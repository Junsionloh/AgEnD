/**
 * AGEND-369 real-app captures: a main task says what its sub tasks' agents are really doing, and how the baton passes. The real web app and task
 * board (scripts/manual/smoke-fixture, a scratch scheduler database of made-up cards); no fleet, CLI or account. The fleet's own waker hands the
 * hand-over notices to a real delivery outbox; the script only moves one row on (delivered, consumed — what a running agent's transcript does),
 * sets what each instance's state is as the status frames say it, and answers the steps route (`/ui/steps`, which needs a live backend's transcript)
 * with real steps parsed from a Claude transcript line.
 *   REPO=<checkout> PW_DIR=<playwright-core root> CHROME=<chrome> OUT=<dir> PHASE=before|after \
 *     npx tsx scripts/manual/task-parent-live-agend369/capture.mts
 * `before` runs against the release without them (AGEND-367's branch: the same cards moved the same way — no line under a sub task, no handoff row, the
 * block says "The work is in its sub tasks"), `after` against this branch. Both write the same pictures' names, so a pair is one name in two folders.
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
const ROSTER = ["game-designer", "game-dev", "game-qa", "game-ops", "game-art", "game-sound"].map((name, i) => ({ name, backend: "claude-code" as const, status: "running" as const, description: ["Designs", "Builds", "Tests", "Ships", "Draws", "Scores"][i] }));
const fx = await bootFixture({ port: 0, roster: ROSTER, instances: ROSTER.length, classic: false });
try {
  const { Scheduler, DEFAULT_SCHEDULER_CONFIG } = await import(REPO + "/src/scheduler/index.ts");
  const { ClaudeStepParser } = await import(REPO + "/src/log-steps.ts");
  const fm = fx.fm;
  fm.scheduler?.db.close();
  fm.scheduler = new Scheduler(join(fm.dataDir, "flow-example.db"), () => {}, DEFAULT_SCHEDULER_CONFIG, () => true);
  const [designer, dev, qa, ops, art, sound] = ROSTER.map((r) => r.name);
  // `game-ops` is offline; `game-dev`, `game-art` and `game-sound` are working while the pictures are taken.
  const was = fm.getInstanceStatus.bind(fm);
  fm.getInstanceStatus = (n: string) => (n === ops ? "stopped" : was(n));
  fm.getInstanceExecutionState = (n: string) => ([dev, art, sound].includes(n) ? "working" : "idle");
  fm.attachTaskBoard(fm.scheduler.db);
  const board = fm.scheduler.db.board;
  board.setCommentRouting({ instances: () => ROSTER.map((r) => r.name), enabled: () => true });
  const handoffs = typeof board.handoffsOf === "function";
  const person = { kind: "person", name: "Example owner" } as const;
  const as = (name: string) => ({ kind: "instance", name }) as const;
  const project = board.createProject(person, { name: "Example project" });

  /** A main task with S-1 (designer), S-2 (`second`, after S-1) and S-3 (qa, after S-2); S-1 is finished. */
  function plan(title: string, goal: string, second: string, independent = false) {
    const main = board.createCards(person, { cards: [{ title, goal, project: project.id, needsReview: false }] }).cards[0];
    const mk = (t: string, assignee: string, dependsOn?: string[]) => board.createCards(person, { cards: [{ parent: main.code, title: t, assignee, needsReview: false, ...(dependsOn ? { dependsOn } : {}) }] }).cards[0];
    const s1 = mk("Game design doc · 遊戲設計文件", designer);
    // `independent`: S-2 does not wait for S-1 (as a plan whose steps run side by side): its assignee is told at once, "assigned to you".
    const s2 = mk("Playable prototype · 可玩原型 (single .html)", second, independent ? undefined : [s1.code]);
    const s3 = mk("QA and balance pass · 測試與平衡", qa, [s2.code]);
    board.moveCard(as(designer), s1.code, "claimed");
    board.updateCard(as(designer), s1.code, { log: "Outline and the three enemy types are in the doc · 大綱與三種敵人都寫進文件了" });
    board.moveCard(as(designer), s1.code, "done", { result: "Design doc written: waves, enemies, upgrade tree · 設計文件完成" });
    return { main, s1, s2, s3 };
  }
  const A = plan("RPG shooter · RPG 射擊遊戲", "Design and build a playable RPG shooter prototype (single HTML file) · 設計並做出可玩的 RPG 射擊原型", dev);
  const B = plan("Card game · 卡牌遊戲", "A two-player card game, shipped as one page · 兩人卡牌遊戲，單頁發佈", ops);
  // C and D: the assignee is working on S-2 and has NOT claimed it (the preview's survivor-dev did exactly this). D has gone on for six minutes.
  const C = plan("Survivor game · 生存遊戲", "S-2's agent started on it without claiming it · S-2 的 agent 沒有認領就開始做了", art, true);
  const D = plan("Puzzle game · 益智遊戲", "The same, for six minutes now · 同樣的情形，已經六分鐘了", sound, true);
  await sleep(11500);                                                    // the waker's window (10 s): the hand-over notices are in the outbox now
  if (handoffs) {
    // What the agent's transcript would do: S-2's notice to `game-dev` is delivered, and the CLI took it up.
    const key = board.handoffsOf([A.s2.uuid]).find((h: any) => h.to === dev)?.key;
    check("S-2's handoff to game-dev carries the outbox's key", !!key, board.handoffsOf([A.s2.uuid]));
    const now = new Date().toISOString();
    fm.deliveryOutbox.db.prepare("UPDATE deliveries SET state='delivered', finished_at=?, consumed_at=?, consumed_via='turn', updated_at=? WHERE source_key=?").run(now, now, now, key);
    const queued = board.handoffsOf([B.s2.uuid]).find((h: any) => h.to === ops);
    check("S-2 of the other plan is queued for the offline instance", !!queued?.key, board.handoffsOf([B.s2.uuid]));
    // C and D: the notices reached their agents (delivered, and the CLI took them up); D's card was handed over six minutes ago.
    for (const [plan2, who] of [[C, art], [D, sound]] as const) {
      const k = board.handoffsOf([plan2.s2.uuid]).find((h: any) => h.to === who)?.key;
      check(`S-2 assignment notice to ${who} carries the outbox's key`, !!k, board.handoffsOf([plan2.s2.uuid]));
      fm.deliveryOutbox.db.prepare("UPDATE deliveries SET state='delivered', finished_at=?, consumed_at=?, consumed_via='turn', updated_at=? WHERE source_key=?").run(now, now, now, k);
    }
    const long = new Date(Date.now() - 6 * 60_000).toISOString();
    fm.scheduler.db.db.prepare("UPDATE task_handoffs SET at = ? WHERE task_id = ?").run(long, D.s2.uuid);
    fm.scheduler.db.db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(long, D.s2.uuid);
  }
  // game-dev takes S-2 (its own claim).
  board.moveCard(as(dev), A.s2.code, "claimed");
  board.updateCard(as(dev), A.s2.code, { log: "Player movement and the first enemy are in · 玩家移動與第一種敵人完成" });
  await sleep(600);

  // The steps route needs a live backend; the script answers it with real steps parsed from a Claude transcript line.
  const toolLine = (ms: number, name: string, input: Record<string, unknown>) => JSON.stringify({ type: "assistant", uuid: `a${ms}`, timestamp: new Date(ms).toISOString(), message: { role: "assistant", content: [{ type: "tool_use", id: `toolu_${ms}`, name, input }] } });
  const stepAnswer = (instance: string) => {
    const parser = new ClaudeStepParser({ thinking: false });
    [toolLine(Date.now() - 30_000, "Read", { file_path: "/w/game/enemies.js" }), toolLine(Date.now() - 12_000, "Edit", { file_path: "/w/game/enemy-ai.js", old_string: "a", new_string: "b" })].forEach((l, i) => parser.push(l, i * 1000));
    return { enabled: true, instance, backend: "claude-code", supported: true, thinking: false, level: "standard", cwd: "/w", home: "/h", steps: parser.steps, after: 100, key: "1-2", before: null, ev: 0 };
  };

  for (const c of matrix()) {
    // C's agent has been working for a few seconds in every picture, however long the run has taken: its hand-over is made fresh each time (D's stays six minutes old).
    if (handoffs) {
      const fresh = new Date().toISOString();
      fm.scheduler.db.db.prepare("UPDATE task_handoffs SET at = ? WHERE task_id = ?").run(fresh, C.s2.uuid);
      fm.scheduler.db.db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(fresh, C.s2.uuid);
    }
    const p = await fx.page(c, { storage: { agend_tasks_project: String(project.id) } }), page = p.page, tag = `${c.device}-${c.theme}-${c.lang}`, phone = c.device === "phone", errors: string[] = [];
    await page.emulateMedia({ reducedMotion: "reduce" });
    page.on("pageerror", (e: Error) => errors.push(e.message));
    await page.route("**/ui/steps*", (route: any) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(stepAnswer(new URL(route.request().url()).searchParams.get("instance") ?? dev)) }));
    const shot = async (name: string, target?: string) => {
      await page.waitForTimeout(500);
      const path = `${tag}-${name}.png`;
      if (target) {
        const size = page.viewportSize();
        await page.setViewportSize({ width: size.width, height: 3200 }); await page.waitForTimeout(500);
        await page.locator(target).first().screenshot({ path: join(OUT, path) });
        await page.setViewportSize(size); await page.waitForTimeout(300);
      } else await page.screenshot({ path: join(OUT, path) });
      receipt.pictures.push({ path, sha256: createHash("sha256").update(readFileSync(join(OUT, path))).digest("hex") });
    };
    const text = async (sel: string) => ((await page.locator(sel).allInnerTexts()).join(" | ")).replace(/\s+/g, " ");
    const words = c.lang === "en"
      ? { running: /Running|Edit|enemy-ai/, handedRead: /read it/, offline: /is offline/, waits: /Waits for S-2/, started: /started S-2/, doneTo: /S-1 done → handed to game-dev to start S-2/, quiet: /The work is in its sub tasks/, unclaimed: /not claimed yet/, late: /still not claimed/, contradiction: /not started yet|is working…/, mark: /Running · not claimed/ }
      : { running: /執行中|Edit|enemy-ai/, handedRead: /已讀/, offline: /離線/, waits: /等 S-2/, started: /已開始 S-2/, doneTo: /S-1 完成 → 已交給 game-dev 開始 S-2/, quiet: /工作在子任務裡/, unclaimed: /尚未認領/, late: /還是沒有認領/, contradiction: /這張還沒開始|處理中…/, mark: /執行中・尚未認領/ };

    // The board: the tile of the plan whose agent is working says so.
    await page.goto(fx.base + "/ui/fleet/tasks"); await page.locator(`[data-tile="${A.main.code}"]`).waitFor(); await page.waitForTimeout(1800);
    check(`${tag}: the main task's tile is Running while its sub task's agent is (as before)`, (await page.locator(`[data-tile="${A.main.code}"].running`).count()) === 1);
    await shot("1-board");
    // The main task whose sub task is running.
    await page.locator(`[data-tile="${A.main.code}"] .tb-tile-title`).click(); await page.locator(".tp-activity .tl").waitFor(); await page.waitForTimeout(2600);
    if (PHASE === "after") {
      const row = (id: string) => page.locator(`.tp-subs .tc-children li:has(.tb-code:text-is("${id}"))`);
      check(`${tag}: ${(await page.evaluate(() => document.body.dataset.chatActivity)) === "1" ? "steps are offered (an admin session)" : "steps are not offered"}`, (await page.evaluate(() => document.body.dataset.chatActivity)) === "1");
      const line = (await row(A.s2.code).locator(".tc-child-line").innerText()).replace(/\s+/g, " ");
      check(`${tag}: S-2's row says what its agent is doing (a turning ring and the step)`, words.running.test(line) && line.includes(dev) && (await row(A.s2.code).locator(".tc-child-line .out-spin").count()) === 1, line);
      check(`${tag}: S-3's row says it waits for S-2`, words.waits.test(await row(A.s3.code).locator(".tc-child-line").innerText()));
      check(`${tag}: S-1 (done) has no line`, (await row(A.s1.code).locator(".tc-child-line").count()) === 0);
      check(`${tag}: the Agent activity block lists S-2's agent, not "the work is in its sub tasks"`, (await page.locator(".tr-run .tf-lines").count()) === 1 && !words.quiet.test(await text(".tr-run")), await text(".tr-run"));
      check(`${tag}: "Running" beside the status`, (await page.locator(".tp-idrow .tr-mark").count()) === 1, await text(".tp-idrow"));
      const baton = (await text(".tl-baton")).replace(/\s+/g, " ");
      check(`${tag}: the activity has the handoff row, settled by S-2 starting`, words.doneTo.test(baton) && words.started.test(baton), baton);
    } else {
      check(`${tag}: nothing under the sub tasks, the block is the one quiet line`, (await page.locator(".tc-child-line").count()) === 0 && words.quiet.test(await text(".tr-run")), await text(".tr-run"));
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot("2-card-running", ".tp");
    // The plan whose next agent is offline.
    await page.goto(fx.base + "/ui/fleet/tasks"); await page.locator(`[data-tile="${B.main.code}"]`).waitFor(); await page.waitForTimeout(1200);
    await page.locator(`[data-tile="${B.main.code}"] .tb-tile-title`).click(); await page.locator(".tp-activity .tl").waitFor(); await page.waitForTimeout(2200);
    if (PHASE === "after") {
      const s2 = (await page.locator(`.tp-subs .tc-children li:has(.tb-code:text-is("${B.s2.code}")) .tc-child-line`).innerText()).replace(/\s+/g, " ");
      check(`${tag}: S-2's row says the next agent is offline and gets it when it is back`, words.offline.test(s2), s2);
      check(`${tag}: the block lists the hand-over`, words.offline.test(await text(".tr-run .tf-lines")), await text(".tr-run"));
      check(`${tag}: the handoff row names who has the baton, and says it is offline`, (await text(".tl-baton")).includes(ops) && words.offline.test(await text(".tl-baton")), await text(".tl-baton"));
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot("3-card-handoff", ".tp");
    // The plans whose agent is working on S-2 without having claimed it: fresh (C), and for six minutes (D).
    for (const [P, who, name, late] of [[C, art, "4-card-unclaimed", false], [D, sound, "5-card-unclaimed-late", true]] as const) {
      await page.goto(fx.base + "/ui/fleet/tasks"); await page.locator(`[data-tile="${P.main.code}"]`).waitFor(); await page.waitForTimeout(1200);
      if (PHASE === "after") check(`${tag}: the board's tile of ${P.main.code} lights up as Running · not claimed`, (await page.locator(`[data-tile="${P.main.code}"].running`).count()) === 1 && words.mark.test(await text(`[data-tile="${P.main.code}"] .tr-mark`)), await text(`[data-tile="${P.main.code}"]`));
      await page.locator(`[data-tile="${P.main.code}"] .tb-tile-title`).click(); await page.locator(".tp-activity .tl").waitFor(); await page.waitForTimeout(2600);
      if (PHASE === "after") {
        const line = (await page.locator(`.tp-subs .tc-children li:has(.tb-code:text-is("${P.s2.code}")) .tc-child-line`).innerText()).replace(/\s+/g, " ");
        check(`${tag}: ${P.s2.code}'s row: the agent running, with the step and the ring, marked not claimed${late ? " — and flagged" : ""}`, line.includes(who) && words.running.test(line) && (late ? words.late : words.unclaimed).test(line) && (await page.locator(`.tp-subs .tc-children li:has(.tb-code:text-is("${P.s2.code}")) .out-spin`).count()) === 1, line);
        if (late) check(`${tag}: the flagged line has the warning look`, (await page.locator(`.tp-subs .tc-children li:has(.tb-code:text-is("${P.s2.code}")) .tc-child-line.tf-warn`).count()) === 1);
        check(`${tag}: the block, the handoff row and the status say it too`, words.unclaimed.test(await text(".tr-run .tf-lines")) || words.late.test(await text(".tr-run .tf-lines")), await text(".tr-run"));
        check(`${tag}: the handoff row has the running line with the ring`, (await page.locator(".tl-baton .tl-wake .out-spin").count()) >= 1 && words.running.test(await text(".tl-baton .tl-wake")), await text(".tl-baton"));
        check(`${tag}: "Running · not claimed" beside the status`, words.mark.test(await text(".tp-idrow .tr-mark")), await text(".tp-idrow"));
        check(`${tag}: no "working" beside "not started"`, !words.contradiction.test(await text(".tp")), await text(".tp-subs"));
      } else {
        check(`${tag}: ${P.main.code} before: the row says nothing, the handoff row has no running line`, (await page.locator(".tc-child-line").count()) === 0 && (await page.locator(".out-spin").count()) === 0);
      }
      await page.evaluate(() => window.scrollTo(0, 0));
      await shot(name, ".tp");
    }
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
