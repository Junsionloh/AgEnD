// Preview-only (AGEND-316): the demo agents dev-a and dev-b start out "working" and stay so for hours, so the board has cards whose
// agent is running (the moving light) without anyone having to send them a message first. Run after patch-mock.mjs. Not product code.
import { readFileSync, writeFileSync } from "node:fs";
const p = "/app/e2e/mock-servers/mock-claude.mjs";
let s = readFileSync(p, "utf8");
const marker = "// PREVIEW-BUSY-AT-START";
if (s.includes(marker)) { console.log("already patched"); process.exit(0); }
const anchor = "rl.on(\"line\"";
const at = s.indexOf(anchor);
if (at < 0 || !s.includes("function lookBusy()")) throw new Error("run patch-mock.mjs first (mock-claude layout changed)");
const block = `${marker}: these two begin busy and stay busy (a changing line in the pane), until a message makes them answer.
if (["dev-a", "dev-b"].includes(INSTANCE_NAME)) { process.env.MOCK_BUSY_S = "36000"; setTimeout(() => lookBusyFor(36000), 4000); }
`;
// lookBusy reads BUSY_S once: give it a version that takes the length.
s = s.replace("function lookBusy() {\n  clearInterval(busyTimer);\n  const t0 = Date.now();", "function lookBusyFor(limit) {\n  clearInterval(busyTimer);\n  const t0 = Date.now();");
s = s.replace("if (n >= BUSY_S) {", "if (n >= limit) {");
s = s.replace("rl.on(\"line\"", "function lookBusy() { lookBusyFor(BUSY_S); }\n" + block + "rl.on(\"line\"");
writeFileSync(p, s);
console.log("patched busy");
