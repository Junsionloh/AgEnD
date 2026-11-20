/**
 * AGEND-324 (the user: "after the server restarts every user has to get a code and sign in again"): a browser that is
 * signed in on this computer — over plain http on localhost, or behind a TLS proxy such as `tailscale serve` — stays
 * signed in across a fleet restart, and a sign-out, revocation or token rotation stays final across one.
 *
 * The store-level guarantees are in web-session.test.ts (persistence) and the gate's in web-gate-hardening.test.ts. What
 * neither pins is the whole path a browser takes: a real FleetManager's sign-in over HTTP, a SECOND FleetManager on the
 * same data directory (the restart), and the same cookie, with the cookie's name (derived from the persisted web.token)
 * and the token epoch both having to come out the same. These tests restart exactly that way. The session file is only
 * written at sign-in, sign-out and once a minute, so each case that matters is also run with no graceful flush (a kill).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { request, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import { rotateWebToken } from "../src/web-auth.js";
import type { WebSessionStore } from "../src/web-session.js";

const HOUR = 3_600_000;
const dirs: string[] = [];
const tempDir = (): string => { const d = mkdtempSync(join(tmpdir(), "agend-324-")); dirs.push(d); return d; };
afterEach(() => {
  vi.useRealTimers();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Fleet { fm: FleetManager; port: number; logged: string[] }
interface Browser { cookie: string; csrf: string; origin: string; headers: Record<string, string> }
interface Raw { status: number; headers: Record<string, string | string[] | undefined>; body: string }

function http(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers }, res => {
      let text = "";
      res.on("data", (c: Buffer) => { text += c.toString(); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    r.on("error", reject);
    r.end(body);
  });
}

/** A fleet as `agend fleet start` brings it up for the web: auth first, then the health server on a free port. */
async function startFleet(dir: string): Promise<Fleet> {
  const fm = new FleetManager(dir);
  const logged: string[] = [];
  const line = (obj: unknown, msg?: string): void => { logged.push(`${typeof obj === "string" ? obj : JSON.stringify(obj)} ${msg ?? ""}`); };
  fm.logger = { info: line, warn: line, error: line, debug: line, trace: line, fatal: line, child: () => fm.logger } as unknown as typeof fm.logger;
  (fm as unknown as { initializeWebAuthTokens(): void }).initializeWebAuthTokens();
  (fm as unknown as { startHealthServer(port: number): void }).startHealthServer(0);
  await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
  const address = (fm as unknown as { healthServer: Server }).healthServer.address();
  if (!address || typeof address === "string") throw new Error("missing TCP address");
  return { fm, port: address.port, logged };
}

/** The fleet stops. `graceful`: its shutdown flush ran (a restart); not: it was killed. */
async function stopFleet({ fm }: Fleet, graceful: boolean): Promise<void> {
  if (graceful) (fm as unknown as { webSessions: WebSessionStore | null }).webSessions?.flush();
  const server = (fm as unknown as { healthServer: Server | null }).healthServer;
  await new Promise<void>(resolve => server?.close(() => resolve()));
  (fm as unknown as { healthServer: Server | null }).healthServer = null;
}

/**
 * Sign in the way a browser does: the code from `/dashboard`, posted to /auth/login. `https`: through a TLS proxy
 * (`tailscale serve`, a reverse proxy) — the request still arrives here as plain http on loopback, with the forwarded
 * proto, so the cookie is the `__Host-` one and Secure.
 */
async function signIn({ fm, port }: Fleet, opts: { https?: boolean } = {}): Promise<Browser> {
  const host = `127.0.0.1:${port}`;
  const origin = `${opts.https ? "https" : "http"}://${host}`;
  const base: Record<string, string> = { host, origin, ...(opts.https ? { "x-forwarded-proto": "https" } : {}) };
  const res = await http(port, "POST", "/auth/login", { ...base, "content-type": "application/json" }, JSON.stringify({ code: fm.issueDashboardLogin()!.display }));
  expect(res.status, res.body).toBe(200);
  const cookie = String(([] as string[]).concat(res.headers["set-cookie"] ?? [])[0]).split(";")[0]!;
  expect(cookie.startsWith(opts.https ? "__Host-agend_session" : "agend_session")).toBe(true);
  return { cookie, csrf: JSON.parse(res.body).csrf as string, origin, headers: base };
}

/** The same browser, at a (possibly new) fleet: its cookie, and the origin it uses (a restart can move the port). */
function at(fleet: Fleet, b: Browser): Browser {
  const host = `127.0.0.1:${fleet.port}`;
  const scheme = b.origin.startsWith("https") ? "https" : "http";
  return { ...b, origin: `${scheme}://${host}`, headers: { ...b.headers, host, origin: `${scheme}://${host}` } };
}
const get = (fleet: Fleet, b: Browser, path: string): Promise<Raw> => {
  const { headers } = at(fleet, b);
  const { origin: _origin, ...noOrigin } = headers;     // a page's own GET carries no Origin the gate checks
  return http(fleet.port, "GET", path, { ...noOrigin, cookie: b.cookie });
};
const write = (fleet: Fleet, b: Browser, method: string, path: string): Promise<Raw> =>
  http(fleet.port, method, path, { ...at(fleet, b).headers, cookie: b.cookie, "x-agend-csrf": b.csrf });
const statusOf = async (fleet: Fleet, b: Browser): Promise<number> => (await get(fleet, b, "/status")).status;
const handleOf = async (fleet: Fleet, b: Browser): Promise<string> => JSON.parse((await get(fleet, b, "/auth/session")).body).handle as string;

describe("AGEND-324: a signed-in browser survives a fleet restart", () => {
  for (const graceful of [true, false]) {
    for (const https of [false, true]) {
      it(`${https ? "behind a TLS proxy (__Host- cookie)" : "on localhost"}, ${graceful ? "graceful stop" : "killed (no flush)"}: still signed in, same session, no new code`, async () => {
        const dir = tempDir();
        const first = await startFleet(dir);
        const browser = await signIn(first, { https });
        expect(await statusOf(first, browser)).toBe(200);
        const handle = await handleOf(first, browser);
        await stopFleet(first, graceful);

        const second = await startFleet(dir);
        expect(await statusOf(second, browser), "the cookie it already holds is accepted by the new process").toBe(200);
        expect(await handleOf(second, browser), "the same session, not a new one").toBe(handle);
        // …and it can write: the CSRF value is derived from the session id, so it too is the same after a restart.
        expect((await write(second, browser, "POST", "/auth/logout")).status).toBe(200);
        expect(await statusOf(second, browser)).toBe(401);
        await stopFleet(second, graceful);
      });
    }
  }

  it("through several restarts in a row, and every one of two browsers", async () => {
    const dir = tempDir();
    let fleet = await startFleet(dir);
    const a = await signIn(fleet), b = await signIn(fleet, { https: true });
    for (let i = 0; i < 3; i++) {
      await stopFleet(fleet, i % 2 === 0);
      fleet = await startFleet(dir);
      expect([await statusOf(fleet, a), await statusOf(fleet, b)], `restart ${i + 1}`).toEqual([200, 200]);
    }
    expect(fleet.logged.some(l => l.includes("Web sessions restored")), "the restart says how many sign-ins it kept").toBe(true);
    await stopFleet(fleet, true);
  });

  it("says nothing about restored sessions when there were none (a fresh data directory is not a restart)", async () => {
    const fresh = await startFleet(tempDir());
    expect(fresh.logged.some(l => l.includes("Web sessions restored"))).toBe(false);
    await stopFleet(fresh, true);
  });
});

describe("AGEND-324: what ended a session stays ended across a restart", () => {
  it("Sign out", async () => {
    const dir = tempDir();
    const first = await startFleet(dir);
    const browser = await signIn(first);
    expect((await write(first, browser, "POST", "/auth/logout")).status).toBe(200);
    await stopFleet(first, false);                       // not even a flush: the sign-out itself was written
    const second = await startFleet(dir);
    expect(await statusOf(second, browser)).toBe(401);
    await stopFleet(second, true);
  });

  it("revoking one device ends that one and leaves the other signed in", async () => {
    const dir = tempDir();
    const first = await startFleet(dir);
    const kept = await signIn(first), revoked = await signIn(first, { https: true });
    const victim = await handleOf(first, revoked);
    expect((await write(first, kept, "DELETE", `/auth/sessions/${victim}`)).status).toBe(200);
    await stopFleet(first, false);
    const second = await startFleet(dir);
    expect([await statusOf(second, kept), await statusOf(second, revoked)]).toEqual([200, 401]);
    await stopFleet(second, true);
  });

  it("Sign out everywhere, and /dashboard revoke (which also withdraws the returning devices)", async () => {
    for (const how of ["all devices", "/dashboard revoke"]) {
      const dir = tempDir();
      const first = await startFleet(dir);
      const a = await signIn(first), b = await signIn(first, { https: true });
      if (how === "all devices") expect((await write(first, a, "DELETE", "/auth/sessions")).status, how).toBe(200);
      else expect(first.fm.revokeWebSessions().durable, how).toBe(true);
      await stopFleet(first, false);
      const second = await startFleet(dir);
      expect([await statusOf(second, a), await statusOf(second, b)], how).toEqual([401, 401]);
      // and nothing is stuck: signing in again works, and that one survives the next restart
      const again = await signIn(second);
      await stopFleet(second, true);
      const third = await startFleet(dir);
      expect(await statusOf(third, again), how).toBe(200);
      await stopFleet(third, true);
    }
  });

  it("`agend web-token rotate` while the fleet is down (or up) ends every session, restart or not", async () => {
    const dir = tempDir();
    const first = await startFleet(dir);
    const browser = await signIn(first);
    await stopFleet(first, true);
    rotateWebToken(dir);
    const second = await startFleet(dir);
    expect(await statusOf(second, browser)).toBe(401);
    await stopFleet(second, true);
  });
});

describe("AGEND-324: the session's own limits are not stretched by a restart", () => {
  const T0 = Date.parse("2026-11-20T00:00:00Z");

  it("48 h absolute: activity before a restart does not extend it, and the downtime counts", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });                // Date only: the sockets and the polling keep real timers
    vi.setSystemTime(T0);
    const dir = tempDir();
    let fleet = await startFleet(dir);
    const browser = await signIn(fleet);
    vi.setSystemTime(T0 + 47 * HOUR);
    await stopFleet(fleet, false);
    fleet = await startFleet(dir);
    expect(await statusOf(fleet, browser), "47 h in, across a restart").toBe(200);   // this use slides the idle window to 95 h…
    vi.setSystemTime(T0 + 49 * HOUR);
    await stopFleet(fleet, true);
    fleet = await startFleet(dir);
    expect(await statusOf(fleet, browser), "…but the 48 h cap from the sign-in still ends it").toBe(401);
    await stopFleet(fleet, true);
  });

  it("idle window: a session unused for longer than it while the fleet was down is gone", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const dir = tempDir();
    let fleet = await startFleet(dir);
    // web.session.local as Settings writes it: 10 h absolute, 2 h idle
    (fleet.fm as unknown as { fleetConfig: unknown }).fleetConfig = { instances: {}, web: { session: { local: { absolute_hours: 10, idle_hours: 2 } } } };
    const browser = await signIn(fleet);
    await stopFleet(fleet, true);
    vi.setSystemTime(T0 + 1 * HOUR);
    fleet = await startFleet(dir);
    (fleet.fm as unknown as { fleetConfig: unknown }).fleetConfig = { instances: {}, web: { session: { local: { absolute_hours: 10, idle_hours: 2 } } } };
    expect(await statusOf(fleet, browser), "down for 1 h of a 2 h idle window").toBe(200);   // used at T0+1h: idle runs to T0+3h
    await stopFleet(fleet, true);
    vi.setSystemTime(T0 + 3 * HOUR + 60_000);
    fleet = await startFleet(dir);
    (fleet.fm as unknown as { fleetConfig: unknown }).fleetConfig = { instances: {}, web: { session: { local: { absolute_hours: 10, idle_hours: 2 } } } };
    expect(await statusOf(fleet, browser), "down past the idle window").toBe(401);
    await stopFleet(fleet, true);
  });
});

describe("AGEND-324: what the restart keeps is kept safely", () => {
  it("the session file is 0600, holds no cookie value, and the cookie value is never logged", async () => {
    const dir = tempDir();
    const first = await startFleet(dir);
    const browser = await signIn(first, { https: true });
    await stopFleet(first, true);
    const second = await startFleet(dir);
    expect(await statusOf(second, browser)).toBe(200);
    const value = browser.cookie.slice(browser.cookie.indexOf("=") + 1);
    const file = join(dir, "web-sessions.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).not.toContain(value);
    expect(readFileSync(join(dir, "web.token"), "utf8")).not.toContain(value);
    expect(statSync(join(dir, "web.token")).mode & 0o777).toBe(0o600);
    for (const l of [...first.logged, ...second.logged]) { expect(l).not.toContain(value); expect(l).not.toContain(browser.csrf); }
    await stopFleet(second, true);
  });
});
