/**
 * #3190 Part 3c: signing a credential profile in on a paired computer from Settings → Accounts. The server's `MachineSignIns` (#3212's StructuredSignIn over a
 * RuntimeSignInTransport) is run against the REAL Runtime side (`RemoteAccounts`, 3a) with a fake CLI process, so both ends are held to the same frames:
 * what the server sends is only `{cli, profile, method, actor}` and a sign-in code; what comes back is the reduced screen; an e-mail address, the sign-in link's
 * query and the code never reach a log or an event. Fixtures only (example.com).
 */
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteAccounts, type RemoteAccountsDeps, type RemoteStatusAnswer } from "../src/runtime-remote-accounts.js";
import { credentialProfilesRoot } from "../src/runtime-credential-profiles.js";
import { createRuntimeProfile, requireOwnedProfile } from "../src/runtime-profile-ownership.js";
import { setRemoteSwitch } from "../src/runtime-remote-setup.js";
import { parseRuntimeRemotePayload, type RuntimeMachine } from "../src/runtime-protocol.js";
import { MachineSignIns, type MachineSignInDeps } from "../src/machine-signins.js";
import { MachineAccounts } from "../src/machine-accounts.js";
import { createRuntimeSignInTransport, runtimeAccountStatus, PROFILE_DOES_NOT_EXIST, RUNTIME_SIGNIN_CLIS, type AccountCaller } from "../src/runtime-signin-transport.js";
import { structuredSignInSupported } from "../src/structured-signin.js";

const ID = "11111111-2222-3333-4444-555555555555";
const URL_OK = "https://claude.com/cai/oauth/authorize?code=true&client_id=fixture&response_type=code&state=STATE-NEVER-LOGGED";
const CODE = "SECRETCODE123-abc";
const EMAIL = "ada.lovelace@example.com";
const ACTOR = "admin:0123456789abcdef";
const directories: string[] = [];
const scratch = (): string => { const path = mkdtempSync(join(tmpdir(), "agend-machine-signin-")); directories.push(path); return path; };
afterEach(() => { for (const path of directories.splice(0)) { if (!resolve(path).startsWith(resolve(tmpdir()) + sep)) throw Error("Unexpected fixture path"); rmSync(path, { recursive: true, force: true }); } });

class FakeChild extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough(); pid = 77; exitCode: number | null = null; signalCode: NodeJS.Signals | null = null; killed = false; written = "";
  constructor() { super(); this.stdin.on("data", chunk => { this.written += chunk.toString(); }); }
  say(text: string): void { this.stdout.write(text); }
  end(code: number): void { this.exitCode = code; this.emit("close", code); }
  kill(): boolean { this.killed = true; queueMicrotask(() => { if (this.exitCode === null) this.end(1); }); return true; }
}

/** The real Runtime side, a fake CLI, and the server's side of the transport over a function call instead of a socket. */
function fixture(options: { switchOn?: boolean; created?: string[]; unreachable?: () => boolean } = {}) {
  const pairing = scratch(), root = credentialProfilesRoot(pairing), children: FakeChild[] = [], spawned: Array<{ args: readonly string[]; env: NodeJS.ProcessEnv | undefined }> = [];
  for (const name of options.created ?? []) createRuntimeProfile(root, "claude-code", name);
  let answer: RemoteStatusAnswer = { loggedIn: false };
  let clock = Date.now();                                      // the Runtime's clock: it paces sign-in starts (5 s apart), so a test moves it
  const deps: RemoteAccountsDeps = { pairingDirectory: pairing, credentialRoot: root, now: () => clock, status: async () => answer, find: async () => ({ path: "claude.exe", command: "claude.exe", args: [] }), environment: () => ({ PATH: "p" }),
    runLogout: async () => 0, inUse: () => undefined, inUseNow: () => undefined, defaultProfile: () => undefined, changed: vi.fn(),
    signIn: { scratchRoot: scratch(), spawn: (_c, args, spawnOptions) => { spawned.push({ args, env: spawnOptions.env }); const child = new FakeChild(); children.push(child); queueMicrotask(() => { child.say(`If the browser didn't open, visit: ${URL_OK}\nPaste code here if prompted > `); }); return child as unknown as ChildProcess; } } };
  const runtime = new RemoteAccounts(deps);
  if (options.switchOn !== false) setRemoteSwitch(pairing, "accounts", true, undefined, clock);
  const sent: Array<{ operation: string; payload: any }> = [];
  const replies: unknown[] = [];
  const call: AccountCaller = async (_id, operation, payload) => {
    if (options.unreachable?.()) throw new Error("Runtime machine is offline");
    sent.push({ operation, payload: structuredClone(payload) });
    const input = parseRuntimeRemotePayload(operation, payload);      // the coordinator's own closed check
    const result = await runtime.handle(operation, input);
    replies.push(structuredClone(result)); return result;
  };
  const machine = (): RuntimeMachine => ({ id: ID, name: "Desk PC", platform: "win32", status: "online", createdAt: 1, generation: 1, runtimeInfo: { protocolVersions: [1], capabilities: ["exec", "remote-signin"] },
    inventory: { clis: [], home: "", probedAt: null, credentialProfiles: { profiles: (options.created ?? []).map(name => ({ name, loggedIn: false, created: true })) } } } as RuntimeMachine);
  const accounts = new MachineAccounts({ call, machine: id => (id === ID ? machine() : undefined), machines: () => [machine()], agents: () => [], signingIn: () => false, log: () => {} });
  const events: Array<Record<string, unknown>> = [];
  let live = true;
  const owner = {};
  const signIns = new MachineSignIns({ call, current: who => live && who === owner, reported: (id, profile) => accounts.profileState(id, profile), readiness: id => accounts.readiness(id), actor: () => ACTOR,
    changed: (event, who, launched) => { events.push({ ...event, launched, mine: who === owner }); } } satisfies MachineSignInDeps);
  const target = (profile: string) => ({ machine: ID, profile });
  const view = (profile: string) => signIns.snapshot(owner, target(profile)).login;
  const phase = (profile: string) => signIns.snapshot(owner, target(profile)).login?.phase;
  return { runtime, signIns, owner, pairing, root, children, spawned, sent, replies, events, call, target, view, phase, answer: (value: RemoteStatusAnswer) => { answer = value; }, tick: (ms: number) => { clock += ms; }, end: () => { live = false; },
    stop: async () => { await signIns.close(); await runtime.stop().catch(() => {}); } };
}
type F = ReturnType<typeof fixture>;
const waitFor = (fn: () => void) => vi.waitFor(fn, { timeout: 6000, interval: 25 });

describe("a sign-in on a computer, end to end against the Runtime's side", () => {
  it("Add account: a new name is created and recorded by that computer's Runtime when its first sign-in starts; the dashboard gets the link, sends one code, and reads success from the CLI's own status", async () => {
    const f = fixture();
    await f.signIns.begin(f.owner, f.target("work"));
    await waitFor(() => expect(f.phase("work")).toBe("code"));
    expect(f.view("work")).toMatchObject({ backend: "claude-code", mine: true, url: expect.stringMatching(/^https:\/\/claude\.com\/cai\/oauth\/authorize\?/), canAct: true });
    // The Runtime built the command itself and made the profile (recorded as its own), with the profile's variable and no browser.
    expect(f.spawned).toHaveLength(1); expect(f.spawned[0]!.args).toEqual(["auth", "login", "--claudeai"]);
    expect(f.spawned[0]!.env?.CLAUDE_CONFIG_DIR).toBe(join(f.root, "claude-code", "work")); expect(f.spawned[0]!.env?.BROWSER).toBe("true");
    expect(JSON.parse(readFileSync(join(f.root, "created.json"), "utf8")).created["claude-code"]).toHaveProperty("work");
    const v = f.view("work")!;
    await f.signIns.input(f.owner, f.target("work"), v.id, v.revision, { kind: "code", value: CODE });
    expect(f.children[0]!.written).toBe(`${CODE}\r`);
    // The CLI's success line names the account: only the fixed outcome is what the dashboard's driver reads.
    f.answer({ loggedIn: true, identity: { maskedEmail: "ad***@example.com", plan: "pro" } });
    f.children[0]!.say(`Logged in as ${EMAIL}\n`); f.children[0]!.end(0);
    await waitFor(() => expect(f.phase("work")).toBe("done"));
    const snapshot = f.signIns.snapshot(f.owner, f.target("work"));
    expect(snapshot).toMatchObject({ selected: ["claude-code"], pending: [], skipped: [], states: { "claude-code": "valid" }, ready: true, target: { machine: ID, profile: "work" } });
    expect(JSON.stringify([snapshot, f.events, f.replies.filter(r => typeof r === "object" && r && "screen" in r)])).not.toContain(EMAIL);
    expect(f.events.at(-1)).toMatchObject({ machine: ID, profile: "work", phase: "done", launched: true, mine: true });
    expect(f.signIns.busy(ID)).toBe(false);
    await f.stop();
  });
  it("what the server sends is a closed shape: {cli, profile, method: subscription, actor} to start, the session id for the rest, one code — never an argv, path, command or environment", async () => {
    const f = fixture({ created: ["work"] });
    await f.signIns.begin(f.owner, f.target("work"));
    await waitFor(() => expect(f.phase("work")).toBe("code"));
    const v = f.view("work")!; await f.signIns.input(f.owner, f.target("work"), v.id, v.revision, { kind: "code", value: CODE });
    f.answer({ loggedIn: true }); f.children[0]!.say("Login successful\n"); f.children[0]!.end(0);
    await waitFor(() => expect(f.phase("work")).toBe("done"));
    const start = f.sent.find(s => s.operation === "signin.start")!;
    expect(start.payload).toEqual({ cli: "claude-code", profile: "work", method: "subscription", actor: ACTOR });
    const keys: Record<string, string[]> = {};
    for (const s of f.sent) keys[s.operation] = [...new Set([...(keys[s.operation] ?? []), ...Object.keys(s.payload)])].sort();
    expect(keys).toMatchObject({ "accounts.switches": [], "signin.start": ["actor", "cli", "method", "profile"], "signin.capture": ["sessionId"], "signin.status": ["sessionId"], "signin.write": ["input", "sessionId"], "accounts.check": ["cli", "profile"], "signin.close": ["sessionId"] });
    expect(JSON.stringify(f.sent.filter(s => s.operation !== "signin.write"))).not.toMatch(/CLAUDE_CONFIG_DIR|argv|command|\\\\|cmd\.exe|auth login/);
    expect(f.sent.filter(s => s.operation === "signin.write")).toHaveLength(1);
    await f.stop();
  });
  it("refuses, with a reason and before anything starts, when the owner's switch is off, the computer is offline or too old, the profile is not one its Runtime created, or the name is not a name", async () => {
    const off = fixture({ switchOn: false });
    await expect(off.signIns.begin(off.owner, off.target("work"))).rejects.toThrow("machine_accounts_off"); expect(off.spawned).toHaveLength(0);
    const hand = fixture(); createRuntimeProfile(hand.root, "claude-code", "ours");     // present in the Runtime, but the computer's report below says it was not created
    const unowned = new MachineSignIns({ call: hand.call, current: () => true, reported: () => ({ exists: true, state: "invalid", created: false }), readiness: async () => null, actor: () => ACTOR });
    await expect(unowned.begin({}, { machine: ID, profile: "by-hand" })).rejects.toThrow("machine_profile_not_owned");
    const gone = new MachineSignIns({ call: hand.call, current: () => true, reported: () => ({ exists: false, state: "unknown", created: false }), readiness: async () => "machine_unknown", actor: () => ACTOR });
    await expect(gone.begin({}, { machine: ID, profile: "work" })).rejects.toThrow("machine_unknown");
    for (const bad of ["../x", "C:\\x", "con", "a b", ""]) await expect(off.signIns.begin(off.owner, { machine: ID, profile: bad })).rejects.toThrow("invalid_machine_target");
    await expect(off.signIns.begin(off.owner, { machine: "not-an-id", profile: "work" })).rejects.toThrow("invalid_machine_target");
    expect(hand.spawned).toHaveLength(0);
    const down = fixture({ unreachable: () => true }); await expect(down.signIns.begin(down.owner, down.target("work"))).rejects.toThrow("machine_unreachable");
  });
  it("a profile the Runtime did not create is refused by the Runtime too (a request that skips the dashboard's check)", async () => {
    const f = fixture(); const hand = join(f.root, "claude-code", "by-hand"); (await import("node:fs")).mkdirSync(hand, { recursive: true });
    await expect(f.call(ID, "signin.start", { cli: "claude-code", profile: "by-hand", method: "subscription", actor: ACTOR })).rejects.toThrow(/was not created by this Runtime/);
    expect(f.spawned).toHaveLength(0);
  });
  it("one sign-in per computer: the same profile joins (a refresh or a double click), another is refused as busy, and a Console sign-in cannot be asked for", async () => {
    const f = fixture({ created: ["work", "home"] });
    const first = await f.signIns.begin(f.owner, f.target("work"));
    const again = await f.signIns.begin(f.owner, f.target("WORK"));
    expect(again.login!.id).toBe(first.login!.id); expect(f.spawned).toHaveLength(1);
    await expect(f.signIns.begin(f.owner, f.target("home"))).rejects.toThrow("machine_busy");
    expect(f.sent.filter(s => s.operation === "signin.start").every(s => s.payload.method === "subscription")).toBe(true);
    expect(f.signIns.signingIn(ID, "work")).toBe(true); expect(f.signIns.signingIn(ID, "home")).toBe(false); expect(f.signIns.busy(ID)).toBe(true);
    await f.stop();
  });
  it("a code the CLI rejects ends the attempt as the provider's refusal, with no retry loop of our own; the computer is free again", async () => {
    const f = fixture({ created: ["work"] });
    await f.signIns.begin(f.owner, f.target("work"));
    await waitFor(() => expect(f.phase("work")).toBe("code"));
    const v = f.view("work")!; await f.signIns.input(f.owner, f.target("work"), v.id, v.revision, { kind: "code", value: CODE });
    f.children[0]!.say("\rPaste code here if prompted > Invalid code. Please make sure the full code was copied\n");   // the CLI redraws its prompt line with the verdict on it
    await waitFor(() => expect(f.view("work")).toMatchObject({ phase: "failed", reason: "provider_rejected" }));
    expect(f.children[0]!.killed).toBe(true); expect(f.signIns.busy(ID)).toBe(false);
    await expect(f.signIns.input(f.owner, f.target("work"), v.id, v.revision + 1, { kind: "code", value: CODE })).rejects.toThrow(/signin_action_(?:stale|ended)/);
    await f.stop();
  });
  it("cancel ends exactly that sign-in on that computer, and a new one can start", async () => {
    const f = fixture({ created: ["work"] });
    await f.signIns.begin(f.owner, f.target("work"));
    await waitFor(() => expect(f.phase("work")).toBe("code"));
    const snapshot = await f.signIns.cancel(f.owner, f.target("work"));
    expect(snapshot.login).toMatchObject({ phase: "failed", reason: "cancelled" }); expect(f.children[0]!.killed).toBe(true);
    f.tick(6_000);                                                      // the Runtime starts sign-ins at least 5 s apart
    await f.signIns.begin(f.owner, f.target("work")); expect(f.spawned).toHaveLength(2);
    await f.stop();
  });
  it("only the admin session that started it may see, answer or cancel it; once that session is gone nothing is accepted", async () => {
    const f = fixture({ created: ["work"] });
    await f.signIns.begin(f.owner, f.target("work"));
    await waitFor(() => expect(f.phase("work")).toBe("code"));
    const v = f.view("work")!, stranger = {};
    expect(() => f.signIns.snapshot(stranger, f.target("work"))).toThrow("signin_session_expired");
    await expect(f.signIns.input(stranger, f.target("work"), v.id, v.revision, { kind: "code", value: CODE })).rejects.toThrow("signin_session_expired");
    await expect(f.signIns.cancel(stranger, f.target("work"))).rejects.toThrow("signin_session_expired");
    await expect(f.signIns.begin(stranger, f.target("home"))).rejects.toThrow("signin_session_expired");
    f.end();
    expect(() => f.signIns.snapshot(f.owner, f.target("work"))).toThrow("signin_session_expired");
    await f.stop();
  });
  it("the owner turning the switch off ends it (the Runtime's own watch), and the dashboard then sees the end", async () => {
    const f = fixture({ created: ["work"] });
    await f.signIns.begin(f.owner, f.target("work"));
    await waitFor(() => expect(f.phase("work")).toBe("code"));
    setRemoteSwitch(f.pairing, "accounts", false, undefined, Date.now());   // (the switch is read at the clock the file was written with)
    await waitFor(() => expect(f.view("work")).toMatchObject({ phase: "failed", reason: expect.stringMatching(/^(?:transport_failed|cleanup_failed)$/) }), );
    expect(f.children[0]!.killed).toBe(true);
    await f.stop();
  });
  it("a close that cannot be confirmed (the computer went offline) keeps the computer reserved, says so, and is retried by the next start", async () => {
    let offline = false;
    const f = fixture({ created: ["work"], unreachable: () => offline });
    await f.signIns.begin(f.owner, f.target("work"));
    await waitFor(() => expect(f.phase("work")).toBe("code"));
    offline = true;
    await expect(f.signIns.cancel(f.owner, f.target("work"))).rejects.toThrow("signin_cleanup_failed");
    expect(f.signIns.busy(ID)).toBe(true); expect(f.signIns.signingIn(ID, "work")).toBe(true);
    await expect(f.signIns.begin(f.owner, f.target("work"))).rejects.toThrow("signin_cleanup_failed");
    offline = false; f.tick(6_000);
    // The Runtime still holds the child of the first attempt until its own close arrives: the retry reaches it, and only then is the computer free.
    await f.signIns.begin(f.owner, f.target("work"));
    expect(f.children[0]!.killed).toBe(true); expect(f.spawned).toHaveLength(2);
    await f.stop();
  });
});

describe("the transport", () => {
  const spec = { argv: ["claude", "auth", "login"] as const };
  const make = (reply: (operation: string, payload: any) => unknown) => {
    const calls: Array<[string, any]> = [];
    const call: AccountCaller = (async (_id: string, operation: string, payload: any) => { calls.push([operation, structuredClone(payload)]); return reply(operation, payload); }) as AccountCaller;
    return { calls, transport: createRuntimeSignInTransport({ machineId: ID, profile: "work", actor: ACTOR, call }) };
  };
  const SESSION = "a".repeat(32);
  it("maps the launch to a CLI id by exact match against the closed table and refuses everything else, sending nothing", async () => {
    expect(RUNTIME_SIGNIN_CLIS).toEqual({ "claude-code": ["claude", "auth", "login"] });
    for (const bad of [{ argv: ["claude", "auth", "login", "--console"], profile: "work" }, { argv: ["kiro-cli", "login"], profile: "work" }, { argv: ["claude", "auth", "login"], profile: "other" }, { argv: ["claude", "auth", "login"] },
      { argv: ["claude", "auth", "login"], profile: "work", logoutArgv: ["claude", "auth", "logout"] }, { argv: ["codex", "login", "--device-auth"], profile: "work" }]) {
      const { calls, transport } = make(() => ({ sessionId: SESSION }));
      await expect(transport.start(bad as any, new AbortController().signal)).rejects.toThrow("signin_unsupported"); expect(calls).toEqual([]);
    }
    const { calls, transport } = make(() => ({ sessionId: SESSION }));
    await transport.start({ ...spec, profile: "work" }, new AbortController().signal);
    expect(calls).toEqual([["signin.start", { cli: "claude-code", profile: "work", method: "subscription", actor: ACTOR }]]);
    expect(structuredSignInSupported("claude-code")).toBe(true);
  });
  it("a start answer that is not a session id is a protocol error, and then there is nothing to close", async () => {
    for (const answer of [null, {}, { sessionId: 7 }, { sessionId: "../x" }, { sessionId: "A".repeat(32) }]) {
      const { calls, transport } = make(() => answer);
      await expect(transport.start({ ...spec, profile: "work" }, new AbortController().signal)).rejects.toThrow("signin_protocol");
      await transport.close(); expect(calls.map(c => c[0])).toEqual(["signin.start"]);
    }
  });
  it("capture reads the Runtime's screen through the closed table again here: an e-mail, a non-https or foreign link and any other line are dropped", async () => {
    const screens: string[] = [];
    const { transport } = make(op => (op === "signin.start" ? { sessionId: SESSION } : { screen: screens.shift() }));
    await transport.start({ ...spec, profile: "work" }, new AbortController().signal);
    screens.push(`Logged in as ${EMAIL}\nAnything else\n`); expect(await transport.capture()).toBe("Login successful\n");
    screens.push(`If the browser didn't open, visit: http://claude.com/x\nPaste code here if prompted >\n`); expect(await transport.capture()).toBe("Paste code here if prompted >\n");
    screens.push(`If the browser didn't open, visit: https://evil.example/x\n`); expect(await transport.capture()).toBe("");
    screens.push(`If the browser didn't open, visit: ${URL_OK}\nPaste code here if prompted >\nsecret line ${EMAIL}\n`); expect(await transport.capture()).toBe(`If the browser didn't open, visit: ${URL_OK}\n`);
    screens.push(`If the browser didn't open, visit: ${URL_OK}\nPaste code here if prompted >\n`); expect(await transport.capture()).toBe(`If the browser didn't open, visit: ${URL_OK}\nPaste code here if prompted >\n`);
    screens.push("x".repeat(20_000)); await expect(transport.capture()).rejects.toThrow("signin_protocol");
    screens.push(undefined as any); await expect(transport.capture()).rejects.toThrow("signin_protocol");
  });
  it("write sends only a code in the characters a code has, in the driver's own form; a menu key, a second line or a control byte is refused here", async () => {
    const { calls, transport } = make(op => (op === "signin.start" ? { sessionId: SESSION } : { accepted: true }));
    await transport.start({ ...spec, profile: "work" }, new AbortController().signal);
    const signal = new AbortController().signal;
    for (const bad of ["\x1b[B\r", "abc\r\ndef\r", "a b\r", "\r", "\x15\r", "code\x00\r", "x".repeat(4097) + "\r"]) await expect(transport.write(bad, signal), JSON.stringify(bad.slice(0, 12))).rejects.toThrow("signin_input");
    await transport.write("\x15abc-DEF_1\r", signal);
    expect(calls.filter(c => c[0] === "signin.write")).toEqual([["signin.write", { sessionId: SESSION, input: "\x15abc-DEF_1\r" }]]);
    const aborted = new AbortController(); aborted.abort();
    await expect(transport.write("\x15abc\r", aborted.signal)).rejects.toThrow("signin_cancelled");
  });
  it("status is {alive, exitCode?} and nothing else; close answers only when the Runtime says it is gone (or no longer running)", async () => {
    let closing: () => unknown = () => ({ closed: true });
    const { calls, transport } = make(op => (op === "signin.start" ? { sessionId: SESSION } : op === "signin.status" ? { alive: false, exitCode: 0, extra: "x" } : closing()));
    await transport.start({ ...spec, profile: "work" }, new AbortController().signal);
    expect(await transport.status()).toEqual({ alive: false, exitCode: 0 });
    await transport.close(); expect(calls.at(-1)).toEqual(["signin.close", { sessionId: SESSION }]);
    const again = make(op => (op === "signin.start" ? { sessionId: SESSION } : (() => { throw new Error("That sign-in is no longer running"); })()));
    await again.transport.start({ ...spec, profile: "work" }, new AbortController().signal); await expect(again.transport.close()).resolves.toBeUndefined();
    const lost = make(op => (op === "signin.start" ? { sessionId: SESSION } : (() => { throw new Error("That computer did not answer in time"); })()));
    await lost.transport.start({ ...spec, profile: "work" }, new AbortController().signal); await expect(lost.transport.close()).rejects.toThrow("signin_close_unconfirmed");
  });
  it("the CLI's own `auth status` is the success check: signed in (masked identity only), signed out, a profile with no folder yet, or unknown; an unmasked e-mail is not shown", async () => {
    const answer = (value: unknown, fail?: string): AccountCaller => (async () => { if (fail) throw new Error(fail); return value; }) as AccountCaller;
    expect(await runtimeAccountStatus(answer({ loggedIn: true, identity: { maskedEmail: "ab***@example.com", plan: "max" } }), ID, "work")).toEqual({ state: "valid", identity: { maskedEmail: "ab***@example.com", plan: "max" } });
    expect(await runtimeAccountStatus(answer({ loggedIn: true, identity: { maskedEmail: EMAIL } }), ID, "work")).toEqual({ state: "unknown" });
    expect(await runtimeAccountStatus(answer({ loggedIn: true }), ID, "work")).toEqual({ state: "valid" });
    expect(await runtimeAccountStatus(answer({ loggedIn: false }), ID, "work")).toEqual({ state: "invalid" });
    expect(await runtimeAccountStatus(answer({ loggedIn: null }), ID, "work")).toEqual({ state: "unknown" });
    expect(await runtimeAccountStatus(answer("yes"), ID, "work")).toEqual({ state: "unknown" });
    expect(await runtimeAccountStatus(answer(null, "Another operation on \"work\" is in progress; try again in a moment"), ID, "work")).toEqual({ state: "unknown" });
    expect(await runtimeAccountStatus(answer(null, 'Credential profile "work" does not exist on this computer'), ID, "work")).toEqual({ state: "invalid" });
  });
  it("what the server reads as 'no such profile yet' is exactly the Runtime's own refusal text", async () => {
    const f = fixture();
    const error = await requireOwnedProfile(f.pairing, f.root, "claude-code", "brand-new").catch((e: Error) => e);
    expect((error as Error).message).toMatch(PROFILE_DOES_NOT_EXIST);
    expect(existsSync(join(f.root, "claude-code", "brand-new"))).toBe(false);
  });
});
