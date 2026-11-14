/**
 * AGEND-245: the `library` block of an agent's export file (`agend_export: 1`, src/agent-export.ts) — what it holds, and how it is read. PURE: no
 * file, no network, no store; reading a file never touches the Library (src/library/agent-transfer.ts compares and writes, on the admin's say).
 *
 * PROVISIONAL FORMAT. Upstream #3638 reserved `library: { skills: [], mcp: [] }` and defined nothing inside it (checked against upstream main and
 * release/2.3.5-alpha when this was written), so these elements are this fork's proposal and may change if upstream defines its own:
 *
 *   library:
 *     skills:                       # every skill the agent has assigned (on or paused), by id
 *       - id: ui-review
 *         sha256: <64 hex>          # the Library's hash of that skill (hashSkill: paths + content hashes)
 *         source: { type: import, from: ui-review.zip }     # optional: where the exporter got it
 *         archive: <base64>         # optional, "bundled": the skill as a ZIP (`<id>/SKILL.md` + files — the same bytes the Library's export writes)
 *     mcp:
 *       - id: github
 *         sha256: <64 hex>          # the hash of the item's file
 *         vars: [MCP_GITHUB_TOKEN]  # the .env variable NAMES it needs — only `MCP_…` names, never a value
 *         definition: |             # optional, "bundled": the item's YAML (the Library's own file: command / address, variable names)
 *     paused: { skills: [id], mcp: [id] }   # the ones of the two lists above that are switched off (the agent's `library.paused`)
 *
 * The version stays `agend_export: 1`: a reader that does not know an element skips it with a reason, as it does any unknown key.
 */
import { LIBRARY_LIMITS, isLibraryId, isMcpVariable } from "./schema.js";
import { scanForSecrets, type SecretFinding } from "../secret-scan.js";

/** The most entries of each list a file may carry. */
export const EXPORT_LIBRARY_MAX_ENTRIES = 100;
/** The most the bundled definitions of a file may add up to, in characters (the file as a whole may be 200,000). */
export const EXPORT_LIBRARY_EMBED_CHARS = 120_000;

export interface ExportSkill { id: string; sha256: string; source?: { type: "import"; from?: string }; archive?: string }
export interface ExportMcp { id: string; sha256: string; vars: string[]; definition?: string }
export interface ExportLibrary { skills: ExportSkill[]; mcp: ExportMcp[]; paused: { skills: string[]; mcp: string[] } }

export type LibrarySkipReason = "unknown" | "badValue" | "tooLong";
export type LibrarySkip = (path: string, reason: LibrarySkipReason) => void;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const SHA_RE = /^[0-9a-f]{64}$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const FROM_MAX = 120;

export const emptyExportLibrary = (): ExportLibrary => ({ skills: [], mcp: [], paused: { skills: [], mcp: [] } });
export const libraryEntryCount = (l: ExportLibrary): number => l.skills.length + l.mcp.length;

/**
 * Reads a file's `library` value: the entries that are well formed, and for every part that is not, a skip with its path. An entry is taken whole or
 * not at all (a half-read entry could mean a different item). Ids are the Library's own rule; variable names are `MCP_…` only.
 */
export function readLibraryBlock(lib: unknown, skip: LibrarySkip): ExportLibrary {
  const out = emptyExportLibrary();
  if (lib === undefined || lib === null) return out;
  if (!isObj(lib)) { skip("library", "badValue"); return out; }
  let embedded = 0;
  for (const key of Object.keys(lib)) {
    if (key !== "skills" && key !== "mcp" && key !== "paused") { skip(`library.${key}`, "unknown"); continue; }
    if (key === "paused") continue;                // read after the lists: it may only name what they list
    const list = lib[key];
    if (!Array.isArray(list)) { skip(`library.${key}`, "badValue"); continue; }
    if (list.length > EXPORT_LIBRARY_MAX_ENTRIES) { skip(`library.${key}`, "tooLong"); continue; }
    const seen = new Set<string>();
    list.forEach((raw, i) => {
      const path = `library.${key}[${i}]`;
      if (!isObj(raw)) { skip(path, "badValue"); return; }
      const allowed = key === "skills" ? ["id", "sha256", "source", "archive"] : ["id", "sha256", "vars", "definition"];
      for (const k of Object.keys(raw)) if (!allowed.includes(k)) skip(`${path}.${k}`, "unknown");
      if (!isLibraryId(raw.id) || typeof raw.sha256 !== "string" || !SHA_RE.test(raw.sha256)) { skip(path, "badValue"); return; }
      if (seen.has(raw.id)) { skip(path, "badValue"); return; }
      if (key === "skills") {
        const entry: ExportSkill = { id: raw.id, sha256: raw.sha256 };
        if (raw.source !== undefined) {
          const s = raw.source;
          const from = isObj(s) && typeof s.from === "string" ? s.from : undefined;
          if (!isObj(s) || s.type !== "import" || (s.from !== undefined && (from === undefined || from.length > FROM_MAX || /[\u0000-\u001f\u007f]/.test(from)))) { skip(`${path}.source`, "badValue"); }
          else entry.source = { type: "import", ...(from ? { from } : {}) };
        }
        if (raw.archive !== undefined) {
          if (typeof raw.archive !== "string" || !BASE64_RE.test(raw.archive) || raw.archive.length % 4 !== 0) skip(`${path}.archive`, "badValue");
          else if ((embedded += raw.archive.length) > EXPORT_LIBRARY_EMBED_CHARS) skip(`${path}.archive`, "tooLong");
          else entry.archive = raw.archive;
        }
        seen.add(raw.id); out.skills.push(entry);
      } else {
        // Only variable NAMES, and only `MCP_…` ones: a file that names anything else is not read for this entry.
        if (!Array.isArray(raw.vars) || raw.vars.length > LIBRARY_LIMITS.mcpEnv * 2 || !raw.vars.every((n) => isMcpVariable(n)) || new Set(raw.vars).size !== raw.vars.length) { skip(`${path}.vars`, "badValue"); skip(path, "badValue"); return; }
        const entry: ExportMcp = { id: raw.id, sha256: raw.sha256, vars: [...(raw.vars as string[])] };
        if (raw.definition !== undefined) {
          if (typeof raw.definition !== "string" || !raw.definition.trim()) skip(`${path}.definition`, "badValue");
          else if (raw.definition.length > LIBRARY_LIMITS.mcpBytes) skip(`${path}.definition`, "tooLong");
          else if ((embedded += raw.definition.length) > EXPORT_LIBRARY_EMBED_CHARS) skip(`${path}.definition`, "tooLong");
          else entry.definition = raw.definition;
        }
        seen.add(raw.id); out.mcp.push(entry);
      }
    });
  }
  if (lib.paused !== undefined) {
    if (!isObj(lib.paused)) skip("library.paused", "badValue");
    else {
      for (const key of Object.keys(lib.paused)) {
        if (key !== "skills" && key !== "mcp") { skip(`library.paused.${key}`, "unknown"); continue; }
        const ids = lib.paused[key];
        const listed = new Set((key === "skills" ? out.skills : out.mcp).map((e) => e.id));
        // A paused id must be one the file lists (it is "assigned but switched off"), once.
        if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string" && listed.has(id)) || new Set(ids).size !== ids.length) skip(`library.paused.${key}`, "badValue");
        else out.paused[key] = [...(ids as string[])];
      }
    }
  }
  return out;
}

/** The value written under `library:`. With nothing in it, exactly the reserved `{ skills: [], mcp: [] }` an export always wrote. */
export function libraryBlockOf(l: ExportLibrary): Record<string, unknown> {
  const block: Record<string, unknown> = {
    skills: l.skills.map((s) => ({ id: s.id, sha256: s.sha256, ...(s.source ? { source: s.source } : {}), ...(s.archive ? { archive: s.archive } : {}) })),
    mcp: l.mcp.map((m) => ({ id: m.id, sha256: m.sha256, vars: m.vars, ...(m.definition ? { definition: m.definition } : {}) })),
  };
  if (l.paused.skills.length || l.paused.mcp.length) block.paused = { ...(l.paused.skills.length ? { skills: l.paused.skills } : {}), ...(l.paused.mcp.length ? { mcp: l.paused.mcp } : {}) };
  return block;
}

/**
 * The secret scan over the `library` block's own text, as the export applies it to every other part of the file: ids, hashes, variable names and the
 * `source`. What the block carries as payload is scanned by whoever builds it, from the parts a text scan can read — a bundled skill by its files (a
 * base64 archive says nothing to a text scan), a bundled MCP definition the way the Library scans an item (description, command, arguments, address:
 * its `env` / `headers` hold variable NAMES, which the patterns would mistake for a value). A hit means nothing is offered to copy or download.
 */
export function scanLibraryBlock(l: ExportLibrary): SecretFinding[] {
  const found: SecretFinding[] = [];
  l.skills.forEach((s, i) => found.push(...scanForSecrets(`library.skills[${i}]`, [s.id, s.sha256, s.source?.from ?? ""].join("\n"))));
  l.mcp.forEach((m, i) => found.push(...scanForSecrets(`library.mcp[${i}]`, [m.id, m.sha256, ...m.vars].join("\n"))));
  return found;
}
