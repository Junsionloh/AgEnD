/**
 * AGEND-244: mounting library Skills into an agent's skills folder.
 *
 * An agent's `library.skills` (fleet.yaml `instances.<name>.library.skills`, set by an administrator only) lists library skill ids.
 * `syncLibrarySkills` publishes them into the folder the agent's CLI reads (`.claude/skills`, `.agents/skills`, …) the way AgEnD's
 * bundled skills are published (`syncManagedSkills` in fleet-manager.ts) — with its OWN ownership record, so the two never touch
 * each other:
 *
 *  - the record is `.agend-library-skills.json` beside the bundled one (`.agend-managed-skills.json`, never read or written here);
 *  - who wins a name: the person's own folder > a bundled skill > a library skill. A folder that exists and is not in the record
 *    is the person's and is left alone; a bundled skill's name is reserved (the library skill is skipped, not published);
 *  - un-mounting removes only the folders listed in the record, and only one that is still exactly what was written (the record
 *    keeps its hash): a folder the person edited or replaced is theirs — not overwritten, not removed;
 *  - a folder that never had a mount gets nothing: no mount and no record → no file, no folder is touched.
 *
 * A skill is published only when it passes every library rule AND matches the hash the library's lock recorded (LibraryStore.
 * skillForMount), so a hand-edited or hand-placed item is not handed to an agent until someone saves it in the Library.
 */
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { atomicWriteFileSync } from "../atomic-write.js";
import { LIBRARY_LIMITS, isLibraryId, normalizeMount, type SkillFile } from "./schema.js";
import { hashSkill, type LibraryStore } from "./store.js";

export const LIBRARY_SKILLS_MANIFEST = ".agend-library-skills.json";
const MANIFEST_VERSION = 1;

/** Why a mounted skill was not published. */
export type SkippedReason = "user-owned" | "bundled" | "not_found" | "invalid" | "untracked" | "modified";
export interface LibrarySkillsResult {
  /** Ids whose folder now holds the library's content (written, or already identical). */
  published: string[];
  skipped: Array<{ id: string; reason: SkippedReason }>;
  /** Ids whose folder was removed because they are no longer mounted (or the library item is gone). */
  removed: string[];
  /** Ids that left the record but whose folder stays: the person changed it, so it is theirs. */
  kept: string[];
}

const sha = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

interface Record1 { sha256: string }

/** The ids this record owns. A record that is missing, corrupt or of another shape owns nothing; an id that is not one never counts. */
function readManifest(path: string): Map<string, Record1> {
  const owned = new Map<string, Record1>();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as { skills?: unknown };
    if (parsed && typeof parsed === "object" && parsed.skills && typeof parsed.skills === "object" && !Array.isArray(parsed.skills)) {
      for (const [id, e] of Object.entries(parsed.skills as Record<string, unknown>)) {
        const h = e && typeof e === "object" ? (e as { sha256?: unknown }).sha256 : undefined;
        if (isLibraryId(id) && typeof h === "string" && /^[0-9a-f]{64}$/.test(h)) owned.set(id, { sha256: h });
      }
    }
  } catch { /* none yet, or unreadable: owns nothing */ }
  return owned;
}

function exists(path: string): boolean { try { lstatSync(path); return true; } catch { return false; } }

/** The hash of what a folder holds now (same rule as the library's), or null if it holds anything else than plain files and folders. */
function hashFolder(dir: string): string | null {
  const files: Array<{ path: string; sha256: string }> = [];
  const walk = (rel: string): boolean => {
    let names: string[];
    try { names = readdirSync(rel ? join(dir, rel) : dir); } catch { return false; }
    for (const name of names) {
      const relPath = rel ? `${rel}/${name}` : name;
      const abs = join(dir, relPath);
      let st;
      try { st = lstatSync(abs); } catch { return false; }
      if (st.isSymbolicLink()) return false;
      if (st.isDirectory()) { if (!walk(relPath)) return false; continue; }
      if (!st.isFile() || files.length >= LIBRARY_LIMITS.skillFiles || st.size > LIBRARY_LIMITS.skillFileBytes) return false;
      try { files.push({ path: relPath, sha256: sha(readFileSync(abs)) }); } catch { return false; }
    }
    return true;
  };
  return walk("") ? hashSkill(files) : null;
}

/** Replaces (or creates) `<dest>/<id>` with exactly `files`: built beside it under a hidden name, then renamed in. */
function writeSkillFolder(dest: string, id: string, files: SkillFile[]): void {
  const tag = randomBytes(4).toString("hex");
  const temp = join(dest, `.agend-lib-tmp-${id}-${tag}`);
  const old = join(dest, `.agend-lib-old-${id}-${tag}`);
  const target = join(dest, id);
  let moved = false;
  try {
    for (const f of files) {
      const abs = join(temp, ...f.path.split("/"));
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, f.content, { flag: "wx" });
    }
    if (exists(target)) { renameSync(target, old); moved = true; }
    renameSync(temp, target);
  } catch (err) {
    try { rmSync(temp, { recursive: true, force: true }); } catch { /* best effort */ }
    if (moved) { try { renameSync(old, target); } catch { /* the old copy stays under its hidden name */ } }
    throw err;
  }
  if (moved) { try { rmSync(old, { recursive: true, force: true }); } catch { /* a hidden leftover is harmless */ } }
}

export interface SyncLibrarySkillsInput {
  /** The CLI's skills folder (`<workspace>/.claude/skills`, …). */
  destSkills: string;
  /** The library skill ids to publish there (union over every agent that shares this folder). */
  mount: readonly string[];
  store: LibraryStore;
  /** Names of the bundled skills: reserved, a library skill of the same name is never published. */
  reserved: ReadonlySet<string>;
}

/** See the file's header. Throws nothing the caller must handle except a write failure on the folder itself. */
export function syncLibrarySkills(input: SyncLibrarySkillsInput): LibrarySkillsResult {
  const { destSkills, store, reserved } = input;
  const mount = normalizeMount([...input.mount]);
  const result: LibrarySkillsResult = { published: [], skipped: [], removed: [], kept: [] };
  const manifestPath = join(destSkills, LIBRARY_SKILLS_MANIFEST);
  // Nothing mounted and nothing ever published here: not one file or folder is created, read or changed.
  if (mount.length === 0 && !exists(manifestPath)) return result;

  const owned = readManifest(manifestPath);
  const next = new Map<string, Record1>();

  for (const id of mount) {
    const folder = join(destSkills, id);
    const rec = owned.get(id);
    // A bundled skill's name is reserved. If a copy of ours is there from before the name was taken, it goes below.
    if (reserved.has(id)) { result.skipped.push({ id, reason: "bundled" }); continue; }
    // The person's own folder (anything there that is not in our record) always wins, untouched.
    const present = exists(folder);
    if (!rec && present) { result.skipped.push({ id, reason: "user-owned" }); continue; }
    // A copy of ours is only ours while it is still what we wrote (the record's hash). One the person edited, or replaced with a
    // folder of their own under the same name, is theirs now: not overwritten, not removed. It stays listed while the skill is
    // mounted, so it is managed again if it is put back exactly as it was.
    const current = present ? hashFolder(folder) : null;
    if (rec && present && current !== rec.sha256) { result.skipped.push({ id, reason: "modified" }); next.set(id, rec); continue; }
    const item = store.skillForMount(id);
    if (!item.ok) {
      result.skipped.push({ id, reason: item.reason });
      // The library lost the item: the published copy goes with it (below). An item that cannot be trusted right now (hand-edited,
      // breaks a rule) leaves the copy already published as it is — not updated, not removed.
      if (rec && item.reason !== "not_found") next.set(id, rec);
      continue;
    }
    if (!(present && current === item.sha256)) {
      mkdirSync(destSkills, { recursive: true });
      writeSkillFolder(destSkills, id, item.files);
    }
    next.set(id, { sha256: item.sha256 });
    result.published.push(id);
  }

  // Only what the record lists is ever removed — and only a folder that is still exactly what was written. No longer mounted, now
  // reserved by a bundled skill, or gone from the library: an untouched copy is removed; one the person changed is left where it
  // is (and leaves the record).
  for (const [id, rec] of owned) {
    if (next.has(id)) continue;
    const folder = join(destSkills, id);
    if (exists(folder) && hashFolder(folder) !== rec.sha256) { result.kept.push(id); continue; }
    try {
      rmSync(folder, { recursive: true, force: true });
      result.removed.push(id);
    } catch {
      next.set(id, rec);   // still there: stays listed, tried again at the next start
    }
  }

  const same = next.size === owned.size && [...next].every(([id, e]) => owned.get(id)?.sha256 === e.sha256);
  if (!same || (next.size > 0 && !exists(manifestPath))) {
    if (next.size === 0) { try { rmSync(manifestPath, { force: true }); } catch { /* an empty record is harmless */ } }
    else {
      const skills: Record<string, Record1> = {};
      for (const id of [...next.keys()].sort()) skills[id] = next.get(id)!;
      atomicWriteFileSync(manifestPath, `${JSON.stringify({ version: MANIFEST_VERSION, skills }, null, 2)}\n`);
    }
  }
  return result;
}

/**
 * Read-only: which agents are given which library skill, from the fleet's `instances` — `{ skillId: [agent names, sorted] }`, only for ids
 * that are mounted somewhere. This is the one place that says who uses an item, for the overview page to read. It looks at the
 * setting only (what an administrator mounted), not at what has been published: a Windows native agent is left out (no skills
 * folder to publish into). Nothing is read from disk and nothing is changed.
 */
export function librarySkillUsage(instances: Record<string, { library?: { skills?: unknown }; runtime?: string } | null | undefined> | null | undefined): Record<string, string[]> {
  // No prototype: an id like `constructor` is a valid library id.
  const usage: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  for (const name of Object.keys(instances ?? {}).sort()) {
    const def = instances![name];
    if (!def || def.runtime === "windows") continue;
    for (const id of normalizeMount(def.library?.skills)) (usage[id] ??= []).push(name);
  }
  return usage;
}
