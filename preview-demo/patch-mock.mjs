// Preview-only: the demo agents answer a board notice / chat message by quoting what they were told (once per burst of lines),
// then look busy for a while (pane output that changes), so the board's "Running" mark and a card's Agent activity can be tried.
// Not part of the repository.
import { readFileSync, writeFileSync } from "node:fs";
const p = "/app/e2e/mock-servers/mock-claude.mjs";
let s = readFileSync(p, "utf8");
const start = s.indexOf('rl.on("line"');
const marker = "// PREVIEW-ECHO";
const from = s.includes(marker) ? s.indexOf(marker) : start;
const end = s.indexOf("// ---------------------------------------------------------------------------\n// 5.");
if (from < 0 || end < 0) throw new Error("mock-claude layout changed");
const block = `${marker}: collect a burst of lines, quote it back once, then look busy (a changing line in the pane) for BUSY_S seconds.
const BUSY_S = parseInt(process.env.MOCK_BUSY_S ?? "40", 10) || 40;
let burst = [], burstTimer = null, busyTimer = null;
function lookBusy() {
  clearInterval(busyTimer);
  const t0 = Date.now();
  busyTimer = setInterval(() => {
    const n = Math.round((Date.now() - t0) / 1000);
    if (n >= BUSY_S) { clearInterval(busyTimer); process.stdout.write("\\n"); return; }
    process.stdout.write(\`\\r✻ Working… (\${n}s · esc to interrupt)\`);
  }, 1000);
}
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  process.stderr.write(\`mock-claude: received input: \${trimmed.slice(0, 100)}\\n\`);
  burst.push(trimmed);
  clearTimeout(burstTimer);
  burstTimer = setTimeout(() => {
    const said = burst.join("\\n"); burst = [];
    lookBusy();
    callReplyTool(\`(demo agent) I was told:\\n\${said.slice(0, 1500)}\${said.length > 1500 ? "\\n…" : ""}\`);
  }, 1500);
});

`;
s = s.slice(0, from) + block + s.slice(end);
writeFileSync(p, s);
console.log("patched");
