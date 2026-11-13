/**
 * AGEND-260: library MCP servers mounted on an agent (Claude Code only) — src/library/mcp-mount.ts, the Claude Code backend's
 * `mcp-config.json` and launch command, and the daemon's resolution at each start.
 *
 * What these hold: an agent with no mount gets exactly what it got before (golden); a mount adds `agend-lib-<id>` entries and nothing
 * else, and un-mounting returns the file to the golden bytes; a secret VALUE is in no file, no log and no API answer; a variable the
 * daemon does not have keeps the item from being enabled.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { Daemon } from "../src/daemon.js";
import { ClaudeCodeBackend } from "../src/backend/claude-code.js";
import { createBackend } from "../src/backend/factory.js";
import type { CliBackendConfig } from "../src/backend/types.js";
import { applyEnvIsolation } from "../src/env-isolation.js";
import { validateFleetConfig } from "../src/config-validator.js";
import {
  LIBRARY_MCP_PREFIX, LibraryStore, buildLibraryMcpEntry, libraryMcpUsage, mcpVariables, missingVariables, resolveLibraryMcp, supportsLibraryMcp,
} from "../src/library/index.js";
import { validateMcpText } from "../src/library/schema.js";
import type { InstanceConfig } from "../src/types.js";
import type { Logger } from "../src/logger.js";

const dirs: string[] = [];
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
const SECRET = "s3cr3t-value-Q9x7-never-on-disk";
const SECRET2 = "other-secret-Z4k2-never-on-disk";
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); vi.unstubAllEnvs(); });

const stdio = (id: string, extra = "") => `agend_library: 1\nkind: mcp\nname: ${id}\ndescription: Echo server\ntransport: stdio\ncommand: node\nargs:\n  - echo.mjs\n${extra}`;
const http = (id: string) => `agend_library: 1\nkind: mcp\nname: ${id}\ntransport: http\nurl: https://mcp.example.com/mcp\nheaders:\n  X-Api-Key: EXAMPLE_API_KEY\n`;
const add = (store: LibraryStore, id: string, text: string) => expect(store.addMcp(id, text, { overwrite: true })).toMatchObject({ ok: true });

/** What the backend wrote and the command it would run, for one config. */
function launch(config: Partial<CliBackendConfig>) {
  const instanceDir = tmp("agend-mcp-inst-");
  const backend = new ClaudeCodeBackend(instanceDir);
  const full = { workingDirectory: instanceDir, instanceDir, instanceName: "w", mcpServers: { agend: { command: "node", args: ["/x/mcp-server.js"], env: { AGEND_INSTANCE_NAME: "w" } } }, ...config } as CliBackendConfig;
  backend.writeConfig(full);
  return { instanceDir, file: readFileSync(join(instanceDir, "mcp-config.json"), "utf8"), command: backend.buildCommand(full) };
}

describe("resolveLibraryMcp", () => {
  let store: LibraryStore;
  beforeEach(() => { store = new LibraryStore(tmp("agend-mcp-home-")); });

  it("a stdio item becomes an entry whose env maps each variable name to an alias reference, never a value", () => {
    add(store, "echo", stdio("echo", "env:\n  - EXAMPLE_TOKEN\n"));
    const r = resolveLibraryMcp({ mount: ["echo"], store, env: { EXAMPLE_TOKEN: SECRET } });
    expect(r.states).toEqual([{ id: "echo", status: "active", vars: ["EXAMPLE_TOKEN"] }]);
    expect(r.active).toEqual([{
      id: "echo", serverName: "agend-lib-echo",
      entry: { command: "node", args: ["echo.mjs"], env: { EXAMPLE_TOKEN: "${AGEND_LIBMCP_0_EXAMPLE_TOKEN}" } },
      secrets: [{ alias: "AGEND_LIBMCP_0_EXAMPLE_TOKEN", name: "EXAMPLE_TOKEN" }],
    }]);
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it("an http item maps each header to a variable reference", () => {
    add(store, "remote", http("remote"));
    const r = resolveLibraryMcp({ mount: ["remote"], store, env: { EXAMPLE_API_KEY: SECRET } });
    expect(r.active[0]!.entry).toEqual({ type: "http", url: "https://mcp.example.com/mcp", headers: { "X-Api-Key": "${AGEND_LIBMCP_0_EXAMPLE_API_KEY}" } });
  });

  it("a variable the daemon does not have (or has empty): the item is NOT enabled and the state names what is missing", () => {
    add(store, "echo", stdio("echo", "env:\n  - EXAMPLE_TOKEN\n  - SECOND\n"));
    add(store, "plain", stdio("plain"));
    const r = resolveLibraryMcp({ mount: ["echo", "plain"], store, env: { EXAMPLE_TOKEN: "", SECOND: SECRET } });
    expect(r.active.map((a) => a.id)).toEqual(["plain"]);
    expect(r.states).toContainEqual({ id: "echo", status: "missing_vars", vars: ["EXAMPLE_TOKEN", "SECOND"], missing: ["EXAMPLE_TOKEN"] });
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it("an item gone from the library, hand-edited, hand-placed or invalid is not enabled, each with its reason", () => {
    add(store, "edited", stdio("edited"));
    writeFileSync(join(store.root, "mcp", "edited.yaml"), stdio("edited", "# changed outside the Library\n"));
    writeFileSync(join(store.root, "mcp", "placed.yaml"), stdio("placed"));
    writeFileSync(join(store.root, "mcp", "broken.yaml"), "agend_library: 1\nkind: mcp\nname: broken\ntransport: stdio\n");
    const r = resolveLibraryMcp({ mount: ["edited", "placed", "broken", "gone"], store, env: {} });
    expect(r.active).toEqual([]);
    expect(Object.fromEntries(r.states.map((s) => [s.id, s.status]))).toEqual({ broken: "invalid", edited: "modified", gone: "not_found", placed: "untracked" });
  });

  it("is in id order whatever the mount order, and each active server has its own alias number", () => {
    add(store, "b-one", stdio("b-one", "env:\n  - TOKEN\n"));
    add(store, "a-one", stdio("a-one", "env:\n  - TOKEN\n"));
    const r = resolveLibraryMcp({ mount: ["b-one", "a-one", "a-one"], store, env: { TOKEN: SECRET } });
    expect(r.active.map((a) => [a.id, a.secrets[0]!.alias])).toEqual([["a-one", "AGEND_LIBMCP_0_TOKEN"], ["b-one", "AGEND_LIBMCP_1_TOKEN"]]);
  });

  it("helpers: the variables an item reads, and which are missing", () => {
    const v = validateMcpText("x", http("x")) as Extract<ReturnType<typeof validateMcpText>, { ok: true }>;
    expect(mcpVariables(v.item)).toEqual(["EXAMPLE_API_KEY"]);
    expect(missingVariables(v.item, {})).toEqual(["EXAMPLE_API_KEY"]);
    expect(buildLibraryMcpEntry(v.item, (n) => `A_${n}`)).toMatchObject({ headers: { "X-Api-Key": "${A_EXAMPLE_API_KEY}" } });
  });

  it("which backends take a mounted MCP server: Claude Code only, and not a native Windows agent", () => {
    expect(supportsLibraryMcp("claude-code")).toBe(true);
    expect(supportsLibraryMcp(undefined)).toBe(true);
    expect(supportsLibraryMcp("claude-code", "windows")).toBe(false);
    for (const b of ["codex", "opencode", "kiro-cli", "antigravity", "grok", "muse"]) expect(supportsLibraryMcp(b)).toBe(false);
  });

  it("usage: which agents mount which server (the setting only; a Windows agent is left out)", () => {
    expect(libraryMcpUsage({ b: { library: { mcp: ["echo"] } }, a: { library: { mcp: ["echo", "x"] } }, w: { runtime: "windows", library: { mcp: ["echo"] } }, n: {} }))
      .toEqual({ echo: ["a", "b"], x: ["a"] });
  });
});

describe("Claude Code's mcp-config.json", () => {
  /** Fresh each time: the temp folders are removed after every test. */
  const baseline = () => launch({});
  const resolved = () => {
    const store = new LibraryStore(tmp("agend-mcp-home-"));
    add(store, "echo", stdio("echo", "env:\n  - EXAMPLE_TOKEN\n"));
    vi.stubEnv("EXAMPLE_TOKEN", SECRET);
    return resolveLibraryMcp({ mount: ["echo"], store, env: process.env }).active;
  };

  it("GOLDEN: with no mount the file and the command are exactly what they were (an empty list too)", () => {
    const base = baseline();
    // The expression the file has always been written with, spelled out: any change to it fails here.
    expect(base.file).toBe(JSON.stringify({ mcpServers: { agend: { command: "node", args: ["/x/mcp-server.js"], env: { AGEND_INSTANCE_NAME: "w" } } } }, null, 2));
    expect(launch({ libraryMcp: [] }).file).toBe(base.file);
    expect(launch({ libraryMcp: [] }).command.replace(/\/[^ ]*agend-mcp-inst-[^/ ]*/g, "<dir>")).toBe(base.command.replace(/\/[^ ]*agend-mcp-inst-[^/ ]*/g, "<dir>"));
    expect(base.command).not.toContain("AGEND_LIBMCP_");
  });

  it("a mount adds `agend-lib-<id>` after the existing entries and changes nothing else", () => {
    const base = baseline();
    const on = launch({ libraryMcp: resolved() });
    const parsed = JSON.parse(on.file);
    expect(Object.keys(parsed.mcpServers)).toEqual(["agend", `${LIBRARY_MCP_PREFIX}echo`]);
    expect(parsed.mcpServers.agend).toEqual(JSON.parse(base.file).mcpServers.agend);
    expect(parsed.mcpServers["agend-lib-echo"]).toEqual({ command: "node", args: ["echo.mjs"], env: { EXAMPLE_TOKEN: "${AGEND_LIBMCP_0_EXAMPLE_TOKEN}" } });
    // everything the launch writes besides the mcp file is the same
    expect(readdirSync(on.instanceDir).sort()).toEqual(readdirSync(base.instanceDir).sort());
  });

  it("un-mounting returns the file to the golden bytes — and a user's own MCP entry is never part of what this writes", () => {
    const base = baseline();
    const instanceDir = tmp("agend-mcp-inst-");
    const backend = new ClaudeCodeBackend(instanceDir);
    const config = (libraryMcp?: CliBackendConfig["libraryMcp"]) => ({ workingDirectory: instanceDir, instanceDir, instanceName: "w", mcpServers: { agend: { command: "node", args: ["/x/mcp-server.js"], env: { AGEND_INSTANCE_NAME: "w" } } }, ...(libraryMcp ? { libraryMcp } : {}) }) as CliBackendConfig;
    const read = () => readFileSync(join(instanceDir, "mcp-config.json"), "utf8");
    backend.writeConfig(config(resolved()));
    expect(read()).toContain("agend-lib-echo");
    backend.writeConfig(config());
    expect(read()).toBe(base.file);
  });

  it("the secret VALUE is in no file the launch writes; the command hands the CLI only the alias (not the real variable name)", () => {
    const on = launch({ libraryMcp: resolved() });
    for (const name of readdirSync(on.instanceDir)) expect(readFileSync(join(on.instanceDir, name), "utf8"), name).not.toContain(SECRET);
    expect(on.file).toContain("${AGEND_LIBMCP_0_EXAMPLE_TOKEN}");
    expect(on.command).toContain(`AGEND_LIBMCP_0_EXAMPLE_TOKEN='${SECRET}'`);
    expect(on.command).not.toMatch(/(^|\s)EXAMPLE_TOKEN=/);
  });
});

describe("the daemon's resolution at each start", () => {
  const cfg = (extra: Partial<InstanceConfig> = {}, backend?: string): InstanceConfig => ({
    working_directory: "/tmp/test", restart_policy: { max_retries: 10, backoff: "exponential", reset_after: 300 },
    context_guardian: { max_age_hours: 4, grace_period_ms: 600_000 }, log_level: "info", ...(backend ? { backend } : {}), ...extra,
  } as InstanceConfig);
  /** A daemon whose instance dir sits in `<home>/instances/w`, as in a fleet, so its library is `<home>/library`. */
  function rig(extra: Partial<InstanceConfig>, backend = "claude-code") {
    const home = tmp("agend-mcp-fleet-");
    const instanceDir = join(home, "instances", "w");
    mkdirSync(instanceDir, { recursive: true });
    const lines: unknown[] = [];
    const logger = pino({ level: "debug" }, { write: (l: string) => { lines.push(l); } }) as Logger;
    const daemon = new Daemon("w", cfg(extra, backend), instanceDir, false, createBackend(backend, instanceDir), undefined, logger);
    const store = new LibraryStore(home);
    return { store, lines, build: () => (daemon as any).buildBackendConfig() as CliBackendConfig };
  }

  it("no mount: the config has no `libraryMcp` key at all", () => {
    const r = rig({});
    expect("libraryMcp" in r.build()).toBe(false);
    const empty = rig({ library: { skills: ["x"] } });
    expect("libraryMcp" in empty.build()).toBe(false);
  });

  it("a mount whose variables are all set is given (names and aliases only in the config); the value is read at launch, not carried in it", () => {
    const r = rig({ library: { mcp: ["echo"] } });
    add(r.store, "echo", stdio("echo", "env:\n  - EXAMPLE_TOKEN\n"));
    vi.stubEnv("EXAMPLE_TOKEN", SECRET);
    const config = r.build();
    expect(config.libraryMcp?.map((m) => m.serverName)).toEqual(["agend-lib-echo"]);
    expect(JSON.stringify(config)).not.toContain(SECRET);
    expect(r.lines.join("")).not.toContain(SECRET);
  });

  it("a missing variable: not enabled, said in the log by NAME only", () => {
    const r = rig({ library: { mcp: ["echo", "plain"] } });
    add(r.store, "echo", stdio("echo", "env:\n  - EXAMPLE_TOKEN\n"));
    add(r.store, "plain", stdio("plain"));
    vi.stubEnv("EXAMPLE_TOKEN", "");
    const config = r.build();
    expect(config.libraryMcp?.map((m) => m.id)).toEqual(["plain"]);
    const log = r.lines.join("");
    expect(log).toContain("missing_vars");
    expect(log).toContain("EXAMPLE_TOKEN");
  });

  it("every mounted item unusable: the config is the one an agent with no mount has", () => {
    const r = rig({ library: { mcp: ["gone"] } });
    expect("libraryMcp" in r.build()).toBe(false);
  });

  it("another backend: ignored, with a note; nothing is added", () => {
    const r = rig({ library: { mcp: ["echo"] } }, "codex");
    add(r.store, "echo", stdio("echo"));
    expect("libraryMcp" in r.build()).toBe(false);
    expect(r.lines.join("")).toContain("does not take mounted MCP servers yet");
  });

  it("works with env_isolation (AGEND-242): the dry run leaves the launch command alone, and its report holds names, never values", () => {
    const r = rig({ library: { mcp: ["echo"] }, env_isolation: "dry-run" } as Partial<InstanceConfig>);
    add(r.store, "echo", stdio("echo", "env:\n  - EXAMPLE_TOKEN\n"));
    vi.stubEnv("EXAMPLE_TOKEN", SECRET);
    const config = r.build();
    const command = launch({ libraryMcp: config.libraryMcp }).command;
    const seen: string[] = [];
    const logger = { info: (o: unknown, m: string) => seen.push(JSON.stringify(o) + m), warn: (o: unknown, m: string) => seen.push(JSON.stringify(o) + m) };
    expect(applyEnvIsolation({ command, env: process.env, config: { env_isolation: "dry-run", backend: "claude-code" }, logger })).toBe(command);
    expect(seen.join("")).not.toContain(SECRET);
    // the aliased variable reaches the CLI through the launch command, so an enforcing allowlist could not take it away
    expect(command).toContain("AGEND_LIBMCP_0_EXAMPLE_TOKEN=");
  });
});

describe("fleet.yaml: library.mcp", () => {
  const validate = (instance: Record<string, unknown>) => validateFleetConfig({
    channel: { type: "telegram", mode: "topic", bot_token_env: "T", group_id: -1 }, defaults: {}, instances: { a: { working_directory: "/tmp/a", ...instance } },
  } as never);
  it("takes a list of ids on claude-code without a warning; a second backend warns that it is ignored", () => {
    const mcpWarnings = (r: ReturnType<typeof validate>) => r.warnings.filter((w) => w.path.endsWith("library.mcp")).map((w) => w.path);
    expect(validate({ library: { mcp: ["echo"] } }).errors).toEqual([]);
    expect(mcpWarnings(validate({ library: { mcp: ["echo"] } }))).toEqual([]);
    expect(mcpWarnings(validate({ backend: "grok", library: { mcp: ["echo"] } }))).toEqual(["instances.a.library.mcp"]);
  });
});

describe("a second agent's secrets never reach another agent", () => {
  it("each launch carries only its own mounted server's variables", () => {
    const store = new LibraryStore(tmp("agend-mcp-home-"));
    add(store, "one", stdio("one", "env:\n  - TOKEN_ONE\n"));
    add(store, "two", stdio("two", "env:\n  - TOKEN_TWO\n"));
    const env = { TOKEN_ONE: SECRET, TOKEN_TWO: SECRET2 } as NodeJS.ProcessEnv;
    vi.stubEnv("TOKEN_ONE", SECRET); vi.stubEnv("TOKEN_TWO", SECRET2);
    const a = launch({ libraryMcp: resolveLibraryMcp({ mount: ["one"], store, env }).active });
    expect(a.command).toContain(SECRET);
    expect(a.command).not.toContain(SECRET2);
    expect(a.file).not.toContain("TOKEN_TWO");
  });
});
