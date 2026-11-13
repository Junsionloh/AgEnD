// AGEND-257: Skill import / export, the Preview / Edit dialog and the one row layout, in Chromium on the realistic fixture —
// the real downloads (one skill, all team skills, a built-in one) read back and compared byte for byte, the real import of a file
// with a new skill, a name clash with a team skill, a name clash with a built-in one, a skill with a secret and file-manager litter,
// the Preview and Edit tabs, and the rows measured: every row has the same two lines, "Details" at the same place on the right,
// centered on the row, nothing wider than the column. Output: 257/<case>-<shot>.png and result.json under OUT.
//   PW_DIR=<checkout> REPO=<checkout> CHROME=<chrome> OUT=<dir> MATRIX=full npx tsx scripts/manual/smoke/smoke-257-skill-transfer.mts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { bootFixture, matrix, caseName, shotPath } from "../smoke-fixture/index.mts";

const fx = await bootFixture({ port: Number(process.env.HP ?? 48557), instances: 8, classic: false });
const REPO = process.env.REPO!;
const { LibraryStore } = await import(REPO + "/src/library/store.ts");
const { writeZip, readZip } = await import(REPO + "/src/library/zip.ts");
const { parseUpload, skillArchive } = await import(REPO + "/src/library/transfer.ts");
const store = new LibraryStore(fx.dir);
const md = (id: string, description: string, body = "Steps…") => `---\nname: ${id}\ndescription: ${description}\nroles: [worker]\n---\n\n# ${id}\n\n${body}\n`;
const names = fx.instances.map((i: any) => i.name);
const inst = fx.fm.fleetConfig.instances, raw = fx.fm.rawFleetConfig.instances;
const seed = () => {
  const add = (id: string, files: Array<{ path: string; content: string }>) => { const r = store.addSkill(id, files); if (!r.ok) throw new Error(`seed ${id}: ${JSON.stringify(r)}`); };
  add("code-review", [{ path: "SKILL.md", content: md("code-review", "Reviews a diff against the team's checklist, one finding per line, with the file and line.", "## Steps\n\n1. Read the **whole** diff.\n2. Run the checklist in `references/checklist.md`.\n3. Report findings, worst first.\n\n- Never approve what you did not read.\n- Quote the line.\n\n```sh\ngit diff main...HEAD\n```\n\n> A review is a conversation.") }, { path: "references/checklist.md", content: "# Checklist\n\n- tests\n- naming\n- secrets\n" }]);
  add("release-notes", [{ path: "SKILL.md", content: md("release-notes", "Drafts release notes from merged pull requests.") }]);
  add("incident-triage", [{ path: "SKILL.md", content: md("incident-triage", "Sorts an incident report into severity and owner, and says what to do in the first ten minutes.") }]);
  add("onboarding-guide", [{ path: "SKILL.md", content: md("onboarding-guide", "Walks a new teammate through the repository.") }]);
  const m = store.addMcp("github", "agend_library: 1\nkind: mcp\nname: github\ndescription: GitHub issues and pull requests\ntransport: stdio\ncommand: npx\nargs:\n  - -y\n  - github-mcp-server\nenv:\n  - GITHUB_TOKEN\n");
  if (!m.ok) throw new Error(JSON.stringify(m));
  // code-review is on five agents (more than a row shows), release-notes on one, the others on none: rows with many tags, one tag and none side by side.
  const mount = (agents: string[], skills: string[]) => { for (const n of agents) { inst[n].library = { skills }; raw[n].library = { skills }; } };
  mount(names.slice(0, 5), ["code-review"]); mount([names[0]!], ["code-review", "release-notes"]);
};
const secret = `gh${"p_"}${"A1b2".repeat(9)}`;
const pack = () => writeZip([
  { name: "incoming-skill/SKILL.md", data: Buffer.from(md("incoming-skill", "A skill from another team's archive.", "Do the thing.\n")) },
  { name: "incoming-skill/references/notes.md", data: Buffer.from("# Notes\n\nSome reference text.\n") },
  { name: "code-review/SKILL.md", data: Buffer.from(md("code-review", "Another team's code review, a different take.", "Look at it.\n")) },
  { name: "concepts/SKILL.md", data: Buffer.from(md("concepts", "Clashes with the built-in one.")) },
  { name: "leaky/SKILL.md", data: Buffer.from(md("leaky", "Has a key in a notes file.")) },
  { name: "leaky/references/notes.md", data: Buffer.from(`# Notes\n\nline\nkey = ${secret}\n`) },
  { name: "__MACOSX/incoming-skill/._SKILL.md", data: Buffer.from("junk") },
  { name: "incoming-skill/.DS_Store", data: Buffer.from("junk") },
]);
const measure = `(() => {
  const rows = [...document.querySelectorAll(".p-library .lib-row")];
  const col = document.querySelector(".p-library .col").getBoundingClientRect();
  const info = rows.map((r) => {
    const rr = r.getBoundingClientRect(), a = r.querySelector(".lib-actions").getBoundingClientRect(), d = r.querySelector("[data-library-view],[data-library-details]").getBoundingClientRect();
    const main = r.querySelector(".lib-main").getBoundingClientRect(), meta = r.querySelector(".lib-meta").getBoundingClientRect();
    const tags = r.querySelectorAll(".lib-tag").length;
    return { id: r.getAttribute("data-library-item") || r.getAttribute("data-library-builtin"), height: Math.round(rr.height), tags,
      detailsRightGap: Math.round(rr.right - d.right), detailsCenterOffset: Math.round((d.top + d.height / 2) - (rr.top + rr.height / 2)),
      twoLines: meta.top >= main.bottom - 1, metaOverflow: r.querySelector(".lib-meta").scrollWidth > r.querySelector(".lib-meta").clientWidth + 1,
      actionsInside: a.right <= rr.right + 0.5 && a.left >= rr.left - 0.5, overRight: Math.round(Math.max(0, [...r.querySelectorAll("*")].reduce((m, e) => Math.max(m, e.getBoundingClientRect().right), 0) - rr.right)) };
  });
  const gaps = new Set(info.map((x) => x.detailsRightGap)), heights = new Set(info.map((x) => x.height));
  return { rows: info.length, withTags: info.filter((x) => x.tags > 0).length, withoutTags: info.filter((x) => x.tags === 0).length, allTwoLines: info.every((x) => x.twoLines),
    detailsRightGaps: [...gaps], detailsCentered: info.every((x) => Math.abs(x.detailsCenterOffset) <= 2), rowHeights: [...heights], metaOverflow: info.filter((x) => x.metaOverflow).map((x) => x.id),
    overRight: info.filter((x) => x.overRight > 1).map((x) => x.id), hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1, colWidth: Math.round(col.width), info };
})()`;
const dlgMeasure = `(() => { const d = document.querySelector("dialog[open] .dlg-box"); if (!d) return null; const r = d.getBoundingClientRect(); const b = document.querySelector("dialog[open] .dlg-body"); return { w: Math.round(r.width), h: Math.round(r.height), vw: innerWidth, vh: innerHeight, fits: r.right <= innerWidth + 1 && r.left >= -1, hscroll: b ? b.scrollWidth > b.clientWidth + 1 : null }; })()`;
const out: any = {};
const same = (a: Buffer, b: Buffer) => a.equals(b);

for (const c of matrix()) {
  const tag = caseName(c);
  if (!store.list().length) seed();
  const x = await fx.page(c, { path: "/ui/library/skills" });
  const errs: string[] = []; x.page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 160)));
  await x.page.waitForSelector("[data-library-builtin]"); await x.page.waitForTimeout(700);
  const R: any = (out[tag] = { errs });
  const shot = (name: string) => x.page.screenshot({ path: shotPath("257", c, name) });
  const L = (en: string, zh: string) => (c.lang === "zh-TW" ? zh : en);

  // 1. the list: Import, Export all, an Export button on each skill row; rows with many tags, one tag, none — and built-in ones
  await x.page.evaluate("window.scrollTo(0, 0)");
  await shot("skills");
  R.rows = await x.page.evaluate(measure);
  R.exportButtons = await x.page.evaluate(`[...document.querySelectorAll("[data-library-export]")].map((e) => e.getAttribute("data-library-export") + ":" + e.getAttribute("href"))`);

  // 2. real downloads, read back
  const download = async (selector: string) => { const [dl] = await Promise.all([x.page.waitForEvent("download"), x.page.locator(selector).first().click()]); const failure = await dl.failure(); if (failure) throw new Error(`download of ${selector} failed: ${failure} (${dl.url()})`); const p = await dl.path(); return { name: dl.suggestedFilename(), bytes: readFileSync(p) }; };
  if (c.device === "desk") {
    const one = await download('[data-library-export="code-review"]');
    const all = await download("[data-library-export-all]");
    const built = await download('[data-library-builtin="skill:concepts"] [data-library-export]');
    const z1 = readZip(one.bytes), zAll = readZip(all.bytes), zB = readZip(built.bytes);
    const disk = (id: string) => store.get("skill", id).detail.files.map((f: any) => [`${id}/${f.path}`, Buffer.from(f.content)]);
    R.downloads = {
      one: { name: one.name, entries: z1.entries.map((e: any) => e.name), identical: disk("code-review").every(([n, b]: any) => same(z1.entries.find((e: any) => e.name === n).data, b)) },
      all: { name: all.name, entries: zAll.entries.map((e: any) => e.name), identical: ["code-review", "release-notes", "incident-triage", "onboarding-guide"].flatMap(disk).every(([n, b]: any) => same(zAll.entries.find((e: any) => e.name === n).data, b)) },
      builtin: { name: built.name, entries: zB.entries.map((e: any) => e.name), identical: same(zB.entries[0].data, readFileSync(`${REPO}/src/general-knowledge/skills/concepts/SKILL.md`)) },
    };
    // export, then import into an empty library: every byte comes back
    mkdirSync(fx.dir + "/_roundtrip", { recursive: true });
    const fresh = new LibraryStore(fx.dir + "/_roundtrip");
    const parsed = parseUpload(all.bytes);
    const res = (await import(REPO + "/src/library/transfer.ts")).applyImport(fresh, parsed.upload.skills, new Map(), new Set());
    R.roundTrip = { statuses: res.map((r: any) => `${r.id}:${r.status}`), sameHashes: JSON.stringify(fresh.list().map((i: any) => [i.id, i.sha256])) === JSON.stringify(store.list().filter((i: any) => i.kind === "skill").map((i: any) => [i.id, i.sha256])) };
  }

  // 3. Preview of a team skill, then Edit (a change typed in, not saved)
  await x.page.locator('[data-library-item="skill:code-review"] [data-library-view]').click();
  await x.page.waitForSelector('[data-library-skill-dialog="team"] [data-library-md] h3'); await x.page.waitForTimeout(400);
  await shot("preview"); R.previewDialog = await x.page.evaluate(dlgMeasure);
  R.previewFields = await x.page.evaluate(`[...document.querySelectorAll("[data-library-fields] .lib-field")].map((e) => e.textContent)`);
  await x.page.locator('[data-library-tab="edit"]').click(); await x.page.waitForSelector("[data-library-edit-text]");
  await x.page.locator("[data-library-edit-text]").fill(md("code-review", "Reviews a diff against the team's checklist, one finding per line, with the file and line.", "## Steps\n\n1. Read the whole diff — twice.\n2. Report findings, worst first.\n"));
  await x.page.waitForTimeout(300);
  await shot("edit"); R.editDialog = await x.page.evaluate(dlgMeasure);
  R.saveEnabled = await x.page.evaluate(`!document.querySelector("[data-library-skill-save]").disabled`);
  // the same skill is on five agents: saving asks first and names them
  await x.page.locator("[data-library-skill-save]").click(); await x.page.waitForSelector('[data-confirm="yes"]');
  R.saveAsks = await x.page.evaluate(`document.querySelector("dialog[open] .confirm-text, .confirm-text")?.textContent`);
  await shot("edit-confirm");
  await x.page.keyboard.press("Escape"); await x.page.waitForTimeout(300);           // not now
  await x.page.locator("dialog[open] .dlg-actions").getByRole("button", { name: L("Close", "關閉"), exact: true }).click();
  await x.page.waitForSelector('[data-confirm="yes"]'); await x.page.locator('[data-confirm="yes"]').click(); await x.page.waitForTimeout(400);   // discard
  R.stillStored = store.get("skill", "code-review").detail.files[0].content.includes("— twice") === false;

  // 4. a built-in skill: preview only
  await x.page.locator('[data-library-builtin="skill:concepts"] [data-library-details]').first().click();
  await x.page.waitForSelector('[data-library-skill-dialog="builtin"] [data-library-md] h3'); await x.page.waitForTimeout(400);
  await shot("builtin");
  R.builtin = { tabs: await x.page.evaluate(`[...document.querySelectorAll("[data-library-tab]")].map((e) => e.getAttribute("data-library-tab"))`), editor: await x.page.locator("[data-library-edit-text]").count(), save: await x.page.locator("[data-library-skill-save]").count(), del: await x.page.locator("[data-library-dialog-delete]").count(), dialog: await x.page.evaluate(dlgMeasure) };
  await x.page.keyboard.press("Escape"); await x.page.waitForTimeout(300);

  // 5. Import: the preview (nothing stored yet), the choice for a name that is taken, the result
  const before = JSON.stringify(store.list().map((i: any) => i.id));
  await x.page.locator("[data-library-import]").click(); await x.page.waitForSelector("[data-library-import-file]", { state: "attached" });
  await shot("import-pick");
  await x.page.setInputFiles("[data-library-import-file]", { name: "team-pack.skill", mimeType: "application/zip", buffer: pack() });
  await x.page.waitForSelector("[data-library-import-found]"); await x.page.waitForTimeout(400);
  R.importFound = await x.page.locator("[data-library-import-found]").textContent();
  R.storedByPreview = JSON.stringify(store.list().map((i: any) => i.id)) !== before;
  await x.page.locator('[data-library-import-skill="incoming-skill"] [data-library-import-text-toggle]').click(); await x.page.waitForTimeout(200);
  await shot("import-preview"); R.importDialog = await x.page.evaluate(dlgMeasure);
  R.clash = { team: await x.page.locator('[data-library-clash="team"] [data-library-choice]').evaluateAll((e: any[]) => e.map((i) => i.getAttribute("data-library-choice") + (i.checked ? "*" : ""))),
    builtin: await x.page.locator('[data-library-clash="builtin"] [data-library-choice]').evaluateAll((e: any[]) => e.map((i) => i.getAttribute("data-library-choice") + (i.checked ? "*" : ""))),
    refused: await x.page.locator('[data-library-import-skill="leaky"] [data-library-import-error]').textContent(),
    secretLeaked: (await x.page.content()).includes(secret) };
  await x.page.locator('[data-library-clash="team"] [data-library-choice="rename"]').check();
  await x.page.locator('[data-library-import-skill="code-review"] [data-library-rename]').fill("code-review-copy");
  await x.page.locator('[data-library-clash="builtin"] [data-library-choice="rename"]').check();
  await x.page.locator('[data-library-import-skill="concepts"] [data-library-rename]').fill("my-concepts");
  await x.page.locator('[data-library-import-skill="code-review"]').scrollIntoViewIfNeeded(); await x.page.waitForTimeout(300);
  await shot("import-conflict");
  R.importButton = await x.page.locator("[data-library-import-go]").textContent();
  await x.page.locator("[data-library-import-go]").click(); await x.page.waitForSelector('[data-library-import-dialog="done"]'); await x.page.waitForTimeout(400);
  await shot("import-result");
  R.importResults = await x.page.locator("[data-library-result]").evaluateAll((e: any[]) => e.map((i) => `${i.getAttribute("data-library-result")}:${i.getAttribute("data-status")}`));
  R.afterImport = store.list().filter((i: any) => i.kind === "skill").map((i: any) => `${i.id}:${i.status}:${i.source?.type ?? "-"}`);
  R.mountedByImport = names.slice(0, 8).filter((n: string) => (inst[n].library?.skills ?? []).some((s: string) => ["incoming-skill", "code-review-copy", "my-concepts"].includes(s)));
  R.importedBytes = JSON.stringify(store.get("skill", "incoming-skill").detail.files.map((f: any) => f.path)) + " " + store.get("skill", "code-review-copy").detail.files[0].content.split("\n")[1];
  await x.page.locator("[data-library-import-close]").click(); await x.page.waitForTimeout(500);
  await x.page.evaluate("window.scrollTo(0, 0)");
  await shot("after-import");
  R.rowsAfterImport = (await x.page.evaluate(measure));
  R.csp = await x.csp();
  await x.ctx.close();
  for (const id of ["incoming-skill", "code-review-copy", "my-concepts"]) store.remove("skill", id);        // the next case starts from the same library
}
writeFileSync(shotPath("257", "result", "x").replace(/result-x\.png$/, "result.json"), JSON.stringify(out, null, 2));
const bad = Object.entries(out).flatMap(([k, v]: any) => [
  ...(v.errs?.length ? [`${k}: page errors ${v.errs}`] : []), ...(v.csp?.length ? [`${k}: csp ${v.csp}`] : []),
  ...(!v.rows?.allTwoLines ? [`${k}: rows not two lines`] : []), ...(v.rows?.detailsRightGaps?.length !== 1 ? [`${k}: Details not at one place ${v.rows?.detailsRightGaps}`] : []),
  ...(!v.rows?.detailsCentered ? [`${k}: Details not centered`] : []), ...(v.rows?.metaOverflow?.length ? [`${k}: line 2 clipped ${v.rows.metaOverflow}`] : []), ...(v.rows?.hscroll ? [`${k}: page scrolls sideways`] : []),
  ...(v.storedByPreview ? [`${k}: preview stored something`] : []), ...(v.mountedByImport?.length ? [`${k}: import mounted ${v.mountedByImport}`] : []),
  ...(v.clash?.secretLeaked ? [`${k}: secret on page`] : []), ...(v.stillStored === false ? [`${k}: discarded edit was stored`] : []),
  ...(v.downloads && !(v.downloads.one.identical && v.downloads.all.identical && v.downloads.builtin.identical && v.roundTrip.sameHashes) ? [`${k}: download not identical`] : []),
]);
console.log(JSON.stringify({ cases: Object.keys(out).length, problems: bad }, null, 2));
await fx.close();
process.exit(bad.length ? 1 : 0);
