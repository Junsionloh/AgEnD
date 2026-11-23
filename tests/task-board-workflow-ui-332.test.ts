/**
 * AGEND-332 (custom statuses, PR 1), the page's side: a project's own names, colours and order for its six statuses show
 * on the board, the list, the menus, the filters, the card and the stats; an older board (no `workflows` in the read)
 * looks exactly as it did; the Statuses dialog sends what a person set, and only a person who can write sees it.
 *
 * The rig is AGEND-294's: the real Fleet panel on a mini DOM, a fake `fetch`, and the board read the handler returns.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

let p: AppPage;
let app: any, nav: any, fleet: any, common: any, wf: any, view: any, stats: any, cardMod: any;
const calls: Array<{ method: string; path: string; body: any }> = [];
let handler: (path: string, method: string, body: any) => unknown = () => ({});
const fetchFake = async (path: string, o: any = {}) => {
  const method = o.method ?? "GET";
  const body = o.body ? JSON.parse(o.body) : null;
  calls.push({ method, path, body });
  const out: any = await handler(path, method, body);
  const status = out && typeof out === "object" && "__status" in out ? out.__status : 200;
  return { ok: status < 400, status, json: async () => out };
};

const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const card = (over: Record<string, unknown>) => ({ id: "M-1", uuid: String(over.id ?? "M-1"), kind: "main", projectId: 1, parentId: null, title: "A card", status: "open",
  assignee: null, dispatcher: { kind: "person", name: "Ann" }, waitsForPerson: false, confirmer: null, priority: "normal", size: null, needsReview: true, dependsOn: [], goal: "", scope: "",
  acceptance: [], context: "", state: "", blockedReason: "", result: "", sort: 1, createdBy: "Ann", version: 4, createdAt: ago(10), updatedAt: ago(1), startedAt: null, submittedAt: null,
  doneAt: null, progress: { total: 0, open: 0, claimed: 0, blocked: 0, review: 0, done: 0 }, unmetDeps: [], commentCount: 0, newCommentCount: 0, lastComment: null, ...over });
const GAME = { id: 1, name: "Game", description: "", archived: false, sort: 1, createdAt: ago(30) };
const OPS = { id: 2, name: "Ops", description: "", archived: false, sort: 2, createdAt: ago(30) };
const CARDS = [
  card({ id: "M-1", title: "Serve the leaderboard", status: "claimed", assignee: "alpha" }),
  card({ id: "M-2", title: "Add the shop", status: "open", sort: 2 }),
  card({ id: "M-3", title: "Choose the badge", status: "review", assignee: "alpha", waitsForPerson: true, sort: 3, result: "B" }),
  card({ id: "M-4", title: "Bootstrap", status: "done", sort: 4, doneAt: ago(1) }),
  card({ id: "M-5", title: "Ops card", status: "open", projectId: 2, sort: 5 }),
];
/** Game's own statuses: renamed, recoloured, reordered (review before blocked), the blocked column hidden while empty. */
const GAME_FLOW = [
  { key: "open", name: "Backlog", description: "Not picked up yet", color: "gray", hideEmpty: false },
  { key: "claimed", name: "Building", description: "", color: "yellow", hideEmpty: false },
  { key: "review", name: "In QA", description: "Tested by the lead", color: "blue", hideEmpty: false },
  { key: "blocked", name: "Stuck", description: "", color: "red", hideEmpty: true },
  { key: "done", name: "Shipped", description: "", color: "red", hideEmpty: false },
  { key: "cancelled", name: "Dropped", description: "", color: "gray", hideEmpty: false },
];
const BUILT_IN = ["open", "claimed", "blocked", "review", "done", "cancelled"].map((key) => ({ key, name: "", description: "", color: ({ open: "gray", claimed: "blue", blocked: "red", review: "yellow", done: "green", cancelled: "gray" } as any)[key], hideEmpty: false }));
let workflows: any;
let cards: any[];

beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet", storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fetchFake;
  app = await import("/assets/app-store.js");
  nav = await import("/assets/app-nav.js");
  fleet = await import("/ui/js/panel-fleet.js");
  common = await import("/ui/js/fleet-task-common.js");
  wf = await import("/ui/js/fleet-task-workflow.js");
  view = await import("/ui/js/fleet-task-view.js");
  stats = await import("/ui/js/fleet-task-stats.js");
  cardMod = await import("/ui/js/fleet-task-card.js");
  nav.startRouter(p.window);
}, 60_000);
afterAll(() => { p.restore(); delete (globalThis as any).fetch; });
beforeEach(async () => {
  await p.unmount();
  const ls = (globalThis as any).localStorage;
  for (const k of ["agend_tasks_project", "agend_tasks_display", "agend_tasks_filters", "agend_tasks_assignee", "agend_tasks_query", "agend_tasks_collapsed"]) ls.removeItem(k);
  for (const k of ["publicLink", "linkMedia", "tier"]) delete (globalThis as any).document.body.dataset[k];
  (globalThis as any).history.replaceState(null, "", "/ui/fleet");
  (globalThis as any).history.entries.length = 1;
  (globalThis as any).history.states.length = 1;
  (globalThis as any).history.at = 0;
  calls.length = 0;
  cards = CARDS;
  workflows = { default: BUILT_IN, defaultCustom: false, projects: { "1": GAME_FLOW } };
  handler = (path, method) => {
    if (path.startsWith("/ui/tasks/board")) return { rev: 1, projects: [GAME, OPS], cards, boardOff: [], workflows };
    const m = /^\/ui\/tasks\/cards\/([^/]+)$/.exec(path);
    if (m && method === "GET") { const c = cards.find((x) => x.id === decodeURIComponent(m[1]!)); return { card: c, parent: null, children: [], comments: [], logs: [], history: [{ id: 1, actor: "alpha", actorKind: "instance", type: "moved", data: { from: "open", to: "claimed" }, at: "2026-11-02T09:00:00.000Z" }], watchers: [], inheritedWatchers: [], leader: null }; }
    if (path.endsWith("/workflow") || path === "/ui/tasks/workflow") return { workflows };
    return {};
  };
  app.applyStatus({ uptime: 1, instances: ["alpha", "beta"].map((name) => ({ name, status: "running", state: "idle", execution_state: "idle" })) });
});

let mounts = 0;
async function mount(storage: Record<string, string> = { agend_tasks_project: "1" }) {
  await p.unmount();
  for (const [k, v] of Object.entries(storage)) (globalThis as any).localStorage.setItem(k, v);
  await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "tasks" }, navKey: `fleet:tasks|wf-${++mounts}|en` }));
  await settle(8);
}
const q = (sel: string) => p.root.querySelector(sel);
const qa = (sel: string) => [...p.root.querySelectorAll(sel)] as any[];
const text = (el: any): string | null => (el ? el.childNodes.map((n: any) => (n.nodeType === 3 ? n.textContent : text(n)) ?? "").map((s: string) => s.replace(/\s+/g, " ").trim()).filter(Boolean).join(" ") : null);
const heads = () => qa(".tb-col-head").map((el) => text(el)!.replace(/\s*(Last 7 days|All)?\s*\d+$/, ""));
const posts = () => calls.filter((c) => c.method === "POST");

describe("the look-up", () => {
  it("a card, a project id, the key of no project, or nothing — each reads the project's workflow, else the default", () => {
    common.setWorkflows(workflows);
    expect(common.statusName("open", 1)).toBe("Backlog");
    expect(common.statusName("open", { projectId: 1 })).toBe("Backlog");
    expect(common.statusName("open", "1")).toBe("Backlog");
    expect(common.statusName("open", 2)).toBe("To do");
    expect(common.statusName("open", common.NO_PROJECT)).toBe("To do");
    expect(common.statusName("open", { projectId: null })).toBe("To do");
    expect(common.statusName("open")).toBe("To do");
    expect(common.statusName("cancelled", 1)).toBe("Dropped");
  });
  it("colour is a class only when it is not the one the status always had; the order leaves out cancelled; a hidden empty column is asked for per status", () => {
    common.setWorkflows(workflows);
    expect([common.statusColor("open", 1), common.statusColor("claimed", 1), common.statusColor("review", 1), common.statusColor("blocked", 1), common.statusColor("done", 1)])
      .toEqual(["", " sc-yellow", " sc-blue", "", " sc-red"]);
    expect(common.statusColor("claimed", 2)).toBe("");
    expect(common.columnsOf(1)).toEqual(["open", "claimed", "review", "blocked", "done"]);
    expect(common.columnsOf(2)).toEqual(["open", "claimed", "blocked", "review", "done"]);
    expect([common.hidesWhenEmpty("blocked", 1), common.hidesWhenEmpty("blocked", 2), common.hidesWhenEmpty("open", 1)]).toEqual([true, false, false]);
    expect(common.statusHint("open", 1)).toBe("Not picked up yet");
    expect(common.statusHint("open", 2)).toBe("");
  });
  it("a read without workflows (an older host), or a malformed one, is the built-in board", () => {
    for (const w of [undefined, null, {}, { default: [], projects: { "1": "x" } }, { default: [{ nope: 1 }] }]) {
      common.setWorkflows(w);
      expect(common.statusName("blocked", 1)).toBe("Blocked");
      expect(common.statusColor("done", 1)).toBe("");
      expect(common.columnsOf(1)).toEqual(["open", "claimed", "blocked", "review", "done"]);
      expect(common.defaultIsCustom()).toBe(false);
    }
  });
  it("the blocked count on a tile says the project's word: 'Stuck 3' ('3 Stuck'), else the page's own", () => {
    common.setWorkflows({ ...workflows, projects: { "1": GAME_FLOW.map((s) => (s.key === "blocked" ? { ...s, name: "Stuck" } : s)) } });
    expect(common.blockedFlagText(3, 1)).toBe("3 Stuck");
    expect(common.blockedFlagText(3, 2)).toBe("3 blocked");
  });
  it("an error or a note that names a status says it in the project's word", () => {
    common.setWorkflows(workflows);
    expect(common.errorText({ key: "already", args: ["M-1", "open"] }, 1)).toContain("Backlog");
    expect(common.errorText({ key: "already", args: ["M-1", "open"] }, 2)).toContain("To do");
    expect(common.notesForPeople([{ key: "back_to", args: ["M-1", "claimed"] }], { projectId: 1 })[0]).toContain("Building");
  });
  it("a history line and a status choice say the project's words (the card's own project)", () => {
    common.setWorkflows(workflows);
    const ev = { type: "moved", data: { from: "open", to: "claimed" } };
    expect(cardMod.describeEvent(ev, { projectId: 1 })).toContain("Backlog");
    expect(cardMod.describeRow(ev, { projectId: 1 })).toMatch(/Backlog.*Building/);
    expect(cardMod.describeRow(ev, { projectId: 2 })).toMatch(/To do.*In progress/);
    expect(cardMod.statusItems({ status: "open", kind: "main", projectId: 1, progress: { total: 0 } }, () => {}).map((i: any) => i.label)).toEqual(["Backlog", "Building", "In QA", "Stuck", "Shipped"]);
  });
  it("what the dialog sends: the six, in the order set, cancelled last, blanks trimmed, hiding only where it is allowed", () => {
    common.setWorkflows(workflows);
    const rows = wf.startRows(1);
    expect(rows.map((r: any) => r.key)).toEqual(["open", "claimed", "review", "blocked", "done", "cancelled"]);
    expect(wf.workflowBody(wf.moveRow(rows, "done", -1)).map((r: any) => r.key)).toEqual(["open", "claimed", "review", "done", "blocked", "cancelled"]);
    expect(wf.moveRow(rows, "open", -1)).toBe(rows);
    expect(wf.moveRow(rows, "done", 1)).toBe(rows);
    expect(wf.moveRow(rows, "cancelled", -1)).toBe(rows);
    const body = wf.workflowBody([{ ...rows[0], name: "  Inbox  ", hideEmpty: true }, ...rows.slice(1)]);
    expect(body[0]).toEqual({ key: "open", name: "Inbox", description: "Not picked up yet", color: "gray", hideEmpty: false });
    expect(wf.sharedName([{ name: "Go" }, { name: " go " }])).toBe("go");
    expect(wf.sharedName([{ name: "" }, { name: "" }, { name: "a" }])).toBeNull();
  });
});

describe("a project with its own statuses", () => {
  it("the board's columns are in its order, in its words, with its colours; an empty column that hides is not drawn", async () => {
    await mount();
    expect(heads()).toEqual(["Backlog", "Building", "In QA", "Shipped"]);
    expect(qa(".tb-col").map((c) => c.className.match(/st-(\w+)/)![1])).toEqual(["open", "claimed", "review", "done"]);
    expect(qa(".tb-col").map((c) => (c.className.match(/sc-(\w+)/) || [])[1] ?? null)).toEqual([null, "yellow", "blue", "red"]);
    expect(q(".tb-col.st-open .tb-col-head").getAttribute("title")).toBe("Not picked up yet");
    // The phone's one-status-at-a-time buttons carry the same words.
    expect(qa(".tb-status-seg button").map((b) => text(b)!.replace(/\s*\d+$/, ""))).toEqual(["Backlog", "Building", "In QA", "Shipped"]);
  });
  it("the hidden column comes back while a card is in it", async () => {
    cards = [...CARDS, card({ id: "M-6", title: "Stuck one", status: "blocked", blockedReason: "Which API?", sort: 6 })];
    await mount();
    expect(heads()).toEqual(["Backlog", "Building", "In QA", "Stuck", "Shipped"]);
  });
  it("another project, and an older board, read the default: today's words, order and colours", async () => {
    await mount({ agend_tasks_project: "2" });
    expect(heads()).toEqual(["To do", "In progress", "Blocked", "To confirm", "Done"]);
    expect(qa(".tb-col").every((c) => !/\bsc-/.test(c.className))).toBe(true);
    workflows = undefined;
    await mount({ agend_tasks_project: "1" });
    expect(heads()).toEqual(["To do", "In progress", "Blocked", "To confirm", "Done"]);
  });
  it("the list groups, the row's dot and the sub-task dots read the project's words", async () => {
    await mount({ agend_tasks_project: "1" });
    fire(qa(".tb-view-toggle button").find((b) => text(b) === "List"), "click"); await settle(6);
    expect(qa(".tb-group-head").map((el) => text(el)!.replace(/\s*\d+$/, ""))).toEqual(["Backlog", "Building", "In QA", "Shipped"]);
    expect(q('[data-row="M-1"] .tb-dot').getAttribute("aria-label")).toBe("Building");
    expect(q('[data-row="M-1"] .tb-dot').className).toContain("sc-yellow");
  });
  it("a card's ⋯ menu lists the statuses in the project's order and words, with its colour dots", async () => {
    await mount();
    fire(q('[data-tile="M-2"] .tb-tile-more'), "click"); await settle(6);
    const moves = qa(".tb-card-menu button").filter((b) => b.querySelector(".tb-dot") && ["Building", "In QA", "Stuck", "Shipped"].includes(text(b)!));
    expect(moves.map((b) => text(b))).toEqual(["Building", "In QA", "Stuck", "Shipped"]);
    expect(moves[0].querySelector(".tb-dot").className).toContain("sc-yellow");
    fire(moves[0], "click"); await settle(10);
    expect(posts().map((c) => [c.path, c.body.to])).toEqual([["/ui/tasks/cards/M-2/move", "claimed"]]);   // the card moves to the built-in key
  });
  it("the card's page says the status, its choices and its history in the project's words", async () => {
    await mount();
    fire(q('[data-tile="M-1"] .tb-tile-title'), "click"); await settle(10);
    expect(text(q(".tp-idrow .tb-pill"))).toBe("Building");
    expect(q(".tp-idrow .tb-pill").className).toContain("sc-yellow");
    const row = qa(".tp-row").find((r) => text(r.querySelector("dt")) === "Status");
    fire(row.querySelector("button.tp-chip"), "click"); await settle(4);
    expect(qa(".tp-row .menu-list button").map((b) => text(b))).toEqual(["Backlog", "Building", "In QA", "Stuck", "Shipped"]);
    // The history: the move "from To do to In progress" reads in the project's words once the run of activity is opened.
    fire(qa("button").find((b) => /1 activity/.test(text(b) ?? "")), "click"); await settle(6);
    expect(text(q(".tl-text"))).toContain("Backlog");
    expect(text(q(".tl-text"))).toContain("Building");
  });
  it("a card waiting for you, on Home, says its own project's word for it", async () => {
    await mount({ agend_tasks_project: "" });
    expect(text(q(".tb-waiting .tb-pill"))).toBe("In QA");
  });
  it("the filter menu and the stats name the project's statuses", async () => {
    await mount();
    common.setWorkflows(workflows);
    expect(view.valueWord("status", "blocked", 1)).toBe("Stuck");
    expect(view.valueWord("status", "blocked", 2)).toBe("Blocked");
    expect(view.groupRows(CARDS.filter((c) => c.projectId === 1) as any, "status", 1).map((g: any) => g.key)).toEqual(["open", "claimed", "review", "done"]);
    expect(stats.insight).toBeTypeOf("function");
  });
});

describe("the Statuses dialog", () => {
  const open = async () => { fire(qa(".tb-head-actions button").find((b) => text(b) === "Statuses"), "click"); await settle(8); };
  const dlg = () => qa("dialog[open]").at(-1);
  const row = (key: string) => dlg().querySelector(`.tf-row[data-status="${key}"]`);

  it("a project's header has Statuses; it opens the project's six, in its order, with its words and colours", async () => {
    await mount();
    await open();
    expect(text(dlg().querySelector(".dlg-title") ?? dlg().querySelector("h2"))).toContain("Game");
    expect(qa("dialog[open] .tf-row").map((r) => r.getAttribute("data-status"))).toEqual(["open", "claimed", "review", "blocked", "done", "cancelled"]);
    expect(row("claimed").querySelector(".tf-name").value).toBe("Building");
    expect(row("claimed").querySelector('.tf-swatch[aria-checked="true"] .tb-dot').className).toContain("sc-yellow");
    expect(row("review").querySelector(".tf-name").getAttribute("placeholder")).toBe("To confirm");
    expect(row("blocked").querySelector(".tf-hide input").checked).toBe(true);
    // Hiding is offered for blocked, review and done only; cancelled says it is no column.
    expect(qa("dialog[open] .tf-hide").length).toBe(3);
    expect(row("open").querySelector(".tf-hide")).toBeNull();
    expect(text(row("cancelled").querySelector(".tf-hint"))).toBe("Not a column");
    // Built-in meaning is on the row; the first and last columns cannot move past the ends.
    expect(row("open").querySelector(".tf-move button").disabled).toBe(true);
    expect(row("cancelled").querySelector(".tf-move button")).toBeNull();
    expect(text(dlg().querySelector(".tf-note"))).toContain("this project's own");
  });
  it("renaming, recolouring and moving a status, then Save, sends the six in that order — nothing about the cards", async () => {
    await mount();
    await open();
    const name = row("open").querySelector(".tf-name"); name.value = "Ideas"; fire(name, "input"); await settle(4);
    fire(row("done").querySelectorAll(".tf-swatch")[2], "click"); await settle(4);          // green
    fire(row("done").querySelectorAll(".tf-move button")[0], "click"); await settle(4);      // done up one: before blocked
    const save = qa("dialog[open] .dlg-actions button").find((b) => text(b) === "Save");
    expect(save.disabled).toBe(false);
    fire(save, "click"); await settle(10);
    expect(posts().map((c) => c.path)).toEqual(["/ui/tasks/projects/1/workflow"]);
    expect(posts()[0]!.body.statuses.map((s: any) => s.key)).toEqual(["open", "claimed", "review", "done", "blocked", "cancelled"]);
    expect(posts()[0]!.body.statuses[0]).toEqual({ key: "open", name: "Ideas", description: "Not picked up yet", color: "gray", hideEmpty: false });
    expect(posts()[0]!.body.statuses.find((s: any) => s.key === "done")).toMatchObject({ color: "green", name: "Shipped" });
    expect(qa("dialog[open]").length, "closed after the save").toBe(0);
    expect(calls.filter((c) => c.path.startsWith("/ui/tasks/board")).length).toBeGreaterThan(1);   // the board is read again
  });
  it("Save waits for a change (when the project has its own), and two statuses with one name are refused before they are sent", async () => {
    await mount();
    await open();
    const save = () => qa("dialog[open] .dlg-actions button").find((b) => text(b) === "Save");
    expect(save().disabled).toBe(true);
    const name = row("blocked").querySelector(".tf-name"); name.value = "building"; fire(name, "input"); await settle(4);
    expect(save().disabled).toBe(true);
    expect(text(dlg().querySelector(".tf-error"))).toContain("Two statuses have the same name");
    name.value = "Waiting"; fire(name, "input"); await settle(4);
    expect(save().disabled).toBe(false);
    expect(dlg().querySelector(".tf-error")).toBeNull();
  });
  it("a project on the default says so, and its first save is the whole six; no 'use the default' until it has its own", async () => {
    await mount({ agend_tasks_project: "2" });
    await open();
    expect(text(dlg().querySelector(".tf-note"))).toContain("uses the default statuses");
    expect(qa("dialog[open] .dlg-actions button").map((b) => text(b))).toEqual(["Cancel", "Save"]);
    expect(qa("dialog[open] .tf-row").map((r) => r.getAttribute("data-status"))).toEqual(["open", "claimed", "blocked", "review", "done", "cancelled"]);
    const save = qa("dialog[open] .dlg-actions button").find((b) => text(b) === "Save");
    expect(save.disabled).toBe(false);
    fire(save, "click"); await settle(10);
    expect(posts().map((c) => c.path)).toEqual(["/ui/tasks/projects/2/workflow"]);
    expect(posts()[0]!.body.statuses).toHaveLength(6);
  });
  it("'Use the default statuses' puts a project back (it has one of its own)", async () => {
    await mount();
    await open();
    const reset = qa("dialog[open] .dlg-actions button").find((b) => text(b) === "Use the default statuses");
    expect(reset).toBeTruthy();
    fire(reset, "click"); await settle(10);
    expect(posts().map((c) => [c.path, c.body])).toEqual([["/ui/tasks/projects/1/workflow", { reset: true }]]);
  });
  it("a refusal is toasted in the page's words and the dialog stays open", async () => {
    await mount();
    await open();
    handler = (path, method) => (method === "POST" ? { __status: 400, error: "x", code: "invalid", key: "workflow_name_twice", args: ["Ideas"] } : { rev: 1, projects: [GAME, OPS], cards, boardOff: [], workflows });
    const name = row("open").querySelector(".tf-name"); name.value = "Ideas"; fire(name, "input"); await settle(4);
    fire(qa("dialog[open] .dlg-actions button").find((b) => text(b) === "Save"), "click"); await settle(10);
    expect(qa("dialog[open]").length).toBe(1);
    expect(qa("dialog[open] .tf-row").length).toBe(6);
  });
  it("Home has the default statuses (cards in no project, projects without their own); it saves to the default route", async () => {
    await mount({ agend_tasks_project: "" });
    fire(qa(".tb-head-actions button").find((b) => text(b) === "Default statuses"), "click"); await settle(8);
    expect(text(dlg().querySelector(".tf-note"))).toContain("cards in no project");
    const name = row("open").querySelector(".tf-name"); name.value = "Inbox"; fire(name, "input"); await settle(4);
    fire(qa("dialog[open] .dlg-actions button").find((b) => text(b) === "Save"), "click"); await settle(10);
    expect(posts().map((c) => c.path)).toEqual(["/ui/tasks/workflow"]);
    expect(posts()[0]!.body.statuses[0]!.name).toBe("Inbox");
  });
  it("a project tile's menu has Statuses…", async () => {
    await mount({ agend_tasks_project: "" });
    fire(q(".tb-project-menu button"), "click"); await settle(6);
    fire(qa(".menu-item, .menu-list button").find((b) => text(b) === "Statuses…"), "click"); await settle(8);
    expect(text(dlg().querySelector(".dlg-title") ?? dlg().querySelector("h2"))).toContain("Game");
  });
  it("a viewer whose writes the host refuses (a guest, or a read-only session over the public link) is not offered the button", async () => {
    (globalThis as any).document.body.dataset.tier = "guest";
    await mount();
    expect(qa(".tb-head-actions button").map((b) => text(b))).not.toContain("Statuses");
    await mount({ agend_tasks_project: "" });
    expect(qa(".tb-head-actions button").map((b) => text(b))).not.toContain("Default statuses");
    (globalThis as any).document.body.dataset.tier = "";
    (globalThis as any).document.body.dataset.publicLink = "1";
    await mount();
    expect(qa(".tb-head-actions button").map((b) => text(b))).not.toContain("Statuses");
    (globalThis as any).document.body.dataset.linkMedia = "1";                          // an admin session over the link writes as itself
    await mount();
    expect(qa(".tb-head-actions button").map((b) => text(b))).toContain("Statuses");
  });
});
