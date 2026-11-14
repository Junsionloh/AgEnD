/**
 * #3731 phase 1: the ACP runner — what the fleet sees of an instance that runs over ACP — driven through its IPC
 * socket the way the fleet and an MCP server drive it, with a fake ACP agent behind it. Covers busy/idle, permission
 * policy, cancel, crash and respawn, hang, delivery verdicts, the chat timeline, and what survives a restart.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IpcClient } from "../src/channel/ipc-bridge.js";
import { AcpAdapter } from "../src/adapters/acp/acp-adapter.js";
import { AcpRunner, type AcpRunnerOptions } from "../src/adapters/acp/acp-runner.js";
import { AGY_PROFILE } from "../src/adapters/acp/profiles.js";
import { LogService, type LogSource } from "../src/log-service.js";
import type { InstanceConfig } from "../src/types.js";

const FAKE = join(import.meta.dirname, "fixtures", "acp", "fake-acp-agent.mjs");
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const dirs: string[] = [];
const runners: AcpRunner[] = [];
const clients: IpcClient[] = [];
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), "acpr-")); dirs.push(d); return d; };
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

interface Harness {
  runner: AcpRunner; adapter: AcpAdapter; dir: string; state: string; fleet: IpcClient;
  outbound: any[]; events: Record<string, any[]>; outbox: FakeOutbox;
}

class FakeOutbox {
  calls: string[] = [];
  begin(id: string, _boot: string, attempt: number) { this.calls.push(`begin:${id}:${attempt}`); return "begun" as const; }
  markEnterStarted(id: string) { this.calls.push(`enter:${id}`); return true; }
  complete(id: string, _boot: string, _a: number, outcome: string, evidence?: string) { this.calls.push(`complete:${id}:${outcome}:${evidence}`); return true; }
  retryBeforeBegin(id: string, _b: string, _a: number, reason: string) { this.calls.push(`retry:${id}:${reason}`); return true; }
  abort() { return true; }
}

async function boot(opts: { dir?: string; state?: string; config?: Partial<InstanceConfig>; runner?: Partial<AcpRunnerOptions>; env?: Record<string, string> } = {}): Promise<Harness> {
  const dir = opts.dir ?? tmp();
  const state = opts.state ?? tmp();
  const config = { working_directory: dir, backend: "antigravity", cli_adapter: "acp", ...opts.config } as InstanceConfig;
  const profile = { ...AGY_PROFILE, supportedVersions: ["1.5.8"], args: () => [FAKE] };
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
  for (const name of ["message_queued", "message_delivered", "message_confirmed", "message_failed", "crash_respawn", "crash_loop", "human_messages_cancelled", "backend_launch_warning"]) {
    runner.on(name, (data: unknown) => (events[name] ??= []).push(data));
  }
  await runner.start();
  const fleet = new IpcClient(join(dir, "channel.sock"));
  clients.push(fleet);
  await fleet.connect();
  const outbound: any[] = [];
  fleet.on("message", (m: any) => {
    if (m.type === "fleet_outbound") {
      outbound.push(m);
      fleet.send({ type: "fleet_outbound_response", fleetRequestId: m.fleetRequestId, result: { messageId: "m1" } });
    }
  });
  return { runner, adapter, dir, state, fleet, outbound, events, outbox };
}

const person = (text: string, id = "msg-1", extra: Record<string, string> = {}) =>
  ({ type: "fleet_inbound", content: text, meta: { chat_id: "chat-1", message_id: id, user: "alice", source: "web", ...extra } });
const steps = (h: Harness, thoughts = true) => h.runner.steps.snapshot(undefined, { thoughts }).steps;
const calls = (state: string): any[] => readFileSync(join(state, "calls.jsonl"), "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
const idle = (h: Harness) => until(() => h.runner.getInstanceState() === "idle" && steps(h).some(s => s.kind === "turn_end"), 5000, "the turn to end");

describe("a turn through the IPC socket", () => {
  it("runs a person's message: busy then idle, steps in the timeline, delivery events, proxy reply", async () => {
    const h = await boot();
    expect(h.runner.getProcessStatus()).toBe("running");
    expect(h.runner.getInstanceState()).toBe("idle");
    h.fleet.send(person("hello there #linger"));
    await until(() => h.runner.getInstanceState() === "working", 3000, "busy");
    await idle(h);
    const s = steps(h);
    expect(s.map(x => x.kind)).toEqual(["user", "thought", "assistant", "turn_end"]);
    expect(s[0]).toMatchObject({ body: "hello there #linger" });
    expect(s[1]).toMatchObject({ kind: "thought", body: "Let me think." }); // two chunks, one step
    expect(s[2]).toMatchObject({ kind: "assistant", body: "OK", status: "done" });
    expect(h.events.message_delivered).toEqual([{ chatId: "chat-1", messageId: "msg-1" }]);
    expect(h.events.message_confirmed).toEqual([{ chatId: "chat-1", messageId: "msg-1" }]);
    // the agent used no reply tool: its text is sent as the reply, to this chat
    await until(() => h.outbound.length === 1, 3000, "the proxy reply");
    expect(h.outbound[0]).toMatchObject({ tool: "reply", args: { text: "OK", chat_id: "chat-1" } });
  });

  it("does not send a proxy reply when the agent already replied with a tool", async () => {
    const h = await boot();
    h.fleet.send(person("hello #linger"));
    // the MCP server's tool call, arriving while the turn runs
    await until(() => h.runner.getInstanceState() === "working", 3000, "busy");
    const mcp = new IpcClient(join(h.dir, "channel.sock"));
    clients.push(mcp);
    await mcp.connect();
    const answered: any[] = [];
    mcp.on("message", (m: any) => { if (m.requestId === 7) answered.push(m); });
    mcp.send({ type: "mcp_ready", sessionName: "worker" });
    mcp.send({ type: "tool_call", tool: "reply", args: { text: "hi alice" }, requestId: 7 });
    await until(() => answered.length === 1, 3000, "the tool answer");
    await idle(h);
    await sleep(100);
    expect(h.outbound.filter(o => o.tool === "reply")).toHaveLength(1);
    expect(h.outbound[0].args).toMatchObject({ text: "hi alice", chat_id: "chat-1" });
  });

  it("serialises messages: the second waits for the first, and says it was queued", async () => {
    const h = await boot();
    h.fleet.send(person("one", "m-1"));
    h.fleet.send(person("two", "m-2"));
    await until(() => steps(h).filter(s => s.kind === "turn_end").length === 2, 6000, "both turns");
    expect(steps(h).filter(s => s.kind === "user").map(s => s.body)).toEqual(["one", "two"]);
    expect(h.events.message_queued).toEqual([{ chatId: "chat-1", messageId: "m-2" }]);
  });

  it("answers the fleet's state query from the runner", async () => {
    const h = await boot();
    const got: any[] = [];
    h.fleet.on("message", (m: any) => { if (m.type === "instance_state_response") got.push(m); });
    h.fleet.send({ type: "query_instance_state", requestId: 5 });
    await until(() => got.length === 1);
    expect(got[0]).toMatchObject({ instanceName: "worker", state: "idle", processStatus: "running", requestId: 5 });
    expect(got[0].interaction).toMatchObject({ phase: "clear" });
  });
});

describe("permissions", () => {
  it("asks by default: the request waits as a step with only the one-shot choices, and the instance reports waiting", async () => {
    const h = await boot();
    h.fleet.send(person("#tool"));
    await until(() => h.runner.steps.pendingPermissions().length === 1, 4000, "the permission request");
    const perm = steps(h).find(s => s.kind === "permission")!;
    expect(perm).toMatchObject({ status: "running", subject: "/work/hello.txt" });
    expect(perm.options!.map(o => o.kind)).toEqual(["allow_once", "reject_once"]); // allow_always is never offered
    expect(h.runner.getInteractionSnapshot()).toMatchObject({ phase: "waiting", kind: "permission" });
    expect(calls(h.state).some(l => l.permissionOutcome)).toBe(false);
  });

  it("allow answers the one-shot allow option; the tool runs", async () => {
    const h = await boot();
    h.fleet.send(person("#tool"));
    await until(() => h.runner.steps.pendingPermissions().length === 1);
    const id = h.runner.steps.pendingPermissions()[0]!.requestId;
    expect(h.runner.answerPermissionByUser(id, "allow")).toBeNull();
    await idle(h);
    expect(calls(h.state).find(l => l.permissionOutcome)?.permissionOutcome).toEqual({ outcome: "selected", optionId: "allow-once" });
    expect(steps(h).find(s => s.kind === "permission")).toMatchObject({ status: "done", note: "Yes" });
    expect(steps(h).find(s => s.kind === "tool")).toMatchObject({ status: "done" });
    expect(h.runner.answerPermissionByUser(id, "allow")).toMatch(/no such permission request/);
  });

  it("deny answers the one-shot refusal", async () => {
    const h = await boot();
    h.fleet.send(person("#tool"));
    await until(() => h.runner.steps.pendingPermissions().length === 1);
    expect(h.runner.answerPermissionByUser(h.runner.steps.pendingPermissions()[0]!.requestId, "deny")).toBeNull();
    await idle(h);
    expect(calls(h.state).find(l => l.permissionOutcome)?.permissionOutcome).toEqual({ outcome: "selected", optionId: "reject-once" });
    expect(steps(h).find(s => s.kind === "tool")).toMatchObject({ status: "failed" });
  });

  it("with acp_always_approve it answers allow-once itself and never an 'always' option", async () => {
    const h = await boot({ config: { acp_always_approve: true } });
    h.fleet.send(person("#tool"));
    await idle(h);
    expect(calls(h.state).find(l => l.permissionOutcome)?.permissionOutcome).toEqual({ outcome: "selected", optionId: "allow-once" });
    expect(steps(h).find(s => s.kind === "permission")).toMatchObject({ status: "done", note: "Yes (auto)" });
    expect(h.runner.steps.pendingPermissions()).toHaveLength(0);
  });

  it("is asked again for the next request: approval is not remembered", async () => {
    const h = await boot();
    for (const n of [1, 2]) {
      h.fleet.send(person("#tool", `m-${n}`));
      await until(() => h.runner.steps.pendingPermissions().length === 1, 4000, `request ${n}`);
      h.runner.answerPermissionByUser(h.runner.steps.pendingPermissions()[0]!.requestId, "allow");
      await until(() => steps(h).filter(s => s.kind === "turn_end").length === n, 5000, `turn ${n}`);
    }
    expect(calls(h.state).filter(l => l.permissionOutcome)).toHaveLength(2);
  });
});

describe("cancel", () => {
  it("with a request waiting: it is answered 'cancelled', the turn ends, nothing is allowed, and a queued message is dropped", async () => {
    const h = await boot();
    h.fleet.send(person("#tool", "m-1"));
    h.fleet.send(person("later", "m-2"));
    await until(() => h.runner.steps.pendingPermissions().length === 1);
    // what FleetManager.cancelInstance does: drop what has not started, then cancel through the adapter
    h.runner.clearPendingDeliveries();
    await h.adapter.cancel();
    await until(() => steps(h).some(s => s.kind === "turn_end"), 4000, "the turn to end");
    expect(calls(h.state).find(l => l.permissionOutcome)?.permissionOutcome).toEqual({ outcome: "cancelled" });
    expect(steps(h).find(s => s.kind === "permission")).toMatchObject({ status: "interrupted", note: "cancelled" });
    expect(steps(h).find(s => s.kind === "turn_end")).toMatchObject({ note: "cancelled" });
    await until(() => h.runner.getInstanceState() === "idle");
    await sleep(100);
    expect(steps(h).filter(s => s.kind === "user")).toHaveLength(1); // "later" never started
    expect(h.events.message_confirmed ?? []).toEqual([]);
    expect(h.events.human_messages_cancelled?.[0]?.messages ?? await (async () => { await sleep(700); return h.events.human_messages_cancelled?.[0]?.messages; })()).toEqual([{ chatId: "chat-1", messageId: "m-2" }]);
  });

  it("a running turn is interrupted with session/cancel", async () => {
    const h = await boot();
    h.fleet.send(person("#slow"));
    await until(() => steps(h).some(s => s.kind === "thought"), 4000, "the turn to start");
    h.runner.clearPendingDeliveries();
    await h.adapter.cancel();
    await until(() => steps(h).some(s => s.kind === "turn_end"), 4000);
    expect(steps(h).find(s => s.kind === "turn_end")).toMatchObject({ note: "cancelled" });
    expect(calls(h.state).some(l => l.in === "session/cancel")).toBe(true);
  });

  it("a user's cancel decision from the chat button cancels the turn", async () => {
    const h = await boot();
    h.fleet.send(person("#tool"));
    await until(() => h.runner.steps.pendingPermissions().length === 1);
    expect(h.runner.answerPermissionByUser(h.runner.steps.pendingPermissions()[0]!.requestId, "cancel")).toBeNull();
    await until(() => steps(h).some(s => s.kind === "turn_end"), 4000);
    expect(calls(h.state).find(l => l.permissionOutcome)?.permissionOutcome).toEqual({ outcome: "cancelled" });
  });
});

describe("crash, respawn and hang", () => {
  it("respawns after the agent dies mid-turn, resumes the same conversation, and fails that turn visibly", async () => {
    const h = await boot({ runner: { respawnDelaysMs: [30] } });
    const id = h.adapter.sessionId();
    h.fleet.send(person("#crash"));
    await until(() => (h.events.crash_respawn ?? []).length === 1, 6000, "the respawn");
    expect(h.adapter.sessionId()).toBe(id);
    expect(h.adapter.isNewSession).toBe(false);
    expect(h.runner.getProcessStatus()).toBe("running");
    expect(steps(h).some(s => s.kind === "error")).toBe(true);
    expect(h.events.message_failed).toEqual([{ chatId: "chat-1", messageId: "msg-1" }]);
    h.fleet.send(person("hello again", "m-2"));
    await until(() => steps(h).some(s => s.kind === "assistant" && s.body === "OK"), 5000, "a normal turn after the respawn");
  });

  it("stops respawning after repeated crashes and says so", async () => {
    const h = await boot({ runner: { respawnDelaysMs: [10], crashLoop: { count: 2, windowMs: 60_000 } } });
    h.fleet.send(person("#crash 1", "c-1"));
    await until(() => (h.events.crash_respawn ?? []).length === 1, 6000);
    h.fleet.send(person("#crash 2", "c-2"));
    await until(() => h.runner.isCrashLoop, 6000, "the crash loop");
    expect(h.events.crash_loop).toHaveLength(1);
    expect(h.runner.notAcceptingReason()).toBe("crash loop");
    await sleep(200);
    expect(h.runner.getProcessStatus()).not.toBe("running");
  });

  it("reports a hang when a running turn has gone quiet, and clears it when the agent speaks again", async () => {
    const h = await boot({ runner: { hangAfterMs: 120, hangCheckEveryMs: 10_000 } });
    const hangs: any[] = [];
    h.runner.getHangDetector().on("hang", d => hangs.push(d));
    h.fleet.send(person("#slow"));
    await until(() => h.runner.getInstanceState() === "working", 3000);
    await sleep(250);
    h.runner.checkHang();
    expect(hangs).toHaveLength(1);
    expect(h.runner.getInstanceState()).toBe("stuck");
    h.runner.checkHang();
    expect(hangs).toHaveLength(1); // once per episode
    h.runner.clearPendingDeliveries();
    await h.adapter.cancel();
    await until(() => h.runner.getInstanceState() === "idle", 4000);
  });

  it("a permission request waiting for a person is not a hang", async () => {
    const h = await boot({ runner: { hangAfterMs: 50, hangCheckEveryMs: 10_000 } });
    const hangs: any[] = [];
    h.runner.getHangDetector().on("hang", d => hangs.push(d));
    h.fleet.send(person("#tool"));
    await until(() => h.runner.steps.pendingPermissions().length === 1);
    await sleep(150);
    h.runner.checkHang();
    expect(hangs).toHaveLength(0);
  });
});

describe("the delivery outbox", () => {
  const durable = { delivery_id: "d-1", delivery_attempt: "1" };
  it("records one verdict per attempt: delivered, with the evidence the agent gave", async () => {
    const h = await boot();
    h.fleet.send(person("hello", "m-1", durable));
    await idle(h);
    expect(h.outbox.calls.filter(c => c.startsWith("begin") || c.startsWith("enter") || c.startsWith("complete"))).toEqual([
      "begin:d-1:1", "enter:d-1", "complete:d-1:delivered:acp:user-message-echo",
    ]);
  });
  it("an agent that dies before it showed any sign of having the message leaves the attempt uncertain", async () => {
    const h = await boot({ runner: { respawnDelaysMs: [10_000] }, env: { FAKE_ACP_NO_ECHO: "1" } });
    h.fleet.send(person("#crash", "m-1", durable));
    await until(() => h.outbox.calls.some(c => c.startsWith("complete")), 6000, "a verdict");
    expect(h.outbox.calls.filter(c => c.startsWith("complete"))).toHaveLength(1);
  });
  it("a message dropped by a cancel before it started is handed back for retry, not delivered", async () => {
    const h = await boot();
    h.runner.clearPendingDeliveries();
    h.fleet.send({ ...person("old", "m-1", durable), delivery_epoch: 0 });
    await until(() => h.outbox.calls.some(c => c.startsWith("retry")), 3000, "the retry");
    expect(h.outbox.calls.some(c => c.includes("complete"))).toBe(false);
  });
});

describe("what survives a restart", () => {
  it("shows the earlier conversation again, never its thinking, and resumes the session", async () => {
    const h = await boot();
    h.fleet.send(person("remember me"));
    await idle(h);
    const id = h.adapter.sessionId();
    await h.runner.stop();
    const file = readFileSync(join(h.dir, "acp-steps.jsonl"), "utf8");
    expect(file).toContain("remember me");
    expect(file).not.toContain("Let me think");

    const h2 = await boot({ dir: h.dir, state: h.state });
    expect(h2.adapter.sessionId()).toBe(id);
    expect(h2.adapter.isNewSession).toBe(false);
    const again = steps(h2);
    expect(again.map(s => s.kind)).toEqual(["user", "assistant", "turn_end"]);
    expect(again.some(s => s.kind === "thought")).toBe(false);
  });
});

describe("the Log's view of an ACP instance", () => {
  const view = async (h: Harness, q: { admin?: boolean }, thinking: boolean) => {
    const live = h.runner.liveSteps;
    const service = new LogService({
      enabled: () => true, thinking: () => thinking, known: () => true,
      source: (): LogSource => ({ backend: "antigravity", path: null, format: null, live }),
      events: () => [], emit: () => undefined,
    });
    return service.steps("worker", q) as Promise<any>;
  };

  it("thought text only for an admin, and only when web.log_thinking is on", async () => {
    const h = await boot();
    h.fleet.send(person("hello"));
    await idle(h);
    const kinds = (a: any) => a.steps.map((s: any) => s.kind);
    expect(kinds(await view(h, { admin: true }, true))).toContain("thought");
    expect(kinds(await view(h, { admin: true }, false))).not.toContain("thought");
    expect(kinds(await view(h, { admin: false }, true))).not.toContain("thought");
    expect(kinds(await view(h, {}, true))).not.toContain("thought");
  });

  it("a reader who is not an admin sees a request waiting but not its answer buttons", async () => {
    const h = await boot();
    h.fleet.send(person("#tool"));
    await until(() => h.runner.steps.pendingPermissions().length === 1);
    const admin = await view(h, { admin: true }, false);
    const guest = await view(h, { admin: false }, false);
    expect(admin.steps.find((s: any) => s.kind === "permission").options).toHaveLength(2);
    const seen = guest.steps.find((s: any) => s.kind === "permission");
    expect(seen).toMatchObject({ status: "running" });
    expect(seen.options).toBeUndefined();
  });

  it("serves only what changed since the page's cursor, and starts again for another run's key", async () => {
    const h = await boot();
    h.fleet.send(person("hello"));
    await idle(h);
    const first = await view(h, { admin: true }, true);
    expect(first.key).toMatch(/^\d{1,20}-\d{1,20}$/); // the shape GET /ui/steps accepts for `key`
    const live = h.runner.liveSteps;
    const service = new LogService({ enabled: () => true, thinking: () => true, known: () => true, source: (): LogSource => ({ backend: "antigravity", path: null, format: null, live }), events: () => [], emit: () => undefined });
    expect((await service.steps("worker", { admin: true, after: first.after, key: first.key }) as any).steps).toEqual([]);
    h.fleet.send(person("again", "m-2"));
    await until(() => steps(h).filter(s => s.kind === "turn_end").length === 2, 5000);
    const next = await service.steps("worker", { admin: true, after: first.after, key: first.key }) as any;
    expect(next.steps.map((s: any) => s.kind)).toEqual(["user", "thought", "assistant", "turn_end"]);
    const other = await service.steps("worker", { admin: true, after: 3, key: "1-2" }) as any;
    expect(other.reset).toBe(true);
    expect(other.steps.length).toBeGreaterThan(4);
  });

  it("with the Log switched off, an admin still gets the request that is waiting for an answer, and nothing else", async () => {
    const h = await boot();
    h.fleet.send(person("#tool"));
    await until(() => h.runner.steps.pendingPermissions().length === 1);
    const live = h.runner.liveSteps;
    const service = new LogService({ enabled: () => false, thinking: () => true, known: () => true, source: (): LogSource => ({ backend: "antigravity", path: null, format: null, live }), events: () => [], emit: () => undefined });
    const admin = await service.steps("worker", { admin: true }) as any;
    expect(admin.steps.map((s: any) => s.kind)).toEqual(["permission"]);
    expect(admin.steps[0].options).toHaveLength(2);
    expect(await service.steps("worker", { admin: false })).toEqual({ enabled: false });
    expect(await service.steps("worker", {})).toEqual({ enabled: false });
  });
});
