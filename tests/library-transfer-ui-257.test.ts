/**
 * AGEND-257: the Library page's new parts — Export / Import buttons, the skill dialog's Preview and Edit tabs (a built-in skill has no Edit),
 * the import dialog (preview, the three ways to settle a name, the result), and one row layout for every item. The real panel in the mini
 * DOM with the server stubbed; the server's rules are tests/library-transfer-257.test.ts and library-transfer-api-257.test.ts.
 */
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";

let p: AppPage, L: any, S: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19283/ui/library/skills", storage: { agend_tour_done: "1" } });
  L = await import("/ui/js/panel-library.js" as string);
  S = await import("/ui/js/library-skill.js" as string);
});
afterAll(() => { p.restore(); });
afterEach(async () => { await p.unmount(); vi.unstubAllGlobals(); (globalThis as any).confirm = undefined; (globalThis as any).history.replaceState(null, "", "/ui/library/skills"); });

const ITEMS = [
  { kind: "skill", id: "review", description: "Reviews code", status: "ok", files: 2, size: 2048, sha256: "a".repeat(64) },
  { kind: "skill", id: "triage", description: "Sorts issues", status: "ok", files: 1, size: 100 },
  { kind: "mcp", id: "github", description: "GitHub", status: "ok", size: 300 },
];
const AGENTS = ["coder", "helper", "oldcli", "extra"].map((name) => ({ name, backend: "claude-code", role: "worker", toolSet: "worker", windows: false, nativeSkills: true }));
const OVERVIEW = {
  agents: AGENTS,
  builtinSkills: [{ name: "concepts", description: "What AgEnD is", roles: ["general", "worker"], agents: ["coder"] }, { name: "hub", description: "The Hub", roles: ["general"], agents: [] }],
  toolSets: [{ name: "worker", tools: ["reply"], agents: ["coder"] }], mcp: [{ name: "agend", agents: ["coder"] }],
  teamUsage: { review: ["coder", "helper", "oldcli", "extra"] },
};
const TEAM_DETAIL = { kind: "skill", id: "review", sha256: "b".repeat(64), description: "Reviews code",
  fields: [{ key: "name", value: "review" }, { key: "description", value: "Reviews code" }, { key: "roles", value: "worker" }], body: "# Review\n\nLook **hard**.\n",
  files: [{ path: "SKILL.md", content: "---\nname: review\ndescription: Reviews code\nroles: [worker]\n---\n# Review\n\nLook **hard**.\n", size: 90 }, { path: "ref/a.md", content: "reference text", size: 14 }] };
const BUILTIN_DETAIL = { kind: "skill", id: "concepts", builtin: true, fields: [{ key: "name", value: "concepts" }, { key: "description", value: "What AgEnD is" }], body: "# Concepts\n",
  files: [{ path: "SKILL.md", content: "---\nname: concepts\ndescription: What AgEnD is\n---\n# Concepts\n", size: 60 }] };

type Call = { url: string; method: string; body: any; raw?: boolean };
function serve(extra: Record<string, (c: Call) => { status: number; body: unknown }> = {}, calls: Call[] = []) {
  const routes: Record<string, (c: Call) => { status: number; body: unknown }> = {
    "/ui/library/list": () => ({ status: 200, body: { items: ITEMS } }),
    "/ui/library/overview": () => ({ status: 200, body: OVERVIEW }),
    "/ui/library/item": () => ({ status: 200, body: { ok: true, detail: TEAM_DETAIL } }),
    "/ui/library/builtin": () => ({ status: 200, body: { ok: true, detail: BUILTIN_DETAIL } }),
    ...extra,
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: any) => {
    const raw = init?.body && typeof init.body !== "string";
    const c: Call = { url, method: init?.method ?? "GET", body: init?.body && !raw ? JSON.parse(init.body) : init?.body, raw: !!raw };
    calls.push(c);
    const a = (routes[url.split("?")[0]!] ?? (() => ({ status: 200, body: { ok: true } })))(c);
    return { ok: a.status < 400, status: a.status, json: async () => a.body };
  }));
  return calls;
}
const open = async (section = "skills", lang = "en") => {
  (globalThis as any).history.replaceState(null, "", `/ui/library/${section}`);
  await p.mount(h(L.LibraryPanel, { route: { panel: "library", section }, navKey: `library:${section}|1|${lang}` })); await settle();
};
const q = (sel: string) => p.document.querySelector(sel) as any;
const qa = (sel: string) => p.document.querySelectorAll(sel) as any[];
const ev = (el: any, type: string) => el.dispatchEvent(new (globalThis as any).Event(type, { bubbles: true }));
const typeInto = async (el: any, value: string) => { el.value = value; ev(el, "input"); await settle(); };

describe("Export and Import on the Skills page", () => {
  it("has Import and Export all above the skills, and an Export link on each skill row (team and built-in) that downloads <id>.zip; MCP rows and tool sets have none", async () => {
    serve(); await open();
    expect(q("[data-library-import]")).not.toBeNull();
    const all = q("[data-library-export-all]");
    expect(all.tagName).toBe("A");
    expect(all.getAttribute("href")).toBe("/ui/library/export-all");
    expect(all.getAttribute("download")).toBe("agend-team-skills.zip");
    const one = q('[data-library-item="skill:review"] [data-library-export]');
    expect(one.getAttribute("href")).toBe("/ui/library/export?id=review");
    expect(one.getAttribute("download")).toBe("review.zip");
    expect(one.getAttribute("aria-label")).toBe("Export “review”");
    expect(q('[data-library-builtin="skill:concepts"] [data-library-export]')).not.toBeNull();
    await p.unmount(); serve(); await open("mcp");
    expect(qa("[data-library-export]").length).toBe(0);
    expect(q("[data-library-import]")).toBeNull();
    await p.unmount(); serve(); await open("tools");
    expect(qa("[data-library-export]").length).toBe(0);
  });

  it("with no team skill, Export all is there but disabled (nothing to export)", async () => {
    serve({ "/ui/library/list": () => ({ status: 200, body: { items: [] } }) }); await open();
    const all = q("[data-library-export-all]");
    expect(all.tagName).toBe("BUTTON");
    expect(all.disabled).toBe(true);
  });
});

describe("one row layout for every category", () => {
  it("each row — with many agent tags or none, built in or the team's, in all three categories — has the same four parts in the same order, Details inside the actions", async () => {
    const parts = (r: any) => r.children.map((c: any) => c.className.split(" ")[0]);
    let seen = 0;
    for (const section of ["skills", "tools", "mcp"]) {
      serve(); await open(section);
      const rows = qa(".lib-row");
      expect(rows.length, section).toBeGreaterThanOrEqual(1);
      for (const r of rows) {
        expect(parts(r), section).toEqual(["lib-ico", "lib-main", "lib-meta", "lib-actions"]);
        expect(r.querySelector(".lib-actions [data-library-view], .lib-actions [data-library-details]"), section).not.toBeNull();
        expect(r.querySelector(".lib-meta .pill:last-child"), section).not.toBeNull();       // the built in / team marker closes line 2
      }
      seen += rows.length;
      await p.unmount();
    }
    expect(seen).toBe(7);                                                              // 2 team + 2 built-in skills, 1 tool set, 1 team + 1 built-in MCP
  });

  it("an item with four agents shows three tags and a +N; one with none shows 'No agent' — both in the same line", async () => {
    serve(); await open();
    const many = '[data-library-item="skill:review"]', none = '[data-library-item="skill:triage"]';
    expect(qa(`${many} [data-library-tag]`).length).toBe(3);
    expect(q(`${many} [data-library-more]`).textContent).toBe("+1");
    expect(q(`${none} .lib-meta`).textContent).toContain("No agent");
    expect(q(`${many} .lib-meta`)).not.toBeNull();
  });

  it("the stylesheet: a two-line grid with the actions in their own right-hand column, tags that never wrap, and only Details on a phone", () => {
    const css = readFileSync("src/ui/shared/app.css", "utf8");
    expect(css).toMatch(/\.p-library \.lib-row \{[^}]*display: grid[^}]*grid-template-areas: "ico main act" "ico meta act"/);
    expect(css).toMatch(/\.p-library \.lib-actions \{[^}]*grid-area: act[^}]*justify-self: end[^}]*align-self: center/);
    expect(css).toMatch(/\.p-library \.lib-tags \{[^}]*flex-wrap: nowrap/);
    expect(css).toMatch(/\.p-library \.lib-meta \{[^}]*flex-wrap: nowrap[^}]*overflow: hidden/);
    expect(css).toMatch(/@media \(max-width: 599px\) \{[^}]*\.lib-act-extra/);
    expect(css).not.toMatch(/\.p-library \.lib-row \{[^}]*flex-wrap: wrap/);
  });
});

describe("the skill dialog: Preview and Edit", () => {
  it("a team skill opens on Preview (frontmatter as fields, SKILL.md as Markdown, the other files listed and opened as text) with an Edit tab", async () => {
    serve(); await open();
    q('[data-library-item="skill:review"] [data-library-view]').click(); await settle();
    const dlg = q('[data-library-skill-dialog="team"]');
    expect(dlg).not.toBeNull();
    expect(qa("[data-library-tab]").map((b: any) => b.getAttribute("data-library-tab"))).toEqual(["preview", "edit"]);
    expect(q('[data-library-tab="preview"]').getAttribute("aria-selected")).toBe("true");
    expect(q("[data-library-fields]").textContent).toContain("Reviews code");
    expect(q("[data-library-fields]").textContent).toContain("Roles");
    expect(q("[data-library-md]").innerHTML).toContain("<h3");                                // rendered by the chat's Markdown renderer
    expect(q("[data-library-md]").innerHTML).toContain("<strong>hard</strong>");
    expect(q("[data-library-skill-used]").textContent).toBe("coder, helper, oldcli, extra");
    expect(qa("[data-library-files] li").length).toBe(2);
    expect(q('[data-library-file-text="ref/a.md"]')).toBeNull();
    q('[data-library-file-toggle="ref/a.md"]').click(); await settle();
    expect(q('[data-library-file-text="ref/a.md"]').textContent).toBe("reference text");
    expect(q("[data-library-export-one]").getAttribute("href")).toBe("/ui/library/export?id=review");
    expect(q("[data-library-dialog-delete]")).not.toBeNull();
  });

  it("text in a skill is text: markup in SKILL.md is not drawn as markup", async () => {
    const evil = "# T\n\n<img src=x onerror=alert(1)><script>alert(2)</script>\n";
    serve({ "/ui/library/item": () => ({ status: 200, body: { ok: true, detail: { ...TEAM_DETAIL, body: evil } } }) }); await open();
    q('[data-library-item="skill:review"] [data-library-view]').click(); await settle();
    const md = q("[data-library-md]");
    expect(md.querySelector("script")).toBeNull();
    expect(md.querySelector("img")).toBeNull();
    expect(md.textContent).toContain("<script>");
  });

  it("a built-in skill has only Preview: no Edit tab, no editor, no Save, no Delete — and can be exported", async () => {
    serve(); await open();
    q('[data-library-builtin="skill:concepts"] [data-library-details]').click(); await settle();
    expect(q('[data-library-skill-dialog="builtin"]')).not.toBeNull();
    expect(qa("[data-library-tab]").map((b: any) => b.getAttribute("data-library-tab"))).toEqual(["preview"]);
    expect(q("[data-library-pane=\"edit\"]")).toBeNull();
    expect(q("[data-library-edit-text]")).toBeNull();
    expect(q("[data-library-skill-save]")).toBeNull();
    expect(q("[data-library-dialog-delete]")).toBeNull();
    expect(q("[data-library-skill-dialog] .note").textContent).toContain("preview only");
    expect(q("[data-library-export-one]").getAttribute("href")).toBe("/ui/library/export?id=concepts&builtin=1");
    expect(q("[data-library-md]").innerHTML).toContain("<h3");
  });

  it("Edit: a change is saved by the library's own save with the hash the editor read; agents that have the skill are named first; the saved hash is read again", async () => {
    const calls: Call[] = [];
    serve({ "/ui/library/save": () => ({ status: 200, body: { ok: true, sha256: "c".repeat(64) } }) }, calls);
    const asked: string[] = [];
    (globalThis as any).confirm = (m: string) => { asked.push(m); return true; };
    await open();
    q('[data-library-item="skill:review"] [data-library-view]').click(); await settle();
    q('[data-library-tab="edit"]').click(); await settle();
    expect(q("[data-library-skill-save]").disabled).toBe(true);                                // nothing changed yet
    expect(q("[data-library-edit-text]").value).toContain("name: review");
    await typeInto(q("[data-library-edit-text]"), TEAM_DETAIL.files[0]!.content + "\nMore.\n");
    expect(q("[data-library-skill-save]").disabled).toBe(false);
    q("[data-library-skill-save]").click(); await settle(12);
    expect(asked.join("\n")).toContain("coder, helper, oldcli, extra");
    expect(asked.join("\n")).toContain("next time they start");
    const save = calls.find((c) => c.url === "/ui/library/save")!;
    expect(save.body).toMatchObject({ kind: "skill", id: "review", overwrite: true, expect: "b".repeat(64) });
    expect(save.body.files).toEqual([{ path: "SKILL.md", content: TEAM_DETAIL.files[0]!.content + "\nMore.\n" }, { path: "ref/a.md", content: "reference text" }]);
    expect(calls.filter((c) => c.url.startsWith("/ui/library/item")).length).toBe(2);         // read again after the save
    expect(q('[data-library-tab="preview"]').getAttribute("aria-selected")).toBe("true");
  });

  it("Edit: a refused save keeps the text, says why (the file and line of a secret, never the secret) and is not shown as saved", async () => {
    const calls: Call[] = [];
    serve({ "/ui/library/save": () => ({ status: 400, body: { error: "secret_found", findings: [{ field: "ref/a.md", line: 3, kind: "api_key" }] } }) }, calls);
    (globalThis as any).confirm = () => true;
    await open();
    q('[data-library-item="skill:triage"] [data-library-view]').click(); await settle();
    q('[data-library-tab="edit"]').click(); await settle();
    await typeInto(q("[data-library-edit-text]"), "edited");
    q("[data-library-skill-save]").click(); await settle(12);
    expect(q("[data-library-error]").textContent).toContain("ref/a.md, line 3");
    expect(q("[data-library-edit-text]").value).toBe("edited");
    expect(q('[data-library-tab="edit"]').getAttribute("aria-selected")).toBe("true");
  });

  it("Edit: a skill nobody has is saved without asking; closing with unsaved changes asks first", async () => {
    const calls: Call[] = [];
    serve({ "/ui/library/item": () => ({ status: 200, body: { ok: true, detail: { ...TEAM_DETAIL, id: "triage" } } }) }, calls);
    const asked: string[] = [];
    (globalThis as any).confirm = (m: string) => { asked.push(m); return false; };
    await open();
    q('[data-library-item="skill:triage"] [data-library-view]').click(); await settle();
    q('[data-library-tab="edit"]').click(); await settle();
    await typeInto(q("[data-library-edit-text]"), "edited");
    q("[data-library-skill-save]").click(); await settle(12);
    expect(asked).toEqual([]);                                                                 // nobody has it: no question
    expect(calls.some((c) => c.url === "/ui/library/save")).toBe(true);
  });
});

describe("the import dialog", () => {
  const PREVIEW = { ok: true, format: "zip", sha256: "d".repeat(64), ignored: ["__MACOSX/x"], skills: [
    { id: "fresh", ok: true, conflict: "none", description: "A new one", skillMd: "---\nname: fresh\ndescription: A new one\n---\nDo it\n", files: [{ path: "SKILL.md", size: 50 }] },
    { id: "review", ok: true, conflict: "team", description: "Another review", skillMd: "---\nname: review\n---\nx", files: [{ path: "SKILL.md", size: 30 }, { path: "a.md", size: 3 }] },
    { id: "concepts", ok: true, conflict: "builtin", description: "Clash", skillMd: "x", files: [{ path: "SKILL.md", size: 30 }] },
    { id: "leak", ok: false, conflict: "none", error: "secret_found", findings: [{ field: "n.md", line: 2, kind: "api_key" }] },
  ] };
  const choose = async (name = "pack.skill", size = 1000) => {
    const input = q("[data-library-import-file]");
    input.files = [{ name, size, arrayBuffer: async () => new Uint8Array([80, 75, 3, 4]).buffer }];
    ev(input, "change"); await settle(12);
  };

  it("shows what is in the file before anything is stored: each skill's description and files, SKILL.md in full on request, what is refused and where, and what was left out", async () => {
    const calls = serve({ "/ui/library/import/preview": () => ({ status: 200, body: PREVIEW }) });
    await open();
    q("[data-library-import]").click(); await settle();
    expect(q("[data-library-import-dialog]").getAttribute("data-library-import-dialog")).toBe("pick");
    await choose();
    const pre = calls.find((c) => c.url.startsWith("/ui/library/import/preview"))!;
    expect(pre).toMatchObject({ method: "POST", raw: true });
    expect(pre.url).toContain("filename=pack.skill");
    expect(q("[data-library-import-found]").textContent).toBe("4 skills in “pack.skill”");
    expect(q("[data-library-import-dialog]").textContent).toContain("Left out of the archive: __MACOSX/x");
    expect(q('[data-library-import-skill="fresh"]').textContent).toContain("A new one");
    expect(q('[data-library-import-skill="review"]').textContent).toContain("SKILL.md, a.md");
    expect(q('[data-library-import-skill="fresh"] [data-library-import-text]')).toBeNull();
    q('[data-library-import-skill="fresh"] [data-library-import-text-toggle]').click(); await settle();
    expect(q('[data-library-import-skill="fresh"] [data-library-import-text]').textContent).toContain("Do it");
    const bad = q('[data-library-import-skill="leak"]');
    expect(bad.textContent).toContain("n.md, line 2");
    expect(bad.querySelector("[data-library-choice]")).toBeNull();                            // nothing to choose about a skill that cannot be imported
    expect(calls.some((c) => c.url.startsWith("/ui/library/import?"))).toBe(false);          // nothing stored by looking
  });

  it("a name that is taken: replace / another name / skip (skip until chosen); a built-in name cannot be replaced; the import sends the preview's hash and each choice", async () => {
    const calls = serve({
      "/ui/library/import/preview": () => ({ status: 200, body: PREVIEW }),
      "/ui/library/import": () => ({ status: 200, body: { ok: true, results: [
        { id: "fresh", status: "imported", savedAs: "fresh" }, { id: "review", status: "replaced", savedAs: "review" }, { id: "concepts", status: "renamed", savedAs: "my-concepts" },
        { id: "leak", status: "rejected", error: "secret_found", findings: [{ field: "n.md", line: 2 }] } ] } }),
    }, []);
    await open();
    q("[data-library-import]").click(); await settle();
    await choose();
    expect(q('[data-library-clash="builtin"]').textContent).toContain("never replaced");
    expect(q('[data-library-clash="builtin"] [data-library-choice="overwrite"]')).toBeNull();
    expect(q('[data-library-clash="team"] [data-library-choice="overwrite"]')).not.toBeNull();
    expect(q('[data-library-clash="team"] [data-library-choice="skip"]').checked).toBe(true);   // nothing is replaced until the admin says so
    expect(q("[data-library-import-go]").textContent).toBe("Import (1)");                       // only the new one so far
    const radio = (id: string, v: string) => { const el = q(`[data-library-clash] [name="lib-clash-${id}"][data-library-choice="${v}"]`) ?? q(`[data-library-import-skill="${id}"] [data-library-choice="${v}"]`); el.checked = true; ev(el, "change"); return settle(); };
    await radio("review", "overwrite");
    await radio("concepts", "rename");
    await typeInto(q('[data-library-import-skill="concepts"] [data-library-rename]'), "my-concepts");
    expect(q("[data-library-import-go]").textContent).toBe("Import (3)");
    await typeInto(q('[data-library-import-skill="concepts"] [data-library-rename]'), "Bad Name!");
    expect(q('[data-library-import-skill="concepts"]').textContent).toContain("Lowercase letters");
    expect(q("[data-library-import-go]").disabled).toBe(true);
    await typeInto(q('[data-library-import-skill="concepts"] [data-library-rename]'), "my-concepts");
    q("[data-library-import-go]").click(); await settle(12);
    const go = calls.find((c) => c.url.startsWith("/ui/library/import?"))!;
    expect(go).toMatchObject({ method: "POST", raw: true });
    const params = new URLSearchParams(go.url.split("?")[1]);
    expect(params.get("sha256")).toBe("d".repeat(64));
    expect(JSON.parse(params.get("decisions")!)).toEqual({ fresh: { action: "add" }, review: { action: "overwrite" }, concepts: { action: "rename", as: "my-concepts" } });
    expect(q('[data-library-import-dialog]').getAttribute("data-library-import-dialog")).toBe("done");
    expect(qa("[data-library-result]").map((r: any) => `${r.getAttribute("data-library-result")}:${r.getAttribute("data-status")}`)).toEqual(["fresh:imported", "review:replaced", "concepts:renamed", "leak:rejected"]);
    expect(q("[data-library-results]").textContent).toContain("Imported as “my-concepts”");
    expect(q("[data-library-results]").textContent).toContain("n.md, line 2");
    expect(q("[data-library-import-dialog]").textContent).toContain("No agent has them yet");
    expect(calls.filter((c) => c.url === "/ui/library/list").length).toBeGreaterThan(1);       // the list is read again
  });

  it("a file that cannot be read is said so in words and nothing else happens; a file that is too large is not even sent", async () => {
    const calls = serve({ "/ui/library/import/preview": () => ({ status: 400, body: { error: "invalid_path", path: "../evil/SKILL.md" } }) });
    await open();
    q("[data-library-import]").click(); await settle();
    await choose("evil.zip");
    expect(q("[data-library-error]").textContent).toContain("../evil/SKILL.md");
    expect(q("[data-library-import-go]")).toBeNull();
    const before = calls.length;
    await choose("huge.zip", 17 * 1024 * 1024);
    expect(q("[data-library-error]").textContent).toContain("larger than 16 MB");
    expect(calls.length).toBe(before);
  });
});

describe("words", () => {
  it("every word of the new module exists in English and zh-TW with the same placeholders, and the page's new error words too", () => {
    const table = (src: string, from: string, to: string) => {
      const block = src.slice(src.indexOf(from), src.indexOf(to));
      return new Map([...block.matchAll(/(?:^|[\s,{])([a-zA-Z_0-9]+): "((?:[^"\\]|\\.)*)"/g)].map((m) => [m[1]!, m[2]!] as const));
    };
    const holes = (v: string) => [...new Set(v.match(/\{\d\}/g) ?? [])].sort().join("");
    const src = readFileSync("src/ui/library-skill.js", "utf8");
    const e = table(src, "  en: {", '  "zh-TW": {'), z = table(src, '  "zh-TW": {', "const tn =");
    expect(e.size).toBeGreaterThan(60);
    expect([...z.keys()].sort()).toEqual([...e.keys()].sort());
    for (const [k, v] of e) { expect(v.length, k).toBeGreaterThan(0); expect(holes(z.get(k)!), k).toBe(holes(v)); }
    // every key the module asks for is defined
    const used = new Set([...src.matchAll(/\btn\("([a-zA-Z_0-9]+)"/g)].map((m) => m[1]!).concat([...src.matchAll(/tn\(`(r_|why_)\$\{/g)].flatMap(() => [...e.keys()].filter((k) => /^(r_|why_)/.test(k)))));
    for (const k of used) expect(e.has(k), k).toBe(true);
  });

  it("zh-TW shows in the dialogs (the module's own namespace is registered)", async () => {
    const I = await import("/assets/app-i18n.js" as string);
    expect(I.t("librarySkill.tabPreview")).toBe("Preview");
    I.setLang("zh-TW", { store: false });
    try {
      expect(I.t("librarySkill.tabPreview")).toBe("預覽");
      expect(I.t("librarySkill.tabEdit")).toBe("編輯");
      expect(I.t("library.exportAll")).toBe("導出全部");
      expect(I.t("library.importBtn")).toBe("導入");
    } finally { I.setLang("en", { store: false }); }
  });
});
