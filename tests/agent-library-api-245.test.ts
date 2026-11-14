/** AGEND-245: the routes — build with the Library groups, compare a file with this computer's Library, apply the administrator's choices. Admin only; no value ever in an answer. */
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { afterEach, expect, it } from "vitest";
import { WebSessionStore, csrfTokenFor, tokenEpoch } from "../src/web-session.js";
import { handleWebRequest } from "../src/web-api.js";
import { LibraryStore } from "../src/library/store.js";
import { McpConfirmations } from "../src/library/mcp-mount.js";

const servers: Server[] = [], dirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise<void>((r) => s.close(() => r())); }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const SECRET = "tok-9f8e7d6c5b4a-SECRET";
const md = (name: string): string => `---\nname: ${name}\ndescription: Does ${name} things\n---\n\n# ${name}\n`;
const MCP = "agend_library: 1\nkind: mcp\nname: gh\ndescription: GitHub\ntransport: stdio\ncommand: npx\nargs:\n  - -y\n  - gh-mcp\nenv:\n  - MCP_GH_TOKEN\n";

async function rig(instances: Record<string, any>) {
  const dataDir = mkdtempSync(join(tmpdir(), "agend-xlapi-")); dirs.push(dataDir);
  const token = "a".repeat(48), sessions = new WebSessionStore();
  const admin = sessions.create({ tier: "admin", surface: "local", label: "admin", tokenEpoch: tokenEpoch(token) });
  const read = sessions.create({ tier: "read", surface: "local", label: "r", tokenEpoch: tokenEpoch(token) });
  const ctx: any = { webToken: token, webSessions: sessions, dataDir, fleetConfig: { defaults: {}, instances: structuredClone(instances) },
    rawInstanceConfig: (n: string) => (Object.hasOwn(instances, n) ? structuredClone(instances[n]) : undefined), logger: { error() {}, info() {}, warn() {}, debug() {} } };
  const s = createServer((req, res) => { handleWebRequest(req, res, new URL(req.url!, `http://${req.headers.host}`), ctx); });
  servers.push(s); s.listen(0, "127.0.0.1"); await once(s, "listening");
  const base = `http://127.0.0.1:${(s.address() as any).port}`;
  const as = (id: string) => (path: string, body: unknown) => fetch(base + path, { method: "POST", body: JSON.stringify(body),
    headers: { "content-type": "application/json", cookie: `agend_session=${id}`, origin: base, "x-agend-csrf": csrfTokenFor(id) } });
  return { dataDir, ctx, post: as(admin.sessionId), viewer: as(read.sessionId) };
}
const inst = { coder: { backend: "claude-code", working_directory: "/w", library: { skills: ["ui"], mcp: ["gh"], paused: { skills: [], mcp: [] } } } };

async function exported(r: Awaited<ReturnType<typeof rig>>, embed: boolean) {
  const store = new LibraryStore(r.dataDir);
  store.addSkill("ui", [{ path: "SKILL.md", content: md("ui") }]);
  store.addMcp("gh", MCP);
  writeFileSync(join(r.dataDir, ".env"), `MCP_GH_TOKEN=${SECRET}\n`);
  const res = await r.post("/ui/agent-export/build", { instance: "coder", include: ["identity", "librarySkills", "libraryMcp"], embed });
  const body = await res.json();
  return { body, text: body.text as string };
}

it("build: the Library groups and `embed`; a value from .env is never in the answer; a bad `embed` is a 400", async () => {
  const r = await rig(inst);
  const refs = await exported(r, false);
  expect(parse(refs.text).library).toMatchObject({ skills: [{ id: "ui" }], mcp: [{ id: "gh", vars: ["MCP_GH_TOKEN"] }] });
  expect(refs.text).not.toContain("definition");
  expect(JSON.stringify(refs.body)).not.toContain(SECRET);
  expect(refs.body.libraryAssigned).toEqual({ skills: 1, mcp: 1 });
  const bundled = await (await r.post("/ui/agent-export/build", { instance: "coder", include: ["librarySkills", "libraryMcp"], embed: true })).json();
  expect(bundled.library).toEqual({ skills: 1, mcp: 1, bundled: 2 });
  expect(bundled.text).not.toContain(SECRET);
  expect((await r.post("/ui/agent-export/build", { instance: "coder", include: [], embed: "yes" })).status).toBe(400);
  expect(r.ctx.fleetConfig.instances).toEqual(inst);
});

it("status then apply: the file's definitions are added only on the choice, the MCP confirmed for that agent, and no agent setting changes", async () => {
  const exporterRig = await rig(inst);
  const { text } = await exported(exporterRig, true);
  const r = await rig({ coder: { backend: "claude-code", working_directory: "/w" } });
  const before = structuredClone(r.ctx.fleetConfig);
  const status = await (await r.post("/ui/agent-export/library-status", { text })).json();
  expect(status.skills.map((s: any) => [s.id, s.status])).toEqual([["ui", "missing-embedded"]]);
  expect(status.mcp.map((s: any) => [s.id, s.status])).toEqual([["gh", "missing-embedded"]]);
  expect(status.mcp[0].embedded.summary).toMatchObject({ command: "npx", args: ["-y", "gh-mcp"] });
  expect(existsSync(join(r.dataDir, "library"))).toBe(false);                  // comparing wrote nothing
  const sha = status.mcp[0].embedded.sha256;
  const out = await (await r.post("/ui/agent-export/library-apply", { text, instance: "coder", choices: { skills: { ui: { action: "add" } }, mcp: { gh: { action: "add", confirm: sha } } } })).json();
  expect(out).toMatchObject({ ok: true, mounts: { skills: { on: ["ui"], paused: [] }, mcp: { on: ["gh"], paused: [] } } });
  expect(JSON.stringify(out)).not.toContain(SECRET);
  const store = new LibraryStore(r.dataDir);
  expect(store.skillForMount("ui").ok).toBe(true);
  expect(new McpConfirmations(store).forAgent("coder")).toEqual({ gh: sha });
  expect(r.ctx.fleetConfig).toEqual(before);
  expect(readdirSync(r.dataDir).sort()).toEqual(["library"]);                   // nothing but the Library's own folder
  // the same file again: both are present now
  const again = await (await r.post("/ui/agent-export/library-status", { text })).json();
  expect([...again.skills, ...again.mcp].map((x: any) => x.status)).toEqual(["present", "present"]);
});

it("apply: an unknown agent is 404, a malformed choice is 400, a file that is not an export is 400; only the admin may use any of it", async () => {
  const r = await rig(inst);
  const { text } = await exported(r, true);
  expect((await r.post("/ui/agent-export/library-apply", { text, instance: "nobody", choices: {} })).status).toBe(404);
  expect((await r.post("/ui/agent-export/library-apply", { text, instance: "__proto__", choices: {} })).status).toBe(404);
  expect((await r.post("/ui/agent-export/library-apply", { text, instance: "coder", choices: { skills: { ui: { action: "delete" } } } })).status).toBe(400);
  expect((await r.post("/ui/agent-export/library-apply", { text, instance: "coder", choices: { mcp: { gh: { action: "use", confirm: "nothex" } } } })).status).toBe(400);
  expect((await r.post("/ui/agent-export/library-apply", { text, instance: "coder", choices: { skills: { "Bad Id": { action: "skip" } } } })).status).toBe(400);
  expect((await r.post("/ui/agent-export/library-status", { text: "hello" })).status).toBe(400);
  for (const path of ["library-status", "library-apply", "build", "parse"]) {
    expect((await r.viewer(`/ui/agent-export/${path}`, { text, instance: "coder", include: [], choices: {} })).status, path).toBeGreaterThanOrEqual(403);
  }
});

it("apply: an MCP server without the confirmed hash is not added; a skill clashing with a local one is never overwritten", async () => {
  const exporterRig = await rig(inst);
  const { text } = await exported(exporterRig, true);
  const r = await rig({ coder: { backend: "claude-code" } });
  const store = new LibraryStore(r.dataDir);
  store.addSkill("ui", [{ path: "SKILL.md", content: md("ui").replace("Does ui things", "Local edition") }]);
  const localSha = (store.get("skill", "ui") as any).detail.sha256;
  const out = await (await r.post("/ui/agent-export/library-apply", { text, instance: "coder", choices: { skills: { ui: { action: "add" } }, mcp: { gh: { action: "add" } } } })).json();
  expect(out.skills[0]).toMatchObject({ id: "ui", outcome: "failed", reason: "exists" });
  expect(out.mcp[0]).toMatchObject({ id: "gh", outcome: "failed", reason: "unconfirmed" });
  expect((store.get("skill", "ui") as any).detail.sha256).toBe(localSha);
  expect(existsSync(join(r.dataDir, "library", "mcp", "gh.yaml"))).toBe(false);
  expect(readFileSync(join(r.dataDir, "library", "skills", "ui", "SKILL.md"), "utf8")).toContain("Local edition");
});
