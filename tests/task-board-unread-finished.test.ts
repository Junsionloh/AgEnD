/**
 * The person's unread has one more reason, `finished` (docs/design/task-board.md, "Unread"): a main task that finished by itself —
 * the board did it when its last sub task was done, because nobody had to confirm it — since the person last looked at it. It was
 * the one thing that happened to their card that nothing told them.
 *   1. Told: a main task the board finished, when someone else moved its last sub task; named by who did.
 *   2. Not told: before the person's floor, once they opened the card, what they finished themselves, a main task moved to done by hand,
 *      one that is not done any more (reopened), one that waits for them (that is `review`, which says so), a sub task.
 *   3. The strongest reason leads: a card that was also answered says so first.
 *
 * Isolation: temp databases.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SchedulerDb } from "../src/scheduler/db.js";
import type { Actor, TaskBoard } from "../src/scheduler/task-board.js";
import { UNREAD_REASONS } from "../src/scheduler/task-board-unread.js";

const ANN: Actor = { kind: "person", name: "Ann" };
const LEAD: Actor = { kind: "instance", name: "lead" };
const DEV: Actor = { kind: "instance", name: "dev-a" };
const QA: Actor = { kind: "instance", name: "qa" };

const dirs: string[] = [], dbs: SchedulerDb[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) { try { db.close(); } catch { /* closed */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function open(): TaskBoard {
  const d = mkdtempSync(join(tmpdir(), "task-board-unread-finished-")); dirs.push(d);
  const db = new SchedulerDb(join(d, "scheduler.db")); dbs.push(db);
  db.board.setCommentRouting({ instances: () => ["lead", "dev-a", "qa"], enabled: () => true });
  db.board.unreadFor("Ann");                                  // the floor: nothing before this is news
  return db.board;
}
function plan(board: TaskBoard, by: Actor = LEAD) {
  const main = board.createCards(by, { cards: [{ title: "Publish the report", assignee: "lead", acceptance: ["a"] }] }).cards[0]!;
  const [draft, review] = board.createCards(LEAD, { parent: main.code, cards: [{ title: "Draft", assignee: "dev-a" }, { title: "Review", assignee: "qa" }] }).cards;
  return { main, draft: draft!, review: review! };
}
function finishBoth(board: TaskBoard, p: ReturnType<typeof plan>, last: Actor = QA) {
  board.moveCard(DEV, p.draft.code, "claimed");
  board.moveCard(DEV, p.draft.code, "done", { result: "drafted" });
  board.moveCard(QA, p.review.code, "claimed");
  return board.moveCard(last, p.review.code, "done", { result: "no blocking issues" });
}
const unread = (board: TaskBoard) => board.unreadFor("Ann").cards.map((u) => [u.id, u.reasons, u.by, u.n]);

describe("the reason", () => {
  it("is the weakest, and a name the page knows", () => {
    expect(UNREAD_REASONS.at(-1)).toBe("finished");
    expect(UNREAD_REASONS).toHaveLength(6);
  });
});

describe("1. told", () => {
  it("a main task the board finished: its card, who finished the last sub task, once", () => {
    const board = open();
    const p = plan(board);
    finishBoth(board, p);
    expect(board.getCard(p.main.code).status).toBe("done");
    expect(unread(board)).toEqual([[p.main.code, ["finished"], "qa", 1]]);
  });

  it("opening the card reads it; finishing again after a reopen is news again", () => {
    const board = open();
    const p = plan(board);
    finishBoth(board, p);
    board.markRead("Ann", p.main.code);
    expect(board.unreadFor("Ann").total).toBe(0);
    board.moveCard(ANN, p.main.code, "claimed", { reason: "one more thing" });
    const extra = board.createCards(ANN, { parent: p.main.code, cards: [{ title: "One more", assignee: "dev-a" }] }).cards[0]!;
    board.moveCard(DEV, extra.code, "claimed");
    board.moveCard(DEV, extra.code, "done", { result: "ok" });
    expect(unread(board)).toEqual([[p.main.code, ["finished"], "dev-a", 1]]);
  });
});

describe("2. not told", () => {
  it("what happened before the person's floor", () => {
    const d = mkdtempSync(join(tmpdir(), "task-board-unread-finished-")); dirs.push(d);
    const db = new SchedulerDb(join(d, "scheduler.db")); dbs.push(db);
    db.board.setCommentRouting({ instances: () => ["lead", "dev-a", "qa"], enabled: () => true });
    const p = plan(db.board);
    finishBoth(db.board, p);
    expect(db.board.unreadFor("Ann").total).toBe(0);            // the first ask writes the floor: older history is not news
  });

  it("what the person finished themselves", () => {
    const board = open();
    const p = plan(board);
    finishBoth(board, p, ANN);
    expect(board.getCard(p.main.code).status).toBe("done");
    expect(board.unreadFor("Ann").total).toBe(0);
  });

  it("a main task moved to done by hand (no sub tasks), a sub task, and one that went back", () => {
    const board = open();
    const main = board.createCards(LEAD, { cards: [{ title: "Alone", assignee: "lead" }] }).cards[0]!;
    board.moveCard(LEAD, main.code, "claimed");
    board.moveCard(LEAD, main.code, "done", { result: "ok" });
    expect(board.unreadFor("Ann").total).toBe(0);
    const p = plan(board);
    finishBoth(board, p);
    expect(unread(board).map((u) => u[0])).toEqual([p.main.code]);      // the sub tasks that finished are not in it
    board.moveCard(ANN, p.main.code, "claimed", { reason: "not yet" });
    expect(board.unreadFor("Ann").total).toBe(0);
  });

  it("one that waits for the person: that is `review`, and says so", () => {
    const board = open();
    const p = plan(board, ANN);
    finishBoth(board, p);
    expect(unread(board)).toEqual([[p.main.code, ["review"], "qa", 1]]);
  });
});

describe("3. the strongest reason leads", () => {
  it("a card that finished and was also answered says it was answered first", () => {
    const board = open();
    const p = plan(board);
    board.updateCard(ANN, p.main.code, { comment: "How is it going?" });
    board.updateCard(LEAD, p.main.code, { comment: "On it." });
    finishBoth(board, p);
    const [u] = board.unreadFor("Ann").cards;
    expect(u!.reasons).toEqual(["answer", "finished"]);
    expect(u!.n).toBe(2);
  });
});
