/**
 * #2564: mail from another office — something sent to a person in this (zones) office by someone not in it flies in at
 * the door, lands near the middle of the room, and waits; the person walks over, picks it up, and walks back.
 * - dropPoint: the waypoint nearest the room's middle that no seat of the office is on (taken or free), letters side by
 *   side, the offset spot checked too; else the nearest point round the middle no seat is on; else none (not delivered).
 * - createMail: only to someone here from someone not here; not with reduced motion, nor stale, nor seen before;
 *   flies door → drop, then waits on the floor (t 0); targets → the drop for its person (not while asleep);
 *   picked up when its person stands on it; gone after MAX_WAIT, or when its person leaves the office; `prime` marks
 *   what was already in the air as seen (another office's or style's mail starts empty — the page makes one per office).
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

const desk = (name: string, state: string, x: number, y: number) => ({ key: name, node: { name, state }, seat: { x, y } });
const office = (desks: any[]) => ({ mode: "zones", width: 1280, height: 720, door: { x: 640, y: 700 }, rooms: [{ desks }],
  waypoints: [{ id: "hall", x: 640, y: 600 }, { id: "mid", x: 600, y: 400 }, { id: "on-seat", x: 640, y: 396 }], edges: [["hall", "mid"]] });
const L = office([desk("ran", "idle", 640, 396), desk("dean", "paused", 200, 200)]);
const item = (id: string, from: string, to: string, extra: any = {}) => ({ id, from, to, kind: "send", ...extra });
const walkersAt = (pos: Record<string, any>) => ({ at: (n: string) => pos[n] || null });

describe("dropPoint", () => {
  it("the waypoint nearest the middle that no seat is on; letters side by side; no free waypoint: the middle", () => {
    expect(Z.dropPoint(L)).toEqual({ x: 600, y: 400 });                       // on-seat is nearer but a seat is on it
    expect(Z.dropPoint(L, 2)).toEqual({ x: 600 + 2 * Z.MAIL.GAP, y: 400 });
    const fallback = Z.dropPoint({ ...L, waypoints: [] });                     // the middle is ran's seat (640, 396)
    expect(fallback).not.toBeNull();
    expect(Math.hypot(fallback.x - 640, fallback.y - 396)).toBeGreaterThanOrEqual(4);
  });
});

describe("dropPoint: never on a seat of the office (review of #2565)", () => {
  it("a free seat (in the areas, nobody on it) is avoided too, not only taken ones", () => {
    const withFree = { ...L, areas: { lounge: { seats: [{ x: 600, y: 400 }] } } };      // a seat on the nearest waypoint, nobody on it
    expect(Z.dropPoint(withFree)).toEqual({ x: 640, y: 600 });                            // the next nearest: the hall
  });
  it("the offset spot is checked too: a letter n GAPs along that would land on a seat goes to the next waypoint", () => {
    const n = 2, onOffset = { ...L, areas: { lounge: { seats: [{ x: 600 + n * Z.MAIL.GAP, y: 400 }] } } };
    expect(Z.dropPoint(onOffset, 0)).toEqual({ x: 600, y: 400 });                         // the first letter is fine
    expect(Z.dropPoint(onOffset, n)).toEqual({ x: 640 + n * Z.MAIL.GAP, y: 600 });         // the third moves on
  });
});

describe("dropPoint's fallback: off every seat too (review of #2565)", () => {
  const off = (p: any, seats: any[]) => seats.every((q) => Math.hypot(p.x - q.x, p.y - q.y) >= 4);
  it("no waypoints: an occupied seat at the middle → a point round it, off every seat", () => {
    const p = Z.dropPoint({ ...L, waypoints: [] });
    expect(off(p, [{ x: 640, y: 396 }, { x: 200, y: 200 }])).toBe(true);
  });
  it("every waypoint blocked, a free seat at the middle and one on the first ring → further out, off every seat", () => {
    const seats = [{ x: 640, y: 396 }, { x: 640 + 2 * Z.MAIL.GAP, y: 396 }];
    const blocked = { ...L, waypoints: seats.map((q, i) => ({ id: `w${i}`, ...q })), areas: { lounge: { seats } } };
    const p = Z.dropPoint(blocked);
    expect(p).not.toBeNull();
    expect(off(p, [...seats, { x: 200, y: 200 }])).toBe(true);
    expect(off(Z.dropPoint(blocked, 3), seats)).toBe(true);                               // with an offset too
  });
  it("nowhere off the seats (a room that is all seat): none — and no letter is delivered there", () => {
    const tiny = { ...office([desk("ran", "idle", 4, 4)]), width: 8, height: 8, waypoints: [], door: { x: 4, y: 8 } };
    expect(Z.dropPoint(tiny)).toBeNull();
    const m = Z.createMail();
    expect(m.sync([item("9", "xiaojie", "ran")], 0, tiny)).toBe(0);
    expect(m.size()).toBe(0);
  });
});

describe("createMail", () => {
  it("a letter only to someone here from someone not here; none still, stale, or seen before", () => {
    const m = Z.createMail();
    expect(m.sync([item("1", "xiaojie", "ran")], 0, L)).toBe(1);
    expect(m.sync([item("1", "xiaojie", "ran")], 0, L)).toBe(0);              // seen
    expect(m.sync([item("2", "dean", "ran")], 0, L)).toBe(0);                 // both here: an ordinary flight
    expect(m.sync([item("3", "ran", "xiaojie")], 0, L)).toBe(0);              // to someone elsewhere
    expect(m.sync([item("4", "xiaojie", "ran", { phase: "stale" })], 0, L)).toBe(0);
    expect(m.sync([item("5", "xiaojie", "ran")], 0, L, true)).toBe(0);        // reduced motion
    expect(m.sync([item("6", "xiaojie", "ran")], 0, { ...L, mode: "desks" })).toBe(0);
    expect(m.size()).toBe(1);
  });
  it("flies in at the door, then waits on the floor; its person is sent to it, picks it up by standing on it", () => {
    const m = Z.createMail();
    m.sync([item("1", "xiaojie", "ran")], 0, L);
    const away = walkersAt({ ran: { x: 640, y: 396, walking: false } });
    const f0 = m.frame(1, L, away);
    expect(f0).toHaveLength(1);
    expect(f0[0].t).toBeGreaterThan(0);
    expect(Math.round(f0[0].y)).toBeGreaterThan(400);                          // near the door, on its way
    expect(m.targets(L, 1).size).toBe(0);                                      // still flying: nobody sent yet
    const landed = m.frame(10000, L, away);
    expect(landed).toEqual([{ id: "1", hue: landed[0].hue, kind: "send", from: "xiaojie", x: 600, y: 400, t: 0 }]);
    expect([...m.targets(L, 10000)]).toEqual([["ran", { x: 600, y: 400 }]]);
    expect(m.frame(11000, L, walkersAt({ ran: { x: 600, y: 400, walking: true } }))).toHaveLength(1);   // passing by
    expect(m.frame(12000, L, walkersAt({ ran: { x: 600, y: 400, walking: false } }))).toEqual([]);     // picked up
    expect(m.size()).toBe(0);
  });
  it("prime: what was already in the air when this office's mail started is not delivered here", () => {
    const m = Z.createMail();
    m.prime([item("1", "xiaojie", "ran")]);
    expect(m.sync([item("1", "xiaojie", "ran"), item("2", "xiaojie", "ran")], 0, L)).toBe(1);
    expect(m.frame(10000, L, walkersAt({})).map((x: any) => x.id)).toEqual(["2"]);
  });
  it("asleep: it waits (nobody is sent); gone after MAX_WAIT, or when its person leaves", () => {
    const m = Z.createMail();
    m.sync([item("1", "xiaojie", "dean")], 0, L);
    m.frame(10000, L, walkersAt({}));
    expect(m.targets(L, 10000).size).toBe(0);
    expect(m.frame(10000 + Z.MAIL.MAX_WAIT + 5000, L, walkersAt({}))).toEqual([]);
    const n = Z.createMail();
    n.sync([item("2", "xiaojie", "ran")], 0, L);
    expect(n.frame(10000, office([desk("dean", "paused", 200, 200)]), walkersAt({}))).toEqual([]);
  });
  it("in bed for the night (#2568): an idle person drawn asleep is not sent either; the letter waits", () => {
    const m = Z.createMail();
    m.sync([item("1", "xiaojie", "ran")], 0, L);
    m.frame(10000, L, walkersAt({}));
    const bedtime = office([{ ...desk("ran", "idle", 640, 396), night: true }, desk("dean", "paused", 200, 200)]);
    expect(m.targets(bedtime, 10000).size).toBe(0);
    expect([...m.targets(L, 10000)]).toEqual([["ran", { x: 600, y: 400 }]]);   // morning: sent as usual
  });
});
