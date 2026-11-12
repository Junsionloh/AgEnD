/**
 * AGEND-236 (upstream #3731, step 1): a READ-ONLY ACP observer of a grok session whose TUI the daemon keeps.
 *
 * grok's leader lets several clients attach to one session. The TUI is the one the person uses; this is a second, silent client:
 * it attaches with `session/load` and listens to `session/update` — `agent_thought_chunk`, `tool_call`, `tool_call_update` — so the
 * chat's live block can show the turn while it runs (the transcript only gets a thought when it ENDS).
 *
 * The rules this module enforces (upstream's ground rules for the spike, checked by tests/grok-leader-observer-236.test.ts):
 *  - It sends exactly two requests, ever: `initialize` and `session/load` (OBSERVER_ALLOWED_METHODS; `send` throws on anything
 *    else). No prompt, no cancel, no `session/set_*`, no `x.ai/*` extension call, no key press.
 *  - It never answers an agent→client request. grok copies every `session/request_permission` to each attached client; the TUI
 *    answers, the copy that reaches this client stays unanswered. It declares no capabilities (no fs, no terminal), so grok has
 *    nothing else to ask it.
 *  - It must not become a leader or start one: it is only started once the instance's own leader exists (grok-leader-host.ts);
 *    `grok agent --leader … stdio` would otherwise spawn one, with this process's environment.
 *  - A grok whose `initialize` does not say loadSession, or whose agentVersion fails the gate, is not observed.
 *
 * Everything an update says is reduced to a small bounded `GrokLive`; nothing else is kept.
 */
import { spawn as nodeSpawn } from "../child-process.js";
import { createInterface } from "node:readline";
import { grokLeaderVersionOk } from "./grok-leader.js";

/** The only requests the observer may ever send. */
export const OBSERVER_ALLOWED_METHODS: readonly string[] = Object.freeze(["initialize", "session/load"]);

export const THOUGHT_MAX = 4000;
export const TOOLS_MAX = 24;
const TITLE_MAX = 300;
const LINE_MAX = 1_000_000;

export type LiveToolStatus = "pending" | "running" | "completed" | "failed";
export interface LiveTool { id: string; title: string; kind: string | null; status: LiveToolStatus }
export interface GrokLive {
  sessionId: string;
  /** A turn is open: the user's prompt was seen (or a thought / tool of one) and its end has not been. */
  turnOpen: boolean;
  turnStartedAt: number | null;
  /** The thought text of the open turn (the newest THOUGHT_MAX characters). */
  thought: string;
  tools: LiveTool[];
  /** The reply text has started. */
  replying: boolean;
  /** grok is waiting for a permission answer (in the TUI). */
  permissionWaiting: boolean;
  updatedAt: number;
}

export function emptyLive(sessionId: string, now: number): GrokLive {
  return { sessionId, turnOpen: false, turnStartedAt: null, thought: "", tools: [], replying: false, permissionWaiting: false, updatedAt: now };
}

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");
const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null);

function toolStatus(v: unknown): LiveToolStatus | null {
  switch (v) {
    case "pending": return "pending";
    case "in_progress": return "running";
    case "completed": return "completed";
    case "failed": return "failed";
    default: return null;
  }
}

function openTurn(s: GrokLive, now: number): void {
  if (s.turnOpen) return;
  s.turnOpen = true; s.turnStartedAt = now; s.thought = ""; s.tools = []; s.replying = false;
}

/**
 * The reducer: one ACP message (a notification) into the live state. Returns true when the state changed. Pure but for `s`.
 * Unknown methods and update kinds are ignored — grok adds them with every release.
 */
export function reduceLive(s: GrokLive, msg: unknown, now: number): boolean {
  const m = rec(msg);
  if (!m || typeof m.method !== "string") return false;
  const params = rec(m.params);
  const update = rec(params?.update);
  const kind = typeof update?.sessionUpdate === "string" ? update.sessionUpdate : null;
  const forThisSession = !params || params.sessionId === undefined || params.sessionId === s.sessionId;
  if (!forThisSession) return false;
  let changed = true;
  switch (m.method === "session/update" || m.method === "_x.ai/session_notification" ? kind : m.method === "_x.ai/session/prompt_complete" ? "prompt_complete" : null) {
    case "user_message_chunk":
      s.turnOpen = false; openTurn(s, now); s.permissionWaiting = false;     // a new prompt starts a new turn, whatever the last one left
      break;
    case "agent_thought_chunk": {
      openTurn(s, now);
      const text = str(rec(update?.content)?.text, THOUGHT_MAX);
      if (!text) { changed = false; break; }
      s.thought = (s.thought + text).slice(-THOUGHT_MAX);
      break;
    }
    case "agent_message_chunk":
      openTurn(s, now); s.replying = true;
      break;
    case "tool_call":
    case "tool_call_update": {
      const id = str(update?.toolCallId, 200);
      if (!id) { changed = false; break; }
      openTurn(s, now);
      let t = s.tools.find(x => x.id === id);
      if (!t) {
        t = { id, title: "", kind: null, status: "pending" };
        s.tools.push(t);
        if (s.tools.length > TOOLS_MAX) s.tools.shift();
      }
      const title = str(update?.title, TITLE_MAX);
      if (title) t.title = title;
      if (typeof update?.kind === "string") t.kind = update.kind.slice(0, 40);
      const st = toolStatus(update?.status);
      if (st) t.status = st;
      break;
    }
    case "pending_interaction": s.permissionWaiting = true; break;
    case "interaction_resolved": s.permissionWaiting = false; break;
    case "turn_completed":
    case "prompt_complete":
      s.turnOpen = false; s.permissionWaiting = false;
      for (const t of s.tools) if (t.status === "pending" || t.status === "running") t.status = "completed";
      break;
    default: changed = false;
  }
  if (changed) s.updatedAt = now;
  return changed;
}

/** What the child process looks like to the observer: lines in, lines out. */
export interface AcpTransport {
  send(line: string): void;
  onLine(cb: (line: string) => void): void;
  onClose(cb: (reason: string) => void): void;
  close(): void;
}

/** The real transport: `grok agent --leader --leader-socket S stdio` — a bridge to the leader's socket, JSON-RPC lines on stdio. */
export function spawnGrokBridge(binary: string, socket: string, cwd: string, spawn: typeof nodeSpawn = nodeSpawn): AcpTransport {
  const child = spawn(binary, ["agent", "--leader", "--leader-socket", socket, "stdio"], { cwd, stdio: ["pipe", "pipe", "ignore"] });
  let lineCb: (l: string) => void = () => undefined, closeCb: (r: string) => void = () => undefined, closed = false;
  const closeOnce = (r: string) => { if (!closed) { closed = true; closeCb(r); } };
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", l => lineCb(l));
  child.on("error", e => closeOnce(`spawn failed: ${e.message}`));
  child.on("exit", (code, sig) => closeOnce(`exited ${code ?? sig}`));
  child.stdin.on("error", () => undefined);
  return {
    send: l => { child.stdin.write(l + "\n"); },
    onLine: cb => { lineCb = cb; },
    onClose: cb => { closeCb = cb; },
    close: () => { try { child.stdin.end(); child.kill("SIGTERM"); } catch { /* gone */ } closeOnce("closed"); },
  };
}

export interface ObserverOptions {
  sessionId: string;
  cwd: string;
  transport: AcpTransport;
  now?: () => number;
  onChange?: (live: GrokLive) => void;
  onClose?: (reason: string) => void;
}

export class GrokAcpObserver {
  private readonly live_: GrokLive;
  private loaded = false;
  private closed = false;
  private readonly now: () => number;
  /** Requests sent, in order (the evidence for "read-only"), and agent→client requests received and left unanswered, by method. */
  readonly sent: string[] = [];
  readonly unanswered: Record<string, number> = {};

  constructor(private readonly o: ObserverOptions) {
    this.now = o.now ?? Date.now;
    this.live_ = emptyLive(o.sessionId, this.now());
  }

  get sessionId(): string { return this.o.sessionId; }
  get isClosed(): boolean { return this.closed; }
  get isLoaded(): boolean { return this.loaded; }
  live(): GrokLive { return { ...this.live_, tools: this.live_.tools.map(t => ({ ...t })) }; }

  start(): void {
    this.o.transport.onLine(l => this.onLine(l));
    this.o.transport.onClose(r => this.finish(r));
    this.send("initialize", 1, { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "agend-observer", version: "1" } });
  }

  stop(): void { if (!this.closed) { this.o.transport.close(); this.finish("stopped"); } }

  /** The one place a request leaves. Anything outside OBSERVER_ALLOWED_METHODS throws before a byte is written. */
  private send(method: string, id: number, params: unknown): void {
    if (!OBSERVER_ALLOWED_METHODS.includes(method)) throw new Error(`observer is read-only: ${method} is not allowed`);
    this.sent.push(method);
    this.o.transport.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  }

  private onLine(line: string): void {
    if (this.closed || line.length > LINE_MAX) return;
    let msg: unknown;
    try { msg = JSON.parse(line); } catch { return; }
    const m = rec(msg);
    if (!m) return;
    // A response (an id, no method): ours are 1 (initialize) and 2 (session/load). The agent's own requests carry a method.
    if (m.method === undefined) {
      if (m.id === 1) return this.onInitialize(m);
      if (m.id === 2) return this.onLoaded(m);
      return;
    }
    if (m.id !== undefined) {
      // An agent→client request (session/request_permission, …): never answered. Counted, nothing more.
      const name = String(m.method).slice(0, 80);
      this.unanswered[name] = (this.unanswered[name] ?? 0) + 1;
      if (name === "session/request_permission" && this.loaded && !this.live_.permissionWaiting) { this.live_.permissionWaiting = true; this.live_.updatedAt = this.now(); this.o.onChange?.(this.live()); }
      return;
    }
    // Updates before the load's answer are grok replaying the session's history, not what is happening now.
    if (!this.loaded) return;
    if (reduceLive(this.live_, m, this.now())) this.o.onChange?.(this.live());
  }

  private onInitialize(m: Record<string, unknown>): void {
    const result = rec(m.result);
    const caps = rec(result?.agentCapabilities);
    const version = str(rec(result?._meta)?.agentVersion, 40);
    if (!result || caps?.loadSession !== true) return this.fail("grok does not offer session/load");
    if (!grokLeaderVersionOk(version)) return this.fail(`grok ${version || "(unknown version)"} is not an audited build`);
    this.send("session/load", 2, { sessionId: this.o.sessionId, cwd: this.o.cwd, mcpServers: [] });
  }

  private onLoaded(m: Record<string, unknown>): void {
    if (m.error !== undefined || !rec(m.result)) return this.fail("session/load was refused");
    this.loaded = true;
    this.live_.updatedAt = this.now();
    this.o.onChange?.(this.live());
  }

  private fail(reason: string): void { this.o.transport.close(); this.finish(reason); }

  private finish(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.o.onClose?.(reason);
  }
}

/** What the chat's block is sent of the live state (the server cuts it to the viewer's level; see LogService). */
export interface LiveView {
  startedAt: number | null;
  replying: boolean;
  permissionWaiting: boolean;
  /** The calls in flight now (the transcript has the finished ones). `title` only at `verbose` — a command or a path; else the kind. */
  tools: { id: string; label: string }[];
  /** The newest of this turn's thought, only for a viewer who may have thinking. */
  thought?: string;
}
export const VIEW_THOUGHT_MAX = 600;
export const VIEW_TOOLS_MAX = 5;

/**
 * The live state as the chat's block may see it: null when no turn is open. `level` is the instance's `tool_progress` (never "off"
 * here); `thinking`: this viewer may have thinking (admin, `web.log_thinking` on). A tool's own title (it holds a command line or a
 * path) goes only to `verbose` — `standard` gets the kind (execute, edit, …), as it gets only a program name for a finished step.
 */
export function liveView(live: GrokLive | null, level: "standard" | "verbose", thinking: boolean): LiveView | null {
  if (!live || !live.turnOpen) return null;
  const tools = live.tools.filter(t => t.status === "pending" || t.status === "running").slice(-VIEW_TOOLS_MAX)
    .map(t => ({ id: t.id, label: (level === "verbose" ? t.title : "") || t.kind || "tool" }));
  return {
    startedAt: live.turnStartedAt, replying: live.replying, permissionWaiting: live.permissionWaiting, tools,
    ...(thinking && live.thought ? { thought: live.thought.slice(-VIEW_THOUGHT_MAX) } : {}),
  };
}
