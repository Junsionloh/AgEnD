/**
 * AGEND-122 (upstream design issue #3486, R1): a signed-in human fleet admin confirms a held Settings change by pressing Apply now
 * from wherever the dashboard is reached, for every kind of change, on a chat fleet and a web-only one alike; the owner's stricter
 * option (`web.verified_authority.remote_confirm_code`) asks for the authenticator's code off the AgEnD computer instead.
 *   - classification: a tailnet-style request (a Host that is not loopback, a forwarding header, a peer that is this machine behind
 *     `tailscale serve`, or a tailnet address of its own) is `lan` on the `local` surface — not a link; only the gateway's binding is;
 *   - the role (settings-role.ts), as a pure decision: who qualifies and the first check each other caller fails;
 *   - the default: every change class (a secret, access, a connection, an outward Hub change, opening a link) gets Apply now from this
 *     computer, a tailnet-style request and the public gateway; never an agent's request, a guest, a header token, the switch off, or
 *     "Only this computer can authorize" off this computer;
 *   - the page is told it is remote (`remote: true`) so the card names no host command.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { SettingsConfirmationStore } from "../src/settings-confirmation.js";
import { SettingsHttpConfirmation } from "../src/settings-http-confirmation.js";
import { requestSettingsConfirmation } from "../src/settings-control.js";
import { prepareSettingsEffect } from "../src/settings-effect.js";
import { classifyWebPeer } from "../src/authority/web-authority.js";
import { evaluateSettingsRole, type SettingsRoleInput } from "../src/authority/settings-role.js";
import { webPeerOf } from "../src/web-api.js";
import { authorizeSession, WEB_CSRF_HEADER } from "../src/web-auth.js";
import { csrfTokenFor, tokenEpoch, type SessionRecord } from "../src/web-session.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { base32Encode, base32Decode, hotp, totpStep, WEB_REMOTE_ACCESS_FILE } from "../src/web-remote-access.js";

const TOKEN = "d".repeat(48), ADMIN = "100";
const SECRET = base32Encode(Buffer.from("0123456789abcdefghij"));
const codeAt = (ms: number) => hotp(base32Decode(SECRET)!, totpStep(ms));
const roots: string[] = [], stores: SettingsConfirmationStore[] = [], fleets: any[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const a of fleets.splice(0)) { a.fm.stormWindow.shutdown(); a.fm.spawnGate.shutdown(); }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Where a request comes from, as AgEnD sees it. Names and addresses are documentation values, never a real one. */
const WHERE = {
  /** `tailscale serve`: it proxies from this machine, with the tailnet name as Host and a forwarding header. */
  tailnetServe: { remoteAddress: "127.0.0.1", host: "agend-box.example-tailnet.ts.net", extra: { "x-forwarded-for": "100.64.0.7", "x-forwarded-proto": "https" } },
  /** The tailnet address of this machine, reached directly. */
  tailnetDirect: { remoteAddress: "100.64.0.7", host: "100.64.0.1:19280", extra: {} },
  lan: { remoteAddress: "192.0.2.20", host: "192.0.2.5:19280", extra: {} },
  here: { remoteAddress: "127.0.0.1", host: "127.0.0.1:19280", extra: {} },
} as const;
type Where = keyof typeof WHERE;

function fleet(o: { enrolled?: boolean; chat?: boolean; outside?: boolean; va?: Record<string, unknown> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agend-122-")); roots.push(dir);
  if (o.enrolled) writeFileSync(join(dir, WEB_REMOTE_ACCESS_FILE), JSON.stringify({ v: 1, totp: { secret: SECRET, enrolledAt: 1, lastStep: 0 }, outside: o.outside ?? true, wrong: 0, level: 0, pausedUntil: 0, handles: [] }), { mode: 0o600 });
  const fm = new FleetManager(dir), any = fm as any;
  fm.fleetConfig = { defaults: { backend: "codex" },
    ...(o.chat ? { channels: [{ id: "a", type: "telegram", mode: "topic", group_id: "-1001", access: { mode: "locked", allowed_users: [ADMIN] } }] } : {}),
    ...(o.va ? { web: { verified_authority: o.va } } : {}),
    instances: { general: { working_directory: dir, general_topic: true } } } as any;
  writeFileSync(join(dir, "web.token"), TOKEN, { mode: 0o600 }); any.initializeWebSessions();
  const store = new SettingsConfirmationStore({ audit: vi.fn() });
  stores.push(store); fleets.push({ fm, any });
  /** An admin session of one kind and a request from `where` carrying its cookie; `gateway` binds the request to the public gateway, as the gateway does. */
  const session = (kind: "code" | "host" | "device" | "account" | "guest" | "outside", where: Where, opts: { gateway?: "quick" | "named"; method?: string } = {}) => {
    const link = !!opts.gateway || kind === "outside";
    const c = any.webSessions.create({ tier: kind === "guest" ? "guest" : "admin", surface: link ? "gateway" : "local", label: "browser", tokenEpoch: tokenEpoch(TOKEN),
      ...(kind === "host" ? { host: true } : {}), ...(kind === "device" ? { via: "device" } : {}),
      ...(kind === "account" ? { owner: { adapterId: "a", userId: ADMIN } } : {}), ...(kind === "guest" ? { owner: { adapterId: "telegram", userId: "42" } } : {}),
      ...(link ? { exposureId: "x" } : {}), ...(kind === "outside" ? { remote: "totp" } : {}) });
    const w = WHERE[where];
    const req: any = { method: opts.method ?? "POST", socket: { remoteAddress: w.remoteAddress },
      headers: { host: w.host, origin: `http://${w.host}`, "sec-fetch-site": "same-origin", cookie: `${link ? "__Host-agend_session" : "agend_session"}=${c.sessionId}`, [WEB_CSRF_HEADER]: csrfTokenFor(c.sessionId), ...w.extra } };
    if (link) bindGatewayRequest(req, { surface: "gateway", exposureId: "x", expectedOrigin: `http://${w.host}`, isCurrent: () => true, named: opts.gateway === "named" } as any);
    return { req, record: c.record };
  };
  const propose = (path: string, body: unknown, extra: Record<string, unknown> = {}, method = "PUT") => {
    const effect = prepareSettingsEffect(method, path, body, { config: fm.fleetConfig, classic: {}, ...extra } as any);
    const apply = vi.fn(async (_c: () => boolean, execution: any) => execution.commit(() => "applied"));
    const view = store.propose({ session: "browser", key: `k${Math.random()}`, bytes: 1, source: "web_session", section: effect.diff!.section, requestedBy: "browser",
      fingerprint: effect.diff!.fingerprint, summary: effect.diff!.summary, affectedConnections: effect.diff!.affectedConnections, authority: effect.diff!.authority,
      ...(effect.diff!.opensLink ? { opensLink: true as const } : {}), current: () => true, unchanged: async () => true, snapshot: () => null, apply }).view;
    return { view, apply };
  };
  /** One change of each class the old rules treated differently. */
  const classes = () => ({
    access: () => propose("/api/settings/hub/membership", { enabled: true }, { hubMembership: () => ({ enabled: false }) }),
    outwardHub: () => propose("/api/settings/hub/run", { enabled: true }),
    openLink: () => propose("/api/settings/fleet/web", { verified_authority: { named_link: true } }),
    hubPairing: () => propose("/api/hub/member/pairing/connect", { address: "https://hub.example.test", code: "ABCD-EFGH" }, { hubPairing: () => ({ summary: ["Connect to the Hub at https://hub.example.test"] }) }, "POST"),
  });
  /** A change of the secret class, held directly: what matters here is its `section`, which the effect sets from the keys it touches. */
  const secretChange = () => store.propose({ session: "browser", key: `s${Math.random()}`, bytes: 1, source: "web_session", section: "secret", requestedBy: "browser",
    fingerprint: `${Math.random()}`.padEnd(64, "0"), summary: ["connections.a.bot_token_env: fingerprint 1234"], affectedConnections: [], authority: { connections: [], primaryGeneral: false, unknown: false },
    current: () => true, unchanged: async () => true, snapshot: () => null, apply: async (_c: () => boolean, e: any) => e.commit(() => "applied") }).view;
  return { fm, any, store, session, classes, secretChange, propose };
}

describe("a tailnet-style request is a LAN request on the local surface", () => {
  it.each(["tailnetServe", "tailnetDirect", "lan"] as const)("%s: peer lan, no gateway, session surface local", (where) => {
    const f = fleet(), s = f.session("code", where);
    expect([classifyWebPeer(s.req), webPeerOf(s.req), s.record.surface]).toEqual(["lan", "lan", "local"]);
    const auth = authorizeSession(s.req, f.any.webToken, f.any.webSessions, { touch: false });
    expect(auth.kind === "ok" && auth.session.surface === "local" && auth.session.tier === "admin").toBe(true);
  });
  it("this computer's own browser is loopback; a forwarding header or a non-loopback Host alone makes a loopback address LAN; a real gateway request is a link", () => {
    const f = fleet();
    expect(webPeerOf(f.session("code", "here").req)).toBe("loopback");
    expect(classifyWebPeer({ socket: { remoteAddress: "127.0.0.1" }, headers: { host: "localhost:19280", "x-forwarded-for": "100.64.0.7" } })).toBe("lan");
    expect(classifyWebPeer({ socket: { remoteAddress: "127.0.0.1" }, headers: { host: "agend-box.example-tailnet.ts.net" } })).toBe("lan");
    // A tunnel connects from 127.0.0.1 too: only the gateway's own binding says "over a link" — never the address.
    expect([webPeerOf(f.session("code", "here", { gateway: "quick" }).req), webPeerOf(f.session("code", "here", { gateway: "named" }).req)]).toEqual(["quick_link", "named_link"]);
  });
});

describe("the role, as a pure decision (settings-role.ts)", () => {
  const rec = (o: Partial<SessionRecord> = {}): SessionRecord => ({ tier: "admin", surface: "local", tokenEpoch: "e", handle: "h", ...o }) as SessionRecord;
  const input = (o: Partial<SettingsRoleInput> = {}): SettingsRoleInput => ({ session: rec(), gateway: false, peer: "lan", tokenEpoch: "e", webOnly: true,
    policy: { enabled: true, loopbackOnly: false, namedLink: false, quickLink: true }, isAdmin: () => true, outside: null, ...o });
  const reason = (i: SettingsRoleInput) => { const r = evaluateSettingsRole(i); return r.ok ? "ok" : r.reason; };
  it("an admin cookie session qualifies from this computer and from the LAN; onHost only on this computer", () => {
    expect(evaluateSettingsRole(input({ peer: "loopback" }))).toMatchObject({ ok: true, onHost: true, account: false });
    expect(evaluateSettingsRole(input())).toMatchObject({ ok: true, onHost: false, account: false });
  });
  it.each([
    ["no session (a header token, the CLI, an agent's request)", { session: null }, "not_session"],
    ["a guest", { session: rec({ tier: "guest" }) }, "not_admin_session"],
    ["a rotated token", { tokenEpoch: "other" }, "token_rotated"],
    ["the web authorization switch off", { policy: { enabled: false, loopbackOnly: false, namedLink: false, quickLink: true } }, "disabled"],
    ["Only this computer can authorize, from the LAN", { policy: { enabled: true, loopbackOnly: true, namedLink: false, quickLink: true } }, "loopback_only"],
    ["a chat account that is no longer an admin", { webOnly: false, session: rec({ owner: { adapterId: "a", userId: "1" } }), isAdmin: () => false }, "not_admin"],
    ["an owner-less admin session on a chat fleet that is not the host's", { webOnly: false }, "no_account"],
    ["a web-only fleet's session over a link that did not sign in from outside", { gateway: true, peer: "quick_link", session: rec({ surface: "gateway" }) }, "outside_sign_in"],
    ["a chat account over the named link while its option is off", { webOnly: false, gateway: true, peer: "named_link", session: rec({ surface: "gateway", owner: { adapterId: "a", userId: "1" } }) }, "link_off"],
    ["a local session replayed over a link", { gateway: true, peer: "quick_link" }, "public_link"],
  ] as const)("%s → %s", (_name, over, expected) => { expect(reason(input(over as Partial<SettingsRoleInput>))).toBe(expected); });
  it("the host's own session on a chat fleet, and a chat account over the quick link (its option on), qualify", () => {
    expect(reason(input({ webOnly: false, session: rec({ host: true }) }))).toBe("ok");
    expect(reason(input({ webOnly: false, gateway: true, peer: "quick_link", session: rec({ surface: "gateway", owner: { adapterId: "a", userId: "1" } }) }))).toBe("ok");
  });
  it("the owner signed in from outside qualifies over its own link only", () => {
    const outside = rec({ surface: "gateway", remote: "totp", exposureId: "x" });
    expect(reason(input({ gateway: true, peer: "quick_link", session: outside, outside: { exposureId: "x" } }))).toBe("ok");
    expect(reason(input({ gateway: true, peer: "quick_link", session: outside, outside: { exposureId: "y" } }))).toBe("outside_sign_in");
  });
});

describe("the default: every class of change gets Apply now, from anywhere", () => {
  const places = ["here", "tailnetServe", "tailnetDirect", "lan"] as const;
  it.each(places)("a web-only fleet's admin (sign-in code, host session, device) from %s: Apply now for access, an outward Hub change, a Hub pairing and a link opener", (where) => {
    for (const kind of ["code", "host", "device"] as const) {
      const f = fleet(), s = f.session(kind, where);
      for (const [name, make] of Object.entries(f.classes())) {
        const p = make();
        expect([name, f.any.settingsSelfConfirmation(f.store, s.req, p.view.id)?.label], `${kind} ${name}`).toEqual([name, "This fleet's admin"]);
      }
      expect(f.any.settingsSelfConfirmation(f.store, s.req, f.secretChange().id)?.label).toBe("This fleet's admin");
    }
  });
  it.each(places)("a chat account that is an admin, from %s: every class too, no DM authorization and no chat card needed", (where) => {
    const f = fleet({ chat: true }), s = f.session("account", where);
    for (const [name, make] of Object.entries(f.classes())) expect([name, !!f.any.settingsSelfConfirmation(f.store, s.req, make().view.id)]).toEqual([name, true]);
    expect(f.any.settingsSelfConfirmation(f.store, s.req, f.secretChange().id)).not.toBeNull();
  });
  it("over the public gateway (a real gateway-bound request): the quick link's own opt-in is on by default — the owner signed in from outside confirms; a named-link session needs its option", () => {
    const f = fleet({ enrolled: true });
    f.any.outsideLink = () => ({ exposureId: "x" });
    const owner = f.session("outside", "here");
    for (const make of Object.values(f.classes())) expect(f.any.settingsSelfConfirmation(f.store, owner.req, make().view.id)).not.toBeNull();
    const chat = fleet({ chat: true }), quick = chat.session("account", "here", { gateway: "quick" }), named = chat.session("account", "here", { gateway: "named" });
    const p = chat.classes().access();
    expect([!!chat.any.settingsSelfConfirmation(chat.store, quick.req, p.view.id), !!chat.any.settingsSelfConfirmation(chat.store, named.req, p.view.id)]).toEqual([true, false]);
  });
  it("never: a guest, a header token (no session), an owner-less session on a chat fleet that is not the host's", () => {
    const f = fleet({ chat: true }), p = f.classes().access();
    expect(f.any.settingsSelfConfirmation(f.store, f.session("guest", "lan").req, p.view.id)).toBeNull();
    const bare = f.session("account", "lan"); delete bare.req.headers.cookie; bare.req.headers.authorization = `Bearer ${TOKEN}`;
    expect(f.any.settingsSelfConfirmation(f.store, bare.req, p.view.id)).toBeNull();
    expect(f.any.settingsSelfConfirmation(f.store, f.session("code", "lan").req, p.view.id)).toBeNull();
  });
  it("the owner's knobs still hold: the web authorization switch off, and Only this computer can authorize off this computer", () => {
    const off = fleet({ va: { enabled: false } }), onlyHere = fleet({ va: { loopback_only: true } });
    for (const f of [off, onlyHere]) {
      const p = f.classes().access();
      expect([f.any.settingsSelfConfirmation(f.store, f.session("code", "tailnetServe").req, p.view.id)]).toEqual([null]);
    }
    const p = onlyHere.classes().access();
    expect(onlyHere.any.settingsSelfConfirmation(onlyHere.store, onlyHere.session("code", "here").req, p.view.id)?.label).toBe("This fleet's admin");
    expect(onlyHere.any.settingsTotpState(onlyHere.store, onlyHere.session("code", "lan").req, p.view.id)).toBe("host_only");
  });
});

describe("who can never confirm (agents, paired Windows PCs)", () => {
  it("`agend settings confirm` refuses an agent's environment before touching the host socket", async () => {
    await expect(requestSettingsConfirmation("/nonexistent", { action: "inspect", id: "x" }, { AGEND_INSTANCE_NAME: "worker" })).rejects.toThrow("Agent sessions cannot confirm Settings changes.");
  });
  it("a paired Windows PC (a runtime bearer token, never a browser cookie session) and an agent's token confirm nothing", () => {
    const f = fleet({ enrolled: true }), p = f.classes().access(), s = f.session("code", "lan");
    for (const authorization of ["Bearer runtime-token-0123456789", `Bearer ${TOKEN}`]) {
      const req = { ...s.req, headers: { host: s.req.headers.host, authorization } };
      expect(f.any.settingsSelfConfirmation(f.store, req, p.view.id)).toBeNull();
    }
  });
});

describe("the remote flag the page reads", () => {
  function route(remote: boolean | undefined) {
    const store = new SettingsConfirmationStore({ audit: vi.fn() }); stores.push(store);
    const view = store.propose({ session: "me", key: "k", bytes: 1, source: "web_session", section: "access", requestedBy: "me", fingerprint: "f".repeat(64),
      summary: ["Enable Hub membership"], affectedConnections: [], authority: { connections: [], primaryGeneral: true, unknown: false },
      current: () => true, unchanged: async () => true, snapshot: () => null, apply: async (_c: () => boolean, execution: any) => execution.commit(() => "applied") }).view;
    const gate = new SettingsHttpConfirmation(store, { principal: () => ({ id: "me", label: "me", source: "web_session", current: () => true }),
      baseline: async () => ({ fingerprint: "b" } as any), snapshot: () => null, ...(remote === undefined ? {} : { remote: () => remote }) });
    const get = (id?: string) => new Promise<any>((resolve) => {
      const req: any = Object.assign(new EventEmitter(), { method: "GET", url: `/api/settings/pending${id ? `/${id}` : ""}`, headers: {} });
      let status = 0; const res: any = { destroyed: false, headersSent: false, setHeader: () => {}, writeHead: (s: number) => { status = s; }, end: (b: string) => resolve({ status, body: JSON.parse(b) }) };
      expect(gate.handle(req, res, new URL(req.url, "http://localhost"), () => false)).toBe(true);
    });
    return { view, get, store };
  }
  it("a remote page's pending change says remote, in a read and in the list", async () => {
    const r = route(true), one = await r.get(r.view.id), list = await r.get();
    expect([one.status, one.body.remote, list.body[0].remote]).toEqual([200, true, true]);
  });
  it("this computer's own page, or a fleet that does not say: no flag; a decided change carries none", async () => {
    for (const remote of [false, undefined]) { const r = route(remote); expect((await r.get(r.view.id)).body.remote).toBeUndefined(); }
    const r = route(true);
    await r.store.decide(r.view.id, "reject", { label: "me", current: () => true, via: "web" } as any);
    expect((await r.get(r.view.id)).body.remote).toBeUndefined();
  });
  it("the fleet says remote for every non-loopback page, on any fleet type", () => {
    for (const chat of [false, true]) {
      const f = fleet({ chat });
      expect(["here", "lan", "tailnetServe", "tailnetDirect"].map(w => f.any.settingsPageIsRemote(f.session("code", w as Where).req))).toEqual([false, true, true, true]);
    }
  });
});
