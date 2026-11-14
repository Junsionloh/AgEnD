/**
 * #3731 phase 1 (web half): what the page is told about how each agent runs — `cli_adapter`, `pane_view` and
 * `acp_always_approve` in the status frame, `adapters` on /ui/backends — and the create-instance request's adapter
 * fields. Real FleetManager.getUiStatus and the real web handler on a scratch data dir; nothing forks.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFile: vi.fn(() => { throw new Error("a status read must not fork"); }),
  execFileSync: vi.fn(() => { throw new Error("a status read must not fork"); }),
  spawn: vi.fn(() => { throw new Error("a status read must not fork"); }),
  spawnSync: vi.fn(() => { throw new Error("a status read must not fork"); }),
}));

const { FleetManager } = await import("../src/fleet-manager.js");
const { adapterUiView } = await import("../src/adapters/ui-view.js");
const { bindAdapter } = await import("../src/adapters/registry.js");
const { createInstanceAdapterFields } = await import("../src/adapters/create-fields.js");
const { handleWebRequest } = await import("../src/web-api.js");
const { tmuxCapabilities } = await import("../src/adapters/tmux-adapter.js");

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A runner with an adapter bound that has (or has not) a pane. */
function boundRunner(paneView: boolean) {
  const runner = new EventEmitter() as any;
  bindAdapter({ id: paneView ? "tmux" : "acp", runner, capabilities: { ...tmuxCapabilities("grok"), paneView } } as never);
  return runner;
}

describe("adapterUiView", () => {
  it("an unset cli_adapter is tmux with a pane, and says nothing of approve-all", () => {
    expect(adapterUiView(undefined, {})).toEqual({ cli_adapter: "tmux", pane_view: true });
    expect(adapterUiView(undefined, undefined)).toEqual({ cli_adapter: "tmux", pane_view: true });
    expect(adapterUiView(undefined, { cli_adapter: "tmux", acp_always_approve: true })).toEqual({ cli_adapter: "tmux", pane_view: true });
  });
  it("acp without a running adapter has no pane and reports approve-all as a boolean", () => {
    expect(adapterUiView(undefined, { cli_adapter: "acp" })).toEqual({ cli_adapter: "acp", pane_view: false, acp_always_approve: false });
    expect(adapterUiView(undefined, { cli_adapter: "acp", acp_always_approve: true })).toEqual({ cli_adapter: "acp", pane_view: false, acp_always_approve: true });
  });
  it("a running instance answers with its bound adapter's capabilities", () => {
    expect(adapterUiView(boundRunner(false), { cli_adapter: "acp" }).pane_view).toBe(false);
    expect(adapterUiView(boundRunner(true), {}).pane_view).toBe(true);
    // An unbound runner is a tmux daemon: the configuration decides.
    expect(adapterUiView(new EventEmitter() as never, {}).pane_view).toBe(true);
  });
});

describe("getUiStatus", () => {
  it("every instance carries cli_adapter and pane_view; acp ones also acp_always_approve", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-3731-status-")); dirs.push(dir);
    const fm = new FleetManager(dir);
    fm.fleetConfig = { defaults: { backend: "claude-code" }, instances: {
      plain: { working_directory: dir },
      agy: { working_directory: dir, backend: "antigravity", cli_adapter: "acp" },
      grok: { working_directory: dir, backend: "grok", cli_adapter: "acp", acp_always_approve: true },
      pinned: { working_directory: dir, backend: "grok", cli_adapter: "tmux" },
    } } as never;
    fm.classicChannels = { getAll: () => [], getChannelIdByInstance: () => undefined, getBackendByInstance: () => "claude-code", getModel: () => undefined } as never;
    vi.spyOn(fm, "getInstanceStatus").mockReturnValue("running");
    const rows = new Map((fm.getUiStatus() as { instances: Array<Record<string, unknown>> }).instances.map(i => [i.name as string, i]));
    const pick = (n: string) => { const r = rows.get(n)!; return { cli_adapter: r.cli_adapter, pane_view: r.pane_view, ...("acp_always_approve" in r ? { acp_always_approve: r.acp_always_approve } : {}) }; };
    expect(pick("plain")).toEqual({ cli_adapter: "tmux", pane_view: true });
    expect(pick("pinned")).toEqual({ cli_adapter: "tmux", pane_view: true });
    expect(pick("agy")).toEqual({ cli_adapter: "acp", pane_view: false, acp_always_approve: false });
    expect(pick("grok")).toEqual({ cli_adapter: "acp", pane_view: false, acp_always_approve: true });
  });
  it("a ClassicBot room is a terminal agent", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-3731-classic-")); dirs.push(dir);
    const fm = new FleetManager(dir);
    fm.fleetConfig = { defaults: {}, instances: {} } as never;
    fm.classicChannels = { getAll: () => [{ instanceName: "room-1", channelId: "c1", name: "Room" }], getChannelIdByInstance: () => undefined, getBackendByInstance: () => "claude-code", getModel: () => undefined } as never;
    vi.spyOn(fm, "getInstanceStatus").mockReturnValue("running");
    const [room] = (fm.getUiStatus() as { instances: Array<Record<string, unknown>> }).instances;
    expect(room).toMatchObject({ name: "room-1", cli_adapter: "tmux", pane_view: true });
  });
});

function call(method: string, path: string, ctx: Record<string, unknown>, body?: unknown) {
  const token = "c".repeat(48);
  const req = Object.assign(new EventEmitter(), { method, url: path, headers: { host: "127.0.0.1:19280", "x-agend-token": token, "content-type": "application/json" }, socket: { remoteAddress: "127.0.0.1", destroy() {} } });
  let status = 0, text = "";
  const done = new Promise<void>(resolve => {
    const res = Object.assign(new EventEmitter(), { headersSent: false, setHeader() {}, getHeader() { return undefined; }, writeHead(c: number) { status = c; }, end(t = "") { text = String(t); resolve(); }, write() { return true; } });
    handleWebRequest(req as never, res as never, new URL(path, "http://127.0.0.1:19280"), { webToken: token, logger: { info() {}, debug() {}, error() {}, warn() {} }, ...ctx } as never);
    if (body !== undefined) queueMicrotask(() => { req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end"); });
  });
  return done.then(() => ({ status, json: JSON.parse(text || "null") }));
}

describe("GET /ui/backends", () => {
  const rows = [{ backend: "claude-code", state: "usable", path: "/bin/claude", minVersion: null }, { backend: "grok", state: "usable", path: "/bin/grok", minVersion: null },
    { backend: "antigravity", state: "usable", path: "/bin/agy", minVersion: null }, { backend: "codex", state: "usable", path: "/bin/codex", minVersion: null }];
  it("lists the adapters each backend may run: acp only for grok and antigravity, tmux for all", async () => {
    const r = await call("GET", "/ui/backends", { fleetConfig: { instances: {} }, backendAvailabilityRows: () => rows });
    const byName = Object.fromEntries(r.json.backends.map((b: { name: string; adapters: string[] }) => [b.name, b.adapters]));
    expect(byName).toEqual({ "claude-code": ["tmux"], codex: ["tmux"], grok: ["tmux", "acp"], antigravity: ["tmux", "acp"] });
  });
  it("the probe fallback names them too", async () => {
    const r = await call("GET", "/ui/backends", { fleetConfig: { instances: {} } });
    const grok = r.json.backends.find((b: { name: string }) => b.name === "grok");
    expect(grok.adapters).toEqual(["tmux", "acp"]);
    expect(r.json.backends.find((b: { name: string }) => b.name === "muse").adapters).toEqual(["tmux"]);
  });
});

describe("createInstanceAdapterFields", () => {
  it("passes a request that names neither field through untouched", () => {
    const args = { directory: "/w", backend: "claude-code" };
    expect(createInstanceAdapterFields(args, undefined)).toEqual({ ok: true, args });
  });
  it("accepts acp for grok and antigravity, from the request's backend or the fleet default", () => {
    expect(createInstanceAdapterFields({ backend: "grok", cli_adapter: "acp" }, undefined)).toEqual({ ok: true, args: { backend: "grok", cli_adapter: "acp" } });
    expect(createInstanceAdapterFields({ backend: "antigravity", cli_adapter: "acp", acp_always_approve: true }, "codex"))
      .toEqual({ ok: true, args: { backend: "antigravity", cli_adapter: "acp", acp_always_approve: true } });
    expect(createInstanceAdapterFields({ cli_adapter: "acp" }, "grok")).toEqual({ ok: true, args: { cli_adapter: "acp" } });
  });
  it("refuses acp on any other backend, including the implicit claude-code", () => {
    for (const [args, def] of [[{ backend: "claude-code", cli_adapter: "acp" }, undefined], [{ cli_adapter: "acp" }, undefined], [{ backend: "codex", cli_adapter: "acp" }, "grok"]] as const) {
      const r = createInstanceAdapterFields({ ...args }, def);
      expect(r.ok).toBe(false);
      expect((r as { error: string }).error).toMatch(/cli_adapter.*not supported yet/);
    }
  });
  it("refuses an unknown value, a non-boolean approve-all, and approve-all without acp", () => {
    expect(createInstanceAdapterFields({ backend: "grok", cli_adapter: "ssh" }, undefined).ok).toBe(false);
    expect(createInstanceAdapterFields({ backend: "grok", cli_adapter: "acp", acp_always_approve: "yes" }, undefined)).toEqual({ ok: false, error: "acp_always_approve must be a boolean" });
    expect(createInstanceAdapterFields({ backend: "grok", acp_always_approve: true }, undefined).ok).toBe(false);
  });
  it("writes nothing for the defaults: tmux and approve-all off are dropped", () => {
    expect(createInstanceAdapterFields({ backend: "grok", cli_adapter: "tmux", acp_always_approve: false }, undefined)).toEqual({ ok: true, args: { backend: "grok" } });
    expect(createInstanceAdapterFields({ backend: "grok", cli_adapter: "acp", acp_always_approve: false }, undefined)).toEqual({ ok: true, args: { backend: "grok", cli_adapter: "acp" } });
  });
});

describe("POST /ui/instances", () => {
  const ctx = (handleCreate: ReturnType<typeof vi.fn>) => ({
    fleetConfig: { defaults: {}, instances: {} }, lifecycle: { handleCreate }, emitSseEvent() {}, getUiStatus: () => ({}),
  });
  it("hands the adapter fields to the lifecycle for grok", async () => {
    const handleCreate = vi.fn(async (_args: unknown, respond: (r: unknown) => void) => respond({ success: true, name: "g" }));
    const r = await call("POST", "/ui/instances", ctx(handleCreate), { topic_name: "g", backend: "grok", cli_adapter: "acp", acp_always_approve: true });
    expect(r.status).toBe(200);
    expect(handleCreate.mock.calls[0]![0]).toMatchObject({ topic_name: "g", backend: "grok", cli_adapter: "acp", acp_always_approve: true });
  });
  it("refuses acp on claude-code with a 400 and never calls the lifecycle", async () => {
    const handleCreate = vi.fn();
    const r = await call("POST", "/ui/instances", ctx(handleCreate), { topic_name: "c", backend: "claude-code", cli_adapter: "acp" });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/cli_adapter/);
    expect(handleCreate).not.toHaveBeenCalled();
  });
});
