/**
 * #3731 phase 0: the adapter interface, with `tmux` as the only adapter. Nothing about how a fleet runs changes, so
 * these tests pin two things: the facade forwards to the daemon exactly, and the fleet really goes through the
 * interface (selection, start, stop, cancel, and the pane-only reads) rather than around it.
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ created: [] as any[] }));

vi.mock("../src/backend-availability.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/backend-availability.js")>(),
  resolveBackendBinary: vi.fn(async () => "/fixture/claude"),
}));

vi.mock("../src/daemon.js", async importOriginal => {
  const original = await importOriginal<typeof import("../src/daemon.js")>();
  const { EventEmitter: Emitter } = await import("node:events");
  class FakeDaemon extends Emitter {
    static seq = 0;
    readonly bootId = `boot-${++FakeDaemon.seq}`;
    isPaused = false;
    calls: string[] = [];
    constructor(public name: string) { super(); fake.created.push(this); }
    setDeliveryOutboxPort() {}
    setAgentCredentialIssuer() {}
    setPeerWorkingDirectories() {}
    setDecisionTeams() {}
    setDecisionSource() {}
    setStatusEmojiAvoidList() {}
    setWorkLeaseCheck() {}
    seedActivityNow() {}
    requestPauseWhenIdle() {}
    async start(...args: unknown[]) { this.calls.push(`start:${args.length}`); }
    async abortStartup() {}
    async stop() { this.calls.push("stop"); }
    async sendEscape() { this.calls.push("sendEscape"); }
    getProcessStatus() { return "running"; }
    getPaneContextSource() {
      return { generation: "g", isCurrent: () => true, capture: async () => "" } as any;
    }
    compactPaneUi() { return {}; }
    get lastPausedAt() { return null; }
  }
  return { ...original, Daemon: FakeDaemon };
});

import { FleetManager } from "../src/fleet-manager.js";
import { adapterOf, bindAdapter, cancelRunner, capabilitiesOf, noPaneMessage } from "../src/adapters/registry.js";
import { cliAdapterProblem } from "../src/adapters/config.js";
import { configuredCapabilities, selectAdapter } from "../src/adapters/select.js";
import { TmuxAdapter, tmuxCapabilities } from "../src/adapters/tmux-adapter.js";
import type { CliAdapter, InstanceRunner } from "../src/adapters/types.js";
import { validateFleetConfig } from "../src/config-validator.js";
import { loadFleetConfigSource } from "../src/config.js";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  fake.created.length = 0;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runnerDouble() {
  const calls: Array<[string, ...unknown[]]> = [];
  const runner = {
    start: vi.fn(async (...a: unknown[]) => { calls.push(["start", ...a]); }),
    stop: vi.fn(async () => { calls.push(["stop"]); }),
    getProcessStatus: vi.fn(() => "crashed" as const),
    pushChannelMessage: vi.fn((...a: unknown[]) => { calls.push(["push", ...a]); }),
    steerMessage: vi.fn((...a: unknown[]) => { calls.push(["steer", ...a]); }),
    sendEscape: vi.fn(async () => { calls.push(["escape"]); }),
  };
  const backend = { getSessionId: vi.fn((): string | null => "sess-1") };
  return { runner, backend, calls, adapter: new TmuxAdapter(runner as any, backend, "claude-code") };
}

describe("cli_adapter validation", () => {
  it.each([undefined, null, "tmux"])("accepts %j", value => {
    expect(cliAdapterProblem(value)).toBeNull();
  });
  it.each(["acp", "claude-stream-json", "", "TMUX", 1, {}])("refuses %j", value => {
    expect(cliAdapterProblem(value)).toEqual(expect.any(String));
  });
  it("says a named adapter is not supported yet", () => {
    expect(cliAdapterProblem("acp")).toContain("not supported yet");
  });
  it("is checked in fleet defaults and per instance by the validator", () => {
    expect(validateFleetConfig({ defaults: { cli_adapter: "tmux" }, instances: { a: { working_directory: "/tmp/a", cli_adapter: "tmux" }, b: { working_directory: "/tmp/b" } } }).errors).toEqual([]);
    const result = validateFleetConfig({ defaults: { cli_adapter: "acp" }, instances: { a: { working_directory: "/tmp/a", cli_adapter: "acp" } } });
    expect(result.errors).toContainEqual(expect.objectContaining({ path: "defaults.cli_adapter" }));
    expect(result.errors).toContainEqual(expect.objectContaining({ path: "instances.a.cli_adapter" }));
  });
  it("is refused when the config loads, naming the key", () => {
    expect(() => loadFleetConfigSource("instances:\n  a:\n    working_directory: /tmp/a\n    cli_adapter: acp\n")).toThrow(/instances\.a\.cli_adapter: "acp" is not supported yet/);
    expect(() => loadFleetConfigSource("defaults:\n  cli_adapter: acp\ninstances: {}\n")).toThrow(/defaults\.cli_adapter/);
    expect(loadFleetConfigSource("instances:\n  a:\n    working_directory: /tmp/a\n    cli_adapter: tmux\n").instances.a.cli_adapter).toBe("tmux");
    expect(loadFleetConfigSource("instances:\n  a:\n    working_directory: /tmp/a\n").instances.a.cli_adapter).toBeUndefined();
  });
});

describe("selectAdapter", () => {
  it.each([undefined, null, "tmux"])("builds the tmux adapter, once, for cli_adapter %j", value => {
    const { runner, backend } = runnerDouble();
    const tmux = vi.fn(() => ({ runner: runner as any, backend }));
    const adapter = selectAdapter("claude-code", { cli_adapter: value }, { tmux });
    expect(tmux).toHaveBeenCalledTimes(1);
    expect(adapter).toBeInstanceOf(TmuxAdapter);
    expect(adapter.id).toBe("tmux");
    expect(adapter.runner).toBe(runner);
  });
  it("binds the adapter to its runner", () => {
    const { runner, backend } = runnerDouble();
    const adapter = selectAdapter("claude-code", {}, { tmux: () => ({ runner: runner as any, backend }) });
    expect(adapterOf(runner as unknown as InstanceRunner)).toBe(adapter);
  });
  it("builds nothing for an adapter that is not supported", () => {
    const tmux = vi.fn();
    expect(() => selectAdapter("claude-code", { cli_adapter: "acp" }, { tmux: tmux as any })).toThrow(/not supported yet/);
    expect(tmux).not.toHaveBeenCalled();
  });
});

describe("TmuxAdapter forwards to the daemon", () => {
  it("starts with the admission fence when there is one, and with no argument when there is not", async () => {
    const { adapter, calls } = runnerDouble();
    const admission = () => {};
    await adapter.start({ admission });
    await adapter.start({});
    expect(calls).toEqual([["start", admission], ["start"]]);
  });
  it("stops, and reports the daemon's process state with no event time", async () => {
    const { adapter, runner } = runnerDouble();
    await adapter.stop();
    expect(runner.stop).toHaveBeenCalledTimes(1);
    expect(adapter.health()).toEqual({ process: "crashed", lastEventAt: null });
  });
  it("hands a prompt to the daemon's inbound entry, keeping its default epoch when none is given", () => {
    const { adapter, calls } = runnerDouble();
    expect(adapter.sendPrompt({ content: "hi", meta: { a: "b" }, targetSession: "s" })).toEqual({ accepted: true });
    adapter.sendPrompt({ content: "hi", meta: {}, deliveryEpoch: 4 });
    expect(calls).toEqual([["push", "hi", { a: "b" }, "s"], ["push", "hi", {}, undefined, 4]]);
  });
  it("steers through the daemon's steer, keeping its default epoch when none is given", () => {
    const { adapter, calls } = runnerDouble();
    adapter.steer("now", { m: "1" });
    adapter.steer("now", {}, 9);
    expect(calls).toEqual([["steer", "now", { m: "1" }], ["steer", "now", {}, 9]]);
  });
  it("cancels by sending the daemon's cancel key", async () => {
    const { adapter, calls } = runnerDouble();
    await adapter.cancel();
    expect(calls).toEqual([["escape"]]);
  });
  it("answers no permission request (a dialog is answered by keys) and emits no events", async () => {
    const { adapter } = runnerDouble();
    expect(adapter.answerPermission("r1", { optionId: "allow" })).toBe(false);
    const seen: unknown[] = [];
    for await (const event of adapter.events()) seen.push(event);
    expect(seen).toEqual([]);
  });
  it("reads the session id from the backend, null when it has none", () => {
    const { adapter, backend } = runnerDouble();
    expect(adapter.sessionId()).toBe("sess-1");
    backend.getSessionId.mockReturnValue(null);
    expect(adapter.sessionId()).toBeNull();
  });
  it("reports what tmux is: a pane, no live permissions or thought, steer per backend", () => {
    expect(tmuxCapabilities("claude-code")).toMatchObject({ paneView: true, livePermissions: false, liveThought: false, steer: true });
    expect(tmuxCapabilities("opencode").steer).toBe(false);
    expect(configuredCapabilities("claude-code", {}).paneView).toBe(true);
    expect(() => configuredCapabilities("claude-code", { cli_adapter: "acp" })).toThrow(/not supported yet/);
  });
});

describe("registry", () => {
  const paneless = (runner: InstanceRunner): CliAdapter => ({
    id: "tmux", runner, capabilities: { ...tmuxCapabilities("claude-code"), paneView: false },
    start: async () => {}, stop: async () => {}, health: () => ({ process: "running", lastEventAt: null }),
    sendPrompt: () => ({ accepted: true }), cancel: vi.fn(async () => {}), answerPermission: () => false,
    events: () => (async function* () {})(), sessionId: () => null,
  });
  it("treats a runner with no adapter as tmux", () => {
    expect(capabilitiesOf(undefined).paneView).toBe(true);
    expect(capabilitiesOf({} as InstanceRunner).paneView).toBe(true);
  });
  it("answers with the bound adapter's capabilities and cancels through it", async () => {
    const runner = { sendEscape: vi.fn(async () => {}) } as unknown as InstanceRunner;
    const adapter = paneless(runner);
    bindAdapter(adapter);
    expect(capabilitiesOf(runner).paneView).toBe(false);
    await cancelRunner(runner);
    expect(adapter.cancel).toHaveBeenCalledTimes(1);
    expect((runner as any).sendEscape).not.toHaveBeenCalled();
  });
  it("sends the escape key itself for a runner with no adapter", async () => {
    const runner = { sendEscape: vi.fn(async () => {}) } as unknown as InstanceRunner;
    await cancelRunner(runner);
    expect((runner as any).sendEscape).toHaveBeenCalledTimes(1);
  });
  it("names the instance and the operation when there is no pane", () => {
    expect(noPaneMessage("worker", "Attach")).toBe('Attach is not available for "worker": its adapter has no terminal pane.');
  });
});

function fleet() {
  const dataDir = join(tmpdir(), `agend-3731-${process.pid}-${Date.now()}-${dirs.length}`);
  mkdirSync(dataDir, { recursive: true });
  dirs.push(dataDir);
  const fm = new FleetManager(dataDir);
  const config = { working_directory: join(dataDir, "work"), backend: "claude-code" } as any;
  fm.fleetConfig = { defaults: {}, instances: { worker: config } } as any;
  vi.spyOn(fm as any, "connectIpcToInstance").mockResolvedValue(undefined);
  return { fm, config };
}

describe("the fleet runs instances through the adapter", () => {
  it("registers the runner that selectAdapter built, and starts it with no argument as before", async () => {
    const { fm, config } = fleet();
    await fm.lifecycle.start("worker", config, false);
    const daemon = fm.lifecycle.daemons.get("worker")!;
    const adapter = adapterOf(daemon);
    expect(adapter).toBeInstanceOf(TmuxAdapter);
    expect(adapter!.runner).toBe(daemon);
    expect(fake.created).toEqual([daemon]);
    // No admission fence for a plain start: the daemon is called with no argument, as before.
    expect((daemon as any).calls).toEqual(["start:0"]);
  });
  it("stops through the adapter", async () => {
    const { fm, config } = fleet();
    await fm.lifecycle.start("worker", config, false);
    const daemon: any = fm.lifecycle.daemons.get("worker");
    const stop = vi.spyOn(TmuxAdapter.prototype, "stop");
    await fm.lifecycle.stop("worker");
    expect(stop).toHaveBeenCalledTimes(1);
    expect(daemon.calls).toEqual(["start:0", "stop"]);
    expect(fm.lifecycle.daemons.has("worker")).toBe(false);
  });
  it("cancels through the adapter", async () => {
    const { fm, config } = fleet();
    await fm.lifecycle.start("worker", config, false);
    const daemon: any = fm.lifecycle.daemons.get("worker");
    const cancel = vi.spyOn(TmuxAdapter.prototype, "cancel");
    expect(fm.cancelInstance("worker")).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(daemon.calls).toContain("sendEscape");
  });
  it("does not start an instance whose cli_adapter is not supported", async () => {
    const { fm, config } = fleet();
    await expect(fm.lifecycle.start("worker", { ...config, cli_adapter: "acp" }, false)).rejects.toThrow(/not supported yet/);
    expect(fake.created).toHaveLength(0);
    expect(fm.lifecycle.daemons.has("worker")).toBe(false);
  });
  it("reads a pane for context only when the adapter has one", async () => {
    const { fm, config } = fleet();
    await fm.lifecycle.start("worker", config, false);
    const daemon = fm.lifecycle.daemons.get("worker")!;
    expect(fm.getPaneContextSource("worker")).not.toBeNull();
    const base = adapterOf(daemon)!;
    bindAdapter({ ...base, runner: daemon, capabilities: { ...base.capabilities, paneView: false } } as CliAdapter);
    expect(fm.getPaneContextSource("worker")).toBeNull();
  });
  it("follows a compact in the pane only when the adapter has one", async () => {
    const { fm, config } = fleet();
    await fm.lifecycle.start("worker", config, false);
    const daemon = fm.lifecycle.daemons.get("worker")!;
    const follow = () => (fm as any).compactWatch.deps.paneFollow("worker");
    expect(follow()).toBe(true);
    const base = adapterOf(daemon)!;
    bindAdapter({ ...base, runner: daemon, capabilities: { ...base.capabilities, paneView: false } } as CliAdapter);
    expect(follow()).toBe(false);
  });
});
