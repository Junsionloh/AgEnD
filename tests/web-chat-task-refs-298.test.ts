/**
 * AGEND-298: task cards in the web chat — the server side, through the real web handler with a real FleetManager and a real
 * scheduler database.
 *   1. GET /ui/tasks/refs: the numbers asked for come back as cards (the rest left out, no error); `?q=` offers cards — by the
 *      number's start, by the title, the latest changes for nothing typed; a guest never reaches it.
 *   2. POST /ui/send: the cards a message names go to the agent as a short block under the person's words (number, status,
 *      title, who has it, how to read it in full). The chat's copy, the receipt's "what was typed" and the channel echo stay the
 *      person's words. A number with no card (never was, or deleted) adds nothing and fails nothing; nor does a guest's, a
 *      command line's or an instance-without-a-board's hint.
 *   3. The board's own reads: suggest(), cardsForRefs(), the block's wording.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/logger.js", async original => {
  const silent: Record<string, unknown> = new Proxy({}, { get: (_t, key) => (key === "child" ? () => silent : key === "level" ? "silent" : () => {}) });
  return { ...await original<typeof import("../src/logger.js")>(), createLogger: () => silent };
});
import { request } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "agend-298-home-"));
process.env.AGEND_HOME = home;

const { FleetManager } = await import("../src/fleet-manager.js");
const { WEB_CSRF_HEADER, WEB_SESSION_COOKIE } = await import("../src/web-auth.js");
const { csrfTokenFor, tokenEpoch } = await import("../src/web-session.js");
const { SchedulerDb } = await import("../src/scheduler/db.js");
const { TASK_REF_HEADER, cardsForRefs, taskRefBlock, taskRefCodes } = await import("../src/chat-task-refs.js");
const { formatHumanInboundMessage } = await import("../src/human-delivery-receipts.js");

const ANN = { kind: "person", name: "Ann" } as const;
const ALICE = { adapterId: "discord", userId: "111111111111111111" };
function raw(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let b = ""; res.on("data", (c: Buffer) => { b += c.toString(); }); res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
    });
    r.on("error", reject); r.end(body);
  });
}
let fm: any, port = 0, dir: string, db: InstanceType<typeof SchedulerDb>;
const cookieOf = (sid: string) => `${WEB_SESSION_COOKIE}=${sid}`;
const read = (sid: string) => ({ cookie: cookieOf(sid) });
const write = (sid: string) => ({ cookie: cookieOf(sid), origin: `http://127.0.0.1:${port}`, [WEB_CSRF_HEADER]: csrfTokenFor(sid), "content-type": "application/json" });
const session = (tier: "admin" | "guest", owner?: typeof ALICE) =>
  fm.webSessions.create({ tier, surface: "local", label: tier, tokenEpoch: tokenEpoch(fm.getDashboardAccess().token!), owner }).sessionId as string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agend-298-fleet-"));
  writeFileSync(join(dir, "fleet.yaml"), `health_port: 0\ninstances:\n  a:\n    working_directory: ${dir}\n    backend: claude-code\n  b:\n    working_directory: ${dir}\n    backend: claude-code\n    dashboard:\n      task_board: false\n`);
  fm = new FleetManager(dir);
  const q = () => {}; fm.logger = { info: q, warn: q, error: q, debug: q, trace: q, fatal: q, child: () => fm.logger };
  fm.notifyFleetError = () => true; fm.loadConfig(join(dir, "fleet.yaml"));
  fm.lifecycle = { isPaused: () => false, hasWorkLease: () => false, daemons: new Map() };
  fm.getInstanceStatus = () => "running";
  fm.initializeWebAuthTokens(); fm.startHealthServer(0);
  await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
  port = (fm.healthServer.address() as { port: number }).port;
  fm.initializeWebSessions?.();
});
afterAll(async () => {
  await new Promise<void>((r) => fm.healthServer?.close(() => r()));
  rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
});

/** The board: M-1 "Build the login API" (dev-a, in progress), its sub task S-1, M-2 "登入頁面" (nobody), M-3 "Old finished work". Main and sub tasks count apart. */
let m1: any, s2: any, m3: any, m4: any;
let boards = 0;
beforeEach(() => {
  // A database of its own for each test: the card numbers count from 1 again.
  db = new SchedulerDb(join(dir, `scheduler-${++boards}.db`));
  fm.scheduler = { db };
  const board = db.board;
  m1 = board.createCards(ANN, { project: undefined, cards: [{ title: "Build the login API", assignee: "dev-a" }] }).cards[0];
  board.moveCard(ANN, m1.code, "claimed");
  s2 = board.createCards(ANN, { cards: [{ parent: m1.code, title: "Write the tests\nacross two lines" }] }).cards[0];
  m3 = board.createCards(ANN, { cards: [{ title: "登入頁面 50%_done" }] }).cards[0];
  m4 = board.createCards(ANN, { cards: [{ title: "Old finished work" }] }).cards[0];
});
afterEach(() => { vi.restoreAllMocks(); delete fm.fleetConfig.web; fm.scheduler = undefined; try { db.close(); } catch { /* closed */ } });

function delivering(instance = "a") {
  const delivered: any[] = [], bodies: string[] = [];
  fm.instanceIpcClients.set(instance, { connected: true, send: () => true });
  vi.spyOn(fm, "deliverHumanToInstance").mockImplementation(async (_n: unknown, payload: unknown, _o: unknown, original: unknown) => { delivered.push(payload); bodies.push(String(original)); return true; });
  return { delivered, bodies };
}
const send = (message: string, over: Record<string, unknown> = {}, sid = session("admin")) =>
  raw(port, "POST", "/ui/send", write(sid), JSON.stringify({ instance: "a", message, ...over }));
const refs = async (query: string, sid = session("admin")) => { const r = await raw(port, "GET", `/ui/tasks/refs${query}`, read(sid)); return { status: r.status, refs: (JSON.parse(r.body).refs ?? []) as any[], body: r.body }; };

describe("GET /ui/tasks/refs", () => {
  it("?codes=: the numbers that are cards, as chips need them; the others are left out, not an error", async () => {
    const r = await refs("?codes=M-1,S-1,M-99,nonsense,%23m2");
    expect(r.status).toBe(200);
    expect(r.refs).toEqual([
      { code: "M-1", title: "Build the login API", status: "claimed", assignee: "dev-a", kind: "main" },
      { code: "S-1", title: "Write the tests across two lines", status: "open", assignee: null, kind: "sub" },
      { code: "M-2", title: "登入頁面 50%_done", status: "open", assignee: null, kind: "main" },
    ]);
    expect((await refs("?codes=")).refs).toEqual([]);
    expect((await refs("?codes=M-98,S-97")).refs).toEqual([]);
  });
  it("a deleted card is one that is not there", async () => {
    (db as any).db.prepare("DELETE FROM tasks WHERE code = ?").run(m3.code);
    expect((await refs("?codes=M-1,M-2")).refs.map((c) => c.code)).toEqual(["M-1"]);
  });
  it("?q=: the latest changes for nothing typed, live cards first", async () => {
    db.board.moveCard(ANN, m4.code, "cancelled");
    const r = (await refs("?q=")).refs.map((c) => c.code);
    expect(r).toHaveLength(4);
    expect(r.at(-1)).toBe(m4.code);
  });
  it("?q=: a number's start (any case, with or without the hyphen or the #), then the title", async () => {
    expect((await refs("?q=m-1")).refs.map((c) => c.code)).toEqual(["M-1"]);
    expect((await refs("?q=%23S1")).refs.map((c) => c.code)).toEqual(["S-1"]);
    expect((await refs("?q=m")).refs.map((c) => c.code).sort()).toEqual(["M-1", "M-2", "M-3"]);
    expect((await refs("?q=1")).refs.map((c) => c.code)).toEqual(["M-1", "S-1"]);    // the exact number first, then the other letter's
    expect((await refs("?q=login")).refs.map((c) => c.code).sort()).toEqual(["M-1"]);
    expect((await refs(`?q=${encodeURIComponent("登入")}`)).refs.map((c) => c.code)).toEqual(["M-2"]);
    expect((await refs("?q=100%25")).refs, "a % is a character, not a wildcard").toEqual([]);
    expect((await refs("?q=nothing-like-this")).refs).toEqual([]);
  });
  it("?limit= bounds the list", async () => {
    expect((await refs("?q=&limit=2")).refs).toHaveLength(2);
    expect((await refs("?q=&limit=0")).refs.length).toBeGreaterThan(0);
  });
  it("a guest never reaches it, and a missing board is a plain 503 for the page to leave as text", async () => {
    vi.spyOn(fm, "guestScope").mockReturnValue(new Set(["a"]));
    fm.fleetConfig.web = { guests: { enabled: true } };
    const r = await raw(port, "GET", "/ui/tasks/refs?codes=M-1", read(session("guest", ALICE)));
    expect(r.status).toBe(403);
    expect(r.body).not.toContain("Build the login API");
    fm.scheduler = undefined;
    expect((await refs("?codes=M-1")).status).toBe(503);
  });
});

describe("POST /ui/send: the cards a message names go to the agent", () => {
  it("a block under the person's words: number, status, title on one line, who has it, how to read the whole card", async () => {
    const { delivered, bodies } = delivering();
    const r = await send("please look at #M-1 and S-1");
    expect(r.status).toBe(200);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].content).toBe([
      "please look at #M-1 and S-1",
      "",
      TASK_REF_HEADER,
      "M-1 [in progress] Build the login API @dev-a (main task)",
      "S-1 [to do] Write the tests across two lines (sub task of M-1)",
      "Read a card in full with the task tool: task get M-1 (or agend-agent task get M-1 --detail).",
    ].join("\n"));
    // What the person typed is what the receipt records; the meta is the web message's, as before.
    expect(bodies).toEqual(["please look at #M-1 and S-1"]);
    expect(delivered[0].meta.source).toBe("web");
    expect(Object.keys(delivered[0].meta).filter((k) => /task|card/i.test(k))).toEqual([]);
    // The agent's line: the person's words and the block, one message; the block is not a header the agent could mistake.
    const wire = formatHumanInboundMessage(delivered[0].content, delivered[0].meta, "mcp");
    expect(wire).toContain(`please look at #M-1 and S-1\n\n${TASK_REF_HEADER}\nM-1 [in progress]`);
    expect(wire.split("\n").filter((l) => l.startsWith("> "))).toEqual([]);
  });
  it("the chat keeps the person's words alone: the stream's copy and the stored row", async () => {
    delivering();
    await send("check #M-1");
    const row = fm.webChatHistory.list("a").at(-1);
    expect([row.role, row.text]).toEqual(["user", "check #M-1"]);
  });
  it("a hand-typed number with no #, and a card's number inside a sentence in Chinese", async () => {
    const { delivered } = delivering();
    await send("看一下M-2的進度");
    expect(delivered[0].content).toContain("M-2 [to do] 登入頁面 50%_done (main task)");
  });
  it("a card that is finished or cancelled is still a card, with its status", async () => {
    db.board.moveCard(ANN, m4.code, "cancelled");
    const { delivered } = delivering();
    await send("what happened to M-3?");
    expect(delivered[0].content).toContain("M-3 [cancelled] Old finished work (main task)");
  });
  it("a number that is no card — never was, or deleted — sends the words as typed: no block, no error", async () => {
    (db as any).db.prepare("DELETE FROM tasks WHERE code = ?").run(m3.code);
    const { delivered } = delivering();
    for (const text of ["#M-99 is not a card", "deleted: #M-2", "see S-77 and #S-78"]) {
      const r = await send(text);
      expect(r.status, text).toBe(200);
    }
    expect(delivered.map((d) => d.content)).toEqual(["#M-99 is not a card", "deleted: #M-2", "see S-77 and #S-78"]);
  });
  it("one real card among numbers that are not: only the real one", async () => {
    const { delivered } = delivering();
    await send("#M-99 #M-1 #S-98");
    expect(delivered[0].content.split("\n").filter((l: string) => /^[MS]-\d+ \[/.test(l))).toEqual(["M-1 [in progress] Build the login API @dev-a (main task)"]);
  });
  it("a long title is cut to one line; at most ten cards", async () => {
    const long = db.board.createCards(ANN, { cards: [{ title: "x".repeat(100) }] }).cards[0];
    const { delivered } = delivering();
    await send(`#${long.code}`);
    expect(delivered[0].content.split("\n").find((l: string) => l.startsWith(long.code))).toBe(`${long.code} [to do] ${"x".repeat(100)} (main task)`);
    for (let i = 0; i < 12; i++) db.board.createCards(ANN, { cards: [{ title: `card ${i}` }] });
    const all = db.board.suggest("", 50).map((c) => `#${c.code}`).join(" ");
    await send(all);
    expect(delivered[1].content.split("\n").filter((l: string) => /^[MS]-\d+ \[/.test(l))).toHaveLength(10);
  });
  it("no board at all, a message with no number, files only: the message goes as it always did", async () => {
    const { delivered } = delivering();
    fm.scheduler = undefined;
    expect((await send("#M-1")).status).toBe(200);
    fm.scheduler = { db };
    expect((await send("no number here, only M and S-")).status).toBe(200);
    expect(delivered.map((d) => d.content)).toEqual(["#M-1", "no number here, only M and S-"]);
  });
  it("a line that starts with / is a command for the CLI (or /raw's exact paste): nothing is added", async () => {
    const { delivered } = delivering();
    await send("/btw about #M-1");
    await send("/raw echo M-1");
    expect(delivered.map((d) => d.content)).toEqual(["/btw about #M-1", "/raw echo M-1"]);
  });
  it("a guest's words bring no card (a guest has no board, and the agent must not repeat one to it)", async () => {
    vi.spyOn(fm, "guestScope").mockReturnValue(new Set(["a"]));
    fm.fleetConfig.web = { guests: { enabled: true } };
    const { delivered } = delivering();
    const r = await send("what is #M-1?", {}, session("guest", ALICE));
    expect(r.status).toBe(200);
    expect(delivered.map((d) => d.content)).toEqual(["what is #M-1?"]);
  });
  it("an instance with its task board off is told the card, not how to read it", async () => {
    const { delivered } = delivering("b");
    const r = await send("#M-1", { instance: "b" });
    expect(r.status).toBe(200);
    expect(delivered[0].content).toBe(`#M-1\n\n${TASK_REF_HEADER}\nM-1 [in progress] Build the login API @dev-a (main task)`);
  });
  it("the channel's echo is the person's words (no card text goes to a topic)", async () => {
    delivering();
    const sent: string[] = [];
    const adapter = { id: "owner", sendText: vi.fn(async (_c: string, text: string) => { sent.push(text); return { messageId: "1" }; }) };
    vi.spyOn(fm, "getAdapterForInstance").mockReturnValue(adapter as never);
    vi.spyOn(fm, "getGroupIdForInstance").mockReturnValue("G" as never);
    fm.fleetConfig.instances.a.topic_id = "T1";
    try {
      await send("look at #M-1");
      await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0));
      expect(sent.join("\n")).not.toContain("Build the login API");
      expect(sent.join("\n")).toContain("#M-1");
    } finally { delete fm.fleetConfig.instances.a.topic_id; }
  });
  it("a retry of the same send (the same clientId) is the same send, even when the card moved in between", async () => {
    const { delivered } = delivering();
    const clientId = "retry-298-aaaa";
    const sid = session("admin");
    expect((await send("#M-1", { clientId }, sid)).status).toBe(200);
    db.board.updateCard(ANN, m1.code, { title: "Build the login API, renamed" });
    const again = await send("#M-1", { clientId }, sid);
    expect([again.status, JSON.parse(again.body).repeated]).toEqual([200, true]);
    expect(delivered).toHaveLength(1);
  });
});

describe("the block and the reads behind it", () => {
  it("taskRefCodes reads what the page reads", () => {
    expect(taskRefCodes("#M-1, S-2 and #m3 but not a#M-4")).toEqual(["M-1", "S-2", "M-3"]);
  });
  it("cardsForRefs: in the order asked, the unknown and the hidden left out, an unreadable board is no cards", () => {
    const board = db.board;
    expect(cardsForRefs(board, ["S-1", "M-99", "M-1"]).map((c) => c.code)).toEqual(["S-1", "M-1"]);
    expect(cardsForRefs(board, ["S-1", "M-1"], (c) => c.assignee === "dev-a").map((c) => c.code)).toEqual(["S-1"]);
    expect(cardsForRefs(board, [])).toEqual([]);
    expect(cardsForRefs({ cardsByCode: () => { throw new Error("db closed"); } } as never, ["M-1"])).toEqual([]);
  });
  it("taskRefBlock: empty for no card; the hint can be left out", () => {
    const cards = cardsForRefs(db.board, ["M-1"]);
    expect(taskRefBlock(db.board, [])).toBe("");
    expect(taskRefBlock(db.board, cards, { hint: false })).not.toContain("task get");
    expect(taskRefBlock(db.board, cards)).toContain("task get M-1");
  });
  it("suggest(): exact number first, live before finished, a keep() that hides is applied before the limit", () => {
    const board = db.board;
    board.moveCard(ANN, m3.code, "cancelled");
    const codes = board.suggest("m", 10).map((c) => c.code);
    expect([codes.length, codes.at(-1)]).toEqual([3, "M-2"]);                       // the cancelled one last
    expect(board.suggest("", 2, (c) => c.code !== "M-1")).toHaveLength(2);
    expect(board.suggest("", 3, (c) => c.assignee !== "dev-a").map((c) => c.code)).not.toContain("M-1");
    expect(board.suggest("   ", 1)).toHaveLength(1);
    expect(board.suggest("zzz")).toEqual([]);
  });
});
