/**
 * AGEND-236 (upstream #3731, step 1): the daemon's per-instance owner of the experimental grok leader + observer.
 *
 * One host per grok instance. Its lifecycle is the instance's:
 *  - `prepare()` — before every launch: decide whether the mode applies (opt-in, version gate, short socket path), and stop any
 *    leader left at the instance's socket by an earlier launch, so the TUI that is about to start spawns a FRESH leader with
 *    THIS launch's environment (a surviving leader keeps the old one: #1411, measured). Returns the socket, or null: launch as
 *    before (`--no-leader`).
 *  - `begin()` — after the launch: every POLL_MS, attach (or re-attach) the read-only observer to the TUI's session once the
 *    instance's own leader exists and the session id is known. The observer is never started while no leader of this socket is
 *    alive: `grok agent --leader … stdio` would spawn one then, with the daemon's environment.
 *  - `stop()` — at every instance stop: the observer first, then this instance's leader (by the pid in its own lock file).
 *
 * A daemon restart: the host starts again with the instance; `prepare()` stops the leftover leader like any other.
 * A TUI crash: the leader stays (grok starts it with --no-exit-on-disconnect); the daemon's respawn runs `prepare()` first.
 */
import { existsSync } from "node:fs";
import { GrokAcpObserver, spawnGrokBridge, type AcpTransport, type GrokLive } from "./grok-acp-observer.js";
import {
  ensureSocketDir, grokLeaderRequested, grokLeaderSocketPath, grokLeaderVersionOk, processArgs, processLeaderSocketEnv, readGrokVersion, readLeaderPid, stopGrokLeader,
} from "./grok-leader.js";

export const POLL_MS = 2000;
const BACKOFF_MS = [2000, 5000, 15000, 30000];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface HostDeps {
  /** Make the transport to the leader (tests pass a fake). */
  transport?: (binary: string, socket: string, cwd: string) => AcpTransport;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (h: unknown) => void;
  now?: () => number;
  socketExists?: (path: string) => boolean;
  leaderAlive?: (socket: string) => boolean;
  stopLeader?: (socket: string) => "none" | "stopped" | "not-a-leader";
  sleep?: (ms: number) => Promise<void>;
  version?: (binary: string) => string | null;
}

export interface HostOptions {
  instanceName: string;
  instanceDir: string;
  cwd: string;
  binary: string;
  backendOptions: Record<string, unknown> | undefined;
  /** The TUI's session id (the backend's own getSessionId()). */
  sessionId: () => string | null;
  /** The live state moved: the chat's page should look. */
  onChange: () => void;
  log: (level: "info" | "warn", msg: string, extra?: Record<string, unknown>) => void;
  deps?: HostDeps;
}

export class GrokLeaderHost {
  private socket: string | null = null;
  private observer: GrokAcpObserver | null = null;
  private timer: unknown = null;
  private failures = 0;
  private notBefore = 0;
  private stopped = false;

  constructor(private readonly o: HostOptions) {}

  /** The mode is requested for this instance (does not say it will run: the gate may refuse). */
  get requested(): boolean { return grokLeaderRequested(this.o.backendOptions); }
  get socketPath(): string | null { return this.socket; }

  async prepare(): Promise<string | null> {
    this.stopped = false;
    this.socket = null;
    if (!this.requested) return null;
    const d = this.o.deps ?? {};
    const version = (d.version ?? readGrokVersion)(this.o.binary);
    if (!grokLeaderVersionOk(version)) {
      this.o.log("warn", "grok leader observer is on, but this grok is not an audited build — launching as before", { version });
      return null;
    }
    const sock = grokLeaderSocketPath(this.o.instanceDir);
    if (!sock.ok) { this.o.log("warn", `grok leader observer: ${sock.reason} — launching as before`); return null; }
    try { ensureSocketDir(sock.dir); } catch (e) {
      this.o.log("warn", `grok leader observer: ${e instanceof Error ? e.message : String(e)} — launching as before`);
      return null;
    }
    await this.retireLeader(sock.path);
    this.socket = sock.path;
    return sock.path;
  }

  /** Stop what an earlier launch left at this socket and wait (bounded) until it has let go of it. */
  private async retireLeader(socket: string): Promise<void> {
    const d = this.o.deps ?? {};
    const pid = readLeaderPid(socket);
    const what = (d.stopLeader ?? stopGrokLeader)(socket);
    if (what === "stopped") this.o.log("info", "stopped this instance's grok leader (a launch's environment must not outlive its launch)", { pid });
    if (what === "not-a-leader") this.o.log("warn", "the pid in the leader lock file is not this instance's grok leader — left alone", { pid });
    if (what === "stopped" && pid !== null && !d.stopLeader) {
      const sleep = d.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
      for (let i = 0; i < 30 && processArgs(pid) !== null; i++) await sleep(100);
    }
  }

  /** Start attaching the observer (after the launch). */
  begin(): void {
    if (!this.socket || this.timer) return;
    const d = this.o.deps ?? {};
    this.stopped = false;
    this.timer = (d.setInterval ?? ((fn: () => void, ms: number) => { const t = setInterval(fn, ms); (t as { unref?: () => void }).unref?.(); return t; }))(() => this.tick(), POLL_MS);
  }

  private leaderAlive(socket: string): boolean {
    const d = this.o.deps ?? {};
    if (d.leaderAlive) return d.leaderAlive(socket);
    if (!(d.socketExists ?? existsSync)(socket)) return false;
    const pid = readLeaderPid(socket);
    if (pid === null) return false;
    const args = processArgs(pid);
    return !!args && args.some((a, i) => a === "agent" && args[i + 1] === "leader") && (args.includes(socket) || processLeaderSocketEnv(pid) === socket);
  }

  /** One poll. Public for tests. */
  tick(): void {
    if (this.stopped || !this.socket) return;
    const now = (this.o.deps?.now ?? Date.now)();
    const sid = this.o.sessionId();
    if (this.observer && !this.observer.isClosed && sid && this.observer.sessionId !== sid) {
      this.o.log("info", "the TUI's session changed — re-attaching the observer", { from: this.observer.sessionId, to: sid });
      const old = this.observer; this.observer = null; old.stop();     // detached first: a planned stop is not a failure to back off from
    }
    if (this.observer && !this.observer.isClosed) return;
    this.observer = null;
    if (!sid || !UUID.test(sid) || now < this.notBefore) return;
    if (!this.leaderAlive(this.socket)) return;                 // never start the bridge without the instance's own leader
    this.attach(this.socket, sid, now);
  }

  private attach(socket: string, sid: string, now: number): void {
    const d = this.o.deps ?? {};
    let transport: AcpTransport;
    try { transport = (d.transport ?? ((b, s, c) => spawnGrokBridge(b, s, c)))(this.o.binary, socket, this.o.cwd); } catch (e) {
      this.backoff(now, `could not start the bridge: ${e instanceof Error ? e.message : String(e)}`); return;
    }
    const obs = new GrokAcpObserver({
      sessionId: sid, cwd: this.o.cwd, transport, now: d.now,
      onChange: () => { if (this.observer !== obs) return; if (obs.isLoaded) this.failures = 0; this.o.onChange(); },
      onClose: reason => {
        if (this.observer !== obs) return;
        if (!this.stopped) this.backoff((d.now ?? Date.now)(), `observer closed: ${reason}`);
        this.o.onChange();
      },
    });
    this.observer = obs;
    obs.start();
  }

  private backoff(now: number, why: string): void {
    this.notBefore = now + BACKOFF_MS[Math.min(this.failures, BACKOFF_MS.length - 1)]!;
    this.failures++;
    this.o.log("warn", `grok leader observer: ${why}`, { retryInMs: this.notBefore - now });
  }

  /** The turn's live state, or null: no observer attached (yet), or it is not loaded. */
  live(): GrokLive | null {
    const obs = this.observer;
    if (!obs || obs.isClosed || !obs.isLoaded) return null;
    return obs.live();
  }

  /** Instance stop: the observer, then this instance's leader. Idempotent. */
  async stop(): Promise<void> {
    this.stopped = true;
    const d = this.o.deps ?? {};
    if (this.timer) { (d.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>)))(this.timer); this.timer = null; }
    this.observer?.stop(); this.observer = null;
    if (this.socket) await this.retireLeader(this.socket);
    this.failures = 0; this.notBefore = 0;
  }
}
