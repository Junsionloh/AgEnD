/**
 * #2560: an idle person in a zones office now and then strolls near their seat and back.
 * - wanderTarget: AWAY ms of every PERIOD (each name its own phase) at a waypoint within REACH of the seat that no seat
 *   is on, picked anew each turn; the seat the rest of the time, and always when no waypoint is near.
 * - walkTargets: only the idle wander; everyone else (working, asleep, calling) is at their seat; `wander` off → seats;
 *   two never stand on one spot (the second stays seated that turn).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { page, type AppPage } from "./helpers/app-harness.js";

let p: AppPage;
let Z: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet/org" });
  Z = await import("/ui/js/fleet-office-zones.js");
});
afterAll(async () => { await p.unmount(); p.restore(); });

const SEAT = { x: 400, y: 400 };
const GRAPH = { waypoints: [{ id: "a", x: 500, y: 400 }, { id: "b", x: 400, y: 300 }, { id: "on-seat", x: 400, y: 400 }, { id: "far", x: 1000, y: 100 }], edges: [] };
const at = (name: string, t: number) => Z.wanderTarget(name, SEAT, GRAPH, t, [SEAT]);

describe("wanderTarget", () => {
  it("away for AWAY ms of every PERIOD, at a near waypoint no seat is on; at the seat the rest", () => {
    const { PERIOD, AWAY } = Z.WANDER;
    const samples = Array.from({ length: PERIOD / 500 }, (_, i) => at("atlas", i * 500));
    const away = samples.filter((q: any) => q !== SEAT);
    expect(away.length * 500).toBe(AWAY);
    for (const q of away) expect(["500,400", "400,300"]).toContain(`${q.x},${q.y}`);   // never the far one, never on a seat
  });
  it("each name its own phase; the spot changes from turn to turn (over a few turns both near ones are used)", () => {
    const { PERIOD } = Z.WANDER;
    const firstAway = (n: string) => Array.from({ length: PERIOD / 500 }, (_, i) => i * 500).find((t) => at(n, t) !== SEAT);
    expect(new Set(["atlas", "quill", "sage", "orbit"].map(firstAway)).size).toBeGreaterThan(1);
    const spots = new Set<string>();
    for (let turn = 0; turn < 12; turn++) for (let t = turn * PERIOD; t < (turn + 1) * PERIOD; t += 500) { const q = at("atlas", t); if (q !== SEAT) spots.add(`${q.x},${q.y}`); }
    expect([...spots].sort()).toEqual(["400,300", "500,400"]);
  });
  it("no waypoint near: always the seat", () => {
    const lone = { waypoints: [{ id: "far", x: 1000, y: 100 }], edges: [] };
    expect(Array.from({ length: 80 }, (_, i) => Z.wanderTarget("atlas", SEAT, lone, i * 500, [SEAT])).every((q: any) => q === SEAT)).toBe(true);
  });
});

describe("walkTargets", () => {
  const desks = [
    { node: { name: "atlas", state: "idle" }, seat: SEAT },
    { node: { name: "quill", state: "working" }, seat: { x: 100, y: 100 } },
    { node: { name: "sage", state: "paused" }, seat: { x: 200, y: 600 } },
  ];
  it("only the idle wander; the rest are at their seats; wander off → everyone at their seat", () => {
    const { PERIOD } = Z.WANDER;
    const ts = Array.from({ length: PERIOD / 500 }, (_, i) => i * 500);
    const moved = (name: string, on = true) => ts.some((t) => { const m = Z.walkTargets(desks, GRAPH, t, on); const d = desks.find((x) => x.node.name === name)!; return m.get(name) !== d.seat; });
    expect([moved("atlas"), moved("quill"), moved("sage")]).toEqual([true, false, false]);
    expect(moved("atlas", false)).toBe(false);
  });
  it("two never share a spot: whoever would stands at their seat that turn", () => {
    const one = { waypoints: [{ id: "a", x: 500, y: 400 }], edges: [] };
    const two = [{ node: { name: "atlas", state: "idle" }, seat: SEAT }, { node: { name: "quill", state: "idle" }, seat: { x: 420, y: 420 } }];
    for (let t = 0; t < 4 * Z.WANDER.PERIOD; t += 500) {
      const m = Z.walkTargets(two, one, t);
      const spots = [...m.values()].filter((q: any, i: number) => q !== two[i].seat).map((q: any) => `${q.x},${q.y}`);
      expect(new Set(spots).size).toBe(spots.length);
    }
  });
  it("never onto a seat of the office, even a free one (someone may be about to sit there)", () => {
    const g = { ...GRAPH, waypoints: [...GRAPH.waypoints, { id: "free", x: 450, y: 350 }], areas: { lounge: { seats: [SEAT, { x: 450, y: 350 }] } } };
    const lone = [{ node: { name: "atlas", state: "idle" }, seat: SEAT }];
    for (let t = 0; t < 4 * Z.WANDER.PERIOD; t += 500) { const q = Z.walkTargets(lone, g, t).get("atlas"); expect(`${q.x},${q.y}`).not.toBe("450,350"); }
  });
});
