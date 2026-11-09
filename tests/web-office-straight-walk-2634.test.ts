/**
 * #2634: a pack can ask for straight walking — each diagonal leg of a walk becomes an L (across, then up or down), so a
 * character set's three walking strips (walkSide, walkDown, walkUp) always fit.
 * - The format: an optional top-level `straight`, true or false (default false; the built-in Studio false).
 * - straighten: a diagonal leg → across then up/down; legs already across or up/down kept; no repeated point.
 * - zonesLayout carries it (overrides keep it); createWalkers walks the L at WALK.SPEED along the longer way, every
 *   heading across or up/down. Without it nothing changes.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { page, type AppPage } from "./helpers/app-harness.js";

const FIXTURE = join(process.cwd(), "tests", "fixtures", "office-skin-clinic");
const MANIFEST = () => JSON.parse(readFileSync(join(FIXTURE, "manifest.json"), "utf8"));

let p: AppPage;
let Z: any, PK: any, M: any, SK: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet/org" });
  Z = await import("/ui/js/fleet-office-zones.js");
  PK = await import("/ui/js/fleet-office-pack.js");
  M = await import("/ui/js/fleet-office-model.js");
  SK = await import("/ui/js/fleet-office-skin.js");
});
afterAll(async () => { await p.unmount(); p.restore(); });

const xy = (pts: any[]) => pts.map((q) => `${q.x},${q.y}`);

describe("the format: straight", () => {
  it("true or false; absent: false; anything else refused", () => {
    expect(PK.checkSkinPack({ ...MANIFEST(), straight: true }).pack.straight).toBe(true);
    expect(PK.checkSkinPack({ ...MANIFEST(), straight: false }).pack.straight).toBe(false);
    expect(PK.checkSkinPack(MANIFEST()).pack.straight).toBe(false);
    for (const v of ["yes", 1, null, {}]) expect(PK.checkSkinPack({ ...MANIFEST(), straight: v })).toEqual({ ok: false, error: "straight: true or false" });
  });
  it("the built-in Studio does not ask for it; overrides keep a pack's", () => {
    expect(SK.STUDIO_PACK.straight).toBe(false);
    const pack = PK.checkSkinPack({ ...MANIFEST(), straight: true }).pack;
    const a = PK.applyOverrides(pack, { pack: pack.id, door: [600, 700] });
    expect(a.ok).toBe(true);
    expect(a.pack.straight).toBe(true);
  });
});

describe("straighten", () => {
  it("a diagonal leg: across first, then up or down", () => {
    expect(xy(Z.straighten([{ x: 0, y: 0 }, { x: 100, y: 50 }]))).toEqual(["0,0", "100,0", "100,50"]);
    expect(xy(Z.straighten([{ x: 100, y: 50 }, { x: 0, y: 0 }]))).toEqual(["100,50", "0,50", "0,0"]);
  });
  it("legs already across or up/down are kept as they are", () => {
    const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 80 }, { x: 20, y: 80 }];
    expect(xy(Z.straighten(pts))).toEqual(xy(pts));
  });
  it("no point repeats, so no leg has no length", () => {
    const out = Z.straighten([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 50, y: 50 }, { x: 50, y: 50 }, { x: 50, y: 0 }]);
    expect(xy(out)).toEqual(["0,0", "50,0", "50,50", "50,0"]);
    for (let i = 1; i < out.length; i++) expect(out[i].x !== out[i - 1].x || out[i].y !== out[i - 1].y).toBe(true);
    expect(xy(Z.straighten([{ x: 5, y: 5 }]))).toEqual(["5,5"]);
  });
});

describe("walking a straight pack", () => {
  const NODES = [{ name: "atlas", state: "working" }];
  const layoutOf = (extra: any) => Z.zonesLayout(PK.checkSkinPack({ ...MANIFEST(), ...extra }).pack, NODES);
  // atlas walks from their desk to the lounge, the way the page syncs walkers (the layout is the graph).
  const walk = (L: any) => {
    const w = Z.createWalkers(), from = L.rooms[0].desks[0].seat, to = Z.zonesLayout(PK.checkSkinPack(MANIFEST()).pack, [{ name: "atlas", state: "idle" }]).rooms[0].desks[0].seat;
    w.sync(new Map([["atlas", from]]), 0, L);
    w.sync(new Map([["atlas", to]]), 0, L);
    return { w, from, to };
  };
  const headings = (w: any, ms: number) => Array.from({ length: 400 }, (_, i) => w.at("atlas", (i / 400) * ms)).filter((q: any) => q.walking).map((q: any) => q.heading);

  it("zonesLayout carries it", () => {
    expect(layoutOf({ straight: true }).straight).toBe(true);
    expect(layoutOf({}).straight).toBe(false);
  });
  it("every heading is across or up/down, at WALK.SPEED along the longer way", () => {
    const L = layoutOf({ straight: true }), { w, from, to } = walk(L);
    const ms = M.pathLength(Z.straighten(M.routeVia(L, from, to))) / Z.WALK.SPEED;
    expect(ms).toBeGreaterThan(M.pathLength(M.routeVia(L, from, to)) / Z.WALK.SPEED);
    const hs = headings(w, ms);
    expect(hs.length).toBeGreaterThan(300);
    for (const h of hs) expect(h.dx === 0 || h.dy === 0, `${h.dx},${h.dy}`).toBe(true);
    expect(w.at("atlas", ms - 5).walking).toBe(true);
    expect(w.at("atlas", ms + 1)).toMatchObject({ x: to.x, y: to.y, walking: false });
  });
  it("without it nothing changes: the graph's legs, diagonals and all, at the same speed", () => {
    const L = layoutOf({}), { w, from, to } = walk(L);
    const ms = M.pathLength(M.routeVia(L, from, to)) / Z.WALK.SPEED;
    expect(headings(w, ms).some((h: any) => h.dx !== 0 && h.dy !== 0)).toBe(true);
    expect(w.at("atlas", ms - 5).walking).toBe(true);
    expect(w.at("atlas", ms + 1).walking).toBe(false);
  });
});
