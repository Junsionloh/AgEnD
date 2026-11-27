/**
 * The two together (`person_confirms_main` and the notice): a fleet that asks the person to confirm the main tasks its agents open
 * gets, when the last sub task is done, a main task in Review under Waiting for you, a "waits for your confirmation" notice on the
 * Notices page, and the Tasks unread says it is to confirm; the person confirming it ends all three.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { Scheduler } from "../src/scheduler/index.js";
import type { Actor } from "../src/scheduler/task-board.js";

const ANN: Actor = { kind: "person", name: "Ann" };
const LEAD: Actor = { kind: "instance", name: "lead" };
const DEV: Actor = { kind: "instance", name: "dev-a" };
const dirs: string[] = [], closers: Array<() => void> = [];
afterEach(() => { for (const c of closers.splice(0)) { try { c(); } catch { /* closed */ } } for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function fleet(personConfirmsMain: boolean) {
  const d = mkdtempSync(join(tmpdir(), "task-board-confirm-notice-")); dirs.push(d);
  vi.stubEnv("AGEND_HOME", d);
  writeFileSync(join(d, "fleet.yaml"), "defaults: {}\ninstances: {}\n");
  const fm = new FleetManager(d);
  const any = fm as any;
  fm.fleetConfig = { defaults: { task_board: { person_confirms_main: personConfirmsMain } }, instances: { lead: { working_directory: d }, "dev-a": { working_directory: d } } } as never;
  vi.spyOn(fm, "emitSseEvent").mockImplementation(() => {});
  any.ensureDeliveryOutbox();
  const scheduler = new Scheduler(join(d, "scheduler.db"), () => {}, { max_schedules: 100, default_timezone: "UTC", retry_count: 3, retry_interval_ms: 1000 }, () => false);
  any.scheduler = scheduler;
  any.attachTaskBoard(scheduler.db);
  scheduler.db.board.setCommentRouting({ instances: () => ["lead", "dev-a"], enabled: () => true });
  closers.push(() => { any.taskBoardWaker?.stop(); fm.stormWindow.shutdown(); fm.spawnGate.shutdown(); scheduler.db.close(); });
  return { fm, board: scheduler.db.board, notices: () => any.webNoticeStore().view().items as Array<Record<string, any>> };
}
const run = (f: ReturnType<typeof fleet>) => {
  const main = f.board.createCards(LEAD, { cards: [{ title: "Publish the report", assignee: "lead", acceptance: ["report attached"] }] }).cards[0]!;
  const sub = f.board.createCards(LEAD, { parent: main.code, cards: [{ title: "Draft", assignee: "dev-a" }] }).cards[0]!;
  f.board.unreadFor("Ann");
  f.board.moveCard(DEV, sub.code, "claimed");
  f.board.moveCard(DEV, sub.code, "done", { result: "drafted" });
  return main;
};

describe("on", () => {
  it("an agent's main task waits for the person, the Notices page says so, the unread says it is to confirm; confirming ends it", () => {
    const f = fleet(true);
    const main = run(f);
    expect(f.board.getCard(main.code).status).toBe("review");
    expect(f.board.waitingForPerson().map((w) => w.card.code)).toEqual([main.code]);
    expect(f.notices().map((n) => [n.kind, n.card, String(n.text).startsWith(`🔔 ${main.code} "Publish the report" waits for your confirmation`)])).toEqual([["task", main.code, true]]);
    expect(f.board.unreadFor("Ann").cards.map((u) => [u.id, u.reasons])).toEqual([[main.code, ["review"]]]);
    f.board.moveCard(ANN, main.code, "done", { comment: "thanks" });
    expect(f.board.waitingForPerson()).toEqual([]);
    expect(f.notices()).toHaveLength(1);                          // the person's own move is not told back to them
  });
});

describe("off (the default)", () => {
  it("the main task finishes by itself, and the person is told so: a notice, and Finished on the Tasks page", () => {
    const f = fleet(false);
    const main = run(f);
    expect(f.board.getCard(main.code).status).toBe("done");
    expect(f.notices().map((n) => [n.kind, n.card, String(n.text).startsWith(`✅ ${main.code} "Publish the report" finished by itself`)])).toEqual([["task", main.code, true]]);
    expect(f.board.unreadFor("Ann").cards.map((u) => [u.id, u.reasons])).toEqual([[main.code, ["finished"]]]);
  });
});
