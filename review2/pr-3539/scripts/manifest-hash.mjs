// sha256 of each asset AS FETCHED FROM THE RUNNING SERVER (signed-in session) vs the same file in the git commit.
import { launch, issueCode, baseOf, OUT } from "./lib.mjs";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const GIT = "/home/junsionloh/multica_workspaces/agend-bcac6942356a/agend-144-ffe4cc7a7f14/workdir/AgEnD";
const SHA = { before: "1be11da91", after: "c79c501fb" };
const ASSETS = [
  ["/ui/js/accounts-view.js", "src/ui/accounts-view.js"], ["/ui/js/host-install.js", "src/ui/host-install.js"], ["/assets/accounts.css", "src/ui/shared/accounts.css"],
  ["/ui/js/settings-confirm.js", "src/ui/settings-confirm.js"], ["/ui/js/accounts-manage.js", "src/ui/accounts-manage.js"], ["/ui/js/accounts-keepalive.js", "src/ui/accounts-keepalive.js"],
  ["/assets/accounts-keepalive.css", "src/ui/shared/accounts-keepalive.css"], ["/assets/app-i18n.js", "src/ui/shared/app-i18n.js"], ["/assets/ui-toast.js", "src/ui/shared/ui-toast.js"],
  ["/assets/app-html.js", "src/ui/shared/app-html.js"], ["/assets/app-store.js", "src/ui/shared/app-store.js"],
];
const h = (buf) => createHash("sha256").update(buf).digest("hex");
const b = await launch(); const rows = [];
for (const which of ["before", "after"]) {
  const ctx = await b.newContext(); const pg = await ctx.newPage(); const base = baseOf(which);
  await pg.goto(`${base}/signin#code=${await issueCode(which)}`); await pg.waitForTimeout(3000);
  for (const [url, path] of ASSETS) {
    const r = await ctx.request.get(base + url); const served = r.ok() ? h(await r.body()) : `HTTP ${r.status()}`;
    let git; try { git = h(execSync(`git -C ${GIT} show ${SHA[which]}:${path}`, { maxBuffer: 1 << 26 })); } catch { git = "(not in commit)"; }
    rows.push(`| ${which} | \`${url}\` | \`${path}\` | \`${served}\` | \`${git}\` | ${served === git ? "match" : "MISMATCH"} |`);
  }
  await ctx.close();
}
writeFileSync(`${OUT}/scripts/hashes.md`, "| build | served URL | git path | sha256 served | sha256 git | |\n|---|---|---|---|---|---|\n" + rows.join("\n") + "\n");
console.log(rows.join("\n"));
await b.close();
