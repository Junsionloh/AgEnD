/**
 * #3731 phase 1 (web half): `cli_adapter` and `acp_always_approve` through Settings. The instance patch accepts them,
 * validates `cli_adapter` against the agent's effective backend (acp: grok / antigravity only), classes a change as an
 * agent restart (like `backend`), and clears the fields cleanly when the agent goes back to the terminal.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleSettingsRequest, type SettingsApiContext } from "../src/settings-api.js";
import { normalizeSettingsInstancePatch, removesInstanceOverride } from "../src/settings-instance-patch.js";
import { batchImpact, buildSettingsImpactSchema, classifyInstanceChange, instanceFieldImpact } from "../src/instance-config-impact.js";
import { settingsChangeDiff } from "../src/settings-change.js";
import { noteSettingsWrite } from "../src/settings-transaction.js";

describe("the instance patch", () => {
  it("takes cli_adapter and acp_always_approve as they come", () => {
    const next = normalizeSettingsInstancePatch({ working_directory: "/w", backend: "grok" }, { cli_adapter: "acp", acp_always_approve: true });
    expect(next).toMatchObject({ backend: "grok", cli_adapter: "acp", acp_always_approve: true });
  });
  it("null, tmux and approve-all off remove the keys instead of writing a default", () => {
    const base = { working_directory: "/w", backend: "grok", cli_adapter: "acp", acp_always_approve: true };
    for (const patch of [{ cli_adapter: null, acp_always_approve: null }, { cli_adapter: "tmux", acp_always_approve: false }]) {
      const next = normalizeSettingsInstancePatch(base, patch);
      expect(next).not.toHaveProperty("cli_adapter");
      expect(next).not.toHaveProperty("acp_always_approve");
      expect(next).toMatchObject({ working_directory: "/w", backend: "grok" });
    }
    expect(removesInstanceOverride("cli_adapter", "tmux")).toBe(true);
    expect(removesInstanceOverride("cli_adapter", "acp")).toBe(false);
    expect(removesInstanceOverride("acp_always_approve", false)).toBe(true);
    expect(removesInstanceOverride("acp_always_approve", true)).toBe(false);
  });
});

describe("what a change costs", () => {
  it("is an agent restart, like the backend — never hot", () => {
    expect(instanceFieldImpact("cli_adapter")).toBe("instance");
    expect(instanceFieldImpact("acp_always_approve")).toBe("instance");
    expect(instanceFieldImpact("backend")).toBe("instance");
    const schema = buildSettingsImpactSchema();
    expect(schema.impacts["instance.cli_adapter"]).toBe("instance");
    expect(schema.impacts["instance.acp_always_approve"]).toBe("instance");
    expect(batchImpact(["instance.cli_adapter", "instance.display_name"], k => schema.impacts[k]!)).toBe("instance");
    const running = { working_directory: "/w", backend: "grok" } as never;
    expect(classifyInstanceChange(running, { working_directory: "/w", backend: "grok", cli_adapter: "acp" } as never)).toBe("restart");
    expect(classifyInstanceChange({ working_directory: "/w", backend: "grok", cli_adapter: "acp" } as never, running)).toBe("restart");
    expect(classifyInstanceChange({ working_directory: "/w", backend: "grok", cli_adapter: "acp" } as never, { working_directory: "/w", backend: "grok", cli_adapter: "acp", acp_always_approve: true } as never)).toBe("restart");
  });
  const diff = (before: object, after: object) => settingsChangeDiff({ fleet: { instances: { w: before } } }, { fleet: { instances: { w: after } } }, { operation: "PATCH instances" });
  it("switching the mode applies without a second confirmation (it is confirmed in the page, like a backend change)", () => {
    expect(diff({ backend: "grok" }, { backend: "grok", cli_adapter: "acp" })).toBeNull();
    expect(diff({ backend: "grok", cli_adapter: "acp" }, { backend: "grok" })).toBeNull();
  });
  it("turning approve-all on waits for an admin; turning it off applies at once", () => {
    const on = diff({ backend: "grok", cli_adapter: "acp" }, { backend: "grok", cli_adapter: "acp", acp_always_approve: true });
    expect(on).not.toBeNull();
    expect(on!.section).toBe("access");
    expect(diff({ backend: "grok", cli_adapter: "acp", acp_always_approve: true }, { backend: "grok", cli_adapter: "acp" })).toBeNull();
    expect(diff({ backend: "grok", cli_adapter: "acp", acp_always_approve: true }, { backend: "grok", cli_adapter: "acp", acp_always_approve: false })).toBeNull();
  });
});

// ── The real handler ──

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function harness(instance: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), "agend-test-3731-")); roots.push(root);
  const path = join(root, "fleet.yaml");
  const config: any = { defaults: {}, instances: { worker: { working_directory: root, ...instance } } };
  writeFileSync(path, yaml.dump(config));
  const save = vi.fn(() => { noteSettingsWrite(path, yaml.load(readFileSync(path, "utf8")), config); writeFileSync(path, yaml.dump(config)); });
  const ctx = { fleetConfig: config, dataDir: root, configPath: path, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getRawFleetConfig: () => config, saveFleetConfig: save, lifecycle: { isPaused: () => false, pause: vi.fn(), wake: vi.fn() } } as unknown as SettingsApiContext;
  function patch(body: unknown): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
      const req = new EventEmitter() as any;
      req.method = "PATCH"; req.url = "/api/settings/fleet/instances/worker"; req.headers = {}; req.destroy = () => undefined;
      let status = 0;
      const res = { headersSent: false, destroyed: false, writeHead(code: number) { status = code; this.headersSent = true; }, setHeader: vi.fn(),
        end(text: string) { resolve({ status, body: JSON.parse(text) }); } } as any;
      try {
        expect(handleSettingsRequest(req, res, new URL(req.url, "http://localhost"), ctx)).toBe(true);
        queueMicrotask(() => { req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end"); });
      } catch (err) { reject(err); }
    });
  }
  const written = () => (yaml.load(readFileSync(path, "utf8")) as any).instances.worker;
  return { config, patch, save, written };
}

describe("PATCH /api/settings/fleet/instances/:name", () => {
  it("accepts acp for a grok agent and writes it", async () => {
    const h = harness({ backend: "grok" });
    const r = await h.patch({ cli_adapter: "acp" });
    expect(r.status).toBe(200);
    expect(h.save).toHaveBeenCalledOnce();
    expect(h.config.instances.worker.cli_adapter).toBe("acp");
    expect(h.written().cli_adapter).toBe("acp");
  });
  it("accepts acp together with a backend change to antigravity in one patch", async () => {
    const h = harness({ backend: "claude-code" });
    expect((await h.patch({ backend: "antigravity", cli_adapter: "acp" })).status).toBe(200);
    expect(h.config.instances.worker).toMatchObject({ backend: "antigravity", cli_adapter: "acp" });
  });
  it("refuses acp on claude-code, including the default backend, and writes nothing", async () => {
    for (const instance of [{ backend: "claude-code" }, {}]) {
      const h = harness(instance);
      const r = await h.patch({ cli_adapter: "acp" });
      expect(r.status).toBe(400);
      expect(JSON.stringify(r.body)).toMatch(/cli_adapter/);
      expect(h.save).not.toHaveBeenCalled();
      expect(h.config.instances.worker).not.toHaveProperty("cli_adapter");
    }
  });
  it("refuses a backend change that leaves an acp agent on a backend that cannot run it", async () => {
    const h = harness({ backend: "grok", cli_adapter: "acp" });
    const r = await h.patch({ backend: "codex" });
    expect(r.status).toBe(400);
    expect(h.config.instances.worker.backend).toBe("grok");
  });
  it("refuses an unknown mode", async () => {
    const h = harness({ backend: "grok" });
    expect((await h.patch({ cli_adapter: "ssh" })).status).toBe(400);
    expect(h.save).not.toHaveBeenCalled();
  });
  it("switching back to tmux (null or tmux) removes both fields from fleet.yaml", async () => {
    for (const body of [{ cli_adapter: null, acp_always_approve: null }, { cli_adapter: "tmux", acp_always_approve: false }]) {
      const h = harness({ backend: "grok", cli_adapter: "acp", acp_always_approve: true });
      const r = await h.patch(body);
      expect(r.status).toBe(200);
      expect(h.config.instances.worker).not.toHaveProperty("cli_adapter");
      expect(h.config.instances.worker).not.toHaveProperty("acp_always_approve");
      expect(h.written()).toEqual({ working_directory: h.config.instances.worker.working_directory, backend: "grok" });
    }
  });
});
