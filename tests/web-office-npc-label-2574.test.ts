/**
 * #2574: a furniture item may have a "label" — a name tag under it, like a person's (an NPC drawn as furniture).
 * - The format: 1–40 characters, trimmed, no control characters; absent → none (as before).
 * - On the page: an item with a label gets a name tag at its anchor, drawn like a person's; one without gets none.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { page, type AppPage } from "./helpers/app-harness.js";

const FIXTURE = join(process.cwd(), "tests", "fixtures", "office-skin-clinic");
const MANIFEST = () => JSON.parse(readFileSync(join(FIXTURE, "manifest.json"), "utf8"));
const STRIP = (src: string) => ({ src, frames: 1, w: 16, h: 16 });

let p: AppPage;
let PK: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet/org" });
  PK = await import("/ui/js/fleet-office-pack.js");
});
afterAll(async () => { await p.unmount(); p.restore(); });

describe("the format: a furniture item's label", () => {
  it("1–40 characters, trimmed; absent: none; anything else refused", () => {
    const with_ = (label: any) => ({ ...MANIFEST(), furniture: [{ id: "keeper", sprite: STRIP("keeper.png"), x: 300, y: 300, ...(label === undefined ? {} : { label }) }] });
    expect(PK.checkSkinPack(with_("  Shopkeeper ")).pack.furniture[0].label).toBe("Shopkeeper");
    expect(PK.checkSkinPack(with_(undefined)).pack.furniture[0].label).toBeNull();
    for (const bad of ["", "   ", "x".repeat(41), "a\nb", 3]) expect(PK.checkSkinPack(with_(bad))).toEqual({ ok: false, error: "furniture[0].label: 1–40 characters" });
    expect(PK.checkSkinPack(with_("x".repeat(40))).ok).toBe(true);
  });
});
