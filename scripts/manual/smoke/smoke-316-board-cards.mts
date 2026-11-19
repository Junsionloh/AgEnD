// AGEND-316: the board's cards, drawn in real Chromium and measured — what the user asked for after AGEND-317's layouts:
//  1. wider: the board fills the content area, a column is 272–360 px however many there are, more columns than fit scroll
//     sideways (the number of columns each width shows is written to the results); a card is as tall as its content, the
//     title at two lines and the status at one at most (cut with "…", the whole text is the tooltip);
//  2. a card whose agent is running has a moving light (a CSS animation on a layer of its own; still under reduced motion);
//  3. no coloured bar on the left edge, in any status;
//  4. the avatar on a card is a button: it opens the picker the card page has (the card does not open), a choice saves,
//     Esc closes it and the focus returns; pointing at it shows an info card (state, what it does, cards in hand);
//     the list's rows have the same avatar; over a read-only link it is not a button and a choice cannot be made.
// Run on the base commit (REPO=<checkout of it>) the same shots are the "before"; the checks that name new things fail there.
//   PW_DIR=<dir with playwright-core> CHROME=<chrome> REPO=<checkout> OUT=<dir> MATRIX=desk-dark-zh-TW,desk-light-en \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-316-uniform-tiles.mts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, caseName, labelOf, matrix, shotPath, type MatrixCase } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-316-board-cards";
const REPO = process.env.REPO!;
const NAMES = ["dev-a", "dev-b", "docs"];
const roster = NAMES.map((name, i) => ({ name, backend: "claude-code" as const, status: "running" as const, ...(i === 0 ? { general: true } : {}) }));
const fx = await bootFixture({ port: Number(process.env.HP ?? 48490), roster, classic: false });
const fm = fx.fm;
// dev-a and dev-b are working (the dashboard's state, which the board reads for "running"); docs is idle.
fm.getInstanceExecutionState = (n: string) => (n === "dev-a" || n === "dev-b" ? "working" : "idle");
const { Scheduler, DEFAULT_SCHEDULER_CONFIG } = await import(REPO + "/src/scheduler/index.ts");

const ANN = { kind: "person", name: "operator" } as const;
const agent = (name: string) => ({ kind: "instance", name }) as const;

/** The same cards in each language; the first six are the screenshot the person sent. */
function seed(c: MatrixCase) {
  fm.scheduler?.db.close();
  fm.scheduler = new Scheduler(join(fm.dataDir, `scheduler-${caseName(c)}.db`), () => {}, DEFAULT_SCHEDULER_CONFIG, (n: string) => !!fm.fleetConfig.instances[n]);
  (fm as any).attachTaskBoard(fm.scheduler.db);
  const board = fm.scheduler.db.board;
  const L = (en: string, zh: string) => labelOf(c, { en, zh });
  const project = board.createProject(ANN, { name: L("Leaderboard", "排行榜"), description: L("Weekly and seasonal rankings", "每週與每季排行榜"), leadInstance: "dev-a" });
  const P = project.id;
  const main = (title: string, extra: Record<string, unknown> = {}) => board.createCards(ANN, { project: P, cards: [{ title, ...extra }] }).cards[0]!.code as string;
  const sub = (parent: string, title: string, extra: Record<string, unknown> = {}) => board.createCards(ANN, { cards: [{ parent, title, ...extra }] }).cards[0]!.code as string;
  const move = (who: any, code: string, to: string, o: Record<string, unknown> = {}) => board.moveCard(who, code, to, o);

  const m1 = main(L("Serve the weekly leaderboard", "提供每週排行榜"), { assignee: "dev-a", priority: "high", size: "M", acceptance: ["Ties share a rank", "Under 300 ms", "Paged", "Cached"] });
  const m2 = main(L("Add the shop", "新增商店"), { assignee: "dev-b", size: "L" });
  const m3 = main(L("Pick the badges", "挑選徽章"), { assignee: "dev-b", priority: "urgent", acceptance: ["Six badges"] });
  const m4 = main(L("Build the score store", "建立分數儲存"), { assignee: "docs", size: "S" });
  const m5 = main(L("Adjust the anti-cheat rules", "調整防作弊規則"), { assignee: "docs", priority: "high" });
  const m6 = main(L("Write the season rules", "撰寫賽季規則"), { assignee: "dev-b", priority: "urgent", size: "S", acceptance: ["Rules page", "Translated"] });
  // M-1: three sub tasks, one done, one in progress (its agent is running), a card that comments.
  const s1 = sub(m1, L("Design the schema", "設計資料表"), { assignee: "dev-a" });
  const s2 = sub(m1, L("Build the score API", "建立分數 API"), { assignee: "dev-a" });
  sub(m1, L("Write the tests", "撰寫測試"), { assignee: "dev-b" });
  move(agent("dev-a"), s1, "claimed"); move(agent("dev-a"), s1, "done", { result: "ok" });
  move(agent("dev-a"), s2, "claimed");
  board.updateCard(ANN, m1, { check: [1], comment: L("Please keep the page size at 50.", "每頁請維持 50 筆。") });
  board.updateCard(agent("dev-a"), m1, { comment: L("Will do.", "好的。") });
  board.updateCard(ANN, m1, { comment: L("Thanks!", "謝謝！") });
  // M-2: two sub tasks, none started: "Next".
  sub(m2, L("Price list", "價目表"), { assignee: "dev-b" });
  sub(m2, L("Checkout", "結帳"), { assignee: "dev-b" });
  // M-3: waits for the person; M-4: done; M-5: blocked with a reason; M-6: in progress (running).
  move(agent("dev-b"), m3, "claimed"); board.updateCard(agent("dev-b"), m3, { check: [1] }); move(agent("dev-b"), m3, "review", { result: "Badges chosen" });
  move(agent("docs"), m4, "claimed"); move(agent("docs"), m4, "review", { result: "ok" }); move(ANN, m4, "done");
  move(agent("docs"), m5, "claimed");
  move(agent("docs"), m5, "blocked", { reason: L("Which scores count: ranked games only?", "哪些分數算數：只算排位賽嗎？") });
  move(agent("dev-b"), m6, "claimed");
  // The hard ones: a title of 100 characters, a long reason, a card with nothing but a title, a size and no priority.
  const long = L("Rework the nightly leaderboard rebuild so that ties, late submissions and region merges are all handled in one pass", "重新設計每晚的排行榜重建流程，讓同分、延遲提交、跨區合併與賽季切換都能在同一次處理中完成並且不會漏算任何一位玩家的成績")
    .slice(0, 100);
  const m7 = main(long, { assignee: "dev-a", priority: "urgent", size: "L" });
  const m8 = main(L("Nothing but a title", "只有標題"));
  const m9 = main(L("Fix the season rollover", "修正賽季交接"), { assignee: "docs", priority: "high" });
  move(agent("docs"), m9, "claimed");
  move(agent("docs"), m9, "blocked", { reason: L("Waiting for the season calendar from the game team — nobody on this side knows which week the new season starts, and the dates in the old design doc disagree with the shop's.", "等遊戲團隊提供賽季日曆 — 這邊沒有人知道新賽季從哪一週開始，舊設計文件與商店頁面的日期也對不起來。") });
  const m10 = main(L("A card with only a size", "只有大小的卡片"), { size: "M" });
  return { m1, m2, m6, m7, m8, m9, m10, P };
}

// What the page lays out: per tile, its box and the parts the checks name.
const MEASURE = `(() => {
  // Lines of text drawn in an element: the boxes inside it (a clamped title still has the boxes of the lines it hides).
  const textLines = (root) => { const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), ys = [], box = root.getBoundingClientRect();
    for (let n = w.nextNode(); n; n = w.nextNode()) { if (!n.textContent.trim()) continue; const rg = document.createRange(); rg.selectNodeContents(n); for (const b of rg.getClientRects()) { const y = b.top + b.height / 2; if (y <= box.bottom + 1) ys.push(y); } }
    ys.sort((a, b) => a - b); let lines = 0, last = -99; for (const y of ys) { if (y - last > 6) lines++; last = y; } return lines; };
  const rect = (el, root) => { if (!el) return null; const b = el.getBoundingClientRect(), o = root.getBoundingClientRect(); return { x: Math.round((b.left - o.left) * 10) / 10, y: Math.round((b.top - o.top) * 10) / 10, w: Math.round(b.width * 10) / 10, h: Math.round(b.height * 10) / 10 }; };
  return [...document.querySelectorAll(".tb-tile")].map((t) => {
    const title = t.querySelector(".tb-tile-title"), span = title.querySelector("span") || title, status = t.querySelector(".tb-tile-status"), cs = getComputedStyle(t), before = getComputedStyle(t, "::before");
    const r = t.getBoundingClientRect();
    return {
      id: t.dataset.tile, col: t.closest(".tb-col").getAttribute("aria-label"), width: Math.round(r.width * 10) / 10, height: Math.round(r.height * 10) / 10,
      titleLines: textLines(span), titleCut: span.scrollHeight > span.clientHeight + 1, titleAttr: title.getAttribute("title"),
      statusLines: status ? textLines(status) : 0, statusKind: status ? (status.className.match(/k-(\\w+)/) || [])[1] : null, statusText: status ? status.textContent.replace(/\\s+/g, " ").trim() : "",
      statusCut: status ? [...status.querySelectorAll("*")].some((e) => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).textOverflow === "ellipsis") : false,
      barContent: before.content, borderLeft: cs.borderLeftWidth, borderLeftColor: cs.borderLeftColor, borderTopColor: cs.borderTopColor, paddingLeft: cs.paddingLeft, paddingTop: cs.paddingTop,
      running: t.classList.contains("running"), shine: !!t.querySelector(".tb-tile-shine"),
      shineAnim: t.querySelector(".tb-tile-shine") ? [getComputedStyle(t.querySelector(".tb-tile-shine"), "::before").animationName, getComputedStyle(t.querySelector(".tb-tile-shine"), "::after").animationName,
        getComputedStyle(t.querySelector(".tb-tile-shine"), "::before").display] : null,
      owner: t.querySelector(".tb-owner-btn") ? { tag: t.querySelector(".tb-owner-btn").tagName, text: t.querySelector(".tb-owner-btn").textContent.trim(), static: t.querySelector(".tb-owner-btn").classList.contains("is-static") } : null,
      leftEdges: ["tb-tile-top", "tb-tile-title", "tb-tile-status", "tb-tile-foot"].map((c) => { const e = t.querySelector("." + c); return e ? Math.round(e.getBoundingClientRect().left - r.left) : null; }),
    };
  });
})()`;
const COLS = `(() => { const sc = document.querySelector(".tb-scroll"), s = sc.getBoundingClientRect();
  const cols = [...document.querySelectorAll(".tb-col")].map((c) => c.getBoundingClientRect());
  return { viewport: innerWidth, scroll: Math.round(s.width), columns: cols.length, visible: cols.filter((c) => c.left >= s.left - 1 && c.right <= s.right + 1).length, widths: [...new Set(cols.map((c) => Math.round(c.width)))],
    scrolls: sc.scrollWidth > sc.clientWidth + 1, pageWidth: Math.round(document.querySelector(".tb-board-page").getBoundingClientRect().width), overflowX: document.documentElement.scrollWidth - innerWidth }; })()`;

const uniq = <T,>(xs: T[]) => [...new Set(xs)];
const results: any = { browser: fx.browser.version(), cases: {} };
let failed = 0;
// SHOTS_ONLY=1: only the board's pictures (the same seed), for a checkout that has none of the new behaviour (the "before");
// FRAMES=1: also frames of the in-progress column over a few seconds (the moving light), to put together as a GIF.
const shotsOnly = !!process.env.SHOTS_ONLY;

for (const c of matrix(process.env.MATRIX ?? "desk-dark-zh-TW,desk-light-en,phone-dark-zh-TW")) {
  const name = caseName(c);
  const ids = seed(c);
  const phone = c.device === "phone";
  const { ctx, page } = await fx.page(c, { path: "/ui/fleet", storage: { agend_tasks_project: String(ids.P) } });
  const errors: string[] = [];
  page.on("pageerror", (e: any) => errors.push(String(e).slice(0, 200)));
  const r: any = {};
  const chk: Record<string, boolean> = {};
  try {
    await page.waitForSelector(".tb-tile", { state: "attached", timeout: 15000 });
    if (!phone) await page.setViewportSize({ width: 1470, height: 760 });
    await page.waitForTimeout(700);
    await page.screenshot({ path: shotPath(SMOKE, c, "1-board") });
    let tiles: any[];
    if (phone) {
      tiles = [];
      const tabs = await page.locator(".tb-status-seg .tb-seg-btn").count();
      for (let i = 0; i < tabs; i++) {
        await page.locator(".tb-status-seg .tb-seg-btn").nth(i).click(); await page.waitForTimeout(200);
        tiles.push(...(await page.evaluate(MEASURE) as any[]).filter((t) => t.width > 0));
        if (i < 2) await page.screenshot({ path: shotPath(SMOKE, c, `1-board-tab${i}`) });
      }
    } else {
      tiles = await page.evaluate(MEASURE) as any[];
    }
    r.tiles = tiles;
    r.statuses = Object.fromEntries(tiles.map((t) => [t.id, `${t.statusKind}: ${t.statusText}`]));
    const rendered = tiles.filter((t) => t.width > 0);
    // 3. no bar: a tile draws nothing at ::before and has no thicker edge on the left than on the top.
    chk.noLeftBar = rendered.every((t) => (t.barContent === "none" || t.barContent === "normal") && t.borderLeft === "1px" && t.borderLeftColor === t.borderTopColor);
    chk.tilePaddingEven = uniq(rendered.map((t) => t.paddingLeft)).length === 1 && rendered.every((t) => t.paddingLeft === t.paddingTop);
    // 1. caps on rows, natural height.
    chk.titleTwoLinesMax = rendered.every((t) => t.titleLines <= 2) && rendered.some((t) => t.titleCut);
    chk.cutTitleHasTooltip = rendered.filter((t) => t.titleCut).every((t) => (t.titleAttr ?? "").length >= 20);
    chk.statusOneLine = rendered.every((t) => t.statusLines <= 1) && rendered.some((t) => t.statusCut);
    chk.heightFollowsContent = uniq(rendered.map((t) => t.height)).length > 1;
    chk.leftEdgesAlign = rendered.every((t) => uniq(t.leftEdges.filter((x: number | null) => x !== null)).length === 1);
    if (!phone) {
      chk.columnsWide = true;   // checked on the columns at each width below
      // The board's width at 1366 / 1440 / 1920, and how many columns each shows.
      r.widths = {};
      for (const w of [1366, 1440, 1920]) {
        await page.setViewportSize({ width: w, height: 760 }); await page.waitForTimeout(250);
        r.widths[w] = await page.evaluate(COLS);
        await page.screenshot({ path: shotPath(SMOKE, c, `1-board-${w}`) });
      }
      chk.columnsWide = Object.values(r.widths).every((x: any) => x.widths.every((w: number) => w >= 272 && w <= 360));
      chk.noPageOverflow = Object.values(r.widths).every((x: any) => x.overflowX <= 0);
      chk.pageFillsAt1920 = r.widths[1920].pageWidth > 1300 && r.widths[1920].columns === 5;
      await page.setViewportSize({ width: 1470, height: 760 });
      await page.waitForTimeout(250);
    } else {
      chk.phoneNoSideScroll = (await page.evaluate(COLS) as any).overflowX <= 0;
    }
    // 2. running: the card whose agent works has the layer; its animations run; another card has none.
    const running = rendered.filter((t) => t.running);
    chk.runningTiles = running.length >= 1 && running.every((t) => t.shine && t.shineAnim && t.shineAnim[0] === "tb-shine" && t.shineAnim[1] === "tb-breathe") && rendered.filter((t) => !t.running).every((t) => !t.shine);
    if (!phone) {
      await page.locator(".tb-tile.running").first().scrollIntoViewIfNeeded();
      // Two frames of the band a moment apart: the light has moved.
      const band = () => page.evaluate(`(() => { const s = document.querySelector(".tb-tile-shine"); return s ? new DOMMatrixReadOnly(getComputedStyle(s, "::before").transform).m41 : null; })()`);
      const x1 = await band(); await page.waitForTimeout(600); const x2 = await band();
      chk.lightMoves = x1 !== x2;
      await page.screenshot({ path: shotPath(SMOKE, c, "2-running") });
      // Reduced motion: the band is gone and the edge is still.
      await page.emulateMedia({ reducedMotion: "reduce" }); await page.waitForTimeout(300);
      const still = await page.evaluate(MEASURE) as any[];
      chk.reducedMotionStill = still.filter((t) => t.running).every((t) => t.shineAnim && t.shineAnim[2] === "none" && t.shineAnim[1] === "none");
      await page.screenshot({ path: shotPath(SMOKE, c, "2-running-reduced-motion") });
      await page.emulateMedia({ reducedMotion: "no-preference" });
    }
    if (process.env.FRAMES && !phone) {
      const box = await page.locator(".tb-col.st-claimed").boundingBox();
      for (let i = 0; i < 26; i++) {
        await page.screenshot({ path: shotPath(SMOKE, c, `frame-${String(i).padStart(2, "0")}`), clip: { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, 330) } });
        await page.waitForTimeout(90);
      }
    }
    if (!shotsOnly) {
    // 4. the avatar: a button; its picker; a choice saves; the card does not open. The info card.
    const db = fm.scheduler.db;
    const assigneeOf = (code: string) => db.board.getCard(code).assignee as string | null;
    // A finished card's assignee is not changed (the card page does not offer it either): static there, a button elsewhere.
    chk.avatarIsButton = rendered.filter((t) => t.col !== labelOf(c, { en: "Done", zh: "完成" })).every((t) => t.owner && t.owner.tag === "BUTTON" && !t.owner.static)
      && rendered.filter((t) => t.col === labelOf(c, { en: "Done", zh: "完成" })).every((t) => t.owner && t.owner.static);
    if (phone) { await page.locator(".tb-status-seg .tb-seg-btn").nth(0).click(); await page.waitForTimeout(200); }
    const owner = page.locator(`[data-tile="${ids.m2}"] .tb-owner-btn`);
    await owner.click(); await page.waitForTimeout(250);
    chk.pickerOpens = (await page.locator(".tb-card-menu").count()) === 1 && (await page.locator(".tb-card-menu [role=menuitemradio]").count()) >= 4;
    chk.cardStaysClosed = (await page.locator(".tp").count()) === 0;
    chk.pickerHasCurrentTicked = (await page.locator('.tb-card-menu [aria-checked="true"]').first().textContent() ?? "").includes("dev-b");
    await page.screenshot({ path: shotPath(SMOKE, c, "3-owner-picker") });
    await page.keyboard.press("Escape"); await page.waitForTimeout(150);
    chk.escClosesAndFocusReturns = (await page.locator(".tb-card-menu").count()) === 0 && await page.evaluate(`document.activeElement?.classList.contains("tb-owner-btn")`) as boolean;
    await owner.click(); await page.waitForTimeout(200);
    await page.locator('.tb-card-menu [role=menuitemradio]', { hasText: "docs" }).first().click();
    for (let i = 0; i < 30 && assigneeOf(ids.m2) !== "docs"; i++) await page.waitForTimeout(100);
    chk.choiceSaves = assigneeOf(ids.m2) === "docs";
    await page.waitForTimeout(400);
    chk.cardStillClosed = (await page.locator(".tp").count()) === 0 && (await page.locator(`[data-tile="${ids.m2}"] .tb-owner-btn`).textContent() ?? "").includes("docs");
    if (!phone) {
      // Keyboard: Tab to the avatar and Enter opens the picker, Esc closes it.
      await page.waitForTimeout(700);                 // past the quiet moment after a choice
      await page.keyboard.press("Shift");             // the keyboard was the last input: the focus is a keyboard's
      await page.locator(`[data-tile="${ids.m6}"] .tb-owner-btn`).focus();
      await page.waitForTimeout(300);
      chk.focusShowsInfo = (await page.locator(".tb-owner-card").count()) === 1;
      await page.keyboard.press("Escape"); await page.waitForTimeout(100);
      chk.escHidesInfo = (await page.locator(".tb-owner-card").count()) === 0;
      await page.keyboard.press("Enter"); await page.waitForTimeout(200);
      chk.enterOpensPicker = (await page.locator(".tb-card-menu").count()) === 1;
      await page.keyboard.press("Escape"); await page.waitForTimeout(150);
      // Pointing at the running card's avatar: the info card.
      await page.mouse.move(2, 2);
      await page.locator(`[data-tile="${ids.m1}"] .tb-owner-btn`).hover(); await page.waitForTimeout(450);
      const info = await page.locator(".tb-owner-card").first().textContent().catch(() => "") ?? "";
      r.info = info.replace(/\\s+/g, " ").trim();
      chk.hoverShowsInfo = (await page.locator(".tb-owner-card").count()) === 1 && /dev-a/.test(info) && /S-2/.test(info);
      await page.screenshot({ path: shotPath(SMOKE, c, "4-owner-info") });
      await page.mouse.move(2, 2); await page.waitForTimeout(250);
      chk.leavingHidesInfo = (await page.locator(".tb-owner-card").count()) === 0;
      // The list: the same avatar.
      await page.locator(".tb-view-toggle .tb-seg-btn").nth(1).click(); await page.waitForTimeout(400);
      chk.listHasAvatarButtons = (await page.locator(".tb-row .tb-row-who .tb-owner-btn:not(.is-static)").count()) >= 5;
      await page.locator(".tb-row .tb-row-who .tb-owner-btn").first().click(); await page.waitForTimeout(200);
      chk.listPickerOpens = (await page.locator(".tb-card-menu").count()) === 1 && (await page.locator(".tp").count()) === 0;
      await page.screenshot({ path: shotPath(SMOKE, c, "5-list-owner-picker") });
      await page.keyboard.press("Escape"); await page.waitForTimeout(150);
      await page.screenshot({ path: shotPath(SMOKE, c, "5-list") });
      await page.locator(".tb-view-toggle .tb-seg-btn").nth(0).click(); await page.waitForTimeout(300);
    }
    }
  } catch (e) { r.error = String(e).slice(0, 500); chk.ranToTheEnd = false; await page.screenshot({ path: shotPath(SMOKE, c, "failure") }).catch(() => {}); }
  r.checks = chk; r.errors = errors;
  const bad = Object.entries(chk).filter(([, v]) => !v).map(([k]) => k);
  if (bad.length || errors.length) failed++;
  console.log(`${bad.length || errors.length ? "FAIL" : "ok  "} ${name}${bad.length ? ` [${bad.join(", ")}]` : ""}${errors.length ? " " + JSON.stringify(errors) : ""}${r.error ? " " + r.error : ""}`);
  results.cases[name] = r;
  await ctx.close();
}
writeFileSync(shotPath(SMOKE, "results", "measures").replace(/\.png$/, ".json"), JSON.stringify(results, null, 1));
await fx.close();
process.exit(failed ? 1 : 0);
