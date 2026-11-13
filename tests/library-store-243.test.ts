/** AGEND-243: the library's storage layer — formats, limits, path safety, lock, and that nothing outside library/ is touched. */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LibraryStore, LIBRARY_LIMITS, isSafeSkillPath, validateMcpText, validateSkill } from "../src/library/index.js";
import { fake } from "./helpers/fake-secrets-163.js";

const homes: string[] = [];
const home = () => { const h = mkdtempSync(join(tmpdir(), "agend-lib-")); homes.push(h); return h; };
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });

const md = (id: string, extra = "") => `---\nname: ${id}\ndescription: Does ${id} things\n${extra}---\n\n# ${id}\nSteps.\n`;
const skill = (id: string, more: Array<{ path: string; content: string }> = []) => [{ path: "SKILL.md", content: md(id) }, ...more];
const MCP = (name: string, rest: string) => `agend_library: 1\nkind: mcp\nname: ${name}\n${rest}`;

describe("a fleet that never uses the library", () => {
  it("has an empty list and no library folder is created by reading", () => {
    const h = home(); const s = new LibraryStore(h);
    expect(s.list()).toEqual([]);
    expect(s.get("skill", "nope")).toMatchObject({ ok: false, error: "not_found" });
    expect(existsSync(join(h, "library"))).toBe(false);
    expect(readdirSync(h)).toEqual([]);
  });
});

describe("skills", () => {
  it("stores SKILL.md with supporting files, lists it, reads it back and records hash + source in the lock", () => {
    const h = home(); const s = new LibraryStore(h);
    const r = s.addSkill("review", skill("review", [{ path: "references/checklist.md", content: "- a\n" }]));
    expect(r).toMatchObject({ ok: true });
    expect(readFileSync(join(h, "library/skills/review/SKILL.md"), "utf8")).toBe(md("review"));
    expect(readFileSync(join(h, "library/skills/review/references/checklist.md"), "utf8")).toBe("- a\n");
    const [item] = s.list();
    expect(item).toMatchObject({ kind: "skill", id: "review", description: "Does review things", status: "ok", files: 2, source: { type: "local" } });
    const lock = JSON.parse(readFileSync(join(h, "library/library.lock.json"), "utf8"));
    expect(lock.version).toBe(1);
    expect(lock.items["skill:review"]).toMatchObject({ sha256: item!.sha256, files: 2, source: { type: "local" } });
    const d = s.get("skill", "review");
    expect(d).toMatchObject({ ok: true, detail: { kind: "skill", id: "review", sha256: item!.sha256 } });
  });

  it("the hash does not depend on the order files are given", () => {
    const a = new LibraryStore(home()), b = new LibraryStore(home());
    const x = { path: "a.md", content: "A" }, y = { path: "b.md", content: "B" };
    const ra = a.addSkill("s", [...skill("s"), x, y]), rb = b.addSkill("s", [y, ...skill("s"), x]);
    expect(ra).toMatchObject({ ok: true }); expect((ra as any).sha256).toBe((rb as any).sha256);
  });

  it("refuses to replace an existing item unless asked, and replaces it whole when asked", () => {
    const h = home(); const s = new LibraryStore(h);
    s.addSkill("one", skill("one", [{ path: "old.md", content: "x" }]));
    expect(s.addSkill("one", skill("one"))).toMatchObject({ ok: false, error: "exists" });
    expect(existsSync(join(h, "library/skills/one/old.md"))).toBe(true);
    expect(s.addSkill("one", skill("one"), { overwrite: true })).toMatchObject({ ok: true });
    expect(existsSync(join(h, "library/skills/one/old.md"))).toBe(false);
    expect(readdirSync(join(h, "library/skills"))).toEqual(["one"]);        // no temp or .old folder left behind
  });

  it("rejects every path that could leave the skill's folder or mean different things on different systems", () => {
    for (const bad of ["../x.md", "a/../../x", "/etc/passwd", "a\\b.md", "C:/x", "C:x", ".hidden", "a/.git/config", "a//b", "", ".", "a/", "con.", "a b.md", "x\u0000y", "a/b/c/d/e/f/g.md", "é.md"]) {
      expect(isSafeSkillPath(bad), JSON.stringify(bad)).toBe(false);
      const v = validateSkill("s", [...skill("s"), { path: bad, content: "x" }]);
      expect(v, JSON.stringify(bad)).toMatchObject({ ok: false, error: "invalid_path" });
    }
    for (const good of ["a.md", "references/x-1.md", "scripts/run_it.sh", "v1.2/notes.txt"]) expect(isSafeSkillPath(good), good).toBe(true);
  });

  it("rejects a bad id, a duplicate (also by case), a file that is also a folder, and a missing or malformed SKILL.md", () => {
    for (const id of ["", "A", "../x", "a/b", "-a", "a".repeat(65), "a.b", 5, null]) expect(validateSkill(id, skill("s")), String(id)).toMatchObject({ ok: false, error: "invalid_id" });
    expect(validateSkill("s", [...skill("s"), { path: "a.md", content: "1" }, { path: "A.md", content: "2" }])).toMatchObject({ error: "duplicate_path" });
    expect(validateSkill("s", [...skill("s"), { path: "a", content: "1" }, { path: "a/b", content: "2" }])).toMatchObject({ error: "invalid_path" });
    expect(validateSkill("s", [{ path: "x.md", content: "x" }])).toMatchObject({ error: "missing_skill_md" });
    expect(validateSkill("s", [{ path: "SKILL.md", content: "no frontmatter" }])).toMatchObject({ error: "bad_frontmatter" });
    expect(validateSkill("s", [{ path: "SKILL.md", content: "---\n: : :\n---\n" }])).toMatchObject({ error: "bad_frontmatter" });
    expect(validateSkill("s", [{ path: "SKILL.md", content: md("other") }])).toMatchObject({ error: "name_mismatch" });
    expect(validateSkill("s", [{ path: "SKILL.md", content: "---\nname: s\n---\n" }])).toMatchObject({ error: "missing_description" });
    expect(validateSkill("s", "nope")).toMatchObject({ error: "invalid_request" });
    expect(validateSkill("s", [...skill("s"), { path: "b.bin", content: "a\u0000b" }])).toMatchObject({ error: "not_text" });
  });

  it("enforces the size and count limits", () => {
    expect(validateSkill("s", [{ path: "SKILL.md", content: md("s") + "x".repeat(LIBRARY_LIMITS.skillMdBytes) }])).toMatchObject({ error: "too_large", path: "SKILL.md" });
    expect(validateSkill("s", [...skill("s"), { path: "big.txt", content: "x".repeat(LIBRARY_LIMITS.skillFileBytes + 1) }])).toMatchObject({ error: "too_large", path: "big.txt" });
    const five = Array.from({ length: 3 }, (_, i) => ({ path: `f${i}.txt`, content: "x".repeat(LIBRARY_LIMITS.skillFileBytes - 10) }));
    expect(validateSkill("s", [...skill("s"), ...five])).toMatchObject({ error: "too_large" });                      // total
    const many = Array.from({ length: LIBRARY_LIMITS.skillFiles }, (_, i) => ({ path: `f${i}.txt`, content: "x" }));
    expect(validateSkill("s", [...skill("s"), ...many])).toMatchObject({ error: "too_many_files" });
  });

  it("refuses a skill that contains something that looks like a secret, naming where but never the value", () => {
    const v = validateSkill("s", skill("s", [{ path: "notes.md", content: `use ${fake.anthropicKey()}\n` }]));
    expect(v).toMatchObject({ ok: false, error: "secret_found", findings: [{ field: "notes.md", line: 1 }] });
    expect(JSON.stringify(v)).not.toContain(fake.anthropicKey());
  });

  it("lists a hand-edited skill as modified, one placed by hand as untracked, and a deleted one as missing", () => {
    const h = home(); const s = new LibraryStore(h);
    s.addSkill("a", skill("a")); s.addSkill("b", skill("b"));
    writeFileSync(join(h, "library/skills/a/SKILL.md"), md("a") + "edited\n");
    mkdirSync(join(h, "library/skills/c")); writeFileSync(join(h, "library/skills/c/SKILL.md"), md("c"));
    rmSync(join(h, "library/skills/b"), { recursive: true });
    const by = Object.fromEntries(s.list().map((i) => [i.id, i.status]));
    expect(by).toEqual({ a: "modified", b: "missing", c: "untracked" });
  });

  it("never follows a symlink: a linked skill, a linked file inside one, and a linked SKILL.md are invalid and not read", () => {
    const h = home(); const outside = home(); writeFileSync(join(outside, "secret.txt"), "TOP-SECRET");
    const s = new LibraryStore(h);
    s.addSkill("real", skill("real"));
    symlinkSync(outside, join(h, "library/skills/linked"));
    mkdirSync(join(h, "library/skills/inner")); writeFileSync(join(h, "library/skills/inner/SKILL.md"), md("inner"));
    symlinkSync(join(outside, "secret.txt"), join(h, "library/skills/inner/leak.md"));
    mkdirSync(join(h, "library/skills/mdlink")); symlinkSync(join(outside, "secret.txt"), join(h, "library/skills/mdlink/SKILL.md"));
    const by = Object.fromEntries(s.list().map((i) => [i.id, i.status]));
    expect(by).toEqual({ real: "ok", linked: "invalid", inner: "invalid", mdlink: "invalid" });
    for (const id of ["linked", "inner", "mdlink"]) expect(JSON.stringify(s.get("skill", id))).not.toContain("TOP-SECRET");
    // removing a linked item unlinks the link only
    expect(s.remove("skill", "linked")).toMatchObject({ ok: true });
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("TOP-SECRET");
  });

  it("ignores names that are not valid ids (hidden temp folders, stray files) and caps what it reads", () => {
    const h = home(); const s = new LibraryStore(h);
    s.addSkill("ok", skill("ok"));
    mkdirSync(join(h, "library/skills/.tmp-x-1")); writeFileSync(join(h, "library/skills/README.txt"), "x"); mkdirSync(join(h, "library/skills/Bad_Name"));
    mkdirSync(join(h, "library/skills/huge")); writeFileSync(join(h, "library/skills/huge/SKILL.md"), md("huge") + "x".repeat(LIBRARY_LIMITS.skillMdBytes));
    expect(s.list().map((i) => `${i.id}:${i.status}`)).toEqual(["huge:invalid", "ok:ok"]);
  });

  it("removes a skill and its lock entry; unknown names are not_found; bad ids are refused", () => {
    const h = home(); const s = new LibraryStore(h);
    s.addSkill("gone", skill("gone"));
    expect(s.remove("skill", "gone")).toMatchObject({ ok: true });
    expect(existsSync(join(h, "library/skills/gone"))).toBe(false);
    expect(JSON.parse(readFileSync(join(h, "library/library.lock.json"), "utf8")).items).toEqual({});
    expect(s.remove("skill", "gone")).toMatchObject({ ok: false, error: "not_found" });
    expect(s.remove("skill", "../library")).toMatchObject({ ok: false, error: "invalid_id" });
    expect(existsSync(join(h, "library"))).toBe(true);
  });

  it("only ever writes inside <home>/library", () => {
    const h = home(); writeFileSync(join(h, "fleet.yaml"), "keep");
    const s = new LibraryStore(h);
    s.addSkill("x", skill("x")); s.addMcp("m", MCP("m", "transport: stdio\ncommand: node\n")); s.remove("skill", "x");
    expect(readdirSync(h).sort()).toEqual(["fleet.yaml", "library"]);
    expect(readFileSync(join(h, "fleet.yaml"), "utf8")).toBe("keep");
  });
});

describe("MCP items", () => {
  const ok = MCP("github", "description: GitHub\ntransport: stdio\ncommand: npx\nargs:\n  - -y\n  - '@modelcontextprotocol/server-github'\nenv:\n  - MCP_GITHUB_TOKEN\n");

  it("stores a stdio server with variable names only, as canonical text", () => {
    const h = home(); const s = new LibraryStore(h);
    const r = s.addMcp("github", ok);
    expect(r).toMatchObject({ ok: true });
    const text = readFileSync(join(h, "library/mcp/github.yaml"), "utf8");
    expect(text).toContain("env:\n  - MCP_GITHUB_TOKEN");
    expect(s.list()[0]).toMatchObject({ kind: "mcp", id: "github", description: "GitHub", status: "ok" });
    expect(s.get("mcp", "github")).toMatchObject({ ok: true, detail: { kind: "mcp", text, item: { transport: "stdio", command: "npx", env: ["MCP_GITHUB_TOKEN"] } } });
  });

  it("stores an http server whose headers point at variables", () => {
    const v = validateMcpText("remote", MCP("remote", "transport: http\nurl: https://mcp.example.com/v1\nheaders:\n  Authorization: MCP_REMOTE_TOKEN\n"));
    expect(v).toMatchObject({ ok: true, item: { transport: "http", url: "https://mcp.example.com/v1", headers: { Authorization: "MCP_REMOTE_TOKEN" } } });
  });

  it("refuses a value where a variable name belongs, a secret in the command, and credentials or a query in the address", () => {
    expect(validateMcpText("m", MCP("m", "transport: stdio\ncommand: node\nenv:\n  MCP_GITHUB_TOKEN: abc\n"))).toMatchObject({ ok: false, error: "bad_mcp", detail: "env" });
    expect(validateMcpText("m", MCP("m", "transport: stdio\ncommand: node\nenv:\n  - MCP_GITHUB_TOKEN=abc123\n"))).toMatchObject({ ok: false, error: "bad_mcp", detail: "env" });
    expect(validateMcpText("m", MCP("m", `transport: stdio\ncommand: node\nargs: ["--key", "${fake.anthropicKey()}"]\n`))).toMatchObject({ ok: false, error: "secret_found" });
    for (const url of ["https://u:p@example.com/x", "https://example.com/x?token=abc", "https://example.com/x#y", "ftp://example.com", "not a url"])
      expect(validateMcpText("m", MCP("m", `transport: http\nurl: ${JSON.stringify(url)}\n`)), url).toMatchObject({ ok: false, error: "bad_mcp", detail: "url" });
    expect(validateMcpText("m", MCP("m", "transport: http\nurl: https://example.com/x\nheaders:\n  Authorization: Bearer abcdefghijklmnopqrstuvwxyz\n"))).toMatchObject({ ok: false, detail: "headers" });
    const r = validateMcpText("m", MCP("m", `transport: stdio\ncommand: node\nargs: ["${fake.anthropicKey()}"]\n`));
    expect(JSON.stringify(r)).not.toContain(fake.anthropicKey());
  });

  it("does not mistake a long variable NAME in a header for a secret", () => {
    expect(validateMcpText("m", MCP("m", "transport: http\nurl: https://example.com/x\nheaders:\n  X-Api-Key: MCP_MY_SERVICE_API_KEY_VARIABLE\n"))).toMatchObject({ ok: true });
  });

  it("rejects other shapes: wrong marker/kind, name not the id, unknown keys, mixed transports, bad yaml, oversize, bad id", () => {
    expect(validateMcpText("m", "name: m\n")).toMatchObject({ error: "bad_mcp", detail: "agend_library" });
    expect(validateMcpText("m", "agend_library: 1\nkind: skill\nname: m\n")).toMatchObject({ error: "bad_mcp", detail: "kind" });
    expect(validateMcpText("m", MCP("other", "transport: stdio\ncommand: node\n"))).toMatchObject({ error: "name_mismatch" });
    expect(validateMcpText("m", MCP("m", "transport: stdio\ncommand: node\nextra: 1\n"))).toMatchObject({ error: "bad_mcp", detail: "extra" });
    expect(validateMcpText("m", MCP("m", "transport: stdio\ncommand: node\nurl: https://x.test\n"))).toMatchObject({ error: "bad_mcp", detail: "url" });
    expect(validateMcpText("m", MCP("m", "transport: http\nurl: https://x.test\ncommand: node\n"))).toMatchObject({ error: "bad_mcp", detail: "command" });
    expect(validateMcpText("m", MCP("m", "transport: stdio\n"))).toMatchObject({ error: "bad_mcp", detail: "command" });
    expect(validateMcpText("m", MCP("m", "transport: ws\n"))).toMatchObject({ error: "bad_mcp", detail: "transport" });
    expect(validateMcpText("m", "a: [unclosed")).toMatchObject({ error: "invalid_yaml" });
    expect(validateMcpText("m", "- a\n- b\n")).toMatchObject({ error: "invalid_yaml" });
    expect(validateMcpText("m", MCP("m", "transport: stdio\ncommand: node\nargs: [" + '"x",'.repeat(LIBRARY_LIMITS.mcpArgs + 1) + "]\n"))).toMatchObject({ error: "bad_mcp", detail: "args" });
    expect(validateMcpText("m", MCP("m", `description: ${"x".repeat(LIBRARY_LIMITS.mcpBytes)}\n`))).toMatchObject({ error: "too_large" });
    expect(validateMcpText("../m", MCP("m", "transport: stdio\ncommand: node\n"))).toMatchObject({ error: "invalid_id" });
    expect(validateMcpText("m", "agend_library: 1\nkind: mcp\nname: &a m\ndescription: *a\ntransport: stdio\ncommand: node\n")).toMatchObject({ ok: false });   // aliases are not read
  });

  it("overwrites only when asked; remove deletes the file and lock entry; a symlinked file is invalid", () => {
    const h = home(); const s = new LibraryStore(h); const outside = home(); writeFileSync(join(outside, "x.yaml"), "TOP-SECRET");
    expect(s.addMcp("a", MCP("a", "transport: stdio\ncommand: node\n"))).toMatchObject({ ok: true });
    expect(s.addMcp("a", MCP("a", "transport: stdio\ncommand: deno\n"))).toMatchObject({ error: "exists" });
    expect(s.addMcp("a", MCP("a", "transport: stdio\ncommand: deno\n"), { overwrite: true })).toMatchObject({ ok: true });
    expect(readFileSync(join(h, "library/mcp/a.yaml"), "utf8")).toContain("deno");
    symlinkSync(join(outside, "x.yaml"), join(h, "library/mcp/link.yaml"));
    expect(s.list().find((i) => i.id === "link")).toMatchObject({ status: "invalid" });
    expect(JSON.stringify(s.get("mcp", "link"))).not.toContain("TOP-SECRET");
    expect(s.remove("mcp", "a")).toMatchObject({ ok: true });
    expect(existsSync(join(h, "library/mcp/a.yaml"))).toBe(false);
  });

  it("a hand-placed mcp file that breaks a rule is invalid, not read", () => {
    const h = home(); const s = new LibraryStore(h); s.addMcp("a", MCP("a", "transport: stdio\ncommand: node\n"));
    writeFileSync(join(h, "library/mcp/bad.yaml"), MCP("bad", "transport: stdio\ncommand: node\nenv:\n  K: v\n"));
    expect(s.list().map((i) => `${i.id}:${i.status}`)).toEqual(["a:ok", "bad:invalid"]);
  });
});

describe("lock file", () => {
  it("survives a damaged lock (treated as empty) and rewrites it atomically with owner-only access", () => {
    const h = home(); const s = new LibraryStore(h);
    s.addSkill("a", skill("a"));
    writeFileSync(join(h, "library/library.lock.json"), "{ not json");
    expect(s.list()[0]).toMatchObject({ id: "a", status: "untracked" });
    s.addSkill("b", skill("b"));
    expect(Object.keys(JSON.parse(readFileSync(join(h, "library/library.lock.json"), "utf8")).items)).toEqual(["skill:b"]);
    if (process.platform !== "win32") expect(require("node:fs").statSync(join(h, "library/library.lock.json")).mode & 0o077).toBe(0);
  });
});

describe("nothing else uses the library yet", () => {
  it("only the web route, the config check, the fleet's mounts and the two backends that render library MCP import src/library — no other agent start, publish or config path reaches it", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const importers: string[] = [];
    const walk = (dir: string): void => {
      for (const n of readdirSync(dir)) {
        const p = join(dir, n);
        if (statSync(p).isDirectory()) { if (!p.endsWith("/library")) walk(p); continue; }
        if (/\.ts$/.test(n) && /from "\.{1,2}\/(?:\.\.\/)?library\/[a-z-]+\.js"/.test(readFileSync(p, "utf8"))) importers.push(p.replace(/^.*\/src\//, ""));
      }
    };
    walk(join(__dirname, "..", "src"));
    // AGEND-244: the mount (fleet-manager.ts) and the shape check of an agent's `library` setting (config-validator.ts).
    // AGEND-261: library MCP mounting — the two backends that render it (claude-code.ts, codex.ts), the type they receive (backend/types.ts)
    // and the daemon that passes it on (daemon.ts, a type). Every other backend and path still does not reach the library.
    expect(importers.sort()).toEqual(["backend/claude-code.ts", "backend/codex.ts", "backend/types.ts", "config-validator.ts", "daemon.ts", "fleet-manager.ts", "web-api.ts"]);
  });
});
