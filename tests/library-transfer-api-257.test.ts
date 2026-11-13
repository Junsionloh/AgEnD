/** AGEND-257: the routes behind export / import / the skill editor — admin only, nothing stored by a preview, the approved bytes are the stored bytes. */
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { WebSessionStore, csrfTokenFor, tokenEpoch } from "../src/web-session.js";
import { handleWebRequest } from "../src/web-api.js";
import { readZip, writeZip } from "../src/library/zip.js";

const servers: Server[] = [], dirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise<void>((r) => s.close(() => r())); }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function rig() {
  const dataDir = mkdtempSync(join(tmpdir(), "agend-libxfer-")); dirs.push(dataDir);
  const token = "a".repeat(48), sessions = new WebSessionStore();
  const admin = sessions.create({ tier: "admin", surface: "local", label: "admin", tokenEpoch: tokenEpoch(token) });
  const viewer = sessions.create({ tier: "read", surface: "local", label: "viewer", tokenEpoch: tokenEpoch(token) });
  const ctx: any = { webToken: token, webSessions: sessions, dataDir, fleetConfig: { instances: {} }, logger: { error() {}, info() {}, warn() {}, debug() {} } };
  const s = createServer((req, res) => { handleWebRequest(req, res, new URL(req.url!, `http://${req.headers.host}`), ctx); });
  servers.push(s); s.listen(0, "127.0.0.1"); await once(s, "listening");
  const base = `http://127.0.0.1:${(s.address() as any).port}`;
  const headers = (id: string, type = "application/json") => ({ "content-type": type, cookie: `agend_session=${id}`, origin: base, "x-agend-csrf": csrfTokenFor(id) });
  const who = (id: string) => ({
    get: (path: string) => fetch(base + path, { headers: headers(id) }),
    post: (path: string, body: unknown) => fetch(base + path, { method: "POST", body: JSON.stringify(body), headers: headers(id) }),
    upload: (path: string, bytes: Buffer) => fetch(base + path, { method: "POST", body: new Uint8Array(bytes), headers: headers(id, "application/octet-stream") }),
  });
  return { dataDir, base, admin: who(admin.sessionId), viewer: who(viewer.sessionId) };
}
const md = (name: string, extra = ""): string => `---\nname: ${name}\ndescription: Does ${name} things\n---\n\nBody${extra}\n`;
const pack = (...skills: Array<[string, string]>) => writeZip(skills.flatMap(([id, text]) => [{ name: `${id}/SKILL.md`, data: Buffer.from(text) }]));
const ghp = `gh${"p_"}${"x".repeat(36)}`;

it("exports one team skill as <id>.zip, every team skill in one zip, and a built-in one as a copy", async () => {
  const r = await rig();
  expect((await r.admin.get("/ui/library/export-all")).status).toBe(404);
  await r.admin.post("/ui/library/save", { kind: "skill", id: "demo", files: [{ path: "SKILL.md", content: md("demo") }, { path: "ref/a.md", content: "a" }] });
  await r.admin.post("/ui/library/save", { kind: "skill", id: "other", files: [{ path: "SKILL.md", content: md("other") }] });
  const one = await r.admin.get("/ui/library/export?id=demo");
  expect(one.status).toBe(200);
  expect(one.headers.get("content-type")).toBe("application/zip");
  expect(one.headers.get("content-disposition")).toBe('attachment; filename="demo.zip"');
  expect(one.headers.get("x-content-type-options")).toBe("nosniff");
  const zip = readZip(Buffer.from(await one.arrayBuffer())) as any;
  expect(zip.entries.map((e: any) => e.name)).toEqual(["demo/SKILL.md", "demo/ref/a.md"]);
  const all = readZip(Buffer.from(await (await r.admin.get("/ui/library/export-all")).arrayBuffer())) as any;
  expect(all.entries.map((e: any) => e.name)).toEqual(["demo/SKILL.md", "demo/ref/a.md", "other/SKILL.md"]);
  const built = await r.admin.get("/ui/library/export?id=concepts&builtin=1");
  expect(built.status).toBe(200);
  expect((readZip(Buffer.from(await built.arrayBuffer())) as any).entries[0].data.toString("utf8")).toBe(readFileSync("src/general-knowledge/skills/concepts/SKILL.md", "utf8"));
  // a built-in export touches nothing of the team's
  expect(readdirSync(join(r.dataDir, "library", "skills")).sort()).toEqual(["demo", "other"]);
  expect((await r.admin.get("/ui/library/export?id=missing")).status).toBe(404);
  expect((await r.admin.get("/ui/library/export?id=..%2F..%2Fetc")).status).toBe(400);
  expect((await r.admin.get("/ui/library/export?id=concepts")).status).toBe(404);       // not a team skill without builtin=1
});

it("a preview stores nothing and shows each skill in full; the import then stores exactly the bytes that were previewed", async () => {
  const r = await rig();
  const bytes = pack(["fresh", md("fresh")], ["concepts", md("concepts")]);
  const p = await r.admin.upload("/ui/library/import/preview?filename=pack.skill", bytes);
  expect(p.status).toBe(200);
  const preview = await p.json();
  expect(preview).toMatchObject({ ok: true, format: "zip", skills: [{ id: "concepts", conflict: "builtin" }, { id: "fresh", conflict: "none", skillMd: md("fresh"), files: [{ path: "SKILL.md" }] }] });
  expect(existsSync(join(r.dataDir, "library"))).toBe(false);
  // the preview's hash is what the import must carry: other bytes (or none) are refused and store nothing
  const other = pack(["fresh", md("fresh", " changed")]);
  const bad = await r.admin.upload(`/ui/library/import?sha256=${preview.sha256}`, other);
  expect(bad.status).toBe(409);
  expect(await bad.json()).toMatchObject({ error: "changed" });
  expect((await r.admin.upload("/ui/library/import", bytes)).status).toBe(409);
  expect(existsSync(join(r.dataDir, "library"))).toBe(false);
  const decisions = encodeURIComponent(JSON.stringify({ concepts: { action: "rename", as: "my-concepts" } }));
  const done = await r.admin.upload(`/ui/library/import?sha256=${preview.sha256}&filename=${encodeURIComponent("C:\\Users\\me\\pack.skill")}&decisions=${decisions}`, bytes);
  expect(done.status).toBe(200);
  expect(await done.json()).toMatchObject({ ok: true, results: [{ id: "concepts", status: "renamed", savedAs: "my-concepts" }, { id: "fresh", status: "imported" }] });
  const list = await (await r.admin.get("/ui/library/list")).json();
  expect(list.items.map((i: any) => `${i.id}:${i.status}:${i.source?.type}:${i.source?.from}`)).toEqual(["fresh:ok:import:pack.skill", "my-concepts:ok:import:pack.skill"]);
});

it("a single SKILL.md can be imported, and a name clash with the team's own is settled by the admin's choice", async () => {
  const r = await rig();
  await r.admin.post("/ui/library/save", { kind: "skill", id: "demo", files: [{ path: "SKILL.md", content: md("demo", " old") }] });
  const bytes = Buffer.from(md("demo", " new"));
  const preview = await (await r.admin.upload("/ui/library/import/preview", bytes)).json();
  expect(preview).toMatchObject({ format: "skill-md", skills: [{ id: "demo", conflict: "team" }] });
  const go = (d: unknown) => r.admin.upload(`/ui/library/import?sha256=${preview.sha256}&decisions=${encodeURIComponent(JSON.stringify(d))}`, bytes).then((x) => x.json());
  expect(await go({})).toMatchObject({ results: [{ status: "skipped", reason: "undecided" }] });
  expect(await go({ demo: { action: "overwrite" } })).toMatchObject({ results: [{ status: "replaced" }] });
  expect((await (await r.admin.get("/ui/library/item?kind=skill&id=demo")).json()).detail.files[0].content).toBe(md("demo", " new"));
});

it("refuses what is wrong with an upload by code and place, never the secret; a bad decisions value is a bad request", async () => {
  const r = await rig();
  const slip = writeZip([{ name: "../evil/SKILL.md", data: Buffer.from(md("evil")) }]);
  expect(await (await r.admin.upload("/ui/library/import/preview", slip)).json()).toMatchObject({ error: "invalid_path", path: "../evil/SKILL.md" });
  const leaky = writeZip([{ name: "leak/SKILL.md", data: Buffer.from(md("leak")) }, { name: "leak/n.md", data: Buffer.from(`k = ${ghp}\n`) }]);
  const res = await r.admin.upload("/ui/library/import/preview", leaky);
  const text = await res.text();
  expect(text).not.toContain(ghp);
  expect(JSON.parse(text)).toMatchObject({ ok: true, skills: [{ id: "leak", ok: false, error: "secret_found", findings: [{ field: "n.md", line: 1 }] }] });
  expect((await r.admin.upload("/ui/library/import/preview", Buffer.from([1, 2, 3, 0, 5]))).status).toBe(400);
  const sha = JSON.parse(text).sha256;
  expect((await r.admin.upload(`/ui/library/import?sha256=${sha}&decisions=nope`, leaky)).status).toBe(400);
  expect((await r.admin.upload(`/ui/library/import?sha256=${sha}&decisions=${encodeURIComponent('{"leak":{"action":"delete-everything"}}')}`, leaky)).status).toBe(400);
  expect(existsSync(join(r.dataDir, "library"))).toBe(false);
});

it("only an administrator can export or import; nothing is created", async () => {
  const r = await rig();
  await r.admin.post("/ui/library/save", { kind: "skill", id: "demo", files: [{ path: "SKILL.md", content: md("demo") }] });
  const bytes = pack(["x", md("x")]);
  expect((await r.viewer.get("/ui/library/export?id=demo")).status).toBe(403);
  expect((await r.viewer.get("/ui/library/export-all")).status).toBe(403);
  expect((await r.viewer.get("/ui/library/builtin?name=concepts")).status).toBe(403);
  expect((await r.viewer.upload("/ui/library/import/preview", bytes)).status).toBe(403);
  expect((await r.viewer.upload("/ui/library/import?sha256=x", bytes)).status).toBe(403);
  expect([401, 403]).toContain((await fetch(`${r.base}/ui/library/export?id=demo`)).status);
  expect([401, 403]).toContain((await fetch(`${r.base}/ui/library/import/preview`, { method: "POST", body: new Uint8Array(bytes) })).status);
  expect(readdirSync(join(r.dataDir, "library", "skills"))).toEqual(["demo"]);
});

it("the page reads a skill as fields and Markdown: a team skill, and a built-in one (which has no other route to be changed by)", async () => {
  const r = await rig();
  await r.admin.post("/ui/library/save", { kind: "skill", id: "demo", files: [{ path: "SKILL.md", content: "---\nname: demo\ndescription: A demo\nroles: [worker]\n---\n# Hi\n" }] });
  const one = await (await r.admin.get("/ui/library/item?kind=skill&id=demo")).json();
  expect(one.detail).toMatchObject({ fields: [{ key: "name", value: "demo" }, { key: "description", value: "A demo" }, { key: "roles", value: "worker" }], body: "# Hi\n" });
  const built = await (await r.admin.get("/ui/library/builtin?name=concepts")).json();
  expect(built.detail).toMatchObject({ builtin: true, id: "concepts" });
  expect(built.detail.fields.map((f: any) => f.key)).toContain("description");
  expect(built.detail.body.length).toBeGreaterThan(100);
  expect((await r.admin.get("/ui/library/builtin?name=nope-not-a-skill")).status).toBe(404);
  expect((await r.admin.get("/ui/library/builtin?name=..%2Fx")).status).toBe(404);
  // saving never writes a built-in one: it is not in the library folder
  expect(readdirSync(join(r.dataDir, "library", "skills"))).toEqual(["demo"]);
});

it("editing: a save runs the same checks and writes nothing when one fails; a good save changes the recorded hash; a skill changed meanwhile is not overwritten", async () => {
  const r = await rig();
  const base = [{ path: "SKILL.md", content: md("demo") }, { path: "ref/a.md", content: "a" }];
  await r.admin.post("/ui/library/save", { kind: "skill", id: "demo", files: base });
  const before = (await (await r.admin.get("/ui/library/list")).json()).items[0];
  const lock = () => readFileSync(join(r.dataDir, "library", "library.lock.json"), "utf8");
  const disk = () => readFileSync(join(r.dataDir, "library", "skills", "demo", "SKILL.md"), "utf8");
  const edit = (files: unknown, expect_?: string) => r.admin.post("/ui/library/save", { kind: "skill", id: "demo", files, overwrite: true, expect: expect_ ?? before.sha256 });
  const lockBefore = lock();
  // verification fails: no frontmatter, a name that is not the folder, a secret
  expect((await edit([{ path: "SKILL.md", content: "no frontmatter" }])).status).toBe(400);
  expect((await edit([{ path: "SKILL.md", content: md("renamed") }])).status).toBe(400);
  const secret = await edit([{ path: "SKILL.md", content: md("demo") }, { path: "ref/a.md", content: `k ${ghp}` }]);
  expect(secret.status).toBe(400);
  const secretText = await secret.text();
  expect(JSON.parse(secretText)).toMatchObject({ error: "secret_found", findings: [{ field: "ref/a.md", line: 1 }] });
  expect(secretText).not.toContain(ghp);
  expect(disk()).toBe(md("demo"));
  expect(lock()).toBe(lockBefore);
  // a good edit: written, hash changes, status stays ok
  const good = await edit([{ path: "SKILL.md", content: md("demo", " edited") }, { path: "ref/a.md", content: "a" }]);
  expect(good.status).toBe(200);
  expect(disk()).toBe(md("demo", " edited"));
  const after = (await (await r.admin.get("/ui/library/list")).json()).items[0];
  expect(after).toMatchObject({ id: "demo", status: "ok" });
  expect(after.sha256).not.toBe(before.sha256);
  expect(lock()).toContain(after.sha256);
  expect(lock()).not.toContain(before.sha256);
  // the editor started from `before`: someone saved since, so this one is refused (409) and the newer text stays
  const stale = await edit([{ path: "SKILL.md", content: md("demo", " stale") }, { path: "ref/a.md", content: "a" }]);
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ error: "changed" });
  expect(disk()).toBe(md("demo", " edited"));
  expect((await edit([{ path: "SKILL.md", content: md("demo", " again") }, { path: "ref/a.md", content: "a" }], after.sha256)).status).toBe(200);
});
