/**
 * AGEND-244: library Skills mounted into an agent — syncLibrarySkills (src/library/mount.ts), its start-up wiring in
 * FleetManager, and the rules around it: its own record, name priority, un-mount, the golden "no mount → nothing changes".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import { DEFAULT_INSTANCE_CONFIG } from "../src/config.js";
import { validateFleetConfig } from "../src/config-validator.js";
import { outboundHandlers, type OutboundContext } from "../src/outbound-handlers.js";
import { LIBRARY_SKILLS_MANIFEST, LibraryStore, libraryMountProblem, syncLibrarySkills } from "../src/library/index.js";
import type { InstanceConfig } from "../src/types.js";

const dirs: string[] = [];
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); vi.restoreAllMocks(); });

const md = (id: string, body = "Steps.") => `---\nname: ${id}\ndescription: Does ${id} things\n---\n\n# ${id}\n${body}\n`;
const add = (store: LibraryStore, id: string, body = "Steps.", more: Array<{ path: string; content: string }> = []) =>
  expect(store.addSkill(id, [{ path: "SKILL.md", content: md(id, body) }, ...more], { overwrite: true })).toMatchObject({ ok: true });

/** Every file and folder under `root`: relative path → content hash (folders: "dir"), so two trees compare byte for byte. */
function tree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    if (!existsSync(join(root, rel))) return;
    for (const name of readdirSync(join(root, rel)).sort()) {
      const r = rel ? `${rel}/${name}` : name;
      if (lstatSync(join(root, r)).isDirectory()) { out[r] = "dir"; walk(r); } else out[r] = createHash("sha256").update(readFileSync(join(root, r))).digest("hex");
    }
  };
  walk("");
  return out;
}
const manifest = (dest: string) => JSON.parse(readFileSync(join(dest, LIBRARY_SKILLS_MANIFEST), "utf8"));

describe("syncLibrarySkills", () => {
  let home: string, store: LibraryStore, dest: string;
  const none = new Set<string>();
  const sync = (mount: string[], reserved: Set<string> = none) => syncLibrarySkills({ destSkills: dest, mount, store, reserved });
  beforeEach(() => { home = tmp("agend-mount-home-"); store = new LibraryStore(home); dest = join(tmp("agend-mount-ws-"), ".claude", "skills"); });

  it("no mount and no record: not one file or folder is created, even when the library has skills", () => {
    add(store, "review");
    expect(sync([])).toEqual({ published: [], skipped: [], removed: [], kept: [] });
    expect(existsSync(join(dest, ".."))).toBe(false);
  });

  it("publishes the mounted skill with its supporting files, and records ownership in its own manifest", () => {
    add(store, "review", "Steps.", [{ path: "references/checklist.md", content: "- a\n" }]);
    add(store, "other");
    const r = sync(["review"]);
    expect(r.published).toEqual(["review"]);
    expect(readFileSync(join(dest, "review", "SKILL.md"), "utf8")).toBe(md("review"));
    expect(readFileSync(join(dest, "review", "references", "checklist.md"), "utf8")).toBe("- a\n");
    expect(existsSync(join(dest, "other"))).toBe(false);                       // not mounted: not published
    const m = manifest(dest);
    expect(m).toEqual({ version: 1, skills: { review: { sha256: (store.list().find((i) => i.id === "review"))!.sha256 } } });
    expect(existsSync(join(dest, ".agend-managed-skills.json"))).toBe(false);  // the bundled record is never written here
    expect(readdirSync(dest).sort()).toEqual([LIBRARY_SKILLS_MANIFEST, "review"]);   // no temp folder left behind
  });

  it("a second start with nothing changed rewrites nothing", () => {
    add(store, "review");
    sync(["review"]);
    const file = join(dest, "review", "SKILL.md"), manifestFile = join(dest, LIBRARY_SKILLS_MANIFEST);
    const past = new Date(Math.floor(Date.now() / 1000) * 1000 - 3_600_000);   // whole seconds: exact in every filesystem
    utimesSync(file, past, past); utimesSync(manifestFile, past, past);
    sync(["review"]);
    expect(statSync(file).mtimeMs).toBe(past.getTime());
    expect(statSync(manifestFile).mtimeMs).toBe(past.getTime());
  });

  it("a library update reaches the agent while the published copy is untouched", () => {
    add(store, "review", "v1");
    sync(["review"]);
    add(store, "review", "v2", [{ path: "extra.md", content: "x" }]);
    expect(sync(["review"]).published).toEqual(["review"]);
    expect(readFileSync(join(dest, "review", "SKILL.md"), "utf8")).toBe(md("review", "v2"));
    expect(existsSync(join(dest, "review", "extra.md"))).toBe(true);
    expect(manifest(dest).skills.review.sha256).toBe(store.list().find((i) => i.id === "review")!.sha256);
  });

  it("an edit made in the published copy is the person's: not overwritten by a library update, not put back", () => {
    add(store, "review", "v1");
    sync(["review"]);
    const record = readFileSync(join(dest, LIBRARY_SKILLS_MANIFEST), "utf8");
    writeFileSync(join(dest, "review", "SKILL.md"), "my own version\n");
    writeFileSync(join(dest, "review", "notes.md"), "mine\n");
    add(store, "review", "v2");                                               // the library moved on
    const r = sync(["review"]);
    expect(r).toMatchObject({ published: [], skipped: [{ id: "review", reason: "modified" }], removed: [] });
    expect(readFileSync(join(dest, "review", "SKILL.md"), "utf8")).toBe("my own version\n");
    expect(readFileSync(join(dest, "review", "notes.md"), "utf8")).toBe("mine\n");
    expect(readFileSync(join(dest, LIBRARY_SKILLS_MANIFEST), "utf8")).toBe(record);   // still listed while mounted
  });

  it("a copy put back exactly as published is managed again", () => {
    add(store, "review", "v1");
    sync(["review"]);
    const original = readFileSync(join(dest, "review", "SKILL.md"), "utf8");
    writeFileSync(join(dest, "review", "SKILL.md"), "edited\n");
    sync(["review"]);
    writeFileSync(join(dest, "review", "SKILL.md"), original);
    add(store, "review", "v2");
    expect(sync(["review"]).published).toEqual(["review"]);
    expect(readFileSync(join(dest, "review", "SKILL.md"), "utf8")).toBe(md("review", "v2"));
  });

  it("a person who replaces our folder with their own of the same name keeps it", () => {
    add(store, "review");
    sync(["review"]);
    rmSync(join(dest, "review"), { recursive: true });
    mkdirSync(join(dest, "review"));
    writeFileSync(join(dest, "review", "SKILL.md"), "theirs\n");
    expect(sync(["review"]).skipped).toEqual([{ id: "review", reason: "modified" }]);
    expect(readFileSync(join(dest, "review", "SKILL.md"), "utf8")).toBe("theirs\n");
    const r = sync([]);                                                        // un-mounted: still theirs, and it leaves the record
    expect(r).toMatchObject({ removed: [], kept: ["review"] });
    expect(readFileSync(join(dest, "review", "SKILL.md"), "utf8")).toBe("theirs\n");
    expect(existsSync(join(dest, LIBRARY_SKILLS_MANIFEST))).toBe(false);
  });

  it("un-mounting never deletes a copy the person changed (an untouched one next to it is removed)", () => {
    add(store, "review"); add(store, "triage");
    sync(["review", "triage"]);
    writeFileSync(join(dest, "review", "SKILL.md"), "edited\n");
    const r = sync([]);
    expect(r).toMatchObject({ removed: ["triage"], kept: ["review"] });
    expect(readFileSync(join(dest, "review", "SKILL.md"), "utf8")).toBe("edited\n");
    expect(existsSync(join(dest, "triage"))).toBe(false);
    expect(existsSync(join(dest, LIBRARY_SKILLS_MANIFEST))).toBe(false);
    // and it is the person's now: mounting the same name again finds a folder that is not in the record
    expect(sync(["review"]).skipped).toEqual([{ id: "review", reason: "user-owned" }]);
  });

  it("an item deleted from the library, or a name a bundled skill has taken, leaves a changed copy alone too", () => {
    add(store, "review"); add(store, "concepts");
    sync(["review", "concepts"]);
    writeFileSync(join(dest, "review", "SKILL.md"), "edited\n");
    writeFileSync(join(dest, "concepts", "SKILL.md"), "edited too\n");
    store.remove("skill", "review");
    const r = sync(["review", "concepts"], new Set(["concepts"]));
    expect(r.removed).toEqual([]);
    expect(r.kept).toEqual(["concepts"]);                                      // reserved by a bundled skill: leaves the record
    expect(r.skipped).toEqual(expect.arrayContaining([{ id: "review", reason: "modified" }]));   // still mounted: stays listed, untouched
    sync([]);
    expect(readFileSync(join(dest, "review", "SKILL.md"), "utf8")).toBe("edited\n");   // …and un-mounted later, still not deleted
    expect(readFileSync(join(dest, "review", "SKILL.md"), "utf8")).toBe("edited\n");
    expect(readFileSync(join(dest, "concepts", "SKILL.md"), "utf8")).toBe("edited too\n");
  });

  it("the person's own folder of the same name wins and is never touched, also after un-mounting", () => {
    add(store, "review");
    mkdirSync(join(dest, "review"), { recursive: true });
    writeFileSync(join(dest, "review", "SKILL.md"), "mine\n");
    expect(sync(["review"])).toMatchObject({ published: [], skipped: [{ id: "review", reason: "user-owned" }] });
    expect(readFileSync(join(dest, "review", "SKILL.md"), "utf8")).toBe("mine\n");
    expect(existsSync(join(dest, LIBRARY_SKILLS_MANIFEST))).toBe(false);       // nothing owned: no record written
    sync([]);
    expect(readFileSync(join(dest, "review", "SKILL.md"), "utf8")).toBe("mine\n");
  });

  it("a bundled skill's name is reserved: the library skill is skipped", () => {
    add(store, "concepts");
    expect(sync(["concepts"], new Set(["concepts"]))).toMatchObject({ published: [], skipped: [{ id: "concepts", reason: "bundled" }] });
    expect(existsSync(join(dest, "concepts"))).toBe(false);
  });

  it("a copy of ours whose name a bundled skill has since taken is removed (the bundled one takes its place)", () => {
    add(store, "concepts");
    sync(["concepts"]);
    expect(existsSync(join(dest, "concepts"))).toBe(true);
    const r = sync(["concepts"], new Set(["concepts"]));
    expect(r.removed).toEqual(["concepts"]);
    expect(existsSync(join(dest, "concepts"))).toBe(false);
    expect(existsSync(join(dest, LIBRARY_SKILLS_MANIFEST))).toBe(false);
  });

  it("un-mounting removes only what its own record lists; the person's skills and the bundled record stay", () => {
    add(store, "review"); add(store, "triage");
    mkdirSync(join(dest, "mine"), { recursive: true });
    writeFileSync(join(dest, "mine", "SKILL.md"), "mine\n");
    writeFileSync(join(dest, ".agend-managed-skills.json"), '["bundled-one"]\n');
    mkdirSync(join(dest, "bundled-one")); writeFileSync(join(dest, "bundled-one", "SKILL.md"), "b\n");
    sync(["review", "triage"]);
    const r = sync(["triage"]);
    expect(r.removed).toEqual(["review"]);
    expect(existsSync(join(dest, "review"))).toBe(false);
    expect(existsSync(join(dest, "triage"))).toBe(true);
    expect(manifest(dest).skills).toHaveProperty("triage");
    sync([]);
    expect(existsSync(join(dest, "triage"))).toBe(false);
    expect(existsSync(join(dest, LIBRARY_SKILLS_MANIFEST))).toBe(false);
    expect(readFileSync(join(dest, "mine", "SKILL.md"), "utf8")).toBe("mine\n");
    expect(readFileSync(join(dest, ".agend-managed-skills.json"), "utf8")).toBe('["bundled-one"]\n');
    expect(readFileSync(join(dest, "bundled-one", "SKILL.md"), "utf8")).toBe("b\n");
  });

  it("a record that is corrupt owns nothing; an id in it that is not an id (a path) is never removed", () => {
    add(store, "review");
    mkdirSync(join(dest, "review"), { recursive: true });
    writeFileSync(join(dest, "review", "SKILL.md"), "mine\n");
    writeFileSync(join(dest, LIBRARY_SKILLS_MANIFEST), "{ not json");
    expect(sync(["review"]).skipped).toEqual([{ id: "review", reason: "user-owned" }]);
    const victim = join(dest, "..", "victim");
    mkdirSync(victim); writeFileSync(join(victim, "f"), "keep");
    writeFileSync(join(dest, LIBRARY_SKILLS_MANIFEST), JSON.stringify({ version: 1, skills: { "../victim": { sha256: "a".repeat(64) }, con: { sha256: "b".repeat(64) } } }));
    sync([]);
    expect(readFileSync(join(victim, "f"), "utf8")).toBe("keep");
  });

  it("an item that is hand-edited, hand-placed or breaks a rule is not published; a copy already published stays as it is", () => {
    add(store, "review"); add(store, "stable");
    sync(["review", "stable"]);
    const before = readFileSync(join(dest, "review", "SKILL.md"), "utf8");
    // hand-edited in the library (hash no longer the lock's)
    writeFileSync(join(home, "library/skills/review/SKILL.md"), md("review", "tampered"));
    // hand-placed: never saved through the Library, so not in the lock
    mkdirSync(join(home, "library/skills/placed"), { recursive: true });
    writeFileSync(join(home, "library/skills/placed/SKILL.md"), md("placed"));
    // hand-placed and breaking a rule (name does not match its folder)
    mkdirSync(join(home, "library/skills/broken"), { recursive: true });
    writeFileSync(join(home, "library/skills/broken/SKILL.md"), md("elsewhere"));
    const r = sync(["review", "stable", "placed", "broken", "ghost"]);
    expect(r.published).toEqual(["stable"]);
    expect(r.skipped).toEqual(expect.arrayContaining([
      { id: "review", reason: "modified" }, { id: "placed", reason: "untracked" }, { id: "broken", reason: "invalid" }, { id: "ghost", reason: "not_found" },
    ]));
    expect(readFileSync(join(dest, "review", "SKILL.md"), "utf8")).toBe(before);
    expect(existsSync(join(dest, "placed"))).toBe(false);
    expect(manifest(dest).skills).toHaveProperty("review");
  });

  it("an item deleted from the library goes from the agent too", () => {
    add(store, "review");
    sync(["review"]);
    store.remove("skill", "review");
    expect(sync(["review"])).toMatchObject({ removed: ["review"], skipped: [{ id: "review", reason: "not_found" }] });
    expect(existsSync(join(dest, "review"))).toBe(false);
  });

  it("ids that are not valid library ids are ignored (nothing is written for them)", () => {
    expect(sync(["../escape", "CON", "con", ""])).toEqual({ published: [], skipped: [], removed: [], kept: [] });
    expect(existsSync(join(dest, ".."))).toBe(false);
  });
});

describe("what a hand-placed library skill must meet (the same rules as a saved one)", () => {
  let home: string, store: LibraryStore;
  const place = (id: string, files: Record<string, string | Buffer>) => {
    for (const [p, c] of Object.entries(files)) { const abs = join(home, "library/skills", id, p); mkdirSync(join(abs, ".."), { recursive: true }); writeFileSync(abs, c); }
  };
  beforeEach(() => { home = tmp("agend-hand-"); store = new LibraryStore(home); });

  it("listed as invalid, with the rule it breaks, and refused by get()", () => {
    place("noname", { "SKILL.md": "no frontmatter" });
    place("wrongname", { "SKILL.md": md("other") });
    place("nodesc", { "SKILL.md": "---\nname: nodesc\n---\nbody" });
    place("leaky", { "SKILL.md": md("leaky", "token: sk-ant-api03-" + "A".repeat(40)) });
    place("binary", { "SKILL.md": md("binary"), "x.bin": Buffer.from([0, 1, 2, 3]) });
    place("fine", { "SKILL.md": md("fine") });
    const byId = Object.fromEntries(store.list().map((i) => [i.id, i]));
    for (const id of ["noname", "wrongname", "nodesc", "leaky", "binary"]) {
      expect(byId[id]).toMatchObject({ status: "invalid" });
      expect(store.get("skill", id)).toMatchObject({ ok: false, error: "unsafe_item" });
    }
    expect(byId.noname!.reason).toBe("bad_frontmatter");
    expect(byId.wrongname!.reason).toBe("name_mismatch");
    expect(byId.leaky!.reason).toBe("secret_found");
    expect(byId.fine).toMatchObject({ status: "untracked" });
    expect(store.get("skill", "fine")).toMatchObject({ ok: true });
  });
});

describe("list() does not read an unchanged library again, and still sees every change", () => {
  it("sees an edit, an added file and a removal between two listings", () => {
    const home = tmp("agend-list-"); const store = new LibraryStore(home);
    add(store, "review", "v1");
    expect(store.list()[0]).toMatchObject({ id: "review", status: "ok" });
    expect(store.list()[0]).toMatchObject({ status: "ok" });                      // from the cache: same answer
    writeFileSync(join(home, "library/skills/review/SKILL.md"), md("review", "edited by hand"));
    expect(store.list()[0]).toMatchObject({ status: "modified" });
    add(store, "review", "v2", [{ path: "more.md", content: "m" }]);
    expect(store.list()[0]).toMatchObject({ status: "ok", files: 2 });
    writeFileSync(join(home, "library/skills/review/more.md"), "m");              // same content rewritten: still ok
    expect(store.list()[0]).toMatchObject({ status: "ok", files: 2 });
    rmSync(join(home, "library/skills/review/more.md"));
    expect(store.list()[0]).toMatchObject({ status: "modified" });
    store.remove("skill", "review");
    expect(store.list()).toEqual([]);
  });
});

describe("Windows device names are refused as an id and as a path segment", () => {
  it("rejects con, nul, aux, prn, com1, lpt9 (any case, with an extension too)", () => {
    const store = new LibraryStore(tmp("agend-win-"));
    for (const id of ["con", "nul", "aux", "prn", "com1", "lpt9", "COM1"]) {
      expect(store.addSkill(id, [{ path: "SKILL.md", content: md(id) }])).toMatchObject({ ok: false, error: "invalid_id" });
    }
    expect(store.addSkill("fine", [{ path: "SKILL.md", content: md("fine") }, { path: "docs/NUL.txt", content: "x" }])).toMatchObject({ ok: false, error: "invalid_path" });
    expect(store.addSkill("fine", [{ path: "SKILL.md", content: md("fine") }, { path: "con/readme.md", content: "x" }])).toMatchObject({ ok: false, error: "invalid_path" });
    expect(store.addMcp("nul", "x")).toMatchObject({ ok: false, error: "invalid_id" });
    // near misses stay fine
    expect(store.addSkill("console", [{ path: "SKILL.md", content: md("console") }, { path: "com10.md", content: "x" }])).toMatchObject({ ok: true });
  });
});

describe("fleet.yaml: library", () => {
  const cfg = (instance: Record<string, unknown>, defaults: Record<string, unknown> = {}) => validateFleetConfig({
    channel: { type: "telegram", mode: "topic", bot_token_env: "T", group_id: -1 }, defaults, instances: { a: { working_directory: "/tmp/a", ...instance } },
  } as never);
  it("accepts a list of library skill ids; unset changes nothing", () => {
    expect(cfg({ library: { skills: ["review", "triage"] } }).errors).toEqual([]);
    expect(cfg({}).errors).toEqual([]);
  });
  it("rejects a wrong shape, a path, a device name, a repeat, and any `defaults.library`", () => {
    for (const library of ["x", ["a"], { skills: "a" }, { skills: ["../x"] }, { skills: ["con"] }, { skills: ["a", "a"] }, { other: [] }, null]) {
      expect(cfg({ library }).errors.some((e) => e.path === "instances.a.library"), JSON.stringify(library)).toBe(true);
    }
    expect(cfg({}, { library: { skills: ["a"] } }).errors.some((e) => e.path === "defaults.library")).toBe(true);
    expect(libraryMountProblem({ skills: ["ok"] }, false)).toBeNull();
  });
  it("mcp is reserved: accepted with a warning, not applied", () => {
    const r = cfg({ library: { mcp: ["github"] } });
    expect(r.errors).toEqual([]);
    expect(r.warnings.some((w) => w.path === "instances.a.library.mcp")).toBe(true);
  });
});

describe("agents cannot mount anything on themselves", () => {
  it("update_instance_config never writes `library`, for any caller", async () => {
    const instance: Record<string, unknown> = { working_directory: "/tmp/w", backend: "claude-code" };
    const ctx = {
      dataDir: tmp("agend-tool-"), fleetConfig: { defaults: {}, instances: { worker: instance } }, classicChannels: { getAll: () => [] },
      saveFleetConfig: vi.fn(), restartSingleInstance: vi.fn(async () => {}), lifecycle: { daemons: new Map(), isPaused: () => false },
      instanceIpcClients: new Map(), getInstanceStatus: () => "running",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as unknown as OutboundContext;
    for (const caller of ["worker", "someone-else"]) {
      await new Promise<void>((resolve) => {
        void outboundHandlers.get("update_instance_config")!(ctx, { name: "worker", config: { library: { skills: ["review"] }, description: "d" } } as never, () => resolve(), { instanceName: caller } as never);
      });
      await new Promise((r) => setTimeout(r, 20));
      expect(instance.library).toBeUndefined();
    }
  });
});

describe("start-up wiring (FleetManager)", () => {
  let dataDir: string, workDir: string, fm: FleetManager, store: LibraryStore;
  const config = (more: Partial<InstanceConfig> = {}, dir = workDir): InstanceConfig => ({ ...DEFAULT_INSTANCE_CONFIG, working_directory: dir, backend: "claude-code", ...more });
  async function start(name: string, c: InstanceConfig, instances: Record<string, InstanceConfig> = { [name]: c }) {
    (fm as any).fleetConfig = { defaults: {}, instances };
    vi.spyOn((fm as any).lifecycle, "start").mockResolvedValue(undefined);
    vi.spyOn(fm as any, "connectIpcToInstance").mockResolvedValue(undefined);
    await fm.startInstance(name, c, false, "fleet-topic");
  }
  beforeEach(() => { dataDir = tmp("agend-fm-data-"); workDir = tmp("agend-fm-work-"); fm = new FleetManager(dataDir); store = new LibraryStore(dataDir); });

  it("GOLDEN: an agent with no mount ends with the very same skills folder and bundled manifest as before, whatever the library holds", async () => {
    // Reference: the bundled path alone, exactly as it ran before this feature.
    const reference = tmp("agend-fm-ref-");
    (fm as any).syncRoleSkills(reference, "claude-code", "worker");
    const expected = tree(join(reference, ".claude", "skills"));
    expect(Object.keys(expected)).toContain(".agend-managed-skills.json");
    expect(Object.keys(expected).some((k) => k.includes("library"))).toBe(false);

    add(store, "review");                                                   // the library has an item nobody mounted
    await start("worker", config());
    expect(tree(join(workDir, ".claude", "skills"))).toEqual(expected);
    expect(tree(workDir).hasOwnProperty(`.claude/skills/${LIBRARY_SKILLS_MANIFEST}`)).toBe(false);
  });

  it("GOLDEN: the same holds when the library folder does not exist at all", async () => {
    const reference = tmp("agend-fm-ref-");
    (fm as any).syncRoleSkills(reference, "claude-code", "worker");
    await start("worker", config());
    expect(tree(join(workDir, ".claude", "skills"))).toEqual(tree(join(reference, ".claude", "skills")));
    expect(existsSync(join(dataDir, "library"))).toBe(false);
  });

  it("publishes a mounted skill beside the bundled ones, with the bundled manifest unchanged", async () => {
    add(store, "review");
    await start("worker", config({ library: { skills: ["review"] } }));
    const skills = join(workDir, ".claude", "skills");
    expect(readFileSync(join(skills, "review", "SKILL.md"), "utf8")).toBe(md("review"));
    expect(manifest(skills).skills).toHaveProperty("review");
    const bundled = JSON.parse(readFileSync(join(skills, ".agend-managed-skills.json"), "utf8")) as string[];
    expect(bundled).not.toContain("review");
    expect(existsSync(join(skills, "worker-collaboration", "SKILL.md"))).toBe(true);
  });

  it("a library skill named like a bundled one is skipped; the bundled one is the one published", async () => {
    add(store, "worker-collaboration", "from the library");
    await start("worker", config({ library: { skills: ["worker-collaboration"] } }));
    const skills = join(workDir, ".claude", "skills");
    expect(readFileSync(join(skills, "worker-collaboration", "SKILL.md"), "utf8")).not.toContain("from the library");
    expect(existsSync(join(skills, LIBRARY_SKILLS_MANIFEST))).toBe(false);
  });

  it("un-mounting at the next start removes the library copy and leaves the bundled skills as they were", async () => {
    add(store, "review");
    await start("worker", config({ library: { skills: ["review"] } }));
    const skills = join(workDir, ".claude", "skills");
    const bundledBefore = readFileSync(join(skills, ".agend-managed-skills.json"), "utf8");
    fm = new FleetManager(dataDir);
    await start("worker", config());
    expect(existsSync(join(skills, "review"))).toBe(false);
    expect(existsSync(join(skills, LIBRARY_SKILLS_MANIFEST))).toBe(false);
    expect(readFileSync(join(skills, ".agend-managed-skills.json"), "utf8")).toBe(bundledBefore);
  });

  it("agents that share one working directory get the union of their mounts, whichever starts", async () => {
    add(store, "alpha"); add(store, "beta");
    const a = config({ library: { skills: ["alpha"] } }), b = config({ library: { skills: ["beta"] } }), plain = config();
    const all = { a, b, plain };
    const skills = join(workDir, ".claude", "skills");
    await start("a", a, all);
    expect(readdirSync(skills).filter((n) => !n.startsWith(".") && ["alpha", "beta"].includes(n)).sort()).toEqual(["alpha", "beta"]);
    fm = new FleetManager(dataDir);
    await start("plain", plain, all);                          // an agent with no mount must not remove what the others were given
    expect(existsSync(join(skills, "alpha"))).toBe(true);
    expect(existsSync(join(skills, "beta"))).toBe(true);
    // a different workspace is not affected by them
    const other = tmp("agend-fm-other-");
    fm = new FleetManager(dataDir);
    await start("elsewhere", config({}, other), { ...all, elsewhere: config({}, other) });
    expect(existsSync(join(other, ".claude", "skills", "alpha"))).toBe(false);
  });

  it("a failing library sync never stops the agent from starting", async () => {
    add(store, "review");
    const c = config({ library: { skills: ["review"] } });
    (fm as any).fleetConfig = { defaults: {}, instances: { worker: c } };
    // the skills folder is a plain file: nothing can be published into it
    mkdirSync(join(workDir, ".claude"), { recursive: true });
    writeFileSync(join(workDir, ".claude", "skills"), "not a folder");
    const lifecycleStart = vi.spyOn((fm as any).lifecycle, "start").mockResolvedValue(undefined);
    vi.spyOn(fm as any, "connectIpcToInstance").mockResolvedValue(undefined);
    await expect(fm.startInstance("worker", c, false, "fleet-topic")).resolves.toBeUndefined();
    expect(lifecycleStart).toHaveBeenCalledOnce();
  });

  it("a symlink in the skills folder is replaced, never followed into", async () => {
    add(store, "review");
    const skills = join(workDir, ".claude", "skills");
    const elsewhere = tmp("agend-fm-elsewhere-");
    mkdirSync(skills, { recursive: true });
    // a link where the person's own folder would be is theirs: skipped, the target untouched
    symlinkSync(elsewhere, join(skills, "review"));
    await start("worker", config({ library: { skills: ["review"] } }));
    expect(readdirSync(elsewhere)).toEqual([]);
  });
});

describe("librarySkillUsage (read-only, for the overview)", () => {
  it("says which agents are given each skill; sorted; ignores invalid ids, Windows agents and agents with no mount", async () => {
    const { librarySkillUsage } = await import("../src/library/index.js");
    const usage = librarySkillUsage({
      b: { library: { skills: ["review", "constructor"] } }, a: { library: { skills: ["review", "../x", "con"] } },
      c: {}, d: { library: {} }, e: { runtime: "windows", library: { skills: ["review"] } }, f: null,
    });
    expect(JSON.parse(JSON.stringify(usage))).toEqual({ review: ["a", "b"], constructor: ["b"] });
    expect(librarySkillUsage(undefined)).toEqual({});
  });
});
