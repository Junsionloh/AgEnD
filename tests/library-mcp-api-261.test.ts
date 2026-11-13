/** AGEND-261: the routes behind the agent settings page's "Team MCP" card — admin only, names but never values, a confirmation per agent and version. */
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { WebSessionStore, csrfTokenFor, tokenEpoch } from "../src/web-session.js";
import { handleWebRequest } from "../src/web-api.js";
import { LibraryStore, McpConfirmations } from "../src/library/index.js";

const servers: Server[] = [], dirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise<void>((r) => s.close(() => r())); }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const SECRET = "tok-9f8e7d6c5b4a-SECRET";
async function rig(instances: Record<string, unknown> = { a: { backend: "claude-code", library: { mcp: ["gh"] } }, g: { backend: "grok" }, w: { runtime: "windows" } }) {
  const dataDir = mkdtempSync(join(tmpdir(), "agend-mcpapi-")); dirs.push(dataDir);
  const token = "a".repeat(48), sessions = new WebSessionStore();
  const admin = sessions.create({ tier: "admin", surface: "local", label: "admin", tokenEpoch: tokenEpoch(token) });
  const viewer = sessions.create({ tier: "read", surface: "local", label: "viewer", tokenEpoch: tokenEpoch(token) });
  const ctx: any = { webToken: token, webSessions: sessions, dataDir, fleetConfig: { defaults: { backend: "claude-code" }, instances }, logger: { error() {}, info() {}, warn() {}, debug() {} } };
  const s = createServer((req, res) => { handleWebRequest(req, res, new URL(req.url!, `http://${req.headers.host}`), ctx); });
  servers.push(s); s.listen(0, "127.0.0.1"); await once(s, "listening");
  const base = `http://127.0.0.1:${(s.address() as any).port}`;
  const headers = (id: string) => ({ "content-type": "application/json", cookie: `agend_session=${id}`, origin: base, "x-agend-csrf": csrfTokenFor(id) });
  const who = (id: string) => ({
    get: (path: string) => fetch(base + path, { headers: headers(id) }),
    post: (path: string, body: unknown) => fetch(base + path, { method: "POST", body: JSON.stringify(body), headers: headers(id) }),
  });
  return { dataDir, admin: who(admin.sessionId), viewer: who(viewer.sessionId) };
}
const MCP = "agend_library: 1\nkind: mcp\nname: gh\ndescription: GitHub\ntransport: stdio\ncommand: npx\nargs:\n  - -y\n  - gh-mcp\nenv:\n  - MCP_GH_TOKEN\n  - MCP_GH_HOST\n";

it("only an administrator reads the mount status or confirms an item", async () => {
  const r = await rig();
  await r.admin.post("/ui/library/save", { kind: "mcp", id: "gh", text: MCP });
  expect((await r.viewer.get("/ui/library/mcp-status?agent=a")).status).toBe(403);
  expect((await r.viewer.post("/ui/library/mcp-confirm", { agent: "a", id: "gh", sha256: "0".repeat(64) })).status).toBe(403);
  expect(existsSync(join(r.dataDir, "library", "mcp-confirmed.json"))).toBe(false);
});

it("the status shows what would run and which variables are set or missing — and never a value", async () => {
  const r = await rig();
  await r.admin.post("/ui/library/save", { kind: "mcp", id: "gh", text: MCP });
  writeFileSync(join(r.dataDir, ".env"), `MCP_GH_TOKEN=${SECRET}\nOTHER=zzz\n`);
  const res = await r.admin.get("/ui/library/mcp-status?agent=a");
  const text = await res.text();
  expect(text).not.toContain(SECRET);
  expect(text).not.toContain("zzz");
  expect(JSON.parse(text)).toMatchObject({
    agent: "a", backend: "claude-code", supported: true, windows: false,
    items: [{ id: "gh", status: "ok", mounted: true, confirmed: false,
      summary: { transport: "stdio", command: "npx", args: ["-y", "gh-mcp"], variables: ["MCP_GH_TOKEN", "MCP_GH_HOST"] },
      variables: [{ name: "MCP_GH_TOKEN", set: true }, { name: "MCP_GH_HOST", set: false }] }],
  });
});

it("a backend the table does not list is reported as unsupported; an unknown agent is 404", async () => {
  const r = await rig();
  expect(await (await r.admin.get("/ui/library/mcp-status?agent=g")).json()).toMatchObject({ backend: "grok", supported: false });
  expect(await (await r.admin.get("/ui/library/mcp-status?agent=w")).json()).toMatchObject({ windows: true });
  expect((await r.admin.get("/ui/library/mcp-status?agent=nobody")).status).toBe(404);
  expect((await r.admin.get("/ui/library/mcp-status?agent=constructor")).status).toBe(404);
  expect((await r.admin.get("/ui/library/mcp-status")).status).toBe(404);
});

it("confirming records the exact version for that agent; an edit afterwards makes it unconfirmed again; a stale or invalid confirmation is refused", async () => {
  const r = await rig();
  await r.admin.post("/ui/library/save", { kind: "mcp", id: "gh", text: MCP });
  const sha = (await (await r.admin.get("/ui/library/item?kind=mcp&id=gh")).json()).detail.sha256;
  const status = async () => (await (await r.admin.get("/ui/library/mcp-status?agent=a")).json()).items[0].confirmed;
  expect(await status()).toBe(false);
  // what the page showed is not what is stored: 409, nothing recorded
  expect((await r.admin.post("/ui/library/mcp-confirm", { agent: "a", id: "gh", sha256: "0".repeat(64) })).status).toBe(409);
  expect(await status()).toBe(false);
  expect((await r.admin.post("/ui/library/mcp-confirm", { agent: "a", id: "gh", sha256: sha })).status).toBe(200);
  expect(await status()).toBe(true);
  expect(new McpConfirmations(new LibraryStore(r.dataDir)).forAgent("a")).toEqual({ gh: sha });
  // another agent has not confirmed it
  expect((await (await r.admin.get("/ui/library/mcp-status?agent=g")).json()).items[0].confirmed).toBe(false);
  // the item is edited (with the hash it had): confirmation no longer matches
  expect((await r.admin.post("/ui/library/save", { kind: "mcp", id: "gh", text: MCP.replace("npx", "evil"), overwrite: true, expect: sha })).status).toBe(200);
  expect(await status()).toBe(false);
  // bad requests
  const bad = (body: unknown) => r.admin.post("/ui/library/mcp-confirm", body).then((x) => x.status);
  expect(await bad({ agent: "a", id: "../x", sha256: sha })).toBe(400);
  expect(await bad({ agent: "a", id: "gh", sha256: "nope" })).toBe(400);
  expect(await bad({ agent: "nobody", id: "gh", sha256: sha })).toBe(404);
  expect(await bad({ agent: "a", id: "missing", sha256: sha })).toBe(404);
  const file = readFileSync(join(r.dataDir, "library", "mcp-confirmed.json"), "utf8");
  expect(file).not.toContain("evil");
});

it("the list names the backends that take library MCP; the overview says who has what mounted", async () => {
  const r = await rig();
  expect((await (await r.admin.get("/ui/library/list")).json()).mcpBackends).toEqual(["claude-code", "codex"]);
  const ov = await (await r.admin.get("/ui/library/overview")).json();
  expect(ov.teamMcpUsage).toEqual({ gh: ["a"] });
  expect(ov.agents.find((x: any) => x.name === "g").libraryMcp).toBe(false);
  expect(ov.agents.find((x: any) => x.name === "a").libraryMcp).toBe(true);
});

it("an item that holds a variable's value is refused at the library, so no value can reach the status either", async () => {
  const r = await rig();
  const withValue = MCP.replace("  - MCP_GH_TOKEN\n", "  MCP_GH_TOKEN: ghp_abcdefghijklmnopqrstuvwxyz0123456789\n");
  expect((await r.admin.post("/ui/library/save", { kind: "mcp", id: "gh", text: withValue })).status).toBe(400);
});

it("AGEND-261 rule A: saving an item whose variable names do not start with MCP_ is refused with 400 and a code the page words — nothing is written; a viewer cannot save at all", async () => {
  const r = await rig();
  const bad = MCP.replace("MCP_GH_TOKEN", "GH_TOKEN");
  const res = await r.admin.post("/ui/library/save", { kind: "mcp", id: "gh", text: bad });
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "mcp_var_prefix", detail: "env", names: ["GH_TOKEN"] });
  expect(existsSync(join(r.dataDir, "library", "mcp", "gh.yaml"))).toBe(false);
  const header = "agend_library: 1\nkind: mcp\nname: h\ntransport: http\nurl: https://a.example/\nheaders:\n  Authorization: SERVICE_TOKEN\n";
  expect(await (await r.admin.post("/ui/library/save", { kind: "mcp", id: "h", text: header })).json()).toEqual({ error: "mcp_var_prefix", detail: "headers", names: ["SERVICE_TOKEN"] });
  // an edit of a saved item is the same save: it cannot be turned into one that breaks the rule
  expect((await r.admin.post("/ui/library/save", { kind: "mcp", id: "gh", text: MCP })).status).toBe(200);
  const sha = (await (await r.admin.get("/ui/library/item?kind=mcp&id=gh")).json()).detail.sha256;
  expect((await r.admin.post("/ui/library/save", { kind: "mcp", id: "gh", text: bad, overwrite: true, expect: sha })).status).toBe(400);
  expect((await r.viewer.post("/ui/library/save", { kind: "mcp", id: "z", text: MCP.replace("name: gh", "name: z") })).status).toBe(403);
});

it("AGEND-261 rule A: the status shows a hand-placed item with a bad name as unusable, with the names (never a value), and the picker data says why; a renamed variable shows what the server sees", async () => {
  const r = await rig();
  expect((await r.admin.post("/ui/library/save", { kind: "mcp", id: "gh", text: MCP.replace("  - MCP_GH_TOKEN\n  - MCP_GH_HOST\n", "  GITHUB_PERSONAL_ACCESS_TOKEN: ${MCP_GH_TOKEN}\n") })).status).toBe(200);
  writeFileSync(join(r.dataDir, "library", "mcp", "legacy.yaml"), MCP.replace("name: gh", "name: legacy").replace("MCP_GH_TOKEN", "LEGACY_TOKEN"));
  writeFileSync(join(r.dataDir, ".env"), `LEGACY_TOKEN=${SECRET}\nMCP_GH_TOKEN=${SECRET}\n`);
  const text = await (await r.admin.get("/ui/library/mcp-status?agent=a")).text();
  expect(text).not.toContain(SECRET);
  const items = JSON.parse(text).items;
  const gh = items.find((i: any) => i.id === "gh"), legacy = items.find((i: any) => i.id === "legacy");
  expect(gh.variables).toEqual([{ name: "MCP_GH_TOKEN", set: true, as: [{ name: "GITHUB_PERSONAL_ACCESS_TOKEN", kind: "env" }] }]);
  expect(legacy).toMatchObject({ id: "legacy", status: "invalid", badVars: ["LEGACY_TOKEN"], confirmed: false });
  expect(legacy.summary).toBeUndefined();
  // it cannot be confirmed (nothing to mount) — so there is no way to give it
  const confirm = await r.admin.post("/ui/library/mcp-confirm", { agent: "a", id: "legacy", sha256: "0".repeat(64) });
  expect(confirm.status).toBe(422);
});
