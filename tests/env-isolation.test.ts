import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ENV_ALLOWED_BASE, ENV_ALLOWED_BY_BACKEND, applyEnvIsolation, envPassthroughNames, isEnvAllowed, planEnvIsolation, resolveEnvIsolation,
} from "../src/env-isolation.js";
import { NATIVE_ENV_ALLOWED } from "../src/windows-cli-worker.js";
import { KNOWN_BACKENDS, validateFleetConfig } from "../src/config-validator.js";
import { createBackend } from "../src/backend/factory.js";
import { getEffectiveInstanceDefaults } from "../src/config.js";

const SECRET = "s3cr3t-VALUE-must-never-be-logged";
const ENV = {
  PATH: "/usr/bin", HOME: "/home/u", LANG: "en_US.UTF-8", LC_ALL: "C", HTTPS_PROXY: "http://proxy", AGEND_INSTANCE_NAME: "x",
  TELEGRAM_BOT_TOKEN: SECRET, DISCORD_BOT_TOKEN: SECRET, GROQ_API_KEY: SECRET, GITHUB_TOKEN: SECRET, ANTHROPIC_API_KEY: SECRET,
} as NodeJS.ProcessEnv;

function recordingLogger() {
  const lines: Array<{ level: string; obj: Record<string, unknown>; msg: string }> = [];
  return { lines, info: (obj: Record<string, unknown>, msg: string) => lines.push({ level: "info", obj, msg }), warn: (obj: Record<string, unknown>, msg: string) => lines.push({ level: "warn", obj, msg }) };
}

describe("env_isolation (AGEND-242): off by default, dry-run only reports names", () => {
  it("resolves anything that is not a known mode to off", () => {
    expect(resolveEnvIsolation(undefined).mode).toBe("off");
    expect(resolveEnvIsolation("nonsense").mode).toBe("off");
    expect(resolveEnvIsolation("off").mode).toBe("off");
    expect(resolveEnvIsolation("dry-run").mode).toBe("dry-run");
    // reserved: accepted, but not enforcing yet
    expect(resolveEnvIsolation("allowlist")).toEqual({ mode: "off", requested: "allowlist" });
  });

  it("returns the command byte for byte and logs nothing when off, unset or allowlist", () => {
    const command = `TERM=xterm-256color AGEND_INSTANCE_NAME='a' claude --settings /x 'quoted $arg'`;
    const before = JSON.stringify(ENV);
    for (const env_isolation of [undefined, "off", "allowlist", "garbage", null] as unknown[]) {
      const logger = recordingLogger();
      expect(applyEnvIsolation({ command, env: ENV, config: { env_isolation, backend: "claude-code" }, logger })).toBe(command);
      expect(logger.lines.filter(l => l.level === "info")).toEqual([]);
    }
    expect(JSON.stringify(ENV)).toBe(before);
  });

  it("dry-run: command and environment are unchanged; the log has names only, never a value", () => {
    const command = "claude --x";
    const before = { ...ENV };
    const logger = recordingLogger();
    const out = applyEnvIsolation({ command, env: ENV, config: { env_isolation: "dry-run", backend: "claude-code", env_passthrough: ["GITHUB_TOKEN"] }, logger });
    expect(out).toBe(command);
    expect(ENV).toEqual(before);
    expect(logger.lines).toHaveLength(1);
    const report = logger.lines[0]!.obj as { wouldRemove: string[]; passthroughApplied: string[]; keptCount: number };
    expect(report.wouldRemove).toEqual(["DISCORD_BOT_TOKEN", "GROQ_API_KEY", "TELEGRAM_BOT_TOKEN"]);
    expect(report.passthroughApplied).toEqual(["GITHUB_TOKEN"]);
    // ANTHROPIC_API_KEY is claude-code's own credential: kept.
    expect(report.wouldRemove).not.toContain("ANTHROPIC_API_KEY");
    expect(JSON.stringify(logger.lines)).not.toContain(SECRET);
  });

  it("dry-run for another backend does not keep claude's variables", () => {
    expect(planEnvIsolation(ENV, { backend: "codex" }).wouldRemove).toContain("ANTHROPIC_API_KEY");
  });

  it("allowlist mode warns that it is not available and still changes nothing", () => {
    const logger = recordingLogger();
    expect(applyEnvIsolation({ command: "c", env: ENV, config: { env_isolation: "allowlist" }, logger })).toBe("c");
    expect(logger.lines.map(l => l.level)).toEqual(["warn"]);
  });

  it("never prints a name that is not a plain identifier", () => {
    const report = planEnvIsolation({ "WEIRD NAME=x": "v", "ok_NAME": "v" } as NodeJS.ProcessEnv);
    expect(report.wouldRemove).toEqual(["ok_NAME"]);
    expect(report.unnamedCount).toBe(1);
  });

  it("env_passthrough keeps only valid names", () => {
    expect(envPassthroughNames(["A", "A", "bad name", 3, "B_1"])).toEqual(["A", "B_1"]);
    expect(envPassthroughNames("A")).toEqual([]);
    expect(isEnvAllowed("GITHUB_TOKEN", "codex", ["GITHUB_TOKEN"])).toBe(true);
  });

  it("keeps the network, language and terminal groups of the Windows native allowlist (NATIVE_ENV_ALLOWED)", () => {
    for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "LANG", "LANGUAGE", "TZ", "TERM", "COLORTERM", "NO_COLOR", "FORCE_COLOR"]) {
      expect(NATIVE_ENV_ALLOWED.has(name), `${name} in NATIVE_ENV_ALLOWED`).toBe(true);
      expect(ENV_ALLOWED_BASE.has(name), `${name} in ENV_ALLOWED_BASE`).toBe(true);
    }
  });

  it("only names known backends in the per-backend table", () => {
    expect(Object.keys(ENV_ALLOWED_BY_BACKEND).sort()).toEqual([...KNOWN_BACKENDS].sort());
  });
});

describe("env_isolation config", () => {
  const validate = (defaults: Record<string, unknown>, instance: Record<string, unknown> = {}) =>
    validateFleetConfig({ channel: { type: "telegram", bot_token_env: "T", group_id: -1 }, defaults: { backend: "mock", ...defaults }, instances: { a: { working_directory: "/tmp", ...instance } } });

  it("accepts off and dry-run, rejects an unknown mode, warns on allowlist", () => {
    expect(validate({ env_isolation: "off" }).errors.filter(e => e.path.includes("env_isolation"))).toEqual([]);
    expect(validate({}, { env_isolation: "dry-run", env_passthrough: ["GITHUB_TOKEN"] }).errors.filter(e => e.path.includes("env_"))).toEqual([]);
    expect(validate({ env_isolation: "yes" }).errors.some(e => e.path === "defaults.env_isolation")).toBe(true);
    expect(validate({}, { env_passthrough: ["bad name"] }).errors.some(e => e.path === "instances.a.env_passthrough")).toBe(true);
    const warned = validate({ env_isolation: "allowlist" });
    expect(warned.errors.filter(e => e.path.includes("env_isolation"))).toEqual([]);
    expect(warned.warnings.some(w => w.path === "defaults.env_isolation")).toBe(true);
  });

  it("a fleet default flows into instances; unset adds nothing", () => {
    expect(getEffectiveInstanceDefaults({ env_isolation: "dry-run" }).env_isolation).toBe("dry-run");
    expect("env_isolation" in getEffectiveInstanceDefaults({})).toBe(false);
  });
});

describe("golden: every backend's launch command is identical with env_isolation unset, off or dry-run", () => {
  const dirs: string[] = [];
  afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

  // kiro-cli's buildCommand runs the real CLI to pin its UI/engine, which the test process guard forbids; the helper
  // takes the finished command string and never looks inside it, so the other backends cover the same property.
  for (const backend of Object.keys(ENV_ALLOWED_BY_BACKEND).filter(b => b !== "kiro-cli")) {
    it(backend, () => {
      const dir = mkdtempSync(join(tmpdir(), "env-iso-"));
      dirs.push(dir);
      let command: string;
      try {
        command = createBackend(backend, dir).buildCommand({ workingDirectory: dir, instanceDir: dir, instanceName: "t", mcpServers: {}, skipResume: true });
      } catch {
        // A backend whose CLI is not installed here cannot build a command; nothing to compare.
        return;
      }
      const snapshot = JSON.stringify(process.env);
      for (const env_isolation of [undefined, "off", "dry-run", "allowlist"] as unknown[]) {
        expect(applyEnvIsolation({ command, env: process.env, config: { env_isolation, backend }, logger: recordingLogger() })).toBe(command);
      }
      expect(JSON.stringify(process.env)).toBe(snapshot);
    });
  }
});
