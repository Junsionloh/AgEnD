/**
 * AGEND-124: named Antigravity accounts and sign-out on a paired Windows computer. The REAL Runtime side (`RemoteAccounts`, the profile folders, the ownership record) with a fake CLI process and fixture
 * data only: no token, no account, no real `agy` (the real-computer measurements are in the issue). What is locked here:
 *  - an account is a folder this Runtime made, and every launch of it (sign-in, status, an agent) names that folder (`--app_data_dir`, relative to the CLI's home) and carries the registry's `pin`;
 *  - a named sign-in never starts before an EMPTY scratch folder has answered "signed out" (else `not_isolated`, nothing started, no folder made);
 *  - a named account's sign-out removes its token file inside the verified folder and asks the CLI; the computer's own login is signed out through the Credential Manager entry the REGISTRY names;
 *  - the local `accounts` switch, one-at-a-time, the pace and the audit record apply, and only the Runtime's own accounts can be touched.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, win32 } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUDIT_FILE, setRemoteSwitch } from "../src/runtime-remote-setup.js";
import { ISOLATION_SCRATCH, PROFILE_OP_MIN_GAP_MS } from "../src/runtime-remote-accounts.js";
import { CREDENTIAL_PROFILE_CLIS, credentialProfileLaunch, credentialProfileReport, credentialProfileStore, parseCredentialProfileReport, withCredentialProfile } from "../src/runtime-credential-profiles.js";
import { buildAccountsView } from "../src/accounts-view.js";
import { probeCredentialIsolation, probeCredentialProfileStatus } from "../src/windows-cli-worker.js";
import { AGY_CODE, AGY_SCREEN, ACTOR, ID, cleanScratch, runtimeRig, scratch, waitFor, type Rig } from "./helpers/machine-runtime.js";

afterEach(() => cleanScratch());
const TOKEN = "antigravity-oauth-token";
const PIN = { SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 0" };
const audit = (f: Rig) => (existsSync(join(f.pairing, AUDIT_FILE)) ? readFileSync(join(f.pairing, AUDIT_FILE), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : []);
const agyDir = (f: Rig, name: string) => join(f.root, "antigravity", name);
/** A rig whose Runtime can prove isolation (its scratch folder answers "signed out"). */
const proven = (extra: Parameters<typeof runtimeRig>[0] = {}) => { const isolated = vi.fn(async () => true); return { f: runtimeRig({ agy: true, isolated, ...extra }), isolated }; };

describe("how a named Antigravity account is launched", () => {
  const home = win32.join("C:\\", "Users", "ada", ".gemini");
  it("is `--app_data_dir <folder relative to the CLI's home>` with the registry's pin, and replaces an ambient value of the pinned variable whatever its letter case", () => {
    const launch = credentialProfileLaunch({ PATH: "p", ssh_connection: "10.0.0.1 22 10.0.0.2 22", KEEP: "1" }, "antigravity", win32.join("C:\\", "Users", "ada", "agend-runtime", "credential-profiles", "antigravity", "work"), home, win32);
    expect(launch.args).toEqual(["--app_data_dir", "..\\agend-runtime\\credential-profiles\\antigravity\\work"]);
    expect(launch.env).toEqual({ PATH: "p", KEEP: "1", ...PIN });
    expect(Object.keys(launch.env).filter(key => key.toUpperCase() === "SSH_CONNECTION")).toEqual(["SSH_CONNECTION"]);
  });
  it("is refused when the folder is on another drive than the CLI's home (there is no relative path), before anything starts", () => {
    expect(() => credentialProfileLaunch({}, "antigravity", win32.join("D:\\", "agend", "credential-profiles", "antigravity", "work"), home, win32)).toThrow(/not on the same drive/);
  });
  it("keeps Claude Code's variable launch as it was (a variable and no arguments), and an environment alone is never a launch of an argument-based CLI", () => {
    expect(credentialProfileLaunch({ PATH: "p" }, "claude-code", "C:\\profiles\\work")).toEqual({ env: { PATH: "p", CLAUDE_CONFIG_DIR: "C:\\profiles\\work" }, args: [] });
    expect(() => withCredentialProfile({}, "antigravity", "C:\\profiles\\work")).toThrow(/by an argument/);
    expect(credentialProfileStore("antigravity")).toBe(TOKEN); expect(credentialProfileStore("claude-code")).toBeUndefined();
    expect(CREDENTIAL_PROFILE_CLIS.antigravity).toEqual({ arg: "--app_data_dir", store: TOKEN, pin: PIN });
  });
});

describe("what a computer reports about its accounts", () => {
  it("keeps Claude Code's where they always were and Antigravity's under `byCli`, only when it has any", () => {
    const f = runtimeRig({ created: ["a"], agyCreated: ["work"] });
    const report = credentialProfileReport(f.root, undefined, () => true);
    expect(report.profiles.map(p => p.name)).toEqual(["a"]); expect(report.byCli).toEqual({ antigravity: [{ name: "work", loggedIn: null, created: true }] });
    expect(credentialProfileReport(runtimeRig({ created: ["a"] }).root).byCli).toBeUndefined();
    expect(parseCredentialProfileReport(JSON.parse(JSON.stringify(report)))).toEqual(report);
  });
  it("accepts nothing else under `byCli`: not Claude Code's own list, not a CLI without accounts, not a malformed row", () => {
    const row = { name: "work", loggedIn: true };
    for (const bad of [{ "claude-code": [row] }, { codex: [row] }, { antigravity: "work" }, { antigravity: [{ name: "a/b", loggedIn: true }] }, { antigravity: [row, { name: "WORK", loggedIn: false }] }, { antigravity: [{ ...row, extra: 1 }] }, [row]])
      expect(() => parseCredentialProfileReport({ profiles: [], byCli: bad }), JSON.stringify(bad)).toThrow(/Invalid credential profile report/);
    expect(parseCredentialProfileReport({ profiles: [], byCli: { antigravity: [row] } }).byCli).toEqual({ antigravity: [row] });
  });
});

describe("the status probe and the isolation probe of the Windows worker", () => {
  const exe = { path: "agy.exe", command: "agy.exe", args: [] as string[] };
  it("asks `agy --app_data_dir <folder> models` under the account's launch and reads the listing's own words: signed in, signed out, or unknown", async () => {
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const answer = (ok: boolean, text: string) => async (_e: unknown, args: string[], env: NodeJS.ProcessEnv) => { calls.push({ args, env }); return { ok, text }; };
    const dir = join(scratch(), "work");
    expect((await probeCredentialProfileStatus("antigravity", dir, async () => exe, answer(true, "gemini-3-pro  Gemini 3 Pro\n"))).loggedIn).toBe(true);
    expect((await probeCredentialProfileStatus("antigravity", dir, async () => exe, answer(false, "Please sign in to view available models"))).loggedIn).toBe(false);
    expect((await probeCredentialProfileStatus("antigravity", dir, async () => exe, answer(false, "network is unreachable"))).loggedIn).toBeNull();
    expect(calls[0]!.args[0]).toBe("--app_data_dir"); expect(calls[0]!.args.at(-1)).toBe("models"); expect(calls[0]!.env.SSH_CONNECTION).toBe(PIN.SSH_CONNECTION);
  });
  it("proves isolation only from an explicit \"signed out\" for an empty scratch folder (asked once more when it said nothing), and removes the scratch folder", async () => {
    const root = scratch(), seen: string[] = [];
    const run = (text: string, ok = false) => async (_e: unknown, args: string[]) => { seen.push(args[1]!); return { ok, text }; };
    expect(await probeCredentialIsolation("antigravity", root, async () => exe, run("Please sign in to view available models"))).toBe(true);
    expect(seen).toHaveLength(1); expect(readdirSync(root)).toEqual([]);                     // removed
    seen.length = 0;
    expect(await probeCredentialIsolation("antigravity", root, async () => exe, run("gemini-3-pro  Gemini 3 Pro", true))).toBe(false);   // signed in under an empty folder: the keyring answered, not the folder
    expect(await probeCredentialIsolation("antigravity", root, async () => exe, run("boom"))).toBe(false);                                   // could not tell, twice
    expect(seen.length).toBe(3);
    expect(await probeCredentialIsolation("antigravity", root, async () => null, run("Please sign in"))).toBe(false);                         // no CLI to ask
  });
});

describe("a named Antigravity account's sign-in on the computer", () => {
  it("is never started before the isolation proof: no proof or a failed proof each leave nothing started and no folder made", async () => {
    const none = runtimeRig({ agy: true });                                            // a Runtime with no probe at all
    await expect(none.runtime.handle("signin.start", { cli: "antigravity", profile: "work", method: "subscription", actor: ACTOR })).rejects.toThrow(/^not_isolated:/);
    const no = proven(); no.isolated.mockResolvedValue(false);
    await expect(no.f.runtime.handle("signin.start", { cli: "antigravity", profile: "work", method: "subscription", actor: ACTOR })).rejects.toThrow(/^not_isolated:/);
    for (const f of [none, no.f]) { expect(f.spawned).toHaveLength(0); expect(existsSync(agyDir(f, "work"))).toBe(false); }
    expect(audit(no.f).filter(r => r.cli === "antigravity").map(r => [r.action, r.outcome, r.reason])).toEqual([["signin", "refused", "not_isolated"]]);
    await none.stop(); await no.f.stop();
  });
  it("asks an EMPTY scratch folder under the Runtime's own folder (never an account's, never a listed one), then starts `agy --app_data_dir <folder> acp --login` with the pin; the folder is made and recorded", async () => {
    const { f, isolated } = proven();
    const { sessionId } = await f.runtime.handle("signin.start", { cli: "antigravity", profile: "work", method: "subscription", actor: ACTOR }) as { sessionId: string };
    expect(isolated).toHaveBeenCalledTimes(1);
    const [cli, scratchRoot] = isolated.mock.calls[0] as unknown as [string, string];
    expect(cli).toBe("antigravity"); expect(scratchRoot).toBe(join(f.pairing, ISOLATION_SCRATCH)); expect(scratchRoot.startsWith(f.root)).toBe(false);
    expect(f.spawned).toHaveLength(1);
    const args = [...f.spawned[0]!.args];
    expect(args.slice(0, 1)).toEqual(["--app_data_dir"]); expect(args.slice(2)).toEqual(["acp", "--login"]);
    expect(args[1]!.replace(/\\/g, "/").endsWith("credential-profiles/antigravity/work")).toBe(true);   // relative to the CLI's own home, ending in the account's folder
    expect(f.spawned[0]!.env).toMatchObject(PIN);
    expect(lstatSync(agyDir(f, "work")).isDirectory()).toBe(true);
    expect(f.runtime.signInProfile()).toBe("work");
    expect(audit(f).filter(r => r.cli === "antigravity").map(r => [r.action, r.outcome])).toEqual([["signin", "started"], ["profile.add", "ok"]]);
    await f.runtime.handle("signin.close", { sessionId }); await f.stop();
  });
  it("is the same sign-in the dashboard drives: the link and the code box, a code, then the CLI's own status says it worked (a Claude account of the same name is another account)", async () => {
    const { f } = proven({ created: ["work"] });
    f.answer({ loggedIn: false });
    await f.signIns.begin(f.owner, f.agyNamed("work"));
    f.children[0]!.say(AGY_SCREEN);
    await waitFor(() => expect(f.signIns.snapshot(f.owner, f.agyNamed("work")).login?.phase).toBe("code"));
    f.answer({ loggedIn: true });
    const login = f.signIns.snapshot(f.owner, f.agyNamed("work")).login!;
    await f.signIns.input(f.owner, f.agyNamed("work"), login.id, login.revision, { kind: "code", value: AGY_CODE });
    expect(f.children[0]!.written).toBe(`${AGY_CODE}\n`);
    f.children[0]!.end(0);
    await waitFor(() => expect(f.signIns.snapshot(f.owner, f.agyNamed("work")).login?.phase).toBe("done"));
    expect(f.sent.map(s => s.operation)).toContain("accounts.check");
    expect(f.sent.find(s => s.operation === "signin.start")!.payload).toEqual({ cli: "antigravity", profile: "work", method: "subscription", actor: ACTOR });
    expect(f.events.at(-1)).toMatchObject({ backend: "antigravity", profile: "work", phase: "done" });
    await f.stop();
  });
  it("a refusal to prove isolation reaches the dialog as `not_isolated`, not as a transport failure, and nothing was started", async () => {
    const f = runtimeRig({ agy: true });
    await f.signIns.begin(f.owner, f.agyNamed("work"));
    await waitFor(() => expect(f.signIns.snapshot(f.owner, f.agyNamed("work")).login).toMatchObject({ phase: "failed", reason: "not_isolated" }));
    expect(f.spawned).toHaveLength(0); expect(existsSync(agyDir(f, "work"))).toBe(false);
    await f.stop();
  });
  it("is refused by an older Runtime (no `accounts-antigravity`) before it is asked, and by the owner's switch; the computer's own login keeps working on the older one", async () => {
    const old = runtimeRig({ agy: { accounts: false } });
    await expect(old.signIns.begin(old.owner, old.agyNamed("work"))).rejects.toThrow("machine_unsupported");
    await old.signIns.begin(old.owner, old.agyTarget);                                  // AGEND-113: still possible
    expect(old.sent.map(s => s.operation)).toContain("signin.start");
    const off = proven({ switchOn: false });
    await expect(off.f.signIns.begin(off.f.owner, off.f.agyNamed("work"))).rejects.toThrow("machine_accounts_off");
    await expect(off.f.runtime.handle("signin.start", { cli: "antigravity", profile: "work", method: "subscription", actor: ACTOR })).rejects.toThrow(/turned off/);
    expect(off.isolated).not.toHaveBeenCalled(); expect(off.f.spawned).toHaveLength(0);
    await old.stop(); await off.f.stop();
  });
  it("only a subscription sign-in, one at a time on the whole computer (a default sign-in blocks a named one), and never a folder this Runtime did not make", async () => {
    const { f } = proven({ agyCreated: ["made"] });
    await expect(f.runtime.handle("signin.start", { cli: "antigravity", profile: "work", method: "console", actor: ACTOR })).rejects.toThrow(/Only a subscription sign-in/);
    const first = await f.runtime.handle("signin.start", { cli: "antigravity", method: "subscription", actor: ACTOR }) as { sessionId: string };
    await expect(f.runtime.handle("signin.start", { cli: "antigravity", profile: "made", method: "subscription", actor: ACTOR })).rejects.toThrow(/Another sign-in/);
    await f.runtime.handle("signin.close", { sessionId: first.sessionId });
    f.tick(10_000);
    mkdirSync(agyDir(f, "byhand"), { recursive: true });
    await expect(f.runtime.handle("signin.start", { cli: "antigravity", profile: "byhand", method: "subscription", actor: ACTOR })).rejects.toThrow(/not created by this Runtime/);
    await f.stop();
  });
});

describe("a named Antigravity account's check, sign-out and removal", () => {
  const plant = (f: Rig, name: string) => { mkdirSync(agyDir(f, name), { recursive: true }); writeFileSync(join(agyDir(f, name), TOKEN), "FIXTURE-NOT-A-TOKEN"); writeFileSync(join(agyDir(f, name), "conversations.db"), "kept"); };
  it("a check asks the CLI under that account's folder and records the answer under Antigravity (and not under a Claude account of the same name)", async () => {
    const seen: string[] = [];
    const f = runtimeRig({ agy: true, agyCreated: ["work"], created: ["work"], status: async (cli, directory) => { seen.push(`${cli}:${directory}`); return { loggedIn: cli === "antigravity" }; } });
    expect(await f.runtime.handle("accounts.check", { cli: "antigravity", profile: "work" })).toEqual({ loggedIn: true });
    expect(seen).toEqual([`antigravity:${agyDir(f, "work")}`]);
    expect(JSON.parse(readFileSync(join(f.root, "status.json"), "utf8")).checkedAt).toEqual({ antigravity: { work: expect.objectContaining({ loggedIn: true }) } });
    await f.stop();
  });
  it("sign-out removes the token file (only that file, only in the verified folder), asks the CLI, and keeps the conversations", async () => {
    const f = runtimeRig({ agy: true, agyCreated: ["work"] });
    plant(f, "work");
    f.answer({ loggedIn: false });
    expect(await f.runtime.handle("accounts.signout", { cli: "antigravity", profile: "work", actor: ACTOR })).toEqual({ loggedIn: false });
    expect(existsSync(join(agyDir(f, "work"), TOKEN))).toBe(false); expect(readFileSync(join(agyDir(f, "work"), "conversations.db"), "utf8")).toBe("kept");
    expect(readdirSync(join(f.root, "antigravity"))).toEqual(["work"]);                  // put back under its own name, no temporary folder left
    expect(audit(f).filter(r => r.action === "profile.signout").map(r => [r.cli, r.profile, r.outcome])).toEqual([["antigravity", "work", "started"], ["antigravity", "work", "ok"]]);
    await f.stop();
  });
  it("says so when the CLI still reports a sign-in afterwards (a login kept somewhere else is not signed out), and a token file that is a link is never followed", async () => {
    const f = runtimeRig({ agy: true, agyCreated: ["work", "linked"] });
    plant(f, "work"); f.answer({ loggedIn: true });
    await expect(f.runtime.handle("accounts.signout", { cli: "antigravity", profile: "work", actor: ACTOR })).rejects.toThrow(/still signed in after sign-out/);
    f.tick(PROFILE_OP_MIN_GAP_MS + 1);
    const outside = join(scratch(), "outside.txt"); writeFileSync(outside, "mine");
    try { symlinkSync(outside, join(agyDir(f, "linked"), TOKEN)); } catch { await f.stop(); return; }   // a system that cannot make a link here has nothing to prove
    await expect(f.runtime.handle("accounts.signout", { cli: "antigravity", profile: "linked", actor: ACTOR })).rejects.toThrow();
    expect(readFileSync(outside, "utf8")).toBe("mine"); expect(lstatSync(join(agyDir(f, "linked"), TOKEN)).isSymbolicLink()).toBe(true);
    await f.stop();
  });
  it("is refused for an account this Runtime did not make, while an agent or a terminal uses it, and in a hurry; the owner's switch decides first", async () => {
    let using: "task" | undefined;
    const f = runtimeRig({ agy: true, agyCreated: ["work"] });
    const deps = (f.runtime as unknown as { deps: { inUse: () => unknown; inUseNow: () => unknown } }).deps;
    deps.inUse = () => using; deps.inUseNow = () => using;
    mkdirSync(agyDir(f, "byhand"), { recursive: true });
    await expect(f.runtime.handle("accounts.signout", { cli: "antigravity", profile: "byhand", actor: ACTOR })).rejects.toThrow(/not created by this Runtime/);
    using = "task";
    await expect(f.runtime.handle("accounts.signout", { cli: "antigravity", profile: "work", actor: ACTOR })).rejects.toThrow(/in use by a running task/);
    using = undefined; plant(f, "work"); f.answer({ loggedIn: false });
    await f.runtime.handle("accounts.signout", { cli: "antigravity", profile: "work", actor: ACTOR });
    await expect(f.runtime.handle("accounts.signout", { cli: "antigravity", profile: "work", actor: ACTOR })).rejects.toThrow(/just changed/);
    setRemoteSwitch(f.pairing, "accounts", false, undefined, Date.now());
    await expect(f.runtime.handle("accounts.signout", { cli: "antigravity", profile: "work", actor: ACTOR })).rejects.toThrow(/turned off/);
    await f.stop();
  });
  it("removal deletes the whole folder and its record; a Claude Code default profile of the same name does not hold it back, and an Antigravity account has no default", async () => {
    const f = runtimeRig({ agy: true, agyCreated: ["work"], created: ["work"], defaultProfile: () => "work" });
    plant(f, "work");
    expect(await f.runtime.handle("accounts.remove", { cli: "antigravity", profile: "work", actor: ACTOR })).toEqual({ removed: true });
    expect(existsSync(agyDir(f, "work"))).toBe(false); expect(existsSync(join(f.root, "claude-code", "work"))).toBe(true);
    f.tick(PROFILE_OP_MIN_GAP_MS + 1);
    await expect(f.runtime.handle("accounts.remove", { cli: "claude-code", profile: "work", actor: ACTOR })).rejects.toThrow(/default for agents/);
    await f.stop();
  });
});

describe("signing the computer's OWN Antigravity login out", () => {
  const credentialRig = (extra: Parameters<typeof runtimeRig>[0] = {}) => { const deleted: string[] = []; const f = runtimeRig({ agy: true, deleteCredential: async name => { deleted.push(name); return 0; }, ...extra }); return { f, deleted }; };
  it("deletes the Credential Manager entry THE REGISTRY names (never one from the request), then asks `agy models`, and records it as its own action", async () => {
    const { f, deleted } = credentialRig(); f.agyAnswer(false);
    expect(await f.runtime.handle("accounts.signout", { cli: "antigravity", actor: ACTOR })).toEqual({ loggedIn: false });
    expect(deleted).toEqual(["gemini:antigravity"]);
    expect(audit(f).filter(r => r.cli === "antigravity").map(r => [r.action, r.outcome, "profile" in r])).toEqual([["login.signout", "started", false], ["login.signout", "ok", false]]);
    await f.stop();
  });
  it("reports a login that is still there afterwards (the CLI keeps it elsewhere), and the entry is not asked for again at once", async () => {
    const { f, deleted } = credentialRig(); f.agyAnswer(true);
    await expect(f.runtime.handle("accounts.signout", { cli: "antigravity", actor: ACTOR })).rejects.toThrow(/still signed in on this computer/);
    await expect(f.runtime.handle("accounts.signout", { cli: "antigravity", actor: ACTOR })).rejects.toThrow(/just signed out/);
    expect(deleted).toHaveLength(1);
    await f.stop();
  });
  it("is refused while a task runs on the computer, while a sign-in is open, when the switch is off, and for a CLI that has no login of its own", async () => {
    let running = true;
    const { f, deleted } = credentialRig({ taskRunning: () => running }); f.agyAnswer(false);
    await expect(f.runtime.handle("accounts.signout", { cli: "antigravity", actor: ACTOR })).rejects.toThrow(/A task is running on this computer/);
    running = false;
    const open = await f.runtime.handle("signin.start", { cli: "antigravity", method: "subscription", actor: ACTOR }) as { sessionId: string };
    await expect(f.runtime.handle("accounts.signout", { cli: "antigravity", actor: ACTOR })).rejects.toThrow(/A sign-in is running|Another sign-in/);
    await f.runtime.handle("signin.close", { sessionId: open.sessionId });
    await expect(f.runtime.handle("accounts.signout", { cli: "claude-code", actor: ACTOR })).rejects.toThrow(/names the credential profile/);
    await expect(f.runtime.handle("accounts.signout", { cli: "codex", actor: ACTOR })).rejects.toThrow(/Only Claude Code and Antigravity accounts/);
    setRemoteSwitch(f.pairing, "accounts", false, undefined, Date.now());
    await expect(f.runtime.handle("accounts.signout", { cli: "antigravity", actor: ACTOR })).rejects.toThrow(/turned off/);
    expect(deleted).toEqual([]);
    await f.stop();
  });
  it("is not possible on a Runtime that was not given the means (no Credential Manager call)", async () => {
    const f = runtimeRig({ agy: true });
    await expect(f.runtime.handle("accounts.signout", { cli: "antigravity", actor: ACTOR })).rejects.toThrow(/cannot sign this computer's own login out/);
    await f.stop();
  });
});

describe("the Accounts page for a computer's Antigravity", () => {
  const view = async (f: Rig) => buildAccountsView({ targets: [], diskProfiles: new Map(), agents: [], classic: [], fleetDefaults: new Map(), machines: await f.accounts.list() });
  const rows = async (f: Rig) => (await view(f)).clis.find(c => c.backend === "antigravity")!.rows;
  const reason = (r: Awaited<ReturnType<typeof rows>>[number]) => (r.scope.kind === "machine" && r.scope.readOnlyReason ? r.scope.readOnlyReason : "");
  it("has the computer's own login first (signed in and out from here), then each account the Runtime made, each with its own Sign in, Sign out and Remove", async () => {
    const f = runtimeRig({ agy: { authenticated: true }, agyCreated: ["work"] });
    f.reportAgy([{ name: "work", loggedIn: true, created: true }, { name: "byhand", loggedIn: false, created: false }]);
    const all = await rows(f);
    expect(all.map(r => [r.profile, r.state, r.signIn, r.signOutOwn === true, reason(r)])).toEqual([
      [null, "usable", true, true, ""], ["byhand", "not_signed_in", false, false, "not_created"], ["work", "usable", true, false, ""]]);
    expect(all.find(r => r.profile === "byhand")).not.toHaveProperty("hostCommand");   // an Antigravity account has no command to run at that computer
    expect((await view(f)).clis.find(c => c.backend === "antigravity")!.machineProfiles).toBe(true);
    await f.stop();
  });
  it("shows the accounts but offers nothing on them when the Runtime is older, the CLI is old, or the owner's switch is off — each with its code, and no Add", async () => {
    const old = runtimeRig({ agy: { accounts: false } }); old.reportAgy([{ name: "work", loggedIn: true, created: true }]);
    const oldRows = await rows(old);
    expect(oldRows[0]).toMatchObject({ profile: null, signIn: true }); expect(oldRows[0]).not.toHaveProperty("signOutOwn");
    expect(oldRows[0]!.scope).toMatchObject({ namedAccounts: false });
    expect(oldRows[1]).toMatchObject({ profile: "work", signIn: false, scope: { readOnlyReason: "runtime_old", namedAccounts: false } });
    const cliOld = runtimeRig({ agy: { version: "1.4.9" } }); cliOld.reportAgy([{ name: "work", loggedIn: true, created: true }]);
    expect((await rows(cliOld)).map(r => [r.profile, r.signIn, reason(r)])).toEqual([[null, false, "cli_old"], ["work", false, "cli_old"]]);
    const off = runtimeRig({ agy: true, switchOn: false }); off.reportAgy([{ name: "work", loggedIn: true, created: true }]);
    expect((await rows(off)).every(r => !r.signIn && reason(r) === "accounts_off")).toBe(true);
    await old.stop(); await cliOld.stop(); await off.stop();
  });
  it("puts an agent on the account it names, and the agents that name none on the computer's own login", async () => {
    const f = runtimeRig({ agy: true, agyCreated: ["work"] });
    const deps = (f.accounts as unknown as { deps: { agents: (id: string, backend?: string) => unknown } }).deps;
    deps.agents = (_id, backend) => (backend === "antigravity" ? [{ name: "ada", profile: "work" }, { name: "bob", profile: null }] : []);
    f.reportAgy([{ name: "work", loggedIn: true, created: true }]);
    const all = await rows(f);
    expect(all.map(r => [r.profile, r.usedBy.agents])).toEqual([[null, ["bob"]], ["work", ["ada"]]]);
    await f.stop();
  });
});

describe("the server's side of Sign out and Remove for a computer's Antigravity", () => {
  it("signs a named account out and removes it through the Runtime, as that CLI's own operation, and remembers the change until the next inventory", async () => {
    const f = runtimeRig({ agy: true, agyCreated: ["work"] });
    mkdirSync(agyDir(f, "work"), { recursive: true }); writeFileSync(join(agyDir(f, "work"), TOKEN), "x");
    f.reportAgy([{ name: "work", loggedIn: true, created: true }]);
    f.answer({ loggedIn: false });
    expect(await f.accounts.signOut("antigravity", "work", true, ID, f.who, "tester")).toEqual({ ok: true });
    expect(f.sent.at(-1)).toEqual({ operation: "accounts.signout", payload: { cli: "antigravity", profile: "work", actor: ACTOR } });
    expect(f.accounts.profileState(ID, "work", "antigravity")).toMatchObject({ state: "invalid" });
    expect(f.accounts.profileState(ID, "work")).toMatchObject({ exists: false });        // not a Claude account of that name
    f.tick(PROFILE_OP_MIN_GAP_MS + 1);
    expect(await f.accounts.remove("antigravity", "work", "work", ID, f.who, "tester")).toEqual({ ok: true });
    expect(f.sent.at(-1)!.payload).toEqual({ cli: "antigravity", profile: "work", actor: ACTOR });
    expect(f.accounts.profileState(ID, "work", "antigravity").exists).toBe(false);
    await f.stop();
  });
  it("signs the computer's own login out when the name is null — Antigravity's only, never Claude Code's — and the page reads it as signed out", async () => {
    const deleted: string[] = [];
    const f = runtimeRig({ agy: { authenticated: true }, deleteCredential: async name => { deleted.push(name); return 0; } }); f.agyAnswer(false);
    expect(await f.accounts.signOut("claude-code", null, true, ID, f.who, "t")).toEqual({ ok: false, error: "machine_default_login" });
    expect(await f.accounts.signOut("antigravity", null, false, ID, f.who, "t")).toEqual({ ok: false, error: "confirm" });
    expect(await f.accounts.signOut("antigravity", null, true, ID, f.who, "t")).toEqual({ ok: true });
    expect(deleted).toEqual(["gemini:antigravity"]); expect(f.sent.at(-1)!.payload).toEqual({ cli: "antigravity", actor: ACTOR });
    expect(f.accounts.reportedDefault(ID, "antigravity")).toBe("invalid");
    await f.stop();
  });
  it("refuses on the server before the computer is asked to change anything: a Runtime without the capability, an unreported or not-ours account", async () => {
    const old = runtimeRig({ agy: { accounts: false } });
    expect(await old.accounts.signOut("antigravity", null, true, ID, old.who, "t")).toMatchObject({ ok: false, error: "machine_unsupported" });
    expect(await old.accounts.add("antigravity", "work", ID, "t")).toMatchObject({ ok: false, error: "machine_unsupported" });
    expect(old.sent).toEqual([]);
    const f = runtimeRig({ agy: true }); f.reportAgy([{ name: "byhand", loggedIn: false, created: false }]);
    expect(await f.accounts.signOut("antigravity", "missing", true, ID, f.who, "t")).toMatchObject({ ok: false, error: "missing" });
    expect(await f.accounts.signOut("antigravity", "byhand", true, ID, f.who, "t")).toMatchObject({ ok: false, error: "machine_profile_not_owned" });
    expect(await f.accounts.remove("antigravity", "byhand", "byhand", ID, f.who, "t")).toMatchObject({ ok: false, error: "machine_profile_not_owned" });
    expect(await f.accounts.add("antigravity", "byhand", ID, "t")).toMatchObject({ ok: false, error: "exists" });
    expect(await f.accounts.add("antigravity", "BYHAND", ID, "t")).toMatchObject({ ok: false, error: "case_clash", clash: "byhand" });
    expect(await f.accounts.add("antigravity", "fresh", ID, "t")).toEqual({ ok: true });
    expect(f.sent.every(s => s.operation === "accounts.switches")).toBe(true);          // only the owner's switch was read
    await old.stop(); await f.stop();
  });
});
