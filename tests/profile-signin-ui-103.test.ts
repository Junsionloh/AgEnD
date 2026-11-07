/**
 * AGEND-103: a NAMED Claude account is signed in with the same dialog as the default account — press Sign in, open the provider's page, paste the code back — and not
 * the old web-terminal flow (a temporary public link, a terminal page, a one-time access code). The real modules on the mini DOM with a recording fetch; nothing
 * reaches a server.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

type Req = { method: string; url: string; body: any };
let reqs: Req[] = [];
let answer: (r: Req) => unknown = () => ({});
const fetchFake = async (url: string, init: any = {}) => {
  const r: Req = { method: init.method || "GET", url, body: init.body ? JSON.parse(init.body) : null };
  reqs.push(r);
  const body = await answer(r);
  return { ok: true, status: 200, json: async () => body };
};

const ENDPOINT = "/ui/browser-backend-signins?backend=claude-code&profile=CHY";
const DEFAULT_ENDPOINT = "/ui/browser-backend-signins";
const AUTH_URL = "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz";
const snapshot = (over: Record<string, unknown> = {}) => ({ selected: ["claude-code"], pending: ["claude-code"], skipped: [], states: { "claude-code": "invalid" }, login: null, ready: false,
  target: { backend: "claude-code", profile: "CHY" }, ...over });
const waitingForCode = { id: "a".repeat(32), backend: "claude-code", revision: 3, phase: "code", mine: true, canAct: true, url: AUTH_URL };

let p: AppPage;
let S: any, shell: any, i18n: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19281/settings/agent", storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fetchFake;
  (globalThis as any).navigator.clipboard = { writeText: async () => {} };
  shell = await import("/assets/app-shell.js");
  i18n = await import("/assets/app-i18n.js");
  S = await import("/ui/js/backend-signin.js");
});
afterAll(() => { p.restore(); delete (globalThis as any).fetch; });
beforeEach(async () => {
  await p.unmount();
  reqs = []; answer = () => ({});
  i18n.setLang("en", { store: false });
  S.signInStore.set({ loaded: false, login: null, targets: [], structured: null });
  shell.shellStore.set({ dialog: null });
});
const text = () => p.root.textContent.replace(/\s+/g, " ");
const btn = (label: string) => p.root.querySelectorAll("button, a").find((b: any) => b.textContent.trim() === label);
const posts = (url: string, operation?: string) => reqs.filter(r => r.method === "POST" && r.url === url && (!operation || r.body?.operation === operation));
const open = async (props: Record<string, unknown>) => { await p.mount(h(S.BrowserSignInDialog, props)); await settle(8); };
/** The cards set `onclick` on their buttons (structured-signin.js); the dialog's own buttons are Preact's (`fire`). */
const press = async (label: string) => { const b = btn(label) as any; expect(b, label).toBeDefined(); await b.onclick(); await settle(8); };
/** What the dialog does when it is closed: the shell takes it off the page (its effects' cleanup runs), as `closeDialog` does. */
const closing = () => async () => { await p.unmount(); };

describe("openSignIn routes a named account to the same dialog as the default one", () => {
  it("claude-code with a profile → BrowserSignInDialog with the name; kiro/codex profiles (never signed in from the dashboard) keep the older dialog that names the command", () => {
    S.openSignIn({ backend: "claude-code", profile: "CHY" });
    expect(shell.shellStore.get().dialog.Component).toBe(S.BrowserSignInDialog);
    expect(shell.shellStore.get().dialog.props).toEqual({ backend: "claude-code", profile: "CHY" });
    for (const backend of ["kiro-cli", "codex"]) {
      S.openSignIn({ backend, profile: "CHY" });
      expect(shell.shellStore.get().dialog.Component, backend).toBe(S.SignInDialog);
      expect(shell.shellStore.get().dialog.props).toEqual({ backend, profile: "CHY" });
    }
  });
  it("the default account is unchanged: no profile in the props", () => {
    S.openSignIn({ backend: "claude-code" });
    expect(shell.shellStore.get().dialog.Component).toBe(S.BrowserSignInDialog);
    expect(shell.shellStore.get().dialog.props).toEqual({ backend: "claude-code" });
  });
  it("an unknown backend still opens the older dialog", () => {
    S.openSignIn({ backend: "antigravity" });
    expect(shell.shellStore.get().dialog.Component).toBe(S.SignInDialog);
  });
});

describe("the named account's dialog", () => {
  it("reads the account's own endpoint; its title carries the name; no temporary public link, terminal, access code or Sign in later", async () => {
    answer = r => r.url === ENDPOINT ? snapshot() : {};
    await open({ backend: "claude-code", profile: "CHY" });
    expect(reqs[0]).toMatchObject({ method: "GET", url: ENDPOINT });
    expect(posts(DEFAULT_ENDPOINT), "the default account's controls are not used").toEqual([]);
    expect(text()).toContain("Sign in to Claude Code · profile CHY");
    expect(btn("Sign in")).toBeDefined();
    for (const gone of ["temporary public link", "Open the sign-in terminal", "Access code", "access code", "Sign in later"]) expect(text(), gone).not.toContain(gone);
    expect(reqs.filter(r => r.url.startsWith("/ui/backend-login/")), "the terminal flow is not used").toEqual([]);
  });
  it("the default account's dialog says the same things (same screen), apart from the name in the title and its checklist's Sign in later", async () => {
    answer = r => r.url === DEFAULT_ENDPOINT ? snapshot({ target: undefined }) : {};
    await open({ backend: "claude-code" });
    const defaultText = text();
    await p.unmount(); reqs = [];
    answer = r => r.url === ENDPOINT ? snapshot() : {};
    await open({ backend: "claude-code", profile: "CHY" });
    const named = text();
    expect(defaultText).toContain("Sign in your AI backends"); expect(named).toContain("Sign in your AI backends");
    expect(defaultText).toContain("Sign in to Claude Code"); expect(named).toContain("Sign in to Claude Code · profile CHY");
    expect(defaultText).toContain("Sign in later"); expect(named).not.toContain("Sign in later");
  });
  it("Sign in → the link opens the provider's page → the code is pasted back into the dialog: start and input go to the account's endpoint, and only there", async () => {
    let login: any = null;
    answer = r => {
      if (r.url !== ENDPOINT) return {};
      if (r.body?.operation === "start") login = waitingForCode;
      if (r.body?.operation === "input") login = { ...waitingForCode, revision: 4, canAct: false };
      return snapshot({ login });
    };
    await open({ backend: "claude-code", profile: "CHY" });
    await press("Sign in");
    expect(posts(ENDPOINT, "start")[0]!.body).toEqual({ operation: "start", backend: "claude-code", relogin: false });
    const link = p.root.querySelectorAll("a").find((a: any) => a.textContent.includes("Open provider sign-in"));
    expect([link.href, link.target, link.rel]).toEqual([AUTH_URL, "_blank", "noopener noreferrer"]);
    const field = p.root.querySelectorAll("input").find((i: any) => i.type === "password") as any;
    expect(field, "a field for the code").toBeDefined(); field.value = "pasted#code";
    await press("Submit code");
    expect(posts(ENDPOINT, "input")[0]!.body).toEqual({ operation: "input", id: waitingForCode.id, revision: 3, action: { kind: "code", value: "pasted#code" } });
    expect(reqs.filter(r => r.method === "POST" && r.url !== ENDPOINT), "nothing is sent to any other endpoint").toEqual([]);
  });
  it("a signed-in account says so, offers Sign in again, and nothing is written to the default account's controls", async () => {
    answer = r => r.url === ENDPOINT ? snapshot({ states: { "claude-code": "valid" }, pending: [], ready: true }) : {};
    await open({ backend: "claude-code", profile: "CHY" });
    expect(text()).toContain("Signed in ✓"); expect(btn("Sign in again")).toBeDefined();
    expect(posts(DEFAULT_ENDPOINT)).toEqual([]);
  });
});

describe("closing, cancelling and the console fallback end the sign-in", () => {
  it("Close ends the account's sign-in (a cancel to its endpoint) so none is left running to refuse Remove", async () => {
    answer = r => r.url === ENDPOINT ? snapshot({ login: waitingForCode }) : {};
    await open({ backend: "claude-code", profile: "CHY", onClose: closing() });
    reqs = [];
    fire(btn("Close"), "click"); await settle(8);
    expect(posts(ENDPOINT, "cancel")).toHaveLength(1);
    expect(posts(DEFAULT_ENDPOINT)).toEqual([]);
  });
  it("the cancel button inside the cards posts a cancel to the account's endpoint", async () => {
    answer = r => r.url === ENDPOINT ? snapshot({ login: waitingForCode }) : {};
    await open({ backend: "claude-code", profile: "CHY" });
    await press("Cancel sign-in");
    expect(posts(ENDPOINT, "cancel").length).toBeGreaterThanOrEqual(1);
    expect(posts(DEFAULT_ENDPOINT)).toEqual([]);
  });
  it("the default account's dialog keeps its behaviour: closing it does not cancel", async () => {
    answer = r => r.url === DEFAULT_ENDPOINT ? snapshot({ target: undefined, login: waitingForCode }) : {};
    await open({ backend: "claude-code", onClose: closing() });
    reqs = [];
    fire(btn("Close"), "click"); await settle(8);
    expect(reqs.filter(r => r.method === "POST")).toEqual([]);
  });
  it("Use console fallback ends the sign-in at the account's endpoint, then opens the older dialog for the SAME account", async () => {
    answer = r => r.url === ENDPOINT ? snapshot() : {};
    await open({ backend: "claude-code", profile: "CHY" });
    fire(btn("Use console fallback"), "click"); await settle(8);
    expect(posts(ENDPOINT, "cancel").length).toBeGreaterThanOrEqual(1);
    expect(shell.shellStore.get().dialog.Component).toBe(S.SignInDialog);
    expect(shell.shellStore.get().dialog.props).toEqual({ backend: "claude-code", profile: "CHY" });
  });
});

describe("zh-TW", () => {
  it("the title names the account and the screen has no terminal words", async () => {
    i18n.setLang("zh-TW", { store: false });
    answer = r => r.url === ENDPOINT ? snapshot() : {};
    await open({ backend: "claude-code", profile: "CHY" });
    expect(text()).toContain("登入 Claude Code · 設定檔 CHY");
    for (const gone of ["臨時公開連結", "登入終端機", "存取碼", "稍後登入"]) expect(text(), gone).not.toContain(gone);
  });
});
