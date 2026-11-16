/**
 * AGEND-279 (6): with `skipPermissions: false` an ACP agent's permission request is put to the chat as a card with buttons (Telegram and
 * Discord), answered only by the owning adapter's fleet admin, applied exactly like the dashboard's buttons, and retired when the request
 * is answered anywhere or lost with the turn. The real runner (with a fake agent) is joined to the real fleet's card path the way the
 * lifecycle joins them: `remote_card` → `postRemoteCard`, `remote_card_gone` → `retireRemoteCard`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcpAdapter } from "../src/adapters/acp/acp-adapter.js";
import { AcpRunner, permissionQuestion } from "../src/adapters/acp/acp-runner.js";
import { AGY_PROFILE } from "../src/adapters/acp/profiles.js";
import { IpcClient } from "../src/channel/ipc-bridge.js";
import { FleetManager } from "../src/fleet-manager.js";
import { setLocale } from "../src/locale.js";
import { remoteCardPrompt } from "../src/remote-card-prompt.js";
import type { InstanceConfig } from "../src/types.js";

const FAKE = join(import.meta.dirname, "fixtures", "acp", "fake-acp-agent.mjs");
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const dirs: string[] = [];
const runners: AcpRunner[] = [];
const clients: IpcClient[] = [];
const fleets: FleetManager[] = [];
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), "acpp-")); dirs.push(d); return d; };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 6000, what = "condition") => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(15); } };
beforeEach(() => setLocale("en"));
afterEach(async () => {
  for (const fm of fleets.splice(0)) { fm.retireRemoteCard("worker", null); (fm as any).stormWindow?.shutdown(); (fm as any).spawnGate?.shutdown(); }
  for (const c of clients.splice(0)) await c.close().catch(() => undefined);
  await Promise.all(runners.splice(0).map(r => r.stop().catch(() => undefined)));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

async function setup(type: "telegram" | "discord" | "web", config: Partial<InstanceConfig> = { skipPermissions: false }) {
  const dir = tmp(), state = tmp();
  vi.stubEnv("AGEND_HOME", dir);
  const fm = new FleetManager(dir) as any; fleets.push(fm);
  const adapterId = `${type}-owner`, chatId = "owned-group", threadId = "worker-topic";
  const channel = { id: adapterId, type, mode: "topic", group_id: chatId, bot_token_env: "DUMMY_TOKEN", access: { mode: "open", allowed_users: ["owner-admin"] } };
  const adapter = { id: adapterId, type,
    notifyAlert: vi.fn().mockResolvedValue({ messageId: "card-message", chatId, threadId }),
    sendText: vi.fn().mockResolvedValue({ messageId: "outcome", chatId, threadId }),
    editMessageRemoveButtons: vi.fn().mockResolvedValue(undefined) } as any;
  fm.fleetConfig = { defaults: {}, ...(type === "web" ? {} : { channels: [channel] }), instances: { worker: { topic_id: threadId, working_directory: dir } } };
  if (type !== "web") { fm.adapter = adapter; fm.worlds.set(adapterId, { id: adapterId, adapter, groupId: chatId, channelConfig: channel, accessManager: { isAllowed: () => true } }); }
  vi.spyOn(fm, "emitSseEvent").mockImplementation(() => {});

  const full = { working_directory: dir, backend: "antigravity", cli_adapter: "acp", ...config } as InstanceConfig;
  const holder: { runner?: AcpRunner } = {};
  const acp = new AcpAdapter({
    profile: { ...AGY_PROFILE, supportedVersions: ["1.5.8"], args: () => [FAKE] }, command: process.execPath, cwd: dir, instanceDir: dir, mcpServers: [], logger,
    env: { PATH: process.env.PATH }, childEnv: { FAKE_ACP_STATE: state, FAKE_ACP_VERSION: "1.5.8" },
    makeRunner: a => (holder.runner = new AcpRunner(a, { name: "worker", config: full, instanceDir: dir, topicMode: true, backend: "antigravity", logger })),
  });
  void acp;
  const runner = holder.runner!; runners.push(runner);
  const posted: any[] = [], gone: string[] = [];
  runner.on("remote_card", (d: any) => { posted.push(d.card); void fm.postRemoteCard("worker", d.card); });
  runner.on("remote_card_gone", (d: any) => { gone.push(d.identity); fm.retireRemoteCard("worker", d.identity); });
  fm.lifecycle.daemons.set("worker", runner);
  await runner.start();
  const ipc = new IpcClient(join(dir, "channel.sock")); clients.push(ipc); await ipc.connect();
  ipc.on("message", (m: any) => { if (m.type === "fleet_outbound") ipc.send({ type: "fleet_outbound_response", fleetRequestId: m.fleetRequestId, result: { messageId: "m1" } }); });
  const ask = (text = "#tool") => ipc.send({ type: "fleet_inbound", content: text, meta: { chat_id: "c", message_id: "m-1", user: "alice", source: "web" } });
  const prompt = () => fm.listWebPrompts()[0]!;
  const click = (action: string, userId = "owner-admin") => ({ callbackData: `card-answer:${prompt().nonce}:${action}`, chatId, threadId, messageId: "card-message", userId, username: userId, ack: vi.fn() });
  const dispatch = (data: ReturnType<typeof click>) => fm.dispatchAdapterCallback(data, adapterId, adapter);
  const pending = () => runner.steps.pendingPermissions();
  return { fm, runner, adapter, ask, prompt, click, dispatch, posted, gone, pending };
}

describe.each(["telegram", "discord"] as const)("a permission request on a %s fleet", type => {
  it("is posted as a card with Allow once / Deny / Cancel the turn, naming what the agent wants, and nothing is answered by itself", async () => {
    const h = await setup(type);
    h.ask();
    await until(() => h.adapter.notifyAlert.mock.calls.length === 1, 6000, "the card");
    const [chat, alert, opts] = h.adapter.notifyAlert.mock.calls[0];
    expect([chat, opts]).toEqual(["owned-group", { threadId: "worker-topic" }]);
    expect(alert.message).toContain("Permission request: ");
    expect(alert.message).toContain("Tap an answer below. Only a fleet admin's answer is taken.");
    expect(alert.message).not.toMatch(/terminal|View/);
    expect(alert.choices.map((c: any) => c.label)).toEqual(["1. Allow once", "2. Deny", "3. Cancel the turn"]);
    expect(h.pending()).toHaveLength(1);                      // still waiting
    expect(h.posted).toHaveLength(1);
    expect(h.posted[0]).toMatchObject({ kind: "question", webOnly: true, noSkip: true, acpPermission: true });
  });

  it("an admin's Allow answers the agent once and the card collapses to what happened; another click does nothing", async () => {
    const h = await setup(type);
    h.ask();
    await until(() => h.adapter.notifyAlert.mock.calls.length === 1);
    const click = h.click("opt-1");
    await h.dispatch(click);
    await until(() => h.pending().length === 0 && h.runner.getInstanceState() === "idle", 6000, "the turn to finish");
    const steps = h.runner.steps.snapshot(undefined, { thoughts: false }).steps;
    expect(steps.find(s => s.kind === "permission")).toMatchObject({ status: "done", note: "Yes" });   // the option the agent named, the one-shot allow
    expect(h.adapter.editMessageRemoveButtons).toHaveBeenCalled();
    expect(h.fm.listWebPrompts()).toEqual([]);
    await h.dispatch(click);
    expect(h.pending()).toHaveLength(0);
  }, 15000);

  it("Deny refuses the one request and Cancel the turn cancels it", async () => {
    for (const [action, expected] of [["opt-2", /^No$/], ["opt-3", /cancel/i]] as const) {
      const h = await setup(type);
      h.ask();
      await until(() => h.adapter.notifyAlert.mock.calls.length === 1);
      await h.dispatch(h.click(action));
      await until(() => h.pending().length === 0 && h.runner.getInstanceState() === "idle", 6000, "the turn to finish");
      const step = h.runner.steps.snapshot(undefined, { thoughts: false }).steps.find(s => s.kind === "permission")!;
      expect(`${step.note}`).toMatch(expected);
      expect(["done", "interrupted"]).toContain(step.status);
      await h.runner.stop(); runners.pop(); await clients.pop()!.close().catch(() => undefined);
    }
  }, 30000);

  it("only a fleet admin can answer: a member's click is refused and the request keeps waiting", async () => {
    const h = await setup(type);
    h.ask();
    await until(() => h.adapter.notifyAlert.mock.calls.length === 1);
    const denied = h.click("opt-1", "chat-member");
    await h.dispatch(denied);
    expect(denied.ack).toHaveBeenCalledWith(expect.stringContaining("admin"));
    expect(h.pending()).toHaveLength(1);
    expect(h.fm.listWebPrompts()).toHaveLength(1);
  });

  it("answered in the dashboard instead: the chat card is retired", async () => {
    const h = await setup(type);
    h.ask();
    await until(() => h.adapter.notifyAlert.mock.calls.length === 1);
    const requestId = h.pending()[0]!.stepId;
    expect(h.runner.answerPermissionByUser(requestId, "allow")).toBeNull();
    await until(() => h.gone.length === 1, 3000, "the card to be retired");
    expect(h.gone[0]).toBe(h.posted[0].identity);
    await until(() => h.fm.listWebPrompts().length === 0, 3000, "the buttons to collapse");
  }, 15000);
});

describe("a button for a request that is not waiting", () => {
  it("is stale: an unknown card, a card already answered, and anything but an option button change nothing", async () => {
    const h = await setup("telegram");
    expect(await h.runner.answerRemoteCard("acp-permission:nope", { kind: "option", n: 1 })).toEqual({ outcome: "stale" });
    h.ask();
    await until(() => h.posted.length === 1, 6000, "the card");
    const identity = h.posted[0].identity;
    expect(await h.runner.answerRemoteCard(identity, { kind: "skip" })).toMatchObject({ outcome: "refused" });
    expect(await h.runner.answerRemoteCard(identity, { kind: "option", n: 9 })).toMatchObject({ outcome: "refused" });
    expect(h.pending()).toHaveLength(1);
    expect(h.runner.answerPermissionByUser(h.pending()[0]!.stepId, "allow")).toBeNull();
    // answered elsewhere between the post and the click: the runner no longer has that request
    expect(await h.runner.answerRemoteCard(identity, { kind: "option", n: 1 })).toEqual({ outcome: "stale" });
  }, 15000);
});

describe("when no card should exist", () => {
  it("skipPermissions (the default) posts nothing: the agent's own tool calls are auto-approved", async () => {
    const h = await setup("telegram", { skipPermissions: undefined });
    h.ask();
    await until(() => h.runner.steps.snapshot(undefined, { thoughts: false }).steps.some(s => s.kind === "turn_end"), 6000, "the turn");
    expect(h.posted).toEqual([]);
    expect(h.adapter.notifyAlert).not.toHaveBeenCalled();
  }, 15000);
  it("a request that waits when the turn is cancelled retires its card", async () => {
    const h = await setup("telegram");
    h.ask();
    await until(() => h.adapter.notifyAlert.mock.calls.length === 1);
    await h.runner.adapter.cancel();
    await until(() => h.gone.length === 1, 6000, "the card to be retired");
  }, 15000);
});

describe("the card's text", () => {
  it("names the tool and the one thing it touches, clipped; never the whole input", () => {
    expect(permissionQuestion({ title: "run_command", rawInput: { command: "rm -rf build", env: { TOKEN: "s3cret" } } })).toBe("Permission request: run_command — rm -rf build");
    expect(permissionQuestion({ title: "Write file a.txt", rawInput: { path: "a.txt" } })).toBe("Permission request: Write file a.txt");
    expect(permissionQuestion({ title: "x".repeat(400) })).toHaveLength("Permission request: ".length + 160);
    expect(permissionQuestion(null)).toBe("Permission request: a tool");
    expect(permissionQuestion({ title: "t", rawInput: { command: "a\n\n   b" } })).toBe("Permission request: t — a b");
  });
  it("a secret is masked before the text is cut, so a token that straddles the cut is not left half showing", () => {
    const token = "sk-abcdefghijklmnopqrstuvwxyz0123456789";
    const text = permissionQuestion({ title: "run_command", rawInput: { command: `${"a".repeat(222)} ${token}` } });
    expect(text).not.toContain("sk-abc");                      // cut first, the 14 characters after `sk-` left would have been too few to be recognised
    expect(text).not.toContain(token);
  });
  it("a terminal card keeps its own closing line", () => {
    const card = { kind: "question", identity: "i", title: "Q", question: "q", page: "options", options: [{ n: 1, title: "Yes", recommended: false, description: null }], freeText: false, cursor: null, typed: null, rowWidth: 0, noSkip: true } as any;
    expect(remoteCardPrompt("w", card).message).toContain("keyed into the agent's terminal");
    expect(remoteCardPrompt("w", { ...card, acpPermission: true }).message).not.toContain("terminal");
  });
});
