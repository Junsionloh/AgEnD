// Plays back a recorded (redacted) ACP wire capture. `out` records are what the client sent: the agent waits for
// one line from stdin for each (and checks the method name). `in` records are what the agent sent: written as
// recorded, optionally in pieces of REPLAY_CHUNK bytes so line framing is exercised on real traffic.
import { readFileSync } from "node:fs";

const records = readFileSync(process.argv[2], "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
const chunk = Number(process.env.REPLAY_CHUNK ?? 0);
let buf = "";
const lines = [];
let waiter = null;
process.stdin.on("data", d => {
  buf += d;
  let n;
  while ((n = buf.indexOf("\n")) >= 0) { lines.push(buf.slice(0, n)); buf = buf.slice(n + 1); }
  waiter?.();
});
process.stdin.on("end", () => process.exit(0));
const nextLine = async () => { while (!lines.length) await new Promise(r => { waiter = r; }); return lines.shift(); };
const write = async s => {
  const bytes = Buffer.from(s + "\n");
  if (!chunk) { process.stdout.write(bytes); return; }
  for (let i = 0; i < bytes.length; i += chunk) { process.stdout.write(bytes.subarray(i, i + chunk)); await new Promise(r => setImmediate(r)); }
};
for (const rec of records) {
  if (rec.dir === "in") { await write(rec.line); continue; }
  const sent = JSON.parse(await nextLine());
  const want = JSON.parse(rec.line);
  if (want.method && sent.method !== want.method) { console.error(`replay: expected ${want.method}, got ${sent.method}`); process.exit(9); }
}
// stay alive until the client closes stdin
setInterval(() => {}, 1000);
