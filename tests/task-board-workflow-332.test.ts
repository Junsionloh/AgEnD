/**
 * AGEND-332 (custom statuses, PR 1): a project words its six statuses its own way — name, colour, order, a column that
 * hides while empty — and nothing else changes.
 *
 *   1. The input: every status once, names / meanings within their limits, a colour from the palette, hiding only where allowed.
 *   2. Reading: a project without a workflow reads the default; the default is the built-in one until a person edits it;
 *      an upgrade writes nothing; a row another release wrote is read forgivingly.
 *   3. Writing: a person only; a project's first save gives it its own workflow; the default covers the rest; reset.
 *   4. Nothing else moves: a card's status stays one of the six and the rules read it; the revision moves so pages read again.
 *   5. A release without it: the tables and the column are additive, an older release's writes leave them as they were.
 *
 * Isolation: every database is a temp file; nothing else runs.
 */
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SchedulerDb } from "../src/scheduler/db.js";
import { CARD_STATUSES, TaskBoardError, type Actor, type TaskBoard } from "../src/scheduler/task-board.js";
import {
  DEFAULT_COLORS, DEFAULT_WORKFLOW, HIDEABLE, WORKFLOW_COLORS, WORKFLOW_LIMITS, WorkflowInputError, checkWorkflow, cloneStatuses, readWorkflow,
} from "../src/scheduler/task-board-workflow.js";

const ANN: Actor = { kind: "person", name: "Ann" };
const DEV: Actor = { kind: "instance", name: "dev-a" };
const SCRIPT: Actor = { kind: "script", name: "web-token" };

const dirs: string[] = [];
const dbs: SchedulerDb[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) { try { db.close(); } catch { /* closed by the test */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function open(path = join((() => { const d = mkdtempSync(join(tmpdir(), "task-workflow-")); dirs.push(d); return d; })(), "scheduler.db")) {
  const db = new SchedulerDb(path);
  dbs.push(db);
  return { db, board: db.board, path };
}
function withProjects() {
  const o = open();
  const game = o.board.createProject(ANN, { name: "Game" });
  const ops = o.board.createProject(ANN, { name: "Ops" });
  return { ...o, game, ops };
}
const code = (e: unknown) => (e instanceof TaskBoardError ? `${e.code}/${e.key}` : String(e));
function refusal(fn: () => unknown): string {
  try { fn(); } catch (e) { return code(e); }
  throw new Error("expected a refusal");
}
/** The six statuses as a person sends them, with the changes given. */
const body = (patch: Record<string, Record<string, unknown>> = {}, order: string[] = [...CARD_STATUSES]) =>
  order.map((key) => ({ key, ...patch[key] }));
const rowsOf = (path: string, table: string) => {
  const raw = new Database(path, { readonly: true });
  try { return (raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n; } finally { raw.close(); }
};

describe("0. the six statuses", () => {
  it("the workflow module's list is the board's (it cannot import the board's constant: the board imports it)", () => {
    expect(DEFAULT_WORKFLOW.map((s) => s.key)).toEqual([...CARD_STATUSES]);
    expect(Object.keys(DEFAULT_COLORS)).toEqual([...CARD_STATUSES]);
    for (const c of Object.values(DEFAULT_COLORS)) expect(WORKFLOW_COLORS).toContain(c);
  });
  it("the built-in workflow is today's board: no names of its own, today's colours, nothing hidden", () => {
    expect(DEFAULT_WORKFLOW.map((s) => [s.key, s.name, s.color, s.hideEmpty])).toEqual([
      ["open", "", "gray", false], ["claimed", "", "blue", false], ["blocked", "", "red", false],
      ["review", "", "yellow", false], ["done", "", "green", false], ["cancelled", "", "gray", false],
    ]);
    expect(Object.isFrozen(DEFAULT_WORKFLOW)).toBe(true);
    const copy = cloneStatuses(DEFAULT_WORKFLOW);
    copy[0]!.name = "x";
    expect(DEFAULT_WORKFLOW[0]!.name).toBe("");
  });
});

describe("1. what a person may send", () => {
  it("every status once, in the order given; a colour left out is the status's own", () => {
    const out = checkWorkflow(body({ blocked: { name: "Stuck", color: "yellow" } }, ["done", "open", "claimed", "review", "blocked", "cancelled"]));
    expect(out.map((s) => s.key)).toEqual(["done", "open", "claimed", "review", "blocked", "cancelled"]);
    expect(out.find((s) => s.key === "blocked")).toMatchObject({ name: "Stuck", color: "yellow", hideEmpty: false });
    expect(out.find((s) => s.key === "done")!.color).toBe("green");
  });
  it("limits: at most 12 statuses, a name of 40 characters, a meaning of 300 (counted in characters, not bytes)", () => {
    expect(WORKFLOW_LIMITS).toMatchObject({ statuses: 12, name: 40, description: 300, instructions: 600 });
    expect(checkWorkflow(body({ open: { name: "待".repeat(40), description: "意".repeat(300) } }))[0]!.name).toHaveLength(40);
    const tooLong = (patch: Record<string, unknown>) => { try { checkWorkflow(body({ open: patch })); } catch (e) { return e as WorkflowInputError; } throw new Error("expected a refusal"); };
    expect(tooLong({ name: "x".repeat(41) })).toMatchObject({ key: "too_long", args: ["name", 41, 40] });
    expect(tooLong({ description: "x".repeat(301) })).toMatchObject({ key: "too_long", args: ["description", 301, 300] });
    expect(() => checkWorkflow(Array.from({ length: 13 }, () => ({ key: "open" })))).toThrow(/at most 12/);
  });
  it("each refusal names itself: unknown, twice, missing, colour, not hideable, same name, not a list", () => {
    const key = (v: unknown) => { try { checkWorkflow(v); } catch (e) { return (e as WorkflowInputError).key; } return "ok"; };
    expect(key(body({}, ["open", "claimed", "blocked", "review", "done", "nope"]))).toBe("workflow_status_unknown");
    expect(key(body({}, ["open", "open", "claimed", "blocked", "review", "done"]))).toBe("workflow_status_twice");
    expect(key(body({}, ["open", "claimed", "blocked", "review", "done"]))).toBe("workflow_status_missing");
    expect(key(body({ open: { color: "#ff0000" } }))).toBe("workflow_color");
    expect(key(body({ open: { color: "purple" } }))).toBe("workflow_color");
    expect(key(body({ open: { hideEmpty: true } }))).toBe("workflow_not_hideable");
    expect(key(body({ claimed: { hideEmpty: true } }))).toBe("workflow_not_hideable");
    expect(key(body({ cancelled: { hideEmpty: true } }))).toBe("workflow_not_hideable");
    expect(key(body({ open: { name: "Go" }, blocked: { name: " go " } }))).toBe("workflow_name_twice");
    expect(key(body({ open: { name: 7 } }))).toBe("workflow_invalid");
    expect(key({ statuses: [] })).toBe("workflow_invalid");
    expect(key(null)).toBe("workflow_invalid");
  });
  it("blocked, review and done may hide while empty — and only those", () => {
    expect([...HIDEABLE].sort()).toEqual(["blocked", "done", "review"]);
    const out = checkWorkflow(body({ blocked: { hideEmpty: true }, review: { hideEmpty: true }, done: { hideEmpty: true } }));
    expect(out.filter((s) => s.hideEmpty).map((s) => s.key)).toEqual(["blocked", "review", "done"]);
  });
  it("control characters are dropped from a name; blank names stay the built-in word", () => {
    const out = checkWorkflow(body({ open: { name: "  Ba\u0000cklog\u0007 " }, claimed: { name: "   " } }));
    expect(out[0]!.name).toBe("Backlog");
    expect(out[1]!.name).toBe("");
  });
  it("a row another release wrote is read forgivingly: unknown status and colour, a missing status, long text", () => {
    const rows = [
      { key: "review", name: "QA", description: "", color: "nope", sort: 0, hide_empty: 1 },
      { key: "open", name: "x".repeat(80), description: "d".repeat(500), color: "green", sort: 1, hide_empty: 1 },
      { key: "testing", name: "Testing", description: "", color: "blue", sort: 2, hide_empty: 0 },
      { key: "open", name: "again", description: "", color: "gray", sort: 3, hide_empty: 0 },
    ];
    const out = readWorkflow(rows);
    expect(out.map((s) => s.key)).toEqual(["review", "open", "claimed", "blocked", "done", "cancelled"]);
    expect(out[0]).toMatchObject({ name: "QA", color: "yellow", hideEmpty: true });
    expect(out[1]).toMatchObject({ hideEmpty: false, color: "green" });
    expect(out[1]!.name).toHaveLength(40);
    expect(out[1]!.description).toHaveLength(300);
    expect(readWorkflow([]).map((s) => s.key)).toEqual([...CARD_STATUSES]);
  });
});

describe("2. reading", () => {
  it("a board with no workflow reads the built-in one, for every project and for cards in none", () => {
    const { board, game } = withProjects();
    const all = board.workflows();
    expect(all.defaultCustom).toBe(false);
    expect(all.projects).toEqual({});
    expect(all.default).toEqual(cloneStatuses(DEFAULT_WORKFLOW));
    expect(board.workflowOf(game.id)).toEqual(cloneStatuses(DEFAULT_WORKFLOW));
    expect(board.workflowOf(null)).toEqual(cloneStatuses(DEFAULT_WORKFLOW));
  });
  it("an upgrade writes nothing: opening, reading and working the board leaves the workflow tables empty and every project's workflow unset", () => {
    const { board, path, db } = withProjects();
    board.createCards(ANN, { project: "Game", cards: [{ title: "A card" }] });
    board.workflows();
    db.close();
    expect(rowsOf(path, "task_workflows")).toBe(0);
    expect(rowsOf(path, "task_statuses")).toBe(0);
    const raw = new Database(path, { readonly: true });
    try { expect(raw.prepare("SELECT COUNT(*) AS n FROM task_projects WHERE workflow_id IS NOT NULL").get()).toEqual({ n: 0 }); } finally { raw.close(); }
  });
});

describe("3. writing", () => {
  it("a project's first save gives it its own workflow; another project and the default are untouched", () => {
    const { board, game, ops } = withProjects();
    const saved = board.setWorkflow(ANN, game.id, body({ blocked: { name: "Stuck", color: "yellow", description: "Waiting for an answer" }, review: { hideEmpty: true } },
      ["open", "claimed", "review", "blocked", "done", "cancelled"]));
    expect(saved.map((s) => s.key)).toEqual(["open", "claimed", "review", "blocked", "done", "cancelled"]);
    const all = board.workflows();
    expect(Object.keys(all.projects)).toEqual([String(game.id)]);
    expect(all.projects[String(game.id)]!.map((s) => s.key)).toEqual(["open", "claimed", "review", "blocked", "done", "cancelled"]);
    expect(all.projects[String(game.id)]!.find((s) => s.key === "blocked")).toEqual({ key: "blocked", name: "Stuck", description: "Waiting for an answer", color: "yellow", hideEmpty: false });
    expect(all.projects[String(game.id)]!.find((s) => s.key === "review")!.hideEmpty).toBe(true);
    expect(board.workflowOf(game.id)[3]!.name).toBe("Stuck");
    expect(board.workflowOf(ops.id)).toEqual(cloneStatuses(DEFAULT_WORKFLOW));
    expect(all.default).toEqual(cloneStatuses(DEFAULT_WORKFLOW));
    expect(all.defaultCustom).toBe(false);
  });
  it("saving again replaces the project's workflow (one row set, not two)", () => {
    const { board, game, path, db } = withProjects();
    board.setWorkflow(ANN, game.id, body({ open: { name: "Backlog" } }));
    board.setWorkflow(ANN, game.id, body({ open: { name: "Ideas" }, done: { color: "blue" } }));
    expect(board.workflowOf(game.id).find((s) => s.key === "open")!.name).toBe("Ideas");
    expect(board.workflowOf(game.id).find((s) => s.key === "done")!.color).toBe("blue");
    db.close();
    expect(rowsOf(path, "task_workflows")).toBe(1);
    expect(rowsOf(path, "task_statuses")).toBe(6);
  });
  it("the default workflow covers cards in no project and every project without its own", () => {
    const { board, game, ops } = withProjects();
    board.setWorkflow(ANN, null, body({ open: { name: "Backlog" } }));
    expect(board.workflows().defaultCustom).toBe(true);
    expect(board.workflowOf(null)[0]!.name).toBe("Backlog");
    expect(board.workflowOf(game.id)[0]!.name).toBe("Backlog");
    board.setWorkflow(ANN, ops.id, body({ open: { name: "Requested" } }));
    expect(board.workflowOf(ops.id)[0]!.name).toBe("Requested");
    expect(board.workflowOf(game.id)[0]!.name).toBe("Backlog");
    board.setWorkflow(ANN, null, body({ open: { name: "Inbox" } }));
    expect(board.workflowOf(null)[0]!.name).toBe("Inbox");
    expect(board.workflowOf(ops.id)[0]!.name).toBe("Requested");
  });
  it("reset puts a project back on the default one, the default back to the built-in one; resetting what was never set does nothing", () => {
    const { board, game, ops, path, db } = withProjects();
    board.setWorkflow(ANN, null, body({ open: { name: "Backlog" } }));
    board.setWorkflow(ANN, game.id, body({ open: { name: "Ideas" } }));
    board.resetWorkflow(ANN, game.id);
    expect(board.workflowOf(game.id)[0]!.name).toBe("Backlog");
    expect(board.workflows().projects).toEqual({});
    board.resetWorkflow(ANN, ops.id);
    board.resetWorkflow(ANN, null);
    expect(board.workflows().defaultCustom).toBe(false);
    expect(board.workflowOf(game.id)).toEqual(cloneStatuses(DEFAULT_WORKFLOW));
    db.close();
    expect(rowsOf(path, "task_workflows")).toBe(0);
    expect(rowsOf(path, "task_statuses")).toBe(0);
  });
  it("only a person: an instance and a script (the header token) are refused, and nothing is written", () => {
    const { board, game, path, db } = withProjects();
    for (const actor of [DEV, SCRIPT]) {
      expect(refusal(() => board.setWorkflow(actor, game.id, body()))).toMatch(/^forbidden/);
      expect(refusal(() => board.setWorkflow(actor, null, body()))).toMatch(/^forbidden/);
      expect(refusal(() => board.resetWorkflow(actor, game.id))).toMatch(/^forbidden/);
    }
    db.close();
    expect(rowsOf(path, "task_workflows")).toBe(0);
  });
  it("a refusal writes nothing, and says which rule it is (the page words it)", () => {
    const { board, game, path, db } = withProjects();
    expect(refusal(() => board.setWorkflow(ANN, game.id, body({ open: { hideEmpty: true } })))).toBe("invalid/workflow_not_hideable");
    expect(refusal(() => board.setWorkflow(ANN, game.id, body({ open: { name: "x".repeat(41) } })))).toBe("too_long/too_long");
    expect(refusal(() => board.setWorkflow(ANN, 999, body()))).toBe("not_found/project_not_found");
    expect(refusal(() => board.resetWorkflow(ANN, 999))).toBe("not_found/project_not_found");
    db.close();
    expect(rowsOf(path, "task_workflows")).toBe(0);
    expect(rowsOf(path, "task_statuses")).toBe(0);
  });
  it("an archived project's workflow can be edited; a renamed project keeps its workflow", () => {
    const { board, game } = withProjects();
    board.setWorkflow(ANN, game.id, body({ open: { name: "Backlog" } }));
    board.updateProject(ANN, game.id, { name: "Games", archived: true });
    expect(board.workflowOf(game.id)[0]!.name).toBe("Backlog");
    board.setWorkflow(ANN, game.id, body({ open: { name: "Later" } }));
    expect(board.workflowOf(game.id)[0]!.name).toBe("Later");
  });
});

describe("4. nothing else moves", () => {
  it("a card's status stays one of the six, the rules read it, and the words change only in the workflow", () => {
    const { board, game } = withProjects();
    const m = board.createCards(ANN, { project: "Game", cards: [{ title: "Build it", assignee: "dev-a" }] }).cards[0]!;
    board.setWorkflow(ANN, game.id, body({ blocked: { name: "Stuck" }, open: { name: "Backlog" } }));
    // Blocking still needs the reason (and a card in progress); the card's status is the built-in key.
    expect(refusal(() => board.moveCard(DEV, m.code, "blocked", {}))).toMatch(/^invalid/);
    board.moveCard(DEV, m.code, "claimed", {});
    expect(refusal(() => board.moveCard(DEV, m.code, "blocked", {}))).toMatch(/^invalid\/block_reason/);
    const moved = board.moveCard(DEV, m.code, "blocked", { reason: "Which API?" });
    expect(moved.card.status).toBe("blocked");
    expect(board.getCard(m.code).status).toBe("blocked");
    expect(board.projectStats()[String(game.id)]).toMatchObject({ blocked: 1 });
    // The workflow is a read of its own: the card carries no workflow field.
    expect(Object.keys(board.getCard(m.code))).not.toContain("workflow");
  });
  it("a card moved to another project reads the other project's words with no change to the card", () => {
    const { board, game, ops } = withProjects();
    const m = board.createCards(ANN, { project: "Game", cards: [{ title: "Build it" }] }).cards[0]!;
    board.setWorkflow(ANN, game.id, body({ open: { name: "Backlog" } }));
    board.setWorkflow(ANN, ops.id, body({ open: { name: "Requested" } }));
    board.updateCard(ANN, m.code, { projectId: ops.id, version: m.version });
    const card = board.getCard(m.code);
    expect(card).toMatchObject({ status: "open", projectId: ops.id });
    expect(board.workflowOf(card.projectId)[0]!.name).toBe("Requested");
  });
  it("a save moves the board's revision once, so every open page reads the board again; a read does not", () => {
    const { board, game } = withProjects();
    const before = board.revision();
    board.workflows();
    expect(board.revision()).toBe(before);
    const seen: Array<{ rev: number; projects: boolean }> = [];
    board.onChange((c) => seen.push({ rev: c.rev, projects: c.projects }));
    board.setWorkflow(ANN, game.id, body({ open: { name: "Backlog" } }));
    expect(board.revision()).toBe(before + 1);
    board.resetWorkflow(ANN, game.id);
    expect(board.revision()).toBe(before + 2);
    expect(seen).toEqual([{ rev: before + 1, projects: true }, { rev: before + 2, projects: true }]);
  });
});

describe("5. a release without it (downgrade)", () => {
  /** What the release before this one does to the board: the columns it knows, a project rename and a card move included. */
  function oldReleaseWrites(path: string, ids: { project: number; card: string }) {
    const raw = new Database(path);
    raw.prepare("UPDATE task_projects SET name = ?, description = ? WHERE id = ?").run("Game (renamed by the old release)", "old", ids.project);
    raw.prepare("INSERT INTO task_projects (name, description, sort, created_at, lead_instance) VALUES ('Made by the old release', '', 9, ?, NULL)").run("2026-03-01T00:00:00.000Z");
    raw.prepare("UPDATE tasks SET status = 'claimed', assignee = 'dev-a', updated_at = ? WHERE id = ?").run("2026-03-02T00:00:00.000Z", ids.card);
    raw.close();
  }
  it("the tables and the column are additive: a project made, renamed and worked on by an older release keeps its workflow when the new one is back", () => {
    const { board, game, db, path } = withProjects();
    const m = board.createCards(ANN, { project: "Game", cards: [{ title: "Build it" }] }).cards[0]!;
    board.setWorkflow(ANN, game.id, body({ blocked: { name: "Stuck", color: "green" }, review: { hideEmpty: true } }, ["done", "open", "claimed", "blocked", "review", "cancelled"]));
    db.close();
    oldReleaseWrites(path, { project: game.id, card: m.uuid });
    const again = open(path);
    expect(again.board.getProject(game.id).name).toBe("Game (renamed by the old release)");
    const flow = again.board.workflowOf(game.id);
    expect(flow.map((s) => s.key)).toEqual(["done", "open", "claimed", "blocked", "review", "cancelled"]);
    expect(flow.find((s) => s.key === "blocked")).toMatchObject({ name: "Stuck", color: "green" });
    expect(flow.find((s) => s.key === "review")!.hideEmpty).toBe(true);
    // The project the old release made has no workflow and reads the default; the card the old release moved is as it left it.
    const made = again.board.listProjects().find((p) => p.name === "Made by the old release")!;
    expect(again.board.workflowOf(made.id)).toEqual(cloneStatuses(DEFAULT_WORKFLOW));
    expect(again.board.getCard(m.code)).toMatchObject({ status: "claimed", assignee: "dev-a" });
  });
  it("a database made before this release (no tables, no column) opens, reads the built-in workflow and is written to by nothing until a person saves", () => {
    const first = open();
    const project = first.board.createProject(ANN, { name: "Game" });
    first.db.close();
    // Take the board back to the release before: the tables and the column are not there.
    const raw = new Database(first.path);
    raw.exec("DROP TABLE task_statuses; DROP TABLE task_workflows; ALTER TABLE task_projects DROP COLUMN workflow_id;");
    expect((raw.prepare("PRAGMA table_info(task_projects)").all() as Array<{ name: string }>).map((c) => c.name)).not.toContain("workflow_id");
    raw.close();
    const again = open(first.path);
    expect(again.board.workflows()).toEqual({ default: cloneStatuses(DEFAULT_WORKFLOW), defaultCustom: false, projects: {} });
    expect(again.board.getProject(project.id).name).toBe("Game");
    expect(rowsOf(first.path, "task_workflows")).toBe(0);
    again.board.setWorkflow(ANN, project.id, body({ open: { name: "Backlog" } }));
    expect(again.board.workflowOf(project.id)[0]!.name).toBe("Backlog");
  });
  it("the new tables hold no card: the status of every card is untouched by a workflow of any kind", () => {
    const { board, game, db, path } = withProjects();
    const m = board.createCards(ANN, { project: "Game", cards: [{ title: "Build it" }] }).cards[0]!;
    board.setWorkflow(ANN, game.id, body({ open: { name: "Backlog" }, claimed: { name: "Doing" } }));
    db.close();
    const raw = new Database(path, { readonly: true });
    try {
      expect(raw.prepare("SELECT status FROM tasks WHERE id = ?").get(m.uuid)).toEqual({ status: "open" });
      expect((raw.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((c) => c.name)).not.toContain("workflow_id");
      expect(raw.prepare("SELECT category FROM task_statuses ORDER BY sort").all().map((r) => (r as { category: string }).category)).toEqual([...CARD_STATUSES]);
    } finally { raw.close(); }
  });
});

describe("6. the board's own reads are the same objects as before", () => {
  it("a TaskBoard type still exposes what the dashboard reads (a type-level check that the workflow methods are on it)", () => {
    const b: Pick<TaskBoard, "workflows" | "workflowOf" | "setWorkflow" | "resetWorkflow"> = open().board;
    expect(typeof b.workflows).toBe("function");
  });
});
