/**
 * AGEND-245: the dialogs — the Library boxes of Export, and the Library rows of Load template in each of the four states: nothing is written before
 * "Fill the form", an MCP server always needs the person's confirmation, and the form (not fleet.yaml) is what receives the ids.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { buildSettingsImpactSchema } from "../src/instance-config-impact.js";
import { buildAgentExport, parseAgentExport, parseAgentLibrary } from "../src/agent-export.js";
import { LibraryStore } from "../src/library/store.js";
import { McpConfirmations } from "../src/library/mcp-mount.js";
import { applyLibrary, compareLibrary, resolveLibraryExport } from "../src/library/agent-transfer.js";
import { builtinSkillNames } from "../src/library/transfer.js";

let p: AppPage, D: any;
const dirs: string[] = [];
const calls: Array<{ url: string; body: any }> = [];
const md = (name: string, extra = ""): string => `---\nname: ${name}\ndescription: Does ${name} things\n---\n\n# ${name}\n${extra}\n`;
const mcpText = (id: string, extra = ""): string => `agend_library: 1\nkind: mcp\nname: ${id}\ndescription: ${id} server\ntransport: stdio\ncommand: npx\nargs:\n  - -y\n  - ${id}-mcp\nenv:\n  - MCP_${id.toUpperCase()}_TOKEN\n${extra}`;
const SECRET = "tok-9f8e7d6c5b4a-SECRET";
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), "agend-xlui-")); dirs.push(d); return d; };

// The two computers: the one that exports (its agent has the library items) and the one that loads.
let source: { store: LibraryStore; dir: string; inst: any };
let here: { store: LibraryStore; dir: string };
const fleet = { instances: {} as Record<string, any> };

beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19281/ui/fleet/agent/coder" });
  (globalThis as any).fetch = async (url: string, opts: any) => {
    const body = JSON.parse(opts.body);
    calls.push({ url, body });
    let out: unknown;
    if (url.endsWith("/parse")) out = parseAgentExport(body.text);
    else if (url.endsWith("/build")) {
      const inst = fleet.instances[body.instance];
      out = buildAgentExport(body.instance, inst, body.include, resolveLibraryExport(source.store, inst.library, { skills: body.include.includes("librarySkills"), mcp: body.include.includes("libraryMcp"), embed: body.embed === true }));
    } else {
      const lib = parseAgentLibrary(body.text)!;
      const host = { envPath: join(here.dir, ".env"), builtin: builtinSkillNames() };
      out = url.endsWith("/library-status") ? { ok: true, ...compareLibrary(here.store, lib, host) } : { ok: true, ...applyLibrary(here.store, lib, body.choices, { ...host, agent: body.instance }) };
    }
    return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(out)) };
  };
  D = await import("/ui/js/settings-dialogs.js");
});
afterAll(() => p.restore());
afterEach(async () => { calls.length = 0; await p.unmount(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function world() {
  const sd = tmp(); const store = new LibraryStore(sd);
  store.addSkill("ui-review", [{ path: "SKILL.md", content: md("ui-review") }]);
  store.addSkill("sleepy", [{ path: "SKILL.md", content: md("sleepy") }]);
  store.addMcp("github", mcpText("github"));
  store.addMcp("linear", mcpText("linear"));
  source = { store, dir: sd, inst: { backend: "claude-code", description: "Reviews", library: { skills: ["ui-review"], mcp: ["github"], paused: { skills: ["sleepy"], mcp: ["linear"] } } } };
  const hd = tmp(); here = { store: new LibraryStore(hd), dir: hd };
}

async function basic(inst: Record<string, unknown>) {
  fleet.instances.coder = inst;
  const out: { m?: any } = {};
  const ctx = { fleet: { defaults: {}, instances: { coder: inst } }, schema: buildSettingsImpactSchema(), stageAgent: vi.fn(), drafts: new Map(),
    channelType: () => "telegram", shortName: (n: string) => n, staged: new Map(), reload: vi.fn() };
  function Basic() {
    const m = D.useAgentForm({ name: "coder", inst, ctx });
    out.m = m;
    return h("section", null, h(D.AgentFields, { m, cat: "basic" }));
  }
  await p.mount(h(Basic, null));
  await settle(6);
  const $ = (sel: string) => p.root.querySelector(sel) as any;
  const $$ = (sel: string) => [...p.root.querySelectorAll(sel)] as any[];
  const click = async (sel: string) => { fire($(sel), "click"); await settle(8); };
  const check = async (sel: string, on: boolean) => { const el = $(sel); el.checked = on; fire(el, "change"); await settle(8); };
  const type = async (sel: string, value: string) => { const el = $(sel); el.value = value; fire(el, "input"); await settle(8); };
  return { $, $$, click, check, type, patch: () => out.m.pending(), form: () => out.m.f };
}
const own = { backend: "claude-code", working_directory: "/w" };
const row = (f: any, kind: string, id: string) => f.$(`[data-import-row="${kind}:${id}"]`);

async function load(f: any, text: string) {
  await f.click("[data-template-load]");
  await f.type("[data-load-text]", text);
  await f.click("[data-load-check]");
}
const exportFile = (embed: boolean): string => buildAgentExport("coder", source.inst, ["identity", "librarySkills", "libraryMcp"], resolveLibraryExport(source.store, source.inst.library, { skills: true, mcp: true, embed })).text!;

describe("Export: the Library boxes", () => {
  it("shows the agent's counts, defaults to references only, and Bundle asks for the definitions", async () => {
    world();
    const f = await basic(source.inst);
    await f.click("[data-template-export]");
    expect(f.$("[data-export-library]")).toBeTruthy();
    expect(f.$('[data-export-group="librarySkills"]').parentNode.textContent).toContain("(2)");
    expect(f.$('[data-export-group="libraryMcp"]').parentNode.textContent).toContain("(2)");
    expect(calls[0]!.body).toMatchObject({ embed: false });
    expect(f.$("[data-export-preview]").value).toContain("sha256:");
    expect(f.$("[data-export-preview]").value).not.toContain("definition");
    await f.check("[data-export-embed]", true);
    expect(calls.at(-1)!.body.embed).toBe(true);
    expect(f.$("[data-export-preview]").value).toContain("definition:");
    expect(f.$("[data-export-preview]").value).toContain("archive:");
    await f.check('[data-export-group="libraryMcp"]', false);
    expect(calls.at(-1)!.body.include).not.toContain("libraryMcp");
    expect(f.$("[data-export-preview]").value).not.toContain("definition:");
  });
  it("an agent with nothing assigned says so, and the boxes are off", async () => {
    world();
    const f = await basic({ ...own, description: "d" });
    await f.click("[data-template-export]");
    expect(f.$("[data-export-library-none]")).toBeTruthy();
    expect(f.$('[data-export-group="librarySkills"]').disabled).toBe(true);
  });
  it("an assigned item that is gone from the Library is said to be left out", async () => {
    world();
    source.store.remove("mcp", "linear");
    const f = await basic(source.inst);
    await f.click("[data-template-export]");
    expect(f.$('[data-export-library-omitted="gone"]')).toBeTruthy();
  });
});

describe("Load template: the four states", () => {
  /** here: ui-review has the same bytes (present), sleepy another version (differs); the file bundles everything, so github is missing-embedded. */
  it("present / differs / missing-embedded / missing are each shown, and nothing is written by checking", async () => {
    world();
    const text = exportFile(true);
    const sleepyFiles = [{ path: "SKILL.md", content: md("sleepy", "local edition") }];
    here.store.addSkill("ui-review", [{ path: "SKILL.md", content: md("ui-review") }]);
    here.store.addSkill("sleepy", sleepyFiles);
    const f = await basic(own);
    await load(f, text);
    expect(row(f, "skill", "ui-review").getAttribute("data-import-status")).toBe("present");
    expect(row(f, "skill", "sleepy").getAttribute("data-import-status")).toBe("differs");
    expect(row(f, "mcp", "github").getAttribute("data-import-status")).toBe("missing-embedded");
    expect(f.$("[data-load-library-section]")).toBeTruthy();
    expect(here.store.list().map((i) => i.id).sort()).toEqual(["sleepy", "ui-review"]);          // checking wrote nothing
  });

  it("reference-only: a missing item is skipped with a warning and the variable to set — the rest of the file still fills", async () => {
    world();
    const f = await basic(own);
    await load(f, exportFile(false));
    expect(row(f, "skill", "ui-review").getAttribute("data-import-status")).toBe("missing");
    expect(row(f, "skill", "ui-review").querySelector("[data-import-missing]")).toBeTruthy();
    expect(row(f, "mcp", "github").querySelector("[data-import-vars]").textContent).toContain("MCP_GITHUB_TOKEN");
    await f.click("[data-load-fill]");
    expect(f.patch()).toMatchObject({ description: "Reviews" });
    expect(f.patch().library).toBeUndefined();
    expect(here.store.list()).toEqual([]);
  });

  it("missing-embedded: SKILL.md can be read first; nothing is added until it is ticked and the form is filled; then the Library has it and the form the id (paused ones paused)", async () => {
    world();
    const f = await basic(own);
    await load(f, exportFile(true));
    await f.click('[data-import-skill-text-toggle="ui-review"]');
    expect(f.$('[data-import-skill-text="ui-review"]').textContent).toContain("# ui-review");
    // nothing ticked: Fill is still allowed (the other fields), and adds nothing
    expect(f.$("[data-load-fill]").disabled).toBe(false);
    await f.check(`[data-import-row="skill:ui-review"] [data-import-choice="add"]`, true);
    await f.check(`[data-import-row="skill:sleepy"] [data-import-choice="add"]`, true);
    expect(here.store.list()).toEqual([]);
    await f.click("[data-load-fill]");
    expect(f.$("[data-load-text]")).toBeFalsy();
    expect(here.store.list().map((i) => i.id).sort()).toEqual(["sleepy", "ui-review"]);
    expect(f.patch().library).toEqual({ skills: ["ui-review"], paused: { skills: ["sleepy"] } });
  });

  it("an MCP server is added only after its whole command and variable names were in view and the box was ticked; the confirmation is for this agent", async () => {
    world();
    writeFileSync(join(here.dir, ".env"), `MCP_GITHUB_TOKEN=${SECRET}\n`);
    const f = await basic(own);
    await load(f, exportFile(true));
    const gh = row(f, "mcp", "github");
    expect(gh.querySelector("[data-library-mcp-command]").textContent).toBe("npx -y github-mcp");
    expect(gh.querySelector('[data-library-mcp-var="MCP_GITHUB_TOKEN"]').textContent).toContain("set");
    expect(p.root.textContent).not.toContain(SECRET);
    const li = row(f, "mcp", "linear");
    expect(li.querySelector("[data-import-envhint]").textContent).toContain("MCP_LINEAR_TOKEN");
    // not confirmed: nothing to do
    await f.click("[data-load-fill]");
    expect(calls.some((c) => c.url.endsWith("/library-apply"))).toBe(false);
    expect(f.patch().library).toBeUndefined();
    // a second try on a fresh dialog, with the box ticked
    const g = f;
    await g.click("[data-template-load]");
    await g.type("[data-load-text]", exportFile(true));
    await g.click("[data-load-check]");
    await g.check(`[data-import-row="mcp:github"] [data-import-confirm]`, true);
    await g.click("[data-load-fill]");
    const apply = calls.find((c) => c.url.endsWith("/library-apply"))!;
    expect(apply.body.instance).toBe("coder");
    expect(apply.body.choices.mcp).toEqual({ github: { action: "add", confirm: expect.stringMatching(/^[0-9a-f]{64}$/) } });
    expect(JSON.stringify(apply.body)).not.toContain(SECRET);
    expect(new McpConfirmations(here.store).forAgent("coder")).toHaveProperty("github");
    expect(g.patch().library).toEqual({ mcp: ["github"] });
  });

  it("differs: the local item is not replaced — use it, or save the file's under a new id (checked before it is sent)", async () => {
    world();
    here.store.addSkill("sleepy", [{ path: "SKILL.md", content: md("sleepy", "local edition") }]);
    const localSha = (here.store.get("skill", "sleepy") as any).detail.sha256;
    const f = await basic(own);
    await load(f, exportFile(true));
    await f.check(`[data-import-row="skill:sleepy"] [data-import-choice="rename"]`, true);
    expect(f.$("[data-import-rename]").value).toBe("sleepy-imported");
    await f.type("[data-import-rename]", "Bad Name");
    expect(f.$("[data-load-fill]").disabled).toBe(true);                 // an unusable new id blocks Fill
    await f.type("[data-import-rename]", "sleepy-theirs");
    expect(f.$("[data-load-fill]").disabled).toBe(false);
    await f.click("[data-load-fill]");
    expect((here.store.get("skill", "sleepy") as any).detail.sha256).toBe(localSha);
    expect(here.store.skillForMount("sleepy-theirs").ok).toBe(true);
    expect(f.patch().library).toEqual({ paused: { skills: ["sleepy-theirs"] } });
  });

  it("what is already assigned to the form is kept: ids are added, not replaced, and an id the agent already has keeps its state", async () => {
    world();
    here.store.addSkill("ui-review", [{ path: "SKILL.md", content: md("ui-review") }]);
    const f = await basic({ ...own, library: { skills: ["mine"], paused: { skills: ["ui-review"] } } });
    await load(f, exportFile(true));
    await f.click("[data-load-fill]");
    // ui-review was already paused on this agent: it stays paused; "mine" is untouched
    expect(f.form().library_skills).toEqual(["mine"]);
    expect(f.form().library_paused.skills).toEqual(["ui-review"]);
  });

  it("a failed add keeps the dialog open, says which and why, fills nothing, and shows the rows as they are now", async () => {
    world();
    const f = await basic(own);
    await load(f, exportFile(true));
    // someone added "ui-review" to this Library (another version) after the file was checked
    here.store.addSkill("ui-review", [{ path: "SKILL.md", content: md("ui-review", "other") }]);
    await f.check(`[data-import-row="skill:ui-review"] [data-import-choice="add"]`, true);
    await f.click("[data-load-fill]");
    expect(f.$("[data-import-failure='ui-review']")).toBeTruthy();
    expect(f.$("[data-load-text]")).toBeTruthy();
    expect(f.patch()).toEqual({});
    expect(row(f, "skill", "ui-review").getAttribute("data-import-status")).toBe("differs");
  });
});

describe("Load template in Chinese", () => {
  it("the Library rows are translated", async () => {
    const i18n = await import("/assets/app-i18n.js");
    i18n.setLang("zh-TW");
    try {
      world();
      const f = await basic(own);
      await load(f, exportFile(true));
      expect(f.$("[data-load-library-section]").textContent).toContain("資源庫");
      expect(row(f, "mcp", "github").textContent).toContain("我已讀過");
      expect(f.$("[data-load-library-section]").textContent).not.toMatch(/agentLibrary\./);
    } finally { i18n.setLang("en"); }
  });
});
