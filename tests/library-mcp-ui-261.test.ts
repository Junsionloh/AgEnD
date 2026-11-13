/**
 * AGEND-261: the "MCP servers" and "Skills" cards of an agent's settings (only what is enabled; "+ Add" opens the picker: read what it runs,
 * Enable = confirm, then the patch), the Library page's MCP rows (the "in use" tags and the "+"), and the words in both languages.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { buildSettingsImpactSchema } from "../src/instance-config-impact.js";
import { buildOverview } from "../src/library/overview.js";
// @ts-expect-error — JS modules of the app, with no types
import { agentForm, agentPatch, agentPatchRequest, libraryMcpMountPatch, libraryMcpOf, libraryMountPatch, libraryValue } from "../src/ui/settings-model.js";

let p: AppPage, D: any, I: any, LM: any, L: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19283/ui/fleet/agent/coder", storage: { agend_tour_done: "1" } });
  I = await import("/assets/app-i18n.js" as string);
  D = await import("/ui/js/settings-dialogs.js");
  LM = await import("/ui/js/library-mcp-field.js" as string);
  L = await import("/ui/js/panel-library.js" as string);
});
afterAll(() => p.restore());
afterEach(async () => { await p.unmount(); vi.unstubAllGlobals(); (globalThis as any).history.replaceState(null, "", "/ui/fleet/agent/coder"); });

const SHA = "a".repeat(64), SHA2 = "b".repeat(64);
const stdio = (id: string, over: Record<string, unknown> = {}) => ({
  id, description: `${id} server`, status: "ok", sha256: SHA, confirmed: false, mounted: false,
  summary: { transport: "stdio", command: "npx", args: ["-y", "pkg with space", "--flag=\"q\""], variables: ["GH_TOKEN", "GH_HOST"] },
  variables: [{ name: "GH_TOKEN", set: true }, { name: "GH_HOST", set: false }], ...over,
});
const http = (id: string) => ({
  id, description: "remote", status: "ok", sha256: SHA2, confirmed: true, mounted: false,
  summary: { transport: "http", url: "https://mcp.example.com/v1", host: "mcp.example.com", variables: ["EX_AUTH"] }, variables: [{ name: "EX_AUTH", set: true }],
});
const STATUS = { agent: "coder", backend: "claude-code", supported: true, backends: ["claude-code", "codex"], windows: false, items: [stdio("gh"), http("ex"), { id: "broken", description: "", status: "modified", confirmed: false, mounted: false }] };

type Calls = Array<{ url: string; method: string; body: any }>;
function answer(map: Record<string, { status: number; body: unknown }>, calls?: Calls) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: any) => {
    calls?.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : undefined });
    const a = map[url.split("?")[0]!] ?? { status: 200, body: {} };
    return { ok: a.status < 400, status: a.status, json: async () => a.body };
  }));
}
const q = (sel: string) => p.document.querySelector(sel) as any;
const qa = (sel: string) => p.document.querySelectorAll(sel) as any[];

const ctxFor = (inst: Record<string, unknown>) => ({
  fleet: { defaults: {}, instances: { coder: inst } }, schema: buildSettingsImpactSchema(), stageAgent: vi.fn(), drafts: new Map(),
  channelType: () => "telegram", shortName: (n: string) => n, staged: new Map(), reload: vi.fn(),
});
async function work(inst: Record<string, unknown>) {
  const out: { m?: any } = {};
  const ctx = ctxFor(inst);
  function Page() { const m = D.useAgentForm({ name: "coder", inst, ctx }); out.m = m; return h(D.AgentFields, { m, cat: "work" }); }
  await p.unmount(); await p.mount(h(Page, null)); await settle(8);
  const rows = () => qa("[data-library-mcp-field] [data-library-mcp]").map((e) => e.getAttribute("data-library-mcp"));
  const remove = async (id: string) => { q(`[data-library-mcp-field] [data-library-remove="${id}"]`).click(); await settle(6); };
  const openPicker = async () => { q("[data-library-mcp-field] [data-library-add-open]").click(); await settle(6); };
  const pickable = () => qa("[data-library-pick-item]").map((e) => e.getAttribute("data-library-pick-item"));
  const read = async (id: string) => { q(`[data-library-pick-item="${id}"]`).click(); await settle(6); };
  return { rows, remove, openPicker, pickable, read, patch: () => out.m.pending(), text: () => (q("[data-library-mcp-field]")?.textContent ?? "") as string };
}

describe("the MCP servers card", () => {
  const withStatus = (items: unknown[] = STATUS.items, extra: Record<string, unknown> = {}) => ({ "/ui/library/mcp-status": { status: 200, body: { ...STATUS, items, ...extra } }, "/ui/library/list": { status: 200, body: { items: [] } } });

  it("sits right under Skills in the Workspace category; its title row has the tip, the restart badge and '+ Add'; there is no second heading inside", async () => {
    answer(withStatus());
    await work({ working_directory: "/w" });
    const card = q("[data-library-mcp-field]");
    expect(card.querySelector(".lib-card-head h3").textContent).toContain("MCP servers");
    expect(card.querySelector(".lib-card-head h3 .impact")).not.toBeNull();
    expect(card.querySelector(".lib-card-head [data-library-add-open]").textContent).toContain("Add");
    expect(card.querySelectorAll(".s-lab").length).toBe(0);
    expect((globalThis as any).fetch.mock.calls.map((c: any[]) => c[0])).toContain("/ui/library/mcp-status?agent=coder");
    const dlg = readFileSync("src/ui/settings-dialogs.js", "utf8");
    expect(dlg.indexOf("libraryMcpCardTitle()")).toBeGreaterThan(dlg.indexOf("libraryCardTitle()"));
    expect(dlg.indexOf("libraryMcpCardTitle()")).toBeLessThan(dlg.indexOf('pt("cardIdle")'));
  });

  it("only what is enabled is on the card: with nothing enabled there is an empty state, and every Library server is in the picker", async () => {
    answer(withStatus());
    const w = await work({ working_directory: "/w" });
    expect(w.rows()).toEqual([]);
    expect(q("[data-library-mcp-field] [data-library-empty]").textContent).toContain("No Library MCP servers enabled yet");
    await w.openPicker();
    expect(w.pickable()).toEqual(["gh", "ex", "broken"]);
    expect(q('[data-library-pick-item="broken"]').disabled).toBe(true);        // changed outside the Library: listed, not offered
  });

  it("an untouched form writes no `library` key", async () => {
    answer(withStatus([stdio("gh", { mounted: true, confirmed: true })]));
    const w = await work({ working_directory: "/w", library: { mcp: ["gh"] } });
    expect(w.rows()).toEqual(["gh"]);
    expect(w.patch()).not.toHaveProperty("library");
  });

  it("reading a server in the picker shows exactly what it runs; Enable is the confirmation (that version, for this agent) and then the patch has the id", async () => {
    const calls: Calls = [];
    answer({ ...withStatus(), "/ui/library/mcp-confirm": { status: 200, body: { ok: true } } }, calls);
    const w = await work({ working_directory: "/w" });
    await w.openPicker();
    await w.read("gh");
    // the whole command, argument by argument (one with a space and one with quotes are quoted so none can be misread), and the variable names
    expect(q("[data-library-mcp-command]").textContent).toBe('npx -y "pkg with space" "--flag=\\"q\\""');
    expect(qa("[data-library-mcp-var]").map((e) => e.getAttribute("data-library-mcp-var"))).toEqual(["GH_TOKEN", "GH_HOST"]);
    expect(q('[data-library-mcp-var="GH_HOST"]').textContent).toContain("missing");
    expect(q("[data-library-picker-preview]").textContent).toContain("same as today’s .env approach");
    expect(q("[data-library-picker-preview]").textContent).toContain("Enabling it confirms this version");
    // nothing is recorded or written until Enable
    expect(w.patch()).not.toHaveProperty("library");
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
    q("[data-library-picker-enable]").click(); await settle(10);
    expect(calls.filter((c) => c.method === "POST")).toEqual([{ url: "/ui/library/mcp-confirm", method: "POST", body: { agent: "coder", id: "gh", sha256: SHA } }]);
    expect(w.patch().library).toEqual({ mcp: ["gh"] });
    // back at the picker's list: gh left it, with a line saying it is enabled; the card behind it lists gh with its status
    expect(w.pickable()).toEqual(["ex", "broken"]);
    expect(q("[data-library-picker-done-note]").textContent).toContain("“gh” is enabled");
    q("[data-library-picker-done]").click(); await settle(6);
    expect(w.rows()).toEqual(["gh"]);
  });

  it("Back from the preview changes nothing and records nothing", async () => {
    const calls: Calls = [];
    answer(withStatus(), calls);
    const w = await work({ working_directory: "/w" });
    await w.openPicker(); await w.read("gh");
    q("[data-library-picker-back]").click(); await settle(6);
    expect(q('[data-library-picker="list"]')).not.toBeNull();
    expect(w.patch()).not.toHaveProperty("library");
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  it("a stale version (409) is not enabled: the picker says so and the form is unchanged", async () => {
    answer({ ...withStatus(), "/ui/library/mcp-confirm": { status: 409, body: { error: "changed" } } });
    const w = await work({ working_directory: "/w" });
    await w.openPicker(); await w.read("gh");
    q("[data-library-picker-enable]").click(); await settle(10);
    expect(q("[data-library-error]").textContent).toContain("changed after you opened");
    expect(w.patch()).not.toHaveProperty("library");
  });

  it("an http server shows the whole address and its domain; enabling several in a row works and removing writes the list back", async () => {
    answer({ ...withStatus(), "/ui/library/mcp-confirm": { status: 200, body: { ok: true } } });
    const w = await work({ working_directory: "/w" });
    await w.openPicker(); await w.read("ex");
    expect(q("[data-library-mcp-url]").textContent).toBe("https://mcp.example.com/v1");
    expect(q("[data-library-mcp-domain]").textContent).toBe("mcp.example.com");
    q("[data-library-picker-enable]").click(); await settle(10);
    await w.read("gh"); q("[data-library-picker-enable]").click(); await settle(10);
    expect(w.patch().library).toEqual({ mcp: ["ex", "gh"] });
    q("[data-library-picker-done]").click(); await settle(6);
    await w.remove("ex");
    expect(w.patch().library).toEqual({ mcp: ["gh"] });
    await w.remove("gh");
    expect(w.patch()).not.toHaveProperty("library");
  });

  it("an enabled server with a missing variable says which, and is not started; a changed one asks to be confirmed again (the confirmation is not a settings change)", async () => {
    const calls: Calls = [];
    const items = [stdio("gh", { mounted: true, confirmed: true }), stdio("ex2", { mounted: true, confirmed: false, variables: [{ name: "A", set: true }] })];
    answer({ ...withStatus(items), "/ui/library/mcp-confirm": { status: 200, body: { ok: true } } }, calls);
    const w = await work({ working_directory: "/w", library: { mcp: ["gh", "ex2"] } });
    expect(w.rows()).toEqual(["gh", "ex2"]);
    expect(q('[data-library-mcp="gh"] [data-library-mcp-missing]').getAttribute("data-library-mcp-missing")).toBe("GH_HOST");
    expect(q('[data-library-mcp="gh"]').textContent).toContain("no value for GH_HOST");
    expect(q('[data-library-mcp="ex2"] [data-library-mcp-changed]').textContent).toContain("Changed — confirm again");
    q('[data-library-mcp="ex2"] [data-library-mcp-review-open]').click(); await settle(6);
    q("[data-library-mcp-confirm]").click(); await settle(10);
    expect(calls.some((c) => c.method === "POST" && c.body.id === "ex2")).toBe(true);
    expect(w.patch()).not.toHaveProperty("library");
  });

  it("says so — from the server's table, not a list in the page — when the agent's CLI cannot take library MCP, and '+ Add' is held back", async () => {
    const field = async (backend: string, backends: string[] | undefined) => {
      answer(withStatus(STATUS.items, backends ? { backends } : { backends: undefined }));
      const m = { name: "coder", f: { backend, library_mcp: [] }, set: () => () => {} };
      await p.mount(h(LM.LibraryMcpCard, { m, title: "MCP servers" })); await settle(6);
    };
    await field("grok", ["claude-code", "codex"]);
    expect(q("[data-library-mcp-unsupported]").textContent).toContain("grok");
    expect(q("[data-library-mcp-unsupported]").textContent).toContain("does not support Library MCP servers yet");
    expect(q("[data-library-add-open]").disabled).toBe(true);
    await p.unmount();
    await field("codex", ["claude-code", "codex"]);
    expect(q("[data-library-mcp-unsupported]")).toBeNull(); expect(q("[data-library-add-open]").disabled).toBe(false);
    await p.unmount();
    await field("grok", undefined);                                             // an older server: nothing is claimed
    expect(q("[data-library-mcp-unsupported]")).toBeNull();
  });

  it("a server the Library no longer has stays on the card so it can be removed; an empty or unreadable library says so and writes nothing", async () => {
    answer(withStatus([]));
    let w = await work({ working_directory: "/w", library: { mcp: ["ghost"] } });
    expect(w.rows()).toEqual(["ghost"]);
    expect(w.text()).toContain("Not in the Library any more");
    await w.remove("ghost");
    expect(w.patch().library).toBeNull();
    w = await work({ working_directory: "/w" });
    await w.openPicker();
    expect(q("[data-library-picker-empty]").textContent).toContain("no usable MCP server yet");
    await p.unmount();
    answer({ "/ui/library/mcp-status": { status: 403, body: { error: "admin_required" } } });
    w = await work({ working_directory: "/w" });
    expect(w.text()).toContain("Could not read the Library");
    expect(w.patch()).not.toHaveProperty("library");
  });

  it("a Windows native agent has no such card", async () => {
    answer(withStatus());
    const w = await work({ working_directory: "/w", runtime: "windows" });
    expect(w.rows()).toEqual([]);
    expect(q("[data-library-mcp-field]")).toBeNull();
    expect((globalThis as any).fetch).not.toHaveBeenCalledWith(expect.stringContaining("/ui/library/mcp-status"), expect.anything());
  });

  it("the details block the picker and the reconfirmation share shows an http server whole", async () => {
    await p.mount(h(LM.McpDetails, { item: http("ex") })); await settle(4);
    expect(q("[data-library-mcp-url]").textContent).toBe("https://mcp.example.com/v1");
    expect(q("[data-library-mcp-domain]").textContent).toBe("mcp.example.com");
  });

  it("is in both languages and the tags' link goes to it (#library-mcp)", () => {
    const src = readFileSync("src/ui/library-mcp-field.js", "utf8");
    expect(src).toContain('card: "MCP servers"'); expect(src).not.toContain("團隊"); expect(src).not.toContain("Team MCP");
    expect(src).toContain('location.hash !== "#library-mcp"');
    expect(readFileSync("src/ui/panel-library.js", "utf8")).toContain("#library-mcp");
  });
});

describe("what the agent gets by itself is one line, opened on request (AGEND-261)", () => {
  const OV = buildOverview({ instances: { coder: { backend: "claude-code" }, general: { backend: "claude-code", general_topic: true } } });
  const ITEMS_ = [{ kind: "skill", id: "review", description: "Reviews code", status: "ok" }];
  const maps = (ov: unknown = { status: 200, body: OV }) => ({
    "/ui/library/overview": ov as any, "/ui/library/list": { status: 200, body: { items: ITEMS_ } }, "/ui/library/mcp-status": { status: 200, body: STATUS },
  });

  it("Skills: the built-in skills of the agent's role are ONE summary line ('n built in · automatic'); opening it lists them read only, with no checkbox or ×", async () => {
    answer(maps());
    await work({ working_directory: "/w" });
    const builtinNames = OV.builtinSkills.filter((b: any) => b.agents.includes("coder")).map((b: any) => b.name);
    expect(builtinNames.length).toBeGreaterThan(0);
    const box = q("[data-library-skills] [data-library-builtin-summary]");
    expect(box.textContent).toContain(`${builtinNames.length} built in · automatic`);
    expect(qa("[data-library-skills] [data-library-builtin-skill]").length).toBe(0);          // closed: no list
    q("[data-library-skills] [data-library-builtin-toggle]").click(); await settle(4);
    const rows = qa("[data-library-skills] [data-library-builtin-skill]");
    expect(rows.map((e) => e.getAttribute("data-library-builtin-skill"))).toEqual(builtinNames);
    for (const r of rows) { expect(r.querySelector("input")).toBeNull(); expect(r.querySelector("[data-library-remove]")).toBeNull(); }
    expect(q("[data-library-skills] [data-library-builtin-toggle]").getAttribute("aria-expanded")).toBe("true");
    q("[data-library-skills] [data-library-builtin-toggle]").click(); await settle(4);
    expect(qa("[data-library-skills] [data-library-builtin-skill]").length).toBe(0);
    // a worker does not get what only the General gets
    expect(OV.builtinSkills.filter((b: any) => b.agents.includes("general")).length).toBeGreaterThan(builtinNames.length);
  });

  it("the built-in lines are display only: nothing is written, and a built-in skill is never in the picker", async () => {
    answer(maps());
    const w = await work({ working_directory: "/w" });
    expect(w.patch()).not.toHaveProperty("library");
    q("[data-library-skills] [data-library-add-open]").click(); await settle(6);
    const names = qa("[data-library-pick-item]").map((e) => e.getAttribute("data-library-pick-item"));
    expect(names).toEqual(["review"]);
  });

  it("MCP servers: AgEnD's own `agend` is one summary line that opens to a read-only list; the Library's enabled servers are rows below", async () => {
    answer(maps());
    const w = await work({ working_directory: "/w", library: { mcp: ["gh"] } });
    expect(q("[data-library-mcp-field] [data-library-builtin-summary]").textContent).toContain("1 built in · automatic");
    q("[data-library-mcp-field] [data-library-builtin-toggle]").click(); await settle(4);
    const row = q("[data-library-mcp-field] [data-library-builtin-mcp]");
    expect(row.getAttribute("data-library-builtin-mcp")).toBe("agend");
    expect(row.querySelector("input")).toBeNull();
    expect(w.rows()).toEqual(["gh"]);
    expect(q('[data-library-mcp="gh"]').textContent).toContain("Library");
    expect(w.patch()).not.toHaveProperty("library");
  });

  it("an overview that cannot be read leaves the Library's rows exactly as before (no built-in line, nothing broken)", async () => {
    answer(maps({ status: 500, body: { error: "library_failed" } }));
    const w = await work({ working_directory: "/w", library: { mcp: ["gh"] } });
    expect(qa("[data-library-builtin-summary]").length).toBe(0);
    expect(w.rows()).toEqual(["gh"]);
  });

  it("the cards, tags and groups say Library / Skills / MCP servers — no 'Team' anywhere the person reads", async () => {
    for (const f of ["src/ui/library-mount-field.js", "src/ui/library-mcp-field.js", "src/ui/library-card.js", "src/ui/panel-library.js", "src/ui/library-skill.js"]) {
      const src = readFileSync(f, "utf8");
      const copy = [...src.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!).filter((x) => /\s/.test(x));
      for (const c of copy) { expect(c, `${f}: ${c.slice(0, 60)}`).not.toMatch(/\bTeam (skills?|MCP)\b|團隊 ?(Skill|MCP)|Added by your team|團隊新增/); }
    }
    answer(maps()); await open("skills");
    expect(q('[data-library-group="team-skills"] h4').textContent).toBe("Library");
    expect(q('[data-library-item="skill:review"] .lib-kind').textContent).toBe("Library");
    await p.unmount();
    expect(I.t("library.counts", 4, 2)).toBe("4 built in · 2 library");
  });
});

describe("the patch", () => {
  it("`library.mcp` is written beside `skills`, each list keeps the other, and null only when nothing is left", () => {
    expect(libraryValue({ library: { skills: ["a"] } }, ["a"], ["m"])).toEqual({ skills: ["a"], mcp: ["m"] });
    expect(libraryValue({ library: { skills: ["a"], mcp: ["m"] } }, ["b"])).toEqual({ skills: ["b"], mcp: ["m"] });           // a skills-only caller keeps the mcp list
    expect(libraryValue({ library: { skills: ["a"], mcp: ["m"] } }, ["a"], [])).toEqual({ skills: ["a"] });
    expect(libraryValue({ library: { mcp: ["m"] } }, [], [])).toBeNull();
    expect(libraryMcpOf({ library: { mcp: ["a", 3, "b"] } })).toEqual(["a", "b"]);
    expect(libraryMcpOf({ library: "x" })).toEqual([]);
  });

  it("the form writes `library` only when the mcp list changed; the server merges it as a whole value", () => {
    const inst = { working_directory: "/w", library: { skills: ["a"], mcp: ["m"] } };
    const form = agentForm(inst, {}, "coder");
    expect(form.library_mcp).toEqual(["m"]);
    expect(agentPatch(form, inst, {}, null, null)).not.toHaveProperty("library");
    expect(agentPatch({ ...form, library_mcp: ["m", "n"] }, inst, {}, null, null).library).toEqual({ skills: ["a"], mcp: ["m", "n"] });
    expect(agentPatch({ ...form, library_mcp: [] }, inst, {}, null, null).library).toEqual({ skills: ["a"] });
  });

  it("the Library's + writes the same value the card does, the same way a skill's + does", () => {
    const schema = buildSettingsImpactSchema();
    for (const inst of [{ working_directory: "/w" }, { working_directory: "/w", library: { skills: ["a"] } }, { working_directory: "/w", library: { skills: ["a"], mcp: ["m"] } }]) {
      const form = agentForm(inst, {}, "coder");
      const viaSettings = agentPatch({ ...form, library_mcp: [...(inst as any).library?.mcp ?? [], "n"] }, inst, {}, null, null);
      expect(libraryMcpMountPatch(inst, "n")).toEqual(viaSettings);
      const request = agentPatchRequest("coder", inst, libraryMcpMountPatch(inst, "n"));
      expect(schema.impacts["instance.library"]).toBe("instance");
      expect(request.url).toBe("/api/settings/fleet/instances/coder");
    }
    expect(libraryMcpMountPatch({ library: { mcp: ["n"] } }, "n")).toEqual({});
    // a skill's + keeps the mcp list
    expect(libraryMountPatch({ library: { skills: ["a"], mcp: ["m"] } }, "b")).toEqual({ library: { skills: ["a", "b"], mcp: ["m"] } });
  });
});

// ── the Library page ───────────────────────────────────────────────────────────────────────────────────
const INSTANCES = { coder: { backend: "claude-code", library: { mcp: ["gh"] } }, helper: { backend: "codex" }, oldcli: { backend: "grok", library: { mcp: ["gh"] } }, winbox: { backend: "claude-code", runtime: "windows" } };
const OVERVIEW = buildOverview({ instances: INSTANCES });
const ITEMS = [{ kind: "skill", id: "review", description: "Reviews", status: "ok", files: 1, size: 100 }, { kind: "mcp", id: "gh", description: "GitHub", status: "ok", size: 300, sha256: SHA }, { kind: "mcp", id: "free", description: "Not used", status: "ok", size: 300, sha256: SHA2 }];
const open = async (section: string) => {
  (globalThis as any).history.replaceState(null, "", `/ui/library/${section}`);
  await p.mount(h(L.LibraryPanel, { route: { panel: "library", section }, navKey: `library:${section}|1|en` })); await settle();
};

describe("the Library page's MCP rows", () => {
  const base = { "/ui/library/list": { status: 200, body: { items: ITEMS } }, "/ui/library/overview": { status: 200, body: OVERVIEW } };

  it("a row shows who uses the server, with a tag that opens that agent's Team MCP card, a warning on an agent whose CLI cannot take it, and a +", async () => {
    answer(base); await open("mcp");
    const tags = qa('[data-library-item="mcp:gh"] [data-library-tag]');
    expect(tags.map((t) => t.getAttribute("data-library-tag"))).toEqual(["coder", "oldcli"]);
    expect(tags[0].getAttribute("href")).toBe("/ui/fleet/agent/coder?cat=work#library-mcp");
    expect(tags[0].classList.contains("warn")).toBe(false);
    expect(tags[1].classList.contains("warn")).toBe(true);                              // grok: not supported yet
    expect(tags[1].getAttribute("title")).toContain("does not support Library MCP servers yet");
    expect(q('[data-library-item="mcp:free"]').textContent).toContain("No agent");
    expect(qa('[data-library-item="mcp:free"] [data-library-add-agent]').length).toBe(1);
    // the page no longer says they cannot be given
    expect(q(".p-library").textContent).not.toContain("not given to agents yet");
  });

  it("the + lists the agents that can take it (not a Windows one, not a CLI without support), shows what it runs, and confirms before writing", async () => {
    const calls: Calls = [];
    const raw = { instances: { coder: { working_directory: "/w", library: { mcp: ["gh"] } }, helper: { working_directory: "/h", backend: "codex" } } };
    answer({ ...base,
      "/ui/library/mcp-status": { status: 200, body: { ...STATUS, items: [stdio("free", { sha256: SHA2 })] } },
      "/ui/library/mcp-confirm": { status: 200, body: { ok: true } },
      "/api/settings/fleet/raw": { status: 200, body: raw }, "/api/settings/schema": { status: 200, body: buildSettingsImpactSchema() } }, calls);
    await open("mcp");
    q('[data-library-item="mcp:free"] [data-library-add-agent]').click(); await settle(10);
    expect(qa("[data-library-pick]").map((e) => e.getAttribute("data-library-pick"))).toEqual(["coder", "helper", "oldcli"]);
    expect(q('[data-library-pick="oldcli"] input').disabled).toBe(true);
    expect(q('[data-library-pick="coder"] input').disabled).toBeFalsy();
    expect(q("[data-library-mcp-command]").textContent).toContain("npx -y");
    expect(q("[data-library-add-dialog]").textContent).toContain("confirming records this exact version");
    expect(q("[data-library-add-confirm]").disabled).toBe(true);
    for (const n of ["helper"]) { const b = q(`[data-library-pick="${n}"] input`); b.checked = true; fire(b, "change"); await settle(); }
    q("[data-library-add-confirm]").click(); await settle(14);
    // first the confirmation of exactly the version shown, then the settings write — and nothing was written before the click
    const writes = calls.filter((c) => c.method !== "GET");
    expect(writes[0]).toEqual({ url: "/ui/library/mcp-confirm", method: "POST", body: { agent: "helper", id: "free", sha256: SHA2 } });
    const patch = writes.find((c) => c.method === "PATCH")!;
    expect(patch.url).toBe("/api/settings/fleet/instances/helper");
    expect(patch.body).toEqual({ library: { mcp: ["free"] } });
    expect(calls.slice(0, calls.findIndex((c) => c.method === "POST")).every((c) => c.method === "GET")).toBe(true);
  });

  it("a confirmation the server refuses stops everything: no settings are written", async () => {
    const calls: Calls = [];
    answer({ ...base, "/ui/library/mcp-status": { status: 200, body: { ...STATUS, items: [stdio("free", { sha256: SHA2 })] } },
      "/ui/library/mcp-confirm": { status: 409, body: { error: "changed" } },
      "/api/settings/fleet/raw": { status: 200, body: { instances: { helper: { working_directory: "/h", backend: "codex" } } } } }, calls);
    await open("mcp");
    q('[data-library-item="mcp:free"] [data-library-add-agent]').click(); await settle(10);
    const b = q('[data-library-pick="helper"] input'); b.checked = true; fire(b, "change"); await settle();
    q("[data-library-add-confirm]").click(); await settle(12);
    expect(q("[data-library-error]").textContent).toContain("changed after you opened");
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("deleting a server that is in use names the agents that lose it", () => {
    expect(I.t("library.deleteBodyUsedMcp", "coder, oldcli")).toContain("MCP server");
    expect(I.t("library.deleteBodyUsedMcp", "coder, oldcli")).toContain("coder, oldcli");
  });
});

describe("words", () => {
  it("every word exists in English and zh-TW, with the same placeholders (the field's and the page's new ones)", () => {
    const table = (block: string) => new Map([...block.matchAll(/(?:^|[\s,{])([a-zA-Z_0-9]+): "((?:[^"\\]|\\.)*)"/g)].map((m) => [m[1]!, m[2]!] as const));
    const holes = (s: string) => [...s.matchAll(/\{\d\}/g)].map((m) => m[0]).sort().join("");
    const src = readFileSync("src/ui/library-mcp-field.js", "utf8");
    const e = table(src.slice(src.indexOf("  en: {"), src.indexOf('  "zh-TW": {'))), z = table(src.slice(src.indexOf('  "zh-TW": {'), src.indexOf("const lw =")));
    expect(e.size).toBeGreaterThanOrEqual(20);
    expect([...z.keys()].sort()).toEqual([...e.keys()].sort());
    for (const [k, v] of e) { expect(v.length, k).toBeGreaterThan(0); expect(z.get(k)!.length, k).toBeGreaterThan(0); expect(holes(z.get(k)!), k).toBe(holes(v)); }
    // the page's new keys, in both languages
    const panel = readFileSync("src/ui/panel-library.js", "utf8");
    const pe = table(panel.slice(panel.indexOf("  en: {"), panel.indexOf('  "zh-TW": {'))), pz = table(panel.slice(panel.indexOf('  "zh-TW": {'), panel.indexOf("const tn =")));
    expect([...pz.keys()].sort()).toEqual([...pe.keys()].sort());
    for (const k of ["tagOpenMcp", "tagNoMcp", "addToBodyMcp", "addToNoMcp", "addToMcpLoading", "addToMcpFailed", "addToConfirmMcp", "addToChanged", "addToConfirmFailed", "deleteBodyUsedMcp", "e_expect_required"]) {
      expect(pe.has(k), k).toBe(true); expect(holes(pz.get(k)!), k).toBe(holes(pe.get(k)!));
    }
    // the shared card parts (the picker, the built-in line, the × )
    const card = readFileSync("src/ui/library-card.js", "utf8");
    const ce = table(card.slice(card.indexOf("  en: {"), card.indexOf('  "zh-TW": {'))), cz = table(card.slice(card.indexOf('  "zh-TW": {'), card.indexOf("const lc =")));
    expect(ce.size).toBeGreaterThanOrEqual(12);
    expect([...cz.keys()].sort()).toEqual([...ce.keys()].sort());
    for (const [k, v] of ce) { expect(cz.get(k)!.length, k).toBeGreaterThan(0); expect(holes(cz.get(k)!), k).toBe(holes(v)); }
    // and the skills card's own
    const ms = readFileSync("src/ui/library-mount-field.js", "utf8");
    const me = table(ms.slice(ms.indexOf("  en: {"), ms.indexOf('  "zh-TW": {'))), mz = table(ms.slice(ms.indexOf('  "zh-TW": {'), ms.indexOf("const lw =")));
    expect([...mz.keys()].sort()).toEqual([...me.keys()].sort());
    for (const [k, v] of me) expect(holes(mz.get(k)!), k).toBe(holes(v));
    expect(I.t("libraryMcp.card")).toBe("MCP servers");
  });
});
