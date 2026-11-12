// Shared helpers of the capture (AGEND-234). Playwright comes from the machine's smoke-test install; nothing here touches :8445 / :19280.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
export const pw = createRequire(process.env.HOME + "/.cache/agend-smoke/pw/")("playwright-core");
export const CAP = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
export const portOf = (name) => Number((readFileSync(join(CAP, "run", name, "ah/fleet.yaml"), "utf8").match(/^health_port:\s*(\d+)/m) || [])[1]);
export const baseOf = (name) => `http://127.0.0.1:${portOf(name)}`;
/** A fresh one-time sign-in code from the instance's own token (loopback only, like the preview's code.sh). */
export async function issueCode(name) {
  const token = readFileSync(join(CAP, "run", name, "ah/web.token"), "utf8").trim();
  const r = await fetch(`${baseOf(name)}/auth/issue-code`, { method: "POST", headers: { "X-Agend-Token": token, "X-Agend-Code-Delivery": "tty" } });
  const b = await r.json();
  if (!b.code) throw new Error("no code: " + JSON.stringify(b));
  return b.code;
}
export async function signedInContext(browser, name, opts) {
  const ctx = await browser.newContext(opts);
  await ctx.addInitScript({ content: `try { localStorage.setItem("agend_tour_done","1"); localStorage.setItem("agend_firstrun_dismissed","1"); } catch {}` });
  const page = await ctx.newPage();
  await page.goto(`${baseOf(name)}/signin#code=${await issueCode(name)}`);
  await page.waitForURL(/\/ui/, { timeout: 20000 });
  return { ctx, page };
}
/** Chromium needs the few shared libs kept under the smoke-test cache (no root on this machine). */
export const launch = () => pw.chromium.launch({ args: ["--no-sandbox"], env: { ...process.env, LD_LIBRARY_PATH: `${process.env.HOME}/.cache/agend-smoke/libs/root/usr/lib/x86_64-linux-gnu:${process.env.LD_LIBRARY_PATH || ""}` } });
