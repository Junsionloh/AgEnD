// AGEND-248: the Library overview in Chromium on the realistic fixture — one card per category (title and rows in the same box), the
// built-in skills / tool sets / `agend` MCP server read only, "used by", and an agent whose CLI has no skills folder. Also the "Team skills"
// card of an agent's settings. Measures that each category is ONE card holding its title and rows, nothing overflows the column and the
// page does not scroll sideways. Output: 248/<case>-library.png | -empty.png | -agent.png and result.json.
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> MATRIX=full npx --prefix <checkout> tsx scripts/manual/smoke/smoke-248-library-overview.mts
import { writeFileSync } from "node:fs";
import { bootFixture, matrix, caseName, shotPath } from "../smoke-fixture/index.mts";

const fx = await bootFixture({ port: Number(process.env.HP ?? 48548), instances: 6, classic: false });
const { LibraryStore } = await import(process.env.REPO + "/src/library/store.ts");
const store = new LibraryStore(fx.dir);
const skill = (id: string, description: string) => store.addSkill(id, [{ path: "SKILL.md", content: `---\nname: ${id}\ndescription: ${description}\n---\n\n# ${id}\n\nSteps…\n` }]);
const names = fx.instances.map((i: any) => i.name);
const phase = process.argv[2] ?? "";
void phase;
const inst = fx.fm.fleetConfig.instances;
// a few team items, mounted on some agents; one agent on a CLI that has no skills folder
const seed = () => {
  for (const [id, d] of [["code-review", "Reviews a diff against the team's checklist."], ["release-notes", "Drafts release notes from merged pull requests."], ["incident-triage", "Sorts an incident report into severity and owner."]] as const) {
    const r = skill(id, d); if (!r.ok) throw new Error(`seed ${id}: ${JSON.stringify(r)}`);
  }
  const m = store.addMcp("github", "agend_library: 1\nkind: mcp\nname: github\ndescription: GitHub issues and pull requests\ntransport: stdio\ncommand: npx\nargs:\n  - -y\n  - github-mcp-server\nenv:\n  - GITHUB_TOKEN\n");
  if (!m.ok) throw new Error(`seed mcp: ${JSON.stringify(m)}`);
  inst[names[0]].library = { skills: ["code-review", "release-notes"] };
  inst[names[1]].library = { skills: ["code-review"] };
  inst[names[2]].backend = "gemini-cli"; inst[names[2]].library = { skills: ["code-review"] };
  inst[names[3]].tool_set = "minimal";
  // The Settings page reads the user-authored config (before defaults are merged), so the same settings go there too.
  const raw = fx.fm.rawFleetConfig.instances;
  raw[names[0]].library = { skills: ["code-review", "release-notes"] };
  raw[names[1]].library = { skills: ["code-review"] };
  raw[names[2]].backend = "gemini-cli"; raw[names[2]].library = { skills: ["code-review"] };
  raw[names[3]].tool_set = "minimal";
};
const r: any = {};
const measure = `(() => {
  const col = document.querySelector(".p-library .col"); const cr = col.getBoundingClientRect();
  const cards = [...document.querySelectorAll("[data-library-card]")].map((c) => ({ id: c.getAttribute("data-library-card"), title: c.querySelector("h3")?.textContent, rows: c.querySelectorAll(".row-item").length,
    titleInside: !!c.querySelector(":scope > .lib-head h3"), onlyChildren: [...c.children].map((e) => e.className.split(" ")[0]) }));
  const over = [...document.querySelectorAll(".p-library .lib-card *")].filter((e) => e.getBoundingClientRect().right > cr.right + 1).slice(0, 5).map((e) => e.tagName + "." + e.className);
  return { cards, over, hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1, strayRows: document.querySelectorAll(".p-library .col > .row-item").length };
})()`;
for (const c of matrix()) {
  const tag = caseName(c);
  // empty team library first (built-in only), then seeded
  {
    const { ctx, page, csp } = await fx.page(c, { path: "/ui/library" });
    const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 160)));
    await page.waitForSelector("[data-library-card]"); await page.waitForTimeout(600);
    await page.setViewportSize({ width: c.device === "desk" ? 1366 : 390, height: c.device === "desk" ? 2300 : 4200 }); await page.waitForTimeout(300);
    await page.screenshot({ path: shotPath("248", c, "empty") });
    r[`${tag}-empty`] = { ...(await page.evaluate(measure)), errs, csp: await csp() };
    await ctx.close();
  }
  if (!store.list().length) seed();
  {
    const { ctx, page, csp } = await fx.page(c, { path: "/ui/library" });
    const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 160)));
    await page.waitForSelector('[data-library-item="skill:code-review"]'); await page.waitForTimeout(600);
    await page.setViewportSize({ width: c.device === "desk" ? 1366 : 390, height: c.device === "desk" ? 2500 : 4600 }); await page.waitForTimeout(300);
    await page.screenshot({ path: shotPath("248", c, "library") });
    r[`${tag}-library`] = { ...(await page.evaluate(measure)), errs, csp: await csp() };
    await ctx.close();
  }
  {
    const { ctx, page, csp } = await fx.page(c, { path: "/ui/fleet" });
    const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 160)));
    await page.waitForTimeout(1200);
    // the agent's page, its Settings tab, then the Workspace category
    await page.goto(`${fx.base}/ui/fleet/agent/${encodeURIComponent(names[2])}`); await page.waitForTimeout(1200);
    for (const label of ["Settings", "設定"]) { const b = page.locator(".hd-tabs, header, .panel-header").getByText(label, { exact: true }).first(); if (await b.count()) { await b.click().catch(() => {}); await page.waitForTimeout(1200); break; } }
    const tab = page.locator("[data-library-skills]");
    for (const label of ["Workspace", "工作區", "工作目錄"]) { if (await tab.count()) break; const b = page.getByText(label, { exact: true }).first(); if (await b.count()) { await b.click().catch(() => {}); await page.waitForTimeout(900); } }
    const found = await tab.count();
    r[`${tag}-agent`] = { found, noFolder: await page.locator("[data-library-no-folder]").count(), errs, csp: await csp() };
    if (found) { await tab.first().scrollIntoViewIfNeeded(); const box = await tab.first().evaluate((e: any) => { const card = e.closest(".card") || e; const b = card.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; }); await page.screenshot({ path: shotPath("248", c, "agent"), clip: { x: Math.max(0, box.x - 8), y: Math.max(0, box.y - 8), width: box.width + 16, height: Math.min(box.height + 16, 700) } }); }
    else await page.screenshot({ path: shotPath("248", c, "agent-miss") });
    await ctx.close();
  }
}
writeFileSync(shotPath("248", "result", "x").replace(/-x\.png$/, ".json"), JSON.stringify(r, null, 1));
console.log(JSON.stringify(r, null, 1).slice(0, 9000));
await fx.close(); process.exit(0);
