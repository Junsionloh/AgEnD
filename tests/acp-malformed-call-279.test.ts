/**
 * AGEND-279: agy's own notice about a malformed tool call. After a background command finished, agy's model wrote its `reply` call as plain
 * text; agy told the model so ("Your previous response contained an improperly formatted function call … Retries remaining: 3") and the ACP
 * client got that as an `agent_message_chunk` with nothing else on it, then the retried call worked. The fixture is that update as captured
 * on the :8449 preview (tests/fixtures/acp/agy-malformed-call-update.json). It is a line in the block — never something the agent said, never a
 * bubble, never part of the reply AgEnD sends for an agent that used no tool, and no change to where a reply's block is anchored.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { chatStep } from "../src/log-steps.js";
import { IpcClient } from "../src/channel/ipc-bridge.js";
import { AcpAdapter } from "../src/adapters/acp/acp-adapter.js";
import { AcpRunner } from "../src/adapters/acp/acp-runner.js";
import { AcpStepStore } from "../src/adapters/acp/steps.js";
import { UpdateTranslator } from "../src/adapters/acp/translate.js";
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
  const profile = { ...AGY_PROFILE, supportedVersions: ["1.5.8"], args: () => [FAKE] };
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


const UPDATE = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "acp", "agy-malformed-call-update.json"), "utf8"));
const NOTICE: string = UPDATE.content.text;

describe("the translator tells agy's notice from what the agent said", () => {
  it("the captured update is a notice, with its words whole; the update itself carries no marker (only its words tell it apart)", () => {
    expect(Object.keys(UPDATE).sort()).toEqual(["content", "sessionUpdate"]);
    expect(new UpdateTranslator().translate(UPDATE)).toEqual([{ kind: "notice", code: "malformed_call", text: NOTICE }]);
  });
  it("ordinary text is a message — also text that merely mentions the words, or starts with a warning sign", () => {
    const t = new UpdateTranslator();
    const msg = (text: string) => t.translate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
    for (const text of ["OK", "⚠ the build is red", "I saw: Your previous response contained an improperly formatted function call — odd.", "A function call was improperly formatted"]) {
      expect(msg(text), text).toEqual([{ kind: "message", text }]);
    }
  });
  it("a notice that arrives in pieces stays one notice until it ends, and the text after it is a message again", () => {
    const t = new UpdateTranslator();
    const chunk = (text: string) => t.translate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
    const cut = NOTICE.indexOf("Please retry");
    expect([chunk(NOTICE.slice(0, cut)), chunk(NOTICE.slice(cut))]).toEqual([
      [{ kind: "notice", code: "malformed_call", text: NOTICE.slice(0, cut) }],
      [{ kind: "notice", code: "malformed_call", text: NOTICE.slice(cut), more: true }],
    ]);
    expect(chunk("Done.")).toEqual([{ kind: "message", text: "Done." }]);
  });
  it("an unfinished notice ends with any other kind of update", () => {
    const t = new UpdateTranslator();
    t.translate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: NOTICE.slice(0, 120) } });
    t.translate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } });
    expect(t.translate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Plain." } })).toEqual([{ kind: "message", text: "Plain." }]);
  });
});

describe("a notice cannot swallow what the agent says next", () => {
  const msg = (t: UpdateTranslator, text: string) => t.translate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
  const kinds = (events: Array<{ kind: string }>) => events.map((e) => e.kind);
  it("its closing count worded another way: agy's closing request still ends it, and the answer after it is said", () => {
    const t = new UpdateTranslator();
    const reworded = NOTICE.replace("Retries remaining: 3", "Retries left: 3");
    expect(kinds(msg(t, reworded))).toEqual(["notice"]);
    expect(msg(t, "OK")).toEqual([{ kind: "message", text: "OK" }]);
  });
  it("the answer in the very chunk that ends it: the notice up to its end, then the answer as a message", () => {
    const t = new UpdateTranslator();
    const events = msg(t, `${NOTICE}The command printed A.`);
    expect(events).toEqual([{ kind: "notice", code: "malformed_call", text: NOTICE }, { kind: "message", text: "The command printed A." }]);
    expect(msg(t, "More.")).toEqual([{ kind: "message", text: "More." }]);                     // and the notice is closed
  });
  it("a lone `Retries …` line after a chunk that ended at the request is the notice's; the text after that is said", () => {
    const t = new UpdateTranslator();
    const cut = NOTICE.indexOf("Retries remaining");
    expect(kinds(msg(t, NOTICE.slice(0, cut)))).toEqual(["notice"]);
    expect(msg(t, NOTICE.slice(cut))).toEqual([{ kind: "notice", code: "malformed_call", text: NOTICE.slice(cut), more: true }]);
    expect(msg(t, "Done.")).toEqual([{ kind: "message", text: "Done." }]);
    // …but a line that is not one is said, not taken
    const u = new UpdateTranslator();
    msg(u, NOTICE.slice(0, cut));
    expect(msg(u, "The answer.")).toEqual([{ kind: "message", text: "The answer." }]);
  });
  it("an ending that never comes: it takes at most 20 chunks, and after that what follows is said", () => {
    const t = new UpdateTranslator();
    msg(t, "Your previous response contained an improperly formatted function call: Malformed function call: ");
    const out = Array.from({ length: 30 }, (_, i) => kinds(msg(t, `piece ${i}\n`))[0]);
    expect(out.filter((k) => k === "notice")).toHaveLength(19);                                    // the opening chunk and these 19: 20
    expect(out.slice(19)).toEqual(Array(11).fill("message"));
  });
  it("…or 4000 characters", () => {
    const t = new UpdateTranslator();
    msg(t, "Your previous response contained an improperly formatted function call: " + "x".repeat(3000));
    expect(kinds(msg(t, "y".repeat(900)))).toEqual(["notice"]);                                    // 3.9K so far
    expect(msg(t, "z".repeat(900))).toEqual([{ kind: "message", text: "z".repeat(900) }]);          // would pass 4K: said
    expect(msg(t, "after")).toEqual([{ kind: "message", text: "after" }]);
  });
  it("the next prompt (reset) ends a notice that never ended", () => {
    const t = new UpdateTranslator();
    msg(t, NOTICE.slice(0, 200));
    t.reset();
    expect(msg(t, "The next turn's answer.")).toEqual([{ kind: "message", text: "The next turn's answer." }]);
  });
  it("a lone `Retries …` line is nothing special when no notice came before it", () => {
    const t = new UpdateTranslator();
    expect(msg(t, "Retries remaining: 3")).toEqual([{ kind: "message", text: "Retries remaining: 3" }]);
  });
});

describe("in the timeline: a line, not 'Said'; the reply's block stays anchored", () => {
  const WIRE = "[agend-human-id:hmsg-1111-aaaa]\ngo\n(message_id: web-m1 | verification_id: v)";
  function replay(parts: Array<Record<string, unknown>>) {
    const d = mkdtempSync(join(tmpdir(), "acp-malformed-")); dirs.push(d);
    let n = 1_000;
    const s = new AcpStepStore(d, () => (n += 10));
    s.beginTurn("T", "sleep 20; echo A", undefined, WIRE);
    for (const e of parts) s.apply(e as never);
    return s;
  }
  const events = [
    { kind: "tool", id: "c1", title: "sleep 20; echo A", toolKind: "execute", status: "completed", rawInput: { command: "sleep 20; echo A" }, rawOutput: "A" },
    ...new UpdateTranslator().translate(UPDATE),
    { kind: "tool", id: "c2", title: "mcp_agend_reply", toolKind: "other", status: "completed", rawInput: { text: "指令執行完成，輸出為：`A`" } },
  ];
  it("the notice is one state line named `malformed_call` with the CLI's words as its body; there is no assistant step", () => {
    const s = replay(events as never);
    const steps = s.snapshot(undefined, { thoughts: true }).steps;
    expect(steps.filter((x) => x.kind === "assistant")).toEqual([]);
    const notice = steps.filter((x) => x.kind === "state");
    expect(notice).toHaveLength(1);
    expect(notice[0]).toMatchObject({ note: "malformed_call", status: "done" });
    expect(notice[0]!.body).toContain("Retries remaining: 3");
  });
  it("in the chat's block it is a step between the tool and the reply (not 'Said'); the reply is still placed by id, and its bubble untouched", () => {
    const s = replay(events as never);
    s.anchorReply("指令執行完成，輸出為：`A`", "web-r1");
    s.apply({ kind: "turn_end", stopReason: "end_turn" });
    const steps = s.snapshot(undefined, { thoughts: true }).steps.map((x) => chatStep(x, "standard"));
    const rows = [
      { boot: "b", id: 1, role: "user", anchor: "web-m1", text: "sleep 20; echo A", ts: new Date(1_000).toISOString() },
      { boot: "b", id: 2, role: "agent", anchor: "web-r1", text: "指令執行完成，輸出為：`A`", ts: new Date(1_200).toISOString() },
    ];
    const { groups } = groupSteps(rows, steps, { now: 5_000 });
    expect(groups.map((g: any) => [g.level, g.rowKey])).toEqual([["id", "b-2"]]);
    expect(groups[0].items.map((x: any) => `${x.kind}:${x.note ?? x.cat ?? ""}`)).toEqual(["tool:run", "state:malformed_call"]);
  });
  it("ordinary text that begins alike stays what the agent said (a step of its own, not a notice)", () => {
    const s = replay([{ kind: "message", text: "Your previous response contained an improperly formatted function call? No — that was fine." }]);
    expect(s.snapshot(undefined, { thoughts: true }).steps.map((x) => x.kind)).toEqual(["user", "assistant"]);
  });
  it("the notice survives a restart as the same line", () => {
    const s = replay(events as never);
    const again = new AcpStepStore((s as unknown as { dir: string }).dir);
    expect(again.snapshot(undefined, { thoughts: true }).steps.filter((x) => x.kind === "state").map((x) => x.note)).toEqual(["malformed_call"]);
  });
});

describe("through the runner, with the notice worded or chunked another way", () => {
  for (const [mode, what] of [["#malformed-reworded", "its count line worded another way"], ["#malformed-joined", "the answer in the chunk that ends it"]]) {
    it(`${what}: the answer is still the agent's, and is sent as the reply`, async () => {
      const h = await boot();
      h.fleet.send({ type: "fleet_inbound", content: `go ${mode}`, meta: { chat_id: "chat-1", message_id: "msg-1", user: "alice", source: "web" } });
      await until(() => h.runner.getInstanceState() === "idle" && h.runner.steps.snapshot(undefined, { thoughts: true }).steps.some((s) => s.kind === "turn_end"), 6000, "the turn");
      await until(() => h.outbound.length === 1, 3000, "the proxy reply");
      expect(h.outbound[0].args.text).toBe("OK");
      const steps = h.runner.steps.snapshot(undefined, { thoughts: true }).steps;
      expect(steps.filter((s) => s.kind === "state").map((s) => s.note)).toEqual(["malformed_call"]);
      expect(steps.filter((s) => s.kind === "assistant").map((s) => s.body)).toEqual(["OK"]);
    });
  }
});

describe("through the runner, with the notice as agy sends it", () => {
  it("the agent's plain answer is sent as the reply — the notice is not part of it, no bubble is made of it, and the timeline has it as a line", async () => {
    const h = await boot();
    h.fleet.send({ type: "fleet_inbound", content: "go #malformed", meta: { chat_id: "chat-1", message_id: "msg-1", user: "alice", source: "web" } });
    await until(() => h.runner.getInstanceState() === "idle" && h.runner.steps.snapshot(undefined, { thoughts: true }).steps.some((s) => s.kind === "turn_end"), 6000, "the turn");
    await until(() => h.outbound.length === 1, 3000, "the proxy reply");
    expect(h.outbound[0].args.text).toBe("OK");                                                  // only what the agent said
    expect(JSON.stringify(h.outbound)).not.toContain("improperly formatted");
    const steps = h.runner.steps.snapshot(undefined, { thoughts: true }).steps;
    expect(steps.filter((s) => s.kind === "state").map((s) => s.note)).toEqual(["malformed_call"]);
    expect(steps.filter((s) => s.kind === "assistant").map((s) => [s.body, s.sent])).toEqual([["OK", true]]);
    expect(steps.find((s) => s.cat === "message")!.anchor).toMatchObject({ messageId: "web-r1" });
  });
});
