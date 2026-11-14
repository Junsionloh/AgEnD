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
