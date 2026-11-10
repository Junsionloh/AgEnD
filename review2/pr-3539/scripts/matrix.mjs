// 16 images: {desk,phone} x {light,dark} x {en,zh-TW} x {before,after}; idle state, the real Settings shell at /settings/agents, "AI accounts and API keys" open.
import { launch, openAccounts, shotFull, say, OUT, LANGS, THEMES } from "./lib.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync(`${OUT}/matrix`, { recursive: true });
const b = await launch(); const log = [];
for (const which of ["before", "after"]) for (const dev of ["desk", "phone"]) for (const theme of THEMES) for (const lang of LANGS) {
  const width = dev === "desk" ? 1180 : 390;
  const { pg, errs, ctx } = await openAccounts(b, { which, lang, theme, width, height: dev === "desk" ? 1400 : 844 });
  const bg = await pg.evaluate(() => `theme=${document.documentElement.dataset.theme} cardBg=${getComputedStyle(document.querySelector(".s-account-card")).backgroundColor} cjk=${/[\u4e00-\u9fff]/.test(document.querySelector("details.s-ai-accounts").innerText)}`);
  const name = `${dev}-${theme}-${lang}-${which}.png`;
  await shotFull(pg, width, `${OUT}/matrix/${name}`);
  const raw = await pg.evaluate(() => (document.querySelector("details.s-ai-accounts")?.innerText.match(/\b(hostinstall|accounts)\.[a-zA-Z_]+/g) || []).join(","));
  const clip = await pg.evaluate(() => [...document.querySelectorAll("details.s-ai-accounts *")].filter((e) => e.scrollWidth > e.clientWidth + 2 && getComputedStyle(e).overflowX !== "visible" || e.getBoundingClientRect().right > innerWidth + 1).slice(0, 5).map((e) => e.tagName + "." + e.className));
  const line = `${name}  bg=${bg} rawKeys=[${raw}] overflow=[${clip}] errs=${JSON.stringify(errs)}  buttons=${JSON.stringify(await pg.locator("button.s-account-update, button.s-account-install").evaluateAll((els) => els.map((e) => e.closest(".s-account-card").getAttribute("data-backend") + ":" + e.textContent.trim())))}`;
  console.log(line); log.push(line);
  await ctx.close();
}
writeFileSync(`${OUT}/matrix/matrix-log.txt`, log.join("\n") + "\n");
await b.close();
