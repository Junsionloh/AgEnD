// real end-to-end of the daemon-side pieces (host + backend.buildCommand + observer) against the real grok 1.0.77 and a tmux TUI
import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync, existsSync } from "node:fs";
const D = process.env.AGEND_DIST; // the built repo: <repo>/dist (npm run build)
const { GrokBackend } = await import(`${D}/backend/grok.js`);
const { GrokLeaderHost } = await import(`${D}/backend/grok-leader-host.js`);
const { resolveBinary } = await import(`${D}/backend/types.js`);
const OUT = "/tmp/gl-e2e/e2e.log";
writeFileSync(OUT, "");
const log = (k, o = {}) => appendFileSync(OUT, JSON.stringify({ t: new Date().toISOString(), k, ...o }) + "\n");
const tmux = (...a) => execFileSync("tmux", ["-L", "e2e", ...a], { encoding: "utf8" });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const instanceDir = "/tmp/gl-e2e/inst"; execFileSync("mkdir", ["-p", instanceDir]);
const cwd = process.env.PROJ;
const backend = new GrokBackend(instanceDir);
const opts = { grok: { leader_observer: true } };
let lastKey = "";
const host = new GrokLeaderHost({
  instanceName: "e2e", instanceDir, cwd, binary: resolveBinary("grok"), backendOptions: opts,
  sessionId: () => backend.getSessionId(),
  onChange: () => {
    const l = host.live(); if (!l) return;
    const key = JSON.stringify([l.turnOpen, l.thought, l.tools.map(t => t.status + ":" + t.title), l.replying, l.permissionWaiting]);
    if (key !== lastKey) { lastKey = key; log("live", { turnOpen: l.turnOpen, thought: l.thought.slice(0, 80), tools: l.tools.map(t => `${t.status}:${t.title.slice(0, 40)}`), replying: l.replying, permissionWaiting: l.permissionWaiting }); }
  },
  log: (lvl, msg, extra) => log("host-" + lvl, { msg, ...extra }),
});
const socket = await host.prepare();
log("prepared", { socket, len: socket ? Buffer.byteLength(socket) : null });
const cfg = { workingDirectory: cwd, instanceDir, instanceName: "e2e", mcpServers: {}, skipPermissions: false, grokLeaderSocket: socket, skipResume: true };
const cmd = "AGEND_PROBE_BINDING=e2e-launch-1 " + backend.buildCommand(cfg) + " --effort low";
log("command", { cmd: cmd.replace(socket, "<socket>") });
try { tmux("kill-server"); } catch {}
tmux("new-session", "-d", "-s", "t", "-x", "140", "-y", "40", "-c", cwd, cmd);
host.begin();
const t0 = Date.now();
while (!host.live() && Date.now() - t0 < 30000) await sleep(500);
log("observer-loaded", { afterMs: Date.now() - t0, live: !!host.live() });
async function ask(text, waitMs) { tmux("send-keys", "-t", "t", "-l", text); await sleep(400); tmux("send-keys", "-t", "t", "Enter"); log("prompt-sent", { text: text.slice(0, 60) }); await sleep(waitMs); }
await ask("Run the shell command 'sleep 5; echo e2e-a'. Then think briefly about what to do next, then use your file edit tool to create e2e-perm.txt containing the word hi, then reply with just OK.", 14000);
// the edit needs a permission: answer it in the TUI (the person's side), never from the observer
const pane = tmux("capture-pane", "-p", "-t", "t");
log("pane-permission", { seen: /Allow Edit/.test(pane) });
if (/Allow Edit/.test(pane)) { await sleep(3000); log("tui-answers-permission"); tmux("send-keys", "-t", "t", "Enter"); }
await sleep(12000);
log("turn-done-live", { live: host.live() && { turnOpen: host.live().turnOpen } });
const leaderPid = Number(execFileSync("cat", [socket.replace(/\.sock$/, ".lock")], { encoding: "utf8" }));
log("leader", { pid: leaderPid, env: execFileSync("sh", ["-c", `tr '\\0' '\\n' < /proc/${leaderPid}/environ | grep AGEND_PROBE`], { encoding: "utf8" }).trim() });
// instance stop: the TUI first (as the daemon does), then host.stop()
try { tmux("kill-server"); } catch {}
await sleep(1500);
const alive = () => { try { process.kill(leaderPid, 0); return true; } catch { return false; } };
log("after-tui-gone", { leaderAlive: alive() });
await host.stop();
await sleep(500);
log("after-host-stop", { leaderAlive: alive(), socketExists: existsSync(socket) });
process.exit(0);
