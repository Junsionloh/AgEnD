/**
 * #3731 phase 1: the ACP protocol layer — framing, the client, the per-CLI profiles, the update translator and the
 * adapter — against recorded (redacted) real captures from grok 1.0.77 and agy 1.5.8, and against a small fake ACP
 * agent in tests/fixtures/acp for the cases a real CLI cannot be made to produce on demand.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LineFramer, decodeFrame } from "../src/adapters/acp/frames.js";
import { AcpAdapter, AcpAuthRequiredError, AcpVersionRefusedError, type AcpMcpServer } from "../src/adapters/acp/acp-adapter.js";
import { AcpTransportError } from "../src/adapters/acp/client.js";
import { AGY_PROFILE, GROK_PROFILE, buildChildEnv, checkVersion, compareVersions, versionAtLeast, type AcpProfile } from "../src/adapters/acp/profiles.js";
import { UpdateTranslator } from "../src/adapters/acp/translate.js";
import type { AdapterEvent, InstanceRunner } from "../src/adapters/types.js";

const FIX = join(import.meta.dirname, "fixtures", "acp");
const FAKE = join(FIX, "fake-acp-agent.mjs");
const REPLAY = join(FIX, "replay-agent.mjs");

const logger = { info() {}, warn() {}, error() {}, debug() {} };
const dirs: string[] = [];
const adapters: AcpAdapter[] = [];
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), "acp-3731-")); dirs.push(d); return d; };
afterEach(async () => {
  await Promise.all(adapters.splice(0).map(a => a.stop().catch(() => undefined)));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A profile that runs `script` under node, claiming to be `base` (same version rules, same events). */
const profileFor = (base: AcpProfile, script: string, ...scriptArgs: string[]): AcpProfile => ({ ...base, args: () => [script, ...scriptArgs] });

function adapterFor(profile: AcpProfile, opts: { instanceDir?: string; env?: NodeJS.ProcessEnv; mcpServers?: AcpMcpServer[]; preamble?: string; signInHint?: (label: string) => string; logger?: { info(o: object, m?: string): void; warn(o: object, m?: string): void; error(o: object, m?: string): void }; trace?: (d: "in" | "out", line: string) => void } = {}) {
  const instanceDir = opts.instanceDir ?? tmp();
  const adapter = new AcpAdapter({
    profile, command: process.execPath, cwd: instanceDir, instanceDir, mcpServers: opts.mcpServers ?? [], preamble: opts.preamble, logger: opts.logger ?? logger,
    env: { PATH: process.env.PATH }, childEnv: opts.env as Record<string, string>, trace: opts.trace, ...(opts.signInHint ? { signInHint: opts.signInHint } : {}), makeRunner: () => ({}) as InstanceRunner,
  });
  adapters.push(adapter);
  const events: AdapterEvent[] = [];
  adapter.onEvent(e => events.push(e));
  return { adapter, events, instanceDir };
}

const fakeProfile = (over: Partial<AcpProfile> = {}): AcpProfile => ({ ...profileFor(AGY_PROFILE, FAKE), ...over });
const fakeEnv = (state: string, extra: NodeJS.ProcessEnv = {}) => ({ FAKE_ACP_STATE: state, FAKE_ACP_VERSION: "1.5.8", ...extra });
const calls = (state: string): any[] => readFileSync(join(state, "calls.jsonl"), "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));

describe("line framing", () => {
  it("joins a line cut in pieces and splits several lines from one piece", () => {
    const f = new LineFramer();
    expect(f.push('{"a":')).toEqual([]);
    expect(f.push('1}\n{"b":2}\n{"c"')).toEqual(['{"a":1}', '{"b":2}']);
    expect(f.push(":3}\r\n")).toEqual(['{"c":3}']);
  });
  it("keeps a multi-byte character that is cut between two chunks", () => {
    const f = new LineFramer();
    const bytes = Buffer.from('{"t":"é✓"}\n');
    const cut = bytes.indexOf(Buffer.from("✓")) + 1;
    expect(f.push(bytes.subarray(0, cut))).toEqual([]);
    expect(f.push(bytes.subarray(cut))).toEqual(['{"t":"é✓"}']);
  });
  it("drops an over-long line whole, reports it once, and keeps the next line", () => {
    const seen: number[] = [];
    const f = new LineFramer({ maxLineBytes: 16, onOverflow: n => seen.push(n) });
    expect(f.push("x".repeat(10))).toEqual([]);
    expect(f.push("y".repeat(40) + "\nshort\n")).toEqual(["short"]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeGreaterThan(16);
  });
});

describe("frame decoding", () => {
  it("treats id 0 as a request id and a null id as unusable", () => {
    expect(decodeFrame('{"jsonrpc":"2.0","id":0,"method":"session/request_permission","params":{}}')).toMatchObject({ kind: "request", id: 0 });
    expect(decodeFrame('{"jsonrpc":"2.0","id":null,"method":"x"}')).toMatchObject({ kind: "notification" });
    expect(decodeFrame('{"jsonrpc":"2.0","id":{},"method":"x"}')).toMatchObject({ kind: "invalid" });
  });
  it("never throws on garbage", () => {
    for (const bad of ["", "{", "[]", "null", "42", '{"id":1}', '{"jsonrpc":"2.0"}']) expect(() => decodeFrame(bad)).not.toThrow();
    expect(decodeFrame("{")).toMatchObject({ kind: "invalid" });
  });
  it("reads a result and an error", () => {
    expect(decodeFrame('{"jsonrpc":"2.0","result":{"a":1},"id":"7"}')).toMatchObject({ kind: "response", id: "7" });
    expect(decodeFrame('{"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"auth"}}')).toMatchObject({ kind: "error", id: 2, code: -32000 });
  });
});

describe("profiles and the version gate", () => {
  it("the policy is a floor and the newest version checked, not a list", () => {
    expect([GROK_PROFILE.minVersion, GROK_PROFILE.verifiedVersion]).toEqual(["1.0.77", "1.0.77"]);
    expect([AGY_PROFILE.minVersion, AGY_PROFILE.verifiedVersion]).toEqual(["1.5.8", "1.5.9"]);
    expect(Object.hasOwn(GROK_PROFILE, "supportedVersions") || Object.hasOwn(AGY_PROFILE, "supportedVersions")).toBe(false);
  });
  it("refuses a release older than the floor, saying the floor and how to upgrade, and not that it falls back to tmux", () => {
    for (const [profile, version, floor, hint] of [[GROK_PROFILE, "1.0.76", "1.0.77", "grok update"], [AGY_PROFILE, "1.5.7", "1.5.8", "agy update"], [AGY_PROFILE, "1.4.99", "1.5.8", "agy update"]] as const) {
      const v = checkVersion(profile, profile === GROK_PROFILE ? { _meta: { agentVersion: version } } : { agentInfo: { version } });
      expect(v.ok, version).toBe(false);
      if (!v.ok) { expect(v.message).toContain(version); expect(v.message).toContain(floor); expect(v.message).toContain(hint); expect(v.message).toMatch(/does not fall back to tmux/); }
    }
  });
  it("starts a release at the floor or checked, newer ones too (with a warning to log), and one that gives no readable version (also warned)", () => {
    expect(checkVersion(AGY_PROFILE, { agentInfo: { version: "1.5.8" } })).toEqual({ ok: true, version: "1.5.8", verified: true });
    expect(checkVersion(AGY_PROFILE, { agentInfo: { version: "1.5.9" } })).toEqual({ ok: true, version: "1.5.9", verified: true });
    for (const version of ["1.5.10", "1.6.0", "2.0.0", "1.5.10-beta.1"]) {
      const v = checkVersion(AGY_PROFILE, { agentInfo: { version } });
      expect(v, version).toMatchObject({ ok: true, verified: false });
      expect((v as { warning: string }).warning).toContain(version);
      expect((v as { warning: string }).warning).toContain("verified up to 1.5.9");
    }
    expect(checkVersion(AGY_PROFILE, {})).toMatchObject({ ok: true, version: null, verified: false });
    expect(checkVersion(AGY_PROFILE, { agentInfo: { version: "nightly" } })).toMatchObject({ ok: true, verified: false });
  });
  it("compares numbers, not strings (1.5.10 is newer than 1.5.9, 1.10.0 than 1.9.9)", () => {
    expect([compareVersions("1.5.10", "1.5.9"), compareVersions("1.10.0", "1.9.9"), compareVersions("1.5.9", "1.5.9"), compareVersions("1.0.99", "1.0.100"), compareVersions("x", "1.0.0")]).toEqual([1, 1, 0, -1, null]);
  });
  it("what depends on the release is decided by the release: a way of adding to a turn from its first release, none before; an unreadable release has none", () => {
    expect([versionAtLeast("1.5.0", "1.5.0"), versionAtLeast("1.4.9", "1.5.0"), versionAtLeast("1.5.10", "1.5.0"), versionAtLeast(null, "1.5.0"), versionAtLeast("nightly", "1.5.0"), versionAtLeast(null, undefined)]).toEqual([true, false, true, false, false, true]);
    expect([GROK_PROFILE.interjectFrom, AGY_PROFILE.interjectFrom]).toEqual(["1.0.14", "1.5.0"]);
  });
  it("starts grok without auto-update and without a shared leader, and passes effort and model", () => {
    expect(GROK_PROFILE.args({ model: "m", effort: "high", skipPermissions: false })).toEqual(["--no-auto-update", "agent", "--no-leader", "--model", "m", "--reasoning-effort", "high", "stdio"]);
    expect(AGY_PROFILE.args({ skipPermissions: false })).toEqual(["acp"]);
  });
  it("skipPermissions (the default) starts each CLI with its own auto-approve flag: grok `agent --always-approve stdio`, agy `acp --dangerously-skip-permissions`", () => {
    for (const options of [{}, { skipPermissions: true }, { skipPermissions: undefined }]) {
      expect(GROK_PROFILE.args(options)).toEqual(["--no-auto-update", "agent", "--no-leader", "--always-approve", "stdio"]);
      expect(AGY_PROFILE.args(options)).toEqual(["acp", "--dangerously-skip-permissions"]);
    }
    expect(GROK_PROFILE.args({ model: "m", skipPermissions: true })).toEqual(["--no-auto-update", "agent", "--no-leader", "--always-approve", "--model", "m", "stdio"]);
  });
  it("builds the child's environment from an allow-list: no fleet or web secrets", () => {
    const env = buildChildEnv(GROK_PROFILE, { PATH: "/bin", HOME: "/h", XAI_API_KEY: "k", AGEND_TOKEN: "secret", AGEND_WEB_SECRET: "s", DISCORD_TOKEN: "d", OPENAI_API_KEY: "o", LC_ALL: "C" });
    expect(env).toMatchObject({ PATH: "/bin", HOME: "/h", XAI_API_KEY: "k", LC_ALL: "C", TERM: "dumb" });
    expect(Object.keys(env).some(k => /AGEND|DISCORD|OPENAI/.test(k))).toBe(false);
    expect(buildChildEnv(AGY_PROFILE, { PATH: "/bin" })).toMatchObject({ AGY_CLI_DISABLE_AUTO_UPDATE: "1" });
  });
});

describe("update translation", () => {
  it("merges a call's updates, tolerates them out of order, and never moves a finished call back", () => {
    const t = new UpdateTranslator();
    const tool = (u: Record<string, unknown>) => t.translate({ sessionUpdate: "tool_call_update", toolCallId: "a", ...u }) as Extract<AdapterEvent, { kind: "tool" }>[];
    expect(tool({ status: "completed", rawOutput: { ok: 1 } })[0]).toMatchObject({ id: "a", status: "completed" });
    const first = t.translate({ sessionUpdate: "tool_call", toolCallId: "a", title: "read", kind: "read" })[0] as Extract<AdapterEvent, { kind: "tool" }>;
    expect(first).toMatchObject({ title: "read", toolKind: "read", status: "completed", rawOutput: { ok: 1 } });
    expect(tool({ status: "in_progress" })[0]!.status).toBe("completed");
  });
  it("ignores update kinds it does not know and bad shapes", () => {
    const t = new UpdateTranslator();
    expect(t.translate({ sessionUpdate: "available_commands_update", availableCommands: [] })).toEqual([]);
    expect(t.translate(null)).toEqual([]);
    expect(t.translate({ sessionUpdate: "tool_call" })).toEqual([]);
  });
});

/** Run a recorded capture through a real adapter: framing, client, translation, version gate, permission answer. */
async function replay(file: string, base: AcpProfile, chunk = 0) {
  const profile = profileFor(base, REPLAY, join(FIX, file));
  const { adapter, events } = adapterFor(profile, { env: chunk ? { REPLAY_CHUNK: String(chunk) } : {} });
  const answered: string[] = [];
  adapter.onEvent(e => {
    if (e.kind === "permission") {
      const allow = e.options.find(o => o.kind === "allow_once")!;
      answered.push(`${e.requestId}:${allow.id}`);
      expect(adapter.answerPermission(e.requestId, { optionId: allow.id })).toBe(true);
    }
  });
  await adapter.start();
  const result = await adapter.prompt("recorded");
  return { events, result, answered, adapter };
}

describe("recorded real captures", () => {
  it.each([[1], [7]])("grok 1.0.77, a short turn (read in %i-byte pieces)", async chunk => {
    const { events, result, adapter } = await replay("grok-1.0.77-short.jsonl", GROK_PROFILE, chunk);
    expect(adapter.agentVersion).toBe("1.0.77");
    expect(result.stopReason).toBe("end_turn");
    expect(events.filter(e => e.kind === "message")).toEqual([{ kind: "message", text: "OK" }]);
  });

  it("grok 1.0.77, a tool turn: permission id 0 is answered with allow_once, the call runs to completion", async () => {
    const { events, answered } = await replay("grok-1.0.77-tool.jsonl", GROK_PROFILE);
    expect(answered).toEqual(["n0:allow-once"]);
    const permission = events.find(e => e.kind === "permission");
    expect(permission).toMatchObject({ kind: "permission", options: expect.arrayContaining([expect.objectContaining({ id: "allow-edits-session", kind: "allow_always" })]) });
    const tools = events.filter(e => e.kind === "tool") as Extract<AdapterEvent, { kind: "tool" }>[];
    expect(tools[0]).toMatchObject({ status: "pending" });
    expect(tools.at(-1)).toMatchObject({ status: "completed", toolKind: "edit" });
    expect(events.filter(e => e.kind === "message").map(e => (e as any).text).join("")).toContain("DONE");
  });

  it("agy 1.5.8, a short turn: usage and the echoed user message", async () => {
    const { events } = await replay("agy-1.5.8-short.jsonl", AGY_PROFILE);
    expect(events).toContainEqual({ kind: "usage", used: 8740, size: 1048576 });
    expect(events.find(e => e.kind === "user")).toMatchObject({ text: expect.stringContaining("Think for a moment") });
    expect(events.filter(e => e.kind === "message")).toEqual([{ kind: "message", text: "OK" }]);
  });

  it.each(["short", "tool"])("agy 1.5.9, the %s capture replays as 1.5.8's does", async which => {
    const { events, result } = await replay(`agy-1.5.9-${which}.jsonl`, AGY_PROFILE);
    expect(result.stopReason).toBe("end_turn");
    expect(events.filter(e => e.kind === "message").map(e => (e as any).text).join("")).toMatch(which === "short" ? /OK/ : /DONE/);
  });

  it("agy 1.5.8, a tool turn: thought chunk, permission id \"1\" (a string), completed write", async () => {
    const { events, answered } = await replay("agy-1.5.8-tool.jsonl", AGY_PROFILE);
    expect(answered).toEqual(["s1:allow"]);
    expect(events.find(e => e.kind === "thought")).toMatchObject({ text: expect.stringContaining("hi") });
    expect(events.filter(e => e.kind === "tool").at(-1)).toMatchObject({ status: "completed", toolKind: "edit" });
  });

  it("refuses a recorded 1.0.77 handshake under a profile whose floor is newer", async () => {
    const profile = { ...profileFor(GROK_PROFILE, REPLAY, join(FIX, "grok-1.0.77-short.jsonl")), minVersion: "2.0.0" };
    const { adapter } = adapterFor(profile);
    await expect(adapter.start()).rejects.toBeInstanceOf(AcpVersionRefusedError);
    expect(adapter.health().process).not.toBe("running");
    expect(adapter.pid).toBeUndefined();
  });
});

describe("the adapter against the fake agent", () => {
  it("opens a session and runs a turn: thought chunks, usage, message, turn end", async () => {
    const state = tmp();
    const { adapter, events } = adapterFor(fakeProfile(), { env: fakeEnv(state) });
    await adapter.start();
    expect(adapter.isNewSession).toBe(true);
    expect(adapter.sessionId()).toMatch(/^fake-/);
    const result = await adapter.prompt("hello");
    expect(result.stopReason).toBe("end_turn");
    expect(events.map(e => e.kind)).toEqual(["user", "thought", "thought", "usage", "message"]);
    expect(adapter.health().lastEventAt).toBeGreaterThan(0);
  });

  it("is not advertised as steerable and offers no steer", () => {
    const { adapter } = adapterFor(fakeProfile());
    expect(adapter.capabilities).toMatchObject({ steer: false, paneView: false, livePermissions: true, liveThought: true });
    expect(adapter.steer).toBeUndefined();
  });

  it("copes with updates out of order and a record cut inside a multi-byte character", async () => {
    const state = tmp();
    const { adapter, events } = adapterFor(fakeProfile(), { env: fakeEnv(state) });
    await adapter.start();
    await adapter.prompt("#ordering");
    const tools = events.filter(e => e.kind === "tool") as Extract<AdapterEvent, { kind: "tool" }>[];
    expect(tools.map(t => t.status)).toEqual(["completed", "completed", "completed"]);
    expect(tools.at(-1)).toMatchObject({ title: "read", toolKind: "read" });
    events.length = 0;
    await adapter.prompt("#split");
    expect(events.find(e => e.kind === "message")).toEqual({ kind: "message", text: "héllo wörld ✓" });
  });

  it("answers fs/* and terminal/* requests from the agent with 'method not found'", async () => {
    const state = tmp();
    const { adapter } = adapterFor(fakeProfile(), { env: fakeEnv(state) });
    await adapter.start();
    await adapter.prompt("#fsprobe");
    const log = calls(state);
    expect(log.find(l => l.fsprobe)?.fsprobe.error.code).toBe(-32601);
    expect(log.find(l => l.terminalprobe)?.terminalprobe.error.code).toBe(-32601);
    // and the handshake advertised nothing
    expect(log.some(l => l.in === "initialize")).toBe(true);
  });

  it("sends the permission request out as an event and applies the answer (allow_once)", async () => {
    const state = tmp();
    const { adapter, events } = adapterFor(fakeProfile(), { env: fakeEnv(state) });
    adapter.onEvent(e => { if (e.kind === "permission") expect(adapter.answerPermission(e.requestId, { optionId: "allow-once" })).toBe(true); });
    await adapter.start();
    await adapter.prompt("#tool");
    expect(calls(state).find(l => l.permissionOutcome)?.permissionOutcome).toEqual({ outcome: "selected", optionId: "allow-once" });
    expect(events.filter(e => e.kind === "tool").at(-1)).toMatchObject({ status: "completed" });
  });

  it("a second answer for the same request, or for an unknown one, is refused", async () => {
    const state = tmp();
    const { adapter } = adapterFor(fakeProfile(), { env: fakeEnv(state) });
    let first: boolean | null = null, second: boolean | null = null;
    adapter.onEvent(e => { if (e.kind === "permission") { first = adapter.answerPermission(e.requestId, { optionId: "reject-once" }); second = adapter.answerPermission(e.requestId, { optionId: "allow-once" }); } });
    await adapter.start();
    await adapter.prompt("#tool");
    expect([first, second]).toEqual([true, false]);
    expect(adapter.answerPermission("nope", { optionId: "x" })).toBe(false);
    expect(calls(state).find(l => l.permissionOutcome)?.permissionOutcome.optionId).toBe("reject-once");
  });

  it("cancel with a permission request waiting answers it 'cancelled' and the turn ends 'cancelled'", async () => {
    const state = tmp();
    const { adapter } = adapterFor(fakeProfile(), { env: fakeEnv(state) });
    const waiting = new Promise<void>(resolve => adapter.onEvent(e => { if (e.kind === "permission") resolve(); }));
    await adapter.start();
    const turn = adapter.prompt("#tool");
    await waiting;
    expect(adapter.pendingPermissionKeys).toHaveLength(1);
    await adapter.cancel();
    expect((await turn).stopReason).toBe("cancelled");
    expect(calls(state).find(l => l.permissionOutcome)?.permissionOutcome).toEqual({ outcome: "cancelled" });
    expect(adapter.pendingPermissionKeys).toHaveLength(0);
  });

  it("stopping with a permission request waiting answers it 'cancelled' on the wire before the process is ended", async () => {
    const state = tmp();
    const sent: string[] = [];
    const { adapter } = adapterFor(fakeProfile(), { env: fakeEnv(state), trace: (d, line) => { if (d === "out") sent.push(line); } });
    const waiting = new Promise<void>(resolve => adapter.onEvent(e => { if (e.kind === "permission") resolve(); }));
    await adapter.start();
    void adapter.prompt("#tool").catch(() => undefined);
    await waiting;
    await adapter.stop();
    const answers = sent.map(l => JSON.parse(l)).filter(m => m.result?.outcome);
    expect(answers).toEqual([{ jsonrpc: "2.0", id: 0, result: { outcome: { outcome: "cancelled" } } }]);
  });

  it("cancel interrupts a running turn through session/cancel", async () => {
    const state = tmp();
    const { adapter, events } = adapterFor(fakeProfile(), { env: fakeEnv(state) });
    await adapter.start();
    const turn = adapter.prompt("#slow");
    await new Promise(r => setTimeout(r, 150));
    expect(adapter.busy).toBe(true);
    await adapter.cancel();
    expect((await turn).stopReason).toBe("cancelled");
    expect(adapter.busy).toBe(false);
    expect(calls(state).some(l => l.in === "session/cancel")).toBe(true);
    expect(events.filter(e => e.kind === "thought")).toHaveLength(2);
  });

  it("a child that exits in the middle of a turn fails that turn and reports an unexpected exit", async () => {
    const state = tmp();
    const { adapter } = adapterFor(fakeProfile(), { env: fakeEnv(state) });
    const exits: { code: number | null; expected: boolean }[] = [];
    adapter.onExit(i => exits.push(i));
    await adapter.start();
    await expect(adapter.prompt("#crash")).rejects.toBeInstanceOf(AcpTransportError);
    expect(exits).toEqual([{ code: 3, signal: null, expected: false }]);
    expect(adapter.health().process).toBe("crashed");
    await expect(adapter.prompt("again")).rejects.toBeInstanceOf(AcpTransportError);
  });

  it("stop is an expected exit", async () => {
    const { adapter } = adapterFor(fakeProfile(), { env: fakeEnv(tmp()) });
    const exits: boolean[] = [];
    adapter.onExit(i => exits.push(i.expected));
    await adapter.start();
    await adapter.stop();
    expect(exits).toEqual([true]);
    expect(adapter.health().process).toBe("stopped");
  });

  it("resumes the stored session with session/load: the replayed history is not live work", async () => {
    const state = tmp();
    const instanceDir = tmp();
    const first = adapterFor(fakeProfile(), { env: fakeEnv(state), instanceDir });
    await first.adapter.start();
    await first.adapter.prompt("remember this");
    const id = first.adapter.sessionId()!;
    await first.adapter.stop();

    const second = adapterFor(fakeProfile(), { env: fakeEnv(state), instanceDir });
    expect(second.adapter.sessionId()).toBe(id);
    await second.adapter.start();
    expect(second.adapter.isNewSession).toBe(false);
    expect(second.adapter.sessionId()).toBe(id);
    expect(calls(state).some(l => l.sessionLoad?.sessionId === id)).toBe(true);
    expect(second.events).toEqual([]); // the agent replayed two history updates; none was surfaced
    await second.adapter.prompt("and now?");
    expect(second.events.some(e => e.kind === "message")).toBe(true);
  });

  it("starts a new session when the stored one cannot be loaded", async () => {
    const state = tmp();
    const instanceDir = tmp();
    const first = adapterFor(fakeProfile(), { env: fakeEnv(state), instanceDir });
    await first.adapter.start();
    const oldId = first.adapter.sessionId()!;
    await first.adapter.stop();
    rmSync(join(state, "sessions.json"));
    const second = adapterFor(fakeProfile(), { env: fakeEnv(state), instanceDir });
    await second.adapter.start();
    expect(second.adapter.isNewSession).toBe(true);
    expect(second.adapter.sessionId()).not.toBe(oldId);
  });

  it("reports a CLI that is not signed in, and stays stopped", async () => {
    const { adapter, events } = adapterFor(fakeProfile(), { env: fakeEnv(tmp(), { FAKE_ACP_AUTH: "1" }) });
    await expect(adapter.start()).rejects.toBeInstanceOf(AcpAuthRequiredError);
    expect(events).toContainEqual({ kind: "auth_required" });
    expect(adapter.pid).toBeUndefined();
  });

  it("the not-signed-in message ends with where to sign in when the host says (the label of the CLI is handed over), and with the plain line when it does not", async () => {
    const plain = adapterFor(fakeProfile(), { env: fakeEnv(tmp(), { FAKE_ACP_AUTH: "1" }) });
    await expect(plain.adapter.start()).rejects.toThrow(/agy is not signed in \(Authentication required\)\. Sign in to agy, then restart the instance\.$/);
    const hinted = adapterFor(fakeProfile(), { env: fakeEnv(tmp(), { FAKE_ACP_AUTH: "1" }), signInHint: label => `Connect ${label} in Settings → Accounts.` });
    await expect(hinted.adapter.start()).rejects.toThrow(/agy is not signed in \(Authentication required\)\. Connect agy in Settings → Accounts\.$/);
  });

  it("refuses to start under a release older than the floor", async () => {
    const { adapter } = adapterFor(fakeProfile(), { env: fakeEnv(tmp(), { FAKE_ACP_VERSION: "1.5.7" }) });
    await expect(adapter.start()).rejects.toThrow(/agy 1\.5\.7 is older than agy 1\.5\.8/);
    expect(adapter.health().process).not.toBe("running");
  });

  it("starts under a newer, unverified release, with one warning in the log and no refusal; a verified one logs none", async () => {
    const warned: string[] = [];
    const log = { info() {}, error() {}, warn: (_o: object, m?: string) => { warned.push(m ?? ""); } };
    const newer = adapterFor(fakeProfile(), { env: fakeEnv(tmp(), { FAKE_ACP_VERSION: "1.5.10" }), logger: log });
    await newer.adapter.start();
    expect([newer.adapter.agentVersion, newer.adapter.versionVerified, newer.adapter.health().process]).toEqual(["1.5.10", false, "running"]);
    expect(warned.filter((m) => /unverified version/.test(m))).toEqual([expect.stringMatching(/agy 1\.5\.10 is an unverified version \(verified up to 1\.5\.9\): starting anyway/)]);
    warned.length = 0;
    const checked = adapterFor(fakeProfile(), { env: fakeEnv(tmp(), { FAKE_ACP_VERSION: "1.5.9" }), logger: log });
    await checked.adapter.start();
    expect([checked.adapter.versionVerified, warned.filter((m) => /unverified version/.test(m))]).toEqual([true, []]);
  });

  it("adds to a running turn only from the release that can: an older one is cancelled and sent next", async () => {
    for (const [version, expected] of [["1.5.9", true], ["1.5.10", true], ["1.4.9", false]] as const) {
      const a = adapterFor(fakeProfile({ minVersion: "1.0.0" }), { env: fakeEnv(tmp(), { FAKE_ACP_VERSION: version, FAKE_ACP_CONCURRENT: "fold" }) });
      await a.adapter.start();
      const turn = a.adapter.prompt("work #slow");
      await new Promise((r) => setTimeout(r, 300));
      expect([version, a.adapter.canInterject, await a.adapter.interject("more") !== false]).toEqual([version, expected, expected]);
      await a.adapter.cancel();
      await turn.catch(() => undefined);
    }
  });

  it("puts the instructions in front of the first prompt of a new session only", async () => {
    const state = tmp();
    const instanceDir = tmp();
    const a = adapterFor(fakeProfile(), { env: fakeEnv(state), instanceDir, preamble: "[FLEET]" });
    await a.adapter.start();
    await a.adapter.prompt("first");
    await a.adapter.prompt("second");
    const sessions = JSON.parse(readFileSync(join(state, "sessions.json"), "utf8"));
    expect(sessions[a.adapter.sessionId()!]).toEqual(["[FLEET]\n\nfirst", "second"]);
    await a.adapter.stop();
    const b = adapterFor(fakeProfile(), { env: fakeEnv(state), instanceDir, preamble: "[FLEET]" });
    await b.adapter.start();
    await b.adapter.prompt("third");
    expect(JSON.parse(readFileSync(join(state, "sessions.json"), "utf8"))[b.adapter.sessionId()!].at(-1)).toBe("third");
  });
});

describe("MCP identity is per instance", () => {
  it("each instance's session/new carries its own agend server and nothing of another's", async () => {
    const server = (name: string): AcpMcpServer => ({
      name: "agend", command: "/usr/bin/node", args: ["/srv/mcp-server.js"],
      env: [{ name: "AGEND_INSTANCE_NAME", value: name }, { name: "AGEND_SOCKET_PATH", value: `/run/${name}/channel.sock` }],
    });
    const stateA = tmp(), stateB = tmp();
    const a = adapterFor(fakeProfile(), { env: fakeEnv(stateA), mcpServers: [server("alpha")] });
    const b = adapterFor(fakeProfile(), { env: fakeEnv(stateB), mcpServers: [server("beta")] });
    await Promise.all([a.adapter.start(), b.adapter.start()]);
    const sentA = calls(stateA).find(l => l.sessionNew)!.sessionNew;
    const sentB = calls(stateB).find(l => l.sessionNew)!.sessionNew;
    expect(sentA.mcpServers).toHaveLength(1);
    expect(sentA.mcpServers[0].env).toContainEqual({ name: "AGEND_INSTANCE_NAME", value: "alpha" });
    expect(sentB.mcpServers[0].env).toContainEqual({ name: "AGEND_INSTANCE_NAME", value: "beta" });
    expect(JSON.stringify(sentA)).not.toContain("beta");
    expect(JSON.stringify(sentB)).not.toContain("alpha");
    // stdio only: no http / sse entry is ever declared
    for (const s of [...sentA.mcpServers, ...sentB.mcpServers]) expect(s.type).toBeUndefined();
  });

  it("does not advertise fs or terminal capabilities", async () => {
    const state = tmp();
    const { adapter } = adapterFor(fakeProfile(), { env: fakeEnv(state) });
    await adapter.start();
    const sent = readFileSync(join(state, "calls.jsonl"), "utf8");
    expect(sent).not.toMatch(/readTextFile|writeTextFile|"terminal"/);
  });
});
