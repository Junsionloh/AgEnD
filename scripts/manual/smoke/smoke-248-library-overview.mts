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
// The layout, measured: the category list is beside the category on a desk (the Settings grid), every row is one compact line, nothing overflows.
const measure = `(() => {
  const nav = document.querySelector(".p-library > .s-nav"), body = document.querySelector(".p-library > .panel-body");
  const nr = nav && nav.getBoundingClientRect(), br = body && body.getBoundingClientRect(), col = document.querySelector(".p-library .col"), cr = col && col.getBoundingClientRect();
  const rows = [...document.querySelectorAll(".p-library .lib-row")];
  const desc = rows.map((e) => e.querySelector(".lib-desc")).filter(Boolean);
  const over = [...document.querySelectorAll(".p-library .lib-card *")].filter((e) => cr && e.getBoundingClientRect().right > cr.right + 1).slice(0, 5).map((e) => e.tagName + "." + e.className);
  return { view: document.querySelector(".p-library")?.getAttribute("data-view"), navVisible: !!nr && nr.width > 0, bodyVisible: !!br && br.width > 0, navBesideBody: !!nr && !!br && nr.width > 0 && nr.right <= br.left + 1,
    navWidth: nr && Math.round(nr.width), bodyWidth: br && Math.round(br.width), colWidth: cr && Math.round(cr.width), rows: rows.length, tags: document.querySelectorAll(".p-library .lib-tag").length,
    descOneLine: desc.every((e) => e.scrollHeight <= e.clientHeight + 2), over, hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 };
})()`;
const manyTeam = () => { for (let i = 1; i <= 12; i++) { const x = skill(`team-skill-${String(i).padStart(2, "0")}`, `Team skill number ${i} - a description that is long enough to be cut to one line on a narrow screen, with detail that belongs in View.`); if (!x.ok) throw new Error(JSON.stringify(x)); } };
const view = (c: any) => ({ width: c.device === "desk" ? 1366 : 390, height: c.device === "desk" ? 900 : 844 });
for (const c of matrix()) {
  const tag = caseName(c);
  if (!store.list().length) { seed(); manyTeam(); }
  const open = async (path: string, wait: string) => {
    const x = await fx.page(c, { path });
    const errs: string[] = []; x.page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 160)));
    await x.page.waitForSelector(wait); await x.page.waitForTimeout(700);
    return { ...x, errs };
  };
  // 1. skills: team (many) and built-in (22), the list of categories beside it (a phone: the list is /ui/library, the category its own page)
  {
    const x = await open(c.device === "desk" ? "/ui/library/skills" : "/ui/library/skills", "[data-library-builtin]");
    await x.page.screenshot({ path: shotPath("248", c, "skills") });
    r[`${tag}-skills`] = { ...(await x.page.evaluate(measure)), errs: x.errs, csp: await x.csp() };
    // a filter narrows both groups
    await x.page.fill("[data-library-filter]", "review"); await x.page.waitForTimeout(300);
    await x.page.screenshot({ path: shotPath("248", c, "skills-filter") });
    r[`${tag}-skills`].filtered = await x.page.evaluate(() => document.querySelectorAll(".p-library .lib-row").length);
    await x.ctx.close();
  }
  {
    const x = await open("/ui/library/tools", '[data-library-builtin^="tools:"]');
    await x.page.screenshot({ path: shotPath("248", c, "tools") });
    r[`${tag}-tools`] = { ...(await x.page.evaluate(measure)), errs: x.errs, csp: await x.csp() };
    await x.ctx.close();
  }
  if (c.device === "phone") {
    const x = await open("/ui/library", ".p-library .s-nav");
    await x.page.screenshot({ path: shotPath("248", c, "index") });
    r[`${tag}-index`] = { ...(await x.page.evaluate(measure)), errs: x.errs, csp: await x.csp() };
    await x.ctx.close();
  }
  // 2. an agent tag opens that agent's Team skills field; the "+" lists the agents that do not have the skill
  {
    const x = await open("/ui/library/skills", '[data-library-item="skill:code-review"] [data-library-tag]');
    const link = x.page.locator('[data-library-item="skill:code-review"] [data-library-tag]').first();
    const name = await link.getAttribute("data-library-tag");
    await link.click(); await x.page.waitForSelector("[data-library-skills]", { timeout: 15000 }).catch(() => {}); await x.page.waitForTimeout(700);
    const field = x.page.locator("[data-library-skills]");
    r[`${tag}-tag-jump`] = { agent: name, url: new URL(x.page.url()).pathname + new URL(x.page.url()).search + new URL(x.page.url()).hash, field: await field.count(), errs: x.errs };
    if (await field.count()) { const box = await field.first().evaluate((e: any) => { const b = (e.closest(".card") || e).getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height, inView: b.top >= 0 && b.top < innerHeight - 100 }; });
      r[`${tag}-tag-jump`].inView = box.inView;
      await x.page.screenshot({ path: shotPath("248", c, "tag-jump") }); }
    await x.ctx.close();
  }
  {
    const x = await open("/ui/library/skills", '[data-library-item="skill:incident-triage"] [data-library-add-agent]');
    await x.page.locator('[data-library-item="skill:incident-triage"] [data-library-add-agent]').click(); await x.page.waitForSelector("[data-library-add-dialog]"); await x.page.waitForTimeout(400);
    r[`${tag}-add`] = { picks: await x.page.locator("[data-library-pick]").count(), noWrite: true, errs: x.errs };
    await x.page.screenshot({ path: shotPath("248", c, "add") });
    await x.ctx.close();
  }
  // 3. the agent's own page: the Team skills field, titled and placed where it is seen
  {
    const x = await open("/ui/fleet", "body");
    await x.page.goto(`${fx.base}/ui/fleet/agent/${encodeURIComponent(names[2])}`); await x.page.waitForTimeout(1200);
    for (const label of ["Settings", "設定"]) { const b = x.page.locator(".hd-tabs, header, .panel-header").getByText(label, { exact: true }).first(); if (await b.count()) { await b.click().catch(() => {}); await x.page.waitForTimeout(1200); break; } }
    const field = x.page.locator("[data-library-skills]");
    for (const label of ["Workspace", "工作區", "工作目錄"]) { if (await field.count()) break; const b = x.page.getByText(label, { exact: true }).first(); if (await b.count()) { await b.click().catch(() => {}); await x.page.waitForTimeout(900); } }
    r[`${tag}-agent`] = { found: await field.count(), noFolder: await x.page.locator("[data-library-no-folder]").count(), cardTitle: await x.page.locator("[data-library-skills]").evaluate((e: any) => (e.closest(".card")?.querySelector("h3")?.textContent) || null).catch(() => null), errs: x.errs, csp: await x.csp() };
    if (await field.count()) await x.page.screenshot({ path: shotPath("248", c, "agent") }); else await x.page.screenshot({ path: shotPath("248", c, "agent-miss") });
    await x.ctx.close();
  }
}
writeFileSync(shotPath("248", "result", "x").replace(/-x\.png$/, ".json"), JSON.stringify(r, null, 1));
console.log(JSON.stringify(r, null, 1).slice(0, 12000));
await fx.close(); process.exit(0);
