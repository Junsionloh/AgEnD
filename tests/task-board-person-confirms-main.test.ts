/**
 * A main task an agent opens for the person finished by itself: nobody had to confirm it, so the person never got to. The
 * board cannot tell whose request a card is (an agent opens it with its own tool, and may not name the person its dispatcher),
 * so the fleet can say it for every main task an agent opens — `defaults.task_board.person_confirms_main`:
 *   1. Off (the default): nothing changes. An agent's main task finishes by itself; no column is read as set.
 *   2. On: a main task an instance opens is marked `person_review` (and needs review). It says so in the agent's answer. Its
 *      sub tasks are still handed out by the instance that opened them, and a main task the person opened is as it was.
 *   3. On: when its last sub task is done it goes to review and waits for the person (Waiting for you, the project's count),
 *      not for the instance that opened it: that one is not woken to confirm it, cannot finish it, and cannot clear the review.
 *      Its owner is still told to wrap it up (check, result, comment). The person finishes it.
 *   4. Only the confirmation is the person's: a blocked sub task's question still goes to the instance that handed it out, and
 *      a blocked main task is not a question for the person.
 *   5. The switch is read as a card is opened: a card keeps what it was opened with when it is switched off.
 *   6. Additive: a database from before the column gains it as 0, and every card in it reads as it did.
 *
 * Isolation: every database is a temp file.
 */
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SchedulerDb } from "../src/scheduler/db.js";
import { personReviews, waitsForPerson, type Actor, type TaskBoard, type Wake } from "../src/scheduler/task-board.js";
import { cardText } from "../src/scheduler/task-board-text.js";
import { boardPersonConfirmsMain } from "../src/task-board-tool.js";
import { wakeMessage } from "../src/task-board-waker.js";
import { validateFleetConfig } from "../src/config-validator.js";

const ANN: Actor = { kind: "person", name: "Ann" };
const LEAD: Actor = { kind: "instance", name: "lead" };
const DEV: Actor = { kind: "instance", name: "dev-a" };
const QA: Actor = { kind: "instance", name: "qa" };
const INSTANCES = ["lead", "dev-a", "qa"];

const dirs: string[] = [], dbs: SchedulerDb[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) { try { db.close(); } catch { /* closed */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string { const d = mkdtempSync(join(tmpdir(), "task-board-person-confirms-")); dirs.push(d); return join(d, "scheduler.db"); }
function open(on: boolean | { value: boolean } = true, path = tmp()): { board: TaskBoard; path: string; flag: { value: boolean } } {
  const flag = typeof on === "boolean" ? { value: on } : on;
  const db = new SchedulerDb(path); dbs.push(db);
  db.board.setCommentRouting({ instances: () => INSTANCES, enabled: () => true });
  db.board.setPersonConfirmsMain(() => flag.value);
  return { board: db.board, path, flag };
}
function heard(board: TaskBoard) {
  const wakes: Wake[] = [];
  board.onChange((c) => { wakes.push(...c.wakes); });
  return { take: () => wakes.splice(0) };
}

/** An agent opens a main task with a definition of done, and a sub task for dev-a and one for qa. */
function plan(board: TaskBoard, over: Record<string, unknown> = {}) {
  const made = board.createCards(LEAD, { cards: [{ title: "Publish the report", assignee: "lead", acceptance: ["report attached", "reviewer sign-off"], ...over }] });
  const main = made.cards[0]!;
  const [draft, review] = board.createCards(LEAD, { parent: main.code, cards: [{ title: "Draft", assignee: "dev-a" }, { title: "Review", assignee: "qa" }] }).cards;
  return { main, draft: draft!, review: review!, notes: made.notes };
}
function finishBoth(board: TaskBoard, p: ReturnType<typeof plan>) {
  board.moveCard(DEV, p.draft.code, "claimed");
  board.moveCard(DEV, p.draft.code, "done", { result: "drafted" });
  board.moveCard(QA, p.review.code, "claimed");
  return board.moveCard(QA, p.review.code, "done", { result: "no blocking issues" });
}

describe("1. off (the default): an agent's main task finishes by itself, as before", () => {
  it("is not marked, needs no review and goes straight to done", () => {
    const { board } = open(false);
    const p = plan(board);
    expect(board.getCard(p.main.code).personReview).toBe(false);
    expect(board.getCard(p.main.code).needsReview).toBe(false);
    expect(p.notes.join("\n")).not.toContain("the person confirms");
    finishBoth(board, p);
    expect(board.getCard(p.main.code).status).toBe("done");
    expect(board.waitingForPerson()).toEqual([]);
  });

  it("is off unless it is exactly true, whatever the board is never told", () => {
    expect(boardPersonConfirmsMain(null)).toBe(false);
    expect(boardPersonConfirmsMain({})).toBe(false);
    expect(boardPersonConfirmsMain({ defaults: { task_board: {} } })).toBe(false);
    expect(boardPersonConfirmsMain({ defaults: { task_board: { person_confirms_main: "yes" } } })).toBe(false);
    expect(boardPersonConfirmsMain({ defaults: { task_board: { person_confirms_main: true } } })).toBe(true);
    const board = new SchedulerDb(tmp()); dbs.push(board);
    // A board nobody told about the switch behaves as off.
    const bare = board.board.createCards(LEAD, { cards: [{ title: "Alone", assignee: "lead" }] }).cards[0]!;
    expect(bare.personReview).toBe(false);
  });

  it("the config validator accepts true or false and refuses anything else", () => {
    const check = (v: unknown) => validateFleetConfig({ defaults: { task_board: { person_confirms_main: v } }, instances: {} }).errors.map((e) => e.path);
    expect(check(true)).not.toContain("defaults.task_board.person_confirms_main");
    expect(check(false)).not.toContain("defaults.task_board.person_confirms_main");
    expect(check("on")).toContain("defaults.task_board.person_confirms_main");
  });
});

describe("2. on: a main task an instance opens is the person's to confirm", () => {
  it("is marked, needs review, and the agent is told in the answer that opened it", () => {
    const { board } = open();
    const p = plan(board);
    const main = board.getCard(p.main.code);
    expect(main.personReview).toBe(true);
    expect(main.needsReview).toBe(true);
    expect(main.dispatcher).toBeNull();
    expect(personReviews(main)).toBe(true);
    expect(p.notes.join("\n")).toContain(`${p.main.code} is a main task the person confirms`);
    expect(p.notes.join("\n")).toContain("does not finish by itself");
  });

  it("its sub tasks are not marked, and stay handed out by the instance that opened them", () => {
    const { board } = open();
    const p = plan(board);
    const sub = board.getCard(p.draft.code);
    expect(sub.personReview).toBe(false);
    expect(sub.needsReview).toBe(false);
    expect(sub.dispatcher).toEqual({ kind: "instance", name: "lead" });
  });

  it("a main task without sub tasks: its owner moves it to review and only the person finishes it", () => {
    const { board } = open();
    const main = board.createCards(LEAD, { cards: [{ title: "Alone", assignee: "lead" }] }).cards[0]!;
    board.moveCard(LEAD, main.code, "claimed");
    expect(() => board.moveCard(LEAD, main.code, "done", { result: "ok" })).toThrow(/needs the person's confirmation; move it to review/);
    board.updateCard(LEAD, main.code, { result: "ok" });
    board.moveCard(LEAD, main.code, "review");
    expect(() => board.moveCard(LEAD, main.code, "done")).toThrow(/waiting for the person's confirmation: only they finish it/);
    expect(board.waitingForPerson().map((w) => w.card.code)).toEqual([main.code]);
    board.moveCard(ANN, main.code, "done");
    expect(board.getCard(main.code).status).toBe("done");
  });

  it("a main task the person opens is as it was: their dispatcher, not marked", () => {
    const { board } = open();
    const main = board.createCards(ANN, { cards: [{ title: "Mine", assignee: "lead" }] }).cards[0]!;
    expect(main.personReview).toBe(false);
    expect(main.needsReview).toBe(true);
    expect(main.dispatcher).toEqual({ kind: "person", name: "Ann" });
    expect(personReviews(main)).toBe(true);
  });

  it("a sub task, or a card the board did not open for an agent's plan, is not marked", () => {
    const { board } = open();
    const p = plan(board);
    expect(board.getCard(p.review.code).personReview).toBe(false);
  });

  it("an agent asking for no review does not take it off: the fleet's setting is the person's", () => {
    const { board } = open();
    const main = board.createCards(LEAD, { cards: [{ title: "Quiet", assignee: "lead", needsReview: false }] }).cards[0]!;
    expect(main.personReview).toBe(true);
    expect(main.needsReview).toBe(true);
  });
});

describe("3. on: the last sub task sends it to the person, not to the instance that opened it", () => {
  it("goes to review, waits under Waiting for you and counts in its project", () => {
    const { board } = open();
    const p = plan(board);
    finishBoth(board, p);
    const main = board.getCard(p.main.code);
    expect(main.status).toBe("review");
    expect(waitsForPerson(main)).toBe(true);
    expect(board.waitingForPerson().map((w) => w.card.code)).toEqual([p.main.code]);
    expect(board.views([main]).find((v) => v.id === p.main.code)).toMatchObject({ waitsForPerson: true, confirmer: null });
    expect(Object.values(board.projectStats()).reduce((n, s) => n + s.waiting, 0)).toBe(1);
    const text = cardText(board, main);
    expect(text).toContain("[waiting for the person]");
    expect(text).toContain("the person confirms it");
  });

  it("the instance that opened it is not woken to confirm it, and has nothing of its own to confirm", () => {
    const { board } = open();
    const w = heard(board);
    const p = plan(board);
    w.take();
    finishBoth(board, p);
    const lead = w.take().filter((x) => x.instance === "lead" && x.code === p.main.code);
    expect(lead.map((x) => x.reasons).flat()).not.toContain("to_confirm");
    expect(lead.map((x) => x.reasons).flat()).not.toContain("confirm_own");
    expect(board.toConfirm("lead")).toEqual([]);
  });

  it("its owner is still told to wrap it up, and that it went to the person", () => {
    const { board } = open();
    const w = heard(board);
    const p = plan(board);
    w.take();
    finishBoth(board, p);
    const wrap = w.take().find((x) => x.instance === "lead" && x.code === p.main.code && x.reasons.includes("wrap_up"))!;
    expect(wrap).toBeTruthy();
    const text = wakeMessage([board.wakeHolds(wrap)!], (u) => board.findCard(u));
    expect(text).toContain("went to the person for confirmation by itself, but 2 definition-of-done items unchecked, no result");
    expect(text).toContain("wrap it up with update");
  });

  it("neither the instance that opened it nor another can finish it or clear the review; the person can", () => {
    const { board } = open();
    const p = plan(board);
    finishBoth(board, p);
    expect(board.confirms(board.getCard(p.main.code), LEAD)).toBe(false);
    // A main task with sub tasks follows them: an agent cannot move it at all. The review is the person's to clear, too.
    expect(() => board.moveCard(LEAD, p.main.code, "done")).toThrow(/its status follows them/);
    expect(() => board.updateCard(LEAD, p.main.code, { needsReview: false })).toThrow(/only a person can clear "needs review"/);
    expect(() => board.updateCard(DEV, p.main.code, { needsReview: false })).toThrow();
    expect(board.getCard(p.main.code).status).toBe("review");
    board.moveCard(ANN, p.main.code, "done");
    expect(board.getCard(p.main.code).status).toBe("done");
    expect(board.waitingForPerson()).toEqual([]);
  });

  it("an agent cannot cancel it while it waits in review — that would take it out of the person's queue — and the person can", () => {
    const { board } = open();
    const p = plan(board);
    finishBoth(board, p);
    expect(board.waitingForPerson().map((w) => w.card.code)).toEqual([p.main.code]);
    expect(() => board.moveCard(LEAD, p.main.code, "cancelled", { reason: "no longer needed" })).toThrow(/waiting for the person's confirmation: only they cancel it/);
    expect(() => board.moveCard(DEV, p.main.code, "cancelled", { reason: "no longer needed" })).toThrow();
    expect(board.getCard(p.main.code).status).toBe("review");
    expect(board.waitingForPerson().map((w) => w.card.code)).toEqual([p.main.code]);
    board.moveCard(ANN, p.main.code, "cancelled", { reason: "not needed" });
    expect(board.getCard(p.main.code).status).toBe("cancelled");
    expect(board.waitingForPerson()).toEqual([]);
  });

  it("the same for a main task without sub tasks that its owner sent to review", () => {
    const { board } = open();
    const main = board.createCards(LEAD, { cards: [{ title: "Alone", assignee: "lead" }] }).cards[0]!;
    board.moveCard(LEAD, main.code, "claimed");
    board.updateCard(LEAD, main.code, { result: "ok" });
    board.moveCard(LEAD, main.code, "review");
    expect(() => board.moveCard(LEAD, main.code, "cancelled", { reason: "oops" })).toThrow(/only they cancel it/);
    board.moveCard(ANN, main.code, "cancelled", { reason: "not needed" });
    expect(board.getCard(main.code).status).toBe("cancelled");
  });

  it("before it is in review its opener may still cancel it, with a reason, as ever; and an agent's own review is not the person's", () => {
    const { board } = open();
    const p = plan(board);
    expect(() => board.moveCard(LEAD, p.main.code, "cancelled")).toThrow(/needs a reason/);
    board.moveCard(LEAD, p.main.code, "cancelled", { reason: "duplicate" });
    expect(board.getCard(p.main.code).status).toBe("cancelled");
    const off = open(false);
    const q = plan(off.board, { needsReview: true });
    finishBoth(off.board, q);
    expect(off.board.getCard(q.main.code).status).toBe("review");
    off.board.moveCard(LEAD, q.main.code, "cancelled", { reason: "its dispatcher's own business" });
    expect(off.board.getCard(q.main.code).status).toBe("cancelled");
  });

  it("the owner can still wrap it up while it waits, and the person sees what was filled in", () => {
    const { board } = open();
    const p = plan(board);
    finishBoth(board, p);
    board.updateCard(LEAD, p.main.code, { check: [1, 2], result: "Delivered.", comment: "Open the attached report." });
    const main = board.getCard(p.main.code);
    expect(main.status).toBe("review");
    expect(main.acceptance.every((a) => a.done)).toBe(true);
    expect(board.waitingForPerson().map((w) => w.card.code)).toEqual([p.main.code]);
  });

  it("the person reopening it sends it back to the instance, as for any card in review", () => {
    const { board } = open();
    const p = plan(board);
    finishBoth(board, p);
    board.moveCard(ANN, p.main.code, "claimed", { reason: "one item is not met" });
    expect(board.getCard(p.main.code).status).toBe("claimed");
    expect(board.waitingForPerson()).toEqual([]);
  });

  it("a person who turns the review off makes it finish by itself again, and turning it on brings the person back", () => {
    const { board } = open();
    const p = plan(board);
    board.updateCard(ANN, p.main.code, { needsReview: false });
    finishBoth(board, p);
    expect(board.getCard(p.main.code).status).toBe("done");
  });
});

describe("4. only the confirmation is the person's", () => {
  it("a blocked sub task's question goes to the instance that handed it out, not to the person", () => {
    const { board } = open();
    const w = heard(board);
    const p = plan(board);
    board.moveCard(DEV, p.draft.code, "claimed");
    w.take();
    board.moveCard(DEV, p.draft.code, "blocked", { reason: "which template?" });
    const lead = w.take().filter((x) => x.instance === "lead" && x.code === p.draft.code).flatMap((x) => x.reasons);
    expect(lead).toContain("decide");
    expect(board.waitingForPerson()).toEqual([]);
  });

  it("a blocked main task is not a question for the person", () => {
    const { board } = open();
    const main = board.createCards(LEAD, { cards: [{ title: "Alone", assignee: "lead" }] }).cards[0]!;
    board.moveCard(LEAD, main.code, "claimed");
    board.moveCard(LEAD, main.code, "blocked", { reason: "waiting for a vendor" });
    expect(board.getCard(main.code).status).toBe("blocked");
    expect(waitsForPerson(board.getCard(main.code))).toBe(false);
    expect(board.waitingForPerson()).toEqual([]);
  });
});

describe("5. the switch is read as a main task is opened", () => {
  it("a card keeps what it was opened with; the next one follows the switch", () => {
    const { board, flag } = open(true);
    const first = plan(board);
    flag.value = false;
    const second = board.createCards(LEAD, { cards: [{ title: "Later", assignee: "lead" }] }).cards[0]!;
    expect(board.getCard(first.main.code).personReview).toBe(true);
    expect(second.personReview).toBe(false);
    expect(second.needsReview).toBe(false);
    flag.value = true;
    expect(board.createCards(LEAD, { cards: [{ title: "Again", assignee: "lead" }] }).cards[0]!.personReview).toBe(true);
  });
});

describe("6. additive: a database from before the column", () => {
  it("gains it as 0 and every card reads as it did; a card opened afterwards is marked", () => {
    const { path, board } = open(false);
    const old = plan(board);
    dbs.splice(0).forEach((d) => d.close());
    const raw = new Database(path);
    raw.exec("ALTER TABLE tasks DROP COLUMN person_review");
    expect((raw.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).some((c) => c.name === "person_review")).toBe(false);
    raw.close();

    const again = open(true, path).board;
    const kept = again.getCard(old.main.code);
    expect(kept.personReview).toBe(false);
    expect(kept.needsReview).toBe(false);
    expect(kept.title).toBe("Publish the report");
    const fresh = again.createCards(LEAD, { cards: [{ title: "New", assignee: "lead" }] }).cards[0]!;
    expect(fresh.personReview).toBe(true);
    // An old release writes a card without the column: it stays 0 in the row it writes, and a card the new code wrote keeps its mark.
    const check = new Database(path);
    check.prepare("UPDATE tasks SET title = 'Edited by an older release' WHERE id = ?").run(fresh.uuid);
    check.close();
    expect(again.getCard(fresh.code).personReview).toBe(true);
  });
});
