import { chromium } from "/home/junsionloh/multica_workspaces/agend-bcac6942356a/agend-144-ffe4cc7a7f14/workdir/ev3539/after/node_modules/playwright-core/index.mjs";
import { readFileSync } from "node:fs";
export const OUT = "/home/junsionloh/multica_workspaces/agend-bcac6942356a/agend-144-ffe4cc7a7f14/workdir/evidence/3539";
export const SITES = { before: { port: 19820, D: "/tmp/ev3539-before" }, after: { port: 19821, D: "/tmp/ev3539-after" } };
export const baseOf = (which) => `http://127.0.0.1:${SITES[which].port}`;
export async function launch() { return chromium.launch(); }
export async function issueCode(which) {
  const { D } = SITES[which], base = baseOf(which);
  const token = readFileSync(`${D}/d/web.token`, "utf8").trim();
  return (await (await fetch(`${base}/auth/issue-code`, { method: "POST", headers: { "X-Agend-Token": token, "X-Agend-Code-Delivery": "tty" } })).json()).code;
}
/** A signed-in page on the real Settings shell at /settings/agents, "AI accounts and API keys" open. opts: {which, lang, theme, width, height} */
export async function openAccounts(b, { which, lang = "en", theme = "light", width = 1180, height = 1500, setup } = {}) {
  const base = baseOf(which);
  const ctx = await b.newContext({
    viewport: { width, height }, colorScheme: theme, locale: lang === "zh-TW" ? "zh-TW" : "en-US",
    deviceScaleFactor: width < 600 ? 2 : 1, isMobile: false,
  });
  await ctx.addInitScript(([l, th]) => { try { localStorage.setItem("agend_lang", l); localStorage.setItem("agend_theme", th); } catch {} }, [lang, theme]);
  const pg = await ctx.newPage();
  const errs = [];
  pg.on("pageerror", (e) => errs.push("PAGEERROR " + e.message));
  pg.on("console", (m) => { if (m.type() === "error") errs.push("CONSOLE " + m.text()); });
  pg.on("requestfailed", (r) => errs.push("REQFAILED " + r.url().replace(base, "") + " " + (r.failure() || {}).errorText));
  if (setup) await setup(pg, ctx);
  const code = await issueCode(which);
  await pg.goto(`${base}/signin#code=${code}`); await pg.waitForTimeout(3000);
  // Theme and language live on the HOST (web-prefs.json, "#1665"): the page paints the host's choice over localStorage. So they are set the way the Preferences page sets them: POST /ui/prefs.
  const pr = await pg.evaluate(async ([l, th]) => { const r = await fetch("/ui/prefs", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ set: { theme: th, lang: l } }) }); return r.status; }, [lang, theme]);
  if (pr !== 200) errs.push("PREFS POST status " + pr);
  await pg.goto(`${base}/settings/agents`); await pg.waitForTimeout(2500);
  const sum = pg.locator("details.s-ai-accounts > summary");
  await sum.click(); await pg.waitForTimeout(3500);
  return { ctx, pg, errs, base };
}
export const card = (pg, id) => pg.locator(`.s-account-card[data-backend="${id}"]`);
export const say = async (pg, id) => (await card(pg, id).innerText()).replace(/\s+/g, " ").slice(0, 600);
/** Make the viewport tall enough that the Settings shell's inner scroller (.panel-body) shows everything (the shell scrolls inside, not the document). */
export async function fitViewport(pg, width) {
  for (let i = 0; i < 3; i++) {
    const [sh, ch] = await pg.evaluate(() => { const e = document.querySelector(".panel-body"); return e ? [e.scrollHeight, e.clientHeight] : [0, 0]; });
    const vh = pg.viewportSize().height;
    const want = Math.max(700, vh - ch + sh + 8);
    if (Math.abs(want - vh) < 10) break;
    await pg.setViewportSize({ width, height: Math.min(want, 16000) }); await pg.waitForTimeout(600);
  }
}
export const shotFull = async (pg, width, path) => { await fitViewport(pg, width); await pg.evaluate(() => document.querySelector(".panel-body")?.scrollTo(0, 0)); await pg.waitForTimeout(300); await pg.screenshot({ path }); };
export const LANGS = ["en", "zh-TW"], THEMES = ["light", "dark"];
