/**
 * AGEND-243: the library's files. `<AGEND_HOME>/library/` holds
 *
 *   skills/<id>/SKILL.md (+ supporting files)   mcp/<id>.yaml   library.lock.json
 *
 * The lock records each item's sha256 and where it came from, so a later step (mounting, export/import) can tell a changed or
 * hand-edited item from the one that was added. Nothing here is mounted into an agent; nothing outside `library/` is touched.
 *
 * Every read treats the folder as untrusted input (it may be edited by hand or synced): symlinks are never followed, sizes are
 * capped, and a skill that breaks a rule is reported as `invalid` instead of being read. Every write goes through schema.ts and
 * lands atomically (a skill is built beside its place and renamed into it; the lock is replaced, never edited).
 */
import {
  constants as fsConstants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { atomicWriteFileSync } from "../atomic-write.js";
import {
  LIBRARY_LIMITS, type LibraryError, type LibraryKind, type McpItem, type SkillFile,
  isLibraryId, isSafeSkillPath, parseSkillFrontmatter, validateMcpText, validateSkill,
} from "./schema.js";

export const LIBRARY_DIRNAME = "library";
export const LOCK_FILENAME = "library.lock.json";
const LOCK_VERSION = 1;
/** The `O_NOFOLLOW` flag where the platform has one (a symlink swapped in after the check then fails to open). */
const NOFOLLOW = process.platform === "win32" ? 0 : (fsConstants.O_NOFOLLOW ?? 0);

export type LibrarySource = { type: "local" } | { type: "import"; from?: string };
export interface LockEntry { sha256: string; size: number; files?: number; source: LibrarySource; updatedAt: string }
interface LockFile { version: number; items: Record<string, LockEntry> }

/** `ok`: matches the lock. `modified`: the lock has another hash (edited by hand). `untracked`: on disk, not in the lock.
 *  `missing`: in the lock, gone from disk. `invalid`: breaks a rule, so it is listed but never read. */
export type LibraryStatus = "ok" | "modified" | "untracked" | "missing" | "invalid";
export interface LibraryItemSummary {
  kind: LibraryKind; id: string; description: string; status: LibraryStatus; sha256?: string; size?: number; files?: number;
  source?: LibrarySource; updatedAt?: string; reason?: string;
}
export interface SkillDetail { kind: "skill"; id: string; description: string; sha256: string; files: Array<{ path: string; content?: string; binary?: true; size: number }> }
export interface McpDetail { kind: "mcp"; id: string; sha256: string; text: string; item: McpItem }
export type LibraryDetail = SkillDetail | McpDetail;
type Ok<T> = { ok: true } & T;
const fail = (error: LibraryError["error"], extra: Partial<LibraryError> = {}): LibraryError => ({ ok: false, error, ...extra });
const sha = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

/** The hash of a skill: its files' paths and content hashes, sorted — independent of the order or the time they were written. */
export function hashSkill(files: ReadonlyArray<{ path: string; sha256: string }>): string {
  return sha([...files].sort((a, b) => (a.path < b.path ? -1 : 1)).map((f) => `${f.path}\u0000${f.sha256}\n`).join(""));
}

/** Reads one file without following a symlink and without reading past `max` bytes; null if it is not a plain file or is too large. */
function readPlainFile(path: string, max: number): Buffer | null {
  let fd: number | undefined;
  try {
    if (!lstatSync(path).isFile()) return null;
    fd = openSync(path, fsConstants.O_RDONLY | NOFOLLOW);
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > max) return null;
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < buf.length) { const n = readSync(fd, buf, off, buf.length - off, off); if (n <= 0) break; off += n; }
    return off === buf.length ? buf : null;
  } catch { return null; } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* done */ } }
}

export class LibraryStore {
  readonly root: string;
  constructor(agendHome: string) { this.root = join(agendHome, LIBRARY_DIRNAME); }

  private skillsDir(): string { return join(this.root, "skills"); }
  private mcpDir(): string { return join(this.root, "mcp"); }
  private lockPath(): string { return join(this.root, LOCK_FILENAME); }
  private skillPath(id: string): string { return join(this.skillsDir(), id); }
  private mcpPath(id: string): string { return join(this.mcpDir(), `${id}.yaml`); }

  /** Creates the folders on the first write only: a fleet that never uses the library gets no `library/` folder. */
  private ensureDirs(): void {
    for (const d of [this.root, this.skillsDir(), this.mcpDir()]) {
      if (existsSync(d)) {
        if (!lstatSync(d).isDirectory()) throw new Error(`${d} is not a folder`);
        continue;
      }
      mkdirSync(d, { mode: 0o700 });
    }
  }

  // ── lock ─────────────────────────────────────────────────────────────

  private readLock(): LockFile {
    const buf = readPlainFile(this.lockPath(), 4 * 1024 * 1024);
    if (!buf) return { version: LOCK_VERSION, items: {} };
    try {
      const data = JSON.parse(buf.toString("utf8")) as Partial<LockFile>;
      const items: Record<string, LockEntry> = {};
      if (data && typeof data === "object" && data.items && typeof data.items === "object") {
        for (const [key, e] of Object.entries(data.items)) {
          if (!/^(skill|mcp):[a-z0-9][a-z0-9-]{0,63}$/.test(key) || !e || typeof e.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(e.sha256)) continue;
          items[key] = { sha256: e.sha256, size: Number(e.size) || 0, ...(typeof e.files === "number" ? { files: e.files } : {}),
            source: e.source && (e.source as { type?: string }).type === "import" ? { type: "import", ...(typeof (e.source as { from?: unknown }).from === "string" ? { from: String((e.source as { from?: string }).from).slice(0, 200) } : {}) } : { type: "local" },
            updatedAt: typeof e.updatedAt === "string" ? e.updatedAt : "" };
        }
      }
      return { version: LOCK_VERSION, items };
    } catch { return { version: LOCK_VERSION, items: {} }; }
  }

  private writeLock(lock: LockFile): void {
    const sorted: Record<string, LockEntry> = {};
    for (const k of Object.keys(lock.items).sort()) sorted[k] = lock.items[k]!;
    atomicWriteFileSync(this.lockPath(), `${JSON.stringify({ version: LOCK_VERSION, items: sorted }, null, 2)}\n`, { mode: 0o600 });
  }

  // ── reads ────────────────────────────────────────────────────────────

  /** A skill folder's files, read under the limits, or why it cannot be. Never follows a link. */
  private readSkillFiles(id: string): { ok: true; files: Array<{ path: string; size: number; sha256: string; buf: Buffer }> } | { ok: false; reason: string } {
    const dir = this.skillPath(id);
    let st;
    try { st = lstatSync(dir); } catch { return { ok: false, reason: "not_found" }; }
    if (!st.isDirectory()) return { ok: false, reason: "unsafe_item" };
    const out: Array<{ path: string; size: number; sha256: string; buf: Buffer }> = [];
    let total = 0;
    const walk = (rel: string): string | null => {
      let names: string[];
      try { names = readdirSync(rel ? join(dir, rel) : dir); } catch { return "unreadable"; }
      for (const name of names.sort()) {
        const relPath = rel ? `${rel}/${name}` : name;
        if (!isSafeSkillPath(relPath)) return "invalid_path";
        const abs = join(dir, relPath);
        let s;
        try { s = lstatSync(abs); } catch { return "unreadable"; }
        if (s.isSymbolicLink()) return "unsafe_item";
        if (s.isDirectory()) { const r = walk(relPath); if (r) return r; continue; }
        if (!s.isFile()) return "unsafe_item";
        if (out.length >= LIBRARY_LIMITS.skillFiles) return "too_many_files";
        const cap = relPath === "SKILL.md" ? LIBRARY_LIMITS.skillMdBytes : LIBRARY_LIMITS.skillFileBytes;
        const buf = readPlainFile(abs, cap);
        if (!buf) return "too_large";
        total += buf.length;
        if (total > LIBRARY_LIMITS.skillTotalBytes) return "too_large";
        out.push({ path: relPath, size: buf.length, sha256: sha(buf), buf });
      }
      return null;
    };
    const problem = walk("");
    if (problem) return { ok: false, reason: problem };
    if (!out.some((f) => f.path === "SKILL.md")) return { ok: false, reason: "missing_skill_md" };
    return { ok: true, files: out };
  }

  private ids(kind: LibraryKind): string[] {
    const dir = kind === "skill" ? this.skillsDir() : this.mcpDir();
    let names: string[];
    try { names = readdirSync(dir); } catch { return []; }
    const ids: string[] = [];
    for (const n of names) {
      const id = kind === "mcp" ? (n.endsWith(".yaml") ? n.slice(0, -5) : "") : n;
      if (isLibraryId(id)) ids.push(id);
      if (ids.length >= LIBRARY_LIMITS.itemsPerKind) break;
    }
    return ids.sort();
  }

  /** Every item, newest state from disk, compared with the lock. A fleet with no `library/` folder gets an empty list. */
  list(): LibraryItemSummary[] {
    const lock = this.readLock();
    const out: LibraryItemSummary[] = [];
    const seenKeys = new Set<string>();
    for (const kind of ["skill", "mcp"] as const) {
      for (const id of this.ids(kind)) {
        const key = `${kind}:${id}`;
        seenKeys.add(key);
        const entry = lock.items[key];
        const d = this.get(kind, id);
        if (!d.ok) { out.push({ kind, id, description: "", status: "invalid", reason: d.error, ...(entry ? { source: entry.source } : {}) }); continue; }
        const detail = d.detail;
        const size = detail.kind === "skill" ? detail.files.reduce((n, f) => n + f.size, 0) : Buffer.byteLength(detail.text);
        const status: LibraryStatus = !entry ? "untracked" : entry.sha256 === detail.sha256 ? "ok" : "modified";
        out.push({
          kind, id, status, sha256: detail.sha256, size,
          description: detail.kind === "skill" ? detail.description : detail.item.description ?? "",
          ...(detail.kind === "skill" ? { files: detail.files.length } : {}),
          ...(entry ? { source: entry.source, updatedAt: entry.updatedAt } : {}),
        });
      }
    }
    for (const [key, entry] of Object.entries(lock.items)) {
      if (seenKeys.has(key)) continue;
      const [kind, id] = key.split(":") as [LibraryKind, string];
      out.push({ kind, id: id!, description: "", status: "missing", sha256: entry.sha256, source: entry.source, updatedAt: entry.updatedAt });
    }
    return out;
  }

  /** One item, whole (a skill's files with their text). */
  get(kind: LibraryKind, id: string): Ok<{ detail: LibraryDetail }> | LibraryError {
    if (!isLibraryId(id)) return fail("invalid_id");
    if (kind === "skill") {
      const r = this.readSkillFiles(id);
      if (!r.ok) return fail(r.reason === "not_found" ? "not_found" : "unsafe_item", r.reason === "not_found" ? {} : { detail: r.reason });
      const md = r.files.find((f) => f.path === "SKILL.md")!;
      const fm = parseSkillFrontmatter(md.buf.toString("utf8"));
      const description = fm.ok && typeof fm.data.description === "string" ? fm.data.description.trim() : "";
      return { ok: true, detail: { kind: "skill", id, description, sha256: hashSkill(r.files),
        files: r.files.map((f) => {
          const text = f.buf.toString("utf8");
          const isText = !f.buf.includes(0) && Buffer.byteLength(text) === f.buf.length;
          return isText ? { path: f.path, size: f.size, content: text } : { path: f.path, size: f.size, binary: true as const };
        }) } };
    }
    const buf = readPlainFile(this.mcpPath(id), LIBRARY_LIMITS.mcpBytes);
    if (!buf) return existsSync(this.mcpPath(id)) ? fail("unsafe_item") : fail("not_found");
    const text = buf.toString("utf8");
    const v = validateMcpText(id, text);
    if (!v.ok) return fail("unsafe_item", { detail: v.error });
    return { ok: true, detail: { kind: "mcp", id, sha256: sha(buf), text, item: v.item } };
  }

  // ── writes ───────────────────────────────────────────────────────────

  private countOf(kind: LibraryKind): number { return this.ids(kind).length; }

  addSkill(id: unknown, files: unknown, opts: { overwrite?: boolean; source?: LibrarySource } = {}): Ok<{ sha256: string }> | LibraryError {
    const v = validateSkill(id, files);
    if (!v.ok) return v;
    this.ensureDirs();
    const target = this.skillPath(v.id);
    const exists = existsSync(target) || (() => { try { lstatSync(target); return true; } catch { return false; } })();
    if (exists && !opts.overwrite) return fail("exists");
    if (!exists && this.countOf("skill") >= LIBRARY_LIMITS.itemsPerKind) return fail("too_many_items");
    // Built beside its place under a hidden name (the listing ignores it), then renamed in.
    const tag = randomBytes(4).toString("hex");
    const temp = join(this.skillsDir(), `.tmp-${v.id}-${tag}`);
    const old = join(this.skillsDir(), `.old-${v.id}-${tag}`);
    let moved = false;
    try {
      for (const f of v.files) {
        const abs = join(temp, ...f.path.split("/"));
        mkdirSync(dirname(abs), { recursive: true, mode: 0o700 });
        writeFileSync(abs, f.content, { mode: 0o600, flag: "wx" });
      }
      if (exists) { renameSync(target, old); moved = true; }
      renameSync(temp, target);
    } catch (err) {
      try { rmSync(temp, { recursive: true, force: true }); } catch { /* best effort */ }
      if (moved) { try { renameSync(old, target); } catch { /* the old copy stays under its hidden name */ } }
      throw err;
    }
    if (moved) { try { rmSync(old, { recursive: true, force: true }); } catch { /* a hidden leftover is harmless */ } }
    const hash = hashSkill(v.files.map((f) => ({ path: f.path, sha256: sha(f.content) })));
    this.record(`skill:${v.id}`, { sha256: hash, size: v.files.reduce((n, f) => n + Buffer.byteLength(f.content), 0), files: v.files.length }, opts.source);
    return { ok: true, sha256: hash };
  }

  addMcp(id: unknown, text: unknown, opts: { overwrite?: boolean; source?: LibrarySource } = {}): Ok<{ sha256: string }> | LibraryError {
    const v = validateMcpText(id, text);
    if (!v.ok) return v;
    this.ensureDirs();
    const target = this.mcpPath(v.id);
    const exists = (() => { try { lstatSync(target); return true; } catch { return false; } })();
    if (exists && !opts.overwrite) return fail("exists");
    if (!exists && this.countOf("mcp") >= LIBRARY_LIMITS.itemsPerKind) return fail("too_many_items");
    if (exists && !lstatSync(target).isFile()) return fail("unsafe_item");
    atomicWriteFileSync(target, v.text, { mode: 0o600 });
    const hash = sha(v.text);
    this.record(`mcp:${v.id}`, { sha256: hash, size: Buffer.byteLength(v.text) }, opts.source);
    return { ok: true, sha256: hash };
  }

  private record(key: string, e: { sha256: string; size: number; files?: number }, source?: LibrarySource): void {
    const lock = this.readLock();
    lock.items[key] = { ...e, source: source ?? { type: "local" }, updatedAt: new Date().toISOString() };
    this.writeLock(lock);
  }

  /** Removes one item and its lock entry. A name that is not there (or only in the lock) still clears the lock entry. */
  remove(kind: LibraryKind, id: unknown): Ok<{}> | LibraryError {
    if (!isLibraryId(id)) return fail("invalid_id");
    const target = kind === "skill" ? this.skillPath(id) : this.mcpPath(id);
    const lock = this.readLock();
    const key = `${kind}:${id}`;
    let onDisk = true;
    try { lstatSync(target); } catch { onDisk = false; }
    if (!onDisk && !lock.items[key]) return fail("not_found");
    // A link is unlinked (rmSync does not follow it); a folder is removed whole.
    if (onDisk) rmSync(target, { recursive: true, force: true });
    if (lock.items[key]) { delete lock.items[key]; this.writeLock(lock); }
    return { ok: true };
  }
}
