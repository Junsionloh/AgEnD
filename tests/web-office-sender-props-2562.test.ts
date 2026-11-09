/**
 * #2562: what flies is its sender's own — a character set may have a "prop" strip; the messages, work and reports its
 * people send fly as it.
 * - The format: "prop" is a set's strip like its poses (checked the same; its picture is one of the pack's), and is
 *   never a pose.
 * - The flights carry who sent each item (`from`), in an office and between All offices' tiles.
 * - spriteSkin.drawProp: the sender's set's prop (a byInstance set, else "default"'s), else the pack's prop for the
 *   kind, else the built-in item.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { page, type AppPage } from "./helpers/app-harness.js";

const FIXTURE = join(process.cwd(), "tests", "fixtures", "office-skin-clinic");
const MANIFEST = () => JSON.parse(readFileSync(join(FIXTURE, "manifest.json"), "utf8"));
const STRIP = (src: string) => ({ src, frames: 1, w: 16, h: 16 });

let p: AppPage;
let PK: any, K: any, M: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet/org" });
  PK = await import("/ui/js/fleet-office-pack.js");
  K = await import("/ui/js/fleet-office-skin.js");
  M = await import("/ui/js/fleet-office-model.js");
});
afterAll(async () => { await p.unmount(); p.restore(); });

const withProps = () => {
  const m = MANIFEST();
  m.characters.fox = { ...m.characters.fox, prop: STRIP("scissors.png") };
  m.byInstance = { atlas: "fox" };
  m.props = { send: STRIP("envelope.png") };
  return m;
};
const fakeCtx = () => {
  const calls: any[] = [];
  return { calls, imageSmoothingEnabled: true, globalAlpha: 1, fillStyle: "", save() {}, restore() {}, beginPath() {}, ellipse() {}, fill() {}, fillRect() {},
    translate() {}, scale() {}, drawImage: (im: any) => calls.push(im.src) };
};
const imgs = (...srcs: string[]) => new Map(srcs.map((s) => [s, { src: s, width: 1 }]));

describe("the format: a set's prop", () => {
  it("accepted and checked like a pose's strip; its picture is the pack's; not a pose", () => {
    const c = PK.checkSkinPack(withProps());
    expect(c.ok).toBe(true);
    expect(c.pack.characters.fox.prop).toMatchObject({ src: "scissors.png", frames: 1, w: 16, h: 16 });
    expect(PK.packImages(c.pack)).toContain("scissors.png");
    const bad = withProps(); bad.characters.fox.prop = { src: "scissors.png", frames: 0, w: 16, h: 16 };
    expect(PK.checkSkinPack(bad).ok).toBe(false);
    const other = withProps(); other.characters.fox.flag = STRIP("x.png");
    expect(PK.checkSkinPack(other)).toEqual({ ok: false, error: 'characters.fox: unknown key "flag"' });
  });
});

describe("the flights carry their sender", () => {
  it("an office's trips: { …, from }", () => {
    const L = { mode: "zones", rooms: [{ desks: [{ key: "a", node: { name: "atlas" }, seat: { x: 100, y: 100 } }, { key: "q", node: { name: "quill" }, seat: { x: 500, y: 100 } }] }],
      waypoints: [], edges: [] };
    const f = M.createFlights();
    f.sync([{ id: "1", from: "atlas", to: "quill", kind: "send", phase: "delivering" }], 0);
    const out = f.frame(500, L);
    expect(out.length ? out[0].from : "none").toBe("atlas");
  });
});

describe("drawProp: the sender's own, else the pack's, else built in", () => {
  it("atlas (fox, with a prop) sends scissors; quill (default, none) the pack's envelope; a kind with no prop the built-in", () => {
    const sk = K.spriteSkin(PK.skinPackOk(withProps()), imgs("scissors.png", "envelope.png"));
    const env = { pal: { fx: { send: "#fff", task: "#fff" } } };
    const draw = (it: any) => { const c = fakeCtx(); sk.drawProp(c, { x: 10, y: 10, t: 0.5, ...it }, 0, env); return c.calls; };
    expect(draw({ hue: "send", from: "atlas" })).toEqual(["scissors.png"]);
    expect(draw({ hue: "task", from: "atlas" })).toEqual(["scissors.png"]);            // every kind they send
    expect(draw({ hue: "send", from: "quill" })).toEqual(["envelope.png"]);
    expect(draw({ hue: "send" })).toEqual(["envelope.png"]);                             // no sender known: by kind
    expect(draw({ hue: "task", from: "quill" })).toEqual([]);                            // built in: drawn, no picture
  });
});
