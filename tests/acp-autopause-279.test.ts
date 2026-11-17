/**
 * AGEND-279 (4): `auto_pause_after` for an ACP instance. The terminal daemon's own idle clock (auto-pause.ts), fed by ACP's busy / idle
 * instead of the pane: an idle instance that was last given work longer ago than the threshold asks the fleet to pause it, an
 * instance that is working, waiting for a person's permission answer, queued, held by a work lease or the General never does, and
 * the next message wakes it and starts a fresh window. The runner runs with a fake agent and a clock the test moves.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IpcClient } from "../src/channel/ipc-bridge.js";
import { AcpAdapter } from "../src/adapters/acp/acp-adapter.js";
import { AcpRunner } from "../src/adapters/acp/acp-runner.js";
import { AGY_PROFILE } from "../src/adapters/acp/profiles.js";
import { readLastInboundAt } from "../src/auto-pause.js";
import { AutoPauseController } from "../src/daemon.js";
import type { InstanceConfig } from "../src/types.js";

const FAKE = join(import.meta.dirname, "fixtures", "acp", "fake-acp-agent.mjs");
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const dirs: string[] = [];
const runners: AcpRunner[] = [];
const clients: IpcClient[] = [];
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), "acpa-")); dirs.push(d); return d; };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 6000, what = "condition") => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(15); } };
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => undefined);
  await Promise.all(runners.splice(0).map(r => r.stop().catch(() => undefined)));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const MIN = 60_000;
async function boot(o: { config?: Partial<InstanceConfig>; name?: string; dir?: string; clock: { t: number }; hangCheckEveryMs?: number; lease?: () => boolean; env?: Record<string, string> }) {
  const dir = o.dir ?? tmp(), state = tmp();
  const config = { working_directory: dir, backend: "antigravity", cli_adapter: "acp", ...o.config } as InstanceConfig;
  const profile = { ...AGY_PROFILE, supportedVersions: ["1.5.8"], args: () => [FAKE] };
  const holder: { runner?: AcpRunner } = {};
  const adapter = new AcpAdapter({
    profile, command: process.execPath, cwd: dir, instanceDir: dir, mcpServers: [], logger, env: { PATH: process.env.PATH }, childEnv: { FAKE_ACP_STATE: state, FAKE_ACP_VERSION: "1.5.8", ...o.env },
    makeRunner: a => (holder.runner = new AcpRunner(a, { name: o.name ?? "worker", config, instanceDir: dir, topicMode: true, backend: "antigravity", logger, now: () => o.clock.t, ...(o.hangCheckEveryMs ? { hangCheckEveryMs: o.hangCheckEveryMs } : {}) })),
  });
  const runner = holder.runner!;
  runners.push(runner);
  if (o.lease) runner.setWorkLeaseCheck(o.lease);
  const requests: any[] = [];
  runner.on("auto_pause_requested", (d: unknown) => requests.push(d));
  await runner.start();
  const fleet = new IpcClient(join(dir, "channel.sock"));
  clients.push(fleet);
  await fleet.connect();
  fleet.on("message", (m: any) => { if (m.type === "fleet_outbound") fleet.send({ type: "fleet_outbound_response", fleetRequestId: m.fleetRequestId, result: { messageId: "m1" } }); });
  return { runner, fleet, dir, requests };
}
const say = (text: string, id: string) => ({ type: "fleet_inbound", content: text, meta: { chat_id: "chat-1", message_id: id, user: "alice", source: "web" } });
const done = (h: { runner: AcpRunner }, n: number) => until(() => h.runner.steps.snapshot(undefined, { thoughts: false }).steps.filter(s => s.kind === "turn_end").length >= n && h.runner.getInstanceState() === "idle", 6000, "the turn to end");

describe("an idle ACP instance with auto_pause_after", () => {
  it("asks to be paused once it has been idle past the threshold, once", async () => {
    const clock = { t: 1_000_000 };
    const h = await boot({ clock, config: { auto_pause_after: 10 } });
    h.runner.checkAutoPause();
    expect(h.requests).toEqual([]);
    clock.t += 9 * MIN; h.runner.checkAutoPause();
    expect(h.requests).toEqual([]);
    clock.t += 2 * MIN; h.runner.checkAutoPause();
    expect(h.requests).toMatchObject([{ name: "worker", reason: "idle" }]);
    h.runner.checkAutoPause();
    expect(h.requests).toHaveLength(1);
  });
  it("the timer asks on its own", async () => {
    const clock = { t: 1_000_000 };
    const h = await boot({ clock, config: { auto_pause_after: 1 }, hangCheckEveryMs: 20 });
    clock.t += 2 * MIN;
    await until(() => h.requests.length === 1, 3000, "the timer's request");
  });
  it("never without the setting, with 0, or for the General", async () => {
    const clock = { t: 1_000_000 };
    for (const [name, config] of [["worker", {}], ["worker", { auto_pause_after: 0 }], ["general", { auto_pause_after: 1 }], ["w2", { auto_pause_after: 1, general_topic: true }]] as const) {
      const h = await boot({ clock, name, config });
      clock.t += 60 * MIN; h.runner.checkAutoPause();
      expect(h.requests, `${name} ${JSON.stringify(config)}`).toEqual([]);
    }
  });
  it("never while a turn is running; a turn that ends counts as activity, so a long one is not followed by an immediate pause", async () => {
    const clock = { t: 1_000_000 };
    const h = await boot({ clock, config: { auto_pause_after: 10 } });
    clock.t += 30 * MIN;
    h.fleet.send(say("hello #linger", "m-1"));
    await until(() => h.runner.getInstanceState() === "working", 3000, "busy");
    clock.t += 30 * MIN; h.runner.checkAutoPause();
    expect(h.requests).toEqual([]);                       // working: past the threshold, and still not asked
    await done(h, 1);
    h.runner.checkAutoPause();
    expect(h.requests).toEqual([]);                       // the turn ended just now: the window starts here, not at the (30 min older) start of the turn
    clock.t += 9 * MIN; h.runner.checkAutoPause();
    expect(h.requests).toEqual([]);
    clock.t += 2 * MIN; h.runner.checkAutoPause();
    expect(h.requests).toHaveLength(1);                   // idle for longer than the threshold since the turn ended
  }, 15000);
  it("never while a permission request waits for a person", async () => {
    const clock = { t: 1_000_000 };
    const h = await boot({ clock, config: { auto_pause_after: 10, skipPermissions: false } });
    h.fleet.send(say("#tool", "m-1"));
    await until(() => h.runner.steps.pendingPermissions().length === 1, 4000, "the permission request");
    clock.t += 60 * MIN; h.runner.checkAutoPause();
    expect(h.requests).toEqual([]);
  }, 15000);
  it("work that is not a person's message (another instance, a schedule) restarts the clock too", async () => {
    const clock = { t: 1_000_000 };
    const h = await boot({ clock, config: { auto_pause_after: 10 } });
    clock.t += 30 * MIN;
    h.fleet.send({ type: "fleet_inbound", content: "from a peer", meta: { chat_id: "", message_id: "", user: "", source: "cross_instance", from_instance: "peer" } });
    await done(h, 1);
    clock.t += 5 * MIN; h.runner.checkAutoPause();
    expect(h.requests).toEqual([]);                       // the peer's work was 5 min ago, not 35
    clock.t += 6 * MIN; h.runner.checkAutoPause();
    expect(h.requests).toHaveLength(1);
  }, 15000);
  it("a work lease holds it, and lifting the lease lets it ask", async () => {
    const clock = { t: 1_000_000 };
    let lease = true;
    const h = await boot({ clock, config: { auto_pause_after: 10 }, lease: () => lease });
    clock.t += 20 * MIN; h.runner.checkAutoPause();
    expect(h.requests).toEqual([]);
    lease = false; h.runner.checkAutoPause();
    expect(h.requests).toHaveLength(1);
  });
  it("a changed threshold starts a fresh countdown; null switches it off", async () => {
    const clock = { t: 1_000_000 };
    const h = await boot({ clock, config: { auto_pause_after: 10 } });
    clock.t += 8 * MIN;
    h.runner.applyConfigUpdate({ auto_pause_after: 5 });
    clock.t += 4 * MIN; h.runner.checkAutoPause();
    expect(h.requests).toEqual([]);                       // 4 min since the change
    clock.t += 2 * MIN; h.runner.checkAutoPause();
    expect(h.requests).toHaveLength(1);
    const g = await boot({ clock, config: { auto_pause_after: 5 } });
    g.runner.applyConfigUpdate({ auto_pause_after: null });
    clock.t += 60 * MIN; g.runner.checkAutoPause();
    expect(g.requests).toEqual([]);
  });
});

describe("pausing and waking", () => {
  it("pause stops the agent; the next message wakes it, resumes, and starts a new window", async () => {
    const clock = { t: 1_000_000 };
    const h = await boot({ clock, config: { auto_pause_after: 10 } });
    h.fleet.send(say("one", "m-1")); await done(h, 1);
    clock.t += 20 * MIN; h.runner.checkAutoPause();
    expect(h.requests).toHaveLength(1);
    await h.runner.pause("idle");
    expect(h.runner.isPaused).toBe(true);
    expect(h.runner.getProcessStatus()).toBe("stopped");
    clock.t += 60 * MIN; h.runner.checkAutoPause();
    expect(h.requests).toHaveLength(1);                   // paused: not asked again
    h.fleet.send(say("two", "m-2")); await done(h, 2);
    expect(h.runner.isPaused).toBe(false);
    clock.t += 3 * MIN; h.runner.checkAutoPause();
    expect(h.requests).toHaveLength(1);                   // a fresh window from the wake and the message
    clock.t += 20 * MIN; h.runner.checkAutoPause();
    expect(h.requests).toHaveLength(2);                   // and it asks again after the next idle period
  }, 20000);
  it("the last work time is kept on disk, so a restarted fleet still pauses an instance that has been idle for long", async () => {
    const clock = { t: 5_000_000 };
    const dir = tmp();
    const first = await boot({ clock, dir, config: { auto_pause_after: 10 } });
    first.fleet.send(say("one", "m-1")); await done(first, 1);
    expect(readLastInboundAt(dir, clock.t + 1)).toBe(5_000_000);
    await first.runner.stop();
    // the file is time-stamped by the test's clock (in the past for the real one), so a new runner reads it back as "now" and a later clock is past it
    const second = await boot({ clock: { t: 5_000_000 + 11 * MIN }, dir, config: { auto_pause_after: 10 } });
    second.runner.checkAutoPause();
    expect(second.requests).toHaveLength(1);
  }, 15000);
});

describe("the shared clock is the terminal daemon's", () => {
  it("AutoPauseController is the same class from both modules", async () => {
    const mod = await import("../src/auto-pause.js");
    expect(AutoPauseController).toBe(mod.AutoPauseController);
    const c = new AutoPauseController(10_000, 0);
    expect(c.observe("idle", 10_000)).toBe(true);
    expect(c.observe("working", 10_000)).toBe(false);
  });
});

describe("\"Send now\" takes a message out of the queue: the count goes with it (AGEND-279)", () => {
  it("the queue count matches the queue, so the instance goes idle and is auto-paused afterwards, and an interruption is `idle` again", async () => {
    const clock = { t: 1_000_000 };
    const h = await boot({ clock, config: { auto_pause_after: 10 }, env: { FAKE_ACP_CONCURRENT: "fold" } });
    const count = () => (h.runner as unknown as { queued: number }).queued;
    h.fleet.send(say("A #slow", "a"));
    await until(() => h.runner.getInstanceState() === "working", 3000, "A is working");
    h.runner.pushChannelMessage("C waits", { chat_id: "chat-1", message_id: "c", user: "alice", source: "web" });
    expect([count(), h.runner.inboxOrder()]).toEqual([2, ["C waits"]]);                       // the running turn and the one waiting
    expect(h.runner.interruptQueued("c")).toBe("add");
    expect([count(), h.runner.inboxOrder()]).toEqual([1, []]);                                // the waiting one left: only the running turn is counted
    await done(h, 1);
    expect(count()).toBe(0);                                                                  // nothing is counted that is not there
    expect(h.runner.interruptMode()).toBe("idle");
    clock.t += 11 * MIN; h.runner.checkAutoPause();
    expect(h.requests).toMatchObject([{ name: "worker", reason: "idle" }]);                    // a stuck count would keep it "queued" for ever
  });
});
