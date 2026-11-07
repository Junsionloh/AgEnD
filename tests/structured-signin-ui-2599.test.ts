import { createContext, runInContext } from "node:vm";
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
const source = readFileSync(new URL("../src/ui/structured-signin.js", import.meta.url), "utf8").replace(/^export /gm, "");
afterEach(() => vi.restoreAllMocks());
function browser(options: Record<string, unknown> = {}, init: Record<string, unknown> = {}, nativeConfirm: (message: string) => boolean = () => true) {
  function element(tag: string): any {
    return { tag, textContent: "", children: [], dataset: {}, disabled: false, ownerDocument: doc,
      append(child: any) { this.children.push(child); }, replaceChildren() { this.children = []; }, setAttribute(key: string, value: string) { this[key] = value; } };
  }
  const doc = { createElement: element, getElementById: () => null };
  const root = element("main"), state = { selected: ["kiro-cli", "antigravity"], pending: ["kiro-cli", "antigravity"], skipped: [], states: { "kiro-cli": "invalid", antigravity: "console_only" } as Record<string, string>, login: null as any, ready: false, ...init };
  const fetcher = vi.fn(async (_url: string, options: any) => {
    const data = options.body ? JSON.parse(options.body) : null;
    if (data?.operation === "start") state.login = { backend: "kiro-cli", id: "a".repeat(32), revision: 3, phase: "method", choices: ["builder_id", "github"], canAct: true };
    if (data?.operation === "input") state.login = { ...state.login, revision: 4, canAct: false };
    return { ok: true, json: async () => structuredClone(state) };
  });
  const timers: (() => Promise<void>)[] = [];
  const ctx = createContext({ document: doc, fetch: fetcher, setTimeout: (fn: any) => { timers.push(fn); return 1; }, clearTimeout() {}, URL, confirm: nativeConfirm });
  runInContext(source, ctx);
  const cards = ctx.mountStructuredSignIns(root, { endpoint: "setup/signins", fetcher, ...options });
  const nodes = (): any[] => { const all: any[] = []; const visit = (n: any) => { all.push(n); n.children.forEach(visit); }; visit(root); return all; };
  const flush = async () => { for (let n = 0; n < 20; n++) await Promise.resolve(); };
  const click = async (text: string) => { const b = nodes().find(n => n.tag === "button" && n.textContent === text); expect(b, text).toBeDefined(); if (!b.disabled) await b.onclick(); await flush(); };
  const texts = () => nodes().map(n => n.textContent).filter(Boolean);
  return { root, cards, state, fetcher, nodes, click, texts, flush, poll: async () => { await timers.shift()?.(); await flush(); } };
}
it("method controls submit once, show the waiting latch, and never expose an agy launch", async () => {
  const h = browser(); await h.flush();
  await h.click("Sign in"); await h.click("GitHub");
  expect(h.fetcher.mock.calls.filter(([, o]) => o.body && JSON.parse(o.body).operation === "input")).toHaveLength(1);
  expect(h.nodes().some(n => n.textContent.includes("Answer sent."))).toBe(true);
  expect(h.nodes().some(n => n.textContent === "GitHub")).toBe(false);
  expect(h.nodes().filter(n => n.textContent === "Sign in")).toHaveLength(0);
  expect(h.nodes().some(n => n.textContent.includes("explicit console fallback"))).toBe(true);
  h.cards.dispose();
});
it("a failed POST releases controls, uses a safe error, and allows deliberate retry", async () => {
  const h = browser(); await h.flush(); h.fetcher.mockRejectedValueOnce(new Error("secret-like vendor text"));
  await h.click("Sign in");
  expect(h.nodes().some(n => n.role === "alert" && n.textContent.includes("Could not complete"))).toBe(true);
  expect(JSON.stringify(h.nodes().map(n => n.textContent))).not.toContain("secret-like");
  expect(h.nodes().find(n => n.textContent === "Sign in").disabled).toBe(false);
  await h.click("Sign in"); expect(h.nodes().some(n => n.textContent === "GitHub")).toBe(true); h.cards.dispose();
});
it("returned code is submitted literally to the closed API and cleared from the input", async () => {
  const h = browser(); await h.flush();
  h.state.login = { backend: "kiro-cli", id: "b".repeat(32), revision: 8, phase: "code", canAct: true };
  await h.poll(); const field = h.nodes().find(n => n.tag === "input"); field.value = "synthetic#code";
  await h.click("Submit code"); expect(field.value).toBe("");
  const input = h.fetcher.mock.calls.filter(([, o]) => o.body && JSON.parse(o.body).operation === "input")[0];
  expect(JSON.parse(input![1].body)).toMatchObject({ operation: "input", revision: 8, action: { kind: "code", value: "synthetic#code" } }); h.cards.dispose();
});

const starts = (h: ReturnType<typeof browser>) => h.fetcher.mock.calls.filter(([, o]) => o.body && JSON.parse(o.body).operation === "start").map(([, o]) => JSON.parse(o.body));

// AGEND-103: the account page's dialog draws only what an account's sign-in needs; the first-install page (no `dialog`) is as it was.
it("the setup page (no `dialog` option) keeps its heading, lead, Check sign-ins, Sign in later and every selected backend's card", async () => {
  const h = browser(); await h.flush();
  expect(h.nodes().find(n => n.tag === "h2")?.textContent).toBe("Sign in your AI backends");
  expect(h.texts().some(t => t.startsWith("Use the controls here"))).toBe(true);
  expect(h.nodes().filter(n => n.tag === "button" && n.textContent === "Check sign-ins")).toHaveLength(1);
  expect(h.nodes().some(n => n.tag === "button" && n.textContent.startsWith("Sign in later"))).toBe(true);
  expect(h.nodes().filter(n => n.tag === "section").map(n => n.dataset.backend)).toEqual(["kiro-cli", "antigravity"]);
  h.cards.dispose();
});
it("`dialog: true` leaves out the heading, lead, Check sign-ins, Sign in later and the setup's \"You can continue\"; `focus` keeps one backend's card", async () => {
  const h = browser({ dialog: true, focus: "kiro-cli" }, { ready: true }); await h.flush();
  expect(h.nodes().some(n => n.tag === "h2")).toBe(false);
  const all = h.texts().join(" | ");
  for (const gone of ["Sign in your AI backends", "Use the controls here", "Check sign-ins", "Sign in later", "You can continue setup"]) expect(all, gone).not.toContain(gone);
  expect(h.nodes().filter(n => n.tag === "section").map(n => n.dataset.backend)).toEqual(["kiro-cli"]);
  expect(h.nodes().filter(n => n.tag === "button").map(n => n.textContent)).toEqual(["Sign in"]);
  h.cards.dispose();
});
it("`dialog: true`: a read that fails is still said (an alert), and there is still no Check sign-ins (the cards read themselves every second)", async () => {
  const h = browser({ dialog: true, focus: "kiro-cli" }); await h.flush();
  h.fetcher.mockRejectedValueOnce(new Error("offline")); await h.poll();
  expect(h.nodes().some(n => n.role === "alert")).toBe(true);
  expect(h.nodes().filter(n => n.tag === "button").map(n => n.textContent)).toEqual(["Sign in"]);
  h.cards.dispose();
});
it("Sign in again: Kiro's words say it signs out first; Claude Code's and Codex's do not mention Kiro (the browser's confirm() when no `confirm` is given, as on the setup page)", async () => {
  const asked: string[] = [];
  for (const [backend, expected] of [["kiro-cli", "Sign in again? Kiro will sign out its existing account first."], ["claude-code", "Sign in again? This replaces the current sign-in."], ["codex", "Sign in again? This replaces the current sign-in."]] as const) {
    const h = browser({}, { selected: [backend], pending: [], states: { [backend]: "valid" }, ready: true }, message => { asked.push(message); return true; }); await h.flush();
    await h.click("Sign in again");
    expect(asked.at(-1), backend).toBe(expected);
    expect(starts(h), backend).toEqual([{ operation: "start", backend, relogin: true }]);
    h.cards.dispose();
  }
  expect(asked.filter(m => /Kiro/.test(m))).toHaveLength(1);
});
it("a `confirm` option is how Sign in again is asked: it gets the words and the button's label, the browser's confirm() is not used, No sends nothing, and an error counts as No", async () => {
  const calls: unknown[] = []; let answer: boolean | "throw" = false;
  const confirm = async (question: unknown) => { calls.push(question); if (answer === "throw") throw new Error("dialog failed"); return answer; };
  const h = browser({ dialog: true, focus: "claude-code", confirm }, { selected: ["claude-code"], pending: [], states: { "claude-code": "valid" }, ready: true }, () => { throw new Error("the browser's confirm() was used"); });
  await h.flush();
  await h.click("Sign in again"); expect(calls).toEqual([{ message: "Sign in again? This replaces the current sign-in.", confirmLabel: "Sign in again" }]); expect(starts(h)).toEqual([]);
  answer = "throw"; await h.click("Sign in again"); expect(calls).toHaveLength(2); expect(starts(h)).toEqual([]);
  answer = true; await h.click("Sign in again"); expect(starts(h)).toEqual([{ operation: "start", backend: "claude-code", relogin: true }]);
  h.cards.dispose();
});
it("a computer's account (`machine`) is never asked: Claude Code's own sign-in replaces the login", async () => {
  const confirm = async () => { throw new Error("asked"); };
  const h = browser({ machine: true, confirm }, { selected: ["claude-code"], pending: [], states: { "claude-code": "valid" }, ready: true }, () => { throw new Error("native"); }); await h.flush();
  await h.click("Sign in again"); expect(starts(h)).toEqual([{ operation: "start", backend: "claude-code", relogin: true }]);
  h.cards.dispose();
});
