/**
 * #3731 phase 1 (web half): the page's side of ACP agents — the execution-mode fields (only where a backend offers acp),
 * the mode badge, terminal gating by `pane_view`, the settings form's patch, and the Log's two new rows: a thought
 * (muted, folded when long) and a permission request (Allow / Deny / Cancel turn while it waits, the outcome after).
 * The real components and panels in the mini DOM; fetch is a fake that records what is sent.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
import { fire, installDom } from "./helpers/mini-dom.js";

let A: any, act: any, appStore: any, logp: any, settings: any;
let calls: Array<{ method: string; url: string; body?: any }> = [];
/** What POST /ui/permission answers. */
let permissionAnswer: { status: number; body: unknown } = { status: 200, body: { ok: true } };
let stepAnswers: unknown[] = [];
const mounted: AppPage[] = [];
const ticks = new Set<(d: unknown) => void>();

async function fakeFetch(url: string, init: { method?: string; body?: string } = {}) {
  const method = init.method || "GET";
  calls.push({ method, url, ...(init.body ? { body: JSON.parse(init.body) } : {}) });
  if (url === "/ui/permission") {
    return { ok: permissionAnswer.status < 400, status: permissionAnswer.status, json: async () => permissionAnswer.body, text: async () => JSON.stringify(permissionAnswer.body) };
  }
  if (url.startsWith("/ui/steps")) {
    const a = stepAnswers.length > 1 ? stepAnswers.shift() : stepAnswers[0];
    return { ok: true, status: 200, json: async () => structuredClone(a), text: async () => JSON.stringify(a) };
  }
  return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
}

beforeAll(async () => {
  // @ts-expect-error — a JS module of the app, with no types
  await import("../src/ui/chat-render.js");
  const base = installDom({ storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fakeFetch;
  A = await import("/ui/js/adapter-mode.js");
  logp = await import("/ui/js/panel-log.js");
  settings = await import("/ui/js/settings-model.js");
  await import("/ui/js/chat-strings.js");
  act = await import("/ui/js/chat-activity.js");
  ({ appStore } = await import("/assets/app-store.js"));
  base.restore();
});
afterEach(async () => {
  for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); }
  calls = []; stepAnswers = []; ticks.clear(); permissionAnswer = { status: 200, body: { ok: true } };
});

/** Several pages in one test: each is let go (unmounted, its DOM removed) before the next. */
async function release(pg: AppPage) { await pg.unmount(); pg.restore(); mounted.splice(mounted.indexOf(pg), 1); }
async function mountOnly(vnode: unknown, lang = "en") {
  const pg = page({ url: "http://127.0.0.1:19280/ui", storage: { agend_tour_done: "1", agend_lang: lang } });
  mounted.push(pg);
  (globalThis as any).fetch = fakeFetch;
  (await import("/assets/app-i18n.js")).setLang(lang);
  await pg.mount(vnode);
  return pg;
}
const text = (el: any) => (el ? el.textContent.replace(/\s+/g, " ").trim() : null);

describe("what a status row says", () => {
  it("modeOf / paneViewOf: an unset or older row is a terminal agent with a pane", () => {
    expect(A.modeOf({})).toBe("tmux");
    expect(A.modeOf(undefined)).toBe("tmux");
    expect(A.modeOf({ cli_adapter: "acp" })).toBe("acp");
    expect(A.paneViewOf({})).toBe(true);
    expect(A.paneViewOf(undefined)).toBe(true);
    expect(A.paneViewOf({ pane_view: true })).toBe(true);
    expect(A.paneViewOf({ pane_view: false })).toBe(false);
  });
  it("adaptersOf: the backend's own list from /ui/backends, the terminal alone when the server does not say", () => {
    const rows = [{ name: "grok", adapters: ["tmux", "acp"] }, { name: "claude-code", adapters: ["tmux"] }, { name: "codex" }];
    expect(A.adaptersOf(rows, "grok")).toEqual(["tmux", "acp"]);
    expect(A.adaptersOf(rows, "claude-code")).toEqual(["tmux"]);
    expect(A.adaptersOf(rows, "codex")).toEqual(["tmux"]);
    expect(A.adaptersOf(rows, "missing")).toEqual(["tmux"]);
    expect(A.adaptersOf(null, "grok")).toEqual(["tmux"]);
  });
  it("effectiveMode: acp only while the backend offers it", () => {
    expect(A.effectiveMode("acp", ["tmux", "acp"])).toBe("acp");
    expect(A.effectiveMode("acp", ["tmux"])).toBe("tmux");
    expect(A.effectiveMode("tmux", ["tmux", "acp"])).toBe("tmux");
    expect(A.effectiveMode(undefined, ["tmux", "acp"])).toBe("tmux");
  });
  it("terminal controls of an agent without a pane say why they are off", () => {
    expect(A.noPaneReason({ pane_view: false })).toBe("No terminal: this agent runs over ACP.");
    expect(A.noPaneReason({ pane_view: true })).toBeUndefined();
    expect(A.noPaneReason({})).toBeUndefined();
  });
});

describe("the execution-mode fields", () => {
  const fields = (props: Record<string, unknown>) => h(A.ExecutionModeFields, { adapters: ["tmux", "acp"], mode: "tmux", approve: false, onMode() {}, onApprove() {}, ...props });
  it("nothing for a backend that only runs in a terminal", async () => {
    const pg = await mountOnly(fields({ adapters: ["tmux"] }));
    expect(pg.root.querySelector(".exec-mode")).toBeNull();
    expect(pg.root.querySelector("select")).toBeNull();
  });
  it("a select with Terminal (tmux) and ACP (no terminal), and a hint saying what ACP is", async () => {
    const pg = await mountOnly(fields({}));
    expect(text(pg.root.querySelector("label"))).toBe("Execution mode");
    expect(pg.root.querySelectorAll("select option").map((o: any) => [o.value, text(o)])).toEqual([["tmux", "Terminal (tmux)"], ["acp", "ACP (no terminal)"]]);
    expect(text(pg.root.querySelector(".exec-mode .note"))).toMatch(/live thinking and tool progress in chat.*permission in chat.*no terminal view and no attach/);
    expect(pg.root.querySelector(".exec-approve")).toBeNull();
  });
  it("choosing a mode reports it", async () => {
    const seen: string[] = [];
    const pg = await mountOnly(fields({ onMode: (v: string) => seen.push(v) }));
    const select = pg.root.querySelector("select") as any;
    select.value = "acp"; fire(select, "change"); await settle();
    expect(seen).toEqual(["acp"]);
  });
  it("with acp: the approve-all checkbox, off by default, with a warning-styled hint", async () => {
    const seen: boolean[] = [];
    const pg = await mountOnly(fields({ mode: "acp", onApprove: (v: boolean) => seen.push(v) }));
    const box = pg.root.querySelector(".exec-approve input[type=checkbox]") as any;
    expect(box).not.toBeNull();
    expect(!!box.checked).toBe(false);
    expect(text(pg.root.querySelector(".exec-approve label"))).toBe("Always approve tool permissions");
    const hint = pg.root.querySelector(".exec-approve .exec-warn");
    expect(text(hint)).toMatch(/^Warning: .*without asking you/);
    box.checked = true; fire(box, "change"); await settle();
    expect(seen).toEqual([true]);
  });
  it("a mode the backend no longer offers reads as the terminal, with no approve-all", async () => {
    const pg = await mountOnly(fields({ adapters: ["tmux", "acp"], mode: "acp" }));
    expect(pg.root.querySelector(".exec-approve")).not.toBeNull();
    await release(pg);
    const pg2 = await mountOnly(fields({ adapters: ["tmux"], mode: "acp" }));
    expect(pg2.root.querySelector(".exec-approve")).toBeNull();
  });
  it("in Traditional Chinese", async () => {
    const pg = await mountOnly(fields({ mode: "acp" }), "zh-TW");
    expect(text(pg.root.querySelector("label"))).toBe("執行模式");
    expect(pg.root.querySelectorAll("select option").map((o: any) => text(o))).toEqual(["終端機（tmux）", "ACP（沒有終端機）"]);
    expect(text(pg.root.querySelector(".exec-approve label"))).toBe("一律允許工具權限");
  });
});

describe("the mode badge", () => {
  it("ACP for an acp agent; nothing for a terminal one", async () => {
    const pg = await mountOnly(h("div", {}, h(A.ModeBadge, { inst: { cli_adapter: "acp" } }), h("i", { class: "other" }, h(A.ModeBadge, { inst: {} }))));
    expect(pg.root.querySelectorAll(".mode-badge").map((b: any) => [text(b), b.getAttribute("title")])).toEqual([["ACP", expect.stringContaining("no terminal")]]);
    expect(pg.root.querySelector(".other .mode-badge")).toBeNull();
  });
});

describe("the confirmation before a switch", () => {
  it("says the terminal screen is lost going to ACP, and what goes away coming back", async () => {
    const { confirmStore } = await import("/assets/ui-confirm.js");
    const toAcp = A.confirmModeSwitch("web-dev", "acp");
    const first = confirmStore.get().queue[0];
    expect(first.message).toMatch(/web-dev will restart in ACP mode.*terminal screen will be lost.*depends on the CLI/);
    expect(first.confirmLabel).toBe("Switch and restart");
    const { answerConfirm } = await import("/assets/ui-confirm.js");
    answerConfirm(first.id, true);
    expect(await toAcp).toBe(true);
    const toTmux = A.confirmModeSwitch("web-dev", "tmux");
    const second = confirmStore.get().queue[0];
    expect(second.message).toMatch(/restart in a terminal.*[Ll]ive thinking and permission buttons go away and a terminal appears.*depends on the CLI/);
    answerConfirm(second.id, false);
    expect(await toTmux).toBe(false);
  });
});

describe("the settings form patch", () => {
  const grok = { backend: "grok", working_directory: "/w" };
  it("a terminal agent's form carries tmux and sends nothing for it", () => {
    const form = settings.agentForm(grok, {});
    expect(form).toMatchObject({ cli_adapter: "tmux", acp_always_approve: false });
    expect(settings.agentPatch(form, grok, {}, null, null)).toEqual({});
  });
  it("switching to acp sends cli_adapter; approve-all only with it", () => {
    const form = settings.agentForm(grok, {});
    expect(settings.agentPatch({ ...form, cli_adapter: "acp" }, grok, {}, null, null)).toEqual({ cli_adapter: "acp" });
    expect(settings.agentPatch({ ...form, cli_adapter: "acp", acp_always_approve: true }, grok, {}, null, null)).toEqual({ cli_adapter: "acp", acp_always_approve: true });
    expect(settings.agentPatch({ ...form, cli_adapter: "tmux", acp_always_approve: true }, grok, {}, null, null)).toEqual({});
  });
  it("switching back removes both (null), and an untouched acp form sends nothing", () => {
    const acp = { ...grok, cli_adapter: "acp", acp_always_approve: true };
    const form = settings.agentForm(acp, {});
    expect(form).toMatchObject({ cli_adapter: "acp", acp_always_approve: true });
    expect(settings.agentPatch(form, acp, {}, null, null)).toEqual({});
    expect(settings.agentPatch({ ...form, cli_adapter: "tmux" }, acp, {}, null, null)).toEqual({ cli_adapter: null, acp_always_approve: null });
    expect(settings.agentPatch({ ...form, acp_always_approve: false }, acp, {}, null, null)).toEqual({ acp_always_approve: null });
  });
});

const step = (id: string, o: Record<string, unknown>) => ({ id, turn: "t1", ts: Date.parse("2026-10-13T08:00:00Z"), ...o });
const OPTIONS = [
  { id: "o-allow", name: "Allow once", kind: "allow_once" }, { id: "o-always", name: "Always allow", kind: "allow_always" },
  { id: "o-deny", name: "Reject", kind: "reject_once" }, { id: "o-never", name: "Always reject", kind: "reject_always" },
];
const pendingStep = (o: Record<string, unknown> = {}) => step("req-1", { kind: "permission", status: "running", tool: "run_command", subject: "rm -rf build", body: "Run a shell command", options: OPTIONS, ...o });

describe("a permission request", () => {
  const card = (s: unknown) => h(A.PermissionCard, { step: s, instance: "web dev", fetcher: (u: string, o: unknown) => fetch(u, o as never) });
  const buttons = (pg: AppPage) => Object.fromEntries(pg.root.querySelectorAll(".perm-actions button").map((b: any) => [text(b), !b.disabled]));
  it("shows what it wants and offers Allow, Deny and Cancel turn while it waits", async () => {
    const pg = await mountOnly(card(pendingStep()));
    expect(text(pg.root.querySelector(".perm-what"))).toBe("Wants to use run_command rm -rf build");
    expect(text(pg.root.querySelector(".perm-title"))).toBe("Run a shell command");
    expect(buttons(pg)).toEqual({ Allow: true, Deny: true, "Cancel turn": true });
    expect(pg.root.querySelectorAll(".perm-actions button")).toHaveLength(3);          // never an *_always choice
    expect(text(pg.root.querySelector(".perm-waiting"))).toBe("Waiting for you");
  });
  it("Allow answers POST /ui/permission with the request id and 'allow'; Deny 'deny'; Cancel turn 'cancel'", async () => {
    for (const [label, decision] of [["Allow", "allow"], ["Deny", "deny"], ["Cancel turn", "cancel"]] as const) {
      calls = [];
      const pg = await mountOnly(card(pendingStep()));
      (pg.root.querySelectorAll(".perm-actions button").find((b: any) => text(b) === label) as any).click(); await settle(6);
      expect(calls).toEqual([{ method: "POST", url: "/ui/permission", body: { instance: "web dev", request_id: "req-1", decision } }]);
      // Sent: the buttons stay off until the step itself says it was answered.
      expect(Object.values(buttons(pg))).toEqual([false, false, false]);
      expect(text(pg.root.querySelector(".perm-sending"))).toBe("Answer sent…");
      await release(pg);
    }
  });
  it("a second press while one is on its way sends nothing more", async () => {
    const pg = await mountOnly(card(pendingStep()));
    const allow = pg.root.querySelector(".perm-allow") as any;
    allow.click(); allow.click(); await settle(6);
    expect(calls.filter(c => c.url === "/ui/permission")).toHaveLength(1);
  });
  it("an error from the server shows inline and the buttons come back", async () => {
    permissionAnswer = { status: 404, body: { error: "no such request" } };
    const pg = await mountOnly(card(pendingStep()));
    (pg.root.querySelector(".perm-allow") as any).click(); await settle(6);
    expect(text(pg.root.querySelector(".perm-error"))).toBe("Could not send the answer: no such request");
    expect(buttons(pg)).toEqual({ Allow: true, Deny: true, "Cancel turn": true });
  });
  it("a network failure shows inline too", async () => {
    const pg = await mountOnly(h(A.PermissionCard, { step: pendingStep(), instance: "w", fetcher: async () => { throw new Error("offline"); } }));
    (pg.root.querySelector(".perm-deny") as any).click(); await settle(6);
    expect(text(pg.root.querySelector(".perm-error"))).toBe("Could not send the answer: offline");
  });
  it("answered: every button is off and the outcome is the step's note", async () => {
    const pg = await mountOnly(card(pendingStep({ status: "done", note: "Allow once" })));
    expect(Object.values(buttons(pg))).toEqual([false, false, false]);
    expect(text(pg.root.querySelector(".perm-outcome"))).toBe("Answered: Allow once");
    expect(pg.root.querySelector(".perm-waiting")).toBeNull();
    (pg.root.querySelector(".perm-allow") as any).click(); await settle(4);
    expect(calls).toEqual([]);
  });
  it("a cancelled turn says so", async () => {
    const pg = await mountOnly(card(pendingStep({ status: "done", note: "cancelled" })));
    expect(text(pg.root.querySelector(".perm-outcome"))).toBe("Turn cancelled");
  });
  it("Allow or Deny is off, with why, when the CLI did not offer that once-only choice; Cancel turn still works", async () => {
    const onlyAlways = OPTIONS.filter(o => o.kind.endsWith("_always"));
    const pg = await mountOnly(card(pendingStep({ options: onlyAlways })));
    expect(buttons(pg)).toEqual({ Allow: false, Deny: false, "Cancel turn": true });
    expect(pg.root.querySelector(".perm-allow")?.getAttribute("title")).toBe("The CLI did not offer this choice");
    expect(A.permissionChoices(pendingStep({ options: onlyAlways }))).toEqual({ allow: null, deny: null });
    expect(A.permissionChoices(pendingStep())).toEqual({ allow: OPTIONS[0], deny: OPTIONS[2] });
    expect(A.permissionChoices({})).toEqual({ allow: null, deny: null });
  });
  it("in Traditional Chinese", async () => {
    const pg = await mountOnly(card(pendingStep()), "zh-TW");
    expect(Object.keys(buttons(pg))).toEqual(["允許", "拒絕", "取消這一輪"]);
    expect(text(pg.root.querySelector(".perm-waiting"))).toBe("等你決定");
  });
});

describe("a permission request in the rows both pages share (log-row.js)", () => {
  let R: any;
  beforeAll(async () => { R = await import("/ui/js/log-row.js"); });
  it("the Log's row: the card under a Permission head with its status", async () => {
    const pg = await mountOnly(h(R.LogRow, { x: pendingStep(), instance: "agy", fetcher: async () => ({ ok: true, status: 200, json: async () => ({}) }) }));
    expect(pg.root.querySelector(".log-item.k-permission.s-running")).not.toBeNull();
    expect(text(pg.root.querySelector(".log-head"))).toContain("Permission");
    expect(text(pg.root.querySelector(".perm-what"))).toBe("Wants to use run_command rm -rf build");
  });
  it("the chat block's compact row carries the same card, answering for the instance it was given", async () => {
    calls = [];
    const pg = await mountOnly(h(R.LogRow, { x: pendingStep(), instance: "agy", chat: true, compact: true }));
    expect(pg.root.querySelector(".log-item.compact.k-permission")).not.toBeNull();
    (pg.root.querySelector(".perm-allow") as any).click(); await settle(6);
    expect(calls).toEqual([{ method: "POST", url: "/ui/permission", body: { instance: "agy", request_id: "req-1", decision: "allow" } }]);
  });
  it("the chat's live block opens by itself while a request waits for a person, and a finished one stays shut", async () => {
    const group = (over: Record<string, unknown>, items: unknown[]) => ({ key: "act:1:0", turn: "1", n: 0, level: "id", rowKey: null, items, trailing: [], ts: 1, from: 1, to: 2, ended: false, turnEnded: false, busy: true, ...over });
    const ctx = { instance: "agy", paths: null, thinking: true };
    const waiting = await mountOnly(h(act.ActivityBlock, { group: group({}, [pendingStep()]), ctx, now: 1000 }));
    expect(text(waiting.root.querySelector(".act-title"))).toBe("Permission: rm -rf build");
    expect(waiting.root.querySelector(".act-block")?.open).toBe(true);
    expect(waiting.root.querySelector(".perm-allow")).not.toBeNull();
    await release(waiting);
    const done = await mountOnly(h(act.ActivityBlock, { group: group({ ended: true, turnEnded: true, busy: false }, [pendingStep({ status: "done", note: "Allow once" })]), ctx, now: 1000 }));
    expect(done.root.querySelector(".act-block")?.open).toBe(false);
    await release(done);
    const quiet = await mountOnly(h(act.ActivityBlock, { group: group({}, [step("toolu_1", { kind: "tool", tool: "Read", cat: "read", subject: "a.ts", status: "running" })]), ctx, now: 1000 }));
    expect(quiet.root.querySelector(".act-block")?.open).toBe(false);
  });
  it("its one-line words for the block's header name what it asks to run", () => {
    expect(R.stepLine(pendingStep(), null)).toBe("Permission: rm -rf build");
  });
});

// ── In the Log tab, in the real shell ──

const live = (name: string, o: Record<string, unknown> = {}) => ({ name, status: "running", backend: "grok", model: "grok-4", context_pct: 10, tags: [], execution_state: "idle", cli_adapter: "acp", pane_view: false, ...o });
const ON = (o: Record<string, unknown> = {}) => ({ enabled: true, instance: "agy", backend: "grok", supported: true, key: "1-2", steps: [], events: [], before: null, after: 100, ev: 0, ...o });
const PANELS = () => new Map<string, unknown>([
  ["log", { load: async () => logp.LogPanel }],
  ["chat", { Component: () => h("div", {}, "chat") }], ["view", { Component: () => h("div", {}, "view") }],
  ["details", { Component: () => h("div", {}, "details") }], ["fleet", { Component: () => h("div", {}, "fleet") }],
  ["settings", { Component: () => h("div", {}, "settings") }], ["needs", { Component: () => h("div", {}, "needs") }],
]);
async function logApp(instances: unknown[]) {
  const pg = page({ url: "http://127.0.0.1:19280/ui/log/agy", storage: { agend_tour_done: "1" } });
  mounted.push(pg);
  (globalThis as any).fetch = fakeFetch;
  const { startRouter } = await import("/assets/app-nav.js");
  const { applyStatus } = await import("/assets/app-store.js");
  const { Shell } = await import("/assets/app-shell.js");
  startRouter(pg.window);
  applyStatus({ instances });
  appStore.set({ streamOn: (name: string, fn: (d: unknown) => void) => { if (name !== "steps_tick") return () => {}; ticks.add(fn); return () => ticks.delete(fn); } });
  await pg.mount(h(Shell, { panels: PANELS(), onNewInstance() {} }));
  await settle(8);
  return pg;
}
const tick = async () => { for (const fn of [...ticks]) fn({ instance: "agy" }); await settle(8); };

describe("the Log tab of an ACP agent", () => {
  it("renders thinking and permission requests in the timeline, and a request answers through POST /ui/permission", async () => {
    stepAnswers = [ON({ steps: [
      step("o1", { kind: "user", body: "clean the build" }),
      step("th1", { kind: "thinking", body: "I should remove the build folder." }),
      pendingStep(),
    ] })];
    const pg = await logApp([live("agy")]);
    const items = pg.root.querySelectorAll(".p-log .log-item");
    expect(items.map((li: any) => li.classList.contains("k-thinking") ? "thinking" : li.classList.contains("k-permission") ? "permission" : "other")).toEqual(["other", "thinking", "permission"]);
    expect(text(pg.root.querySelector(".p-log .k-thinking .log-think"))).toContain("I should remove the build folder");
    const permission = pg.root.querySelector(".p-log .k-permission") as any;
    expect(text(permission.querySelector(".log-head"))).toContain("Permission");
    expect(text(permission.querySelector(".perm-what"))).toBe("Wants to use run_command rm -rf build");
    (permission.querySelector(".perm-allow") as any).click(); await settle(6);
    expect(calls.filter(c => c.url === "/ui/permission")).toEqual([{ method: "POST", url: "/ui/permission", body: { instance: "agy", request_id: "req-1", decision: "allow" } }]);
    // The server answers the step (a tick, then the same step done): the outcome replaces the buttons' wait.
    stepAnswers = [ON({ steps: [pendingStep({ status: "done", note: "Allow once" })] })];
    await tick();
    const after = pg.root.querySelector(".p-log .k-permission") as any;
    expect(after.classList.contains("s-done")).toBe(true);
    expect(text(after.querySelector(".perm-outcome"))).toBe("Answered: Allow once");
    expect(Object.values(Object.fromEntries(after.querySelectorAll(".perm-actions button").map((b: any) => [text(b), !b.disabled])))).toEqual([false, false, false]);
  });
  it("the Tools filter keeps permission requests (they are what the agent waits on)", async () => {
    stepAnswers = [ON({ steps: [step("th1", { kind: "thinking", body: "hm" }), pendingStep(), step("toolu_1", { kind: "tool", tool: "Read", cat: "read", subject: "a.ts", status: "done" })] })];
    const pg = await logApp([live("agy")]);
    const chip = pg.root.querySelectorAll(".p-log .log-bar .chip-btn").find((b: any) => text(b) === "Tools") as any;
    chip.click(); await settle(4);
    expect(pg.root.querySelectorAll(".p-log .log-item").map((li: any) => li.className.match(/k-(\w+)/)[1])).toEqual(["permission", "tool"]);
  });
});

describe("a terminal agent's View tab, and one without a pane", () => {
  const tabs = (pg: AppPage) => pg.root.querySelectorAll(".inst-switch .seg-item").map((el: any) => [text(el), el.tagName.toLowerCase(), el.getAttribute("aria-disabled") ?? null, el.getAttribute("title") ?? null]);
  it("a terminal agent's tabs are all links", async () => {
    stepAnswers = [ON()];
    const pg = await logApp([live("agy", { cli_adapter: "tmux", pane_view: true })]);
    expect(tabs(pg)).toEqual([["Chat", "a", null, null], ["View", "a", null, null], ["Log", "a", null, null], ["Settings", "a", null, null]]);
  });
  it("an agent with no pane has View switched off, with why", async () => {
    stepAnswers = [ON()];
    const pg = await logApp([live("agy")]);
    expect(tabs(pg)).toEqual([["Chat", "a", null, null], ["View", "span", "true", "No terminal: this agent runs over ACP."], ["Log", "a", null, null], ["Settings", "a", null, null]]);
  });
  it("an older server's row (no pane_view) keeps View", async () => {
    stepAnswers = [ON()];
    const { cli_adapter: _a, pane_view: _p, ...old } = live("agy") as Record<string, unknown>;
    const pg = await logApp([old]);
    expect(tabs(pg)[1]).toEqual(["View", "a", null, null]);
  });
});

describe("the sidebar", () => {
  it("an ACP agent's row carries the ACP badge and says so in its tooltip; a terminal agent's does not", async () => {
    stepAnswers = [ON()];
    const pg = await logApp([live("agy"), live("plain", { cli_adapter: "tmux", pane_view: true })]);
    const rows = pg.root.querySelectorAll("#instanceList a.inst");
    const by = (name: string) => rows.find((a: any) => a.getAttribute("href").endsWith(`/${name}`)) as any;
    expect(text(by("agy").querySelector(".mode-badge"))).toBe("ACP");
    expect(by("agy").getAttribute("title")).toContain("Mode: ACP (no terminal)");
    expect(by("plain").querySelector(".mode-badge")).toBeNull();
    expect(by("plain").getAttribute("title")).not.toContain("Mode:");
  });
});

describe("View of an agent with no terminal", () => {
  const ROSTER = [{ instance_name: "agy", display_name: "Agy", status: "running", context_pct: 1, model: "m", backend: "grok", tags: [], has_avatar: false, role: "dev", description: "d" }];
  async function viewOf(frame: Record<string, unknown>, dataset: Record<string, string> = {}) {
    const pg = page({ url: "http://127.0.0.1:19280/view/agy", storage: { agend_tour_done: "1" } });
    mounted.push(pg);
    for (const [k, v] of Object.entries(dataset)) (pg.document as any).body.dataset[k] = v;
    const g = globalThis as any;
    g.fetch = async (u: string, init: { method?: string; body?: string } = {}) => {
      calls.push({ method: init.method || "GET", url: u });
      if (u === "/api/profiles") return { ok: true, status: 200, json: async () => ROSTER };
      if (u.startsWith("/api/pane/")) return { ok: true, status: 200, headers: { get: () => null }, text: async () => "PANE" };
      return { ok: false, status: 404, json: async () => ({}) };
    };
    g.getComputedStyle = () => ({ paddingLeft: "6px", paddingRight: "6px", paddingTop: "5px", paddingBottom: "5px", fontFamily: "monospace", fontSize: "1px", lineHeight: "1.2" });
    g.ResizeObserver = class { observe() {} disconnect() {} };
    const view = await import("/assets/panel-view.js");
    const { applyStatus } = await import("/assets/app-store.js");
    applyStatus({ instances: [live("agy", frame)] });
    await pg.mount(h(view.ViewPanel, { route: { panel: "view", instance: "agy" }, navKey: "k1" }));
    await settle(10);
    return pg;
  }
  it("pane_view false: no pane is ever read; the page says why and points to the Log", async () => {
    const pg = await viewOf({});
    expect(calls.filter(c => c.url.startsWith("/api/pane/"))).toEqual([]);
    expect(pg.root.querySelector(".v-term")).toBeNull();
    expect(text(pg.root.querySelector(".v-nopane .note"))).toMatch(/runs over ACP, so it has no terminal to show.*Log/);
    expect(pg.root.querySelector(".v-nopane a")?.getAttribute("href")).toBe("/settings/web-dashboard");
  });
  it("with the Log tab on, the link goes to the agent's Log", async () => {
    const pg = await viewOf({}, { logTab: "1" });
    expect(pg.root.querySelector(".v-nopane a")?.getAttribute("href")).toBe("/ui/log/agy");
  });
  it("a terminal agent's View still reads its pane", async () => {
    const pg = await viewOf({ cli_adapter: "tmux", pane_view: true });
    expect(calls.some(c => c.url === "/api/pane/agy")).toBe(true);
    expect(pg.root.querySelector(".v-term")).not.toBeNull();
    expect(pg.root.querySelector(".v-nopane")).toBeNull();
  });
});
