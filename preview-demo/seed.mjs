// Preview-only demo data for AGEND-305: written with the board's own code (dist/scheduler), run inside the preview container
// before the fleet is restarted, so nothing wakes while it is written. Not part of the repository.
import { Scheduler, DEFAULT_SCHEDULER_CONFIG } from "/app/dist/scheduler/index.js";

const NAMES = ["lead", "dev-a", "dev-b", "docs"];
const sched = new Scheduler("/data/scheduler.db", () => {}, DEFAULT_SCHEDULER_CONFIG, (n) => NAMES.includes(n));
const b = sched.db.board;
b.setCommentRouting({ instances: () => NAMES, enabled: () => true });
b.setProgressRouting({ enabled: () => true, leader: () => null });

const PERSON = { kind: "person", name: "Demo Person" };
const inst = (name) => ({ kind: "instance", name });
const run = (what, fn) => { try { return fn(); } catch (e) { console.log(`seed ${what}: ${String(e && e.message || e).slice(0, 200)}`); } };

const lb = b.createProject(PERSON, { name: "排行榜", description: "每週與每季排行榜", leadInstance: "lead" });
const bill = b.createProject(PERSON, { name: "帳務", description: "發票與對帳" });

const made = b.createCards(PERSON, { project: lb.name, cards: [
  { title: "提供每週排行榜", assignee: "dev-a", priority: "high", size: "M", dispatcher: inst("lead"),
    goal: "玩家打完一場後一秒內就能看到本週名次。",
    scope: "做：排名規則、分數 API、頁面。不做：賽季排名。",
    acceptance: ["同分同名次", "頁面 300 ms 內回應", "只算排位賽", "舊分數保留"],
    context: "分數格式見 M-4。" },
  { title: "新增商店", assignee: "dev-b", priority: "normal", size: "L", goal: "玩家可以用金幣買徽章。" },
  { title: "挑選徽章", assignee: "dev-b", priority: "urgent", goal: "選定本季徽章圖樣。", acceptance: ["比較三個方案"] },   // handed out by the person: it waits for them (Needs you)
  { title: "建立分數儲存", assignee: "dev-a", priority: "low", size: "S" },
  { title: "調整防作弊規則", assignee: "docs", priority: "high", dispatcher: inst("lead") },
  { title: "撰寫賽季規則", assignee: "dev-b", priority: "urgent", size: "S", dispatcher: inst("lead"), needsReview: false,
    goal: "把賽季規則寫成一頁，讓玩家看得懂。", acceptance: ["規則一頁以內", "附兩個例子"] },
  { title: "封存上一季", assignee: "dev-a", priority: "low" },
] }).cards;
const [m1, m2, m3, m4, m5, m6, m7] = made.map((c) => c.code);
console.log("main tasks", m1, m2, m3, m4, m5, m6, m7);

b.createCards(PERSON, { parent: m1, cards: [
  { title: "訂定排名規則", assignee: "dev-a" },
  { title: "建立分數 API", assignee: "dev-a", dependsOn: ["#1"], acceptance: ["GET /scores/weekly", "分頁"] },
  { title: "排行榜頁面", assignee: "docs", dependsOn: ["#2"] },
] });
b.createCards(PERSON, { parent: m2, cards: [{ title: "價目表", assignee: "dev-b" }, { title: "結帳流程", assignee: "dev-b" }] });
b.createCards(PERSON, { project: bill.name, cards: [
  { title: "對 10 月發票", assignee: "dev-b", priority: "high", dispatcher: inst("lead") },
  { title: "逾期提醒信", priority: "normal" },
] });
b.createCards(inst("dev-a"), { cards: [{ title: "檢查夜間索引工作", assignee: "dev-a" }] });

// The board's life: agents claim, work and log; the person comments; one card waits for the person, one is blocked, one is
// finished, one cancelled, one is in progress for the person to finish (M-6).
run("m4 done", () => { b.moveCard(inst("dev-a"), m4, "claimed"); b.moveCard(inst("dev-a"), m4, "review", { result: "ok" }); b.moveCard(PERSON, m4, "done"); });
run("s1 claim", () => b.moveCard(inst("dev-a"), "S-1", "claimed"));
run("s1 done", () => b.moveCard(inst("dev-a"), "S-1", "done", { result: "規則已確認：同分同名次。" }));
run("s2 claim", () => b.moveCard(inst("dev-a"), "S-2", "claimed"));
run("log s2", () => b.updateCard(inst("dev-a"), "S-2", { log: "端點骨架完成，接著做分頁", check: [1] }));
run("log m1", () => b.updateCard(inst("dev-a"), m1, { log: "開始做分數 API", state: "已完成：規則。下一步：API。注意：賽季邊界。", check: [1] }));
run("comment person", () => b.updateCard(PERSON, m1, { comment: "冷快取時頁面也請維持在 300 ms 內。" }));
run("comment agent", () => b.updateCard(inst("dev-a"), m1, { comment: "了解，我會先量冷路徑。" }));
run("m3 claim", () => { b.moveCard(inst("dev-b"), m3, "claimed"); b.updateCard(inst("dev-b"), m3, { check: [1] }); });
run("m3 review", () => b.moveCard(inst("dev-b"), m3, "review", { result: "共用資料夾有三個徽章方案，建議 B。" }));
run("m5 claim", () => b.moveCard(inst("docs"), m5, "claimed"));
run("m5 block", () => b.moveCard(inst("docs"), m5, "blocked", { reason: "哪些分數算數：只算排位賽嗎？" }));
run("m6 claim", () => b.moveCard(inst("dev-b"), m6, "claimed"));
run("m6 log", () => b.updateCard(inst("dev-b"), m6, { log: "草稿寫好了，還差兩個例子", check: [1] }));
run("m7 cancel", () => b.moveCard(PERSON, m7, "cancelled", { reason: "dropped" }));

// Watchers: docs follows the card in progress (M-1) and the one the person will finish (M-6); lead leads the project.
run("watch m1", () => b.setWatchers(PERSON, m1, { add: ["docs"] }));
run("watch m6", () => b.setWatchers(PERSON, m6, { add: ["docs"] }));

const all = b.listCards ? b.listCards({}) : [];
console.log("seeded", Array.isArray(all) ? all.length : "?", "cards; M-1 watchers:", b.watchersOf(made[0].uuid), "M-6 watchers:", b.watchersOf(made[5].uuid));
sched.db.close();
