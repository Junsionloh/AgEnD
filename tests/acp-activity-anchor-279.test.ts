/**
 * AGEND-279: where an ACP agent's work shows in the chat. The daemon sees the whole `session/update` stream and the fleet's
 * answer to every reply, so every reply's block is anchored to its bubble by the bubble's own message id (level `id`) — never
 * inferred from the words, the time or "the last reply of the turn" — and text AgEnD sent as a bubble is not shown a second
 * time inside the block. The fixture is the interjection scenario of the :8449 acceptance run (agy-acp).
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AcpStepStore } from "../src/adapters/acp/steps.js";
import { chatStep, type LogStep } from "../src/log-steps.js";
// @ts-expect-error — a JS module of the app, with no types
import { groupSteps } from "../src/ui/chat-activity-groups.js";

const FIXTURE = JSON.parse(readFileSync(join(__dirname, "fixtures/acp/agy-interject-timeline.json"), "utf8"));
const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

/** Feeds the fixture to a step store the way the runner does (events as they come; the fleet's answers after the call). */
function replay(order: "call-first" | "mcp-first" = "call-first", dir?: string) {
  const d = dir ?? mkdtempSync(join(tmpdir(), "acp-anchor-"));
  if (!dir) dirs.push(d);
  let t = 1_000;
  const s = new AcpStepStore(d, () => (t += 10));
  for (const turn of FIXTURE.turns) {
    s.beginTurn(turn.id, turn.text, undefined, turn.wire);
    const ev: any[] = turn.events;
    for (let i = 0; i < ev.length; i++) {
      const x = ev[i];
      // mcp-first: the fleet's answer to a reply arrives before the CLI's own update for the call.
      if (order === "mcp-first" && ev[i + 1]?.do === "mcp" && x.do === "event" && x.e.kind === "tool") { applyOne(s, ev[i + 1]); applyOne(s, x); i++; continue; }
      applyOne(s, x);
    }
  }
  return s;
}
function applyOne(s: AcpStepStore, x: any): void {
  if (x.do === "event") s.apply(x.e);
  else if (x.do === "user") s.addUserMessage(x.text);
  else if (x.do === "mcp") s.anchorReply(x.text, x.fleetAnswer.messageId);
  else if (x.do === "proxy") s.addProxyReply(x.text, x.fleetAnswer.messageId);
}
const rowsOf = () => FIXTURE.rows.map((r: any, i: number) => ({ boot: "b", id: i + 1, ts: new Date(1_000 + i * 100).toISOString(), ...r }));
const place = (s: AcpStepStore) => groupSteps(rowsOf(), s.snapshot(undefined, { thoughts: true }).steps.map(x => chatStep(x, "standard")), { now: 5_000, complete: true });
const rowOf = (g: any) => FIXTURE.rows[Number(g.rowKey.split("-")[1]) - 1].anchor;

describe("a turn's steps hang above the first reply after them, anchored by message id", () => {
  for (const order of ["call-first", "mcp-first"] as const) {
    it(`${order}: every block is placed by id, the work between replies above the reply it led to`, () => {
      const { groups, live } = place(replay(order));
      expect(live).toBeNull();
      // Nothing is placed by guesswork: every block was matched by a message id.
      expect(groups.map((g: any) => g.level)).toEqual(["id", "id", "id"]);
      expect(groups.map((g: any) => rowOf(g))).toEqual(["web-w3", "web-r4a", "web-r4b"]);
      // The command's step is above "Waiting for the command to finish." (the reply its own turn ended with).
      expect(groups[0].items.map((x: any) => `${x.kind}:${x.subject ?? x.tool ?? ""}`)).toEqual(["tool:sleep"]);
      // The thinking before the date reply is above the date reply; only what came after it is above the second reply.
      expect(groups[1].items.map((x: any) => x.kind)).toEqual(["thinking"]);
      expect(groups[2].items.map((x: any) => x.kind)).toEqual(["thinking", "tool"]);
    });
  }

  it("the text AgEnD sent as a bubble is not shown again as a step; the lone `.` was never one", () => {
    const { groups } = place(replay());
    const shown = groups.flatMap((g: any) => [...g.items, ...g.trailing]);
    expect(shown.filter((x: any) => x.kind === "assistant")).toEqual([]);
    const s = replay();
    const assistant = s.snapshot(undefined, { thoughts: true }).steps.filter(x => x.kind === "assistant");
    expect(assistant.map(x => [x.body, x.sent ?? false])).toEqual([["Waiting for the command to finish.", true], [".", false]]);
  });

  it("a restart keeps the ids, the replies' order and the `sent` mark", () => {
    const d = mkdtempSync(join(tmpdir(), "acp-anchor-"));
    dirs.push(d);
    const before = replay("call-first", d).snapshot(undefined, { thoughts: true }).steps.filter(x => x.kind !== "thinking");
    const after = new AcpStepStore(d).snapshot(undefined, { thoughts: true }).steps;
    expect(after.map((x: LogStep) => x.id).sort()).toEqual(before.map((x: LogStep) => x.id).sort());   // (a tool that was still running is written when it ends: its place among the others is not the point here)
    expect(after.filter((x: LogStep) => x.kind === "tool" && x.cat === "message").map((x: LogStep) => x.anchor?.messageId)).toEqual(["web-w3", "web-r4a", "web-r4b"]);
    expect(after.filter((x: LogStep) => x.sent).length).toBe(1);
  });
});

describe("the exact anchor, not the text, names the row", () => {
  it("an id that came before the call's own update is on the step as soon as it is announced (not only when the turn ends)", () => {
    const d = mkdtempSync(join(tmpdir(), "acp-anchor-")); dirs.push(d);
    const s = new AcpStepStore(d);
    s.beginTurn("T", "go", undefined, "[agend-human-id:hmsg-9999-cccc]\ngo\n(message_id: web-ug | verification_id: v)");
    s.anchorReply("hello", "web-k1");
    s.apply({ kind: "tool", id: "x1", title: "mcp_agend_reply", toolKind: "other", status: "completed", rawInput: { text: "hello" } });
    expect(s.snapshot(undefined, { thoughts: true }).steps.find(x => x.cat === "message")?.anchor).toEqual({ replyText: "hello", messageId: "web-k1" });
  });

  it("an id learned after later steps were written does not move the reply step behind them when the file is read back", () => {
    const d = mkdtempSync(join(tmpdir(), "acp-anchor-")); dirs.push(d);
    const s = new AcpStepStore(d);
    s.beginTurn("T", "go", undefined, "[agend-human-id:hmsg-9999-cccc]\ngo\n(message_id: web-ug | verification_id: v)");
    s.apply({ kind: "tool", id: "x1", title: "mcp_agend_reply", toolKind: "other", status: "completed", rawInput: { text: "hello" } });
    s.apply({ kind: "tool", id: "x2", title: "ls", toolKind: "execute", status: "completed", rawInput: { command: "ls" } });
    s.anchorReply("hello", "web-k1");                                      // the fleet's answer, after the next tool was already written
    const order = (st: AcpStepStore) => st.snapshot(undefined, { thoughts: true }).steps.map(x => x.id);
    expect(order(new AcpStepStore(d))).toEqual(order(s));
  });

  it("two replies that say the same thing each take their own row (what the text alone could not tell apart)", () => {
    const d = mkdtempSync(join(tmpdir(), "acp-anchor-")); dirs.push(d);
    let t = 1_000;
    const s = new AcpStepStore(d, () => (t += 10));
    s.beginTurn("T", "go", undefined, "[agend-human-id:hmsg-9999-cccc]\ngo\n(message_id: web-ug | verification_id: v)");
    s.apply({ kind: "thought", text: "one" });
    s.apply({ kind: "tool", id: "x1", title: "mcp_agend_reply", toolKind: "other", status: "completed", rawInput: { text: "ok" } });
    s.anchorReply("ok", "web-k1");
    s.apply({ kind: "thought", text: "two" });
    s.apply({ kind: "tool", id: "x2", title: "mcp_agend_reply", toolKind: "other", status: "completed", rawInput: { text: "ok" } });
    s.anchorReply("ok", "web-k2");
    s.apply({ kind: "turn_end", stopReason: "end_turn" });
    const ids = s.snapshot(undefined, { thoughts: true }).steps.filter(x => x.cat === "message").map(x => x.anchor?.messageId);
    expect(ids).toEqual(["web-k1", "web-k2"]);                                  // the second call is not given the first's id
  });

  it("a reply made between prompts (agy, once a command it left running finished) is matched when its update arrives with the next prompt", () => {
    const d = mkdtempSync(join(tmpdir(), "acp-anchor-")); dirs.push(d);
    const s = new AcpStepStore(d);
    s.beginTurn("T1", "go", undefined, "[agend-human-id:hmsg-9999-cccc]\ngo\n(message_id: web-u1 | verification_id: v)");
    s.apply({ kind: "message", text: "Waiting." });
    s.apply({ kind: "turn_end", stopReason: "end_turn" });
    s.anchorReply("The command finished: A", "web-late");                    // the fleet's answer: no prompt is running, nothing is announced yet
    s.beginTurn("T2", "and the date?", undefined, "[agend-human-id:hmsg-8888-dddc]\nand the date?\n(message_id: web-u2 | verification_id: v)");
    s.apply({ kind: "tool", id: "x1", title: "mcp_agend_reply", toolKind: "other", status: "completed", rawInput: { text: "The command finished: A" } });   // agy's updates, flushed with the new prompt
    s.apply({ kind: "tool", id: "x2", title: "mcp_agend_reply", toolKind: "other", status: "completed", rawInput: { text: "Today is the 17th." } });
    s.anchorReply("Today is the 17th.", "web-date");
    s.apply({ kind: "turn_end", stopReason: "end_turn" });
    const ids = s.snapshot(undefined, { thoughts: true }).steps.filter(x => x.cat === "message").map(x => [x.anchor?.replyText, x.anchor?.messageId]);
    expect(ids).toEqual([["The command finished: A", "web-late"], ["Today is the 17th.", "web-date"]]);
  });

  it("an id that no step claimed is never given to another turn's reply by order", () => {
    const d = mkdtempSync(join(tmpdir(), "acp-anchor-")); dirs.push(d);
    const s = new AcpStepStore(d);
    s.beginTurn("T1", "go", undefined, "[agend-human-id:hmsg-9999-cccc]\ngo\n(message_id: web-u1 | verification_id: v)");
    s.apply({ kind: "turn_end", stopReason: "end_turn" });
    s.anchorReply("never announced", "web-stray");
    s.beginTurn("T2", "next", undefined, "[agend-human-id:hmsg-8888-dddc]\nnext\n(message_id: web-u2 | verification_id: v)");
    s.apply({ kind: "tool", id: "x1", title: "mcp_agend_reply", toolKind: "other", status: "completed", rawInput: { text: "something else" } });
    s.apply({ kind: "turn_end", stopReason: "end_turn" });
    expect(s.snapshot(undefined, { thoughts: true }).steps.filter(x => x.cat === "message").map(x => x.anchor)).toEqual([{ replyText: "something else" }]);
  });

  it("a reply the CLI never announced as a tool call still gets a step of its own when the turn ends", () => {
    const d = mkdtempSync(join(tmpdir(), "acp-anchor-")); dirs.push(d);
    const s = new AcpStepStore(d);
    s.beginTurn("T", "go", undefined, "[agend-human-id:hmsg-9999-cccc]\ngo\n(message_id: web-ug | verification_id: v)");
    s.apply({ kind: "tool", id: "x1", title: "ls", toolKind: "execute", status: "completed", rawInput: { command: "ls" } });
    s.anchorReply("done", "web-k1");
    s.apply({ kind: "turn_end", stopReason: "end_turn" });
    const reply = s.snapshot(undefined, { thoughts: true }).steps.filter(x => x.cat === "message");
    expect(reply.map(x => x.anchor)).toEqual([{ replyText: "done", messageId: "web-k1" }]);
    const rows = [{ boot: "b", id: 1, role: "user", anchor: "web-ug", text: "go", ts: new Date(1000).toISOString() }, { boot: "b", id: 2, role: "agent", anchor: "web-k1", text: "done", ts: new Date(1100).toISOString() }];
    const { groups } = groupSteps(rows, s.snapshot(undefined, { thoughts: true }).steps, { now: 9_000_000 });
    expect(groups.map((g: any) => [g.level, g.rowKey])).toEqual([["id", "b-2"]]);
  });
});
