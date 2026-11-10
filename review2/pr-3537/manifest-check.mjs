// compares sha256 of every .js/.css the page fetched from the running server with the same path in the git commit
import { readFileSync } from "node:fs"; import { execFileSync } from "node:child_process"; import { createHash } from "node:crypto";
const G = "/home/junsionloh/multica_workspaces/agend-bcac6942356a/agend-144-ffe4cc7a7f14/workdir/AgEnD";
const sha = b => createHash("sha256").update(b).digest("hex");
const served = JSON.parse(readFileSync("served-sha.json", "utf8"));
const commit = { before: "1be11da9186914756d12fb021e8d8822cc70ab86", after: "8d37814a0219a7b0a1b58454a02dd9ba9cb55581" };
const show = (c, p) => { try { return execFileSync("git", ["-C", G, "show", `${c}:${p}`], { maxBuffer: 1 << 26 }); } catch { return null; } };
const rows = []; let match = { before: 0, after: 0 }, mism = [], nofile = [];
for (const [k, h] of Object.entries(served).sort()) {
  const [srv, path] = k.split("|"); const cands = path.startsWith("/ui/js/") ? [`src/ui/${path.slice(7)}`] : [`src/ui/shared/${path.slice(8)}`, `src/ui/${path.slice(8)}`];
  let b = null, used = null; for (const c of cands) { b = show(commit[srv], c); if (b) { used = c; break; } }
  if (!b) { nofile.push(`${srv} ${path}`); continue; }
  const g = sha(b); if (g === h) match[srv]++; else mism.push(`${srv} ${path} server=${h} git=${g}`);
  if (/cli-caps|runtime-cli-install|runtime-install\.css|app-i18n|panel-runtimes/.test(path)) rows.push(`| ${srv} | \`${path}\` | \`${used}\` | \`${h}\` | \`${g}\` | ${g === h ? "match" : "MISMATCH"} |`);
}
console.log(rows.join("\n")); console.log("\nmatch", JSON.stringify(match), "mismatch", mism.length, mism.join("\n"), "\nno git counterpart:", nofile.join(", "));
console.log("served counts", Object.keys(served).filter(k => k.startsWith("before|")).length, Object.keys(served).filter(k => k.startsWith("after|")).length);
const sk = JSON.parse(readFileSync("skew-state.json", "utf8"));
for (const s of sk) { const f = s.url.startsWith("/ui/js/") ? `src/ui/${s.url.slice(7)}` : `src/ui/shared/${s.url.slice(8)}`; console.log("skew", s.url, "old served", s.oldSha, "git before", sha(show(commit.before, f)), sha(show(commit.before, f)) === s.oldSha ? "match" : "MISMATCH"); }
