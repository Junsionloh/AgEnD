/**
 * #3731: antigravity's ACP server validates every MCP tool schema with a Go (RE2) regex engine and refuses a tool whose
 * `pattern` uses JavaScript's `\uXXXX`. One such pattern made every turn of an agy instance fail with "building toolbox".
 */
import { describe, expect, it } from "vitest";
import { TOOLS, portablePattern } from "../src/channel/mcp-tools.js";

const patterns = (node: unknown, out: string[] = []): string[] => {
  if (Array.isArray(node)) node.forEach(n => patterns(n, out));
  else if (node && typeof node === "object") for (const [k, v] of Object.entries(node)) { if (k === "pattern" && typeof v === "string") out.push(v); else patterns(v, out); }
  return out;
};

describe("MCP tool schemas are acceptable to a Go regex engine", () => {
  it("no tool's pattern uses \\uXXXX, \\p{..} or lookaround", () => {
    const all = TOOLS.flatMap(t => patterns(t.inputSchema).map(p => `${t.name}: ${p}`));
    expect(all.length).toBeGreaterThan(0);
    expect(all.filter(p => /\\u[0-9a-fA-F]{4}|\\p\{|\(\?[=!<]/.test(p))).toEqual([]);
  });
  it("the rewritten pattern still means the same", () => {
    const before = /^[^\s\u0000-\u001f\u007f]+$/;
    const after = new RegExp(portablePattern("^[^\\s\\u0000-\\u001f\\u007f]+$"));
    for (const s of ["abc", "a b", "a\u0001", "a\u007f", "id-1_2", "", "é"]) expect(after.test(s)).toBe(before.test(s));
    expect(portablePattern("^[a-z]+$")).toBe("^[a-z]+$");
  });
});
