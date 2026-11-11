// `instances.<name>.instructions` — an agent's own Markdown, added beside `systemPrompt`.
import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { handleSettingsRequest, type SettingsApiContext } from "../src/settings-api.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildFleetInstructions, buildNativeFleetInstructions, type FleetInstructionsParams } from "../src/instructions.js";
import { AGENT_INSTRUCTIONS_MAX_CHARS, agentInstructionsText } from "../src/agent-instructions.js";
import { validateFleetConfig } from "../src/config-validator.js";
import { settingsChangeDiff, SETTINGS_DIFF_UNITS } from "../src/settings-change.js";
import { normalizeSettingsInstancePatch, removesInstanceOverride } from "../src/settings-instance-patch.js";
import { instanceFieldImpact } from "../src/instance-config-impact.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { Daemon } from "../src/daemon.js";
import { createBackend } from "../src/backend/factory.js";
import { KiroBackend } from "../src/backend/kiro.js";
import { TEST_KIRO_COMPAT } from "./helpers/kiro-compat.js";
import type { InstanceConfig } from "../src/types.js";
import type { Logger } from "../src/logger.js";
import { matrixCases } from "./helpers/instructions-matrix.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
// Recorded from the instructions code before this field existed (`release/2.3.5-alpha` at 861ca2ac4): see helpers/instructions-matrix-record.ts.
const GOLDEN: Record<string, string> = JSON.parse(readFileSync(new URL("./fixtures/instructions-matrix.json", import.meta.url), "utf8"));
const NOT_FILLED: Array<[string, unknown]> = [["undefined", undefined], ["empty", ""], ["spaces", "   "], ["newlines and tabs", "\n\t \r\n"], ["not a string", 42]];
const FILLED = "# Role\n\nYou review pull requests.\n\n- Be kind\n- Be exact\n";

describe("what an agent is told", () => {
  const cases = matrixCases();
  it("covers the whole parameter grid, for the fleet and the Windows native builders", () => {
    expect(cases.length).toBe(576);
    expect(Object.keys(GOLDEN).length).toBe(cases.length * 3);
  });

  it.each(NOT_FILLED)("word for word what it was before when instructions is %s (every combination, fleet and Windows native)", (_label, value) => {
    let checked = 0;
    for (const { key, params } of cases) {
      const withField = { ...params, agentInstructions: value as string | undefined };
      expect(sha(buildFleetInstructions(withField)), `fleet|${key}`).toBe(GOLDEN[`fleet|${key}`]);
      expect(sha(buildNativeFleetInstructions(withField, false)), `native|${key}`).toBe(GOLDEN[`native|${key}`]);
      expect(sha(buildNativeFleetInstructions(withField, true)), `native-general|${key}`).toBe(GOLDEN[`native-general|${key}`]);
      checked += 3;
    }
    expect(checked).toBe(cases.length * 3);
  });

  it("when filled, the old text is exactly the beginning of the new one, and the section is the last", () => {
    for (const { key, params } of cases) {
      const filled = { ...params, agentInstructions: FILLED };
      for (const [name, build] of [["fleet", buildFleetInstructions], ["native", (p: FleetInstructionsParams) => buildNativeFleetInstructions(p, false)], ["native-general", (p: FleetInstructionsParams) => buildNativeFleetInstructions(p, true)]] as const) {
        const before = build(params), after = build(filled);
        expect(sha(before), `${name}|${key}`).toBe(GOLDEN[`${name}|${key}`]);
        expect(after.startsWith(before), `${name}|${key}`).toBe(true);
        expect(after.slice(before.length)).toBe(`\n\n## Agent Instructions\n\n${FILLED.replace(/\s+$/, "")}`);
      }
    }
  });

  it("comes after systemPrompt and is the last section", () => {
    const text = buildFleetInstructions({ instanceName: "a", workingDirectory: "/w", customPrompt: "PERSONA", agentInstructions: "OWN" });
    expect(text.indexOf("PERSONA")).toBeGreaterThan(-1);
    expect(text.indexOf("PERSONA")).toBeLessThan(text.indexOf("## Agent Instructions"));
    expect(text.endsWith("## Agent Instructions\n\nOWN")).toBe(true);
    expect(text.match(/^## Agent Instructions$/gm)?.length).toBe(1);
  });

  it("keeps the text as written inside, trims only trailing whitespace", () => {
    expect(agentInstructionsText("  indented\n\n    code\n\n")).toBe("  indented\n\n    code");
    expect(agentInstructionsText(" \n ")).toBeUndefined();
  });
});

describe("the field in the configuration", () => {
  const fleet = (instructions: unknown) => ({ instances: { a: { working_directory: "/w", instructions } } });
  const problems = (instructions: unknown) => validateFleetConfig(fleet(instructions)).errors.filter(e => e.path.endsWith("instructions"));

  it("accepts text up to the limit and refuses longer text or a non-text value", () => {
    expect(problems(undefined)).toEqual([]);
    expect(problems("")).toEqual([]);
    expect(problems("x".repeat(AGENT_INSTRUCTIONS_MAX_CHARS))).toEqual([]);
    expect(problems("x".repeat(AGENT_INSTRUCTIONS_MAX_CHARS + 1))).toHaveLength(1);
    expect(problems(["a"])).toHaveLength(1);
    expect(problems(7)).toHaveLength(1);
  });

  it("is a restart-class setting, as systemPrompt is", () => {
    expect(instanceFieldImpact("instructions")).toBe(instanceFieldImpact("systemPrompt"));
    expect(instanceFieldImpact("instructions")).not.toBe("now");
  });

  it("null removes it from fleet.yaml (the page clears the field that way); nothing else of the instance changes", () => {
    expect(removesInstanceOverride("instructions", null)).toBe(true);
    expect(removesInstanceOverride("systemPrompt", null)).toBe(false);
    const base = { working_directory: "/w", systemPrompt: "keep me", instructions: "old" };
    expect(normalizeSettingsInstancePatch(base, { instructions: null })).toEqual({ working_directory: "/w", systemPrompt: "keep me" });
    expect(normalizeSettingsInstancePatch(base, { instructions: "new" })).toEqual({ working_directory: "/w", systemPrompt: "keep me", instructions: "new" });
  });
});

describe("the web confirmation of a long instructions text", () => {
  const effect = (instructions: string | undefined) => ({ fleet: { instances: { dev: { working_directory: "/w", ...(instructions === undefined ? {} : { instructions }) } } } });
  const long = "A".repeat(20_000) + "\n" + "Z".repeat(4_000);

  it("shows length, fingerprint and the first words — it does not exceed the card (confirmation_diff_too_large) at 24,000 characters", () => {
    expect(long.length).toBeGreaterThan(SETTINGS_DIFF_UNITS);
    const diff = settingsChangeDiff(effect(undefined), effect(long), { operation: "PATCH /api/settings/fleet/instances/dev" });
    expect(diff).not.toBeNull();
    const line = diff!.summary.find(l => l.includes("instructions"))!;
    expect(line).toContain("24001");
    expect(line).toMatch(/[0-9a-f]{12}/);
    expect(line).toContain("AAAA");
    expect(line.length).toBeLessThan(400);
    expect(diff!.summary.join("\n").length).toBeLessThan(SETTINGS_DIFF_UNITS);
  });

  it("a one-character change is a different fingerprint and a different change", () => {
    const a = settingsChangeDiff(effect(long), effect(long + "!"), { operation: "PATCH x" })!;
    const b = settingsChangeDiff(effect(long), effect(long + "?"), { operation: "PATCH x" })!;
    expect(a.summary.join()).not.toBe(b.summary.join());
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it("removing it is shown too, and the same text is no change", () => {
    const removed = settingsChangeDiff(effect("hello"), effect(undefined), { operation: "PATCH x" })!;
    expect(removed.summary.join("\n")).toMatch(/instructions.*5.*→/);
    expect(settingsChangeDiff(effect(long), effect(long), { operation: "PATCH x" })).toBeNull();
  });

  it("the authority classifier (it judges the same change from `instances.<name>`, not from `fleet`) lists it just as shortly", async () => {
    const { settingsEffectAuthority } = await import("../src/settings-authority.js");
    const inst = (instructions?: string) => ({ working_directory: "/w", ...(instructions === undefined ? {} : { instructions }) });
    const cfg = (instructions?: string) => ({ defaults: {}, instances: { dev: inst(instructions) } }) as never;
    expect(() => settingsEffectAuthority(cfg(), cfg(long), {}, {})).not.toThrow();
    expect(() => settingsEffectAuthority(cfg(long), cfg(long + "!"), {}, {})).not.toThrow();
    const diff = settingsChangeDiff({ instances: { dev: inst() } }, { instances: { dev: inst(long) } }, { operation: "authority" })!;
    expect(diff.summary.join("\n").length).toBeLessThan(400);
  });

  it("does not change how systemPrompt is confirmed", () => {
    const sp = (v: string) => ({ fleet: { instances: { dev: { working_directory: "/w", systemPrompt: v } } } });
    const diff = settingsChangeDiff(sp("old"), sp("new prompt"), { operation: "PATCH x" })!;
    expect(diff.summary.join("\n")).toContain("old");
    expect(diff.summary.join("\n")).toContain("new prompt");
  });
});

describe("saving it through the Settings API", () => {
  function patch(body: unknown): Promise<{ status: number; body: Record<string, unknown>; saved: ReturnType<typeof vi.fn> }> {
    const saved = vi.fn();
    const ctx = { fleetConfig: { defaults: {}, instances: { worker: { working_directory: "/tmp/worker", systemPrompt: "persona", instructions: "old" } } }, configPath: "/tmp/fleet.yaml", dataDir: "/tmp",
      logger: { warn: vi.fn(), info: vi.fn() }, getRawFleetConfig: () => ({}), saveFleetConfig: saved, lifecycle: { isPaused: vi.fn(() => false) } } as unknown as SettingsApiContext;
    return new Promise((resolve, reject) => {
      const req = new EventEmitter() as EventEmitter & { method: string; destroy(): void };
      req.method = "PATCH"; req.destroy = () => undefined;
      let status = 0;
      const res = { writeHead(code: number) { status = code; }, end(payload: string) { resolve({ status, body: JSON.parse(payload), saved }); } };
      try {
        handleSettingsRequest(req as never, res as never, new URL("http://localhost/api/settings/fleet/instances/worker"), ctx);
        queueMicrotask(() => { req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end"); });
      } catch (err) { reject(err); }
    });
  }

  it("writes the text under its own key and leaves systemPrompt alone", async () => {
    const r = await patch({ instructions: FILLED });
    expect(r.status).toBe(200);
    expect(r.saved).toHaveBeenCalledWith([{ path: ["instances", "worker", "instructions"], value: FILLED, remove: false }]);
  });

  it("removes the key when the page sends null", async () => {
    const r = await patch({ instructions: null });
    expect(r.status).toBe(200);
    expect(r.saved).toHaveBeenCalledWith([{ path: ["instances", "worker", "instructions"], value: null, remove: true }]);
  });

  it("refuses a text over the limit and writes nothing", async () => {
    const r = await patch({ instructions: "x".repeat(AGENT_INSTRUCTIONS_MAX_CHARS + 1) });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.saved).not.toHaveBeenCalled();
  });
});

describe("every runtime hands the AI the same text", () => {
  const BACKENDS = ["claude-code", "codex", "opencode", "kiro-cli", "antigravity", "grok", "muse"] as const;
  const cfg = (extra: Partial<InstanceConfig> = {}, backend?: string): InstanceConfig => ({
    working_directory: "/tmp/test", restart_policy: { max_retries: 10, backoff: "exponential", reset_after: 300 },
    context_guardian: { max_age_hours: 4, grace_period_ms: 600_000 }, log_level: "info", ...(backend ? { backend } : {}), ...extra,
  } as InstanceConfig);
  const spawnText = (backend: string, extra: Partial<InstanceConfig>, mode?: "cli") => {
    const dir = mkdtempSync(join(tmpdir(), "agend-instr-162-"));
    try {
      const daemon = new Daemon("w", cfg({ ...extra, ...(mode ? { agent_mode: mode } : {}) }, backend), dir, false, backend === "kiro-cli" ? new KiroBackend(dir, TEST_KIRO_COMPAT) : createBackend(backend, dir), undefined, pino({ level: "silent" }) as Logger);
      return (daemon as any).buildBackendConfig().instructions as string;
    } finally { rmSync(dir, { recursive: true, force: true }); }
  };

  it.each(BACKENDS.flatMap(b => [[b, undefined], [b, "cli" as const]] as const))("%s (%s mode): the filled text is the last section and the unfilled one is untouched", (backend, mode) => {
    const plain = spawnText(backend, { systemPrompt: "PERSONA" }, mode);
    for (const empty of [undefined, "", "   "]) expect(spawnText(backend, { systemPrompt: "PERSONA", instructions: empty }, mode)).toBe(plain);
    const filled = spawnText(backend, { systemPrompt: "PERSONA", instructions: FILLED }, mode);
    expect(filled.startsWith(plain)).toBe(true);
    expect(filled.slice(plain.length)).toBe(`\n\n## Agent Instructions\n\n${FILLED.replace(/\s+$/, "")}`);
    expect(plain.indexOf("PERSONA")).toBeGreaterThan(-1);
  });

  it("the Windows native pane builder hands it over as well, after systemPrompt", () => {
    const text = buildNativeFleetInstructions({ instanceName: "n", workingDirectory: "C:/w", customPrompt: "PERSONA", agentInstructions: "OWN" }, false);
    expect(text.endsWith("PERSONA\n\n## Agent Instructions\n\nOWN")).toBe(true);
  });
});
