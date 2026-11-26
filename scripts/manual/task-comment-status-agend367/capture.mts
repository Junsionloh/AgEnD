/**
 * AGEND-367 real-app captures: where a task card's comments stand, and what is new for the person. The real web app and task board
 * (scripts/manual/smoke-fixture, a scratch scheduler database of made-up cards); no fleet, CLI or account. The fleet's own waker hands the
 * comments to a real delivery outbox; the script only moves two of its rows on (delivered, consumed — what a running agent's transcript
 * does) and sets what each instance's state is, as the status frames say it.
 *   REPO=<checkout> PW_DIR=<playwright-core root> CHROME=<chrome> OUT=<dir> PHASE=before|after \
 *     npx tsx scripts/manual/task-comment-status-agend367/capture.mts
 * `before` runs against the release without them (AGEND-365's branch: the same comments, nothing under them, no dot, no strip, no number),
 * `after` against this branch. Both write the same pictures' names (`<combination>-1-board.png`, `-2-card.png`), so a pair is one name in
 * two folders.
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fx = await bootFixture({ port: 0, instances: 3, classic: false });
try {
  const { Scheduler, DEFAULT_SCHEDULER_CONFIG } = await import(REPO + "/src/scheduler/index.ts");
  const fm = fx.fm;
  fm.scheduler?.db.close();
  fm.scheduler = new Scheduler(join(fm.dataDir, "status-example.db"), () => {}, DEFAULT_SCHEDULER_CONFIG, () => true);
  const names = fx.instances.map((i: any) => i.name);
  const [worker, away, quiet] = names;
  // `away` is offline; `quiet` has the task board switched off; `worker` is working while the pictures are taken.
  fm.fleetConfig.instances[quiet] = { ...fm.fleetConfig.instances[quiet], dashboard: { ...(fm.fleetConfig.instances[quiet]?.dashboard ?? {}), task_board: false } };
  const was = fm.getInstanceStatus.bind(fm);
  fm.getInstanceStatus = (n: string) => (n === away ? "stopped" : was(n));
  fm.getInstanceExecutionState = (n: string) => (n === worker ? "working" : "idle");
  fm.attachTaskBoard(fm.scheduler.db);
  const board = fm.scheduler.db.board;
  const dev = { kind: "instance", name: worker } as const;
  board.setCommentRouting({ instances: () => names, enabled: () => true });
  const probe = await fx.page({ device: "desk", theme: "light", lang: "en" });
  const project = board.createProject({ kind: "person", name: "Example owner" }, { name: "Example project" });
  const scratch = board.createCards({ kind: "person", name: "Example owner" }, { cards: [{ title: "Scratch", project: project.id }] }).cards[0];
  const viewer = await probe.page.evaluate(async (code: string) => (await (await fetch(`/ui/tasks/cards/${code}`)).json()).viewer ?? null, scratch.code);
  await probe.ctx.close();
  const me = { kind: "person", name: viewer?.name ?? "web-user" } as const;
  receipt.viewer = viewer ? { name: me.name } : null;
  const status = typeof board.entryWakes === "function";
  const card = board.createCards(me, { cards: [{ title: "Serve the weekly leaderboard · 週排行榜上線", assignee: worker, project: project.id,
    goal: "Players see their rank every week · 玩家每週都看得到自己的名次" }] }).cards[0];
  board.moveCard(me, card.code, "claimed");
  if (status) board.unreadFor(me.name);                                  // this person's floor: what comes after is news
  const say = (by: any, text: string, extra: Record<string, unknown> = {}) => { board.updateCard(by, card.code, { comment: text, ...extra }); return board.detail(card.code).comments.at(-1).id as number; };
  // 1. a question, answered (the answer is unread, and the question's status is "replied")
  say(me, "Is the **ranking** weekly? · 排行榜是每週重置嗎？", { to: [worker] });
  say(dev, "Yes — it resets on Monday at 00:00. · 對，每週一 00:00 重置。");
  // 2. a comment to the working agent (it names an agent with the board off) and one to an offline agent
  const working = say(me, `Please handle ties too. · 平手也請處理。 @${quiet}, can you check the docs? · 可以幫忙看一下文件嗎？`, { to: [worker] });
  const offline = say(me, `@${away} please review when you are back. · 回來之後請幫忙 review。`, { to: [] });
  await sleep(11500);                                                    // the waker's window (10 s): the notices are in the outbox now
  let sending = 0;
  if (status) {
    // What the agent's transcript would do: the notice to `worker` is delivered, and the CLI took it up.
    const key = board.entryWakes(card.code).get(working)!.find((w: any) => w.to === worker)!.key;
    const now = new Date().toISOString();
    fm.deliveryOutbox.db.prepare("UPDATE deliveries SET state='delivered', finished_at=?, consumed_at=?, consumed_via='turn', updated_at=? WHERE source_key=?").run(now, now, now, key);
    // 3. a comment just written: it has not gone to delivery yet (the waker takes 10 s). Kept so by writing it past the waker.
    sending = say(me, "And a last one, just sent. · 還有一則剛送出的。", { to: [] });
    const future = new Date(Date.now() + 3_600_000).toISOString();
    fm.scheduler.db.db.prepare("UPDATE task_entries SET wakes = ? WHERE id = ?").run(JSON.stringify([{ to: worker, why: "assignee", at: future }]), sending);
  } else say(me, "And a last one, just sent. · 還有一則剛送出的。", { to: [] });
  receipt.comments = board.detail(card.code).comments.map((e: any) => ({ id: e.id, by: e.author, parentId: e.parentId ?? null }));
  const words = (lang: string) => lang === "en"
    ? { read: /read it/, working: /is working…/, replied: /replied/, offline: /is offline/, off: /task board is off/, sending: /Sent to/ }
    : { read: /已讀/, working: /處理中/, replied: /已回覆/, offline: /離線/, off: /任務板是關閉的/, sending: /已送給/ };
  for (const c of matrix()) {
    const p = await fx.page(c, { storage: { agend_tasks_project: String(project.id) } }), page = p.page, tag = `${c.device}-${c.theme}-${c.lang}`, phone = c.device === "phone", errors: string[] = [];
    await page.emulateMedia({ reducedMotion: "reduce" });
    page.on("pageerror", (e: Error) => errors.push(e.message));
    if (status) fm.scheduler.db.db.prepare("DELETE FROM task_card_reads WHERE person = ?").run(me.name);          // each picture starts from "not opened yet"
    const shot = async (name: string, target?: string) => {
      await page.waitForTimeout(400);
      const path = `${tag}-${name}.png`;
      if (target) {
        const size = page.viewportSize();
        await page.setViewportSize({ width: size.width, height: 2600 }); await page.waitForTimeout(400);
        await page.locator(target).first().screenshot({ path: join(OUT, path) });
        await page.setViewportSize(size); await page.waitForTimeout(300);
      } else await page.screenshot({ path: join(OUT, path) });
      receipt.pictures.push({ path, sha256: createHash("sha256").update(readFileSync(join(OUT, path))).digest("hex") });
    };
    // The board: a dot on the card's tile, the strip above it, the number on the sidebar's Fleet row (not on a phone's drawer, M-3166).
    await page.goto(fx.base + "/ui/fleet/tasks"); await page.locator(`[data-tile="${card.code}"]`).waitFor(); await page.waitForTimeout(1800);
    if (PHASE === "after") {
      check(`${tag}: the card's tile has a dot`, (await page.locator(`[data-tile="${card.code}"] .tb-unread`).count()) === 1);
      const strip = (await page.locator(".tb-unread-strip").innerText()).replace(/\s+/g, " ");
      check(`${tag}: the strip names the card and says who answered`, strip.includes(card.code) && strip.includes(worker), strip);
      if (!phone) check(`${tag}: the sidebar's Fleet row says 1`, (await page.locator("#sidebar .task-unread-count").innerText()) === "1", await page.locator("#sidebar .task-unread-count").count());
      else check(`${tag}: a phone's drawer has no count (M-3166)`, (await page.locator("#sidebar .task-unread-count:visible").count()) === 0);
    }
    await shot("1-board");
    // The card: opened from its tile; its new comments tagged, and read a moment later.
    await page.locator(`[data-tile="${card.code}"] .tb-tile-title`).click(); await page.locator(".tp-activity .tl").waitFor(); await page.waitForTimeout(2400);
    if (PHASE === "after") {
      const w = words(c.lang);
      const under = async (id: number) => ((await page.locator(`#c${id} .tl-wakes`).allInnerTexts()).join(" ")).replace(/\s+/g, " ");
      const ids = board.detail(card.code).comments.map((e: any) => e.id as number);
      check(`${tag}: the answered question says "replied"`, w.replied.test(await under(ids[0]!)), await under(ids[0]!));
      check(`${tag}: the comment to the working agent says it is working`, w.working.test(await under(working)), await under(working));
      check(`${tag}: …and that the agent with the board off was not woken`, w.off.test(await under(working)), await under(working));
      check(`${tag}: the comment to the offline agent says it is offline`, w.offline.test(await under(offline)), await under(offline));
      check(`${tag}: a comment just sent says it was sent`, w.sending.test(await under(sending)), await under(sending));
      check(`${tag}: the answer is tagged New`, (await page.locator(".tl-new").count()) >= 1, await page.locator(".tl-new").count());
      const after = await page.evaluate(async () => (await (await fetch("/ui/tasks/unread")).json()));
      check(`${tag}: opening the card marked it read`, after.total === 0, after);
      if (!phone) check(`${tag}: …and the sidebar's number is gone`, (await page.locator("#sidebar .task-unread-count").count()) === 0);
    }
    await page.evaluate(() => document.querySelector(".tp-activity")?.scrollIntoView({ block: "start" })); await page.waitForTimeout(300);
    await shot("2-card", ".tp-activity");
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
