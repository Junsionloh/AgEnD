/**
 * the Instructions field on an agent's Basic info — the Edit / Preview switch, the counter (characters and bytes,
 * the 24,000 limit, the Codex AGENTS.md note), and the patch: its own key, beside systemPrompt, written only when changed.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { buildSettingsImpactSchema } from "../src/instance-config-impact.js";
// @ts-expect-error — a JS module of the app, with no types
import { agentForm, agentPatch } from "../src/ui/settings-model.js";
// @ts-expect-error — a JS module of the app, with no types
import { instructionsSize, INSTRUCTIONS_MAX_CHARS, CODEX_NOTE_BYTES } from "../src/ui/agent-instructions-field.js";

let p: AppPage, D: any, G: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19281/ui/fleet/agent/coder" });
  (globalThis as any).fetch = async () => ({ ok: false, status: 404, json: async () => null });
  D = await import("/ui/js/settings-dialogs.js");
  G = await import("/ui/js/agent-details-settings.js");
});
afterAll(() => p.restore());
afterEach(async () => { await p.unmount(); });

async function form(inst: Record<string, unknown>) {
  const out: { m?: any } = {};
  const ctx = { fleet: { defaults: {}, instances: { coder: inst } }, schema: buildSettingsImpactSchema(), stageAgent: vi.fn(), drafts: new Map(),
    channelType: () => "telegram", shortName: (n: string) => n, staged: new Map(), reload: vi.fn() };
  function Basic() {
    const m = D.useAgentForm({ name: "coder", inst, ctx });
    out.m = m;
    return h("section", { "data-cat": "basic" }, h(D.AgentFields, { m, cat: "basic" }));
  }
  await p.unmount();
  await p.mount(h(Basic, null));
  await settle(6);
  const $ = (sel: string) => p.root.querySelector(sel) as any;
  const edit = async (sel: string, value: string) => { const el = $(sel); el.value = value; fire(el, "input"); fire(el, "change"); await settle(3); };
  const click = async (sel: string) => { fire($(sel), "click"); await settle(3); };
  return { $, edit, click, patch: () => out.m.pending(), ready: () => out.m.ready };
}
const inst = { backend: "claude-code", working_directory: "/w" };

describe("the patch: its own key, beside systemPrompt", () => {
  it("an untouched form writes nothing, with or without instructions already saved (fleet.yaml is unchanged)", async () => {
    expect((await form(inst)).patch()).toEqual({});
    expect((await form({ ...inst, instructions: "# Role\nreview" })).patch()).toEqual({});
    expect((await form({ ...inst, instructions: "   " })).patch()).toEqual({});
  });
  it("typing writes exactly {instructions}; clearing it (or blanks only) writes null so the key leaves fleet.yaml; systemPrompt is never touched", async () => {
    const f = await form({ ...inst, systemPrompt: "persona" });
    await f.edit("#ag-instr", "# Role\n\nBe exact.");
    expect(f.patch()).toEqual({ instructions: "# Role\n\nBe exact." });
    const g = await form({ ...inst, systemPrompt: "persona", instructions: "old text" });
    await g.edit("#ag-instr", "");
    expect(g.patch()).toEqual({ instructions: null });
    await g.edit("#ag-instr", " \n ");
    expect(g.patch()).toEqual({ instructions: null });
    await g.edit("#ag-instr", "old text");
    expect(g.patch()).toEqual({});
  });
  it("agentPatch given a form without the key (an older caller) writes none", () => {
    const f = agentForm(inst, {}, "coder"); delete f.instructions;
    expect(agentPatch(f, inst, {}, null, null)).toEqual({});
  });
  it("is Basic info's: the nav dot of that category", () => {
    expect([...G.dirtyCategories("fleet", { instructions: "x" })]).toEqual(["basic"]);
    expect([...G.dirtyCategories("native", { instructions: "x" })]).toEqual([]);   // a Windows native agent has no such field (it keeps its own system prompt)
  });
});

describe("the field", () => {
  it("sits in Basic info with an ⓘ, a counter in characters and bytes, and the Codex note", async () => {
    const f = await form(inst);
    expect(f.$('[data-cat="basic"] #ag-instr')).not.toBeNull();
    expect(f.$('[data-cat="basic"] .instructions-field')).not.toBeNull();
    expect(p.root.querySelectorAll(".s-tipbtn").length).toBe(4);   // name, tags, description, instructions
    expect(f.$("[data-instructions-size]").textContent).toContain("0 / 24,000 characters");
    expect(f.$("[data-instructions-codex]").textContent).toContain("32 KiB");
    await f.edit("#ag-instr", "héllo 你好");
    expect(f.$("[data-instructions-size]").textContent).toContain("8 / 24,000 characters");
    expect(f.$("[data-instructions-size]").textContent).toContain("13 bytes");
  });
  it("counts characters as the server does (UTF-16 length) and bytes as UTF-8", () => {
    expect(instructionsSize("abc")).toEqual({ chars: 3, bytes: 3 });
    expect(instructionsSize("你好")).toEqual({ chars: 2, bytes: 6 });
  });
  it("over 24,000 characters: an error under the field and Save waits; at 24,000 it is fine", async () => {
    const f = await form(inst);
    await f.edit("#ag-instr", "x".repeat(INSTRUCTIONS_MAX_CHARS));
    expect(f.ready()).toBe(true);
    await f.edit("#ag-instr", "x".repeat(INSTRUCTIONS_MAX_CHARS + 1));
    expect(f.ready()).toBe(false);
    expect(f.$("[data-instructions-size]").textContent).toContain("24,001 characters");
    expect(f.$("[data-instructions-size]").getAttribute("role")).toBe("alert");
  });
  it("past about 16 KiB the Codex note warns that the end may be cut", async () => {
    const f = await form(inst);
    await f.edit("#ag-instr", "x".repeat(CODEX_NOTE_BYTES + 1));
    expect(f.$("[data-instructions-codex]").textContent).toContain("may cut off");
    expect(f.$("[data-instructions-codex]").className).toContain("warning");
  });
  it("Preview shows the text through the chat's Markdown renderer (HTML in it stays text); Edit brings the draft back", async () => {
    const f = await form(inst);
    await f.edit("#ag-instr", "# Title\n\n- one\n- two\n\n<script>alert(1)</script>");
    await f.click('[data-instructions-mode="preview"]');
    expect(f.$("#ag-instr")).toBeNull();
    const html = f.$("[data-instructions-preview]").innerHTML as string;
    expect(html).toMatch(/<h1|<strong|Title/);
    expect(html).toContain("<li>");
    expect(html).not.toContain("<script>");
    await f.click('[data-instructions-mode="edit"]');
    expect(f.$("#ag-instr").value).toBe("# Title\n\n- one\n- two\n\n<script>alert(1)</script>");
    // Switching only previews: nothing was staged by it.
    expect(f.patch()).toEqual({ instructions: "# Title\n\n- one\n- two\n\n<script>alert(1)</script>" });
  });
  it("Preview of nothing says so", async () => {
    const f = await form(inst);
    await f.click('[data-instructions-mode="preview"]');
    expect(f.$('[data-cat="basic"]').textContent).toContain("Nothing to preview");
  });
});
