// Screenshots for "the chat's live activity line starts with the turn": the REAL dashboard (the real FleetManager serves the
// real page and chat history, seeded here), a Claude Code instance that is working on a turn whose transcript has only the
// prompt so far — the state a long thought leaves, because the CLI writes a thought when it ends. Scripted (a harness, not the
// product): GET /ui/steps answers the finished first turn and the second turn's prompt only (with the server-side cut,
// chatStep); the agent is made "working" by the same SSE `activity` event the daemon sends on a transition.
//   VARIANT=before|after OUT=<dir> npx tsx ../shots-live.mts      (run from a checkout in a directory named AgEnD)
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../AgEnD/src/fleet-manager.js";
import { chatStep, type LogStep } from "../AgEnD/src/log-steps.js";

const OUT = process.env.OUT!, VARIANT = process.env.VARIANT as "before" | "after";
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

const NOW = Date.now();
const T_USER1 = NOW - 10 * 60_000, T_REPLY1 = T_USER1 + 192_000, T_USER2 = NOW - 45_000;
const L = {
  "zh-TW": { u1: "panel-chat.js 的進度區塊壞了，幫我修好並跑測試。", r1: "修好了：進度區塊在回合結束時會收成一行摘要，不再重複。`tests/web-chat-progress.test.ts` 全部通過，已提交。", u2: "再幫我補一個「重新載入不重複」的測試，順便檢查邊界情況。" },
  en: { u1: "The progress block in panel-chat.js is broken — fix it and run the tests.", r1: "Fixed: the progress block now shrinks to a one-line summary when the turn ends, and is not duplicated. `tests/web-chat-progress.test.ts` passes; committed.", u2: "Now add a test that a reload does not duplicate it, and check the edge cases." },
} as const;
const tool = (id: string, ts: number, over: Partial<LogStep>): LogStep => ({ id, turn: "t1", ts, kind: "tool", status: "done", ...over } as LogStep);
const read = (id: string, ts: number, path: string) => tool(id, ts, { tool: "Read", cat: "read", subject: `/srv/work/probe/${path}`, input: JSON.stringify({ file_path: `/srv/work/probe/${path}` }), body: "…" });
const edit = (id: string, ts: number, path: string) => tool(id, ts, { tool: "Edit", cat: "edit", subject: `/srv/work/probe/${path}`, input: JSON.stringify({ file_path: `/srv/work/probe/${path}` }), body: "The file has been updated." });
const bash = (id: string, ts: number, cmd: string) => tool(id, ts, { tool: "Bash", cat: "run", subject: cmd, input: JSON.stringify({ command: cmd }), body: "ok" });
const grep = (id: string, ts: number) => tool(id, ts, { tool: "Grep", cat: "search", subject: "act-block  in  src/ui", input: "{}", body: "…" });
const user = (id: string, turn: string, ts: number, anchor: string): LogStep => ({ id, turn, ts, kind: "user", anchor: { messageId: anchor }, body: "…" });
const reply = (id: string, turn: string, ts: number, anchor: string): LogStep => ({ id, turn, ts, kind: "tool", tool: "mcp__agend__reply", cat: "message", status: "done", anchor: { messageId: anchor, replyText: "…" } } as LogStep);
const end = (turn: string, ts: number): LogStep => ({ id: `end-${turn}`, turn, ts, kind: "turn_end" });
const t1 = (n: number) => T_USER1 + n * 15_000;
const first: LogStep[] = [user("u1", "t1", T_USER1, "w-u1"),
  grep("a1", t1(1)), read("a2", t1(2), "src/ui/panel-chat.js"), edit("a3", t1(3), "src/ui/panel-chat.js"),
  bash("a4", t1(4), "npx vitest run tests/web-chat-progress.test.ts"), bash("a5", t1(5), "git commit -am 'fix(web): one summary line'"),
  reply("r1", "t1", T_REPLY1, "w-r1"), end("t1", T_REPLY1 + 500)];
// The second turn: the prompt is all the transcript has so far — the CLI is thinking.
const second: LogStep[] = [user("u2", "t2", T_USER2, "w-u2")];
const rows = (lang: "zh-TW" | "en", lang2 = L[lang]) => [
  { sender: "web-user", role: "user", text: lang2.u1, ts: new Date(T_USER1 - 1000).toISOString(), anchor: "w-u1" },
  { sender: "probe", role: "agent", text: lang2.r1, ts: new Date(T_REPLY1 + 800).toISOString(), anchor: "w-r1" },
  { sender: "web-user", role: "user", text: lang2.u2, ts: new Date(T_USER2 - 500).toISOString(), anchor: "w-u2" },
];

const browser = await pw.chromium.launch({ args: ["--no-sandbox"] });
const code = () => (fm as any).issueDashboardLogin().display as string;
const answer = (steps: LogStep[]) => ({ enabled: true, instance: "probe", backend: "claude-code", supported: true, level: "standard", thinking: false, cwd: "/srv/work/probe", home: "/home/dev", key: "1-1", steps: steps.map((s) => chatStep(s, "standard")), events: [], before: null, after: 1000, ev: 0 });

type Scene = { name: string; lang: "zh-TW" | "en"; dark: boolean; mobile: boolean; opened: boolean };
async function shot(sc: Scene) {
  const ctx = await browser.newContext({ viewport: sc.mobile ? { width: 390, height: 844 } : { width: 1366, height: 820 }, colorScheme: sc.dark ? "dark" : "light", locale: sc.lang, isMobile: sc.mobile, hasTouch: sc.mobile, deviceScaleFactor: sc.mobile ? 2 : 1, bypassCSP: true });
  await ctx.addInitScript({ content: `try { localStorage.setItem("agend_tour_done", "1"); localStorage.setItem("agend_lang", "${sc.lang}"); } catch {}` });
  const p = await ctx.newPage();
  await p.route("**/ui/steps**", (route: any) => { const shift = Date.now() - NOW; route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(answer([...first, ...second.map((x) => ({ ...x, ts: x.ts + shift }))])) }); });
  await p.goto(`${BASE}/signin`); await p.waitForTimeout(800);
  await p.evaluate(`fetch("/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "${code()}" }) })`);
  await p.waitForTimeout(400);
  await p.evaluate(`fetch("/auth/session").then(r => r.json()).then(s => fetch("/ui/prefs", { method: "POST", headers: { "content-type": "application/json", "x-agend-csrf": s.csrf }, body: JSON.stringify({ set: { lang: "${sc.lang}", theme: "${sc.dark ? "dark" : "light"}" } }) }))`);
  await p.waitForTimeout(400);
  await p.goto(`${BASE}/ui/chat/probe`); await p.waitForSelector("#msgIn", { timeout: 20000 }); await p.waitForTimeout(2000);
  // The agent starts working: the SSE event the daemon sends on a state transition.
  (fm as any).emitSseEvent("activity", { instance: "probe", state: "working" });
  await p.waitForTimeout(2500);
  // The shot instance is not running: say "working" in the header the way the upstream mockups did (a harness edit, not the product).
  await p.evaluate((working: string) => { const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n: any; while ((n = w.nextNode())) { if (/^\s*(已停止|Stopped|stopped)\s*$/.test(n.data) && (n.parentElement?.getBoundingClientRect().top ?? 999) < 90) n.data = working; } }, sc.lang === "en" ? "working" : "工作中");
  if (sc.opened) { await p.click(".act-block.live summary"); await p.waitForTimeout(300); }
  await p.evaluate(() => { const s = document.querySelector(".scroller") as HTMLElement | null; if (s) s.scrollTop = s.scrollHeight; });
  await p.waitForTimeout(500);
  const blocks = await p.evaluate(() => document.querySelectorAll(".act-block").length);
  console.log(sc.name, "act-blocks:", blocks);
  await p.screenshot({ path: join(OUT, `${sc.name}.png`) });
  await ctx.close();
}

const seed = (lang: "zh-TW" | "en") => { for (const r of rows(lang)) fm.webChatHistory.record({ instance: "probe", ...r } as never); };
try {
  for (const lang of ["en", "zh-TW"] as const) {
    fm.webChatHistory.forget("probe"); seed(lang);
    for (const dark of [false, true]) for (const mobile of [false, true]) {
      const base = `${mobile ? "phone" : "desktop"}-${dark ? "dark" : "light"}-${lang === "en" ? "en" : "zhTW"}`;
      await shot({ name: `${base}-${VARIANT}-working-no-step`, lang, dark, mobile, opened: false });
      if (VARIANT === "after") await shot({ name: `${base}-after-working-no-step-opened`, lang, dark, mobile, opened: true });
    }
  }
} catch (e) { console.log(String((e as Error).stack ?? e).slice(0, 1500)); }
finally { await browser.close(); (fm as any).healthServer?.close(); process.exit(0); }
