/**
 * AGEND-296: a card shows what its agent is doing.
 *  - the match is an inference — a card in progress, its assignee working — exact while the assignee has that one card in
 *    progress; with several in progress each says "busy, N cards" and none says "running"; nothing is stored or added to the API;
 *  - a board tile and a list row say "Running" (and a main task says it for a sub task of its own); the card's page has an
 *    "Agent activity" block: who, their state, the way to their conversation and, for an admin with tool progress on, the live steps;
 *  - the timeline marks what an agent did, and an entry from an older server (no kind) is shown as it was;
 *  - an instance the viewer cannot see, a card nobody has, a steps feed that is off, refused or missing: nothing breaks.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ClaudeStepParser, type LogStep } from "../src/log-steps.js";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

let p: AppPage;
let app: any, nav: any, fleet: any, run: any, activity: any, act: any;
const calls: Array<{ method: string; path: string; body: any }> = [];
type Reply = unknown | { __status: number; [k: string]: unknown };
let handler: (path: string, method: string, body: any) => Reply = () => ({});
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
const PROJECT = { id: 1, name: "Leaderboard", description: "", archived: false, sort: 1, createdAt: ago(30) };
const M1 = card({ id: "M-1", title: "Serve the weekly leaderboard", status: "claimed", assignee: "alpha", sort: 1, startedAt: "2026-11-02T09:00:00.000Z" });
const M2 = card({ id: "M-2", title: "Add the shop", status: "claimed", assignee: "beta", sort: 2, progress: { total: 2, open: 0, claimed: 1, blocked: 0, review: 0, done: 1 } });
const S1 = card({ id: "S-1", kind: "sub", parentId: "M-2", title: "Price list", status: "done", assignee: "alpha", sort: 1 });
const S2 = card({ id: "S-2", kind: "sub", parentId: "M-2", title: "Checkout", status: "claimed", assignee: "beta", sort: 2 });
const M3 = card({ id: "M-3", title: "Choose the badge", status: "open", assignee: "gamma", sort: 3 });
const M4 = card({ id: "M-4", title: "Bootstrap", status: "done", assignee: "alpha", sort: 4, doneAt: ago(1) });
const M5 = card({ id: "M-5", title: "Nobody has it", status: "open", sort: 5 });
let CARDS: any[] = [];

const T0 = Date.parse("2026-11-02T09:00:00.000Z");
const ENTRIES = {
  comments: [
    { id: 11, author: "Ann", authorKind: "person", kind: "comment", text: "Keep it under 300 ms.", at: "2026-11-02T10:00:00.000Z" },
    { id: 12, author: "alpha", authorKind: "instance", kind: "comment", text: "Understood.", at: "2026-11-02T12:00:00.000Z" },
  ],
  logs: [{ id: 21, author: "alpha", authorKind: "instance", text: "Endpoint skeleton done", at: "2026-11-02T11:00:00.000Z" }],
  history: [
    { id: 31, actor: "Ann", actorKind: "person", type: "created", data: {}, at: "2026-11-01T08:00:00.000Z" },
    { id: 32, actor: "alpha", actorKind: "instance", type: "moved", data: { from: "open", to: "claimed" }, at: "2026-11-02T09:00:00.000Z" },
    { id: 33, actor: "Ann", actorKind: "person", type: "moved", data: { from: "review", to: "claimed", reason: "Redo it." }, at: "2026-11-03T09:00:00.000Z" },
  ],
};
const detailOf = (id: string, over: Record<string, unknown> = {}) => {
  const c: any = CARDS.find((x: any) => x.id === id) ?? card({ id, title: `Card ${id}` });
  return { card: c, parent: c.parentId ? { id: "M-2", title: M2.title, status: "claimed" } : null, children: c.id === "M-2" ? [S1, S2] : [], ...ENTRIES, ...over };
};

/** Real steps, as the server reads them from a Claude transcript. */
const toolLine = (ms: number, name: string, input: Record<string, unknown>) => JSON.stringify({ type: "assistant", uuid: `a${ms}`, timestamp: new Date(ms).toISOString(),
  message: { role: "assistant", content: [{ type: "tool_use", id: `toolu_${ms}`, name, input }] } });
const stepsOf = (lines: string[]): LogStep[] => { const parser = new ClaudeStepParser({ thinking: false }); lines.forEach((l, i) => parser.push(l, i * 1000)); return parser.steps; };

beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet", storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fetchFake;
  app = await import("/assets/app-store.js");
  nav = await import("/assets/app-nav.js");
  fleet = await import("/ui/js/panel-fleet.js");
  run = await import("/ui/js/fleet-task-run.js");
  activity = await import("/ui/js/fleet-task-activity.js");
  act = await import("/ui/js/chat-activity.js");
  nav.startRouter(p.window);
});
afterAll(() => { p.restore(); delete (globalThis as any).fetch; });

/** The dashboard's view of the fleet: each instance's state (`working`, `idle`, `stuck`) and, for `awaiting_input`, what it waits on. */
const fleetIs = (states: Record<string, string>, extra: Record<string, unknown> = {}) => app.applyStatus({ uptime: 1, instances: Object.entries(states).map(([name, state]) =>
  state === "awaiting_input" ? { name, status: "running", state, execution_state: "working", interaction_summary: "a permission" } : { name, status: "running", state, execution_state: state, ...extra }) });
let steps: unknown = null;
beforeEach(async () => {
  await p.unmount();
  act.forgetActivity();
  const ls = (globalThis as any).localStorage;
  for (const k of ["agend_tasks_project", "agend_tasks_display", "agend_tasks_filters", "agend_tasks_assignee", "agend_tasks_query", "agend_tasks_collapsed"]) ls.removeItem(k);
  delete (globalThis as any).document.body.dataset.publicLink;
  delete (globalThis as any).document.body.dataset.chatActivity;
  (globalThis as any).history.replaceState(null, "", "/ui/fleet");
  (globalThis as any).history.entries.length = 1;
  (globalThis as any).history.states.length = 1;
  (globalThis as any).history.at = 0;
  calls.length = 0;
  steps = null;
  CARDS = [M1, M2, S1, S2, M3, M4, M5];
  handler = (path) => {
    if (path.startsWith("/ui/tasks/board")) return { rev: 1, projects: [PROJECT], cards: CARDS, boardOff: [] };
    if (path.startsWith("/ui/steps")) return steps ?? { __status: 403, error: "admin_only" };
    const m = /^\/ui\/tasks\/cards\/([^/]+)$/.exec(path);
    if (m) return detailOf(decodeURIComponent(m[1]!));
    return {};
  };
  fleetIs({ alpha: "working", beta: "idle", gamma: "idle" });
});

let mounts = 0;
async function mount(storage: Record<string, string> = { agend_tasks_project: "1" }) {
  await p.unmount();
  for (const [k, v] of Object.entries(storage)) (globalThis as any).localStorage.setItem(k, v);
  await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "tasks" }, navKey: `fleet:tasks|rv-${++mounts}|en` }));
  await settle(8);
}
const doc = () => (globalThis as any).document;
const q = (sel: string) => p.root.querySelector(sel);
const qa = (sel: string) => [...p.root.querySelectorAll(sel)] as any[];
const text = (el: any): string | null => (el ? el.childNodes.map((n: any) => (n.nodeType === 3 ? n.textContent : text(n)) ?? "").map((s: string) => s.replace(/\s+/g, " ").trim()).filter(Boolean).join(" ") : null);
async function openCard(id: string) { fire(q(`[data-tile="${id}"] .tb-tile-title`) ?? q(`[data-row="${id}"] .tb-row-title`), "click"); await settle(10); }
const markOf = (id: string) => q(`[data-tile="${id}"] .tr-mark`) ?? q(`[data-row="${id}"] .tr-mark`);

// ── What is running (pure) ─────────────────────────────────────────────────────────────────────────────────────────

const INST = (state: string) => [{ name: "alpha", status: "running" }, { name: "beta", status: "running" }, { name: "off", status: "paused" }].map((i) => ({ ...i, state }));
const ctx = (over: Record<string, unknown> = {}) => ({ instances: INST("working"), exec: { alpha: "working", beta: "idle", off: "working" }, awaiting: {}, doing: new Map(), ...over });

describe("how many cards an instance has in progress", () => {
  it("counts the cards in `claimed` by assignee; a main task that follows its sub tasks does not count (its sub tasks do); nobody's and other statuses do not", () => {
    const doing = run.inProgressBy([M1, M2, S1, S2, M3, M4, M5, card({ id: "S-9", kind: "sub", parentId: "M-2", status: "claimed", assignee: "beta" })]);
    expect([...doing]).toEqual([["alpha", 1], ["beta", 2]]);
  });
  it("a main task with no sub tasks counts; garbage in is an empty count", () => {
    expect([...run.inProgressBy([card({ id: "M-7", status: "claimed", assignee: "alpha" }), card({ id: "M-8", status: "claimed", assignee: null })])]).toEqual([["alpha", 1]]);
    for (const bad of [null, undefined, "x", {}, [null, 3]]) expect(run.inProgressBy(bad).size).toBe(0);
  });
});

describe("what a card's assignee is doing on it", () => {
  it("a card in progress, its assignee working: running, and exact when it is the assignee's one", () => {
    expect(run.runOf(M1, ctx())).toEqual({ instance: "alpha", state: "working", shared: 0 });
    expect(run.runOf(M1, ctx({ doing: new Map([["alpha", 1]]) }))).toEqual({ instance: "alpha", state: "working", shared: 0 });
  });
  it("with several cards in progress nothing says which one: each is shared, none is a plain 'working'", () => {
    expect(run.runOf(M1, ctx({ doing: new Map([["alpha", 3]]) }))).toEqual({ instance: "alpha", state: "working", shared: 3 });
  });
  it("waiting for the person, stuck and idle are states of their own; idle is a state of the card's page, not of the board", () => {
    expect(run.runOf(M1, ctx({ awaiting: { alpha: "a permission" } }))?.state).toBe("needs");
    expect(run.runOf(M1, ctx({ exec: { alpha: "stuck" } }))?.state).toBe("stuck");
    expect(run.runOf(M1, ctx({ exec: { alpha: "idle" } }))?.state).toBe("idle");
  });
  it("nothing to say: not in progress, nobody's, an instance the viewer does not see, one that is not running", () => {
    expect(run.runOf({ ...M1, status: "open" }, ctx())).toBeNull();
    expect(run.runOf({ ...M1, status: "done" }, ctx())).toBeNull();
    expect(run.runOf({ ...M1, assignee: null }, ctx())).toBeNull();
    expect(run.runOf({ ...M1, assignee: "ghost" }, ctx()), "no such instance for this viewer (hidden, gone, a person)").toBeNull();
    expect(run.runOf({ ...M1, assignee: "off" }, ctx()), "paused").toBeNull();
    expect(run.runOf(null, ctx())).toBeNull();
    expect(run.runOf(M1, { instances: undefined, exec: undefined, awaiting: undefined, doing: undefined })).toBeNull();
  });
  it("a main task that follows its sub tasks has the strongest of its in-progress sub tasks'; none in progress: nothing", () => {
    const sub = (id: string, assignee: string, status = "claimed") => card({ id, kind: "sub", parentId: "M-2", status, assignee });
    const c = ctx({ exec: { alpha: "idle", beta: "working" } });
    expect(run.runOf(M2, c, [sub("S-1", "alpha"), sub("S-2", "beta")])?.instance).toBe("beta");
    expect(run.runOf(M2, c, [sub("S-1", "alpha", "done"), sub("S-2", "beta", "open")])).toBeNull();
    expect(run.runOf(M2, c, [])).toBeNull();
    expect(run.runOf(M2, c, undefined)).toBeNull();
  });
});

describe("when the card was put in progress, and the steps since", () => {
  it("the newest move to claimed in the history; else the time it first started; else unknown", () => {
    expect(run.claimedSince({ history: ENTRIES.history, card: M1 })).toBe(Date.parse("2026-11-03T09:00:00.000Z"));
    expect(run.claimedSince({ history: [], card: M1 })).toBe(T0);
    expect(run.claimedSince({ history: [{ type: "moved", data: { to: "review" }, at: "2026-11-04T09:00:00.000Z" }], card: { startedAt: null } })).toBe(0);
    for (const bad of [null, undefined, {}, { history: [null, { type: "moved" }] }]) expect(run.claimedSince(bad)).toBe(0);
  });
  const S = stepsOf([toolLine(T0 + 1000, "Read", { file_path: "/w/a.ts" }), toolLine(T0 + 61_000, "Bash", { command: "npm test" }), toolLine(T0 + 62_000, "Edit", { file_path: "/w/b.ts", old_string: "a", new_string: "b" })]);
  const snap = (over: Record<string, unknown> = {}) => ({ steps: S, info: { supported: true, level: "standard" }, dead: false, phase: null, complete: true, ...over });
  it("a live group of the steps since then (a little slack before it); the block draws it as the chat does", () => {
    expect(S.length).toBe(3);
    const all = run.liveGroupOf(snap(), { since: T0 });
    expect(all.items.map((s: any) => s.tool)).toEqual(["Read", "Bash", "Edit"]);
    expect(all).toMatchObject({ level: "live", ended: false, to: 0, busy: true, rowKey: null, trailing: [], atEnd: true });
    const later = run.liveGroupOf(snap(), { since: T0 + 60_000 });
    expect(later.items.map((s: any) => s.tool)).toEqual(["Bash", "Edit"]);
    expect(later.from).toBe(S[1]!.ts);
  });
  it("since not known: the newest turn's steps; marked partial only when the steps do not reach back to the claim", () => {
    expect(run.liveGroupOf(snap(), {}).items.length).toBeGreaterThan(0);
    expect(run.liveGroupOf(snap({ complete: false }), { since: T0 - 3_600_000 }).partial).toBe(true);
    expect(run.liveGroupOf(snap({ complete: true }), { since: T0 - 3_600_000 }).partial).toBeUndefined();
    expect(run.liveGroupOf(snap({ complete: false }), { since: T0 + 1000 }).partial, "the first step is not newer than the claim").toBeUndefined();
  });
  it("nothing to draw from: no answer yet, the server offers nothing, tool_progress off, a backend with no steps", () => {
    expect(run.liveGroupOf(null, { since: T0 })).toBeNull();
    expect(run.liveGroupOf(snap({ dead: true }), { since: T0 })).toBeNull();
    expect(run.liveGroupOf(snap({ info: { level: "off" } }), { since: T0 })).toBeNull();
    expect(run.liveGroupOf(snap({ info: { supported: false, level: "standard" } }), { since: T0 })).toBeNull();
    expect(run.liveGroupOf(snap({ steps: [] }), { since: T0 }).items).toEqual([]);
  });
});

describe("the timeline says what an agent did", () => {
  it("each entry carries who made it (person, instance…); an older server's entry carries none", () => {
    const tl = activity.timelineOf({ comments: ENTRIES.comments, logs: ENTRIES.logs, history: ENTRIES.history });
    expect(tl.map((e: any) => `${e.type}:${e.who}:${e.by}`)).toEqual(["event:Ann:person", "event:alpha:instance", "comment:Ann:person", "log:alpha:instance", "comment:alpha:instance", "event:Ann:person"]);
    const old = activity.timelineOf({ comments: [{ id: 1, author: "alpha", text: "x", at: ago(1) }], logs: [{ id: 2, author: "alpha", text: "y", at: ago(1) }], history: [{ id: 3, actor: "alpha", type: "created", data: {}, at: ago(2) }] });
    expect(old.map((e: any) => e.by)).toEqual(["", "", ""]);
  });
});

// ── The board ───────────────────────────────────────────────────────────────────────────────────────────────────────

describe("the board says which cards are running", () => {
  it("a tile whose assignee is working says Running (its tile is marked); one whose assignee is idle, or that nobody has, says nothing", async () => {
    await mount();
    expect(text(markOf("M-1"))).toBe("Running");
    expect(q('[data-tile="M-1"]').className).toContain(" running");
    expect(markOf("M-3"), "gamma is idle").toBeNull();
    expect(markOf("M-5"), "nobody's").toBeNull();
    expect(markOf("M-4"), "finished").toBeNull();
    expect(q('[data-tile="M-3"]').className).not.toContain("running");
  });
  it("a main task shows it for its sub task that is running", async () => {
    fleetIs({ alpha: "idle", beta: "working", gamma: "idle" });
    await mount();
    expect(text(markOf("M-2"))).toBe("Running");
    expect(markOf("M-1"), "alpha is idle").toBeNull();
  });
  it("waiting for the person and stuck are marked too, in their own words; the mark follows the instance's state live", async () => {
    await mount();
    fleetIs({ alpha: "stuck", beta: "idle", gamma: "idle" }); await settle(6);
    expect(text(markOf("M-1"))).toBe("Looks stuck");
    fleetIs({ alpha: "awaiting_input", beta: "idle", gamma: "idle" }); await settle(6);
    expect(text(markOf("M-1"))).toBe("Needs you");
    fleetIs({ alpha: "idle", beta: "idle", gamma: "idle" }); await settle(6);
    expect(markOf("M-1")).toBeNull();
    app.applyActivity({ instance: "alpha", state: "working" }); await settle(6);
    expect(text(markOf("M-1"))).toBe("Running");
  });
  it("an assignee with several cards in progress: each says it is busy with N cards, none says Running", async () => {
    CARDS = [M1, card({ id: "M-6", title: "Second", status: "claimed", assignee: "alpha", sort: 6 }), M3];
    await mount();
    for (const id of ["M-1", "M-6"]) {
      expect(text(markOf(id))).toBe("Busy · 2 cards");
      expect(markOf(id).className).toContain("shared");
      expect(q(`[data-tile="${id}"]`).className).not.toContain("running");
    }
  });
  it("the list marks its rows the same way", async () => {
    await mount({ agend_tasks_project: "1", agend_tasks_display: JSON.stringify({ view: "list" }) });
    expect(q(".tb-list")).toBeTruthy();
    expect(text(markOf("M-1"))).toBe("Running");
    expect(q('[data-row="M-1"]').className).toContain(" running");
    expect(markOf("M-3")).toBeNull();
  });
  it("a viewer who does not see the assignee (hidden, gone) sees no mark and no error", async () => {
    app.applyStatus({ uptime: 1, instances: [{ name: "beta", status: "running", state: "idle", execution_state: "idle" }] });
    await mount();
    expect(markOf("M-1")).toBeNull();
    expect(q('[data-tile="M-1"]')).toBeTruthy();
  });
});

// ── The card's page ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("a card's page: Agent activity", () => {
  it("who has it, their state, and the way to their conversation", async () => {
    await mount();
    await openCard("M-1");
    const block = q(".tr-run");
    expect(block).toBeTruthy();
    expect(text(block.querySelector(".tr-title"))).toBe("Agent activity");
    expect(text(block.querySelector(".tb-who"))).toBe("alpha");
    expect(text(block.querySelector(".tr-state"))).toBe("Running");
    const link = block.querySelector("a.tr-open");
    expect(link.getAttribute("href")).toBe("/ui/chat/alpha");
    expect(text(link)).toBe("Open conversation");
    expect(qa(".tp-body > *")[0], "first in the body, above the card's text").toBe(block);
    expect(calls.filter((c) => c.path.startsWith("/ui/steps")), "nothing is read for a viewer who is not an admin").toEqual([]);
  });
  it("idle while the card is in progress says so; with several cards in progress it says which it cannot know", async () => {
    fleetIs({ alpha: "idle", beta: "idle", gamma: "idle" });
    await mount();
    await openCard("M-1");
    expect(text(q(".tr-state"))).toBe("Idle");
    expect(text(q(".tr-note"))).toBe("alpha has this card in progress but is idle right now.");
    CARDS = [M1, card({ id: "M-6", title: "Second", status: "claimed", assignee: "alpha", sort: 6 })];
    fleetIs({ alpha: "working", beta: "idle", gamma: "idle" });
    (globalThis as any).history.replaceState(null, "", "/ui/fleet");
    await mount();
    await openCard("M-1");
    expect(text(q(".tr-note"))).toContain("alpha has 2 cards in progress");
  });
  it("a card that is not in progress has the name and the conversation link, no state; a finished one too", async () => {
    await mount();
    await openCard("M-3");
    expect(q(".tr-state")).toBeNull();
    expect(q("a.tr-open").getAttribute("href")).toBe("/ui/chat/gamma");
    (globalThis as any).history.replaceState(null, "", "/ui/fleet");
    await mount({ agend_tasks_project: "1", agend_tasks_display: JSON.stringify({ done: "all" }) });
    await openCard("M-4");
    expect(q(".tr-state")).toBeNull();
    expect(q("a.tr-open").getAttribute("href")).toBe("/ui/chat/alpha");
  });
  it("no block for a card nobody has, an assignee the viewer does not see, or a main task that follows its sub tasks", async () => {
    await mount();
    await openCard("M-5");
    expect(q(".tr-run")).toBeNull();
    (globalThis as any).history.replaceState(null, "", "/ui/fleet");
    await mount();
    await openCard("M-2");
    expect(q(".tr-run"), "its sub tasks' pages have it").toBeNull();
    app.applyStatus({ uptime: 1, instances: [{ name: "beta", status: "running", state: "idle", execution_state: "idle" }] });
    (globalThis as any).history.replaceState(null, "", "/ui/fleet");
    await mount();
    await openCard("M-1");
    expect(q(".tr-run")).toBeNull();
    expect(q(".tp-body .tc-field"), "the rest of the page is there").toBeTruthy();
  });
  it("a sub task's page has it, with its own assignee's state", async () => {
    fleetIs({ alpha: "idle", beta: "working", gamma: "idle" });
    await mount();
    fire(q('[data-tile="M-2"] .tb-tile-progress'), "click"); await settle(4);
    fire(qa(".tb-subs button").find((b) => text(b)!.includes("S-2")), "click"); await settle(10);
    expect(text(q(".tr-run .tb-who"))).toBe("beta");
    expect(text(q(".tr-state"))).toBe("Running");
  });
});

describe("a card's page: the live steps (an admin session, tool progress on)", () => {
  const answer = (over: Record<string, unknown> = {}) => ({ enabled: true, instance: "alpha", backend: "claude-code", supported: true, thinking: false, level: "standard", cwd: "/w", home: "/h",
    steps: stepsOf([toolLine(Date.now() - 20_000, "Read", { file_path: "/w/src/a.ts" }), toolLine(Date.now() - 10_000, "Bash", { command: "npm test" })]), after: 100, key: "1-2", before: null, ev: 0, ...over });
  it("draws the chat's live block from the steps since the card was put in progress; nothing is read until the card is open", async () => {
    doc().body.dataset.chatActivity = "1";
    steps = answer();
    await mount();
    expect(calls.filter((c) => c.path.startsWith("/ui/steps")), "the board reads none").toEqual([]);
    await openCard("M-1");
    await settle(12);
    const reads = calls.filter((c) => c.path.startsWith("/ui/steps"));
    expect(reads.length).toBeGreaterThan(0);
    expect(reads[0]!.path).toContain("instance=alpha");
    const live = q(".tr-run .act-block.live");
    expect(live, "the chat's own block").toBeTruthy();
    expect(text(live.querySelector(".act-sum"))).toContain("2 tools");
  });
  it("tool progress off for that instance: the state alone, and a line saying why with the way to turn it on", async () => {
    doc().body.dataset.chatActivity = "1";
    steps = { enabled: true, instance: "alpha", backend: "claude-code", supported: true, thinking: false, level: "off", steps: [], after: null, key: null, before: null, ev: 0 };
    await mount();
    await openCard("M-1");
    await settle(12);
    expect(q(".tr-run .act-block")).toBeNull();
    expect(text(q(".tr-state"))).toBe("Running");
    expect(text(q(".tr-note"))).toContain("alpha's tool progress is off");
    expect(q(".tr-note a").getAttribute("href")).toBe("/ui/fleet/agent/alpha");
  });
  it("a backend with no steps says so; a refusal or an error shows the state alone and breaks nothing", async () => {
    doc().body.dataset.chatActivity = "1";
    steps = { enabled: true, instance: "alpha", backend: "muse", supported: false, reason: "unsupported", thinking: false, level: "standard", steps: [], after: null, key: null, before: null, ev: 0 };
    await mount();
    await openCard("M-1");
    await settle(12);
    expect(text(q(".tr-note"))).toBe("This agent's runtime does not offer its steps.");
    act.forgetActivity();
    steps = null;                       // the server refuses (403)
    (globalThis as any).history.replaceState(null, "", "/ui/fleet");
    await mount();
    await openCard("M-1");
    await settle(12);
    expect(q(".tr-run")).toBeTruthy();
    expect(q(".tr-run .act-block")).toBeNull();
    expect(q(".tr-note")).toBeNull();
    expect(text(q(".tr-state"))).toBe("Running");
  });
  it("the steps are not read while the card's assignee is idle (nothing to watch), nor with Show activity switched off", async () => {
    doc().body.dataset.chatActivity = "1";
    steps = answer();
    fleetIs({ alpha: "idle", beta: "idle", gamma: "idle" });
    await mount();
    await openCard("M-1");
    await settle(10);
    expect(calls.filter((c) => c.path.startsWith("/ui/steps"))).toEqual([]);
    fleetIs({ alpha: "working", beta: "idle", gamma: "idle" });
    act.setActivityOn(false);
    try {
      (globalThis as any).history.replaceState(null, "", "/ui/fleet");
      await mount();
      await openCard("M-1");
      await settle(10);
      expect(calls.filter((c) => c.path.startsWith("/ui/steps"))).toEqual([]);
      expect(text(q(".tr-state"))).toBe("Running");
    } finally { act.setActivityOn(true); }
  });
});

describe("a card's page: the timeline marks the agent's actions", () => {
  it("an instance's claim, move, log line and comment carry an Agent tag and a bar; a person's do not", async () => {
    await mount();
    await openCard("M-1");
    const items = qa(".tl-item");
    expect(items.length).toBe(6);
    expect(items.map((li) => li.className.includes("by-agent"))).toEqual([false, true, false, true, true, false]);
    expect(items.map((li) => qa(".tr-by").filter((tag) => li.contains(tag)).length)).toEqual([0, 1, 0, 1, 1, 0]);
    expect(text(items[1])).toContain("alpha Agent");
  });
  it("an older server's entries (no kind) are shown as they were: no tag, no bar", async () => {
    handler = (path) => (path.startsWith("/ui/tasks/board") ? { rev: 1, projects: [PROJECT], cards: CARDS, boardOff: [] }
      : detailOf("M-1", { comments: [{ id: 1, author: "alpha", kind: "comment", text: "hi", at: ago(1) }], logs: [{ id: 2, author: "alpha", text: "log", at: ago(1) }],
        history: [{ id: 3, actor: "alpha", type: "moved", data: { from: "open", to: "claimed" }, at: ago(2) }] }));
    await mount();
    await openCard("M-1");
    expect(qa(".tl-item").length).toBe(3);
    expect(qa(".tr-by")).toEqual([]);
    expect(qa(".tl-item").some((li) => li.className.includes("by-agent"))).toBe(false);
  });
});
