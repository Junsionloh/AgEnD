/**
 * A main task that finished by itself, or went to review for the person, told nobody who was not looking at the card: the
 * Notices page holds fleet, agent, update, schedule and summary notices only, and the one the board did send went to the
 * agents. The person is now told (docs/design/task-board.md, "The person is told"):
 *   1. The board names what to tell with each committed write (`BoardChange.news`): a main task that finished by itself because
 *      nobody had to confirm it (`done`), or that waits for the person (`review`: one they handed out). Not a sub task, not a main task moved by hand to done, not what waits for an agent, not what the person did.
 *   2. A web-only fleet keeps it as a Notice (`task`: the card to open, its owner) and pushes it to the dashboard; the words say what
 *      is still missing and who is asked to fill it in, in English and 繁體中文.
 *   3. A chat fleet says it in General; a card that waits for the person is left to Needs you when the fleet asked for it there.
 *   4. The store keeps the card with the notice, and does not believe a card that is not a card number.
 *
 * Isolation: every database and fleet home is a temp dir.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { setLocale } from "../src/locale.js";
import { Scheduler } from "../src/scheduler/index.js";
import { SchedulerDb } from "../src/scheduler/db.js";
import type { Actor, PersonNews, TaskBoard } from "../src/scheduler/task-board.js";
import { WebNotices, WEB_NOTICES_FILE } from "../src/web-notices.js";

const ANN: Actor = { kind: "person", name: "Ann" };
const LEAD: Actor = { kind: "instance", name: "lead" };
const DEV: Actor = { kind: "instance", name: "dev-a" };
const QA: Actor = { kind: "instance", name: "qa" };
const INSTANCES = ["lead", "dev-a", "qa"];

const dirs: string[] = [], dbs: Array<{ close(): void }> = [], fleets: FleetManager[] = [];
afterEach(() => {
  for (const f of fleets.splice(0)) { try { (f as any).taskBoardWaker?.stop(); f.stormWindow.shutdown(); f.spawnGate.shutdown(); } catch { /* stopped */ } }
  for (const db of dbs.splice(0)) { try { db.close(); } catch { /* closed */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks(); vi.unstubAllEnvs(); setLocale("en");
});
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

function open(): { board: TaskBoard; news: PersonNews[] } {
  const db = new SchedulerDb(join(tmp("task-board-person-notice-"), "scheduler.db")); dbs.push(db);
  db.board.setCommentRouting({ instances: () => INSTANCES, enabled: () => true });
  const news: PersonNews[] = [];
  db.board.onChange((c) => { news.push(...c.news); });
  return { board: db.board, news };
}
function plan(board: TaskBoard, actor: Actor = LEAD, over: Record<string, unknown> = {}) {
  const main = board.createCards(actor, { cards: [{ title: "Publish the report", assignee: "lead", acceptance: ["report attached", "reviewer sign-off"], ...over }] }).cards[0]!;
  const [draft, review] = board.createCards(LEAD, { parent: main.code, cards: [{ title: "Draft", assignee: "dev-a" }, { title: "Review", assignee: "qa" }] }).cards;
  return { main, draft: draft!, review: review! };
}
function finishBoth(board: TaskBoard, p: ReturnType<typeof plan>, last: Actor = QA) {
  board.moveCard(DEV, p.draft.code, "claimed");
  board.moveCard(DEV, p.draft.code, "done", { result: "drafted" });
  board.moveCard(QA, p.review.code, "claimed");
  return board.moveCard(last, p.review.code, "done", { result: "no blocking issues" });
}

describe("1. what the board says the person is to be told", () => {
  it("a main task that finished by itself: the card, who moved the last sub task, what it still lacks", () => {
    const { board, news } = open();
    const p = plan(board);
    finishBoth(board, p);
    expect(news).toEqual([{ kind: "done", uuid: p.main.uuid, code: p.main.code, title: "Publish the report", assignee: "lead", by: "qa",
      gap: { unchecked: 2, noResult: true }, checked: 0, total: 2 }]);
  });

  it("nothing lacking: still told it finished, with no gap", () => {
    const { board, news } = open();
    const p = plan(board);
    board.updateCard(LEAD, p.main.code, { check: [1, 2], result: "All delivered." });
    finishBoth(board, p);
    expect(news.map((n) => [n.kind, n.gap, n.checked, n.total])).toEqual([["done", null, 2, 2]]);
  });

  it("a main task the person handed out waits for them: told as review, never as done", () => {
    const { board, news } = open();
    const a = plan(board, ANN);
    finishBoth(board, a);
    expect(news.map((n) => [n.kind, n.code])).toEqual([["review", a.main.code]]);
    expect(news[0]!.gap).toEqual({ unchecked: 2, noResult: true });
  });

  it("not what waits for an agent: an instance dispatcher's review is its own business", () => {
    const { board, news } = open();
    const p = plan(board, LEAD, { needsReview: true });
    expect(board.getCard(p.main.code).needsReview).toBe(true);
    finishBoth(board, p);
    expect(board.getCard(p.main.code).status).toBe("review");
    expect(news).toEqual([]);
  });

  it("not what the person did themselves, and not a sub task", () => {
    const { board, news } = open();
    const p = plan(board);
    board.moveCard(DEV, p.draft.code, "claimed");
    board.moveCard(DEV, p.draft.code, "done", { result: "drafted" });
    board.moveCard(QA, p.review.code, "claimed");
    expect(news).toEqual([]);                      // sub tasks finished: no news
    board.moveCard(ANN, p.review.code, "done", { result: "checked by me" });
    expect(board.getCard(p.main.code).status).toBe("done");
    expect(news).toEqual([]);                      // the person moved the last one: they know
  });

  it("not a main task moved to done by hand (no sub tasks): that is its owner's own move, not the board finishing it", () => {
    const { board, news } = open();
    const main = board.createCards(LEAD, { cards: [{ title: "Alone", assignee: "lead" }] }).cards[0]!;
    board.moveCard(LEAD, main.code, "claimed");
    board.moveCard(LEAD, main.code, "done", { result: "ok" });
    expect(news).toEqual([]);
  });

  it("a main task without sub tasks that its owner sends to review for the person is told", () => {
    const { board, news } = open();
    const main = board.createCards(ANN, { cards: [{ title: "Alone", assignee: "lead" }] }).cards[0]!;
    board.moveCard(LEAD, main.code, "claimed");
    board.updateCard(LEAD, main.code, { result: "ok" });
    board.moveCard(LEAD, main.code, "review");
    expect(news.map((n) => [n.kind, n.code, n.by])).toEqual([["review", main.code, "lead"]]);
  });

  it("a main task that went back and finished again is told again; one reopened in the meantime is not told twice for one move", () => {
    const { board, news } = open();
    const p = plan(board);
    finishBoth(board, p);
    expect(news).toHaveLength(1);
    board.moveCard(ANN, p.main.code, "claimed", { reason: "one more thing" });
    expect(news).toHaveLength(1);
    const extra = board.createCards(ANN, { parent: p.main.code, cards: [{ title: "One more", assignee: "dev-a" }] }).cards[0]!;
    board.moveCard(DEV, extra.code, "claimed");
    board.moveCard(DEV, extra.code, "done", { result: "ok" });
    expect(news.map((n) => n.kind)).toEqual(["done", "done"]);
  });
});

describe("4. the store keeps the card with the notice", () => {
  it("a task notice carries its card and owner; a card that is not a card number is not kept; read back after a restart", () => {
    const path = join(tmp("task-board-person-notice-store-"), WEB_NOTICES_FILE);
    const log = { warn: vi.fn() };
    const store = new WebNotices(path, log);
    store.add({ kind: "task", text: "done", instance: "lead", card: "M-12" });
    store.add({ kind: "task", text: "bad", card: "../etc/passwd" });
    store.add({ kind: "task", text: "sub", card: "S-3" });
    expect(store.view().items.map((n) => [n.kind, n.card, n.instance])).toEqual([["task", "S-3", undefined], ["task", undefined, undefined], ["task", "M-12", "lead"]]);
    const again = new WebNotices(path, log);
    expect(again.view().items.map((n) => n.card)).toEqual(["S-3", undefined, "M-12"]);
    writeFileSync(path, JSON.stringify({ v: 1, next: 9, seen: 0, items: [{ id: 1, at: 1, kind: "task", text: "x", card: "nope" }, { id: 2, at: 1, kind: "task", text: "y", card: "M-1" }] }));
    expect(new WebNotices(path, log).view().items.map((n) => n.id)).toEqual([2]);
  });
});

function fleet(config: Record<string, unknown> = {}) {
  const d = tmp("task-board-person-notice-fm-");
  vi.stubEnv("AGEND_HOME", d);
  writeFileSync(join(d, "fleet.yaml"), "defaults: {}\ninstances: {}\n");
  const fm = new FleetManager(d); fleets.push(fm);
  fm.fleetConfig = { defaults: {}, instances: { lead: { working_directory: d }, "dev-a": { working_directory: d }, qa: { working_directory: d } }, ...config } as never;
  const any = fm as any;
  const sse: Array<[string, any]> = [];
  vi.spyOn(fm, "emitSseEvent").mockImplementation((event: string, data: unknown) => { sse.push([event, data]); });
  any.ensureDeliveryOutbox();
  const scheduler = new Scheduler(join(d, "scheduler.db"), () => {}, { max_schedules: 100, default_timezone: "UTC", retry_count: 3, retry_interval_ms: 1000 }, () => false);
  dbs.push(scheduler.db);
  any.scheduler = scheduler;
  any.attachTaskBoard(scheduler.db);
  scheduler.db.board.setCommentRouting({ instances: () => INSTANCES, enabled: () => true });
  return { fm, any, board: scheduler.db.board, sse, notices: () => (fm as any).webNoticeStore().view().items as Array<Record<string, any>> };
}
const CHAT = { channel: { type: "telegram", mode: "topic", bot_token_env: "T", group_id: "-100", access: { mode: "locked", allowed_users: ["1"] } } };

describe("2. a web-only fleet: a Notice about the card", () => {
  it("a main task that finished by itself: kept (kind task, its card and owner) and pushed, with what is missing and who is asked", () => {
    const f = fleet();
    const p = plan(f.board);
    finishBoth(f.board, p);
    const [n] = f.notices();
    expect(f.notices()).toHaveLength(1);
    expect([n!.kind, n!.card, n!.instance]).toEqual(["task", p.main.code, "lead"]);
    expect(n!.text).toBe(`✅ ${p.main.code} "Publish the report" finished by itself: every sub task is done, and nobody had to confirm it. Not wrapped up yet: 0 of 2 definition-of-done items ticked, no result. lead is asked to fill that in.`);
    expect(f.sse.filter(([e]) => e === "notice")).toEqual([["notice", { notice: expect.objectContaining({ kind: "task", card: p.main.code }), unread: 1 }]]);
  });

  it("nothing lacking: no 'not wrapped up' line", () => {
    const f = fleet();
    const p = plan(f.board);
    f.board.updateCard(LEAD, p.main.code, { check: [1, 2], result: "All delivered." });
    finishBoth(f.board, p);
    expect(f.notices()[0]!.text).toBe(`✅ ${p.main.code} "Publish the report" finished by itself: every sub task is done, and nobody had to confirm it.`);
  });

  it("one that waits for the person (a main task they handed out)", () => {
    const f = fleet();
    const p = plan(f.board, ANN);
    finishBoth(f.board, p);
    expect(f.notices().map((n) => [n.kind, n.card, n.text.startsWith(`🔔 ${p.main.code} "Publish the report" waits for your confirmation: every sub task is done.`)])).toEqual([["task", p.main.code, true]]);
  });

  it("in 繁體中文 when the fleet speaks it, and a long title is cut", () => {
    setLocale("zh-TW");
    const f = fleet();
    const p = plan(f.board, LEAD, { title: "T".repeat(95) });
    finishBoth(f.board, p);
    const text = String(f.notices()[0]!.text);
    expect(text).toContain("已自動完成：子任務都完成了，不需要任何人確認。");
    expect(text).toContain("還沒收尾：完成定義 2 項只勾了 0 項、還沒有結果。已請 lead 補上。");
    expect(text).toContain(`${"T".repeat(79)}…`);
    expect(text).not.toContain("T".repeat(80));
  });

  it("an owner who is not an agent of this fleet is not named as asked", () => {
    const f = fleet();
    const main = f.board.createCards(LEAD, { cards: [{ title: "Ghost's", assignee: "ghost", acceptance: ["a"] }] }).cards[0]!;
    const sub = f.board.createCards(LEAD, { parent: main.code, cards: [{ title: "Only", assignee: "dev-a" }] }).cards[0]!;
    f.board.moveCard(DEV, sub.code, "claimed");
    f.board.moveCard(DEV, sub.code, "done", { result: "ok" });
    expect(f.notices()).toHaveLength(1);
    expect(f.notices()[0]!.text).not.toContain("is asked to fill that in");
    expect(f.notices()[0]!.instance).toBeUndefined();
  });
});

describe("3. a chat fleet: said in General; what Needs you lists is left to it", () => {
  it("a main task that finished by itself is posted once, with where to open it", () => {
    const f = fleet(CHAT);
    const said = vi.spyOn(f.fm, "notifyFleetError").mockReturnValue(true);
    const p = plan(f.board);
    finishBoth(f.board, p);
    expect(said).toHaveBeenCalledTimes(1);
    expect(said.mock.calls[0]![0]).toContain(`✅ ${p.main.code} "Publish the report" finished by itself`);
    expect(said.mock.calls[0]![0]).toContain("Open it in Fleet › Tasks.");
    expect(said.mock.calls[0]![1]).toEqual({ throttle: false });
    expect(f.fm.webNoticesFeed()).toBeNull();
  });

  it("one that waits for the person is posted, unless Needs you already lists it (needs_you.task_board)", () => {
    const a = fleet(CHAT);
    const sa = vi.spyOn(a.fm, "notifyFleetError").mockReturnValue(true);
    finishBoth(a.board, plan(a.board, ANN));
    expect(sa.mock.calls.map((c) => String(c[0]).startsWith("🔔"))).toEqual([true]);

    const b = fleet({ ...CHAT, needs_you: { task_board: true } });
    const sb = vi.spyOn(b.fm, "notifyFleetError").mockReturnValue(true);
    finishBoth(b.board, plan(b.board, ANN));
    expect(sb).not.toHaveBeenCalled();
    // …but one that finished by itself is not in Needs you: it is posted either way.
    finishBoth(b.board, plan(b.board));
    expect(sb.mock.calls.map((c) => String(c[0]).startsWith("✅"))).toEqual([true]);
  });

  it("a notice that cannot be delivered never fails the write that finished the card", () => {
    const f = fleet(CHAT);
    vi.spyOn(f.fm, "notifyFleetError").mockImplementation(() => { throw new Error("no adapter"); });
    const p = plan(f.board);
    expect(() => finishBoth(f.board, p)).not.toThrow();
    expect(f.board.getCard(p.main.code).status).toBe("done");
  });
});
