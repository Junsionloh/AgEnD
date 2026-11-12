// TUI crash + relaunch (the daemon's respawn) with the host and observer running throughout
import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync, existsSync } from "node:fs";
const D = process.env.AGEND_DIST; // the built repo: <repo>/dist (npm run build)
const { GrokBackend } = await import(`${D}/backend/grok.js`);
const { GrokLeaderHost } = await import(`${D}/backend/grok-leader-host.js`);
const { resolveBinary } = await import(`${D}/backend/types.js`);
const OUT = "/tmp/gl-e2e/e2e2.log"; writeFileSync(OUT, "");
const log = (k, o = {}) => appendFileSync(OUT, JSON.stringify({ t: new Date().toISOString(), k, ...o }) + "\n");
const tmux = (...a) => execFileSync("tmux", ["-L", "e2e", ...a], { encoding: "utf8" });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const instanceDir = "/tmp/gl-e2e/inst2"; execFileSync("mkdir", ["-p", instanceDir]);
const cwd = process.env.PROJ;
const backend = new GrokBackend(instanceDir);
let lastKey = "";
const host = new GrokLeaderHost({
  instanceName: "e2e2", instanceDir, cwd, binary: resolveBinary("grok"), backendOptions: { grok: { leader_observer: true } },
  sessionId: () => backend.getSessionId(),
  onChange: () => { const l = host.live(); const key = JSON.stringify(l && [l.turnOpen, l.permissionWaiting, l.tools.map(t => t.status)]); if (key !== lastKey) { lastKey = key; log("live", l ? { turnOpen: l.turnOpen, permissionWaiting: l.permissionWaiting, tools: l.tools.map(t => t.status + ":" + t.title.slice(0, 30)) } : null); } },
  log: (lvl, msg, extra) => log("host-" + lvl, { msg, ...extra }),
});
const socket = await host.prepare();
const launch = (resume) => {
  const cfg = { workingDirectory: cwd, instanceDir, instanceName: "e2e2", mcpServers: {}, skipPermissions: false, grokLeaderSocket: socket, skipResume: !resume };
  const cmd = backend.buildCommand(cfg) + " --effort low";
  log("launch", { resume, cmd: cmd.replace(socket, "<socket>").replace(/AGEND_GROK_MCP_DIR=\S+ AGEND_GROK_MCP_BINDING=\S* /, "") });
  try { tmux("kill-server"); } catch {}
  tmux("new-session", "-d", "-s", "t", "-x", "140", "-y", "40", "-c", cwd, cmd);
};
const ask = async (text, ms) => { tmux("send-keys", "-t", "t", "-l", text); await sleep(400); tmux("send-keys", "-t", "t", "Enter"); log("prompt-sent", { text: text.slice(0, 50) }); await sleep(ms); };
launch(false); host.begin();
for (let i = 0; i < 60 && !host.live(); i++) await sleep(500);
log("loaded", { live: !!host.live() });
await ask("Reply with just OK.", 9000);
const sid = backend.getSessionId(); writeFileSync(`${instanceDir}/session-id`, sid + "\n"); log("session", { sid: sid.slice(0, 8) + "…" });
const leaderPid = Number(execFileSync("cat", [socket.replace(/\.sock$/, ".lock")], { encoding: "utf8" }));
// crash the TUI: SIGKILL the grok TUI process (not the leader)
const tuiPid = execFileSync("sh", ["-c", `ps -eo pid,ppid,args | awk '$3 ~ /grok$/ && $4=="--no-auto-update" && $5=="--leader" {print $1}'`], { encoding: "utf8" }).trim();
log("crash", { tuiPid: Number(tuiPid), leaderPid }); execFileSync("kill", ["-9", tuiPid]);
await sleep(4000);
log("after-crash", { leaderAlive: (() => { try { process.kill(leaderPid, 0); return true; } catch { return false; } })(), observerLoaded: !!host.live() });
// the daemon's respawn: prepare() runs first (stops the leader left behind), then a new TUI resumes the session
const socket2 = await host.prepare();
log("respawn-prepare", { sameSocket: socket2 === socket, leaderStillAlive: (() => { try { process.kill(leaderPid, 0); return true; } catch { return false; } })() });
launch(true);
for (let i = 0; i < 40 && !host.live(); i++) await sleep(500);
log("re-attached", { live: !!host.live() });
await ask("Use your file edit tool to create e2e2-perm.txt containing the word hi, then reply with just DONE.", 13000);
const pane = tmux("capture-pane", "-p", "-t", "t");
log("pane", { permissionDialogInTui: /Allow Edit/.test(pane), observerSaysWaiting: host.live()?.permissionWaiting });
tmux("send-keys", "-t", "t", "Enter"); await sleep(8000);
log("done", { fileCreated: existsSync(cwd + "/e2e2-perm.txt"), observerWaiting: host.live()?.permissionWaiting, turnOpen: host.live()?.turnOpen });
try { tmux("kill-server"); } catch {}
await sleep(1000); await host.stop(); await sleep(500);
log("stopped", { socketExists: existsSync(socket) });
process.exit(0);
