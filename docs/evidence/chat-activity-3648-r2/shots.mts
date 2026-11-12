// AGEND-214 (Prism's review of #3709, R7): the chat's activity block on the REAL dashboard, answered by the REAL /ui/steps route
// and the REAL LogService reading a REAL redacted Claude Code transcript (tests/fixtures/chat-activity-3648/claude-web-chat.jsonl).
// Nothing is stubbed: the route, the admission, the parser, the server-side cut and the page are the product's. The only things
// this script does to the fixture are (1) shift every record's `timestamp` (and the ledger's `ts`) by one constant so the last
// turn is "now" — needed for a LIVE turn; (2) cut the transcript just before the second reply's result (the running scene: the reply call is in; its result, the closing `.` and the turn's end are not); and
// (3) say "Working" in the header, since the shot instance is not running (as the #3639 mockups did).
//
//   MODE=shots  REPO=<checkout> OUT=<dir>  [LABEL=after|before]   npx tsx shots.mts     (REPO: the head, or the base for "before")
//   MODE=skew   REPO=<head checkout> BASE=<base checkout> PREV=<previous-head checkout> OUT=<dir> npx tsx shots.mts
// needs playwright-core (REPO/node_modules) and a Chromium (CHROME=<binary>).
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = process.env.REPO!, OUT = process.env.OUT!, MODE = process.env.MODE ?? "shots", LABEL = process.env.LABEL ?? "after";
mkdirSync(OUT, { recursive: true });
const pw = createRequire(join(REPO, "package.json"))("playwright-core");
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const { FleetManager } = await import(join(REPO, "src/fleet-manager.ts"));

const FIX = join(process.env.FIXREPO ?? REPO, "tests/fixtures/chat-activity-3648");
const rawTranscript = readFileSync(join(FIX, "claude-web-chat.jsonl"), "utf8").split("\n").filter(Boolean);
const rawLedger = JSON.parse(readFileSync(join(FIX, "claude-web-chat.ledger.json"), "utf8")) as Array<Record<string, any>>;
const FIXTURE_SHA = { transcript: sha(readFileSync(join(FIX, "claude-web-chat.jsonl"))), ledger: sha(readFileSync(join(FIX, "claude-web-chat.ledger.json"))) };

// The cut for the running scene: everything up to (not including) the second `reply` call's result.
const replyResultAt = (() => { const i = rawTranscript.findIndex((l) => l.includes("tool_result") && l.includes("web-mwbq7p0l-17a474c2")); return i < 0 ? rawTranscript.length : i; })();
const lastTs = (lines: string[]) => Math.max(...lines.map((l) => Date.parse(JSON.parse(l).timestamp)).filter(Number.isFinite));

type Shape = "full" | "running";
function material(shape: Shape): { transcript: string; ledger: Array<Record<string, any>> } {
  const lines = shape === "running" ? rawTranscript.slice(0, replyResultAt) : rawTranscript;
  const delta = Date.now() - 4000 - lastTs(lines);
  const transcript = lines.map((l) => { const e = JSON.parse(l); e.timestamp = new Date(Date.parse(e.timestamp) + delta).toISOString(); return JSON.stringify(e); }).join("\n") + "\n";
  const rows = (shape === "running" ? rawLedger.slice(0, 3) : rawLedger).map((r) => ({ ...r, ts: new Date(Date.parse(r.ts) + delta).toISOString() }));
  return { transcript, ledger: rows };
}

const NAME = "master";
async function boot(shape: Shape, level: "standard" | "verbose", logTab = false) {
  const dir = mkdtempSync(join(tmpdir(), "agend-214-"));
  const fm: any = new FleetManager(dir);
  const quiet = () => {};
  fm.logger = { info: quiet, warn: quiet, error: quiet, debug: quiet, trace: quiet, fatal: quiet, child: () => fm.logger };
  fm.notifyFleetError = () => true;
  fm.fleetConfig = { instances: { [NAME]: { working_directory: "/srv/work/master", backend: "claude-code", tool_progress: level } }, web: { log_tab: logTab } };
  fm.initializeWebAuthTokens();
  fm.startHealthServer(0);
  const port: number = await new Promise((resolve) => { const t = setInterval(() => { const a = fm.healthServer?.address?.(); if (a?.port) { clearInterval(t); resolve(a.port); } }, 50); });
  const m = material(shape);
  const tdir = join(dir, "scratch"); mkdirSync(tdir, { recursive: true });
  const tpath = join(tdir, "transcript.jsonl"); writeFileSync(tpath, m.transcript);
  const idir = fm.getInstanceDir(NAME); mkdirSync(idir, { recursive: true });
  writeFileSync(join(idir, "statusline.json"), JSON.stringify({ transcript_path: tpath }));
  for (const r of m.ledger) fm.webChatHistory.record({ instance: NAME, sender: r.sender, role: r.role, text: r.text, ts: r.ts, anchor: r.anchor });
  return { fm, port, base: `http://127.0.0.1:${port}`, close: () => fm.healthServer?.close() };
}

const browserFor = () => pw.chromium.launch({ executablePath: process.env.CHROME, args: ["--no-sandbox"] });
type Opts = { lang: "zh-TW" | "en"; dark: boolean; mobile: boolean };
async function open(browser: any, srv: { fm: any; base: string }, o: Opts, hooks?: (p: any) => Promise<void>) {
  const ctx = await browser.newContext({ viewport: o.mobile ? { width: 390, height: 844 } : { width: 1366, height: 820 }, colorScheme: o.dark ? "dark" : "light", locale: o.lang, isMobile: o.mobile, hasTouch: o.mobile, deviceScaleFactor: o.mobile ? 2 : 1 });
  await ctx.addInitScript({ content: `try { localStorage.setItem("agend_tour_done", "1"); localStorage.setItem("agend_lang", "${o.lang}"); } catch {}` });
  const p = await ctx.newPage();
  const errors: string[] = [];
  p.on("pageerror", (e: Error) => errors.push(`pageerror: ${e.message}`));
  p.on("console", (m: any) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
  const failed: string[] = [];
  p.on("response", (r: any) => { if (r.status() >= 400) failed.push(`${r.status()} ${new URL(r.url()).pathname}`); });
  (p as any).failedRequests = failed;
  await hooks?.(p);
  await p.goto(`${srv.base}/signin`); await p.waitForTimeout(800);
  const code = srv.fm.issueDashboardLogin().display as string;
  await p.evaluate(`fetch("/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "${code}" }) })`);
  await p.waitForTimeout(400);
  await p.evaluate(`fetch("/auth/session").then(r => r.json()).then(s => fetch("/ui/prefs", { method: "POST", headers: { "content-type": "application/json", "x-agend-csrf": s.csrf }, body: JSON.stringify({ set: { lang: "${o.lang}", theme: "${o.dark ? "dark" : "light"}" } }) }))`);
  await p.waitForTimeout(400);
  return { ctx, p, errors };
}
const working = (p: any, lang: string) => p.evaluate((w: string) => { const t = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n: any; while ((n = t.nextNode())) { if (/^\s*(已停止|Stopped|stopped)\s*$/.test(n.data) && (n.parentElement?.getBoundingClientRect().top ?? 999) < 90) n.data = w; } }, lang === "en" ? "Working" : "工作中");
const scrollEnd = (p: any) => p.evaluate(() => { const sc = document.querySelector(".scroller") as HTMLElement | null; if (sc) sc.scrollTop = sc.scrollHeight; });
const probe = (p: any) => p.evaluate(() => ({
  composer: !!document.querySelector("#msgIn"), blocks: document.querySelectorAll(".act-block").length, rows: document.querySelectorAll(".msg-row, .bubble, .msg").length,
  overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  steps: document.querySelectorAll(".act-block .log-item").length,
}));

// ───────────────────────────────────────────────────────── MODE=shots
async function shots() {
  const browser = await browserFor();
  const receipt: any[] = [];
  const kinds = LABEL === "before" ? (["before"] as const) : (["a", "b", "c"] as const);
  const nameOf = { before: "0-before", a: "1-running-collapsed-and-finished", b: "2-running-expanded", c: "3-verbose-expanded" } as const;
  try {
    for (const lang of ["en", "zh-TW"] as const) for (const dark of [false, true]) for (const mobile of [false, true]) for (const kind of kinds) {
      const srv = await boot("running", kind === "c" ? "verbose" : "standard");
      const o = { lang, dark, mobile };
      const base = `${mobile ? "phone" : "desktop"}-${dark ? "dark" : "light"}-${lang === "en" ? "en" : "zhTW"}`;
      const { ctx, p, errors } = await open(browser, srv, o);
      try {
        const steps: Array<{ status: number }> = [];
        const bytesServed = new Map<string, string>();
        p.on("response", async (r: any) => {
          const u = new URL(r.url());
          if (u.pathname.includes("/ui/steps")) steps.push({ status: r.status() });
          if (r.status() === 200 && (/^\/ui\/js\/[a-z0-9_-]+\.js$/.test(u.pathname) || /^\/assets\/[A-Za-z0-9_.-]+\.(js|css)$/.test(u.pathname))) {
            try { bytesServed.set(u.pathname, sha(await r.body())); } catch { /* a navigation raced the body */ }
          }
        });
        await p.goto(`${srv.base}/ui/chat/${NAME}`); await p.waitForSelector("#msgIn", { timeout: 20000 }); await p.waitForTimeout(2500);
        if (kind !== "before") {
          await p.waitForSelector(".act-block", { timeout: 15000 });
          if (kind === "b" || kind === "c") { await p.click(".act-block.live summary"); await p.waitForTimeout(300); }
        }
        await working(p, lang); await scrollEnd(p); await p.waitForTimeout(500);
        const file = `${base}-${nameOf[kind]}.png`;
        await p.screenshot({ path: join(OUT, file) });
        const r = { file, ...(await probe(p)), stepsRequests: steps.map((s) => s.status), errors, served: Object.fromEntries([...bytesServed].sort()) };
        receipt.push(r); console.log("ok", file, JSON.stringify({ blocks: r.blocks, steps: r.steps, composer: r.composer, errors: r.errors.length, files: Object.keys(r.served).length }));
      } finally { await ctx.close(); srv.close(); }
    }
  } finally { await browser.close(); }
  writeFileSync(join(OUT, `shots-${LABEL}.json`), JSON.stringify({ label: LABEL, repo: REPO, fixture: FIXTURE_SHA, scenes: receipt }, null, 2));
}

// ───────────────────────────────────────────────────────── MODE=skew
// Real Chrome against the head's server, with a browser that RETAINED some older files: each case serves the named paths from an
// older checkout (the bytes actually returned are hashed) and everything else from the head. Asked: does the chat still work.
const BASE = process.env.BASE!, PREV = process.env.PREV!;
const served = (root: string, urlPath: string): string | null => {
  const m = urlPath.match(/^\/ui\/js\/([a-z0-9_-]+\.js)$/); if (m) return join(root, "src/ui", m[1]!);
  const a = urlPath.match(/^\/assets\/([A-Za-z0-9_.-]+)$/); if (a) return join(root, "src/ui/shared", a[1]!);
  return null;
};
const cases: Array<{ name: string; from: "base" | "prev"; paths: string[]; note: string }> = [
  { name: "old-i18n", from: "base", paths: ["/assets/app-i18n.js"], note: "the shared string module a cached browser still holds" },
  { name: "old-shell", from: "base", paths: ["/assets/app-shell.js", "/assets/app-ctx.js"], note: "the app shell modules" },
  { name: "old-thread", from: "base", paths: ["/assets/chat-thread.js"], note: "the chat thread module (this PR changes it)" },
  { name: "old-css", from: "base", paths: ["/assets/app.css"], note: "the stylesheet (this PR changes it)" },
  { name: "old-log-modules", from: "base", paths: ["/ui/js/panel-log.js"], note: "the Log panel from before log-row.js existed" },
  { name: "old-panel", from: "base", paths: ["/ui/js/panel-chat.js"], note: "the chat panel from before the block existed (new server, new thread module)" },
  { name: "prev-head", from: "prev", paths: ["/ui/js/chat-activity.js", "/ui/js/chat-activity-groups.js", "/ui/js/log-row.js", "/ui/js/panel-chat.js"], note: "the previous head's activity modules (the fixes of this review not yet loaded)" },
  { name: "missing-log-row", from: "base", paths: ["/ui/js/log-row.js"], note: "log-row.js not cached/available (404): chat-activity.js imports it" },
];
async function skew() {
  const browser = await browserFor();
  const out: any[] = [];
  const hashes = new Map<string, string>();
  try {
    for (const c of cases) for (const o of [{ lang: "en" as const, dark: false, mobile: false }, { lang: "zh-TW" as const, dark: true, mobile: true }]) {
      const srv = await boot("running", "standard", true);
      const root = c.from === "base" ? BASE : PREV;
      const servedBytes: Array<{ path: string; source: string; sha256: string; currentSha256: string | null; equalToCurrent: boolean | null; status: number }> = [];
      const { ctx, p, errors } = await open(browser, srv, o, async (page) => {
        await page.route((u: URL) => c.paths.includes(u.pathname), async (route: any) => {
          const pth = new URL(route.request().url()).pathname;
          const f = served(root, pth); const cur = served(REPO, pth);
          let bytes: Buffer | null = null; try { bytes = f ? readFileSync(f) : null; } catch { bytes = null; }
          let curBytes: Buffer | null = null; try { curBytes = cur ? readFileSync(cur) : null; } catch { curBytes = null; }
          if (!bytes) { servedBytes.push({ path: pth, source: `${c.from}: absent`, sha256: "", currentSha256: curBytes ? sha(curBytes) : null, equalToCurrent: null, status: 404 }); await route.fulfill({ status: 404, body: "File not found" }); return; }
          servedBytes.push({ path: pth, source: c.from === "base" ? "c1cfcfe03 (upstream base, before the PR)" : "b0feba52f (this PR's previous head)", sha256: sha(bytes), currentSha256: curBytes ? sha(curBytes) : null, equalToCurrent: curBytes ? bytes.equals(curBytes) : null, status: 200 });
          await route.fulfill({ status: 200, contentType: pth.endsWith(".css") ? "text/css" : "application/javascript; charset=utf-8", body: bytes });
        });
      });
      const label = `${c.name}-${o.mobile ? "phone-dark-zhTW" : "desktop-light-en"}`;
      try {
        await p.goto(`${srv.base}/ui/chat/${NAME}`);
        await p.waitForSelector("#msgIn", { timeout: 12000 }).catch(() => {});
        await p.waitForTimeout(3000);
        await working(p, o.lang); await scrollEnd(p);
        const r = await probe(p).catch(() => ({ composer: false, blocks: 0, rows: 0, overflowX: false, steps: 0 }));
        await p.screenshot({ path: join(OUT, `skew-${label}.png`) });
        const chatFailed = [...(p as any).failedRequests];
        // the same browser, same retained files: the Log tab (web.log_tab on for this case)
        await p.goto(`${srv.base}/ui/log/${NAME}`); await p.waitForTimeout(3500);
        const log = await p.evaluate(() => ({ logRows: document.querySelectorAll(".log-item").length, logListPresent: !!document.querySelector(".log-list"), shellPresent: !!document.querySelector("nav, .sidebar, #sidebar") })).catch(() => ({ logRows: -1, logListPresent: false, shellPresent: false }));
        await p.screenshot({ path: join(OUT, `skew-log-${label}.png`) });
        out.push({ case: c.name, view: o.mobile ? "phone-dark-zh-TW" : "desktop-light-en", note: c.note, served: servedBytes, ...r, errors, failedRequests: chatFailed, log, logFailedRequests: [...(p as any).failedRequests].slice(chatFailed.length) });
        console.log("skew", label, JSON.stringify({ composer: r.composer, blocks: r.blocks, errors: errors.length }));
      } finally { await ctx.close(); srv.close(); }
    }
  } finally { await browser.close(); }
  for (const f of ["src/ui/shared/app-i18n.js", "src/ui/shared/app-shell.js", "src/ui/shared/chat-thread.js", "src/ui/shared/app.css", "src/ui/panel-log.js", "src/ui/log-row.js", "src/ui/panel-chat.js", "src/ui/chat-activity.js", "src/ui/chat-activity-groups.js"]) {
    for (const [tag, root] of [["head", REPO], ["prev", PREV], ["base", BASE]] as const) { try { hashes.set(`${tag}:${f}`, sha(readFileSync(join(root, f)))); } catch { hashes.set(`${tag}:${f}`, "(absent)"); } }
  }
  writeFileSync(join(OUT, "skew-receipt.json"), JSON.stringify({ head: REPO, fixture: FIXTURE_SHA, fileHashes: Object.fromEntries(hashes), cases: out }, null, 2));
}

try { if (MODE === "skew") await skew(); else await shots(); } catch (e) { console.log(String((e as Error).stack ?? e).slice(0, 2500)); process.exitCode = 1; }
process.exit(process.exitCode ?? 0);
