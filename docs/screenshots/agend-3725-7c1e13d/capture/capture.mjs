// AGEND-234 capture: node capture.mjs <outDir>
// 8 combos (desktop/phone x light/dark x en/zh-TW) x 3 scenes x {before, after}, against two isolated, already-running instances (instance.sh).
// Records, per image, the page's own "Source build" badge text and the sha256 of the bytes the page was served, into <outDir>/receipt.json.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { launch, baseOf, signedInContext } from "./lib.mjs";

const out = process.argv[2];
mkdirSync(`${out}/single`, { recursive: true });
const SIDES = ["before", "after"];
const COMBOS = [];
for (const device of ["desk", "phone"]) for (const theme of ["light", "dark"]) for (const lang of ["en", "zh-TW"]) COMBOS.push({ device, theme, lang });
if (process.env.ONLY) { const keep = COMBOS.filter(c => process.env.ONLY.split(",").includes(`${c.device}-${c.theme}-${c.lang}`)); COMBOS.length = 0; COMBOS.push(...keep); }
const VIEW = { desk: { width: 1280, height: 900 }, phone: { width: 390, height: 844 } };
const badgeRe = /Source build|原始碼建置/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const served = {};   // side -> { urlPath: { sha256, bytes } } (every /assets, /ui and /api-free static response the pages loaded)

async function api(page, method, path, body) {
  return page.evaluate(async ([method, path, body]) => {
    const r = await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, body: j };
  }, [method, path, body]);
}
async function reset(page) {
  // End whatever either backend has running, so the next scene starts from the same state on both sides.
  for (let i = 0; i < 3; i++) {
    await api(page, "POST", "/ui/browser-backend-signins", { operation: "cancel" });
    await api(page, "POST", "/ui/backend-login/cancel", { backend: "grok" });
    await api(page, "POST", "/ui/backend-login/cancel", { backend: "claude-code" });
    await api(page, "POST", "/ui/backend-login/cancel", {});   // the base has one global window: a body without a backend ends whatever runs
    await sleep(400);
  }
  await page.evaluate(() => { for (const b of document.querySelectorAll('dialog[open] button')) if (/^(Close|關閉)$/.test(b.textContent.trim())) b.click(); });
}
async function openAccounts(page, side) {
  await page.goto(`${baseOf(side)}/settings/agents`);
  await page.waitForSelector(".s-account-card[data-backend=grok]", { timeout: 30000, state: "attached" });
  await page.evaluate(() => document.querySelector("details.s-ai-accounts")?.setAttribute("open", ""));
  await sleep(1200);
}
/** Only for the shot: leave the Claude Code and Grok cards (the two this change is about), hide the others. */
async function onlyTwoCards(page) {
  await page.evaluate(() => { for (const c of document.querySelectorAll(".s-account-card")) if (!["claude-code", "grok"].includes(c.dataset.backend)) c.style.display = "none"; });
}
async function badge(page) {
  const loc = page.getByText(badgeRe).first();
  const text = (await loc.textContent())?.trim() ?? null;
  const png = await loc.screenshot().catch(() => null);
  return { text, png };
}
async function shotCards(page, path) {
  // A tall viewport for this one shot, so the page's fixed top bar and bottom tab bar do not sit on top of the cards (phone).
  const vp = page.viewportSize();
  await page.setViewportSize({ width: vp.width, height: 2600 }); await sleep(1200);
  const box = page.locator(".s-accounts").first();
  await box.scrollIntoViewIfNeeded();
  await box.screenshot({ path });
  await page.setViewportSize(vp); await sleep(500);
}
async function shotViewport(page, path) { await page.screenshot({ path }); }
async function pressConnect(page, backend) {
  const btn = page.locator(`.s-account-card[data-backend=${backend}] .s-account-row[data-account=default] button`).filter({ hasText: /^(Connect|連接|Reconnect|重新連接)$/ }).first();
  const disabled = await btn.isDisabled();
  if (!disabled) await btn.click();
  return { disabled };
}

const browser = await launch();
const receipt = { capturedAt: new Date().toISOString(), sides: {}, images: [] };
for (const combo of COMBOS) {
  for (const side of SIDES) {
    const tag = `${combo.device}-${combo.theme}-${combo.lang}`;
    const { ctx, page } = await signedInContext(browser, side, { viewport: VIEW[combo.device], colorScheme: combo.theme, locale: combo.lang === "en" ? "en-US" : "zh-TW", deviceScaleFactor: 2, isMobile: combo.device === "phone", hasTouch: combo.device === "phone" });
    await ctx.addInitScript({ content: `try { localStorage.setItem("agend_lang","${combo.lang}"); localStorage.setItem("agend_theme","${combo.theme}"); } catch {}` });
    page.on("response", async (r) => {
      try {
        const u = new URL(r.url()); if (!/^\/(assets|ui)\//.test(u.pathname) || r.request().method() !== "GET" || !r.ok()) return;
        if (/\/(backend-login|browser-backend-signins|instances|status)/.test(u.pathname) || /text\/event-stream/.test(r.headers()["content-type"] || "")) return;
        const buf = await r.body(); (served[side] ||= {})[u.pathname] = { sha256: createHash("sha256").update(buf).digest("hex"), bytes: buf.length };
      } catch { /* a response that went away */ }
    });
    const rec = (scene, file, b, extra = {}) => {
      const badgeFile = file.replace(/^single\//, "single/badge-");
      if (b.png) writeFileSync(`${out}/${badgeFile}`, b.png);
      receipt.images.push({ file, side, scene, ...combo, badge: b.text, badgeFile, sha256: createHash("sha256").update(readFileSync(`${out}/${file}`)).digest("hex"), ...extra });
    };
    const keep = {};

    // (a) Claude Code connecting; Grok's Connect.
    await openAccounts(page, side); await reset(page); await openAccounts(page, side);
    await api(page, "POST", "/ui/browser-backend-signins", { operation: "select", backends: ["claude-code"] });
    const start = await api(page, "POST", "/ui/browser-backend-signins", { operation: "start", backend: "claude-code" });
    await openAccounts(page, side); await sleep(2500);
    await page.reload(); await page.waitForSelector(".s-account-card[data-backend=grok]", { state: "attached" }); await page.evaluate(() => document.querySelector("details.s-ai-accounts")?.setAttribute("open", "")); await sleep(2500);
    await onlyTwoCards(page);
    const grokBtn = await page.locator(`.s-account-card[data-backend=grok] .s-account-row[data-account=default] button`).first().isDisabled();
    let b = await badge(page); keep.a = b.png;
    await shotCards(page, `${out}/single/a-grok-connect-${side}-${tag}.png`);
    rec("a", `single/a-grok-connect-${side}-${tag}.png`, b, { grokConnectDisabled: grokBtn, claudeStart: start.status });
    await reset(page);

    // (b) Grok already connecting; Connect pressed for it again (the page disables its own button, so the dialog is opened as the page itself opens it).
    await openAccounts(page, side);
    await page.evaluate(async () => { const m = await import("/ui/js/backend-signin.js"); m.openSignIn({ backend: "grok" }); });
    await page.locator("dialog[open]").getByRole("button", { name: /^(Connect|連接)$/ }).click({ timeout: 15000 });
    await page.waitForSelector(".signin-run", { timeout: 20000 });
    await page.locator("dialog[open]").getByRole("button", { name: /^(Close|關閉)$/ }).first().click();
    await sleep(800);
    await page.evaluate(async () => { const m = await import("/ui/js/backend-signin.js"); m.openSignIn({ backend: "grok" }); });
    await page.waitForSelector(".signin-message", { timeout: 20000 });
    await sleep(800);
    b = await badge(page); keep.b = b.png;
    await shotViewport(page, `${out}/single/b-refused-${side}-${tag}.png`);
    rec("b", `single/b-refused-${side}-${tag}.png`, b, { message: await page.locator(".signin-message").first().textContent() });
    await reset(page);

    // (c) The Claude Code dialog's console-fallback note.
    await openAccounts(page, side);
    const press = await pressConnect(page, "claude-code");
    await page.waitForSelector("dialog[open] .signin-browser", { timeout: 20000 }).catch(() => {});
    await sleep(3500);
    b = await badge(page); keep.c = b.png;
    await shotViewport(page, `${out}/single/c-console-note-${side}-${tag}.png`);
    rec("c", `single/c-console-note-${side}-${tag}.png`, b, { claudeConnectDisabled: press.disabled, hasNote: await page.locator("[data-signin-console-note]").count() });
    await reset(page);
    await ctx.close();
  }
  console.log("done", combo);
}
await browser.close();
receipt.served = served;
writeFileSync(`${out}/receipt-raw-${process.env.ONLY || "all"}.json`, JSON.stringify(receipt, null, 1));
