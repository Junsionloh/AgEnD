// AGEND-354: a task card as the person reads it — what an agent wrote on it. ONE script for both builds:
//   ROLE=before  on the release this PR is based on (a card whose agents wrote only what they could: text, a path)
//   ROLE=after   on this PR (the same words as Markdown, and the files the agents attached)
// The same scenario as the owner's M-12: a main task with three sub tasks — planner's design document, dev's HTML prototype, master's
// acceptance — on the real Tasks tab, desk 1366 / phone 390, light / dark, English / zh-TW (MATRIX=full, the default).
//   PW_DIR=<dir with playwright-core> REPO=<checkout> OUT=<dir> ROLE=before|after FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-354-task-card-files.mts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PICTURES, bootFixture, matrix, shotPath, VIEWPORTS } from "../smoke-fixture/index.mts";

const ROLE = process.env.ROLE === "before" ? "before" : "after";
const SMOKE = `smoke-354-${ROLE}`;
const roster = ["planner", "dev", "mastertest"].map((name) => ({ name, backend: "claude-code" as const, displayName: name }));
const fx = await bootFixture({ port: Number(process.env.HP ?? 48560), instances: 3, roster, classic: false });
const REPO = process.env.REPO!;
const { SchedulerDb } = await import(REPO + "/src/scheduler/db.ts");
const db = new SchedulerDb(join(fx.dir, "scheduler.db"));
fx.fm.scheduler = { db };
fx.fm.attachTaskBoard(db);
const PERSON = { kind: "person" as const, name: "admin" };
const as = (name: string) => ({ kind: "instance" as const, name });

const DESIGN_MD = "# 倖存者遊戲設計文件 / Survivors design\n\n## 核心循環 / Core loop\n\n1. 移動、自動攻擊\n2. 撿經驗球升級\n3. 三選一升級\n\n## 內容 / Content\n\n| 項目 | 數量 |\n|---|---|\n| 敵人 | 8 + Boss |\n| 武器 | 8 |\n| 被動 | 10 |\n\n```text\n勝利條件：存活 15 分鐘\n```\n";
const GAME_HTML = "<!doctype html><meta charset=utf-8><title>Survivors</title><body style='margin:0;background:#111;color:#eee;font:16px sans-serif'><canvas id=c width=640 height=360></canvas><p>WASD 移動 · 空白鍵衝刺</p><script>const c=document.getElementById('c').getContext('2d');c.fillStyle='#5af';c.fillRect(300,160,20,20);</script></body>";
// A picture the fixture draws (a real PNG).
const PNG = await fx.picture(Object.keys(PICTURES)[0] as keyof typeof PICTURES);

const staged = async (who: string, name: string, bytes: Buffer): Promise<string> => {
  const { stageFile } = await import(REPO + "/src/task-attach-client.ts");
  const { boardToolAction } = await import(REPO + "/src/task-board-tool.ts");
  const got = await stageFile(name, bytes, async (call: any) => { try { return { result: boardToolAction(db, who, call) }; } catch (e) { return { error: (e as Error).message }; } });
  if ("error" in got) throw new Error(got.error);
  return got.upload;
};

db.board.createProject(PERSON, { name: "遊戲 Games" });
const mains = db.board.createCards(PERSON, { project: "遊戲 Games", cards: [{ title: "製作倖存者遊戲", assignee: "mastertest", dispatcher: { kind: "person" },
  goal: "製作一款倖存者類（Survivors-like）遊戲。\n\n- master 統籌與整合\n- planner 負責企劃，dev 負責程式\n- 子任務由不同 agent 處理並回報到本主任務",
  acceptance: ["企劃文件完成（玩法、敵人、武器、升級、勝負條件）", "可執行的原型完成", "master 整合並驗收"] }] }).cards;
const M = mains[0]!.code;
const subs = db.board.createCards(PERSON, { cards: [
  { parent: M, title: "企劃：倖存者遊戲設計文件", assignee: "planner", goal: "撰寫設計文件，完成後回報到主任務。" },
  { parent: M, title: "程式：倖存者遊戲原型實作", assignee: "dev", goal: "做一個可在瀏覽器直接開啟的 HTML 原型。" },
  { parent: M, title: "Master：整合與驗收", assignee: "mastertest", goal: "彙整企劃與程式成果，驗收原型並回報使用者。" },
] }).cards;
const [S1, S2, S3] = subs.map((c: any) => c.code);

// planner: S-1
db.board.moveCard(as("planner"), S1, "claimed", {});
const design = ROLE === "after" ? await staged("planner", "survivor-design.md", Buffer.from(DESIGN_MD)) : null;
if (ROLE === "after") {
  db.board.moveCard(as("planner"), S1, "done", {
    result: "## 設計文件完成\n\n核心循環、操作、**8 種敵人 + Boss**、8 武器、10 被動、升級規則、勝負條件、MVP 範圍。\n\n驗證：逐項對照主任務的企劃清單。",
    comment: "## S-1 完成：設計文件\n\n**核心循環**\n\n1. 移動、自動攻擊\n2. 撿經驗球升級\n3. 三選一升級\n\n**MVP 範圍**：1 張地圖、3 種武器、3 種敵人，存活 15 分鐘獲勝。\n\n完整文件見附件 `survivor-design.md`。",
    attach: [design!] });
} else {
  db.board.moveCard(as("planner"), S1, "done", { result: "設計文件完成：/data/workspaces/planner/survivor-design.md（核心循環、操作、8種敵人+Boss、波次表、8武器、10被動、升級規則、數值目標、勝負條件、MVP範圍）" });
  db.board.updateCard(as("planner"), S1, { comment: "S-1 完成。設計文件路徑：/data/workspaces/planner/survivor-design.md（含 MVP 範圍建議）" });
}
// dev: S-2
db.board.moveCard(as("dev"), S2, "claimed", {});
if (ROLE === "after") {
  const game = await staged("dev", "index.html", Buffer.from(GAME_HTML));
  const shot = await staged("dev", "screenshot.png", PNG);
  db.board.moveCard(as("dev"), S2, "done", {
    result: "可執行原型：單檔 HTML5 Canvas，瀏覽器直接開啟。WASD 移動、空白鍵衝刺、3 種武器、3 種敵人、三選一升級、存活 15 分鐘獲勝。",
    comment: "## S-2 完成：可玩原型\n\n- 單檔 `index.html`（HTML5 Canvas），雙擊或在卡片上按 **預覽** 即可玩\n- 測試參數：`?speed=N`、`?win=秒數`\n\n```js\n// 勝利判定\nif (time >= winSeconds) endGame(\"win\");\n```",
    attach: [game, shot] });
} else {
  db.board.moveCard(as("dev"), S2, "done", { result: "可執行原型：/data/dev/survivors/index.html（單檔 HTML5 Canvas，瀏覽器直接開啟）。WASD 移動、空白鍵衝刺、3 種武器、3 種敵人、三選一升級、存活 15 分鐘獲勝" });
}
// master: S-3 and the main task's own words
db.board.moveCard(as("mastertest"), S3, "claimed", {});
db.board.moveCard(as("mastertest"), S3, "done", { result: ROLE === "after" ? "## 驗收通過\n\n- `index.html` 存在（322 行），JS 語法檢查通過\n- 內容符合企劃的 MVP 範圍" : "驗收：index.html 存在（322 行），JS 語法檢查通過；內容符合企劃 MVP 範圍。" });
db.board.updateCard(as("mastertest"), M, { state: ROLE === "after" ? "- 企劃 ✅\n- 原型 ✅\n- 驗收 ✅\n\n下一步：等你確認" : "企劃、原型、驗收都完成，等你確認" });

const results: any = { role: ROLE, browser: fx.browser.version(), card: M, shots: [] as string[] };
for (const c of matrix()) {
  // This device allows previews (the host preference the chat's own opt-in writes, #1665).
  const { page, ctx } = await fx.page(c, { path: `/ui/fleet?card=${S1}`, prefs: { "preview.optIn": true } });
  await page.setViewportSize({ width: VIEWPORTS[c.device].width, height: c.device === "phone" ? 1900 : 1250 });
  await page.waitForSelector(".tp", { timeout: 15000 });
  await page.waitForTimeout(600);
  const file = shotPath(SMOKE, c, "planner-card");
  await page.screenshot({ path: file, fullPage: true });
  results.shots.push(file);
  if (ROLE === "after") {
    // The developer's card: the prototype and its picture, with the HTML's Preview.
    await page.goto(`${fx.base}/ui/fleet?card=${S2}`); await page.waitForSelector(".tp", { timeout: 15000 }); await page.waitForTimeout(600);
    const dev = shotPath(SMOKE, c, "dev-card");
    await page.screenshot({ path: dev, fullPage: true });
    results.shots.push(dev);
    // The prototype RUNS from the card: this device allows previews (the chat's own opt-in), Preview reads the file and starts the sandbox
    // frame — an iframe of the preview origin, scripts only — and the file itself is still a download, never a page of the dashboard.
    if (c.device === "desk" && c.theme === "light" && c.lang === "en") {
      await page.goto(`${fx.base}/ui/fleet?card=${S2}`); await page.waitForSelector(".tp", { timeout: 15000 });
      await page.click(".tf-html .btn-primary");
      await page.waitForSelector(".tp-files iframe", { timeout: 15000 });
      await page.waitForTimeout(1500);
      const frame = page.frames().find((f: any) => f !== page.mainFrame() && /\/preview|:\d+/.test(f.url()));
      results.preview = { iframe: await page.locator(".tp-files iframe").count(), sandbox: await page.locator(".tp-files iframe").first().getAttribute("sandbox"),
        origin: frame ? new URL(frame.url()).origin : null, dashboard: fx.base, canvasInFrame: frame ? await frame.locator("canvas").count() : 0 };
      const run = shotPath(SMOKE, c, "dev-card-preview-running");
      await page.screenshot({ path: run, fullPage: true });
      results.shots.push(run);
      const dl = await page.request.get(`${fx.base}/ui/tasks/files/${(db.board.attachments(db.board.getCard(S2).uuid) as any[]).find((f) => f.name === "index.html").id}`);
      results.download = { status: dl.status(), type: dl.headers()["content-type"], disposition: dl.headers()["content-disposition"], csp: dl.headers()["content-security-policy"] };
    }
  }
  await ctx.close();
}
writeFileSync(join(process.env.OUT ?? "/tmp", `${SMOKE}-results.json`), JSON.stringify(results, null, 2) + "\n");
console.log(`${ROLE}: ${results.shots.length} screenshots`);
await fx.close();
process.exit(0);
