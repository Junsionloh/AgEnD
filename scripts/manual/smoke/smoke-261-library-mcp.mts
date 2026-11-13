// AGEND-261: library MCP servers mounted on an agent — in Chromium on the realistic fixture. The "Team MCP servers" card of an agent's settings
// (with a mount; none; a variable with no value and a changed item; a CLI that cannot take them), the confirmation dialog, and the Library's MCP
// rows. Measures that nothing overflows the card or the dialog and the page does not scroll sideways; checks the page never holds a value of
// a variable. Output: 261/<case>-mcp-card.png | -mcp-card-empty.png | -mcp-card-unsupported.png | -mcp-confirm.png | -mcp-library.png and result.json.
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> MATRIX=full npx --prefix <checkout> tsx scripts/manual/smoke/smoke-261-library-mcp.mts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, matrix, caseName, shotPath } from "../smoke-fixture/index.mts";

const fx = await bootFixture({ port: Number(process.env.HP ?? 48561), instances: 6, classic: false });
const { LibraryStore } = await import(process.env.REPO + "/src/library/store.ts");
const { McpConfirmations } = await import(process.env.REPO + "/src/library/mcp-mount.ts");
const store = new LibraryStore(fx.dir);
const confirmations = new McpConfirmations(store);
const names = fx.instances.map((i: any) => i.name);
const SECRET = "ghp_SMOKE_SECRET_VALUE_THAT_MUST_NEVER_SHOW_0123456789";
const mcp = (id: string, description: string, body: string, overwrite = false) => {
  const r = store.addMcp(id, `agend_library: 1\nkind: mcp\nname: ${id}\ndescription: ${description}\n${body}`, { overwrite });
  if (!r.ok) throw new Error(`seed ${id}: ${JSON.stringify(r)}`);
};
const sha = (id: string): string => store.mcpForMount(id).sha256;
const seed = async () => {
  mcp("github", "GitHub issues and pull requests", "transport: stdio\ncommand: npx\nargs:\n  - -y\n  - \"@modelcontextprotocol/server-github\"\nenv:\n  - GITHUB_TOKEN\n  - GITHUB_HOST\n");
  mcp("linear", "Linear issues, over HTTPS", "transport: http\nurl: https://mcp.linear.example.com/v1\nheaders:\n  Authorization: LINEAR_AUTH\n");
  mcp("notes", "Local notes server, no secrets", "transport: stdio\ncommand: node\nargs:\n  - ./tools/notes-mcp.js\n");
  // .env: the token has a value, the host and the linear header do not (a missing variable). The value must never reach a page.
  writeFileSync(join(fx.dir, ".env"), `GITHUB_TOKEN=${SECRET}\n`, { mode: 0o600 });
  const [a, b, c] = names;
  // a: github mounted and confirmed (GITHUB_HOST has no value); linear mounted and confirmed, then edited afterwards (needs confirming again)
  confirmations.confirm(a, "github", sha("github"));
  confirmations.confirm(a, "linear", sha("linear"));
  mcp("linear", "Linear issues, over HTTPS (now with a second header)", "transport: http\nurl: https://mcp.linear.example.com/v1\nheaders:\n  Authorization: LINEAR_AUTH\n  X-Workspace: LINEAR_WORKSPACE\n", true);
  const inst = fx.fm.fleetConfig.instances, raw = fx.fm.rawFleetConfig.instances;
  for (const o of [inst, raw]) {
    o[a].backend = "claude-code"; o[a].library = { mcp: ["github", "linear"] };
    o[b].backend = "claude-code";
    o[c].backend = "grok"; o[c].library = { mcp: ["notes"] };
  }
  // linear's second save changed it: the store's own save recorded the new hash, so a's confirmation is for the old one.
};
const r: any = {};
const view = (c: any) => ({ width: c.device === "desk" ? 1366 : 390, height: c.device === "desk" ? 900 : 844 });
void view;
const measure = `(() => {
  const dlg = document.querySelector(".dlg, [role=dialog]"), card = document.querySelector("[data-library-mcp-field]")?.closest(".card");
  const box = (e) => e && e.getBoundingClientRect();
  const within = (root) => root ? [...root.querySelectorAll("*")].filter((e) => { const b = e.getBoundingClientRect(), p = box(root); return b.width > 0 && (b.right > p.right + 1); }).slice(0, 5).map((e) => e.tagName + "." + e.className) : [];
  return { hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1, cardOver: within(card), dialogOver: within(dlg) };
})()`;
await seed();
for (const c of matrix()) {
  const tag = caseName(c);
  const agent = async (name: string, shot: string, then?: (x: any) => Promise<void>) => {
    const x = await fx.page(c, { path: "/ui/fleet" });
    const errs: string[] = []; x.page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 160)));
    await x.page.goto(`${fx.base}/ui/fleet/agent/${encodeURIComponent(name)}?cat=work#library-mcp`);
    await x.page.waitForSelector("[data-library-mcp-field]", { timeout: 20000 }); await x.page.waitForTimeout(1200);
    if (then) await then(x);
    await x.page.screenshot({ path: shotPath("261", c, shot) });
    const body = await x.page.content();
    r[`${tag}-${shot}`] = { ...(await x.page.evaluate(measure)), valueInPage: body.includes(SECRET), errs, csp: await x.csp(),
      rows: await x.page.locator("[data-library-mcp]").count(), missing: await x.page.locator("[data-library-mcp-missing]").count(), changed: await x.page.locator("[data-library-mcp-changed]").count(),
      unsupported: await x.page.locator("[data-library-mcp-unsupported]").count() };
    await x.ctx.close();
  };
  // with a mount: github (a variable has no value) and linear (changed since it was confirmed)
  await agent(names[0], "mcp-card");
  // no mount at all
  await agent(names[1], "mcp-card-empty");
  // a CLI that cannot take library MCP
  await agent(names[2], "mcp-card-unsupported");
  // ticking an unconfirmed server: exactly what it runs, the variables, set / missing
  await agent(names[1], "mcp-confirm", async (x) => {
    await x.page.locator('[data-library-mcp="github"] input').click();
    await x.page.waitForSelector("[data-library-mcp-review]"); await x.page.waitForTimeout(500);
  });
  // the Library's MCP rows: who uses each, the +
  {
    const x = await fx.page(c, { path: "/ui/library/mcp" });
    const errs: string[] = []; x.page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 160)));
    await x.page.waitForSelector('[data-library-item="mcp:github"]', { timeout: 20000 }); await x.page.waitForTimeout(900);
    await x.page.screenshot({ path: shotPath("261", c, "mcp-library") });
    r[`${tag}-mcp-library`] = { ...(await x.page.evaluate(measure)), tags: await x.page.locator('[data-library-item^="mcp:"] [data-library-tag]').count(), warn: await x.page.locator('[data-library-item^="mcp:"] .lib-tag.warn').count(),
      plus: await x.page.locator('[data-library-item^="mcp:"] [data-library-add-agent]').count(), valueInPage: (await x.page.content()).includes(SECRET), errs, csp: await x.csp() };
    // the + dialog, with what it runs
    await x.page.locator('[data-library-item="mcp:notes"] [data-library-add-agent]').click();
    await x.page.waitForSelector("[data-library-add-dialog] [data-library-mcp-command]", { timeout: 15000 }); await x.page.waitForTimeout(400);
    await x.page.screenshot({ path: shotPath("261", c, "mcp-add") });
    r[`${tag}-mcp-add`] = { ...(await x.page.evaluate(measure)), picks: await x.page.locator("[data-library-pick]").count(), errs };
    await x.ctx.close();
  }
}
writeFileSync(shotPath("261", "result", "x").replace(/-x\.png$/, ".json"), JSON.stringify(r, null, 1));
console.log(JSON.stringify(r, null, 1).slice(0, 14000));
await fx.close(); process.exit(0);
