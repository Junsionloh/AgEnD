import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.js";
import { AGY_STEER_MIN_VERSION, AntigravityBackend, agySteerKeyFor, readAgyQueuedMessages } from "../src/backend/antigravity.js";
import { instanceSupportsSteer } from "../src/steer-capability.js";
import { RuntimePanePort } from "../src/runtime-pane-port.js";

/**
 * AGEND-284: a steer into a busy tmux agy. agy sends a message by its own `Queued Messages` setting (settings.json
 * `queuedMessages`): "queue" (the default) holds it for the turn's end, "send-immediately" hands it to the running turn at
 * the next step boundary without cancelling the tool. Alt+M (agy 1.4.0+) sends with the opposite of the setting. Measured
 * live on agy 1.5.10 (see the PR): under "queue" Alt+M took the message into the turn and the running tool finished; under
 * "send-immediately" a plain Enter did, and Alt+M queued it. agy reads the setting once, when it starts, so the steer's key follows
 * the setting as it was at launch, and a file changed since offers no steer.
 */
const roots: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const BUSY = readFileSync(join(__dirname, "fixtures", "agy-1.3.1-busy-generating.pane.txt"), "utf8");
const MARKER_ROWS = "\n> [STEERING — mid-task course correction.]\n(message_id: message-284)";
const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } } as any;

/** A fake HOME holding agy's settings: `undefined` writes no file, a string is the file's text. */
function agyHome(settings: string | undefined): string {
  const home = mkdtempSync(join(tmpdir(), "agend-284-")); roots.push(home);
  if (settings !== undefined) {
    mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
    writeFileSync(join(home, ".gemini", "antigravity-cli", "settings.json"), settings);
  }
  return home;
}
const backendFor = (settings: string | undefined) => new AntigravityBackend(join(agyHome(undefined), "instance"), agyHome(settings));

describe("what the setting means for a steer", () => {
  it.each([
    ["no settings file: agy's default, queue", undefined, "queue"],
    ["an empty object: no key, queue", "{}", "queue"],
    ["queue", '{"queuedMessages":"queue"}', "queue"],
    ["send-immediately", '{"queuedMessages":"send-immediately"}', "send-immediately"],
    ["other keys around it", '{"toolPermission":"always-proceed","queuedMessages":"send-immediately","trustedWorkspaces":[]}', "send-immediately"],
    ["a value this table does not know", '{"queuedMessages":"interrupt"}', null],
    ["not a string", '{"queuedMessages":true}', null],
    ["not JSON", "{ nope", null],
    ["a JSON that is not an object", "[]", null],
    ["an empty file", "", null],
  ] as const)("%s → %s", (_name, text, expected) => {
    const home = agyHome(text);
    expect(readAgyQueuedMessages(join(home, ".gemini", "antigravity-cli"))).toBe(expected);
  });

  it("a settings.json that cannot be read (here: a directory) is unknown, not the default", () => {
    const home = agyHome(undefined);
    mkdirSync(join(home, ".gemini", "antigravity-cli", "settings.json"), { recursive: true });
    expect(readAgyQueuedMessages(join(home, ".gemini", "antigravity-cli"))).toBeNull();
  });

  it("the key: Alt+M against 'queue', Enter against 'send-immediately', none when unknown", () => {
    expect(agySteerKeyFor("queue")).toBe("M-m");
    expect(agySteerKeyFor("send-immediately")).toBe("Enter");
    expect(agySteerKeyFor(null)).toBeNull();
  });
});

describe("AntigravityBackend answers per launch", () => {
  it("takes a steer under the default and under send-immediately, with the key that setting needs", () => {
    const queue = backendFor(undefined);
    expect([queue.supportsSteer(), queue.steerSubmitKey()]).toEqual([true, "M-m"]);
    const now = backendFor('{"queuedMessages":"send-immediately"}');
    expect([now.supportsSteer(), now.steerSubmitKey()]).toEqual([true, "Enter"]);
  });

  it("an unreadable setting is no steer (the message is queued, as before)", () => {
    const b = backendFor("{ nope");
    expect([b.supportsSteer(), b.steerSubmitKey()]).toEqual([false, null]);
  });

  it("agy reads the setting once, at launch: a file changed since says nothing about the running agy, so no steer is offered until it is back", () => {
    const home = agyHome('{"queuedMessages":"queue"}');
    const file = join(home, ".gemini", "antigravity-cli", "settings.json");
    const b = new AntigravityBackend(join(home, "instance"), home);
    b.noteLaunchSettings();                                   // the launch: agy starts and reads "queue"
    expect(b.steerSubmitKey()).toBe("M-m");
    writeFileSync(file, '{"queuedMessages":"send-immediately"}');
    expect(b.steerSubmitKey()).toBeNull();                    // measured: the running agy still queues a plain Enter
    expect(b.supportsSteer()).toBe(false);
    writeFileSync(file, "{ half written");
    expect(b.steerSubmitKey()).toBeNull();
    writeFileSync(file, '{"queuedMessages":"queue"}');
    expect(b.steerSubmitKey()).toBe("M-m");                   // the same as at launch again
    b.noteLaunchSettings();                                   // a relaunch under the other setting follows it
    writeFileSync(file, '{"queuedMessages":"send-immediately"}');
    b.noteLaunchSettings();
    expect(b.steerSubmitKey()).toBe("Enter");
  });

  it("a launch whose setting could not be read offers nothing, even if the file is fine afterwards", () => {
    const home = agyHome("{ nope");
    const file = join(home, ".gemini", "antigravity-cli", "settings.json");
    const b = new AntigravityBackend(join(home, "instance"), home);
    b.noteLaunchSettings();
    writeFileSync(file, '{"queuedMessages":"queue"}');
    expect(b.steerSubmitKey()).toBeNull();
  });

  it("the version policy is a floor: older than 1.4.0 is refused; newer, or one that is not recorded, is not", () => {
    expect(AGY_STEER_MIN_VERSION).toBe("1.4.0");
    const agendHome = agyHome(undefined);
    const b = new AntigravityBackend(join(agendHome, "instance"), agyHome(undefined), agendHome);
    const record = (text: string | null) => {
      mkdirSync(join(agendHome, "cli-env"), { recursive: true });
      if (text === null) rmSync(join(agendHome, "cli-env", "antigravity.json"), { force: true });
      else writeFileSync(join(agendHome, "cli-env", "antigravity.json"), text);
    };
    for (const [version, key] of [["1.3.6", null], ["1.3.99", null], ["1.4.0", "M-m"], ["1.5.10", "M-m"], ["2.0.0", "M-m"], ["agy 1.3.6", null],
      ["unknown", "M-m"]] as const) {
      record(JSON.stringify({ probedAt: 1, version }));
      expect(b.steerSubmitKey(), String(version)).toBe(key);
    }
    record(null);                                              // nothing recorded yet
    expect(b.steerSubmitKey()).toBe("M-m");
    record("{ half written");
    expect(b.steerSubmitKey()).toBe("M-m");
  });

  it("the name table alone still says no (nothing steers an agy that is not running); a running launch decides", () => {
    expect(instanceSupportsSteer("antigravity", undefined)).toBe(false);
    expect(instanceSupportsSteer("antigravity", true)).toBe(true);
    expect(instanceSupportsSteer("antigravity", false)).toBe(false);
  });
});

interface Opts { settings?: string; enterOk?: boolean; native?: boolean; pane?: (s: { pasted: boolean }) => string }

async function steerAgy(opts: Opts = {}) {
  vi.useFakeTimers();
  const root = mkdtempSync(join(tmpdir(), "agend-284-d-")); roots.push(root);
  const instanceDir = join(root, "instances", "agy");
  const backend = new AntigravityBackend(instanceDir, agyHome(opts.settings));
  backend.noteLaunchSettings();
  const daemon: any = new Daemon("agy", {
    working_directory: root, log_level: "error",
    restart_policy: { max_retries: 10, backoff: "exponential", reset_after: 300 },
    context_guardian: { max_age_hours: 4, grace_period_ms: 600_000 },
  }, instanceDir, false, backend as any,
  { getObservationResetAt: () => 0, getLastOutputAt: () => undefined, isIdle: () => false, waitUntilIdle: vi.fn(async () => true) } as any, logger);
  mkdirSync(instanceDir, { recursive: true });
  writeFileSync(join(instanceDir, "window-id"), "@agy");
  const state = { pasted: false };
  const keys: string[] = [];
  const tmux = {
    capturePane: vi.fn(async () => (opts.pane ? opts.pane(state) : state.pasted ? `${BUSY}${MARKER_ROWS}` : BUSY)),
    pasteBuffer: vi.fn(async () => { state.pasted = true; return true; }),
    sendSpecialKey: vi.fn(async (key: string) => { keys.push(key); return opts.enterOk !== false; }),
    getLastPasteError: vi.fn(), isLastPasteFailureRecoverable: vi.fn(() => true), getLastSendSpecialKeyError: vi.fn(),
    getWindowId: () => "@agy",
  };
  daemon.tmux = tmux;
  if (opts.native) daemon.nativePaneLifecycle = {};
  vi.spyOn(daemon, "wake").mockResolvedValue(undefined);
  vi.spyOn(daemon, "waitForInputTransientToClear").mockResolvedValue(true);
  vi.spyOn(daemon, "paneReadinessForDelivery").mockResolvedValue("busy");
  vi.spyOn(daemon, "probeBlockingDialog").mockResolvedValue({ state: "clear" } as any);
  vi.spyOn(daemon, "hasPositiveDeliveryInput").mockResolvedValue(true);
  // A steer that is not handed to the busy pane waits for the idle prompt: here that wait ends at once, with the pane never ready.
  const idleWait = vi.spyOn(daemon, "waitForPaneReadyForDelivery").mockResolvedValue(false);
  const delivered: unknown[] = [];
  const real = daemon.deliverMessage.bind(daemon);
  vi.spyOn(daemon, "deliverMessage").mockImplementation(async (...args: unknown[]) => { const r = await real(...args); delivered.push(r); return r; });
  const meta = {
    user: "u", user_id: "u", message_id: "message-284", chat_id: "chat", thread_id: "", ts: new Date().toISOString(),
  };
  daemon.steerMessage("change course", meta);
  await vi.runAllTimersAsync();
  await daemon.steerLock;
  return { daemon, tmux, keys, delivered, backend, idleWait };
}

describe("a steer into a busy tmux agy", () => {
  it("under the default 'queue' goes in with Alt+M (M-m) — one paste, one key, never Enter", async () => {
    const r = await steerAgy();
    expect(r.tmux.pasteBuffer).toHaveBeenCalledOnce();
    expect(r.keys).toEqual(["M-m"]);
    expect(r.delivered).toEqual([true]);
  });

  it("with settings.json saying queue, the same", async () => {
    const r = await steerAgy({ settings: '{"queuedMessages":"queue"}' });
    expect(r.keys).toEqual(["M-m"]);
  });

  it("under 'send-immediately' Alt+M would queue it: the steer goes in with a plain Enter", async () => {
    const r = await steerAgy({ settings: '{"queuedMessages":"send-immediately"}' });
    expect(r.tmux.pasteBuffer).toHaveBeenCalledOnce();
    expect(r.keys).toEqual(["Enter"]);
    expect(r.delivered).toEqual([true]);
  });

  it("with a setting it cannot read nothing is typed into the busy agy: the steer waits for the idle prompt like any message", async () => {
    const r = await steerAgy({ settings: "{ nope" });
    expect(r.idleWait).toHaveBeenCalled();
    expect(r.tmux.pasteBuffer).not.toHaveBeenCalled();
    expect(r.keys).toEqual([]);
  });

  it("an Alt+M that could not be sent is not a delivery", async () => {
    const r = await steerAgy({ enterOk: false });
    expect(r.keys[0]).toBe("M-m");
    expect(r.delivered).not.toEqual([true]);
  });

  it("a native pane (Windows host) has no Alt+M: no steer is offered there, nothing is typed", async () => {
    const r = await steerAgy({ native: true });
    expect(r.daemon.launchSupportsSteer()).toBe(false);
    expect(r.keys).not.toContain("M-m");
    expect(r.tmux.pasteBuffer).not.toHaveBeenCalled();
  });

  it("…but a native pane under 'send-immediately' needs only Enter, which it has", async () => {
    const r = await steerAgy({ native: true, settings: '{"queuedMessages":"send-immediately"}' });
    expect(r.daemon.launchSupportsSteer()).toBe(true);
  });

  it("a launch's own answer reaches every entry point (/steer, Ctrl+Enter, send_to_instance steer:true) through launchSupportsSteer", async () => {
    const r = await steerAgy();
    expect(r.daemon.launchSupportsSteer()).toBe(true);
    const unreadable = await steerAgy({ settings: "{ nope" });
    expect(unreadable.daemon.launchSupportsSteer()).toBe(false);
  });
});

describe("an ordinary message to a busy agy is unchanged", () => {
  it("it waits for the idle prompt: nothing is typed into the busy box, and Alt+M is not its key", async () => {
    vi.useFakeTimers();
    const root = mkdtempSync(join(tmpdir(), "agend-284-q-")); roots.push(root);
    const instanceDir = join(root, "instances", "agy");
    const daemon: any = new Daemon("agy", {
      working_directory: root, log_level: "error",
      restart_policy: { max_retries: 10, backoff: "exponential", reset_after: 300 },
      context_guardian: { max_age_hours: 4, grace_period_ms: 600_000 },
    }, instanceDir, false, new AntigravityBackend(instanceDir, agyHome(undefined)) as any,
    { getObservationResetAt: () => 0, getLastOutputAt: () => undefined, isIdle: () => false, waitUntilIdle: vi.fn(async () => true) } as any, logger);
    mkdirSync(instanceDir, { recursive: true });
    const gate = vi.spyOn(daemon, "waitForPaneReadyForDelivery").mockResolvedValue(false);
    const keys: string[] = [];
    daemon.tmux = {
      capturePane: vi.fn(async () => BUSY), pasteBuffer: vi.fn(async () => true),
      sendSpecialKey: vi.fn(async (key: string) => { keys.push(key); return true; }),
      getWindowId: () => "@agy", getLastPasteError: vi.fn(), isLastPasteFailureRecoverable: vi.fn(() => true), getLastSendSpecialKeyError: vi.fn(),
    };
    writeFileSync(join(instanceDir, "window-id"), "@agy");
    vi.spyOn(daemon, "wake").mockResolvedValue(undefined);
    vi.spyOn(daemon, "waitForInputTransientToClear").mockResolvedValue(true);
    vi.spyOn(daemon, "paneReadinessForDelivery").mockResolvedValue("busy");
    vi.spyOn(daemon, "probeBlockingDialog").mockResolvedValue({ state: "clear" } as any);
    vi.spyOn(daemon, "hasPositiveDeliveryInput").mockResolvedValue(true);
    daemon.pushChannelMessage("hello", { user: "u", user_id: "u", message_id: "m", chat_id: "chat", thread_id: "", ts: new Date().toISOString() });
    await vi.runAllTimersAsync();
    expect(gate).toHaveBeenCalled();                              // it went down the idle wait…
    expect(keys).not.toContain("M-m");                            // …and not the hand-off
  });
});

describe("the key reaches the pane", () => {
  it("a native pane host refuses Alt+M without sending anything", async () => {
    const mutate = vi.fn();
    const port: any = Object.create(RuntimePanePort.prototype);
    port.mutate = mutate;
    port.record = { pending: false };
    expect(await port.sendSpecialKey("M-m")).toBe(false);
    expect(mutate).not.toHaveBeenCalled();
    expect(port.lastInputWasNotSent()).toBe(true);
  });
});
