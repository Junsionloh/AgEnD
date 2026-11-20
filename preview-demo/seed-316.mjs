// Preview-only (AGEND-316): extra cards for the board's new look, after seed.mjs — a title of 100 characters, a long blocked
// reason, and a card with nothing but a title; written with the board's own code before the restart. Not product code.
import { Scheduler, DEFAULT_SCHEDULER_CONFIG } from "/app/dist/scheduler/index.js";
const NAMES = ["lead", "dev-a", "dev-b", "docs"];
const sched = new Scheduler("/data/scheduler.db", () => {}, DEFAULT_SCHEDULER_CONFIG, (n) => NAMES.includes(n));
const b = sched.db.board;
const PERSON = { kind: "person", name: "Demo Person" };
const inst = (name) => ({ kind: "instance", name });
const run = (what, fn) => { try { return fn(); } catch (e) { console.log(`seed ${what}: ${String(e && e.message || e).slice(0, 200)}`); } };
const made = b.createCards(PERSON, { project: "排行榜", cards: [
  { title: "重新設計每晚的排行榜重建流程，讓同分、延遲提交、跨區合併與賽季切換都能在同一次處理中完成並且不會漏算任何一位玩家的成績", assignee: "dev-a", priority: "urgent", size: "L" },
  { title: "修正賽季交接", assignee: "docs", priority: "high" },
  { title: "只有標題的卡片" },
  { title: "Rework the nightly leaderboard rebuild so that ties, late submissions and region merges are all handled".slice(0, 100), assignee: "lead", size: "M" },
] }).cards.map((c) => c.code);
run("block", () => { b.moveCard(inst("docs"), made[1], "claimed"); b.moveCard(inst("docs"), made[1], "blocked", { reason: "等遊戲團隊提供賽季日曆 — 這邊沒有人知道新賽季從哪一週開始，舊設計文件與商店頁面的日期也對不起來。" }); });
// A run of system lines on M-1 (after its comments), long enough to fold into "› N activities" on the card's page.
for (const patch of [{ goal: "玩家打完一場後一秒內看到本週名次" }, { scope: "做：排名規則、分數 API、頁面。不做：賽季排名" }, { context: "分數格式見 M-4；頁面沿用設定頁的樣式" }, { size: "L" }, { priority: "urgent" }, { size: "M" }]) run("m1 update", () => b.updateCard(PERSON, "M-1", patch));
// Round 7 — the stream of M-1 reads: [progress note] [comment] [comment] › 7 activities › [agent comment: heading, list, table,
// JSON, inline code, link] › 1 activity › [person comment: a Python block]. And a long log in a comment on M-2 (folded at 30 lines).
b.setCommentRouting({ instances: () => NAMES, enabled: () => true });
b.setProgressRouting({ enabled: () => true, leader: () => null });
const AGENT_MD = [
  "### 本週排行榜 API 的結果", "",
  "已用 `npm run build` 重建，細節見[設計筆記](https://example.com/leaderboard-notes)。", "",
  "- 同分同名次（已驗證）", "- 延遲提交保留到下一輪", "  - 跨區合併另開卡片", "",
  "| 步驟 | 結果 | 耗時 |", "| --- | :---: | ---: |", "| build | 通過 | 12 s |", "| 測試 | **2 項失敗** | 41 s |", "| 部署預覽 | 通過 | 8 s |", "",
  "回傳格式如下：", "",
  "```json",
  JSON.stringify({ week: "2026-W46", ranked: true, top: [{ rank: 1, player: "ann", score: 9120 }, { rank: 1, player: "bo", score: 9120 }], paging: { next: "cursor-2", limit: 50 }, note: null }, null, 2),
  "```",
].join("\n");
const PERSON_MD = ["了解，這是我想的排序寫法，請對照看看：", "", "```python", "def rank(rows):", "    # 同分同名次，名次跳號", "    rows = sorted(rows, key=lambda r: -r[\"score\"])", "    out, last, place = [], None, 0", "    for i, r in enumerate(rows, 1):", "        if r[\"score\"] != last:", "            place, last = i, r[\"score\"]", "        out.append({**r, \"rank\": place})", "    return out", "```", "", "不用照抄，**邏輯對得上**就好。"].join("\n");
run("m1 agent md", () => b.updateCard(inst("dev-a"), "M-1", { comment: AGENT_MD }));
run("m1 one update", () => b.updateCard(PERSON, "M-1", { priority: "high" }));
run("m1 person code", () => b.updateCard(PERSON, "M-1", { comment: PERSON_MD }));
const LONG_LOG = ["$ npm test -- --run leaderboard", ...Array.from({ length: 42 }, (_, i) => `  ✓ leaderboard › case ${String(i + 1).padStart(2, "0")} (${5 + ((i * 7) % 23)} ms)`), "Test Files  1 passed (1)", "     Tests  42 passed (42)"].join("\n");
run("m2 long", () => b.updateCard(inst("dev-b"), "M-2", { comment: "測試輸出如下：\n\n```text\n" + LONG_LOG + "\n```" }));
console.log("seed-316 cards", made.join(", "));
sched.db.close();
