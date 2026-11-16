/**
 * AGEND-279 (3): a message sent to an ACP agent that is busy. tmux queues a normal message until the turn ends; ACP has no
 * mid-turn input, so it does the same, and `/steer` is queued too and says so (it never claims to land mid-turn, and it never
 * cancels the running turn to make room). The runner is driven through its IPC socket with the fake ACP agent behind it.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IpcClient } from "../src/channel/ipc-bridge.js";
import { AcpAdapter } from "../src/adapters/acp/acp-adapter.js";
import { AcpRunner } from "../src/adapters/acp/acp-runner.js";
import { AGY_PROFILE } from "../src/adapters/acp/profiles.js";
import { TopicCommands } from "../src/topic-commands.js";
import type { InboundMessage } from "../src/channel/types.js";
import type { InstanceConfig } from "../src/types.js";

const FAKE = join(import.meta.dirname, "fixtures", "acp", "fake-acp-agent.mjs");
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const dirs: string[] = [];
const runners: AcpRunner[] = [];
const clients: IpcClient[] = [];
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), "acps-")); dirs.push(d); return d; };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 6000, what = "condition") => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(15); } };
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => undefined);
  await Promise.all(runners.splice(0).map(r => r.stop().catch(() => undefined)));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function boot() {
  const dir = tmp(), state = tmp();
  const config = { working_directory: dir, backend: "antigravity", cli_adapter: "acp" } as InstanceConfig;
  const profile = { ...AGY_PROFILE, supportedVersions: ["1.5.8"], args: () => [FAKE] };
  const holder: { runner?: AcpRunner } = {};
  const adapter = new AcpAdapter({
    profile, command: process.execPath, cwd: dir, instanceDir: dir, mcpServers: [], logger, env: { PATH: process.env.PATH }, childEnv: { FAKE_ACP_STATE: state, FAKE_ACP_VERSION: "1.5.8" },
    makeRunner: a => (holder.runner = new AcpRunner(a, { name: "worker", config, instanceDir: dir, topicMode: true, backend: "antigravity", logger })),
  });
  const runner = holder.runner!;
  runners.push(runner);
  const queued: unknown[] = [];
  runner.on("message_queued", (d: unknown) => queued.push(d));
  await runner.start();
  const fleet = new IpcClient(join(dir, "channel.sock"));
  clients.push(fleet);
  await fleet.connect();
  fleet.on("message", (m: any) => { if (m.type === "fleet_outbound") fleet.send({ type: "fleet_outbound_response", fleetRequestId: m.fleetRequestId, result: { messageId: "m1" } }); });
  return { runner, fleet, state, queued };
}
const meta = (id: string) => ({ chat_id: "chat-1", message_id: id, user: "alice", source: "web" });
const steps = (h: { runner: AcpRunner }) => h.runner.steps.snapshot(undefined, { thoughts: false }).steps;
const calls = (state: string): any[] => readFileSync(join(state, "calls.jsonl"), "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));

describe("a message that arrives while the agent is working", () => {
  it.each(["fleet_inbound", "steer"] as const)("%s: waits for the running turn, which is not cancelled, then runs as its own turn", async (type) => {
    const h = await boot();
    h.fleet.send({ type: "fleet_inbound", content: "first #linger", meta: meta("m-1") });
    await until(() => h.runner.getInstanceState() === "working", 3000, "busy");
    h.fleet.send({ type, content: "second", meta: meta("m-2") });
    await until(() => steps(h).filter(s => s.kind === "turn_end").length === 2, 8000, "both turns");
    expect(steps(h).filter(s => s.kind === "user").map(s => s.body)).toEqual(["first #linger", "second"]);
    // The first turn ran to its own end: nothing was cancelled to make room for the second.
    
    expect(calls(h.state).filter(c => "cancelled" in c)).toEqual([]);   // the fake agent logs every session/cancel it receives
    expect(h.queued).toEqual([{ chatId: "chat-1", messageId: "m-2" }]);
  });
});

describe("/steer in a chat, for an ACP instance", () => {
  const inbound = (text: string): InboundMessage => ({ source: "discord", adapterId: "discord-main", chatId: "c", threadId: "t", messageId: "m1", userId: "u", username: "u", text, timestamp: new Date(), isBotMessage: false });
  function setup(backend: string, acp: boolean) {
    const send = vi.fn();
    const sendText = vi.fn().mockResolvedValue({ messageId: "r", chatId: "c" });
    const commands = new TopicCommands({
      adapter: { sendText }, adapters: new Map(),
      fleetConfig: { defaults: {}, instances: { worker: { backend, working_directory: "/tmp", ...(acp ? { cli_adapter: "acp" } : {}) } } },
      instanceIpcClients: new Map([["worker", { connected: true, send }]]),
      instanceRunsAcp: () => acp, getDeliveryEpoch: () => 3, isFleetAdmin: () => false,
    } as any);
    return { commands, send, sendText };
  }
  it.each(["grok", "antigravity"])("%s over ACP: the message goes to the runner, and the reply says it is queued for the end of the turn", async (backend) => {
    const { commands, send, sendText } = setup(backend, true);
    expect(await commands.handleInstanceCommand(inbound("/steer do it"), "worker")).toBe(true);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0]).toMatchObject({ type: "steer", content: "do it" });
    const said = String(sendText.mock.calls[0][1]);
    expect(said).toMatch(/queued and lands when the running turn ends/);
    expect(said).not.toMatch(/mid-turn instead|lands mid-turn/);
  });
  it("a terminal grok instance is unchanged: it steers mid-turn; a terminal agy instance still refuses", async () => {
    const grok = setup("grok", false);
    await grok.commands.handleInstanceCommand(inbound("/steer do it"), "worker");
    expect(grok.send).toHaveBeenCalledOnce();
    expect(String(grok.sendText.mock.calls[0][1])).toContain("lands mid-turn");
    const agy = setup("antigravity", false);
    await agy.commands.handleInstanceCommand(inbound("/steer do it"), "worker");
    expect(agy.send).not.toHaveBeenCalled();
    expect(String(agy.sendText.mock.calls[0][1])).toContain("not supported");
  });
});
