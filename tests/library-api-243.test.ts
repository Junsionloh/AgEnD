/** AGEND-243: the library's web routes — admin only, validated, and nothing is written without a valid admin request. */
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { WebSessionStore, csrfTokenFor, tokenEpoch } from "../src/web-session.js";
import { handleWebRequest } from "../src/web-api.js";

const servers: Server[] = [], dirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise<void>((r) => s.close(() => r())); }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function rig() {
  const dataDir = mkdtempSync(join(tmpdir(), "agend-libapi-")); dirs.push(dataDir);
  const token = "a".repeat(48), sessions = new WebSessionStore();
  const admin = sessions.create({ tier: "admin", surface: "local", label: "admin", tokenEpoch: tokenEpoch(token) });
  const viewer = sessions.create({ tier: "read", surface: "local", label: "viewer", tokenEpoch: tokenEpoch(token) });
  const ctx: any = { webToken: token, webSessions: sessions, dataDir, fleetConfig: { instances: {} }, logger: { error() {}, info() {}, warn() {}, debug() {} } };
  const s = createServer((req, res) => { handleWebRequest(req, res, new URL(req.url!, `http://${req.headers.host}`), ctx); });
  servers.push(s); s.listen(0, "127.0.0.1"); await once(s, "listening");
  const base = `http://127.0.0.1:${(s.address() as any).port}`;
  const headers = (id: string) => ({ "content-type": "application/json", cookie: `agend_session=${id}`, origin: base, "x-agend-csrf": csrfTokenFor(id) });
  const post = (id: string) => (path: string, body: unknown) => fetch(base + path, { method: "POST", body: JSON.stringify(body), headers: headers(id) });
  const get = (id: string) => (path: string) => fetch(base + path, { headers: headers(id) });
  return { dataDir, base, admin: { post: post(admin.sessionId), get: get(admin.sessionId) }, viewer: { post: post(viewer.sessionId), get: get(viewer.sessionId) } };
}
const SKILL = `---\nname: demo\ndescription: A demo\n---\nBody\n`;
const MCP = "agend_library: 1\nkind: mcp\nname: m\ntransport: stdio\ncommand: node\nenv:\n  - TOKEN_VAR\n";

it("an admin saves, lists, reads and deletes a skill and an MCP item", async () => {
  const r = await rig();
  expect(await (await r.admin.get("/ui/library/list")).json()).toMatchObject({ items: [] });
  expect(existsSync(join(r.dataDir, "library"))).toBe(false);
  const saved = await r.admin.post("/ui/library/save", { kind: "skill", id: "demo", files: [{ path: "SKILL.md", content: SKILL }] });
  expect(saved.status).toBe(200);
  expect((await r.admin.post("/ui/library/save", { kind: "mcp", id: "m", text: MCP })).status).toBe(200);
  const list = await (await r.admin.get("/ui/library/list")).json();
  expect(list.items.map((i: any) => `${i.kind}:${i.id}:${i.status}`)).toEqual(["skill:demo:ok", "mcp:m:ok"]);
  const one = await (await r.admin.get("/ui/library/item?kind=skill&id=demo")).json();
  expect(one).toMatchObject({ ok: true, detail: { id: "demo", files: [{ path: "SKILL.md", content: SKILL }] } });
  expect((await r.admin.post("/ui/library/delete", { kind: "skill", id: "demo" })).status).toBe(200);
  expect((await r.admin.get("/ui/library/item?kind=skill&id=demo")).status).toBe(404);
  expect((await r.admin.post("/ui/library/delete", { kind: "mcp", id: "m" })).status).toBe(200);
});

it("answers the library's errors with a code and the place, never the secret", async () => {
  const r = await rig();
  const ghp = `gh${"p_"}${"x".repeat(36)}`;
  const secret = await r.admin.post("/ui/library/save", { kind: "skill", id: "demo", files: [{ path: "SKILL.md", content: SKILL }, { path: "n.md", content: ghp }] });
  expect(secret.status).toBe(400);
  const text = await secret.text();
  expect(JSON.parse(text)).toMatchObject({ error: "secret_found", findings: [{ field: "n.md", line: 1 }] });
  expect(text).not.toContain(ghp);
  expect((await r.admin.post("/ui/library/save", { kind: "skill", id: "../x", files: [] })).status).toBe(400);
  expect((await r.admin.post("/ui/library/save", { kind: "skill", id: "demo", files: [{ path: "../SKILL.md", content: SKILL }] })).status).toBe(400);
  expect((await r.admin.post("/ui/library/save", { kind: "nope", id: "demo" })).status).toBe(400);
  expect((await r.admin.get("/ui/library/item?kind=skill&id=..%2F..")).status).toBe(400);
  const big = await r.admin.post("/ui/library/save", { kind: "skill", id: "demo", files: [{ path: "SKILL.md", content: SKILL + "x".repeat(150 * 1024) }] });
  expect(big.status).toBe(413);
  const ok = { kind: "skill", id: "demo", files: [{ path: "SKILL.md", content: SKILL }] };
  expect((await r.admin.post("/ui/library/save", ok)).status).toBe(200);
  expect((await r.admin.post("/ui/library/save", ok)).status).toBe(409);
  // AGEND-260: a replacement must name the version it read (`expect`); without it nothing is written
  const noExpect = await r.admin.post("/ui/library/save", { ...ok, overwrite: true, files: [{ path: "SKILL.md", content: SKILL + "\nchanged\n" }] });
  expect(noExpect.status).toBe(400);
  expect(await noExpect.json()).toMatchObject({ error: "invalid_request", detail: "expect" });
  const sha = (await (await r.admin.get("/ui/library/item?kind=skill&id=demo")).json() as any).detail.sha256;
  expect((await r.admin.post("/ui/library/save", { ...ok, overwrite: true, expect: "0".repeat(64) })).status).toBe(409);
  expect((await r.admin.post("/ui/library/save", { ...ok, overwrite: true, expect: "short" })).status).toBe(400);
  expect((await r.admin.post("/ui/library/save", { ...ok, overwrite: true, expect: sha })).status).toBe(200);
  expect((await r.admin.post("/ui/library/delete", { kind: "skill", id: "missing" })).status).toBe(404);
});

it("is for the administrator only: a read-only session or no session cannot read or write, and nothing is created", async () => {
  const r = await rig();
  expect((await r.viewer.get("/ui/library/list")).status).toBe(403);
  expect((await r.viewer.post("/ui/library/save", { kind: "skill", id: "demo", files: [{ path: "SKILL.md", content: SKILL }] })).status).toBe(403);
  expect((await r.viewer.post("/ui/library/delete", { kind: "skill", id: "demo" })).status).toBe(403);
  expect([401, 403]).toContain((await fetch(`${r.base}/ui/library/list`)).status);
  expect([401, 403]).toContain((await fetch(`${r.base}/ui/library/save`, { method: "POST", body: "{}" })).status);
  expect(existsSync(join(r.dataDir, "library"))).toBe(false);
});
