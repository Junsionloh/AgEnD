/**
 * The `task` tool on the task board (docs/design/task-board.md): its board actions through both of its doors (HTTP:
 * handleTaskCrudHttp, IPC: handleTaskCrud) — mine, projects, move, create/update with board fields, get of a board
 * card, list by project or parent — answered in text; the tool's own tasks answered as before.
 *
 * Isolation: temp databases; a FleetManager with no fleet (nothing starts).
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SchedulerDb } from "../src/scheduler/db.js";
import { Scheduler } from "../src/scheduler/index.js";
import { FleetManager } from "../src/fleet-manager.js";
import type { Actor } from "../src/scheduler/task-board.js";
import { TaskBoardArgs } from "../src/outbound-schemas.js";

const ANN: Actor = { kind: "person", name: "Ann" };

const dirs: string[] = [];
const dbs: SchedulerDb[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) { try { db.close(); } catch { /* closed */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function dir(): string { const d = mkdtempSync(join(tmpdir(), "task-board-tool-")); dirs.push(d); return d; }

describe("the task tool's board actions", () => {
  function fleet() {
    const d = dir();
    writeFileSync(join(d, "fleet.yaml"), "defaults: {}\ninstances: {}\n");
    const fm = new FleetManager(d);
    const scheduler = new Scheduler(join(d, "scheduler.db"), () => {}, { max_schedules: 100, default_timezone: "UTC", retry_count: 3, retry_interval_ms: 1000 }, () => false);
    (fm as unknown as Record<string, unknown>).scheduler = scheduler;
    dbs.push(scheduler.db);
    const call = (instance: string, args: Record<string, unknown>) => fm.handleTaskCrudHttp(instance, args);
    return { fm, db: scheduler.db, call };
  }

  it("an agent's day: projects, a main task split into sub tasks, mine, get, update, move — text answers", async () => {
    const { db, call } = fleet();
    db.board.createProject(ANN, { name: "Game" });
    expect(await call("lead", { action: "projects" })).toBe("1 Game — 0 main tasks, 0% done");
    expect(await call("lead", { action: "create", title: "Leaderboard", project: "Game", description: "weekly top 100", acceptance: ["resets Monday"] }))
      .toBe("ok M-1 Leaderboard [to do] @lead (v1)");
    expect(await call("lead", { action: "create", title: "API", parent: "M-1", assignee: "dev-a" })).toBe("ok S-1 API [to do] @dev-a (v1)");
    expect(await call("lead", { action: "create", title: "Review", parent: "M-1", assignee: "dev-b", depends_on: ["S-1"] })).toBe("ok S-2 Review [to do] @dev-b (v1)");
    expect(await call("dev-b", { action: "mine" })).toBe("dev-b's work on the task board\nwaiting on dependencies:\n S-2 Review — waits for S-1");
    expect(await call("dev-a", { action: "move", id: "S-1", to: "claimed" })).toBe("ok S-1 to do → in progress (v2)");
    expect(await call("dev-a", { action: "update", id: "S-1", state: "done: handler\nnext: tests", log: "handler in" })).toBe("ok S-1 API [in progress] @dev-a (v3)");
    db.board.updateCard(ANN, "S-1", { comment: "cache it 30 s" });
    expect(await call("dev-a", { action: "get", detail:true, id: "s1" })).toBe([
      "S-1 sub task · API [in progress] @dev-a v4",
      "main M-1 Leaderboard · dispatched by lead · finish it yourself",
      "state:", " done: handler", " next: tests",
      "comments (1 new):", ` Ann ${db.board.detail("S-1").comments[0]!.at.slice(5, 16).replace("T", " ")} [new]: cache it 30 s`,
    ].join("\n"));
    // Its next write hands over the comment it had not seen.
    expect(await call("dev-a", { action: "move", id: "S-1", to: "done", result: "src/api.ts; tests pass" }))
      .toBe("ok S-1 in progress → done (v5)\nnew comment (Ann): cache it 30 s\nS-2's dependencies are all done; it can start");
    expect(await call("lead", { action: "list", detail:true, parent: "M-1" })).toBe("S-2 [to do] Review @dev-b");
    expect(await call("lead", { action: "list", detail:true, parent: "M-1", filter_status: ["done", "open"] })).toBe("S-2 [to do] Review @dev-b\nS-1 [done] API @dev-a");
    expect(await call("lead", { action: "mine" })).toBe("lead's work on the task board\nmain tasks you coordinate:\n M-1 Leaderboard [in progress] sub tasks 1/2");
  });

  it("the board's rules hold, as answers the agent can act on", async () => {
    const { db, call } = fleet();
    db.board.createCards(ANN, { cards: [{ title: "Theirs", assignee: "dev-b" }] });
    expect(await call("dev-a", { action: "move", id: "M-1", to: "claimed" })).toEqual({ error: "M-1 is assigned to dev-b; you cannot take it" });
    // Fields and a status together: one write — the refused move leaves the fields as they were.
    expect(await call("dev-b", { action: "update", id: "M-1", state: "x", status: "done" })).toEqual({ error: "only a card in progress can go to review (M-1 is open)" });
    expect(db.board.getCard("M-1").state).toBe("");
    expect(await call("dev-b", { action: "move", id: "M-1", to: "finished" })).toEqual({ error: "\"to\" is one of open, claimed, blocked, review, done, cancelled" });
    expect(await call("dev-b", { action: "move", id: "M-1", to: "doing" })).toBe("ok M-1 to do → in progress (v2)");      // a word from other boards
    // Done on a card that waits for the person is theirs to confirm, as with the tool's `done`; past that, only they move it.
    expect(await call("dev-b", { action: "move", id: "M-1", to: "done", result: "r" })).toBe("ok M-1 in progress → waiting for the person (v3)");
    expect(await call("dev-b", { action: "move", id: "M-1", to: "done" })).toEqual({ error: "M-1 is waiting for the person's confirmation: only they finish it" });
  });

  it("finishing with no words at all says which field takes the result (a real agent put its summary in `comment`, twice)", async () => {
    const { db, call } = fleet();
    db.board.createCards(ANN, { cards: [{ title: "Mine", assignee: "dev-a", dispatcher: { kind: "instance", name: "lead" } }] });
    expect(await call("dev-a", { action: "move", id: "M-1", to: "claimed" })).toBe("ok M-1 to do → in progress (v2)");
    // Neither a result nor a comment (a blank one is none): the answer names the field, and nothing is written.
    for (const comment of [undefined, "   "]) {
      const refused = await call("dev-a", { action: "move", id: "M-1", to: "done", ...(comment === undefined ? {} : { comment }) }) as { error: string };
      expect(refused.error).toContain("`result` field");
      expect(refused.error).toContain("which files changed and how it was checked");
      expect(db.board.getCard("M-1").status).toBe("claimed");
    }
    expect(await call("dev-a", { action: "move", id: "M-1", to: "done", result: "nothing changed; read it with task get" })).toBe("ok M-1 in progress → done (v3)");
  });

  describe("AGEND-337: a finishing move with words in `comment` and none in `result` takes them as the result", () => {
    const comments = (db: SchedulerDb, ref: string) => db.board.detail(ref).comments.map((c) => c.text);
    /** M-1 handed out by lead to dev-a, which waits for lead's confirmation, claimed and sent back once with an earlier result. */
    function sentBack() {
      const f = fleet();
      f.db.board.createCards(ANN, { cards: [{ title: "Mine", assignee: "dev-a", dispatcher: { kind: "instance", name: "lead" }, needsReview: true }] });
      return f;
    }

    it("first finish: the comment is the result, not also a comment, and the answer says so", async () => {
      const { db, call } = sentBack();
      await call("dev-a", { action: "move", id: "M-1", to: "claimed" });
      const said = await call("dev-a", { action: "move", id: "M-1", to: "review", comment: "src/a.ts; tests pass" }) as string;
      expect(said).toContain("ok M-1 in progress → waiting for confirmation");
      expect(said).toContain("your comment was taken as the result");
      expect(db.board.getCard("M-1").result).toBe("src/a.ts; tests pass");
      expect(comments(db, "M-1")).toEqual([]);
    });

    it("resubmitted after a send-back with only a comment: the one who confirms sees the new summary, not the old one", async () => {
      const { db, call } = sentBack();
      await call("dev-a", { action: "move", id: "M-1", to: "claimed" });
      await call("dev-a", { action: "move", id: "M-1", to: "review", result: "first round: src/a.ts" });
      expect(db.board.getCard("M-1").result).toBe("first round: src/a.ts");
      expect(await call("lead", { action: "move", id: "M-1", to: "claimed", reason: "check the second case too" })).toContain("ok M-1");
      // The old result is still on the card (nothing clears it), so the refusal never fires: only the rule below keeps it from going stale.
      expect(db.board.getCard("M-1").result).toBe("first round: src/a.ts");
      await call("dev-a", { action: "move", id: "M-1", to: "review", comment: "second round: both cases checked in src/a.test.ts" });
      expect(db.board.getCard("M-1").result).toBe("second round: both cases checked in src/a.test.ts");
      expect(await call("lead", { action: "get", id: "M-1", detail: true })).toContain("result: second round: both cases checked in src/a.test.ts");
    });

    it("both given: the result is the result and the comment stays a comment", async () => {
      const { db, call } = sentBack();
      await call("dev-a", { action: "move", id: "M-1", to: "claimed" });
      const said = await call("dev-a", { action: "move", id: "M-1", to: "review", result: "src/a.ts; tests pass", comment: "ping me if the cache is wrong" }) as string;
      expect(said).not.toContain("taken as the result");
      expect(db.board.getCard("M-1").result).toBe("src/a.ts; tests pass");
      expect(comments(db, "M-1")).toEqual(["ping me if the cache is wrong"]);
    });

    it("counter-evidence: the confirmer's note, a person's note, a blank comment and other moves never become a result", async () => {
      const { db, call } = sentBack();
      await call("dev-a", { action: "move", id: "M-1", to: "claimed" });
      await call("dev-a", { action: "move", id: "M-1", to: "review", result: "the assignee's summary" });
      // The dispatcher confirms with a note: it is a comment, and the assignee's result is not overwritten.
      expect(await call("lead", { action: "move", id: "M-1", to: "done", comment: "approved, thanks" })).toContain("ok M-1");
      expect(db.board.getCard("M-1").status).toBe("done");
      expect(db.board.getCard("M-1").result).toBe("the assignee's summary");
      expect(comments(db, "M-1")).toEqual(["approved, thanks"]);
      // A person moving the card with a note: the same.
      db.board.createCards(ANN, { cards: [{ title: "Other", assignee: "dev-b" }] });
      await call("dev-b", { action: "move", id: "M-2", to: "claimed" });
      await call("dev-b", { action: "move", id: "M-2", to: "done", result: "summary two" });
      db.board.moveCard(ANN, "M-2", "claimed", { reason: "again", comment: "a person's note" });
      expect(db.board.getCard("M-2").result).toBe("summary two");
      // Not a finishing move (blocked with a comment), and an agent that does not hold the card: nothing becomes a result.
      db.board.createCards(ANN, { cards: [{ title: "Third", assignee: "dev-a" }] });
      await call("dev-a", { action: "move", id: "M-3", to: "claimed" });
      expect(await call("dev-a", { action: "move", id: "M-3", to: "blocked", reason: "who decides?", comment: "see the thread" })).toContain("ok M-3");
      expect(db.board.getCard("M-3").result).toBe("");
      expect(comments(db, "M-3")).toContain("see the thread");
      db.board.createCards(ANN, { cards: [{ title: "Theirs", assignee: "dev-b" }] });
      expect(await call("dev-a", { action: "move", id: "M-4", to: "done", comment: "mine now" })).toHaveProperty("error");   // refused: not its card
      expect(db.board.getCard("M-4").result).toBe("");
    });

    it("the tool says so in its description", async () => {
      const { TOOLS } = await import("../src/channel/mcp-tools.js");
      const text = TOOLS.find((t) => t.name === "task")!.description;
      expect(text).toContain("the summary of finished work goes in `result`, `comment` is a note for people");
      expect(text).toContain("a finishing move with only a comment takes it as the result");
    });
  });

  it("who handed it out, one card at a time, and what to fill in before its dispatcher confirms", async () => {
    const { db, call } = fleet();
    db.board.createProject(ANN, { name: "Game" });
    expect(await call("lead", { action: "create", title: "Leaderboard", project: "Game", assignee: "dev-a", acceptance: ["resets Monday", "top 100"], needs_review: true }))
      .toBe("ok M-1 Leaderboard [to do] @dev-a (v1)");
    expect((await call("dev-a", { action: "get", detail:true, id: "M-1" }) as string).split("\n")[1]).toBe("project Game · dispatched by lead · lead confirms it");   // #2434: an agent's card, its dispatcher's
    expect(await call("dev-a", { action: "create", title: "Archive", project: "Game", dispatcher: "lead" })).toBe("ok M-2 Archive [to do] @dev-a (v1)");
    expect(db.board.getCard("M-2").dispatcher).toEqual({ kind: "instance", name: "lead" });
    expect(await call("dev-a", { action: "update", id: "M-2", dispatcher: null })).toBe("ok M-2 Archive [to do] @dev-a (v2)");
    expect(db.board.getCard("M-2").dispatcher).toBeNull();
    // Handed out, it counts toward the limit; opened for itself with nobody handing it out, it would not (#2303).
    await call("dev-a", { action: "update", id: "M-2", dispatcher: "lead" });
    await call("dev-a", { action: "move", id: "M-1", to: "claimed" });
    expect(await call("dev-a", { action: "move", id: "M-2", to: "claimed" }))
      .toEqual({ error: "you already have M-1 \"Leaderboard\" in progress. One card at a time: finish it first; if you cannot go on, move it to blocked with a reason, then start M-2" });
    db.board.moveCard(ANN, "M-2", "claimed");                    // the person may; mine says to settle them
    expect(await call("dev-a", { action: "mine" })).toContain(" ⚠ 2 cards in progress: one at a time — finish one (or block it with a reason) before the next");
    db.board.moveCard(ANN, "M-2", "open");
    // Blocked on a question: its dispatcher answers with the decision (`agend-agent task move M-1 claimed "…"`).
    await call("dev-a", { action: "move", id: "M-1", to: "blocked", reason: "weekly or daily?" });
    expect(await call("lead", { action: "move", id: "M-1", to: "claimed", reason: "weekly, the person says" })).toBe("ok M-1 blocked → in progress (v4)");
    expect(db.board.detail("M-1").comments.map((e) => `${e.author}: ${e.text}`)).toEqual(["lead: weekly, the person says"]);
    // In review before it is wrapped up (the person moved it there): what is missing, in get and in mine.
    db.board.moveCard(ANN, "M-1", "review");
    expect(await call("dev-a", { action: "get", detail:true, id: "M-1" })).toContain("before lead confirms it: 2 definition-of-done items unchecked, no result (fill in with update)");
    expect(await call("dev-a", { action: "mine" })).toContain("waiting for confirmation:\n M-1 Leaderboard — fill in before they confirm: 2 definition-of-done items unchecked, no result — by lead");
    // …and the lead, who confirms it, has it in its own list (#2434).
    expect(await call("lead", { action: "mine" })).toContain("for you to confirm:\n M-1 Leaderboard @dev-a — move it to done, or back to claimed with what is missing");
  });

  it("the tool's own tasks are answered as before", async () => {
    const { call } = fleet();
    const ack = await call("dev-a", { action: "create", title: "Plain" }) as { id: string; status: string };
    expect(Object.keys(ack).sort()).toEqual(["id", "status", "updated_at"]);
    expect(await call("dev-a", { action: "get", detail:true, id: ack.id })).toMatchObject({ id: ack.id, code: "M-1", title: "Plain" });
    expect(await call("dev-a", { action: "update", id: ack.id, priority: "high" })).toMatchObject({ id: ack.id, status: "open" });
  });

  it("the IPC door answers the same", () => {
    const { fm, db } = fleet();
    db.board.createProject(ANN, { name: "Game" });
    const got: Array<Record<string, unknown>> = [];
    (fm as unknown as { instanceIpcClients: Map<string, unknown> }).instanceIpcClients.set("dev-a", { send: (m: Record<string, unknown>) => { got.push(m); return true; } });
    (fm as unknown as { handleTaskCrud(name: string, msg: Record<string, unknown>): void }).handleTaskCrud("dev-a", { fleetRequestId: "r1", payload: { action: "projects" }, meta: { instance_name: "dev-a" } });
    expect(got).toEqual([{ type: "fleet_task_response", fleetRequestId: "r1", result: "1 Game — 0 main tasks, 0% done" }]);
  });

  it("the tool's schema takes the board's fields", () => {
    expect(TaskBoardArgs.safeParse({ action: "move", id: "M-1", to: "blocked", reason: "who?" }).success).toBe(true);
    expect(TaskBoardArgs.safeParse({ action: "update", id: "S-1", check: [1, 2], state: "next: x", comment: "c", version: 3 }).success).toBe(true);
    expect(TaskBoardArgs.safeParse({ action: "create", title: "x", parent: "M-1", acceptance: ["a"], needs_review: true, size: "M", dispatcher: "lead" }).success).toBe(true);
    expect(TaskBoardArgs.safeParse({ action: "update", id: "M-1", dispatcher: null }).success).toBe(true);
    expect(TaskBoardArgs.safeParse({ action: "move", id: "M-1", to: "finished" }).success).toBe(false);
  });
});
