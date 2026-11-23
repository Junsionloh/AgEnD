/**
 * AGEND-340, the page side: the banner on an agent's chat and Log pages that says a signed-in account is not used by it, and how to
 * choose one. The server's rule and its words are tests/account-hint-340.test.ts and tests/account-hint-route-340.test.ts.
 *
 *  - the banner: what it says for one account and for several, in English and in 繁體中文; "Choose an account" opens the agent's
 *    settings on the category that holds the Account field; "Use <account>" exists only for exactly one account, and is the write
 *    Settings' Save makes for an agent's account — a PATCH of that one CLI's credential_profile — never made without the press;
 *  - nothing when there is nothing to say: no hint, no admin session (403), an older server, a Windows agent, a guest page;
 *  - the failed-start toast carries the server's hint; both pages the banner belongs on render it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

let p: AppPage;
let app: any, nav: any, i18n: any, mod: any;
const calls: Array<{ method: string; path: string; body: any }> = [];
let HINT: any = null;
let STATUS = 200;
const fetchFake = async (path: string, o: any = {}) => {
  const method = o.method ?? "GET";
  calls.push({ method, path, body: o.body ? JSON.parse(o.body) : null });
  if (path.startsWith("/ui/account-hint/")) return { ok: STATUS === 200, status: STATUS, json: async () => ({ hint: HINT }) };
  return { ok: true, status: 200, json: async () => ({}) };
};

beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/chat/dev", storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fetchFake;
  app = await import("/assets/app-store.js");
  nav = await import("/assets/app-nav.js");
  i18n = await import("/assets/app-i18n.js");
  mod = await import("/ui/js/account-hint.js");
  nav.startRouter(p.window);
});
afterAll(() => { p.restore(); delete (globalThis as any).fetch; });

const ONE = { backend: "claude-code", label: "Claude Code", accounts: ["work"], only: "work" };
const MANY = { backend: "codex", label: "Codex", accounts: ["a", "b"], only: null };
const DEV = { name: "dev", status: "paused", runtime: undefined };
beforeEach(async () => {
  await p.unmount();
  i18n.setLang("en", { store: false });
  calls.length = 0; HINT = null; STATUS = 200;
  delete (globalThis as any).document.body.dataset.tier;
});

const q = (sel: string) => p.root.querySelector(sel);
const text = (el: any): string => (el ? el.childNodes.map((n: any) => (n.nodeType === 3 ? n.textContent : text(n)) ?? "").map((s: string) => s.replace(/\s+/g, " ").trim()).filter(Boolean).join(" ") : "");
async function mount(inst: any = DEV) {
  await p.mount(h("div", {}, h(mod.AccountHint, { name: "dev", inst })));
  await settle(10);
}
const buttons = () => (q(".account-hint") ? [...q(".account-hint").querySelectorAll("button")].map((b: any) => text(b)) : []);

describe("the banner", () => {
  it("one account signed in: says so, with Choose an account and Use <account>", async () => {
    HINT = ONE;
    await mount();
    const b = q(".account-hint");
    expect(b).toBeTruthy();
    expect(b.getAttribute("role")).toBe("status");
    expect(text(b.querySelector("p"))).toBe("Claude Code is not signed in on this host, and dev uses no account of its own, so it cannot start. The account work is signed in.");
    expect(buttons()).toEqual(["Choose an account", "Use work"]);
    expect(calls.map((c) => c.path)).toEqual(["/ui/account-hint/dev"]);
  });
  it("several accounts: all named, the person chooses — no Use button (the pick would be a guess)", async () => {
    HINT = MANY;
    await mount();
    expect(text(q(".account-hint p"))).toBe("Codex is not signed in on this host, and dev uses no account of its own, so it cannot start. These accounts are signed in: a, b.");
    expect(buttons()).toEqual(["Choose an account"]);
  });
  it("is in 繁體中文 too", async () => {
    HINT = ONE;
    i18n.setLang("zh-TW", { store: false });
    await mount();
    expect(text(q(".account-hint p"))).toBe("這台主機上的 Claude Code 尚未登入，而 dev 沒有指定自己的帳號，所以無法啟動。帳號 work 已登入。");
    expect(buttons()).toEqual(["選擇帳號", "使用 work"]);
  });
  it("Choose an account opens the agent's settings on the category with the Account field", async () => {
    HINT = ONE;
    await mount();
    const choose = [...q(".account-hint").querySelectorAll("button")][0];
    fire(choose, "click");
    await settle(5);
    expect(mod.accountSettingsPath("dev")).toMatch(/\?cat=runtime$/);
    expect(`${p.window.location.pathname}${p.window.location.search}`).toBe(mod.accountSettingsPath("dev"));
  });
  it("Use <account> is Settings' own write for an agent's account — only when pressed, only that CLI's credential_profile", async () => {
    HINT = ONE;
    await mount();
    expect(calls.some((c) => c.method !== "GET")).toBe(false);                 // nothing is written by showing it
    fire([...q(".account-hint").querySelectorAll("button")][1], "click");
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true), { timeout: 2000 });
    const write = calls.find((c) => c.method === "PATCH");
    expect(write).toBeTruthy();
    expect(write!.path).toBe("/api/settings/fleet/instances/dev");
    expect(write!.body).toEqual({ backend_options: { "claude-code": { credential_profile: "work" } } });
  });
});

describe("nothing to say", () => {
  it("no hint, a refused session (403), an older server, a Windows agent, a guest page: no banner", async () => {
    await mount();                                                             // the server says: no hint
    expect(q(".account-hint")).toBeNull();
    HINT = ONE; STATUS = 403;
    await mount();
    expect(q(".account-hint")).toBeNull();                                     // not an admin session
    STATUS = 200;
    const asked = calls.filter((c) => c.path.startsWith("/ui/account-hint/")).length;
    await mount({ ...DEV, runtime: "windows" });
    expect(q(".account-hint")).toBeNull();
    expect(calls.filter((c) => c.path.startsWith("/ui/account-hint/")).length).toBe(asked);   // a Windows agent never even asks
    HINT = { backend: "claude-code", accounts: [] };                           // a malformed answer is no hint
    await mount();
    expect(q(".account-hint")).toBeNull();
    (globalThis as any).document.body.dataset.tier = "guest";
    HINT = ONE; calls.length = 0;
    await p.unmount();
    await mount();
    expect(app.guestPage()).toBe(true);
    expect(q(".account-hint")).toBeNull();
    expect(calls).toEqual([]);                                                 // a guest page never even asks
  });
  it("a running agent has a working sign-in: no banner and no request — and it asks once it stops (the page's read budget, #1374)", async () => {
    HINT = ONE;
    await mount({ ...DEV, status: "running" });
    expect(q(".account-hint")).toBeNull();
    expect(calls).toEqual([]);
    for (const status of ["paused", "stopped", "crashed"]) {
      await mount({ ...DEV, status });
      expect(q(".account-hint"), status).toBeTruthy();
    }
  });
  it("readAccountHint: the answer as the server gives it, nothing for anything else", async () => {
    const ok = (body: any, status = 200) => async () => ({ ok: status === 200, status, json: async () => body });
    expect(await mod.readAccountHint("dev", ok({ hint: ONE }))).toEqual(ONE);
    expect(await mod.readAccountHint("dev", ok({ hint: null }))).toBeNull();
    expect(await mod.readAccountHint("dev", ok({}))).toBeNull();
    expect(await mod.readAccountHint("dev", ok({ hint: ONE }, 403))).toBeNull();
    expect(await mod.readAccountHint("dev", async () => { throw new Error("offline"); })).toBeNull();
    expect(await mod.readAccountHint("a b/c", async (url: string) => { expect(url).toBe("/ui/account-hint/a%20b%2Fc"); return { ok: true, json: async () => ({}) }; })).toBeNull();
  });
});

describe("the toast of a failed Start or Restart", () => {
  it("the error and the hint, one line; the error alone when there is no hint", () => {
    expect(mod.startFailureText({ error: "could not start", hint: "Claude Code is not signed in on this host." })).toBe("could not start Claude Code is not signed in on this host.");
    expect(mod.startFailureText({ error: "could not start" })).toBe("could not start");
    expect(mod.startFailureText({ hint: "only a hint" })).toBe("only a hint");
    expect(mod.startFailureText(null)).toBe("");
    expect(mod.startFailureText({ error: 5, hint: 7 })).toBe("");
  });
});

describe("where it is drawn", () => {
  const src = (f: string) => readFileSync(new URL(`../src/ui/${f}`, import.meta.url), "utf8");
  it("the chat page and the Log page render the banner; the chat and Details pages put the hint in a failed-start toast", () => {
    for (const f of ["panel-chat.js", "panel-log.js"]) {
      expect(src(f), f).toContain('import { AccountHint');
      expect(src(f), f).toMatch(/<\$\{AccountHint\} name=\$\{name\} inst=\$\{inst\} \/>/);
    }
    for (const f of ["panel-chat.js", "panel-details.js"]) {
      expect(src(f), f).toContain("startFailureText");
      expect(src(f), f).toMatch(/toast\(startFailureText\(r\), false, r\.hint \? \{ detail: true \} : undefined\)/);
    }
  });
});
