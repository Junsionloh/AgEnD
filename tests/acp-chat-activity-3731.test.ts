/**
 * #3731 on the alpha line: an ACP instance's live steps feed the chat's activity timeline (#3648) — the same grouping the
 * transcript backends use, with nothing ACP-specific in the page: the user step and the `reply` call carry the same anchors a
 * transcript's do, thinking is the `thinking` kind, and a waiting permission request is a step of the block.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AcpStepStore } from "../src/adapters/acp/steps.js";
import { chatStep } from "../src/log-steps.js";
// @ts-expect-error — a JS module of the app, with no types
import { groupSteps, isReplyStep } from "../src/ui/chat-activity-groups.js";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
const store = () => { const d = mkdtempSync(join(tmpdir(), "acp-chat-")); dirs.push(d); let t = 1_000; return new AcpStepStore(d, () => (t += 10)); };

const WIRE = "[agend-human-id:hmsg-1111-aaaa]\nhello\n(message_id: web-m1 | verification_id: v1)";
const replyCall = (rawOutput?: unknown, status: "in_progress" | "completed" = "completed") =>
  ({ kind: "tool" as const, id: "c2", title: "agend__reply", toolKind: "other", status, rawInput: { variant: "UseTool", tool_name: "agend__reply", tool_input: { text: "Hi there" } }, ...(rawOutput !== undefined ? { rawOutput } : {}) });

describe("an ACP turn in the chat's timeline", () => {
  it("the user step carries the ids written into the prompt, though its body is what the person typed", () => {
    const s = store();
    s.beginTurn("1", "hello", undefined, WIRE);
    const user = s.snapshot(undefined, { thoughts: true }).steps[0];
    expect(user.anchor).toEqual({ messageId: "web-m1", humanId: "hmsg-1111-aaaa" });
    expect(user.body).toBe("hello");
  });

  it("the reply call is AgEnD's reply by name and anchor, whatever the CLI calls it, and learns its message id from the result", () => {
    for (const title of ["agend__reply", "mcp_agend_reply", "Run mcp_agend_reply"]) {
      const s = store();
      s.beginTurn("1", "hello", undefined, WIRE);
      s.apply({ kind: "tool", id: "c2", title, toolKind: "other", status: "completed", rawInput: { text: "Hi there" }, rawOutput: '{"chatId":"web","messageId":"web-r1"}' });
      const call = s.snapshot(undefined, { thoughts: true }).steps.find(x => x.kind === "tool")!;
      expect(isReplyStep(call)).toBe(true);
      expect(call.anchor).toEqual({ replyText: "Hi there", messageId: "web-r1" });
    }
  });

  it("grok's MCP result nests the reply's message id in output.OkayOutput; it still anchors the call by id", () => {
    const s = store();
    s.beginTurn("1", "hello", undefined, WIRE);
    s.apply({ kind: "tool", id: "c2", title: "agend__reply", toolKind: "other", status: "completed",
      rawInput: { variant: "UseTool", tool_name: "agend__reply", tool_input: { text: "OK", reply_to: "web-m1" } },
      rawOutput: { type: "MCP", tool_name: "reply", server_name: "agend", output: { OkayOutput: "{\"chatId\":\"web\",\"messageId\":\"web-r9\"}" } } });
    const call = s.snapshot(undefined, { thoughts: true }).steps.find(x => x.kind === "tool")!;
    expect(call.anchor).toEqual({ replyText: "OK", messageId: "web-r9" });
  });

  it("another server's reply-looking tool is not taken for AgEnD's", () => {
    const s = store();
    s.beginTurn("1", "hello", undefined, WIRE);
    s.apply({ kind: "tool", id: "c2", title: "other__reply", toolKind: "other", status: "completed", rawInput: { text: "x" } });
    expect(isReplyStep(s.snapshot(undefined, { thoughts: true }).steps.find(x => x.kind === "tool")!)).toBe(false);
  });

  it("thinking, a tool and the reply group above the reply's row by its id; the tool is cut to `standard` like any backend's", () => {
    const s = store();
    s.beginTurn("1", "hello", undefined, WIRE);
    s.apply({ kind: "thought", text: "Let me look." });
    s.apply({ kind: "tool", id: "c1", title: "ls", toolKind: "execute", status: "completed", rawInput: { command: "ls -la /secret" }, rawOutput: "files" });
    s.apply(replyCall('{"chatId":"web","messageId":"web-r1"}'));
    s.apply({ kind: "turn_end", stopReason: "end_turn" });
    const steps = s.snapshot(undefined, { thoughts: true }).steps.map(x => chatStep(x, "standard"));
    const rows = [
      { boot: "b", id: 1, role: "user", anchor: "web-m1", text: "hello", ts: new Date(1_000).toISOString() },
      { boot: "b", id: 2, role: "agent", anchor: "web-r1", text: "Hi there", ts: new Date(1_100).toISOString() },
    ];
    const { groups } = groupSteps(rows, steps, { now: 1_200 });
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ rowKey: "b-2", level: "id" });
    expect(groups[0].items.map((x: any) => x.kind)).toEqual(["thinking", "tool"]);
    const tool = groups[0].items.find((x: any) => x.kind === "tool");
    expect(tool.input).toBeUndefined();            // `standard` never sends the arguments or the output
    expect(tool.body).toBeUndefined();
  });

  it("a waiting permission request is a step of the live block, with its buttons' options", () => {
    const s = store();
    s.beginTurn("1", "hello", undefined, WIRE);
    s.apply({ kind: "permission", requestId: "7", tool: { title: "agend__send_to_instance", kind: "other", rawInput: { x: 1 } },
      options: [{ id: "once", name: "allow once", kind: "allow_once" }, { id: "no", name: "reject once", kind: "reject_once" }, { id: "always", name: "always", kind: "allow_always" }] });
    const steps = s.snapshot(undefined, { thoughts: false }).steps.map(x => chatStep(x, "standard"));
    const rows = [{ boot: "b", id: 1, role: "user", anchor: "web-m1", text: "hello", ts: new Date(1_000).toISOString() }];
    const { live } = groupSteps(rows, steps, { now: 1_100 });
    const perm = live.items.find((x: any) => x.kind === "permission");
    expect(perm).toBeDefined();
    expect(perm.status).toBe("running");
    expect(perm.options.map((o: any) => o.kind)).toEqual(["allow_once", "reject_once"]);   // never an *_always choice
  });

  it("a request AgEnD's own policy answered is left out of the block; one a person has to answer is not", () => {
    const s = store();
    s.beginTurn("1", "hello", undefined, WIRE);
    const opts = [{ id: "once", name: "allow once", kind: "allow_once" as const }, { id: "no", name: "reject once", kind: "reject_once" as const }];
    s.apply({ kind: "permission", requestId: "1", tool: { title: "agend__reply", kind: "other" }, options: opts });
    s.resolvePermission("1", "allow once (agend tool)", true);
    s.apply({ kind: "permission", requestId: "2", tool: { title: "Bash rm x", kind: "execute" }, options: opts });
    const steps = s.snapshot(undefined, { thoughts: false }).steps;
    expect(steps.filter(x => x.kind === "permission").map(x => x.auto === true)).toEqual([true, false]);
    const rows = [{ boot: "b", id: 1, role: "user", anchor: "web-m1", text: "hello", ts: new Date(1_000).toISOString() }];
    const { live } = groupSteps(rows, steps, { now: 1_100 });
    expect(live.items.filter((x: any) => x.kind === "permission")).toHaveLength(1);
    expect(live.items.find((x: any) => x.kind === "permission").auto).toBeUndefined();
  });
});
