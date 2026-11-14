/**
 * AGEND-257: moving Skills in and out of the library, and reading one for display. Pure in the sense that matters: bytes in, bytes or
 * answers out — the only store it touches is the one it is handed, and every skill it would add goes through `LibraryStore.addSkill`,
 * so the rules (validateSkill: names, sizes, text only, no hidden file, no Windows device name, no secret) are the ones a skill typed
 * in by hand meets. Nothing is mounted into an agent.
 *
 * Formats (the precedents are Multica's `skill import` and Anthropic's `.skill`, both a ZIP of a skill folder):
 *   <id>/SKILL.md (+ files)              one skill; the folder name is the skill's name
 *   <id>/…  <id2>/…                      several skills (what "Export all" writes)
 *   SKILL.md (+ files) at the top        one skill, named by its `name:`
 *   a single SKILL.md                    one skill, named by its `name:`
 * A `.skill` file is the same ZIP under another name; the bytes are what is read, never the file name.
 */
import { createHash } from "node:crypto";
import { BUNDLED_SKILLS_DIR, listBundledSkills, readBundledSkill } from "../bundled-skills.js";
import type { SecretFinding } from "../secret-scan.js";
import type { LibraryStore } from "./store.js";
import { LIBRARY_LIMITS, isLibraryId, parseSkillFrontmatter, validateSkill, type LibraryError, type LibraryErrorCode, type SkillFile } from "./schema.js";
import { looksLikeZip, readZip, writeZip, ZIP_LIMITS, type ZipEntry } from "./zip.js";

/** Skills one upload may carry (a preview shows every one of them, SKILL.md in full). */
export const IMPORT_MAX_SKILLS = 100;

const fail = (error: LibraryErrorCode, extra: { path?: string; detail?: string } = {}): LibraryError => ({ ok: false, error, ...extra });
const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

// ── Export ─────────────────────────────────────────────────────────────

/** One skill as an archive: `<id>/SKILL.md` and its other files, in path order. */
export function skillArchive(id: string, files: ReadonlyArray<SkillFile>): Buffer {
  return writeZip([...files].sort((a, b) => (a.path < b.path ? -1 : 1)).map((f) => ({ name: `${id}/${f.path}`, data: Buffer.from(f.content, "utf8") })));
}

/** The files of a team skill, as stored (hand-edited or not: an export copies what is there, a skill that cannot be read safely is not offered). */
export function teamSkillFiles(store: LibraryStore, id: string): { ok: true; files: SkillFile[] } | LibraryError {
  const r = store.get("skill", id);
  if (!r.ok) return r;
  if (r.detail.kind !== "skill") return fail("not_found");
  return { ok: true, files: r.detail.files.map((f) => ({ path: f.path, content: f.content ?? "" })) };
}

/** A built-in skill's files: its SKILL.md, byte for byte. A copy only — the shipped skill is not touched. */
export function builtinSkillFiles(id: string, dir: string = BUNDLED_SKILLS_DIR): { ok: true; files: SkillFile[] } | LibraryError {
  const r = readBundledSkill(id, dir);
  return r.ok ? { ok: true, files: [{ path: "SKILL.md", content: r.text }] } : fail("not_found");
}

/** Every team skill that can be read, in one archive. Refused when the whole would be too large to import again. */
export function allTeamSkillsArchive(store: LibraryStore): { ok: true; archive: Buffer; count: number } | LibraryError {
  const entries: ZipEntry[] = [];
  let total = 0, count = 0;
  for (const item of store.list()) {
    if (item.kind !== "skill" || item.status === "missing" || item.status === "invalid") continue;
    const r = teamSkillFiles(store, item.id);
    if (!r.ok) continue;
    count++;
    for (const f of [...r.files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
      const data = Buffer.from(f.content, "utf8");
      total += data.length;
      if (total > ZIP_LIMITS.totalBytes) return fail("too_large");
      entries.push({ name: `${item.id}/${f.path}`, data });
    }
  }
  if (!count) return fail("not_found");
  return { ok: true, archive: writeZip(entries), count };
}

// ── Reading a skill for display ────────────────────────────────────────

export interface SkillField { key: string; value: string }
const scalar = (v: unknown): string | null => (typeof v === "string" ? v.trim().slice(0, 1000) : typeof v === "number" || typeof v === "boolean" ? String(v) : null);
const FIRST = ["name", "description", "roles"];

/** A SKILL.md split for the page: its frontmatter as plain `key: value` fields (text only, bounded), and the Markdown after it. */
export function describeSkillText(text: string): { fields: SkillField[]; body: string } {
  const fm = parseSkillFrontmatter(text);
  if (!fm.ok) return { fields: [], body: text };
  const keys = Object.keys(fm.data).sort((a, b) => (FIRST.includes(a) ? FIRST.indexOf(a) : 99) - (FIRST.includes(b) ? FIRST.indexOf(b) : 99));
  const fields: SkillField[] = [];
  for (const key of keys.slice(0, 20)) {
    const v = fm.data[key];
    const value = Array.isArray(v) ? v.map(scalar).filter((x): x is string => x !== null).join(", ").slice(0, 1000) : scalar(v);
    if (value) fields.push({ key: key.slice(0, 64), value });
  }
  return { fields, body: fm.body };
}

// ── Import: reading an upload ──────────────────────────────────────────

/** One skill found in an upload, checked by the library's own rules (or why it is not usable). */
export type ImportCandidate =
  | { ok: true; id: string; description: string; files: SkillFile[] }
  | { ok: false; id: string; error: LibraryErrorCode; path?: string; detail?: string; findings?: SecretFinding[] };
export interface ParsedUpload { format: "zip" | "skill-md"; sha256: string; skills: ImportCandidate[]; /** Names left out (file-manager litter, files outside any skill). */ ignored: string[] }

const decode = (buf: Buffer): string | null => {
  if (buf.includes(0)) return null;
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buf); } catch { return null; }
};

/** The name a SKILL.md gives itself. */
function nameInside(text: string): string | null {
  const fm = parseSkillFrontmatter(text);
  return fm.ok && typeof fm.data.name === "string" ? fm.data.name : null;
}

function candidate(id: string, parts: ReadonlyArray<{ path: string; data: Buffer }>): ImportCandidate {
  const files: SkillFile[] = [];
  for (const p of parts) {
    const content = decode(p.data);
    if (content === null) return { ok: false, id, error: "not_text", path: p.path.slice(0, 160) };
    files.push({ path: p.path, content });
  }
  const v = validateSkill(id, files);
  if (!v.ok) return { ok: false, id, error: v.error, ...(v.path ? { path: v.path } : {}), ...(v.detail ? { detail: v.detail } : {}), ...(v.findings ? { findings: v.findings } : {}) };
  return { ok: true, id, description: v.meta.description, files: v.files };
}

/** An upload's bytes → the skills in it, each checked; or why the upload as a whole cannot be read. */
export function parseUpload(bytes: Buffer): { ok: true; upload: ParsedUpload } | LibraryError {
  const digest = sha256(bytes);
  if (!looksLikeZip(bytes)) {
    // A single SKILL.md: text, named by its own `name:`.
    if (bytes.length > LIBRARY_LIMITS.skillMdBytes) return fail("too_large", { path: "SKILL.md" });
    const text = decode(bytes);
    if (text === null) return fail("bad_archive", { detail: "format" });
    const name = nameInside(text);
    if (name === null) return fail("bad_frontmatter", { path: "SKILL.md" });
    const id = name.slice(0, 64);
    return { ok: true, upload: { format: "skill-md", sha256: digest, skills: [isLibraryId(name) ? candidate(id, [{ path: "SKILL.md", data: bytes }]) : { ok: false, id, error: "invalid_id" }], ignored: [] } };
  }
  const z = readZip(bytes);
  if (!z.ok) return fail(z.error, { ...(z.path ? { path: z.path } : {}), ...(z.detail ? { detail: z.detail } : {}) });
  const entries = z.entries;
  const ignored = [...z.ignored];
  if (!entries.length) return fail("no_skill");
  const skills: ImportCandidate[] = [];
  if (entries.some((e) => e.name === "SKILL.md")) {
    // The skill's files are at the top of the archive: it is named by its SKILL.md.
    const md = decode(entries.find((e) => e.name === "SKILL.md")!.data);
    const name = md === null ? null : nameInside(md);
    const id = (name ?? "").slice(0, 64);
    skills.push(name !== null && isLibraryId(name)
      ? candidate(id, entries.map((e) => ({ path: e.name, data: e.data })))
      : md === null ? { ok: false, id, error: "not_text", path: "SKILL.md" } : name === null ? { ok: false, id, error: "bad_frontmatter", path: "SKILL.md" } : { ok: false, id, error: "invalid_id" });
  } else {
    const groups = new Map<string, Array<{ path: string; data: Buffer }>>();
    for (const e of entries) {
      const slash = e.name.indexOf("/");
      if (slash < 0) { ignored.push(e.name.slice(0, 160)); continue; }
      const folder = e.name.slice(0, slash);
      if (!groups.has(folder)) groups.set(folder, []);
      groups.get(folder)!.push({ path: e.name.slice(slash + 1), data: e.data });
    }
    if (![...groups.values()].some((files) => files.some((f) => f.path === "SKILL.md"))) return fail("no_skill");
    if (groups.size > IMPORT_MAX_SKILLS) return fail("too_many_items");
    for (const [folder, files] of [...groups].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const shown = folder.slice(0, 64);
      skills.push(!isLibraryId(folder) ? { ok: false, id: shown, error: "invalid_id" }
        : files.some((f) => f.path === "SKILL.md") ? candidate(folder, files) : { ok: false, id: folder, error: "missing_skill_md" });
    }
  }
  return { ok: true, upload: { format: "zip", sha256: digest, skills, ignored } };
}

// ── Import: the preview ────────────────────────────────────────────────

/** `team`: the library already has a skill of that name. `builtin`: AgEnD ships one of that name (never replaced). */
export type ImportConflict = "none" | "team" | "builtin";
export interface PreviewSkill {
  id: string; ok: boolean; conflict: ImportConflict;
  description?: string; files?: Array<{ path: string; size: number }>; skillMd?: string; fields?: SkillField[];
  error?: LibraryErrorCode; path?: string; detail?: string; findings?: SecretFinding[];
}

/** The names a skill may clash with: the team's (on disk now) and the built-in ones. */
export function takenNames(store: LibraryStore, builtin: ReadonlySet<string>): { team: Set<string>; builtin: ReadonlySet<string> } {
  return { team: new Set(store.list().filter((i) => i.kind === "skill" && i.status !== "missing").map((i) => i.id)), builtin };
}

/** The names of the skills AgEnD ships. */
export const builtinSkillNames = (bundledDir?: string): Set<string> => new Set(listBundledSkills(bundledDir ?? BUNDLED_SKILLS_DIR).map((s) => s.name));

export function conflictOf(id: string, taken: { team: ReadonlySet<string>; builtin: ReadonlySet<string> }): ImportConflict {
  return taken.builtin.has(id) ? "builtin" : taken.team.has(id) ? "team" : "none";
}

/** What the admin reads before anything is stored: each skill's name, description, files and SKILL.md in full — a skill is instructions an AI will follow. */
export function previewUpload(upload: ParsedUpload, taken: { team: ReadonlySet<string>; builtin: ReadonlySet<string> }): { format: ParsedUpload["format"]; sha256: string; skills: PreviewSkill[]; ignored: string[] } {
  return {
    format: upload.format, sha256: upload.sha256, ignored: upload.ignored,
    skills: upload.skills.map((s): PreviewSkill => {
      const conflict = conflictOf(s.id, taken);
      if (!s.ok) return { id: s.id, ok: false, conflict, error: s.error, ...(s.path ? { path: s.path } : {}), ...(s.detail ? { detail: s.detail } : {}), ...(s.findings ? { findings: s.findings } : {}) };
      const md = s.files.find((f) => f.path === "SKILL.md")!.content;
      return { id: s.id, ok: true, conflict, description: s.description, skillMd: md, fields: describeSkillText(md).fields,
        files: s.files.map((f) => ({ path: f.path, size: Buffer.byteLength(f.content) })) };
    }),
  };
}

// ── Import: storing ────────────────────────────────────────────────────

/** What the admin chose for a skill that clashes (or, for one that does not, `skip`). `as`: the new name for `rename`. */
export interface ImportDecision { action: "add" | "overwrite" | "rename" | "skip"; as?: string }
export interface ImportOutcome {
  id: string;
  status: "imported" | "replaced" | "renamed" | "skipped" | "rejected";
  /** The name it was stored under (differs from `id` after a rename). */
  savedAs?: string;
  reason?: "undecided" | "builtin" | "chosen";
  error?: LibraryErrorCode; path?: string; detail?: string; findings?: SecretFinding[];
}

/** Gives the skill a new name: the `name:` line of its frontmatter (and nothing else) changes. Null when that line cannot be found. */
export function renameSkillFiles(files: ReadonlyArray<SkillFile>, id: string): SkillFile[] | null {
  const out: SkillFile[] = [];
  let done = false;
  for (const f of files) {
    if (f.path !== "SKILL.md") { out.push(f); continue; }
    const m = /^(---[ \t]*\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/.exec(f.content.replace(/^﻿/, ""));
    if (!m || !/^name[ \t]*:.*$/m.test(m[2]!)) return null;
    // A name that YAML would read as a number or a keyword is quoted, so it stays the text it is.
    const value = /^[0-9-]+$|^(?:true|false|null|yes|no|on|off|y|n)$/i.test(id) ? `"${id}"` : id;
    const lead = f.content.startsWith("﻿") ? "﻿" : "";
    out.push({ path: f.path, content: lead + m[1] + m[2]!.replace(/^name[ \t]*:.*$/m, `name: ${value}`) + m[3] + f.content.slice(lead.length + m[0].length) });
    done = true;
  }
  return done ? out : null;
}

/**
 * Stores what the admin approved. Each skill is saved on its own (atomically, by the store): one that is refused does not undo the
 * others. A clash with no decision is skipped, never overwritten; a built-in name is never replaced (rename or skip).
 */
export function applyImport(store: LibraryStore, skills: ReadonlyArray<ImportCandidate>, decisions: ReadonlyMap<string, ImportDecision>, builtin: ReadonlySet<string>, from?: string): ImportOutcome[] {
  const out: ImportOutcome[] = [];
  const source = { type: "import" as const, ...(from ? { from } : {}) };
  for (const s of skills) {
    if (!s.ok) { out.push({ id: s.id, status: "rejected", error: s.error, ...(s.path ? { path: s.path } : {}), ...(s.detail ? { detail: s.detail } : {}), ...(s.findings ? { findings: s.findings } : {}) }); continue; }
    const taken = takenNames(store, builtin);   // read again each time: an earlier skill of this upload may have taken the name
    const conflict = conflictOf(s.id, taken);
    const d = decisions.get(s.id);
    if (d?.action === "skip") { out.push({ id: s.id, status: "skipped", reason: "chosen" }); continue; }
    if (conflict !== "none" && !d) { out.push({ id: s.id, status: "skipped", reason: "undecided" }); continue; }
    if (d?.action === "overwrite" && conflict === "builtin") { out.push({ id: s.id, status: "rejected", error: "exists", reason: "builtin" }); continue; }
    if (d?.action === "rename") {
      const as = d.as;
      if (!isLibraryId(as)) { out.push({ id: s.id, status: "rejected", error: "invalid_id" }); continue; }
      if (conflictOf(as, taken) !== "none") { out.push({ id: s.id, status: "rejected", error: "exists", detail: as }); continue; }
      const renamed = renameSkillFiles(s.files, as);
      if (!renamed) { out.push({ id: s.id, status: "rejected", error: "bad_frontmatter", path: "SKILL.md" }); continue; }
      const r = store.addSkill(as, renamed, { source });
      out.push(r.ok ? { id: s.id, status: "renamed", savedAs: as } : { id: s.id, status: "rejected", error: r.error, ...(r.path ? { path: r.path } : {}), ...(r.detail ? { detail: r.detail } : {}), ...(r.findings ? { findings: r.findings } : {}) });
      continue;
    }
    const overwrite = conflict === "team" && d?.action === "overwrite";
    if (conflict === "team" && !overwrite) { out.push({ id: s.id, status: "skipped", reason: "undecided" }); continue; }
    if (conflict === "builtin") { out.push({ id: s.id, status: "rejected", error: "exists", reason: "builtin" }); continue; }
    const r = store.addSkill(s.id, s.files, { overwrite, source });
    out.push(r.ok ? { id: s.id, status: overwrite ? "replaced" : "imported", savedAs: s.id } : { id: s.id, status: "rejected", error: r.error, ...(r.path ? { path: r.path } : {}), ...(r.detail ? { detail: r.detail } : {}), ...(r.findings ? { findings: r.findings } : {}) });
  }
  return out;
}
