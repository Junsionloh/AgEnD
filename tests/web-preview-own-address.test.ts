/**
 * The preview takes the page's own address (a name the host guard answers to, at whatever port it is reached at) as a
 * dashboard address — it no longer asks the owner to list it again — and says plainly what it still needs: a preview
 * origin on a DIFFERENT host name (a port alone is not enough: cookies are not port-isolated), and that localhost needs
 * no setup. The boundary is unchanged: the preview origin must be another host name, and `frame-ancestors` / the shim's
 * postMessage list stay exact origins (never 'self', never *).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { request, type IncomingHttpHeaders, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import {
  buildShim, createPreviewListener, dashboardOrigins, MAX_ADOPTED_ORIGINS, PREVIEW_OFF_CODES, previewAvailability, previewFrameCsp,
  previewOriginProblem, type PreviewSettings,
} from "../src/web-preview.js";

const tempDirs: string[] = [];
const servers: Server[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const s of servers.splice(0)) s.close();
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const TAILNET = "dash.tailnet.example";
const CONFIG = { web: { allowed_hosts: [TAILNET, "lan.example:9443"] }, hostname: "box.lan" };
const settings = (o: Partial<PreviewSettings> = {}): PreviewSettings => ({ enabled: true, port: 19281, origin: "https://frame.example.org", ...o });

function listener(o: Partial<PreviewSettings> = {}, config: object | null = CONFIG) {
  return createPreviewListener({ settings: settings(o), healthPort: 19280, config, bootId: "a".repeat(32) });
}
/** What /ui does for one load: previewAvailability against the listener, as previewForUi calls it. */
function load(l: ReturnType<typeof listener>, host: string, secure: boolean) {
  return previewAvailability(l.settings, host, secure, l.origins, l);
}

describe("a name the host guard answers to is the page's own address, at any port", () => {
  it("the owner's case: the name is in allowed_hosts without a port, the dashboard is reached at :8445 → previews are offered", () => {
    const l = listener();
    // Before: https://dash.tailnet.example:8445 is not in the (port-less) list, so "list this address in web.allowed_hosts".
    expect(previewAvailability(l.settings, `${TAILNET}:8445`, true, l.origins)).toMatchObject({ previewOrigin: null, code: "notListed" });
    expect(load(l, `${TAILNET}:8445`, true)).toEqual({ dashboardOrigin: `https://${TAILNET}:8445`, previewOrigin: "https://frame.example.org", reason: null, code: null });
    expect(l.origins).toContain(`https://${TAILNET}:8445`);
  });
  it("every name the guard lists is adoptable: allowed_hosts (with or without a port written), hostname, the loopback names", () => {
    const l = listener();
    for (const [host, secure, origin] of [
      [`${TAILNET}:8445`, true, `https://${TAILNET}:8445`], [`${TAILNET}:8446`, false, `http://${TAILNET}:8446`],
      ["lan.example:7443", true, "https://lan.example:7443"],        // listed as lan.example:9443: the guard does not compare ports
      ["box.lan:8080", false, "http://box.lan:8080"],                // `hostname`
      ["localhost:9000", false, "http://localhost:9000"], ["127.0.0.1:9000", false, "http://127.0.0.1:9000"], ["[::1]:9000", false, "http://[::1]:9000"],
    ] as const) {
      expect(load(l, host, secure), host).toMatchObject({ dashboardOrigin: origin, previewOrigin: "https://frame.example.org", code: null });
      expect(l.origins, host).toContain(origin);
    }
  });
  it("a name the guard does not list is never adopted — the host guard's list is the only one that decides", () => {
    const l = listener();
    const before = [...l.origins];
    for (const host of ["evil.example:8445", "dash.tailnet.example.evil.net:8445", "192.168.1.5:19280", "other.tailnet.example:443"]) {
      expect(load(l, host, true), host).toMatchObject({ previewOrigin: null, code: "notListed" });
    }
    expect(l.origins).toEqual(before);
    expect(l.adoptable("https://evil.example:8445")).toBe(false);
    l.adoptOrigin("https://evil.example:8445");               // asked directly: still ignored
    expect(l.origins).toEqual(before);
  });
  it("a name is adopted only when a preview is really offered: a refused load leaves nothing behind", () => {
    const base = [...listener().origins];
    // No preview_origin: a non-loopback name has nowhere to preview from (needOrigin).
    const noOrigin = listener({ origin: null });
    expect(load(noOrigin, `${TAILNET}:8445`, true)).toMatchObject({ previewOrigin: null, code: "needOrigin" });
    expect(noOrigin.origins).toEqual(dashboardOrigins(noOrigin.settings, 19280, CONFIG));
    // https dashboard, http preview_origin (mixed content).
    const mixed = listener({ origin: "http://frame.example.org" });
    expect(load(mixed, `${TAILNET}:8445`, true)).toMatchObject({ previewOrigin: null, code: "needHttps" });
    expect(mixed.origins).toEqual(base);
    // The preview origin is the dashboard's own address.
    const same = listener({ origin: `https://${TAILNET}:8445` });
    expect(load(same, `${TAILNET}:8445`, true)).toMatchObject({ previewOrigin: null, code: "sameOrigin" });
    expect(same.origins).toEqual(dashboardOrigins(same.settings, 19280, CONFIG));
    // Preview switched off, or the address cannot be read.
    const off = listener();
    expect(previewAvailability({ ...off.settings, enabled: false }, `${TAILNET}:8445`, true, off.origins, off)).toMatchObject({ code: "fleetOff" });
    expect(previewAvailability(off.settings, "bad host!", true, off.origins, off)).toMatchObject({ code: "unchecked" });
    expect(off.origins).toEqual(base);
  });
  it("loopback with no preview_origin: a name at another port (an SSH forward) is offered the same name on the preview port", () => {
    const l = listener({ origin: null });
    expect(load(l, "localhost:9000", false)).toEqual({ dashboardOrigin: "http://localhost:9000", previewOrigin: "http://localhost:19281", reason: null, code: null });
    expect(l.origins).toContain("http://localhost:9000");
  });
  it("an adopted address is listed once however often it loads; one already in the config is not adopted again", () => {
    const l = listener();
    for (let i = 0; i < 3; i++) load(l, `${TAILNET}:8445`, true);
    expect(l.origins.filter(o => o === `https://${TAILNET}:8445`)).toHaveLength(1);
    expect(l.adoptable("http://localhost:19280")).toBe(false);          // the health port's own loopback origin: listed
    expect(l.adoptable(`https://${TAILNET}:8445`)).toBe(true);
    expect(l.adoptable(`https://${TAILNET}:8445/`)).toBe(false);        // not the text dashboardOriginFor writes
    expect(l.adoptable(`https://${TAILNET}:443`)).toBe(false);          // a default port is never part of an origin
    expect(l.adoptable("ftp://dash.tailnet.example:8445")).toBe(false);
  });
  it(`at most ${MAX_ADOPTED_ORIGINS} addresses are kept: the least recently loaded goes first, and comes back on its next load`, () => {
    const l = listener();
    const configured = dashboardOrigins(l.settings, 19280, CONFIG);
    const origin = (n: number) => `https://${TAILNET}:${9000 + n}`;
    for (let n = 0; n < MAX_ADOPTED_ORIGINS + 5; n++) load(l, `${TAILNET}:${9000 + n}`, true);
    expect(l.origins).toHaveLength(configured.length + MAX_ADOPTED_ORIGINS);
    expect(l.origins).not.toContain(origin(0));
    expect(l.origins).toContain(origin(MAX_ADOPTED_ORIGINS + 4));
    load(l, `${TAILNET}:9000`, true);                                    // back again: the oldest of the rest goes instead
    expect(l.origins).toContain(origin(0));
    expect(l.origins).not.toContain(origin(5));
    expect(l.origins).toHaveLength(configured.length + MAX_ADOPTED_ORIGINS);
    expect(configured.every(o => l.origins.includes(o))).toBe(true);     // the configured ones are never dropped
  });
});

describe("the boundary is unchanged: another host name, and exact origins only", () => {
  it("a preview origin on the dashboard's own host name is refused — at another port too — by the validator and at the point of use", () => {
    for (const origin of ["https://dash.tailnet.example:8446", "https://dash.tailnet.example", "http://localhost:19281", "https://box.lan:8446"]) {
      expect(previewOriginProblem(origin, CONFIG), origin).toMatch(/separate host name/);
    }
    // The validator would have refused this at start; the check at the point of use holds even if a config got past it.
    const l = listener({ origin: `https://${TAILNET}:8446` });
    const p = load(l, `${TAILNET}:8445`, true);
    expect(p).toMatchObject({ previewOrigin: null, code: "sameOrigin" });
    expect(p.reason).toMatch(/different host name/);
    expect(l.origins).toEqual(dashboardOrigins(l.settings, 19280, CONFIG));
    // A different host name is what works.
    expect(previewOriginProblem("https://frame.example.org", CONFIG)).toBeNull();
  });
  it("the loopback default is unchanged: the same loopback name, next port (its listener reads no cookie)", () => {
    const l = listener({ origin: null });
    expect(load(l, "127.0.0.1:19280", false)).toMatchObject({ previewOrigin: "http://127.0.0.1:19281", code: null });
    expect(l.origins).toEqual(dashboardOrigins(l.settings, 19280, CONFIG));    // nothing to adopt: already listed
  });
  it("frame-ancestors and the shim list the adopted address as an exact origin — never 'self', never *", async () => {
    const l = listener();
    servers.push(l.server);
    await new Promise<void>(r => l.server.listen(0, "127.0.0.1", () => r()));
    const port = (l.server.address() as { port: number }).port;
    const frame = () => raw(port, "/frame", { host: "frame.example.org" });
    const before = await frame();
    expect(String(before.headers["content-security-policy"])).not.toContain(`${TAILNET}:8445`);

    load(l, `${TAILNET}:8445`, true);
    const after = await frame();
    const csp = String(after.headers["content-security-policy"]);
    expect(csp).toBe(previewFrameCsp(l.origins));
    expect(csp).toMatch(new RegExp(`frame-ancestors [^;]*https://${TAILNET.replaceAll(".", "\\.")}:8445(?: |;)`));
    expect(csp).not.toMatch(/'self'|\*/);
    expect(after.body).toBe(buildShim(l.bootId, l.origins));
    expect(after.body).toContain(`ORIGINS = ${JSON.stringify(l.origins)}`);
    expect(after.body).not.toMatch(/ORIGINS = [^;]*\*/);
    // /frame is still served only to the preview origin's host (and loopback): the dashboard's name is a 403 there.
    expect((await raw(port, "/frame", { host: `${TAILNET}:8445` })).status).toBe(403);
  });
});

describe("through the fleet: previewForUi adopts the load's address, and /frame then lets it frame", () => {
  it("an https proxy at :8445 for a name in allowed_hosts (no port): the page is offered the preview, /frame lists exactly that origin", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-own-address-")); tempDirs.push(dir);
    const fm = new FleetManager(dir);
    const quiet = () => {};
    fm.logger = { info: quiet, warn: quiet, error: quiet, debug: quiet, trace: quiet, fatal: quiet, child: () => fm.logger } as unknown as typeof fm.logger;
    const any = fm as unknown as Record<string, any>;
    any.fleetConfig = { instances: {}, web: { allowed_hosts: [TAILNET], preview_origin: "https://frame.example.org" } };
    any.initializeWebAuthTokens(); any.startHealthServer(0);
    await vi.waitFor(() => expect(any.previewListening).toBe(true));
    servers.push(any.healthServer);
    const pl = any.previewListener;
    const pport = (pl.server.address() as { port: number }).port;

    const p = any.previewForUi(`${TAILNET}:8445`, true);
    expect([p.dashboardOrigin, p.previewOrigin, p.code, p.boot]).toEqual([`https://${TAILNET}:8445`, "https://frame.example.org", null, pl.bootId]);
    const csp = String((await raw(pport, "/frame", { host: "frame.example.org" })).headers["content-security-policy"]);
    expect(csp).toContain(`https://${TAILNET}:8445`);
    expect(csp).not.toMatch(/'self'|\*/);

    // A Host the guard does not list never gets here in a real request; asked anyway it is refused and adopts nothing.
    expect(any.previewForUi("evil.example:8445", true)).toMatchObject({ previewOrigin: null, code: "notListed", boot: pl.bootId });
    expect(String((await raw(pport, "/frame", { host: "frame.example.org" })).headers["content-security-policy"])).not.toContain("evil.example");
    pl.close();
  });
  it("no preview_origin, the dashboard at a tailnet name: needOrigin — and no address is adopted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-own-address-")); tempDirs.push(dir);
    const fm = new FleetManager(dir);
    const quiet = () => {};
    fm.logger = { info: quiet, warn: quiet, error: quiet, debug: quiet, trace: quiet, fatal: quiet, child: () => fm.logger } as unknown as typeof fm.logger;
    const any = fm as unknown as Record<string, any>;
    any.fleetConfig = { instances: {}, web: { allowed_hosts: [TAILNET] } };
    any.initializeWebAuthTokens(); any.startHealthServer(0);
    await vi.waitFor(() => expect(any.previewListening).toBe(true));
    servers.push(any.healthServer);
    const before = [...any.previewListener.origins];
    const p = any.previewForUi(`${TAILNET}:8445`, true);
    expect(p).toMatchObject({ dashboardOrigin: `https://${TAILNET}:8445`, previewOrigin: null, code: "needOrigin" });
    expect(p.reason).toContain(`https://${TAILNET}:8445`);
    expect(any.previewListener.origins).toEqual(before);
    any.previewListener.close();
  });
});

describe("the three reasons say what a preview needs", () => {
  const SERVER: Array<[string, PreviewSettings | null, string, boolean]> = [
    ["notListed", settings(), "evil.example:8445", true],
    ["needOrigin", settings({ origin: null }), `${TAILNET}:8445`, true],
    ["sameOrigin", settings({ origin: `https://${TAILNET}:8445` }), `${TAILNET}:8445`, true],
  ];
  it.each(SERVER)("%s (server, English): a different host name, a port alone does not work, localhost needs no setup", (code, s, host, secure) => {
    const l = createPreviewListener({ settings: s!, healthPort: 19280, config: CONFIG });
    const p = previewAvailability(l.settings, host, secure, l.origins, l);
    expect(p.code).toBe(code);
    expect(p.reason).toMatch(/different host name/);
    expect(p.reason).toMatch(/only a different port does not work, because cookies are shared across ports/);
    expect(p.reason).toMatch(/open the dashboard as localhost \(http:\/\/localhost:19280 by default\): previews then need no setup/);
    expect(p.reason).toContain(`https://${host}`);          // the address it speaks of is the page's own
  });
  it("the page's dictionary has the same three, in English and 繁中, with the address filled in", async () => {
    const strings = await import("/assets/app-i18n.js");
    // @ts-expect-error — a JS module of the app, with no types
    await import("../src/ui/chat-strings.js");
    const say = (lang: string, code: string, arg: string) => {
      strings.setLang(lang);
      try { return strings.t(`chat.pvServer_${code}`, arg); } finally { strings.setLang("en"); }
    };
    expect(PREVIEW_OFF_CODES).toEqual(expect.arrayContaining(["notListed", "needOrigin", "sameOrigin"]));
    for (const code of ["notListed", "needOrigin", "sameOrigin"]) {
      const en = say("en", code, "https://x.example:8445"), zh = say("zh-TW", code, "https://x.example:8445");
      expect(en, code).toMatch(/different host name/);
      expect(en, code).toMatch(/cookies are shared across ports/);
      expect(en, code).toMatch(/localhost/);
      expect(zh, code).toMatch(/不同主機名稱/);
      expect(zh, code).toMatch(/cookie 不分連接埠/);
      expect(zh, code).toMatch(/localhost/);
      expect(en, code).toContain("https://x.example:8445");
      expect(zh, code).toContain("https://x.example:8445");
      expect(en, code).not.toContain("{0}");
      expect(zh, code).not.toContain("{0}");
      expect(zh, code).not.toBe(en);
    }
    // The old advice — "list this address (with its port)" — is gone: an address no longer has to be listed.
    expect(say("en", "notListed", "x")).not.toMatch(/with its port/);
    expect(say("zh-TW", "notListed", "x")).not.toMatch(/含連接埠/);
  });
});

function raw(port: number, path: string, headers: Record<string, string>): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method: "GET", path, headers }, res => {
      let text = ""; res.on("data", (c: Buffer) => { text += c.toString(); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    r.on("error", reject); r.end();
  });
}
