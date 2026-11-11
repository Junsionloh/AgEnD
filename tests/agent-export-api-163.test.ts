/** AGEND-163: the two routes behind Export and Load template — admin only, computed from the saved config, nothing written. */
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, expect, it } from "vitest";
import { WebSessionStore, csrfTokenFor, tokenEpoch } from "../src/web-session.js";
import { handleWebRequest } from "../src/web-api.js";

const servers: Server[] = [];
afterEach(async () => { for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise<void>((r) => s.close(() => r())); } });

async function rig() {
  const token = "a".repeat(48), sessions = new WebSessionStore();
  const admin = sessions.create({ tier: "admin", surface: "local", label: "admin", tokenEpoch: tokenEpoch(token) });
  const before = { instances: { coder: { working_directory: "/w", channel_id: "discord", description: "Reviews", instructions: "# Role", tags: ["a"] } } };
  const ctx: any = { webToken: token, webSessions: sessions, fleetConfig: structuredClone(before), logger: { error() {}, info() {}, warn() {}, debug() {} } };
  const s = createServer((req, res) => { handleWebRequest(req, res, new URL(req.url!, `http://${req.headers.host}`), ctx); });
  servers.push(s); s.listen(0, "127.0.0.1"); await once(s, "listening");
  const base = `http://127.0.0.1:${(s.address() as any).port}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + path, { method: "POST", body: JSON.stringify(body),
    headers: { "content-type": "application/json", cookie: `agend_session=${admin.sessionId}`, origin: base, "x-agend-csrf": csrfTokenFor(admin.sessionId), ...headers } });
  return { ctx, before, post, base };
}

it("build: the saved agent's file, without the excluded fields; parse: what a file would fill", async () => {
  const r = await rig();
  const built = await (await r.post("/ui/agent-export/build", { instance: "coder", include: ["identity", "instructions"] })).json();
  expect(built.text).toContain("agend_export: 1");
  expect(built.text).not.toContain("discord");
  const read = await (await r.post("/ui/agent-export/parse", { text: built.text })).json();
  expect(read).toMatchObject({ ok: true, fill: { description: "Reviews", instructions: "# Role", tags: ["a"] } });
  expect(r.ctx.fleetConfig).toEqual(r.before);
});

it("build: a secret withholds the text; bad requests and unknown agents are refused", async () => {
  const r = await rig();
  r.ctx.fleetConfig.instances.coder.instructions = "key sk-abcdefghijklmnopqrstuvwx";
  const blocked = await (await r.post("/ui/agent-export/build", { instance: "coder", include: ["instructions"] })).json();
  expect(blocked.text).toBeNull();
  expect(blocked.findings).toEqual([{ field: "instructions", line: 1, kind: "api_key" }]);
  expect(JSON.stringify(blocked)).not.toContain("abcdefghij");
  expect((await r.post("/ui/agent-export/build", { instance: "nobody", include: [] })).status).toBe(404);
  expect((await r.post("/ui/agent-export/build", { instance: "__proto__", include: [] })).status).toBe(404);
  expect((await r.post("/ui/agent-export/build", { instance: "constructor", include: [] })).status).toBe(404);
  expect((await r.post("/ui/agent-export/build", { instance: "coder", include: "all" })).status).toBe(400);
  expect((await r.post("/ui/agent-export/parse", [])).status).toBe(400);
  expect(await (await r.post("/ui/agent-export/parse", { text: 5 })).json()).toEqual({ ok: false, error: "empty" });
});

it("only the admin session may use them (no cookie, no CSRF, or a guest-tier session is refused)", async () => {
  const r = await rig();
  expect((await r.post("/ui/agent-export/parse", { text: "x" }, { cookie: "" })).status).toBeGreaterThanOrEqual(400);
  expect((await r.post("/ui/agent-export/parse", { text: "x" }, { "x-agend-csrf": "nope" })).status).toBeGreaterThanOrEqual(400);
});
