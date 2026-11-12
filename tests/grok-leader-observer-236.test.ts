/**
 * AGEND-236 (upstream #3731, step 1): keep grok's TUI and attach a read-only ACP observer through a per-instance leader.
 *
 * Fixture: tests/fixtures/grok-leader-observer-236/1.0.77/session-turns.jsonl — the messages a real observer (grok 1.0.77, attached with
 * `grok agent --leader --leader-socket … stdio` + `session/load`) received from a leader while a person drove the TUI through four
 * turns (thinking + a tool; a permission-asking edit; a pure-reasoning turn; two 6-second tool calls). Redacted: see its README.
 *
 * What is pinned here, against upstream's ground rules:
 *  1. one leader per instance, own socket (path short enough), a stale leader stopped before every launch and at every stop
 *  2. the permission request stays with the TUI: the observer is sent a copy and never answers it
 *  3. the observer is read-only: it sends `initialize` and `session/load` and nothing else, ever
 *  4. a version gate and a real fixture
 *  5. the default is unchanged: no opt-in, no leader (`--no-leader`), no observer, no `live` in any answer
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { GrokBackend } from "../src/backend/grok.js";
import {
  GROK_LEADER_AUDIT, GROK_LEADER_AUDITED_VERSIONS, GROK_SOCKET_PATH_MAX, ensureSocketDir, grokLeaderLaunchFlags, grokLeaderRequested, grokLeaderSocketPath, grokLeaderVersionOk, leaderLockPath, parseGrokVersion, readGrokVersion,
  resetGrokVersionCache, stopGrokLeader,
} from "../src/backend/grok-leader.js";
import { GrokAcpObserver, OBSERVER_ALLOWED_METHODS, emptyLive, liveView, reduceLive, type AcpTransport } from "../src/backend/grok-acp-observer.js";
import { GrokLeaderHost, type HostDeps } from "../src/backend/grok-leader-host.js";
import { LogService, type LogServiceDeps } from "../src/log-service.js";
import { validateFleetConfig } from "../src/config-validator.js";
import { page, settle, type AppPage } from "./helpers/app-harness.js";
import { installDom } from "./helpers/mini-dom.js";
// @ts-expect-error — a JS module of the app, with no types
import { composeRows, groupSteps } from "../src/ui/chat-activity-groups.js";

const FIX = join(import.meta.dirname, "fixtures", "grok-leader-observer-236");
const frames: Array<{ t: number; m: any }> = readFileSync(join(FIX, "1.0.77", "session-turns.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const SID = "00000000-0000-4000-8000-000000000000";
const dirs: string[] = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "agend-236-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A transport that records everything written to the leader and lets the test push what the leader says. */
class FakeTransport implements AcpTransport {
  written: any[] = [];
  closedBy: string | null = null;
  private line: (l: string) => void = () => undefined;
  private close_: (r: string) => void = () => undefined;
  send(l: string) { this.written.push(JSON.parse(l)); }
  onLine(cb: (l: string) => void) { this.line = cb; }
  onClose(cb: (r: string) => void) { this.close_ = cb; }
  close() { this.closedBy = "observer"; }
  push(m: unknown) { this.line(JSON.stringify(m)); }
  end(reason = "gone") { this.close_(reason); }
}
const observe = () => {
  const tr = new FakeTransport(); let clock = 0; const changes: any[] = [];
  const obs = new GrokAcpObserver({ sessionId: SID, cwd: "/work/instance", transport: tr, now: () => clock, onChange: (l) => changes.push(l) });
  obs.start();
  return { tr, obs, changes, at: (t: number) => { clock = t; } };
};
/** Play the fixture's frames through the observer, in order, with the fixture's own clock. */
const play = (h: ReturnType<typeof observe>, until: (f: { t: number; m: any }, i: number) => boolean = () => false) => {
  for (let i = 0; i < frames.length; i++) {
    if (until(frames[i]!, i)) return i;
    h.at(frames[i]!.t);
    h.tr.push(frames[i]!.m);
  }
  return frames.length;
};
const kind = (f: { m: any }) => f.m.params?.update?.sessionUpdate as string | undefined;

describe("the fixture is a real capture", () => {
  it("one initialize answer for 1.0.77, one load answer, then four turns with thoughts, calls, one permission request", () => {
    expect(frames[0]!.m.result._meta.agentVersion).toBe("1.0.77");
    expect(frames[0]!.m.result.agentCapabilities.loadSession).toBe(true);
    expect(frames.filter((f) => kind(f) === "user_message_chunk")).toHaveLength(4);
    expect(frames.filter((f) => kind(f) === "agent_thought_chunk").length).toBeGreaterThanOrEqual(6);
    expect(frames.filter((f) => f.m.method === "session/request_permission")).toHaveLength(1);
    expect(frames.filter((f) => f.m.method === "_x.ai/session_notification" && f.m.params.update.sessionUpdate === "turn_completed")).toHaveLength(4);
  });
});

describe("rule 4 — the version gate", () => {
  it("parses what `grok --version` prints, and a bare version", () => {
    expect(parseGrokVersion("grok 1.0.77 (50ca579fa996) [stable]")).toBe("1.0.77");
    expect(parseGrokVersion("1.0.80")).toBe("1.0.80");
    expect(parseGrokVersion("grok nightly")).toBeNull();
    expect(parseGrokVersion(null)).toBeNull();
  });
  it("only the exact audited versions pass — not a range: later patches, earlier ones, 1.1+, 2.x and junk do not", () => {
    for (const v of ["1.0.77", "grok 1.0.77 (50ca579fa996) [stable]"]) expect(grokLeaderVersionOk(v), v).toBe(true);
    for (const v of ["1.0.78", "1.0.99", "grok 1.0.99 (abc) [stable]", "1.0.76", "1.0.52", "1.0.770", "1.1.0", "2.0.0", "0.9.99", "", "x", null, undefined]) expect(grokLeaderVersionOk(v as any), String(v)).toBe(false);
  });
  it("the allow-list is the audit rows, and every listed version has its audit row, its evidence entry and its fixture", () => {
    expect(GROK_LEADER_AUDITED_VERSIONS).toEqual(GROK_LEADER_AUDIT.map((r) => r.version));
    expect(GROK_LEADER_AUDITED_VERSIONS.length).toBeGreaterThan(0);
    expect(new Set(GROK_LEADER_AUDITED_VERSIONS).size).toBe(GROK_LEADER_AUDITED_VERSIONS.length);
    const evidence = readFileSync(join(import.meta.dirname, "..", "docs", "evidence", "grok-leader-observer-236", "README.md"), "utf8");
    for (const row of GROK_LEADER_AUDIT) {
      const v = row.version;
      expect(v, "an exact x.y.z, not a range").toMatch(/^\d{1,3}\.\d{1,3}\.\d{1,3}$/);
      expect(row.build, `${v}: build hash`).toMatch(/^[0-9a-f]{7,40}$/);
      expect(row.date, `${v}: date`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(row.auditor.trim(), `${v}: auditor`).not.toBe("");
      for (const k of ["flagAccepted", "tuiJoinsLeader", "observerReplayAndLive", "permissionOnlyTuiResolves", "driverTransferAndRespawn"] as const) expect(row[k], `${v}: ${k}`).toBe("pass");
      expect(row.socketPathLimit, `${v}: socket limit`).toBeGreaterThan(GROK_SOCKET_PATH_MAX);
      const fixture = join(FIX, row.fixtureDir, "session-turns.jsonl");
      expect(existsSync(fixture), `${v}: fixture ${fixture}`).toBe(true);
      const first = JSON.parse(readFileSync(fixture, "utf8").split("\n").find(Boolean)!);
      expect(first.m.result._meta.agentVersion, `${v}: the fixture's initialize answer is this version`).toBe(v);
      expect(evidence, `${v}: audit entry in docs/evidence/grok-leader-observer-236/README.md`).toContain(`### grok ${v} (${row.build})`);
    }
  });
  it("the binary's version is read once and cached; an unreadable one is null (so: not audited)", () => {
    resetGrokVersionCache(); let calls = 0;
    expect(readGrokVersion("/x/grok", () => { calls++; return "grok 1.0.77 (a) [stable]"; })).toBe("1.0.77");
    expect(readGrokVersion("/x/grok", () => { calls++; return "grok 9.9.9"; })).toBe("1.0.77");
    expect(calls).toBe(1);
    expect(readGrokVersion("/y/grok", () => { throw new Error("no such binary"); })).toBeNull();
    resetGrokVersionCache();
  });
  it("the observer itself refuses a grok whose initialize answer is not an audited build, or has no session/load — and sends no load", () => {
    for (const result of [
      { protocolVersion: 1, agentCapabilities: { loadSession: true }, _meta: { agentVersion: "1.1.0" } },
      { protocolVersion: 1, agentCapabilities: { loadSession: true }, _meta: {} },
      { protocolVersion: 1, agentCapabilities: { loadSession: false }, _meta: { agentVersion: "1.0.77" } },
    ]) {
      const h = observe(); let closed = "";
      (h.obs as any).o.onClose = (r: string) => { closed = r; };
      h.tr.push({ jsonrpc: "2.0", id: 1, result });
      expect(h.tr.written.map((m) => m.method)).toEqual(["initialize"]);
      expect(h.obs.isClosed).toBe(true);
      expect(closed).not.toBe("");
      expect(h.tr.closedBy).toBe("observer");
    }
  });
});

describe("rule 3 — the observer is read-only", () => {
  it("over the whole real session it sends exactly initialize and session/load — nothing else", () => {
    const h = observe();
    play(h);
    expect(h.tr.written.map((m) => m.method)).toEqual(["initialize", "session/load"]);
    expect(h.obs.sent).toEqual(["initialize", "session/load"]);
    expect([...OBSERVER_ALLOWED_METHODS]).toEqual(["initialize", "session/load"]);
    // what it does send: no capabilities (no fs, no terminal), an empty MCP list (it starts nothing), the session it was told
    expect(h.tr.written[0].params.clientCapabilities).toEqual({});
    expect(h.tr.written[1].params).toEqual({ sessionId: SID, cwd: "/work/instance", mcpServers: [] });
  });
  it("any other request is refused before a byte is written (prompt, cancel, set_mode, an extension call)", () => {
    const h = observe();
    for (const method of ["session/prompt", "session/cancel", "session/set_mode", "session/set_model", "x.ai/session/set", "session/request_permission", "fs/write_text_file"]) {
      expect(() => (h.obs as any).send(method, 9, {}), method).toThrow(/read-only/);
    }
    expect(h.tr.written.map((m) => m.method)).toEqual(["initialize"]);
  });
  it("the module names no other request: only initialize and session/load appear as a method it sends", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "src", "backend", "grok-acp-observer.ts"), "utf8");
    const sends = [...src.matchAll(/this\.send\(\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(sends.sort()).toEqual(["initialize", "session/load"]);
    // no other write path to the leader than send()
    expect([...src.matchAll(/transport\.send\(/g)]).toHaveLength(1);
    for (const method of ["session/prompt", "session/cancel", "session/set_", "x.ai/session/set", "terminal/", "fs/write"]) expect(src.includes(`"${method}`), method).toBe(false);
  });
  it("agent→client lines that are not responses (an id and a method) never get an answer — whatever they ask", () => {
    const h = observe();
    h.tr.push({ jsonrpc: "2.0", id: 1, result: frames[0]!.m.result });
    h.tr.push({ jsonrpc: "2.0", id: 2, result: {} });
    const before = h.tr.written.length;
    // ids 1 and 2 are the ones the observer itself used: an agent REQUEST with such an id must not be mistaken for a response
    for (const m of ["session/request_permission", "fs/read_text_file", "terminal/create", "x.ai/anything"]) h.tr.push({ jsonrpc: "2.0", id: 1, method: m, params: {} });
    h.tr.push({ jsonrpc: "2.0", id: 2, method: "session/request_permission", params: {} });
    expect(h.tr.written).toHaveLength(before);
    expect(h.obs.unanswered["session/request_permission"]).toBe(2);
    expect(h.obs.unanswered["fs/read_text_file"]).toBe(1);
    expect(h.obs.sent).toEqual(["initialize", "session/load"]);            // one load: the repeated "id 1" requests did not trigger another
  });
});

describe("rule 2 — a permission request stays with the TUI", () => {
  it("walking it frame by frame: waiting from the request (or its pending_interaction) until interaction_resolved, answers sent: none", () => {
    const h = observe(); const waiting: boolean[] = [];
    for (const f of frames) { h.at(f.t); h.tr.push(f.m); waiting.push(h.obs.live().permissionWaiting); }
    const up = waiting.indexOf(true), down = waiting.indexOf(false, up);
    expect(up).toBeGreaterThan(0); expect(down).toBeGreaterThan(up);
    const resolved = frames.findIndex((f) => f.m.params?.update?.sessionUpdate === "interaction_resolved");
    expect(down).toBe(resolved);
    expect(h.tr.written.map((m) => m.method)).toEqual(["initialize", "session/load"]);   // nothing was ever a response to the request
    expect(h.tr.written.some((m) => m.result !== undefined || m.error !== undefined)).toBe(false);
    expect(h.obs.unanswered["session/request_permission"]).toBe(1);
  });
});

describe("the live state, from the real session", () => {
  it("updates before the load's answer are grok replaying history, not now — ignored", () => {
    const h = observe();
    h.tr.push({ jsonrpc: "2.0", id: 1, result: frames[0]!.m.result });
    h.tr.push({ jsonrpc: "2.0", method: "session/update", params: { sessionId: SID, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "old" } } } });
    expect(h.obs.live().thought).toBe("");
    expect(h.obs.isLoaded).toBe(false);
    h.tr.push({ jsonrpc: "2.0", id: 2, result: {} });
    expect(h.obs.isLoaded).toBe(true);
    h.tr.push({ jsonrpc: "2.0", method: "session/update", params: { sessionId: SID, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "new" } } } });
    expect(h.obs.live().thought).toBe("new");
  });
  it("a refused load closes the observer", () => {
    const h = observe();
    h.tr.push({ jsonrpc: "2.0", id: 1, result: frames[0]!.m.result });
    h.tr.push({ jsonrpc: "2.0", id: 2, error: { code: -32602, message: "no such session" } });
    expect(h.obs.isClosed).toBe(true); expect(h.obs.isLoaded).toBe(false);
  });
  it("the thought is in hand while the turn is still open — seconds before the turn ends (the whole point)", () => {
    // turn 4 of the capture: a 6 s tool, a thought, a 6 s tool, "OK". The thought arrived ~16 s before turn_completed.
    const h = observe();
    const starts = frames.map((f, i) => (kind(f) === "user_message_chunk" ? i : -1)).filter((i) => i >= 0);
    const t4 = starts[3]!;
    const firstThought = frames.findIndex((f, i) => i > t4 && kind(f) === "agent_thought_chunk");
    const completed = frames.findIndex((f, i) => i > t4 && f.m.params?.update?.sessionUpdate === "turn_completed");
    play(h, (_f, i) => i === firstThought + 1);
    const mid = h.obs.live();
    expect(mid.turnOpen).toBe(true);
    expect(mid.thought).toMatch(/Running the first command/);
    expect(frames[completed]!.t - frames[firstThought]!.t).toBeGreaterThan(10_000);       // seconds earlier than the turn's end, by the capture's own clock
  });
  it("a tool call goes pending → running while it runs, and its title is the command; it is completed when it ends", () => {
    const h = observe(); const seen: string[] = [];
    for (const f of frames) {
      h.at(f.t); h.tr.push(f.m);
      const sleepCall = h.obs.live().tools.find((t) => /sleep 6; echo step-a/.test(t.title));
      if (sleepCall && seen[seen.length - 1] !== sleepCall.status) seen.push(sleepCall.status);
    }
    expect(seen).toEqual(["pending", "running", "completed"]);
  });
  it("turn boundaries: a new prompt starts a clean turn, turn_completed ends it, and the last state still has the tools as completed", () => {
    const h = observe(); const open: boolean[] = [];
    for (const f of frames) { h.at(f.t); h.tr.push(f.m); if (open[open.length - 1] !== h.obs.live().turnOpen) open.push(h.obs.live().turnOpen); }
    expect(open).toEqual([false, true, false, true, false, true, false, true, false]);
    const end = h.obs.live();
    expect(end.turnOpen).toBe(false);
    expect(end.tools.every((t) => t.status === "completed")).toBe(true);
  });
  it("noise (queue/models/commands updates, unknown kinds, another session's updates) changes nothing", () => {
    const s = emptyLive(SID, 0);
    for (const m of [
      { method: "_x.ai/queue/changed", params: { sessionId: SID } },
      { method: "session/update", params: { sessionId: SID, update: { sessionUpdate: "available_commands_update" } } },
      { method: "session/update", params: { sessionId: SID, update: { sessionUpdate: "a_kind_from_the_future", content: { text: "x" } } } },
      { method: "session/update", params: { sessionId: "11111111-1111-4111-8111-111111111111", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "other session" } } } },
      "not an object", null, { method: 5 },
    ]) expect(reduceLive(s, m, 1)).toBe(false);
    expect(s).toEqual(emptyLive(SID, 0));
  });
  it("bounded: a huge thought keeps its newest 4000 characters, and tools are capped", () => {
    const s = emptyLive(SID, 0);
    for (let i = 0; i < 50; i++) reduceLive(s, { method: "session/update", params: { sessionId: SID, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "x".repeat(500) + i } } } }, 1);
    expect(s.thought.length).toBe(4000);
    expect(s.thought.endsWith("49")).toBe(true);
    for (let i = 0; i < 60; i++) reduceLive(s, { method: "session/update", params: { sessionId: SID, update: { sessionUpdate: "tool_call", toolCallId: `c${i}`, title: "t".repeat(1000) } } }, 1);
    expect(s.tools.length).toBeLessThanOrEqual(24);
    expect(s.tools.every((t) => t.title.length <= 300)).toBe(true);
  });
  it("garbage and oversize lines from the leader are dropped, not thrown", () => {
    const h = observe();
    expect(() => { (h.tr as any).line("not json"); (h.tr as any).line("[1,2]"); (h.tr as any).line("x".repeat(1_100_000)); }).not.toThrow();
  });
});

describe("liveView — what the chat may be sent of it", () => {
  const live = (over: Record<string, unknown> = {}) => {
    const s = emptyLive(SID, 0); s.turnOpen = true; s.turnStartedAt = 5; s.thought = "I should run the build first";
    s.tools = [{ id: "c1", title: "Execute `cat ~/.ssh/config`", kind: "execute", status: "running" }, { id: "c0", title: "Read a.txt", kind: "read", status: "completed" }];
    return Object.assign(s, over);
  };
  it("verbose: the call's title; standard: only its kind (a title holds a command line or a path)", () => {
    expect(liveView(live(), "verbose", false)!.tools).toEqual([{ id: "c1", label: "Execute `cat ~/.ssh/config`" }]);
    expect(liveView(live(), "standard", false)!.tools).toEqual([{ id: "c1", label: "execute" }]);
    expect(JSON.stringify(liveView(live(), "standard", true))).not.toContain(".ssh");
  });
  it("thinking only for a viewer who may have it", () => {
    expect(liveView(live(), "verbose", false)).not.toHaveProperty("thought");
    expect(liveView(live(), "verbose", true)!.thought).toBe("I should run the build first");
    expect(liveView(live({ thought: "y".repeat(5000) }), "verbose", true)!.thought!.length).toBe(600);
  });
  it("no turn open (or nothing observed): null", () => {
    expect(liveView(live({ turnOpen: false }), "verbose", true)).toBeNull();
    expect(liveView(null, "verbose", true)).toBeNull();
  });
});

describe("rule 1 — one leader per instance, on its own short socket", () => {
  it("the path is <dir>/agend-grok-<uid>/<12 hex>.sock — the same for an instance, different for another, short however long the instance dir is", () => {
    const a = grokLeaderSocketPath("/home/u/.agend/instances/alpha", { uid: 1000, runtimeDir: "/run/user/1000" });
    const a2 = grokLeaderSocketPath("/home/u/.agend/instances/alpha", { uid: 1000, runtimeDir: "/run/user/1000" });
    const b = grokLeaderSocketPath("/home/u/.agend/instances/beta", { uid: 1000, runtimeDir: "/run/user/1000" });
    expect(a).toEqual(a2);
    expect(a.ok && b.ok && a.path !== b.path).toBe(true);
    expect(a.ok && a.path).toMatch(/^\/run\/user\/1000\/agend-grok-1000\/[0-9a-f]{12}\.sock$/);
    const long = grokLeaderSocketPath("/home/u/" + "very-long-directory-name/".repeat(20) + "instance", { uid: 1000, runtimeDir: "/run/user/1000" });
    expect(long.ok && Buffer.byteLength(long.path)).toBeLessThan(GROK_SOCKET_PATH_MAX + 1);
  });
  it("a runtime dir that would make it too long is skipped for the temp dir", () => {
    const r = grokLeaderSocketPath("/i/x", { uid: 7, runtimeDir: "/" + "r".repeat(120), tmp: "/tmp" });
    expect(r.ok && r.path.startsWith("/tmp/agend-grok-7/")).toBe(true);
    const mac = grokLeaderSocketPath("/i/x", { uid: 501, runtimeDir: undefined, tmp: "/var/folders/zz/abcdefghijklmnopqrstuvwxyz0123456789/T" });
    expect(mac.ok && Buffer.byteLength(mac.path)).toBeLessThan(104);        // macOS sun_path is 104 bytes
  });
  it("the limit is the measured one: grok 1.0.77 accepted a 107-byte socket path and refused 108", () => {
    expect(GROK_SOCKET_PATH_MAX).toBeLessThan(107);
  });
  it("the directory is a plain directory of ours with mode 0700; a symlink or a foreign owner is refused", () => {
    const root = scratch(); const dir = join(root, "agend-grok-1");
    ensureSocketDir(dir); expect(statSync(dir).mode & 0o777).toBe(0o700);
    ensureSocketDir(dir);                                                    // again: fine
    const target = join(root, "elsewhere"); mkdirSync(target); const link = join(root, "link");
    symlinkSync(target, link);
    expect(() => ensureSocketDir(link)).toThrow(/plain directory/);
    expect(() => ensureSocketDir(dir, (process.getuid?.() ?? 0) + 1)).toThrow(/another user/);
  });
  it("the TUI's flags name that socket, quoted, in place of --no-leader", () => {
    expect(grokLeaderLaunchFlags("/run/user/1000/agend-grok-1000/abc.sock")).toBe("--leader --leader-socket '/run/user/1000/agend-grok-1000/abc.sock'");
  });
  it("stopping a leader: by the pid in the instance's own lock file, only a grok `agent leader` of THIS socket, never by name", () => {
    const dir = scratch(); const sock = join(dir, "abc.sock");
    writeFileSync(leaderLockPath(sock), "4242\n");
    const killed: Array<[number, string]> = []; const removed: string[] = [];
    const deps = (args: string[] | null, env: string | null = null) => ({ args: () => args, socketEnv: () => env, kill: (p: number, s: string) => { killed.push([p, s]); }, unlink: (p: string) => { removed.push(p); } }) as any;
    // the leader the TUI spawned: no --leader-socket in its argv, the socket in its environment
    expect(stopGrokLeader(sock, deps(["/h/.grok/bin/grok", "agent", "leader", "--no-exit-on-disconnect"], sock))).toBe("stopped");
    expect(killed).toEqual([[4242, "SIGTERM"]]);
    expect(removed).toEqual([]);                                   // not before the process is seen to be gone (the host removes them then)
    // a leader we named on its argv
    killed.length = 0;
    expect(stopGrokLeader(sock, deps(["grok", "agent", "leader", "--leader-socket", sock]))).toBe("stopped");
    expect(killed).toHaveLength(1);
    // other processes with that pid (pid reuse), another instance's leader, a grok that is not a leader: left alone
    killed.length = 0;
    expect(stopGrokLeader(sock, deps(["/usr/bin/vim", "x"]))).toBe("not-a-leader");
    expect(stopGrokLeader(sock, deps(["grok", "agent", "leader", "--leader-socket", "/run/other.sock"], "/run/other.sock"))).toBe("not-a-leader");
    expect(stopGrokLeader(sock, deps(["grok", "--leader", "--leader-socket", sock]))).toBe("not-a-leader");
    expect(killed).toEqual([]);
    // the pid is gone: only the stale files go
    removed.length = 0;
    expect(stopGrokLeader(sock, deps(null))).toBe("none");
    expect(removed).toEqual([sock, leaderLockPath(sock)]);
    // no lock file at all
    expect(stopGrokLeader(join(dir, "none.sock"), deps(["grok", "agent", "leader"]))).toBe("none");
  });
});

describe("rule 5 — the default is unchanged", () => {
  const cfg = (over: Record<string, unknown> = {}) => ({ workingDirectory: "/w", instanceDir: scratch(), instanceName: "g1", mcpServers: {}, ...over }) as any;
  it("no opt-in: the launch is --no-leader, exactly as before", () => {
    const cmd = new GrokBackend(scratch()).buildCommand(cfg());
    expect(cmd).toMatch(/ --no-auto-update --no-leader --always-approve/);
    expect(cmd).not.toContain("--leader-socket");
  });
  it("a socket (set by the daemon only when opted in and gated): --leader --leader-socket, no --no-leader", () => {
    const cmd = new GrokBackend(scratch()).buildCommand(cfg({ grokLeaderSocket: "/run/user/1/agend-grok-1/abc.sock" }));
    expect(cmd).toContain(" --no-auto-update --leader --leader-socket '/run/user/1/agend-grok-1/abc.sock' --always-approve");
    expect(cmd).not.toContain("--no-leader");
  });
  it("the switch is the literal true of backend_options.grok.leader_observer — nothing else turns it on", () => {
    expect(grokLeaderRequested(undefined)).toBe(false);
    expect(grokLeaderRequested({})).toBe(false);
    expect(grokLeaderRequested({ grok: {} })).toBe(false);
    for (const v of ["true", 1, "yes", null, {}, [], "on"]) expect(grokLeaderRequested({ grok: { leader_observer: v } }), String(v)).toBe(false);
    expect(grokLeaderRequested({ codex: { leader_observer: true } })).toBe(false);
    expect(grokLeaderRequested({ grok: { leader_observer: true } })).toBe(true);
  });
  it("the config validator takes a boolean and refuses anything else", () => {
    const check = (v: unknown) => validateFleetConfig({ defaults: {}, instances: { g: { working_directory: "/w", backend: "grok", backend_options: { grok: { leader_observer: v } } } } } as any);
    expect(check(true).errors.filter((e: any) => /leader_observer/.test(e.path))).toEqual([]);
    expect(check("yes").errors.some((e: any) => /leader_observer/.test(e.path))).toBe(true);
  });
  it("not requested: the host does nothing at all — no version probe, no socket, no leader stopped", async () => {
    let touched = 0;
    const deps: HostDeps = { version: () => { touched++; return "1.0.77"; }, stopLeader: () => { touched++; return "none"; } };
    const host = new GrokLeaderHost({ instanceName: "g", instanceDir: scratch(), cwd: "/w", binary: "grok", backendOptions: { grok: {} }, sessionId: () => SID, onChange() {}, log() {}, deps });
    expect(await host.prepare()).toBeNull();
    host.begin(); host.tick();
    expect(host.live()).toBeNull();
    await host.stop();
    expect(touched).toBe(0);
  });
  it("the log service sends no `live` unless it is asked for one and the instance has an observer", async () => {
    const s = chatSession();
    const a: any = await svc(s.updates).steps("x", { chat: true });
    expect("live" in a).toBe(false);
  });
});

describe("the host — the instance's leader and observer lifecycle", () => {
  const mk = (over: Partial<HostDeps> = {}, o: Record<string, unknown> = {}) => {
    const events: string[] = []; const transports: FakeTransport[] = []; let sid: string | null = SID; let leaderUp = true; let clock = 1_000_000; let timer: (() => void) | null = null;
    const deps: HostDeps = {
      version: () => "1.0.77",
      stopLeader: () => { events.push("stopLeader"); return "stopped"; },
      leaderAlive: () => leaderUp,
      transport: () => { const t = new FakeTransport(); transports.push(t); events.push("bridge"); return t; },
      now: () => clock, setInterval: (fn) => { timer = fn; return 1; }, clearInterval: () => { timer = null; },
      ...over,
    };
    const host = new GrokLeaderHost({ instanceName: "g", instanceDir: scratch(), cwd: "/w", binary: "grok", backendOptions: { grok: { leader_observer: true } }, sessionId: () => sid, onChange: () => events.push("change"), log: (l, m) => events.push(`${l}:${m}`), deps, ...o });
    return { host, events, transports, setSid: (s: string | null) => { sid = s; }, setLeader: (b: boolean) => { leaderUp = b; }, advance: (ms: number) => { clock += ms; }, tickTimer: () => timer?.(), hasTimer: () => timer !== null };
  };
  const load = (t: FakeTransport) => { t.push({ jsonrpc: "2.0", id: 1, result: frames[0]!.m.result }); t.push({ jsonrpc: "2.0", id: 2, result: {} }); };

  it("prepare: stops whatever the last launch left (so the TUI starts a fresh leader with THIS launch's environment), returns the socket", async () => {
    const h = mk();
    const sock = await h.host.prepare();
    expect(sock).toMatch(/agend-grok-\d+\/[0-9a-f]{12}\.sock$/);
    expect(h.events).toContain("stopLeader");
  });
  it("an unaudited grok: not used, the launch is as before (null socket), and nothing is stopped or started", async () => {
    const h = mk({ version: () => "1.1.0" });
    expect(await h.host.prepare()).toBeNull();
    expect(h.events.some((e) => e.startsWith("warn:"))).toBe(true);
    expect(h.events).not.toContain("stopLeader");
    h.host.begin(); expect(h.hasTimer()).toBe(false);
  });
  it("the observer attaches only when the instance's own leader exists AND the session id is known — never starting a leader itself", async () => {
    const h = mk();
    await h.host.prepare(); h.host.begin();
    h.setLeader(false); h.tickTimer();
    expect(h.transports).toHaveLength(0);                                    // `grok agent --leader stdio` would SPAWN one here
    h.setLeader(true); h.setSid(null); h.tickTimer();
    expect(h.transports).toHaveLength(0);
    h.setSid("not-a-uuid"); h.tickTimer();
    expect(h.transports).toHaveLength(0);
    h.setSid(SID); h.tickTimer();
    expect(h.transports).toHaveLength(1);
    h.tickTimer();
    expect(h.transports).toHaveLength(1);                                    // one observer, not one per tick
    expect(h.transports[0]!.written.map((m) => m.method)).toEqual(["initialize"]);
    expect(h.host.live()).toBeNull();                                        // not loaded yet: nothing claimed
    load(h.transports[0]!);
    expect(h.host.live()).not.toBeNull();
  });
  it("the TUI's session changes (/new, /resume): the observer is dropped and attached to the new one", async () => {
    const h = mk();
    await h.host.prepare(); h.host.begin(); h.tickTimer(); load(h.transports[0]!);
    h.setSid("11111111-1111-4111-8111-111111111111"); h.tickTimer();
    expect(h.transports[0]!.closedBy).toBe("observer");
    expect(h.transports).toHaveLength(2);
    expect(h.transports[1]!.written.map((m) => m.method)).toEqual(["initialize"]);
  });
  it("the bridge dies (leader gone, grok crashed): the live state is dropped, and the next attach waits out a backoff", async () => {
    const h = mk();
    await h.host.prepare(); h.host.begin(); h.tickTimer(); load(h.transports[0]!);
    h.transports[0]!.end("exited 1");
    expect(h.host.live()).toBeNull();
    h.tickTimer(); expect(h.transports).toHaveLength(1);                     // backing off
    h.advance(2500); h.tickTimer(); expect(h.transports).toHaveLength(2);
  });
  it("stop: the observer first, then the instance's leader; the timer is cleared; a second stop is harmless", async () => {
    const h = mk();
    await h.host.prepare(); h.host.begin(); h.tickTimer();
    h.events.length = 0;
    await h.host.stop();
    expect(h.transports[0]!.closedBy).toBe("observer");
    expect(h.events).toContain("stopLeader");
    expect(h.hasTimer()).toBe(false);
    await h.host.stop();
    h.tickTimer(); expect(h.transports).toHaveLength(1);
  });
  it("a relaunch: the previous launch's observer and poll are dropped BEFORE its leader is stopped (a bridge whose leader dies would start one of its own), and nothing re-attaches meanwhile", async () => {
    const order: string[] = []; let h!: ReturnType<typeof mk>;
    h = mk({ stopLeader: () => { order.push(`stopLeader(observerClosed=${h.transports[0]?.closedBy}, poll=${h.hasTimer()})`); h.tickTimer(); order.push(`transports=${h.transports.length}`); return "stopped"; } });
    await h.host.prepare(); h.host.begin(); h.tickTimer(); load(h.transports[0]!);
    expect(h.host.live()).not.toBeNull();
    order.length = 0;
    expect(await h.host.prepare()).not.toBeNull();
    expect(order).toEqual(["stopLeader(observerClosed=observer, poll=false)", "transports=1"]);
    expect(h.host.live()).toBeNull();
    h.host.begin(); h.tickTimer();                                               // after the new launch: attached again
    expect(h.transports).toHaveLength(2);
  });
  it("an unlisted version (a later patch too): not used — the launch is --no-leader, no observer, a warning, and nothing fails", async () => {
    for (const version of ["1.0.78", "1.0.76", "2.0.0", null]) {
      const h = mk({ version: () => version });
      expect(await h.host.prepare(), String(version)).toBeNull();
      expect(h.events.some((e) => e.startsWith("warn:") && e.includes("audited list")), String(version)).toBe(true);
      expect(h.events).not.toContain("stopLeader");
      expect(h.host.socketPath).toBeNull();
      h.host.begin(); expect(h.hasTimer()).toBe(false);
    }
  });
  it("fail closed: a lock file that names a process that is not this instance's leader — no socket (so --no-leader), no observer, nothing signalled", async () => {
    const h = mk({ stopLeader: () => "not-a-leader" });
    expect(await h.host.prepare()).toBeNull();
    expect(h.events.some((e) => e.startsWith("warn:the pid in the leader lock file"))).toBe(true);
    expect(h.events.some((e) => e.startsWith("warn:grok leader observer:") && e.includes("--no-leader"))).toBe(true);
    expect(h.host.socketPath).toBeNull();
    h.host.begin(); expect(h.hasTimer()).toBe(false);
    h.tickTimer(); expect(h.transports).toHaveLength(0);
  });
  it("fail closed, with the real check: a lock file pointing at a foreign process (this test process) is left alone and the launch gets no socket", async () => {
    const instanceDir = scratch(); let sock = "";
    const h = mk({}, { instanceDir });
    const deps: HostDeps = { version: () => "1.0.77" };            // stopLeader, pidAlive: the real ones
    const host = new GrokLeaderHost({ instanceName: "g", instanceDir, cwd: "/w", binary: "grok", backendOptions: { grok: { leader_observer: true } }, sessionId: () => SID, onChange: () => undefined, log: (l, m) => h.events.push(`${l}:${m}`), deps });
    const first = grokLeaderSocketPath(instanceDir); if (!first.ok) throw new Error("no socket path"); sock = first.path;
    ensureSocketDir(first.dir);
    writeFileSync(leaderLockPath(sock), `${process.pid}\n`);         // a live process that is not a `grok agent leader`
    try {
      expect(await host.prepare()).toBeNull();
      expect(host.socketPath).toBeNull();
      expect(readFileSync(leaderLockPath(sock), "utf8").trim()).toBe(String(process.pid));   // the record is kept
      expect(h.events.some((e) => e.startsWith("warn:the pid in the leader lock file"))).toBe(true);
    } finally { rmSync(leaderLockPath(sock), { force: true }); }
  });
  it("fail closed: a leader that was told to stop and is still running after the wait — the TUI does not join it (no socket, no observer), its lock file is kept", async () => {
    const instanceDir = scratch();
    const first = grokLeaderSocketPath(instanceDir); if (!first.ok) throw new Error("no socket path"); ensureSocketDir(first.dir);
    writeFileSync(leaderLockPath(first.path), "4242\n"); writeFileSync(first.path, "");
    const events: string[] = []; let polls = 0; let slept = 0;
    const deps: HostDeps = { version: () => "1.0.77", stopLeader: () => { events.push("sigterm"); return "stopped"; }, pidAlive: () => { polls++; return true; }, sleep: async (ms) => { slept += ms; } };
    const host = new GrokLeaderHost({ instanceName: "g", instanceDir, cwd: "/w", binary: "grok", backendOptions: { grok: { leader_observer: true } }, sessionId: () => SID, onChange: () => undefined, log: (l, m) => events.push(`${l}:${m}`), deps });
    try {
      expect(await host.prepare()).toBeNull();
      expect(host.socketPath).toBeNull();
      expect(slept).toBe(3000);                                                     // the bounded wait: 30 × 100 ms, then it gives up
      expect(events.some((e) => e.startsWith("warn:") && e.includes("did not exit in time") && e.includes("--no-leader"))).toBe(true);
      expect(existsSync(leaderLockPath(first.path)) && existsSync(first.path)).toBe(true);   // still there: the next launch retries the stop
      host.begin(); expect(host.socketPath).toBeNull();
    } finally { rmSync(leaderLockPath(first.path), { force: true }); rmSync(first.path, { force: true }); }
    expect(polls).toBeGreaterThan(0);
  });
  it("a leader that exits during the wait: the files are removed and the launch gets the socket", async () => {
    const instanceDir = scratch();
    const first = grokLeaderSocketPath(instanceDir); if (!first.ok) throw new Error("no socket path"); ensureSocketDir(first.dir);
    writeFileSync(leaderLockPath(first.path), "4242\n"); writeFileSync(first.path, "");
    let alive = true; let sleeps = 0;
    const deps: HostDeps = { version: () => "1.0.77", stopLeader: () => "stopped", pidAlive: () => alive, sleep: async () => { if (++sleeps === 3) alive = false; } };
    const host = new GrokLeaderHost({ instanceName: "g", instanceDir, cwd: "/w", binary: "grok", backendOptions: { grok: { leader_observer: true } }, sessionId: () => SID, onChange: () => undefined, log: () => undefined, deps });
    expect(await host.prepare()).toBe(first.path);
    expect(existsSync(leaderLockPath(first.path)) || existsSync(first.path)).toBe(false);
  });
});

const chatSession = () => {
  const dir = join(scratch(), ".grok", "sessions", "%2Fwork", "01a1ce90-0114-7dc2-9d69-da3fddae4e20");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "updates.jsonl"), JSON.stringify({ timestamp: 1, method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "hi" } }, _meta: { agentTimestampMs: 1000 } } }) + "\n");
  return { updates: join(dir, "updates.jsonl") };
};
const liveOf = (over: Record<string, unknown> = {}) => {
  const s = emptyLive(SID, 0); s.turnOpen = true; s.turnStartedAt = 7; s.thought = "weighing two options"; s.replying = false;
  s.tools = [{ id: "c1", title: "Execute `sleep 6; echo step-a`", kind: "execute", status: "running" }];
  return Object.assign(s, over);
};
const svc = (path: string, over: Partial<LogServiceDeps> = {}) => new LogService({ enabled: () => false, toolProgress: () => "verbose", thinking: () => true, known: () => true, source: () => ({ backend: "grok", path, format: "grok" }), events: () => [], emit: () => {}, ...over });

describe("the log service: `live` in the chat's answer", () => {
  it("chat + grok + an open turn: the running call and (for an admin with thinking on) the thought", async () => {
    const s = chatSession();
    const a: any = await svc(s.updates, { grokLive: () => liveOf() }).steps("x", { chat: true, thinking: true });
    expect(a.live).toEqual({ startedAt: 7, replying: false, permissionWaiting: false, tools: [{ id: "c1", label: "Execute `sleep 6; echo step-a`" }], thought: "weighing two options" });
  });
  it("thinking off (web.log_thinking, or not asked): no thought; tool_progress standard: the kind, not the command", async () => {
    const s = chatSession();
    expect(((await svc(s.updates, { grokLive: () => liveOf(), thinking: () => false }).steps("x", { chat: true, thinking: true })) as any).live).not.toHaveProperty("thought");
    expect(((await svc(s.updates, { grokLive: () => liveOf() }).steps("x", { chat: true })) as any).live).not.toHaveProperty("thought");
    const std: any = await svc(s.updates, { grokLive: () => liveOf(), toolProgress: () => "standard" }).steps("x", { chat: true, thinking: true });
    expect(std.live.tools).toEqual([{ id: "c1", label: "execute" }]);
    expect(JSON.stringify(std)).not.toContain("sleep 6");
  });
  it("tool_progress off, the Log tab's own request, another backend, a closed turn, no observer: no `live`", async () => {
    const s = chatSession();
    const has = async (over: Partial<LogServiceDeps>, q: object) => "live" in ((await svc(s.updates, { grokLive: () => liveOf(), ...over }).steps("x", q)) as any);
    expect(await has({ toolProgress: () => "off" }, { chat: true })).toBe(false);
    expect(await has({ enabled: () => true }, {})).toBe(false);
    expect(await has({ source: () => ({ backend: "claude-code", path: s.updates, format: "claude" }) }, { chat: true })).toBe(false);
    expect(await has({ grokLive: () => liveOf({ turnOpen: false }) }, { chat: true })).toBe(false);
    expect(await has({ grokLive: () => null }, { chat: true })).toBe(false);
    expect(await has({ grokLive: undefined }, { chat: true })).toBe(false);
  });
  it("read when the answer leaves: tool_progress turned off while the answer was made leaves no `live`", async () => {
    const s = chatSession(); let level: "verbose" | "off" = "verbose";
    const sv = svc(s.updates, { toolProgress: () => level, grokLive: () => { level = "off"; return liveOf(); } });
    const a: any = await sv.steps("x", { chat: true });
    expect("live" in a).toBe(false);
  });
});

type Mod = any;
let thread: Mod, act: Mod, i18n: Mod;
beforeAll(async () => {
  // @ts-expect-error — a JS module of the app, with no types
  await import("../src/ui/chat-render.js");
  const base = installDom({ storage: { agend_tour_done: "1" } });
  thread = await import("/ui/js/chat-thread.js");
  act = await import("/ui/js/chat-activity.js");
  await import("/ui/js/chat-strings.js");
  i18n = await import("/assets/app-i18n.js");
  base.restore();
});
let pg: AppPage | null = null;
afterEach(async () => { await pg?.unmount(); pg?.restore(); pg = null; act.forgetActivity(); });

describe("the page: the live line and the thought of the observed turn", () => {
  const PROMPT = 1794462778828;
  const rows = [{ role: "user", boot: "b", id: "web-1", anchor: "web-1", text: "go", ts: new Date(PROMPT).toISOString() }];
  const prompt = { id: "u1", kind: "user", ts: PROMPT, anchor: { messageId: "web-1" } };
  const mount = (thinking: boolean) => {
    pg = page({ storage: { agend_tour_done: "1" } });
    const doc = pg.document as any;
    const scroller = doc.createElement("div"), list = doc.createElement("div");
    scroller.append(list); doc.body.append(scroller);
    const th = thread.createThread(list, scroller, {
      t: (k: string) => i18n.t(k), tf: (k: string, ...a: unknown[]) => i18n.t(k, ...a), isUser: (x: any) => x.role === "user", onJump() {}, onEmpty() {},
      setPreviewOptIn() {}, copyText: async () => true, download() {}, toggleWrap() {},
      activity: { mount: (node: unknown, g: unknown) => act.mountActivity(node, g, () => ({ paths: null, thinking })) },
    });
    return { list, th };
  };
  const draw = async (grok: any, thinking = true) => {
    const { list, th } = mount(thinking);
    th.render(composeRows(rows, groupSteps(rows, [prompt], { now: Date.now(), complete: true, busy: true, grok })));
    await settle();
    return list;
  };
  it("a call running now is the line; the thought is the block's first note", async () => {
    const list = await draw({ tools: [{ label: "Execute `sleep 6`" }], permissionWaiting: false, replying: false, thought: "weighing two options" });
    expect(list.querySelector(".act-title").textContent).toBe("Execute `sleep 6`");
    expect(list.querySelector(".act-thought").textContent).toContain("weighing two options");
  });
  it("permission waiting and replying have their words; thinking hidden by the page hides the thought; no grok info is the plain line", async () => {
    expect((await draw({ tools: [{ label: "x" }], permissionWaiting: true, replying: false, thought: "" })).querySelector(".act-title").textContent).toBe(i18n.t("act.ph_permission"));
    await pg?.unmount(); pg?.restore(); pg = null;
    expect((await draw({ tools: [], permissionWaiting: false, replying: true, thought: "" })).querySelector(".act-title").textContent).toBe(i18n.t("act.ph_text"));
    await pg?.unmount(); pg?.restore(); pg = null;
    expect((await draw({ tools: [], permissionWaiting: false, replying: false, thought: "secret plan" }, false)).querySelector(".act-thought")).toBeNull();
    await pg?.unmount(); pg?.restore(); pg = null;
    expect((await draw(null)).querySelector(".act-title").textContent).toBe(i18n.t("act.working"));
  });
  it("the feed keeps only what the page can show of `live`: bounded strings, no other field", async () => {
    const answer = (live: unknown) => ({ enabled: true, supported: true, level: "verbose", thinking: true, steps: [prompt], key: "1-1", after: 10, before: null, ev: 0, live });
    let next: any = answer({ tools: [{ id: "c", label: "L".repeat(1000), secret: "x" }], permissionWaiting: true, replying: false, thought: "T".repeat(2000), extra: "no" });
    const feed = act.observeActivity("grok-236", { fetcher: async () => ({ ok: true, status: 200, json: async () => next }), changed() {}, working: () => true, setTimer: () => 0, clearTimer: () => {}, shown: () => true, now: () => PROMPT + 5000 });
    feed.start(); await settle(); await settle();
    const g = (r: any[]) => r.find((x) => x.role === "activity")?.group;
    const grok = g(feed.compose(rows)).grok;
    expect(grok.tools[0].label).toHaveLength(300);
    expect(grok.tools[0]).not.toHaveProperty("secret");
    expect(grok.thought).toHaveLength(600);
    expect(grok).not.toHaveProperty("extra");
    next = answer(undefined); feed.nudge(); await settle(); await settle();
    expect(g(feed.compose(rows)).grok).toBeUndefined();                      // the next answer says it afresh: nothing
    feed.stop();
  });
});
