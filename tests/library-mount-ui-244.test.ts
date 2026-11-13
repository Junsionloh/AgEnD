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

const DETAIL = (id: string) => ({ ok: true, detail: { kind: "skill", id, description: `${id} desc`, sha256: "a".repeat(64), fields: [{ key: "name", value: id }, { key: "description", value: `${id} desc` }], body: `# ${id}\n\nSteps`, files: [{ path: "SKILL.md", size: 40, content: `---\nname: ${id}\n---\n` }] } });
/** Every URL answered by its own rule: the list, the overview and one skill's detail. */
const answer = (status: number, body: unknown, over: Record<string, { status: number; body: unknown }> = {}) => vi.stubGlobal("fetch", vi.fn(async (url: string) => {
  const key = url.split("?")[0]!;
  const a = over[key] ?? (key === "/ui/library/item" ? { status: 200, body: DETAIL(new URL(url, "http://x").searchParams.get("id")!) } : key === "/ui/library/overview" ? { status: 404, body: {} } : { status, body });
  return { ok: a.status < 400, status: a.status, json: async () => a.body };
}));
const ctxFor = (inst: Record<string, unknown>) => ({
  fleet: { defaults: {}, instances: { coder: inst } }, schema: buildSettingsImpactSchema(), stageAgent: vi.fn(), drafts: new Map(),
  channelType: () => "telegram", shortName: (n: string) => n, staged: new Map(), reload: vi.fn(),
});
const q = (sel: string) => p.document.querySelector(sel) as any;
const qa = (sel: string) => p.document.querySelectorAll(sel) as any[];
async function work(inst: Record<string, unknown>) {
  const out: { m?: any } = {};
  const ctx = ctxFor(inst);
  function Page() { const m = D.useAgentForm({ name: "coder", inst, ctx }); out.m = m; return h(D.AgentFields, { m, cat: "work" }); }
  await p.unmount(); await p.mount(h(Page, null)); await settle(8);
  /** The skills that are enabled (the card's rows). */
  const rows = () => qa("[data-library-skills] [data-library-skill]").map((e) => e.getAttribute("data-library-skill"));
  /** The trash asks first (the app's own confirmation); `yes` answers it. */
  const remove = async (id: string, yes = true) => {
    (globalThis as any).confirm = undefined; (p as any).window.confirm = undefined;     // the harness answers a question by itself only while this is a function
    q(`[data-library-skills] [data-library-remove="${id}"]`).click(); await settle(4);
    const C = await import("/assets/ui-confirm.js" as string);
    const asked = C.confirmStore.get().queue[0];
    if (asked) C.answerConfirm(asked.id, yes);
    await settle(4);
    return asked;
  };
  /** The switch of an assigned row: on = given, off = paused (assigned, not given). */
  const flip = async (id: string, on: boolean) => { const el = q(`[data-library-skills] [data-library-switch="${id}"] input`); el.checked = on; fire(el, "change"); await settle(4); };
  const openPicker = async () => { q("[data-library-skills] [data-library-add-open]").click(); await settle(6); };
  const pickable = () => qa("[data-library-pick-item]").map((e) => e.getAttribute("data-library-pick-item"));
  /** Open one item in the picker, read it, enable it. */
  const enable = async (id: string) => { q(`[data-library-pick-item="${id}"]`).click(); await settle(8); q("[data-library-picker-enable]").click(); await settle(6); };
  return { rows, remove, flip, openPicker, pickable, enable, patch: () => out.m.pending(), text: () => (q("[data-library-skills]")?.textContent ?? "") as string };
}

describe("the card", () => {
  it("lists only what is assigned; the picker offers the Library's skills that are not (no MCP, no built-in), one that cannot be given only as unavailable", async () => {
    answer(200, { items: ITEMS });
    const w = await work({ working_directory: "/w", library: { skills: ["review"] } });
    expect(w.rows()).toEqual(["review"]);                                       // triage, edited and fresh are not on the card
    expect(w.text()).toContain("Reviews code"); expect(q("[data-library-assigned]").textContent).toContain("Assigned to this agent");
    await w.openPicker();
    expect(w.pickable()).toEqual(["triage", "edited", "fresh"]);
    expect(q('[data-library-pick-item="edited"]').disabled).toBe(true); expect(q('[data-library-pick-item="fresh"]').disabled).toBe(true);
    expect(q('[data-library-pick-item="triage"]').disabled).toBeFalsy();
    expect((globalThis as any).fetch.mock.calls[0][0]).toBe("/ui/library/list");
  });

  it("is titled 'Skills' (tip and restart badge by the title); '+ Add' sits in the 'Assigned to this agent' section's header, with the line that says what a switch does; no second 'Skills' heading", async () => {
    answer(200, { items: ITEMS });
    await work({ working_directory: "/w" });
    const card = q("[data-library-skills]");
    expect(card.querySelector("h3").textContent).toContain("Skills");
    expect(card.querySelector("h3 .impact")).not.toBeNull();                      // "Restart this Agent", next to the title
    const sec = card.querySelector("[data-library-assigned]");
    expect(sec.querySelector(".lib-sec-title").textContent).toBe("Assigned to this agent");
    expect(sec.querySelector(".lib-sec-hint").textContent).toContain("Turn a switch off to pause an item without removing it");
    expect(sec.querySelector(".lib-sec-head [data-library-add-open]")).not.toBeNull();
    expect(card.querySelector("h3 [data-library-add-open]")).toBeNull();
    expect(card.querySelectorAll(".s-lab").length).toBe(0);                       // the duplicate "Skills ⓘ" sub-heading is gone
  });

  it("an untouched form writes no `library` key (fleet.yaml stays as it is)", async () => {
    answer(200, { items: ITEMS });
    const w = await work({ working_directory: "/w", library: { skills: ["review"] } });
    expect(w.rows()).toEqual(["review"]);
    expect(w.patch()).not.toHaveProperty("library");
    const none = await work({ working_directory: "/w" });
    expect(none.patch()).not.toHaveProperty("library");
  });

  it("an empty card says so; enabling through the picker (read first, then Enable) writes the whole list and the skill leaves the picker; removing the last one removes the key", async () => {
    answer(200, { items: ITEMS });
    const w = await work({ working_directory: "/w" });
    expect(w.rows()).toEqual([]);
    expect(q("[data-library-skills] .lib-empty").textContent).toContain("No Library skills assigned yet");
    await w.openPicker();
    // a click reads it (257's preview: fields, Markdown, files); nothing is written until Enable
    q('[data-library-pick-item="review"]').click(); await settle(8);
    expect(q('[data-library-picker-preview="review"] [data-library-fields]')).not.toBeNull();
    expect(q('[data-library-picker-preview="review"] [data-library-md]')).not.toBeNull();
    expect(w.patch()).not.toHaveProperty("library");
    q("[data-library-picker-enable]").click(); await settle(6);
    expect(w.patch().library).toEqual({ skills: ["review"] });
    // back at the list, the enabled skill gone from it, and a line saying so; a second one can follow
    expect(w.pickable()).toEqual(["triage", "edited", "fresh"]);
    expect(q("[data-library-picker-done-note]").textContent).toContain("“review” is assigned");
    await w.enable("triage");
    expect(w.patch().library).toEqual({ skills: ["review", "triage"] });
    q("[data-library-picker-done]").click(); await settle(4);
    expect(q("[data-library-picker]")).toBeNull();
    expect(w.rows()).toEqual(["review", "triage"]);
    await w.remove("review");
    expect(w.patch().library).toEqual({ skills: ["triage"] });
    await w.remove("triage");
    expect(w.patch()).not.toHaveProperty("library");                           // back to what is saved: no key at all
    const w2 = await work({ working_directory: "/w", library: { skills: ["review"] } });
    await w2.remove("review");
    expect(w2.patch().library).toBeNull();
  });

  it("the picker filters by name and description, and says when nothing matches", async () => {
    answer(200, { items: ITEMS });
    const w = await work({ working_directory: "/w" });
    await w.openPicker();
    const filter = q("[data-library-picker-filter]");
    filter.value = "sorts"; fire(filter, "input"); await settle(4);
    expect(w.pickable()).toEqual(["triage"]);
    filter.value = "zzz"; fire(filter, "input"); await settle(4);
    expect(w.pickable()).toEqual([]); expect(q("[data-library-picker-empty]").textContent).toContain("Nothing matches “zzz”");
  });

  it("the switch PAUSES without removing: the skill moves from `library.skills` to `library.paused.skills` and back; the trash asks first and removes it from both", async () => {
    answer(200, { items: ITEMS });
    const w = await work({ working_directory: "/w", library: { skills: ["review", "triage"] } });
    expect(w.rows()).toEqual(["review", "triage"]);
    await w.flip("review", false);
    expect(w.rows()).toEqual(["review", "triage"]);                             // still on the card, in the same place
    expect(q('[data-library-skill="review"]').getAttribute("data-library-on")).toBe("0");
    expect(q('[data-library-skill="review"]').textContent).toContain("Paused: not given to the agent");
    expect(w.patch().library).toEqual({ skills: ["triage"], paused: { skills: ["review"] } });
    // a paused skill is not in the picker (it is assigned), and turning it back on writes the saved value again: no change at all
    await w.openPicker();
    expect(w.pickable()).not.toContain("review");
    q("[data-library-picker-done]").click(); await settle(4);
    await w.flip("review", true);
    expect(q('[data-library-skill="review"]').getAttribute("data-library-on")).toBe("1");
    expect(w.patch()).toEqual({});
    // removing: the question first (No leaves everything), then Yes drops it from both lists
    await w.flip("triage", false);
    const no = await w.remove("triage", false);
    expect(no.title).toContain("Remove “triage” from this agent?");
    expect(w.rows()).toEqual(["review", "triage"]);
    await w.remove("triage");
    expect(w.rows()).toEqual(["review"]);
    expect(w.patch()).toEqual({ library: { skills: ["review"] } });             // saved was {skills:[review,triage]}: triage is gone from both lists, nothing is paused
  });

  it("an agent that never pauses anything writes no `paused` key — the value is exactly what it was before pausing existed", async () => {
    answer(200, { items: ITEMS });
    const w = await work({ working_directory: "/w" });
    await w.openPicker(); await w.enable("review");
    expect(w.patch().library).toEqual({ skills: ["review"] });
    expect(Object.keys(w.patch().library)).toEqual(["skills"]);
  });

  it("a skill that cannot be read in the picker says so and enables nothing", async () => {
    answer(200, { items: ITEMS }, { "/ui/library/item": { status: 500, body: {} } });
    const w = await work({ working_directory: "/w" });
    await w.openPicker();
    q('[data-library-pick-item="review"]').click(); await settle(8);
    expect(q("[data-library-picker]").textContent).toContain("Could not read it");
    expect(w.patch()).not.toHaveProperty("library");
  });

  it("an enabled skill the Library no longer has stays on the card so it can be removed", async () => {
    answer(200, { items: ITEMS });
    const w = await work({ working_directory: "/w", library: { skills: ["ghost"] } });
    expect(w.rows()).toEqual(["ghost"]);
    expect(w.text()).toContain("Not in the Library any more");
    await w.remove("ghost");
    expect(w.patch().library).toBeNull();
  });

  it("an empty library and an unreadable one say so; neither writes anything", async () => {
    answer(200, { items: [{ kind: "mcp", id: "github", status: "ok" }] });
    let w = await work({ working_directory: "/w" });
    expect(w.rows()).toEqual([]);
    await w.openPicker();
    expect(q("[data-library-picker-empty]").textContent).toContain("no usable skills yet");
    await p.unmount();
    answer(403, { error: "admin_required" });
    w = await work({ working_directory: "/w" });
    expect(w.text()).toContain("Could not read the Library"); expect(w.patch()).not.toHaveProperty("library");
  });

  it("a Windows native agent has no such card", async () => {
    answer(200, { items: ITEMS });
    const w = await work({ working_directory: "/w", runtime: "windows" });
    expect(w.rows()).toEqual([]);
    expect(q("[data-library-skills]")).toBeNull();
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
    expect(I.t("libraryMount.card")).toBe("Skills");
  });
});
