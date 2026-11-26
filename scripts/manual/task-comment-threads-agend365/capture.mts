/**
 * AGEND-365 real-app captures: a task card's comments before and after the threads — Reply, Add reaction, Edit, Resolve thread,
 * Copy, Copy link, Delete in a ⋯ menu; replies under their thread; reactions; a resolved thread folded to one line; a deleted
 * comment's line; and the recipient chip under the comment box. The real web app and task board (scripts/manual/smoke-fixture,
 * a scratch scheduler database of made-up cards); no fleet, CLI or account.
 *   REPO=<checkout> PW_DIR=<playwright-core root> CHROME=<chrome> OUT=<dir> PHASE=before|after \
 *     npx tsx scripts/manual/task-comment-threads-agend365/capture.mts
 * `before` runs against the release without the threads (the same comments, plain: it has no reply, reaction or chip), `after` against
 * this branch. Both write the same pictures' names (`<combination>-1-stream.png`), so a pair is one name in two folders.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, matrix } from "../smoke-fixture/index.mts";

const OUT = process.env.OUT!, REPO = process.env.REPO!, PHASE = process.env.PHASE === "before" ? "before" : "after";
mkdirSync(OUT, { recursive: true });
const git = (...a: string[]) => execFileSync("git", ["-C", REPO, "-c", "gc.auto=0", ...a], { encoding: "utf8" }).trim();
const receipt: any = { phase: PHASE, sourceHead: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain", "--", "src").split("\n").filter(Boolean), checks: [], pictures: [] };
const check = (name: string, ok: unknown, detail?: unknown) => { receipt.checks.push({ name, ok: !!ok, ...(ok ? {} : { detail }) }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)}`}`); };
const fx = await bootFixture({ port: 0, instances: 3, classic: false });
try {
  const { Scheduler, DEFAULT_SCHEDULER_CONFIG } = await import(REPO + "/src/scheduler/index.ts");
  const fm = fx.fm;
  fm.scheduler?.db.close();
  fm.scheduler = new Scheduler(join(fm.dataDir, "threads-example.db"), () => {}, DEFAULT_SCHEDULER_CONFIG, () => true);
  fm.attachTaskBoard(fm.scheduler.db);
  const board = fm.scheduler.db.board;
  const names = fx.instances.map((i: any) => i.name);
  const dev = { kind: "instance", name: names[0] } as const, other = { kind: "instance", name: names[1] } as const;
  board.setCommentRouting({ instances: () => names, enabled: () => true });
  // The page signs in as one person; the comments that are "mine" are written under that name (the new card read says who it is).
  const probe = await fx.page({ device: "desk", theme: "light", lang: "en" });
  const project = board.createProject({ kind: "person", name: "Example owner" }, { name: "Example project" });
  const scratch = board.createCards({ kind: "person", name: "Example owner" }, { cards: [{ title: "Scratch", project: project.id }] }).cards[0];
  const viewer = await probe.page.evaluate(async (code: string) => (await (await fetch(`/ui/tasks/cards/${code}`)).json()).viewer ?? null, scratch.code);
  await probe.ctx.close();
  const me = { kind: "person", name: viewer?.name ?? "web-user" } as const;
  const threads = typeof board.react === "function";
  receipt.viewer = viewer ? { name: me.name } : null;
  const card = board.createCards(me, { cards: [{ title: "Serve the weekly leaderboard · 週排行榜上線", assignee: names[0], project: project.id,
    goal: "Players see their rank every week · 玩家每週都看得到自己的名次" }] }).cards[0];
  board.moveCard(me, card.code, "claimed");
  const say = (by: any, text: string, extra: Record<string, unknown> = {}) => { board.updateCard(by, card.code, { comment: text, ...(threads ? { to: [], ...extra } : {}) }); return board.detail(card.code).comments.at(-1).id as number; };
  const q1 = say(me, "Is the **ranking** weekly? · 排行榜是每週重置嗎？");
  const a1 = say(dev, "Yes — it resets on Monday at 00:00. · 對，每週一 00:00 重置。", { replyTo: q1 });
  const f1 = say(me, "Thanks! Please keep it under 300 ms. · 謝謝！請控制在 300 毫秒內。", { replyTo: a1 });
  const p1 = say(dev, "Pushed the endpoint: `GET /v1/leaderboard` · 已推上端點：`GET /v1/leaderboard`");
  const gone = say(me, "(a comment that is deleted) · （這則留言已刪除）");
  const r1 = say(other, "Old question, answered below · 舊問題，答案在下面");
  const r2 = say(dev, "Fixed in the last release. · 上一版已修好。", { replyTo: r1 });
  if (threads) {
    board.editComment(me, card.code, f1, "Thanks! Please keep it under 300 ms. · 謝謝！請控制在 300 毫秒內。（已補充）");
    board.react(me, card.code, p1, "👍", true); board.react(other, card.code, p1, "👍", true); board.react(dev, card.code, p1, "🎉", true);
    board.react(other, card.code, q1, "👀", true);
    board.deleteComment(me, card.code, gone);
    board.resolveThread(me, card.code, r1, true);
  }
  // Which comments exist, as the board says (the receipt's fixture).
  receipt.comments = board.detail(card.code).comments.map((e: any) => ({ id: e.id, by: e.author, parentId: e.parentId ?? null, edited: !!e.editedAt, deleted: !!e.deleted, resolved: !!e.resolved, reactions: (e.reactions ?? []).map((r: any) => `${r.emoji}×${r.by.length}`) }));
  for (const c of matrix()) {
    const p = await fx.page(c), page = p.page, tag = `${c.device}-${c.theme}-${c.lang}`, phone = c.device === "phone", errors: string[] = [];
    await page.emulateMedia({ reducedMotion: "reduce" });
    page.on("pageerror", (e: Error) => errors.push(e.message));
    const shot = async (name: string, target?: string) => {
      await page.waitForTimeout(400);
      const path = `${tag}-${name}.png`;
      if (target) {
        // The block taller than the window (a phone's long column): the window made tall for the picture, then as it was.
        const size = page.viewportSize();
        await page.setViewportSize({ width: size.width, height: 2600 }); await page.waitForTimeout(400);
        await page.locator(target).first().screenshot({ path: join(OUT, path) });
        await page.setViewportSize(size); await page.waitForTimeout(300);
      } else await page.screenshot({ path: join(OUT, path) });
      receipt.pictures.push({ path, sha256: createHash("sha256").update(readFileSync(join(OUT, path))).digest("hex") });
    };
    await page.goto(fx.base + `/ui/fleet/tasks?card=${card.code}`); await page.locator(".tp-activity .tl").waitFor(); await page.waitForTimeout(1200);
    if (PHASE === "after") {
      const tools = await page.locator("#c" + q1 + " .tl-tools").count();
      check(`${tag}: each comment has its tools (reaction button and ⋯)`, tools === 1 && (await page.locator(".tl-comment .tl-tools").count()) === 4, tools);   // the thread's three, the comment of its own; the deleted line and the folded thread have none
      check(`${tag}: replies are drawn under their thread's first comment (the resolved thread's are folded away)`, (await page.locator(`.tl-thread .tl-reply`).count()) === 2, await page.locator(".tl-thread .tl-reply").count());
      check(`${tag}: a resolved thread is one line`, (await page.locator(".tl-resolved-btn").count()) === 1);
      check(`${tag}: a deleted comment is a line`, /deleted|已刪除/.test(await page.locator("#c" + gone).innerText()));
      // The count is text in the page's font (the chip's own font is the emoji font, whose digits are grey pictures).
      const n = await page.locator("#c" + p1 + " .tl-reacts .n").first().evaluate((el: Element) => getComputedStyle(el).fontFamily);
      check(`${tag}: a reaction's count is drawn in the page's font, not the emoji font`, !/emoji/i.test(n.split(",")[0]!), n);
      check(`${tag}: the viewer's own reaction is pressed`, (await page.locator("#c" + p1 + " .tl-reacts button[aria-pressed=true]").count()) === 1);
      const chip = (await page.locator(".tp-activity > .tc-composer .tc-to").innerText()).replace(/\s+/g, " ");
      check(`${tag}: the box starts at the assignee: "${names[0]} · starts when sent"`, chip.includes(names[0]) && /starts when sent|送出後開始處理/.test(chip), chip);
      // The ⋯ menu of the viewer's own comment: Reply, Add reaction, Edit, Resolve thread, Copy, Copy link, Delete.
      await page.locator("#c" + q1).scrollIntoViewIfNeeded();
      await page.locator("#c" + q1 + " .tl-menu > button").click(); await page.waitForTimeout(400);
      const items = await page.locator("#c" + q1 + " .tl-menu .menu-list button").allInnerTexts();
      check(`${tag}: the menu offers reply, reaction, edit, resolve, copy, copy link, delete`, items.length === 7, items);
      await page.evaluate((id: number) => document.getElementById("c" + id)?.scrollIntoView({ block: "start" }), q1); await page.waitForTimeout(300);
      await shot("2-menu");
      await page.keyboard.press("Escape"); await page.waitForTimeout(300);
      check(`${tag}: Esc closes the menu`, (await page.locator(".tl-menu .menu-list").count()) === 0, await page.locator(".tl-menu .menu-list").count());
      // Reply to the assignee's answer: the box opens under its thread, its chip starts as the one it answers, and its list is open.
      await page.locator("#c" + a1 + " .tl-menu > button").scrollIntoViewIfNeeded(); await page.locator("#c" + a1 + " .tl-menu > button").click(); await page.waitForTimeout(400);
      await page.locator("#c" + a1 + " .tl-menu .menu-list button").first().click(); await page.waitForTimeout(600);
      const replyChip = (await page.locator(".tl-reply-box .tc-to").innerText()).replace(/\s+/g, " ");
      check(`${tag}: a reply's chip starts as the author of the comment it answers`, replyChip.includes(names[0]), replyChip);
      await page.locator(".tl-reply-box textarea").fill(c.lang === "en" ? "And what about ties?" : "平手怎麼算？");
      await page.locator(".tl-reply-box .tc-to").click(); await page.waitForTimeout(400);
      const groups = await page.locator(".tl-reply-box .menu-list .menu-heading").allInnerTexts();
      check(`${tag}: the chip lists the assignee and the other agents, and "No agent notified"`, groups.length >= 2 && (await page.locator(".tl-reply-box .menu-list button").count()) >= 3, groups);
      await page.evaluate(() => document.querySelector(".tl-reply-box")?.scrollIntoView({ block: "center" })); await page.waitForTimeout(300);
      await shot("3-reply");
    }
    // The activity stream (the comments, the comment box under them): the whole block, so the phone's long column shows too — read afresh,
    // last (the window is made tall for it and then put back).
    await page.goto(fx.base + `/ui/fleet/tasks?card=${card.code}`); await page.locator(".tp-activity .tl").waitFor(); await page.waitForTimeout(1200);
    await page.locator(".tl-more").first().click().catch(() => {});
    await shot("1-stream", ".tp-activity");
    check(`${tag}: no page errors`, errors.length === 0, errors);
    await page.context().close();
  }
} finally {
  await fx.close();
  const failed = receipt.checks.filter((x: any) => !x.ok).length;
  receipt.summary = `${receipt.checks.length - failed}/${receipt.checks.length}`;
  writeFileSync(join(OUT, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(`checks ${receipt.summary}`);
  process.exitCode = failed ? 1 : 0;
}
