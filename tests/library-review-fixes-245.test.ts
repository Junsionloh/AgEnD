/** AGEND-245: the small fixes from the PR #79 review — the Claude Code MCP file when it cannot be made private, and what an error answer may echo. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsFault = vi.hoisted(() => ({ chmod: null as null | string, unlink: null as null | string, writes: [] as string[] }));
vi.mock("node:fs", async (orig) => {
  const real = await orig<typeof import("node:fs")>();
  const err = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });
  return {
    ...real,
    chmodSync: (path: string, mode: number) => { if (fsFault.chmod && String(path).endsWith("mcp-config.json")) throw err(fsFault.chmod); return real.chmodSync(path, mode); },
    unlinkSync: (path: string) => { if (fsFault.unlink && String(path).endsWith("mcp-config.json")) throw err(fsFault.unlink); return real.unlinkSync(path); },
    writeFileSync: ((path: any, data: any, opts?: any) => { if (String(path).endsWith("mcp-config.json")) fsFault.writes.push(String(data)); return real.writeFileSync(path, data, opts); }) as typeof real.writeFileSync,
  };
});

import { ClaudeCodeBackend } from "../src/backend/claude-code.js";
import { validateMcpText, echoableVarName } from "../src/library/schema.js";

describe("Claude Code mcp-config.json: when it cannot be made private nothing is written into it", () => {
  let root: string;
  const SECRET = "the-secret-value";
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "agend245-")); mkdirSync(join(root, "i"), { recursive: true }); fsFault.chmod = null; fsFault.unlink = null; fsFault.writes = []; });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });
  const cfg = () => ({ workingDirectory: join(root, "i"), instanceDir: join(root, "i"), instanceName: "w", mcpServers: {},
    libraryMcp: { "agend-lib-x": { transport: "stdio", command: "npx", args: [], env: { MCP_X: SECRET } } } }) as never;

  it("chmod fails and so does the removal: it stops, and the values are never written", () => {
    writeFileSync(join(root, "i", "mcp-config.json"), "old", { mode: 0o644 });
    fsFault.chmod = "EPERM"; fsFault.unlink = "EACCES";
    expect(() => new ClaudeCodeBackend(join(root, "i")).writeConfig(cfg())).toThrow(/could not be made private/);
    expect(fsFault.writes.some((w) => w.includes(SECRET))).toBe(false);
    expect(readFileSync(join(root, "i", "mcp-config.json"), "utf8")).toBe("old");
  });

  it("chmod fails but the old file can be removed: it is replaced by a new 0600 one, as before", () => {
    writeFileSync(join(root, "i", "mcp-config.json"), "old", { mode: 0o644 });
    fsFault.chmod = "EPERM";
    new ClaudeCodeBackend(join(root, "i")).writeConfig(cfg());
    expect(readFileSync(join(root, "i", "mcp-config.json"), "utf8")).toContain(SECRET);
  });

  it("chmod fails, and the file was already gone (ENOENT on the removal): it writes", () => {
    fsFault.chmod = "EPERM"; fsFault.unlink = "ENOENT";
    new ClaudeCodeBackend(join(root, "i")).writeConfig(cfg());
    expect(existsSync(join(root, "i", "mcp-config.json"))).toBe(true);
  });
});

describe("a variable name an error answer may echo", () => {
  it("only ^[A-Z][A-Z0-9_]{0,63}$ comes back; anything else, a pasted value included, is ?", () => {
    expect(echoableVarName("GH_TOKEN")).toBe("GH_TOKEN");
    expect(echoableVarName("A".repeat(64))).toBe("A".repeat(64));
    for (const bad of ["github_token", "Gh_Token", "A".repeat(65), "_X", "1X", "X-Y", "", 5, null, undefined, "ghp_abcdefghijklmnopqrstuvwxyz0123456789"]) expect(echoableVarName(bad), String(bad)).toBe("?");
  });

  it("validateMcpText says ? for a lowercase or mixed-case name, in env (list and map form) and in headers", () => {
    const stdio = (env: string) => `agend_library: 1\nkind: mcp\nname: x\ntransport: stdio\ncommand: npx\nenv:\n${env}`;
    expect(validateMcpText("x", stdio("  - github_token\n  - OTHER_TOKEN\n"))).toMatchObject({ ok: false, error: "mcp_var_prefix", names: ["?", "OTHER_TOKEN"] });
    expect(validateMcpText("x", stdio("  SERVER: ${Mixed_Case}\n"))).toMatchObject({ ok: false, error: "mcp_var_prefix", names: ["?"] });
    expect(validateMcpText("x", "agend_library: 1\nkind: mcp\nname: x\ntransport: http\nurl: https://a.example/\nheaders:\n  X-A: lower_case\n")).toMatchObject({ ok: false, error: "mcp_var_prefix", names: ["?"] });
  });
});
