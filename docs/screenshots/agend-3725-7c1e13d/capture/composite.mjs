// Builds the 8 composite images (left before, right after; rows a/b/c) from the single shots + the per-image badge crops. node composite.mjs <shotsDir>
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { launch } from "./lib.mjs";
const dir = process.argv[2];
const raws = readdirSync(dir).filter((f) => /^receipt-raw-.*\.json$/.test(f)).map((f) => JSON.parse(readFileSync(`${dir}/${f}`, "utf8")));
const images = raws.flatMap((r) => r.images);
const uri = (f) => `data:image/png;base64,${readFileSync(`${dir}/${f}`).toString("base64")}`;
const ROWS = [["a", "(a) Claude Code is connecting → Grok “Connect”"], ["b", "(b) Same backend pressed again → refusal"], ["c", "(c) Claude Code dialog → console-fallback note"]];
const NUM = { "desk-light-en": 1, "desk-light-zh-TW": 2, "desk-dark-en": 3, "desk-dark-zh-TW": 4, "phone-light-en": 5, "phone-light-zh-TW": 6, "phone-dark-en": 7, "phone-dark-zh-TW": 8 };
const browser = await launch();
for (const [tag, n] of Object.entries(NUM)) {
  const phone = tag.startsWith("phone"), dark = tag.includes("dark"), w = phone ? 330 : 700;
  const pick = (side, scene) => images.find((i) => `${i.device}-${i.theme}-${i.lang}` === tag && i.side === side && i.scene === scene);
  const cell = (side, scene) => { const i = pick(side, scene); return `<div class="cell"><div class="cap ${side}">${side === "before" ? "Before" : "After"} · <code>${i.badge}</code></div><img class="badge" src="${uri(i.badgeFile)}"><img class="shot" src="${uri(i.file)}"></div>`; };
  const html = `<html><body style="margin:0;padding:20px;background:${dark ? "#1b1b1d" : "#e9e9ec"};font:14px/1.4 system-ui,sans-serif;color:${dark ? "#eee" : "#111"}">
  <style>.grid{display:grid;grid-template-columns:${w}px ${w}px;gap:14px 24px}.row{grid-column:1/3;font-weight:700;font-size:16px;margin-top:10px}.cell img.shot{width:${w}px;display:block;border:1px solid #8888;border-radius:6px}.cell img.badge{height:${phone ? 26 : 22}px;margin:4px 0}.cap{font-weight:600}.cap.before{color:#c0392b}.cap.after{color:#1e8449}code{font-size:12px}</style>
  <div style="font-weight:700;font-size:18px;margin-bottom:6px">#3725 · ${tag.replace("desk", "desktop")} — before (upstream base) vs after (PR head)</div>
  <div class="grid">${ROWS.map(([s, label]) => `<div class="row">${label}</div>${cell("before", s)}${cell("after", s)}`).join("")}</div></body></html>`;
  const ctx = await browser.newContext({ viewport: { width: 2 * w + 68, height: 800 }, deviceScaleFactor: 1.5 });
  const page = await ctx.newPage();
  await page.setContent(html); await page.waitForTimeout(500);
  await page.screenshot({ path: `${dir}/${n}-${tag}.png`, fullPage: true });
  await ctx.close();
}
await browser.close();
