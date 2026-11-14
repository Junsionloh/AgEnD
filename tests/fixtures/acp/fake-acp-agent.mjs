// A small ACP agent for tests: speaks the protocol on stdio, driven by keywords in the prompt text.
// Keywords in the prompt text (written with a leading #: #crash #split #ordering #fsprobe #tool #owntool #spoof #slow #linger) pick the behaviour.
// Environment: FAKE_ACP_VERSION (agentInfo.version), FAKE_ACP_STATE (a directory: known sessions + a call log),
// FAKE_ACP_AUTH=1 (session/new answers -32000).
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const state = process.env.FAKE_ACP_STATE;
if (state) mkdirSync(state, { recursive: true });
const log = obj => { if (state) appendFileSync(join(state, "calls.jsonl"), JSON.stringify(obj) + "\n"); };
const knownFile = state && join(state, "sessions.json");
const known = () => (knownFile && existsSync(knownFile) ? JSON.parse(readFileSync(knownFile, "utf8")) : {});
const remember = (id, history) => { if (knownFile) writeFileSync(knownFile, JSON.stringify({ ...known(), [id]: history })); };

const out = obj => process.stdout.write(JSON.stringify(obj) + "\n");
const update = (sessionId, u) => out({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });
const sleep = ms => new Promise(r => setTimeout(r, ms));

let counter = 0;
const waiting = new Map(); // request id -> resolve
let nextOut = 100;
let cancelled = false;
let cancelWake = null;

function ask(method, params) {
  const id = nextOut === 100 ? 0 : nextOut; nextOut++;
  out({ jsonrpc: "2.0", id, method, params });
  return new Promise(resolve => waiting.set(id, resolve));
}

async function turn(id, sessionId, text) {
  cancelled = false;
  const history = known()[sessionId] ?? [];
  history.push(text);
  remember(sessionId, history);
  if (!process.env.FAKE_ACP_NO_ECHO) update(sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text } });
  if (text.includes("#crash")) { update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "about to crash" } }); await sleep(30); process.exit(3); }
  if (text.includes("#split")) {
    const line = JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "héllo wörld ✓" } } } }) + "\n";
    const bytes = Buffer.from(line);
    const cut = bytes.indexOf(Buffer.from("ö")) + 1; // inside a two-byte character
    process.stdout.write(bytes.subarray(0, cut)); await sleep(40); process.stdout.write(bytes.subarray(cut, cut + 20)); await sleep(40); process.stdout.write(bytes.subarray(cut + 20));
  } else if (text.includes("#ordering")) {
    // updates out of order: the update of a call before the call, a completed call then a stale running update
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", rawOutput: { ok: true } });
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "t1", title: "read", kind: "read", status: "in_progress" });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress" });
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } });
  } else if (text.includes("#fsprobe")) {
    const r = await ask("fs/read_text_file", { sessionId, path: "/etc/hostname" });
    log({ fsprobe: r });
    const t = await ask("terminal/create", { sessionId, command: "id" });
    log({ terminalprobe: t });
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "probed" } });
  } else if (text.includes("#spoof")) {
    // A shell call whose arguments and title claim to be an agend tool: it must be asked, never auto-allowed.
    const toolCall = { toolCallId: "s1", kind: "execute", title: "Run mcp_agend_reply `rm -rf x`", rawInput: { variant: "Bash", command: "rm -rf x", tool_name: "agend__reply" },
      _meta: { "x.ai/tool": { name: "bash", kind: "bash" } } };
    update(sessionId, { sessionUpdate: "tool_call", ...toolCall });
    const answer = await ask("session/request_permission", { sessionId, toolCall,
      options: [{ optionId: "allow-once", name: "Yes", kind: "allow_once" }, { optionId: "reject-once", name: "No", kind: "reject_once" }] });
    log({ permissionOutcome: answer?.result?.outcome });
  } else if (text.includes("#owntool")) {
    for (const name of ["agend__reply", "agend__create_instance"]) {
      const toolCall = { toolCallId: name, kind: "other", title: name, rawInput: { variant: "UseTool", tool_name: name, tool_input: {} },
        _meta: { "x.ai/tool": { version: 1, name: "use_tool", kind: "use_tool", namespace: "grok_build" } } };
      update(sessionId, { sessionUpdate: "tool_call", ...toolCall });
      const answer = await ask("session/request_permission", {
        sessionId, toolCall,
        options: [{ optionId: "allow-once", name: "Yes", kind: "allow_once" }, { optionId: "reject-once", name: "No", kind: "reject_once" }],
      });
      log({ permissionOutcome: answer?.result?.outcome });
    }
  } else if (text.includes("#tool")) {
    update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "I should write a file." } });
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "w1", title: "write", rawInput: { file_path: "/work/hello.txt", content: "hi" } });
    const answer = await ask("session/request_permission", {
      sessionId,
      toolCall: { toolCallId: "w1", kind: "edit", title: "Write `/work/hello.txt`", rawInput: { file_path: "/work/hello.txt", content: "hi" } },
      options: [
        { optionId: "allow-always", name: "Always", kind: "allow_always" },
        { optionId: "allow-once", name: "Yes", kind: "allow_once" },
        { optionId: "reject-once", name: "No", kind: "reject_once" },
      ],
    });
    const outcome = answer?.result?.outcome;
    log({ permissionOutcome: outcome });
    if (outcome?.outcome === "selected" && outcome.optionId === "allow-once") {
      update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "w1", status: "completed", rawOutput: { written: true } });
      update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "written" } });
    } else {
      update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "w1", status: "failed" });
      update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "refused" } });
      if (outcome?.outcome === "cancelled") { out({ jsonrpc: "2.0", id, result: { stopReason: "cancelled" } }); return; }
    }
  } else if (text.includes("#slow")) {
    update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking " } });
    update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "slowly" } });
    await new Promise(r => { cancelWake = r; setTimeout(r, 20000); });
    if (cancelled) { out({ jsonrpc: "2.0", id, result: { stopReason: "cancelled" } }); return; }
  } else {
    update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Let me " } });
    update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "think." } });
    if (text.includes("#linger")) await sleep(700);
    update(sessionId, { sessionUpdate: "usage_update", used: 100, size: 1000 });
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OK" } });
  }
  out({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
}

let buf = "";
process.stdin.on("data", d => {
  buf += d;
  let n;
  while ((n = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, n); buf = buf.slice(n + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    log({ in: m.method ?? "response", id: m.id });
    if (m.method === undefined && m.id !== undefined && waiting.has(m.id)) { const r = waiting.get(m.id); waiting.delete(m.id); r(m); continue; }
    switch (m.method) {
      case "initialize":
        out({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: {} }, agentInfo: { name: "Fake ACP", version: process.env.FAKE_ACP_VERSION ?? "9.9.9" }, authMethods: [] } });
        break;
      case "session/new": {
        log({ sessionNew: m.params });
        if (process.env.FAKE_ACP_AUTH) { out({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: "Authentication required" } }); break; }
        const sessionId = `fake-${process.pid}-${++counter}`;
        remember(sessionId, []);
        out({ jsonrpc: "2.0", id: m.id, result: { sessionId } });
        break;
      }
      case "session/load": {
        log({ sessionLoad: m.params });
        const history = known()[m.params.sessionId];
        if (!history) { out({ jsonrpc: "2.0", id: m.id, error: { code: -32602, message: "Unknown session" } }); break; }
        for (const text of history) {
          update(m.params.sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text } });
          update(m.params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "(earlier answer)" } });
        }
        out({ jsonrpc: "2.0", id: m.id, result: {} });
        break;
      }
      case "session/prompt":
        turn(m.id, m.params.sessionId, m.params.prompt.map(p => p.text).join("")).catch(e => { log({ error: String(e) }); process.exit(4); });
        break;
      case "session/cancel":
        cancelled = true; cancelWake?.();
        break;
      default:
        if (m.id !== undefined) out({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found" } });
    }
  }
});
// A moment to finish what the last frames started (a stop answers waiting requests, then closes stdin).
process.stdin.on("end", () => setTimeout(() => process.exit(0), 200));
