// Merges the per-combo raw receipts into receipt.json and checks, file by file, that what each instance served is the committed source of its commit. node finalize.mjs <shotsDir> <headRepo> <baseRepo>
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
const [dir, headRepo, baseRepo] = process.argv.slice(2);
const git = (repo, ...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "buffer", maxBuffer: 64 << 20 });
const text = (repo, ...a) => git(repo, ...a).toString("utf8").trim();
const raws = readdirSync(dir).filter((f) => /^receipt-raw-.*\.json$/.test(f)).sort().map((f) => JSON.parse(readFileSync(`${dir}/${f}`, "utf8")));
const images = raws.flatMap((r) => r.images).sort((a, b) => a.file.localeCompare(b.file));
const sides = { before: { repo: baseRepo, label: "upstream base of the PR (merge-base with release/2.3.5-alpha at review time)" }, after: { repo: headRepo, label: "PR #3725 head" } };
for (const [side, s] of Object.entries(sides)) {
  s.commit = text(s.repo, "rev-parse", "HEAD");
  s.statusPorcelain = text(s.repo, "status", "--porcelain", "--untracked-files=normal");
  s.provenance = JSON.parse(readFileSync(`${s.repo}/dist/build-provenance.json`, "utf8"));
  const tree = text(s.repo, "ls-tree", "-r", "--name-only", "HEAD", "src/ui").split("\n");
  const served = {}; for (const r of raws) Object.assign(served, r.served?.[side] ?? {});
  const files = {}; let match = 0, mismatch = 0, unmapped = 0;
  for (const [path, v] of Object.entries(served).sort()) {
    const base = path.split("/").pop();
    const cands = tree.filter((f) => f.split("/").pop() === base);
    let verdict = "unmapped", source = null;
    if (cands.length >= 1) {
      const hit = cands.find((f) => createHash("sha256").update(git(s.repo, "show", `HEAD:${f}`)).digest("hex") === v.sha256);
      source = hit ?? cands[0]; verdict = hit ? "match" : "mismatch";
    }
    if (verdict === "match") match++; else if (verdict === "mismatch") mismatch++; else unmapped++;
    files[path] = { sha256: v.sha256, bytes: v.bytes, committedAs: source, vsCommit: verdict };
  }
  s.servedResources = { total: Object.keys(files).length, matchCommittedSource: match, mismatch, unmapped, files };
}
const receipt = {
  issue: "AGEND-234", purpose: "Re-capture of the 8 after-screenshots of upstream PR #3725 from a clean build of its head, with the source/served-byte binding the first capture lacked (Prism review item 4).",
  capturedAt: raws[0].capturedAt, node: process.version,
  build: "git worktree at the commit (detached), `npm ci`, `npm run build` (tsc + postbuild, which stamps dist/build-provenance.json); `git status --porcelain --untracked-files=normal` empty before and after the build",
  run: "cap/instance.sh start <side> <repo> <port> (own AGEND_HOME and HOME, env -i, PATH = cap/bin fakes + node + system bins; fleet.yaml with no instances; no real credentials; never :8445 / :19280), then cap/capture.mjs",
  fakeClis: "cap/bin/claude and cap/bin/grok: logged out; `claude auth login` replays the real 2.1.286 OAuth-URL pane, `grok login` the real 1.0.77 device-code pane (both from tests/fixtures); nothing reaches a provider",
  sides, images,
  notes: [
    "Scene (a) hides the Codex/Kiro/other cards with an inline display:none (only the two this change is about stay); the badge crop beside each shot is the page's own header badge from the same page load.",
    "Scene (a) is shot at a 2600px-tall viewport so the page's fixed bars do not cover the cards; (b) and (c) are plain viewport shots.",
    "Scene (b) is opened with the page's own openSignIn (the page itself disables a backend's Connect while that backend is connecting, which is the point of the change).",
    "Before-side refusal text is the server's sentence (it follows the host's language, here zh-TW, not the page's); the after side words it in the page's language.",
    "The 'before' instance is the PR's merge-base (944535da9), not the current tip of release/2.3.5-alpha, so the diff shown is exactly this PR.",
  ],
};
writeFileSync(`${dir}/receipt.json`, JSON.stringify(receipt, null, 1) + "\n");
for (const side of ["before", "after"]) { const s = sides[side].servedResources; console.log(side, sides[side].commit.slice(0, 12), "modified:", sides[side].provenance.modified, "status:", JSON.stringify(sides[side].statusPorcelain), `served ${s.total}: match ${s.matchCommittedSource}, mismatch ${s.mismatch}, unmapped ${s.unmapped}`); }
const bad = images.filter((i) => !i.badge.includes(sides[i.side].commit.slice(0, 12)) || /modified|含未提交|unknown|不明/.test(i.badge));
console.log("images", images.length, "badge not equal to its side's commit or flagged:", bad.length);
console.log("a:", images.filter((i) => i.scene === "a").map((i) => `${i.side}:${i.grokConnectDisabled ? "disabled" : "enabled"}`).join(" "));
