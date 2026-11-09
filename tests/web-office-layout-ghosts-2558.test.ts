/**
 * #2558: placing seats on a skin pack whose figures are taller than the built-in ones.
 * - Edit layout's faint figures (ghostsOf): one on every seat no one is on, in the pose its area is for (the first
 *   state the pack's stateZones sends there: asleep, working, calling, idle), drawn faint with the pack's default set.
 * - A seated person's bubble (speakerAt): over the head of the picture drawn, never lower than the built-in spot.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { page, type AppPage } from "./helpers/app-harness.js";

let p: AppPage;
let F: any, K: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet/org" });
  F = await import("/ui/js/fleet-office.js");
  K = await import("/ui/js/fleet-office-skin.js");
});
afterAll(async () => { await p.unmount(); p.restore(); });

const PACK = {
  areas: {
    work: { name: "work", seats: [{ x: 100, y: 300 }, { x: 200, y: 300 }] },
    lounge: { name: "lounge", seats: [{ x: 400, y: 300 }] },
    alert: { name: "alert", seats: [{ x: 600, y: 300 }] },
    nap: { name: "nap", seats: [{ x: 800, y: 300 }] },
  },
  stateZones: { working: "work", idle: "lounge", paused: "nap", stopped: "nap", needs: "alert", crashed: "alert", stuck: "alert", default: "lounge" },
};

describe("Edit layout's faint figures (ghostsOf)", () => {
  it("one on every seat, in its area's pose: asleep on a nap seat, working at a desk, calling at the alert, idle in the lounge", () => {
    const g = F.ghostsOf(PACK);
    expect(g.map((x: any) => [x.x, x.y, x.look.pose])).toEqual([[100, 300, "working"], [200, 300, "working"], [400, 300, "idle"], [600, 300, "needs"], [800, 300, "paused"]]);
    expect(g.every((x: any) => x.look.name === "" && !x.look.dim)).toBe(true);                 // the default set (faint by GHOST_ALPHA, not dim)
  });
  it("no figure where someone already is; an area no state goes to stands idle", () => {
    const people = [{ at: { x: 100, y: 300 } }, { at: { x: 801, y: 299 } }];
    expect(F.ghostsOf(PACK, people).map((x: any) => x.x)).toEqual([200, 400, 600]);
    const spare = { ...PACK, areas: { ...PACK.areas, porch: { name: "porch", seats: [{ x: 50, y: 60 }] } } };
    expect(F.ghostsOf(spare).find((x: any) => x.x === 50).look.pose).toBe("idle");
  });
});

describe("A seated person's bubble (speakerAt)", () => {
  it("built in: where it always was (50 above the feet)", () => {
    expect(F.speakerAt(K.pixelSkin, { name: "atlas", pose: "idle" }, { x: 300, y: 400 })).toEqual({ x: 310, y: 350 });
  });
  it("a taller figure: over its head, not on its face; a shorter one keeps the built-in spot", () => {
    const tall = { charBox: () => ({ x: 228, y: 266, w: 144, h: 144 }) };                       // a 134 px figure at (300, 409)
    expect(F.speakerAt(tall, {}, { x: 300, y: 409 })).toEqual({ x: 310, y: 268 });
    const short = { charBox: () => ({ x: 280, y: 370, w: 40, h: 40 }) };
    expect(F.speakerAt(short, {}, { x: 300, y: 400 })).toEqual({ x: 310, y: 350 });
  });
});
