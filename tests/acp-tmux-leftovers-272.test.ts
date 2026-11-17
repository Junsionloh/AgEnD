/**
 * #3731 / AGEND-272: what a tmux launch leaves behind and what only a terminal can do, for an instance that runs over ACP.
 *  1. the `agend` MCP server an ACP instance declares must not be shadowed by anything a tmux backend wrote (grok merges
 *     the project's `.mcp.json` over the client's servers, by name), and agy's global launcher must get no identity;
 *  2. an ACP agent whose MCP server never connects is reported, as a tmux instance's is;
 *  3. every terminal-only input (`raw_paste`: /effort, /model, /compact, /clear, /save, /chat load, /raw) is answered or
 *     refused for an ACP instance, never handed to the agent as a prompt; effort and model go through the protocol.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IpcClient } from "../src/channel/ipc-bridge.js";
import { AcpAdapter } from "../src/adapters/acp/acp-adapter.js";
import { AcpStepStore } from "../src/adapters/acp/steps.js";
import { AcpRunner, type AcpRunnerOptions } from "../src/adapters/acp/acp-runner.js";
import { ACP_MCP_SERVER_NAME, buildAcpLaunch, toolNameHint } from "../src/adapters/acp/launch.js";
import { AGY_PROFILE, GROK_PROFILE, buildChildEnv } from "../src/adapters/acp/profiles.js";
import { writeGrokMcp } from "../src/backend/grok-mcp.js";
import type { InstanceConfig } from "../src/types.js";

const FAKE = join(import.meta.dirname, "fixtures", "acp", "fake-acp-agent.mjs");
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const dirs: string[] = [];
const runners: AcpRunner[] = [];
const clients: IpcClient[] = [];
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), "acp272-")); dirs.push(d); return d; };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 4000, what = "condition") => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(15); }
};

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => undefined);
  await Promise.all(runners.splice(0).map(r => r.stop().catch(() => undefined)));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// ───────────────────────────────────────────────────────────────────────── 1. leftovers of a tmux launch

describe("the agend server of an ACP instance cannot be shadowed by what a tmux backend wrote", () => {
  const launch = (backend: string) => {
    const root = tmp(); const instanceDir = join(root, "instances", "w"); mkdirSync(instanceDir, { recursive: true });
    return buildAcpLaunch({ name: "w", config: { working_directory: root, backend } as never, instanceDir, runtimeIdentity: { kind: "fleet-topic", backend, model: "m" } }, "/dist/channel/mcp-server.js");
  };

  it("is declared under a name no tmux backend writes, and it is not `agend`", () => {
    for (const backend of ["grok", "antigravity"]) {
      const parts = launch(backend);
      expect(parts.mcpServers.map(s => s.name)).toEqual([ACP_MCP_SERVER_NAME]);
      expect(ACP_MCP_SERVER_NAME).not.toBe("agend");
    }
    // agy's tmux launch writes the global `agend-fleet` entry; grok's writes `agend` into the project's .mcp.json (below)
    expect(ACP_MCP_SERVER_NAME).not.toBe("agend-fleet");
  });

  it("grok: the `.mcp.json` the tmux launch really writes holds `agend`, a name the ACP server does not use", () => {
    const work = tmp(); const instanceDir = tmp();
    // a tmux launch, then a switch to ACP: the file is still there, with its launch shim under the name `agend`
    writeGrokMcp({ workingDirectory: work, instanceDir, instanceName: "w", mcpServers: { agend: { command: "/usr/bin/node", args: ["/dist/channel/mcp-server.js"], env: { AGEND_SOCKET_PATH: join(instanceDir, "channel.sock") } } } } as never, instanceDir);
    const leftover = JSON.parse(readFileSync(join(work, ".mcp.json"), "utf8")) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(leftover.mcpServers)).toEqual(["agend"]);
    expect(Object.keys(leftover.mcpServers)).not.toContain(ACP_MCP_SERVER_NAME);
  });

  it("the preamble names the tools as each CLI spells them, so the agent does not search for its reply tool", () => {
    expect(launch("grok").preamble).toContain("agend_acp__reply");
    expect(launch("antigravity").preamble).toContain("mcp_agend_acp_reply");
    expect(toolNameHint("grok")).not.toContain("mcp_agend_acp_");
  });

  it("agy: the global `agend-fleet` launcher runs under agy's child environment, which carries no other instance's identity", () => {
    const source = { PATH: "/usr/bin", HOME: "/h", AGEND_SOCKET_PATH: "/data/instances/agy-tmux/channel.sock", AGEND_INSTANCE_NAME: "agy-tmux", AGEND_FLEET_DATA_DIR: "/data", AGEND_GROK_MCP_BINDING: "b", GEMINI_API_KEY: "k" };
    for (const profile of [AGY_PROFILE, GROK_PROFILE]) {
      const env = buildChildEnv(profile, source);
      expect(Object.keys(env).filter(k => k.startsWith("AGEND_"))).toEqual([]);
    }
    // the instance's own identity is only in the MCP server entry of session/new
    const entry = launch("antigravity").mcpServers[0]!;
    expect(Object.fromEntries(entry.env.map(e => [e.name, e.value])).AGEND_INSTANCE_NAME).toBe("w");
  });
});

// ───────────────────────────────────────────────────────────────────────── harness for the runner

interface Harness { runner: AcpRunner; adapter: AcpAdapter; dir: string; state: string; fleet: IpcClient; events: Record<string, any[]>; outbound: any[]; outbox: FakeOutbox; broadcasts: any[] }

class FakeOutbox {
  calls: string[] = [];
  begin(id: string, _b: string, attempt: number) { this.calls.push(`begin:${id}:${attempt}`); return "begun" as const; }
  markEnterStarted(id: string) { this.calls.push(`enter:${id}`); return true; }
  complete(id: string, _b: string, _a: number, outcome: string) { this.calls.push(`complete:${id}:${outcome}`); return true; }
  retryBeforeBegin(id: string, _b: string, _a: number, reason: string) { this.calls.push(`retry:${id}:${reason}`); return true; }
  abort() { return true; }
}

async function boot(opts: { config?: Partial<InstanceConfig>; runner?: Partial<AcpRunnerOptions>; env?: Record<string, string>; mcpConnects?: "with_session" | "first_prompt" } = {}): Promise<Harness> {
  const dir = tmp(), state = tmp();
  const config = { working_directory: dir, backend: "antigravity", cli_adapter: "acp", skipPermissions: false, ...opts.config } as InstanceConfig;
  // The MCP tests below are about a CLI that starts its server with the session (grok) unless a test says it starts with the first prompt (agy).
  const profile = { ...AGY_PROFILE, args: () => [FAKE], mcpConnects: opts.mcpConnects ?? "with_session" };
  const holder: { runner?: AcpRunner } = {};
  const adapter = new AcpAdapter({
    profile, command: process.execPath, cwd: dir, instanceDir: dir, mcpServers: [], logger,
    env: { PATH: process.env.PATH }, childEnv: { FAKE_ACP_STATE: state, FAKE_ACP_VERSION: "1.5.8", ...opts.env },
    makeRunner: a => (holder.runner = new AcpRunner(a, { name: "worker", config, instanceDir: dir, topicMode: true, backend: "antigravity", logger, ...opts.runner })),
  });
  const runner = holder.runner!;
  runners.push(runner);
  const outbox = new FakeOutbox();
  runner.setDeliveryOutboxPort(outbox as any);
  const events: Record<string, any[]> = {};
  for (const name of ["message_failed", "backend_launch_warning", "mcp_died", "mcp_recovered", "message_delivered"]) runner.on(name, (d: unknown) => (events[name] ??= []).push(d));
  await runner.start();
  const fleet = new IpcClient(join(dir, "channel.sock"));
  clients.push(fleet);
  await fleet.connect();
  const outbound: any[] = [], broadcasts: any[] = [];
  fleet.on("message", (m: any) => {
    if (m.type === "fleet_outbound") { outbound.push(m); fleet.send({ type: "fleet_outbound_response", fleetRequestId: m.fleetRequestId, result: { messageId: "m1" } }); }
    else broadcasts.push(m);
  });
  return { runner, adapter, dir, state, fleet, events, outbound, outbox, broadcasts };
}

const calls = (state: string): any[] => { try { return readFileSync(join(state, "calls.jsonl"), "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
const prompts = (state: string) => calls(state).filter(c => c.in === "session/prompt");
const history = (state: string): string[] => Object.values(JSON.parse(readFileSync(join(state, "sessions.json"), "utf8")) as Record<string, string[]>).flat();
const mcpClient = async (h: Harness, sessionName = "worker"): Promise<IpcClient> => {
  const mcp = new IpcClient(join(h.dir, "channel.sock"));
  clients.push(mcp);
  await mcp.connect();
  mcp.send({ type: "mcp_ready", sessionName });
  return mcp;
};

// ───────────────────────────────────────────────────────────────────────── 2. MCP never connected

describe("an ACP agent whose agend MCP server never connects is reported", () => {
  it("after the grace period: logged as an incident, kept in the timeline, and shown as an error state", async () => {
    const h = await boot({ runner: { mcpGraceMs: 80 } });
    await until(() => (h.events.mcp_died?.length ?? 0) === 1, 3000, "the never-connected report");
    expect(h.events.mcp_died![0]).toMatchObject({ name: "worker", pid: 0, neverConnected: true, acp: true, autoRestart: false });
    expect(h.runner.isErrorState).toBe(true);
    expect(h.runner.lastErrorType).toBe("mcp");
    const errors = h.runner.steps.snapshot(undefined, { thoughts: false }).steps.filter(s => s.kind === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.body).toContain("never connected");
    await sleep(150);
    expect(h.events.mcp_died).toHaveLength(1);                     // once per launch
  });

  it("says nothing when the server announces itself in time (mcp_ready), and the agent is not in an error state", async () => {
    const h = await boot({ runner: { mcpGraceMs: 200 } });
    await mcpClient(h);
    await until(() => h.runner.mcpConnected, 2000, "mcp_ready");
    await sleep(350);
    expect(h.events.mcp_died).toBeUndefined();
    expect(h.runner.isErrorState).toBe(false);
  });

  it("a tool call alone also proves the server is up", async () => {
    const h = await boot({ runner: { mcpGraceMs: 200 } });
    const mcp = new IpcClient(join(h.dir, "channel.sock")); clients.push(mcp); await mcp.connect();
    mcp.send({ type: "tool_call", tool: "list_instances", args: {}, requestId: 1 });
    await until(() => h.runner.mcpConnected, 2000, "tool call");
    await sleep(300);
    expect(h.events.mcp_died).toBeUndefined();
  });

  it("another instance's server on this socket is not this instance's: the report still comes", async () => {
    const h = await boot({ runner: { mcpGraceMs: 120 } });
    await mcpClient(h, "some-other-instance");
    await until(() => (h.events.mcp_died?.length ?? 0) === 1, 3000, "the report");
    expect(h.runner.mcpConnected).toBe(false);
  });

  it("a server that connects after the report retracts it and clears the error state", async () => {
    const h = await boot({ runner: { mcpGraceMs: 60 } });
    await until(() => (h.events.mcp_died?.length ?? 0) === 1, 3000, "the report");
    expect(h.runner.isErrorState).toBe(true);
    await mcpClient(h);
    await until(() => (h.events.mcp_recovered?.length ?? 0) === 1, 3000, "the retraction");
    expect(h.events.mcp_recovered![0]).toMatchObject({ name: "worker", source: "late_connect" });
    expect(h.runner.isErrorState).toBe(false);
  });

  it("is checked again after every launch (a restart that comes up without the server is reported again)", async () => {
    const h = await boot({ runner: { mcpGraceMs: 80 } });
    await mcpClient(h);
    await until(() => h.runner.mcpConnected, 2000, "mcp_ready");
    await h.runner.pause("operator");
    await h.runner.wake();
    expect(h.runner.mcpConnected).toBe(false);
    await until(() => (h.events.mcp_died?.length ?? 0) === 1, 3000, "the second launch's report");
  });
});

describe("an agent that starts its MCP server with the first prompt (agy) is not reported before one", () => {
  const send = (h: Harness, text: string) => h.fleet.send({ type: "fleet_inbound", content: text, meta: { chat_id: "c1", message_id: `m-${text}`, user: "alice", source: "web" } });
  const turnEnded = (h: Harness) => until(() => h.runner.getInstanceState() === "idle" && h.runner.steps.snapshot(undefined, { thoughts: false }).steps.some(s => s.kind === "turn_end"), 5000, "the turn to end");
  const errors = (h: Harness) => h.runner.steps.snapshot(undefined, { thoughts: false }).steps.filter(s => s.kind === "error");

  it("an idle instance past the grace period is not reported: nobody has written to it", async () => {
    const h = await boot({ mcpConnects: "first_prompt", runner: { mcpGraceMs: 60 } });
    await sleep(300);
    expect(h.events.mcp_died).toBeUndefined();
    expect(h.runner.isErrorState).toBe(false);
    expect(errors(h)).toHaveLength(0);
  });

  it("the server that connects with the first prompt means nothing is ever reported", async () => {
    const h = await boot({ mcpConnects: "first_prompt", runner: { mcpGraceMs: 80 } });
    await sleep(200);
    send(h, "hello");
    await mcpClient(h);                       // agy starts the server for the turn
    await turnEnded(h);
    await sleep(250);
    expect(h.runner.mcpConnected).toBe(true);
    expect(h.events.mcp_died).toBeUndefined();
    expect(errors(h)).toHaveLength(0);
  });

  it("a turn that ended with no server counts the grace period from the turn's end, and is then reported", async () => {
    const h = await boot({ mcpConnects: "first_prompt", runner: { mcpGraceMs: 150 } });
    send(h, "hello");
    await turnEnded(h);
    expect(h.events.mcp_died).toBeUndefined();
    await until(() => (h.events.mcp_died?.length ?? 0) === 1, 3000, "the report after a turn");
    expect(h.runner.isErrorState).toBe(true);
    expect(errors(h)).toHaveLength(1);
  });

  it("grok's kind (server with the session) is still reported without any prompt", async () => {
    const h = await boot({ mcpConnects: "with_session", runner: { mcpGraceMs: 80 } });
    await until(() => (h.events.mcp_died?.length ?? 0) === 1, 3000, "the report");
  });

  it("a report that a late connection retracts leaves no error in the chat timeline, and none after the timeline is read back from disk", async () => {
    const h = await boot({ runner: { mcpGraceMs: 60 } });
    await until(() => (h.events.mcp_died?.length ?? 0) === 1, 3000, "the report");
    expect(errors(h)).toHaveLength(1);
    await mcpClient(h);
    await until(() => (h.events.mcp_recovered?.length ?? 0) === 1, 3000, "the retraction");
    expect(errors(h)).toHaveLength(0);
    const all = h.runner.steps.snapshot(undefined, { thoughts: false }).steps;
    expect(all.some(s => s.kind === "state" && /connected after all/.test(s.note ?? ""))).toBe(true);
    // what was saved is the retracted step, not the error
    const reloaded = new AcpStepStore(h.dir).snapshot(undefined, { thoughts: false }).steps;
    expect(reloaded.filter(s => s.kind === "error")).toHaveLength(0);
    expect(reloaded.some(s => s.kind === "state")).toBe(true);
  });

  it("a stopped instance's timer never reports, and neither does a paused one", async () => {
    const stopped = await boot({ mcpConnects: "with_session", runner: { mcpGraceMs: 120 } });
    await stopped.runner.stop();
    const paused = await boot({ mcpConnects: "with_session", runner: { mcpGraceMs: 120 } });
    await paused.runner.pause("operator");
    await sleep(350);
    expect(stopped.events.mcp_died).toBeUndefined();
    expect(paused.events.mcp_died).toBeUndefined();
  });
});

describe("a configured model that carries its effort level (agy) is split for ACP", () => {
  const setConfigs = (state: string) => calls(state).filter(c => c.setConfig).map(c => c.setConfig);
  const agy = { FAKE_ACP_CONFIG: "1", FAKE_ACP_MODELS: "gemini-4-hydrogen,gemini-4-carbon,gemini-4-argon" };

  it("applies gemini-4-carbon-high as the model gemini-4-carbon plus the level high as the effort", async () => {
    const h = await boot({ env: agy, config: { model: "gemini-4-carbon-high" } });
    await until(() => setConfigs(h.state).length >= 2, 4000, "both settings");
    expect(setConfigs(h.state)).toEqual([expect.objectContaining({ configId: "model", value: "gemini-4-carbon" }), expect.objectContaining({ configId: "effort", value: "high" })]);
    expect(h.events.backend_launch_warning).toBeUndefined();
  });

  it("the configured effort wins over the level in the id", async () => {
    const h = await boot({ env: agy, config: { model: "gemini-4-carbon-high", effort: "low" } as never });
    await until(() => setConfigs(h.state).length >= 2, 4000, "both settings");
    expect(setConfigs(h.state).find(c => c.configId === "effort")).toMatchObject({ value: "low" });
  });

  it("an id the agent offers as it is is applied as it is", async () => {
    const h = await boot({ env: agy, config: { model: "gemini-4-argon" } });
    await until(() => setConfigs(h.state).length >= 1, 4000, "the model");
    expect(setConfigs(h.state)[0]).toMatchObject({ configId: "model", value: "gemini-4-argon" });
  });

  it("a model nothing offers is not applied, and the person is told in the chat as well as the log", async () => {
    const h = await boot({ env: agy, config: { model: "no-such-model-high" } });
    await until(() => (h.events.backend_launch_warning?.length ?? 0) === 1, 4000, "the warning");
    expect(h.events.backend_launch_warning![0].message).toContain("was not applied");
    const errs = h.runner.steps.snapshot(undefined, { thoughts: false }).steps.filter(s => s.kind === "error");
    expect(errs).toHaveLength(1);
    expect(errs[0]!.body).toContain("no-such-model");
  });

  it("a live model change with a tmux-style id is split too", async () => {
    const h = await boot({ env: agy });
    const result = await h.runner.setSessionSetting("model", "gemini-4-argon-low");
    expect(result).toMatchObject({ ok: true, value: "gemini-4-argon" });
    expect(setConfigs(h.state).map(c => `${c.configId}=${c.value}`)).toEqual(["model=gemini-4-argon", "effort=low"]);
  });
});

// ───────────────────────────────────────────────────────────────────────── 3. terminal-only input

describe("terminal input sent to an ACP instance is never a prompt", () => {
  const rawCases: Record<string, any> = {
    "/effort low": { type: "raw_paste", content: "/effort low" },
    "/model grok-4.6": { type: "raw_paste", content: "/model grok-4.6" },
    "/model with the runtime-switch id": { type: "raw_paste", content: "/model opus", runtime_switch: { id: "switch-1", kind: "model", requested: "opus" } },
    "/compact": { type: "raw_paste", content: "/compact", context_reset: "compact" },
    "/clear": { type: "raw_paste", content: "/clear", context_reset: "clear" },
    "/save notes": { type: "raw_paste", content: "/chat save notes" },
    "/chat load notes": { type: "raw_paste", content: "/chat load notes" },
    "/login": { type: "raw_paste", content: "/login" },
  };

  it("none of the raw pastes the fleet sends (effort, model, compact, clear, save, load, login) reaches the agent", async () => {
    const h = await boot();
    for (const msg of Object.values(rawCases)) h.fleet.send(msg);
    await sleep(300);
    expect(prompts(h.state)).toEqual([]);
    expect(h.runner.steps.snapshot(undefined, { thoughts: true }).steps).toEqual([]);
    expect(h.runner.getInstanceState()).toBe("idle");
  });

  it("a paste that asked to be told when it was written is answered `not_written`", async () => {
    const h = await boot();
    h.fleet.send({ type: "raw_paste", content: "/compact", context_reset: "compact", notify_written: "w-1" });
    await until(() => h.broadcasts.some(m => m.type === "raw_paste_written"), 2000, "the answer");
    expect(h.broadcasts.find(m => m.type === "raw_paste_written")).toMatchObject({ id: "w-1", outcome: "not_written" });
    expect(prompts(h.state)).toEqual([]);
  });

  it("a human's `/raw <text>` message is not sent either, and its message is marked failed", async () => {
    const h = await boot();
    h.fleet.send({ type: "fleet_inbound", content: "/raw /effort low", meta: { chat_id: "c", message_id: "m-raw", user: "alice", source: "web" } });
    await until(() => (h.events.message_failed?.length ?? 0) === 1, 2000, "message_failed");
    expect(prompts(h.state)).toEqual([]);
  });

  it("a silent schedule's text is the one raw paste that is a prompt: sent exactly as written, with its delivery accounted", async () => {
    const h = await boot();
    h.fleet.send({ type: "raw_paste", content: "check the build", silent_schedule: true, delivery_id: "d-1", delivery_attempt: "1" });
    await until(() => prompts(h.state).length === 1, 3000, "the scheduled prompt");
    expect(history(h.state)).toEqual(["check the build"]);          // no [user:] envelope, no fleet wrapper
    await until(() => h.outbox.calls.some(c => c.startsWith("complete:d-1:delivered")), 3000, "delivery verdict");
    expect(h.outbox.calls[0]).toBe("begin:d-1:1");
  });

  it("an ordinary message still runs as a turn (the guard is for terminal input only)", async () => {
    const h = await boot();
    h.fleet.send({ type: "fleet_inbound", content: "hello", meta: { chat_id: "c", message_id: "m1", user: "alice", source: "web" } });
    await until(() => prompts(h.state).length === 1, 3000, "the prompt");
  });
});

// ───────────────────────────────────────────────────────────────────────── effort and model, through the protocol

describe("effort and model of an ACP agent are session settings", () => {
  const settings = (state: string) => calls(state).filter(c => c.setConfig).map(c => c.setConfig);

  it("setConfigOption sends session/set_config_option for a value the agent lists, and reads the answer", async () => {
    const h = await boot({ env: { FAKE_ACP_CONFIG: "1" } });
    expect(h.adapter.configOption("thought_level")).toMatchObject({ id: "effort", values: ["low", "medium", "high"], currentValue: "medium" });
    expect(await h.adapter.setConfigOption("thought_level", "low")).toEqual({ ok: true, value: "low" });
    expect(settings(h.state)).toEqual([{ sessionId: expect.any(String), configId: "effort", value: "low" }]);
    expect(h.adapter.configOption("thought_level")!.currentValue).toBe("low");
  });

  it("a value the agent does not list is refused with what it does list, and nothing is sent", async () => {
    const h = await boot({ env: { FAKE_ACP_CONFIG: "1" } });
    const r = await h.adapter.setConfigOption("thought_level", "ultra");
    expect(r).toMatchObject({ ok: false, reason: "invalid", accepted: ["low", "medium", "high"] });
    expect(settings(h.state)).toEqual([]);
  });

  it("an agent that offers no such setting says so (no request)", async () => {
    const h = await boot();                                          // no configOptions
    expect(await h.adapter.setConfigOption("thought_level", "low")).toMatchObject({ ok: false, reason: "not_offered" });
    expect(h.runner.sessionSettingValues("effort")).toEqual([]);
    expect(settings(h.state)).toEqual([]);
  });

  it("the configured effort and model are applied when the instance starts (agy takes no launch flag for them)", async () => {
    const h = await boot({ env: { FAKE_ACP_CONFIG: "1" }, config: { model: "m2", effort: "high" } as Partial<InstanceConfig> });
    await until(() => settings(h.state).length === 2, 3000, "both settings");
    expect(settings(h.state).map(s => `${s.configId}=${s.value}`).sort()).toEqual(["effort=high", "model=m2"]);
  });

  it("a configured value the agent does not offer becomes a launch warning, not a typed command", async () => {
    const h = await boot({ env: { FAKE_ACP_CONFIG: "1" }, config: { model: "no-such-model" } as Partial<InstanceConfig> });
    await until(() => (h.events.backend_launch_warning?.length ?? 0) === 1, 3000, "the warning");
    expect(h.events.backend_launch_warning![0].message).toContain("no-such-model");
    expect(h.events.backend_launch_warning![0].message).toContain("m1, m2");
    expect(settings(h.state)).toEqual([]);
    expect(prompts(h.state)).toEqual([]);
  });

  it("setSessionSetting maps effort to the thought_level setting and model to the model setting", async () => {
    const h = await boot({ env: { FAKE_ACP_CONFIG: "1" } });
    expect(await h.runner.setSessionSetting("effort", "high")).toMatchObject({ ok: true });
    expect(await h.runner.setSessionSetting("model", "m2")).toMatchObject({ ok: true });
    expect(h.runner.sessionSettingValues("model")).toEqual(["m1", "m2"]);
    expect(settings(h.state).map(s => s.configId)).toEqual(["effort", "model"]);
  });
});

// ───────────────────────────────────────────────────────────────────────── the fleet's call sites

describe("the fleet answers terminal-only commands for an ACP instance instead of sending them", () => {
  const sent: any[] = [];
  const ipc = { connected: true, send: (m: unknown) => { sent.push(m); return true; } };
  const reply = (key: string, ...args: unknown[]) => [key, ...args].join("|");

  const topicCommands = async (acp: boolean, backend = "grok") => {
    const { TopicCommands } = await import("../src/topic-commands.js");
    const ctx = {
      instanceIpcClients: new Map([["w", ipc]]), fleetConfig: { instances: { w: { backend } }, defaults: {} }, classicChannels: undefined,
      instanceRunsAcp: () => acp,
    };
    return new TopicCommands(ctx as never);
  };
  const fleetManager = async (acp: boolean, backend = "grok", runner?: unknown) => {
    const { FleetManager } = await import("../src/fleet-manager.js");
    const fm = Object.create(FleetManager.prototype) as any;
    fm.fleetConfig = { instances: { w: { backend, ...(acp ? { cli_adapter: "acp" } : {}) } }, defaults: {} };
    fm.lifecycle = { daemons: new Map(runner ? [["w", runner]] : []) };
    fm.instanceIpcClients = new Map([["w", ipc]]);
    fm.logger = logger;
    fm.saveFleetConfig = () => undefined;
    fm.persistInstanceModel = (name: string, model: string) => { fm.fleetConfig.instances[name].model = model; return true; };
    return fm;
  };

  afterEach(() => { sent.length = 0; });

  it("/compact, /clear and /save: nothing is sent, and the reply says why", async () => {
    const tc = await topicCommands(true);
    expect(tc.compactInstance("w", "keep the plan")).toMatchObject({ sent: false });
    expect(tc.compactInstance("w").text).toContain("ACP");
    expect(tc.supportsClear("w")).toBe(false);
    expect(tc.clearInstance("w")).toMatchObject({ sent: false });
    expect(await tc.sendSave("w", "notes")).toContain("ACP");
    expect(sent).toEqual([]);
    expect(reply("x")).toBe("x");
  });

  it("the same calls on a tmux instance still type into the pane (the guard is not general)", async () => {
    const tc = await topicCommands(false, "claude-code");                // a backend that has all three commands
    expect(tc.compactInstance("w").sent).toBe(true);
    expect(tc.clearInstance("w").sent).toBe(true);
    await tc.sendSave("w", "notes");
    expect(sent.map(m => m.type)).toEqual(["raw_paste", "raw_paste", "raw_paste"]);
  });

  it("pasteRawToClassicInstance (the one path of /chat load, a classic /save, and the runtime /effort and /model) sends nothing", async () => {
    const acp = await fleetManager(true);
    expect(acp.pasteRawToClassicInstance("w", "/chat load notes")).toBe(false);
    expect(acp.pasteRawToClassicInstance("w", "/effort low")).toBe(false);
    expect(sent).toEqual([]);
    const tmux = await fleetManager(false);
    expect(tmux.pasteRawToClassicInstance("w", "/chat load notes")).toBe(true);
    expect(sent).toEqual([{ type: "raw_paste", content: "/chat load notes" }]);
  });

  it("the runtime model switch (claude's /model with a result to wait for) is not started on an ACP instance", async () => {
    const fm = await fleetManager(true);
    expect(await fm.runRuntimeModelSwitch("w", "opus")).toEqual({ outcome: "not_sent" });
    expect(sent).toEqual([]);
  });

  it("/effort on a running ACP agent is set through the protocol, clamped to what it offers, and saved", async () => {
    const calls: [string, string][] = [];
    const runner = { sessionSettingValues: () => ["low", "medium", "high"], setSessionSetting: async (k: string, v: string) => { calls.push([k, v]); return { ok: true as const, value: v }; } };
    const fm = await fleetManager(true, "grok");
    fm.acpRunnerOf = () => runner;
    fm.effortLevelsFor = () => ["low", "medium", "high"];
    fm.shownInstanceName = (n: string) => n;
    const text = await fm.applyEffort("w", "max");
    expect(calls).toEqual([["effort", "high"]]);                      // max is not offered: the nearest level below it
    expect(fm.fleetConfig.instances.w.effort).toBe("high");
    expect(text).toContain("high");
    expect(sent).toEqual([]);                                          // and nothing was pasted
  });

  it("/effort the agent refuses is not saved, and the answer carries the values it offers", async () => {
    const runner = { sessionSettingValues: () => ["low", "high"], setSessionSetting: async () => ({ ok: false as const, reason: "failed" as const, message: "unknown value", accepted: ["low", "high"] }) };
    const fm = await fleetManager(true, "grok");
    fm.acpRunnerOf = () => runner;
    fm.effortLevelsFor = () => ["low", "high"];
    fm.shownInstanceName = (n: string) => n;
    const text = await fm.applyEffort("w", "low");
    expect(fm.fleetConfig.instances.w.effort).toBeUndefined();
    expect(text).toContain("unknown value");
    expect(text).toContain("low, high");
    expect(sent).toEqual([]);
  });

  it("/model: a name the agent does not list is refused before anything happens; a listed one is set and saved", async () => {
    const calls: [string, string][] = [];
    const runner = { sessionSettingValues: () => ["grok-4.7", "grok-4.6"], setSessionSetting: async (k: string, v: string) => { calls.push([k, v]); return { ok: true as const, value: v }; } };
    const fm = await fleetManager(true, "grok");
    fm.acpRunnerOf = () => runner;
    fm.shownInstanceName = (n: string) => n;
    expect(await fm.applyModel("w", "nonsense")).toContain("grok-4.7, grok-4.6");
    expect(calls).toEqual([]);
    expect(fm.fleetConfig.instances.w.model).toBeUndefined();
    await fm.applyModel("w", "grok-4.6");
    expect(calls).toEqual([["model", "grok-4.6"]]);
    expect(fm.fleetConfig.instances.w.model).toBe("grok-4.6");
    expect(sent).toEqual([]);
  });

  it("an ACP instance that is stopped saves the value for its next start and says so", async () => {
    const fm = await fleetManager(true, "grok");
    fm.acpRunnerOf = () => null;
    fm.effortLevelsFor = () => ["low", "medium", "high"];
    fm.shownInstanceName = (n: string) => n;
    const text = await fm.applyEffort("w", "low");
    expect(fm.fleetConfig.instances.w.effort).toBe("low");
    expect(text).toContain("low");
    expect(sent).toEqual([]);
  });

  it("the slash /save of a fleet topic and of a classic channel: answered for an ACP instance, nothing pasted", async () => {
    for (const kind of ["fleet", "classic"]) {
      const fm = await fleetManager(true, "grok");
      fm.isModelAdmin = () => true;
      fm.shownInstanceName = (n: string) => n;
      fm.classicChannels = { getInstanceByChannel: () => (kind === "classic" ? "w" : undefined), getBackendByInstance: () => "grok" };
      fm.routing = { resolve: () => ({ kind: "fleet", name: "w" }) };
      const answers: string[] = [];
      await fm.handleSlashSave({ channelId: "c", userId: "u", options: { filename: "notes" }, respond: async (text: string) => { answers.push(text); return undefined; } });
      expect(answers).toHaveLength(1);
      expect(answers[0]).toContain("ACP");
      expect(sent).toEqual([]);
    }
  });

  it("instanceRunsAcp: a running instance answers by its adapter, a stopped one by its configuration", async () => {
    expect((await fleetManager(true)).instanceRunsAcp("w")).toBe(true);
    expect((await fleetManager(false)).instanceRunsAcp("w")).toBe(false);
    // a running one is judged by the adapter it was built with, whatever the configuration says now
    const { bindAdapter } = await import("../src/adapters/registry.js");
    const running = {};
    bindAdapter({ id: "acp", runner: running } as never);
    expect((await fleetManager(false, "grok", running)).instanceRunsAcp("w")).toBe(true);
    const tmuxRunning = {};
    bindAdapter({ id: "tmux", runner: tmuxRunning } as never);
    expect((await fleetManager(true, "grok", tmuxRunning)).instanceRunsAcp("w")).toBe(false);
  });
});

