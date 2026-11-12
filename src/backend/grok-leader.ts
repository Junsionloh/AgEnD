/**
 * AGEND-236 (upstream #3731, step 1): the pieces of the experimental "keep grok's TUI, add a read-only ACP observer" mode that
 * are plain functions — the gate, the per-instance socket path, the launch flags and the leader's stop.
 *
 * What was measured on grok 1.0.77 (evidence: docs/evidence/grok-leader-observer-236/README.md):
 *  - `grok --leader --leader-socket S` joins a leader at S; with none listening it spawns one itself. That leader is a child of the
 *    TUI that inherits the TUI's environment (verified in /proc/<pid>/environ), and it runs with `--no-exit-on-disconnect`: it
 *    OUTLIVES the TUI. A TUI launched later joins it and its tools run with the FIRST launch's environment (#1411), so the daemon
 *    must stop the instance's leader at every stop and before every launch — see `stopGrokLeader`.
 *  - The socket path must be shorter than sun_path (108 bytes on Linux: 107 works, 108 does not; 104 on macOS: 103).
 *
 * Everything here is opt-in: nothing runs unless `backend_options.grok.leader_observer` is true on the instance AND the installed
 * grok passes the version gate. Without that, grok is launched exactly as before (`--no-leader`).
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellQuote } from "./types.js";

/** The grok builds whose leader / ACP fields were audited and have a fixture (tests/fixtures/grok-leader-observer-236). */
export const GROK_LEADER_AUDITED = Object.freeze({ major: 1, minor: 0, minPatch: 77 });

/** `grok --version` prints "grok 1.0.77 (50ca579fa996) [stable]"; the bare "1.0.77" is accepted too. */
export function parseGrokVersion(text: string | null | undefined): string | null {
  const m = typeof text === "string" ? /(?:^|\s)v?(\d{1,3}\.\d{1,3}\.\d{1,3})(?=\s|$|[-(])/.exec(text) : null;
  return m ? m[1]! : null;
}

/** The version gate: 1.0.x from the audited patch on. A newer minor or major has not been audited — it is not used. */
export function grokLeaderVersionOk(version: string | null | undefined): boolean {
  const v = parseGrokVersion(version ?? "");
  if (!v) return false;
  const [major, minor, patch] = v.split(".").map(Number) as [number, number, number];
  return major === GROK_LEADER_AUDITED.major && minor === GROK_LEADER_AUDITED.minor && patch >= GROK_LEADER_AUDITED.minPatch;
}

const versionCache = new Map<string, string | null>();
/** The installed grok's version (cached per binary; null when it cannot be read). */
export function readGrokVersion(binary: string, run: (bin: string) => string = (b) => execFileSync(b, ["--version"], { encoding: "utf-8", timeout: 5000 })): string | null {
  if (versionCache.has(binary)) return versionCache.get(binary)!;
  let v: string | null = null;
  try { v = parseGrokVersion(run(binary)); } catch { v = null; }
  versionCache.set(binary, v);
  return v;
}
export function resetGrokVersionCache(): void { versionCache.clear(); }

/** The per-instance switch (default off): `backend_options.grok.leader_observer: true`. Anything but literal `true` is off. */
export function grokLeaderRequested(backendOptions: Record<string, unknown> | undefined): boolean {
  const g = backendOptions?.grok;
  return !!g && typeof g === "object" && (g as Record<string, unknown>).leader_observer === true;
}

/** Longest socket path used: below Linux's 107 and macOS's 103 with room for the sibling `.lock` name. */
export const GROK_SOCKET_PATH_MAX = 100;

export type GrokSocket = { ok: true; path: string; dir: string } | { ok: false; reason: string };

/**
 * One socket per instance, in a private directory the daemon user owns: `<runtime dir>/agend-grok-<uid>/<12 hex>.sock`, the hex
 * being a hash of the instance directory (unique per instance AND per fleet home; the path itself stays short however long the
 * instance's name or directory is). `XDG_RUNTIME_DIR` (`/run/user/<uid>`) is preferred; otherwise the temp directory.
 */
export function grokLeaderSocketPath(instanceDir: string, opts: { uid?: number; runtimeDir?: string; tmp?: string } = {}): GrokSocket {
  // A unix-domain socket in a 0700 directory: no Windows runtime (its launch is a different mechanism; the mode stays off there).
  if (process.platform === "win32" && opts.uid === undefined) return { ok: false, reason: "the leader socket is not supported on Windows" };
  const uid = opts.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0);
  const hash = createHash("sha256").update(instanceDir).digest("hex").slice(0, 12);
  const bases = [opts.runtimeDir ?? process.env.XDG_RUNTIME_DIR, opts.tmp ?? tmpdir(), "/tmp"].filter((b): b is string => !!b && b.startsWith("/"));
  for (const base of bases) {
    const dir = join(base, `agend-grok-${uid}`);
    const path = join(dir, `${hash}.sock`);
    if (Buffer.byteLength(path) <= GROK_SOCKET_PATH_MAX) return { ok: true, path, dir };
  }
  return { ok: false, reason: `no short enough place for the leader socket (limit ${GROK_SOCKET_PATH_MAX} bytes)` };
}

/** Make `dir` a real directory of ours, mode 0700 (a symlink, a foreign owner or loose permissions are refused: the socket lives there). */
export function ensureSocketDir(dir: string, uid = typeof process.getuid === "function" ? process.getuid() : -1): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("leader socket directory is not a plain directory");
  if (uid >= 0 && st.uid !== uid) throw new Error("leader socket directory belongs to another user");
  if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
}

/** The launch flags for a TUI that joins (or starts) the instance's own leader. Replaces `--no-leader`. */
export function grokLeaderLaunchFlags(socket: string): string {
  return `--leader --leader-socket ${shellQuote(socket)}`;
}

/** grok writes the leader's pid beside the socket: `<socket without .sock>.lock`. */
export function leaderLockPath(socket: string): string { return socket.replace(/\.sock$/, "") + ".lock"; }

export function readLeaderPid(socket: string): number | null {
  try {
    const n = Number(readFileSync(leaderLockPath(socket), "utf-8").trim());
    return Number.isInteger(n) && n > 1 ? n : null;
  } catch { return null; }
}

/**
 * The command line of `pid` (null: no such process / cannot tell). Linux reads /proc; elsewhere `ps`.
 * Used to prove that the pid in a lock file is a grok leader before it is signalled.
 */
export function processArgs(pid: number): string[] | null {
  try { return readFileSync(`/proc/${pid}/cmdline`, "utf-8").split("\0").filter(Boolean); } catch { /* not Linux or gone */ }
  try {
    const out = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf-8", timeout: 3000 }).trim();
    return out ? out.split(/\s+/) : null;
  } catch { return null; }
}

/** The leader's own socket, from its environment (grok sets GROK_LEADER_SOCKET in the leader it spawns). Linux only; null elsewhere. */
export function processLeaderSocketEnv(pid: number): string | null {
  try {
    for (const kv of readFileSync(`/proc/${pid}/environ`, "utf-8").split("\0")) if (kv.startsWith("GROK_LEADER_SOCKET=")) return kv.slice("GROK_LEADER_SOCKET=".length);
  } catch { /* not Linux or gone */ }
  return null;
}

export interface LeaderStopDeps {
  args?: (pid: number) => string[] | null;
  socketEnv?: (pid: number) => string | null;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  unlink?: (path: string) => void;
}

/**
 * Stop THIS instance's leader — by the pid in its own lock file, never by name, and only after the process proves to be a grok
 * leader for this socket: its argv holds `agent leader` (grok's own spawn) and either `--leader-socket <socket>` (a leader we
 * started) or, for the one the TUI spawned, GROK_LEADER_SOCKET=<socket> in its environment. Anything else is left alone.
 * Returns what happened, for the log.
 */
export function stopGrokLeader(socket: string, deps: LeaderStopDeps = {}): "none" | "stopped" | "not-a-leader" {
  const pid = readLeaderPid(socket);
  if (pid === null) return "none";
  const args = (deps.args ?? processArgs)(pid);
  if (!args) { removeStale(socket, deps); return "none"; }          // the pid is gone: only a stale lock/socket remains
  const isLeader = args.some((a, i) => a === "agent" && args[i + 1] === "leader");
  const ours = args.includes(socket) || (deps.socketEnv ?? processLeaderSocketEnv)(pid) === socket;
  if (!isLeader || !ours) return "not-a-leader";
  try { (deps.kill ?? process.kill)(pid, "SIGTERM"); } catch { /* already gone */ }
  removeStale(socket, deps);
  return "stopped";
}

function removeStale(socket: string, deps: LeaderStopDeps): void {
  const rm = deps.unlink ?? ((p: string) => { try { unlinkSync(p); } catch { /* absent */ } });
  rm(socket); rm(leaderLockPath(socket));
}
