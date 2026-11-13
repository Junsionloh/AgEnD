// AGEND-261: library MCP servers mounted on an agent — in Chromium on the realistic fixture. The "Team MCP servers" card of an agent's settings
// (with a mount; none; a variable with no value and a changed item; a CLI that cannot take them), the confirmation dialog, and the Library's MCP
// rows. Measures that nothing overflows the card or the dialog and the page does not scroll sideways; checks the page never holds a value of
// a variable. Output: 261/<case>-empty.png | -mounted.png | -unsupported.png | -picker-list.png | -picker-skill.png | -picker-mcp.png | -mcp-library.png | -mcp-add.png and result.json.
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
  for (const [id, d] of [["code-review", "Reviews a diff against the team's checklist."], ["release-notes", "Drafts release notes from merged pull requests."], ["incident-triage", "Sorts an incident report into severity and owner."]] as const) {
    const k = store.addSkill(id, [{ path: "SKILL.md", content: `---\nname: ${id}\ndescription: ${d}\nroles: [general, worker]\n---\n\n# ${id}\n\n1. Read the input.\n2. Apply the checklist.\n3. Report what you found.\n` }, { path: "checklist.md", content: "- one\n- two\n" }]);
    if (!k.ok) throw new Error(`seed skill ${id}: ${JSON.stringify(k)}`);
  }
  const inst = fx.fm.fleetConfig.instances, raw = fx.fm.rawFleetConfig.instances;
  for (const o of [inst, raw]) {
    o[a].backend = "claude-code"; o[a].library = { skills: ["code-review"], mcp: ["github", "linear"] };
    o[b].backend = "claude-code";
    o[c].backend = "grok"; o[c].library = { mcp: ["notes"] };
  }
  // linear's second save changed it: the store's own save recorded the new hash, so a's confirmation is for the old one.
};
const r: any = {};
const view = (c: any) => ({ width: c.device === "desk" ? 1366 : 390, height: c.device === "desk" ? 900 : 844 });
void view;
const measure = `(() => {
  const dlg = document.querySelector(".dlg, [role=dialog]"), card = document.querySelector("[data-library-mcp-field]");
  const box = (e) => e && e.getBoundingClientRect();
  const within = (root) => root ? [...root.querySelectorAll("*")].filter((e) => !e.closest("dialog, [role=dialog]") || root === dlg).filter((e) => { const b = e.getBoundingClientRect(), p = box(root); return b.width > 0 && (b.right > p.right + 1); }).slice(0, 5).map((e) => e.tagName + "." + e.className) : [];
  return { hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1, cardOver: within(card), dialogOver: within(dlg) };
})()`;
await seed();
for (const c of matrix()) {
  const tag = caseName(c);
  /** An agent's Workspace page, the Skills card at the top of the view (the MCP servers card right under it). `then` drives the page; the shot follows. */
  const agent = async (name: string, shot: string, then?: (x: any) => Promise<void>, anchor = "[data-library-skills]") => {
    const x = await fx.page(c, { path: "/ui/fleet" });
    const errs: string[] = []; x.page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 160)));
    await x.page.goto(`${fx.base}/ui/fleet/agent/${encodeURIComponent(name)}?cat=work`);
    await x.page.waitForSelector("[data-library-mcp-field]", { timeout: 20000 }); await x.page.waitForTimeout(1500);
    await x.page.locator(anchor).evaluate((e: any) => e.scrollIntoView({ block: "start" })); await x.page.waitForTimeout(300);
    if (then) await then(x);
    await x.page.screenshot({ path: shotPath("261", c, shot) });
    const body = await x.page.content();
    r[`${tag}-${shot}`] = { ...(await x.page.evaluate(measure)), valueInPage: body.includes(SECRET), errs, csp: await x.csp(),
      skillRows: await x.page.locator("[data-library-skills] [data-library-skill]").count(), mcpRows: await x.page.locator("[data-library-mcp-field] [data-library-mcp]").count(),
      builtinLines: await x.page.locator("[data-library-builtin-summary]").count(), noCheckbox: (await x.page.locator("[data-library-skills] input[type=checkbox], [data-library-mcp-field] input[type=checkbox]").count()) === 0,
      missing: await x.page.locator("[data-library-mcp-missing]").count(), changed: await x.page.locator("[data-library-mcp-changed]").count(), unsupported: await x.page.locator("[data-library-mcp-unsupported]").count(),
      oldSubheading: await x.page.locator("[data-library-skills] .s-lab, [data-library-mcp-field] .s-lab").count() };
    await x.ctx.close();
  };
  // only the built-in ones (an agent with nothing from the Library): the empty state
  await agent(names[1], "empty");
  // with enabled items: a skill, github (a variable has no value) and linear (changed since it was confirmed); the built-in line opened on the MCP card
  await agent(names[0], "mounted", async (x) => { await x.page.locator("[data-library-mcp-field] [data-library-builtin-toggle]").click(); await x.page.waitForTimeout(300); });
  // a CLI that cannot take library MCP
  await agent(names[2], "unsupported", undefined, "[data-library-mcp-field]");
  // the picker: the list (not yet enabled, with a filter), a skill's preview (257's), an MCP server's preview (the command, the variables)
  await agent(names[1], "picker-list", async (x) => {
    await x.page.locator("[data-library-skills] [data-library-add-open]").click(); await x.page.waitForSelector("[data-library-picker=list]"); await x.page.waitForTimeout(500);
  });
  await agent(names[1], "picker-skill", async (x) => {
    await x.page.locator("[data-library-skills] [data-library-add-open]").click(); await x.page.waitForSelector("[data-library-picker=list]");
    await x.page.locator('[data-library-pick-item="code-review"]').click(); await x.page.waitForSelector("[data-library-picker-preview] [data-library-md]"); await x.page.waitForTimeout(500);
  });
  await agent(names[1], "picker-mcp", async (x) => {
    await x.page.locator("[data-library-mcp-field] [data-library-add-open]").click(); await x.page.waitForSelector("[data-library-picker=list]");
    await x.page.locator('[data-library-pick-item="github"]').click(); await x.page.waitForSelector("[data-library-picker-preview] [data-library-mcp-command]"); await x.page.waitForTimeout(500);
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
