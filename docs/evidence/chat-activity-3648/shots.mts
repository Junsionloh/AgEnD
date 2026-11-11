// Screenshots of the chat's activity block on the REAL dashboard: the real FleetManager serves the real page and chat
// history (seeded here); only GET /ui/steps is answered by the script, with the same shapes (and the same server-side cut to
// standard / verbose, chatStep) the product sends. Nothing is injected into the page.
//   cd AgEnD && OUT=<dir> npx tsx ../scratch/shots.mts
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../AgEnD/src/fleet-manager.js";
import { chatStep, type LogStep } from "../AgEnD/src/log-steps.js";

const OUT = process.env.OUT!;
mkdirSync(OUT, { recursive: true });
const pw = createRequire(join(process.cwd(), "package.json"))("playwright-core");

const dir = mkdtempSync(join(tmpdir(), "agend-shots-"));
const fm = new FleetManager(dir);
const quiet = () => {};
fm.logger = { info: quiet, warn: quiet, error: quiet, debug: quiet, trace: quiet, fatal: quiet, child: () => fm.logger } as unknown as typeof fm.logger;
(fm as any).notifyFleetError = () => true;
(fm as any).fleetConfig = { instances: { probe: { working_directory: "/srv/work/probe", backend: "claude-code", tool_progress: "standard" } }, web: { log_tab: false } };
(fm as any).initializeWebAuthTokens();
(fm as any).startHealthServer(0);
const port = await new Promise<number>((resolve) => { const t = setInterval(() => { const a = (fm as any).healthServer?.address?.(); if (a?.port) { clearInterval(t); resolve(a.port); } }, 50); });
const BASE = `http://127.0.0.1:${port}`;

// ── the conversation (what /ui/history serves) and the transcript's steps (what /ui/steps serves) ─────────────────
const NOW = Date.now();
const T_USER1 = NOW - 10 * 60_000, T_REPLY1 = T_USER1 + 192_000, T_USER2 = NOW - 60_000;
const L = {
  "zh-TW": { u1: "panel-chat.js 的進度區塊壞了，幫我修好並跑測試。", r1: "修好了：進度區塊在回合結束時會收成一行摘要，不再重複。`tests/web-chat-progress.test.ts` 全部通過，已提交。", u2: "再幫我補一個「重新載入不重複」的測試。" },
  en: { u1: "The progress block in panel-chat.js is broken — fix it and run the tests.", r1: "Fixed: the progress block now shrinks to a one-line summary when the turn ends, and is not duplicated. `tests/web-chat-progress.test.ts` passes; committed.", u2: "Now add a test that a reload does not duplicate it." },
} as const;
const tool = (id: string, ts: number, over: Partial<LogStep>): LogStep => ({ id, turn: "t1", ts, kind: "tool", status: "done", ...over } as LogStep);
const read = (id: string, ts: number, path: string, status: LogStep["status"] = "done") => tool(id, ts, { tool: "Read", cat: "read", subject: `/srv/work/probe/${path}`, input: JSON.stringify({ file_path: `/srv/work/probe/${path}` }), body: "…", status });
const edit = (id: string, ts: number, path: string) => tool(id, ts, { tool: "Edit", cat: "edit", subject: `/srv/work/probe/${path}`, input: JSON.stringify({ file_path: `/srv/work/probe/${path}` }), body: "The file has been updated." });
const bash = (id: string, ts: number, cmd: string, status: LogStep["status"] = "done") => tool(id, ts, { tool: "Bash", cat: "run", subject: cmd, input: JSON.stringify({ command: cmd }), body: "ok", status });
const grep = (id: string, ts: number) => tool(id, ts, { tool: "Grep", cat: "search", subject: "act-block  in  src/ui", input: "{}", body: "…" });
const user = (id: string, turn: string, ts: number, anchor: string): LogStep => ({ id, turn, ts, kind: "user", anchor: { messageId: anchor }, body: "…" });
const reply = (id: string, turn: string, ts: number, anchor: string): LogStep => ({ id, turn, ts, kind: "tool", tool: "mcp__agend__reply", cat: "message", status: "done", anchor: { messageId: anchor, replyText: "…" } } as LogStep);
const end = (turn: string, ts: number): LogStep => ({ id: `end-${turn}`, turn, ts, kind: "turn_end" });
const t1 = (n: number) => T_USER1 + n * 15_000;
const first: LogStep[] = [user("u1", "t1", T_USER1, "w-u1"),
  grep("a1", t1(1)), read("a2", t1(2), "src/ui/panel-chat.js"), read("a3", t1(3), "src/ui/chat-store.js"), edit("a4", t1(4), "src/ui/panel-chat.js"),
  bash("a5", t1(5), "npm run typecheck"), bash("a6", t1(6), "npx vitest run tests/web-chat-progress.test.ts"), edit("a7", t1(7), "tests/web-chat-progress.test.ts"),
  bash("a8", t1(8), "npx vitest run tests/web-chat-progress.test.ts"), read("a9", t1(9), "docs/web-dashboard.md"), edit("a10", t1(10), "docs/web-dashboard.md"),
  bash("a11", t1(11), "git commit -am 'fix(web): one summary line'"), bash("a12", t1(12), "git status --short"),
  reply("r1", "t1", T_REPLY1, "w-r1"), end("t1", T_REPLY1 + 500)];
const t2 = (n: number) => T_USER2 + n * 8_000;
const second: LogStep[] = [user("u2", "t2", T_USER2, "w-u2"),
  { ...grep("b1", t2(1)), turn: "t2" }, { ...read("b2", t2(2), "tests/web-chat-progress.test.ts"), turn: "t2" }, { ...read("b3", t2(3), "src/ui/chat-activity.js"), turn: "t2" },
  { ...edit("b4", t2(4), "tests/web-chat-progress.test.ts"), turn: "t2" }, { ...bash("b5", t2(5), "npm run typecheck"), turn: "t2" },
  { ...bash("b6", t2(6), "npx vitest run tests/web-chat-progress.test.ts"), turn: "t2" }, { ...read("b7", t2(7), "tests/web-chat-progress.test.ts", "running"), turn: "t2" }];
const rows = (lang: "zh-TW" | "en", lang2 = L[lang]) => [
  { sender: "web-user", role: "user", text: lang2.u1, ts: new Date(T_USER1 - 1000).toISOString(), anchor: "w-u1" },
  { sender: "probe", role: "agent", text: lang2.r1, ts: new Date(T_REPLY1 + 800).toISOString(), anchor: "w-r1" },
  { sender: "web-user", role: "user", text: lang2.u2, ts: new Date(T_USER2 - 500).toISOString(), anchor: "w-u2" },
];

// ── a browser per scene ────────────────────────────────────────────────────────────────────────────────────────
const browser = await pw.chromium.launch({ args: ["--no-sandbox"] });
const code = () => (fm as any).issueDashboardLogin().display as string;
const answer = (level: "standard" | "verbose" | null, steps: LogStep[]) => (level === null ? { status: 404, body: { error: "not available" } }
  : { status: 200, body: { enabled: true, instance: "probe", backend: "claude-code", supported: true, level, thinking: false, cwd: "/srv/work/probe", home: "/home/dev", key: "1-1", steps: steps.map((s) => chatStep(s, level)), events: [], before: null, after: 1000, ev: 0 } });

type Scene = { name: string; lang: "zh-TW" | "en"; dark: boolean; mobile: boolean; kind: "before" | "a" | "b" | "c" };
async function shot(sc: Scene) {
  const level = sc.kind === "before" ? null : sc.kind === "c" ? "verbose" : "standard";
  const ctx = await browser.newContext({ viewport: sc.mobile ? { width: 390, height: 844 } : { width: 1366, height: 820 }, colorScheme: sc.dark ? "dark" : "light", locale: sc.lang, isMobile: sc.mobile, hasTouch: sc.mobile, deviceScaleFactor: sc.mobile ? 2 : 1, bypassCSP: true });
  await ctx.addInitScript({ content: `try { localStorage.setItem("agend_tour_done", "1"); localStorage.setItem("agend_lang", "${sc.lang}"); } catch {}` });
  const p = await ctx.newPage();
  // Only /ui/steps is the script's; the thread and everything else are the real server's.
  await p.route("**/ui/steps**", (route: any) => { const shift = Date.now() - NOW; const a = answer(level, [...first, ...second.map((x) => ({ ...x, ts: x.ts + shift }))]); route.fulfill({ status: a.status, contentType: "application/json", body: JSON.stringify(a.body) }); });
  await p.goto(`${BASE}/signin`); await p.waitForTimeout(800);
  await p.evaluate(`fetch("/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "${code()}" }) })`);
  await p.waitForTimeout(400);
  await p.evaluate(`fetch("/auth/session").then(r => r.json()).then(s => fetch("/ui/prefs", { method: "POST", headers: { "content-type": "application/json", "x-agend-csrf": s.csrf }, body: JSON.stringify({ set: { lang: "${sc.lang}", theme: "${sc.dark ? "dark" : "light"}" } }) }))`);
  await p.waitForTimeout(400);
  await p.goto(`${BASE}/ui/chat/probe`); await p.waitForSelector("#msgIn", { timeout: 20000 }); await p.waitForTimeout(2500);
  if (sc.kind === "before") { /* the thread as it was: no block */ }
  else {
    await p.waitForSelector(".act-block", { timeout: 15000 });
    if (sc.kind === "b" || sc.kind === "c") { await p.click(".act-block.live summary"); await p.waitForTimeout(300); }
  }
  // The shot instance is not running: say "working" in the header the way the upstream mockups did (a harness edit, not the product).
  await p.evaluate((working: string) => { const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n: any; while ((n = w.nextNode())) { if (/^\s*(已停止|Stopped|stopped)\s*$/.test(n.data) && (n.parentElement?.getBoundingClientRect().top ?? 999) < 90) n.data = working; } }, sc.lang === "en" ? "Working" : "工作中");
  await p.evaluate(() => { const sc = document.querySelector(".scroller") as HTMLElement | null; if (sc) sc.scrollTop = sc.scrollHeight; });
  await p.waitForTimeout(500);
  await p.screenshot({ path: join(OUT, `${sc.name}.png`) });
  await ctx.close();
}

// seed the conversation once per language (the history is the server's, so a language is a different set of rows)
const seed = (lang: "zh-TW" | "en") => { for (const r of rows(lang)) fm.webChatHistory.record({ instance: "probe", ...r } as never); };
const scenes: Scene[] = [];
for (const lang of ["en", "zh-TW"] as const) for (const dark of [false, true]) for (const mobile of [false, true]) {
  const base = `${mobile ? "phone" : "desktop"}-${dark ? "dark" : "light"}-${lang === "en" ? "en" : "zhTW"}`;
  for (const kind of ["before", "a", "b", "c"] as const) scenes.push({ name: `${base}-${kind === "before" ? "0-before" : kind === "a" ? "1-running-collapsed-and-finished" : kind === "b" ? "2-running-expanded" : "3-verbose-expanded"}`, lang, dark, mobile, kind });
}
try {
  for (const lang of ["en", "zh-TW"] as const) {
    // a fresh history for each language
    fm.webChatHistory.forget("probe");
    seed(lang);
    for (const sc of scenes.filter((s) => s.lang === lang)) { await shot(sc); console.log("ok", sc.name); }
  }
} catch (e) { console.log(String((e as Error).stack ?? e).slice(0, 1500)); }
finally { await browser.close(); (fm as any).healthServer?.close(); process.exit(0); }
