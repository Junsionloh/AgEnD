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
import { readFileSync } from "node:fs";
import { chatStep, type LogStep } from "../AgEnD/src/log-steps.js";
import { AntigravityStepParser, GrokStepParser } from "../AgEnD/src/log-steps-agy-grok.js";

const OUT = process.env.OUT!;
const BACKEND = process.env.BACKEND as "antigravity" | "grok";
const FIX = "../AgEnD/tests/fixtures/chat-activity-3648";
mkdirSync(OUT, { recursive: true });
const pw = createRequire(join(process.cwd(), "package.json"))("playwright-core");

const dir = mkdtempSync(join(tmpdir(), "agend-shots-"));
const fm = new FleetManager(dir);
const quiet = () => {};
fm.logger = { info: quiet, warn: quiet, error: quiet, debug: quiet, trace: quiet, fatal: quiet, child: () => fm.logger } as unknown as typeof fm.logger;
(fm as any).notifyFleetError = () => true;
(fm as any).fleetConfig = { instances: { probe: { working_directory: "/home/user/scratch-191/ws/probe", backend: BACKEND, tool_progress: "standard" } }, web: { log_tab: false } };
(fm as any).initializeWebAuthTokens();
(fm as any).startHealthServer(0);
const port = await new Promise<number>((resolve) => { const t = setInterval(() => { const a = (fm as any).healthServer?.address?.(); if (a?.port) { clearInterval(t); resolve(a.port); } }, 50); });
const BASE = `http://127.0.0.1:${port}`;


const lines = readFileSync(join(FIX, `${BACKEND === "antigravity" ? "agy" : "grok"}-web-chat.jsonl`), "utf8").split("\n").filter(Boolean);
const ledger = JSON.parse(readFileSync(join(FIX, `${BACKEND === "antigravity" ? "agy" : "grok"}-web-chat.ledger.json`), "utf8")) as Array<Record<string, any>>;
const parser = BACKEND === "antigravity" ? new AntigravityStepParser({ thinking: false }) : new GrokStepParser({ thinking: false });
lines.forEach((l, i) => parser.push(l, Date.parse("2026-11-11T11:10:00Z") + i * 1000));
const STEPS: LogStep[] = parser.steps;
const browser = await pw.chromium.launch({ args: ["--no-sandbox"] });
const code = () => (fm as any).issueDashboardLogin().display as string;
const answer = (level: "standard" | "verbose") => ({ enabled: true, instance: "probe", backend: BACKEND, supported: true, level, thinking: false, cwd: "/home/user/scratch-191/ws/probe", home: "/home/user", key: "1-1", steps: STEPS.map((s) => chatStep(s, level)), events: [], before: null, after: 1000, ev: 0 });
type Scene = { name: string; dark: boolean; mobile: boolean; level: "standard" | "verbose"; open: boolean };
async function shot(sc: Scene) {
  const lang = "en";
  const ctx = await browser.newContext({ viewport: sc.mobile ? { width: 390, height: 844 } : { width: 1366, height: 820 }, colorScheme: sc.dark ? "dark" : "light", locale: lang, isMobile: sc.mobile, hasTouch: sc.mobile, deviceScaleFactor: sc.mobile ? 2 : 1, bypassCSP: true });
  await ctx.addInitScript({ content: `try { localStorage.setItem("agend_tour_done", "1"); localStorage.setItem("agend_lang", "${lang}"); } catch {}` });
  const p = await ctx.newPage();
  await p.route("**/ui/steps**", (route: any) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(answer(sc.level)) }));
  await p.goto(`${BASE}/signin`); await p.waitForTimeout(800);
  await p.evaluate(`fetch("/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "${code()}" }) })`);
  await p.waitForTimeout(400);
  await p.evaluate(`fetch("/auth/session").then(r => r.json()).then(s => fetch("/ui/prefs", { method: "POST", headers: { "content-type": "application/json", "x-agend-csrf": s.csrf }, body: JSON.stringify({ set: { lang: "${lang}", theme: "${sc.dark ? "dark" : "light"}" } }) }))`);
  await p.waitForTimeout(400);
  await p.goto(`${BASE}/ui/chat/probe`); await p.waitForSelector("#msgIn", { timeout: 20000 }); await p.waitForTimeout(2500);
  await p.waitForSelector(".act-block", { timeout: 15000 });
  if (sc.open) { await p.evaluate(() => document.querySelectorAll(".act-block summary").forEach((s) => (s as HTMLElement).click())); await p.waitForTimeout(300); }
  console.log(sc.name, "blocks:", await p.evaluate(() => document.querySelectorAll(".act-block").length));
  await p.evaluate(() => { const s = document.querySelector(".scroller") as HTMLElement | null; if (s) s.scrollTop = 0; });
  await p.waitForTimeout(400);
  await p.screenshot({ path: join(OUT, `${sc.name}.png`) });
  await ctx.close();
}
try {
  fm.webChatHistory.forget("probe");
  for (const r of ledger) fm.webChatHistory.record({ instance: "probe", sender: r.sender, role: r.role, text: r.text, ts: r.ts, anchor: r.anchor } as never);
  for (const mobile of [false, true]) for (const [k, level, open] of [["1-standard-collapsed", "standard", false], ["2-standard-opened", "standard", true], ["3-verbose-opened", "verbose", true]] as const)
    await shot({ name: `${BACKEND === "antigravity" ? "agy" : "grok"}-${mobile ? "phone" : "desktop"}-light-en-${k}`, dark: false, mobile, level, open });
} catch (e) { console.log(String((e as Error).stack ?? e).slice(0, 1500)); }
finally { await browser.close(); (fm as any).healthServer?.close(); process.exit(0); }
