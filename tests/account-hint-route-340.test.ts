/**
 * AGEND-340, where the hint is said (the rule and the facts are tests/account-hint-340.test.ts):
 *  - GET /ui/account-hint/<agent>: the fleet's admin session only (it names accounts) — no session, a guest, a gateway session and
 *    the web token get nothing; an agent with an account, a default that works or an unknown name get no hint or a 404;
 *  - a failed Start or Restart answers with its error AND the hint, so the toast says where the account is; a start that fails for an
 *    agent with nothing to say carries none;
 *  - the auth-error incident the instance lifecycle posts names the signed-in account beside its `/login` remedy.
 * A real listener on a scratch AGEND_HOME (the harness of tests/accounts-route-3212.test.ts and tests/web-send-dedupe.test.ts).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("../src/logger.js", async original => {
  const silent: Record<string, unknown> = new Proxy({}, { get: (_t, key) => (key === "child" ? () => silent : key === "level" ? "silent" : () => {}) });
  return { ...await original<typeof import("../src/logger.js")>(), createLogger: () => silent };
});
import { request } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "agend-hint-home-"));
process.env.AGEND_HOME = home;
const { FleetManager } = await import("../src/fleet-manager.js");
const { WEB_CSRF_HEADER, WEB_SESSION_COOKIE } = await import("../src/web-auth.js");
const { csrfTokenFor, tokenEpoch } = await import("../src/web-session.js");
const { InstanceLifecycle } = await import("../src/instance-lifecycle.js");

function raw(port: number, method: string, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let b = ""; res.on("data", (c: Buffer) => { b += c.toString(); }); res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
    });
    r.on("error", reject); r.end();
  });
}
let fm: any, port = 0, dir: string;
const session = (tier: "admin" | "guest", surface: "local" | "gateway" = "local", owner?: { adapterId: string; userId: string }) =>
  fm.webSessions.create({ tier, surface, label: tier, tokenEpoch: tokenEpoch(fm.getDashboardAccess().token!), ...(owner ? { owner } : {}), ...(surface === "gateway" ? { exposureId: "e1" } : {}) }).sessionId as string;
const get = (sid: string | null, path: string) => raw(port, "GET", path, sid ? { cookie: `${WEB_SESSION_COOKIE}=${sid}` } : {});
const post = (sid: string, path: string) => raw(port, "POST", path, { cookie: `${WEB_SESSION_COOKIE}=${sid}`, origin: `http://127.0.0.1:${port}`, [WEB_CSRF_HEADER]: csrfTokenFor(sid), "content-type": "application/json" });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agend-hint-fleet-"));
  const work = join(dir, "w"); mkdirSync(work);
  const profile = join(dir, "credential-profiles", "claude-code", "work");
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "00000000-0000-4000-8000-000000000001" } }));
  writeFileSync(join(profile, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "c".repeat(32), refreshToken: "c".repeat(32), expiresAt: Date.now() + 86_400_000 } }));
  writeFileSync(join(dir, "fleet.yaml"), [
    "health_port: 0", "instances:",
    `  dev:\n    working_directory: ${work}\n    backend: claude-code`,
    `  own:\n    working_directory: ${work}\n    backend: claude-code\n    backend_options:\n      claude-code:\n        credential_profile: work`,
  ].join("\n") + "\n");
  fm = new FleetManager(dir);
  const q = () => {}; fm.logger = { info: q, warn: q, error: q, debug: q, trace: q, fatal: q, child: () => fm.logger };
  fm.notifyFleetError = () => true; fm.loadConfig(join(dir, "fleet.yaml"));
  fm.lifecycle = { isPaused: () => false, hasWorkLease: () => false, daemons: new Map() };
  fm.getInstanceStatus = () => "running";
  // The host's CLI states are a fact of the machine running the test: say what they are.
  fm.backendSignInTargets = () => [{ backend: "claude-code", state: "not_signed_in", signIn: true }];
  fm.initializeWebAuthTokens(); fm.startHealthServer(0);
  await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
  port = (fm.healthServer.address() as { port: number }).port;
  fm.initializeWebSessions?.();
}, 30_000);
afterAll(async () => {
  await new Promise<void>((r) => fm.healthServer?.close(() => r()));
  rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
});

describe("GET /ui/account-hint/<agent>", () => {
  it("an admin session: the hint for an agent on no account; none (null) for one with an account; 404 for a name that is no agent", async () => {
    const sid = session("admin");
    const dev = await get(sid, "/ui/account-hint/dev");
    expect(dev.status).toBe(200);
    expect(JSON.parse(dev.body)).toEqual({ hint: { backend: "claude-code", accounts: ["work"], only: "work", label: "Claude Code" } });
    expect(JSON.parse((await get(sid, "/ui/account-hint/own")).body)).toEqual({ hint: null });
    expect((await get(sid, "/ui/account-hint/nobody")).status).toBe(404);
    expect((await get(sid, "/ui/account-hint/constructor")).status).toBe(404);
  });
  it("counter-evidence: no session, a guest, a gateway session and the web token get nothing of the accounts", async () => {
    expect((await get(null, "/ui/account-hint/dev")).status).toBe(401);
    for (const sid of [session("guest", "local", { adapterId: "discord", userId: "111111111111111111" }), session("admin", "gateway")]) {
      const r = await get(sid, "/ui/account-hint/dev");
      expect([401, 403, 404]).toContain(r.status);
      expect(r.body).not.toContain("work");
    }
    const token = await raw(port, "GET", "/ui/account-hint/dev", { "x-agend-token": fm.getDashboardAccess().token! });
    expect(token.status).toBe(403);
    expect(token.body).not.toContain("work");
  });
});

describe("a failed Start or Restart", () => {
  it("answers with the error and the hint, so the toast says where the account is", async () => {
    const sid = session("admin");
    fm.startInstance = async () => { throw new Error("could not start"); };
    fm.restartSingleInstance = async () => { throw new Error("could not restart"); };
    for (const [verb, error] of [["start", "could not start"], ["restart", "could not restart"]] as const) {
      const r = await post(sid, `/ui/${verb}/dev`);
      expect(r.status, verb).toBe(500);
      const body = JSON.parse(r.body);
      expect(body.error).toBe(error);
      expect(body.hint).toBe("Claude Code is not signed in on this host, and dev uses no account of its own, so it cannot start. The Claude Code account work is signed in: choose one for dev in its settings (Details → Runtime → Account).");
    }
  });
  it("counter-evidence: an agent with an account, and a failure that is not a start (404), carry no hint", async () => {
    const sid = session("admin");
    fm.startInstance = async () => { throw new Error("could not start"); };
    const own = await post(sid, "/ui/start/own");
    expect(own.status).toBe(500);
    expect(JSON.parse(own.body)).toEqual({ error: "could not start" });
    const missing = await post(sid, "/ui/start/nobody");
    expect(missing.status).toBe(404);
    expect(JSON.parse(missing.body).hint).toBeUndefined();
  });
});

describe("the auth-error incident", () => {
  /** What the lifecycle posts for an agent stopped at the CLI's sign-in screen (its own notifier, a fake fleet around it). */
  function incident(accountHintText: ((name: string) => string | null) | undefined, profile: string | null) {
    const posted: string[] = [];
    const ctx: any = {
      logger: { info() {}, warn() {}, error() {}, debug() {} }, fleetConfig: { instances: { dev: {} }, defaults: {} }, dataDir: dir, accountHintText,
      credentialProfileOf: () => profile, backendNameForInstance: () => "claude-code",
    };
    const lc: any = Object.create(InstanceLifecycle.prototype);
    Object.assign(lc, { ctx, daemons: new Map([["dev", {}]]), lastAuthAlertAt: new Map(), backendOf: () => "claude-code", profileOf: () => profile,
      notifyIncident: (_to: string, _kind: string, text: string) => { posted.push(text); return true; }, authErrorButton: () => {}, maybeOfferLoginButton: () => {} });
    try { lc.notifyAuthErrorOnce("dev", "CLI is waiting at its sign-in screen — credentials are missing or expired", "dev"); } catch { /* the rest of the notifier is not under test */ }
    return posted[0] ?? "";
  }
  it("names the signed-in account beside the /login remedy when the agent uses none; says nothing extra otherwise", () => {
    const hint = "Claude Code is not signed in on this host, and dev uses no account of its own, so it cannot start. The Claude Code account work is signed in: choose one for dev in its settings (Details → Runtime → Account).";
    const withHint = incident(() => hint, null);
    expect(withHint).toContain("Use `/login claude-code` to re-login remotely.");
    expect(withHint.endsWith(`\n\n${hint}`)).toBe(true);
    expect(incident(() => null, null)).not.toContain("is signed in:");
    expect(incident(undefined, null)).not.toContain("account of its own");
    // An agent that already names an account is told about THAT login, never about another: no hint line.
    expect(incident(() => hint, "work")).not.toContain("account of its own");
    // A hint that throws never costs the notice.
    expect(incident(() => { throw new Error("boom"); }, null)).toContain("credentials are missing or expired");
  });
});
