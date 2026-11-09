/**
 * #2698: furniture that waits for its person to sit down, and can hide them.
 * - The format: "activeOn" is "state" (the default) or "seated", only with activeWhen; "hides" is true or false, only
 *   with activeFor. An old item keeps "state" and false.
 * - "activeOn": "seated": the item stays as it is while its person walks to their seat, turns active on arrival, and
 *   back as soon as they walk off (activeFurniture with a posture; furnitureAt in the scene).
 * - "hides": while the item is active its people are not drawn; their name tag and bubble are drawn on the item (in one
 *   row at its tag point, after its own label); hovering the item hits them; someone walking is always drawn.
 * - Defaults: a pack without the keys is drawn and hit exactly as before (the scene's own active set).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { page, type AppPage } from "./helpers/app-harness.js";

let p: AppPage;
let PK: any, Z: any, K: any, F: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet/org" });
  PK = await import("/ui/js/fleet-office-pack.js");
  Z = await import("/ui/js/fleet-office-zones.js");
  K = await import("/ui/js/fleet-office-skin.js");
  F = await import("/ui/js/fleet-office.js");
});
afterAll(async () => { await p.unmount(); p.restore(); });

const STRIP = (src: string, w = 16, h = 16) => ({ src, frames: 1, w, h, fps: 0 });
const BED = { id: "bed", sprite: STRIP("bed.png", 40, 20), x: 900, y: 420, activeWhen: "paused", activeSprite: STRIP("bed_on.png", 40, 20), activeFor: "atlas" };
const pack = (items: any[]) => ({ format: 1, id: "f", background: "bg.png",
  areas: { desks: { rect: [0, 0, 600, 720], seats: [[100, 600]] }, nap: { rect: [700, 0, 580, 720], seats: [[900, 420], [960, 420]] } },
  stateZones: { working: "desks", paused: "nap", default: "desks" },
  characters: { default: { idle: STRIP("idle.png"), working: STRIP("work.png"), paused: STRIP("sleep.png"), walk: STRIP("walk.png") } }, furniture: items });

describe("the format", () => {
  it("activeOn: \"state\" or \"seated\", only with activeWhen; hides: a boolean, only with activeFor; an old item keeps the defaults", () => {
    const c = PK.checkSkinPack(pack([{ ...BED, activeOn: "seated", hides: true }]));
    expect(c.ok).toBe(true);
    expect([c.pack.furniture[0].activeOn, c.pack.furniture[0].hides]).toEqual(["seated", true]);
    expect(PK.checkSkinPack(pack([{ ...BED, activeOn: "state", hides: false }])).pack.furniture[0]).toMatchObject({ activeOn: "state", hides: false });
    expect(PK.checkSkinPack(pack([{ ...BED, activeOn: "sitting" }]))).toEqual({ ok: false, error: 'furniture[0].activeOn: "state" or "seated"' });
    expect(PK.checkSkinPack(pack([{ ...BED, hides: "yes" }]))).toEqual({ ok: false, error: "furniture[0].hides: true or false" });
    const { activeFor, ...noFor } = BED;
    expect(PK.checkSkinPack(pack([{ ...noFor, hides: true }]))).toEqual({ ok: false, error: "furniture[0].hides: only with activeFor" });
    const { activeWhen, activeSprite, activeFor: _f, ...bare } = BED;
    expect(PK.checkSkinPack(pack([{ ...bare, activeOn: "seated" }]))).toEqual({ ok: false, error: "furniture[0].activeOn: only with activeWhen" });
    expect(PK.checkSkinPack(pack([BED])).pack.furniture[0]).toMatchObject({ activeOn: "state", hides: false });   // as before
    // A share cuts activeFor to the people it shows (none: []): still a pack, and the item hides nobody.
    const cut = PK.checkSkinPack(pack([{ ...BED, activeFor: [], hides: true }]));
    expect(cut.ok).toBe(true);
    const on = Z.activeFurniture(cut.pack, new Set(["paused"]), new Map([["atlas", "paused"]]));
    expect([on.size, Z.hiddenBy(cut.pack, on, new Map([["atlas", "paused"]])).size]).toEqual([0, 0]);
  });
});

describe("activeFurniture and hiddenBy with a posture", () => {
  it("seated: active only once a watched person in the state is seated; state: as before, whatever their posture", () => {
    const c = PK.checkSkinPack(pack([{ ...BED, activeOn: "seated" }, { ...BED, id: "lamp", activeFor: undefined }])).pack;
    const by = new Map([["atlas", "paused"]]), states = new Set(["paused"]);
    const on = (posture: string | null) => [...Z.activeFurniture(c, states, by, posture === null ? null : () => posture)].sort();
    expect(on("walking")).toEqual(["lamp"]);
    expect(on("standing")).toEqual(["lamp"]);
    expect(on("seated")).toEqual(["bed", "lamp"]);
    expect(on(null)).toEqual(["bed", "lamp"]);                         // no walkers: everyone at their seat
    expect([...Z.activeFurniture(c, new Set(["working"]), new Map([["atlas", "working"]]), () => "seated")]).toEqual([]);
  });
  it("hides: the people an active item is active for, in activeFor's order, never one walking", () => {
    const c = PK.checkSkinPack(pack([{ ...BED, activeFor: ["quill", "atlas"], hides: true }])).pack;
    const by = new Map([["atlas", "paused"], ["quill", "paused"], ["sage", "paused"]]);
    const active = Z.activeFurniture(c, new Set(["paused"]), by);
    expect([...Z.hiddenBy(c, active, by, () => "seated")]).toEqual([["quill", "bed"], ["atlas", "bed"]]);
    expect([...Z.hiddenBy(c, active, by, (n: string) => (n === "quill" ? "walking" : "seated")).keys()]).toEqual(["atlas"]);
    expect(Z.hiddenBy(c, new Set(), by).size).toBe(0);                  // not active: nobody
  });
});

/** A scene on `items` with atlas moving from the desks (working) to the nap area (paused) at t = 1000. */
function scene(items: any[]) {
  const c = PK.checkSkinPack(pack(items)).pack;
  const srcs = ["bed.png", "bed_on.png", "idle.png", "work.png", "sleep.png", "walk.png"];
  const base = K.spriteSkin(c, new Map(srcs.map((s) => [s, { src: s, width: 1 }])));
  const drawn: any[] = [];
  const skin = { ...base,
    drawCharacter: (ctx: any, d: any, look: any, ms: number, env: any) => { drawn.push(["person", look.name, look.pose, d.seat.x, d.seat.y]); },
    drawFurniture: (ctx: any, f: any, active: boolean) => { drawn.push(["item", f.id, active]); },
    drawTag: (ctx: any, x: number, y: number, look: any) => { drawn.push(["tag", look.label, x, y]); },
    drawBubble: (ctx: any, x: number, y: number, text: string) => { drawn.push(["bubble", x, y]); } };
  const walkers = Z.createWalkers();
  const node = (state: string) => ({ name: "atlas", state, i: { name: "atlas" } });
  const L1 = Z.zonesLayout(c, [node("working")]);
  walkers.sync(new Map([["atlas", L1.seats.get("atlas")]]), 0, L1);
  const L2 = Z.zonesLayout(c, [node("paused")], L1.seats);
  walkers.sync(new Map([["atlas", L2.seats.get("atlas")]]), 1000, L2);
  const looks = new Map(L2.rooms[0].desks.map((d: any) => [d.key, { name: "atlas", label: "Atlas", state: "paused", pose: "paused", free: true }]));
  const part = F.partOf(L2, looks, skin, true, walkers, { frame: () => [], size: () => 0 });
  const calls: any[] = [];
  const ctx = new Proxy({ measureText: (t: string) => ({ width: t.length * 6 }) } as any, { get(o, k) { if (k in o) return o[k]; return (...a: any[]) => calls.push([k, a]); }, set(o, k, v) { o[k] = v; return true; } });
  const env = { pal: { bg: "#000", surface: "#111", border: "#222", text: "#fff", focus: "#0ff" }, mode: "dark", labels: { areas: {} } };
  const at = (ms: number) => { drawn.length = 0; F.drawPart(ctx, part, 1, 0, 0, ms, false, null, env); return [...drawn]; };
  const arrive = 1000 + Math.ceil(Math.hypot(900 - 100, 420 - 600) / Z.WALK.SPEED) + 10;
  return { c, part, at, arrive, seat: L2.seats.get("atlas"), desk: L2.rooms[0].desks[0] };
}
const item = (d: any[], id = "bed") => d.find((x) => x[0] === "item" && x[1] === id)?.[2];
const person = (d: any[]) => d.find((x) => x[0] === "person" && x[1] === "atlas") || null;
const tag = (d: any[]) => d.find((x) => x[0] === "tag" && x[1] === "Atlas") || null;

describe("activeOn: \"seated\" in the scene", () => {
  it("stays inactive while the person walks, turns active on arrival, back as they walk off", () => {
    const s = scene([{ ...BED, activeOn: "seated" }]);
    const walking = s.at(2000);
    expect([item(walking), person(walking)?.[2]]).toEqual([false, "walk"]);
    const there = s.at(s.arrive);
    expect([item(there), person(there)?.[2]]).toEqual([true, "paused"]);
    expect(F.furnitureAt(s.part, s.arrive).active.has("bed")).toBe(true);
    // Walking off (sent to another spot): back at once.
    s.part.walkers.sync(new Map([["atlas", { x: 960, y: 600 }]]), s.arrive + 100, s.part.L);
    expect(item(s.at(s.arrive + 200))).toBe(false);
  });
});

describe("hides in the scene", () => {
  it("not drawn while the item is active; the tag and bubble at the item; hover over the item names the person", () => {
    const s = scene([{ ...BED, activeOn: "seated", hides: true }]);
    // A round in which atlas speaks (its bubble shows), after arriving.
    let ms = s.arrive;
    while (!Z.bubbleAt("atlas", "paused", ms, ["Zzz"])) ms += 250;
    const d = s.at(ms);
    expect([item(d), person(d)]).toEqual([true, null]);
    expect(tag(d)).toEqual(["tag", "Atlas", 900, 420]);                   // the item's tag point
    const top = PK.stripBox(s.c.furniture[0].activeSprite, 900, 420).y + 2;
    expect(d.filter((x) => x[0] === "bubble")).toEqual([["bubble", 910, Math.min(420 - 50, top)]]);
    // Hover: the item's picture is atlas; their empty seat is not.
    const b = PK.stripBox(s.c.furniture[0].activeSprite, 900, 420);
    expect(F.hitPart(s.part, b.x + 2, b.y + 2, ms)?.node.name).toBe("atlas");
    expect(F.hitPart(s.part, 900, 430, ms)?.node.name).toBe("atlas");       // its tag row
    expect(F.hitPart(s.part, 600, 100, ms)).toBeNull();
  });
  it("a walking person is drawn (with their own tag), even while the item is active for them", () => {
    const s = scene([{ ...BED, hides: true }]);                           // activeOn "state": active as the state changes
    const d = s.at(2000);
    expect([item(d), person(d)?.[2]]).toEqual([true, "walk"]);
    expect(tag(d)?.[2]).not.toBe(900);                                    // under their feet, on the way
    const there = s.at(s.arrive);
    expect([item(there), person(there), tag(there)]).toEqual([true, null, ["tag", "Atlas", 900, 420]]);
  });
  it("several share the item's tag row, after its own label, left to right in activeFor's order", () => {
    const c = PK.checkSkinPack(pack([{ ...BED, label: "Bed" }])).pack;
    const ctx = { save() {}, restore() {}, measureText: (t: string) => ({ width: t.length * 6 }) } as any;
    const row = F.tagRow(ctx, 900, 420, [{ label: c.furniture[0].label }, { label: "Quill" }, { label: "Atlas" }]);
    expect(row.map((r: any) => r.look.label)).toEqual(["Bed", "Quill", "Atlas"]);
    expect(row[0].x).toBeLessThan(row[1].x);
    expect(row[1].x).toBeLessThan(row[2].x);
    expect(Math.round((row[0].x + row[2].x) / 2)).toBeCloseTo(900, -1);
  });
});

describe("hides: hit on the tags as drawn (#2699 review)", () => {
  /** quill and atlas asleep on one bed with a long label and long names: a tag row wider than the picture. */
  function crowd() {
    const LONG = "The long four-poster bed by the window";   // under the 40-character cap, wider than a tag
    const c = PK.checkSkinPack(pack([{ ...BED, label: LONG, activeFor: ["quill", "atlas"], hides: true }])).pack;
    const srcs = ["bed.png", "bed_on.png", "idle.png", "work.png", "sleep.png", "walk.png"];
    const drawn: any[] = [];
    const skin = { ...K.spriteSkin(c, new Map(srcs.map((s) => [s, { src: s, width: 1 }]))),
      drawCharacter: (ctx: any, d: any, look: any) => { drawn.push(["person", look.name]); },
      drawFurniture: () => {}, drawBubble: () => {},
      drawTag: (ctx: any, x: number, y: number, look: any) => { drawn.push(["tag", look.label, x, y]); } };
    const nodes = ["quill", "atlas"].map((name) => ({ name, state: "paused", i: { name } }));
    const L = Z.zonesLayout(c, nodes);
    const label = (n: string) => (n === "quill" ? "Quill the Midnight Scribe" : "Atlas of the Northern Maps");
    const looks = new Map(L.rooms[0].desks.map((d: any) => [d.key, { name: d.node.name, label: label(d.node.name), state: "paused", pose: "paused", free: true }]));
    const part = F.partOf(L, looks, skin, true, Z.createWalkers(), { frame: () => [], size: () => 0 });
    const ctx = new Proxy({ measureText: (t: string) => ({ width: t.length * 6 }) } as any, { get(o, k) { if (k in o) return o[k]; return () => {}; }, set(o, k, v) { o[k] = v; return true; } });
    const env = { pal: { bg: "#000", surface: "#111", border: "#222", text: "#fff", focus: "#0ff" }, mode: "dark", labels: { areas: {} } };
    const draw = (tagsOff = false) => { drawn.length = 0; F.drawPart(ctx, part, 1, 0, 0, 5000, false, null, env, tagsOff); return [...drawn]; };
    const hit = (x: number, y: number) => F.hitPart(part, x, y, 5000)?.node.name ?? null;
    return { c, ctx, draw, hit, label, LONG };
  }
  it("each person's tag selects that person, across its whole width and past the picture's edge", () => {
    const s = crowd();
    const d = s.draw();
    expect(d.filter((x) => x[0] === "person")).toEqual([]);                  // both drawn as the bed
    const tags = d.filter((x) => x[0] === "tag");
    expect(tags.map((x) => x[1])).toEqual([s.LONG, s.label("quill"), s.label("atlas")]);
    const pic = PK.stripBox(s.c.furniture[0].activeSprite, 900, 420);
    for (const name of ["quill", "atlas"]) {
      const [, text, x, y] = tags.find((t) => t[1] === s.label(name));
      const b = K.tagBox(s.ctx, x, y, text);
      for (const px of [b.x + 1, x, b.x + b.w - 2]) for (const py of [b.y + 1, b.y + b.h - 2]) expect([name, px, py, s.hit(px, py)]).toEqual([name, px, py, name]);
    }
    // Quill's tag is the one under the picture's centre; Atlas's runs past its right edge.
    expect(tags.find((t) => t[1] === s.label("quill"))[2]).toBe(900);
    expect(K.tagBox(s.ctx, tags[2][2], 420, tags[2][1]).x + 10).toBeGreaterThan(pic.x + pic.w);
    // The picture keeps its left-to-right regions; the item's own label names nobody.
    expect([s.hit(pic.x + 1, pic.y + 1), s.hit(pic.x + pic.w - 2, pic.y + 1)]).toEqual(["quill", "atlas"]);
    const own = K.tagBox(s.ctx, tags[0][2], 420, tags[0][1]);
    expect(s.hit(own.x + 2, own.y + 2)).toBeNull();
  });
  it("a tag left out is not hit: with the tags off only the picture is", () => {
    const s = crowd();
    const tags = s.draw().filter((x) => x[0] === "tag");
    const [, text, x, y] = tags[2];
    const b = K.tagBox(s.ctx, x, y, text), past = b.x + b.w - 2;
    expect(s.hit(past, b.y + 2)).toBe("atlas");
    expect(s.draw(true).filter((t) => t[0] === "tag")).toEqual([]);
    expect(s.hit(past, b.y + 2)).toBeNull();
  });
});

describe("defaults", () => {
  it("without the keys: active as the state changes, the person drawn and hit at their seat, the scene's own active set", () => {
    const s = scene([BED]);
    expect([item(s.at(2000)), person(s.at(2000))?.[2]]).toEqual([true, "walk"]);
    const there = s.at(s.arrive);
    expect([item(there), person(there)?.slice(2)]).toEqual([true, ["paused", s.seat.x, s.seat.y]]);
    expect(tag(there)).toEqual(["tag", "Atlas", s.seat.x, s.seat.y]);
    expect(F.furnitureAt(s.part, s.arrive).active).toBe(s.part.active);
    expect(F.hitPart(s.part, s.seat.x, s.seat.y - 4, s.arrive)?.node.name).toBe("atlas");
  });
});
