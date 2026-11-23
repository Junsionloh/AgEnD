/**
 * AGEND-340: Settings → Accounts signs a CLI in under a NAMED profile, which no agent uses until it is chosen. An agent that names
 * none (and whose fleet default names none) runs on the CLI's default sign-in; when that is signed out it sits at the CLI's sign-in
 * screen and is paused, and nothing said why. The hint says that a signed-in account exists and where to choose it — and never
 * chooses one.
 *
 *   1. The rule (account-hint.ts, pure): who gets a hint and who does not, and that the profiles are only read when they could matter.
 *   2. The facts (FleetManager.accountHintFor): a real fleet and real profile folders, for Claude Code and for Codex; a Windows agent,
 *      an agent with an account, a fleet default with an account, and a signed-in default all get none.
 * Where it is said (the admin-only route, a failed start and restart, the auth-error incident) is tests/account-hint-route-340.test.ts.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { accountHint, accountHintLabel, accountHintText, type AccountHintFacts } from "../src/account-hint.js";
import { FleetManager } from "../src/fleet-manager.js";
import type { SignInTarget } from "../src/web-backend-login.js";

type State = SignInTarget["state"];
/** The facts of one agent. `profiles` may be the list, or the function that reads it (to count the reads). */
const facts = (over: { agent?: AccountHintFacts["agent"]; defaultState?: AccountHintFacts["defaultState"]; profiles?: Array<{ profile: string; state: State }> | AccountHintFacts["profiles"] } = {}): AccountHintFacts => ({
  agent: over.agent ?? { backend: "claude-code", profile: null },
  defaultState: "defaultState" in over ? over.defaultState : "not_signed_in",
  profiles: typeof over.profiles === "function" ? over.profiles : () => over.profiles ?? [{ profile: "work", state: "usable" as State }],
});

describe("the rule", () => {
  it("an agent on the default sign-in, which is signed out, with one account signed in: the hint offers that account", () => {
    expect(accountHint(facts())).toEqual({ backend: "claude-code", accounts: ["work"], only: "work" });
  });
  it("several accounts signed in: all listed in order, none offered as the one (the person chooses)", () => {
    expect(accountHint(facts({ profiles: [{ profile: "zed", state: "usable" }, { profile: "Alpha", state: "usable" }, { profile: "mid", state: "usable" }] })))
      .toEqual({ backend: "claude-code", accounts: ["Alpha", "mid", "zed"], only: null });
  });
  it("only a signed-in account is offered: a signed-out one, or one that cannot be told, is not", () => {
    expect(accountHint(facts({ profiles: [{ profile: "off", state: "not_signed_in" }, { profile: "odd", state: "unknown" }, { profile: "ok", state: "usable" }] })))
      .toEqual({ backend: "claude-code", accounts: ["ok"], only: "ok" });
  });
  it("counter-evidence: no hint when there is nothing to offer, or when the default is not certainly signed out, or the agent has an account", () => {
    expect(accountHint(facts({ profiles: [] }))).toBeNull();
    expect(accountHint(facts({ profiles: [{ profile: "off", state: "not_signed_in" }, { profile: "odd", state: "unknown" }] }))).toBeNull();
    for (const defaultState of ["usable", "unknown", "not_installed", "too_old", undefined] as const) expect(accountHint(facts({ defaultState })), String(defaultState)).toBeNull();
    expect(accountHint(facts({ agent: { backend: "claude-code", profile: "work" } }))).toBeNull();
  });
  it("the folders are read only when the hint could matter", () => {
    const read = vi.fn(() => [{ profile: "work", state: "usable" as State }]);
    accountHint(facts({ agent: { backend: "claude-code", profile: "mine" }, profiles: read }));
    accountHint(facts({ defaultState: "usable", profiles: read }));
    accountHint(facts({ defaultState: undefined, profiles: read }));
    expect(read).not.toHaveBeenCalled();
    accountHint(facts({ profiles: read }));
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("the words name the CLI, the agent and the account(s), and say where to choose", () => {
    const one = accountHintText({ backend: "claude-code", accounts: ["work"], only: "work" }, "dev", accountHintLabel("claude-code"));
    expect(one).toBe("Claude Code is not signed in on this host, and dev uses no account of its own, so it cannot start. The Claude Code account work is signed in: choose one for dev in its settings (Details → Runtime → Account).");
    const many = accountHintText({ backend: "codex", accounts: ["a", "b"], only: null }, "gpt", accountHintLabel("codex"));
    expect(many).toContain("These Codex accounts are signed in: a, b");
    expect(many).not.toContain("undefined");
    expect(accountHintLabel("some-new-cli")).toBe("some-new-cli");
  });
});

const dirs: string[] = [];
const managers: FleetManager[] = [];
afterEach(() => {
  for (const fm of managers.splice(0)) (fm as unknown as { stopCliEnvProbes(): void }).stopCliEnvProbes();
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A fleet with a claude-code agent on nothing (`dev`), one with its own account (`own`), a codex agent (`gpt`), a Windows one (`win`); one signed-in and one signed-out profile of each CLI. */
function fixture(fleetDefault = "") {
  const dir = mkdtempSync(join(tmpdir(), "agend-account-hint-")); dirs.push(dir);
  const work = join(dir, "w"); mkdirSync(work);
  const path = join(dir, "fleet.yaml");
  writeFileSync(path, [
    "defaults:", "  backend: claude-code", ...(fleetDefault ? ["  backend_options:", "    claude-code:", `      credential_profile: ${fleetDefault}`] : []),
    "instances:",
    `  dev:\n    working_directory: ${work}`,
    `  own:\n    working_directory: ${work}\n    backend_options:\n      claude-code:\n        credential_profile: work`,
    `  gpt:\n    backend: codex\n    working_directory: ${work}`,
    `  win:\n    runtime: windows\n    machine_id: m1\n    working_directory: C:\\\\w`,
  ].join("\n") + "\n");
  const claude = join(dir, "credential-profiles", "claude-code");
  mkdirSync(join(claude, "work"), { recursive: true }); mkdirSync(join(claude, "off"), { recursive: true });
  writeFileSync(join(claude, "work", ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "00000000-0000-4000-8000-000000000001" } }));
  writeFileSync(join(claude, "work", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "c".repeat(32), refreshToken: "c".repeat(32), expiresAt: Date.now() + 86_400_000 } }));
  const codex = join(dir, "credential-profiles", "codex");
  mkdirSync(join(codex, "team"), { recursive: true }); mkdirSync(join(codex, "idle"), { recursive: true });
  writeFileSync(join(codex, "team", "auth.json"), JSON.stringify({ tokens: { access_token: "t".repeat(24) } }));
  const fm = new FleetManager(dir); managers.push(fm);
  fm.loadConfig(path);
  const signedOut = (backend: string) => ({ backend, state: "not_signed_in", signIn: true }) as SignInTarget;
  const states = (m: Record<string, State>) => vi.spyOn(fm, "backendSignInTargets").mockReturnValue(Object.entries(m).map(([backend, state]) => ({ ...signedOut(backend), state })));
  return { dir, fm, states };
}

describe("the facts of a real fleet", () => {
  it("an agent on no account, with the default sign-in signed out and an account signed in: the hint, for Claude Code and for Codex", () => {
    const { fm, states } = fixture();
    states({ "claude-code": "not_signed_in", codex: "not_signed_in" });
    expect(fm.accountHintFor("dev")).toEqual({ backend: "claude-code", accounts: ["work"], only: "work" });
    expect(fm.accountHintFor("gpt")).toEqual({ backend: "codex", accounts: ["team"], only: "team" });
    expect(fm.accountHintText("dev")).toContain("Claude Code is not signed in on this host, and dev uses no account of its own");
  });
  it("counter-evidence: an agent with an account, a Windows agent, an unknown name, a signed-in default, a fleet default with an account: none", () => {
    const { fm, states } = fixture();
    states({ "claude-code": "not_signed_in", codex: "not_signed_in" });
    expect(fm.accountHintFor("own")).toBeNull();            // names `work` itself
    expect(fm.accountHintFor("win")).toBeNull();            // a paired computer's own sign-in, never this host's
    expect(fm.accountHintFor("nobody")).toBeNull();
    expect(fm.accountHintText("own")).toBeNull();
    states({ "claude-code": "usable", codex: "usable" });
    expect(fm.accountHintFor("dev")).toBeNull();            // the default works
    expect(fm.accountHintFor("gpt")).toBeNull();
    const withDefault = fixture("work");
    withDefault.states({ "claude-code": "not_signed_in" });
    expect(withDefault.fm.accountHintFor("dev")).toBeNull(); // the fleet default names an account: dev follows it
  });
  it("a CLI with no signed-in account of its own on disk: none (nothing to offer)", () => {
    const { fm, states, dir } = fixture();
    rmSync(join(dir, "credential-profiles", "codex", "team"), { recursive: true });
    states({ "claude-code": "not_signed_in", codex: "not_signed_in" });
    expect(fm.accountHintFor("gpt")).toBeNull();
    expect(fm.accountHintFor("dev")).not.toBeNull();
  });
});
