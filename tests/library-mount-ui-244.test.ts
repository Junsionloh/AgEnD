/**
 * AGEND-244: the "Team skills" field in an agent's settings (Workspace) — ticks library skills, writes `library` only when it changed,
 * keeps what else `library` holds, lists no built-in skill and no MCP server; and the settings rules around the new key.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { buildSettingsImpactSchema } from "../src/instance-config-impact.js";
import { normalizeSettingsInstancePatch } from "../src/settings-instance-patch.js";
// @ts-expect-error — a JS module of the app, with no types
import { agentForm, agentPatch, libraryValue, librarySkillsOf } from "../src/ui/settings-model.js";

let p: AppPage, D: any, I: any;
const ITEMS = [
  { kind: "skill", id: "review", description: "Reviews code", status: "ok" },
  { kind: "skill", id: "triage", description: "Sorts issues", status: "ok" },
  { kind: "skill", id: "edited", description: "", status: "modified" },
  { kind: "skill", id: "fresh", description: "", status: "untracked" },
  { kind: "mcp", id: "github", description: "GitHub", status: "ok" },
];
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19281/ui/fleet/agent/coder" });
  I = await import("/assets/app-i18n.js" as string);
  D = await import("/ui/js/settings-dialogs.js");
});
afterAll(() => p.restore());
afterEach(async () => { await p.unmount(); vi.unstubAllGlobals(); });

const answer = (status: number, body: unknown) => vi.stubGlobal("fetch", vi.fn(async () => ({ ok: status < 400, status, json: async () => body })));
const ctxFor = (inst: Record<string, unknown>) => ({
  fleet: { defaults: {}, instances: { coder: inst } }, schema: buildSettingsImpactSchema(), stageAgent: vi.fn(), drafts: new Map(),
  channelType: () => "telegram", shortName: (n: string) => n, staged: new Map(), reload: vi.fn(),
});
async function work(inst: Record<string, unknown>) {
  const out: { m?: any } = {};
  const ctx = ctxFor(inst);
  function Page() { const m = D.useAgentForm({ name: "coder", inst, ctx }); out.m = m; return h(D.AgentFields, { m, cat: "work" }); }
  await p.unmount(); await p.mount(h(Page, null)); await settle(8);
  const rows = () => p.root.querySelectorAll("[data-library-skill]").map((e: any) => e.getAttribute("data-library-skill"));
  const box = (id: string) => p.root.querySelector(`[data-library-skill="${id}"] input`) as any;
  const tick = async (id: string, on: boolean) => { const el = box(id); el.checked = on; fire(el, "change"); await settle(4); };
  return { rows, box, tick, patch: () => out.m.pending(), text: () => p.root.textContent as string };
}

describe("the field", () => {
  it("lists the library's skills only (no MCP, no built-in), and offers a skill that is not in its saved state only as unavailable", async () => {
    answer(200, { items: ITEMS });
    const w = await work({ working_directory: "/w" });
    expect(w.rows()).toEqual(["review", "triage", "edited", "fresh"]);
    expect(w.box("review").disabled).toBeFalsy();
    expect(w.box("edited").disabled).toBe(true); expect(w.box("fresh").disabled).toBe(true);
    expect(w.text()).toContain("Reviews code");
    expect(w.text()).toContain("Skills"); expect(w.text()).toContain("Library");
    expect((globalThis as any).fetch.mock.calls[0][0]).toBe("/ui/library/list");
  });

  it("an untouched form writes no `library` key (fleet.yaml stays as it is)", async () => {
    answer(200, { items: ITEMS });
    const w = await work({ working_directory: "/w", library: { skills: ["review"] } });
    expect(w.box("review").checked).toBe(true);
    expect(w.patch()).not.toHaveProperty("library");
    const none = await work({ working_directory: "/w" });
    expect(none.patch()).not.toHaveProperty("library");
  });

  it("ticking writes the whole list; unticking the last one removes the key", async () => {
    answer(200, { items: ITEMS });
    const w = await work({ working_directory: "/w" });
    await w.tick("review", true); await w.tick("triage", true);
    expect(w.patch().library).toEqual({ skills: ["review", "triage"] });
    await w.tick("review", false);
    expect(w.patch().library).toEqual({ skills: ["triage"] });
    const w2 = await work({ working_directory: "/w", library: { skills: ["review"] } });
    await w2.tick("review", false);
    expect(w2.patch().library).toBeNull();
  });

  it("a mounted skill the Library no longer has stays in the list so it can be removed", async () => {
    answer(200, { items: ITEMS });
    const w = await work({ working_directory: "/w", library: { skills: ["ghost"] } });
    expect(w.rows()).toContain("ghost");
    expect(w.text()).toContain("Not in the Library any more");
    expect(w.box("ghost").disabled).toBeFalsy();
    await w.tick("ghost", false);
    expect(w.patch().library).toBeNull();
  });

  it("an empty library and an unreadable one say so; neither writes anything", async () => {
    answer(200, { items: [{ kind: "mcp", id: "github", status: "ok" }] });
    let w = await work({ working_directory: "/w" });
    expect(w.rows()).toEqual([]); expect(w.text()).toContain("no usable skills yet");
    answer(403, { error: "admin_required" });
    w = await work({ working_directory: "/w" });
    expect(w.text()).toContain("Could not read the Library"); expect(w.patch()).not.toHaveProperty("library");
  });

  it("a Windows native agent has no such field", async () => {
    answer(200, { items: ITEMS });
    const w = await work({ working_directory: "/w", runtime: "windows" });
    expect(w.rows()).toEqual([]);
    expect((globalThis as any).fetch).not.toHaveBeenCalledWith("/ui/library/list", expect.anything());
  });
});

describe("the patch and the settings rules", () => {
  it("keeps what else `library` holds; null only when nothing is left", () => {
    expect(libraryValue({ library: { skills: ["a"], mcp: ["m"] } }, [])).toEqual({ mcp: ["m"] });
    expect(libraryValue({ library: { skills: ["a"], mcp: ["m"] } }, ["b"])).toEqual({ skills: ["b"], mcp: ["m"] });
    expect(libraryValue({}, [])).toBeNull();
    expect(librarySkillsOf({ library: { skills: ["a", 3, "b"] } })).toEqual(["a", "b"]);
    expect(librarySkillsOf({ library: "x" })).toEqual([]);
  });

  it("the patch names `library` only when it changed, and the server merges it as a whole value (null removes the key)", () => {
    const inst = { working_directory: "/w", library: { skills: ["a"] } };
    const form = agentForm(inst, {}, "coder");
    expect(agentPatch(form, inst, {}, null, null)).not.toHaveProperty("library");
    const patch = agentPatch({ ...form, library_skills: ["a", "b"] }, inst, {}, null, null);
    expect(patch.library).toEqual({ skills: ["a", "b"] });
    expect(normalizeSettingsInstancePatch(inst, patch).library).toEqual({ skills: ["a", "b"] });
    const cleared = agentPatch({ ...form, library_skills: [] }, inst, {}, null, null);
    expect(cleared).toHaveProperty("library", null);
    expect(normalizeSettingsInstancePatch(inst, cleared)).not.toHaveProperty("library");
  });

  it("changing it costs an agent restart (the skills are published at start), and it is a category of the Workspace page", () => {
    expect(buildSettingsImpactSchema().impacts["instance.library"]).toBe("instance");
    expect(readFileSync("src/ui/agent-details-settings.js", "utf8")).toMatch(/work: \[[^\]]*"library"/);
  });
});

describe("words", () => {
  it("every word exists in English and zh-TW, with the same placeholders", () => {
    const src = readFileSync("src/ui/library-mount-field.js", "utf8");
    const en = src.slice(src.indexOf("  en: {"), src.indexOf('  "zh-TW": {')), zh = src.slice(src.indexOf('  "zh-TW": {'), src.indexOf("const lw ="));
    const table = (block: string) => new Map([...block.matchAll(/(?:^|[\s,{])([a-zA-Z_0-9]+): "((?:[^"\\]|\\.)*)"/g)].map((m) => [m[1]!, m[2]!] as const));
    const e = table(en), z = table(zh);
    expect(e.size).toBeGreaterThanOrEqual(8);
    expect([...z.keys()].sort()).toEqual([...e.keys()].sort());
    for (const [k, v] of e) { expect(v.length, k).toBeGreaterThan(0); expect(z.get(k)!.length, k).toBeGreaterThan(0); }
    expect(I.t("libraryMount.label")).toBe("Skills");
  });
});
