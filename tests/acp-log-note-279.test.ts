/**
 * AGEND-279 (1): an ACP agent's Log never tells the reader to use the View (it has none). Stopped or not signed in, the
 * server says "not running" instead of "unsupported"; and the page, if it ever is told "unsupported" for a pane-less agent,
 * leaves the View sentence out. A terminal agent's text is unchanged.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
import { installDom } from "./helpers/mini-dom.js";

let logp: any, appStore: any;
let stepAnswer: unknown = {};
const mounted: AppPage[] = [];

async function fakeFetch(url: string) {
  const body = url.startsWith("/ui/steps") ? stepAnswer : {};
  return { ok: true, status: 200, json: async () => structuredClone(body), text: async () => JSON.stringify(body) };
}
beforeAll(async () => {
  // @ts-expect-error — a JS module of the app, with no types
  await import("../src/ui/chat-render.js");
  const base = installDom({ storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fakeFetch;
  logp = await import("/ui/js/panel-log.js");
  ({ appStore } = await import("/assets/app-store.js"));
  base.restore();
});
afterEach(async () => { for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); } vi.unstubAllEnvs(); });

const text = (el: any) => (el ? el.textContent.replace(/\s+/g, " ").trim() : null);
const row = (o: Record<string, unknown> = {}) => ({ name: "agy", status: "stopped", backend: "opencode", model: "m", context_pct: 0, tags: [], execution_state: "idle", ...o });
async function logApp(instances: unknown[]) {
  const pg = page({ url: "http://127.0.0.1:19280/ui/log/agy", storage: { agend_tour_done: "1" } });
  mounted.push(pg);
  (globalThis as any).fetch = fakeFetch;
  const { startRouter } = await import("/assets/app-nav.js");
  const { applyStatus } = await import("/assets/app-store.js");
  const { Shell } = await import("/assets/app-shell.js");
  startRouter(pg.window);
  applyStatus({ instances });
  appStore.set({ streamOn: () => () => {} });
  const stub = (n: string) => [n, { Component: () => h("div", {}, n) }] as const;
  await pg.mount(h(Shell, { panels: new Map<string, unknown>([["log", { load: async () => logp.LogPanel }], stub("chat"), stub("view"), stub("details"), stub("fleet"), stub("settings"), stub("needs")]), onNewInstance() {} }));
  await settle(8);
  return pg;
}

describe("the page", () => {
  const UNSUPPORTED = { enabled: true, instance: "agy", backend: "opencode", supported: false, reason: "unsupported", steps: [], events: [], before: null, after: null, ev: 0 };
  it("an agent with a pane keeps the sentence that points at the View", async () => {
    stepAnswer = UNSUPPORTED;
    const pg = await logApp([row({ cli_adapter: "tmux", pane_view: true })]);
    expect(text(pg.root.querySelector(".p-log .log-why"))).toBe("opencode has no transcript AgEnD can read, so this Log shows fleet events only. View shows its screen.");
  });
  it("an agent without a pane (ACP) is not sent to the View", async () => {
    stepAnswer = UNSUPPORTED;
    const pg = await logApp([row({ cli_adapter: "acp", pane_view: false })]);
    const why = text(pg.root.querySelector(".p-log .log-why"));
    expect(why).toBe("opencode has no transcript AgEnD can read, so this Log shows fleet events only.");
    expect(why).not.toMatch(/View/);
  });
});

describe("the server, for an ACP agent that is not running", () => {
  async function fleet(instances: Record<string, unknown>, defaults: Record<string, unknown> = {}) {
    const dir = mkdtempSync(join(tmpdir(), "agend-279-"));
    vi.stubEnv("AGEND_HOME", dir);
    const { FleetManager } = await import("../src/fleet-manager.js");
    const fm = new FleetManager(dir) as any;
    clearInterval(fm.sessionPruneTimer);
    fm.fleetConfig = { defaults, instances, web: { log_tab: true } };
    return fm;
  }
  it("says it is not running, never 'unsupported' and never a stale transcript", async () => {
    const fm = await fleet({ g: { working_directory: "/w/g", backend: "grok", cli_adapter: "acp" }, a: { working_directory: "/w/a", backend: "antigravity", cli_adapter: "acp" } });
    expect(fm.logSource("g")).toEqual({ backend: "grok", path: null, format: null, reason: "not_running" });
    expect(fm.logSource("a")).toEqual({ backend: "antigravity", path: null, format: null, reason: "not_running" });
    expect(await fm.logSteps("g", {})).toMatchObject({ enabled: true, supported: false, reason: "not_running", steps: [] });
  });
  it("also when the mode comes from the defaults", async () => {
    const fm = await fleet({ g: { working_directory: "/w/g", backend: "grok" } }, { cli_adapter: "acp" });
    expect(fm.logSource("g").reason).toBe("not_running");
  });
  it("a terminal grok instance is read as before", async () => {
    const fm = await fleet({ g: { working_directory: "/w/g", backend: "grok" } });
    expect(fm.logSource("g")).toMatchObject({ backend: "grok", format: "grok", reason: "no_transcript" });
  });
});
