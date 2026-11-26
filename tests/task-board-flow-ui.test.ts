/**
 * A main task says what its sub tasks' agents are really doing, and how the baton passes (docs/design/task-board.md, "Live state and
 * handoffs"; fleet-task-flow.js):
 *
 *   1. What a line says (pure): a sub task being worked on, busy with several cards, waiting for the person, looking stuck, idle, blocked;
 *      waiting for another; ready and handed on — sending, taken, read, offline, paused, failed, not sent (and why); the summary the main task's
 *      block lists; a handoff as the activity stream says it; the step line of the chat's own feed.
 *   2. The main task's page: a turning ring and the current step on the sub task that runs (the state alone when steps are not offered,
 *      tool progress is off, or the viewer is not an admin), the same in the "Agent activity" block and as "Running" beside the status; the board's
 *      tile says it too. Waiting, handed on, read, offline, failed, blocked, idle — each its own line.
 *   3. The activity: the sub tasks' moves, and each handoff as a row that is not folded away; none for a session that cannot write.
 *   4. Live: the stream's ping reads the card again, a notice on its way is read again by itself, steps move as the feed does.
 *   5. Both languages; the sub task's own page says where its hand-over stands.
 *
 * The page is the real Tasks tab in tests/helpers/mini-dom.ts.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeStepParser, type LogStep } from "../src/log-steps.js";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

let p: AppPage;
let app: any, nav: any, fleet: any, flow: any, run: any, act: any, activity: any, i18n: any;
const calls: Array<{ method: string; path: string }> = [];
const handlers: Record<string, Array<(d: unknown) => void>> = {};
const emit = (name: string, data: unknown) => { for (const fn of handlers[name] ?? []) fn(data); };
let CARDS: any[] = [];
let DETAILS: Record<string, any> = {};
let steps: unknown = null;
const fetchFake = async (path: string, o: any = {}) => {
  const method = o.method ?? "GET";
  calls.push({ method, path });
  let out: any = {};
  if (path.startsWith("/ui/tasks/board")) out = { rev: 1, projects: [PROJECT], cards: CARDS, boardOff: [] };
  else if (path.startsWith("/ui/tasks/unread")) out = { enabled: true, total: 0, cards: {} };
  else if (path.startsWith("/ui/steps")) out = steps ?? { __status: 403, error: "admin_only" };
  else { const m = /^\/ui\/tasks\/cards\/([^/?]+)$/.exec(path); if (m && DETAILS[decodeURIComponent(m[1]!)]) out = DETAILS[decodeURIComponent(m[1]!)]; }
  const status = out && typeof out === "object" && "__status" in out ? out.__status : 200;
  return { ok: status < 400, status, json: async () => out };
};

const NOW = Date.now();
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000, HOUR = 3_600_000;
const card = (over: Record<string, unknown>) => ({ id: "M-1", uuid: String(over.id ?? "M-1"), kind: "main", projectId: 1, parentId: null, title: "A card", status: "open",
  assignee: null, dispatcher: { kind: "person", name: "Ann" }, waitsForPerson: false, confirmer: null, priority: "normal", size: null, needsReview: false, dependsOn: [], goal: "", scope: "",
  acceptance: [], context: "", state: "", blockedReason: "", result: "", sort: 1, createdBy: "Ann", version: 4, createdAt: ago(10 * HOUR), updatedAt: ago(HOUR), startedAt: null, submittedAt: null,
  doneAt: null, progress: { total: 0, open: 0, claimed: 0, blocked: 0, review: 0, done: 0 }, unmetDeps: [], commentCount: 0, newCommentCount: 0, lastComment: null, ...over });
const PROJECT = { id: 1, name: "Game", description: "", archived: false, sort: 1, createdAt: ago(30 * HOUR) };
const ANN = { name: "Ann", kind: "person" };

/** M-2 "RPG shooter" with S-1 (done, game-designer), S-2 (game-dev) and S-3 (game-qa, after S-2). The states of S-2 and S-3 are set per test. */
const sub = (id: string, over: Record<string, unknown>) => card({ id, kind: "sub", parentId: "M-2", sort: Number(id.slice(2)), ...over });
let main: any, S1: any, S2: any, S3: any;
function plan(s2: Record<string, unknown> = {}, s3: Record<string, unknown> = {}, over: { main?: Record<string, unknown> } = {}) {
  S1 = sub("S-1", { title: "Game design doc", status: "done", assignee: "game-designer", doneAt: ago(10 * MIN) });
  S2 = sub("S-2", { title: "Playable prototype", status: "claimed", assignee: "game-dev", dependsOn: ["S-1"], ...s2 });
  S3 = sub("S-3", { title: "QA and balance pass", status: "open", assignee: "game-qa", dependsOn: ["S-2"], unmetDeps: ["S-2"], ...s3 });
  const subs = [S1, S2, S3];
  const done = subs.filter((c) => c.status === "done").length, claimed = subs.filter((c) => c.status === "claimed").length;
  main = card({ id: "M-2", title: "RPG shooter", status: "claimed", assignee: "test", sort: 2, progress: { total: 3, open: subs.filter((c) => c.status === "open").length, claimed, blocked: subs.filter((c) => c.status === "blocked").length, review: 0, done }, ...over.main });
  CARDS = [main, ...subs];
  setDetails();
}
const history = [{ id: 1, actor: "Ann", actorKind: "person", type: "created", data: {}, at: ago(3 * HOUR) }];
function setDetails(extra: { main?: Record<string, unknown>; sub?: Record<string, Record<string, unknown>> } = {}) {
  DETAILS = {
    "M-2": { card: main, parent: null, children: [S1, S2, S3], comments: [], logs: [], history, subEvents: [], viewer: ANN, watchers: [], inheritedWatchers: [], leader: null, ...extra.main },
    ...Object.fromEntries([S1, S2, S3].map((c) => [c.id, { card: c, parent: { id: "M-2", title: main.title, status: main.status }, children: [], comments: [], logs: [], history, viewer: ANN, watchers: [], inheritedWatchers: [], leader: null, ...(extra.sub ?? {})[c.id] }])),
  };
}
const ho = (card: string, to: string, state: string, extra: Record<string, unknown> = {}) => ({ id: Math.floor(Math.random() * 1e6), card, to, why: "ready", after: "S-1", at: ago(2 * MIN), state, ...extra });
const mv = (id: number, card: string, actor: string, from: string, to: string, ago_: number, extra: Record<string, unknown> = {}) => ({ id, at: ago(ago_), actor, actorKind: "instance", card, title: card === "S-1" ? "Game design doc" : "Playable prototype", data: { from, to, ...extra } });

const toolLine = (ms: number, name: string, input: Record<string, unknown>) => JSON.stringify({ type: "assistant", uuid: `a${ms}`, timestamp: new Date(ms).toISOString(),
  message: { role: "assistant", content: [{ type: "tool_use", id: `toolu_${ms}`, name, input }] } });
const stepsOf = (lines: string[]): LogStep[] => { const parser = new ClaudeStepParser({ thinking: false }); lines.forEach((l, i) => parser.push(l, i * 1000)); return parser.steps; };
const feedAnswer = (instance: string, over: Record<string, unknown> = {}) => ({ enabled: true, instance, backend: "claude-code", supported: true, thinking: false, level: "standard", cwd: "/w", home: "/h",
  steps: stepsOf([toolLine(Date.now() - 20_000, "Read", { file_path: "/w/src/a.ts" }), toolLine(Date.now() - 10_000, "Edit", { file_path: "/w/src/game.js", old_string: "a", new_string: "b" })]), after: 100, key: "1-2", before: null, ev: 0, ...over });

beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet", storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fetchFake;
  app = await import("/assets/app-store.js");
  nav = await import("/assets/app-nav.js");
  fleet = await import("/ui/js/panel-fleet.js");
  flow = await import("/ui/js/fleet-task-flow.js");
  run = await import("/ui/js/fleet-task-run.js");
  act = await import("/ui/js/chat-activity.js");
  activity = await import("/ui/js/fleet-task-activity.js");
  i18n = await import("/assets/app-i18n.js");
  nav.startRouter(p.window);
});
afterAll(() => { p.restore(); delete (globalThis as any).fetch; });

const doc = () => (globalThis as any).document;
const q = (sel: string) => p.root.querySelector(sel);
const qa = (sel: string) => [...p.root.querySelectorAll(sel)] as any[];
const text = (el: any): string | null => (el ? el.childNodes.map((n: any) => (n.nodeType === 3 ? n.textContent : text(n)) ?? "").map((s: string) => s.replace(/\s+/g, " ").trim()).filter(Boolean).join(" ") : null);
/** The dashboard's view of the fleet: each instance's state (`working`, `idle`, `stuck`, `awaiting_input`, `stopped`, `paused`). */
const fleetIs = (states: Record<string, string>) => app.applyStatus({ uptime: 1, instances: Object.entries(states).map(([name, state]) =>
  state === "awaiting_input" ? { name, status: "running", state, execution_state: "working", interaction_summary: "a permission" }
    : state === "stopped" ? { name, status: "stopped", state: "stopped", execution_state: "idle" }
      : state === "paused" ? { name, status: "paused", state: "paused", execution_state: "idle" }
        : { name, status: "running", state, execution_state: state }) });
const EVERYONE = { "game-designer": "idle", "game-dev": "idle", "game-qa": "idle", test: "idle" };

beforeEach(async () => {
  await p.unmount();
  act.forgetActivity();
  const ls = (globalThis as any).localStorage;
  for (const k of ["agend_tasks_project", "agend_tasks_display", "agend_tasks_filters", "agend_tasks_assignee", "agend_tasks_query", "agend_tasks_collapsed"]) ls.removeItem(k);
  for (const k of ["publicLink", "chatActivity", "linkMedia", "tier"]) delete doc().body.dataset[k];
  i18n.setLang("en", { store: false });
  (globalThis as any).history.replaceState(null, "", "/ui/fleet");
  (globalThis as any).history.entries.length = 1; (globalThis as any).history.states.length = 1; (globalThis as any).history.at = 0;
  calls.length = 0;
  for (const k of Object.keys(handlers)) delete handlers[k];
  steps = null;
  app.appStore.set({ streamOn: (name: string, fn: (d: unknown) => void) => { (handlers[name] ??= []).push(fn); return () => { handlers[name] = (handlers[name] ?? []).filter((f) => f !== fn); }; } });
  plan();
  fleetIs(EVERYONE);
});
afterEach(() => { vi.useRealTimers(); });

let mounts = 0;
async function open(card = "M-2", storage: Record<string, string> = { agend_tasks_project: "1" }) {
  await p.unmount();
  (globalThis as any).history.replaceState(null, "", "/ui/fleet");
  for (const [k, v] of Object.entries(storage)) (globalThis as any).localStorage.setItem(k, v);
  await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "tasks" }, navKey: `fleet:tasks|flow-${++mounts}|en` }));
  await settle(8);
  fire(q(`[data-tile="${card}"] .tb-tile-title`), "click"); await settle(12);
}
const rowOf = (id: string) => qa(".tp-subs .tc-children li").find((li) => text(li)!.includes(` ${id} `) || text(li)!.includes(` ${id}`) && text(li)!.split(" ").includes(id));
const lineOf = (id: string) => { const row = rowOf(id); const el = row && row.querySelector(".tc-child-line"); return el ? text(el) : null; };
const block = () => q(".tr-run");

// ── 1. What a line says (pure) ─────────────────────────────────────────────────────────────────────────────

describe("1. what a line says", () => {
  const states = (o: Record<string, string>) => new Map(Object.entries(o));
  const ctx = (st: Record<string, string>, over: Record<string, unknown> = {}) => ({ handoffs: [], states: states(st), doing: new Map(), live: () => "", ...over });

  it("handoffText: each state of a notice has its words; offline, paused and working are the page's inference", () => {
    const say = (state: string, st: Record<string, string> = {}, extra: Record<string, unknown> = {}) => { const r = flow.handoffText({ to: "dev", state, ...extra }, states(st)); return r ? [r.tone, r.text] : null; };
    expect(say("sending")).toEqual(["wait", "Handed to dev"]);
    expect(say("queued", { dev: "idle" })).toEqual(["wait", "Waiting for dev to take it"]);
    expect(say("queued", { dev: "stopped" })).toEqual(["wait", "dev is offline — it gets this when it is back"]);
    expect(say("queued", { dev: "paused" })).toEqual(["wait", "dev is paused — it gets this when it is resumed"]);
    expect(say("delivered", { dev: "idle" })).toEqual(["ok", "Delivered to dev — waiting for it to start"]);
    expect(say("read", { dev: "idle" })).toEqual(["ok", "dev read it — waiting for it to start"]);
    expect(say("read", { dev: "working" })).toEqual(["busy", "dev is working… (this card is not started yet)"]);
    expect(say("failed")).toEqual(["bad", "Could not hand it to dev"]);
    expect(say("uncertain")).toEqual(["bad", "Not sure dev got it"]);
    expect(say("withdrawn")?.[0]).toBe("muted");
    expect(say("skipped", {}, { skip: "board_off" })).toEqual(["bad", "dev's task board is off, so it was not told"]);
    expect(say("skipped", {}, { skip: "not_taken" })).toEqual(["bad", "The notice to dev could not be queued"]);
    expect(say("skipped", {}, { skip: "lost" })?.[1]).toContain("was lost");
    expect(say("skipped", {}, { skip: "contact_held" })).toEqual(["bad", "dev was not told"]);
    expect(say("skipped", {}, { skip: "not_waiting" }), "the card no longer waited: nothing to say").toBeNull();
    expect(say("unknown"), "no record any more: nothing to say, never a guess").toBeNull();
    expect(flow.handoffText(null, states({}))).toBeNull();
  });

  it("subLine: the card in progress says what its agent is doing, or its state; the others say where they stand", () => {
    const line = (c: any, st: Record<string, string>, over: Record<string, unknown> = {}) => { const l = flow.subLine(card({ kind: "sub", id: "S-2", ...c }), ctx(st, over)); return l ? [l.kind, l.tone, l.text, !!l.spin] : null; };
    expect(line({ status: "claimed", assignee: "dev" }, { dev: "working" })).toEqual(["running", "busy", "dev · Running", true]);
    expect(line({ status: "claimed", assignee: "dev" }, { dev: "working" }, { live: () => "Edit src/game.js" })).toEqual(["running", "busy", "dev · Edit src/game.js", true]);
    expect(line({ status: "claimed", assignee: "dev" }, { dev: "working" }, { doing: new Map([["dev", 2]]) })).toEqual(["busy", "muted", "dev · busy with 2 cards", false]);
    expect(line({ status: "claimed", assignee: "dev" }, { dev: "needs" })).toEqual(["needs", "warn", "dev · waiting for you", false]);
    expect(line({ status: "claimed", assignee: "dev" }, { dev: "stuck" })).toEqual(["stuck", "bad", "dev · looks stuck", false]);
    expect(line({ status: "claimed", assignee: "dev" }, { dev: "idle" })).toEqual(["idle", "muted", "dev · idle", false]);
    expect(line({ status: "claimed", assignee: "ghost" }, { dev: "working" }), "an instance the viewer does not see: nothing is said of it").toBeNull();
    expect(line({ status: "claimed", assignee: null }, {})).toBeNull();
    expect(line({ status: "blocked", assignee: "dev", blockedReason: "needs the API key" }, {})).toEqual(["blocked", "bad", "Blocked: needs the API key", false]);
    expect(line({ status: "blocked", assignee: "dev" }, {})?.[2]).toBe("Blocked");
    expect(line({ status: "done", assignee: "dev" }, { dev: "working" })).toBeNull();
    expect(line({ status: "review", assignee: "dev" }, { dev: "working" })).toBeNull();
  });

  it("subLine: an open card waits for what it depends on (a hidden one counted, never named), then is ready, then is handed on", () => {
    const line = (c: any, over: Record<string, unknown> = {}) => { const l = flow.subLine(card({ kind: "sub", id: "S-2", status: "open", ...c }), ctx({ dev: "idle" }, over)); return l ? [l.kind, l.text] : null; };
    expect(line({ assignee: "dev", dependsOn: ["S-1", "S-3"], unmetDeps: ["S-1", "S-3"] })).toEqual(["waiting", "Waits for S-1, S-3"]);
    expect(line({ assignee: "dev", dependsOn: [], unmetDeps: [], hiddenUnmet: 1 })?.[1]).toContain("Waits for");
    expect(line({ assignee: null })).toEqual(["ready", "Ready to start — nobody is assigned"]);
    expect(line({ assignee: "dev" })).toEqual(["ready", "Ready — dev has not started it yet"]);
    const handed = [{ id: 3, card: "S-2", to: "dev", state: "read", at: ago(MIN) }];
    expect(line({ assignee: "dev" }, { handoffs: handed })).toEqual(["handed", "dev read it — waiting for it to start"]);
    expect(line({ assignee: "dev" }, { handoffs: [{ id: 3, card: "S-2", to: "someone-else", state: "read", at: ago(MIN) }] }), "a hand-over to a former assignee is not the baton now").toEqual(["ready", "Ready — dev has not started it yet"]);
    expect(line({ assignee: "dev" }, { handoffs: [{ id: 1, card: "S-2", to: "dev", state: "failed", at: ago(HOUR) }, { id: 2, card: "S-2", to: "dev", state: "read", at: ago(MIN) }] })?.[1], "the newest").toBe("dev read it — waiting for it to start");
    expect(line({ assignee: "dev" }, { handoffs: [{ id: 3, card: "S-2", to: "dev", state: "skipped", skip: "not_waiting", at: ago(MIN) }] })).toEqual(["ready", "Ready — dev has not started it yet"]);
  });

  it("mainLines: the strongest first, at most four and how many more; what only waits is not listed", () => {
    const sc = (id: string, status: string, assignee: string, extra: Record<string, unknown> = {}) => card({ kind: "sub", id, status, assignee, ...extra });
    const subs = [sc("S-1", "done", "a"), sc("S-2", "open", "b", { unmetDeps: ["S-3"] }), sc("S-3", "claimed", "c"), sc("S-4", "blocked", "d", { blockedReason: "why" }), sc("S-5", "claimed", "e"), sc("S-6", "claimed", "f"), sc("S-7", "claimed", "g"), sc("S-8", "cancelled", "h")];
    const r = flow.mainLines(subs, ctx({ c: "working", e: "needs", f: "stuck", g: "idle" }, { live: (n: string) => (n === "c" ? "Edit a.ts" : "") }), 4);
    expect(r.lines.map((x: any) => [x.card.id, x.line.kind])).toEqual([["S-3", "running"], ["S-5", "needs"], ["S-6", "stuck"], ["S-4", "blocked"]]);
    expect(r.more).toBe(1);                                                // S-7 (idle)
    expect(flow.mainLines([sc("S-1", "done", "a"), sc("S-2", "open", "b", { unmetDeps: ["S-3"] }), sc("S-3", "open", "c", { unmetDeps: ["S-4"] })], ctx({})).lines, "only waiting: one quiet line instead").toEqual([]);
    expect(flow.mainLines([sc("S-2", "open", "b")], ctx({})).lines, "ready, nobody told: the row's, not the block's").toEqual([]);
    expect(flow.mainLines([], ctx({})).lines).toEqual([]);
  });

  it("a handoff as the activity says it, and its card starting settles it", () => {
    const states0 = states({ dev: "idle" });
    const ready = { id: 1, card: "S-2", to: "dev", why: "ready", after: "S-1", at: ago(MIN), state: "read" };
    expect(flow.batonOf(ready, states0, null)).toEqual({ lead: "S-1 done → handed to dev to start S-2", status: { tone: "ok", text: "dev read it — waiting for it to start" } });
    expect(flow.batonOf(ready, states0, ago(30_000)).status).toEqual({ tone: "done", text: "dev started S-2" });
    expect(flow.batonOf({ ...ready, why: "assigned", after: null }, states0, null).lead).toBe("S-2 handed to dev");
    expect(flow.batonOf({ ...ready, after: null }, states0, null).lead).toBe("S-2 can start → handed to dev");
    expect(flow.batonOf({ ...ready, state: "unknown" }, states0, null).status).toBeNull();
  });

  it("startedAfter: the card's move to in progress at or after the handoff — a sub task's from the main task's events, its own from its history", () => {
    const h1 = { card: "S-2", at: ago(10 * MIN) };
    const d = { card: { id: "M-2" }, subEvents: [mv(1, "S-2", "dev", "open", "claimed", 20 * MIN), mv(2, "S-2", "dev", "open", "claimed", 5 * MIN), mv(3, "S-3", "qa", "open", "claimed", MIN)], history: [] };
    expect(flow.startedAfter(h1, d)).toBe(d.subEvents[1]!.at);
    expect(flow.startedAfter({ card: "S-3", at: ago(10 * MIN) }, d)).toBe(d.subEvents[2]!.at);
    expect(flow.startedAfter({ card: "S-2", at: ago(MIN) }, d)).toBeNull();
    expect(flow.startedAfter({ card: "S-2", at: ago(10 * MIN) }, { card: { id: "S-2" }, subEvents: [], history: [{ type: "moved", at: ago(4 * MIN), data: { to: "claimed" } }] })).toBeTruthy();
  });

  it("which handoffs are still on their way, and the names to read the state of", () => {
    expect(flow.handoffsMoving({ handoffs: [{ state: "queued", at: ago(MIN) }] }, NOW)).toBe(true);
    expect(flow.handoffsMoving({ handoffs: [{ state: "read", at: ago(MIN) }] }, NOW)).toBe(false);
    expect(flow.handoffsMoving({ handoffs: [{ state: "queued", at: ago(30 * MIN) }] }, NOW), "stale: no polling for ever").toBe(false);
    expect(flow.handoffsMoving({}, NOW)).toBe(false);
    expect(flow.handoffNames({ handoffs: [{ to: "a" }, { to: "b" }, { to: "a" }] })).toEqual(["a", "b"]);
  });

  it("the step line of an instance, from the steps the chat's feed holds: the newest step, or the backend's phase when no call runs; nothing when steps are off", async () => {
    steps = feedAnswer("game-dev");
    const feed = act.observeActivity("game-dev", { changed: () => {}, working: () => true, polling: false, streamOn: undefined });
    feed.start(); await settle(10);
    expect(flow.liveLineOf("game-dev")).toMatch(/game\.js/);
    expect(flow.liveLineOf("someone-else"), "no feed read for it").toBe("");
    feed.stop();
    act.forgetActivity();
    steps = { enabled: true, instance: "game-dev", backend: "claude-code", supported: true, thinking: false, level: "off", steps: [], after: null, key: null, before: null, ev: 0 };
    const off = act.observeActivity("game-dev", { changed: () => {}, working: () => true, polling: false, streamOn: undefined });
    off.start(); await settle(10);
    expect(flow.liveLineOf("game-dev"), "tool progress off: the state alone").toBe("");
    off.stop();
  });
});

// ── 2. The main task's page ────────────────────────────────────────────────────────────────────────────────

describe("2. the main task's page: who is really working", () => {
  it("a sub task whose agent is working: a turning ring and the state, in its row, in the block and beside the status; the others say where they stand", async () => {
    fleetIs({ ...EVERYONE, "game-dev": "working" });
    await open();
    expect(lineOf("S-1"), "done: nothing").toBeNull();
    expect(lineOf("S-2")).toBe("game-dev · Running");
    expect(rowOf("S-2")!.querySelector(".tc-child-line .out-spin"), "the shared turning ring").toBeTruthy();
    expect(lineOf("S-3")).toBe("Waits for S-2");
    expect(rowOf("S-3")!.querySelector(".out-spin")).toBeNull();
    expect(text(q(".tp-idrow .tr-mark")), "beside the status, as on the board").toBe("Running");
    expect(block().className).not.toContain("is-strip");
    expect(text(block().querySelector(".tf-lines"))).toBe("game-dev · Running S-2");
    expect(block().querySelector(".tf-lines .out-spin")).toBeTruthy();
    expect(block().querySelector("a.tr-open"), "a main task has no conversation of its own").toBeNull();
  });

  it("the board's tile says it too: a main task is Running while a sub task's agent is", async () => {
    fleetIs({ ...EVERYONE, "game-dev": "working" });
    await open("M-2");
    fire(q(".tp-back, .tp-bar .tp-back"), "click"); await settle(8);
    expect(q('[data-tile="M-2"]').className).toContain("running");
    expect(text(q('[data-tile="M-2"] .tr-mark'))).toBe("Running");
  });

  it("with steps offered (an admin, tool progress on): the line says what the agent is doing, in the row and in the block — read once, for the instance that runs", async () => {
    doc().body.dataset.chatActivity = "1";
    steps = feedAnswer("game-dev");
    fleetIs({ ...EVERYONE, "game-dev": "working" });
    await open();
    await settle(14);
    expect(lineOf("S-2")).toMatch(/^game-dev · .*game\.js/);
    expect(text(block().querySelector(".tf-lines"))).toMatch(/^game-dev · .*game\.js S-2$/);
    const reads = calls.filter((c) => c.path.startsWith("/ui/steps"));
    expect(reads.length).toBeGreaterThan(0);
    expect(new Set(reads.map((c) => /instance=([^&]+)/.exec(c.path)![1])), "only the instance that runs a sub task").toEqual(new Set(["game-dev"]));
  });

  it("tool progress off: the state alone, and no step is read into the line", async () => {
    doc().body.dataset.chatActivity = "1";
    steps = { enabled: true, instance: "game-dev", backend: "claude-code", supported: true, thinking: false, level: "off", steps: [], after: null, key: null, before: null, ev: 0 };
    fleetIs({ ...EVERYONE, "game-dev": "working" });
    await open();
    await settle(14);
    expect(lineOf("S-2")).toBe("game-dev · Running");
    expect(JSON.stringify(calls)).not.toContain("game.js");
  });

  it("a viewer who is not an admin (no steps offered): the state alone, and nothing is asked of the steps' route", async () => {
    steps = feedAnswer("game-dev");
    fleetIs({ ...EVERYONE, "game-dev": "working" });
    await open();
    await settle(10);
    expect(lineOf("S-2")).toBe("game-dev · Running");
    expect(calls.filter((c) => c.path.startsWith("/ui/steps"))).toEqual([]);
  });

  it("Show activity switched off in this browser: the state alone, nothing read", async () => {
    doc().body.dataset.chatActivity = "1";
    steps = feedAnswer("game-dev");
    fleetIs({ ...EVERYONE, "game-dev": "working" });
    act.setActivityOn(false);
    try {
      await open();
      await settle(10);
      expect(lineOf("S-2")).toBe("game-dev · Running");
      expect(calls.filter((c) => c.path.startsWith("/ui/steps"))).toEqual([]);
    } finally { act.setActivityOn(true); }
  });

  it("an agent that is idle, waiting for you, stuck or busy with another card: each has its own look, and a busy agent is not called Running", async () => {
    await open();
    expect(lineOf("S-2")).toBe("game-dev · idle");
    expect(text(block().querySelector(".tf-lines"))).toBe("game-dev · idle S-2");
    expect(q(".tp-idrow .tr-mark"), "idle is not running").toBeNull();
    fleetIs({ ...EVERYONE, "game-dev": "awaiting_input" }); await settle(8);
    expect(lineOf("S-2")).toBe("game-dev · waiting for you");
    expect(rowOf("S-2")!.querySelector(".tc-child-line").className).toContain("tf-warn");
    expect(text(q(".tp-idrow .tr-mark"))).toBe("Needs you");
    fleetIs({ ...EVERYONE, "game-dev": "stuck" }); await settle(8);
    expect(lineOf("S-2")).toBe("game-dev · looks stuck");
    expect(rowOf("S-2")!.querySelector(".tc-child-line").className).toContain("tf-bad");
    CARDS = [...CARDS, sub("S-9", { status: "claimed", assignee: "game-dev", title: "Another" })]; DETAILS["M-2"].children = [S1, S2, S3, CARDS.at(-1)];
    fleetIs({ ...EVERYONE, "game-dev": "working" });
    await open();
    expect(lineOf("S-2")).toBe("game-dev · busy with 2 cards");
    expect(rowOf("S-2")!.querySelector(".out-spin"), "not called running: no ring").toBeNull();
  });

  it("a blocked sub task says why, in the danger colour", async () => {
    plan({ status: "blocked", blockedReason: "needs the API key" });
    await open();
    expect(lineOf("S-2")).toBe("Blocked: needs the API key");
    expect(rowOf("S-2")!.querySelector(".tc-child-line").className).toContain("tf-bad");
    expect(text(block().querySelector(".tf-lines"))).toContain("Blocked: needs the API key");
  });

  it("nothing is going on (only waiting, or ready with nobody told): the block is its one quiet line, as before", async () => {
    plan({ status: "open", unmetDeps: [] }, { status: "open", unmetDeps: ["S-2"] });
    await open();
    expect(block().className).toContain("is-strip");
    expect(text(q(".tp-agent-note"))).toBe("The work is in its sub tasks: each one's agent updates its own card");
    expect(lineOf("S-2")).toBe("Ready — game-dev has not started it yet");
    expect(lineOf("S-3")).toBe("Waits for S-2");
  });
});

describe("2b. the baton: S-1 done, S-2 handed on", () => {
  const handed = (state: string, extra: Record<string, unknown> = {}) => { plan({ status: "open", unmetDeps: [], assignee: "game-dev" }, { status: "open", unmetDeps: ["S-2"] }); setDetails({ main: { handoffs: [ho("S-2", "game-dev", state, extra)], subEvents: [mv(1, "S-1", "game-designer", "claimed", "done", 10 * MIN)] } }); };

  it("sending, taken, read: the row and the block say who has the baton, in words", async () => {
    handed("sending");
    await open();
    expect(lineOf("S-2")).toBe("Handed to game-dev");
    expect(rowOf("S-2")!.querySelector(".tc-child-line").className).toContain("tf-k-handed");
    expect(text(block().querySelector(".tf-lines"))).toBe("Handed to game-dev S-2");
    handed("read"); emit("task_wakes", { ids: ["M-2"] });
    await new Promise((r) => setTimeout(r, 400)); await settle(10);
    expect(lineOf("S-2")).toBe("game-dev read it — waiting for it to start");
    expect(lineOf("S-3")).toBe("Waits for S-2");
  });

  it("offline or paused: it says when the agent will get it; a failure says it did not arrive, and why", async () => {
    handed("queued"); fleetIs({ ...EVERYONE, "game-dev": "stopped" });
    await open();
    expect(lineOf("S-2")).toBe("game-dev is offline — it gets this when it is back");
    fleetIs({ ...EVERYONE, "game-dev": "paused" }); await settle(8);
    expect(lineOf("S-2")).toBe("game-dev is paused — it gets this when it is resumed");
    fleetIs(EVERYONE);
    for (const [state, skip, want] of [["failed", undefined, "Could not hand it to game-dev"], ["uncertain", undefined, "Not sure game-dev got it"], ["skipped", "board_off", "game-dev's task board is off, so it was not told"], ["skipped", "not_taken", "The notice to game-dev could not be queued"]] as const) {
      handed(state, skip ? { skip } : {});
      await open();
      expect([state, skip, lineOf("S-2")]).toEqual([state, skip, want]);
      expect(rowOf("S-2")!.querySelector(".tc-child-line").className).toContain("tf-bad");
    }
  });

  it("a read-only session has no record of the notice: the row says only that it is ready", async () => {
    plan({ status: "open", unmetDeps: [], assignee: "game-dev" }, { status: "open", unmetDeps: ["S-2"] });
    await open();
    expect(lineOf("S-2")).toBe("Ready — game-dev has not started it yet");
  });

  it("the sub task's own page says where its hand-over stands (and where it waits)", async () => {
    handed("read");
    setDetails({ main: { handoffs: [ho("S-2", "game-dev", "read")], subEvents: [] }, sub: { "S-2": { handoffs: [ho("S-2", "game-dev", "read")] } } });
    await open("M-2");
    fire(rowOf("S-2")!.querySelector("button"), "click"); await settle(12);
    expect(q('[data-card="S-2"]')).toBeTruthy();
    expect(text(q(".tp-agent-note"))).toBe("game-dev read it — waiting for it to start");
    await open("M-2");
    fire(rowOf("S-3")!.querySelector("button"), "click"); await settle(12);
    expect(q('[data-card="S-3"]')).toBeTruthy();
    expect(text(q(".tp-agent-note"))).toBe("Waits for S-2");
  });
});

// ── 3. The activity ────────────────────────────────────────────────────────────────────────────────────────

describe("3. the main task's activity", () => {
  const events = () => [mv(1, "S-1", "game-designer", "open", "claimed", 40 * MIN), mv(2, "S-1", "game-designer", "claimed", "done", 10 * MIN), mv(3, "S-2", "game-dev", "open", "claimed", 3 * MIN)];

  it("the sub tasks' moves are lines of the activity, with the sub task's number; a handoff is a row of its own that is not folded away", async () => {
    plan({ status: "claimed", unmetDeps: [] });
    setDetails({ main: { subEvents: events(), handoffs: [ho("S-2", "game-dev", "read", { at: ago(9 * MIN) })] } });
    await open();
    const baton = q(".tl-baton");
    expect(baton, "visible without opening a run").toBeTruthy();
    expect(text(baton.querySelector(".tl-sentence"))).toBe("S-1 done → handed to game-dev to start S-2");
    expect(text(baton.querySelector(".tl-wake"))).toBe("game-dev started S-2");
    expect(baton.querySelector(".tl-wake").className).toContain("wk-done");
    // The moves are history lines, folded into "N activities" like any history; opened they name the sub task.
    const runs = qa(".tl-more").filter((b) => /activit/.test(text(b)!));
    expect(runs, "the history lines are runs on either side of the handoff row: it splits them, so it is never inside one").toHaveLength(2);
    for (const run of runs) { fire(run, "click"); await settle(4); }
    const lines = qa(".tl-event .tl-sentence").map((el) => text(el));
    expect(lines.some((l) => l!.includes("game-designer") && l!.includes("S-1 · changed status from To do to In progress"))).toBe(true);
    expect(lines.some((l) => l!.includes("game-designer") && l!.includes("S-1 · changed status from In progress to Done"))).toBe(true);
    expect(lines.some((l) => l!.includes("game-dev") && l!.includes("S-2 · changed status from To do to In progress"))).toBe(true);
  });

  it("not started yet: the handoff row says where it stands, and follows the instance's state", async () => {
    handedState("queued");
    fleetIs({ ...EVERYONE, "game-dev": "stopped" });
    await open();
    expect(text(q(".tl-baton .tl-wake"))).toBe("game-dev is offline — it gets this when it is back");
    fleetIs(EVERYONE); await settle(8);
    expect(text(q(".tl-baton .tl-wake"))).toBe("Waiting for game-dev to take it");
    function handedState(state: string) { plan({ status: "open", unmetDeps: [] }, { status: "open", unmetDeps: ["S-2"] }); setDetails({ main: { subEvents: [events()[1]!], handoffs: [ho("S-2", "game-dev", state)] } }); }
  });

  it("the History filter has them; Comments does not", async () => {
    plan({ status: "claimed", unmetDeps: [] });
    setDetails({ main: { subEvents: events(), handoffs: [ho("S-2", "game-dev", "read", { at: ago(9 * MIN) })] } });
    await open();
    const filter = (name: string) => qa(".tl-filter button").find((b) => text(b)!.startsWith(name));
    fire(filter("History"), "click"); await settle(6);
    expect(q(".tl-baton")).toBeTruthy();
    expect(qa(".tl-event")).toHaveLength(4);                                     // the card's creation and the three moves, each open
    fire(filter("Comments"), "click"); await settle(6);
    expect(q(".tl-baton")).toBeNull();
  });

  it("a session that cannot write has the moves and no handoff row", async () => {
    plan({ status: "claimed", unmetDeps: [] });
    setDetails({ main: { subEvents: events(), viewer: undefined } });
    await open();
    expect(q(".tl-baton")).toBeNull();
    expect(qa(".tl-more").some((b) => /activit/.test(text(b)!)), "the moves are there").toBe(true);
  });

  it("an instance's name and a card's title are text — never markup", async () => {
    const nasty = "<img src=x onerror=alert(1)>";
    plan({ status: "open", unmetDeps: [], assignee: nasty }, { status: "open", unmetDeps: ["S-2"] });
    setDetails({ main: { handoffs: [ho("S-2", nasty, "read")], subEvents: [] } });
    await open();
    expect(qa(".tl-baton img, .tc-child-line img, .tf-lines img")).toHaveLength(0);
    expect(text(q(".tl-baton .tl-sentence"))).toContain(nasty);
  });
});

// ── 4. Live ────────────────────────────────────────────────────────────────────────────────────────────────

describe("4. live", () => {
  it("a ping for this main task reads it again — and one for a card that is not on this page does not", async () => {
    await open();
    const reads = () => calls.filter((c) => c.method === "GET" && /^\/ui\/tasks\/cards\/M-2$/.test(c.path)).length;
    const before = reads();
    emit("task_wakes", { ids: ["M-9"] });
    await new Promise((r) => setTimeout(r, 400)); await settle(6);
    expect(reads()).toBe(before);
    emit("task_wakes", { ids: ["M-2", "S-2"] });
    await new Promise((r) => setTimeout(r, 400)); await settle(10);
    expect(reads()).toBe(before + 1);
  });

  it("a hand-over on its way is read again by itself; once settled it is not", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    plan({ status: "open", unmetDeps: [] }, { status: "open", unmetDeps: ["S-2"] });
    setDetails({ main: { handoffs: [ho("S-2", "game-dev", "queued")], subEvents: [] } });
    await open();
    const reads = () => calls.filter((c) => c.method === "GET" && /^\/ui\/tasks\/cards\/M-2$/.test(c.path)).length;
    const before = reads();
    await vi.advanceTimersByTimeAsync(5_100); await settle(6);
    expect(reads()).toBeGreaterThan(before);
    setDetails({ main: { handoffs: [ho("S-2", "game-dev", "read")], subEvents: [] } });
    await vi.advanceTimersByTimeAsync(5_100); await settle(10);
    const settled = reads();
    await vi.advanceTimersByTimeAsync(20_000); await settle(6);
    expect(reads()).toBe(settled);
  });

  it("the agent's state moves the line with the dashboard's own status frames; the step line moves with the feed's steps_tick", async () => {
    doc().body.dataset.chatActivity = "1";
    steps = feedAnswer("game-dev");
    fleetIs({ ...EVERYONE, "game-dev": "working" });
    await open();
    await settle(14);
    expect(lineOf("S-2")).toMatch(/game\.js/);
    steps = feedAnswer("game-dev", { steps: stepsOf([toolLine(Date.now() - 2_000, "Bash", { command: "npm test" })]), after: 200, key: "1-3" });
    emit("steps_tick", { instance: "game-dev" });
    await new Promise((r) => setTimeout(r, 50)); await settle(14);
    expect(lineOf("S-2")).toMatch(/npm test/);
    fleetIs({ ...EVERYONE, "game-dev": "idle" }); await settle(8);
    expect(lineOf("S-2")).toBe("game-dev · idle");
    expect(rowOf("S-2")!.querySelector(".out-spin")).toBeNull();
  });
});

// ── 5. Both languages ──────────────────────────────────────────────────────────────────────────────────────

describe("5. both languages", () => {
  it("every string the lines use is in English and Traditional Chinese, with the same holes", () => {
    const keys = ["running", "needs", "stuck", "idle", "busyN", "busyTip", "runningTip", "waitsFor", "readyNobody", "readyFor", "blocked", "blockedOn", "sending", "queued", "offline", "paused", "delivered",
      "read", "working", "failed", "uncertain", "withdrawn", "skip.board_off", "skip.not_taken", "skip.lost", "skip.other", "handedAfter", "handedReady", "handedAssigned", "started", "handoffLabel", "linesLabel", "openCard", "more"]
      .map((k) => `taskflow.${k}`);
    const holes = (s: string) => [...new Set(s.match(/\{\d\}/g) ?? [])].sort().join();
    for (const key of keys) {
      const en = i18n.tIn("en", key), zh = i18n.tIn("zh-TW", key);
      expect(en, key).not.toBe(key);
      expect(zh, key).not.toBe(key);
      expect(zh, `${key} is translated`).not.toBe(en);
      expect(holes(zh), `${key} placeholders`).toBe(holes(en));
    }
  });

  it("in Traditional Chinese: the rows, the block, the handoff", async () => {
    i18n.setLang("zh-TW", { store: false });
    plan({ status: "open", unmetDeps: [], assignee: "game-dev" }, { status: "open", unmetDeps: ["S-2"] });
    setDetails({ main: { handoffs: [ho("S-2", "game-dev", "read")], subEvents: [mv(1, "S-1", "game-designer", "claimed", "done", 10 * MIN)] } });
    await open();
    expect(lineOf("S-2")).toBe("game-dev 已讀，等它開始");
    expect(lineOf("S-3")).toBe("等 S-2");
    expect(text(q(".tl-baton .tl-sentence"))).toBe("S-1 完成 → 已交給 game-dev 開始 S-2");
    fleetIs({ ...EVERYONE, "game-dev": "working" });
    plan({ status: "claimed", unmetDeps: [] });
    await open();
    expect(lineOf("S-2")).toBe("game-dev · 執行中");
    expect(text(q(".tp-idrow .tr-mark"))).toBe("執行中");
  });
});

// keep the imports honest: the modules the page is made of
void run; void activity;
