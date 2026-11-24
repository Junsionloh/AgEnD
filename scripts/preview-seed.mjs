// PREVIEW ONLY (branch preview/*, never in a PR): gives a fresh preview a task board worth trying — three projects and some
// cards an agent opened without one — so Fleet › Tasks has something to sort the moment the page opens. It runs from
// `postbuild`, only inside the preview image (the build runs in /app), and writes /data/scheduler.db, which the fleet opens.
// Nothing here reaches an instance: every card is unassigned, so no notice wakes anybody.
import { mkdirSync } from "node:fs";
import { join } from "node:path";

if (process.cwd() !== "/app") process.exit(0);
const home = process.env.AGEND_HOME || "/data";
mkdirSync(home, { recursive: true });
const { SchedulerDb } = await import("../dist/scheduler/db.js");
const db = new SchedulerDb(join(home, "scheduler.db"));
const board = db.board;
const person = { kind: "person", name: "preview" };
const agent = { kind: "instance", name: "test" };

const game = board.createProject(person, { name: "遊戲", description: "遊戲相關工作" });
const shop = board.createProject(person, { name: "商店", description: "商店與付款" });
board.createProject(person, { name: "文件", description: "說明文件與發佈說明" });
board.createCards(person, { project: game.id, cards: [{ title: "提供每週排行榜" }, { title: "挑選徽章" }] });
board.createCards(person, { project: shop.id, cards: [{ title: "結帳流程" }] });

// What an agent opened without saying which project: unassigned, in no project.
for (const title of ["每日報告給擁有者", "檢查夜間備份", "修正結帳頁文案", "輪替 API 金鑰", "每週未完成卡片摘要", "回覆退款客服信", "更新 changelog"]) {
  board.createCards(agent, { cards: [{ title, assignee: null, project: null }] });
}
db.close();
console.log("preview-seed: 3 projects, 3 filed cards, 7 cards in no project");
