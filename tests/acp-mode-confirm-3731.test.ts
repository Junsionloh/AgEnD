/**
 * #3731: changing an existing agent's execution mode (`cli_adapter`) restarts it, so every place that can send that change asks
 * first, and answering no sends nothing. The entries: the agent page's Runtime & model (/ui/fleet/agent/<name>) and the
 * Settings page's agent dialog (Done, then Save). The create wizard only makes new agents (nothing restarts), and no other
 * module stages `cli_adapter` (checked below by reading the sources).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
import { fire, installDom } from "./helpers/mini-dom.js";

const mounted: AppPage[] = [];
let calls: string[] = [];
let bodies: Array<{ url: string; body: any }> = [];
let webDevExtra: Record<string, unknown> = {};
const live = (name: string, o: Record<string, unknown> = {}) => ({ name, status: "running", backend: "grok", model: "grok-4", context_pct: 10, tags: [], execution_state: "idle", ...o });
const DETAIL = (name: string) => ({ name, status: "running", description: "Builds the site", display_name: "Web developer", working_directory: "/w/web", backend: "grok",
  tags: [], binding: { channel_id: "discord-2", topic_id: "1234", general_topic: false }, model: "grok-4", model_source: "live", effort: null, context_pct: 42, statusline: {}, recent_activity: [] });

async function fakeFetch(url: string, init: { method?: string; body?: string } = {}) {
  const m = init.method || "GET";
  calls.push(`${m} ${url}`);
  if (m !== "GET" && init.body) { try { bodies.push({ url, body: JSON.parse(init.body) }); } catch { /* not JSON */ } }
  const SETTINGS: Record<string, unknown> = {
    "/api/settings/schema": { impacts: {}, order: ["now", "instance", "fleet"] },
    "/api/settings/fleet/raw": { defaults: {}, channels: [], instances: { "web-dev": { working_directory: "/w/web", description: "Builds the site", backend: "grok", ...webDevExtra } } },
    "/api/settings/classic": { defaults: {}, channels: {} }, "/api/settings/connections": [],
    "/api/settings/status-emojis": { keys: [], builtins: { discord: {}, telegram: {} }, telegram_allowed: [], suggestions: [] }, "/api/fleet": { version: "2.2.0", instances: [{ name: "web-dev", status: "running" }] },
    "/api/profiles": [{ instance_name: "web-dev", status: "running", backend: "grok", tags: [] }], "/api/settings/pending": [],
    "/ui/backends": { backends: [{ name: "grok", state: "ready", adapters: ["tmux", "acp"] }] },
  };
  if (m === "GET" && Object.prototype.hasOwnProperty.call(SETTINGS, url)) return { ok: true, status: 200, json: async () => structuredClone(SETTINGS[url]), text: async () => "" };
  const body: unknown = url === "/ui/instance/web-dev" ? DETAIL("web-dev") : m === "POST" || m === "PATCH" ? { ok: true } : {};
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

let details: any, chat: any, req: any, confirmMod: any;
beforeAll(async () => {
  // @ts-expect-error — a JS module of the app, with no types
  await import("../src/ui/chat-render.js");
  // @ts-expect-error — a JS module of the app, with no types
  await import("../src/ui/preview.js");
  const base = installDom({ storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fakeFetch;
  // @ts-expect-error — a JS module of the app, with no types
  chat = await import("../src/ui/panel-chat.js");
  // @ts-expect-error — a JS module of the app, with no types
  details = await import("../src/ui/panel-details.js");
  // @ts-expect-error — a JS module of the app, with no types
  req = await import("../src/ui/settings-request.js");
  confirmMod = await import("/assets/ui-confirm.js");
  chat.boot({ stream: { on() {} }, boot: null, deps: { fetch: () => new Promise(() => {}) } });
  base.restore();
});
afterEach(async () => {
  for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); }
  (await import("/assets/app-store.js")).appStore.set({ viewOnly: false });
  req.takeAgentRequest();
  webDevExtra = {}; calls = []; bodies = [];
  for (const q of [...confirmMod.confirmStore.get().queue]) confirmMod.answerConfirm(q.id, false);
});

const PANELS = () => new Map([
  ["chat", { load: async () => chat.ChatPanel }], ["details", { load: async () => details.DetailsPanel }],
  ["view", { Component: () => h("div", {}, "view") }], ["fleet", { Component: () => h("div", {}, "fleet") }],
  ["settings", { Component: () => h("div", {}, "settings") }], ["needs", { Component: () => h("div", {}, "needs") }],
]);
const patches = () => bodies.filter(b => b.url === "/api/settings/fleet/instances/web-dev");
const untilRead = async () => { for (let i = 0; i < 80 && !calls.includes("GET /api/settings/fleet/raw"); i++) await new Promise(r => setTimeout(r, 100)); };
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
const questions = () => confirmMod.confirmStore.get().queue as Array<{ id: number; message: string; confirmLabel?: string }>;
/** Wait for a question to be on screen, answer it, and say what it asked. */
async function answer(yes: boolean) {
  for (let i = 0; i < 60 && !questions().length; i++) await pause(50);
  const q = questions()[0];
  expect(q, "a question is on screen").toBeDefined();
  confirmMod.answerConfirm(q.id, yes);
  await pause(250); await settle(10);
  return q.message;
}

/** The agent page, Runtime & model: pick `mode`, and press the page's Save. */
async function pagePick(mode: string) {
  const pg = page({ url: "http://127.0.0.1:19280/ui/fleet/agent/web-dev?cat=runtime", storage: { agend_tour_done: "1" } });
  mounted.push(pg);
  (globalThis as any).confirm = undefined;                   // the dialog itself is driven (see tests/helpers/app-harness.ts)
  (globalThis as any).fetch = fakeFetch;
  const { startRouter } = await import("/assets/app-nav.js");
  const { applyStatus } = await import("/assets/app-store.js");
  const { Shell } = await import("/assets/app-shell.js");
  startRouter(pg.window);
  applyStatus({ instances: [live("web-dev", { ...webDevExtra })] });
  await pg.mount(h(Shell, { panels: PANELS(), onNewInstance() {} }));
  await settle(8); await untilRead(); await settle(14);
  const select = pg.root.querySelector("#ag-mode");
  expect(select, "the page has the Execution mode choice").not.toBeNull();
  select.value = mode; fire(select, "change"); await settle(8);
  const bar = () => pg.root.querySelector(".p-details > .s-pending");
  expect(bar(), "staged at once").not.toBeNull();
  const save = async () => { bar().querySelector(".btn-primary").click(); await settle(10); };
  return { pg, bar, save };
}

/** The Settings page's agent dialog: pick `mode`, press Done, then Settings' own Save. */
async function dialogPick(mode: string) {
  // @ts-expect-error — a JS module of the app, with no types
  const S = await import("../src/ui/panel-settings.js");
  const pg = page({ url: "http://127.0.0.1:19280/settings", storage: { agend_tour_done: "1" } });
  mounted.push(pg);
  (globalThis as any).confirm = undefined;
  (globalThis as any).fetch = fakeFetch;
  req.requestAgentSettings("web-dev");
  await pg.mount(h(S.SettingsPanel, { route: { panel: "settings", section: "agents" }, navKey: `settings:agents|mode|${mode}|${Math.random()}` }));
  await settle(10);
  const select = pg.root.querySelector("dialog #ag-mode");
  expect(select, "the dialog has the Execution mode choice").not.toBeNull();
  select.value = mode; fire(select, "change"); await settle(8);
  pg.root.querySelectorAll("dialog .btn-primary").find((b: any) => b.textContent.trim() === "Done").click(); await settle(10);
  // Done only stages: no question yet, nothing written.
  expect(questions(), "Done asks nothing").toHaveLength(0);
  expect(patches()).toHaveLength(0);
  const bar = () => pg.root.querySelector(".s-pending");
  expect(bar(), "staged by Done").not.toBeNull();
  const save = async () => { bar().querySelector(".btn-primary").click(); await settle(10); };
  return { pg, bar, save };
}

describe.each([
  ["the agent page (Runtime & model)", pagePick],
  ["the Settings page's agent dialog", dialogPick],
] as const)("%s", (_name, pick) => {
  it("going to ACP asks first; no sends nothing and keeps the change staged; yes sends it once", async () => {
    const { bar, save } = await pick("acp");
    await save();
    const message = await answer(false);
    expect(message).toMatch(/restart in ACP mode.*terminal screen will be lost/);
    expect(patches(), "declined: nothing written").toHaveLength(0);
    expect(bar(), "declined: still staged").not.toBeNull();
    await save();
    await answer(true);
    for (let i = 0; i < 60 && !patches().length; i++) await pause(50);
    expect(patches()).toHaveLength(1);
    expect(patches()[0].body).toMatchObject({ cli_adapter: "acp" });
  });

  it("going back to the terminal asks too, in its own words, and no sends nothing", async () => {
    webDevExtra = { cli_adapter: "acp" };
    const { save } = await pick("tmux");
    await save();
    const message = await answer(false);
    expect(message).toMatch(/restart in a terminal/);
    expect(patches()).toHaveLength(0);
    await save();
    await answer(true);
    for (let i = 0; i < 60 && !patches().length; i++) await pause(50);
    expect(patches()).toHaveLength(1);
    expect(patches()[0].body.cli_adapter).toBeNull();
  });
});

describe("a change that is not an execution-mode change asks nothing about it", () => {
  it("the agent page: editing the description only sends it, with no mode question", async () => {
    const { pg } = await pagePick("acp");                     // stage the mode…
    // …then put it back, so the only change left is the description
    const select = pg.root.querySelector("#ag-mode"); select.value = "tmux"; fire(select, "change"); await settle(8);
    await go(pg, "basic");
    const desc = pg.root.querySelector("#ag-desc"); desc.value = "Builds the site, faster"; fire(desc, "input"); await settle(8);
    pg.root.querySelector(".p-details > .s-pending .btn-primary").click(); await settle(10);
    for (let i = 0; i < 60 && !patches().length; i++) await pause(50);
    expect(questions()).toHaveLength(0);
    expect(patches()).toHaveLength(1);
    expect(patches()[0].body).toEqual({ description: "Builds the site, faster" });
  });
});
async function go(_pg: AppPage, cat: string) { const { navigate } = await import("/assets/app-nav.js"); navigate(`/ui/fleet/agent/web-dev?cat=${cat}`); await settle(10); }

describe("every module that can send a cli_adapter change is covered", () => {
  it("the only UI modules that name cli_adapter in a write are the form, its patch builder, the create wizard, and the two that stage the change", () => {
    const dir = join(import.meta.dirname, "..", "src", "ui");
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".js") ? [join(d, e.name)] : []);
    const writers = walk(dir).filter(f => /body\.cli_adapter\s*=|cli_adapter\s*:\s*(mode|null|"acp"|"tmux")|out\.cli_adapter\s*=|"cli_adapter" in patch/.test(readFileSync(f, "utf8")))
      .map(f => f.slice(dir.length + 1)).sort();
    // settings-model.js builds the patch; settings-dialogs.js feeds it the form's mode; panel-settings.js and agent-details-settings.js
    // add the question to what they stage. panel-fleet.js is the create wizard: it makes a new agent (POST create; an existing name is refused), so nothing restarts.
    expect(writers).toEqual(["adapter-mode.js", "panel-fleet.js", "panel-settings.js", "settings-dialogs.js", "settings-model.js"]);
    for (const staging of ["panel-settings.js", "agent-details-settings.js"]) {
      expect(readFileSync(join(dir, staging), "utf8"), `${staging} adds the mode question`).toContain("modeConfirms(");
      expect(readFileSync(join(dir, staging), "utf8"), `${staging} asks it before writing`).toContain("askModeConfirm(");
    }
  });
});
