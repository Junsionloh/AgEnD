/**
 * AGEND-279: the runner hands the fleet's answer to each reply to the timeline (an MCP `reply`, and the proxy reply AgEnD sends when
 * the agent used none), so the chat's block is anchored to the bubble by its message id. Driven through the IPC socket with a fake agent.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IpcClient } from "../src/channel/ipc-bridge.js";
import { AcpAdapter } from "../src/adapters/acp/acp-adapter.js";
import { AcpRunner } from "../src/adapters/acp/acp-runner.js";
import { AGY_PROFILE } from "../src/adapters/acp/profiles.js";
import type { InstanceConfig } from "../src/types.js";
// @ts-expect-error — a JS module of the app, with no types
import { groupSteps } from "../src/ui/chat-activity-groups.js";

const FAKE = join(import.meta.dirname, "fixtures", "acp", "fake-acp-agent.mjs");
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const dirs: string[] = [];
const runners: AcpRunner[] = [];
const clients: IpcClient[] = [];
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), "acpa-")); dirs.push(d); return d; };
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

async function boot() {
  const dir = tmp(), state = tmp();
  const config = { working_directory: dir, backend: "antigravity", cli_adapter: "acp", skipPermissions: false } as InstanceConfig;
  const profile = { ...AGY_PROFILE, args: () => [FAKE] };
  const holder: { runner?: AcpRunner } = {};
  const adapter = new AcpAdapter({
    profile, command: process.execPath, cwd: dir, instanceDir: dir, mcpServers: [], logger, env: { PATH: process.env.PATH }, childEnv: { FAKE_ACP_STATE: state, FAKE_ACP_VERSION: "1.5.8" },
    makeRunner: a => (holder.runner = new AcpRunner(a, { name: "worker", config, instanceDir: dir, topicMode: true, backend: "antigravity", logger })),
  });
  const runner = holder.runner!;
  runners.push(runner);
  void adapter;
  await runner.start();
  const fleet = new IpcClient(join(dir, "channel.sock"));
  clients.push(fleet);
  await fleet.connect();
  let n = 0;
  const outbound: any[] = [];
  // The fleet answers each reply with the message it made, as afterReplyRouted's callers see it.
  fleet.on("message", (m: any) => { if (m.type === "fleet_outbound") { outbound.push(m); fleet.send({ type: "fleet_outbound_response", fleetRequestId: m.fleetRequestId, result: { chatId: "web", messageId: `web-r${++n}` } }); } });
  return { runner, dir, fleet, outbound };
}
const person = (text: string, id: string) => ({ type: "fleet_inbound", content: text, meta: { chat_id: "chat-1", message_id: id, user: "alice", source: "web" } });
const steps = (h: { runner: AcpRunner }) => h.runner.steps.snapshot(undefined, { thoughts: true }).steps;
const ended = (h: { runner: AcpRunner }) => until(() => h.runner.getInstanceState() === "idle" && steps(h).some(s => s.kind === "turn_end"), 6000, "the turn to end");

describe("the runner anchors the timeline's reply steps by the message the fleet made", () => {
  it("a turn that ends with text AgEnD sent as the reply: a reply step carries the bubble's id, and the text is not repeated as a step", async () => {
    const h = await boot();
    h.fleet.send(person("hello #linger", "msg-1"));
    await ended(h);
    await until(() => steps(h).some(s => s.cat === "message"), 3000, "the proxy reply's step");
    const st = steps(h);
    const reply = st.find(s => s.cat === "message")!;
    expect(reply.anchor).toEqual({ replyText: "OK", messageId: "web-r1" });
    expect(st.find(s => s.kind === "assistant")).toMatchObject({ body: "OK", sent: true });
    const rows = [
      { boot: "b", id: 1, role: "user", anchor: "msg-1", text: "hello #linger", ts: new Date(st[0]!.ts).toISOString() },
      { boot: "b", id: 2, role: "agent", anchor: "web-r1", text: "OK", ts: new Date(st[0]!.ts + 900).toISOString() },
    ];
    const { groups } = groupSteps(rows, st, { now: st[0]!.ts + 10_000 });
    expect(groups.map((g: any) => [g.level, g.rowKey])).toEqual([["id", "b-2"]]);
    expect(groups[0].items.map((x: any) => x.kind)).toEqual(["thinking"]);
  });

  it("an MCP reply: the fleet's answer names the row, though the CLI's own update for the call carries no result", async () => {
    const h = await boot();
    h.fleet.send(person("hello #linger", "msg-1"));
    await until(() => h.runner.getInstanceState() === "working", 3000, "busy");
    const mcp = new IpcClient(join(h.dir, "channel.sock"));
    clients.push(mcp);
    await mcp.connect();
    const answered: any[] = [];
    mcp.on("message", (m: any) => { if (m.requestId === 7) answered.push(m); });
    mcp.send({ type: "mcp_ready", sessionName: "worker" });
    mcp.send({ type: "tool_call", tool: "reply", args: { text: "hi alice" }, requestId: 7 });
    await until(() => answered.length === 1, 3000, "the tool answer");
    await ended(h);
    await sleep(50);
    // (the fake agent does not announce the call itself, so the turn's end gave the confirmed reply a step of its own)
    expect(steps(h).filter(s => s.cat === "message").map(s => s.anchor)).toEqual([{ replyText: "hi alice", messageId: "web-r1" }]);
    expect(h.outbound.filter(o => o.tool === "reply")).toHaveLength(1);                      // and no proxy reply on top of it
  });
});
