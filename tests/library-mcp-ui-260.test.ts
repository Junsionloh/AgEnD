/**
 * AGEND-260: the "Team MCP servers" field in an agent's settings (Workspace), the list/overview answers behind it and the Library page's
 * MCP rows: ticking writes `library.mcp` and keeps `library.skills`; "Missing X" for a variable the daemon does not have (names only);
 * "not supported yet" on any backend but Claude Code; the usage counts MCP; no secret value is in any answer.
 */
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { WebSessionStore, csrfTokenFor, tokenEpoch } from "../src/web-session.js";
import { handleWebRequest } from "../src/web-api.js";
import { buildOverview } from "../src/library/overview.js";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { buildSettingsImpactSchema } from "../src/instance-config-impact.js";
import { normalizeSettingsInstancePatch } from "../src/settings-instance-patch.js";
// @ts-expect-error — a JS module of the app, with no types
import { agentForm, agentPatch, libraryMcpOf, libraryValue, libraryMountPatch } from "../src/ui/settings-model.js";

const SECRET = "s3cr3t-value-Q9x7-never-in-an-answer";
const MCP = (id: string, extra = "") => `agend_library: 1\nkind: mcp\nname: ${id}\ndescription: ${id} server\ntransport: stdio\ncommand: node\nargs:\n  - s.mjs\n${extra}`;

describe("the routes", () => {
  const servers: Server[] = [], dirs: string[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise<void>((r) => s.close(() => r())); }
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });
  async function rig(instances: Record<string, unknown> = {}) {
    const dataDir = mkdtempSync(join(tmpdir(), "agend-mcp-api-")); dirs.push(dataDir);
    const token = "a".repeat(48), sessions = new WebSessionStore();
    const admin = sessions.create({ tier: "admin", surface: "local", label: "admin", tokenEpoch: tokenEpoch(token) });
    const ctx: any = { webToken: token, webSessions: sessions, dataDir, fleetConfig: { instances }, logger: { error() {}, info() {}, warn() {}, debug() {} } };
    const s = createServer((req, res) => { handleWebRequest(req, res, new URL(req.url!, `http://${req.headers.host}`), ctx); });
    servers.push(s); s.listen(0, "127.0.0.1"); await once(s, "listening");
    const base = `http://127.0.0.1:${(s.address() as any).port}`;
    const headers = { "content-type": "application/json", cookie: `agend_session=${admin.sessionId}`, origin: base, "x-agend-csrf": csrfTokenFor(admin.sessionId) };
    return {
      get: async (path: string) => (await fetch(base + path, { headers })).json() as Promise<any>,
      post: (path: string, body: unknown) => fetch(base + path, { method: "POST", body: JSON.stringify(body), headers }),
    };
  }

  it("the list says how each MCP item runs, which variables it reads and which the daemon lacks — names only", async () => {
    vi.stubEnv("PRESENT_TOKEN", SECRET);
    vi.stubEnv("ABSENT_TOKEN", "");
    const r = await rig();
    expect((await r.post("/ui/library/save", { kind: "mcp", id: "echo", text: MCP("echo", "env:\n  - PRESENT_TOKEN\n  - ABSENT_TOKEN\n") })).status).toBe(200);
    expect((await r.post("/ui/library/save", { kind: "mcp", id: "plain", text: MCP("plain") })).status).toBe(200);
    const list = await r.get("/ui/library/list");
    const byId = Object.fromEntries(list.items.map((i: any) => [i.id, i]));
    expect(byId.echo.mcp).toEqual({ transport: "stdio", vars: ["PRESENT_TOKEN", "ABSENT_TOKEN"], missing: ["ABSENT_TOKEN"] });
    expect(byId.plain.mcp).toEqual({ transport: "stdio", vars: [], missing: [] });
    expect(list.mcpBackends).toEqual(["claude-code"]);
    expect(JSON.stringify(list)).not.toContain(SECRET);
  });

  it("the overview counts MCP in 'used by' and flags an agent whose CLI cannot take one", async () => {
    const r = await rig({
      a: { backend: "claude-code", library: { mcp: ["echo"] } }, b: { backend: "codex", library: { mcp: ["echo"], skills: ["s"] } },
      w: { backend: "claude-code", runtime: "windows", library: { mcp: ["echo"] } }, n: {},
    });
    const ov = await r.get("/ui/library/overview");
    expect(ov.teamMcpUsage).toEqual({ echo: ["a", "b"] });
    expect(Object.fromEntries(ov.agents.map((a: any) => [a.name, a.libraryMcp]))).toEqual({ a: true, b: false, n: true, w: false });
    expect(ov.teamUsage).toEqual({ s: ["b"] });
    expect(buildOverview({ instances: {} }).teamMcpUsage).toEqual({});
  });

  it("deleting a mounted server still asks: the usage the page shows includes it", async () => {
    const r = await rig({ a: { library: { mcp: ["echo"] } } });
    await r.post("/ui/library/save", { kind: "mcp", id: "echo", text: MCP("echo") });
    expect((await r.get("/ui/library/overview")).teamMcpUsage.echo).toEqual(["a"]);
  });
});

describe("the settings model", () => {
  it("`library` keeps both lists: changing one never drops the other; null only when both are empty", () => {
    const inst = { library: { skills: ["s"], mcp: ["m"] } };
    expect(libraryValue(inst, ["t"])).toEqual({ skills: ["t"], mcp: ["m"] });
    expect(libraryValue(inst, ["s"], [])).toEqual({ skills: ["s"] });
    expect(libraryValue(inst, [], [])).toBeNull();
    expect(libraryValue({}, [], ["m"])).toEqual({ mcp: ["m"] });
    expect(libraryMcpOf({ library: { mcp: ["a", 1, "b"] } })).toEqual(["a", "b"]);
    expect(libraryMcpOf({})).toEqual([]);
    // the "+" on a team skill keeps the agent's MCP mount
    expect(libraryMountPatch(inst, "u")).toEqual({ library: { skills: ["s", "u"], mcp: ["m"] } });
  });

  it("the patch names `library` only when the MCP list changed, and the server accepts it", () => {
    const inst = { working_directory: "/w", library: { skills: ["a"] } };
    const form = agentForm(inst, {}, "coder");
    expect(form.library_mcp).toEqual([]);
    expect(agentPatch(form, inst, {}, null, null)).not.toHaveProperty("library");
    const patch = agentPatch({ ...form, library_mcp: ["echo"] }, inst, {}, null, null);
    expect(patch.library).toEqual({ skills: ["a"], mcp: ["echo"] });
    expect(normalizeSettingsInstancePatch(inst, patch).library).toEqual({ skills: ["a"], mcp: ["echo"] });
    expect(buildSettingsImpactSchema().impacts["instance.library"]).toBe("instance");
  });
});

describe("the field", () => {
  let p: AppPage, D: any, I: any;
  beforeAll(async () => {
    p = page({ url: "http://127.0.0.1:19281/ui/fleet/agent/coder" });
    I = await import("/assets/app-i18n.js" as string);
    D = await import("/ui/js/settings-dialogs.js");
  });
  afterAll(() => p.restore());
  afterEach(async () => { await p.unmount(); vi.unstubAllGlobals(); });
  const ITEMS = [
    { kind: "skill", id: "review", description: "Reviews code", status: "ok" },
    { kind: "mcp", id: "echo", description: "Echo", status: "ok", mcp: { transport: "stdio", vars: ["EXAMPLE_TOKEN"], missing: [] } },
    { kind: "mcp", id: "needs-key", description: "Needs a key", status: "ok", mcp: { transport: "http", vars: ["EXAMPLE_API_KEY"], missing: ["EXAMPLE_API_KEY"] } },
    { kind: "mcp", id: "edited", description: "", status: "modified" },
  ];
  const answer = (body: unknown) => vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => body })));
  async function work(inst: Record<string, unknown>) {
    const out: { m?: any } = {};
    const ctx = {
      fleet: { defaults: {}, instances: { coder: inst } }, schema: buildSettingsImpactSchema(), stageAgent: vi.fn(), drafts: new Map(),
      channelType: () => "telegram", shortName: (n: string) => n, staged: new Map(), reload: vi.fn(),
    };
    function Page() { const m = D.useAgentForm({ name: "coder", inst, ctx }); out.m = m; return h(D.AgentFields, { m, cat: "work" }); }
    await p.unmount(); await p.mount(h(Page, null)); await settle(8);
    const rows = () => p.root.querySelectorAll("[data-library-mcp-item]").map((e: any) => e.getAttribute("data-library-mcp-item"));
    const box = (id: string) => p.root.querySelector(`[data-library-mcp-item="${id}"] input`) as any;
    const tick = async (id: string, on: boolean) => { const el = box(id); el.checked = on; fire(el, "change"); await settle(4); };
    return { rows, box, tick, patch: () => out.m.pending(), text: () => p.root.textContent as string };
  }

  it("lists the MCP servers only; ticking writes `library.mcp` and keeps `library.skills`; an untouched form writes nothing", async () => {
    answer({ items: ITEMS, mcpBackends: ["claude-code"] });
    const w = await work({ working_directory: "/w", library: { skills: ["review"] } });
    expect(w.rows()).toEqual(["echo", "needs-key", "edited"]);
    expect(w.text()).toContain("Team MCP servers");
    expect(w.patch()).not.toHaveProperty("library");
    await w.tick("echo", true);
    expect(w.patch().library).toEqual({ skills: ["review"], mcp: ["echo"] });
    await w.tick("echo", false);
    expect(w.patch()).not.toHaveProperty("library");
  });

  it("shows how each runs and what it reads; a missing variable is named and the item says it will not be enabled", async () => {
    answer({ items: ITEMS, mcpBackends: ["claude-code"] });
    const w = await work({ working_directory: "/w" });
    const echo = p.root.querySelector('[data-library-mcp-item="echo"]').textContent as string;
    expect(echo).toContain("Runs a local command"); expect(echo).toContain("EXAMPLE_TOKEN");
    const needs = p.root.querySelector('[data-library-mcp-item="needs-key"]');
    expect(needs.textContent).toContain("Calls a web address");
    expect(needs.querySelector("[data-library-mcp-missing]").getAttribute("data-library-mcp-missing")).toBe("EXAMPLE_API_KEY");
    expect(needs.textContent).toContain("Missing EXAMPLE_API_KEY");
    expect(needs.textContent).toContain("not enabled");
    expect(p.root.querySelector('[data-library-mcp-item="echo"] [data-library-mcp-missing]')).toBeNull();
    // a modified item cannot be ticked (not the file that was saved)
    expect(w.box("edited").disabled).toBe(true);
    // a server that lacks a variable may still be ticked: the administrator can set the variable afterwards
    expect(w.box("needs-key").disabled).toBeFalsy();
  });

  it("any other backend: says 'not supported yet' and adds nothing; an id already mounted can still be unticked", async () => {
    answer({ items: ITEMS, mcpBackends: ["claude-code"] });
    const w = await work({ working_directory: "/w", backend: "codex", library: { mcp: ["echo"] } });
    expect(p.root.querySelector("[data-library-mcp-unsupported]").textContent).toContain("Not supported yet");
    expect(w.box("needs-key").disabled).toBe(true);
    expect(w.box("echo").disabled).toBeFalsy();
    await w.tick("echo", false);
    expect(w.patch().library).toBeNull();
  });

  it("a Windows native agent has no such field", async () => {
    answer({ items: ITEMS, mcpBackends: ["claude-code"] });
    const w = await work({ working_directory: "/w", runtime: "windows" });
    expect(w.rows()).toEqual([]);
  });

  it("every new word exists in English and zh-TW with the same placeholders", () => {
    const src = readFileSync("src/ui/library-mount-field.js", "utf8");
    const en = src.slice(src.indexOf("  en: {"), src.indexOf('  "zh-TW": {')), zh = src.slice(src.indexOf('  "zh-TW": {'), src.indexOf("const lw ="));
    const table = (block: string) => new Map([...block.matchAll(/(?:^|[\s,{])([a-zA-Z_0-9]+): "((?:[^"\\]|\\.)*)"/g)].map((m) => [m[1]!, m[2]!] as const));
    const e = table(en), z = table(zh);
    for (const k of ["mcpCard", "mcpLabel", "mcpTip", "mcpNone", "mcpUnsupported", "mcpMissing", "mcpNote", "mcpUses", "mcpNoVars", "mcpStdio", "mcpHttp"]) {
      expect(e.has(k) && z.has(k), k).toBe(true);
      expect([...(e.get(k)!.matchAll(/\{\d\}/g))].map((m) => m[0]).sort(), k).toEqual([...(z.get(k)!.matchAll(/\{\d\}/g))].map((m) => m[0]).sort());
    }
    expect(I.t("libraryMount.mcpLabel")).toBe("Team MCP servers");
  });
});
