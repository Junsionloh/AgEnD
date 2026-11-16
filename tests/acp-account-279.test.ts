/**
 * AGEND-279 (2): an ACP instance runs under a named account (`backend_options.<cli>.credential_profile`). grok is told its
 * folder by GROK_HOME, agy by `--app_data_dir` (the terminal backend's own launch); each account's folder is its own, and the
 * child of a named account never receives the daemon's own account variables. The child is observed through the spawn seam.
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acpAccountLaunch } from "../src/adapters/acp/account.js";
import { AcpAdapter } from "../src/adapters/acp/acp-adapter.js";
import { AGY_PROFILE, GROK_PROFILE, type AcpProfile } from "../src/adapters/acp/profiles.js";
import { spawn as nodeSpawn } from "../src/child-process.js";
import { validateFleetConfig } from "../src/config-validator.js";
import { runtimeConfigProblem } from "../src/adapters/config.js";
import type { InstanceRunner } from "../src/adapters/types.js";

const FAKE = join(import.meta.dirname, "fixtures", "acp", "fake-acp-agent.mjs");
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const dirs: string[] = [];
const adapters: AcpAdapter[] = [];
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), "acp-account-")); dirs.push(d); return d; };
afterEach(async () => {
  await Promise.all(adapters.splice(0).map(a => a.stop().catch(() => undefined)));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

/** What the adapter hands the OS to start the child; the real child is the fake agent. */
async function launched(base: AcpProfile, backendOptions: Record<string, unknown> | undefined, source: NodeJS.ProcessEnv, home: string) {
  const seen: { command: string; args: string[]; env: Record<string, string> }[] = [];
  // The fake agent reports its version the way agy does; everything else (args, env, account launch) is the real profile's.
  const profile: AcpProfile = { ...base, supportedVersions: ["9.9.9"], versionOf: AGY_PROFILE.versionOf };
  const account = acpAccountLaunch(profile, home, backendOptions);
  const instanceDir = tmp();
  const adapter = new AcpAdapter({
    profile, command: "/usr/bin/the-cli", cwd: instanceDir, instanceDir, mcpServers: [], logger,
    env: source, childEnv: { FAKE_ACP_VERSION: "9.9.9", FAKE_ACP_STATE: join(instanceDir, "state") },
    ...(account ? { account: { env: account.env, args: account.args } } : {}),
    spawn: ((command: string, args: string[], options: { env: Record<string, string> }) => {
      seen.push({ command, args: [...args], env: { ...options.env } });
      return nodeSpawn(process.execPath, [FAKE], options as never);
    }) as never,
    makeRunner: () => ({}) as InstanceRunner,
  });
  adapters.push(adapter);
  await adapter.start();
  return { seen: seen[0]!, account };
}
const DAEMON_ENV = { PATH: process.env.PATH, HOME: process.env.HOME, XAI_API_KEY: "default-xai-key", GROK_HOME: "/default/grok-home", GOOGLE_API_KEY: "default-google-key", GEMINI_API_KEY: "default-gemini-key" };

describe("grok under a named account", () => {
  it("is started with GROK_HOME on the account's own folder, and none of the default account's variables", async () => {
    const home = tmp();
    const { seen, account } = await launched(GROK_PROFILE, { credential_profile: "work" }, DAEMON_ENV, home);
    const folder = join(home, "credential-profiles", "grok", "work");
    expect(account!.folder).toBe(folder);
    expect(seen.env.GROK_HOME).toBe(folder);
    expect(seen.env.XAI_API_KEY).toBeUndefined();
    expect(seen.args).toEqual(["--no-auto-update", "agent", "--no-leader", "--always-approve", "stdio"]);
    expect(statSync(folder).mode & 0o777).toBe(0o700);
  });
  it("without an account the child is exactly what it was: the daemon's variables, no folder made", async () => {
    const home = tmp();
    const { seen, account } = await launched(GROK_PROFILE, undefined, DAEMON_ENV, home);
    expect(account).toBeNull();
    expect(seen.env.GROK_HOME).toBe("/default/grok-home");
    expect(seen.env.XAI_API_KEY).toBe("default-xai-key");
    expect(existsSync(join(home, "credential-profiles"))).toBe(false);
  });
  it("two accounts are two folders: a sign-in written for one is not in the other, nor in the default", async () => {
    const home = tmp();
    const work = await launched(GROK_PROFILE, { credential_profile: "work" }, DAEMON_ENV, home);
    const play = await launched(GROK_PROFILE, { credential_profile: "play" }, DAEMON_ENV, home);
    expect(work.seen.env.GROK_HOME).not.toBe(play.seen.env.GROK_HOME);
    writeFileSync(join(work.seen.env.GROK_HOME!, "auth.json"), "{\"work\":true}");
    expect(existsSync(join(play.seen.env.GROK_HOME!, "auth.json"))).toBe(false);
    expect(existsSync(join(home, "auth.json"))).toBe(false);
  });
  it("a folder that is a link is refused (it would be another account's)", () => {
    const home = tmp(), other = tmp();
    mkdirSync(join(home, "credential-profiles", "grok"), { recursive: true });
    symlinkSync(other, join(home, "credential-profiles", "grok", "work"));
    expect(() => acpAccountLaunch(GROK_PROFILE, home, { credential_profile: "work" })).toThrow(/symlink/);
    expect(lstatSync(join(home, "credential-profiles", "grok", "work")).isSymbolicLink()).toBe(true);
  });
  it("a name that is not a profile name is refused before anything is made", () => {
    const home = tmp();
    expect(() => acpAccountLaunch(GROK_PROFILE, home, { credential_profile: "../escape" })).toThrow(/credential_profile/);
    expect(existsSync(join(home, "credential-profiles"))).toBe(false);
  });
  it("the sign-in command for the account names its folder", () => {
    const home = tmp();
    const account = acpAccountLaunch(GROK_PROFILE, home, { credential_profile: "work" })!;
    expect(account.loginCommand).toBe(`GROK_HOME=${JSON.stringify(account.folder)} grok login --device-auth`);
  });
});

describe("agy under a named account", () => {
  it("is started with --app_data_dir right after the binary (relative to ~/.gemini) and the registry's pin, without the default account's keys", async () => {
    const home = tmp();
    const { seen, account } = await launched(AGY_PROFILE, { credential_profile: "work" }, DAEMON_ENV, home);
    expect(seen.args.slice(0, 2)[0]).toBe("--app_data_dir");
    expect(seen.args.slice(2)).toEqual(["acp", "--dangerously-skip-permissions"]);
    expect(resolve(homedir(), ".gemini", seen.args[1]!)).toBe(account!.folder);
    expect(account!.folder).toBe(join(home, "credential-profiles", "antigravity", "work"));
    expect(seen.env.SSH_CONNECTION).toBe("127.0.0.1 0 127.0.0.1 0");
    expect(seen.env.GOOGLE_API_KEY).toBeUndefined();
    expect(seen.env.GEMINI_API_KEY).toBeUndefined();
    expect(lstatSync(account!.folder).isDirectory()).toBe(true);
  });
  it("without an account: no folder argument, no pin, the daemon's keys as before", async () => {
    const { seen } = await launched(AGY_PROFILE, undefined, DAEMON_ENV, tmp());
    expect(seen.args).toEqual(["acp", "--dangerously-skip-permissions"]);
    expect(seen.env.SSH_CONNECTION).toBeUndefined();
    expect(seen.env.GOOGLE_API_KEY).toBe("default-google-key");
  });
  it("two accounts are two folders", async () => {
    const home = tmp();
    const a = await launched(AGY_PROFILE, { credential_profile: "a" }, DAEMON_ENV, home);
    const b = await launched(AGY_PROFILE, { credential_profile: "b" }, DAEMON_ENV, home);
    expect(a.seen.args[1]).not.toBe(b.seen.args[1]);
    expect(realpathSync(a.account!.folder)).not.toBe(realpathSync(b.account!.folder));
  });
  it("the sign-in command is the one the terminal backend gives", () => {
    const home = tmp();
    const account = acpAccountLaunch(AGY_PROFILE, home, { credential_profile: "work" })!;
    expect(account.loginCommand).toContain('agy "--app_data_dir"');
    expect(account.loginCommand).toContain("acp --login");
  });
});

describe("the lifecycle hands the account to the adapter", () => {
  const adapterFor = async (backendName: string, config: Record<string, unknown>, home: string) => {
    vi.stubEnv("AGEND_HOME", home);
    const { InstanceLifecycle } = await import("../src/instance-lifecycle.js");
    const root = tmp();
    const lc = new InstanceLifecycle({ logger: { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } }, signInHint: () => "the default's advice" } as never) as unknown as {
      buildAcpAdapter(p: Record<string, unknown>): { opts: { account?: { env: Record<string, string>; args: string[] }; signInHint?: (label: string) => string } };
    };
    return lc.buildAcpAdapter({ name: "w", config: { working_directory: root, backend: backendName, cli_adapter: "acp", ...config }, instanceDir: root, topicMode: true, backendName,
      resolvedBinary: "/bin/x", capActiveDecisions: (r: unknown[]) => r, selectRelevantDecisions: (r: unknown[]) => r });
  };
  it("a named account: its launch and its own sign-in advice; none: the default's advice and nothing added", async () => {
    const home = tmp();
    const named = await adapterFor("grok", { backend_options: { grok: { credential_profile: "work" } } }, home);
    expect(named.opts.account!.env.GROK_HOME).toBe(join(home, "credential-profiles", "grok", "work"));
    expect(named.opts.signInHint!("grok")).toContain(`GROK_HOME=${JSON.stringify(join(home, "credential-profiles", "grok", "work"))} grok login`);
    const plain = await adapterFor("grok", {}, home);
    expect(plain.opts.account).toBeUndefined();
    expect(plain.opts.signInHint!("grok")).toBe("the default's advice");
    expect((await adapterFor("antigravity", { backend_options: { antigravity: { credential_profile: "work" } } }, home)).opts.account!.args[0]).toBe("--app_data_dir");
  });
  it("a profile of another CLI is not this CLI's account", async () => {
    const home = tmp();
    const grok = await adapterFor("grok", { backend_options: { antigravity: { credential_profile: "work" } } }, home);
    expect(grok.opts.account).toBeUndefined();
  });
});

describe("configuration", () => {
  it("a named account on an acp instance has no 'no credential home' warning for grok, and a terminal grok instance still has it", () => {
    const warnings = (inst: Record<string, unknown>) => validateFleetConfig({ instances: { a: { working_directory: "/tmp/a", backend: "grok", backend_options: { grok: { credential_profile: "work" } }, ...inst } } }).warnings.map(w => w.path).filter(p => p.endsWith("credential_profile"));
    expect(warnings({ cli_adapter: "acp" })).toEqual([]);
    expect(warnings({})).toContain("instances.a.backend_options.grok.credential_profile");
  });
  it("a Runtime / CLI switch with an account and acp is not refused for the account", () => {
    expect(runtimeConfigProblem({ backend: "grok", cli_adapter: "acp" })).toBeNull();
  });
});
