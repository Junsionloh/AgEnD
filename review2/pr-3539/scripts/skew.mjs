// Retained-module / cached-asset skew on the AFTER server (page.route serves the release-tip copy, from git 1be11da91, of the chosen asset). Fresh fleet per variant.
import { launch, openAccounts, card, say, fitViewport, OUT } from "./lib.mjs";
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
const S = `${OUT}/scripts`, R = "/home/junsionloh/multica_workspaces/agend-bcac6942356a/agend-144-ffe4cc7a7f14/workdir/ev3539";
const GIT = "/home/junsionloh/multica_workspaces/agend-bcac6942356a/agend-144-ffe4cc7a7f14/workdir/AgEnD";
const old = (p) => execSync(`git -C ${GIT} show 1be11da91:${p}`, { maxBuffer: 1 << 26 }).toString();
const ASSET = { view: ["/ui/js/accounts-view.js", "src/ui/accounts-view.js", "text/javascript"], host: ["/ui/js/host-install.js", "src/ui/host-install.js", "text/javascript"], css: ["/assets/accounts.css", "src/ui/shared/accounts.css", "text/css"] };
const VARIANTS = [
  ["baseline", []], ["newview-oldhost", ["host"]], ["oldview-newhost", ["view"]], ["oldcss", ["css"]],
  ["oldcss-newview-oldhost", ["css", "host"]], ["oldcss-oldview-newhost", ["css", "view"]], ["allold", ["view", "host", "css"]], ["newcss-oldmodules", ["view", "host"]],
];
mkdirSync(`${OUT}/skew`, { recursive: true }); const logf = `${OUT}/skew/skew-log.txt`; writeFileSync(logf, "");
const L = (s) => { console.log(s); appendFileSync(logf, s + "\n"); };
const b = await launch();
for (const [name, olds] of VARIANTS) {
  execSync(`${S}/fleet.sh stop after ${R}/after 19821; ${S}/setup.sh after 19821 >/dev/null; ${S}/fleet.sh start after ${R}/after 19821`, { stdio: "ignore", shell: "/bin/bash" });
  const hits = {}, posts = [];
  const { pg, errs, ctx } = await openAccounts(b, { which: "after", lang: "en", theme: "light", width: 1180, height: 1400, setup: async (p, c) => {
    for (const k of olds) { const [url, path, type] = ASSET[k]; const body = old(path);
      await c.route((u) => u.pathname === url, (route) => { hits[k] = (hits[k] || 0) + 1; route.fulfill({ status: 200, contentType: type + "; charset=utf-8", headers: { "cache-control": "no-store" }, body }); }); }
    p.on("response", async (r) => { if (r.request().method() === "POST" && /host-(install|update)/.test(r.url())) { let t = ""; try { t = (await r.text()).slice(0, 120); } catch {} posts.push(`${r.url().replace(/^http:\/\/127.0.0.1:\d+/, "")} ${r.request().postData()} -> ${r.status()} ${t}`); } });
  } });
  const el = pg.locator("details.s-ai-accounts");
  const swap = olds.map((k) => `${k}:${hits[k] || 0}`).join(",") || "none";
  const nCards = await pg.locator(".s-account-card").count();
  const btns = await pg.locator("button.s-account-update, button.s-account-install").evaluateAll((els) => els.map((e) => e.closest(".s-account-card").getAttribute("data-backend") + ":" + e.textContent.trim()));
  const versionLines = await pg.locator(".s-account-version").count();
  await fitViewport(pg, 1180); await el.screenshot({ path: `${OUT}/skew/skew-${name}-en.png` });
  const idleErrs = [...errs];
  // click Update (grok) if there is one, then Install (opencode) if there is one
  let actions = [];
  const upd = card(pg, "grok").locator("button.s-account-update");
  if (await upd.count()) { await upd.click(); await pg.waitForTimeout(10000); actions.push("clicked Update(grok)"); } else actions.push("no Update button");
  const inst = card(pg, "opencode").locator("button.s-account-install");
  if (await inst.count()) { await inst.click(); await pg.waitForTimeout(10000); actions.push("clicked Install(opencode)"); } else actions.push("no Install button");
  await fitViewport(pg, 1180); await el.screenshot({ path: `${OUT}/skew/skew-${name}-after-click-en.png` });
  const g = (await say(pg, "grok")).slice(0, 300), o = (await say(pg, "opencode")).slice(0, 300);
  L(`## ${name}: routed(old copies served) ${swap}\n   cards=${nCards} versionLines=${versionLines} buttons=${JSON.stringify(btns)}\n   errors(at idle)=${JSON.stringify(idleErrs)}  errors(all)=${JSON.stringify(errs)}\n   ${actions.join("; ")}; POSTs=${JSON.stringify(posts)}\n   grok after: ${g}\n   opencode after: ${o}`);
  await ctx.close();
}
await b.close();
