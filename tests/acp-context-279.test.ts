/**
 * AGEND-279 (5): the context figure of an ACP agent. grok reports each model call's tokens in its own `_x.ai/session_notification`
 * and the window of its current model in `models`; agy reports `usage_update` {used, size}. Both reach the dashboard, `/ctx` and
 * `/status` through `reportedContext` (an ACP agent has no screen to read). Nothing is guessed: no report, no figure. The grok data is
 * a real capture (grok 1.0.77), the rest runs the runner with the fake agent replaying it.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AcpAdapter } from "../src/adapters/acp/acp-adapter.js";
import { AcpRunner, tokenLabel } from "../src/adapters/acp/acp-runner.js";
import { AGY_PROFILE, GROK_PROFILE } from "../src/adapters/acp/profiles.js";
import { UpdateTranslator } from "../src/adapters/acp/translate.js";
import { IpcClient } from "../src/channel/ipc-bridge.js";
import { formatContextUsageLine, resolveInstanceContext } from "../src/topic-commands.js";
import type { InstanceConfig } from "../src/types.js";

const FIX = join(import.meta.dirname, "fixtures", "acp");
const FAKE = join(FIX, "fake-acp-agent.mjs");
const CAPTURE = join(FIX, "grok-1.0.77-context.json");
const real = JSON.parse(readFileSync(CAPTURE, "utf8"));
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const dirs: string[] = [];
const runners: AcpRunner[] = [];
const clients: IpcClient[] = [];
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), "acpc-")); dirs.push(d); return d; };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 6000, what = "condition") => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(15); } };
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => undefined);
  await Promise.all(runners.splice(0).map(r => r.stop().catch(() => undefined)));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("what grok reports", () => {
  it("a model call's context is the prompt it sent: tokens paid for plus tokens read from the cache (real capture)", () => {
    const events = new UpdateTranslator().translateGrokNotification(real.response_completed.params);
    expect(events).toEqual([{ kind: "usage", used: 14877 + 2176 }]);
    // the turn's own total agrees (input 17053 includes the cache read), so the sum is the prompt size and not a double count
    expect(real.turn_completed.params.update.usage.inputTokens).toBe(17053);
  });
  it("nothing else in the notification stream is a reading", () => {
    const t = new UpdateTranslator();
    expect(t.translateGrokNotification(real.turn_completed.params)).toEqual([]);
    expect(t.translateGrokNotification({ update: { sessionUpdate: "response_completed" } })).toEqual([]);
    expect(t.translateGrokNotification({ update: { sessionUpdate: "response_completed", usage: { input_tokens: "many" } } })).toEqual([]);
    expect(t.translateGrokNotification(null)).toEqual([]);
  });
  it("the window is the current model's `totalContextTokens` (real capture); an unknown model, or none, is no window", () => {
    expect(GROK_PROFILE.contextWindowOf!(real.models)).toBe(256000);
    expect(GROK_PROFILE.contextWindowOf!({ ...real.models, currentModelId: "nope" })).toBeNull();
    expect(GROK_PROFILE.contextWindowOf!(undefined)).toBeNull();
    expect(GROK_PROFILE.contextWindowOf!({ currentModelId: "m", availableModels: [{ modelId: "m", _meta: { totalContextTokens: -5 } }] })).toBeNull();
  });
  it("the capabilities say grok reports a context and, as before, agy does", () => {
    expect(GROK_PROFILE.capabilities.contextUsage).toBe(true);
    expect(AGY_PROFILE.capabilities.contextUsage).toBe(true);
  });
});

async function boot(profile: typeof GROK_PROFILE, backend: string, env: Record<string, string>) {
  const dir = tmp(), state = tmp();
  const config = { working_directory: dir, backend, cli_adapter: "acp" } as InstanceConfig;
  const holder: { runner?: AcpRunner } = {};
  const adapter = new AcpAdapter({
    profile: { ...profile, supportedVersions: ["1.5.8"], versionOf: AGY_PROFILE.versionOf, args: () => [FAKE] }, command: process.execPath, cwd: dir, instanceDir: dir, mcpServers: [], logger,
    env: { PATH: process.env.PATH }, childEnv: { FAKE_ACP_STATE: state, FAKE_ACP_VERSION: "1.5.8", ...env },
    makeRunner: a => (holder.runner = new AcpRunner(a, { name: "worker", config, instanceDir: dir, topicMode: true, backend, logger })),
  });
  const runner = holder.runner!;
  runners.push(runner);
  await runner.start();
  const fleet = new IpcClient(join(dir, "channel.sock"));
  clients.push(fleet);
  await fleet.connect();
  fleet.on("message", (m: any) => { if (m.type === "fleet_outbound") fleet.send({ type: "fleet_outbound_response", fleetRequestId: m.fleetRequestId, result: { messageId: "m1" } }); });
  const turn = async (text: string, id: string) => {
    const before = runner.steps.snapshot(undefined, { thoughts: false }).steps.filter(s => s.kind === "turn_end").length;
    fleet.send({ type: "fleet_inbound", content: text, meta: { chat_id: "c", message_id: id, user: "alice", source: "web" } });
    await until(() => runner.steps.snapshot(undefined, { thoughts: false }).steps.filter(s => s.kind === "turn_end").length > before && runner.getInstanceState() === "idle", 6000, "the turn");
  };
  return { runner, turn };
}

describe("through the runner", () => {
  it("grok: nothing before the first model call; after it, used / window as a percentage and as the pair grok's screen shows", async () => {
    const h = await boot(GROK_PROFILE, "grok", { FAKE_ACP_GROK_CONTEXT: CAPTURE });
    expect(h.runner.contextReport()).toBeNull();
    await h.turn("hello", "m-1");
    const report = h.runner.contextReport()!;
    expect(report.context).toBeCloseTo(17053 / 256000 * 100, 6);
    expect(report.tokenRatio).toEqual({ usedLabel: "17.1K", totalLabel: "256K", percentage: report.context });
    expect(formatContextUsageLine(report.context, report.tokenRatio)).toContain("17.1K / 256K (7%)");
  });
  it("agy: usage_update's own used / size, as a percentage only", async () => {
    const h = await boot(AGY_PROFILE, "antigravity", {});
    expect(h.runner.contextReport()).toBeNull();
    await h.turn("hello", "m-1");
    expect(h.runner.contextReport()).toEqual({ context: 10, tokenRatio: null });   // the fake agent reports 100 of 1000
  });
  it("grok's own notification is read only for grok: agy keeps its usage_update, whatever else arrives", async () => {
    const h = await boot(AGY_PROFILE, "antigravity", { FAKE_ACP_GROK_CONTEXT: CAPTURE });
    await h.turn("hello", "m-1");
    expect(h.runner.contextReport()).toEqual({ context: 10, tokenRatio: null });
  });
  it("a CLI that reports no context has no figure, whatever it sends", async () => {
    const h = await boot({ ...GROK_PROFILE, capabilities: { ...GROK_PROFILE.capabilities, contextUsage: false } }, "grok", { FAKE_ACP_GROK_CONTEXT: CAPTURE });
    await h.turn("hello", "m-1");
    expect(h.runner.contextReport()).toBeNull();
  });
  it("the figure survives the next turn and follows it", async () => {
    const h = await boot(GROK_PROFILE, "grok", { FAKE_ACP_GROK_CONTEXT: CAPTURE });
    await h.turn("one", "m-1"); const first = h.runner.contextReport()!.context;
    await h.turn("two", "m-2");
    expect(h.runner.contextReport()!.context).toBe(first);   // the fake agent reports the same prompt size each call
  });
});

describe("where the figure is read", () => {
  it("resolveInstanceContext: what the agent reports is used as it is; without one, nothing changes", () => {
    const reported = { context: 42, tokenRatio: null };
    expect(resolveInstanceContext("/nowhere", "w", "grok", { reported })).toEqual(reported);
    expect(resolveInstanceContext("/nowhere", "w", "claude-code", { reported, statusline: { context_window: { used_percentage: 7 } } })).toEqual(reported);
    expect(resolveInstanceContext("/nowhere", "w", "claude-code", { reported: null, statusline: { context_window: { used_percentage: 7 } } })).toEqual({ context: 7, tokenRatio: null });
  });
  it("the fleet answers for an ACP runner only; a terminal runner (even with a figure of its own) is read as before", async () => {
    const dir = tmp();
    vi.stubEnv("AGEND_HOME", dir);
    const { FleetManager } = await import("../src/fleet-manager.js");
    const { bindAdapter } = await import("../src/adapters/registry.js");
    const fm = new FleetManager(dir) as any;
    clearInterval(fm.sessionPruneTimer);
    const make = (id: "acp" | "tmux") => { const runner = { contextReport: () => ({ context: 33, tokenRatio: null }) } as never; bindAdapter({ id, runner, capabilities: { contextUsage: true, paneView: id === "tmux" } } as never); return runner as unknown as object; };
    fm.lifecycle.daemons.set("a", make("acp"));
    fm.lifecycle.daemons.set("t", make("tmux"));
    expect(fm.reportedContext("a")).toEqual({ context: 33, tokenRatio: null });
    expect(fm.reportedContext("t")).toBeNull();
    expect(fm.reportedContext("missing")).toBeNull();
    vi.unstubAllEnvs();
  });
});

describe("token labels", () => {
  it.each([[850, "850"], [14877, "14.9K"], [17053, "17.1K"], [256000, "256K"], [500000, "500K"], [1_200_000, "1.2M"], [999_999, "1M"], [999_949, "999.9K"]])("%i → %s", (n, label) => {
    expect(tokenLabel(n)).toBe(label);
  });
});
