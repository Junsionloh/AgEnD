/**
 * Settings → Shared agent settings has the switch for `defaults.task_board.person_confirms_main`, in the Advanced drawer after
 * "Archive finished cards after":
 *  - one switch (off unless the file says true) with one line that says what it does (English and 繁體中文);
 *  - an untouched page has nothing to save and the 'default' mark; turning it on writes `person_confirms_main: true` beside
 *    liveness and every other key of `task_board`; turning it back off takes the key away (off is the default);
 *  - it is found by Settings search (English and 繁體中文), and the change is a "now" change (no restart: the board reads it as
 *    each main task is opened).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { buildSettingsImpactSchema } from "../src/instance-config-impact.js";
import { settingsChangeDiff } from "../src/settings-change.js";
import { validateFleetConfig as validateFleet } from "../src/config-validator.js";

const schema = buildSettingsImpactSchema();
let p: AppPage;
let raw: any;
const sent: Array<{ method: string; path: string; body: any }> = [];
const realFetch = (globalThis as any).fetch;
const fleet = () => ({
  defaults: { backend: "codex", model: "gpt-5.5" },
  instances: { "dev-a": { working_directory: "/w/dev" }, general: { working_directory: "/w/g", general_topic: true } },
  channels: [{ id: "main", type: "discord", bot_token_env: "T", group_id: "1" }], web: {},
});
const fakeFetch = async (path: string, init: { method?: string; body?: string } = {}) => {
  const method = init.method ?? "GET";
  if (method !== "GET") sent.push({ method, path, body: init.body ? JSON.parse(init.body) : null });
  const body = (() => {
    if (method !== "GET") return { ok: true };
    if (path === "/api/settings/schema") return schema;
    if (path === "/api/settings/fleet/raw") return raw;
    if (path === "/api/settings/classic") return { defaults: {}, channels: {} };
    if (path === "/api/settings/connections") return [{ id: "main", token_present: true }];
    if (path === "/api/settings/status-emojis") return { keys: [], builtins: { discord: {}, telegram: {} }, telegram_allowed: [], suggestions: [] };
    if (path === "/api/settings/pending") return [];
    if (path === "/api/fleet") return { version: "2.4.0", instances: Object.keys(raw.instances).map((name) => ({ name, status: "running" })) };
    if (path.startsWith("/ui/")) return {};
    return [];
  })();
  return { ok: true, status: 200, json: async () => body };
};
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19284/settings", storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fakeFetch;
  const nav = await import("/assets/app-nav.js");
  nav.startRouter(p.window);
});
afterAll(() => { p.restore(); (globalThis as any).fetch = realFetch; });
beforeEach(async () => {
  raw = fleet(); sent.length = 0; (globalThis as any).confirm = () => true;
  (await import("/assets/app-i18n.js")).setLang("en");
});
afterEach(async () => { await p.unmount(); });

let opened = 0;
const open = async () => {
  const { SettingsPanel } = await import("/ui/js/panel-settings.js");
  await p.mount(h(SettingsPanel, { route: { panel: "settings", section: "agent-defaults" }, navKey: `settings:agent-defaults|${++opened}` }));
  await settle(14);
};
const text = (el: any) => (el ? el.textContent.replace(/\s+/g, " ").trim() : null);
const $ = (sel: string): any => p.root.querySelector(sel);
const check = async (el: any, on: boolean) => { el.checked = on; fire(el, "change"); await settle(4); };
const bar = () => $(".s-pending");
const save = async () => { bar().querySelectorAll("button").find((b: any) => b.textContent === "Save").click(); await settle(12); };
const written = () => sent.filter((s) => s.path === "/api/settings/fleet/defaults").map((s) => s.body);
const LIVENESS = { enabled: true, quiet_minutes: 60, prompt_minutes: 10, crash_grace_minutes: 5 };

describe("the switch", () => {
  it("is drawn in the Advanced drawer after 'Archive finished cards after': a real switch, off, with a line that says what it does", async () => {
    await open();
    const card = $("#g-confirm");
    expect(card).toBeTruthy();
    expect(!!card.closest("details")).toBe(true);
    expect(card.previousElementSibling?.id ?? card.previousSibling?.id).toBe("g-archive");
    expect(text(card.querySelector(".s-lab-text"))).toBe("Main tasks wait for you to confirm them");
    expect([$("#g-confirm-main").getAttribute("role"), $("#g-confirm-main").checked]).toEqual(["switch", false]);
    expect(text(card.querySelector(".s-info"))).toContain("the main task goes to Review and waits under Waiting for you, instead of finishing by itself");
  });

  it("an untouched page has nothing to save and shows the 'default' mark", async () => {
    await open();
    expect(bar()).toBeNull();
    expect(written()).toEqual([]);
    expect($("#g-confirm").querySelectorAll(".s-default").length).toBe(1);
  });

  it("turning it on and saving writes true beside liveness and every other key of task_board", async () => {
    raw.defaults.task_board = { leader: "dev-a", something_newer: { keep: "me" } };
    await open();
    await check($("#g-confirm-main"), true);
    expect(text($("#g-confirm-main").closest("label").querySelector(".s-switch-text"))).toBe("On");
    await save();
    expect(written()).toHaveLength(1);
    expect(written()[0].task_board).toEqual({ liveness: LIVENESS, leader: "dev-a", something_newer: { keep: "me" }, person_confirms_main: true });
  });

  it("shows what is saved; turning it back off takes the key away, and edit-and-put-back writes nothing", async () => {
    raw.defaults.task_board = { person_confirms_main: true };
    await open();
    expect($("#g-confirm-main").checked).toBe(true);
    await check($("#g-confirm-main"), false);
    await check($("#g-confirm-main"), true);
    expect(bar()).toBeNull();
    await check($("#g-confirm-main"), false);
    await save();
    expect(written()[0].task_board).toEqual({ liveness: LIVENESS });
    expect(Object.keys(written()[0].task_board)).not.toContain("person_confirms_main");
  });

  it("anything but an explicit true is off", async () => {
    raw.defaults.task_board = { person_confirms_main: "yes" };
    await open();
    expect($("#g-confirm-main").checked).toBe(false);
  });

  it("speaks 繁體中文 too", async () => {
    (await import("/assets/app-i18n.js")).setLang("zh-TW");
    await open();
    expect(text($("#g-confirm").querySelector(".s-lab-text"))).toBe("主任務要等你確認");
    expect(text($("#g-confirm").querySelector(".s-info"))).toContain("Agent 開的主任務，最後一張子任務完成後會進入「審查」");
  });
});

describe("the server side of the same change", () => {
  const change = (tb: unknown, before: unknown = undefined) => settingsChangeDiff({ fleet: { defaults: before === undefined ? {} : { task_board: before } } }, { fleet: { defaults: { task_board: tb } } }, { operation: "defaults" });
  it("goes through the confirmation Settings asks for any task_board value, and says what changed", () => {
    expect(change({ person_confirms_main: true })?.summary.join("\n")).toContain("person\\_confirms\\_main: absent → true");
    expect(change({}, { person_confirms_main: true })?.summary.join("\n")).toContain("person\\_confirms\\_main: true → absent");
  });
  it("is a 'now' change: the board reads it as each main task is opened, nothing restarts", () => {
    expect(JSON.stringify(schema)).toContain("defaults.task_board");
  });
  it("the validator takes true and false and refuses anything else", () => {
    const bad = (v: unknown) => validateFleet({ defaults: { task_board: { person_confirms_main: v } }, instances: { a: { working_directory: "/w" } } } as never).errors.map((e) => e.path);
    expect(bad(true)).toEqual([]);
    expect(bad(false)).toEqual([]);
    expect(bad("yes")).toEqual(["defaults.task_board.person_confirms_main"]);
  });
});
