// spike observer: ACP client over `grok agent --leader stdio`; read-only, never answers any agent->client request.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
const [,, sock, sid, cwd, out] = process.argv;
const log = (kind, obj) => appendFileSync(out, JSON.stringify({ t: new Date().toISOString(), kind, ...obj }) + "\n");
const child = spawn("grok", ["agent", "--leader", "--leader-socket", sock, "stdio"], { stdio: ["pipe", "pipe", "pipe"], cwd });
log("spawn", { pid: child.pid });
child.stderr.on("data", d => log("stderr", { text: String(d).slice(0, 500) }));
child.on("exit", (c, s) => log("exit", { code: c, signal: s }));
const send = (m) => { log("tx", { m }); child.stdin.write(JSON.stringify(m) + "\n"); };
createInterface({ input: child.stdout }).on("line", line => {
  let m; try { m = JSON.parse(line); } catch { return log("rx-raw", { line: line.slice(0, 300) }); }
  log("rx", { m });
  if (m.id === 1 && m.method === undefined) send({ jsonrpc: "2.0", id: 2, method: "session/load", params: { sessionId: sid, cwd, mcpServers: [] } });
  // agent->client requests (id + method): deliberately NOT answered
});
send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "agend-spike-observer", version: "0" } } });
process.on("SIGTERM", () => { child.kill(); process.exit(0); });
