/**
 * AGEND-279: a message sent as an interjection (Ctrl+Enter, the Interject button, `/steer text`) through /ui/send, the server's side.
 * `steer: true` hands the message to the agent as a steer when it is working and can take one (its row says how: `added`, `interrupted`,
 * `sent`); an agent that cannot gets it queued, marked `unsupported`; an idle agent just receives it, unmarked. The row keeps the mark, the
 * live copy and /ui/history carry it, a runner's later word (`interrupted`, `refused`) reaches the row and the pages, and a message that
 * waited and was then handed over says when (`sentAt`, where the thread puts it).
 * The real FleetManager's web server on a scratch home (nothing started: delivery is a spy).
 */
import { request } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const home = mkdtempSync(join(tmpdir(), "agend-steer-home-"));
process.env.AGEND_HOME = home;

const { FleetManager } = await import("../src/fleet-manager.js");
const { WEB_CSRF_HEADER, WEB_SESSION_COOKIE } = await import("../src/web-auth.js");
const { csrfTokenFor, tokenEpoch } = await import("../src/web-session.js");
const { bindAdapter } = await import("../src/adapters/registry.js");

function raw(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let b = ""; res.on("data", (c: Buffer) => { b += c.toString(); }); res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
    });
    r.on("error", reject); r.end(body);
  });
}
let fm: any, port = 0, dir: string;
const cookieOf = (sid: string) => `${WEB_SESSION_COOKIE}=${sid}`;
const write = (sid: string) => ({ cookie: cookieOf(sid), origin: `http://127.0.0.1:${port}`, [WEB_CSRF_HEADER]: csrfTokenFor(sid), "content-type": "application/json" });
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agend-steer-fleet-"));
  writeFileSync(join(dir, "fleet.yaml"), `health_port: 0\ninstances:\n  a:\n    working_directory: ${dir}\n    backend: claude-code\n  w:\n    working_directory: ${dir}\n    backend: claude-code\n    runtime: windows\n`);
  fm = new FleetManager(dir);
  const q = () => {}; fm.logger = { info: q, warn: q, error: q, debug: q, trace: q, fatal: q, child: () => fm.logger };
  fm.notifyFleetError = () => true; fm.loadConfig(join(dir, "fleet.yaml"));
  fm.lifecycle = { isPaused: () => false, hasWorkLease: () => false, daemons: new Map() };
  fm.getInstanceStatus = () => "running";
  // A guest of agent "a" (as tests/guest-grants-enforcement-2348.test.ts sets one up).
  fm.worlds.set("discord", { id: "discord", adapter: { type: "discord" }, accessManager: { getMode: () => "pairing", isAllowed: (u: string) => u === ALICE.userId } });
  fm.fleetConfig.web = { view_access: "session", guests: { enabled: true, grants: { [`${ALICE.adapterId}:${ALICE.userId}`]: { instances: ["a"] } } } };
  fm.initializeWebAuthTokens(); fm.startHealthServer(0);
  await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
  port = (fm.healthServer.address() as { port: number }).port;
  fm.initializeWebSessions?.();
});
afterAll(async () => {
  await new Promise<void>((r) => fm.healthServer?.close(() => r()));
  rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
});
afterEach(() => { vi.restoreAllMocks(); });
const ALICE = { adapterId: "discord", userId: "111111111111111111" };
const guestSession = () => fm.webSessions.create({ tier: "guest", surface: "local", label: "guest", tokenEpoch: tokenEpoch(fm.getDashboardAccess().token!), owner: ALICE }).sessionId as string;
const session = () => fm.webSessions.create({ tier: "admin", surface: "local", label: "admin", tokenEpoch: tokenEpoch(fm.getDashboardAccess().token!) }).sessionId as string;
/** A live stream client: what it is written, as frames. */
function liveClient() {
  const writes: string[] = [];
  const res = { write: (s: string) => { writes.push(s); return true; }, writableEnded: false, destroyed: false, on() {}, once() {}, end() {} };
  fm.sseClients.add(res);
  return { frames: () => writes.filter((w) => w.includes("event: message")).map((w) => JSON.parse(w.split("data: ")[1]!.split("\n")[0]!)), stop: () => fm.sseClients.delete(res) };
}
function delivering() {
  fm.instanceIpcClients.set("a", { connected: true, send: () => true });
  vi.spyOn(fm, "deliverHumanToInstance").mockImplementation(async () => true);
}


const post = (b: Record<string, unknown>) => raw(port, "POST", "/ui/send", write(session()), JSON.stringify({ instance: "a", ...b }));
function steering(mode: string) {
  fm.instanceIpcClients.set("a", { connected: true, send: () => true });
  vi.spyOn(fm, "webSteerMode").mockReturnValue(mode as never);
  const steer = vi.spyOn(fm, "sendWebSteer").mockReturnValue(true);
  const normal = vi.spyOn(fm, "deliverHumanToInstance").mockImplementation(async () => true);
  return { steer, normal };
}

describe("/ui/send with steer: true", () => {
  it.each([["add", "added"], ["interrupt", "interrupted"], ["native", "sent"]])("a working agent that can take it (%s): handed over as a steer, not queued; the row, the live copy and the answer say %s", async (mode, mark) => {
    const { steer, normal } = steering(mode);
    const live = liveClient();
    try {
      const r = await post({ message: "mid-turn", steer: true });
      expect(r.status, r.body).toBe(200);
      const answer = JSON.parse(r.body);
      expect(answer.steer).toBe(mark);
      expect(steer).toHaveBeenCalledTimes(1);
      expect(normal).not.toHaveBeenCalled();
      expect(steer.mock.calls[0]![1]).toMatchObject({ content: expect.stringContaining("mid-turn"), meta: { message_id: answer.messageId, source: "web" } });
      expect(fm.webChatHistory.list("a").at(-1)).toMatchObject({ text: "mid-turn", messageId: answer.messageId, steer: mark });
      expect(live.frames().at(-1)).toMatchObject({ steer: mark });
    } finally { live.stop(); }
  });
  it("an agent that cannot take an interjection gets the message queued as any, and the row says so", async () => {
    const { steer, normal } = steering("unsupported");
    const r = await post({ message: "mid-turn", steer: true });
    expect(JSON.parse(r.body).steer).toBe("unsupported");
    expect([steer.mock.calls.length, normal.mock.calls.length]).toEqual([0, 1]);
    expect(fm.webChatHistory.list("a").at(-1)).toMatchObject({ steer: "unsupported" });
  });
  it("an idle agent just receives it: no steer, no mark", async () => {
    const { steer, normal } = steering("idle");
    const r = await post({ message: "now", steer: true });
    expect(Object.hasOwn(JSON.parse(r.body), "steer")).toBe(false);
    expect([steer.mock.calls.length, normal.mock.calls.length]).toEqual([0, 1]);
    expect(Object.hasOwn(fm.webChatHistory.list("a").at(-1), "steer")).toBe(false);
  });
  it("without the flag nothing changes, whatever the agent is doing", async () => {
    const { steer, normal } = steering("add");
    const r = await post({ message: "queue me" });
    expect([Object.hasOwn(JSON.parse(r.body), "steer"), steer.mock.calls.length, normal.mock.calls.length]).toEqual([false, 0, 1]);
  });
  it("a steer the agent's connection refused is a failed send (503), not a delivered one", async () => {
    const { steer } = steering("add");
    steer.mockReturnValue(false);
    const r = await post({ message: "lost", steer: true });
    expect(r.status).toBe(503);
  });
  it("only a boolean: anything else is refused", async () => {
    steering("add");
    expect((await post({ message: "x", steer: "yes" })).status).toBe(400);
  });
});

describe("what happens to the row afterwards", () => {
  it("a runner's later word (the turn was cut short; the CLI refused it) reaches the row and the pages", async () => {
    steering("add");
    const live: string[] = [];
    const res = { write: (s: string) => { live.push(s); return true; }, writableEnded: false, destroyed: false, on() {}, once() {}, end() {} };
    fm.sseClients.add(res);
    try {
      const { messageId } = JSON.parse((await post({ message: "mid-turn", steer: true })).body);
      fm.reportSteer("a", messageId, "refused");
      expect(fm.webChatHistory.list("a").at(-1).steer).toBe("refused");
      const frame = live.filter((w) => w.includes("event: delivery")).map((w) => JSON.parse(w.split("data: ")[1]!.split("\n")[0]!)).at(-1);
      expect(frame).toMatchObject({ instance: "a", messageId, steer: "refused" });
    } finally { fm.sseClients.delete(res); }
  });
  it("a word that comes before the row is recorded (the runner is quicker than the answer) is not lost", () => {
    fm.reportSteer("a", "web-early-0001", "interrupted");
    fm.emitSseEvent("message", { instance: "a", sender: "me", role: "user", text: "early", ts: new Date().toISOString(), messageId: "web-early-0001", steer: "added" });
    expect(fm.webChatHistory.list("a").at(-1)).toMatchObject({ messageId: "web-early-0001", steer: "interrupted" });
  });
  it("a message that waited gets `sentAt` when it is handed to the agent; one that never waited gets none", () => {
    fm.emitSseEvent("message", { instance: "a", sender: "me", role: "user", text: "waits", ts: new Date().toISOString(), messageId: "web-wait-0001" });
    fm.emitSseEvent("message", { instance: "a", sender: "me", role: "user", text: "direct", ts: new Date().toISOString(), messageId: "web-wait-0002" });
    fm.reactMessageStatus("a", "", "web-wait-0001", "queued");
    fm.reactMessageStatus("a", "", "web-wait-0001", "processing");
    fm.reactMessageStatus("a", "", "web-wait-0002", "processing");
    const rows = fm.webChatHistory.list("a");
    const waited = rows.find((m: any) => m.messageId === "web-wait-0001"), direct = rows.find((m: any) => m.messageId === "web-wait-0002");
    expect([typeof waited.sentAt, waited.delivery, Object.hasOwn(direct, "sentAt")]).toEqual(["string", "processing", false]);
    expect(fm.webChatHistory.deliveries().find((d: any) => d.messageId === "web-wait-0001")).toMatchObject({ sentAt: waited.sentAt });
  });
});

describe("who may interject, and the edges of the dispatch", () => {
  it("a guest's `steer: true` is ignored: the message is queued like any other, no steer, no mark", async () => {
    const { steer, normal } = steering("interrupt");
    const r = await raw(port, "POST", "/ui/send", write(guestSession()), JSON.stringify({ instance: "a", message: "from a guest", steer: true }));
    expect(r.status, r.body).toBe(200);
    expect(Object.hasOwn(JSON.parse(r.body), "steer")).toBe(false);
    expect([steer.mock.calls.length, normal.mock.calls.length]).toEqual([0, 1]);
    expect(Object.hasOwn(fm.webChatHistory.list("a").at(-1), "steer")).toBe(false);
  });
  it("a Windows runtime never takes a steer: the flag is not even asked about", async () => {
    const { steer, normal } = steering("add");
    const asked = fm.webSteerMode as ReturnType<typeof vi.fn>;
    fm.instanceIpcClients.set("w", { connected: true, send: () => true });
    vi.spyOn(fm, "nativeInstanceRuntime").mockReturnValue({ get: () => undefined } as never);
    const r = await raw(port, "POST", "/ui/send", write(session()), JSON.stringify({ instance: "w", message: "native", steer: true }));
    expect([r.status, Object.hasOwn(JSON.parse(r.body), "steer")]).toEqual([200, false]);
    expect(normal.mock.calls.map((c) => c[0])).toEqual(["w"]);                                  // it was delivered, as a message
    expect(steer).not.toHaveBeenCalled();
    expect(asked).not.toHaveBeenCalledWith("w");
  });
  it("webSteerMode: only a working (or stuck) agent can be interjected into; an idle or paused one is a plain send", () => {
    const state = vi.spyOn(fm, "getInstanceExecutionState");
    vi.spyOn(fm, "acpSteerMode").mockReturnValue(undefined);
    for (const idle of ["idle", "paused", null]) { state.mockReturnValue(idle as never); expect(fm.webSteerMode("a"), String(idle)).toBe("idle"); }
    for (const busy of ["working", "stuck"]) { state.mockReturnValue(busy as never); expect(fm.webSteerMode("a"), busy).toBe("native"); }   // claude-code steers
    vi.spyOn(fm, "backendNameForInstance").mockReturnValue("antigravity");
    state.mockReturnValue("working" as never);
    expect(fm.webSteerMode("a")).toBe("unsupported");                                      // a terminal agy has no way
  });
});

describe("POST /ui/send-now: a waiting message, interjected", () => {
  const queuedRow = (id: string, delivery: string | undefined = "queued") => {
    fm.emitSseEvent("message", { instance: "a", sender: "me", role: "user", text: `waits ${id}`, ts: new Date().toISOString(), messageId: id });
    if (delivery === "queued") fm.reactMessageStatus("a", "", id, "queued");
    else if (delivery) { fm.reactMessageStatus("a", "", id, "queued"); fm.reactMessageStatus("a", "", id, delivery as never); }
  };
  const now = (b: Record<string, unknown>, sid = session()) => raw(port, "POST", "/ui/send-now", write(sid), JSON.stringify(b));
  it("a message that still waits: taken out of the queue and interjected; the answer says how", async () => {
    const spy = vi.spyOn(fm, "sendQueuedNow").mockReturnValue("added");
    queuedRow("web-now-0001");
    const r = await now({ instance: "a", messageId: "web-now-0001" });
    expect([r.status, JSON.parse(r.body)]).toEqual([200, { sent: true, steer: "added" }]);
    expect(spy).toHaveBeenCalledWith("a", "web-now-0001");
  });
  it("one that went meanwhile (delivered, or the turn ended) is not sent again: the queue sends it as any, this does nothing", async () => {
    const spy = vi.spyOn(fm, "sendQueuedNow").mockReturnValue("added");
    queuedRow("web-now-0002", "processing");
    expect(JSON.parse((await now({ instance: "a", messageId: "web-now-0002" })).body)).toEqual({ sent: false, reason: "not_queued" });
    expect(JSON.parse((await now({ instance: "a", messageId: "web-nothing-1" })).body)).toEqual({ sent: false, reason: "not_queued" });
    expect(spy).not.toHaveBeenCalled();
  });
  it("one that the agent no longer holds (it started in the instant between): nothing is sent", async () => {
    vi.spyOn(fm, "sendQueuedNow").mockReturnValue(null);
    queuedRow("web-now-0003");
    expect(JSON.parse((await now({ instance: "a", messageId: "web-now-0003" })).body)).toEqual({ sent: false, reason: "not_queued" });
  });
  it("a guest may not: refused by the server, whatever its page shows", async () => {
    const spy = vi.spyOn(fm, "sendQueuedNow").mockReturnValue("added");
    queuedRow("web-now-0004");
    const r = await now({ instance: "a", messageId: "web-now-0004" }, guestSession());
    expect([r.status, JSON.parse(r.body).error]).toEqual([403, expect.stringMatching(/^guest_/)]);   // (the guest allow-list refuses the route first; the handler refuses a guest too)
    expect(spy).not.toHaveBeenCalled();
  });
  it("a Windows runtime has no queue to take it from; a bad body is refused", async () => {
    const spy = vi.spyOn(fm, "sendQueuedNow").mockReturnValue("added");
    expect((await now({ instance: "w", messageId: "web-now-0005" })).status).toBe(404);
    for (const bad of [{}, { instance: "a" }, { instance: "a", messageId: "telegram-12" }, { instance: "a", messageId: 7 }]) expect((await now(bad)).status, JSON.stringify(bad)).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });
  it("without a session it is refused", async () => {
    expect([401, 403]).toContain((await raw(port, "POST", "/ui/send-now", { "content-type": "application/json" }, JSON.stringify({ instance: "a", messageId: "web-now-0006" }))).status);
  });
  it("the ledger row keeps how and when (markSentNow); a row that is not waiting is left alone", () => {
    queuedRow("web-now-0007");
    const row = fm.webChatHistory.markSentNow("a", "web-now-0007", "added");
    expect([row.steer, typeof row.sentAt]).toEqual(["added", "string"]);
    queuedRow("web-now-0008", "processing");
    expect(fm.webChatHistory.markSentNow("a", "web-now-0008", "added")).toBeNull();
  });
});

describe("the fleet's part of Send now (sendQueuedNow)", () => {
  const runner = (mode: string | null) => { const r: any = { interruptQueued: vi.fn(() => mode) }; bindAdapter({ id: "acp", runner: r } as never); fm.daemons.set("a", r); return r; };
  const row = (id: string) => { fm.emitSseEvent("message", { instance: "a", sender: "me", role: "user", text: id, ts: new Date().toISOString(), messageId: id }); fm.reactMessageStatus("a", "", id, "queued"); return fm.webChatHistory.list("a").find((m: any) => m.messageId === id); };
  afterEach(() => { fm.daemons.delete("a"); });
  it("the runner takes it out: the row says `added` and when, and the pages are told at once", () => {
    const r = runner("add");
    const m = row("web-fl-0001");
    const frames: string[] = [];
    const res = { write: (x: string) => { frames.push(x); return true; }, writableEnded: false, destroyed: false, on() {}, once() {}, end() {} };
    fm.sseClients.add(res);
    try {
      expect(fm.sendQueuedNow("a", "web-fl-0001")).toBe("added");
      expect(r.interruptQueued).toHaveBeenCalledWith("web-fl-0001");
      expect([m.steer, typeof m.sentAt]).toEqual(["added", "string"]);
      const frame = frames.filter((w) => w.includes("event: delivery")).map((w) => JSON.parse(w.split("data: ")[1]!.split("\n")[0]!)).at(-1);
      expect(frame).toMatchObject({ instance: "a", messageId: "web-fl-0001", steer: "added", sentAt: m.sentAt });
    } finally { fm.sseClients.delete(res); }
  });
  it("by cancelling the turn: `interrupted`", () => {
    runner("interrupt");
    const m = row("web-fl-0002");
    expect(fm.sendQueuedNow("a", "web-fl-0002")).toBe("interrupted");
    expect(m.steer).toBe("interrupted");
  });
  it("the queue had run out (idle): it is just sent, the row is not marked", () => {
    runner("idle");
    const m = row("web-fl-0003");
    expect(fm.sendQueuedNow("a", "web-fl-0003")).toBe("idle");
    expect(Object.hasOwn(m, "steer")).toBe(false);
  });
  it("it is no longer in the queue: null, nothing marked; an agent that is not ACP has no such queue", () => {
    runner(null);
    const m = row("web-fl-0004");
    expect(fm.sendQueuedNow("a", "web-fl-0004")).toBeNull();
    expect(Object.hasOwn(m, "steer")).toBe(false);
    const plain: any = { interruptQueued: vi.fn(() => "add") };
    fm.daemons.set("a", plain);                                                              // no ACP adapter bound: a terminal agent
    expect(fm.sendQueuedNow("a", "web-fl-0004")).toBeNull();
    expect(plain.interruptQueued).not.toHaveBeenCalled();
  });
});
