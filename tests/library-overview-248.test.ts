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
    // oldcli's CLI has no skills folder: nothing is published to it, so it is not listed as using one (a Windows agent neither)
    expect(by["for-workers"]!.agents).toEqual(["coder", "general", "helper"]);
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
import { readFileSync } from "node:fs";
// @ts-expect-error — a JS module of the app, with no types
import { parseRoute, routePath, routeKey } from "../src/ui/shared/app-route.js";
import { shellRoute } from "../src/web-shell-routes.js";
// @ts-expect-error — JS modules of the app, with no types
import { agentForm, agentPatch, agentPatchRequest, libraryMountPatch, requestImpact } from "../src/ui/settings-model.js";
// @ts-expect-error
import { categoryPath } from "../src/ui/agent-details-settings.js";
import { buildSettingsImpactSchema } from "../src/instance-config-impact.js";

let p: AppPage, L: any, I: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19282/ui/library/skills", storage: { agend_tour_done: "1" } });
  I = await import("/assets/app-i18n.js" as string);
  L = await import("/ui/js/panel-library.js" as string);
});
afterAll(() => { p.restore(); });
afterEach(async () => { await p.unmount(); vi.unstubAllGlobals(); (globalThis as any).history.replaceState(null, "", "/ui/library/skills"); });

const ITEMS = [
  { kind: "skill", id: "review", description: "Reviews code", status: "ok", files: 1, size: 100 },
  { kind: "skill", id: "triage", description: "Sorts issues", status: "ok", files: 1, size: 100 },
  { kind: "mcp", id: "github", description: "GitHub", status: "ok", size: 300 },
];
const OVERVIEW = buildOverview({ instances: INSTANCES, bundledDir: fixtureSkills() });
type Calls = Array<{ url: string; method: string; body: any }>;
function answer(map: Record<string, { status: number; body: unknown }>, calls?: Calls) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: any) => {
    calls?.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : undefined });
    const a = map[url.split("?")[0]!] ?? { status: 200, body: { result: "applied" } };
    return { ok: a.status < 400, status: a.status, json: async () => a.body };
  }));
}
const ok = { "/ui/library/list": { status: 200, body: { items: ITEMS } }, "/ui/library/overview": { status: 200, body: OVERVIEW } };
const open = async (section: string | undefined, lang = "en") => {
  (globalThis as any).history.replaceState(null, "", section ? `/ui/library/${section}` : "/ui/library");
  await p.mount(h(L.LibraryPanel, { route: section ? { panel: "library", section } : { panel: "library" }, navKey: `library:${section ?? ""}|1|${lang}` })); await settle();
};
const q = (sel: string) => p.document.querySelector(sel) as any;
const qa = (sel: string) => p.document.querySelectorAll(sel) as any[];
const text = () => q(".p-library").textContent as string;

describe("the layout is Settings'", () => {
  it("is the Settings page's own structure: a category list on the left, the chosen category on the right, a back link, PageHead and the search box", async () => {
    answer(ok); await open("skills");
    const root = q(".p-library");
    expect(root.classList.contains("p-settings")).toBe(true);                         // the same grid, nav and phone rules
    const nav = q("nav.s-nav");
    expect(nav).not.toBeNull();
    expect(nav.querySelectorAll(".s-nav-group .seg-item").map((a: any) => a.getAttribute("href"))).toEqual(["/ui/library/skills", "/ui/library/tools", "/ui/library/mcp"]);
    expect(nav.querySelector(".seg-item.active").getAttribute("data-library-nav")).toBe("skills");
    expect(q(".panel-body .s-back")).not.toBeNull();                                  // the phone's way back to the list
    expect(q(".panel-body .s-page-head h2").textContent).toBe("Skills");              // the shared PageHead
    expect(q(".panel-body .s-toolbar .s-search input[data-library-filter]")).not.toBeNull();
    // only the chosen category is on the right
    expect(qa("[data-library-card]").map((c) => c.getAttribute("data-library-card"))).toEqual(["skills"]);
    expect(qa("[data-library-builtin]").every((r) => r.getAttribute("data-library-builtin").startsWith("skill:"))).toBe(true);
  });

  it("each category shows only its own: tools, MCP servers", async () => {
    answer(ok); await open("tools");
    expect(q(".seg-item.active").getAttribute("data-library-nav")).toBe("tools");
    expect(qa("[data-library-builtin]").map((r) => r.getAttribute("data-library-builtin"))).toEqual(Object.keys(TOOL_PROFILES).map((n) => `tools:${n}`));
    expect(qa("[data-library-add]").length).toBe(0);                                  // tool sets are not added here
    await p.unmount();
    answer(ok); await open("mcp");
    expect(qa("[data-library-item]").map((r) => r.getAttribute("data-library-item"))).toEqual(["mcp:github"]);
    expect(qa("[data-library-builtin]").map((r) => r.getAttribute("data-library-builtin"))).toEqual(["mcp:agend"]);
    expect(q('[data-library-add="mcp"]')).not.toBeNull();
  });

  it("on a phone /ui/library is the list of categories and a category opens on its own, as /settings does", async () => {
    answer(ok); await open(undefined);
    expect(q(".p-library").getAttribute("data-view")).toBe("index");
    await p.unmount();
    answer(ok); await open("tools");
    expect(q(".p-library").getAttribute("data-view")).toBe("section");
    const css = readFileSync("src/ui/shared/app.css", "utf8");
    expect(css).toMatch(/\.p-settings\[data-view="index"\] > \.panel-body \{ display: none; \}/);   // the rule it rides on
  });

  it("routes: /ui/library keeps working and its categories parse on the client and the server alike", () => {
    expect(parseRoute("/ui/library")).toEqual({ panel: "library" });
    for (const s of ["skills", "tools", "mcp"]) {
      expect(parseRoute(`/ui/library/${s}`)).toEqual({ panel: "library", section: s });
      expect(shellRoute("GET", `/ui/library/${s}`)).toEqual({ kind: "shell", route: { panel: "library", section: s } });
      expect(routePath({ panel: "library", section: s })).toBe(`/ui/library/${s}`);
    }
    expect(routePath({ panel: "library" })).toBe("/ui/library");
    expect(parseRoute("/ui/library/nope")).toBeNull();
    for (const data of ["list", "item", "overview", "save", "delete"]) expect(shellRoute("GET", `/ui/library/${data}`)).toBeNull();
    expect(routeKey({ panel: "library", section: "tools" })).not.toBe(routeKey({ panel: "library", section: "skills" }));
  });
});

describe("many items", () => {
  it("every item is one compact row: the description is cut to one line and its full text is in Details / View", async () => {
    answer(ok); await open("skills");
    const rows = qa("[data-library-builtin]");
    expect(rows.length).toBe(OVERVIEW.builtinSkills.length);
    for (const r of rows) {
      expect(r.classList.contains("lib-row")).toBe(true);
      expect(r.querySelector(".lib-desc")).not.toBeNull();
      expect(r.querySelector("[data-library-details]")).not.toBeNull();
    }
    expect(readFileSync("src/ui/shared/app.css", "utf8")).toMatch(/\.p-library \.lib-desc \{[^}]*white-space: nowrap/);
    // AGEND-257: a built-in skill's Details is the skill dialog (preview only); a tool set's stays the read-only list
    answer({ ...ok, "/ui/library/builtin": { status: 200, body: { ok: true, detail: { kind: "skill", id: "admin-only", builtin: true, sha256: "", fields: [], body: "# Hi", files: [{ path: "SKILL.md", content: "# Hi", size: 4 }] } } } });
    qa("[data-library-details]")[0].click(); await settle();
    expect(q('[data-library-skill-dialog="builtin"]')).not.toBeNull();
    await p.unmount(); answer(ok); await open("tools");
    qa("[data-library-details]")[0].click(); await settle();
    expect(q("[data-library-details-dialog]").textContent).toContain("Used by");
  });

  it("a filter narrows the category's rows (team and built-in), and says when nothing matches", async () => {
    answer(ok); await open("skills");
    const filter = q("[data-library-filter]");
    const type = async (v: string) => { filter.value = v; filter.dispatchEvent(new (globalThis as any).Event("input", { bubbles: true })); await settle(); };
    await type("everyone");
    expect(qa("[data-library-builtin]").map((r) => r.getAttribute("data-library-builtin"))).toEqual(["skill:everyone"]);
    expect(qa("[data-library-item]").length).toBe(0);
    await type("sorts");                                                              // the description counts too
    expect(qa("[data-library-item]").map((r) => r.getAttribute("data-library-item"))).toEqual(["skill:triage"]);
    await type("zzzz");
    expect(text()).toContain("Nothing matches “zzzz”.");
    await type("");
    expect(qa("[data-library-builtin]").length).toBe(OVERVIEW.builtinSkills.length);
  });
});

describe("agents as tags", () => {
  it("a team skill's agents are tags that open that agent's Team skills field; built-in tags open the agent", async () => {
    answer(ok); await open("skills");
    const tags = qa('[data-library-item="skill:review"] [data-library-tag]');
    expect(tags.map((t) => t.getAttribute("data-library-tag"))).toEqual(["coder", "helper", "oldcli"]);
    expect(tags[0].tagName).toBe("A");
    expect(tags[0].getAttribute("href")).toBe(`${categoryPath("coder", "work")}#library-skills`);     // straight to the field
    expect(categoryPath("coder", "work")).toBe("/ui/fleet/agent/coder?cat=work");
    const built = qa('[data-library-builtin="skill:admin-only"] [data-library-tag]');
    expect(built.map((t) => t.getAttribute("href"))).toEqual(["/ui/fleet/agent/general"]);
    expect(qa('[data-library-builtin="skill:admin-only"] [data-library-add-agent]').length).toBe(0);     // built-in: a jump only, never an add
    await p.unmount(); answer(ok); await open("tools");
    expect(qa('[data-library-builtin="tools:minimal"] [data-library-tag]').map((t) => t.getAttribute("href"))).toEqual(["/ui/fleet/agent/coder?cat=work"]);
    expect(qa("[data-library-add-agent]").length).toBe(0);
  });

  it("only a team skill has the + tag; an agent whose CLI has no skills folder is marked in its tag", async () => {
    answer(ok); await open("skills");
    expect(qa("[data-library-item] [data-library-add-agent]").length).toBe(2);
    expect(qa("[data-library-builtin] [data-library-add-agent]").length).toBe(0);
    const bad = q('[data-library-item="skill:review"] [data-library-tag="oldcli"]');
    expect(bad.classList.contains("warn")).toBe(true);
    expect(bad.getAttribute("title")).toContain("no skills folder");
    expect(q('[data-library-item="skill:review"] [data-library-tag="coder"]').classList.contains("warn")).toBe(false);
  });

  it("more than three agents: the rest are behind a +N tag", async () => {
    const many = buildOverview({ instances: Object.fromEntries(["a", "b", "c", "d", "e"].map((n) => [n, { backend: "claude-code", library: { skills: ["review"] } }])), bundledDir: fixtureSkills() });
    answer({ ...ok, "/ui/library/overview": { status: 200, body: many } }); await open("skills");
    const row = '[data-library-item="skill:review"]';
    expect(qa(`${row} [data-library-tag]`).length).toBe(3);
    // AGEND-257: "+N" never makes the row taller; it opens the skill, whose Preview lists every agent
    expect(q(`${row} [data-library-more]`).textContent).toContain("+2");
    expect(q(`${row} [data-library-more]`).getAttribute("title")).toContain("d, e");
    answer({ ...ok, "/ui/library/overview": { status: 200, body: many }, "/ui/library/item": { status: 200, body: { ok: true, detail: { kind: "skill", id: "review", sha256: "a".repeat(64), fields: [], body: "", files: [{ path: "SKILL.md", content: "x", size: 1 }] } } } });
    q(`${row} [data-library-more]`).click(); await settle();
    expect(qa(`${row} [data-library-tag]`).length).toBe(3);
    expect(q('[data-library-skill-dialog="team"]')).not.toBeNull();
    expect(q("[data-library-skill-used]").textContent).toBe("a, b, c, d, e");
  });

  it("the page says the missing built-in agents too: a skill nobody gets shows 'No agent'", async () => {
    answer(ok); await open("tools");
    expect(q('[data-library-builtin="tools:coordinator"]').textContent).toContain("No agent");
  });
});

describe("the + tag writes what the agent's Settings page writes", () => {
  it("opens a list of the agents that do not have it yet (not a Windows one), says it applies at the next start, and disables an agent with no skills folder", async () => {
    answer(ok); await open("skills");
    q('[data-library-item="skill:triage"] [data-library-add-agent]').click(); await settle();
    const names = qa("[data-library-pick]").map((e) => e.getAttribute("data-library-pick"));
    expect(names).toEqual(["coder", "general", "oldcli"]);                            // helper already has triage; winbox is Windows
    expect(q("[data-library-add-dialog]").textContent).toContain("Takes effect the next time the agent starts");
    expect(q('[data-library-pick="oldcli"] input').disabled).toBe(true);
    expect(q("[data-library-add-confirm]").disabled).toBe(true);                      // nothing picked yet
  });

  it("the patch is exactly the Team skills field's: same `library` value, same URL and shape, same cost as Settings' staging", () => {
    const schema = buildSettingsImpactSchema();
    for (const inst of [{ working_directory: "/w" }, { working_directory: "/w", library: { skills: ["a"] } }, { working_directory: "/w", library: { skills: ["a"], mcp: ["m"] } }]) {
      const form = agentForm(inst, {}, "coder");
      const viaSettings = agentPatch({ ...form, library_skills: [...(inst as any).library?.skills ?? [], "b"] }, inst, {}, null, null);
      expect(libraryMountPatch(inst, "b")).toEqual(viaSettings);
      const request = agentPatchRequest("coder", inst, libraryMountPatch(inst, "b"));
      expect(request).toEqual({ method: "PATCH", url: "/api/settings/fleet/instances/coder", body: viaSettings });
      expect(requestImpact(schema, request)).toBe(schema.impacts["instance.library"]);
    }
    expect(libraryMountPatch({ library: { skills: ["b"] } }, "b")).toEqual({});               // already there: nothing to write
    expect(agentPatchRequest("w", { runtime: "windows" }, { library: null }).url).toBe("/ui/instances/w");
    // and Settings' own staging uses the same helper (not a second copy of the URL)
    expect(readFileSync("src/ui/panel-settings.js", "utf8")).toContain("request: agentPatchRequest(name, inst, patch)");
  });

  it("confirming sends that PATCH through the app's Apply (startOperation), once per chosen agent, and writes nothing else", async () => {
    const calls: Calls = [];
    const raw = { instances: { coder: { working_directory: "/w", library: { skills: ["review"], mcp: ["m"] } }, general: { general_topic: true } } };
    answer({ ...ok, "/api/settings/fleet/raw": { status: 200, body: raw }, "/api/settings/schema": { status: 200, body: buildSettingsImpactSchema() } }, calls);
    await open("skills");
    q('[data-library-item="skill:triage"] [data-library-add-agent]').click(); await settle();
    for (const n of ["coder", "general"]) { const box = q(`[data-library-pick="${n}"] input`); box.checked = true; box.dispatchEvent(new (globalThis as any).Event("change", { bubbles: true })); await settle(); }
    q("[data-library-add-confirm]").click(); await settle(12);
    const patches = calls.filter((c) => c.method === "PATCH");
    expect(patches.map((c) => c.url)).toContain("/api/settings/fleet/instances/coder");
    const coder = patches.find((c) => c.url.endsWith("/coder"))!;
    expect(coder.body).toEqual({ library: { skills: ["review", "triage"], mcp: ["m"] } });         // what the field writes: the list, and what else `library` holds kept
    expect(coder.body).toEqual(agentPatch({ ...agentForm(raw.instances.coder, {}, "coder"), library_skills: ["review", "triage"] }, raw.instances.coder, {}, null, null));
    // before the confirm nothing but reads
    expect(calls.slice(0, 4).every((c) => c.method === "GET")).toBe(true);
    // the words say when it applies
    expect(I.t("library.addStarted", "triage")).toContain("next starts");
  });
});

describe("the page's words", () => {
  it("an overview that cannot be read still leaves the team's items, with a retry for the rest", async () => {
    answer({ ...ok, "/ui/library/overview": { status: 500, body: { error: "library_failed" } } }); await open("skills");
    expect(qa("[data-library-item]").length).toBe(2);
    expect(qa("[data-library-builtin]").length).toBe(0);
    expect(text()).toContain("Could not read the built-in skills and tools.");
    expect(qa('[data-library-item] [data-library-add-agent]').length).toBe(0);         // without the overview the agents are not known: no +
    answer(ok);
    qa(".p-library .error-state button")[0].click(); await settle();
    expect(qa("[data-library-builtin]").length).toBeGreaterThan(0);
  });

  it("an empty team library still shows the built-in items and an empty state in the team group", async () => {
    answer({ ...ok, "/ui/library/list": { status: 200, body: { items: [] } } }); await open("skills");
    expect(qa("[data-library-item]").length).toBe(0);
    expect(qa('[data-library-group="team-skills"] .empty').length).toBe(1);
    expect(qa("[data-library-builtin]").length).toBeGreaterThan(0);
    expect(qa("[data-library-add]").length).toBe(1);
  });

  it("a session that is not an administrator is told so, and shows no built-in rows", async () => {
    answer({ "/ui/library/list": { status: 403, body: { error: "admin_required" } }, "/ui/library/overview": { status: 403, body: { error: "admin_required" } } }); await open("skills");
    expect(text()).toContain("administrator");
    expect(qa("[data-library-card]").length).toBe(0);
  });

  it("says it is an overview, which items are built in (read only) and which are the team's, in English and in zh-TW", async () => {
    answer(ok); await open("skills");
    expect(text()).toContain("An overview of what this AgEnD has"); expect(text()).toContain("Built in · read only"); expect(text()).toContain("Added by your team");
    expect(text()).not.toContain("Nothing in the library is given to an agent");
    await p.unmount();
    answer(ok); I.setLang("zh-TW", { store: false });
    try {
      await open("skills", "zh-TW");
      expect(text()).toContain("這一頁是總覽"); expect(text()).toContain("內建・唯讀"); expect(text()).toContain("團隊新增");
      expect(q('[data-library-nav="tools"]').textContent).toContain("工具");
      expect(text()).not.toContain("不會交給任何 Agent");
      expect(q('[data-library-item="skill:review"] [data-library-tag="oldcli"]').getAttribute("title")).toContain("沒有 skill 資料夾");
    } finally { I.setLang("en", { store: false }); }
  });

  it("every word exists in English and zh-TW, with the same placeholders", () => {
    const src = readFileSync("src/ui/panel-library.js", "utf8");
    const en = src.slice(src.indexOf("  en: {"), src.indexOf('  "zh-TW": {')), zh = src.slice(src.indexOf('  "zh-TW": {'), src.indexOf("const tn ="));
    const table = (block: string) => new Map([...block.matchAll(/(?:^|[\s,{])([a-zA-Z_0-9]+): "((?:[^"\\]|\\.)*)"/g)].map((m) => [m[1]!, m[2]!] as const));
    const holes = (v: string) => [...new Set(v.match(/\{\d\}/g) ?? [])].sort().join("");
    const e = table(en), z = table(zh);
    expect([...z.keys()].sort()).toEqual([...e.keys()].sort());
    for (const [k, v] of e) { if (k !== "st_ok") expect(holes(z.get(k)!), k).toBe(holes(v)); }
  });
});

describe("the agent's Team skills field", () => {
  it("is titled 'Team skills (from the Library)' in both languages, sits right after the working directory, and is the target of the tags' link", () => {
    const f = readFileSync("src/ui/library-mount-field.js", "utf8");
    expect(f).toContain('card: "Team skills (from the Library)"'); expect(f).toContain('card: "團隊 Skill（來自資源庫）"');
    expect(f).toContain('location.hash !== "#library-skills"');                   // the tags' link target is the hash, not an id (two panes would share it)
    const dlg = readFileSync("src/ui/settings-dialogs.js", "utf8");
    expect(dlg.indexOf("libraryCardTitle()")).toBeGreaterThan(dlg.indexOf('pt("cardWorkdir")'));
    expect(dlg.indexOf("libraryCardTitle()")).toBeLessThan(dlg.indexOf('pt("cardIdle")'));
  });

  it("says so when the agent's CLI has no skills folder — from the server's list, not a list in the page", async () => {
    const D = await import("/ui/js/library-mount-field.js" as string);
    const field = async (backend: string, folderBackends: string[] | undefined) => {
      answer({ "/ui/library/list": { status: 200, body: { items: ITEMS, ...(folderBackends ? { skillsFolderBackends: folderBackends } : {}) } } });
      const m = { f: { backend, library_skills: [] }, set: () => () => {} };
      await p.mount(h(D.LibrarySkillsField, { m, L: (label: string) => h("label", null, label) })); await settle(6);
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
});
