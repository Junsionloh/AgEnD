/** AGEND-257: Skill export / import — the archive reader's refusals, the round trip, the three ways to settle a name clash, and the library's own rules on everything that comes in. */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { LibraryStore } from "../src/library/store.js";
import { crc32, readZip, writeZip, ZIP_LIMITS } from "../src/library/zip.js";
import {
  allTeamSkillsArchive, applyImport, builtinSkillFiles, builtinSkillNames, describeSkillText, parseUpload, previewUpload, renameSkillFiles, skillArchive, takenNames,
  type ImportDecision,
} from "../src/library/transfer.js";
import { validateSkill } from "../src/library/schema.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const home = (): string => { const d = mkdtempSync(join(tmpdir(), "agend-xfer-")); dirs.push(d); return d; };
const md = (name: string, extra = ""): string => `---\nname: ${name}\ndescription: Does ${name} things\n---\n\n# ${name}\n\nSteps${extra}\n`;
const ghp = `gh${"p_"}${"x".repeat(36)}`;

interface RawEntry { name: string; data: Buffer; method?: 0 | 8; flags?: number; madeBy?: number; external?: number; crc?: number; declared?: number; packed?: Buffer }
/** An archive built by hand, so a test can write the records a well-behaved writer never would. */
function raw(entries: RawEntry[], opts: { comment?: Buffer } = {}): Buffer {
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0, cdBytes = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8"), method = e.method ?? 0;
    const body = e.packed ?? (method === 8 ? deflateRawSync(e.data) : e.data);
    const crc = e.crc ?? crc32(e.data), size = e.declared ?? e.data.length, flags = e.flags ?? 0x0800;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flags, 6); lh.writeUInt16LE(method, 8); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(size, 22); lh.writeUInt16LE(name.length, 26);
    local.push(lh, name, body);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(e.madeBy ?? 0x0314, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(flags, 8); cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(body.length, 20); cd.writeUInt32LE(size, 24); cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(e.external ?? ((0o100644 << 16) >>> 0), 38); cd.writeUInt32LE(offset, 42);
    central.push(cd, name); cdBytes += cd.length + name.length;
    offset += lh.length + name.length + body.length;
  }
  const comment = opts.comment ?? Buffer.alloc(0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBytes, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...local, ...central, end, comment]);
}
const file = (name: string, text: string, rest: Partial<RawEntry> = {}): RawEntry => ({ name, data: Buffer.from(text), ...rest });
const refused = (bytes: Buffer): { error: string; path?: string } => { const r = parseUpload(bytes); expect(r.ok).toBe(false); return r as never; };

describe("the archive reader refuses what could leave the folder or hide something", () => {
  it.each([
    ["a parent folder", "../evil/SKILL.md"], ["a parent folder inside a path", "a/../../x.md"], ["an absolute path", "/etc/cron.d/x"],
    ["a drive letter", "C:/Windows/x.md"], ["a backslash path", "demo\\..\\x.md"], ["a NUL in the name", "demo/a\u0000.md"],
  ])("%s (zip slip)", (_what, name) => {
    const r = readZip(raw([file(name, "x")]));
    expect(r).toMatchObject({ ok: false, error: "invalid_path" });
    expect(parseUpload(raw([file(name, "x")]))).toMatchObject({ ok: false, error: "invalid_path" });
  });

  it("a symbolic link (Unix mode in the entry's attributes), a device and a Windows reparse point", () => {
    expect(readZip(raw([file("demo/SKILL.md", md("demo"), { external: (0o120777 << 16) >>> 0 })]))).toMatchObject({ ok: false, error: "unsafe_item", path: "demo/SKILL.md" });
    expect(readZip(raw([file("demo/x", "x", { external: (0o010644 << 16) >>> 0 })]))).toMatchObject({ ok: false, error: "unsafe_item" });
    expect(readZip(raw([file("demo/x", "x", { madeBy: 0x0014, external: 0x400 })]))).toMatchObject({ ok: false, error: "unsafe_item" });
  });

  it("an encrypted entry, an unknown method, ZIP64, a wrong CRC and a size that lies", () => {
    expect(readZip(raw([file("demo/SKILL.md", md("demo"), { flags: 0x0801 })]))).toMatchObject({ ok: false, error: "bad_archive", detail: "encrypted" });
    expect(readZip(raw([file("demo/SKILL.md", md("demo"), { method: 9 as never })]))).toMatchObject({ ok: false, error: "bad_archive", detail: "method" });
    expect(readZip(raw([file("demo/SKILL.md", md("demo"), { crc: 1 })]))).toMatchObject({ ok: false, error: "bad_archive", detail: "crc" });
    // a deflate stream that unpacks to far more than its header says (a zip bomb with a small label): stopped at the declared size
    const bomb = Buffer.alloc(5 * 1024 * 1024, 97);
    expect(readZip(raw([{ name: "demo/SKILL.md", data: bomb, method: 8, declared: 100, crc: 0 }]))).toMatchObject({ ok: false, error: "bad_archive" });
    expect(readZip(Buffer.from("PK\u0003\u0004 not really an archive, but long enough to look at"))).toMatchObject({ ok: false, error: "bad_archive" });
    const z64 = raw([file("demo/SKILL.md", md("demo"))]);
    z64.writeUInt16LE(0xffff, z64.length - 22 + 8); z64.writeUInt16LE(0xffff, z64.length - 22 + 10);
    expect(readZip(z64)).toMatchObject({ ok: false, error: "bad_archive", detail: "zip64" });
  });

  it("limits: one file, all files, and the number of entries (a header cannot lie its way past them)", () => {
    expect(readZip(raw([file("demo/big.md", "x".repeat(ZIP_LIMITS.entryBytes + 1))]))).toMatchObject({ ok: false, error: "too_large", path: "demo/big.md" });
    const pieces = Array.from({ length: 12 }, (_, i) => file(`demo/f${i}.md`, "y".repeat(ZIP_LIMITS.entryBytes)));
    expect(readZip(raw(pieces), { totalBytes: 2 * 1024 * 1024 })).toMatchObject({ ok: false, error: "too_large" });
    expect(readZip(raw(Array.from({ length: 11 }, (_, i) => file(`demo/${i}.md`, "z"))), { entries: 10 })).toMatchObject({ ok: false, error: "too_many_files" });
    expect(readZip(Buffer.alloc(100), { archiveBytes: 50 })).toMatchObject({ ok: false, error: "too_large" });
    // the end record may be followed by a comment, and two entries that differ only by case are one name on macOS and Windows
    expect(readZip(raw([file("demo/a.md", "a")], { comment: Buffer.from("made by a tool") }))).toMatchObject({ ok: true });
    expect(readZip(raw([file("demo/a.md", "a"), file("demo/A.md", "b")]))).toMatchObject({ ok: false, error: "duplicate_path" });
    // AGEND-261: and so do two spellings of one name (é as one character, as macOS writes it, and as e + an accent)
    expect(readZip(raw([file("demo/caf\u00e9.md", "a"), file("demo/cafe\u0301.md", "b")]))).toMatchObject({ ok: false, error: "duplicate_path" });
  });

  it("leaves macOS and Windows file-manager litter out and says so", () => {
    const r = readZip(raw([file("demo/SKILL.md", md("demo")), file("__MACOSX/demo/._SKILL.md", "junk"), file("demo/.DS_Store", "junk"), file("Thumbs.db", "x")]));
    expect(r).toMatchObject({ ok: true, ignored: ["__MACOSX/demo/._SKILL.md", "demo/.DS_Store", "Thumbs.db"] });
    expect((r as any).entries.map((e: any) => e.name)).toEqual(["demo/SKILL.md"]);
  });

  it("is not fooled by a name: the bytes decide what it is", () => {
    expect(refused(Buffer.from([0, 1, 2, 3, 4, 5]))).toMatchObject({ error: "bad_archive" });
    expect(refused(Buffer.from("just some text with no frontmatter"))).toMatchObject({ error: "bad_frontmatter" });
    expect(refused(writeZip([]))).toMatchObject({ error: "no_skill" });
    expect(refused(writeZip([{ name: "notes/readme.md", data: Buffer.from("hi") }]))).toMatchObject({ error: "no_skill" });
  });
});

describe("what comes in meets the library's own rules, one skill at a time", () => {
  const upload = (...entries: RawEntry[]) => { const r = parseUpload(raw(entries)); expect(r.ok).toBe(true); return (r as any).upload; };

  it("a hidden file, a Windows device name, a name that is not the folder, a missing description and a binary file are each named and refused", () => {
    const u = upload(
      file("hid/SKILL.md", md("hid")), file("hid/.env", "A=1"),
      file("dev/SKILL.md", md("dev")), file("dev/nul.txt", "x"),
      file("one/SKILL.md", md("other")),
      file("nod/SKILL.md", "---\nname: nod\n---\nbody\n"),
      file("bin/SKILL.md", md("bin")), file("bin/pic.png", "\u0000\u0001\u0002"),
      file("ok/SKILL.md", md("ok")),
    );
    const by = Object.fromEntries(u.skills.map((s: any) => [s.id, s]));
    expect(by.hid).toMatchObject({ ok: false, error: "invalid_path", path: ".env" });
    expect(by.dev).toMatchObject({ ok: false, error: "invalid_path", path: "nul.txt" });
    expect(by.one).toMatchObject({ ok: false, error: "name_mismatch" });
    expect(by.nod).toMatchObject({ ok: false, error: "missing_description" });
    expect(by.bin).toMatchObject({ ok: false, error: "not_text", path: "pic.png" });
    expect(by.ok).toMatchObject({ ok: true, description: "Does ok things" });
  });

  it("a secret is refused and reported by file and line only — never the value, in the preview or in what is stored", () => {
    const u = upload(file("leak/SKILL.md", md("leak")), file("leak/notes.md", `line one\nTOKEN ${ghp}\n`), file("fine/SKILL.md", md("fine")));
    const h = home(), store = new LibraryStore(h);
    const preview = previewUpload(u, takenNames(store, new Set()));
    const text = JSON.stringify(preview);
    expect(text).not.toContain(ghp);
    expect(preview.skills[0]).toMatchObject({ id: "fine", ok: true });
    expect(preview.skills[1]).toMatchObject({ id: "leak", ok: false, error: "secret_found", findings: [{ field: "notes.md", line: 2 }] });
    const out = applyImport(store, u.skills, new Map(), new Set());
    expect(out.map((o) => `${o.id}:${o.status}`)).toEqual(["fine:imported", "leak:rejected"]);
    expect(JSON.stringify(out)).not.toContain(ghp);
    expect(existsSync(join(h, "library", "skills", "leak"))).toBe(false);
    expect(readdirSync(join(h, "library", "skills"))).toEqual(["fine"]);
  });

  it("the same skill is read from a folder, from the top of an archive, and from a lone SKILL.md", () => {
    const folder = parseUpload(writeZip([{ name: "demo/SKILL.md", data: Buffer.from(md("demo")) }, { name: "demo/notes/a.md", data: Buffer.from("a") }]));
    const top = parseUpload(writeZip([{ name: "SKILL.md", data: Buffer.from(md("demo")) }, { name: "notes/a.md", data: Buffer.from("a") }]));
    const lone = parseUpload(Buffer.from(md("demo")));
    for (const r of [folder, top, lone]) expect((r as any).upload.skills[0]).toMatchObject({ ok: true, id: "demo" });
    expect((folder as any).upload.skills[0].files).toEqual((top as any).upload.skills[0].files);
    expect((lone as any).upload).toMatchObject({ format: "skill-md" });
    expect((folder as any).upload).toMatchObject({ format: "zip" });
    expect(parseUpload(Buffer.from("---\nname: ../x\ndescription: d\n---\n")) as any).toMatchObject({ ok: true, upload: { skills: [{ ok: false, error: "invalid_id" }] } });
  });

  it("previews the name, description, every file and SKILL.md in full, and what each name would clash with", () => {
    const h = home(), store = new LibraryStore(h);
    expect(store.addSkill("mine", [{ path: "SKILL.md", content: md("mine") }]).ok).toBe(true);
    const u = (parseUpload(writeZip([
      { name: "mine/SKILL.md", data: Buffer.from(md("mine", " v2")) }, { name: "mine/ref/a.md", data: Buffer.from("abc") },
      { name: "concepts/SKILL.md", data: Buffer.from(md("concepts")) }, { name: "fresh/SKILL.md", data: Buffer.from(md("fresh")) },
    ])) as any).upload;
    const p = previewUpload(u, takenNames(store, builtinSkillNames()));
    expect(p.skills.map((s) => `${s.id}:${s.conflict}`)).toEqual(["concepts:builtin", "fresh:none", "mine:team"]);
    const mine = p.skills.find((s) => s.id === "mine")!;
    expect(mine).toMatchObject({ ok: true, description: "Does mine things", skillMd: md("mine", " v2"), files: [{ path: "SKILL.md" }, { path: "ref/a.md", size: 3 }] });
    expect(mine.fields).toEqual([{ key: "name", value: "mine" }, { key: "description", value: "Does mine things" }]);
    // a preview stores nothing
    expect(readdirSync(join(h, "library", "skills"))).toEqual(["mine"]);
  });
});

describe("a name that is already in the library: overwrite, rename or skip", () => {
  const setup = () => {
    const h = home(), store = new LibraryStore(h);
    expect(store.addSkill("mine", [{ path: "SKILL.md", content: md("mine", " old") }, { path: "old.md", content: "gone after overwrite" }]).ok).toBe(true);
    const u = (parseUpload(writeZip([{ name: "mine/SKILL.md", data: Buffer.from(md("mine", " new")) }, { name: "mine/new.md", data: Buffer.from("n") }])) as any).upload;
    return { h, store, u };
  };
  const run = (s: ReturnType<typeof setup>, d?: ImportDecision) => applyImport(s.store, s.u.skills, new Map(d ? [["mine", d]] : []), new Set(), "pack.zip");
  const files = (store: LibraryStore, id: string) => (store.get("skill", id) as any).detail.files.map((f: any) => `${f.path}=${f.content}`);

  it("no decision: skipped, nothing changes", () => {
    const s = setup();
    expect(run(s)).toEqual([{ id: "mine", status: "skipped", reason: "undecided" }]);
    expect(files(s.store, "mine")).toEqual([`SKILL.md=${md("mine", " old")}`, "old.md=gone after overwrite"]);
  });
  it("overwrite: replaced whole, hash recorded, source says imported", () => {
    const s = setup();
    expect(run(s, { action: "overwrite" })).toMatchObject([{ id: "mine", status: "replaced" }]);
    expect(files(s.store, "mine")).toEqual(["SKILL.md=" + md("mine", " new"), "new.md=n"]);
    expect(s.store.list()[0]).toMatchObject({ id: "mine", status: "ok", source: { type: "import", from: "pack.zip" } });
  });
  it("rename: stored under the new name (only the `name:` line differs), the old one is untouched", () => {
    const s = setup();
    expect(run(s, { action: "rename", as: "mine-2" })).toMatchObject([{ id: "mine", status: "renamed", savedAs: "mine-2" }]);
    expect(files(s.store, "mine-2")).toEqual(["SKILL.md=" + md("mine", " new").replace("name: mine\n", "name: mine-2\n"), "new.md=n"]);
    expect(files(s.store, "mine")[0]).toContain(" old");
    expect(s.store.list().map((i) => `${i.id}:${i.status}`)).toEqual(["mine:ok", "mine-2:ok"]);
    // a rename onto a name that is taken, or one that is not a name, is refused and stores nothing
    expect(run(s, { action: "rename", as: "mine-2" })).toMatchObject([{ status: "rejected", error: "exists" }]);
    expect(run(s, { action: "rename", as: "../x" })).toMatchObject([{ status: "rejected", error: "invalid_id" }]);
    expect(s.store.list().length).toBe(2);
  });
  it("skip: left out, nothing changes", () => {
    const s = setup();
    expect(run(s, { action: "skip" })).toEqual([{ id: "mine", status: "skipped", reason: "chosen" }]);
    expect(files(s.store, "mine")[0]).toContain(" old");
  });
  it("a built-in name is never replaced: overwrite is refused, rename and skip work", () => {
    const h = home(), store = new LibraryStore(h);
    const u = (parseUpload(writeZip([{ name: "concepts/SKILL.md", data: Buffer.from(md("concepts")) }])) as any).upload;
    const builtin = builtinSkillNames();
    expect(builtin.has("concepts")).toBe(true);
    expect(applyImport(store, u.skills, new Map(), builtin)).toEqual([{ id: "concepts", status: "skipped", reason: "undecided" }]);
    expect(applyImport(store, u.skills, new Map([["concepts", { action: "overwrite" }]]), builtin)).toEqual([{ id: "concepts", status: "rejected", error: "exists", reason: "builtin" }]);
    expect(applyImport(store, u.skills, new Map([["concepts", { action: "add" }]]), builtin)).toMatchObject([{ status: "rejected", reason: "builtin" }]);
    expect(applyImport(store, u.skills, new Map([["concepts", { action: "rename", as: "concepts" }]]), builtin)).toMatchObject([{ status: "rejected", error: "exists" }]);
    expect(applyImport(store, u.skills, new Map([["concepts", { action: "rename", as: "my-concepts" }]]), builtin)).toMatchObject([{ status: "renamed", savedAs: "my-concepts" }]);
    expect(store.list().map((i) => i.id)).toEqual(["my-concepts"]);
  });
  it("a skill named `constructor` is only a name, not a key into an object", () => {
    const h = home(), store = new LibraryStore(h);
    const u = (parseUpload(Buffer.from(md("constructor"))) as any).upload;
    expect(applyImport(store, u.skills, new Map(), new Set())).toMatchObject([{ id: "constructor", status: "imported" }]);
  });
  it("imports put a skill in the library and nothing else: no agent, no fleet file", () => {
    const s = setup();
    run(s, { action: "overwrite" });
    expect(readdirSync(s.h).sort()).toEqual(["library"]);
  });
  it("renameSkillFiles keeps every other byte, a quoted number stays text, a BOM and CRLF are kept", () => {
    const text = "\uFEFF---\r\nname: old\r\ndescription: d\r\n---\r\nBody name: old\r\n";
    const out = renameSkillFiles([{ path: "SKILL.md", content: text }, { path: "a.md", content: "x" }], "123")!;
    expect(out[0]!.content).toBe("\uFEFF---\r\nname: \"123\"\r\ndescription: d\r\n---\r\nBody name: old\r\n");
    expect(validateSkill("123", out)).toMatchObject({ ok: true });
    expect(renameSkillFiles([{ path: "SKILL.md", content: "no frontmatter" }], "x")).toBeNull();
  });
});

describe("export, then import: every byte comes back the same", () => {
  const SKILLS: Record<string, Array<{ path: string; content: string }>> = {
    plain: [{ path: "SKILL.md", content: md("plain") }],
    rich: [
      { path: "SKILL.md", content: "\uFEFF---\r\nname: rich\r\ndescription: Ünïcödé — 日本語 and emoji 🎉\r\n---\r\n\r\nCRLF body\r\n\ttabbed\r\n   trailing   \r\n" },
      { path: "ref/deep/notes.md", content: "# notes\n\nno final newline" },
      { path: "ref/empty.txt", content: "" },
      { path: "ref/big.txt", content: "lorem ipsum dolor sit amet\n".repeat(6000) },        // compresses: exercises deflate
      { path: "scripts/run.sh", content: "#!/bin/sh\necho hi\n" },
    ],
  };
  const fill = (store: LibraryStore) => { for (const [id, files] of Object.entries(SKILLS)) expect(store.addSkill(id, files).ok).toBe(true); };
  const bytesOf = (store: LibraryStore, id: string) => { const d = (store.get("skill", id) as any).detail; return d.files.map((f: any) => [f.path, Buffer.from(f.content, "utf8").toString("hex")]); };

  it("one skill", () => {
    const a = new LibraryStore(home()), b = new LibraryStore(home());
    fill(a);
    const t = teamFiles(a, "rich");
    const r = parseUpload(skillArchive("rich", t)) as any;
    expect(r.ok).toBe(true);
    expect(applyImport(b, r.upload.skills, new Map(), new Set())).toMatchObject([{ id: "rich", status: "imported" }]);
    expect(bytesOf(b, "rich")).toEqual(bytesOf(a, "rich"));
    expect(b.list()[0]).toMatchObject({ sha256: a.list().find((i) => i.id === "rich")!.sha256, status: "ok" });
  });
  it("all team skills in one archive", () => {
    const a = new LibraryStore(home()), b = new LibraryStore(home());
    fill(a);
    const all = allTeamSkillsArchive(a);
    expect(all).toMatchObject({ ok: true, count: 2 });
    const r = parseUpload((all as any).archive) as any;
    expect(r.upload.skills.map((s: any) => `${s.id}:${s.ok}`)).toEqual(["plain:true", "rich:true"]);
    applyImport(b, r.upload.skills, new Map(), new Set());
    for (const id of Object.keys(SKILLS)) expect(bytesOf(b, id)).toEqual(bytesOf(a, id));
    expect(b.list().map((i) => i.sha256)).toEqual(a.list().map((i) => i.sha256));
  });
  it("the same skill always makes the same archive", () => {
    expect(skillArchive("rich", SKILLS.rich!).equals(skillArchive("rich", [...SKILLS.rich!].reverse()))).toBe(true);
  });
  it("an empty library has nothing to export", () => {
    expect(allTeamSkillsArchive(new LibraryStore(home()))).toMatchObject({ ok: false, error: "not_found" });
  });
  it("a built-in skill is exported as a copy of its SKILL.md and read back as the same text", () => {
    const name = [...builtinSkillNames()][0]!;
    const f = builtinSkillFiles(name) as any;
    expect(f.ok).toBe(true);
    const shipped = readFileSync(join("src/general-knowledge/skills", name, "SKILL.md"), "utf8");
    expect(f.files).toEqual([{ path: "SKILL.md", content: shipped }]);
    const back = readZip(skillArchive(name, f.files)) as any;
    expect(back.entries[0]).toMatchObject({ name: `${name}/SKILL.md` });
    expect(back.entries[0].data.toString("utf8")).toBe(shipped);
    expect(builtinSkillFiles("../x")).toMatchObject({ ok: false });
  });
  it("describeSkillText: fields in a fixed order (name, description, roles first), text only, and the Markdown after the frontmatter", () => {
    const d = describeSkillText("---\nzeta: 1\nroles: [general, worker]\nname: x\nnested: {a: 1}\ndescription: hello\n---\n# Title\n");
    expect(d.fields).toEqual([{ key: "name", value: "x" }, { key: "description", value: "hello" }, { key: "roles", value: "general, worker" }, { key: "zeta", value: "1" }]);
    expect(d.body).toBe("# Title\n");
    expect(describeSkillText("# no frontmatter")).toEqual({ fields: [], body: "# no frontmatter" });
  });
});
function teamFiles(store: LibraryStore, id: string) { return (store.get("skill", id) as any).detail.files.map((f: any) => ({ path: f.path, content: f.content })); }
