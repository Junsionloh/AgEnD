import { launch, openAccounts, card, say, OUT } from "./lib.mjs";
const b = await launch();
for (const which of ["before", "after"]) {
  const reqs = [];
  const { pg, errs } = await openAccounts(b, { which, setup: async (p) => p.on("response", (r) => { const u = r.url(); if (/\.(js|css)(\?|$)/.test(u)) reqs.push(u.replace(/^http:\/\/127.0.0.1:\d+/, "")); }) });
  console.log("==", which, "cards:", await pg.locator(".s-account-card").evaluateAll((els) => els.map((e) => e.getAttribute("data-backend"))));
  for (const id of await pg.locator(".s-account-card").evaluateAll((els) => els.map((e) => e.getAttribute("data-backend")))) console.log(id, "=>", (await say(pg, id)).slice(0, 300));
  console.log("buttons", await pg.locator("button.s-account-update, button.s-account-install").evaluateAll((els) => els.map((e) => e.closest(".s-account-card").getAttribute("data-backend") + ":" + e.textContent.trim())));
  console.log("errs", errs);
  console.log("assets", reqs.filter((u) => /accounts|host-install|settings-confirm|app-i18n|ui-toast/.test(u)));
  await pg.screenshot({ path: `/tmp/probe-${which}.png` });
}
await b.close();
