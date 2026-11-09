/**
 * #2570: furniture that lives — an item with "loop": true plays its strip all along (not only while its activeWhen
 * holds), switches to its activeSprite while it does, and goes back to its loop after; "activeFor" (an instance's
 * name, or a list) makes activeWhen watch only those people's states, not anyone's shown.
 * - The format: loop is true or false; activeFor needs activeWhen and is a name or a list of up to 8.
 * - activeFurniture: with activeFor, only the named people's states count.
 * - spriteSkin.drawFurniture: active → activeSprite (else its strip) playing; not active → its strip playing with loop,
 *   its first frame without (as before).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { page, type AppPage } from "./helpers/app-harness.js";

let p: AppPage;
let PK: any, Z: any, K: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet/org" });
  PK = await import("/ui/js/fleet-office-pack.js");
  Z = await import("/ui/js/fleet-office-zones.js");
  K = await import("/ui/js/fleet-office-skin.js");
});
afterAll(async () => { await p.unmount(); p.restore(); });

const STRIP = (src: string, frames = 4) => ({ src, frames, w: 16, h: 16, fps: 4 });
const pack = (items: any[]) => ({ format: 1, id: "f", background: "bg.png", areas: { lounge: { rect: [0, 0, 1280, 720], seats: [[100, 100]] } },
  stateZones: { idle: "lounge" }, characters: { default: { idle: STRIP("i.png", 1) } }, furniture: items });
const LANTERN = { id: "lantern", sprite: STRIP("flicker.png"), x: 100, y: 100, loop: true, activeWhen: "working", activeSprite: STRIP("bright.png") };
const CAT = { id: "cat", sprite: STRIP("sleep.png"), x: 200, y: 100, loop: true, activeWhen: ["needs", "crashed"], activeFor: "atlas", activeSprite: STRIP("look.png") };

describe("the format", () => {
  it("loop and activeFor accepted; loop is a boolean; activeFor needs activeWhen and is a name or a list", () => {
    const c = PK.checkSkinPack(pack([LANTERN, CAT]));
    expect(c.ok).toBe(true);
    expect(c.pack.furniture.map((f: any) => [f.id, f.loop, f.activeFor])).toEqual([["lantern", true, null], ["cat", true, ["atlas"]]]);
    expect(PK.checkSkinPack(pack([{ ...LANTERN, loop: "yes" }]))).toEqual({ ok: false, error: "furniture[0].loop: true or false" });
    const { activeWhen, activeSprite, ...bare } = CAT;
    expect(PK.checkSkinPack(pack([bare]))).toEqual({ ok: false, error: "furniture[0].activeFor: only with activeWhen" });
    expect(PK.checkSkinPack(pack([{ ...CAT, activeFor: ["a", "b"] }])).pack.furniture[0].activeFor).toEqual(["a", "b"]);
    expect(PK.checkSkinPack(pack([{ ...CAT, activeFor: 3 }])).ok).toBe(false);
    expect(PK.checkSkinPack(pack([{ id: "old", sprite: STRIP("o.png"), x: 1, y: 1 }])).pack.furniture[0].loop).toBe(false);   // as before
  });
});

describe("activeFurniture with activeFor", () => {
  it("only the named people's states count; without activeFor, anyone's", () => {
    const c = PK.checkSkinPack(pack([LANTERN, CAT])).pack;
    const on = (states: string[], by: Record<string, string>) => [...Z.activeFurniture(c, new Set(states), new Map(Object.entries(by)))].sort();
    expect(on(["needs"], { quill: "needs" })).toEqual([]);                     // someone else calls: the cat sleeps on
    expect(on(["needs"], { atlas: "needs" })).toEqual(["cat"]);
    expect(on(["working", "needs"], { atlas: "working", quill: "needs" })).toEqual(["lantern"]);
  });
});

describe("drawFurniture", () => {
  const draws = (f: any, active: boolean, ms: number) => {
    const calls: any[] = [];
    const ctx = { imageSmoothingEnabled: true, save() {}, restore() {}, translate() {}, scale() {}, drawImage: (im: any, sx: number) => calls.push([im.src, sx / 16]) };
    const c = PK.checkSkinPack(pack([f])).pack;
    K.spriteSkin(c, new Map(["flicker.png", "bright.png", "o.png"].map((s) => [s, { src: s, width: 1 }]))).drawFurniture(ctx, c.furniture[0], active, ms, {});
    return calls[0];
  };
  it("looping: its strip plays when not active; active: its activeSprite plays; no loop: the first frame holds", () => {
    expect(draws(LANTERN, false, 0)[0]).toBe("flicker.png");
    expect(new Set([0, 250, 500, 750].map((ms) => draws(LANTERN, false, ms)[1])).size).toBeGreaterThan(1);
    expect(draws(LANTERN, true, 500)[0]).toBe("bright.png");
    const still = { id: "old", sprite: STRIP("o.png"), x: 1, y: 1 };
    expect([0, 250, 500, 750].map((ms) => draws(still, false, ms)[1])).toEqual([0, 0, 0, 0]);
  });
});
