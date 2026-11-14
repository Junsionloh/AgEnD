import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AcpClient, AcpRpcError, AcpTransportError, type PermissionRequest } from "./client.js";
import { UpdateTranslator } from "./translate.js";
import { buildChildEnv, checkVersion, type AcpProfile } from "./profiles.js";
import type {
  AdapterCapabilities, AdapterEvent, AdapterHealth, AdapterStartContext, CliAdapter, InstanceRunner,
  PermissionDecision, PromptAck, PromptRequest,
} from "../types.js";

/** The CLI's version is not on the profile's list, or it did not report one. The instance stays stopped. */
export class AcpVersionRefusedError extends Error {
  constructor(message: string) { super(message); this.name = "AcpVersionRefusedError"; }
}

/** The CLI is not signed in (`auth_required`). The instance stays stopped until a person signs in. */
export class AcpAuthRequiredError extends Error {
  constructor(message: string) { super(message); this.name = "AcpAuthRequiredError"; }
}

/** One MCP server for `session/new`: stdio form, the only one every agent must accept. */
export interface AcpMcpServer {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: readonly { name: string; value: string }[];
}

export interface AcpAdapterOptions {
  readonly profile: AcpProfile;
  /** The CLI's binary (absolute path when it could be resolved). */
  readonly command: string;
  /** The instance's working directory; absolute. */
  readonly cwd: string;
  readonly instanceDir: string;
  readonly model?: string;
  readonly effort?: string;
  /** This instance's own MCP servers, passed in `session/new` / `session/load` (never shared with another instance). */
  readonly mcpServers: readonly AcpMcpServer[];
  /** Text put in front of the first prompt of a new session (fleet instructions). Not repeated after a resume. */
  readonly preamble?: string;
  /** Where the child's allow-listed environment is taken from (default: this process's). */
  readonly env?: NodeJS.ProcessEnv;
  /** Variables set on the child on top of the allow-listed ones. */
  readonly childEnv?: Readonly<Record<string, string>>;
  readonly logger: { info(o: object, m?: string): void; warn(o: object, m?: string): void; error(o: object, m?: string): void; debug?(o: object, m?: string): void };
  /** Builds the runner this adapter is bound to (the fleet's per-instance object). */
  readonly makeRunner: (adapter: AcpAdapter) => InstanceRunner;
  /** Test seam. */
  readonly spawn?: ConstructorParameters<typeof AcpClient>[0]["spawn"];
}

export interface TurnResult { readonly stopReason: string }

type Listener = (event: AdapterEvent) => void;
const SESSION_FILE = "acp-session-id";
const INIT_TIMEOUT_MS = 30_000;
const SESSION_TIMEOUT_MS = 120_000;

/**
 * The `acp` adapter: one agent process, one session, for one instance. It speaks the protocol (initialize, version
 * gate, session/new or session/load, prompt turns, cancel, permission requests) and translates what the agent sends
 * into `AdapterEvent`s. Everything the fleet needs to know about an instance — busy and idle, crash and respawn,
 * permission policy, chat steps, delivery receipts — is the runner's job (`AcpRunner`), written once for every ACP CLI.
 */
export class AcpAdapter implements CliAdapter {
  readonly id = "acp" as const;
  readonly capabilities: AdapterCapabilities;
  readonly runner: InstanceRunner;

  private client: AcpClient | null = null;
  private readonly translator = new UpdateTranslator();
  private readonly listeners = new Set<Listener>();
  private readonly exitListeners = new Set<(info: { code: number | null; signal: NodeJS.Signals | null; expected: boolean }) => void>();
  private session: string | null = null;
  private replaying = false;
  private turn: Promise<TurnResult> | null = null;
  private lastEvent: number | null = null;
  private stopping = false;
  private preambleSent = true;
  private _newSession = true;
  private _agentVersion: string | null = null;

  constructor(private readonly opts: AcpAdapterOptions) {
    this.capabilities = opts.profile.capabilities;
    this.session = this.readStoredSession();
    this.runner = opts.makeRunner(this);
  }

  get profile(): AcpProfile { return this.opts.profile; }
  /** Whether the current session was created by this start (false: an earlier conversation was loaded). */
  get isNewSession(): boolean { return this._newSession; }
  get agentVersion(): string | null { return this._agentVersion; }
  get pid(): number | undefined { return this.client?.pid; }
  get busy(): boolean { return this.turn !== null; }
  get pendingPermissionKeys(): string[] { return this.client?.pendingPermissionKeys ?? []; }
  /** The last stderr text of the agent process, for failure messages. */
  get stderr(): string { return this.client?.stderr ?? ""; }

  onEvent(listener: Listener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  onExit(listener: (info: { code: number | null; signal: NodeJS.Signals | null; expected: boolean }) => void): () => void {
    this.exitListeners.add(listener); return () => this.exitListeners.delete(listener);
  }

  async start(ctx: AdapterStartContext = {}): Promise<void> {
    if (this.client) throw new Error("the ACP adapter is already started");
    this.stopping = false;
    ctx.admission?.();
    const { profile } = this.opts;
    const client = new AcpClient({
      command: this.opts.command,
      args: profile.args({ model: this.opts.model, effort: this.opts.effort }),
      env: buildChildEnv(profile, this.opts.env ?? process.env, this.opts.childEnv),
      cwd: this.opts.cwd,
      spawn: this.opts.spawn,
      onNotification: (method, params) => this.onNotification(method, params),
      onPermissionRequest: request => this.onPermission(request),
      onWarning: (message, detail) => this.opts.logger.warn({ ...detail }, `acp: ${message}`),
    });
    this.client = client;
    client.on("exit", ({ code, signal }: { code: number | null; signal: NodeJS.Signals | null }) => {
      if (this.client !== client) return;
      const expected = this.stopping;
      this.client = null;
      this.turn = null;
      for (const l of this.exitListeners) l({ code, signal, expected });
    });
    try {
      await client.start();
      ctx.admission?.();
      const init = await client.request<Record<string, unknown>>("initialize", { protocolVersion: 1, clientCapabilities: {} }, { timeoutMs: INIT_TIMEOUT_MS });
      ctx.admission?.();
      const verdict = checkVersion(profile, init);
      if (!verdict.ok) throw new AcpVersionRefusedError(verdict.message);
      this._agentVersion = verdict.version;
      await this.openSession(client, init);
      ctx.admission?.();
    } catch (err) {
      this.stopping = true; // the failed start's exit is not a crash
      this.client = null;
      await client.close(1500).catch(() => undefined);
      this.stopping = false;
      if (err instanceof AcpRpcError && err.authRequired) {
        this.emit({ kind: "auth_required" });
        throw new AcpAuthRequiredError(`${profile.label} is not signed in (${err.message}). Sign in to ${profile.label}, then restart the instance.`);
      }
      throw err;
    }
  }

  private async openSession(client: AcpClient, init: Record<string, unknown>): Promise<void> {
    const caps = (init.agentCapabilities ?? {}) as Record<string, unknown>;
    const mcpServers = this.opts.mcpServers.map(s => ({ name: s.name, command: s.command, args: [...s.args], env: s.env.map(e => ({ ...e })) }));
    const params = { cwd: this.opts.cwd, mcpServers };
    if (this.session && (caps.loadSession === true || caps.load_session === true)) {
      this.replaying = true;
      try {
        await client.request("session/load", { sessionId: this.session, ...params }, { timeoutMs: SESSION_TIMEOUT_MS });
        this._newSession = false;
        this.preambleSent = true;
        this.opts.logger.info({ sessionId: this.session }, "acp: resumed the stored session");
        return;
      } catch (err) {
        if (err instanceof AcpTransportError) throw err;
        if (err instanceof AcpRpcError && err.authRequired) throw err;
        // The stored session is gone (or the CLI refuses it): say so and start a new conversation.
        this.opts.logger.warn({ sessionId: this.session, error: (err as Error).message }, "acp: the stored session could not be loaded; starting a new one");
        this.session = null;
      } finally {
        this.replaying = false;
      }
    }
    const created = await client.request<Record<string, unknown>>("session/new", params, { timeoutMs: SESSION_TIMEOUT_MS });
    if (typeof created?.sessionId !== "string" || !created.sessionId) throw new Error("session/new did not return a session id");
    this.session = created.sessionId;
    this._newSession = true;
    this.preambleSent = !this.opts.preamble;
    this.storeSession(this.session);
  }

  async stop(): Promise<void> {
    const client = this.client;
    if (!client) return;
    this.stopping = true;
    client.cancelAllPermissions();
    if (this.session && this.turn) client.notify("session/cancel", { sessionId: this.session });
    await client.close();
    this.client = null;
    this.turn = null;
  }

  health(): AdapterHealth {
    return { process: this.client?.isRunning ? "running" : this.stopping ? "stopped" : "crashed", lastEventAt: this.lastEvent };
  }

  /** Run one turn. Rejects when the agent process is gone before the answer; resolves with the stop reason otherwise. */
  prompt(content: string): Promise<TurnResult> {
    const client = this.client;
    if (!client?.isRunning || !this.session) return Promise.reject(new AcpTransportError("the agent is not running"));
    if (this.turn) return Promise.reject(new Error("a turn is already running"));
    const text = !this.preambleSent && this.opts.preamble ? `${this.opts.preamble}\n\n${content}` : content;
    this.preambleSent = true;
    const sessionId = this.session;
    this.translator.reset();
    const turn = client.request<Record<string, unknown>>("session/prompt", { sessionId, prompt: [{ type: "text", text }] })
      .then(result => ({ stopReason: typeof result?.stopReason === "string" ? result.stopReason : "end_turn" }))
      .catch(err => {
        if (err instanceof AcpRpcError && err.authRequired) this.emit({ kind: "auth_required" });
        throw err;
      })
      .finally(() => { if (this.turn === turn) this.turn = null; });
    this.turn = turn;
    return turn;
  }

  sendPrompt(request: PromptRequest): PromptAck {
    void this.prompt(request.content).then(r => this.emit({ kind: "turn_end", stopReason: r.stopReason }), () => undefined);
    return { accepted: true };
  }

  /** ACP defines no mid-turn input: not offered (capabilities.steer is false). */
  steer = undefined;

  /** Interrupt the running turn. Waiting permission requests are answered "cancelled" first, as the protocol asks. */
  async cancel(): Promise<void> {
    const client = this.client;
    if (!client?.isRunning || !this.session) return;
    client.cancelAllPermissions();
    if (this.turn) client.notify("session/cancel", { sessionId: this.session });
  }

  answerPermission(requestId: string, decision: PermissionDecision): boolean {
    return this.client?.answerPermission(requestId, "cancelled" in decision ? { cancelled: true } : { optionId: decision.optionId }) ?? false;
  }

  events(): AsyncIterable<AdapterEvent> {
    const queue: AdapterEvent[] = [];
    let wake: (() => void) | null = null;
    const off = this.onEvent(e => { queue.push(e); wake?.(); });
    const self = this;
    return {
      [Symbol.asyncIterator]: () => ({
        async next(): Promise<IteratorResult<AdapterEvent>> {
          while (!queue.length) {
            if (!self.client && self.stopping) { off(); return { done: true, value: undefined }; }
            await new Promise<void>(r => { wake = r; setTimeout(r, 250).unref?.(); });
          }
          return { done: false, value: queue.shift()! };
        },
        async return(): Promise<IteratorResult<AdapterEvent>> { off(); return { done: true, value: undefined }; },
      }),
    };
  }

  sessionId(): string | null { return this.session; }

  /** Forget the stored conversation: the next start opens a new session. */
  forgetSession(): void {
    this.session = null;
    try { writeFileSync(join(this.opts.instanceDir, SESSION_FILE), ""); } catch { /* best effort */ }
  }

  private emit(event: AdapterEvent): void {
    this.lastEvent = Date.now();
    for (const l of this.listeners) {
      try { l(event); } catch (err) { this.opts.logger.warn({ error: (err as Error).message }, "acp: an event listener threw"); }
    }
  }

  private onNotification(method: string, params: unknown): void {
    // Any frame is proof of life for the hang timer, even those that carry nothing we show.
    this.lastEvent = Date.now();
    if (method !== "session/update") return;
    if (this.replaying) return; // session/load replays the old conversation: it is history, not live work
    const p = params && typeof params === "object" ? params as Record<string, unknown> : null;
    if (!p || (typeof p.sessionId === "string" && this.session && p.sessionId !== this.session)) return;
    for (const event of this.translator.translate(p.update)) this.emit(event);
  }

  private onPermission(request: PermissionRequest): void {
    this.emit({
      kind: "permission",
      requestId: request.key,
      tool: request.toolCall,
      options: request.options.map(o => ({ id: o.optionId, name: o.name, kind: o.kind })),
    });
  }

  private readStoredSession(): string | null {
    try {
      const file = join(this.opts.instanceDir, SESSION_FILE);
      if (!existsSync(file)) return null;
      const id = readFileSync(file, "utf8").trim();
      return /^[\w.:-]{1,200}$/.test(id) ? id : null;
    } catch { return null; }
  }

  private storeSession(id: string): void {
    try {
      const file = join(this.opts.instanceDir, SESSION_FILE);
      writeFileSync(`${file}.tmp`, id, { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
    } catch (err) { this.opts.logger.warn({ error: (err as Error).message }, "acp: could not store the session id"); }
  }
}
