// Phone states on the AFTER build: grok (fake, 1.0.70, audited 1.0.77) is updated with the fake installer in mode slow / warn / fail / ok.
import { launch, openAccounts, card, say, shotFull, OUT } from "./lib.mjs";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
const D = "/tmp/ev3539-after", HOME = `${D}/home`;
mkdirSync(`${OUT}/phone-states`, { recursive: true });
const reset = (mode) => { // the fake grok goes back to 1.0.70; the fake installer gets its scripted behaviour
  writeFileSync(`${HOME}/.grok/bin/grok`, `#!/bin/sh\ncase "$1" in --version|-v|version) echo "grok 1.0.70 (50ca579fa996)";; *) echo "fake grok";; esac\n`, { mode: 0o755 });
  writeFileSync(`${D}/ctl/grok`, mode);
};
const combos = [["light", "en"], ["dark", "en"], ["light", "zh-TW"]];
const states = [["running", "slow", 6000], ["warning", "warn", 8000], ["failure", "fail", 8000], ["success", "ok", 12000]];
const only = process.argv[2], comboIdx = process.argv[3];
const b = await launch(); const logf = `${OUT}/phone-states/states-log.txt`; if (!only) writeFileSync(logf, "");
const L = (s) => { console.log(s); appendFileSync(logf, s + "\n"); };
for (const [ci, [theme, lang]] of combos.entries()) if (comboIdx === undefined || String(ci) === comboIdx) for (const [state, mode, wait] of states) {
  if (only && only !== state) continue;
  reset(mode);
  let posts, pg, errs, ctx;
  for (let attempt = 0; attempt < 2; attempt++) { // the host caches the version it read; after the fake binary is reset wait until the page reads 1.0.70 again
    posts = [];
    ({ pg, errs, ctx } = await openAccounts(b, { which: "after", lang, theme, width: 390, height: 844, setup: async (p) => {
      p.on("response", async (r) => { if (r.request().method() === "POST" && /host-(install|update)/.test(r.url())) { let body = ""; try { body = (await r.text()).slice(0, 300); } catch {} posts.push(`${r.request().method()} ${r.url().replace(/^http:\/\/127.0.0.1:\d+/, "")} ${r.request().postData()} -> ${r.status()} ${body}`); } });
    } }));
    if (await card(pg, "grok").locator("button.s-account-update").count()) break;
    L(`   (attempt ${attempt}: grok has no Update button yet; waiting 10 s)`); await ctx.close(); await new Promise((r) => setTimeout(r, 10000));
  }
  const before = await say(pg, "grok");
  await card(pg, "grok").locator("button.s-account-update").click();
  await pg.waitForTimeout(wait);
  const name = `phone-${theme}-${lang}-${state}`;
  await card(pg, "grok").scrollIntoViewIfNeeded();
  await pg.evaluate(() => { const c = document.querySelector('.s-account-card[data-backend="grok"]'); const pb = document.querySelector(".panel-body"); pb.scrollTop += c.getBoundingClientRect().top - 60; });
  await pg.waitForTimeout(400);
  await pg.screenshot({ path: `${OUT}/phone-states/${name}.png` });           // literal 390x844 viewport, grok card in view
  const after = await say(pg, "grok");
  const phase = await pg.locator('.s-account-card[data-backend="grok"] .s-account-install-run').getAttribute("data-phase");
  await shotFull(pg, 390, `${OUT}/phone-states/${name}-fullpage.png`);        // whole Settings page, tall 390-wide viewport
  if (state === "running") { // then cancel, and look at that too
    await pg.evaluate(() => document.querySelector(".panel-body").scrollTo(0, 0));
    const cancel = card(pg, "grok").getByRole("button", { name: lang === "zh-TW" ? "取消更新" : "Cancel update", exact: true });
    const had = await cancel.count();
    if (had) { await cancel.click(); await pg.waitForTimeout(4000); }
    L(`   cancel button present=${had}; after cancel: ${(await say(pg, "grok")).slice(0, 260)}`);
  }
  const oc = await pg.evaluate(() => { const c = document.querySelector('.s-account-card[data-backend="grok"]'); const r = c.getBoundingClientRect(); return { cardW: Math.round(r.width), over: [...c.querySelectorAll("*")].filter((e) => e.getBoundingClientRect().right > innerWidth + 1 || e.scrollWidth > e.clientWidth + 2 && getComputedStyle(e).overflowX === "hidden").slice(0, 4).map((e) => e.tagName + "." + e.className) }; });
  L(`${name}: phase=${phase} POST=${JSON.stringify(posts)} errs=${JSON.stringify(errs.filter((e) => !/401/.test(e)))} card=${JSON.stringify(oc)}\n   BEFORE: ${before.slice(0, 200)}\n   AFTER : ${after.slice(0, 420)}`);
  await ctx.close();
}
await b.close();
