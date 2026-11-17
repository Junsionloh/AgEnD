/**
 * AGEND-279, the page: interjecting by key, and where a message that waits for the running turn is shown.
 *  • Ctrl+Enter / ⌘+Enter is an interjection while the agent works (Enter queues, as ever); the Interject button is the same on a phone; the
 *    page sends it as `steer: true` and the bubble — not a card — says "Interjection" and how it went.
 *  • A message that waits (`delivery: "queued"`) is at the bottom, below the work block and marked; once it was handed over it is where THAT
 *    happened (after the previous turn's last reply), not where it was typed.
 * The screenshot of the report is the fixture: "sleep 20; echo A" running, "測試" typed while it ran.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { installDom } from "./helpers/mini-dom.js";
// @ts-expect-error — a JS module of the app, with no types
import { composeRows, groupSteps, splitQueued } from "../src/ui/chat-activity-groups.js";

type Served = any;
let render: Served;
beforeAll(async () => {
  // @ts-expect-error — a JS module of the app, with no types
  await import("../src/ui/chat-render.js");
  render = (globalThis as any).AgendChatRender;
});
const read = (...p: string[]) => readFileSync(join(process.cwd(), "src", "ui", ...p), "utf8");

const T = (s: string) => new Date(`2026-11-17T01:${s}Z`).toISOString();
const row = (id: number, role: string, text: string, at: string, extra: Record<string, unknown> = {}) => ({ boot: "b", id, role, text, ts: T(at), sender: role === "user" ? "web-user" : "agy-acp", anchor: `a${id}`, ...extra });
const ids = (rows: Array<{ id: number }>) => rows.map((r) => r.id);

describe("a message that waits is at the bottom, below the running turn (the second screenshot)", () => {
  // 06:00 "sleep 20; echo A" · 06:50 "測試" typed while it ran (waiting) · 07:10 the turn's reply
  const waiting = row(2, "user", "測試", "06:50", { delivery: "queued", messageId: "web-2" });
  const rows = [row(1, "user", "sleep 20; echo A", "06:00", { delivery: "delivered" }), waiting, row(3, "agent", "指令執行完成", "07:10")];

  it("splitQueued takes it out of the thread and puts it last", () => {
    const { main, tail } = splitQueued(rows);
    expect([ids(main), ids(tail)]).toEqual([[1, 3], [2]]);
  });
  it("the running turn's block stays between its message and the reply, and the waiting message is below all of it", () => {
    const steps = [
      { id: "u", turn: "t1", ts: Date.parse(T("06:00")), kind: "user", anchor: { messageId: "a1" } },
      { id: "c", turn: "t1", ts: Date.parse(T("06:05")), kind: "tool", tool: "Bash", cat: "run", status: "running", subject: "sleep 20; echo A" },
    ];
    const { main, tail } = splitQueued([rows[0], waiting]);
    const composed = composeRows(main, groupSteps(main, steps, { now: Date.parse(T("06:55")), complete: true, busy: true })).concat(tail);
    expect(composed.map((r: any) => r.role === "activity" ? "activity" : r.text)).toEqual(["sleep 20; echo A", "activity", "測試"]);
  });
  it("without splitQueued the message sits right under the first one, above the block (what the screenshot showed)", () => {
    const steps = [{ id: "u", turn: "t1", ts: Date.parse(T("06:00")), kind: "user", anchor: { messageId: "a1" } }, { id: "c", turn: "t1", ts: Date.parse(T("06:05")), kind: "tool", tool: "Bash", cat: "run", status: "running" }];
    const composed = composeRows([rows[0], waiting], groupSteps([rows[0], waiting], steps, { now: Date.parse(T("06:55")), complete: true, busy: true }));
    expect(composed.map((r: any) => r.role === "activity" ? "activity" : r.text)).toEqual(["sleep 20; echo A", "測試", "activity"]);
  });
  it("several waiting messages keep their order; the page's own pending bubbles come after them", () => {
    const more = row(4, "user", "再一則", "06:55", { delivery: "queued" });
    const pending = { boot: "out", id: 9, role: "user", text: "typing", ts: T("06:58"), outgoing: { state: "sending" } };
    const { main, tail } = splitQueued([rows[0], waiting, more, row(5, "agent", "reply", "07:10"), pending]);
    expect([ids(main), ids(tail)]).toEqual([[1, 5], [2, 4, 9]]);
  });
  it("an interjection that was taken stays in its turn, even while its tick still says queued (a terminal agent's own steer)", () => {
    const steered = row(2, "user", "S", "06:50", { delivery: "queued", steer: "sent" });
    const refused = row(3, "user", "R", "06:51", { delivery: "queued", steer: "unsupported" });
    const { main, tail } = splitQueued([rows[0], steered, refused, row(4, "agent", "r", "07:10")]);
    expect([ids(main), ids(tail)]).toEqual([[1, 2, 4], [3]]);                    // `unsupported` was queued like any: it waits
  });
  it("only a person's queued message waits: an agent's row, or a message with another tick, stays", () => {
    const { main, tail } = splitQueued([row(1, "user", "a", "06:00", { delivery: "processing" }), row(2, "agent", "b", "06:01", { delivery: "queued" }), row(3, "user", "c", "06:02")]);
    expect([ids(main), tail.length]).toEqual([[1, 2, 3], 0]);
  });
});

describe("a message that waited is where it was handed over, not where it was typed", () => {
  // typed 06:50 while turn 1 ran; turn 1's last reply 07:10; handed to the agent 07:12
  const typed = row(2, "user", "測試", "06:50", { delivery: "processing", messageId: "web-2", sentAt: T("07:12") });
  const rows = [row(1, "user", "sleep 20; echo A", "06:00"), typed, row(3, "agent", "指令執行完成", "07:10"), row(4, "agent", "(more)", "07:11"), row(5, "agent", "later", "07:30")];
  it("it follows the previous turn's last reply", () => {
    expect(ids(splitQueued(rows).main)).toEqual([1, 3, 4, 2, 5]);
  });
  it("a message that never waited (no sentAt), or was handed over at once, does not move", () => {
    const direct = [row(1, "user", "a", "06:00"), row(2, "user", "b", "06:10", { sentAt: T("06:10") }), row(3, "agent", "c", "06:20")];
    expect(ids(splitQueued(direct).main)).toEqual([1, 2, 3]);
    expect(ids(splitQueued([row(1, "user", "a", "06:00", { sentAt: T("06:00") }), row(2, "agent", "b", "06:01")]).main)).toEqual([1, 2]);
  });
  it("handed over after everything: it goes last (before the pending bubbles)", () => {
    const late = row(1, "user", "q", "06:00", { sentAt: T("09:00") });
    const pending = { boot: "out", id: 9, role: "user", text: "x", ts: T("09:30"), outgoing: { state: "sending" } };
    const { main, tail } = splitQueued([late, row(2, "agent", "r", "07:00"), pending]);
    expect([ids(main), ids(tail)]).toEqual([[2, 1], [9]]);
  });
  it("the delivery report brings `sentAt` and `steer` to the row; a row's two copies keep the one that knows", () => {
    const list = [{ boot: "b", id: 1, messageId: "web-1", delivery: "queued", text: "x" }];
    const next = render.applyDelivery(list, "web-1", "processing", { sentAt: T("07:12"), steer: "interrupted" });
    expect(next[0]).toMatchObject({ delivery: "processing", sentAt: T("07:12"), steer: "interrupted" });
    expect(render.applyDelivery(next, "web-1", "processing", { sentAt: T("07:12"), steer: "interrupted" })).toBe(next);      // nothing new: the same list
    const merged = render.mergeMessages([{ boot: "b", id: 1, text: "x", delivery: "queued" }], [{ boot: "b", id: 1, text: "x", delivery: "processing", sentAt: T("07:12"), steer: "added" }]);
    expect(merged[0]).toMatchObject({ delivery: "processing", sentAt: T("07:12"), steer: "added" });
  });
});

describe("the bubble's marks (no card)", () => {
  let thread: Served, i18n: Served;
  async function draw(rows: unknown[], lang = "en") {
    const base = installDom({ storage: { agend_tour_done: "1" } });
    try {
      thread = await import("/ui/js/chat-thread.js");
      await import("/ui/js/chat-strings.js");
      i18n = await import("/assets/app-i18n.js");
      i18n.setLang(lang);
      const list = base.document.createElement("div"), scroller = base.document.createElement("div");
      const tr = (k: string, ...a: unknown[]) => i18n.t(k, ...a);
      const th = thread.createThread(list, scroller, { t: tr, tf: tr, isUser: (x: any) => x.role === "user", onJump() {}, onEmpty() {}, setPreviewOptIn() {}, copyText: async () => true, download() {}, toggleWrap() {} });
      th.render(rows);
      return [...list.querySelectorAll(".msg")].map((m: any) => ({ marks: [...m.querySelectorAll(".steer-mark,.queue-mark")].map((e: any) => `${e.className}|${e.textContent}`) }));
    } finally { i18n?.setLang("en"); base.restore(); }
  }
  it.each([
    ["added", "steer-mark steer-added|Interjection · added to this turn"],
    ["interrupted", "steer-mark steer-interrupted|Interjection · turn stopped, sent next"],
    ["sent", "steer-mark steer-sent|Interjection · sent into the running turn"],
    ["unsupported", "steer-mark steer-unsupported|Interjection · this agent does not take interjections, queued"],
    ["refused", "steer-mark steer-refused|Interjection · refused, sent as the next message"],
  ])("a message that asked to interject: %s", async (steer, mark) => {
    const out = await draw([row(1, "user", "hi", "06:00", { steer, delivery: "processing" })]);
    expect(out[0]!.marks).toEqual([mark]);
  });
  it("a message waiting for the running turn says when it goes", async () => {
    const out = await draw([row(1, "user", "hi", "06:00", { delivery: "queued" })]);
    expect(out[0]!.marks).toEqual(["queue-mark|Queued · sent when this turn ends"]);
  });
  it("in Chinese too", async () => {
    const out = await draw([row(1, "user", "hi", "06:00", { steer: "added" }), row(2, "user", "hi", "06:01", { delivery: "queued" })], "zh-TW");
    expect(out.map((o) => o.marks)).toEqual([["steer-mark steer-added|插話 · 已加進這一輪"], ["queue-mark|排隊中・這一輪結束後送出"]]);
  });
  it("an interjection that was taken is not also labelled as waiting", async () => {
    const out = await draw([row(1, "user", "hi", "06:00", { steer: "sent", delivery: "queued" }), row(2, "user", "hi", "06:01", { steer: "unsupported", delivery: "queued" })]);
    expect(out.map((o) => o.marks)).toEqual([["steer-mark steer-sent|Interjection · sent into the running turn"], ["steer-mark steer-unsupported|Interjection · this agent does not take interjections, queued", "queue-mark|Queued · sent when this turn ends"]]);
  });
  it("an ordinary message, and an agent's row, carry no mark", async () => {
    const out = await draw([row(1, "user", "hi", "06:00", { delivery: "delivered" }), row(2, "agent", "yo", "06:01", { steer: "added", delivery: "queued" })]);
    expect(out.map((o) => o.marks)).toEqual([[], []]);
  });
  it("a bubble this page is still sending is already tagged when it was sent as an interjection", async () => {
    const pending = { boot: "out", id: 1, role: "user", sender: "You", text: "now", ts: T("06:00"), clientId: "c1c1c1c1", outgoing: { state: "sending" }, files: [], steerAsked: true };
    const out = await draw([pending]);
    expect(out[0]!.marks).toEqual(["steer-mark|Interjection"]);
  });
});

describe("the page sends `steer: true`, and says it only when something went another way", () => {
  async function storeWith(answer: Record<string, unknown>) {
    const store = await import("/ui/js/chat-store.js");
    await import("/ui/js/chat-strings.js");
    const { t } = await import("/assets/app-i18n.js");
    const calls: any[] = [], toasts: string[] = [];
    const fetchFn = async (path: string, o: any = {}) => { calls.push({ path, body: typeof o.body === "string" ? JSON.parse(o.body) : o.body }); return { ok: true, status: 200, json: async () => (path === "/ui/send" ? answer : {}) }; };
    const s = store.createChatStore({ fetch: fetchFn, toast: (m: string) => { toasts.push(m); }, announce: () => {}, t, setTimeout: () => 0 });
    s.setCurrent("w");
    return { s, calls, toasts };
  }
  const sent = (calls: any[]) => calls.filter((c) => c.path === "/ui/send").map((c) => c.body);
  it("with the flag the request carries it; without, it does not", async () => {
    const { s, calls } = await storeWith({ sent: true, messageId: "web-1" });
    s.setDraft("w", "queue me"); await s.send("w");
    s.setDraft("w", "interject"); await s.send("w", { steer: true });
    expect(sent(calls).map((b) => [b.message, b.steer])).toEqual([["queue me", undefined], ["interject", true]]);
  });
  it("an answer that says it went as asked adds no line; one that says the turn was stopped, or that the agent cannot, adds one", async () => {
    for (const [steer, line] of [["added", null], ["sent", null], ["interrupted", /turn was stopped/], ["unsupported", /does not take interjections/]] as const) {
      const { s, toasts } = await storeWith({ sent: true, messageId: "web-1", steer });
      s.setDraft("w", "x"); await s.send("w", { steer: true });
      if (line) expect(toasts.join("|"), steer).toMatch(line); else expect(toasts, steer).toEqual([]);
    }
  });
});

describe("the composer", () => {
  const panel = read("panel-chat.js");
  it("Enter queues (a plain send) and Ctrl+Enter / ⌘+Enter interjects while the agent works, sends plainly when it does not", () => {
    expect(panel).toContain('const key = R().composerKey(e, { touch: touchScreen(), steer: true });');
    expect(panel).toContain('if (key === "send") { e.preventDefault(); submit(); }');
    expect(panel).toContain('else if (key === "steer") { e.preventDefault(); submit(busy && !guest ? { steer: true } : {}); }');   // a guest's Ctrl+Enter is a plain send
    expect(panel).toContain("store.send(name, o.steer ? { steer: true } : undefined);");
  });
  it("`/steer text` goes the same way: its result is the bubble's mark, not a card", () => {
    expect(panel).toContain('if (cmd && cmd.command === "steer" && cmd.args && !guest) { store.setDraft(name, cmd.args); store.send(name, { steer: true }); return; }');
  });
  it("there is no Interject button; the hint under the box says what the keys do", () => {
    expect(panel).toContain("composerHint(inst, R().isBusy(exec))");
    expect(panel).not.toContain("btn-steer");
    expect(read("shared", "chat-composer.js")).not.toContain("btn-steer");
    expect(read("shared", "app.css")).not.toContain(".btn-steer");
  });
  it("the hint's words, in both languages, name the key that interjects", async () => {
    const strings = await import("/ui/js/chat-strings.js");
    void strings;
    const { t, setLang } = await import("/assets/app-i18n.js");
    setLang("en");
    expect(t("chat.composerHintBusy", "Ctrl")).toBe("Enter queues · Ctrl+Enter interjects · Shift+Enter for a new line");
    setLang("zh-TW");
    expect(t("chat.composerHintBusy", "⌘")).toBe("Enter 排隊 · ⌘+Enter 插話 · Shift+Enter 換行");
    setLang("en");
  });
});
