/**
 * AGEND-248: the Library as an overview — what it reads (bundled skills, tool profiles, the `agend` MCP server, who uses what) and that it
 * only reads; the route (admin only, nothing created); the page (one card per category, title and rows in the same box, built-in rows
 * read only, "used by", a CLI with no skills folder); and the same flag on the agent's Team skills field.
 */
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSessionStore, csrfTokenFor, tokenEpoch } from "../src/web-session.js";
import { handleWebRequest } from "../src/web-api.js";
import { buildOverview } from "../src/library/overview.js";
import { parseBundledSkillRoles, listBundledSkills, BUNDLED_SKILLS_DIR } from "../src/bundled-skills.js";
import { NATIVE_SKILLS_DIR_SEGMENTS, hasNativeSkillsDir } from "../src/native-skills-dir.js";
import { TOOL_PROFILES } from "../src/tool-permissions.js";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const scratch = (): string => { const d = mkdtempSync(join(tmpdir(), "agend-overview-")); dirs.push(d); return d; };

/** A small bundled-skills folder: one with no `roles` (General only), one for workers, one for classic bots too. */
function fixtureSkills(): string {
  const dir = scratch();
  const add = (name: string, roles: string | null, description = `${name} does a thing`) => {
    mkdirSync(join(dir, name));
    writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n${roles ? `roles: ${roles}\n` : ""}---\n\n# ${name}\n`);
  };
  add("admin-only", null); add("for-workers", "[general, worker]"); add("everyone", "[general, worker, classic]"); add("typo", "[general, nope]");
  return dir;
}

const INSTANCES = {
  general: { backend: "claude-code", general_topic: true },
  coder: { backend: "claude-code", tool_set: "minimal", library: { skills: ["review"] } },
  helper: { backend: "codex", library: { skills: ["review", "triage"] } },
  oldcli: { backend: "gemini-cli", library: { skills: ["review"] } },
  winbox: { backend: "claude-code", runtime: "windows", library: { skills: ["review"] } },
};

describe("buildOverview", () => {
  it("lists bundled skills with their roles and the agents that get them by role (a Windows agent has no skills folder)", () => {
    const o = buildOverview({ instances: INSTANCES, bundledDir: fixtureSkills() });
    const by = Object.fromEntries(o.builtinSkills.map((s) => [s.name, s]));
    expect(Object.keys(by)).toEqual(["admin-only", "everyone", "for-workers", "typo"]);
    expect(by["admin-only"]!.roles).toEqual(["general"]);
    expect(by["admin-only"]!.agents).toEqual(["general"]);
    expect(by["for-workers"]!.agents).toEqual(["coder", "general", "helper", "oldcli"]);
    expect(by["everyone"]!.roles).toEqual(["general", "worker", "classic"]);
    expect(by["typo"]!.roles).toEqual(["general"]);                       // an unknown role fails closed, as the publisher does
    expect(by["everyone"]!.description).toBe("everyone does a thing");
  });

  it("names every tool profile with its tools and the agents running under it (the one rule the daemon uses)", () => {
    const o = buildOverview({ instances: INSTANCES, bundledDir: fixtureSkills() });
    expect(o.toolSets.map((t) => t.name)).toEqual(Object.keys(TOOL_PROFILES));
    const set = (n: string) => o.toolSets.find((t) => t.name === n)!;
    expect(set("general").agents).toEqual(["general"]);
    expect(set("minimal").agents).toEqual(["coder"]);
    expect(set("worker").agents).toEqual(["helper", "oldcli", "winbox"]);
    expect(set("minimal").tools).toEqual([...TOOL_PROFILES.minimal]);
    expect(o.mcp).toEqual([{ name: "agend", agents: ["coder", "general", "helper", "oldcli", "winbox"] }]);
  });

  it("reports team skill usage from librarySkillUsage, and which agents' CLI has no skills folder", () => {
    const o = buildOverview({ instances: INSTANCES, bundledDir: fixtureSkills() });
    expect(o.teamUsage).toEqual({ review: ["coder", "helper", "oldcli"], triage: ["helper"] });   // the Windows agent is left out
    const flags = Object.fromEntries(o.agents.map((a) => [a.name, a.nativeSkills]));
    expect(flags).toEqual({ coder: true, general: true, helper: true, oldcli: false, winbox: true });
    expect(o.agents.find((a) => a.name === "winbox")!.windows).toBe(true);
    expect(o.agents.find((a) => a.name === "general")!.role).toBe("general");
  });

  it("an agent with no backend takes the fleet's default", () => {
    const o = buildOverview({ instances: { a: {} }, defaultBackend: "gemini-cli", bundledDir: fixtureSkills() });
    expect(o.agents[0]).toMatchObject({ name: "a", backend: "gemini-cli", nativeSkills: false });
    expect(buildOverview({ instances: { a: {} }, bundledDir: fixtureSkills() }).agents[0]!.backend).toBe("claude-code");
  });

  it("reads only: the settings are not changed, and an empty or missing fleet answers an empty overview", () => {
    const frozen = JSON.parse(JSON.stringify(INSTANCES));
    const deep = (v: any): any => { if (v && typeof v === "object") { Object.values(v).forEach(deep); Object.freeze(v); } return v; };
    expect(() => buildOverview({ instances: deep(frozen), bundledDir: fixtureSkills() })).not.toThrow();
    expect(frozen).toEqual(INSTANCES);
    for (const instances of [{}, null, undefined]) {
      const o = buildOverview({ instances, bundledDir: fixtureSkills() });
      expect(o.agents).toEqual([]); expect(o.teamUsage).toEqual({}); expect(o.mcp).toEqual([{ name: "agend", agents: [] }]);
    }
  });

  it("the real bundle: every skill has a description and valid roles, and the names match the folder", () => {
    const o = buildOverview({ instances: {} });
    expect(o.builtinSkills.length).toBe(listBundledSkills().length);
    expect(o.builtinSkills.length).toBeGreaterThan(10);
    for (const s of o.builtinSkills) {
      expect(s.description.length, s.name).toBeGreaterThan(0);
      expect(s.roles.length, s.name).toBeGreaterThan(0);
      for (const r of s.roles) expect(["general", "worker", "classic"]).toContain(r);
    }
    expect(existsSync(BUNDLED_SKILLS_DIR)).toBe(true);
  });
});

describe("the roles rule the publisher and the overview share", () => {
  it("falls back to General only, and says why when the value is bad", () => {
    expect(parseBundledSkillRoles("no frontmatter")).toEqual({ roles: ["general"] });
    expect(parseBundledSkillRoles("---\nname: a\n---\n")).toEqual({ roles: ["general"] });
    expect(parseBundledSkillRoles("---\nroles: [worker, classic]\n---\n")).toEqual({ roles: ["worker", "classic"] });
    for (const bad of ["roles: worker", "roles: []", "roles: [admin]", "roles: [: ["]) {
      const r = parseBundledSkillRoles(`---\n${bad}\n---\n`);
      expect(r.roles, bad).toEqual(["general"]); expect(r.error, bad).toBeDefined();
    }
  });
});

describe("the skills-folder table", () => {
  it("answers for the CLIs it knows, never for a name that only an object inherits", () => {
    for (const b of Object.keys(NATIVE_SKILLS_DIR_SEGMENTS)) expect(hasNativeSkillsDir(b)).toBe(true);
    for (const b of ["gemini-cli", "constructor", "__proto__", "", undefined, 3]) expect(hasNativeSkillsDir(b), String(b)).toBe(false);
  });
});

describe("the route", () => {
  const servers: Server[] = [];
  afterEach(async () => { for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise<void>((r) => s.close(() => r())); } });
  async function rig() {
    const dataDir = scratch();
    const token = "a".repeat(48), sessions = new WebSessionStore();
    const admin = sessions.create({ tier: "admin", surface: "local", label: "admin", tokenEpoch: tokenEpoch(token) });
    const viewer = sessions.create({ tier: "read", surface: "local", label: "viewer", tokenEpoch: tokenEpoch(token) });
    const ctx: any = { webToken: token, webSessions: sessions, dataDir, fleetConfig: { defaults: { backend: "codex" }, instances: INSTANCES }, logger: { error() {}, info() {}, warn() {}, debug() {} } };
    const s = createServer((req, res) => { handleWebRequest(req, res, new URL(req.url!, `http://${req.headers.host}`), ctx); });
    servers.push(s); s.listen(0, "127.0.0.1"); await once(s, "listening");
    const base = `http://127.0.0.1:${(s.address() as any).port}`;
    const get = (id: string) => (path: string) => fetch(base + path, { headers: { cookie: `agend_session=${id}`, origin: base, "x-agend-csrf": csrfTokenFor(id) } });
    return { dataDir, base, admin: get(admin.sessionId), viewer: get(viewer.sessionId) };
  }

  it("an administrator reads the overview; nothing is created or written", async () => {
    const r = await rig();
    const res = await r.admin("/ui/library/overview");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agents.map((a: any) => a.name)).toEqual(["coder", "general", "helper", "oldcli", "winbox"]);
    expect(body.builtinSkills.length).toBeGreaterThan(10);
    expect(body.toolSets.map((t: any) => t.name)).toEqual(Object.keys(TOOL_PROFILES));
    expect(body.teamUsage).toEqual({ review: ["coder", "helper", "oldcli"], triage: ["helper"] });
    expect(readdirSync(r.dataDir)).toEqual([]);                                  // not even the library/ folder
  });

  it("is for the administrator only, as the rest of the library is", async () => {
    const r = await rig();
    expect((await r.viewer("/ui/library/overview")).status).toBe(403);
    expect([401, 403]).toContain((await fetch(`${r.base}/ui/library/overview`)).status);
  });

  it("the list says which CLIs read a skills folder, from the same table", async () => {
    const r = await rig();
    const body = await (await r.admin("/ui/library/list")).json();
    expect(body.skillsFolderBackends).toEqual(Object.keys(NATIVE_SKILLS_DIR_SEGMENTS));
  });
});

// ── the page ────────────────────────────────────────────────────────────────────────────────────────────────────
let p: AppPage, L: any, I: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19282/ui/library", storage: { agend_tour_done: "1" } });
  I = await import("/assets/app-i18n.js" as string);
  L = await import("/ui/js/panel-library.js" as string);
});
afterAll(() => { p.restore(); });
afterEach(async () => { await p.unmount(); vi.unstubAllGlobals(); });

const ITEMS = [
  { kind: "skill", id: "review", description: "Reviews code", status: "ok", files: 1, size: 100 },
  { kind: "skill", id: "triage", description: "Sorts issues", status: "ok", files: 1, size: 100 },
  { kind: "mcp", id: "github", description: "GitHub", status: "ok", size: 300 },
];
const OVERVIEW = buildOverview({ instances: INSTANCES, bundledDir: fixtureSkills() });
function answer(map: Record<string, { status: number; body: unknown }>) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => { const a = map[url.split("?")[0]!] ?? { status: 404, body: {} }; return { ok: a.status < 400, status: a.status, json: async () => a.body }; }));
}
const ok = { "/ui/library/list": { status: 200, body: { items: ITEMS } }, "/ui/library/overview": { status: 200, body: OVERVIEW } };
const open = async (lang = "en") => { await p.mount(h(L.LibraryPanel, { navKey: `library:|1|${lang}` })); await settle(); };
const q = (sel: string) => p.document.querySelector(sel) as any;
const qa = (sel: string) => p.document.querySelectorAll(sel) as any[];

describe("the page as an overview", () => {
  it("has one card per category, each holding its title, its team rows and its built-in rows in the same box", async () => {
    answer(ok); await open();
    const cards = qa("[data-library-card]");
    expect(cards.map((c) => c.getAttribute("data-library-card"))).toEqual(["skills", "tools", "mcp"]);
    for (const c of cards) {
      expect(c.classList.contains("card"), "a shared card").toBe(true);
      expect(c.querySelector("h3"), "its title is inside it").not.toBeNull();
      expect(c.querySelectorAll(".row-item").length, "its rows are inside it").toBeGreaterThan(0);
    }
    const skills = q('[data-library-card="skills"]');
    expect(skills.querySelector("h3").textContent).toBe("Skills");
    expect(skills.querySelector('[data-library-add="skill"]')).not.toBeNull();          // the Add button sits in the card's title row
    expect([...skills.querySelectorAll("[data-library-item]")].map((e: any) => e.getAttribute("data-library-item"))).toEqual(["skill:review", "skill:triage"]);
    expect(skills.querySelectorAll("[data-library-builtin]").length).toBe(OVERVIEW.builtinSkills.length);
    expect(q('[data-library-card="tools"]').querySelectorAll("[data-library-builtin]").length).toBe(Object.keys(TOOL_PROFILES).length);
    expect(q('[data-library-card="mcp"] [data-library-item="mcp:github"]')).not.toBeNull();
    expect(q('[data-library-card="mcp"] [data-library-builtin="mcp:agend"]')).not.toBeNull();
    // no category title is a box of its own outside its rows
    expect(qa(".p-library > .panel-body > .col > .row-item").length).toBe(0);
  });

  it("says it is an overview, and which items are built in (read only) and which the team added", async () => {
    answer(ok); await open();
    const text = q(".p-library").textContent;
    expect(text).toContain("An overview of what this AgEnD has");
    expect(text).toContain("Built in · read only"); expect(text).toContain("Added by your team");
    expect(text).not.toContain("Nothing in the library is given to an agent");
  });

  it("built-in rows have no Delete, View or Add: they are read only", async () => {
    answer(ok); await open();
    for (const row of qa("[data-library-builtin]")) {
      expect(row.querySelector("[data-library-delete]")).toBeNull();
      expect(row.querySelector("[data-library-view]")).toBeNull();
      expect(row.querySelector("button"), row.getAttribute("data-library-builtin")).toBeNull();
      expect(row.textContent).toContain("Built in");
    }
    expect(qa("[data-library-delete]").length).toBe(ITEMS.length);                       // only the team's own rows
  });

  it("shows who uses each item: built-in skills by role, tool sets by setting, team skills by mount", async () => {
    answer(ok); await open();
    const used = (key: string) => q(`[data-library-builtin="${key}"] [data-library-used-by]`).textContent;
    expect(used("skill:admin-only")).toContain("Used by: general");
    expect(used("skill:admin-only")).toContain("Given to: General");
    expect(used("skill:for-workers")).toContain("coder, general, helper, oldcli");
    expect(used("tools:minimal")).toContain("Used by: coder");
    expect(used("tools:coordinator")).toContain("No agent uses it");
    expect(used("mcp:agend")).toContain("coder, general, helper, oldcli, winbox");
    expect(q('[data-library-item="skill:review"] [data-library-used-by]').textContent).toContain("Used by: coder, helper, oldcli");
    expect(q('[data-library-item="skill:triage"] [data-library-used-by]').textContent).toContain("Used by: helper");
    expect(q('[data-library-item="mcp:github"] [data-library-used-by]')).toBeNull();     // MCP items are not given to agents yet
    expect(q('[data-library-builtin="tools:full"]').textContent).toContain(`${TOOL_PROFILES.full.length} tools`);
    expect(q('[data-library-builtin="tools:minimal"]').textContent).toContain("reply · send_to_instance");
  });

  it("marks an agent whose CLI has no skills folder: the skill is mounted but cannot take effect", async () => {
    answer(ok); await open();
    const note = q('[data-library-item="skill:review"] [data-library-no-folder="oldcli"]');
    expect(note.textContent).toContain("oldcli"); expect(note.textContent).toContain("gemini-cli"); expect(note.textContent).toContain("no skills folder");
    expect(q('[data-library-item="skill:review"]').classList.contains("is-warn")).toBe(true);
    expect(q('[data-library-item="skill:triage"] [data-library-no-folder]')).toBeNull();
    expect(q('[data-library-item="skill:triage"]').classList.contains("is-warn")).toBe(false);
  });

  it("deleting a skill that agents use says who loses it", async () => {
    answer(ok); await open();
    const src = (await import("node:fs")).readFileSync("src/ui/panel-library.js", "utf8");
    expect(src).toContain("deleteBodyUsed");
    expect(I.t("library.deleteBodyUsed", "coder, helper")).toContain("coder, helper");
  });

  it("if the overview cannot be read the team's items are still there, with a retry for the rest", async () => {
    answer({ ...ok, "/ui/library/overview": { status: 500, body: { error: "library_failed" } } }); await open();
    expect(qa("[data-library-item]").length).toBe(ITEMS.length);
    expect(qa("[data-library-builtin]").length).toBe(0);
    expect(q(".p-library").textContent).toContain("Could not read the built-in skills and tools.");
    answer(ok);
    const retry = qa(".p-library .error-state button")[0]; retry.click(); await settle();
    expect(qa("[data-library-builtin]").length).toBeGreaterThan(0);
  });

  it("an empty team library still shows the built-in items, with an empty state in each team group and both Add buttons", async () => {
    answer({ ...ok, "/ui/library/list": { status: 200, body: { items: [] } } }); await open();
    expect(qa("[data-library-item]").length).toBe(0);
    expect(qa('[data-library-group^="team-"] .empty').length).toBe(2);
    expect(qa("[data-library-add]").length).toBe(2);
    expect(qa("[data-library-builtin]").length).toBeGreaterThan(0);
  });

  it("a session that is not an administrator is told so, and shows no built-in rows", async () => {
    answer({ "/ui/library/list": { status: 403, body: { error: "admin_required" } }, "/ui/library/overview": { status: 403, body: { error: "admin_required" } } }); await open();
    expect(q(".p-library").textContent).toContain("administrator");
    expect(qa("[data-library-card]").length).toBe(0);
  });

  it("is the same in zh-TW", async () => {
    answer(ok); I.setLang("zh-TW", { store: false });
    try {
      await open("zh-TW");
      const text = q(".p-library").textContent;
      expect(text).toContain("這一頁是總覽"); expect(text).toContain("內建・唯讀"); expect(text).toContain("團隊新增"); expect(text).toContain("使用中");
      expect(q('[data-library-card="tools"] h3').textContent).toBe("工具");
      expect(q('[data-library-item="skill:review"] [data-library-no-folder="oldcli"]').textContent).toContain("沒有 skill 資料夾");
      expect(text).not.toContain("不會交給任何 Agent");
    } finally { I.setLang("en", { store: false }); }
  });
});

describe("the agent's Team skills field", () => {
  it("says so when the agent's CLI has no skills folder — from the server's list, not a list in the page", async () => {
    const D = await import("/ui/js/library-mount-field.js" as string);
    const field = (backend: string, folderBackends: string[] | undefined) => {
      answer({ "/ui/library/list": { status: 200, body: { items: ITEMS, ...(folderBackends ? { skillsFolderBackends: folderBackends } : {}) } } });
      const m = { f: { backend, library_skills: [] }, set: () => () => {} };
      return p.mount(h(D.LibrarySkillsField, { m, L: (label: string) => h("label", null, label) })).then(() => settle(6));
    };
    await field("gemini-cli", Object.keys(NATIVE_SKILLS_DIR_SEGMENTS));
    expect(q("[data-library-no-folder]").textContent).toContain("gemini-cli");
    await p.unmount();
    await field("claude-code", Object.keys(NATIVE_SKILLS_DIR_SEGMENTS));
    expect(q("[data-library-no-folder]")).toBeNull();
    await p.unmount();
    await field("gemini-cli", undefined);                                   // an older server: nothing is claimed
    expect(q("[data-library-no-folder]")).toBeNull();
  });

  it("has the words in both languages", () => {
    const src = (require("node:fs") as typeof import("node:fs")).readFileSync("src/ui/library-mount-field.js", "utf8");
    expect((src.match(/noFolder:/g) ?? []).length).toBe(2);
  });
});
