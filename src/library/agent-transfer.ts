/**
 * AGEND-245: an agent's export / import and the Library — the three steps that need the Library's files (export-format.ts is the pure part):
 *
 *   1. `resolveLibraryExport`  — export: the skills and MCP servers the agent has assigned, as the file's `library` entries (a reference each: id and
 *                                hash; optionally the definition bundled). Reads the Library, writes nothing. Only an item that is `ok` there (the version
 *                                the Library recorded, the one an agent would actually be given) is exported; MCP variable VALUES are never read.
 *   2. `compareLibrary`        — import, the preview: each entry against this computer's Library — present / differs / missing-embedded / missing — with
 *                                what an administrator needs to read before agreeing (a skill's SKILL.md, an MCP server's whole command and variable names).
 *                                Reads only.
 *   3. `applyLibrary`          — import, on the administrator's explicit choices: stores what they chose to add (never overwriting a local item), records
 *                                the MCP confirmation they gave for exactly the version they were shown, and answers with the ids the agent's FORM may now
 *                                take. It changes no agent setting: the form is filled and Save is the Settings page's own.
 */
import { createHash } from "node:crypto";
import type { SecretFinding } from "../secret-scan.js";
import { scanForSecrets } from "../secret-scan.js";
import { isLibraryId, normalizeMount, stringifyMcp, validateMcpText, type McpItem, type SkillFile } from "./schema.js";
import { LibraryStore, hashSkill, type LibraryItemSummary } from "./store.js";
import {
  conflictOf, describeSkillText, parseUpload, renameSkillFiles, skillArchive, takenNames, teamSkillFiles, type SkillField,
} from "./transfer.js";
import { McpConfirmations, envNamesSet, mcpSummary, mcpVariables, type McpSummary } from "./mcp-mount.js";
import {
  EXPORT_LIBRARY_EMBED_CHARS, emptyExportLibrary, scanLibraryBlock, type ExportLibrary, type ExportMcp, type ExportSkill,
} from "./export-format.js";

const sha256Of = (v: string | Buffer): string => createHash("sha256").update(v).digest("hex");

// ── 1. Export ──────────────────────────────────────────────────────────

export type LibraryOmitReason = "gone" | "notReady" | "tooBigToEmbed";
export interface LibraryOmission { kind: "skill" | "mcp"; id: string; reason: LibraryOmitReason }
export interface LibraryExportOptions { skills: boolean; mcp: boolean; /** Bundle the definitions into the file (default: references only). */ embed: boolean }
export interface LibraryExportResult {
  library: ExportLibrary;
  /** What the agent has assigned but the file does not carry (or carries without its definition), and why. */
  omitted: LibraryOmission[];
  findings: SecretFinding[];
  /** How many of each the agent has assigned (on or paused), whatever was chosen — for the dialog's counts. */
  assigned: { skills: number; mcp: number };
}

/** The ids an agent's `library` setting assigns, on and then paused (an id is in one list or the other). */
export function assignedIds(setting: unknown, kind: "skills" | "mcp"): { all: string[]; paused: Set<string> } {
  const s = setting && typeof setting === "object" && !Array.isArray(setting) ? (setting as Record<string, unknown>) : {};
  const p = s.paused && typeof s.paused === "object" && !Array.isArray(s.paused) ? (s.paused as Record<string, unknown>) : {};
  const on = normalizeMount(s[kind]);
  const off = normalizeMount(p[kind]).filter((id) => !on.includes(id));
  return { all: [...on, ...off], paused: new Set(off) };
}

const sourceOf = (item: LibraryItemSummary): ExportSkill["source"] | undefined => {
  const s = item.source;
  if (!s || s.type !== "import") return undefined;
  const from = typeof s.from === "string" && s.from.length <= 120 && !/[\u0000-\u001f\u007f]/.test(s.from) ? s.from : undefined;
  return { type: "import", ...(from ? { from } : {}) };
};

/** The text parts of an MCP item a secret scan reads (its variable names are not a value). */
export const mcpScanParts = (item: McpItem): string[] => [item.description, item.command, ...(item.args ?? []), item.url].filter((v): v is string => !!v);

/** Export: the agent's assigned Library items as the file's `library` block. Reads the Library; the `.env` is never opened. */
export function resolveLibraryExport(store: LibraryStore, setting: unknown, opts: LibraryExportOptions): LibraryExportResult {
  const skills = assignedIds(setting, "skills"), mcp = assignedIds(setting, "mcp");
  const library = emptyExportLibrary();
  const omitted: LibraryOmission[] = [];
  const findings: SecretFinding[] = [];
  const assigned = { skills: skills.all.length, mcp: mcp.all.length };
  if (!opts.skills && !opts.mcp) return { library, omitted, findings, assigned };
  const listed = new Map(store.list().map((i) => [`${i.kind}:${i.id}`, i]));
  let embedded = 0;
  // A bundled definition counts against one budget, so the file stays within what the loader reads; an item that does not fit goes as a reference.
  const fits = (n: number): boolean => embedded + n <= EXPORT_LIBRARY_EMBED_CHARS;
  const unusable = (item: LibraryItemSummary | undefined): LibraryOmitReason | null => (!item || item.status === "missing" ? "gone" : item.status !== "ok" ? "notReady" : null);

  if (opts.skills) {
    for (const id of skills.all) {
      const item = listed.get(`skill:${id}`);
      const bad = unusable(item);
      if (bad || !item?.sha256) { omitted.push({ kind: "skill", id, reason: bad ?? "notReady" }); continue; }
      const entry: ExportSkill = { id, sha256: item.sha256 };
      const source = sourceOf(item);
      if (source) entry.source = source;
      if (opts.embed) {
        const files = teamSkillFiles(store, id);
        if (!files.ok) { omitted.push({ kind: "skill", id, reason: "notReady" }); continue; }
        for (const f of files.files) findings.push(...scanForSecrets(`library.skills.${id}/${f.path}`, f.content));
        const archive = skillArchive(id, files.files).toString("base64");
        if (fits(archive.length)) { entry.archive = archive; embedded += archive.length; } else omitted.push({ kind: "skill", id, reason: "tooBigToEmbed" });
      }
      library.skills.push(entry);
      if (skills.paused.has(id)) library.paused.skills.push(id);
    }
  }
  if (opts.mcp) {
    for (const id of mcp.all) {
      const item = listed.get(`mcp:${id}`);
      const bad = unusable(item);
      const got = bad ? null : store.get("mcp", id);
      if (bad || !got || !got.ok || got.detail.kind !== "mcp") { omitted.push({ kind: "mcp", id, reason: bad ?? "notReady" }); continue; }
      const detail = got.detail;
      // Variable NAMES only (every one starts with MCP_: the Library refuses an item that names anything else); a value is never read here.
      const entry: ExportMcp = { id, sha256: detail.sha256, vars: mcpVariables(detail.item) };
      if (opts.embed) {
        findings.push(...scanForSecrets(`library.mcp.${id}`, mcpScanParts(detail.item).join("\n")));
        if (fits(detail.text.length)) { entry.definition = detail.text; embedded += detail.text.length; } else omitted.push({ kind: "mcp", id, reason: "tooBigToEmbed" });
      }
      library.mcp.push(entry);
      if (mcp.paused.has(id)) library.paused.mcp.push(id);
    }
  }
  findings.push(...scanLibraryBlock(library));
  return { library, omitted, findings, assigned };
}

// ── 2. Import: the preview ─────────────────────────────────────────────

/** `present`: this computer's Library has that exact version. `differs`: it has the id, another version (never overwritten). `missing-embedded`: it has
 *  not, and the file carries the definition. `missing`: it has not, and the file only refers to it. */
export type ImportStatus = "present" | "differs" | "missing-embedded" | "missing";

export interface SkillView { description: string; skillMd: string; fields: SkillField[]; files: Array<{ path: string; size: number }> }
export type EmbeddedProblem = "bad_archive" | "mismatch" | "hash" | "builtin" | "invalid" | "bad_definition";
export interface McpView {
  description: string; sha256: string; summary: McpSummary;
  variables: Array<{ name: string; set: boolean; as: Array<{ name: string; kind: "env" | "header" }> }>;
}
export interface SkillImportRow {
  id: string; status: ImportStatus; paused: boolean; sha256: string; source?: ExportSkill["source"];
  /** The Library's version of it on this computer (when it has the id): its hash, and whether an agent could be given it as it is. */
  local?: { sha256: string; description: string; ready: boolean };
  embedded?: ({ ok: true; sha256: string } & SkillView) | { ok: false; problem: EmbeddedProblem };
}
export interface McpImportRow {
  id: string; status: ImportStatus; paused: boolean; sha256: string;
  /** The names the file says it needs, with whether `.env` here has a value (never the value). */
  vars: Array<{ name: string; set: boolean }>;
  local?: { ready: boolean; badVars?: string[] } & Partial<McpView> & { sha256: string };
  embedded?: ({ ok: true } & McpView) | { ok: false; problem: EmbeddedProblem };
}
export interface LibraryImportView { skills: SkillImportRow[]; mcp: McpImportRow[] }

const skillView = (files: SkillFile[], description: string): SkillView => {
  const md = files.find((f) => f.path === "SKILL.md")?.content ?? "";
  return { description, skillMd: md, fields: describeSkillText(md).fields, files: files.map((f) => ({ path: f.path, size: Buffer.byteLength(f.content) })) };
};

/** An embedded skill: the archive read with the Library's own rules, the one skill in it, the hash the file declared. */
function readEmbeddedSkill(entry: ExportSkill, builtin: ReadonlySet<string>): { ok: true; files: SkillFile[]; description: string; sha256: string } | { ok: false; problem: EmbeddedProblem } {
  if (!entry.archive) return { ok: false, problem: "bad_archive" };
  const parsed = parseUpload(Buffer.from(entry.archive, "base64"));
  if (!parsed.ok) return { ok: false, problem: "bad_archive" };
  const only = parsed.upload.skills;
  if (only.length !== 1) return { ok: false, problem: "mismatch" };
  const s = only[0]!;
  if (!s.ok) return { ok: false, problem: "invalid" };
  if (s.id !== entry.id) return { ok: false, problem: "mismatch" };
  if (builtin.has(s.id)) return { ok: false, problem: "builtin" };
  const sha256 = hashSkill(s.files.map((f) => ({ path: f.path, sha256: sha256Of(f.content) })));
  if (sha256 !== entry.sha256) return { ok: false, problem: "hash" };
  return { ok: true, files: s.files, description: s.description, sha256 };
}

/** An embedded MCP definition: read with the Library's own rules (secret scan, `MCP_` names), named as its entry, the hash the file declared. */
function readEmbeddedMcp(entry: ExportMcp): { ok: true; item: McpItem; text: string; sha256: string } | { ok: false; problem: EmbeddedProblem } {
  if (!entry.definition) return { ok: false, problem: "bad_definition" };
  const v = validateMcpText(entry.id, entry.definition);
  if (!v.ok) return { ok: false, problem: v.error === "name_mismatch" ? "mismatch" : "invalid" };
  const sha256 = sha256Of(v.text);
  if (sha256 !== entry.sha256) return { ok: false, problem: "hash" };
  return { ok: true, item: v.item, text: v.text, sha256 };
}

const mcpViewOf = (item: McpItem, sha256: string, set: ReadonlySet<string>): McpView => {
  const summary = mcpSummary(item);
  return { description: item.description ?? "", sha256, summary,
    variables: summary.variables.map((name) => ({ name, set: set.has(name), as: summary.uses.filter((u) => u.variable === name).map((u) => ({ name: u.as, kind: u.kind })) })) };
};

export interface CompareHost { envPath: string; builtin: ReadonlySet<string> }

/** Each entry of a file's `library` against this computer's Library. Reads only. */
export function compareLibrary(store: LibraryStore, lib: ExportLibrary, host: CompareHost): LibraryImportView {
  const listed = new Map(store.list().map((i) => [`${i.kind}:${i.id}`, i]));
  const out: LibraryImportView = { skills: [], mcp: [] };
  for (const entry of lib.skills) {
    const local = listed.get(`skill:${entry.id}`);
    const have = local && local.status !== "missing" ? local : undefined;
    const embedded = entry.archive ? readEmbeddedSkill(entry, host.builtin) : undefined;
    const row: SkillImportRow = { id: entry.id, status: "missing", paused: lib.paused.skills.includes(entry.id), sha256: entry.sha256, ...(entry.source ? { source: entry.source } : {}) };
    if (have) {
      const ok = have.status === "ok" && !!have.sha256;
      row.local = { sha256: have.sha256 ?? "", description: have.description, ready: ok };
      row.status = have.sha256 === entry.sha256 ? "present" : "differs";
    } else row.status = embedded?.ok ? "missing-embedded" : "missing";
    if (embedded) row.embedded = embedded.ok ? { ok: true, sha256: embedded.sha256, ...skillView(embedded.files, embedded.description) } : embedded;
    out.skills.push(row);
  }
  const names = [...new Set(lib.mcp.flatMap((m) => m.vars))];
  const set = envNamesSet(host.envPath, names);
  for (const entry of lib.mcp) {
    const local = listed.get(`mcp:${entry.id}`);
    const have = local && local.status !== "missing" ? local : undefined;
    const embedded = entry.definition ? readEmbeddedMcp(entry) : undefined;
    const row: McpImportRow = { id: entry.id, status: "missing", paused: lib.paused.mcp.includes(entry.id), sha256: entry.sha256, vars: entry.vars.map((name) => ({ name, set: set.has(name) })) };
    if (have) {
      const got = store.mcpForMount(entry.id);
      const view = got.ok ? mcpViewOf(got.item, got.sha256, envNamesSet(host.envPath, mcpVariables(got.item))) : undefined;
      row.local = { sha256: have.sha256 ?? "", ready: got.ok, ...(view ?? {}), ...(!got.ok && got.reason === "bad_vars" ? { badVars: got.names } : {}) };
      row.status = have.sha256 === entry.sha256 ? "present" : "differs";
    } else row.status = embedded?.ok ? "missing-embedded" : "missing";
    if (embedded) row.embedded = embedded.ok ? { ok: true, ...mcpViewOf(embedded.item, embedded.sha256, envNamesSet(host.envPath, mcpVariables(embedded.item))) } : embedded;
    out.mcp.push(row);
  }
  return out;
}

// ── 3. Import: applying the administrator's choices ────────────────────

/** `use`: this computer's version. `add`: store the bundled one (an id this Library does not have). `rename`: store the bundled one under `as`. `skip`. */
export interface ImportChoice {
  action: "use" | "add" | "rename" | "skip";
  /** The new id for `rename`. */
  as?: string;
  /** MCP: the administrator confirmed this exact version (its hash as they were shown it). Required for every action but `skip`. */
  confirm?: string;
}
export interface LibraryChoices { skills: Record<string, ImportChoice>; mcp: Record<string, ImportChoice> }

export type ApplyReason = "chosen" | "undecided" | "missing" | "changed" | "unconfirmed" | "notReady" | "exists" | "invalid" | "builtin" | "bad_id" | "embedded";
export interface ApplyOutcome { id: string; outcome: "used" | "added" | "renamed" | "skipped" | "failed"; savedAs?: string; reason?: ApplyReason }
/** The ids the agent's form may take: `on` and `paused` (a paused one is assigned but switched off), under the names they now have in the Library. */
export interface MountIds { on: string[]; paused: string[] }
export interface LibraryApplyResult { skills: ApplyOutcome[]; mcp: ApplyOutcome[]; mounts: { skills: MountIds; mcp: MountIds } }

export interface ApplyHost extends CompareHost { agent: string }

/**
 * Stores and confirms what the administrator chose, one item at a time (one that fails does not undo the others). A local item is NEVER overwritten: a
 * different version is used as it is or the bundled one is saved under another id. An MCP server is only ever used, added or renamed with its hash in
 * `confirm` — the version the person was shown — and that hash is checked again here; the confirmation is recorded for this agent at that version.
 */
export function applyLibrary(store: LibraryStore, lib: ExportLibrary, choices: LibraryChoices, host: ApplyHost): LibraryApplyResult {
  const view = compareLibrary(store, lib, host);
  const out: LibraryApplyResult = { skills: [], mcp: [], mounts: { skills: { on: [], paused: [] }, mcp: { on: [], paused: [] } } };
  const take = (kind: "skills" | "mcp", row: { id: string; paused: boolean }, id: string): void => {
    const into = out.mounts[kind];
    (row.paused ? into.paused : into.on).push(id);
  };
  const entryOf = <T extends { id: string }>(list: T[], id: string): T => list.find((e) => e.id === id)!;

  for (const row of view.skills) {
    const choice = Object.hasOwn(choices.skills, row.id) ? choices.skills[row.id]! : undefined;
    const done = (o: Omit<ApplyOutcome, "id">): void => { out.skills.push({ id: row.id, ...o }); };
    if (row.status === "missing") { done({ outcome: "skipped", reason: "missing" }); continue; }
    if (!choice) { done({ outcome: "skipped", reason: "undecided" }); continue; }
    if (choice.action === "skip") { done({ outcome: "skipped", reason: "chosen" }); continue; }
    if (choice.action === "use") {
      if (!row.local) { done({ outcome: "failed", reason: "missing" }); continue; }
      // Present (or the local version the person chose): it must still be one an agent can be given.
      if (!row.local.ready) { done({ outcome: "failed", reason: "notReady" }); continue; }
      take("skills", row, row.id); done({ outcome: "used", savedAs: row.id }); continue;
    }
    // add / rename: store the bundled skill; the Library's own rules run again inside addSkill.
    const emb = readEmbeddedSkill(entryOf(lib.skills, row.id), host.builtin);
    if (!emb.ok) { done({ outcome: "failed", reason: emb.problem === "builtin" ? "builtin" : "embedded" }); continue; }
    if (choice.action === "add" && row.local) { done({ outcome: "failed", reason: "exists" }); continue; }
    if (choice.action === "add" && row.status !== "missing-embedded") { done({ outcome: "failed", reason: "changed" }); continue; }
    let id = row.id, files = emb.files;
    if (choice.action === "rename") {
      const as = choice.as;
      if (!isLibraryId(as)) { done({ outcome: "failed", reason: "bad_id" }); continue; }
      if (conflictOf(as, takenNames(store, host.builtin)) !== "none") { done({ outcome: "failed", reason: "exists" }); continue; }
      const renamed = renameSkillFiles(files, as);
      if (!renamed) { done({ outcome: "failed", reason: "invalid" }); continue; }
      id = as; files = renamed;
    }
    const r = store.addSkill(id, files, { source: { type: "import", from: "agent template" } });
    if (!r.ok) { done({ outcome: "failed", reason: r.error === "exists" ? "exists" : "invalid" }); continue; }
    take("skills", row, id);
    done({ outcome: choice.action === "rename" ? "renamed" : "added", savedAs: id });
  }

  const confirmations = new McpConfirmations(store);
  for (const row of view.mcp) {
    const choice = Object.hasOwn(choices.mcp, row.id) ? choices.mcp[row.id]! : undefined;
    const done = (o: Omit<ApplyOutcome, "id">): void => { out.mcp.push({ id: row.id, ...o }); };
    if (row.status === "missing") { done({ outcome: "skipped", reason: "missing" }); continue; }
    if (!choice) { done({ outcome: "skipped", reason: "undecided" }); continue; }
    if (choice.action === "skip") { done({ outcome: "skipped", reason: "chosen" }); continue; }
    // Every MCP server needs the administrator's explicit confirmation of the version they were shown.
    if (choice.action === "use") {
      if (!row.local) { done({ outcome: "failed", reason: "missing" }); continue; }
      if (!row.local.ready || !row.local.sha256) { done({ outcome: "failed", reason: "notReady" }); continue; }
      if (choice.confirm !== row.local.sha256) { done({ outcome: "failed", reason: choice.confirm ? "changed" : "unconfirmed" }); continue; }
      confirmations.confirm(host.agent, row.id, row.local.sha256);
      take("mcp", row, row.id); done({ outcome: "used", savedAs: row.id }); continue;
    }
    const emb = readEmbeddedMcp(entryOf(lib.mcp, row.id));
    if (!emb.ok) { done({ outcome: "failed", reason: "embedded" }); continue; }
    if (choice.action === "add" && row.local) { done({ outcome: "failed", reason: "exists" }); continue; }
    let id = row.id, text = emb.text;
    if (choice.action === "rename") {
      const as = choice.as;
      if (!isLibraryId(as)) { done({ outcome: "failed", reason: "bad_id" }); continue; }
      if (store.list().some((i) => i.kind === "mcp" && i.id === as && i.status !== "missing")) { done({ outcome: "failed", reason: "exists" }); continue; }
      id = as; text = stringifyMcp({ ...emb.item, name: as });
    }
    // The hash the person confirmed is the one of the bundled definition they read (a rename changes only the name line, not what runs).
    if (choice.confirm !== emb.sha256) { done({ outcome: "failed", reason: choice.confirm ? "changed" : "unconfirmed" }); continue; }
    const r = store.addMcp(id, text, { source: { type: "import", from: "agent template" } });
    if (!r.ok) { done({ outcome: "failed", reason: r.error === "exists" ? "exists" : "invalid" }); continue; }
    confirmations.confirm(host.agent, id, r.sha256);
    take("mcp", row, id);
    done({ outcome: choice.action === "rename" ? "renamed" : "added", savedAs: id });
  }
  return out;
}
