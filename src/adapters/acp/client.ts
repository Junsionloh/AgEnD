import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { LineFramer, decodeFrame, type JsonRpcId } from "./frames.js";

/** A JSON-RPC error answered by the agent (the request was understood and refused). */
export class AcpRpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
    this.name = "AcpRpcError";
  }
  /** ACP's "authentication required" (-32000). */
  get authRequired(): boolean { return this.code === -32000; }
}

/** The transport went away (child exit, stdio closed) before the request was answered. */
export class AcpTransportError extends Error {
  constructor(message: string) { super(message); this.name = "AcpTransportError"; }
}

export interface PermissionOption { readonly optionId: string; readonly name: string; readonly kind: string }

/** `session/request_permission`, as received (the tool call is untrusted data, bounded by the consumer). */
export interface PermissionRequest {
  /** Opaque key for answering; unique among the requests in flight (the JSON-RPC id can be 0 or a string). */
  readonly key: string;
  readonly sessionId: string;
  readonly toolCall: Record<string, unknown>;
  readonly options: readonly PermissionOption[];
}

export type PermissionOutcome = { readonly optionId: string } | { readonly cancelled: true };

export interface AcpClientOptions {
  readonly command: string;
  readonly args: readonly string[];
  /** The child's whole environment: nothing is inherited. */
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly spawn?: typeof nodeSpawn;
  readonly maxLineBytes?: number;
  /** Requests of ours that may be unanswered at once. */
  readonly maxPending?: number;
  /** Permission requests from the agent that may be unanswered at once; more are refused. */
  readonly maxPermissions?: number;
  readonly onNotification: (method: string, params: unknown) => void;
  readonly onPermissionRequest: (request: PermissionRequest) => void;
  readonly onWarning?: (message: string, detail?: Record<string, unknown>) => void;
}

const STDERR_KEEP = 4096;
const DEFAULT_MAX_PENDING = 64;
const DEFAULT_MAX_PERMISSIONS = 16;

/**
 * The ACP transport for one agent process: JSON-RPC 2.0 over the child's stdin/stdout.
 *
 * What it answers by itself: nothing but `session/request_permission`, which goes to `onPermissionRequest` and is
 * answered later through `answerPermission`. Every other agent-to-client request gets `-32601`, so `fs/*` and
 * `terminal/*` never work even if an agent sends them (and none is advertised). The child is spawned without a shell,
 * with exactly the environment it was given.
 *
 * Events: `exit` ({ code, signal }) once, when the process is gone and every pending request has been failed.
 */
export class AcpClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly framer: LineFramer;
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, { resolve: (v: unknown) => void; reject: (e: Error) => void; method: string; timer: NodeJS.Timeout | null }>();
  private readonly permissions = new Map<string, JsonRpcId>();
  private stderrTail = "";
  private exited = false;
  private lastFrameAt = 0;

  constructor(private readonly opts: AcpClientOptions) {
    super();
    this.framer = new LineFramer({
      maxLineBytes: opts.maxLineBytes,
      onOverflow: bytes => opts.onWarning?.("dropped an over-long line from the agent", { bytes }),
    });
  }

  get pid(): number | undefined { return this.child?.pid; }
  get isRunning(): boolean { return !!this.child && !this.exited; }
  /** Time of the last well-formed frame from the agent (ms since epoch), 0 before any. */
  get lastActivityAt(): number { return this.lastFrameAt; }
  /** The end of what the child wrote on stderr, for a failure message. */
  get stderr(): string { return this.stderrTail; }
  get pendingPermissionKeys(): string[] { return [...this.permissions.keys()]; }

  /** Spawn the child. Resolves once it has been created (a failure to exec rejects). */
  start(): Promise<void> {
    if (this.child) return Promise.reject(new Error("AcpClient already started"));
    const spawnFn = this.opts.spawn ?? nodeSpawn;
    return new Promise((resolve, reject) => {
      const child = spawnFn(this.opts.command, [...this.opts.args], {
        cwd: this.opts.cwd, env: { ...this.opts.env }, stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true,
      }) as ChildProcessWithoutNullStreams;
      this.child = child;
      let settled = false;
      child.once("error", err => {
        if (!settled) { settled = true; reject(err); }
        this.handleExit(null, null);
      });
      child.once("spawn", () => { if (!settled) { settled = true; resolve(); } });
      child.stdout.on("data", (chunk: Buffer) => { for (const line of this.framer.push(chunk)) this.handleLine(line); });
      child.stderr.on("data", (chunk: Buffer) => {
        this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-STDERR_KEEP);
      });
      // A write to a dead child raises EPIPE on stdin; the exit handler owns reporting it.
      child.stdin.on("error", () => { /* handled by exit */ });
      child.once("exit", (code, signal) => this.handleExit(code, signal));
    });
  }

  /** Send a request and wait for its answer. Rejects with `AcpRpcError` (agent refused) or `AcpTransportError`. */
  request<T = unknown>(method: string, params: unknown, opts: { timeoutMs?: number } = {}): Promise<T> {
    if (!this.isRunning) return Promise.reject(new AcpTransportError(`${method}: the agent process is not running`));
    if (this.pending.size >= (this.opts.maxPending ?? DEFAULT_MAX_PENDING)) return Promise.reject(new Error(`${method}: too many requests in flight`));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = opts.timeoutMs ? setTimeout(() => {
        this.pending.delete(id);
        reject(new AcpTransportError(`${method}: no answer within ${opts.timeoutMs} ms`));
      }, opts.timeoutMs) : null;
      timer?.unref?.();
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, method, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** A notification (no answer): `session/cancel`. */
  notify(method: string, params: unknown): void {
    if (this.isRunning) this.write({ jsonrpc: "2.0", method, params });
  }

  /** Answer a `session/request_permission`. Returns false when it is not (or no longer) waiting. */
  answerPermission(key: string, outcome: PermissionOutcome): boolean {
    const id = this.permissions.get(key);
    if (id === undefined) return false;
    this.permissions.delete(key);
    const body = "cancelled" in outcome ? { outcome: "cancelled" } : { outcome: "selected", optionId: outcome.optionId };
    this.write({ jsonrpc: "2.0", id, result: { outcome: body } });
    return true;
  }

  /** Answer every waiting permission request with the cancelled outcome (turn cancelled, or the instance stops). */
  cancelAllPermissions(): string[] {
    const keys = [...this.permissions.keys()];
    for (const key of keys) this.answerPermission(key, { cancelled: true });
    return keys;
  }

  /** End the child: SIGTERM, then SIGKILL after `graceMs`. Resolves when it has exited. */
  close(graceMs = 3000): Promise<void> {
    const child = this.child;
    if (!child || this.exited) return Promise.resolve();
    return new Promise(resolve => {
      this.once("exit", () => { clearTimeout(kill); resolve(); });
      try { child.stdin.end(); } catch { /* already closed */ }
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
      const kill = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } }, graceMs);
      kill.unref?.();
    });
  }

  private write(message: Record<string, unknown>): void {
    const child = this.child;
    if (!child || this.exited || child.stdin.destroyed) return;
    try { child.stdin.write(JSON.stringify(message) + "\n"); } catch { /* the exit handler reports it */ }
  }

  private handleLine(line: string): void {
    const frame = decodeFrame(line);
    if (frame.kind === "invalid") { this.opts.onWarning?.("ignored an unusable frame from the agent", { reason: frame.reason }); return; }
    this.lastFrameAt = Date.now();
    switch (frame.kind) {
      case "response": this.settle(frame.id, { ok: true, value: frame.result }); return;
      case "error": if (frame.id !== null) this.settle(frame.id, { ok: false, error: new AcpRpcError(frame.code, frame.message, frame.data) }); return;
      case "notification":
        try { this.opts.onNotification(frame.method, frame.params); } catch (err) { this.opts.onWarning?.("a notification handler threw", { method: frame.method, error: (err as Error).message }); }
        return;
      case "request": this.handleAgentRequest(frame.id, frame.method, frame.params); return;
    }
  }

  private settle(id: JsonRpcId, outcome: { ok: true; value: unknown } | { ok: false; error: Error }): void {
    const entry = this.pending.get(id);
    if (!entry) return; // an answer to nothing we asked: ignored
    this.pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    if (outcome.ok) entry.resolve(outcome.value); else entry.reject(outcome.error);
  }

  private handleAgentRequest(id: JsonRpcId, method: string, params: unknown): void {
    if (method !== "session/request_permission") {
      this.write({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
      return;
    }
    const p = params && typeof params === "object" ? params as Record<string, unknown> : null;
    const toolCall = p?.toolCall && typeof p.toolCall === "object" ? p.toolCall as Record<string, unknown> : null;
    const options = Array.isArray(p?.options) ? (p!.options as unknown[]).flatMap((o): PermissionOption[] => {
      const r = o && typeof o === "object" ? o as Record<string, unknown> : null;
      return r && typeof r.optionId === "string" && typeof r.kind === "string"
        ? [{ optionId: r.optionId, name: typeof r.name === "string" ? r.name : r.optionId, kind: r.kind }] : [];
    }) : [];
    if (!p || typeof p.sessionId !== "string" || !toolCall || options.length === 0) {
      this.write({ jsonrpc: "2.0", id, error: { code: -32602, message: "Invalid params for session/request_permission" } });
      return;
    }
    const key = `${typeof id === "number" ? "n" : "s"}${id}`;
    if (this.permissions.has(key) || this.permissions.size >= (this.opts.maxPermissions ?? DEFAULT_MAX_PERMISSIONS)) {
      // Fail closed: a request we cannot track is answered as cancelled rather than left hanging or allowed.
      this.write({ jsonrpc: "2.0", id, result: { outcome: { outcome: "cancelled" } } });
      this.opts.onWarning?.("refused a permission request: too many waiting, or a repeated id", { key });
      return;
    }
    this.permissions.set(key, id);
    this.opts.onPermissionRequest({ key, sessionId: p.sessionId, toolCall, options });
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    const why = signal ? `signal ${signal}` : `code ${code}`;
    const err = new AcpTransportError(`the agent process exited (${why})${this.stderrTail ? `: ${this.stderrTail.trim().slice(-300)}` : ""}`);
    for (const [id, entry] of [...this.pending]) {
      this.pending.delete(id);
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.permissions.clear();
    this.emit("exit", { code, signal });
  }
}
