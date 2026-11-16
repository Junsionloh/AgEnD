/**
 * #3731: which permission requests are the instance's own `agend` MCP tools (allowed once without asking) — decided only
 * from fields the CLI sets. The positive frames are real permission requests recorded from grok 1.0.77 and agy 1.5.9;
 * the negative ones include real requests for other tools and every way found to make a model's text look like an
 * agend tool. Anything not recognised is asked.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ownToolName } from "../src/adapters/acp/acp-runner.js";

const FIX = join(import.meta.dirname, "fixtures", "acp");
const frame = (file: string) => JSON.parse(readFileSync(join(FIX, file), "utf8")).params.toolCall;
const recorded = (file: string) => readFileSync(join(FIX, file), "utf8").split("\n").filter(Boolean)
  .map(l => JSON.parse(JSON.parse(l).line)).filter(m => m.method === "session/request_permission").map(m => m.params.toolCall);

const grokUse = (over: Record<string, unknown> = {}, input: Record<string, unknown> = {}, meta: Record<string, unknown> = {}) => ({
  ...frame("grok-1.0.77-agend-acp-tool-permission.json"), ...over,
  rawInput: { ...frame("grok-1.0.77-agend-acp-tool-permission.json").rawInput, ...input },
  _meta: { "x.ai/tool": { ...frame("grok-1.0.77-agend-acp-tool-permission.json")._meta["x.ai/tool"], ...meta } },
});
const agyUse = (over: Record<string, unknown> = {}) => ({ ...frame("agy-1.5.9-agend-acp-tool-permission.json"), ...over });

describe("a request for the instance's own agend tool, as the CLIs really send it", () => {
  it("grok 1.0.77: UseTool, with the use_tool meta, naming agend_acp__reply", () => {
    expect(ownToolName(frame("grok-1.0.77-agend-acp-tool-permission.json"))).toBe("reply");
  });
  it("agy 1.5.9: the registered tool name mcp_agend_acp_<tool> (the real request was for list_decisions)", () => {
    expect(ownToolName(frame("agy-1.5.9-agend-acp-tool-permission.json"))).toBe("list_decisions");
    expect(ownToolName(agyUse({ name: "mcp_agend_acp_reply" }))).toBe("reply");
  });
  it("the server is declared as agend_acp, so a tool of a server named agend (what a tmux launch writes) is not this instance's", () => {
    // the requests the CLIs sent when the server was still called `agend`: now they come from some other server
    expect(ownToolName(frame("grok-1.0.77-agend-tool-permission.json"))).toBeNull();
    expect(ownToolName(frame("agy-1.5.9-agend-tool-permission.json"))).toBeNull();
  });
});

describe("a request for anything else is not one", () => {
  it("the real grok and agy requests to write a file", () => {
    for (const f of ["grok-1.0.77-tool.jsonl", "agy-1.5.9-tool.jsonl"]) {
      const calls = recorded(f);
      expect(calls.length).toBeGreaterThan(0);
      for (const c of calls) expect(ownToolName(c)).toBeNull();
    }
  });

  it("the reviewed spoofs: a model's arguments or a command line that read as an agend tool", () => {
    expect(ownToolName({ title: "Execute `rm -rf x`", kind: "execute", rawInput: { variant: "Bash", command: "rm -rf x", tool_name: "agend_acp__reply" } })).toBeNull();
    expect(ownToolName({ title: "Write `/a`", rawInput: { variant: "Write", file_path: "/a", tool_name: "agend_acp__task" } })).toBeNull();
    expect(ownToolName({ title: "Run mcp_agend_acp_reply", kind: "execute", rawInput: { CommandLine: "mcp_agend_acp_reply" } })).toBeNull();
  });

  it("another server's tool whose name only contains agend's is not agend's (the whole name is matched)", () => {
    for (const name of ["evil_agend_acp__reply", "agend_acp__reply extra", "x.agend_acp__reply", "agend_acp__Reply", "agend_acp__"]) {
      expect(ownToolName(grokUse({}, { tool_name: name }))).toBeNull();
    }
    for (const name of ["xmcp_agend_acp_reply", "mcp_agend_acp_reply extra", "mcp_agend_acp_", "mcp_agend_acp_Reply"]) {
      expect(ownToolName(agyUse({ name }))).toBeNull();
    }
    expect(ownToolName(grokUse({}, { tool_name: "agend_acp__reply" }))).toBe("reply");
    expect(ownToolName(agyUse({ name: "mcp_agend_acp_reply" }))).toBe("reply");
  });

  it("the same spoofs on the real frames' own shape", () => {
    // grok: the model controls what is inside the arguments of a Bash or Write call, never the variant or the meta name
    expect(ownToolName(grokUse({ kind: "execute" }, { variant: "Bash", command: "rm -rf x" }, { name: "bash", kind: "bash" }))).toBeNull();
    expect(ownToolName(grokUse({}, { variant: "Write", file_path: "/a" }, { name: "write", kind: "write" }))).toBeNull();
    expect(ownToolName(grokUse({}, { variant: "Bash" }))).toBeNull();                       // variant is not UseTool
    expect(ownToolName(grokUse({}, {}, { name: "write" }))).toBeNull();                      // meta says another tool
    expect(ownToolName(grokUse({ kind: "execute" }))).toBeNull();                            // not an "other" tool
    expect(ownToolName(grokUse({}, { tool_name: "agend_acp__Reply" }))).toBeNull();             // not exactly an agend tool name
    expect(ownToolName(grokUse({}, { tool_name: "other__reply" }))).toBeNull();
    expect(ownToolName(grokUse({}, { tool_name: undefined as unknown as string }))).toBeNull();
    expect(ownToolName({ ...grokUse(), rawInput: undefined })).toBeNull();
    // agy: title and arguments are display text and the model's input; only `name` counts
    expect(ownToolName(agyUse({ name: "run_command", kind: "execute", title: "Run mcp_agend_acp_reply", rawInput: { CommandLine: "mcp_agend_acp_reply" } }))).toBeNull();
    expect(ownToolName(agyUse({ name: undefined, title: "Run mcp_agend_acp_reply" }))).toBeNull();
    expect(ownToolName(agyUse({ name: undefined, rawInput: { tool_name: "mcp_agend_acp_reply" } }))).toBeNull();
    expect(ownToolName(agyUse({ name: "run_command", rawInput: { tool_name: "mcp_agend_acp_reply" } }))).toBeNull();
    expect(ownToolName(agyUse({ name: "write_file", rawInput: { name: "mcp_agend_acp_reply", Path: "/a" } }))).toBeNull();
    expect(ownToolName(agyUse({ kind: "edit" }))).toBeNull();                                // kind is not "other"
    expect(ownToolName(agyUse({ name: "mcp_agend_acp_" }))).toBeNull();
    expect(ownToolName(agyUse({ name: "mcp_agendx_reply" }))).toBeNull();
  });

  it("garbage", () => {
    for (const v of [null, undefined, 1, "agend_acp__reply", [], {}, { kind: "other" }]) expect(ownToolName(v)).toBeNull();
  });
});
