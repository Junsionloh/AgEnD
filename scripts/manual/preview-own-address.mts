// The preview takes the dashboard's own address: a real-browser smoke. NOT part of the test suite (CI has no browser).
//
//   PW_DIR=<dir with playwright-core> REPO=$PWD OUT=<dir> [CHROME=/path/to/chrome] [EXPECT=works|refused] \
//     [SCENARIO=listed|noOrigin] [HP=47480] [LANG_UI=en|zh-TW] npx tsx scripts/manual/preview-own-address.mts
//
// It runs the real /ui and /frame from an in-process FleetManager in a scratch AGEND_HOME — no fleet, no CLI, no tmux, no
// instance is started. The dashboard is reached at http://dash.test:<HP> (a name in web.allowed_hosts WITHOUT a port, at a
// non-default port) and the preview origin is http://frame.test:<HP+1> (a different host name); Chromium maps both names
// to 127.0.0.1 with --host-resolver-rules.
//   SCENARIO=listed   (default) web.allowed_hosts: [dash.test], web.preview_origin: http://frame.test:<HP+1>
//   SCENARIO=noOrigin web.allowed_hosts: [dash.test], no web.preview_origin — the page says what it needs
// EXPECT=works: the preview must run in the frame (exit 1 otherwise); EXPECT=refused: it must not (the "before" run,
// against a checkout without the change). Without EXPECT it only records. Prints one JSON line; screenshots in OUT.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(process.env.PW_DIR + "/");
const { chromium } = require("playwright-core");
const SCENARIO = process.env.SCENARIO === "noOrigin" ? "noOrigin" : "listed";
const LANG_UI = process.env.LANG_UI === "zh-TW" ? "zh-TW" : "en";
const EXPECT = process.env.EXPECT ?? "";
const HP = Number(process.env.HP ?? 47480), PP = HP + 1;
const OUT = process.env.OUT ?? join(tmpdir(), "preview-own-address-out");
mkdirSync(OUT, { recursive: true });
const DASH = "dash.test", FRAME = "frame.test";
const dir = mkdtempSync(join(tmpdir(), "own-address-"));
process.env.AGEND_HOME = dir;
writeFileSync(join(dir, "fleet.yaml"), `health_port: ${HP}\ninstances:\n  w:\n    working_directory: ${dir}\n    backend: claude-code\nweb:\n  preview_port: ${PP}\n  allowed_hosts:\n    - ${DASH}\n`
  + (SCENARIO === "listed" ? `  preview_origin: http://${FRAME}:${PP}\n` : ""));
const { FleetManager } = await import(process.env.REPO + "/src/fleet-manager.ts");
const fm: any = new FleetManager(dir);
const q = () => {}; fm.logger = { info: q, warn: q, error: q, debug: q, trace: q, fatal: q, child: () => fm.logger };
fm.notifyFleetError = () => true;
fm.loadConfig(join(dir, "fleet.yaml"));
fm.lifecycle = { isPaused: () => false, hasWorkLease: () => false, daemons: new Map() };
fm.deliverToInstance = async () => true;
fm.initializeWebAuthTokens(); fm.startHealthServer(HP);
const t0 = Date.now(); while (!fm.previewListening && Date.now() - t0 < 5000) await new Promise(r => setTimeout(r, 50));
if (!fm.previewListening) throw new Error("the preview listener did not start");
// The host's preferences: the language, and this device's opt-in to previews (the app's own confirm, answered once).
fm.webPrefs.write("operator", new Map<string, unknown>([["lang", LANG_UI], ["preview.optIn", true]]));

const at = `http://${DASH}:${HP}`;
const EXE = process.env.CHROME ?? process.env.HOME + "/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome";
const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox", `--host-resolver-rules=MAP ${DASH} 127.0.0.1, MAP ${FRAME} 127.0.0.1`] });
const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: LANG_UI === "zh-TW" ? "zh-TW" : "en-US" });
await ctx.addInitScript({ content: `try { localStorage.setItem("agend_tour_done", "1"); localStorage.setItem("agend_firstrun_dismissed", "1"); localStorage.setItem("agend_lang", ${JSON.stringify(LANG_UI)}); } catch {}` });
const page = await ctx.newPage();
page.on("dialog", (d: any) => d.accept());
const result: Record<string, unknown> = { scenario: SCENARIO, lang: LANG_UI, dashboard: at, browser: `Chromium ${browser.version()}` };
try {
  await page.goto(`${at}/signin`); await page.waitForSelector("#code");
  fm.initializeWebSessions();
  const { tokenEpoch } = await import(process.env.REPO + "/src/web-session.ts");
  const code = fm.webLoginCodes.issue({ tier: "admin", epoch: tokenEpoch(fm.webToken) }).display;
  await page.locator("#code").evaluate((input: HTMLInputElement, value: string) => {
    input.value = value; input.dispatchEvent(new Event("input", { bubbles: true })); input.form!.requestSubmit();
  }, code);
  await page.waitForURL(`${at}/ui`);
  await page.goto(`${at}/ui/chat/w`);
  await page.waitForSelector("#instanceList a.inst");
  const attrs = await page.evaluate(`Object.fromEntries(["data-dashboard-origin","data-preview-origin","data-preview-reason-code"].map(k => [k, document.body.getAttribute(k)]))`);
  result.pageData = attrs;
  // One agent reply with an HTML block: its card is where a preview starts.
  fm.emitSseEvent("message", { instance: "w", sender: "w", role: "agent", text: "```html\n<p id=ok>rendered</p>\n```", ts: new Date().toISOString() });
  for (let i = 0; i < 50 && Number(await page.evaluate(`document.querySelectorAll(".html-card").length`)) < 1; i++) await page.waitForTimeout(100);
  const note = () => page.evaluate(`(document.querySelector(".html-card .pv-note") || {}).textContent || ""`) as Promise<string>;
  const runnable = Number(await page.evaluate(`[...document.querySelectorAll(".html-card .pv-run")].filter(b => !b.hidden).length`)) > 0;
  result.cardNote = (await note()).trim();
  let rendered = false, frameUrl = "";
  if (runnable) {
    await page.evaluate(`[...document.querySelectorAll(".html-card .pv-run")].at(-1).click()`);
    for (let i = 0; i < 60 && !rendered; i++) {
      const f = page.frames().find((x: any) => x !== page.mainFrame() && x.url().endsWith("/frame"));
      if (f) { frameUrl = f.url(); try { rendered = await f.evaluate("!!document.getElementById('ok')"); } catch { /* navigating */ } }
      await page.waitForTimeout(100);
    }
  }
  result.runButton = runnable; result.frameUrl = frameUrl; result.rendered = rendered;
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, `${SCENARIO}-${LANG_UI}-${EXPECT || "run"}.png`) });
  // What /frame says to the browser's frame request: the exact dashboard origins that may frame it.
  if (SCENARIO === "listed") {
    const csp: string = await new Promise((resolve, reject) => {
      const r = request({ host: "127.0.0.1", port: PP, path: "/frame", headers: { host: `${FRAME}:${PP}` } }, res => { res.resume(); res.on("end", () => resolve(String(res.headers["content-security-policy"]))); });
      r.on("error", reject); r.end();
    });
    const ancestors = (csp.split(";").map(s => s.trim()).find(s => s.startsWith("frame-ancestors")) ?? "");
    result.frameAncestors = ancestors;
    result.frameAncestorsExact = ancestors.includes(`${at}`) && !/'self'|\*/.test(csp);
  }
} finally {
  await browser.close();
  fm.healthServer?.closeAllConnections?.(); fm.healthServer?.close(); fm.stopPreviewListener?.();
}
console.log(JSON.stringify(result));
const worked = result.rendered === true && (SCENARIO !== "listed" || result.frameAncestorsExact === true);
if (EXPECT === "works" && !worked) { console.error("EXPECTED the preview to run; it did not"); process.exit(1); }
if (EXPECT === "refused" && result.rendered === true) { console.error("EXPECTED the preview to be refused; it ran"); process.exit(1); }
process.exit(0);
