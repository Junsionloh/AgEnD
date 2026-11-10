/**
 * AGEND-146 (upstream #3486, the maintainer's follow-up): a browser that is not signed in yet signs in as ONE admin with the code of
 * THAT admin's own authenticator — POST /auth/totp `{ account, code }` — on chat fleets and web-only fleets, on a direct connection
 * and (where the fleet allows it) over a public link. The rules this file holds:
 *   - who: the typed name resolves, among admins that have an app and are still admins, to exactly one; the session is that
 *     account's own (a web-only fleet's is the fleet admin's) and the settings role it gets is the one #3503 gives that admin;
 *   - nothing tells admins apart from strangers: a wrong code, a name that is nobody's, an admin with no app, one demoted since, and a
 *     name two admins share are the same answer (401 wrong_code), counted the same way (the fleet-wide sign-in limit grows for all);
 *   - one use per time step, shared with that admin's confirmations (`lastStep`); limits per admin, per typed name and fleet-wide;
 *   - rechecked as the session is made (same app, still an admin, still allowed here); "Only this computer can authorize" closes it;
 *   - every success is a Notice to the fleet's admins; the 8-character sign-in code is unchanged.
 * The route is driven through the real handler (handleAuthRequest) on the real FleetManager; requests are built as AgEnD sees them.
 */
import { Readable } from "node:stream";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { handleAuthRequest } from "../src/auth-api.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { WEB_CSRF_HEADER } from "../src/web-auth.js";
import { csrfTokenFor, tokenEpoch } from "../src/web-session.js";
import { evaluateSettingsRole } from "../src/authority/settings-role.js";
import { base32Decode, base32Encode, hotp, totpStep, adminKey, HOST_ADMIN_KEY, OUTSIDE_LINK_OWNER, SIGNIN_FLEET_WRONG_LIMIT, SIGNIN_WRONG_LIMIT, TOTP_SIGNIN_OVER_PUBLIC_LINK, WebRemoteAccess, WEB_REMOTE_ACCESS_FILE } from "../src/web-remote-access.js";
import { setLocale } from "../src/locale.js";

const TOKEN = "d".repeat(48), ADMIN = "100", ADMIN_B = "200", NO_APP = "300", STRANGER = "999";
const HOST_SECRET = base32Encode(Buffer.from("0123456789abcdefghij"));
const secretFor = (user: string) => base32Encode(Buffer.from(`secret-for-${user}`.padEnd(20, "#").slice(0, 20)));
/** The code of an app (a secret) `offset` time steps from now. Each step is accepted once per app. */
const codeOf = (secret: string, offset = 0) => hotp(base32Decode(secret)!, totpStep(Date.now()) + offset);
const roots: string[] = [], fleets: any[] = [];
afterEach(() => {
  for (const a of fleets.splice(0)) { a.fm.stormWindow.shutdown(); a.fm.spawnGate.shutdown(); }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const WHERE = {
  tailnetServe: { remoteAddress: "127.0.0.1", host: "agend-box.example-tailnet.ts.net", extra: { "x-forwarded-for": "100.64.0.7", "x-forwarded-proto": "https" } },
  lan: { remoteAddress: "192.0.2.20", host: "192.0.2.5:19280", extra: {} },
  here: { remoteAddress: "127.0.0.1", host: "127.0.0.1:19280", extra: {} },
} as const;
type Where = keyof typeof WHERE;

/**
 * `chat`: a Telegram connection `a` whose admins are ADMIN and ADMIN_B (and NO_APP, who has no app) — ADMIN_B's and ADMIN's apps are seeded;
 * not chat: a web-only fleet with the host operator's app.
 */
function fleet(o: { chat?: boolean; hostApp?: boolean; admins?: string[]; allowed?: string[]; outside?: boolean; va?: Record<string, unknown>; names?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agend-146-")); roots.push(dir);
  const chat = o.chat ?? true, apps = o.admins ?? (chat ? [ADMIN, ADMIN_B] : []);
  const rec = (secret: string) => ({ secret, enrolledAt: 1, lastStep: 0 });
  writeFileSync(join(dir, WEB_REMOTE_ACCESS_FILE), JSON.stringify({ v: 1, ...(o.hostApp ?? !chat ? { totp: rec(HOST_SECRET) } : {}),
    ...(apps.length ? { admins: Object.fromEntries(apps.map(u => [adminKey("a", u), rec(secretFor(u))])) } : {}),
    outside: o.outside ?? false, wrong: 0, level: 0, pausedUntil: 0, handles: [] }), { mode: 0o600 });
  const fm = new FleetManager(dir), any = fm as any;
  fm.fleetConfig = { defaults: { backend: "codex" },
    ...(chat ? { channels: [{ id: "a", type: "telegram", mode: "topic", group_id: "-1001", access: { mode: "locked", allowed_users: o.allowed ?? [ADMIN, ADMIN_B, NO_APP] } }] } : {}),
    web: { verified_authority: { enabled: true, ...o.va } },
    instances: { general: { working_directory: dir, general_topic: true } } } as any;
  writeFileSync(join(dir, "web.token"), TOKEN, { mode: 0o600 }); any.initializeWebSessions();
  fleets.push({ fm, any });
  if (chat && o.names !== false) { any.noteWebSignIn({ adapterId: "a", userId: ADMIN, username: "Alice_TG" }); any.noteWebSignIn({ adapterId: "a", userId: ADMIN_B, username: "bob" }); }
  const notified: string[] = [];
  vi.spyOn(any, "notifyFleetError").mockImplementation(((text: string) => { notified.push(text); return true; }) as any);
  /** The link a public request arrives over (the gateway's own binding), as `openSignin` reports it. */
  const openLink = (owner?: unknown) => { any.publicWebLink = { openSignin: () => ({ exposureId: "x", owner, url: "https://x.trycloudflare.com/signin" }), whenClosed: async () => {}, close: async () => {}, endOf: () => null }; };
  /** POST /auth/totp through the real handler. */
  const totp = (body: unknown, opts: { where?: Where; link?: "quick" | "named"; raw?: string } = {}) => new Promise<{ status: number; headers: Record<string, any>; json: any }>((resolve, reject) => {
    const link = !!opts.link, w = WHERE[opts.where ?? "lan"];
    const host = link ? "x.trycloudflare.com" : w.host, origin = link ? "https://x.trycloudflare.com" : `http://${w.host}`;
    const req: any = Object.assign(Readable.from([Buffer.from(opts.raw ?? JSON.stringify(body))]), { method: "POST", url: "/auth/totp", socket: { remoteAddress: link ? "127.0.0.1" : w.remoteAddress },
      headers: { host, origin, "content-type": "application/json", "sec-fetch-site": "same-origin", "user-agent": "Mozilla/5.0 (iPhone) Safari", ...(link ? {} : w.extra) } });
    if (link) bindGatewayRequest(req, { surface: "gateway", exposureId: "x", expectedOrigin: origin, isCurrent: () => true, named: opts.link === "named" } as any);
    const res: any = { destroyed: false, headersSent: false, writeHead(s: number, h: Record<string, any>) { this.s = s; this.h = h; }, end(b: string) { resolve({ status: this.s, headers: this.h, json: b ? JSON.parse(b) : null }); } };
    try { if (!handleAuthRequest(req, res, new URL(req.url, origin), any)) reject(new Error("not handled")); } catch (err) { reject(err); }
  });
  /** A request carrying the session cookie a sign-in answered with (from where it came). */
  const withCookie = (r: { headers: Record<string, any> }, where: Where, link?: "quick" | "named") => {
    const set = r.headers["Set-Cookie"], cookie = String(Array.isArray(set) ? set[0] : set).split(";")[0]!, sessionId = cookie.split("=")[1]!;
    const w = WHERE[where], host = link ? "x.trycloudflare.com" : w.host, origin = link ? "https://x.trycloudflare.com" : `http://${w.host}`;
    const req: any = { method: "POST", socket: { remoteAddress: link ? "127.0.0.1" : w.remoteAddress }, headers: { host, origin, "sec-fetch-site": "same-origin", cookie, [WEB_CSRF_HEADER]: csrfTokenFor(sessionId), ...(link ? {} : w.extra) } };
    if (link) bindGatewayRequest(req, { surface: "gateway", exposureId: "x", expectedOrigin: origin, isCurrent: () => true, named: link === "named" } as any);
    return { req, sessionId, record: any.webSessions.authenticate(sessionId, tokenEpoch(TOKEN), { touch: false, ...(link ? { surface: "gateway", exposureId: "x" } : { surface: "local" }) }) };
  };
  const access = (): WebRemoteAccess => any.webRemoteAccess();
  const feed = () => (any.webNoticesFeed()?.view().items ?? []).map((n: { text: string }) => n.text);
  return { fm, any, dir, totp, withCookie, openLink, access, notified, feed };
}

const WRONG = { status: 401, json: { error: "wrong_code" } };
const summary = (r: { status: number; json: unknown }) => ({ status: r.status, json: r.json });

describe("who signs in: the admin the name stands for, with their own code", () => {
  it.each(["lan", "tailnetServe", "here"] as const)("chat fleet, direct (%s): the account's own session, and the settings role #3503 gives that admin", async where => {
    const f = fleet();
    const r = await f.totp({ account: "alice_tg", code: codeOf(secretFor(ADMIN)) }, { where });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, tier: "admin" });
    const s = f.withCookie(r, where);
    expect(s.record).toMatchObject({ tier: "admin", surface: "local", owner: { adapterId: "a", userId: ADMIN } });
    expect(s.record.host).toBeUndefined(); expect(s.record.remote).toBeUndefined();
    const { role } = f.any.settingsRole(s.req);
    expect(role).toMatchObject({ ok: true, actor: { adapter_id: "a", user_id: ADMIN }, account: true, onHost: where === "here" });
  });
  it("the other admin signs in as THEMSELVES — by handle, by user id, and by connection:id — and only their own app opens it", async () => {
    const f = fleet();
    for (const [account, offset] of [["@BOB", -1], [ADMIN_B, 0], ["a:200", 1]] as const) {
      const r = await f.totp({ account, code: codeOf(secretFor(ADMIN_B), offset) });
      expect(r.status).toBe(200);
      expect(f.withCookie(r, "lan").record.owner).toEqual({ adapterId: "a", userId: ADMIN_B });
    }
    // Alice's name with Bob's code is just a wrong code.
    expect(summary(await f.totp({ account: "alice_tg", code: codeOf(secretFor(ADMIN_B), 2) }))).toEqual(WRONG);
  });
  it("chat fleet over a public link: allowed, the account's session over the gateway (its role still follows the link's option)", async () => {
    const f = fleet({ va: { quick_link: true } });
    f.openLink();
    const r = await f.totp({ account: "bob", code: codeOf(secretFor(ADMIN_B)) }, { link: "quick" });
    expect(r.status).toBe(200);
    const s = f.withCookie(r, "lan", "quick");
    expect(s.record).toMatchObject({ surface: "gateway", exposureId: "x", owner: { adapterId: "a", userId: ADMIN_B } });
    expect(f.any.settingsRole(s.req).role).toMatchObject({ ok: true, actor: { user_id: ADMIN_B } });
    // The link's option off: signed in, but no say over held changes (unchanged #3503 rule).
    const off = fleet({ va: { quick_link: false } }); off.openLink();
    const r2 = await off.totp({ account: "bob", code: codeOf(secretFor(ADMIN_B)) }, { link: "quick" });
    expect(r2.status).toBe(200);
    expect(off.any.settingsRole(off.withCookie(r2, "lan", "quick").req).role).toEqual({ ok: false, reason: "link_off" });
  });
  it("chat fleet, no link open for that exposure: 404 as if the route were not there; the central switch is one constant, read in one place", async () => {
    const f = fleet();
    expect((await f.totp({ account: "bob", code: codeOf(secretFor(ADMIN_B)) }, { link: "quick" })).status).toBe(404);   // no link is open
    expect(TOTP_SIGNIN_OVER_PUBLIC_LINK).toBe(true);
    const src = readFileSync(join(process.cwd(), "src", "fleet-manager.ts"), "utf8");
    const code = src.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l) && l.includes("TOTP_SIGNIN_OVER_PUBLIC_LINK"));
    expect(code).toHaveLength(2);                                                                                         // the import and the one decision
  });
  it("web-only fleet, direct: the fleet's one admin (the host operator), no name needed; the session is the plain admin session, role = host operator", async () => {
    const f = fleet({ chat: false });
    const r = await f.totp({ code: codeOf(HOST_SECRET) }, { where: "tailnetServe" });
    expect(r.status).toBe(200);
    const s = f.withCookie(r, "tailnetServe");
    expect(s.record).toMatchObject({ tier: "admin", surface: "local" });
    expect([s.record.owner, s.record.host, s.record.remote]).toEqual([undefined, undefined, undefined]);
    expect(f.any.settingsRole(s.req).role).toMatchObject({ ok: true, actor: { adapter_id: "host", user_id: "operator" }, account: false });
  });
  it("web-only fleet over the outside link (as before, #3008): the remote session, authorized as this computer's admin", async () => {
    const f = fleet({ chat: false, outside: true });
    f.openLink(OUTSIDE_LINK_OWNER);
    const r = await f.totp({ code: codeOf(HOST_SECRET) }, { link: "quick" });
    expect(r.status).toBe(200);
    const s = f.withCookie(r, "lan", "quick");
    expect(s.record).toMatchObject({ remote: "totp", surface: "gateway", exposureId: "x" });
    expect(s.record.owner).toBeUndefined();
    expect(f.any.settingsRole(s.req).role).toMatchObject({ ok: true, outsideSession: true });
    // …and a web-only fleet's OTHER links stay closed to it: only the outside link.
    const other = fleet({ chat: false, outside: false }); other.openLink();
    expect((await other.totp({ code: codeOf(HOST_SECRET) }, { link: "quick" })).status).toBe(404);
  });
  it("a chat fleet's host operator (the `agend web` session on the computer) cannot be signed in as, nor anyone as a chat account without an app", async () => {
    const f = fleet({ admins: [ADMIN, ADMIN_B], hostApp: true });
    expect(f.access().isEnrolled(HOST_ADMIN_KEY)).toBe(true);
    for (const account of ["host", "operator", "host:operator", ""]) expect(summary(await f.totp({ account, code: codeOf(HOST_SECRET) }))).toEqual(WRONG);
    expect(summary(await f.totp({ code: codeOf(HOST_SECRET, 1) }))).toEqual(WRONG);                // no name at all: never a match against "everyone"
  });
  it("the session is never more than the admin session of that account: no host flag, no authorization, nothing an agent takes as a go-ahead", async () => {
    const f = fleet();
    const r = await f.totp({ account: "alice_tg", code: codeOf(secretFor(ADMIN)) });
    const s = f.withCookie(r, "lan");
    expect(s.record).not.toHaveProperty("host");
    expect(f.any.sessionAuthorizationStore()?.list() ?? []).toEqual([]);
    expect(f.any.webAuthority({ session: s.record, gateway: false, peer: "lan" }).authority.kind).toBe("none");
  });
});

describe("nothing tells admins from strangers: one answer, the same counting", () => {
  it("a wrong code, a name that is nobody's, an admin with no app, a demoted admin, a shared name: the same 401 body and headers", async () => {
    // ADMIN is demoted (not in the list any more); NO_APP is an admin with no app; ALICE and a second "alice" share a name.
    const f = fleet({ allowed: [ADMIN_B, NO_APP, "400"], admins: [ADMIN_B, "400"], names: false });
    f.any.noteWebSignIn({ adapterId: "a", userId: ADMIN_B, username: "twin" }); f.any.noteWebSignIn({ adapterId: "a", userId: "400", username: "TWIN" });
    const good = codeOf(secretFor(ADMIN_B));
    const answers = await Promise.all([
      f.totp({ account: ADMIN_B, code: "000000" }),                       // a real admin, a wrong code
      f.totp({ account: "ghost", code: good }),                           // no such name (the right code of someone else)
      f.totp({ account: NO_APP, code: good }),                            // an admin with no app
      f.totp({ account: STRANGER, code: good }),                          // an account that is not an admin
      f.totp({ account: "twin", code: good }),                            // a name two admins answer to: nobody's
    ]);
    for (const a of answers) expect([a.status, a.json, a.headers]).toEqual([401, { error: "wrong_code" }, { "Content-Type": "application/json" }]);
    expect(f.any.webSessions.list(undefined, () => true)).toEqual([]);
    // …and they stay answerable by the unambiguous form.
    expect((await f.totp({ account: "a:200", code: codeOf(secretFor(ADMIN_B), 1) })).status).toBe(200);
  });
  it("a demoted admin and one whose app was replaced cannot sign in; a name no longer an admin's is nobody's", async () => {
    const f = fleet();
    f.fm.fleetConfig!.channels![0]!.access!.allowed_users = [ADMIN_B];                       // ADMIN demoted
    expect(summary(await f.totp({ account: "alice_tg", code: codeOf(secretFor(ADMIN)) }))).toEqual(WRONG);
    // ADMIN_B's app replaced: the old code no longer works, the new one does.
    const b = f.access().beginEnrollment("h", "x", adminKey("a", ADMIN_B));
    expect(f.access().confirmEnrollment("h", codeOf(b.secret, -1))).toBe("ok");
    expect(summary(await f.totp({ account: "bob", code: codeOf(secretFor(ADMIN_B), 1) }))).toEqual(WRONG);
    expect((await f.totp({ account: "bob", code: codeOf(b.secret, 1) })).status).toBe(200);
  });
  it("a name that is nobody's counts toward the fleet-wide sign-in limit exactly as a real admin's wrong code does (state is saved either way)", async () => {
    const f = fleet();
    const saved = () => JSON.parse(readFileSync(join(f.dir, WEB_REMOTE_ACCESS_FILE), "utf8"));
    await f.totp({ account: "ghost", code: "000000" });
    expect(saved().signin.wrong).toBe(1);
    await f.totp({ account: "bob", code: "000000" });
    expect(saved().signin.wrong).toBe(2);
    expect(saved().admins[adminKey("a", ADMIN_B)].lim.wrong).toBe(1);                         // the real admin's own count; a ghost has none to show
    expect(saved().admins[adminKey("a", ADMIN)].lim).toBeUndefined();
  });
  it("timing: the same work for both — a decoy secret is compared when there is no admin (the store's verdicts are the same shape)", () => {
    const store = new WebRemoteAccess(join(fleet().dir, WEB_REMOTE_ACCESS_FILE), { warn: () => {} });
    expect(store.signIn(adminKey("a", ADMIN), "x", "000000")).toEqual({ kind: "wrong" });
    expect(store.signIn(null, "y", "000000")).toEqual({ kind: "wrong" });
    expect(store.signIn(adminKey("a", "nobody"), "z", "000000")).toEqual({ kind: "wrong" });  // a key with no record: the same as none
  });
  it("a body that is not {code, account} strings is a 400 (and says nothing about admins); a cross-site or non-JSON POST is refused", async () => {
    const f = fleet();
    expect((await f.totp({ account: 5, code: "000000" })).status).toBe(400);
    expect((await f.totp({ account: "x".repeat(300), code: "000000" })).status).toBe(400);
    expect((await f.totp({ code: 123456 })).status).toBe(400);
    expect((await f.totp(null, { raw: "not json" })).status).toBe(400);
  });
});

describe("one use per time step, shared with the admin's confirmations", () => {
  it("the same code (the same step) cannot sign in twice; a confirmation that used a step blocks sign-in with it, and the other way round", async () => {
    const f = fleet();
    const code = codeOf(secretFor(ADMIN));
    expect((await f.totp({ account: "alice_tg", code })).status).toBe(200);
    expect(summary(await f.totp({ account: "alice_tg", code }))).toEqual(WRONG);              // used
    expect(f.access().verify(code, adminKey("a", ADMIN))).toMatchObject({ kind: "wrong" });   // …and a confirmation cannot reuse it either
    // A confirmation uses the next step: sign-in cannot use it afterwards.
    const next = codeOf(secretFor(ADMIN), 1);
    expect(f.access().verify(next, adminKey("a", ADMIN))).toEqual({ kind: "ok" });
    expect(summary(await f.totp({ account: "alice_tg", code: next }))).toEqual(WRONG);
  });
  it("a sign-in's wrong codes do not touch the confirmation limiter (an open route cannot pause admins who are signed in)", async () => {
    const f = fleet();
    for (let n = 0; n < SIGNIN_WRONG_LIMIT + 2; n++) await f.totp({ account: "bob", code: "000000" });
    expect(f.access().status(adminKey("a", ADMIN_B)).pausedForMs).toBe(0);
    expect(f.access().verify(codeOf(secretFor(ADMIN_B)), adminKey("a", ADMIN_B))).toEqual({ kind: "ok" });
  });
});

describe("limits: per admin, per name typed, and fleet-wide", () => {
  it("five wrong codes for one admin pause THEM (429 with the wait), the right code included; another admin is not paused", async () => {
    const f = fleet();
    for (let n = 1; n < SIGNIN_WRONG_LIMIT; n++) expect((await f.totp({ account: "bob", code: "000000" })).status).toBe(401);
    const fifth = await f.totp({ account: "bob", code: "000000" });
    expect([fifth.status, fifth.json.error, fifth.headers["Retry-After"]]).toEqual([429, "paused", "900"]);
    expect(fifth.json.retryAfterMs).toBe(15 * 60_000);
    const during = await f.totp({ account: "bob", code: codeOf(secretFor(ADMIN_B)) });
    expect(during.status).toBe(429);
    // Their other names (id) share the admin's own count, so the pause cannot be walked around…
    expect((await f.totp({ account: ADMIN_B, code: codeOf(secretFor(ADMIN_B), 1) })).status).toBe(429);
    // …and another admin signs in as usual.
    expect((await f.totp({ account: "alice_tg", code: codeOf(secretFor(ADMIN)) })).status).toBe(200);
    // A Notice says it (to the admins), once.
    expect(f.notified.filter(t => /paused/.test(t)).length).toBe(1);
  });
  it("a name that is nobody's is paused the same way after the same number of tries (so the pause itself says nothing)", async () => {
    const f = fleet();
    for (let n = 1; n < SIGNIN_WRONG_LIMIT; n++) expect((await f.totp({ account: "ghost", code: "000000" })).status).toBe(401);
    expect((await f.totp({ account: "ghost", code: "000000" })).status).toBe(429);
    expect(f.notified.filter(t => /paused/.test(t)).length).toBe(0);                        // a stranger's name is no Notice (a flood must not flood)
  });
  it("the whole sign-in has one limit, and names that are nobody's count in it: past it everyone is paused, the right code too", async () => {
    const f = fleet();
    // 4 wrong codes for each of several different names stays under every per-name limit, and only the fleet-wide one stops it.
    let last = 0, n = 0;
    while (last !== 429 && n < SIGNIN_FLEET_WRONG_LIMIT + 5) { last = (await f.totp({ account: `ghost${Math.floor(n / 4)}`, code: "000000" })).status; n++; }
    expect(n).toBe(SIGNIN_FLEET_WRONG_LIMIT);
    const real = await f.totp({ account: "alice_tg", code: codeOf(secretFor(ADMIN)) });
    expect([real.status, real.json.error]).toEqual([429, "paused"]);
    expect(f.notified.filter(t => /paused/.test(t)).length).toBe(1);                        // the fleet-wide one is said
  });
  it("a correct code ends that admin's own count (and the fleet-wide one)", async () => {
    const f = fleet();
    for (let n = 0; n < SIGNIN_WRONG_LIMIT - 1; n++) await f.totp({ account: "bob", code: "000000" });
    expect((await f.totp({ account: ADMIN_B, code: codeOf(secretFor(ADMIN_B)) })).status).toBe(200);
    const saved = JSON.parse(readFileSync(join(f.dir, WEB_REMOTE_ACCESS_FILE), "utf8"));
    expect([saved.signin, saved.admins[adminKey("a", ADMIN_B)].lim]).toEqual([undefined, undefined]);
  });
  it("a limiter survives a restart (it is saved with the app file)", async () => {
    const f = fleet();
    for (let n = 0; n < SIGNIN_WRONG_LIMIT; n++) await f.totp({ account: "bob", code: "000000" });
    const reopened = new WebRemoteAccess(join(f.dir, WEB_REMOTE_ACCESS_FILE), { warn: () => {} });
    expect(reopened.signIn(adminKey("a", ADMIN_B), "other-name", codeOf(secretFor(ADMIN_B)))).toMatchObject({ kind: "paused" });
  });
});

describe("rechecked as the session is made", () => {
  it("the app replaced, or the admin demoted, between the code and the session: no session, nothing admitted", () => {
    const f = fleet(), code = codeOf(secretFor(ADMIN));
    const first = f.any.totpSignIn({ exposureId: undefined, peer: "lan", account: "alice_tg", code });
    expect(first.kind).toBe("ok");
    const b = f.access().beginEnrollment("h", "x", adminKey("a", ADMIN)); f.access().confirmEnrollment("h", codeOf(b.secret, -1));
    const rec = f.any.webSessions.create({ tier: "admin", surface: "local", label: "x", tokenEpoch: tokenEpoch(TOKEN), owner: first.session.owner }).record;
    expect(first.commit(rec, "x")).toBe(false);
    const second = f.any.totpSignIn({ exposureId: undefined, peer: "lan", account: "alice_tg", code: codeOf(b.secret, 1) });
    expect(second.kind).toBe("ok");
    f.fm.fleetConfig!.channels![0]!.access!.allowed_users = [ADMIN_B];
    expect(second.commit(rec, "x")).toBe(false);
  });
  it("the HTTP answer for a refused commit is 503 and the session is gone", async () => {
    const f = fleet();
    vi.spyOn(f.any, "totpSignIn").mockImplementation((() => ({ kind: "ok", session: { owner: { adapterId: "a", userId: ADMIN } }, commit: () => false })) as any);
    const r = await f.totp({ account: "alice_tg", code: "123456" });
    expect([r.status, r.json]).toEqual([503, { error: "unavailable" }]);
    expect(f.any.webSessions.list(undefined, () => true)).toEqual([]);
  });
  it.each([["lan"], ["tailnetServe"]] as const)("\"Only this computer can authorize\": refused from %s (404, nothing counted), and over a link; this computer's own browser still signs in", async where => {
    const f = fleet({ va: { loopback_only: true } });
    expect((await f.totp({ account: "alice_tg", code: codeOf(secretFor(ADMIN)) }, { where })).status).toBe(404);
    f.openLink();
    expect((await f.totp({ account: "alice_tg", code: codeOf(secretFor(ADMIN)) }, { link: "quick" })).status).toBe(404);
    expect(() => readFileSync(join(f.dir, WEB_REMOTE_ACCESS_FILE), "utf8")).not.toThrow();
    expect(JSON.parse(readFileSync(join(f.dir, WEB_REMOTE_ACCESS_FILE), "utf8")).signin).toBeUndefined();   // refused before anything is counted
    expect((await f.totp({ account: "alice_tg", code: codeOf(secretFor(ADMIN)) }, { where: "here" })).status).toBe(200);
  });
  it("the same on a web-only fleet", async () => {
    const f = fleet({ chat: false, va: { loopback_only: true } });
    expect((await f.totp({ code: codeOf(HOST_SECRET) }, { where: "lan" })).status).toBe(404);
    expect((await f.totp({ code: codeOf(HOST_SECRET) }, { where: "here" })).status).toBe(200);
  });
});

describe("every success tells the fleet's admins", () => {
  it("a Notice names who, the device and how, goes to General AND the dashboard's Notices once; no code or secret in it", async () => {
    const f = fleet();
    const code = codeOf(secretFor(ADMIN));
    expect((await f.totp({ account: "alice_tg", code })).status).toBe(200);
    const notices = f.feed();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/signed in from a new browser with their authenticator code/);
    expect(notices[0]).toMatch(/direct connection/);
    expect(f.notified).toHaveLength(1);
    for (const text of [...notices, ...f.notified]) { expect(text).not.toContain(code); expect(text).not.toContain(secretFor(ADMIN)); }
  });
  it("with no General to post to, the web Notices carry it; over a link it says so", async () => {
    const f = fleet(); f.openLink();
    vi.spyOn(f.any, "notifyFleetError").mockImplementation((() => false) as any);
    expect((await f.totp({ account: "bob", code: codeOf(secretFor(ADMIN_B)) }, { link: "quick" })).status).toBe(200);
    expect(f.feed()).toHaveLength(1);
    expect(f.feed()[0]).toMatch(/public link/);
  });
  it("a web-only fleet's success is a Notice too", async () => {
    const f = fleet({ chat: false });
    expect((await f.totp({ code: codeOf(HOST_SECRET) })).status).toBe(200);
    expect(f.feed().length + f.notified.length).toBeGreaterThan(0);
  });
});

describe("what is unchanged", () => {
  it("the 8-character sign-in code still signs in (a web-only fleet's `agend web --code`), authenticator or not", async () => {
    const f = fleet({ chat: false });
    const issued = f.any.webLoginCodes.issue({ tier: "admin", epoch: tokenEpoch(TOKEN), host: true });
    const req: any = Object.assign(Readable.from([Buffer.from(JSON.stringify({ code: issued.display }))]), { method: "POST", url: "/auth/login", socket: { remoteAddress: "127.0.0.1" },
      headers: { host: "127.0.0.1:19280", origin: "http://127.0.0.1:19280", "content-type": "application/json", "sec-fetch-site": "same-origin", "user-agent": "Safari" } });
    const out = await new Promise<number>(resolve => {
      const res: any = { destroyed: false, headersSent: false, writeHead(s: number) { this.s = s; }, end() { resolve(this.s); }, once() {}, removeListener() {} };
      handleAuthRequest(req, res, new URL(req.url, "http://127.0.0.1:19280"), f.any);
    });
    expect(out).toBe(200);
  });
  it("an admin with no app has no authenticator route: only the 8-character code (the name is answered as nobody's)", async () => {
    const f = fleet();
    expect(summary(await f.totp({ account: NO_APP, code: "123456" }))).toEqual(WRONG);
  });
  it("the page lists nobody and offers no suggestions: no admin names, no datalist, autocomplete off", async () => {
    const html = readFileSync(join(process.cwd(), "src", "ui", "signin-authenticator.html"), "utf8");
    expect(html).not.toMatch(/datalist|list="/i);
    expect(html).toMatch(/id="account"[^>]*autocomplete="off"/);
    const js = readFileSync(join(process.cwd(), "src", "ui", "shared", "signin-authenticator.js"), "utf8");
    expect(js).not.toMatch(/\/auth\/(sessions|device-login)|admins|enumerate/);
  });
  it("the status a signed-in admin reads says what THEY type as the name (their handle, else their id) — never anyone else's", () => {
    const f = fleet();
    const a = f.withCookie({ headers: { "Set-Cookie": `agend_session=${f.any.webSessions.create({ tier: "admin", surface: "local", label: "x", tokenEpoch: tokenEpoch(TOKEN), owner: { adapterId: "a", userId: ADMIN } }).sessionId}` } }, "lan");
    expect(f.any.webOutsideStatus(a.req)).toMatchObject({ enrolled: true, signinName: "Alice_TG" });
    const g = fleet({ names: false }), b = g.withCookie({ headers: { "Set-Cookie": `agend_session=${g.any.webSessions.create({ tier: "admin", surface: "local", label: "x", tokenEpoch: tokenEpoch(TOKEN), owner: { adapterId: "a", userId: ADMIN_B } }).sessionId}` } }, "lan");
    expect(g.any.webOutsideStatus(b.req)).toMatchObject({ signinName: ADMIN_B });
  });
  it("a stranger's session cookie, a guest's and a header token never reach the route's result (it takes only a code and a name)", async () => {
    const f = fleet();
    const guest = f.any.webSessions.create({ tier: "guest", surface: "local", label: "g", tokenEpoch: tokenEpoch(TOKEN), owner: { adapterId: "a", userId: STRANGER } });
    expect(evaluateSettingsRole({ session: guest.record, gateway: false, peer: "lan", tokenEpoch: tokenEpoch(TOKEN), webOnly: false,
      policy: { enabled: true, loopbackOnly: false, namedLink: false, quickLink: true }, isAdmin: () => true, outside: null })).toEqual({ ok: false, reason: "not_admin_session" });
    expect(summary(await f.totp({ account: STRANGER, code: "123456" }))).toEqual(WRONG);
  });
});
