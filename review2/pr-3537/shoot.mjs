// Evidence for upstream PR #3537: Settings -> Runtime page of two real AgEnD builds (BEFORE :19810, AFTER :19811).
// Only the paired Windows computer's answers are synthetic (page.route on /ui/runtimes and .../remote-setup); the page's code, css and words are real.
import { chromium } from "/home/junsionloh/multica_workspaces/agend-bcac6942356a/agend-144-ffe4cc7a7f14/workdir/ev3537/after/node_modules/playwright-core/index.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const [OUT, MODE = "all"] = process.argv.slice(2);
const SERVERS = { before: { port: 19810, D: "/tmp/ev3537-before" }, after: { port: 19811, D: "/tmp/ev3537-after" } };
const W = "/home/junsionloh/multica_workspaces/agend-bcac6942356a/agend-144-ffe4cc7a7f14/workdir/ev3537";
const b = await chromium.launch();
const json = (body, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const id = "12345678-1234-4321-abcd-123456789012";
const claude = { id: "claude-code", path: "C:\\Users\\me\\AppData\\Local\\Agend\\cli\\claude.exe", runnable: true, authenticated: true, version: "2.1.316 (Claude Code)", readOnlySupport: true, supports: { execution: true, resume: true, mcp: true }, models: [] };
const machine = { id, name: "Office PC", status: "online", platform: "win32", lastSeenAt: Date.now(), inventoryUpdatedAt: Date.now(),
  runtimeInfo: { version: "2.3.5-alpha", buildId: "a".repeat(64), protocolVersions: [1], capabilities: ["exec", "mcp", "panes", "credential-profiles", "remote-signin", "cli-install"] },
  inventory: { home: "C:\\Users\\me", clis: [claude] } };
let recording = true; const served = {};   // "<server>|<path>" -> sha256 of what the running server returned
const log = [];

async function open(server, { lang, scheme, viewport, tweak, errors }) {
  const { port, D } = SERVERS[server]; const base = `http://127.0.0.1:${port}`;
  const catalog = JSON.parse(readFileSync(`${D}/catalog.json`, "utf8")).map(({ id, version }) => ({ id, version }));
  const token = readFileSync(`${D}/d/web.token`, "utf8").trim();
  const code = (await (await fetch(`${base}/auth/issue-code`, { method: "POST", headers: { "X-Agend-Token": token, "X-Agend-Code-Delivery": "tty" } })).json()).code;
  const ctx = await b.newContext({ viewport, colorScheme: scheme, locale: lang === "zh-TW" ? "zh-TW" : "en-US" });
  await ctx.addInitScript((l) => { try { if (location.pathname !== "/signin") localStorage.setItem("agend_lang", l); } catch {} }, lang);
  const pg = await ctx.newPage();
  pg.on("response", r => { if (r.status() >= 400) errors?.push(`HTTP ${r.status()} ${r.url().replace(base, "")}`); });
  pg.on("requestfailed", r => errors?.push(`requestfailed ${r.url().replace(base, "")} ${r.failure()?.errorText}`));
  pg.on("pageerror", e => errors?.push("pageerror: " + e.message));
  pg.on("console", m => { if (["error", "warning"].includes(m.type())) errors?.push(`console.${m.type()}: ${m.text()}`); });
  pg.on("response", async r => { const u = new URL(r.url()); if (recording && u.origin === base && /\.(js|css)$/.test(u.pathname)) { try { served[`${server}|${u.pathname}`] = createHash("sha256").update(await r.body()).digest("hex"); } catch {} } });
  const json_ = (body) => json(body);
  await pg.route("**/ui/runtimes", r => r.fulfill(json_({ enabled: true, machines: [machine] })));
  await pg.route("**/ui/runtimes/machines/*/remote-setup", r => r.fulfill(json_({ capable: true, online: true, switches: { accounts: { on: false }, install: { on: true, until: Date.now() + 2 * 3600e3 } }, job: null, catalog })));
  if (tweak) await tweak(pg, base);
  await pg.goto(`${base}/signin#code=${code}`); await pg.waitForTimeout(3000);
  await pg.goto(`${base}/settings/runtimes`);
  // the host keeps the language the first context chose (#1665), so set it the way Preferences does: the app's own setLang on this page
  await pg.waitForFunction(() => document.querySelector(".runtime-cli-install") || document.querySelector("main, #app"), null, { timeout: 15000 }).catch(() => {});
  await pg.evaluate(async (l) => { const m = await import("/assets/app-i18n.js"); m.setLang(l); }, lang);
  await pg.locator(".runtime-cli-install").first().waitFor({ timeout: 15000 }).catch(async e => { console.log("NO INSTALL BLOCK", errors?.join(" | ")); await pg.screenshot({ path: `${OUT}/debug-${Date.now()}.png` }); throw e; });
  await pg.waitForTimeout(1500);
  const sum = pg.locator(".runtime-cli-install-others > summary");
  if (!(await pg.locator(".runtime-cli-install-others[open]").count())) await sum.click();
  await pg.waitForTimeout(600);
  return { pg, ctx, base };
}
const state = pg => pg.evaluate(() => ({ lang: document.documentElement.lang, theme: document.documentElement.getAttribute("data-theme"), bg: getComputedStyle(document.body).backgroundColor, h: document.documentElement.scrollHeight, w: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
  rows: [...document.querySelectorAll(".runtime-cli-install-list li")].map(e => e.innerText.replace(/\s+/g, " ")), why: [...document.querySelectorAll(".runtime-cli-install-why")].map(e => e.innerText), cmds: [...document.querySelectorAll(".runtime-command-text")].map(e => e.innerText),
  overflow: [...document.querySelectorAll(".runtime-cli-install *")].filter(e => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX === "visible" || e.getBoundingClientRect().right > document.documentElement.clientWidth + 1).map(e => e.tagName + "." + e.className + " sw=" + e.scrollWidth + " cw=" + e.clientWidth).slice(0, 8),
  raw: (document.querySelector(".runtime-cli-install")?.innerText.match(/runtimeInstall\.\w+|undefined|\[object|NaN/g) || []) }));


// The real Settings shell scrolls inside its own pane, so a plain full-page shot cuts it at the viewport: grow the viewport (same width) to the pane's full
// scroll height, scroll to the top, and shoot — the whole shell, sidebar and Install block, nothing cropped or composited.
async function shot(pg, path) {
  await pg.evaluate(() => { for (const e of document.querySelectorAll("*")) if (e.scrollTop) e.scrollTop = 0; window.scrollTo(0, 0); });
  const extra = await pg.evaluate(() => Math.max(0, ...[...document.querySelectorAll("*")].map(e => { const o = getComputedStyle(e).overflowY; return (o === "auto" || o === "scroll") ? e.scrollHeight - e.clientHeight : 0; })));
  const vp = pg.viewportSize(); const h = Math.min(vp.height + extra, 6000);
  await pg.setViewportSize({ width: vp.width, height: h }); await pg.waitForTimeout(500);
  await pg.screenshot({ path });
  const after = await pg.evaluate(() => Math.max(0, ...[...document.querySelectorAll("*")].map(e => { const o = getComputedStyle(e).overflowY; return (o === "auto" || o === "scroll") ? e.scrollHeight - e.clientHeight : 0; })));
  return { extra, shotHeight: h, leftoverScroll: after };
}
// 1. matrix
if (MODE !== "skew") for (const server of ["before", "after"]) for (const [vn, viewport] of [["desk", { width: 1180, height: 900 }], ["phone", { width: 390, height: 844 }]])
  for (const scheme of ["light", "dark"]) for (const lang of ["en", "zh-TW"]) {
    const errors = []; const { pg, ctx } = await open(server, { lang, scheme, viewport, errors });
    const name = `${vn}-${scheme}-${lang}-${server}`; const f = await shot(pg, `${OUT}/${name}.png`);
    const s = await state(pg); log.push({ name, ...s, frame: f, errors });
    console.log(name, JSON.stringify({ lang: s.lang, theme: s.theme, bg: s.bg, w: s.w, cw: s.cw, frame: f, raw: s.raw, overflow: s.overflow, rows: s.rows.length, why: s.why.length, errors }));
    await ctx.close();
  }
writeFileSync(`${OUT}/matrix-state.json`, JSON.stringify(log, null, 1));
// 2. skew: the AFTER server, with ONE retained OLD file (served by the BEFORE server) in place of the new one
recording = false;
const baseOf = { "cli-caps.js": "/ui/js/cli-caps.js", "runtime-cli-install.js": "/ui/js/runtime-cli-install.js", "runtime-install.css": "/assets/runtime-install.css" };
const afterUrls = Object.keys(served).filter(k => k.startsWith("after|")).map(k => k.slice(6));
writeFileSync(`${OUT}/after-served-assets.txt`, afterUrls.sort().join("\n") + "\n");
const skewLog = [];
for (const [what, file] of [["old-registry", "cli-caps.js"], ["old-install-module", "runtime-cli-install.js"], ["old-css", "runtime-install.css"]]) {
  const url = baseOf[file]; if (!afterUrls.includes(url)) console.log("WARNING: the page did not request", url);
  // the old file comes from the BEFORE server through a signed-in session of its own (/ui/js and /assets answer 401 to an anonymous fetch)
  const bs = await open("before", { lang: "en", scheme: "light", viewport: { width: 1180, height: 900 }, errors: [] });
  const old = await bs.ctx.request.get(`${bs.base}${url}`); const body = await old.body(); await bs.ctx.close();
  if (!old.ok()) throw new Error(`old ${url}: HTTP ${old.status()}`);
  const oldSha = createHash("sha256").update(body).digest("hex"); let hits = 0;
  const errors = [];
  const { pg, ctx } = await open("after", { lang: "en", scheme: "light", viewport: { width: 1180, height: 900 }, errors,
    tweak: async (pg) => { await pg.route(u => new URL(u).pathname === url, r => { hits++; r.fulfill({ status: 200, contentType: old.headers()["content-type"] || "text/javascript", body }); }); } });
  const f = await shot(pg, `${OUT}/skew-${what}-en.png`); const s = await state(pg);
  skewLog.push({ what, url, oldSha, newSha: served[`after|${url}`], hits, rows: s.rows, why: s.why.length, cmds: s.cmds, raw: s.raw, errors, frame: f });
  console.log("SKEW", what, JSON.stringify({ hits, rows: s.rows, why: s.why.length, cmds: s.cmds.length, raw: s.raw, errors }));
  await ctx.close();
}
writeFileSync(`${OUT}/skew-state.json`, JSON.stringify(skewLog, null, 1));
writeFileSync(`${OUT}/served-sha.json`, JSON.stringify(served, null, 1));
await b.close();
