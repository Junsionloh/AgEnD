/**
 * AGEND-279 (3): a message sent to an ACP agent that is busy, queue or interrupt, as the sender chooses. A normal message is queued until
 * the turn ends (as in tmux, the default). `/steer` (or `steer: true` from another instance) interrupts: the running turn is cancelled
 * (`session/cancel`), the message runs next in the SAME session with a line saying the last turn was cut short, ahead of what was
 * already queued; a permission request that waits is answered cancelled and its chat card retired; an idle agent just receives it.
 * The runner is driven through its IPC socket with the fake ACP agent behind it.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IpcClient } from "../src/channel/ipc-bridge.js";
import { AcpAdapter } from "../src/adapters/acp/acp-adapter.js";
import { AcpRunner } from "../src/adapters/acp/acp-runner.js";
import { AGY_PROFILE, GROK_PROFILE } from "../src/adapters/acp/profiles.js";
import { TopicCommands } from "../src/topic-commands.js";
import { outboundHandlers } from "../src/outbound-handlers.js";
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

/** `grok`: the profile with `_x.ai/interject`; default: agy's (a second prompt folded into the running one: FAKE_ACP_CONCURRENT); `plain`: a CLI with no way to add to a turn. `env`: fake-agent switches. */
async function boot(o: { grok?: boolean; plain?: boolean; env?: Record<string, string>; log?: { info(...a: any[]): void; warn(...a: any[]): void; error(...a: any[]): void; debug(...a: any[]): void }; outbox?: unknown; cancelEveryMs?: number } = {}) {
  const dir = tmp(), state = tmp();
  const config = { working_directory: dir, backend: o.grok ? "grok" : "antigravity", cli_adapter: "acp" } as InstanceConfig;
  const base = o.grok ? GROK_PROFILE : AGY_PROFILE;
  const profile = { ...base, ...(o.plain ? { interject: undefined } : {}), supportedVersions: ["1.5.8"], versionOf: AGY_PROFILE.versionOf, args: () => [FAKE] };
  const holder: { runner?: AcpRunner } = {};
  const adapter = new AcpAdapter({
    profile, command: process.execPath, cwd: dir, instanceDir: dir, mcpServers: [], logger: o.log ?? logger, env: { PATH: process.env.PATH }, childEnv: { FAKE_ACP_STATE: state, FAKE_ACP_VERSION: "1.5.8", ...o.env },
    makeRunner: a => (holder.runner = new AcpRunner(a, { name: "worker", config, instanceDir: dir, topicMode: true, backend: o.grok ? "grok" : "antigravity", logger: o.log ?? logger, ...(o.cancelEveryMs ? { cancelRetryEveryMs: o.cancelEveryMs } : {}) })),
  });
  const runner = holder.runner!;
  runners.push(runner);
  if (o.outbox) runner.setDeliveryOutboxPort(o.outbox as never);
  const queued: unknown[] = [], delivered: unknown[] = [], confirmed: unknown[] = [], steered: unknown[] = [];
  runner.on("message_steered", (d: unknown) => steered.push(d));
  runner.on("message_queued", (d: unknown) => queued.push(d));
  runner.on("message_delivered", (d: unknown) => delivered.push(d));
  runner.on("message_confirmed", (d: unknown) => confirmed.push(d));
  await runner.start();
  const fleet = new IpcClient(join(dir, "channel.sock"));
  clients.push(fleet);
  await fleet.connect();
  fleet.on("message", (m: any) => { if (m.type === "fleet_outbound") fleet.send({ type: "fleet_outbound_response", fleetRequestId: m.fleetRequestId, result: { messageId: "m1" } }); });
  return { runner, fleet, state, queued, delivered, confirmed, steered };
}
const meta = (id: string, extra: Record<string, string> = {}) => ({ chat_id: "chat-1", message_id: id, user: "alice", source: "web", ...extra });
const steps = (h: { runner: AcpRunner }) => h.runner.steps.snapshot(undefined, { thoughts: false }).steps;
const calls = (state: string): any[] => readFileSync(join(state, "calls.jsonl"), "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
const sessions = (state: string): Record<string, string[]> => JSON.parse(readFileSync(join(state, "sessions.json"), "utf8"));
const turnEnds = (h: { runner: AcpRunner }) => steps(h).filter(s => s.kind === "turn_end").map(s => s.note);
const NOTE = /was interrupted by the user before it finished/;

describe("a normal message that arrives while the agent is working (the default)", () => {
  it.each(["fleet_inbound", "btw"] as const)("%s: waits for the running turn, which is not cancelled, then runs as its own turn", async (type) => {
    const h = await boot();
    h.fleet.send({ type: "fleet_inbound", content: "first #linger", meta: meta("m-1") });
    await until(() => h.runner.getInstanceState() === "working", 3000, "busy");
    h.fleet.send({ type, content: "second", meta: meta("m-2") });
    await until(() => turnEnds(h).length === 2, 8000, "both turns");
    expect(steps(h).filter(s => s.kind === "user").map(s => s.body)).toEqual(["first #linger", "second"]);
    expect(turnEnds(h)).toEqual(["end_turn", "end_turn"]);
    expect(calls(h.state).filter(c => "cancelled" in c)).toEqual([]);
    expect(h.queued).toEqual([{ chatId: "chat-1", messageId: "m-2" }]);
    expect(Object.values(sessions(h.state)).flat().some(t => NOTE.test(t))).toBe(false);
  });
});

describe("an interruption where the CLI can add a message to the running turn (grok's `_x.ai/interject`)", () => {
  it("adds it to the turn: no cancel, no new prompt, the turn ends once, normally, and the queue is untouched", async () => {
    const h = await boot({ grok: true });
    h.fleet.send({ type: "fleet_inbound", content: "A #slow", meta: meta("a") });
    await until(() => h.runner.getInstanceState() === "working", 3000, "A is working");
    h.runner.pushChannelMessage("C queued", meta("c"));
    expect(h.runner.interruptMode()).toBe("add");
    h.runner.interruptMessage("B joins", meta("b"));
    await until(() => turnEnds(h).length === 2, 10000, "A's turn and C's");
    const log = calls(h.state);
    expect(log.filter(c => "cancelled" in c)).toEqual([]);                                     // nothing was cancelled
    expect(log.filter(c => "interject" in c)).toHaveLength(1);
    expect(log.find(c => "interject" in c).interject).toContain("B joins");                    // with the usual [user:] envelope
    expect(log.find(c => "interject" in c).active).toBe(true);
    expect(turnEnds(h)).toEqual(["end_turn", "end_turn"]);                                     // A took B inside its own turn; C was the next turn
    const prompts = Object.values(sessions(h.state))[0]!;
    expect(prompts).toHaveLength(2);                                                          // only A and C were ever prompted: B was not a prompt
    expect(prompts.some(t => NOTE.test(t) || t.includes("B joins"))).toBe(false);
    const st = steps(h);
    expect(st.filter(s => s.kind === "user").map(s => s.body)).toEqual(["A #slow", "B joins", "C queued"]);
    expect(st.filter(s => s.kind === "assistant").map(s => s.body).join("\n")).toContain("interjected:");
    // B is delivered at once and confirmed with A's turn; B is never announced as queued, C is.
    expect(h.delivered).toContainEqual({ chatId: "chat-1", messageId: "b" });
    expect(h.confirmed).toContainEqual({ chatId: "chat-1", messageId: "b" });
    expect(h.queued).toEqual([{ chatId: "chat-1", messageId: "c" }]);
  });

  it("falls back to cancel and a new prompt when the CLI does not take it", async () => {
    const h = await boot({ grok: true, env: { FAKE_ACP_INTERJECT: "reject" } });
    h.fleet.send({ type: "fleet_inbound", content: "A #slow", meta: meta("a") });
    await until(() => h.runner.getInstanceState() === "working", 3000, "A is working");
    h.runner.interruptMessage("B instead", meta("b"));
    await until(() => turnEnds(h).length === 2, 10000, "both turns");
    expect(turnEnds(h)).toEqual(["cancelled", "end_turn"]);
    expect(calls(h.state).filter(c => "cancelled" in c)).toHaveLength(1);
    expect(Object.values(sessions(h.state))[0]!.map(t => NOTE.test(t))).toEqual([false, true]);
  });

  it("an answer that is not \"queued\" is not a delivery: the turn is cancelled and the message is a new prompt", async () => {
    const h = await boot({ grok: true, env: { FAKE_ACP_INTERJECT: "refuse" } });
    h.fleet.send({ type: "fleet_inbound", content: "A #slow", meta: meta("a") });
    await until(() => h.runner.getInstanceState() === "working", 3000, "A is working");
    h.runner.interruptMessage("B instead", meta("b"));
    await until(() => turnEnds(h).length === 2, 10000, "both turns");
    expect(turnEnds(h)).toEqual(["cancelled", "end_turn"]);
    expect(h.delivered).toHaveLength(2);                                                       // A, and B as its own prompt (no early "delivered" for B)
  });

  it("an agent with no way of adding to a turn is told to cancel; an idle one just receives it", async () => {
    const agy = await boot({ plain: true });
    expect(agy.runner.interruptMode()).toBe("idle");
    agy.fleet.send({ type: "fleet_inbound", content: "A #slow", meta: meta("a") });
    await until(() => agy.runner.getInstanceState() === "working", 3000, "A is working");
    expect(agy.runner.interruptMode()).toBe("interrupt");
    const grok = await boot({ grok: true });
    expect(grok.runner.interruptMode()).toBe("idle");
    grok.fleet.send({ type: "steer", content: "hi", meta: meta("m") });                        // idle: sent as it is, the CLI is not asked to interject
    await until(() => turnEnds(grok).length === 1, 6000, "the turn");
    expect(calls(grok.state).filter(c => "interject" in c)).toEqual([]);
  });

  it("while an interruption by cancel is already waiting, a further one joins it (the turn is already being cancelled)", async () => {
    const h = await boot({ grok: true, env: { FAKE_ACP_INTERJECT: "reject" } });
    h.fleet.send({ type: "fleet_inbound", content: "A #slow", meta: meta("a") });
    await until(() => h.runner.getInstanceState() === "working", 3000, "A is working");
    h.runner.interruptMessage("B1", meta("b1"));
    await sleep(200);
    h.runner.interruptMessage("B2", meta("b2"));
    await until(() => turnEnds(h).length === 3, 12000, "all turns");
    expect(steps(h).filter(s => s.kind === "user").map(s => s.body)).toEqual(["A #slow", "B1", "B2"]);
  });
});

describe("an interruption where the CLI folds a second prompt into the running turn (agy)", () => {
  it("sends it as a second prompt: nothing is cancelled, and the turn is over only when both requests have answered", async () => {
    const h = await boot({ env: { FAKE_ACP_CONCURRENT: "fold", FAKE_ACP_FOLD_DELAY: "1500" } });
    h.fleet.send({ type: "fleet_inbound", content: "A #slow", meta: meta("a") });
    await until(() => h.runner.getInstanceState() === "working", 3000, "A is working");
    h.runner.pushChannelMessage("C queued", meta("c"));
    expect(h.runner.interruptMode()).toBe("add");
    h.runner.interruptMessage("B folded", meta("b"));
    await until(() => calls(h.state).some(c => "foldedPrompt" in c), 3000, "the second prompt");
    // The CLI answered the FIRST request at once and is still working: that is not the end of the turn, and the queue must not move.
    await until(() => steps(h).filter(s => s.kind === "user").length === 2, 3000, "B as a step of the turn");
    expect(h.runner.getInstanceState()).toBe("working");
    expect(turnEnds(h)).toEqual([]);
    expect(steps(h).filter(s => s.kind === "user").map(s => s.body)).toEqual(["A #slow", "B folded"]);
    await until(() => turnEnds(h).length === 2, 10000, "A's turn (both requests) and C's");
    expect(turnEnds(h)).toEqual(["end_turn", "end_turn"]);
    expect(calls(h.state).filter(c => "cancelled" in c)).toEqual([]);
    expect(steps(h).filter(s => s.kind === "user").map(s => s.body)).toEqual(["A #slow", "B folded", "C queued"]);
    expect(steps(h).filter(s => s.kind === "assistant").map(s => s.body).join("\n")).toContain("interjected: ");
    expect(h.delivered).toContainEqual({ chatId: "chat-1", messageId: "b" });
    expect(h.confirmed).toContainEqual({ chatId: "chat-1", messageId: "b" });
  });

  it("falls back to cancel and a new prompt when the CLI refuses a second prompt at once", async () => {
    const h = await boot({ env: { FAKE_ACP_CONCURRENT: "error" } });
    h.fleet.send({ type: "fleet_inbound", content: "A #slow", meta: meta("a") });
    await until(() => h.runner.getInstanceState() === "working", 3000, "A is working");
    h.runner.interruptMessage("B instead", meta("b"));
    await until(() => turnEnds(h).length === 2, 10000, "both turns");
    expect(turnEnds(h)).toEqual(["cancelled", "end_turn"]);
    expect(calls(h.state).filter(c => "cancelled" in c)).toHaveLength(1);
    expect(Object.values(sessions(h.state))[0]!.map(t => NOTE.test(t))).toEqual([false, true]);
  });
});

/** An outbox with the real one's rules that matter here: one attempt per (delivery, attempt number); `begin` again is `duplicate`; `abort` only while begun; `complete` ends it. */
class FakeOutbox {
  calls: string[] = [];
  private state = new Map<string, "begun" | "completed" | "aborted">();
  begin(id: string, _boot: string, attempt: number) { const k = `${id}#${attempt}`; this.calls.push(`begin:${k}`); if (this.state.has(k)) return "duplicate" as const; this.state.set(k, "begun"); return "begun" as const; }
  markEnterStarted(id: string, _b: string, attempt: number) { this.calls.push(`enter:${id}#${attempt}`); return true; }
  complete(id: string, _b: string, attempt: number, outcome: string, evidence?: string) { const k = `${id}#${attempt}`; this.calls.push(`complete:${k}:${outcome}:${evidence}`); if (this.state.get(k) !== "begun") return false; this.state.set(k, "completed"); return true; }
  abort(id: string, _b: string, attempt: number, reason: string) { const k = `${id}#${attempt}`; this.calls.push(`abort:${k}`); void reason; if (this.state.get(k) !== "begun") return false; this.state.set(k, "aborted"); return true; }
  retryBeforeBegin(id: string, _b: string, attempt: number, reason: string) { this.calls.push(`retry:${id}#${attempt}:${reason}`); return true; }
}
const durable = (id: string, attempt = 1) => ({ chat_id: "", message_id: "x1", user: "instance:planner", source: "cross_instance", from_instance: "planner", delivery_id: id, delivery_attempt: String(attempt) });

describe("the bubble of a message that asked to interject hears how it went (AGEND-279)", () => {
  it("added to the running turn by the CLI: nothing to correct, no event", async () => {
    const h = await boot({ grok: true });
    h.fleet.send({ type: "fleet_inbound", content: "A #slow", meta: meta("a") });
    await until(() => h.runner.getInstanceState() === "working", 3000, "A is working");
    h.runner.interruptMessage("B joins", meta("b"));
    await until(() => turnEnds(h).length === 1, 10000, "A's turn");
    expect(h.steered).toEqual([]);
  });
  it("the CLI does not take it and the turn is cancelled for it: the message was `interrupted`", async () => {
    const h = await boot({ grok: true, env: { FAKE_ACP_INTERJECT: "reject" } });
    h.fleet.send({ type: "fleet_inbound", content: "A #slow", meta: meta("a") });
    await until(() => h.runner.getInstanceState() === "working", 3000, "A is working");
    h.runner.interruptMessage("B instead", meta("b"));
    await until(() => turnEnds(h).length === 2, 10000, "both turns");
    expect(h.steered).toEqual([{ chatId: "chat-1", messageId: "b", steer: "interrupted" }]);
  });
  it("an agent with no way of adding to a turn cancels it: `interrupted`; an idle one just receives it: nothing", async () => {
    const h = await boot({ plain: true });
    h.runner.interruptMessage("idle first", meta("i"));
    await until(() => turnEnds(h).length === 1, 5000, "the idle send");
    expect(h.steered).toEqual([]);
    h.fleet.send({ type: "fleet_inbound", content: "A #slow", meta: meta("a") });
    await until(() => h.runner.getInstanceState() === "working", 3000, "A is working");
    h.runner.interruptMessage("B interrupts", meta("b"));
    await until(() => turnEnds(h).length === 3, 10000, "all turns");
    expect(h.steered).toEqual([{ chatId: "chat-1", messageId: "b", steer: "interrupted" }]);
  });
  it("the CLI took it and then refused it: the message is `refused` and goes again as its own", async () => {
    const h = await boot({ env: { FAKE_ACP_CONCURRENT: "late-error" } });
    h.fleet.send({ type: "fleet_inbound", content: "A #slow", meta: meta("a") });
    await until(() => h.runner.getInstanceState() === "working", 3000, "A is working");
    h.runner.interruptMessage("B late", meta("b"));
    await until(() => h.steered.some((e: any) => e.steer === "refused"), 8000, "the refusal");
    expect(h.steered.at(-1)).toEqual({ chatId: "chat-1", messageId: "b", steer: "refused" });
    await h.runner.adapter.cancel();
    await until(() => turnEnds(h).length >= 1, 10000, "A ends");
  }, 30000);
  it("a message of someone else (no message id to tell) says nothing", async () => {
    const h = await boot({ grok: true, env: { FAKE_ACP_INTERJECT: "reject" } });
    h.fleet.send({ type: "fleet_inbound", content: "A #slow", meta: meta("a") });
    await until(() => h.runner.getInstanceState() === "working", 3000, "A is working");
    h.runner.interruptMessage("B instead", { chat_id: "chat-1", user: "alice", source: "web" });
    await until(() => turnEnds(h).length === 2, 10000, "both turns");
    expect(h.steered).toEqual([]);
  });
});

describe("\"Send now\": a message that waits in the queue is taken out and interjected (AGEND-279)", () => {
  const waiting = (h: Awaited<ReturnType<typeof boot>>) => h.runner.inboxOrder();
  const prompts = (h: Awaited<ReturnType<typeof boot>>) => Object.values(sessions(h.state)).flat();
  it("the CLI can add to a turn (grok): it is added to the running turn, left the queue, and is never prompted a second time", async () => {
    const h = await boot({ grok: true });
    h.fleet.send({ type: "fleet_inbound", content: "A #slow", meta: meta("a") });
    await until(() => h.runner.getInstanceState() === "working", 3000, "A is working");
    h.runner.pushChannelMessage("C waits", meta("c"));
    h.runner.pushChannelMessage("D waits", meta("d"));
    expect(waiting(h)).toEqual(["C waits", "D waits"]);
    expect(h.runner.interruptQueued("c")).toBe("add");
    expect(waiting(h)).toEqual(["D waits"]);                                                  // gone from the queue
    await until(() => turnEnds(h).length === 2, 10000, "A's turn and D's");
    expect(calls(h.state).filter(c => "interject" in c).map(c => c.interject)).toEqual([expect.stringContaining("C waits")]);   // once, into the turn
    expect(calls(h.state).filter(c => "cancelled" in c)).toEqual([]);
    expect(prompts(h).filter(t => t.includes("C waits"))).toEqual([]);                        // never a prompt of its own
    expect(prompts(h).filter(t => t.includes("D waits"))).toHaveLength(1);                    // the rest of the queue is untouched
    expect(steps(h).filter(s => s.kind === "user").map(s => s.body)).toEqual(["A #slow", "C waits", "D waits"]);
  });
  it("agy folds a second prompt in: the same, one prompt for it and not a second", async () => {
    const h = await boot({ env: { FAKE_ACP_CONCURRENT: "fold" } });
    h.fleet.send({ type: "fleet_inbound", content: "A #slow", meta: meta("a") });
    await until(() => h.runner.getInstanceState() === "working", 3000, "A is working");
    h.runner.pushChannelMessage("C waits", meta("c"));
    expect(h.runner.interruptQueued("c")).toBe("add");
    await until(() => turnEnds(h).length === 1, 10000, "the turn");
    expect(waiting(h)).toEqual([]);
    expect(prompts(h).filter(t => t.includes("C waits"))).toHaveLength(1);
  });
  it("a CLI with no way to add to a turn: the turn is cancelled, the message runs next, once", async () => {
    const h = await boot({ plain: true });
    h.fleet.send({ type: "fleet_inbound", content: "A #slow", meta: meta("a") });
    await until(() => h.runner.getInstanceState() === "working", 3000, "A is working");
    h.runner.pushChannelMessage("C waits", meta("c"));
    expect(h.runner.interruptQueued("c")).toBe("interrupt");
    expect(waiting(h)).toEqual(["C waits"]);                                                  // now at the front, as an interruption (once)
    await until(() => turnEnds(h).length === 2, 10000, "A cancelled, C run");
    expect(turnEnds(h)).toEqual(["cancelled", "end_turn"]);
    expect(prompts(h).filter(t => t.includes("C waits"))).toHaveLength(1);
    expect(h.steered).toContainEqual({ chatId: "chat-1", messageId: "c", steer: "interrupted" });
  });
  it("it is not waiting any more (its turn has started, or it is gone): nothing is sent, and it is not sent twice", async () => {
    const h = await boot();
    h.fleet.send({ type: "fleet_inbound", content: "A #linger", meta: meta("a") });
    await until(() => h.runner.getInstanceState() === "working", 3000, "A is working");
    expect(h.runner.interruptQueued("a")).toBeNull();                                          // the running turn's own message: not in the queue
    expect(h.runner.interruptQueued("nobody")).toBeNull();
    h.runner.pushChannelMessage("C waits", meta("c"));
    await until(() => turnEnds(h).length === 2, 10000, "both turns");                         // C ran as the next turn…
    expect(h.runner.interruptQueued("c")).toBeNull();                                          // …so the press that comes now finds it gone
    await sleep(100);
    expect(prompts(h).filter(t => t.includes("C waits"))).toHaveLength(1);
    expect(calls(h.state).filter(c => "cancelled" in c || "interject" in c)).toEqual([]);
  });
});

describe("durable deliveries added to a running turn (second review)", () => {
  it("the verdict waits for the turn's end: nothing is completed while the turn runs, then delivered once", async () => {
    const outbox = new FakeOutbox();
    const h = await boot({ env: { FAKE_ACP_CONCURRENT: "fold", FAKE_ACP_FOLD_DELAY: "1200" }, outbox });
    h.fleet.send({ type: "fleet_inbound", content: "A #slow", meta: meta("a") });
    await until(() => h.runner.getInstanceState() === "working", 3000, "A is working");
    h.runner.interruptMessage("B durable", durable("d1"));
    await until(() => outbox.calls.some(c => c.startsWith("enter:d1")), 3000, "the attempt begun");
    expect(outbox.calls.filter(c => c.startsWith("complete:d1"))).toEqual([]);                // taken, but the turn is still running
    await until(() => turnEnds(h).length === 1, 10000, "the turn");
    expect(outbox.calls.filter(c => c.startsWith("complete:d1"))).toEqual(["complete:d1#1:delivered:acp:interjected"]);
  }, 20000);

  it("the turn it was added to is cancelled before it ends: the verdict is uncertain, never delivered", async () => {
    const outbox = new FakeOutbox();
    const h = await boot({ env: { FAKE_ACP_CONCURRENT: "fold-hold" }, outbox });
    h.fleet.send({ type: "fleet_inbound", content: "A #slow", meta: meta("a") });
    await until(() => h.runner.getInstanceState() === "working", 3000, "A is working");
    h.runner.interruptMessage("B durable then cut", durable("d3"));
    await until(() => outbox.calls.some(c => c.startsWith("enter:d3")), 3000, "the attempt begun");
    expect(outbox.calls.filter(c => c.startsWith("complete:d3"))).toEqual([]);
    await h.runner.adapter.cancel();                                                          // the turn that took it is cut short
    await until(() => turnEnds(h).length === 1, 10000, "the turn ends");
    expect(turnEnds(h)).toEqual(["cancelled"]);
    expect(outbox.calls.filter(c => c.startsWith("complete:d3"))).toEqual(["complete:d3#1:uncertain:acp:interjected-turn-not-finished"]);
  }, 20000);

  it("agy refuses the added prompt late: the attempt goes back to the outbox (abort), is never completed as delivered, and nothing is dropped", async () => {
    const outbox = new FakeOutbox();
    const h = await boot({ env: { FAKE_ACP_CONCURRENT: "late-error" }, outbox });
    h.fleet.send({ type: "fleet_inbound", content: "A #slow", meta: meta("a") });
    await until(() => h.runner.getInstanceState() === "working", 3000, "A is working");
    h.runner.interruptMessage("B durable late", durable("d2"));
    await until(() => outbox.calls.some(c => c.startsWith("abort:d2")), 5000, "the attempt handed back");
    expect(outbox.calls.filter(c => c.startsWith("complete:d2"))).toEqual([]);                // not recorded as delivered
    expect(steps(h).filter(s => s.kind === "user").map(s => [s.body, s.status ?? null])).toEqual([["A #slow", null], ["B durable late", "failed"]]);   // the step says it was refused
    await h.runner.adapter.cancel();                                                          // (ends A, which nothing else would)
    await until(() => turnEnds(h).length === 1, 10000, "A ends");
    expect(outbox.calls.filter(c => c.startsWith("complete:d2"))).toEqual([]);                // the end of the turn does not complete what was handed back
    // The outbox delivers it again as a new attempt (the fleet's part): it reaches the runner as a message of its own.
    h.runner.pushChannelMessage("B durable late", durable("d2", 2));
    await until(() => turnEnds(h).length === 2, 10000, "the redelivery");
    expect(outbox.calls.filter(c => c.startsWith("complete:d2"))).toEqual([expect.stringMatching(/^complete:d2#2:delivered:acp:/)]);   // the second attempt is the one completed
    expect(Object.values(sessions(h.state))[0]!.filter(t => t.includes("B durable late"))).toHaveLength(1);   // prompted once, as its own turn
  }, 30000);

  it("a message that is not durable is sent again here, and the second copy does not report 'delivered' a second time", async () => {
    const h = await boot({ env: { FAKE_ACP_CONCURRENT: "late-error" } });
    h.fleet.send({ type: "fleet_inbound", content: "A #slow", meta: meta("a") });
    await until(() => h.runner.getInstanceState() === "working", 3000, "A is working");
    h.runner.interruptMessage("B plain", meta("b"));
    await until(() => turnEnds(h).length === 2, 15000, "A (cancelled by the resend) and B");
    expect(h.delivered.filter((d: any) => d.messageId === "b")).toHaveLength(1);
    expect(steps(h).filter(s => s.kind === "user").map(s => [s.body, s.status ?? null])).toEqual([["A #slow", null], ["B plain", "failed"], ["B plain", null]]);
  }, 25000);
});

describe("the cancel that is repeated", () => {
  it("stops with the turn it was for: the next turn is not cancelled by it", async () => {
    const h = await boot({ plain: true, cancelEveryMs: 150 });
    h.fleet.send({ type: "fleet_inbound", content: "A #slow", meta: meta("a") });
    await until(() => h.runner.getInstanceState() === "working", 3000, "A is working");
    h.runner.interruptMessage("B #slow", meta("b"));                                         // B itself waits for a cancel
    await until(() => turnEnds(h).length === 1, 5000, "A cancelled");
    await until(() => steps(h).filter(s => s.kind === "user").length === 2, 3000, "B started");
    await sleep(1200);                                                                        // many retry intervals later
    expect(turnEnds(h)).toEqual(["cancelled"]);                                              // B is still running
    expect(calls(h.state).filter(c => "cancelled" in c)).toHaveLength(1);                     // and never received a cancel
  }, 20000);

  it("gives up after 8 asks and says so, naming the turn and the interruption that waits", async () => {
    const warns: any[] = [];
    const log = { ...logger, warn: (o: object, m?: string) => { warns.push([o, m]); } };
    const h = await boot({ plain: true, cancelEveryMs: 60, env: { FAKE_ACP_IGNORE_CANCEL: "all" }, log });
    h.fleet.send({ type: "fleet_inbound", content: "A #slow", meta: meta("a") });
    await until(() => h.runner.getInstanceState() === "working", 3000, "A is working");
    h.runner.interruptMessage("B waits", meta("b"));
    await until(() => warns.some(w => /giving up asking/.test(String(w[1]))), 5000, "the warning");
    const w = warns.find(x => /giving up asking/.test(String(x[1])))!;
    expect(w[0]).toMatchObject({ name: "worker", waitingInterruptions: 1, interruptedBy: "the user" });
    expect(calls(h.state).filter(c => "cancelIgnored" in c)).toHaveLength(9);                 // the first ask and eight repeats, then no more
    await sleep(400);
    expect(calls(h.state).filter(c => "cancelIgnored" in c)).toHaveLength(9);
  }, 20000);
});

describe("grok's announcement counts for one message", () => {
  it("two messages with the same text: the one announcement is used up by the first, the second (not announced) is sent as a prompt", async () => {
    const h = await boot({ grok: true, env: { FAKE_ACP_INTERJECT: "announce-first" } });
    h.fleet.send({ type: "fleet_inbound", content: "A #slow", meta: meta("a") });
    await until(() => h.runner.getInstanceState() === "working", 3000, "A is working");
    // Identical on the wire (same envelope): what the CLI would announce for either.
    h.runner.interruptMessage("same words", meta("b"));
    h.runner.interruptMessage("same words", meta("b"));
    await until(() => turnEnds(h).length === 2, 20000, "A, then the second message as its own turn");
    expect(Object.values(sessions(h.state))[0]!.filter(t => t.includes("same words"))).toHaveLength(1);   // exactly one of the two became a prompt
  }, 30000);
});

describe("an interruption in the gaps (review of 00c682636)", () => {
  it("while a paused agent is being woken for the message that is starting: that turn is cut short as soon as its prompt has left, and the next message runs", async () => {
    // The CLI drops the first cancel it gets (agy does so right after resuming a session): the runner asks again.
    const h = await boot({ plain: true, env: { FAKE_ACP_IGNORE_FIRST_CANCEL: "1" } });
    h.fleet.send({ type: "fleet_inbound", content: "first", meta: meta("m-0") });
    await until(() => turnEnds(h).length === 1, 6000, "the first turn");
    await h.runner.pause("idle");
    expect(h.runner.isPaused).toBe(true);
    h.runner.pushChannelMessage("A #slow", meta("a"));        // starts waking the agent (takes a moment)
    h.runner.interruptMessage("B instead", meta("b"));       // arrives while A is being started: there is no running prompt to cancel yet
    await until(() => turnEnds(h).length === 3, 15000, "A (cut short) and B");
    expect(turnEnds(h)).toEqual(["end_turn", "cancelled", "end_turn"]);   // A did NOT run its 20 s: it was cancelled the moment it started
    expect(calls(h.state).filter(c => "cancelIgnored" in c)).toHaveLength(1);
    expect(calls(h.state).filter(c => "cancelled" in c)).toHaveLength(1);                  // the second ask stopped it
    expect(steps(h).filter(s => s.kind === "user").map(s => s.body)).toEqual(["first", "A #slow", "B instead"]);
    const prompts = Object.values(sessions(h.state)).flat();
    expect(prompts.map(t => NOTE.test(t))).toEqual([false, false, true]);
  }, 25000);

  it("agy refuses the second prompt late (after the 400 ms looked at): the message is sent again, interrupting, not lost", async () => {
    const h = await boot({ env: { FAKE_ACP_CONCURRENT: "late-error" } });
    h.fleet.send({ type: "fleet_inbound", content: "A #slow", meta: meta("a") });
    await until(() => h.runner.getInstanceState() === "working", 3000, "A is working");
    h.runner.interruptMessage("B late refused", meta("b"));
    await until(() => turnEnds(h).length === 2, 15000, "A (cancelled by the resend) and B");
    expect(calls(h.state).some(c => "latePrompt" in c)).toBe(true);
    expect(turnEnds(h)).toEqual(["cancelled", "end_turn"]);
    const prompts = Object.values(sessions(h.state))[0]!;
    expect(prompts.filter(t => t.includes("B late refused"))).toHaveLength(1);              // delivered once, as its own prompt with the note
    expect(prompts.map(t => NOTE.test(t))).toContain(true);
    expect(h.confirmed.filter((c: any) => c.messageId === "b")).toHaveLength(1);              // confirmed once (the refused copy is not counted)
  }, 25000);

  it("grok's answer comes too late but it announced the interjection: counted as taken, not sent a second time", async () => {
    const h = await boot({ grok: true, env: { FAKE_ACP_INTERJECT: "announce-slow" } });
    h.fleet.send({ type: "fleet_inbound", content: "A #slow", meta: meta("a") });
    await until(() => h.runner.getInstanceState() === "working", 3000, "A is working");
    h.runner.interruptMessage("B once", meta("b"));
    await until(() => turnEnds(h).length === 1, 15000, "the turn");
    await sleep(6500);                                                                       // the late `queued` arrives; nothing must follow from it
    expect(turnEnds(h)).toEqual(["end_turn"]);
    expect(calls(h.state).filter(c => "cancelled" in c)).toEqual([]);
    expect(Object.values(sessions(h.state)).flat().filter(t => t.includes("B once"))).toEqual([]);   // never prompted
    expect(calls(h.state).filter(c => "interject" in c)).toHaveLength(1);                     // asked once
    expect(h.delivered).toContainEqual({ chatId: "chat-1", messageId: "b" });
  }, 30000);

  it("the answer comes after the turn it was for has ended: the message is sent again as its own, not left without a state", async () => {
    const h = await boot({ grok: true, env: { FAKE_ACP_INTERJECT: "late", FAKE_ACP_INTERJECT_DELAY: "1500" } });
    h.fleet.send({ type: "fleet_inbound", content: "A #linger", meta: meta("a") });
    await until(() => h.runner.getInstanceState() === "working", 3000, "A is working");
    h.runner.interruptMessage("B after the end", meta("b"));
    await until(() => turnEnds(h).length === 2, 15000, "A, then B as its own turn");
    expect(turnEnds(h)).toEqual(["end_turn", "end_turn"]);
    expect(Object.values(sessions(h.state))[0]!.filter(t => t.includes("B after the end"))).toHaveLength(1);
    expect(h.delivered.filter((c: any) => c.messageId === "b")).toHaveLength(1);
    expect(h.confirmed.filter((c: any) => c.messageId === "b")).toHaveLength(1);
  }, 25000);
});

describe("an interruption (/steer, steer: true)", () => {
  it("is what the IPC `steer` message does, and a launch that takes steer is what the fleet's cross-instance send asks", async () => {
    const h = await boot({ plain: true });
    expect(h.runner.launchSupportsSteer()).toBe(true);
  });

  it("cancels the running turn, runs next in the same session with a note, and keeps the queued messages behind it", async () => {
    const h = await boot({ plain: true });
    h.fleet.send({ type: "fleet_inbound", content: "A #slow", meta: meta("a") });
    await until(() => h.runner.getInstanceState() === "working", 3000, "A is working");
    // Straight into the runner, so the order of arrival is exactly this.
    h.runner.pushChannelMessage("C queued", meta("c"));
    expect(h.runner.inboxOrder()).toEqual(["C queued"]);
    h.runner.interruptMessage("B interrupts", meta("b"));
    expect(h.runner.inboxOrder()).toEqual(["B interrupts", "C queued"]);
    await until(() => turnEnds(h).length === 3, 10000, "all three turns");
    // Order: A (cut short), then B, then the message that was already waiting.
    expect(steps(h).filter(s => s.kind === "user").map(s => s.body)).toEqual(["A #slow", "B interrupts", "C queued"]);
    expect(turnEnds(h)).toEqual(["cancelled", "end_turn", "end_turn"]);
    // One session for everything, one cancel; only B's prompt carries the note.
    const all = sessions(h.state);
    expect(Object.keys(all)).toHaveLength(1);
    const prompts = Object.values(all)[0]!;
    expect(prompts).toHaveLength(3);
    expect(prompts.map(t => NOTE.test(t))).toEqual([false, true, false]);
    expect(prompts[1]).toContain("B interrupts");
    expect(calls(h.state).filter(c => "cancelled" in c)).toHaveLength(1);
    expect(calls(h.state).filter(c => c.sessionNew)).toHaveLength(1);
    // B is not announced as "queued"; C, which did wait, is.
    expect(h.queued).toEqual([{ chatId: "chat-1", messageId: "c" }]);
  });

  it("two interruptions keep their own order, ahead of the queue", async () => {
    const h = await boot({ plain: true });
    h.fleet.send({ type: "fleet_inbound", content: "A #slow", meta: meta("a") });
    await until(() => h.runner.getInstanceState() === "working", 3000, "A is working");
    h.runner.pushChannelMessage("C queued", meta("c"));
    h.runner.interruptMessage("B1", meta("b1"));
    h.runner.interruptMessage("B2", meta("b2"));
    expect(h.runner.inboxOrder()).toEqual(["B1", "B2", "C queued"]);
    await until(() => turnEnds(h).length === 4, 12000, "all turns");
    expect(steps(h).filter(s => s.kind === "user").map(s => s.body)).toEqual(["A #slow", "B1", "B2", "C queued"]);
    expect(turnEnds(h)[0]).toBe("cancelled");
  });

  it("an agent that is idle just receives it: no cancel, no note", async () => {
    const h = await boot({ plain: true });
    h.fleet.send({ type: "steer", content: "hello", meta: meta("m-1") });
    await until(() => turnEnds(h).length === 1, 6000, "the turn");
    expect(turnEnds(h)).toEqual(["end_turn"]);
    expect(calls(h.state).filter(c => "cancelled" in c)).toEqual([]);
    expect(Object.values(sessions(h.state)).flat().some(t => NOTE.test(t))).toBe(false);
  });

  it("another agent's interruption says so in the note", async () => {
    const h = await boot({ plain: true });
    h.fleet.send({ type: "fleet_inbound", content: "A #slow", meta: meta("a") });
    await until(() => h.runner.getInstanceState() === "working", 3000, "A is working");
    h.fleet.send({ type: "steer", content: "from the planner", meta: { chat_id: "", message_id: "x1", user: "instance:planner", source: "cross_instance", from_instance: "planner" } });
    await until(() => turnEnds(h).length === 2, 8000, "both turns");
    expect(Object.values(sessions(h.state))[0]![1]).toMatch(/interrupted by another agent \(planner\) before it finished/);
  });

  it("a permission request that waits is answered cancelled and its chat card is retired", async () => {
    const dir = tmp(), state = tmp();
    const config = { working_directory: dir, backend: "antigravity", cli_adapter: "acp", skipPermissions: false } as InstanceConfig;
    const holder: { runner?: AcpRunner } = {};
    const profile = { ...AGY_PROFILE, interject: undefined, supportedVersions: ["1.5.8"], args: () => [FAKE] };   // no way of adding to a turn: the cancel path
    new AcpAdapter({ profile, command: process.execPath, cwd: dir, instanceDir: dir, mcpServers: [], logger, env: { PATH: process.env.PATH }, childEnv: { FAKE_ACP_STATE: state, FAKE_ACP_VERSION: "1.5.8" },
      makeRunner: a => (holder.runner = new AcpRunner(a, { name: "worker", config, instanceDir: dir, topicMode: true, backend: "antigravity", logger })) });
    const runner = holder.runner!; runners.push(runner);
    const cards: any[] = [], gone: string[] = [];
    runner.on("remote_card", (d: any) => cards.push(d.card));
    runner.on("remote_card_gone", (d: any) => gone.push(d.identity));
    await runner.start();
    const fleet = new IpcClient(join(dir, "channel.sock")); clients.push(fleet); await fleet.connect();
    fleet.on("message", (m: any) => { if (m.type === "fleet_outbound") fleet.send({ type: "fleet_outbound_response", fleetRequestId: m.fleetRequestId, result: { messageId: "m1" } }); });
    fleet.send({ type: "fleet_inbound", content: "#tool", meta: meta("a") });
    await until(() => runner.steps.pendingPermissions().length === 1 && cards.length === 1, 6000, "the permission card");
    fleet.send({ type: "steer", content: "never mind, do this", meta: meta("b") });
    await until(() => runner.steps.snapshot(undefined, { thoughts: false }).steps.filter(s => s.kind === "turn_end").length === 2, 10000, "both turns");
    expect(runner.steps.pendingPermissions()).toHaveLength(0);
    const all = runner.steps.snapshot(undefined, { thoughts: false }).steps;
    expect(all.filter(s => s.kind === "permission").map(s => [s.status, s.note])).toEqual([["interrupted", "cancelled"]]);
    expect(gone).toEqual([cards[0].identity]);
    expect(all.filter(s => s.kind === "turn_end").map(s => s.note)).toEqual(["cancelled", "end_turn"]);
    expect(readFileSync(join(state, "calls.jsonl"), "utf8")).toContain("\"permissionOutcome\":{\"outcome\":\"cancelled\"}");   // the agent was told: cancelled, never allowed
  }, 20000);
});

describe("/steer in a chat, for an ACP instance", () => {
  const inbound = (text: string): InboundMessage => ({ source: "discord", adapterId: "discord-main", chatId: "c", threadId: "t", messageId: "m1", userId: "u", username: "u", text, timestamp: new Date(), isBotMessage: false });
  function setup(backend: string, acp: boolean, state: "working" | "idle" | "stuck" = "working") {
    const send = vi.fn();
    const sendText = vi.fn().mockResolvedValue({ messageId: "r", chatId: "c" });
    const commands = new TopicCommands({
      adapter: { sendText }, adapters: new Map(),
      fleetConfig: { defaults: {}, instances: { worker: { backend, working_directory: "/tmp", ...(acp ? { cli_adapter: "acp" } : {}) } } },
      instanceIpcClients: new Map([["worker", { connected: true, send }]]),
      instanceRunsAcp: () => acp, getInstanceExecutionState: () => state, getDeliveryEpoch: () => 3, isFleetAdmin: () => false,
    } as any);
    return { commands, send, sendText };
  }
  it.each(["grok", "antigravity"])("%s over ACP, working: the message goes to the runner and the reply says the turn was interrupted", async (backend) => {
    const { commands, send, sendText } = setup(backend, true);
    expect(await commands.handleInstanceCommand(inbound("/steer do it"), "worker")).toBe(true);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0]).toMatchObject({ type: "steer", content: "do it" });
    expect(String(sendText.mock.calls[0][1])).toMatch(/Interrupted worker's current turn and sent this message instead/);
  });
  it("idle: sent directly, and the reply says so; stuck counts as working", async () => {
    const idle = setup("grok", true, "idle");
    await idle.commands.handleInstanceCommand(inbound("/steer do it"), "worker");
    expect(idle.send).toHaveBeenCalledOnce();
    expect(String(idle.sendText.mock.calls[0][1])).toMatch(/is idle: your message was sent directly/);
    const stuck = setup("grok", true, "stuck");
    await stuck.commands.handleInstanceCommand(inbound("/steer do it"), "worker");
    expect(String(stuck.sendText.mock.calls[0][1])).toMatch(/Interrupted/);
  });
  it("where the CLI adds it to the turn (grok), the reply says it was added and the turn is not interrupted", async () => {
    const { commands, send, sendText } = (() => {
      const send = vi.fn(); const sendText = vi.fn().mockResolvedValue({ messageId: "r", chatId: "c" });
      const commands = new TopicCommands({ adapter: { sendText }, adapters: new Map(),
        fleetConfig: { defaults: {}, instances: { worker: { backend: "grok", working_directory: "/tmp", cli_adapter: "acp" } } },
        instanceIpcClients: new Map([["worker", { connected: true, send }]]), instanceRunsAcp: () => true, acpSteerMode: () => "add", getDeliveryEpoch: () => 3, isFleetAdmin: () => false } as any);
      return { commands, send, sendText };
    })();
    await commands.handleInstanceCommand(inbound("/steer more"), "worker");
    expect(send).toHaveBeenCalledOnce();
    expect(String(sendText.mock.calls[0][1])).toMatch(/Added to worker's current turn.*the turn is not interrupted/);
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

describe("steer: true from another instance (the existing field, the same meaning)", () => {
  const callerMeta = { instanceName: "sender", requestId: 1, fleetRequestId: undefined, senderSessionName: undefined };
  function ctxFor(backend: string, acp: boolean) {
    return {
      fleetConfig: { defaults: {}, instances: { sender: {}, target: { backend, ...(acp ? { cli_adapter: "acp" } : {}) } }, channel: undefined },
      adapter: null, logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
      instanceIpcClients: new Map([["target", { connected: true, send: vi.fn() }]]), sessionRegistry: new Map(),
      lifecycle: { daemons: new Map(), isPaused: vi.fn(() => false) }, classicChannels: null, eventLog: { logActivity: vi.fn(), insert: vi.fn() },
      deliverToInstance: vi.fn(() => new Promise<void>(() => {})), notifyInstanceTopic: vi.fn(), lastActivityMs: vi.fn(() => 0),
      instanceRunsAcp: () => acp, instanceLaunchSupportsSteer: () => (acp ? true : undefined), hasPendingIdleGatedDelivery: vi.fn(() => true),
    } as any;
  }
  const call = async (ctx: any, args: Record<string, unknown>) => {
    let result: any; let error: string | undefined;
    await outboundHandlers.get("send_to_instance")!(ctx, { detail: true, instance_name: "target", message: "supplement", ...args }, (r, e) => { result = r; error = e; }, callerMeta as any);
    return { result, error };
  };
  it.each(["grok", "antigravity"])("an ACP %s target gets a steer message, and it is not held behind an earlier queued send (it goes in front)", async (backend) => {
    const ctx = ctxFor(backend, true);
    const { result, error } = await call(ctx, { steer: true });
    expect(error).toBeUndefined();
    expect(result).toMatchObject({ delivery_mode: "steer" });
    expect(result).not.toHaveProperty("warning");
    expect(ctx.deliverToInstance).toHaveBeenCalledWith("target", expect.objectContaining({ type: "steer", content: "supplement" }), { isCrossInstance: true, waitForIdle: false });
  });
  it("without steer it is an ordinary queued message, whatever the target runs", async () => {
    const ctx = ctxFor("grok", true);
    const { result } = await call(ctx, {});
    expect(result).not.toHaveProperty("delivery_mode", "steer");
    expect(ctx.deliverToInstance).toHaveBeenCalledWith("target", expect.objectContaining({ type: "fleet_inbound" }));
  });
  it("a terminal target is unchanged: a steer still waits behind an earlier queued send", async () => {
    const ctx = ctxFor("claude-code", false);
    const { result } = await call(ctx, { steer: true });
    expect(result).toMatchObject({ delivery_mode: "idle_queue" });
    expect(result.warning).toContain("previous message is still queued");
  });
});
