/**
 * AGEND-245: an agent's export / import carries its Library skills and MCP servers — the `library` block, the four import states, bundled and
 * reference-only files, and that no variable value, no secret and no unconfirmed MCP server ever travels.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { parse } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { LibraryStore } from "../src/library/store.js";
import { McpConfirmations } from "../src/library/mcp-mount.js";
import { buildAgentExport, parseAgentExport, parseAgentLibrary } from "../src/agent-export.js";
import { applyLibrary, compareLibrary, resolveLibraryExport } from "../src/library/agent-transfer.js";
import { EXPORT_LIBRARY_EMBED_CHARS } from "../src/library/export-format.js";
import { builtinSkillNames } from "../src/library/transfer.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const home = (): string => { const d = mkdtempSync(join(tmpdir(), "agend-xl-")); dirs.push(d); return d; };
const md = (name: string, extra = ""): string => `---\nname: ${name}\ndescription: Does ${name} things\n---\n\n# ${name}\n\nSteps${extra}\n`;
const mcpText = (id: string, extra = ""): string => `agend_library: 1\nkind: mcp\nname: ${id}\ndescription: ${id} server\ntransport: stdio\ncommand: npx\nargs:\n  - -y\n  - ${id}-mcp\nenv:\n  - MCP_${id.toUpperCase()}_TOKEN\n${extra}`;
const SECRET = "tok-9f8e7d6c5b4a-SECRET";
const builtin = builtinSkillNames();

/** The exporter's computer: a Library with a skill and two MCP servers, and an agent that has them (one skill and one server paused). */
function exporter() {
  const dir = home(); const store = new LibraryStore(dir);
  expect(store.addSkill("ui-review", [{ path: "SKILL.md", content: md("ui-review") }, { path: "notes/a.md", content: "# a\n" }], { source: { type: "import", from: "ui-review.zip" } }).ok).toBe(true);
  expect(store.addSkill("sleepy", [{ path: "SKILL.md", content: md("sleepy") }]).ok).toBe(true);
  expect(store.addMcp("github", mcpText("github")).ok).toBe(true);
  expect(store.addMcp("linear", mcpText("linear")).ok).toBe(true);
  writeFileSync(join(dir, ".env"), `MCP_GITHUB_TOKEN=${SECRET}\nMCP_LINEAR_TOKEN=${SECRET}2\n`);
  const inst = { backend: "claude-code", library: { skills: ["ui-review"], mcp: ["github"], paused: { skills: ["sleepy"], mcp: ["linear"] } } };
  return { dir, store, inst };
}
const ALL = ["identity", "librarySkills", "libraryMcp"];
const exportWith = (x: ReturnType<typeof exporter>, include: string[], embed: boolean, inst: object = x.inst) =>
  buildAgentExport("coder", { description: "d", ...inst } as never, include, resolveLibraryExport(x.store, (inst as any).library, { skills: include.includes("librarySkills"), mcp: include.includes("libraryMcp"), embed }));

describe("export: the library block", () => {
  it("with no library group chosen (or nothing assigned) the block is the empty one every export had, byte for byte", () => {
    const x = exporter();
    const old = buildAgentExport("coder", { description: "d" } as never, ["identity"]);
    expect(old.text).toContain("library:\n  skills: []\n  mcp: []\n");
    const noGroup = exportWith(x, ["identity"], false);
    expect(noGroup.text).toBe(old.text);
    const none = exportWith(x, ALL, false, { backend: "claude-code" });
    expect(none.text).toBe(old.text);
    expect(none.library).toEqual({ skills: 0, mcp: 0, bundled: 0 });
  });

  it("references only by default: id and sha256 (and source, and the variable NAMES of an MCP server), paused as the agent has it, no definition", () => {
    const x = exporter();
    const r = exportWith(x, ALL, false);
    const doc = parse(r.text!);
    expect(doc.library.skills.map((s: any) => s.id)).toEqual(["ui-review", "sleepy"]);
    expect(doc.library.skills[0]).toEqual({ id: "ui-review", sha256: expect.stringMatching(/^[0-9a-f]{64}$/), source: { type: "import", from: "ui-review.zip" } });
    expect(doc.library.mcp).toEqual([
      { id: "github", sha256: expect.stringMatching(/^[0-9a-f]{64}$/), vars: ["MCP_GITHUB_TOKEN"] },
      { id: "linear", sha256: expect.stringMatching(/^[0-9a-f]{64}$/), vars: ["MCP_LINEAR_TOKEN"] },
    ]);
    expect(doc.library.paused).toEqual({ skills: ["sleepy"], mcp: ["linear"] });
    expect(r.text).not.toContain("archive");
    expect(r.text).not.toContain("definition");
    expect(r.libraryAssigned).toEqual({ skills: 2, mcp: 2 });
    expect(r.library).toEqual({ skills: 2, mcp: 2, bundled: 0 });
    expect(x.store.get("skill", "ui-review").ok && (x.store.get("skill", "ui-review") as any).detail.sha256).toBe(doc.library.skills[0].sha256);
  });

  it("only the chosen group is written; each can be chosen alone", () => {
    const x = exporter();
    const skills = parse(exportWith(x, ["librarySkills"], false).text!);
    expect(skills.library.mcp).toEqual([]);
    expect(skills.library.paused).toEqual({ skills: ["sleepy"] });
    const mcp = parse(exportWith(x, ["libraryMcp"], false).text!);
    expect(mcp.library.skills).toEqual([]);
    expect(mcp.library.paused).toEqual({ mcp: ["linear"] });
  });

  it("bundled: a skill as the library's own ZIP and an MCP server as its YAML — and still no variable value anywhere in the file", () => {
    const x = exporter();
    const r = exportWith(x, ALL, true);
    expect(r.text).toBeTruthy();
    expect(r.library.bundled).toBe(4);
    const doc = parse(r.text!);
    expect(Buffer.from(doc.library.skills[0].archive, "base64").subarray(0, 2).toString()).toBe("PK");
    expect(doc.library.mcp[0].definition).toBe(readFileSync(join(x.dir, "library", "mcp", "github.yaml"), "utf8"));
    expect(r.text).not.toContain(SECRET);
    expect(r.text).not.toContain("tok-");
    // the file reads back the same as it was written, with nothing skipped
    const read = parseAgentExport(r.text);
    expect(read).toMatchObject({ ok: true, skipped: [], libraryUsed: true });
  });

  it("an item that is gone, or was changed outside the Library, is left out with the reason (it would not be given to an agent either)", () => {
    const x = exporter();
    writeFileSync(join(x.dir, "library", "mcp", "github.yaml"), `${mcpText("github")}# edited by hand\n`);
    x.store.remove("skill", "sleepy");
    const r = exportWith(x, ALL, false);
    expect(r.libraryOmitted).toEqual(expect.arrayContaining([{ kind: "skill", id: "sleepy", reason: "gone" }, { kind: "mcp", id: "github", reason: "notReady" }]));
    const doc = parse(r.text!);
    expect(doc.library.skills.map((s: any) => s.id)).toEqual(["ui-review"]);
    expect(doc.library.paused).toEqual({ mcp: ["linear"] });
  });

  it("bundling stays inside one budget: what does not fit goes as a reference and is said so", () => {
    const x = exporter();
    const noise = (): string => randomBytes(75_000).toString("hex");       // 150 KB that does not compress much
    for (const id of ["big-a", "big-b", "big-c"]) expect(x.store.addSkill(id, [{ path: "SKILL.md", content: md(id) }, { path: "d.txt", content: `${id} ${noise()}` }]).ok).toBe(true);
    const inst = { library: { skills: ["big-a", "big-b", "big-c"] } };
    const r = exportWith(x, ["librarySkills"], true, inst);
    expect(r.text!.length).toBeLessThan(200_000);
    expect(r.libraryOmitted.some((o) => o.reason === "tooBigToEmbed")).toBe(true);
    const doc = parse(r.text!);
    expect(doc.library.skills).toHaveLength(3);
    expect(doc.library.skills.filter((s: any) => s.archive).length).toBeLessThan(3);
    expect(doc.library.skills.reduce((n: number, s: any) => n + (s.archive?.length ?? 0), 0)).toBeLessThanOrEqual(EXPORT_LIBRARY_EMBED_CHARS);
    expect(parseAgentExport(r.text)).toMatchObject({ ok: true });
  });

  it("the secret scan covers the whole library block: a hit anywhere in it withholds the file", () => {
    const x = exporter();
    const ghp = `gh${"p_"}${"y".repeat(36)}`;
    // the item's recorded source is a text the exporter does not control (an upload's file name)
    expect(x.store.addSkill("from-name", [{ path: "SKILL.md", content: md("from-name") }], { source: { type: "import", from: `${ghp}.zip` } }).ok).toBe(true);
    const r = exportWith(x, ["librarySkills"], false, { library: { skills: ["from-name"] } });
    expect(r.text).toBeNull();
    expect(r.findings).toEqual([{ field: "library.skills[0]", line: 3, kind: "api_key" }]);
    expect(JSON.stringify(r)).not.toContain("yyyy");
  });
});

describe("reading a file's library block (pure)", () => {
  const file = (lib: string) => `agend_export: 1\nkind: agent\nagent:\n  description: d\nlibrary:\n${lib}`;
  const sha = "a".repeat(64);
  it("an old file with an empty library reads exactly as before", () => {
    const r = parseAgentExport(file("  skills: []\n  mcp: []\n"));
    expect(r).toMatchObject({ ok: true, libraryUsed: false, library: { skills: [], mcp: [] }, skipped: [] });
  });
  it("takes the well-formed entries and skips the rest, each with its path; paused may only name listed ids", () => {
    const r = parseAgentExport(file(`  skills:\n    - { id: ui, sha256: ${sha} }\n    - { id: Bad_Id, sha256: ${sha} }\n    - { ref: old-style }\n    - { id: ui, sha256: ${sha} }\n  mcp:\n    - { id: gh, sha256: ${sha}, vars: [MCP_A] }\n    - { id: gh2, sha256: ${sha}, vars: [GH_TOKEN] }\n  paused: { skills: [ui, nope], mcp: [gh] }\n  extra: 1\n`));
    expect(r).toMatchObject({ ok: true, libraryUsed: true, library: { skills: [{ id: "ui", paused: false }], mcp: [{ id: "gh", vars: ["MCP_A"], paused: true }] } });
    if (!r.ok) throw new Error();
    const paths = r.skipped.map((s) => s.path);
    expect(paths).toEqual(expect.arrayContaining(["library.skills[1]", "library.skills[2]", "library.skills[3]", "library.mcp[1].vars", "library.mcp[1]", "library.paused.skills", "library.extra"]));
  });
  it("variable names are MCP_… names only: a value (or any other name) in `vars` drops the entry", () => {
    const r = parseAgentExport(file(`  mcp:\n    - { id: gh, sha256: ${sha}, vars: [${SECRET}] }\n    - { id: g2, sha256: ${sha}, vars: [mcp_lower] }\n`));
    expect(r).toMatchObject({ ok: true, library: { mcp: [] } });
  });
  it("a bad sha256, a non-base64 archive, an over-long list or a bundle over the budget is skipped, never read", () => {
    const r = parseAgentExport(file(`  skills:\n    - { id: a, sha256: nothex }\n    - { id: b, sha256: ${sha}, archive: "not base64!" }\n    - { id: c, sha256: ${sha}, archive: ${"QUJD".repeat(40_000)} }\n`));
    if (!r.ok) throw new Error();
    expect(r.skipped.map((s) => s.path)).toEqual(expect.arrayContaining(["library.skills[0]", "library.skills[1].archive", "library.skills[2].archive"]));
    expect(r.library.skills.map((s) => s.id)).toEqual(["b", "c"]);
    expect(r.library.skills.every((s) => !s.bundled)).toBe(true);
    const many = Array.from({ length: 101 }, (_, i) => `    - { id: s${i}, sha256: ${sha} }`).join("\n");
    const big = parseAgentExport(file(`  skills:\n${many}\n`));
    expect(big).toMatchObject({ ok: true, library: { skills: [] } });
  });
  it("does not touch any file or the network (pure): reading needs no home folder at all", () => {
    expect(parseAgentLibrary("agend_export: 1\nlibrary:\n  skills: []\n")).toEqual({ skills: [], mcp: [], paused: { skills: [], mcp: [] } });
    expect(parseAgentLibrary("not an export")).toBeNull();
  });
});

describe("import: the four states against this computer's Library", () => {
  /** Export with the definitions bundled, from the exporter's computer; the importer is another Library. */
  function setup(embed: boolean) {
    const x = exporter();
    const text = exportWith(x, ALL, embed).text!;
    const lib = parseAgentLibrary(text)!;
    const dir = home(); const store = new LibraryStore(dir);
    return { x, text, lib, dir, store, host: { envPath: join(dir, ".env"), builtin } };
  }
  const states = (v: ReturnType<typeof compareLibrary>) => Object.fromEntries([...v.skills, ...v.mcp].map((r) => [r.id, r.status]));

  it("missing-embedded when the file carries the definition, missing when it only refers to it", () => {
    const a = setup(true);
    expect(states(compareLibrary(a.store, a.lib, a.host))).toEqual({ "ui-review": "missing-embedded", sleepy: "missing-embedded", github: "missing-embedded", linear: "missing-embedded" });
    const b = setup(false);
    expect(states(compareLibrary(b.store, b.lib, b.host))).toEqual({ "ui-review": "missing", sleepy: "missing", github: "missing", linear: "missing" });
  });

  it("present when the exact version is already here, differs when the id is here as another version", () => {
    const a = setup(true);
    // same skill, same bytes → present; same id, other content → differs
    const same = (a.x.store.get("skill", "ui-review") as any).detail.files.map((f: any) => ({ path: f.path, content: f.content }));
    expect(a.store.addSkill("ui-review", same).ok).toBe(true);
    expect(a.store.addSkill("sleepy", [{ path: "SKILL.md", content: md("sleepy", " changed") }]).ok).toBe(true);
    expect(a.store.addMcp("github", (a.x.store.get("mcp", "github") as any).detail.text).ok).toBe(true);
    expect(a.store.addMcp("linear", mcpText("linear", "  - MCP_LINEAR_EXTRA\n")).ok).toBe(true);
    const v = compareLibrary(a.store, a.lib, a.host);
    expect(states(v)).toEqual({ "ui-review": "present", sleepy: "differs", github: "present", linear: "differs" });
    expect(v.skills.find((s) => s.id === "sleepy")).toMatchObject({ paused: true, embedded: { ok: true }, local: { ready: true } });
  });

  it("an MCP row shows the whole command and the variable names with set / missing — never a value", () => {
    const a = setup(true);
    writeFileSync(a.host.envPath, `MCP_GITHUB_TOKEN=${SECRET}\n`);
    const v = compareLibrary(a.store, a.lib, a.host);
    const gh = v.mcp.find((m) => m.id === "github")!;
    expect(gh.vars).toEqual([{ name: "MCP_GITHUB_TOKEN", set: true }]);
    expect(gh.embedded).toMatchObject({ ok: true, summary: { transport: "stdio", command: "npx", args: ["-y", "github-mcp"], variables: ["MCP_GITHUB_TOKEN"] }, variables: [{ name: "MCP_GITHUB_TOKEN", set: true }] });
    const li = v.mcp.find((m) => m.id === "linear")!;
    expect(li.vars).toEqual([{ name: "MCP_LINEAR_TOKEN", set: false }]);
    expect(JSON.stringify(v)).not.toContain(SECRET);
    // a reference-only file still tells which variable to put in `.env`
    const b = setup(false);
    expect(compareLibrary(b.store, b.lib, b.host).mcp[0]).toMatchObject({ status: "missing", vars: [{ name: "MCP_GITHUB_TOKEN", set: false }] });
  });

  it("a bundled definition is read with the Library's rules: a changed byte, a wrong name, a secret or a built-in skill's name is not usable", () => {
    const a = setup(true);
    const tamper = (id: string, edit: (e: any) => void) => { const l = structuredClone(a.lib); edit([...l.skills, ...l.mcp].find((e) => e.id === id)!); return compareLibrary(a.store, l, a.host); };
    expect(tamper("github", (e) => { e.definition = e.definition.replace("-y", "-z"); }).mcp.find((m) => m.id === "github")).toMatchObject({ status: "missing", embedded: { ok: false, problem: "hash" } });
    expect(tamper("github", (e) => { e.definition = e.definition.replace("name: github", "name: other"); }).mcp.find((m) => m.id === "github")).toMatchObject({ embedded: { ok: false, problem: "mismatch" } });
    expect(tamper("github", (e) => { e.definition = e.definition.replace("env:\n  - MCP_GITHUB_TOKEN", "env:\n  - GITHUB_TOKEN"); }).mcp.find((m) => m.id === "github")).toMatchObject({ embedded: { ok: false, problem: "invalid" } });
    expect(tamper("ui-review", (e) => { e.archive = Buffer.from("not a zip at all").toString("base64"); }).skills.find((s) => s.id === "ui-review")).toMatchObject({ status: "missing", embedded: { ok: false } });
    const name = [...builtin][0]!;
    const l = structuredClone(a.lib);
    l.skills = [{ id: name, sha256: "b".repeat(64), archive: a.lib.skills[0]!.archive }];
    expect(compareLibrary(a.store, l, a.host).skills[0]).toMatchObject({ embedded: { ok: false } });
  });

  describe("applying the administrator's choices", () => {
    it("nothing is written for what was not chosen; a missing (reference-only) item is skipped with its reason, the rest still loads", () => {
      const b = setup(false);
      const out = applyLibrary(b.store, b.lib, { skills: {}, mcp: {} }, { ...b.host, agent: "coder" });
      expect(out.skills.every((o) => o.outcome === "skipped")).toBe(true);
      expect(out.mcp.map((o) => o.reason)).toEqual(["missing", "missing"]);
      expect(b.store.list()).toEqual([]);
      expect(existsSync(join(b.dir, "library"))).toBe(false);
    });

    it("missing-embedded: the skill is stored after the choice, the MCP server only with the confirmed hash — and confirmed for that agent at that version", () => {
      const a = setup(true);
      const view = compareLibrary(a.store, a.lib, a.host);
      const gh = view.mcp.find((m) => m.id === "github")!;
      // an MCP server chosen without its hash is refused, and nothing is stored
      const refused = applyLibrary(a.store, a.lib, { skills: {}, mcp: { github: { action: "add" } } }, { ...a.host, agent: "coder" });
      expect(refused.mcp.find((o) => o.id === "github")).toMatchObject({ outcome: "failed", reason: "unconfirmed" });
      expect(a.store.list().some((i) => i.id === "github")).toBe(false);
      // with a wrong hash (it was not the version shown)
      expect(applyLibrary(a.store, a.lib, { skills: {}, mcp: { github: { action: "add", confirm: "c".repeat(64) } } }, { ...a.host, agent: "coder" }).mcp[0]).toMatchObject({ outcome: "failed", reason: "changed" });
      const out = applyLibrary(a.store, a.lib, { skills: { "ui-review": { action: "add" }, sleepy: { action: "skip" } }, mcp: { github: { action: "add", confirm: gh.sha256 }, linear: { action: "skip" } } }, { ...a.host, agent: "coder" });
      expect(out.skills).toEqual([{ id: "ui-review", outcome: "added", savedAs: "ui-review" }, { id: "sleepy", outcome: "skipped", reason: "chosen" }]);
      expect(out.mcp).toEqual([{ id: "github", outcome: "added", savedAs: "github" }, { id: "linear", outcome: "skipped", reason: "chosen" }]);
      expect(out.mounts).toEqual({ skills: { on: ["ui-review"], paused: [] }, mcp: { on: ["github"], paused: [] } });
      expect(a.store.skillForMount("ui-review").ok).toBe(true);
      expect(a.store.mcpForMount("github").ok).toBe(true);
      expect(new McpConfirmations(a.store).forAgent("coder")).toEqual({ github: gh.sha256 });
      // the bytes stored are the exporter's (the hashes the file declared)
      expect((a.store.get("skill", "ui-review") as any).detail.sha256).toBe(a.lib.skills[0]!.sha256);
      expect(states(compareLibrary(a.store, a.lib, a.host))).toMatchObject({ "ui-review": "present", github: "present" });
    });

    it("paused items come back paused", () => {
      const a = setup(true);
      const out = applyLibrary(a.store, a.lib, { skills: { sleepy: { action: "add" } }, mcp: { linear: { action: "add", confirm: a.lib.mcp[1]!.sha256 } } }, { ...a.host, agent: "coder" });
      expect(out.mounts).toEqual({ skills: { on: [], paused: ["sleepy"] }, mcp: { on: [], paused: ["linear"] } });
    });

    it("present: used as it is; an MCP server still needs the confirmation of the version on this computer", () => {
      const a = setup(false);
      const text = (a.x.store.get("mcp", "github") as any).detail.text;
      a.store.addMcp("github", text);
      const sha = a.lib.mcp[0]!.sha256;
      expect(applyLibrary(a.store, a.lib, { skills: {}, mcp: { github: { action: "use" } } }, { ...a.host, agent: "coder" }).mcp[0]).toMatchObject({ outcome: "failed", reason: "unconfirmed" });
      expect(new McpConfirmations(a.store).forAgent("coder")).toEqual({});
      const out = applyLibrary(a.store, a.lib, { skills: {}, mcp: { github: { action: "use", confirm: sha } } }, { ...a.host, agent: "coder" });
      expect(out.mcp[0]).toMatchObject({ outcome: "used" });
      expect(out.mounts.mcp.on).toEqual(["github"]);
      expect(new McpConfirmations(a.store).forAgent("coder")).toEqual({ github: sha });
    });

    it("differs: a local version is never overwritten — use it, save the bundled one under a new id, or skip", () => {
      const a = setup(true);
      const local = [{ path: "SKILL.md", content: md("sleepy", " local edition") }];
      a.store.addSkill("sleepy", local);
      const localSha = (a.store.get("skill", "sleepy") as any).detail.sha256;
      // "add" over an id that is here is refused
      expect(applyLibrary(a.store, a.lib, { skills: { sleepy: { action: "add" } }, mcp: {} }, { ...a.host, agent: "coder" }).skills.find((o) => o.id === "sleepy")).toMatchObject({ outcome: "failed", reason: "exists" });
      expect((a.store.get("skill", "sleepy") as any).detail.sha256).toBe(localSha);
      // rename: the bundled one is stored under the new name (its `name:` line follows), the local one is untouched
      const renamed = applyLibrary(a.store, a.lib, { skills: { sleepy: { action: "rename", as: "sleepy-theirs" } }, mcp: {} }, { ...a.host, agent: "coder" });
      expect(renamed.skills.find((o) => o.id === "sleepy")).toEqual({ id: "sleepy", outcome: "renamed", savedAs: "sleepy-theirs" });
      expect(renamed.mounts.skills.paused).toEqual(["sleepy-theirs"]);
      expect((a.store.get("skill", "sleepy-theirs") as any).detail.files[0].content).toContain("name: sleepy-theirs");
      expect((a.store.get("skill", "sleepy") as any).detail.sha256).toBe(localSha);
      // the new name must be free and a valid id
      expect(applyLibrary(a.store, a.lib, { skills: { sleepy: { action: "rename", as: "sleepy-theirs" } }, mcp: {} }, { ...a.host, agent: "coder" }).skills.find((o) => o.id === "sleepy")).toMatchObject({ outcome: "failed", reason: "exists" });
      expect(applyLibrary(a.store, a.lib, { skills: { sleepy: { action: "rename", as: "Bad Name" } }, mcp: {} }, { ...a.host, agent: "coder" }).skills.find((o) => o.id === "sleepy")).toMatchObject({ outcome: "failed", reason: "bad_id" });
      // use the local one
      const used = applyLibrary(a.store, a.lib, { skills: { sleepy: { action: "use" } }, mcp: {} }, { ...a.host, agent: "coder" });
      expect(used.skills.find((o) => o.id === "sleepy")).toMatchObject({ outcome: "used" });
      expect(used.mounts.skills.paused).toEqual(["sleepy"]);
    });

    it("an MCP server differing from the local one: rename stores the bundled definition under a new id, with the hash shown; local stays", () => {
      const a = setup(true);
      a.store.addMcp("github", mcpText("github", "  - MCP_GITHUB_EXTRA\n"));
      const localSha = (a.store.get("mcp", "github") as any).detail.sha256;
      const sha = a.lib.mcp[0]!.sha256;
      const out = applyLibrary(a.store, a.lib, { skills: {}, mcp: { github: { action: "rename", as: "github-theirs", confirm: sha } } }, { ...a.host, agent: "coder" });
      expect(out.mcp[0]).toEqual({ id: "github", outcome: "renamed", savedAs: "github-theirs" });
      expect(out.mounts.mcp.on).toEqual(["github-theirs"]);
      expect((a.store.get("mcp", "github") as any).detail.sha256).toBe(localSha);
      expect((a.store.get("mcp", "github-theirs") as any).detail.item.name).toBe("github-theirs");
      expect(Object.keys(new McpConfirmations(a.store).forAgent("coder"))).toEqual(["github-theirs"]);
    });

    it("what changed between the preview and the choice is not applied on the old say-so", () => {
      const a = setup(false);
      a.store.addMcp("github", (a.x.store.get("mcp", "github") as any).detail.text);
      const sha = a.lib.mcp[0]!.sha256;
      // the library's item is edited (saved again) after the administrator read it
      a.store.addMcp("github", mcpText("github", "  - MCP_GITHUB_EXTRA\n"), { overwrite: true });
      const out = applyLibrary(a.store, a.lib, { skills: {}, mcp: { github: { action: "use", confirm: sha } } }, { ...a.host, agent: "coder" });
      expect(out.mcp[0]).toMatchObject({ outcome: "failed", reason: "changed" });
      expect(new McpConfirmations(a.store).forAgent("coder")).toEqual({});
    });
  });
});
