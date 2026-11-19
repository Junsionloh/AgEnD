/**
 * AGEND-316: the board's cards (Fleet › Tasks), after AGEND-317's layout A and the user's four points:
 *  - wider, and as tall as the content: the columns are 272–360 px however many there are (more than fit scroll), the board
 *    page is not held to 1240 px; a title takes two lines and the status one at most (the whole text is the tooltip); the
 *    status line says ONE thing, by priority (stuck → waits for the person → running → next → the sub tasks' progress);
 *  - a card whose agent is running says so with the "Running" mark (the moving light of the first version is gone: the user found
 *    it repeated the mark); it stops with the run;
 *  - no coloured bar on the left edge, in any status;
 *  - the assignee's avatar is a button: the card page's picker (the card does not open), a choice saves with the version
 *    the card was drawn at, a conflict says so; Esc closes it, the focus returns; an info card on hover and on the
 *    keyboard's focus; the list's rows have it too; over a read-only link, and on a finished card, it is not a button;
 *  - the info card names nothing the viewer does not see;
 *  - the card page's activity (heading, filter, timeline) and its comment box are ONE panel — the app's plain .card, set apart
 *    from the sub tasks, the box at its foot; without a box (a read-only page) the panel holds the timeline alone.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

let p: AppPage;
let fleet: any, common: any, owner: any, app: any, nav: any, i18n: any, toastMod: any;
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
  acceptance: [] as Array<{ text: string; done: boolean }>, context: "", state: "", blockedReason: "", result: "done", sort: 1, createdBy: "Ann", version: 4, createdAt: ago(10), updatedAt: ago(1), startedAt: null, submittedAt: null,
  doneAt: null, progress: { total: 0, open: 0, claimed: 0, blocked: 0, review: 0, done: 0 }, unmetDeps: [], commentCount: 0, newCommentCount: 0, lastComment: null, ...over });
const PROJECT = { id: 1, name: "Leaderboard", description: "", archived: false, sort: 1, createdAt: ago(30), leadInstance: "alpha" };
const LONG = "Rework the nightly leaderboard rebuild so that ties, late submissions and region merges are all handled in one pass";
const REASON = "Which scores count: ranked games only? Nobody on this side knows which week the new season starts";

let CARDS: any[] = [];
const build = () => {
  // M-1 runs (its sub task S-1 is alpha's one card in progress); M-2 has sub tasks to start; M-3 waits for the person; M-4 is blocked;
  // M-5 is done; M-6 has nobody; M-7 has an assignee and a dispatcher the viewer does not see; M-8 has a title of 100+ characters;
  // M-9 has sub tasks and nothing running (only their progress to say).
  const m1 = card({ id: "M-1", title: "Serve the weekly leaderboard", status: "claimed", assignee: "alpha", priority: "high", size: "M", sort: 1, progress: { total: 2, open: 1, claimed: 1, blocked: 0, review: 0, done: 0 },
    acceptance: [{ text: "Ties share a rank", done: true }, { text: "Under 300 ms", done: false }], commentCount: 2 });
  const s1 = card({ id: "S-1", kind: "sub", parentId: "M-1", title: "Build the score API", status: "claimed", assignee: "alpha", needsReview: false, sort: 1 });
  const s1b = card({ id: "S-9", kind: "sub", parentId: "M-1", title: "Write the tests", status: "open", assignee: "beta", needsReview: false, sort: 2 });
  const m2 = card({ id: "M-2", title: "Add the shop", status: "open", assignee: "beta", size: "L", sort: 2, progress: { total: 2, open: 2, claimed: 0, blocked: 0, review: 0, done: 0 } });
  const s2 = card({ id: "S-2", kind: "sub", parentId: "M-2", title: "Price list", status: "open", assignee: "gamma", needsReview: false, sort: 1 });
  const s3 = card({ id: "S-3", kind: "sub", parentId: "M-2", title: "Checkout", status: "open", assignee: "gamma", needsReview: false, sort: 2 });
  const m3 = card({ id: "M-3", title: "Pick the badges", status: "review", assignee: "beta", waitsForPerson: true, priority: "urgent", sort: 3 });
  const m4 = card({ id: "M-4", title: "Adjust the anti-cheat rules", status: "blocked", assignee: "gamma", blockedReason: REASON, sort: 4 });
  const m5 = card({ id: "M-5", title: "Build the score store", status: "done", assignee: "alpha", doneAt: ago(1), sort: 5 });
  const m6 = card({ id: "M-6", title: "Nothing but a title", status: "open", assignee: null, sort: 6 });
  const m7 = card({ id: "M-7", title: "Old work", status: "open", assignee: "ghost", dispatcher: { kind: "instance", name: "hidden-bot" }, sort: 7 });
  const m8 = card({ id: "M-8", title: LONG, status: "open", assignee: "beta", sort: 8 });
  const m9 = card({ id: "M-9", title: "Both halves wait", status: "open", assignee: "gamma", sort: 9, progress: { total: 1, open: 0, claimed: 0, blocked: 0, review: 0, done: 1 } });
  const s9 = card({ id: "S-10", kind: "sub", parentId: "M-9", title: "One half", status: "done", assignee: "gamma", needsReview: false, sort: 1, doneAt: ago(1) });
  return [m1, s1, s1b, m2, s2, s3, m3, m4, m5, m6, m7, m8, m9, s9];
};
const STORE = (alpha: string) => [["alpha", alpha], ["beta", "idle"], ["gamma", "idle"]].map(([name, exec]) => ({ name, status: "running", state: exec, execution_state: exec }));

beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet", storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fetchFake;
  app = await import("/assets/app-store.js");
  nav = await import("/assets/app-nav.js");
  i18n = await import("/assets/app-i18n.js");
  toastMod = await import("/assets/ui-toast.js");
  fleet = await import("/ui/js/panel-fleet.js");
  common = await import("/ui/js/fleet-task-common.js");
  owner = await import("/ui/js/fleet-task-owner.js");
  nav.startRouter(p.window);
});
afterAll(() => { p.restore(); delete (globalThis as any).fetch; });

const body = () => (globalThis as any).document.body;
beforeEach(async () => {
  await p.unmount();
  i18n.setLang("en", { store: false });
  const ls = (globalThis as any).localStorage;
  for (const k of ["agend_tasks_project", "agend_tasks_display", "agend_tasks_filters", "agend_tasks_assignee", "agend_tasks_query", "agend_tasks_collapsed"]) ls.removeItem(k);
  for (const k of ["publicLink", "linkMedia", "tier"]) delete body().dataset[k];
  (globalThis as any).history.replaceState(null, "", "/ui/fleet");
  (globalThis as any).history.entries.length = 1;
  (globalThis as any).history.states.length = 1;
  (globalThis as any).history.at = 0;
  calls.length = 0;
  CARDS = build();
  owner.quietInfo(-1);                    // the moment after a picker closes belongs to the test that closed it
  handler = (path, method) => {
    if (path.startsWith("/ui/tasks/board")) return { rev: 1, projects: [PROJECT], cards: CARDS, boardOff: [] };
    const m = /^\/ui\/tasks\/cards\/([^/]+)(\/move)?$/.exec(path);
    if (m && method === "POST") return { card: CARDS.find((x) => x.id === decodeURIComponent(m[1]!)), notes: [] };
    if (m) { const c = CARDS.find((x) => x.id === decodeURIComponent(m[1]!)) ?? CARDS[0]; return { card: c, parent: null, children: [], comments: [], logs: [], history: [], watchers: [], inheritedWatchers: [], leader: null, followsProgress: true }; }
    return {};
  };
  app.applyStatus({ uptime: 1, instances: STORE("working") });
});

let mounts = 0;
async function mount(display: Record<string, unknown> | null = null) {
  await p.unmount();
  (globalThis as any).history.replaceState(null, "", "/ui/fleet");
  (globalThis as any).localStorage.setItem("agend_tasks_project", "1");
  if (display) (globalThis as any).localStorage.setItem("agend_tasks_display", JSON.stringify(display));
  await p.mount(h("div", {}, h(fleet.FleetPanel, { route: { panel: "fleet", tab: "tasks" }, navKey: `fleet:tasks|l316-${++mounts}|en` }), h(toastMod.Toasts, {})));
  await settle(8);
}
const q = (sel: string) => p.root.querySelector(sel);
const qa = (sel: string) => [...p.root.querySelectorAll(sel)] as any[];
const text = (el: any): string => (el ? el.childNodes.map((n: any) => (n.nodeType === 3 ? n.textContent : text(n)) ?? "").map((s: string) => s.replace(/\s+/g, " ").trim()).filter(Boolean).join(" ") : "");
const doc = () => (globalThis as any).document;
const tile = (id: string) => q(`[data-tile="${id}"]`);
const posts = () => calls.filter((c) => c.method === "POST");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
// The harness's elements name `on<event>` props they know; Preact falls back to the prop's own casing for the others.
const enter = (el: any) => { fire(el, "mouseenter"); fire(el, "MouseEnter"); };
const leave = (el: any) => { fire(el, "mouseleave"); fire(el, "MouseLeave"); };
const UI = join(process.cwd(), "src", "ui");
const CSS = readFileSync(join(UI, "shared", "app.css"), "utf8") + "\n" + readFileSync(join(UI, "shared", "task-board.css"), "utf8");
const rule = (sel: string) => { const i = CSS.indexOf(`\n${sel} {`); return i < 0 ? null : CSS.slice(i + 1, CSS.indexOf("}", i) + 1); };

describe("the status line says one thing, by priority", () => {
  const sub = (status: string, over: Record<string, unknown> = {}) => card({ id: "S-1", kind: "sub", status, ...over });
  const work = (status: string, label: string, tone: string) => ({ label, tone, cards: [sub(status)] });
  it("stuck → waits for the person → running → next → the sub tasks' progress; nothing: none", () => {
    const c = (over: Record<string, unknown>) => card({ status: "claimed", ...over });
    const all = { now: work("claimed", "tasks.nowDoing", "claimed"), run: { instance: "alpha", state: "working", shared: 0 }, hasSubs: true };
    // A blocked card with a reason says it, whatever else it could say.
    expect(common.tileStatus(c({ status: "blocked", blockedReason: "why?" }), all)).toMatchObject({ kind: "blocked", reason: "why?" });
    // A main task blocked by a sub task, with no reason of its own, names that sub task.
    expect(common.tileStatus(c({ status: "claimed" }), { now: work("blocked", "tasks.nowBlocked", "blocked"), run: all.run, hasSubs: true })).toMatchObject({ kind: "blocked", reason: "" });
    expect(common.tileStatus(c({ status: "review", waitsForPerson: true }), all)).toMatchObject({ kind: "review", you: true });
    expect(common.tileStatus(c({ status: "review", confirmer: "alpha" }), all)).toMatchObject({ kind: "review", you: false, label: "Waiting for alpha" });
    expect(common.tileStatus(c({}), all)).toMatchObject({ kind: "running", run: { state: "working" } });
    expect(common.tileStatus(c({}), { now: all.now, hasSubs: true })).toMatchObject({ kind: "running", run: null });
    expect(common.tileStatus(c({}), { run: { instance: "alpha", state: "needs", shared: 0 } })).toMatchObject({ kind: "running" });
    expect(common.tileStatus(c({}), { run: { instance: "alpha", state: "idle", shared: 0 } }), "an idle agent says nothing").toBeNull();
    expect(common.tileStatus(c({ status: "open" }), { now: work("open", "tasks.nowNext", "open"), hasSubs: true })).toMatchObject({ kind: "next" });
    expect(common.tileStatus(c({ status: "open" }), { hasSubs: true })).toEqual({ kind: "progress" });
    expect(common.tileStatus(c({ status: "open" }), {})).toBeNull();
  });

  it("on the board: each tile has at most one status element, the kind in its class; a card with nothing to say has no row", async () => {
    await mount();
    const kind = (id: string) => (tile(id).querySelector(".tb-tile-status")?.className.match(/k-(\w+)/) ?? [])[1] ?? null;
    expect(["M-1", "M-2", "M-3", "M-4", "M-6", "M-9"].map(kind)).toEqual(["running", "next", "review", "blocked", null, "progress"]);
    for (const t of qa(".tb-tile")) expect(t.querySelectorAll(".tb-tile-status").length, t.getAttribute("data-tile")).toBeLessThanOrEqual(1);
    expect(tile("M-6").querySelector(".tb-tile-status"), "no row for nothing").toBeNull();
    expect(text(tile("M-3").querySelector(".tb-tile-waits"))).toBe("Waiting for you");
    expect(text(tile("M-1").querySelector(".tb-tile-run"))).toContain("Running");
    expect(text(tile("M-1").querySelector(".tb-tile-now"))).toBe("S-1 Build the score API");
    expect(text(tile("M-2").querySelector(".tb-tile-now"))).toBe("Next S-2 Price list +1");
    expect(tile("M-9").querySelector(".tb-tile-progress"), "the progress is the line, with the sub tasks' toggle in it").toBeTruthy();
  });

  it("the whole text of a cut line is its tooltip; a blocked reason is one line (cut) with its text in the title", async () => {
    await mount();
    const note = tile("M-4").querySelector(".tb-tile-note");
    expect(note.getAttribute("title")).toBe(REASON);
    expect(text(note)).toBe(REASON);
    expect(rule(".tb-tile-note > span")).toMatch(/white-space: nowrap/);
    expect(rule(".tb-tile-note > span")).toMatch(/text-overflow: ellipsis/);
    expect(rule(".tb-tile-status")).toMatch(/overflow: hidden/);
    expect(rule(".tb-tile-note.st-blocked")).toMatch(/color: var\(--danger\)/);
    expect(rule(".tb-tile-waits")).toMatch(/color: var\(--warn\)/);
  });

  it("a status that is not the progress leaves the sub tasks' count in the foot, opening the list; a blocked sub task shows there", async () => {
    await mount();
    const toggle = tile("M-1").querySelector(".tb-tile-foot .tb-tile-subs");
    expect(text(toggle)).toBe("0 / 2");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fire(toggle, "click"); await settle(4);
    expect(tile("M-1").querySelector(".tb-subs")).toBeTruthy();
    expect(qa(".tp").length, "it did not open the card").toBe(0);
    expect(tile("M-9").querySelector(".tb-tile-foot .tb-tile-subs"), "the progress line is the toggle: not twice").toBeNull();
    CARDS[0].progress = { total: 2, open: 0, claimed: 1, blocked: 1, review: 0, done: 0 };
    await mount();
    expect(tile("M-1").querySelector(".tb-tile-subs").className).toContain("has-blocked");
  });

  it("the title is cut at two lines in CSS, and its whole text (with the drag hint) is the tooltip", async () => {
    await mount();
    const t = tile("M-8").querySelector(".tb-tile-title");
    expect(t.getAttribute("title")).toContain(LONG);
    expect(text(t.querySelector("span"))).toBe(LONG);
    expect(rule(".tb-tile-title > span")).toMatch(/-webkit-line-clamp: 2/);
    expect(rule(".tb-tile-title > span")).toMatch(/line-clamp: 2/);
    expect(rule(".tb-tile-title > span")).toMatch(/overflow: hidden/);
  });
});

describe("wider, and as tall as the content", () => {
  it("a column is 272–360 px however many there are; more than fit scroll; the phone stays one column", () => {
    const cols = rule(".tb-columns")!;
    expect(cols).toMatch(/grid-auto-flow: column/);
    expect(cols).toMatch(/grid-auto-columns: minmax\(272px, 360px\)/);
    expect(cols, "no fixed number of columns").not.toMatch(/repeat\(\d/);
    expect(cols).toMatch(/min-width: min-content/);
    const phone = CSS.slice(CSS.indexOf("@media (max-width: 899px), (pointer: coarse)", CSS.indexOf(".tb-columns {")));
    expect(phone).toMatch(/\.tb-columns \{ grid-auto-flow: row; grid-auto-columns: auto; grid-template-columns: minmax\(0, 1fr\)/);
    expect(CSS).not.toMatch(/\.tb-columns\.no-done/);
  });
  it("a project's page — the board and the list alike — is not held to 1240 px; Home keeps the Fleet page's width", async () => {
    expect(rule(".col.col-wide")).toMatch(/max-width: 1240px/);
    expect(rule(".col.col-wide:has(> .tb > .tb-board-page)")).toMatch(/max-width: none/);
    expect(CSS, "no rule is left that frees the board alone").not.toMatch(/is-board/);
    await mount();
    expect(q(".tb-board-page"), "the board").toBeTruthy();
    expect(q(".tb-board-page").className).toBe("tb-board-page");
    await mount({ view: "list" });
    expect(q(".tb-board-page .tb-list"), "the list is on the same page, so it has the same width").toBeTruthy();
    expect(q(".tb-board-page").className).toBe("tb-board-page");
    // Home (the projects) is not a board page: its rule is the Fleet page's.
    await p.unmount();
    (globalThis as any).localStorage.removeItem("agend_tasks_project");
    (globalThis as any).history.replaceState(null, "", "/ui/fleet");            // a project's board writes `?tp=` into the address
    await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "tasks" }, navKey: `fleet:tasks|l316-home-${++mounts}|en` }));
    await settle(8);
    expect(q(".tb-home")).toBeTruthy();
    expect(q(".tb-board-page")).toBeNull();
  });
  it("the list's columns: the title takes what is left, every other column keeps its width (head and rows alike)", () => {
    expect(rule(".tb-row-text")).toMatch(/flex: 1/);
    expect(rule(".tb-lh-title")).toMatch(/flex: 1/);
    for (const [sel, width] of [[".tb-lh-prio", "84px"], [".tb-lh-who", "140px"], [".tb-lh-time", "7em"], [".tb-lh-code", "4.5em"], [".tb-row-prio", "84px"], [".tb-row-who", "140px"], [".tb-row-time", "7em"], [".tb-row-code", "4.5em"]] as const) {
      expect(rule(sel), sel).toContain(`width: ${width}`);
      expect(rule(sel), sel).not.toMatch(/(^|[ ;{])flex: [1-9]/);
    }
  });
  it("no fixed height anywhere on a tile: it follows its content", () => {
    for (const sel of [".tb-tile", ".tb-tile-top", ".tb-tile-title", ".tb-tile-status", ".tb-tile-foot"]) {
      const r = rule(sel);
      expect(r, sel).toBeTruthy();
      expect(r, sel).not.toMatch(/(^|[ ;{])height:/);
    }
  });
  it("a tile's columns count is the statuses shown, not five", async () => {
    await mount({ view: "board", group: "status", order: "manual", dir: "asc", done: "hide", subs: false });
    expect(qa(".tb-col").length).toBe(4);
    expect(q(".tb-columns").className).toBe("tb-columns");
  });
});

describe("no coloured bar on the left edge", () => {
  it("the shared bar's lists do not have the tile; the tile sets no bar colour in any status", () => {
    const lists = [...CSS.matchAll(/^\.lbar, [^{]*\{/gm)].map((m) => m[0]).join("\n") + [...CSS.matchAll(/^\.lbar::before, [^{]*\{/gm)].map((m) => m[0]).join("\n");
    expect(lists).toContain(".reply-bar");
    expect(lists, "the tile is not one of its places").not.toMatch(/\.tb-tile\b/);
    expect(CSS).not.toMatch(/\.tb-tile[.\w-]*\s*\{[^}]*--lbar-color/);
    expect(rule(".tb-tile")).not.toMatch(/--lbar-color/);
    expect(rule(".tb-tile")).toMatch(/padding: var\(--s-3\);/);
  });
  it("a tile of every status is drawn without a bar element or class", async () => {
    await mount();
    for (const t of qa(".tb-tile")) {
      expect(t.className, t.getAttribute("data-tile")).not.toMatch(/lbar|bar/);
      expect(t.querySelector(".lbar")).toBeNull();
    }
    expect(qa(".tb-tile").map((t) => t.className.match(/st-(\w+)/)![1]).sort()).toEqual(expect.arrayContaining(["claimed", "open", "review", "blocked", "done"]));
  });
});

describe("a card whose agent is running says so once, with the \"Running\" mark (no moving light)", () => {
  it("the running card has the mark in its status line and its `running` class; others have neither; no light layer", async () => {
    await mount();
    expect(tile("M-1").className).toContain(" running");
    expect(text(tile("M-1").querySelector(".tb-tile-run .tr-mark"))).toBe("Running");
    for (const id of ["M-2", "M-3", "M-4", "M-5", "M-6", "M-9"]) { expect(tile(id).className, id).not.toContain("running"); expect(tile(id).querySelector(".tr-mark"), id).toBeNull(); }
    for (const t of qa(".tb-tile")) expect(t.querySelector(".tb-tile-shine"), t.getAttribute("data-tile")).toBeNull();
    expect(tile("M-1").getAttribute("style"), "no style attribute (the CSP)").toBeNull();
  });
  it("it stops when the run does: the agent idle → no class, no mark; working again → back", async () => {
    await mount();
    app.applyStatus({ uptime: 2, instances: STORE("idle") }); await settle(6);
    expect(tile("M-1").className).not.toContain("running");
    expect(tile("M-1").querySelector(".tr-mark")).toBeNull();
    app.applyStatus({ uptime: 3, instances: STORE("working") }); await settle(6);
    expect(tile("M-1").className).toContain(" running");
    expect(tile("M-1").querySelector(".tr-mark")).toBeTruthy();
  });
  it("an agent with two cards in progress runs none of them (which one it is on is not known)", async () => {
    CARDS.push(card({ id: "M-20", title: "Second", status: "claimed", assignee: "beta", sort: 20 }), card({ id: "M-21", title: "Third", status: "claimed", assignee: "beta", sort: 21 }));
    app.applyStatus({ uptime: 2, instances: STORE("working").map((i: any) => (i.name === "beta" ? { ...i, state: "working", execution_state: "working" } : i)) });
    await mount();
    expect(tile("M-20").className).not.toContain("running");
    expect(tile("M-21").className).not.toContain("running");
  });
  it("the CSS has no light: no layer, no keyframes, no animation on a tile; the original running tile (edge, tint) stays", () => {
    expect(CSS).not.toMatch(/tb-tile-shine|tb-shine|tb-breathe/);
    expect(CSS, "nothing on a tile animates but its flash when a card changes").not.toMatch(/\.tb-tile[^{]*\{[^}]*animation: (?!tb-flash|none)/);
    expect(rule(".tb-tile.running")).toMatch(/border-color: var\(--accent\)/);
    expect(rule(".tb-tile.running")).toMatch(/background: color-mix\(in srgb, var\(--accent\) 6%, var\(--bg\)\)/);
    expect(rule(".tb-row.running")).toBeTruthy();
  });
});

describe("the avatar is the card page's assignee picker", () => {
  const chip = (id: string) => tile(id).querySelector(".tb-owner-btn");
  const picker = () => q(".tb-card-menu");
  const items = () => qa(".tb-card-menu button[role^=menuitem]").map((b) => `${b.getAttribute("aria-checked") === "true" ? "✓ " : ""}${text(b)}`);
  it("a button with a name that says what it does; a finished card's assignee is plain; nobody is a button too", async () => {
    await mount();
    expect(chip("M-1").tagName).toBe("BUTTON");
    expect(chip("M-1").getAttribute("aria-label")).toBe("alpha: change assignee");
    expect(chip("M-1").getAttribute("aria-haspopup")).toBe("menu");
    expect(chip("M-1").getAttribute("title"), "no tooltip of its own: the info card says more").toBeNull();
    expect(text(chip("M-1"))).toContain("alpha");
    expect(chip("M-6").tagName).toBe("BUTTON");
    expect(chip("M-6").getAttribute("aria-label")).toBe("Assign");
    expect(text(chip("M-6"))).toBe("Unassigned");
    expect(chip("M-5").tagName, "done: not changed").toBe("SPAN");
    expect(chip("M-5").className).toContain("is-static");
  });
  it("a click opens the picker the page has (nobody, each instance, Other…; this one ticked) and does not open the card", async () => {
    await mount();
    fire(chip("M-2"), "click"); await settle(4);
    expect(picker().getAttribute("role")).toBe("menu");
    expect(picker().getAttribute("aria-label")).toBe("beta: change assignee");
    expect(items()).toEqual(["Unassigned", "alpha", "✓ beta", "gamma", "Other…"]);
    expect(qa(".tp").length, "the card stayed shut").toBe(0);
    expect(calls.filter((c) => /\/ui\/tasks\/cards\/M-2$/.test(c.path) && c.method === "GET")).toEqual([]);
  });
  it("a choice saves with the version the card was drawn at, closes the picker and gives the focus back; the card stays shut", async () => {
    await mount();
    fire(chip("M-2"), "click"); await settle(4);
    fire(qa(".tb-card-menu [role=menuitemradio]").find((b) => text(b) === "gamma"), "click"); await settle(10);
    expect(posts().map((c) => [c.path, c.body])).toEqual([["/ui/tasks/cards/M-2", { assignee: "gamma", version: 4 }]]);
    expect(picker()).toBeNull();
    expect(doc().activeElement.className).toContain("tb-owner-btn");
    expect(qa(".tp").length).toBe(0);
    expect(calls.filter((c) => c.path.startsWith("/ui/tasks/board")).length, "the board is read again").toBeGreaterThanOrEqual(2);
  });
  it("Unassigned sends null", async () => {
    await mount();
    fire(chip("M-2"), "click"); await settle(4);
    fire(qa(".tb-card-menu [role=menuitemradio]").find((b) => text(b) === "Unassigned"), "click"); await settle(10);
    expect(posts().map((c) => c.body)).toEqual([{ assignee: null, version: 4 }]);
  });
  it("Esc closes it without sending, and the avatar has the focus back", async () => {
    await mount();
    fire(chip("M-2"), "click"); await settle(4);
    fire(picker(), "keydown", { key: "Escape", cancelable: true }); await settle(4);
    expect(picker()).toBeNull();
    expect(posts()).toEqual([]);
    expect(doc().activeElement.className).toContain("tb-owner-btn");
  });
  it("a card changed since (409) says so and the board is read again; nothing else is sent", async () => {
    handler = (path, method) => {
      if (path.startsWith("/ui/tasks/board")) return { rev: 1, projects: [PROJECT], cards: CARDS, boardOff: [] };
      if (method === "POST") return { __status: 409, error: "changed", key: "conflict", args: ["M-2", "alpha"] };
      return {};
    };
    await mount();
    const reads = () => calls.filter((c) => c.path.startsWith("/ui/tasks/board")).length;
    const before = reads();
    fire(chip("M-2"), "click"); await settle(4);
    fire(qa(".tb-card-menu [role=menuitemradio]").find((b) => text(b) === "gamma"), "click"); await settle(10);
    expect(posts().length).toBe(1);
    expect(text(q(".toasts"))).toContain("M-2 changed while you were choosing. The board is up to date: choose again.");
    expect(reads()).toBeGreaterThan(before);
  });
  it("an error says what the host said", async () => {
    handler = (path, method) => {
      if (path.startsWith("/ui/tasks/board")) return { rev: 1, projects: [PROJECT], cards: CARDS, boardOff: [] };
      if (method === "POST") return { __status: 400, error: "No such instance" };
      return {};
    };
    await mount();
    fire(chip("M-2"), "click"); await settle(4);
    fire(qa(".tb-card-menu [role=menuitemradio]").find((b) => text(b) === "gamma"), "click"); await settle(10);
    expect(text(q(".toasts"))).toContain("No such instance");
  });
  it("Other… asks for a name, and sends it", async () => {
    await mount();
    fire(chip("M-2"), "click"); await settle(4);
    fire(qa(".tb-card-menu [role=menuitem]").find((b) => text(b) === "Other…"), "click"); await settle(8);
    const box = q("dialog input, dialog textarea");
    expect(box, "the question").toBeTruthy();
    box.value = "delta"; fire(box, "input"); await settle(4);
    fire(q("dialog .btn-primary"), "click"); await settle(12);
    expect(posts().map((c) => c.body)).toEqual([{ assignee: "delta", version: 4 }]);
  });
  it("the tile's own menu (⋯) assigns through the same write, with the same conflict words", async () => {
    handler = (path, method) => {
      if (path.startsWith("/ui/tasks/board")) return { rev: 1, projects: [PROJECT], cards: CARDS, boardOff: [] };
      if (method === "POST") return { __status: 409, error: "changed", key: "conflict", args: ["M-2", "alpha"] };
      return {};
    };
    await mount();
    fire(tile("M-2").querySelector(".tb-tile-more"), "click"); await settle(6);
    fire(qa(".tb-card-menu [role=menuitemradio]").find((b) => text(b) === "gamma"), "click"); await settle(10);
    expect(posts().map((c) => c.body)).toEqual([{ assignee: "gamma", version: 4 }]);
    expect(text(q(".toasts"))).toContain("changed while you were choosing");
  });
  it("the picker is the page's: the same items for the same card", async () => {
    const card = await import("/ui/js/fleet-task-card.js") as any;
    await mount();
    fire(chip("M-2"), "click"); await settle(4);
    const page = card.assigneeItems(CARDS.find((c: any) => c.id === "M-2"), ["alpha", "beta", "gamma"], [], () => {}).map((i: any) => `${i.checked ? "✓ " : ""}${i.label}`);
    expect(items().concat([]).map((s) => s.replace(/^✓ /, "✓ ")), "the radio items, then Other…").toEqual(page);
  });
  it("the list's rows have the same avatar and picker", async () => {
    await mount({ view: "list", group: "status", order: "manual", dir: "asc", done: "recent", subs: false });
    const row = (id: string) => q(`[data-row="${id}"] .tb-row-who .tb-owner-btn`);
    expect(row("M-2").tagName).toBe("BUTTON");
    expect(row("M-5").tagName, "a finished card's: plain").toBe("SPAN");
    fire(row("M-2"), "click"); await settle(4);
    expect(items()).toEqual(["Unassigned", "alpha", "✓ beta", "gamma", "Other…"]);
    expect(qa(".tp").length, "the row did not open its card").toBe(0);
    fire(qa(".tb-card-menu [role=menuitemradio]").find((b) => text(b) === "alpha"), "click"); await settle(10);
    expect(posts().map((c) => [c.path, c.body])).toEqual([["/ui/tasks/cards/M-2", { assignee: "alpha", version: 4 }]]);
  });
  it("a main task whose sub tasks are someone else's: its owner is the avatar, the sub tasks' people follow it", async () => {
    await mount();
    expect(text(tile("M-2").querySelector(".tb-tile-foot .tb-owner"))).toContain("beta");
    expect(text(tile("M-2").querySelector(".tb-tile-foot .tb-people .tb-who"))).toBe("gamma");
    expect(tile("M-2").querySelector(".tb-tile-foot .tb-people").getAttribute("title")).toBe("Assigned to its sub tasks");
    expect(tile("M-9").querySelector(".tb-tile-foot .tb-people"), "no sub task to start or run: nobody follows").toBeNull();
  });
});

describe("over a read-only link, the avatar only shows", () => {
  const seen = async (set: Record<string, string>) => {
    for (const [k, v] of Object.entries(set)) body().dataset[k] = v;
    await mount();
  };
  it("a public link that is not an admin's: no button anywhere, a click picks nothing and opens only the card", async () => {
    await seen({ publicLink: "1" });
    expect(qa("button.tb-owner-btn").length).toBe(0);
    expect(qa(".tb-owner-btn.is-static").length).toBeGreaterThan(5);
    fire(tile("M-2").querySelector(".tb-owner-btn"), "click"); await settle(8);
    expect(q(".tb-card-menu")).toBeNull();
    expect(posts()).toEqual([]);
    expect(q(".tp"), "the avatar is part of the tile: the card opens").toBeTruthy();
  });
  it("a guest: the same; the list's rows too", async () => {
    await seen({ tier: "guest" });
    expect(qa("button.tb-owner-btn").length).toBe(0);
    await mount({ view: "list" });
    expect(qa("button.tb-owner-btn").length).toBe(0);
    expect(qa(".tb-row-who .tb-owner-btn.is-static").length).toBeGreaterThan(5);
  });
  it("an admin session over the link writes as itself (M-3278): the buttons are there", async () => {
    await seen({ publicLink: "1", linkMedia: "1" });
    expect(tile("M-2").querySelector(".tb-owner-btn").tagName).toBe("BUTTON");
  });
  it("the viewer's kind, in the one place that says it", () => {
    body().dataset.publicLink = "1"; expect(common.boardReadOnly()).toBe(true);
    body().dataset.linkMedia = "1"; expect(common.boardReadOnly()).toBe(false);
    delete body().dataset.publicLink; delete body().dataset.linkMedia; expect(common.boardReadOnly()).toBe(false);
    body().dataset.tier = "guest"; expect(common.boardReadOnly()).toBe(true);
  });
  it("the info card still shows (it only reads): read-only is not blind", async () => {
    await seen({ publicLink: "1" });
    const el = tile("M-1").querySelector(".tb-owner-btn");
    expect(el.getAttribute("tabindex")).toBe("0");
    enter(el); await wait(300); await settle(2);
    expect(q(".tb-owner-card")).toBeTruthy();
  });
});

describe("the info card", () => {
  const chip = (id: string) => tile(id).querySelector(".tb-owner-btn");
  const card = () => q(".tb-owner-card");
  const rows = () => {
    const kids = (q(".toc-rows")?.childNodes ?? []).filter((n: any) => n.nodeType === 1);
    return Object.fromEntries(kids.filter((n: any) => n.tagName === "DT").map((dt: any) => [text(dt), text(kids[kids.indexOf(dt) + 1])]));
  };
  it("pointing at the avatar shows it after a short pause: who, state, what it is doing, how many cards, the page's two facts", async () => {
    await mount();
    enter(chip("M-1"));
    await settle(2);
    expect(card(), "not at once").toBeNull();
    await wait(300); await settle(2);
    expect(text(q(".toc-head"))).toContain("alpha");
    expect(text(q(".toc-head .tr-mark"))).toBe("Running");
    expect(rows()).toEqual({ Now: "Working on S-1 Build the score API", Cards: "1 open · 1 in progress", Role: "Project lead", "Dispatched by": "Ann" });
    expect(card().getAttribute("role")).toBe("tooltip");
    expect(chip("M-1").getAttribute("aria-describedby")).toBe(card().getAttribute("id"));
    expect(q(".tb-owner-pop").getAttribute("style") ?? "", "placed through the CSSOM, never an attribute in the markup").toMatch(/^(left: [\d.]+px; top: [\d.]+px;)?$/);
  });
  it("leaving, a click, Esc and a scroll hide it; a quick pass shows nothing", async () => {
    await mount();
    enter(chip("M-1")); leave(chip("M-1")); await wait(300); await settle(2);
    expect(card(), "a quick pass").toBeNull();
    enter(chip("M-1")); await wait(300); await settle(2);
    expect(card()).toBeTruthy();
    leave(chip("M-1")); await settle(2);
    expect(card(), "leaving").toBeNull();
    enter(chip("M-1")); await wait(300); await settle(2);
    fire(chip("M-1"), "keydown", { key: "Escape" }); await settle(2);
    expect(card(), "Esc").toBeNull();
    leave(chip("M-1")); enter(chip("M-1")); await wait(300); await settle(2);
    fire(chip("M-1"), "click"); await settle(4);
    expect(card(), "a click (which opens the picker)").toBeNull();
    expect(q(".tb-card-menu")).toBeTruthy();
  });
  it("the keyboard's focus shows it at once; blur hides it; one card at a time", async () => {
    await mount();
    fire(chip("M-1"), "focus"); await settle(2);
    expect(card(), "at once").toBeTruthy();
    enter(chip("M-3")); await wait(300); await settle(2);
    expect(qa(".tb-owner-card").length, "pointing at a second one hides the first").toBe(1);
    expect(text(q(".toc-head"))).toContain("beta");
    fire(chip("M-1"), "blur"); leave(chip("M-3")); await settle(2);
    expect(qa(".tb-owner-card").length).toBe(0);
  });
  it("the focus coming back from the picker it opened does not show it", async () => {
    await mount();
    fire(chip("M-2"), "click"); await settle(4);
    fire(q(".tb-card-menu"), "keydown", { key: "Escape", cancelable: true }); await settle(4);
    fire(chip("M-2"), "focus"); await settle(2);
    expect(card()).toBeNull();
    await wait(600);
    fire(chip("M-2"), "blur"); fire(chip("M-2"), "focus"); await settle(2);
    expect(card(), "a keyboard's focus later does").toBeTruthy();
  });
  it("what it says is from the board the viewer was sent and the instances they see", async () => {
    const facts = owner.ownerFacts("alpha", CARDS[0], CARDS, "alpha");
    expect(facts).toMatchObject({ total: 1, by: { claimed: 1, open: 0, blocked: 0, review: 0 }, lead: true, dispatcher: { kind: "person", name: "Ann" } });
    expect(facts.doing.map((c: any) => c.id)).toEqual(["S-1"]);
    // A main task that follows its sub tasks is not work in itself; a finished card is not in hand.
    expect(owner.ownerFacts("alpha", CARDS[0], CARDS, null).total, "M-1 follows its sub tasks and M-5 is done").toBe(1);
    expect(owner.ownerFacts("gamma", CARDS[0], CARDS, "alpha")).toMatchObject({ lead: false, total: 3 });
    expect(owner.ownerFacts("nobody", CARDS[0], [], null)).toMatchObject({ total: 0, doing: [] });
  });
  it("an instance the viewer does not see: no state, no dispatcher name; a person's name stays", async () => {
    await mount();
    enter(chip("M-7")); await wait(300); await settle(2);
    const all = text(card());
    expect(card()).toBeTruthy();
    expect(all).toContain("ghost");
    expect(all, "no state is claimed for an instance not shown").not.toMatch(/Running|Idle|Offline|Needs you|Looks stuck/);
    expect(all, "the dispatcher is an instance kept out of sight: not named").not.toContain("hidden-bot");
    expect(rows()["Dispatched by"], "…and no row for it").toBeUndefined();
    expect(owner.visibleDispatcher({ kind: "instance", name: "hidden-bot" }, { instances: [{ name: "alpha" }] })).toBeNull();
    expect(owner.visibleDispatcher({ kind: "instance", name: "alpha" }, { instances: [{ name: "alpha" }] })).toBe("alpha");
    expect(owner.visibleDispatcher({ kind: "person", name: "Ann" }, { instances: [] })).toBe("Ann");
    expect(owner.visibleDispatcher(null, { instances: [] })).toBeNull();
  });
  it("the states in words: running, needs you, stuck, idle; any other state of an instance shown is offline", () => {
    const st = (exec: string, status = "running") => owner.ownerState("alpha", { instances: [{ name: "alpha", status, execution_state: exec }], exec: { alpha: exec } });
    expect(st("working")).toMatchObject({ state: "running", text: "Running" });
    expect(st("idle")).toMatchObject({ state: "idle", text: "Idle" });
    expect(st("stuck")).toMatchObject({ state: "stuck", text: "Looks stuck" });
    expect(st("idle", "stopped")).toMatchObject({ state: "offline", text: "Offline" });
    expect(st("idle", "crashed")).toMatchObject({ state: "offline" });
    expect(owner.ownerState("alpha", { instances: [] }), "not shown: nothing claimed").toBeNull();
  });
  it("the words are in both languages with the same {n}, and every call names one", () => {
    const strip = (src: string) => src.replace(/^import .*$/gm, "").replace(/^export /gm, "");
    const ctx = vm.createContext({ navigator: { language: "en" } });
    vm.runInContext(strip(readFileSync(join(UI, "shared", "app-i18n.js"), "utf8")), ctx);
    const src = readFileSync(join(UI, "fleet-task-owner.js"), "utf8");
    vm.runInContext(`(${/register\("taskowner", (\{[\s\S]*?\n\})\);/.exec(src)![0].replace(/;$/, "")})`, ctx);
    const tables = vm.runInContext("tables", ctx) as Record<"en" | "zh-TW", Record<string, string>>;
    const keys = (lang: "en" | "zh-TW") => Object.keys(tables[lang]).filter((k) => k.startsWith("taskowner."));
    expect(keys("en").sort()).toEqual(keys("zh-TW").sort());
    for (const k of keys("en")) expect((tables["zh-TW"][k]!.match(/\{\d\}/g) ?? []).join(), k).toBe((tables.en[k]!.match(/\{\d\}/g) ?? []).join());
    for (const file of ["fleet-task-owner.js", "fleet-tasks.js", "fleet-task-view.js"]) {
      for (const m of readFileSync(join(UI, file), "utf8").matchAll(/\bt\(\s*"(taskowner\.[\w.]+)"/g)) expect(tables.en[m[1]!], `${file}: ${m[1]}`).toBeDefined();
    }
    for (const s of ["claimed", "open", "blocked", "review"]) expect(tables.en[`taskowner.part_${s}`], s).toBeDefined();
  });
});


describe("the card page's activity is one panel", () => {
  const AT = "2026-11-02T10:00:00.000Z";
  const withActivity = () => {
    handler = (path, method) => {
      if (path.startsWith("/ui/tasks/board")) return { rev: 1, projects: [PROJECT], cards: CARDS, boardOff: [] };
      const m = /^\/ui\/tasks\/cards\/([^/]+)$/.exec(path);
      if (m && method === "GET") {
        const c = CARDS.find((x: any) => x.id === decodeURIComponent(m[1]!)) ?? CARDS[0];
        return { card: c, parent: null, children: CARDS.filter((x: any) => x.parentId === c.id), comments: [{ id: 1, author: "Ann", authorKind: "person", text: "Please **check** this", at: AT }],
          logs: [{ id: 2, author: "alpha", authorKind: "instance", text: "Endpoint done", at: AT }],
          history: [{ id: 3, type: "created", actor: "Ann", actorKind: "person", at: AT, data: {} }, { id: 4, type: "updated", actor: "Ann", actorKind: "person", at: AT, data: { changes: ["goal"] } }, { id: 5, type: "updated", actor: "Ann", actorKind: "person", at: AT, data: { changes: ["goal"] } }],
          watchers: [], inheritedWatchers: [], leader: null, followsProgress: true };
      }
      return { card: CARDS[0], notes: [] };
    };
  };
  const open = async (id: string) => { fire(tile(id).querySelector(".tb-tile-title"), "click"); await settle(12); };
  it("heading, filter, timeline and the comment box are in one .card that is not inside the sub tasks; the box is last", async () => {
    withActivity();
    await mount(); await open("M-1");
    const panel = q(".tp-activity");
    expect(panel.className).toBe("card tp-activity");
    expect(qa(".tp-grid > *").map((el) => el.className).at(-1)).toBe("card tp-activity");
    expect([...panel.childNodes].filter((n: any) => n.nodeType === 1).map((n: any) => n.className.split(" ")[0]), "the timeline, then the box").toEqual(["tl", "tc-composer"]);
    expect(text(panel.querySelector(".tl-bar h3"))).toBe("Activity");
    expect(qa(".tp-activity .tl-filter button").map((b) => text(b))).toEqual(["All", "Comments 1", "Progress 1", "History 2"]);
    expect(panel.querySelector(".tc-composer textarea")).toBeTruthy();
    expect(q(".tp-body").querySelector(".tp-activity"), "apart from the sub tasks and the spec").toBeNull();
    expect(q(".tp-subs") === null || !panel.contains(q(".tp-subs"))).toBe(true);
  });
  it("what it wraps behaves as before: the filter, equal history lines as ×N, Markdown in a comment", async () => {
    withActivity();
    await mount(); await open("M-1");
    expect(qa(".tp-activity .tl-list > li").length, "all: created, a change ×2 as one, the log, the comment").toBe(4);
    expect(text(q(".tp-activity .tl-list"))).toMatch(/× ?2/);
    expect(q(".tp-activity .tl-comment .tl-body.md strong"), "Markdown").toBeTruthy();
    fire(qa(".tp-activity .tl-filter button").find((b) => text(b).startsWith("Comments")), "click"); await settle(4);
    expect(qa(".tp-activity .tl-list > li").length).toBe(1);
    expect(q(".tp-activity .tl-comment")).toBeTruthy();
    expect(q(".tp-activity .tc-composer"), "the box stays under the filter's choice").toBeTruthy();
  });
  it("without a comment box (a read-only page) the panel holds the timeline alone", async () => {
    withActivity();
    await p.unmount();
    const card = await import("/ui/js/fleet-task-card.js") as any;
    await p.mount(h(card.CardPage, { id: "M-1", tick: 0, projects: [PROJECT], writable: false, back: "Back to the board", onBack() {}, onOpen() {}, onStep() {}, reloadBoard() {} }));
    await settle(12);
    const panel = q(".tp-activity");
    expect(panel.className).toBe("card tp-activity");
    expect([...panel.childNodes].filter((n: any) => n.nodeType === 1).map((n: any) => n.className.split(" ")[0])).toEqual(["tl"]);
    expect(q(".tc-composer")).toBeNull();
  });
  it("its look is Settings' card: the app's .card with a thin border, --r-md, padding alike on every side, no shadow, a sentence-case heading, a thin line above the box, tokens only", () => {
    const panel = rule(".tp-activity.card")!;
    expect(panel).toMatch(/--tp-panel-pad: var\(--s-5\)/);
    expect(panel).toMatch(/padding: var\(--tp-panel-pad\)/);
    expect(panel).toMatch(/margin: 0/);
    expect(rule(".tp-side.card, .tp-activity.card")).toMatch(/border: 1px solid var\(--border\)/);
    expect(rule(".tp-side.card, .tp-activity.card")).toMatch(/border-radius: var\(--r-md\)/);
    expect(rule(".tp-side.card, .tp-activity.card")).toMatch(/box-shadow: none/);
    expect(rule(".tl-bar > h3")).toMatch(/font-size: var\(--fs-lg\)/);
    expect(rule(".tl-bar > h3")).toMatch(/text-transform: none/);
    expect(rule(".tp-activity .tc-composer")).toMatch(/border-top: 1px solid var\(--border\)/);
    expect(rule(".tp-activity .tc-composer")).toMatch(/padding-top: var\(--s-3\)/);
    expect(rule(".tp-activity .tl-day > span")).toMatch(/background: var\(--surface\)/);
    for (const sel of [".tp-activity.card", ".tp-side.card, .tp-activity.card", ".tp-activity .tc-composer", ".tp-activity .tl-day > span", ".tl-bar > h3"]) expect(rule(sel), sel).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i);
    // The card is the .card of app.css (surface, radius, gap): the page does not draw its own.
    expect(rule(".card")).toMatch(/background: var\(--surface\)/);
    expect(rule(".card")).toMatch(/border-radius: var\(--r-md\)/);
  });
  it("the timeline's words still start on the page's value column: the first column gives back the padding; a phone's lines are unchanged", () => {
    expect(rule(".tl-line")).toMatch(/grid-template-columns: 1rem calc\(var\(--tp-label\) \+ var\(--tp-gap\) - 1rem - 2 \* var\(--s-2\) - var\(--tp-panel-pad, 0px\)\) minmax\(0, 1fr\) auto/);
    expect(CSS, "no override of a line from inside the panel (it would beat the phone's)").not.toMatch(/\.tp-activity[^{]*\.tl-line[^{]*\{/);
    expect(CSS).toMatch(/\n  \.tl-line \{ grid-template-columns: 1rem minmax\(0, 1fr\) auto; \}/);
  });
});

describe("in the list, the Running mark leads the title", () => {
  const LIST = { view: "list", group: "status", order: "manual", dir: "asc", done: "recent", subs: false };
  it("a running row has the mark first in its title cell, before the title button; it is no longer among the row's tags", async () => {
    await mount(LIST);
    const cell = q('[data-row="M-1"] .tb-row-text');
    const kids = [...cell.childNodes].filter((n: any) => n.nodeType === 1);
    expect(kids[0].className).toContain("tr-mark");
    expect(text(kids[0])).toBe("Running");
    expect(kids[1].className, "then the title").toContain("tb-row-title");
    expect(q('[data-row="M-1"] .tb-row-tags .tr-mark'), "not among the tags any more").toBeNull();
    expect(qa('[data-row="M-1"] .tr-mark').length, "once").toBe(1);
    expect(q('[data-row="M-2"] .tr-mark'), "a row that does not run has none").toBeNull();
    expect([...q('[data-row="M-2"] .tb-row-text').childNodes].filter((n: any) => n.nodeType === 1)[0].className).toContain("tb-row-title");
  });
  it("it follows the run: the agent idle → no mark; a sub task row of a running main task is the one that runs", async () => {
    await mount({ ...LIST, subs: true });
    expect(q('[data-row="S-1"] .tb-row-text .tr-mark'), "the sub task in progress").toBeTruthy();
    app.applyStatus({ uptime: 2, instances: STORE("idle") }); await settle(6);
    expect(qa(".tb-row .tr-mark").length).toBe(0);
  });
  it("the mark does not take the title's cell off its column: it is a flex item that does not shrink", () => {
    expect(rule(".tb-row-text")).toMatch(/flex: 1;/);
    expect(CSS).toMatch(/\.tb-row-text > \.tr-mark \{ flex: none;/);
  });
});


describe("Tasks is dressed as Settings is (one product)", () => {
  const LIST = { view: "list", group: "status", order: "manual", dir: "asc", done: "recent", subs: false };
  it("a project's page head is Settings' page head: its classes, a title with its badge, the description as the lead, the actions at the right", async () => {
    PROJECT.description = "Weekly and seasonal rankings";
    await mount();
    const head = q(".tb-bar-head");
    expect(head.className).toBe("tb-bar-head s-page-head");
    const kids = [...head.childNodes].filter((n: any) => n.nodeType === 1);
    expect(kids.map((n: any) => n.className.split(" ")[0]), "what it says, then what it offers").toEqual(["tb-head-main", "tb-head-actions"]);
    expect(q(".tb-head-main .tb-title.s-page-title h2")).toBeTruthy();
    expect(text(q(".tb-head-main .tb-title h2"))).toBe("Leaderboard");
    expect(text(q(".tb-head-main > p.s-page-lead"))).toBe("Weekly and seasonal rankings");
    expect(q(".tb-head-main .tb-stats"), "its numbers").toBeTruthy();
    expect(q(".tb-head-actions .btn-primary"), "the main action").toBeTruthy();
    // The first ghost button of the head is still the way back (tests, smokes and keyboards rely on it).
    expect(text(q(".tb-bar-head .btn-ghost"))).toBe("Projects");
    PROJECT.description = "";
  });
  it("an archived project says so as Settings badges a scope (.s-scope)", async () => {
    (PROJECT as any).archived = true;
    await mount();
    expect(text(q(".tb-title .s-scope"))).toBe("Archived");
    (PROJECT as any).archived = false;
  });
  it("Home has the same head: the title, then the search, Instances and New project", async () => {
    await p.unmount();
    (globalThis as any).localStorage.removeItem("agend_tasks_project");
    (globalThis as any).history.replaceState(null, "", "/ui/fleet");
    await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "tasks" }, navKey: `fleet:tasks|l316-head-${++mounts}|en` }));
    await settle(8);
    const head = q(".tb-head");
    expect(head.className).toBe("list-head tb-head s-page-head");
    expect(text(q(".tb-head .s-page-title h2"))).toBe("Projects");
    expect([...q(".tb-head .tb-head-actions").childNodes].filter((n: any) => n.nodeType === 1).length).toBeGreaterThanOrEqual(3);
    expect(q(".tb-head .btn-primary")).toBeTruthy();
  });
  it("the CSS takes Settings' values (tokens only): the 24px title from .s-page-head, the search field, the list container, the project tile", () => {
    expect(CSS).toMatch(/\.s-page-head h2 \{[^}]*font-size: 24px/);
    expect(rule(".tb-title h2"), "no size of its own: Settings' title").not.toMatch(/font-size/);
    expect(rule(".tb-search input")).toMatch(/background: var\(--surface\)/);
    expect(rule(".tb-search input")).toMatch(/border: 0/);
    expect(rule(".tb-search input")).toMatch(/border-radius: var\(--r-sm\)/);
    const list = rule(".tb-list")!;
    expect(list).toMatch(/border: 1px solid var\(--border\)/);
    expect(list).toMatch(/border-radius: var\(--r-md\)/);
    expect(list).toMatch(/background: var\(--surface\)/);
    expect(list).toMatch(/gap: 0/);
    expect(rule(".tb-group-head")).toMatch(/background: var\(--surface-2\)/);
    expect(rule(".tb-group-head")).toMatch(/border-radius: 0/);
    expect(rule(".tb-list-head")).toMatch(/background: var\(--surface-2\)/);
    expect(rule(".tb-project")).toMatch(/border-radius: var\(--r-md\)/);
    for (const sel of [".tb-list", ".tb-group-head", ".tb-list-head", ".tb-search input", ".tb-project", ".tb-head-main", ".tb-head-actions"]) expect(rule(sel), sel).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i);
  });
  it("the list is one container with its header and groups inside; rows and groups behave as before", async () => {
    await mount(LIST);
    const list = q(".tb-list");
    expect([...list.childNodes].filter((n: any) => n.nodeType === 1).map((n: any) => n.className.split(" ")[0])[0]).toBe("tb-list-head");
    expect(qa(".tb-list > .tb-group").length, "one per status").toBe(5);
    expect(qa(".tb-row").length).toBeGreaterThanOrEqual(8);
    fire(q(".tb-group-toggle"), "click"); await settle(4);
    expect(qa(".tb-list > .tb-group.shut").length, "a group still folds").toBe(1);
  });
});
