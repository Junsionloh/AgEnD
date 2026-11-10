import { chromium } from "/home/junsionloh/multica_workspaces/agend-bcac6942356a/agend-132-c29e606c811e/workdir/AgEnD/node_modules/playwright-core/index.mjs";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import yamlLib from "/home/junsionloh/multica_workspaces/agend-bcac6942356a/agend-132-c29e606c811e/workdir/AgEnD/node_modules/js-yaml/index.js";
const W = "/home/junsionloh/multica_workspaces/agend-bcac6942356a/agend-132-c29e606c811e/workdir";
const OUT = `${W}/skew/out`; mkdirSync(OUT, { recursive: true });
const D = "/tmp/ag132s/d", PORT = 19793, base = `http://127.0.0.1:${PORT}`;
const BASE_SHA = "9458db49d", OLDEST = "a2a77ad7d";
const retained = (sha, f) => readFileSync(`${W}/skew/old/${sha}/${f}`, "utf8");
const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const inst = (name) => { const y = yamlLib.load(readFileSync(`${D}/fleet.yaml`, "utf8")); return y.instances?.[name]; };
const cases = [
  { id: "control-new-new", note: "head panel-fleet.js + head accounts-view.js (no retained module)", routes: {} },
  { id: "new-panel-old-accounts-base", note: `head panel-fleet.js with accounts-view.js retained from ${BASE_SHA} (the PR's base)`, routes: { "accounts-view.js": [BASE_SHA, "accounts-view.js"] } },
  { id: "new-panel-old-accounts-oldest", note: `head panel-fleet.js with accounts-view.js retained from ${OLDEST} (first version exporting AccountSelect, #3224)`, routes: { "accounts-view.js": [OLDEST, "accounts-view.js"] } },
  { id: "old-panel-new-server", note: `panel-fleet.js retained from ${BASE_SHA} (the create panel without this PR) against the head server and other head modules`, routes: { "panel-fleet.js": [BASE_SHA, "panel-fleet.js"] } },
];
const views = { desktop: { width: 1280, height: 860 }, phone: { width: 390, height: 800 } };
async function code() { const token = readFileSync(`${D}/web.token`, "utf8").trim();
  const r = await fetch(`${base}/auth/issue-code`, { method: "POST", headers: { "X-Agend-Token": token, "X-Agend-Code-Delivery": "tty" } }); return (await r.json()).code; }
const b = await chromium.launch();
const results = []; let n = 0;
for (const c of cases) for (const [vname, vp] of Object.entries(views)) for (const mode of ["named", "default"]) {
  const name = `sk${++n}-${c.id.replace(/[^a-z]/g, "").slice(0, 8)}-${vname}-${mode}`;
  const rec = { case: c.id, view: vname, mode, instance: name, errors: [], served: {} };
  const ctx = await b.newContext({ locale: "en-US", colorScheme: "light", viewport: views.desktop });
  const pg = await ctx.newPage();
  const listen = () => { pg.on("pageerror", e => rec.errors.push(String(e.message || e).slice(0, 200)));
  pg.on("console", m => { if (m.type() === "error") rec.errors.push(m.text().slice(0, 200)); }); };
  for (const [file, [from, f]] of Object.entries(c.routes)) {
    await ctx.route(`**/ui/js/${file}`, async (route) => { rec.served[file] = (rec.served[file] || 0) + 1; await route.fulfill({ status: 200, contentType: "application/javascript; charset=utf-8", body: retained(from, f) }); });
  }
  try {
    await pg.goto(`${base}/signin#code=${await code()}`); await pg.waitForTimeout(3500); listen();
    await pg.goto(`${base}/settings/agents`); await pg.waitForTimeout(2500);
    await pg.locator("button").filter({ hasText: /New agent/ }).first().click(); await pg.waitForTimeout(1500);
    rec.dialogOpens = await pg.locator(".agent-runtime-picker").count() > 0;
    await pg.locator('.agent-runtime-picker input[value="wsl"]').check({ force: true }); await pg.waitForTimeout(2500);
    if (vname === "phone") { await pg.setViewportSize(vp); await pg.waitForTimeout(600); }
    rec.cli = (await pg.locator(".agent-create-cli .cli-picker-value").first().textContent()).trim();
    const field = pg.locator("#create-host-account");
    rec.fieldPresent = (await field.count()) > 0;
    if (rec.fieldPresent) {
      rec.options = await field.locator("option").allTextContents();
      rec.hint = ((await field.locator("xpath=..").locator(".note").first().textContent()) || "").trim();
      if (mode === "named") { await field.selectOption("work"); await pg.waitForTimeout(400); }
    }
    if (vname === "phone") await pg.locator(".dlg-body").first().evaluate(e => e.scrollTo(0, e.scrollHeight));
    if (mode === "named" || !rec.fieldPresent) await pg.screenshot({ path: `${OUT}/${c.id}-${vname}-${mode}.png` });
    await pg.getByRole("button", { name: "Next" }).click(); await pg.waitForTimeout(1000);
    await pg.locator(".agent-runtime-fields input").nth(1).fill(name);
    await pg.getByRole("button", { name: "Create" }).click(); await pg.waitForTimeout(5000);
    rec.created = (await pg.locator(".agent-create-success").count()) > 0 || /Instance created|Confirmed and applied/.test(await pg.locator("body").innerText());
  } catch (e) { rec.fail = String(e.message).split("\n")[0]; }
  await ctx.close();
  const m = inst(name);
  rec.yaml = m ? m : null;
  rec.profile = m ? (m.backend_options?.["claude-code"]?.credential_profile ?? null) : undefined;
  const expect = mode === "named" && rec.fieldPresent ? "work" : null;
  rec.ok = !rec.fail && rec.dialogOpens && !!m && (rec.profile || null) === expect && rec.errors.length === 0;
  console.log(c.id, vname, mode, "field:", rec.fieldPresent, "profile:", rec.profile, "ok:", rec.ok, rec.fail || "", rec.errors.slice(0, 1).join("|"));
  results.push(rec);
}
await b.close();
writeFileSync(`${OUT}/results.json`, JSON.stringify({ results, retained: Object.fromEntries(Object.entries({ [`accounts-view.js@${BASE_SHA}`]: retained(BASE_SHA, "accounts-view.js"), [`accounts-view.js@${OLDEST}`]: retained(OLDEST, "accounts-view.js"), [`panel-fleet.js@${BASE_SHA}`]: retained(BASE_SHA, "panel-fleet.js") }).map(([k, v]) => [k, sha(v)])) }, null, 2));
