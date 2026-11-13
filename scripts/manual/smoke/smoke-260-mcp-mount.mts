// AGEND-260: library MCP mounting in Chromium on the realistic fixture — the Library's MCP page (rows, "used by" tags, a
// "Missing X" mark for a variable AgEnD's environment lacks, a flagged tag on an agent whose CLI cannot take one) and the agent's
// "Team MCP servers" card (ticked, missing, and "not supported yet" on another backend). Also checks that the secret VALUE is in no
// page, and that an agent tag lands on the field. Output: 260/<case>-library-mcp.png | -agent.png | -unsupported.png and result.json.
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> MATRIX=full npx --prefix <checkout> tsx scripts/manual/smoke/smoke-260-mcp-mount.mts
import { writeFileSync } from "node:fs";
import { bootFixture, matrix, caseName, shotPath } from "../smoke-fixture/index.mts";

const SECRET = "s3cr3t-value-Q9x7-never-on-a-page";
process.env.EXAMPLE_TOKEN = SECRET;       // present in the environment AgEnD runs in; GITHUB_TOKEN and DOCS_API_KEY are not
delete process.env.GITHUB_TOKEN; delete process.env.DOCS_API_KEY;
const fx = await bootFixture({ port: Number(process.env.HP ?? 48560), instances: 6, classic: false });
const { LibraryStore } = await import(process.env.REPO + "/src/library/store.ts");
const store = new LibraryStore(fx.dir);
const names = fx.instances.map((i: any) => i.name);
const inst = fx.fm.fleetConfig.instances, raw = fx.fm.rawFleetConfig.instances;
const seed = () => {
  const add = (id: string, text: string) => { const r = store.addMcp(id, text); if (!r.ok) throw new Error(`seed ${id}: ${JSON.stringify(r)}`); };
  add("echo", "agend_library: 1\nkind: mcp\nname: echo\ndescription: A harmless local echo server for trying the mount\ntransport: stdio\ncommand: node\nargs:\n  - echo-mcp.mjs\nenv:\n  - EXAMPLE_TOKEN\n");
  add("github", "agend_library: 1\nkind: mcp\nname: github\ndescription: GitHub issues and pull requests\ntransport: stdio\ncommand: npx\nargs:\n  - -y\n  - github-mcp-server\nenv:\n  - GITHUB_TOKEN\n");
  add("team-docs", "agend_library: 1\nkind: mcp\nname: team-docs\ndescription: The team's documentation search\ntransport: http\nurl: https://docs.example.com/mcp\nheaders:\n  X-Api-Key: DOCS_API_KEY\n");
  add("filesystem-ro", "agend_library: 1\nkind: mcp\nname: filesystem-ro\ndescription: Read-only files under one folder\ntransport: stdio\ncommand: npx\nargs:\n  - -y\n  - \"@modelcontextprotocol/server-filesystem\"\n  - /srv/docs\n");
  const set = (n: string, backend: string, mcp: string[]) => { for (const o of [inst, raw]) { o[n].backend = backend; o[n].library = { mcp }; } };
  set(names[0]!, "claude-code", ["echo", "github", "team-docs"]);
  set(names[1]!, "claude-code", ["echo", "filesystem-ro"]);
  set(names[2]!, "codex", ["echo"]);
};
const r: any = {};
for (const c of matrix()) {
  const tag = caseName(c);
  if (!store.list().length) seed();
  const open = async (path: string, wait: string) => {
    const x = await fx.page(c, { path });
    const errs: string[] = []; x.page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 160)));
    await x.page.waitForSelector(wait); await x.page.waitForTimeout(700);
    return { ...x, errs };
  };
  // 1. the Library's MCP page
  {
    const x = await open("/ui/library/mcp", '[data-library-item="mcp:echo"]');
    await x.page.screenshot({ path: shotPath("260", c, "library-mcp") });
    r[`${tag}-library-mcp`] = {
      rows: await x.page.locator("[data-library-item^='mcp:']").count(),
      missingMarks: await x.page.locator("[data-library-mcp-missing]").evaluateAll((e: any[]) => e.map((i) => i.getAttribute("data-library-mcp-missing"))),
      tagsOnEcho: await x.page.locator('[data-library-item="mcp:echo"] [data-library-tag]').evaluateAll((e: any[]) => e.map((i) => i.getAttribute("data-library-tag") + (i.className.includes("warn") ? "!" : ""))),
      hscroll: await x.page.evaluate("document.documentElement.scrollWidth > document.documentElement.clientWidth + 1"),
      secretOnPage: (await x.page.content()).includes(SECRET), errs: x.errs, csp: await x.csp(),
    };
    await x.ctx.close();
  }
  // 2. an agent tag opens that agent's Team MCP servers card
  {
    const x = await open("/ui/library/mcp", '[data-library-item="mcp:github"] [data-library-tag]');
    const link = x.page.locator('[data-library-item="mcp:github"] [data-library-tag]').first();
    const agent = await link.getAttribute("data-library-tag");
    await link.click(); await x.page.waitForSelector("[data-library-mcp]", { timeout: 15000 }).catch(() => {}); await x.page.waitForTimeout(900);
    const field = x.page.locator("[data-library-mcp]");
    r[`${tag}-agent`] = { agent, url: new URL(x.page.url()).pathname + new URL(x.page.url()).search + new URL(x.page.url()).hash, field: await field.count(), errs: x.errs };
    if (await field.count()) {
      r[`${tag}-agent`].ticked = await x.page.locator("[data-library-mcp-item] input").evaluateAll((e: any[]) => e.filter((i) => i.checked).map((i) => i.closest("[data-library-mcp-item]").getAttribute("data-library-mcp-item")));
      r[`${tag}-agent`].missing = await x.page.locator("[data-library-mcp-missing]").evaluateAll((e: any[]) => e.map((i) => i.textContent));
      r[`${tag}-agent`].secretOnPage = (await x.page.content()).includes(SECRET);
      r[`${tag}-agent`].inView = await field.first().evaluate((e: any) => { const b = (e.closest(".card") || e).getBoundingClientRect(); return b.top >= 0 && b.top < innerHeight - 100; });
      await field.first().scrollIntoViewIfNeeded(); await x.page.waitForTimeout(300);
      await x.page.screenshot({ path: shotPath("260", c, "agent") });
    } else await x.page.screenshot({ path: shotPath("260", c, "agent-miss") });
    await x.ctx.close();
  }
  // 3. an agent on another backend: "not supported yet"
  {
    const x = await open(`/ui/fleet/agent/${encodeURIComponent(names[2]!)}?cat=work#library-mcp`, "[data-library-mcp]");
    r[`${tag}-unsupported`] = { note: await x.page.locator("[data-library-mcp-unsupported]").textContent().catch(() => null), disabledBoxes: await x.page.locator("[data-library-mcp-item] input:disabled").count(), ticked: await x.page.locator("[data-library-mcp-item] input:checked").count(), errs: x.errs };
    await x.page.locator("[data-library-mcp]").first().scrollIntoViewIfNeeded(); await x.page.waitForTimeout(300);
    await x.page.screenshot({ path: shotPath("260", c, "unsupported") });
    await x.ctx.close();
  }
}
writeFileSync(shotPath("260", "result", "x").replace(/-x\.png$/, ".json"), JSON.stringify(r, null, 1));
console.log(JSON.stringify(r, null, 1).slice(0, 9000));
await fx.close(); process.exit(0);
