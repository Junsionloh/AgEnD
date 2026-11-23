/**
 * AGEND-342: an agent's comment sometimes shows its steps run together ("1) … ; 2) … ; 3) …" in one paragraph), not every time.
 *
 * What the evidence says (real-agent run on the preview, claude-dev, 2026-11-23): nothing in AgEnD takes a newline out. One comment of the
 * same agent, the same hour, had 4 newlines in what it sent, in the database and on the page, where it is a numbered list; the one in the
 * screenshot had none in what the agent SENT (its tool call, the stored text and the page agree). The page draws a single newline as a
 * line break and a step per line as a list; a text with no newline in it has nothing to break. So the difference is the agent's own text,
 * and the only thing that told it how to write a comment was "A comment on the card (update/move)". Now the field, the tool's description
 * and the CLI's instructions say, in a few words, what a comment is: Markdown, a list item or step per line, long text in paragraphs.
 *
 * This file: (1) newlines survive the way in — the tool's two doors, `update` and `move`, the store, `task get`; (2) the renderer turns
 * those lines into lines (the page itself is tests/task-board-card-316.test.ts "AGEND-342"); (3) the rule is in the three places an agent
 * reads, and short.
 */
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import vm from "node:vm";
import type { SchedulerDb } from "../src/scheduler/db.js";
import { Scheduler } from "../src/scheduler/index.js";
import { FleetManager } from "../src/fleet-manager.js";
import type { Actor } from "../src/scheduler/task-board.js";
import { TaskBoardArgs } from "../src/outbound-schemas.js";
import { TOOLS } from "../src/channel/mcp-tools.js";
import { withoutTaskCommands } from "../src/dashboard-permissions.js";

const ANN: Actor = { kind: "person", name: "Ann" };
const STEPS = "做法：\n1) 用 task get 讀完整張卡\n2) 用 task update 留一句進度\n3) 逐項勾選驗收";
const dirs: string[] = [];
const dbs: SchedulerDb[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) { try { db.close(); } catch { /* closed */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function fleet() {
  const d = mkdtempSync(join(tmpdir(), "task-comment-format-")); dirs.push(d);
  writeFileSync(join(d, "fleet.yaml"), "defaults: {}\ninstances: {}\n");
  const fm = new FleetManager(d);
  const scheduler = new Scheduler(join(d, "scheduler.db"), () => {}, { max_schedules: 100, default_timezone: "UTC", retry_count: 3, retry_interval_ms: 1000 }, () => false);
  (fm as unknown as Record<string, unknown>).scheduler = scheduler;
  dbs.push(scheduler.db);
  return { db: scheduler.db, call: (instance: string, args: Record<string, unknown>) => fm.handleTaskCrudHttp(instance, args) };
}
const textOf = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));

describe("the lines go in as they were written", () => {
  it("`update` with a comment: stored exactly, and `task get` hands it back with its lines", async () => {
    const { db, call } = fleet();
    db.board.createCards(ANN, { cards: [{ title: "Mine", assignee: "dev-a" }] });
    expect(textOf(await call("dev-a", { action: "update", id: "M-1", comment: STEPS }))).toContain("ok M-1");
    const stored = db.board.detail("M-1").comments;
    expect(stored.map((c) => c.text)).toEqual([STEPS]);
    expect(stored[0]!.text.split("\n")).toHaveLength(4);
    const read = textOf(await call("lead", { action: "get", id: "M-1", detail: true }));
    expect(read).toContain(`: ${STEPS}`);                  // the comment, with its four lines, after "<author> <time>:"
    expect(read.split("\n").filter((l) => /^[123]\) /.test(l)).length).toBe(3);
  });
  it("`move` with a comment: the same", async () => {
    const { db, call } = fleet();
    db.board.createCards(ANN, { cards: [{ title: "Mine", assignee: "dev-a" }] });
    expect(textOf(await call("dev-a", { action: "move", id: "M-1", to: "claimed", comment: STEPS }))).toContain("ok M-1");
    expect(db.board.detail("M-1").comments.map((c) => c.text)).toEqual([STEPS]);
  });
  it("counter-evidence: the notice that quotes a comment is one line by design (it is a quote, not the comment); the comment itself is untouched", async () => {
    const { db } = fleet();
    db.board.createCards(ANN, { cards: [{ title: "Mine", assignee: "dev-a" }] });
    db.board.updateCard(ANN, "M-1", { comment: STEPS });
    expect(db.board.detail("M-1").comments[0]!.text).toBe(STEPS);
    const { oneLine } = await import("../src/scheduler/task-board-text.js");
    expect(oneLine(STEPS, 160)).toBe("做法： 1) 用 task get 讀完整張卡 2) 用 task update 留一句進度 3) 逐項勾選驗收");
  });
});

describe("the page's renderer draws those lines as lines", () => {
  // The chat's own renderer, which the card page uses for a comment (fleet-task-activity.js `commentHtml`).
  const ctx: Record<string, any> = { navigator: {}, window: {} };
  ctx.globalThis = ctx; vm.createContext(ctx);
  vm.runInContext(readFileSync(new URL("../src/ui/shared/chat-render.js", import.meta.url), "utf8"), ctx);
  const md = (text: string): string => (ctx.AgendChatRender ?? ctx.window.AgendChatRender).renderMarkdown(text);
  it("a step per line is a numbered list; single newlines are line breaks; blank lines are paragraphs", () => {
    expect(md(STEPS)).toBe("<p>做法：</p><ol><li>用 task get 讀完整張卡</li><li>用 task update 留一句進度</li><li>逐項勾選驗收</li></ol>");
    expect(md("步驟一：讀卡\n步驟二：寫進度\n步驟三：交回")).toBe("<p>步驟一：讀卡<br>步驟二：寫進度<br>步驟三：交回</p>");
    expect(md("步驟一\n\n步驟二")).toBe("<p>步驟一</p><p>步驟二</p>");
    expect(md("- a\n- b\n- c")).toBe("<ul><li>a</li><li>b</li><li>c</li></ul>");
  });
  it("counter-evidence: the same steps with no newline in them are one paragraph — the screenshot — whatever the renderer does", () => {
    expect(md("做法：1) 用 task get 讀完整張卡；2) 用 task update 留一句進度；3) 逐項勾選驗收")).toBe("<p>做法：1) 用 task get 讀完整張卡；2) 用 task update 留一句進度；3) 逐項勾選驗收</p>");
  });
});

describe("the rule is where an agent reads it, and short", () => {
  const RULE = "one list item or step per line";
  const fieldText = (TaskBoardArgs.shape.comment as { description?: string }).description ?? "";
  const toolText = TOOLS.find((t) => t.name === "task")!.description;
  const cli = readFileSync(new URL("../src/agent-cli-instructions.md", import.meta.url), "utf8");
  it("the comment field, the tool's description and the CLI's instructions say a comment is Markdown with a step per line", () => {
    expect(fieldText).toBe("A comment on the card (update/move). Markdown: one list item or step per line, long text in paragraphs");
    expect(toolText).toContain(`a comment is Markdown: ${RULE}, long text in paragraphs`);
    expect(cli).toMatch(new RegExp(`^agend-agent task comment M-3 "text" \\[--version N\\]\\s+# Comment on a card \\(Markdown: ${RULE}\\); @<instance> in it wakes that instance$`, "m"));
  });
  it("every place adds one clause, not a paragraph: this text goes into every agent's prompt", () => {
    const added = (s: string) => s.length;
    expect(added("Markdown: one list item or step per line, long text in paragraphs")).toBeLessThan(80);
    expect(fieldText.length).toBeLessThan(120);
  });
  it("with the task board off the CLI line leaves with the other task commands, as before", () => {
    expect(withoutTaskCommands(cli)).not.toContain("task comment");
  });
});
