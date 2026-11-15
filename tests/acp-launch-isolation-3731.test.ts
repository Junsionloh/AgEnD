/**
 * #3731: the `agend` MCP server an ACP instance declares in `session/new` carries that instance's own identity and socket,
 * so two ACP instances on one host never reach each other's fleet connection.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildAcpLaunch } from "../src/adapters/acp/launch.js";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
const launch = (name: string, extra: Record<string, unknown> = {}) => {
  const root = mkdtempSync(join(tmpdir(), "acp-launch-")); dirs.push(root);
  const instanceDir = join(root, "instances", name); mkdirSync(instanceDir, { recursive: true });
  const config = { working_directory: root, backend: "grok", ...extra } as never;
  return { root, instanceDir, parts: buildAcpLaunch({ name, config, instanceDir, runtimeIdentity: { kind: "fleet-topic", backend: "grok", model: "m" } }, "/dist/channel/mcp-server.js") };
};
const env = (parts: ReturnType<typeof buildAcpLaunch>) => Object.fromEntries(parts.mcpServers[0]!.env.map(e => [e.name, e.value]));

describe("the agend MCP server of an ACP instance", () => {
  it("is declared once, with the instance's own name and its own socket in its instance directory", () => {
    const a = launch("alpha"), b = launch("beta");
    expect(a.parts.mcpServers).toHaveLength(1);
    expect(env(a.parts).AGEND_INSTANCE_NAME).toBe("alpha");
    expect(env(b.parts).AGEND_INSTANCE_NAME).toBe("beta");
    expect(env(a.parts).AGEND_SOCKET_PATH).toBe(join(a.instanceDir, "channel.sock"));
    expect(env(b.parts).AGEND_SOCKET_PATH).toBe(join(b.instanceDir, "channel.sock"));
    expect(env(a.parts).AGEND_SOCKET_PATH).not.toBe(env(b.parts).AGEND_SOCKET_PATH);
  });

  it("runs on the Node that runs the fleet, not a `node` found on PATH", () => {
    expect(launch("alpha").parts.mcpServers[0]!.command).toBe(process.execPath);
  });
});

describe("the lifecycle hands skipPermissions to the ACP adapter, which starts the CLI with its flag or without it", () => {
  const adapterFor = async (backendName: string, config: Record<string, unknown>) => {
    const { InstanceLifecycle } = await import("../src/instance-lifecycle.js");
    const root = mkdtempSync(join(tmpdir(), "acp-lifecycle-")); dirs.push(root);
    const lc = new InstanceLifecycle({ logger: { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } } } as never) as unknown as {
      buildAcpAdapter(p: Record<string, unknown>): { opts: { skipPermissions?: boolean } };
    };
    return lc.buildAcpAdapter({ name: "w", config: { working_directory: root, backend: backendName, cli_adapter: "acp", ...config }, instanceDir: root, topicMode: true, backendName,
      resolvedBinary: "/bin/x", capActiveDecisions: (r: unknown[]) => r, selectRelevantDecisions: (r: unknown[]) => r });
  };
  it("unset or true: the flag; false: none", async () => {
    for (const backend of ["grok", "antigravity"]) {
      expect((await adapterFor(backend, {})).opts.skipPermissions).toBe(true);
      expect((await adapterFor(backend, { skipPermissions: true })).opts.skipPermissions).toBe(true);
      expect((await adapterFor(backend, { skipPermissions: false })).opts.skipPermissions).toBe(false);
    }
  });
});
