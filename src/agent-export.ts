/**
 * AGEND-163: an agent's portable settings as one YAML file (`<role>.agend-agent.yaml`, `agend_export: 1`), and the way back.
 *
 * Allow-list only: a field is written, or read, because it is named here — never because it is not excluded. Accounts,
 * keys, channel ids, folders, machine ids, permissions, commands and status emojis are not in the allow-list, so they
 * are neither exported nor loaded; a file that carries them (a hand edit) has them skipped with the reason.
 *
 * Both directions are pure functions of their input: nothing here reads or writes fleet.yaml, so loading a file only
 * fills the form — the person still presses Apply and goes through the usual confirmations.
 */
import { parseDocument, stringify } from "yaml";
import { systemPromptParts } from "./prompt-file-ref.js";
import { scanForSecrets, type SecretFinding } from "./secret-scan.js";
import { libraryBlockOf, readLibraryBlock, type ExportLibrary } from "./library/export-format.js";
import type { LibraryExportResult, LibraryOmission } from "./library/agent-transfer.js";
import type { InstanceConfig } from "./types.js";

export const AGENT_EXPORT_VERSION = 1;
/**
 * The most an agent's `systemPrompt` ("Agent instructions") may hold, in characters: the editor's limit
 * (ui/agent-instructions-field.js INSTRUCTIONS_MAX_CHARS; tests/agent-export-163.test.ts keeps the two equal).
 */
export const AGENT_INSTRUCTIONS_MAX_CHARS = 24_000;
/** The largest file `parseAgentExport` reads, in characters (the instructions alone may take 24,000). */
export const AGENT_EXPORT_MAX_CHARS = 200_000;

const DESCRIPTION_MAX = 2_000;
const TAG_MAX_CHARS = 64;
const TAGS_MAX = 50;
const MODEL_MAX_CHARS = 200;
const ROLE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+[\]-]*$/;

/** What an export can carry, as the checkboxes of the export dialog. */
export const EXPORT_GROUPS = ["identity", "systemPrompt", "runtime", "behavior", "librarySkills", "libraryMcp"] as const;
export type ExportGroup = (typeof EXPORT_GROUPS)[number];

const TOOL_SETS = ["worker", "coordinator", "standard", "minimal", "full"];
const TOOL_PROGRESS = ["off", "standard", "verbose"];
const LOG_LEVELS = ["trace", "debug", "info", "warn", "error"];
const AGENT_MODES = ["mcp", "cli"];
const VISIBILITY = ["full", "summary", "hidden"];

/** Why a field of a file is not loaded (the page words each code). */
export type SkipReason =
  | "machine" | "binding" | "account" | "permission" | "command" | "emoji" | "notice" | "fleetOnly" | "name"
  | "runtimeSwitch" | "fileRef" | "unknown" | "badValue" | "tooLong";

/** The fields a file may name that are on purpose not loaded, and why. A name not here and not allowed is "unknown". */
const EXCLUDED: Record<string, SkipReason> = {
  display_name: "name",
  working_directory: "machine", runtime: "machine", machine_id: "machine", worktree_source: "machine",
  channel_id: "binding", topic_id: "binding", general_topic: "binding",
  backend_options: "account", credential_profile: "account",
  dashboard: "permission", office_access: "permission", office_pack_access: "permission", skipPermissions: "permission",
  pre_task_command: "command",
  status_emojis: "emoji",
  quota_notice: "notice",
  workflow: "fleetOnly", cost_guard: "fleetOnly", restart_policy: "fleetOnly", profile: "fleetOnly", mcp_proxy_reply: "permission",
};
const excludedReason = (key: string): SkipReason => (key.startsWith("native_") ? "machine" : Object.hasOwn(EXCLUDED, key) ? EXCLUDED[key]! : "unknown");

export interface Skipped { path: string; reason: SkipReason }

// The secret scan lives in secret-scan.ts (the Library's rules use it too); re-exported here for the callers that always imported it from this file.
export { scanForSecrets, type SecretFinding } from "./secret-scan.js";

// ── Export ─────────────────────────────────────────────────────────────

export interface BuildResult {
  /** The file, or null when something in it looks like a secret (nothing is offered to copy or download). */
  text: string | null;
  findings: SecretFinding[];
  /** What the file holds, by group (the page's preview of "what will be in it"). */
  groups: ExportGroup[];
  /** True when none of the chosen settings is saved on this agent: the file would hold nothing. */
  empty: boolean;
  /** A chosen setting this agent has but the file does not carry, and why (the dialog says so beside the preview). */
  omitted: Array<{ field: "systemPrompt"; reason: "fileRef" | "tooLong" }>;
  /** AGEND-245: Library items the agent has assigned that the file does not carry (or carries without the definition), and why. */
  libraryOmitted: LibraryOmission[];
  /** How many Library skills / MCP servers the agent has assigned (on or paused), whatever was chosen: the dialog's counts. */
  libraryAssigned: { skills: number; mcp: number };
  /** What the `library` block holds: how many entries, and how many carry their definition. */
  library: { skills: number; mcp: number; bundled: number };
}

const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/**
 * Only what this agent itself sets (a field that follows the fleet's defaults is not written). `lib`: the agent's Library items already resolved by
 * the caller (src/library/agent-transfer.ts `resolveLibraryExport`, which reads the Library) — this function stays a pure function of its input;
 * without it, or without the Library groups chosen, the `library` block is the empty one every export has had.
 */
export function buildAgentExport(role: string, inst: Partial<InstanceConfig>, include: readonly string[], lib?: LibraryExportResult): BuildResult {
  const want = new Set(include.filter((g): g is ExportGroup => (EXPORT_GROUPS as readonly string[]).includes(g)));
  const agent: Record<string, unknown> = {};
  const behavior: Record<string, unknown> = {};
  const findings: SecretFinding[] = [];
  const omitted: BuildResult["omitted"] = [];
  const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v : undefined);

  if (want.has("identity")) {
    const d = text(inst.description);
    if (d) { agent.description = d; findings.push(...scanForSecrets("description", d)); }
    if (Array.isArray(inst.tags) && inst.tags.length) {
      agent.tags = inst.tags.filter((x): x is string => typeof x === "string");
      findings.push(...scanForSecrets("tags", (agent.tags as string[]).join("\n")));
    }
  }
  if (want.has("systemPrompt")) {
    // Agent instructions: an inline text only. A `file:` part (prompt-file-ref.ts systemPromptParts, the rule the editor and the
    // daemon both use) names a file on the exporter's computer, which means nothing elsewhere: the whole value is left out.
    const s = text(inst.systemPrompt);
    // A text longer than the editor's limit would be written but then refused on load (`tooLong`), so it is left out here and said so.
    if (s && systemPromptParts(s).some((part) => part.startsWith("file:"))) omitted.push({ field: "systemPrompt", reason: "fileRef" });
    else if (s && s.length > AGENT_INSTRUCTIONS_MAX_CHARS) omitted.push({ field: "systemPrompt", reason: "tooLong" });
    else if (s) { agent.systemPrompt = s.replace(/\s+$/, ""); findings.push(...scanForSecrets("systemPrompt", s)); }
  }
  if (want.has("runtime")) {
    if (text(inst.backend)) agent.backend = inst.backend;
    if (text(inst.model)) agent.model = inst.model;
    if (Array.isArray(inst.model_failover) && inst.model_failover.length) agent.model_failover = inst.model_failover;
    if (text(inst.tool_set)) agent.tool_set = inst.tool_set;
    if (typeof inst.lightweight === "boolean") agent.lightweight = inst.lightweight;
  }
  if (want.has("behavior")) {
    const hang = inst.hang_detector;
    if (hang && typeof hang === "object" && typeof hang.timeout_minutes === "number") behavior.hang_detector = { timeout_minutes: hang.timeout_minutes };
    for (const key of ["tool_progress", "reply_completion_guard", "log_level", "auto_pause_after", "agent_mode", "cross_instance_visibility", "board_cards_at_once", "resume_interrupted_work"] as const) {
      if (own(inst, key) && inst[key] !== undefined && inst[key] !== null) behavior[key] = inst[key];
    }
  }

  const useLibrary = !!lib && (want.has("librarySkills") || want.has("libraryMcp"));
  const library: ExportLibrary = useLibrary ? lib.library : { skills: [], mcp: [], paused: { skills: [], mcp: [] } };
  const libraryInfo: Pick<BuildResult, "libraryOmitted" | "libraryAssigned" | "library"> = {
    libraryOmitted: useLibrary ? lib.omitted : [],
    libraryAssigned: lib ? lib.assigned : { skills: 0, mcp: 0 },
    library: { skills: library.skills.length, mcp: library.mcp.length, bundled: library.skills.filter((x) => x.archive).length + library.mcp.filter((x) => x.definition).length },
  };
  if (useLibrary) findings.push(...lib.findings);
  const empty = !Object.keys(agent).length && !Object.keys(behavior).length && !library.skills.length && !library.mcp.length;
  if (findings.length) return { text: null, findings, groups: [...want], empty, omitted, ...libraryInfo };
  const doc: Record<string, unknown> = { agend_export: AGENT_EXPORT_VERSION, kind: "agent" };
  if (ROLE_RE.test(role)) doc.role = role;
  doc.agent = agent;
  if (Object.keys(behavior).length) doc.behavior = behavior;
  doc.library = libraryBlockOf(library);
  return { text: stringify(doc, { lineWidth: 0, blockQuote: "literal" }), findings: [], groups: [...want], empty, omitted, ...libraryInfo };
}

// ── Load ───────────────────────────────────────────────────────────────

/** What a file fills into the form: only the values that passed every check, under the form's own names. */
export interface FillValues {
  description?: string; tags?: string[]; systemPrompt?: string;
  model?: string; model_failover?: string; tool_set?: string; lightweight?: boolean;
  hang_detector?: number; tool_progress?: string; reply_completion_guard?: boolean; log_level?: string; auto_pause_after?: number;
  agent_mode?: string; cross_instance_visibility?: string; board_cards_at_once?: number; resume_interrupted_work?: boolean;
}
export type FillKey = keyof FillValues;

export type ParseResult =
  | { ok: true; role?: string; fill: FillValues; skipped: Skipped[]; libraryUsed: boolean; library: LibrarySummary; extraFailover: boolean }
  | { ok: false; error: "empty" | "too_large" | "invalid_yaml" | "not_export" | "unsupported_version" | "wrong_kind" };

/** What the loader's dialog is told about a file's `library` entries (the bundled definitions stay on the server: the dialog asks for the comparison). */
export interface LibrarySummary {
  skills: Array<{ id: string; sha256: string; bundled: boolean; paused: boolean }>;
  mcp: Array<{ id: string; sha256: string; vars: string[]; bundled: boolean; paused: boolean }>;
}
const summaryOf = (l: ExportLibrary): LibrarySummary => ({
  skills: l.skills.map((x) => ({ id: x.id, sha256: x.sha256, bundled: !!x.archive, paused: l.paused.skills.includes(x.id) })),
  mcp: l.mcp.map((x) => ({ id: x.id, sha256: x.sha256, vars: x.vars, bundled: !!x.definition, paused: l.paused.mcp.includes(x.id) })),
});

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.length <= max ? v : null);
const num = (v: unknown, min: number, max = 100_000): number | null => (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : null);

/** Read a file: the allow-listed values that are fine, and for every other field why it was left out. */
export function parseAgentExport(input: unknown): ParseResult {
  return readExport(input).result;
}

/**
 * AGEND-245: the `library` entries of a file, in full (the bundled definitions included) — what the Library comparison and the import work from. The same
 * reading as `parseAgentExport` (so the dialog's list and what is applied can never differ); null when the file is not a readable export at all.
 */
export function parseAgentLibrary(input: unknown): ExportLibrary | null {
  const r = readExport(input);
  return r.result.ok ? r.library : null;
}

function readExport(input: unknown): { result: ParseResult; library: ExportLibrary } {
  const noLibrary = { skills: [], mcp: [], paused: { skills: [], mcp: [] } } as ExportLibrary;
  const fail = (error: Extract<ParseResult, { ok: false }>["error"]): { result: ParseResult; library: ExportLibrary } => ({ result: { ok: false, error }, library: noLibrary });
  if (typeof input !== "string" || input.trim() === "") return fail("empty");
  if (input.length > AGENT_EXPORT_MAX_CHARS) return fail("too_large");
  // YAML 1.2 core schema, no aliases (nothing to expand), duplicate keys refused: plain data in, nothing else.
  const doc = parseDocument(input, { version: "1.2", schema: "core", uniqueKeys: true, prettyErrors: false });
  if (doc.errors.length) return fail("invalid_yaml");
  let root: unknown;
  try { root = doc.toJS({ maxAliasCount: 0 }); } catch { return fail("invalid_yaml"); }
  if (!isObj(root) || !own(root, "agend_export")) return fail("not_export");
  if (root.agend_export !== AGENT_EXPORT_VERSION) return fail("unsupported_version");
  if (own(root, "kind") && root.kind !== "agent") return fail("wrong_kind");

  const fill: FillValues = {};
  const skipped: Skipped[] = [];
  const skip = (path: string, reason: SkipReason): void => { skipped.push({ path, reason }); };
  let role: string | undefined;
  let libraryUsed = false;
  let library: ExportLibrary = { skills: [], mcp: [], paused: { skills: [], mcp: [] } };
  let extraFailover = false;

  for (const key of Object.keys(root)) {
    if (key === "agend_export" || key === "kind") continue;
    if (key === "role") { if (typeof root.role === "string" && ROLE_RE.test(root.role)) role = root.role; else skip("role", "badValue"); continue; }
    if (key === "agent") { if (isObj(root.agent)) readAgent(root.agent); else skip("agent", "badValue"); continue; }
    if (key === "behavior") { if (isObj(root.behavior)) readBehavior(root.behavior); else skip("behavior", "badValue"); continue; }
    if (key === "library") { readLibrary(root.library); continue; }
    skip(key, "unknown");
  }

  function readAgent(a: Record<string, unknown>): void {
    for (const key of Object.keys(a)) {
      const path = `agent.${key}`, v = a[key];
      switch (key) {
        case "description": { const s = str(v, DESCRIPTION_MAX); if (s === null) skip(path, typeof v === "string" ? "tooLong" : "badValue"); else if (s.trim()) fill.description = s; break; }
        case "tags": {
          if (!Array.isArray(v) || v.length > TAGS_MAX || v.some((x) => typeof x !== "string" || !x.trim() || x.length > TAG_MAX_CHARS)) skip(path, "badValue");
          else fill.tags = [...new Set((v as string[]).map((x) => x.trim()))];
          break;
        }
        case "systemPrompt": {
          const s = str(v, AGENT_INSTRUCTIONS_MAX_CHARS);
          if (s === null) skip(path, typeof v === "string" ? "tooLong" : "badValue");
          // A `file:` part would make the daemon read a path on the computer that loads this file: never filled from a file.
          else if (systemPromptParts(s).some((part) => part.startsWith("file:"))) skip(path, "fileRef");
          else if (s.trim()) fill.systemPrompt = s;
          break;
        }
        case "backend": skip(path, "runtimeSwitch"); break;
        case "model": { const s = str(v, MODEL_MAX_CHARS); if (s === null || !MODEL_RE.test(s)) skip(path, "badValue"); else fill.model = s; break; }
        case "model_failover": {
          if (!Array.isArray(v) || !v.length || v.some((x) => typeof x !== "string" || x.length > MODEL_MAX_CHARS || !MODEL_RE.test(x))) skip(path, "badValue");
          else { fill.model_failover = v[0] as string; extraFailover = v.length > 1; }
          break;
        }
        case "tool_set": if (typeof v === "string" && TOOL_SETS.includes(v)) fill.tool_set = v; else skip(path, "badValue"); break;
        case "lightweight": if (typeof v === "boolean") fill.lightweight = v; else skip(path, "badValue"); break;
        default: skip(path, excludedReason(key));
      }
    }
  }

  function readBehavior(b: Record<string, unknown>): void {
    for (const key of Object.keys(b)) {
      const path = `behavior.${key}`, v = b[key];
      switch (key) {
        case "hang_detector": {
          const m = isObj(v) ? num(v.timeout_minutes, 1) : null;
          if (m === null) skip(path, "badValue"); else fill.hang_detector = m;
          if (isObj(v)) for (const k of Object.keys(v)) if (k !== "timeout_minutes") skip(`${path}.${k}`, "unknown");
          break;
        }
        case "tool_progress": if (typeof v === "string" && TOOL_PROGRESS.includes(v)) fill.tool_progress = v; else skip(path, "badValue"); break;
        case "reply_completion_guard": if (typeof v === "boolean") fill.reply_completion_guard = v; else skip(path, "badValue"); break;
        case "log_level": if (typeof v === "string" && LOG_LEVELS.includes(v)) fill.log_level = v; else skip(path, "badValue"); break;
        case "auto_pause_after": { const n = num(v, 0); if (n === null) skip(path, "badValue"); else fill.auto_pause_after = n; break; }
        case "agent_mode": if (typeof v === "string" && AGENT_MODES.includes(v)) fill.agent_mode = v; else skip(path, "badValue"); break;
        case "cross_instance_visibility": if (typeof v === "string" && VISIBILITY.includes(v)) fill.cross_instance_visibility = v; else skip(path, "badValue"); break;
        case "board_cards_at_once": if (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 1000) fill.board_cards_at_once = v; else skip(path, "badValue"); break;
        case "resume_interrupted_work": if (typeof v === "boolean") fill.resume_interrupted_work = v; else skip(path, "badValue"); break;
        default: skip(path, excludedReason(key));
      }
    }
  }

  // AGEND-245: the `library` block (src/library/export-format.ts — provisional elements, pure reading). Nothing here touches the Library.
  function readLibrary(lib: unknown): void {
    if (isObj(lib)) for (const key of ["skills", "mcp"]) if (Array.isArray(lib[key]) && (lib[key] as unknown[]).length) libraryUsed = true;
    library = readLibraryBlock(lib, skip);
  }

  return { result: { ok: true, ...(role ? { role } : {}), fill, skipped, libraryUsed, library: summaryOf(library), extraFailover }, library };
}
