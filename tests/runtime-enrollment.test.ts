import { createServer, IncomingMessage, ServerResponse, type Server } from "node:http";
import { Readable } from "node:stream";
import { once } from "node:events";
import { generateKeyPairSync, createHash, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeCoordinator, type RuntimeEnrollmentAuditEntry } from "../src/runtime-coordinator.js";
import { handleRuntimeRequest, type RuntimeApiContext } from "../src/runtime-api.js";
import { ENROLL_IDENTITY_FILE, ENROLL_TTL_MS, generateEnrollToken, hashEnrollToken, loadRuntimeServerIdentity } from "../src/runtime-enrollment.js";
import { RuntimeClientStore } from "../src/runtime-client-store.js";
import { describeEnrollRefusal, enrollRuntime } from "../src/runtime-client.js";
import { RUNTIME_ENROLL_PATH, RUNTIME_ENROLL_HELLO_PATH, RUNTIME_ENROLL_TOKEN_PATTERN, runtimeEnrollGrantMessage, runtimeEnrollHelloMessage, runtimeServerFingerprint, verifyRuntimeServerProof } from "../src/runtime-protocol.js";

/**
 * AGEND-110: one-time install-command tokens. The server only keeps a hash, the token works once and for 15 minutes, a new token (or a revoke) ends
 * the old one, every issue/use/revoke is recorded, the Runtime proves who the server is before it sends the token, and nothing secret is left in a file.
 */
const homes: string[] = [], hubs: RuntimeCoordinator[] = [], servers: Server[] = [], clients: WebSocket[] = [];
const ACTOR = "admin:0123456789abcdef";
function home() { const value = mkdtempSync(join(tmpdir(), "agend-runtime-enroll-")); homes.push(value); return value; }
function hub(options: ConstructorParameters<typeof RuntimeCoordinator>[1] = {}, dir = home()) { const value = new RuntimeCoordinator(dir, options); hubs.push(value); return value; }
async function listen(h: RuntimeCoordinator, log: string[] = []) {
  const server = createServer((req, res) => { log.push(`${req.method} ${req.url}`); if (!h.handlePublicRequest(req, res, new URL(req.url ?? "/", "http://localhost"))) { res.writeHead(404); res.end(); } });
  servers.push(server); server.on("upgrade", (req, socket, head) => { if (!h.handleUpgrade(req, socket, head)) socket.destroy(); });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); if (!address || typeof address === "string") throw Error("No test port");
  return `http://127.0.0.1:${address.port}`;
}
const nonce = (): string => "ab".repeat(16);
function enrollInput(h: RuntimeCoordinator, token: string, extra: Record<string, unknown> = {}) { return { token, fingerprint: h.serverFingerprint(), nonce: nonce(), name: "Desk", platform: "win32", ...extra }; }
/** Every file under a folder, as text, so "the token is nowhere on disk" can be checked for the whole data and profile folders. */
function everyFile(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) if (entry.isFile()) out.push(readFileSync(join(entry.parentPath, entry.name), "utf8"));
  return out;
}
afterEach(async () => {
  vi.useRealTimers();
  for (const ws of clients.splice(0)) ws.terminate();
  for (const h of hubs.splice(0)) h.close();
  for (const s of servers.splice(0)) await new Promise<void>(done => s.close(() => done()));
  for (const path of homes.splice(0)) { if (!resolve(path).startsWith(resolve(tmpdir()) + sep)) throw Error("Unsafe test cleanup"); rmSync(path, { recursive: true, force: true }); }
});

describe("the token and the server identity", () => {
  it("is 256 random bits behind a fixed prefix, and no two are alike", () => {
    const tokens = new Set(Array.from({ length: 64 }, generateEnrollToken));
    expect(tokens.size).toBe(64);
    for (const token of tokens) { expect(token).toMatch(RUNTIME_ENROLL_TOKEN_PATTERN); expect(Buffer.from(token.slice("agend_enroll_".length), "base64url")).toHaveLength(32); }
    expect(hashEnrollToken("agend_enroll_" + "A".repeat(43))).toMatch(/^[a-f0-9]{64}$/);
  });
  it("creates the enrollment key once, privately, and finds the same one again", () => {
    const dir = home(), first = loadRuntimeServerIdentity(dir), again = loadRuntimeServerIdentity(dir);
    expect(again.fingerprint).toBe(first.fingerprint); expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    if (process.platform !== "win32") expect(statSync(join(dir, ENROLL_IDENTITY_FILE)).mode & 0o077).toBe(0);
    expect(loadRuntimeServerIdentity(home()).fingerprint).not.toBe(first.fingerprint);
  });
  it("never replaces an odd identity file (that would change the fingerprint under every command already handed out)", () => {
    const dir = home(); writeFileSync(join(dir, ENROLL_IDENTITY_FILE), "{\"version\":2}");
    expect(() => loadRuntimeServerIdentity(dir)).toThrow(/Malformed/);
    expect(readFileSync(join(dir, ENROLL_IDENTITY_FILE), "utf8")).toBe("{\"version\":2}");
  });
  it("signs a nonce so the key's fingerprint and the signature can both be checked, and nothing else passes", () => {
    const identity = loadRuntimeServerIdentity(home()), message = runtimeEnrollHelloMessage(nonce()), signature = identity.signature(message);
    expect(verifyRuntimeServerProof(identity.fingerprint, identity.publicKey, signature, message)).toBe(true);
    expect(verifyRuntimeServerProof("0".repeat(64), identity.publicKey, signature, message)).toBe(false);                           // another fingerprint
    expect(verifyRuntimeServerProof(identity.fingerprint, identity.publicKey, signature, runtimeEnrollHelloMessage("cd".repeat(16)))).toBe(false); // another nonce
    expect(verifyRuntimeServerProof(identity.fingerprint, identity.publicKey, "AAAA", message)).toBe(false);
    for (const hostile of [undefined, 1, "", "!!!", "x".repeat(300)]) expect(verifyRuntimeServerProof(identity.fingerprint, hostile, signature, message)).toBe(false);
    // a different key that someone made to look right still fails the fingerprint pin
    const other = generateKeyPairSync("ed25519"), der = other.publicKey.export({ type: "spki", format: "der" });
    expect(verifyRuntimeServerProof(identity.fingerprint, der.toString("base64url"), sign(null, message, other.privateKey).toString("base64url"), message)).toBe(false);
    expect(runtimeServerFingerprint(der)).not.toBe(identity.fingerprint);
  });
});

describe("issuing, using, expiring and revoking a token", () => {
  it("keeps only the token's hash: not the token, not on disk, not in the list the page reads", () => {
    const h = hub(), issued = h.createEnrollment(ACTOR);
    expect(issued.token).toMatch(RUNTIME_ENROLL_TOKEN_PATTERN); expect(issued.fingerprint).toBe(h.serverFingerprint()); expect(issued.expiresAt - issued.createdAt).toBe(ENROLL_TTL_MS);
    const raw = readFileSync(join(homes[0], "runtime-machines.json"), "utf8");
    expect(raw).not.toContain(issued.token); expect(raw).not.toContain(issued.token.slice("agend_enroll_".length)); expect(raw).toContain(hashEnrollToken(issued.token));
    const listed = JSON.stringify(h.listEnrollments());
    expect(listed).not.toContain(issued.token); expect(listed).not.toContain(hashEnrollToken(issued.token)); expect(listed).not.toMatch(/Hash|token/i);
    expect(h.listEnrollments()).toEqual([{ id: issued.id, status: "unused", createdAt: issued.createdAt, expiresAt: issued.expiresAt }]);
  });
  it("is good for 15 minutes by default", () => { expect(ENROLL_TTL_MS).toBe(15 * 60_000); });
  it("creates an already-approved computer with a credential, once, and stores that credential only as a hash", () => {
    const h = hub(), { token, id } = h.createEnrollment(ACTOR), result = h.enroll(enrollInput(h, token, { hostname: "DESK-1" }));
    expect(result).toMatchObject({ status: "enrolled" }); expect(result.credential).toMatch(/^[a-f0-9]{64}$/);
    const machine = h.machine(result.machineId)!;
    expect(machine).toMatchObject({ name: "Desk", status: "offline", enrolledVia: "install-command", enrollmentId: id, hostname: "DESK-1" }); expect(machine.approvedAt).toBeTypeOf("number");
    expect(machine.pairingFingerprint).toBeUndefined();                                                      // no fingerprint to compare, nothing to approve
    expect(h.listEnrollments()[0]).toMatchObject({ id, status: "used", machineId: result.machineId });
    const raw = readFileSync(join(homes[0], "runtime-machines.json"), "utf8");
    expect(raw).not.toContain(result.credential); expect(raw).not.toContain(token);
    expect(JSON.stringify(h.listMachines())).not.toMatch(/credentialHash|claimHash|Secret/);
  });
  it("refuses a second use of the same token, and the machine of the first stays", () => {
    const h = hub(), { token } = h.createEnrollment(ACTOR), first = h.enroll(enrollInput(h, token));
    let refusal: unknown; try { h.enroll(enrollInput(h, token, { name: "Second" })); } catch (error) { refusal = error; }
    expect(refusal).toMatchObject({ reason: "used" }); expect(String((refusal as Error).message)).not.toContain(token);
    expect(h.listMachines().map(machine => machine.id)).toEqual([first.machineId]);
  });
  it("refuses an expired token, a revoked one, and one that was never issued, each with its own reason", () => {
    let now = 1_000_000; const h = hub({ now: () => now }), a = h.createEnrollment(ACTOR);
    now += ENROLL_TTL_MS - 1; expect(h.listEnrollments()[0].status).toBe("unused");
    now += 1; expect(h.listEnrollments()[0].status).toBe("expired");
    expect(() => h.enroll(enrollInput(h, a.token))).toThrow(/expired/);
    let reason = (): unknown => { try { h.enroll(enrollInput(h, a.token)); } catch (error) { return (error as { reason?: unknown }).reason; } };
    expect(reason()).toBe("expired");
    const b = h.createEnrollment(ACTOR); h.revokeEnrollment(b.id, ACTOR);
    reason = (): unknown => { try { h.enroll(enrollInput(h, b.token)); } catch (error) { return (error as { reason?: unknown }).reason; } };
    expect(reason()).toBe("revoked");
    reason = (): unknown => { try { h.enroll(enrollInput(h, generateEnrollToken())); } catch (error) { return (error as { reason?: unknown }).reason; } };
    expect(reason()).toBe("invalid");
    expect(h.listMachines()).toEqual([]);
  });
  it("ends every earlier unused token when a new one is made, and only the new one works", () => {
    const h = hub(), first = h.createEnrollment(ACTOR), second = h.createEnrollment(ACTOR);
    expect(h.listEnrollments().map(row => [row.id, row.status])).toEqual([[second.id, "unused"], [first.id, "revoked"]]);
    expect(() => h.enroll(enrollInput(h, first.token))).toThrow(/revoked/);
    expect(h.enroll(enrollInput(h, second.token)).status).toBe("enrolled");
  });
  it("keeps a used token's status when a newer one is made (a used one is history, not something to revoke)", () => {
    const h = hub(), first = h.createEnrollment(ACTOR); h.enroll(enrollInput(h, first.token)); h.createEnrollment(ACTOR);
    expect(h.listEnrollments().find(row => row.id === first.id)?.status).toBe("used");
    expect(() => h.revokeEnrollment(first.id, ACTOR)).toThrow(/Only an unused/);
  });
  it("revokes an unused token and says so, and refuses to revoke what does not exist", () => {
    const h = hub(), { id, token } = h.createEnrollment(ACTOR);
    expect(h.revokeEnrollment(id, ACTOR)).toMatchObject({ id, status: "revoked" });
    expect(() => h.enroll(enrollInput(h, token))).toThrow(/revoked/);
    expect(() => h.revokeEnrollment("00000000-0000-4000-8000-000000000000", ACTOR)).toThrow(/not found/);
  });
  it("refuses a token for a different AgEnD: a fingerprint that is not this server's, even with the right token", () => {
    const h = hub(), { token } = h.createEnrollment(ACTOR);
    let refusal: unknown; try { h.enroll(enrollInput(h, token, { fingerprint: "0".repeat(64) })); } catch (error) { refusal = error; }
    expect(refusal).toMatchObject({ reason: "mismatch" });
    expect(h.listEnrollments()[0].status).toBe("unused");                                                    // a wrong-server attempt spends nothing
    expect(h.enroll(enrollInput(h, token)).status).toBe("enrolled");
  });
  it("binds the token to the identity it was issued under: after the identity changes it no longer works", () => {
    const dir = home(), first = hub({}, dir), { token } = first.createEnrollment(ACTOR); first.close(); hubs.pop();
    rmSync(join(dir, ENROLL_IDENTITY_FILE));                                                                 // a different AgEnD identity under the same data folder
    const second = hub({}, dir);
    expect(second.serverFingerprint()).not.toBe(first.serverFingerprint());
    expect(() => second.enroll(enrollInput(second, token))).toThrow(/different AgEnD/);
  });
  it("survives a restart: what was used, revoked or still pending is what it was, and an unused token still works", () => {
    const dir = home(), first = hub({}, dir), a = first.createEnrollment(ACTOR), usedMachine = first.enroll(enrollInput(first, a.token)).machineId;
    const b = first.createEnrollment(ACTOR); first.revokeEnrollment(b.id, ACTOR); const c = first.createEnrollment(ACTOR);
    first.close(); hubs.pop();
    const second = hub({}, dir);
    expect(second.listEnrollments().map(row => [row.id, row.status])).toEqual([[c.id, "unused"], [b.id, "revoked"], [a.id, "used"]]);
    expect(second.machine(usedMachine)?.enrolledVia).toBe("install-command");
    expect(() => second.enroll(enrollInput(second, a.token))).toThrow(/already used/); expect(() => second.enroll(enrollInput(second, b.token))).toThrow(/revoked/);
    expect(second.enroll(enrollInput(second, c.token)).status).toBe("enrolled");
  });
  it("records issue, use and revoke (and a replaced token), with no token, hash or address in the record", () => {
    const seen: RuntimeEnrollmentAuditEntry[] = []; const h = hub({ audit: entry => seen.push(entry) });
    const a = h.createEnrollment(ACTOR), b = h.createEnrollment(ACTOR), used = h.enroll(enrollInput(h, b.token)), c = h.createEnrollment(ACTOR); h.revokeEnrollment(c.id, ACTOR);
    try { h.enroll(enrollInput(h, a.token)); } catch { /* refused: logged, not stored */ }
    expect(seen.map(entry => [entry.event, entry.enrollmentId, entry.actor, entry.machineId])).toEqual([
      ["issued", a.id, ACTOR, undefined], ["superseded", a.id, ACTOR, undefined], ["issued", b.id, ACTOR, undefined],
      ["used", b.id, undefined, used.machineId], ["issued", c.id, ACTOR, undefined], ["revoked", c.id, ACTOR, undefined], ["rejected", a.id, undefined, undefined]]);
    expect(seen.at(-1)).toMatchObject({ reason: "revoked" });
    const stored = JSON.parse(readFileSync(join(homes[0], "runtime-machines.json"), "utf8")).enrollmentAudit as Array<Record<string, unknown>>;
    expect(stored.map(entry => entry.event)).toEqual(["issued", "superseded", "issued", "used", "issued", "revoked"]);   // a refused try is logged only
    const everything = JSON.stringify([seen, stored]);
    for (const token of [a.token, b.token, c.token]) { expect(everything).not.toContain(token); expect(everything).not.toContain(hashEnrollToken(token)); }
    expect(everything).not.toContain(used.credential);
  });
  it("keeps the audit trail bounded and never fails a use because the log hook failed", () => {
    const h = hub({ audit: () => { throw new Error("log hook down"); } });
    for (let i = 0; i < 40; i++) h.createEnrollment(ACTOR);
    expect(JSON.parse(readFileSync(join(homes[0], "runtime-machines.json"), "utf8")).enrollmentAudit.length).toBeLessThanOrEqual(512);
    expect(h.enroll(enrollInput(h, h.createEnrollment(ACTOR).token)).status).toBe("enrolled");
  });
  it("does not leave a half-made computer when the journal cannot be written", () => {
    const h = hub(), { token } = h.createEnrollment(ACTOR);
    const save = vi.spyOn(h as unknown as { save(): void }, "save").mockImplementation(() => { throw new Error("disk full"); });
    expect(() => h.enroll(enrollInput(h, token))).toThrow(/disk full/); save.mockRestore();
    expect(h.listMachines()).toEqual([]); expect(h.listEnrollments()[0].status).toBe("unused");
    expect(h.enroll(enrollInput(h, token)).status).toBe("enrolled");
  });
  it("validates the request closely: unknown fields, a malformed token or fingerprint, a bad name or platform", () => {
    const h = hub(), { token } = h.createEnrollment(ACTOR);
    for (const bad of [{ extra: 1 }, { token: "agend_enroll_short" }, { fingerprint: "ZZ" }, { nonce: "xyz" }, { name: " " }, { name: "a\nb" }, { platform: "linux" }, { hostname: "x\ny" }])
      expect(() => h.enroll(enrollInput(h, token, bad))).toThrow(/Invalid runtime enrollment request/);
    expect(() => h.enroll("nope")).toThrow(/Invalid runtime enrollment request/);
    expect(h.listEnrollments()[0].status).toBe("unused");
  });
  it("respects the machine limit", () => {
    const h = hub();
    for (let i = 0; i < 64; i++) h.enroll(enrollInput(h, h.createEnrollment(ACTOR).token, { name: `PC ${i}` }));
    expect(() => h.enroll(enrollInput(h, h.createEnrollment(ACTOR).token))).toThrow(/limit/);
  });
  it("rejects a journal whose enrollment records are malformed", () => {
    const dir = home(); hub({}, dir).createEnrollment(ACTOR); hubs.pop()!.close();
    const path = join(dir, "runtime-machines.json"), state = JSON.parse(readFileSync(path, "utf8")); state.enrollments[0].tokenHash = "nope"; writeFileSync(path, JSON.stringify(state));
    expect(() => new RuntimeCoordinator(dir)).toThrow(/Malformed runtime machine store/);
  });
  it("lets the computer it created connect with its credential, and revoking that computer ends the connection", async () => {
    const h = hub(), base = await listen(h), { token } = h.createEnrollment(ACTOR), result = h.enroll(enrollInput(h, token));
    const ws = new WebSocket(base.replace("http:", "ws:") + "/runtime/v1/connect", { headers: { Authorization: `Bearer ${result.credential}` } }); clients.push(ws);
    await once(ws, "open"); const welcome = once(ws, "message");
    ws.send(JSON.stringify({ v: 1, type: "hello", bootId: "boot-1", inventory: { home: "C:\\Users\\test", clis: [] } })); await welcome;
    expect(h.machine(result.machineId)?.status).toBe("online");
    const closed = once(ws, "close"); h.revoke(result.machineId); const [code] = await closed; expect(code).toBe(1008);
    expect(h.machine(result.machineId)?.status).toBe("revoked");
  });
});

describe("the public routes", () => {
  async function post(base: string, path: string, body: unknown) {
    const response = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }
  it("answers hello with a signature over the caller's nonce and spends nothing", async () => {
    const h = hub(), base = await listen(h), { token } = h.createEnrollment(ACTOR);
    const answer = await post(base, RUNTIME_ENROLL_HELLO_PATH, { nonce: nonce() });
    expect(answer.status).toBe(200);
    expect(verifyRuntimeServerProof(h.serverFingerprint(), answer.body.publicKey, answer.body.signature, runtimeEnrollHelloMessage(nonce()))).toBe(true);
    expect(h.listEnrollments()[0].status).toBe("unused"); expect(token).toBeTruthy();
    expect((await post(base, RUNTIME_ENROLL_HELLO_PATH, { nonce: "short" })).status).toBe(400);
    expect((await post(base, RUNTIME_ENROLL_HELLO_PATH, { nonce: nonce(), extra: 1 })).status).toBe(400);
  });
  it("enrolls over HTTP, signs the grant for this request, and then refuses the same token with a reason", async () => {
    const h = hub(), base = await listen(h), { token } = h.createEnrollment(ACTOR);
    const first = await post(base, RUNTIME_ENROLL_PATH, enrollInput(h, token));
    expect(first.status).toBe(201); expect(first.body).toMatchObject({ status: "enrolled" });
    expect(verifyRuntimeServerProof(h.serverFingerprint(), loadRuntimeServerIdentity(homes[0]).publicKey, first.body.signature, runtimeEnrollGrantMessage(nonce(), String(first.body.machineId), String(first.body.credential)))).toBe(true);
    const second = await post(base, RUNTIME_ENROLL_PATH, enrollInput(h, token));
    expect(second.status).toBe(403); expect(second.body).toMatchObject({ reason: "used" }); expect(JSON.stringify(second.body)).not.toContain(token);
  });
  it("gives every refusal its status and reason, and an unknown token only the generic 'invalid'", async () => {
    let now = 1_000_000; const h = hub({ now: () => now }), base = await listen(h);
    const a = h.createEnrollment(ACTOR); now += ENROLL_TTL_MS;
    expect(await post(base, RUNTIME_ENROLL_PATH, enrollInput(h, a.token))).toMatchObject({ status: 403, body: { reason: "expired" } });
    const b = h.createEnrollment(ACTOR); h.revokeEnrollment(b.id, ACTOR);
    expect(await post(base, RUNTIME_ENROLL_PATH, enrollInput(h, b.token))).toMatchObject({ status: 403, body: { reason: "revoked" } });
    const c = h.createEnrollment(ACTOR);
    expect(await post(base, RUNTIME_ENROLL_PATH, enrollInput(h, c.token, { fingerprint: "1".repeat(64) }))).toMatchObject({ status: 403, body: { reason: "mismatch" } });
    expect(await post(base, RUNTIME_ENROLL_PATH, enrollInput(h, generateEnrollToken()))).toMatchObject({ status: 400, body: { reason: "invalid" } });
    expect(await post(base, RUNTIME_ENROLL_PATH, { nope: 1 })).toMatchObject({ status: 400, body: { reason: "invalid" } });
  });
  it("is POST-only, takes no query, and refuses a browser (an Origin or a cookie)", async () => {
    const h = hub(), base = await listen(h), { token } = h.createEnrollment(ACTOR);
    expect((await fetch(base + RUNTIME_ENROLL_PATH)).status).toBe(403);
    expect((await fetch(base + RUNTIME_ENROLL_PATH + "?x=1", { method: "POST", body: "{}" })).status).toBe(403);
    expect((await fetch(base + RUNTIME_ENROLL_PATH, { method: "POST", headers: { Origin: "https://evil.example" }, body: JSON.stringify(enrollInput(h, token)) })).status).toBe(403);
    expect((await fetch(base + RUNTIME_ENROLL_HELLO_PATH, { method: "POST", headers: { Cookie: "a=b" }, body: JSON.stringify({ nonce: nonce() }) })).status).toBe(403);
    expect(h.listEnrollments()[0].status).toBe("unused");
  });
  it("rate-limits a token that keeps being refused", async () => {
    const h = hub(), base = await listen(h), { id, token } = h.createEnrollment(ACTOR); h.revokeEnrollment(id, ACTOR);
    const statuses: number[] = []; for (let i = 0; i < 40; i++) statuses.push((await post(base, RUNTIME_ENROLL_PATH, enrollInput(h, token))).status);
    expect(statuses.slice(0, 30).every(status => status === 403)).toBe(true); expect(statuses.at(-1)).toBe(429);
  });
});

describe("the administrator routes", () => {
  const token = "t".repeat(48);
  function request(path: string, method = "GET", body: unknown = {}): IncomingMessage {
    const req = Readable.from([JSON.stringify(body)]) as unknown as IncomingMessage;
    req.method = method; req.url = path; req.headers = { host: "localhost", "x-agend-token": token };
    Object.defineProperty(req, "socket", { value: { remoteAddress: "127.0.0.1" }, configurable: true }); return req;
  }
  class Response extends ServerResponse {
    status = 0; body = "";
    override writeHead(code: number): this { this.status = code; return this; }
    override end(chunk?: unknown): this { this.body += String(chunk ?? ""); return this; }
  }
  beforeEach(() => vi.stubEnv("AGEND_REMOTE_RUNTIME", "1"));
  afterEach(() => vi.unstubAllEnvs());
  function run(ctx: RuntimeApiContext, path: string, method = "GET", body: unknown = {}, mutate?: (req: IncomingMessage) => void) {
    const req = request(path, method, body), res = new Response(req); mutate?.(req);
    handleRuntimeRequest(req, res, new URL(path, "http://localhost"), ctx); return res;
  }
  const context = () => { const h = hub(), ctx: RuntimeApiContext = { webToken: token, runtimeCoordinator: () => h }; return { h, ctx }; };
  it("issues a token to an authorised administrator, once, with the server fingerprint, and lists it without the token", async () => {
    const { h, ctx } = context(), issued = run(ctx, "/ui/runtimes/enrollment", "POST");
    await vi.waitFor(() => expect(issued.status).toBe(201));
    const body = JSON.parse(issued.body); expect(body.token).toMatch(RUNTIME_ENROLL_TOKEN_PATTERN); expect(body.fingerprint).toBe(h.serverFingerprint());
    const list = run(ctx, "/ui/runtimes"); expect(list.status).toBe(200);
    expect(list.body).not.toContain(body.token); expect(JSON.parse(list.body).enrollments).toEqual([{ id: body.id, status: "unused", createdAt: body.createdAt, expiresAt: body.expiresAt }]);
  });
  it("needs the same authorization as a pairing code: no token, a foreign Origin or a public link gets nothing", async () => {
    const { h, ctx } = context(), create = vi.spyOn(h, "createEnrollment");
    for (const kind of ["missing", "origin"]) {
      const res = run(ctx, "/ui/runtimes/enrollment", "POST", {}, req => { if (kind === "missing") delete req.headers["x-agend-token"]; else req.headers.origin = "https://foreign.example"; });
      expect(res.status).toBe(403);
    }
    expect(create).not.toHaveBeenCalled();
  });
  it("answers 404 for those routes while Remote Runtime is off, and 404 for a GET", async () => {
    vi.stubEnv("AGEND_REMOTE_RUNTIME", ""); const get = vi.fn();
    expect(run({ webToken: token, runtimeCoordinator: get }, "/ui/runtimes/enrollment", "POST").status).toBe(404); expect(get).not.toHaveBeenCalled();
    vi.stubEnv("AGEND_REMOTE_RUNTIME", "1"); const { ctx } = context();
    expect(run(ctx, "/ui/runtimes/enrollment", "GET").status).toBe(404);
  });
  it("revokes an unused token, and refuses fields or an unknown id", async () => {
    const { h, ctx } = context(), { id, token: secret } = h.createEnrollment(ACTOR);
    const ok = run(ctx, `/ui/runtimes/enrollment/${id}/revoke`, "POST"); await vi.waitFor(() => expect(ok.status).toBe(200));
    expect(JSON.parse(ok.body).enrollment).toMatchObject({ id, status: "revoked" }); expect(() => h.enroll(enrollInput(h, secret))).toThrow(/revoked/);
    const bad = run(ctx, `/ui/runtimes/enrollment/${id}/revoke`, "POST", { x: 1 }); await vi.waitFor(() => expect(bad.status).toBe(400));
    const missing = run(ctx, "/ui/runtimes/enrollment/00000000-0000-4000-8000-000000000000/revoke", "POST"); await vi.waitFor(() => expect(missing.status).toBe(400));
    const fields = run(ctx, "/ui/runtimes/enrollment", "POST", { server: "x" }); await vi.waitFor(() => expect(fields.status).toBe(400));
  });
  it("records the administrator session handle as the actor (an opaque value, never an address)", async () => {
    const seen: RuntimeEnrollmentAuditEntry[] = [], h = hub({ audit: entry => seen.push(entry) }), ctx: RuntimeApiContext = { webToken: token, runtimeCoordinator: () => h };
    const res = run(ctx, "/ui/runtimes/enrollment", "POST"); await vi.waitFor(() => expect(res.status).toBe(201));
    expect(seen[0]).toMatchObject({ event: "issued", actor: "api-token" });     // a header token has no session handle
  });
});

describe("the Runtime joining with a token (enrollRuntime)", () => {
  // The Runtime reports the platform it runs on, and AgEnD accepts only Windows ones.
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  beforeEach(() => { Object.defineProperty(process, "platform", { value: "win32" }); });
  afterEach(() => { Object.defineProperty(process, "platform", platform); });
  const storeDir = (): RuntimeClientStore => { const dir = mkdtempSync(join(tmpdir(), "agend-runtime-enroll-profile-")); homes.push(dir); return new RuntimeClientStore(dir); };
  it("proves the server first, then spends the token, and saves a credential the server accepts", async () => {
    const log: string[] = [], h = hub(), base = await listen(h, log), { token } = h.createEnrollment(ACTOR), store = storeDir(), reports: string[] = [];
    const credentials = await enrollRuntime({ server: base, token, fingerprint: h.serverFingerprint(), name: "Desk", store, report: text => reports.push(text) });
    expect(log).toEqual([`POST ${RUNTIME_ENROLL_HELLO_PATH}`, `POST ${RUNTIME_ENROLL_PATH}`]);               // identity before token, in that order
    expect(store.credentials()).toMatchObject({ server: base, machineId: credentials.machineId, credential: credentials.credential, name: "Desk" });
    expect(h.machine(credentials.machineId)).toMatchObject({ enrolledVia: "install-command", status: "offline" });
    expect(reports.join("\n")).not.toContain(token);
    const ws = new WebSocket(base.replace("http:", "ws:") + "/runtime/v1/connect", { headers: { Authorization: `Bearer ${credentials.credential}` } }); clients.push(ws);
    await once(ws, "open");
  });
  it("sends NOTHING secret when the server's fingerprint is not the pinned one: the token is never transmitted", async () => {
    const log: string[] = [], bodies: string[] = [], h = hub(), real = createServer((req, res) => {
      const chunks: Buffer[] = []; req.on("data", chunk => chunks.push(chunk)); req.on("end", () => { log.push(`${req.method} ${req.url}`); bodies.push(Buffer.concat(chunks).toString()); if (!h.handlePublicRequest(req, res, new URL(req.url ?? "/", "http://localhost"))) { res.writeHead(404); res.end(); } });
    });
    servers.push(real); real.listen(0, "127.0.0.1"); await once(real, "listening"); const base = `http://127.0.0.1:${(real.address() as { port: number }).port}`;
    const { token } = h.createEnrollment(ACTOR), store = storeDir();
    await expect(enrollRuntime({ server: base, token, fingerprint: "e".repeat(64), name: "Desk", store })).rejects.toThrow(/did not prove it is the AgEnD this install command was made for.*NOT sent/s);
    expect(log).toEqual([`POST ${RUNTIME_ENROLL_HELLO_PATH}`]); expect(bodies.join("")).not.toContain(token);
    expect(store.credentials()).toBeNull(); expect(h.listEnrollments()[0].status).toBe("unused"); expect(h.listMachines()).toEqual([]);
  });
  it("sends nothing secret to something that is not an AgEnD at all (no JSON, or the route is missing)", async () => {
    const seenBodies: string[] = [], other = createServer((req, res) => { req.on("data", chunk => seenBodies.push(String(chunk))); req.on("end", () => { res.writeHead(200, { "Content-Type": "text/html" }); res.end("<html>hello</html>"); }); });
    servers.push(other); other.listen(0, "127.0.0.1"); await once(other, "listening"); const base = `http://127.0.0.1:${(other.address() as { port: number }).port}`;
    const token = generateEnrollToken();
    await expect(enrollRuntime({ server: base, token, fingerprint: "a".repeat(64), name: "Desk", store: storeDir() })).rejects.toThrow(/NOT sent/);
    expect(seenBodies.join("")).not.toContain(token);
  });
  it("refuses a grant that is not signed for this request, and saves nothing", async () => {
    const h = hub(), identity = loadRuntimeServerIdentity(homes[0]);
    const proxy = createServer((req, res) => {
      const chunks: Buffer[] = []; req.on("data", chunk => chunks.push(chunk)); req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        if (req.url === RUNTIME_ENROLL_HELLO_PATH) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ publicKey: identity.publicKey, signature: identity.signature(runtimeEnrollHelloMessage(body.nonce)) })); return; }
        // a grant signed for a DIFFERENT credential: a replay or a swap
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "enrolled", machineId: "11111111-2222-4333-8444-555555555555", credential: "c".repeat(64), signature: identity.signature(runtimeEnrollGrantMessage(body.nonce, "11111111-2222-4333-8444-555555555555", "d".repeat(64))) }));
      });
    });
    servers.push(proxy); proxy.listen(0, "127.0.0.1"); await once(proxy, "listening"); const base = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`, store = storeDir();
    await expect(enrollRuntime({ server: base, token: generateEnrollToken(), fingerprint: identity.fingerprint, name: "Desk", store })).rejects.toThrow(/could not be verified, so nothing was saved/);
    expect(store.credentials()).toBeNull(); expect(h).toBeTruthy();
  });
  it("turns each refusal into one plain sentence that names the next step (open Settings, generate again), without the token", async () => {
    let now = 1_000_000; const h = hub({ now: () => now }), base = await listen(h), fingerprint = h.serverFingerprint(), store = storeDir();
    const expired = h.createEnrollment(ACTOR); now += ENROLL_TTL_MS;
    await expect(enrollRuntime({ server: base, token: expired.token, fingerprint, name: "Desk", store })).rejects.toThrow(/expired.*generate a new install command/s);
    const revoked = h.createEnrollment(ACTOR); h.revokeEnrollment(revoked.id, ACTOR);
    await expect(enrollRuntime({ server: base, token: revoked.token, fingerprint, name: "Desk", store })).rejects.toThrow(/revoked in AgEnD.*generate a new install command/s);
    const live = h.createEnrollment(ACTOR); await enrollRuntime({ server: base, token: live.token, fingerprint, name: "Desk", store: storeDir() });
    let used: Error | undefined; try { await enrollRuntime({ server: base, token: live.token, fingerprint, name: "Desk", store }); } catch (error) { used = error as Error; }
    expect(used?.message).toMatch(/already used.*generate a new install command/s); expect(used?.message).not.toContain(live.token);
    await expect(enrollRuntime({ server: base, token: generateEnrollToken(), fingerprint, name: "Desk", store })).rejects.toThrow(/not valid for this AgEnD.*generate a new install command/s);
    expect(store.credentials()).toBeNull();
    for (const reason of ["invalid", "expired", "used", "revoked", "mismatch", "limit", "anything-else"]) expect(describeEnrollRefusal(reason)).not.toBe("");
  });
  it("refuses a malformed token or fingerprint before it talks to anyone", async () => {
    const store = storeDir(), fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(enrollRuntime({ server: "http://127.0.0.1:1", token: "agend_enroll_short", fingerprint: "a".repeat(64), name: "Desk", store })).rejects.toThrow(/not valid/);
    await expect(enrollRuntime({ server: "http://127.0.0.1:1", token: generateEnrollToken(), fingerprint: "xyz", name: "Desk", store })).rejects.toThrow(/fingerprint/);
    expect(fetchSpy).not.toHaveBeenCalled(); fetchSpy.mockRestore();
  });
  it("leaves the token in no file: not in the AgEnD data folder, not in the Runtime profile", async () => {
    const h = hub(), base = await listen(h), { token } = h.createEnrollment(ACTOR), store = storeDir();
    await enrollRuntime({ server: base, token, fingerprint: h.serverFingerprint(), name: "Desk", store });
    for (const dir of [homes[0], store.directory]) for (const text of everyFile(dir)) { expect(text).not.toContain(token); expect(text).not.toContain(token.slice("agend_enroll_".length)); }
    expect(existsSync(join(store.directory, "connection.json"))).toBe(true);
    // the credential file holds the machine credential and the address only
    expect(Object.keys(JSON.parse(readFileSync(join(store.directory, "connection.json"), "utf8"))).sort()).toEqual(["credential", "machineId", "name", "server"]);
    expect(createHash("sha256").update(token).digest("hex")).toMatch(/^[a-f0-9]{64}$/);
  });
});
