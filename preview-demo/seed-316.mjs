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
console.log("seed-316 cards", made.join(", "));
sched.db.close();
