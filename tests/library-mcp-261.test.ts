/**
 * AGEND-261: library MCP servers mounted on an agent (Claude Code, Codex): what is written, what is left out and why, and that a value
 * never appears anywhere but the backend's own config file.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeCodeBackend } from "../src/backend/claude-code.js";
import { CodexBackend } from "../src/backend/codex.js";
import { Daemon } from "../src/daemon.js";
import { FleetManager } from "../src/fleet-manager.js";
import { validateFleetConfig } from "../src/config-validator.js";
import {
  LIBRARY_MCP_BACKENDS, LibraryStore, isReservedMcpEnvName, McpConfirmations, envNamesSet, libraryMcpName, libraryMcpUsage, libraryMountProblem, mcpSummary, readEnvValues,
  resolveMcpMount, stringifyMcp, supportsLibraryMcp, validateMcpText, type LibraryMcpEntry,
} from "../src/library/index.js";
import { claudeMcpEntry, codexMcpBlock, codexMcpToml, tomlBasic } from "../src/library/mcp-render.js";
import { buildOverview } from "../src/library/overview.js";

const dirs: string[] = [];
const tmp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const STDIO = (name: string, extra = "command: npx\nargs:\n  - -y\n  - some-server\nenv:\n  - MCP_GH_TOKEN\n  - MCP_GH_HOST\n"): string =>
  `agend_library: 1\nkind: mcp\nname: ${name}\ndescription: A server\ntransport: stdio\n${extra}`;
const HTTP = (name: string): string =>
  `agend_library: 1\nkind: mcp\nname: ${name}\ntransport: http\nurl: https://mcp.example.com/v1\nheaders:\n  Authorization: MCP_EX_AUTH\n`;
const SECRET = "s3cr3t-VALUE-9f8e7d";

function rig() {
  const home = tmp("agend-mcp261-");
  const store = new LibraryStore(home);
  const confirmations = new McpConfirmations(store);
  const sha = (id: string): string => { const g = store.mcpForMount(id); if (!g.ok) throw new Error(`not mountable: ${id}`); return g.sha256; };
  return { home, store, confirmations, sha, env: join(home, ".env") };
}

describe("resolveMcpMount: what is written and what is left out", () => {
  it("writes a confirmed item whose variables all have a value; names, not values, are what the result says", () => {
    const r = rig();
    expect(r.store.addMcp("gh", STDIO("gh"))).toMatchObject({ ok: true });
    r.confirmations.confirm("a", "gh", r.sha("gh"));
    const out = resolveMcpMount({ ids: ["gh"], store: r.store, confirmed: r.confirmations.forAgent("a"), values: new Map([["MCP_GH_TOKEN", SECRET], ["MCP_GH_HOST", "h.example"]]) });
    expect(out.mounted).toEqual(["gh"]);
    expect(out.skipped).toEqual([]);
    expect(out.entries[libraryMcpName("gh")]).toEqual({ transport: "stdio", command: "npx", args: ["-y", "some-server"], env: { MCP_GH_TOKEN: SECRET, MCP_GH_HOST: "h.example" } });
  });

  it("a missing variable means the server is not started at all, and the skip names the variable (never a value)", () => {
    const r = rig();
    r.store.addMcp("gh", STDIO("gh"));
    r.confirmations.confirm("a", "gh", r.sha("gh"));
    const out = resolveMcpMount({ ids: ["gh"], store: r.store, confirmed: r.confirmations.forAgent("a"), values: new Map([["MCP_GH_HOST", SECRET]]) });
    expect(out.entries).toEqual({});
    expect(out.mounted).toEqual([]);
    expect(out.skipped).toEqual([{ id: "gh", reason: "missing_vars", names: ["MCP_GH_TOKEN"] }]);
    expect(JSON.stringify(out.skipped)).not.toContain(SECRET);
  });

  it("not confirmed for this agent: nothing is written; another agent's confirmation does not count", () => {
    const r = rig();
    r.store.addMcp("gh", STDIO("gh"));
    r.confirmations.confirm("other", "gh", r.sha("gh"));
    const values = new Map([["MCP_GH_TOKEN", "x"], ["MCP_GH_HOST", "y"]]);
    expect(resolveMcpMount({ ids: ["gh"], store: r.store, confirmed: r.confirmations.forAgent("a"), values }).skipped).toEqual([{ id: "gh", reason: "unconfirmed" }]);
  });

  it("an item edited after it was confirmed is not written until it is confirmed again", () => {
    const r = rig();
    r.store.addMcp("gh", STDIO("gh"));
    r.confirmations.confirm("a", "gh", r.sha("gh"));
    const values = new Map([["MCP_GH_TOKEN", "x"], ["MCP_GH_HOST", "y"]]);
    const run = () => resolveMcpMount({ ids: ["gh"], store: r.store, confirmed: r.confirmations.forAgent("a"), values });
    expect(run().mounted).toEqual(["gh"]);
    // the command changes (same item, new content, saved properly in the Library)
    expect(r.store.addMcp("gh", STDIO("gh", "command: evil\nenv:\n  - MCP_GH_TOKEN\n  - MCP_GH_HOST\n"), { overwrite: true })).toMatchObject({ ok: true });
    expect(run()).toMatchObject({ mounted: [], skipped: [{ id: "gh", reason: "unconfirmed" }] });
    r.confirmations.confirm("a", "gh", r.sha("gh"));
    expect(run().entries[libraryMcpName("gh")]).toMatchObject({ command: "evil" });
  });

  it("an item changed by hand outside the Library, a missing one and one that breaks a rule are never written", () => {
    const r = rig();
    r.store.addMcp("gh", STDIO("gh"));
    r.confirmations.confirm("a", "gh", r.sha("gh"));
    const file = join(r.store.root, "mcp", "gh.yaml");
    writeFileSync(file, STDIO("gh", "command: sneaky\n"));
    const run = (ids: string[]) => resolveMcpMount({ ids, store: r.store, confirmed: r.confirmations.forAgent("a"), values: new Map([["MCP_GH_TOKEN", "x"]]) }).skipped;
    expect(run(["gh"])).toEqual([{ id: "gh", reason: "modified" }]);
    writeFileSync(file, "not: [valid");
    expect(run(["gh"])).toEqual([{ id: "gh", reason: "invalid" }]);
    expect(run(["nope"])).toEqual([{ id: "nope", reason: "not_found" }]);
    writeFileSync(join(r.store.root, "mcp", "hand.yaml"), STDIO("hand"));
    expect(run(["hand"])).toEqual([{ id: "hand", reason: "untracked" }]);
  });

  it("an http server: the header value comes from its variable; a value that cannot be a header leaves it out, by name", () => {
    const r = rig();
    r.store.addMcp("ex", HTTP("ex"));
    r.confirmations.confirm("a", "ex", r.sha("ex"));
    const ok = resolveMcpMount({ ids: ["ex"], store: r.store, confirmed: r.confirmations.forAgent("a"), values: new Map([["MCP_EX_AUTH", `Bearer ${SECRET}`]]) });
    expect(ok.entries[libraryMcpName("ex")]).toEqual({ transport: "http", url: "https://mcp.example.com/v1", headers: { Authorization: `Bearer ${SECRET}` } });
    const bad = resolveMcpMount({ ids: ["ex"], store: r.store, confirmed: r.confirmations.forAgent("a"), values: new Map([["MCP_EX_AUTH", `Bearer x\r\nX-Evil: ${SECRET}`]]) });
    expect(bad.entries).toEqual({});
    expect(bad.skipped).toEqual([{ id: "ex", reason: "bad_value", names: ["MCP_EX_AUTH"] }]);
    expect(JSON.stringify(bad.skipped)).not.toContain(SECRET);
  });

  it("ids are taken once each and only if they are library ids", () => {
    const r = rig();
    const out = resolveMcpMount({ ids: ["../x", "a", "a"], store: r.store, confirmed: {}, values: new Map() });
    expect(out.skipped).toEqual([{ id: "a", reason: "not_found" }]);
  });
});

describe("what an administrator is shown", () => {
  it("the full command and arguments, or the address and its domain, the variable names and what the server sees each as", () => {
    const stdio = validateMcpText("gh", STDIO("gh"));
    const http = validateMcpText("ex", HTTP("ex"));
    expect(stdio.ok && mcpSummary(stdio.item)).toEqual({ transport: "stdio", command: "npx", args: ["-y", "some-server"], variables: ["MCP_GH_TOKEN", "MCP_GH_HOST"],
      uses: [{ variable: "MCP_GH_TOKEN", as: "MCP_GH_TOKEN", kind: "env" }, { variable: "MCP_GH_HOST", as: "MCP_GH_HOST", kind: "env" }] });
    expect(http.ok && mcpSummary(http.item)).toEqual({ transport: "http", url: "https://mcp.example.com/v1", host: "mcp.example.com", variables: ["MCP_EX_AUTH"], uses: [{ variable: "MCP_EX_AUTH", as: "Authorization", kind: "header" }] });
    const renamed = validateMcpText("r", STDIO("r", "command: npx\nenv:\n  GITHUB_PERSONAL_ACCESS_TOKEN: ${MCP_GITHUB_TOKEN}\n"));
    expect(renamed.ok && mcpSummary(renamed.item).uses).toEqual([{ variable: "MCP_GITHUB_TOKEN", as: "GITHUB_PERSONAL_ACCESS_TOKEN", kind: "env" }]);
  });

  it("variables that change how a program is found or loaded are refused as the name a server is given, however the item is written", () => {
    // the list form: the name must start with MCP_ first, so these stop at the prefix rule…
    for (const name of ["PATH", "NODE_OPTIONS", "LD_PRELOAD", "HOME"]) {
      expect(validateMcpText("x", STDIO("x", `command: npx\nenv:\n  - ${name}\n`)), name).toMatchObject({ ok: false, error: "mcp_var_prefix", detail: "env" });
    }
    // …and in the renaming form, where the MCP_ source is fine, the NAME the server sees may not be one of them (case-insensitive, whole families by prefix)
    for (const name of ["PATH", "path", "Path", "NODE_OPTIONS", "node_options", "LD_PRELOAD", "Ld_Preload", "LD_LIBRARY_PATH", "LD_AUDIT", "ld_debug", "DYLD_INSERT_LIBRARIES", "dyld_library_path",
      "PYTHONPATH", "pythonstartup", "PYTHONHOME", "NODE_PATH", "PERL5OPT", "RUBYOPT", "JAVA_TOOL_OPTIONS", "GIT_SSH_COMMAND", "IFS", "ifs", "CODEX_HOME", "codex_home", "HOME",
      "HTTP_PROXY", "https_proxy", "ALL_PROXY", "no_proxy", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS", "GIT_ASKPASS", "GIT_EXEC_PATH", "CLASSPATH", "TMPDIR", "PYTHONUSERBASE"]) {
      expect(validateMcpText("x", STDIO("x", `command: npx\nenv:\n  ${name}: \${MCP_OK}\n`)), name).toMatchObject({ ok: false, error: "bad_mcp", detail: "env" });
      expect(isReservedMcpEnvName(name), name).toBe(true);
    }
    for (const name of ["LDAP_PASSWORD", "OLD_PATH_TOKEN", "DYLDX", "PATHS", "GITHUB_PERSONAL_ACCESS_TOKEN"]) {
      expect(isReservedMcpEnvName(name), name).toBe(false);
      expect(validateMcpText("x", STDIO("x", `command: npx\nenv:\n  ${name}: \${MCP_OK}\n`)), name).toMatchObject({ ok: true });
    }
    expect(validateMcpText("x", `agend_library: 1\nkind: mcp\nname: x\ntransport: http\nurl: https://a.example/\nheaders:\n  X-A: ld_preload\n`)).toMatchObject({ ok: false, error: "mcp_var_prefix", detail: "headers" });
  });
});

/** AGEND-261, the user's rule A: a variable an MCP item takes from `.env` must start with MCP_ (upper case, exactly). */
describe("the MCP_ rule", () => {
  const names = (text: string) => { const v = validateMcpText("x", text); return v.ok ? null : { error: v.error, detail: v.detail, names: v.names }; };

  it("is checked when an item is SAVED: a list entry, a renaming source and a header variable that do not start with MCP_ are refused, with the field and the names", () => {
    expect(names(STDIO("x", "command: npx\nenv:\n  - GITHUB_TOKEN\n  - MCP_OK\n"))).toEqual({ error: "mcp_var_prefix", detail: "env", names: ["GITHUB_TOKEN"] });
    expect(names(STDIO("x", "command: npx\nenv:\n  SERVER_NAME: ${TELEGRAM_BOT_TOKEN}\n"))).toEqual({ error: "mcp_var_prefix", detail: "env", names: ["TELEGRAM_BOT_TOKEN"] });
    expect(names(`agend_library: 1\nkind: mcp\nname: x\ntransport: http\nurl: https://a.example/\nheaders:\n  Authorization: LINEAR_AUTH\n`)).toEqual({ error: "mcp_var_prefix", detail: "headers", names: ["LINEAR_AUTH"] });
    // case is exact, and a bare prefix is not a name
    for (const bad of ["mcp_token", "Mcp_Token", "MCP", "MCP_", "XMCP_TOKEN", "_MCP_TOKEN"]) expect(names(STDIO("x", `command: npx\nenv:\n  - ${bad}\n`)), bad).toMatchObject({ error: expect.stringMatching(/mcp_var_prefix|bad_mcp/) });
    // the ones that do follow it
    for (const good of ["MCP_TOKEN", "MCP_github_token", "MCP_A", "MCP_1"]) expect(names(STDIO("x", `command: npx\nenv:\n  - ${good}\n`)), good).toBeNull();
    expect(names(STDIO("x", "command: npx\nenv:\n  - MCP_A\n  - MCP_B\n"))).toBeNull();
  });

  it("an error never repeats a value pasted where a name belongs", () => {
    const pasted = `ghp_${"x".repeat(36)}`;
    expect(names(STDIO("x", `command: npx\nenv:\n  - ${pasted}\n`))).toEqual({ error: "mcp_var_prefix", detail: "env", names: ["?"] });
    expect(JSON.stringify(names(STDIO("x", `command: npx\nenv:\n  - ${pasted}\n`)))).not.toContain(pasted);
    expect(names(STDIO("x", "command: npx\nenv:\n  - has space\n"))).toMatchObject({ error: "bad_mcp", detail: "env" });
  });

  it("the store refuses to save one (nothing is written) and the web route answers 400 with a code the page words — see the API test", () => {
    const r = rig();
    expect(r.store.addMcp("gh", STDIO("gh", "command: npx\nenv:\n  - GITHUB_TOKEN\n"))).toMatchObject({ ok: false, error: "mcp_var_prefix" });
    expect(existsSync(join(r.store.root, "mcp", "gh.yaml"))).toBe(false);
    expect(r.store.addMcp("gh", STDIO("gh", "command: npx\nenv:\n  - MCP_GITHUB_TOKEN\n"))).toMatchObject({ ok: true });
    // an edit of a saved item is the same call: it cannot be changed to break the rule either
    expect(r.store.addMcp("gh", STDIO("gh", "command: npx\nenv:\n  - GITHUB_TOKEN\n"), { overwrite: true })).toMatchObject({ ok: false, error: "mcp_var_prefix" });
    expect(readFileSync(join(r.store.root, "mcp", "gh.yaml"), "utf8")).toContain("MCP_GITHUB_TOKEN");
  });

  it("is checked AGAIN when the config is written: an item placed by hand, or left by an older AgEnD, is not mounted — the skip says which names; the agent still starts", () => {
    const r = rig();
    r.store.addMcp("old", STDIO("old", "command: npx\nenv:\n  - MCP_OLD\n"));
    r.confirmations.confirm("a", "old", r.sha("old"));
    // an older AgEnD saved it with a plain name (the file and its lock entry are consistent: `ok`, confirmed)
    const file = join(r.store.root, "mcp", "old.yaml");
    const legacy = readFileSync(file, "utf8").replace("MCP_OLD", "OLD_TOKEN");
    writeFileSync(file, legacy);
    const lock = JSON.parse(readFileSync(join(r.store.root, "library.lock.json"), "utf8"));
    lock.items["mcp:old"].sha256 = createHash("sha256").update(legacy).digest("hex");
    writeFileSync(join(r.store.root, "library.lock.json"), JSON.stringify(lock));
    r.confirmations.confirm("a", "old", createHash("sha256").update(legacy).digest("hex"));
    expect(r.store.mcpForMount("old")).toEqual({ ok: false, reason: "bad_vars", names: ["OLD_TOKEN"] });
    const out = resolveMcpMount({ ids: ["old"], store: r.store, confirmed: r.confirmations.forAgent("a"), values: new Map([["OLD_TOKEN", SECRET]]) });
    expect(out.entries).toEqual({});
    expect(out.skipped).toEqual([{ id: "old", reason: "bad_vars", names: ["OLD_TOKEN"] }]);
    expect(JSON.stringify(out.skipped)).not.toContain(SECRET);
    // a hand-placed one, never saved through the Library
    writeFileSync(join(r.store.root, "mcp", "hand.yaml"), STDIO("hand", "command: npx\nenv:\n  - LEGACY\n"));
    expect(resolveMcpMount({ ids: ["hand"], store: r.store, confirmed: {}, values: new Map() }).skipped).toEqual([{ id: "hand", reason: "bad_vars", names: ["LEGACY"] }]);
  });

  it("the name a server is given can differ from the .env variable: `env: { NAME: ${MCP_VAR} }` reads MCP_VAR and hands it over as NAME (and the list form hands it over under its own name)", () => {
    const r = rig();
    expect(r.store.addMcp("gh", STDIO("gh", "command: npx\nargs:\n  - -y\n  - gh-mcp\nenv:\n  GITHUB_PERSONAL_ACCESS_TOKEN: ${MCP_GITHUB_TOKEN}\n  GITHUB_HOST: ${MCP_GITHUB_HOST}\n"))).toMatchObject({ ok: true });
    r.confirmations.confirm("a", "gh", r.sha("gh"));
    const stored = readFileSync(join(r.store.root, "mcp", "gh.yaml"), "utf8");
    expect(stored).toContain("GITHUB_PERSONAL_ACCESS_TOKEN");
    expect(parseYaml(stored).env).toEqual({ GITHUB_PERSONAL_ACCESS_TOKEN: "${MCP_GITHUB_TOKEN}", GITHUB_HOST: "${MCP_GITHUB_HOST}" });
    const out = resolveMcpMount({ ids: ["gh"], store: r.store, confirmed: r.confirmations.forAgent("a"), values: new Map([["MCP_GITHUB_TOKEN", SECRET], ["MCP_GITHUB_HOST", "h.example"], ["GITHUB_PERSONAL_ACCESS_TOKEN", "WRONG"]]) });
    expect(out.entries[libraryMcpName("gh")]).toEqual({ transport: "stdio", command: "npx", args: ["-y", "gh-mcp"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: SECRET, GITHUB_HOST: "h.example" } });
    // the missing-variable rule names the `.env` variable (not the name the server sees)
    const miss = resolveMcpMount({ ids: ["gh"], store: r.store, confirmed: r.confirmations.forAgent("a"), values: new Map([["MCP_GITHUB_HOST", "h"]]) });
    expect(miss.skipped).toEqual([{ id: "gh", reason: "missing_vars", names: ["MCP_GITHUB_TOKEN"] }]);
    expect(JSON.stringify(miss.skipped)).not.toContain("GITHUB_PERSONAL_ACCESS_TOKEN");
    // a list and a map cannot be mixed, a literal on the right is a value (refused), and the target may not be a reserved name
    expect(names(STDIO("x", "command: npx\nenv:\n  NAME: literal-value\n"))).toMatchObject({ error: "bad_mcp", detail: "env" });
    expect(names(STDIO("x", "command: npx\nenv:\n  NAME: ghp_abcdefghijklmnopqrstuvwxyz0123456789\n"))).toMatchObject({ error: "bad_mcp", detail: "env" });
    expect(names(STDIO("x", "command: npx\nenv:\n  - MCP_A\n  - B: ${MCP_B}\n"))).toMatchObject({ error: "bad_mcp", detail: "env" });
    expect(names(STDIO("x", "command: npx\nenv: MCP_A\n"))).toMatchObject({ error: "bad_mcp", detail: "env" });
    // the claude / codex writers get the resolved entry: the renamed variable is what is written
    expect(claudeMcpEntry(out.entries[libraryMcpName("gh")]!)).toMatchObject({ env: { GITHUB_PERSONAL_ACCESS_TOKEN: SECRET } });
    expect(parseToml(codexMcpToml("agend-lib-gh", out.entries[libraryMcpName("gh")]!)).mcp_servers["agend-lib-gh"].env.GITHUB_PERSONAL_ACCESS_TOKEN).toBe(SECRET);
  });

  it("the list form is still `MCP_NAME` → the same name, and an item written before renaming existed (list of MCP_ names) keeps its exact text and hash", () => {
    const r = rig();
    const text = STDIO("gh");
    expect(r.store.addMcp("gh", text)).toMatchObject({ ok: true });
    expect(readFileSync(join(r.store.root, "mcp", "gh.yaml"), "utf8")).toBe(stringifyMcp((validateMcpText("gh", text) as any).item));
    expect(parseYaml(readFileSync(join(r.store.root, "mcp", "gh.yaml"), "utf8")).env).toEqual(["MCP_GH_TOKEN", "MCP_GH_HOST"]);
  });
});

describe(".env values and the confirmation record", () => {
  it("reads only the names asked for, only non-empty values, and never through a symlink", () => {
    const home = tmp("agend-mcp261-env-");
    const file = join(home, ".env");
    writeFileSync(file, `# c\nA=1\nexport B="two"\nC=\nD=${SECRET}\r\nUNRELATED=zzz\n`);
    const got = readEnvValues(file, ["A", "B", "C", "D", "MISSING"]);
    expect([...got]).toEqual([["A", "1"], ["B", "two"], ["D", SECRET]]);
    expect([...envNamesSet(file, ["A", "C"])]).toEqual(["A"]);
    const link = join(home, "link.env");
    symlinkSync(file, link);
    expect(readEnvValues(link, ["A"]).size).toBe(0);
    expect(readEnvValues(join(home, "none"), ["A"]).size).toBe(0);
  });

  it("the record is private, per agent, survives a rewrite, and a corrupt or foreign one confirms nothing", () => {
    const r = rig();
    r.store.addMcp("gh", STDIO("gh"));
    r.confirmations.confirm("a", "gh", r.sha("gh"));
    r.confirmations.confirm("b", "gh", "1".repeat(64));
    expect(statSync(r.confirmations.path).mode & 0o777).toBe(0o600);
    expect(r.confirmations.forAgent("a")).toEqual({ gh: r.sha("gh") });
    expect(r.confirmations.forAgent("b")).toEqual({ gh: "1".repeat(64) });
    expect(r.confirmations.forAgent("constructor")).toEqual({});
    writeFileSync(r.confirmations.path, "{ nope");
    expect(r.confirmations.forAgent("a")).toEqual({});
    writeFileSync(r.confirmations.path, JSON.stringify({ agents: { a: { "../x": "0".repeat(64), gh: "short" } } }));
    expect(r.confirmations.forAgent("a")).toEqual({});
  });
});

describe("the backend table", () => {
  it("answers from one table: Claude Code and Codex, no other backend, no inherited name", () => {
    expect(Object.keys(LIBRARY_MCP_BACKENDS).sort()).toEqual(["claude-code", "codex"]);
    for (const b of ["claude-code", "codex"]) expect(supportsLibraryMcp(b)).toBe(true);
    for (const b of ["opencode", "kiro-cli", "grok", "muse", "antigravity", "mock", "constructor", "toString", undefined, 3]) expect(supportsLibraryMcp(b)).toBe(false);
  });
  it("the overview says per agent whether its backend takes them, and who has what mounted", () => {
    const o = buildOverview({ defaultBackend: "claude-code", instances: {
      a: { library: { mcp: ["gh", "ex"] } }, b: { backend: "grok", library: { mcp: ["gh"] } }, w: { runtime: "windows", library: { mcp: ["gh"] } },
    } });
    expect(o.agents.map((x) => [x.name, x.libraryMcp])).toEqual([["a", true], ["b", false], ["w", true]]);
    expect(o.teamMcpUsage).toEqual({ gh: ["a", "b"], ex: ["a"] });
    // a paused server is not "in use": only what is given counts
    expect(libraryMcpUsage({ a: { library: { mcp: ["gh"], paused: { mcp: ["ex"] } } as never } })).toEqual({ gh: ["a"] });
    expect(libraryMcpUsage(null)).toEqual({});
  });
});

describe("fleet.yaml: library.mcp", () => {
  const cfg = (inst: unknown) => validateFleetConfig({
    channel: { type: "telegram", mode: "topic", bot_token_env: "T", group_id: -1 }, defaults: {}, instances: { a: { working_directory: "/tmp/a", ...(inst as object) } },
  } as never);
  it("accepts a list of ids with no warning that it is ignored; rejects a wrong shape, a path, a repeat, and defaults.library", () => {
    const ok = cfg({ library: { mcp: ["github"] } });
    expect(ok.errors).toEqual([]);
    expect(ok.warnings.some((w: { path: string }) => w.path === "instances.a.library.mcp")).toBe(false);
    expect(libraryMountProblem({ mcp: "github" }, false)).toMatch(/list of library MCP ids/);
    expect(libraryMountProblem({ mcp: ["../x"] }, false)).toMatch(/list of library MCP ids/);
    expect(libraryMountProblem({ mcp: ["a", "a"] }, false)).toMatch(/twice/);
    expect(libraryMountProblem({ mcp: ["a"], skills: ["b"] }, false)).toBeNull();
    expect(libraryMountProblem({ mcp: ["a"] }, true)).toMatch(/per agent/);
  });
});

describe("rendering: Claude Code", () => {
  it("a stdio server keeps command, args and env; an http one is `type: http` with its headers", () => {
    expect(claudeMcpEntry({ transport: "stdio", command: "npx", args: ["-y", "s"], env: { A: "1" } })).toEqual({ command: "npx", args: ["-y", "s"], env: { A: "1" } });
    expect(claudeMcpEntry({ transport: "stdio", command: "npx", args: [], env: {} })).toEqual({ command: "npx", args: [] });
    expect(claudeMcpEntry({ transport: "http", url: "https://a.example/x", headers: { Authorization: "Bearer t" } })).toEqual({ type: "http", url: "https://a.example/x", headers: { Authorization: "Bearer t" } });
  });
});

describe("rendering: Codex TOML escaping", () => {
  const nasty = [
    "plain", "quote\" and \\ backslash", "line\nbreak", "tab\there", "del\u007fchar", "nul\u0000char", "ctrl\u001b[31m",
    "\"\n[mcp_servers.evil]\ncommand = \"sh\"", "'''\"\"\"", "emoji 😀 and é", "lone \ud800 surrogate", "# not a comment", "a = 'b'",
  ];
  it("every awkward value reads back exactly as it was (a lone surrogate becomes U+FFFD)", () => {
    for (const v of nasty) {
      const entry: LibraryMcpEntry = { transport: "stdio", command: "cmd", args: [v], env: { K: v } };
      const parsed = parseToml(codexMcpToml("agend-lib-x", entry)) as any;
      const expected = v.replace(/[\ud800-\udfff]/gu, (c, i, s) => (c.length === 1 && /[\ud800-\udfff]/.test(c) ? "�" : c));
      expect(Object.keys(parsed.mcp_servers), v).toEqual(["agend-lib-x"]);
      expect(parsed.mcp_servers["agend-lib-x"].args, v).toEqual([expected]);
      expect(parsed.mcp_servers["agend-lib-x"].env.K, v).toBe(expected);
    }
  });
  it("tomlBasic: control characters and DEL are escaped, so no raw one is left in the file", () => {
    expect(tomlBasic("a\u0000b\u007fc\n")).toBe('"a\\u0000b\\u007fc\\n"');
    // eslint-disable-next-line no-control-regex
    expect(/[\u0000-\u0008\u000a-\u001f\u007f]/.test(tomlBasic("x\u0001\u001f\u007f\r\n"))).toBe(false);
  });
  it("an http server renders `url` and an `http_headers` table", () => {
    const parsed = parseToml(codexMcpToml("agend-lib-ex", { transport: "http", url: "https://a.example/x", headers: { Authorization: "Bearer \"t\"", "X-Api": "k" } })) as any;
    expect(parsed.mcp_servers["agend-lib-ex"]).toEqual({ url: "https://a.example/x", http_headers: { Authorization: "Bearer \"t\"", "X-Api": "k" } });
  });
  it("the block holds every entry, sorted, and drops one that would not read back", () => {
    const good: LibraryMcpEntry = { transport: "stdio", command: "a", args: [], env: {} };
    const { text, dropped } = codexMcpBlock({ "agend-lib-b": good, "agend-lib-a": good });
    expect(dropped).toEqual([]);
    expect(Object.keys((parseToml(text) as any).mcp_servers)).toEqual(["agend-lib-a", "agend-lib-b"]);
    // a name that cannot be a TOML key table path safely is still quoted, never injected
    const odd = codexMcpBlock({ "agend-lib-x\"]\n[evil": good });
    expect(odd.text.includes("\n[evil")).toBe(false);
  });
});

/** The bytes the backends wrote before this change, pinned: an agent with nothing mounted must get exactly these. */
describe("GOLDEN: an agent with nothing mounted gets the same files as before", () => {
  const savedEnv = { AGEND_HOME: process.env.AGEND_HOME, CODEX_HOME: process.env.CODEX_HOME };
  let root: string, instance: string, shared: string;
  beforeEach(() => {
    root = tmp("agend-mcp261-gold-");
    instance = join(root, "agend", "instances", "w1");
    shared = join(root, "shared");
    mkdirSync(instance, { recursive: true }); mkdirSync(shared, { recursive: true });
    process.env.AGEND_HOME = join(root, "agend");
    process.env.CODEX_HOME = shared;
  });
  afterEach(() => { for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const servers = { agend: { command: "/usr/bin/node", args: ["/x/mcp-server.js"], env: { AGEND_INSTANCE_NAME: "w1", A: "1" } } };
  const base = (extra: object = {}) => ({ workingDirectory: instance, instanceDir: instance, instanceName: "w1", mcpServers: servers, ...extra });

  it("Claude Code: mcp-config.json is exactly the JSON of mcpServers, with and without an empty libraryMcp", () => {
    const expected = JSON.stringify({ mcpServers: servers }, null, 2);
    new ClaudeCodeBackend(instance).writeConfig(base() as never);
    expect(readFileSync(join(instance, "mcp-config.json"), "utf8")).toBe(expected);
    writeFileSync(join(instance, "mcp-config.json"), "stale");
    new ClaudeCodeBackend(instance).writeConfig(base({ libraryMcp: {} }) as never);
    expect(readFileSync(join(instance, "mcp-config.json"), "utf8")).toBe(expected);
  });

  it("Claude Code: a mounted server is appended under its agend-lib- name, the agend one and the rest are unchanged, and the file is owner-only", () => {
    const entry: LibraryMcpEntry = { transport: "stdio", command: "npx", args: ["-y", "s"], env: { MCP_GH_TOKEN: SECRET } };
    new ClaudeCodeBackend(instance).writeConfig(base({ libraryMcp: { [libraryMcpName("gh")]: entry, [libraryMcpName("ex")]: { transport: "http", url: "https://a.example/", headers: { Authorization: SECRET } } } }) as never);
    const written = JSON.parse(readFileSync(join(instance, "mcp-config.json"), "utf8"));
    expect(written.mcpServers.agend).toEqual(servers.agend);
    expect(written.mcpServers["agend-lib-gh"]).toEqual({ command: "npx", args: ["-y", "s"], env: { MCP_GH_TOKEN: SECRET } });
    expect(written.mcpServers["agend-lib-ex"]).toEqual({ type: "http", url: "https://a.example/", headers: { Authorization: SECRET } });
    expect(Object.keys(written.mcpServers).sort()).toEqual(["agend", "agend-lib-ex", "agend-lib-gh"]);
    expect(statSync(join(instance, "mcp-config.json")).mode & 0o077).toBe(0);
  });

  it("Claude Code: the file with values is 0600 whatever the umask, also when an old world-readable one was there (and it is never rewritten before it is tightened)", () => {
    const entry: LibraryMcpEntry = { transport: "stdio", command: "npx", args: [], env: { MCP_GH_TOKEN: SECRET } };
    const file = join(instance, "mcp-config.json");
    const old = process.umask(0o000);                                    // the worst case: a file created under this umask would be 0666
    try {
      // new file
      new ClaudeCodeBackend(instance).writeConfig(base({ libraryMcp: { [libraryMcpName("gh")]: entry } }) as never);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      // an old file from before there was anything mounted: 0644, the stale content
      rmSync(file); writeFileSync(file, "stale", { mode: 0o644 }); chmodSync(file, 0o644);
      expect(statSync(file).mode & 0o777).toBe(0o644);
      new ClaudeCodeBackend(instance).writeConfig(base({ libraryMcp: { [libraryMcpName("gh")]: entry } }) as never);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(file, "utf8")).mcpServers["agend-lib-gh"].env.MCP_GH_TOKEN).toBe(SECRET);
      // unmounting rewrites the plain content (no values left in it); nothing else about the no-mount path changed
      new ClaudeCodeBackend(instance).writeConfig(base() as never);
      expect(readFileSync(file, "utf8")).toBe(JSON.stringify({ mcpServers: servers }, null, 2));
      expect(readFileSync(file, "utf8")).not.toContain(SECRET);
    } finally { process.umask(old); }
  });

  it("Claude Code: a first write is created 0600 by the open itself (the tightening after it is only for an old file)", () => {
    const src = readFileSync(join(__dirname, "..", "src", "backend", "claude-code.ts"), "utf8");
    const at = src.indexOf("if (libraryEntries.length) {\n      // It now holds");
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at, src.indexOf("// 2. Write statusline script"));
    // the order in the source: tighten an old file, then write with { mode: 0o600 }, never a plain write of the values
    expect(block.indexOf("chmodSync(mcpConfigPath, 0o600)")).toBeLessThan(block.indexOf("writeFileSync(mcpConfigPath, mcpConfigText, { mode: 0o600 })"));
    expect(block.match(/writeFileSync\(mcpConfigPath, mcpConfigText\)/g) ?? []).toHaveLength(1);       // the plain one is the else (nothing mounted) only
    expect(block.indexOf("} else {")).toBeGreaterThan(block.indexOf("{ mode: 0o600 }"));
  });

  it("Codex: config.toml is byte-identical with no libraryMcp (absent or empty), and the user's own settings and servers are kept", () => {
    writeFileSync(join(shared, "config.toml"), 'model = "gpt-x"\n\n[mcp_servers.mine]\ncommand = "mine"\n');
    new CodexBackend(instance).writeConfig(base() as never);
    const file = join(CodexBackend.shortHomeFor(instance), "config.toml");
    const without = readFileSync(file, "utf8");
    new CodexBackend(instance).writeConfig(base({ libraryMcp: {} }) as never);
    expect(readFileSync(file, "utf8")).toBe(without);
    expect(without).toContain("[mcp_servers.mine]");
    expect(without).not.toContain("agend-lib-");
  });

  it("Codex: a mounted server is added as its own tables; the next start without it removes it; the user's tables stay", () => {
    writeFileSync(join(shared, "config.toml"), 'model = "gpt-x"\n\n[mcp_servers.mine]\ncommand = "mine"\n');
    const entry: LibraryMcpEntry = { transport: "stdio", command: "npx", args: ["-y", "s\"q"], env: { MCP_GH_TOKEN: `${SECRET}"\n[evil]` } };
    const file = join(CodexBackend.shortHomeFor(instance), "config.toml");
    new CodexBackend(instance).writeConfig(base() as never);
    const before = readFileSync(file, "utf8");
    new CodexBackend(instance).writeConfig(base({ libraryMcp: { [libraryMcpName("gh")]: entry } }) as never);
    const withLib = parseToml(readFileSync(file, "utf8")) as any;
    expect(withLib.mcp_servers["agend-lib-gh"]).toEqual({ command: "npx", args: ["-y", "s\"q"], env: { MCP_GH_TOKEN: `${SECRET}"\n[evil]` } });
    expect(withLib.mcp_servers.mine).toEqual({ command: "mine" });
    expect(withLib.mcp_servers.evil).toBeUndefined();
    expect(Object.keys(withLib.mcp_servers).sort()).toEqual(["agend-w1", "agend-lib-gh", "mine"].sort());
    expect(statSync(file).mode & 0o077).toBe(0);
    new CodexBackend(instance).writeConfig(base() as never);
    expect(readFileSync(file, "utf8")).toBe(before);
  });
});

describe("the daemon: nothing mounted adds nothing to the backend config", () => {
  const logger: any = { error() {}, info() {}, warn() {}, debug() {}, child() { return logger; } };
  const make = (config: object, root: string) => new Daemon("w1", { working_directory: root, log_level: "error", ...config } as never, join(root, "instances", "w1"), false, undefined, undefined, logger);
  it("no `libraryMcp` key unless something was mounted AND resolved; the source is not even asked for an agent with no mount", () => {
    const root = tmp("agend-mcp261-d-");
    mkdirSync(join(root, "instances", "w1"), { recursive: true });
    const source = vi.fn((_ids: readonly string[]) => ({ "agend-lib-gh": { transport: "stdio", command: "x", args: [], env: {} } as LibraryMcpEntry }));
    const plain = make({}, root);
    plain.setLibraryMcpSource(source);
    const baseline = (plain as any).buildBackendConfig();
    expect("libraryMcp" in baseline).toBe(false);
    expect(source).not.toHaveBeenCalled();
    const emptyList = make({ library: { skills: ["a"] } }, root);
    emptyList.setLibraryMcpSource(source);
    expect("libraryMcp" in (emptyList as any).buildBackendConfig()).toBe(false);
    expect(source).not.toHaveBeenCalled();
    // AGEND-261: a paused server is assigned but not in `library.mcp`: the source is not asked, nothing is added — the same config as no mount at all
    const pausedOnly = make({ library: { paused: { mcp: ["gh"] } } }, root);
    pausedOnly.setLibraryMcpSource(source);
    expect("libraryMcp" in (pausedOnly as any).buildBackendConfig()).toBe(false);
    expect(source).not.toHaveBeenCalled();
    const mounted = make({ library: { mcp: ["gh"] } }, root);
    mounted.setLibraryMcpSource(source);
    const built = (mounted as any).buildBackendConfig();
    expect(source).toHaveBeenCalledWith(["gh"]);
    expect(Object.keys(built.libraryMcp)).toEqual(["agend-lib-gh"]);
    // everything else in the config is what the agent without a mount gets
    const { libraryMcp: _l, instructions: i1, ...rest } = built;
    const { instructions: i2, ...restBase } = baseline;
    expect(JSON.stringify(rest).replace(/w1/g, "")).toBe(JSON.stringify(restBase).replace(/w1/g, ""));
    expect(i1).toBe(i2);
    // a source that gives nothing (not confirmed, a variable missing, a backend without support) adds nothing
    const none = make({ library: { mcp: ["gh"] } }, root);
    none.setLibraryMcpSource(() => undefined);
    expect("libraryMcp" in (none as any).buildBackendConfig()).toBe(false);
    const empty = make({ library: { mcp: ["gh"] } }, root);
    empty.setLibraryMcpSource(() => ({}));
    expect("libraryMcp" in (empty as any).buildBackendConfig()).toBe(false);
  });
});

describe("FleetManager.libraryMcpFor: the whole path from fleet files to the entries", () => {
  function fleet() {
    const root = tmp("agend-mcp261-f-");
    const fm = new FleetManager(root) as any;
    const warns: unknown[][] = [];
    fm.logger = { error() {}, info() {}, debug() {}, warn: (...a: unknown[]) => { warns.push(a); }, child() { return fm.logger; } };
    const store = new LibraryStore(root);
    const confirmations = new McpConfirmations(store);
    const mount = (agent = "a") => {
      store.addMcp("gh", STDIO("gh"));
      confirmations.confirm(agent, "gh", (store.mcpForMount("gh") as any).sha256);
    };
    return { root, fm, warns, store, confirmations, mount, env: join(root, ".env") };
  }

  it("resolves a confirmed item with its values from .env; a log line carries names only", () => {
    const f = fleet();
    f.mount();
    writeFileSync(f.env, `MCP_GH_TOKEN=${SECRET}\nMCP_GH_HOST=h.example\n`);
    expect(f.fm.libraryMcpFor("a", ["gh"], "claude-code")).toEqual({ "agend-lib-gh": { transport: "stdio", command: "npx", args: ["-y", "some-server"], env: { MCP_GH_TOKEN: SECRET, MCP_GH_HOST: "h.example" } } });
    expect(f.fm.libraryMcpFor("a", ["gh"], "codex")).toBeDefined();
    expect(JSON.stringify(f.warns)).not.toContain(SECRET);
  });

  it("a variable that is not in .env: not started, and the warning names it", () => {
    const f = fleet();
    f.mount();
    writeFileSync(f.env, `MCP_GH_HOST=h.example\n`);
    expect(f.fm.libraryMcpFor("a", ["gh"], "claude-code")).toBeUndefined();
    expect(JSON.stringify(f.warns)).toContain("MCP_GH_TOKEN");
    expect(JSON.stringify(f.warns)).not.toContain("h.example");
    // the same state at the next launch says nothing new
    const n = f.warns.length;
    f.fm.libraryMcpFor("a", ["gh"], "claude-code");
    expect(f.warns.length).toBe(n);
  });

  it("not confirmed, or confirmed for another agent: not written", () => {
    const f = fleet();
    f.mount("other");
    writeFileSync(f.env, `MCP_GH_TOKEN=x\nGH_HOST=y\n`);
    expect(f.fm.libraryMcpFor("a", ["gh"], "claude-code")).toBeUndefined();
  });

  it("AGEND-261 rule A at start: an item with a name that breaks the MCP_ rule is not written, the warning names the variable (never the value), and the rest still mounts", () => {
    const f = fleet();
    f.mount();
    writeFileSync(join(f.root, "library", "mcp", "legacy.yaml"), STDIO("legacy", "command: npx\nenv:\n  - TELEGRAM_BOT_TOKEN\n"));
    writeFileSync(f.env, `MCP_GH_TOKEN=${SECRET}\nMCP_GH_HOST=h\nTELEGRAM_BOT_TOKEN=${SECRET}-bot\n`);
    const got = f.fm.libraryMcpFor("a", ["legacy", "gh"], "claude-code");
    expect(Object.keys(got)).toEqual(["agend-lib-gh"]);
    const logged = JSON.stringify(f.warns);
    expect(logged).toContain("TELEGRAM_BOT_TOKEN");
    expect(logged).toContain("bad_vars");
    expect(logged).not.toContain(SECRET);
  });

  it("a backend that cannot take them gets nothing, even when everything else is in order", () => {
    const f = fleet();
    f.mount();
    writeFileSync(f.env, `MCP_GH_TOKEN=x\nGH_HOST=y\n`);
    for (const b of ["opencode", "kiro-cli", "grok", "muse", "antigravity"]) expect(f.fm.libraryMcpFor("a", ["gh"], b)).toBeUndefined();
    expect(JSON.stringify(f.warns)).toContain("does not support");
  });

  it("a broken library or .env never throws into a start", () => {
    const f = fleet();
    mkdirSync(join(f.root, "library"), { recursive: true });
    writeFileSync(join(f.root, "library", "mcp"), "a file where a folder should be");
    chmodSync(join(f.root, "library", "mcp"), 0o000);
    expect(() => f.fm.libraryMcpFor("a", ["gh"], "claude-code")).not.toThrow();
    expect(existsSync(f.env)).toBe(false);
  });
});
