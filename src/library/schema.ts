/**
 * AGEND-243: the Skill / MCP library's formats and the checks every write goes through. Pure: no file access here.
 *
 * Formats follow the precedents the project already has:
 *  - a Skill is a folder `skills/<id>/` with a `SKILL.md` (YAML frontmatter `name` + `description`, then the instructions) and
 *    optional supporting files — the Claude Code / Multica skill layout, and the same id rule as the bundled skills
 *    (src/bundled-skills.ts);
 *  - an MCP server is one `mcp/<id>.yaml`. It names the VARIABLES a server needs (`env`, `headers`), never their values, so a
 *    library item can be shared without carrying a secret. Anything that looks like a secret is refused (the same scan the
 *    agent export uses).
 *
 * Nothing here is mounted into an agent (that is a later step): the library only stores and checks.
 */
import { parse, stringify } from "yaml";
import { scanForSecrets, type SecretFinding } from "../agent-export.js";

export type LibraryKind = "skill" | "mcp";
export const LIBRARY_KINDS: readonly LibraryKind[] = ["skill", "mcp"];

/** Size and count limits. A save arrives as one JSON body (web-api.ts reads at most 512 KiB), so the totals stay under it. */
export const LIBRARY_LIMITS = Object.freeze({
  skillMdBytes: 100 * 1024,
  skillFileBytes: 200 * 1024,
  skillTotalBytes: 384 * 1024,
  skillFiles: 64,
  skillPathChars: 160,
  skillPathDepth: 6,
  mcpBytes: 16 * 1024,
  itemsPerKind: 500,
  descriptionChars: 1024,
  mcpArgs: 64,
  mcpArgChars: 1024,
  mcpEnv: 64,
});

/**
 * Names Windows reserves as devices (CON, PRN, AUX, NUL, COM1-9, LPT1-9, with or without an extension): a folder or file called
 * that cannot be created or removed there, so an item that is shared between machines may not carry one.
 */
export const isWindowsReservedName = (name: string): boolean => /^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])$/i.test(name.split(".")[0]!);

/** The same id rule as the bundled skills, minus the names Windows reserves. */
export const LIBRARY_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const isLibraryId = (v: unknown): v is string => typeof v === "string" && LIBRARY_ID_RE.test(v) && !isWindowsReservedName(v);

export type LibraryErrorCode =
  | "invalid_request" | "invalid_id" | "invalid_path" | "duplicate_path" | "missing_skill_md" | "bad_frontmatter" | "name_mismatch"
  | "missing_description" | "too_large" | "too_many_files" | "not_text" | "secret_found" | "exists" | "not_found" | "too_many_items"
  | "invalid_yaml" | "bad_mcp" | "unsafe_item"
  // AGEND-257: an upload that is not a usable archive / has no skill in it; a skill that changed since it was read.
  | "bad_archive" | "no_skill" | "changed"
  // AGEND-261: replacing an item without saying which version it started from.
  | "expect_required";
export interface LibraryError { ok: false; error: LibraryErrorCode; path?: string; detail?: string; findings?: SecretFinding[] }
const fail = (error: LibraryErrorCode, extra: { path?: string; detail?: string; findings?: SecretFinding[] } = {}): LibraryError => ({ ok: false, error, ...extra });

// ── Mounting (an agent's `library` setting; applied in mount.ts) ──

/** The ids a mount list names, in order, once each. Anything that is not a valid library id is dropped. */
export function normalizeMount(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const id of list) if (isLibraryId(id) && !out.includes(id)) out.push(id);
  return out;
}

/** What is wrong with an instance's `library` value (null when fine). The one place fleet.yaml's shape is judged. */
export function libraryMountProblem(value: unknown, isDefaults: boolean): string | null {
  if (isDefaults) return "is set per agent: the fleet defaults cannot mount library items";
  if (!value || typeof value !== "object" || Array.isArray(value)) return "must be a mapping like { skills: [id, …] }";
  for (const key of Object.keys(value)) if (key !== "skills" && key !== "mcp") return `has an unknown key "${key}" (only skills and mcp are available)`;
  const { skills, mcp } = value as { skills?: unknown; mcp?: unknown };
  if (skills !== undefined) {
    if (!Array.isArray(skills) || !skills.every((id) => isLibraryId(id))) {
      return "skills must be a list of library skill ids (lowercase letters, digits and hyphens, not a Windows device name)";
    }
    if (new Set(skills).size !== skills.length) return "skills lists the same id twice";
    if (skills.length > LIBRARY_LIMITS.itemsPerKind) return `skills lists more than ${LIBRARY_LIMITS.itemsPerKind} ids`;
  }
  if (mcp !== undefined) {
    if (!Array.isArray(mcp) || !mcp.every((id) => isLibraryId(id))) {
      return "mcp must be a list of library MCP ids (lowercase letters, digits and hyphens, not a Windows device name)";
    }
    if (new Set(mcp).size !== mcp.length) return "mcp lists the same id twice";
    if (mcp.length > LIBRARY_LIMITS.itemsPerKind) return `mcp lists more than ${LIBRARY_LIMITS.itemsPerKind} ids`;
  }
  return null;
}

// ── Skills ─────────────────────────────────────────────────────────────

/** One file of a skill: a path under the skill's folder (always `/`-separated) and its text. */
export interface SkillFile { path: string; content: string }

const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const byteLength = (s: string): number => Buffer.byteLength(s, "utf8");

/**
 * A path inside a skill's folder: relative, `/`-separated, no empty / `.` / `..` segment, no hidden segment, no drive letter or
 * backslash, plain characters only (so it means the same on Linux, macOS and Windows), not ending in a dot, and no segment a
 * Windows device name (`con`, `nul.txt`…).
 */
export function isSafeSkillPath(p: unknown): p is string {
  if (typeof p !== "string" || !p || p.length > LIBRARY_LIMITS.skillPathChars) return false;
  const parts = p.split("/");
  if (parts.length > LIBRARY_LIMITS.skillPathDepth) return false;
  return parts.every((seg) => SEGMENT_RE.test(seg) && !seg.endsWith(".") && seg !== "." && seg !== ".." && !isWindowsReservedName(seg));
}

/** The frontmatter of a SKILL.md: `{ name, description, … }` between two `---` lines. */
export function parseSkillFrontmatter(text: string): { ok: true; data: Record<string, unknown>; body: string } | { ok: false } {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text.replace(/^﻿/, ""));
  if (!m) return { ok: false };
  let data: unknown;
  try { data = parse(m[1]!, { maxAliasCount: 0 }); } catch { return { ok: false }; }
  if (!data || typeof data !== "object" || Array.isArray(data)) return { ok: false };
  return { ok: true, data: data as Record<string, unknown>, body: text.slice(m[0].length) };
}

export interface SkillMeta { description: string }

/** Every rule a skill must meet before it is stored. `id` is the folder name. */
export function validateSkill(id: unknown, files: unknown): { ok: true; id: string; files: SkillFile[]; meta: SkillMeta } | LibraryError {
  if (!isLibraryId(id)) return fail("invalid_id");
  if (!Array.isArray(files)) return fail("invalid_request");
  if (files.length > LIBRARY_LIMITS.skillFiles) return fail("too_many_files");
  const seen = new Set<string>();
  const folded: string[] = [];
  const out: SkillFile[] = [];
  let total = 0;
  for (const f of files) {
    if (!f || typeof f !== "object") return fail("invalid_request");
    const { path, content } = f as Record<string, unknown>;
    if (!isSafeSkillPath(path)) return fail("invalid_path", { path: typeof path === "string" ? path.slice(0, 80) : "" });
    if (typeof content !== "string") return fail("invalid_request", { path });
    if (seen.has(path)) return fail("duplicate_path", { path });
    seen.add(path);
    // A name that differs only by case is the same file on macOS and Windows.
    const lower = path.normalize("NFC").toLowerCase();
    if (folded.includes(lower)) return fail("duplicate_path", { path });
    folded.push(lower);
    if (content.includes("\u0000")) return fail("not_text", { path });
    const size = byteLength(content);
    if (size > (path === "SKILL.md" ? LIBRARY_LIMITS.skillMdBytes : LIBRARY_LIMITS.skillFileBytes)) return fail("too_large", { path });
    total += size;
    out.push({ path, content });
  }
  if (total > LIBRARY_LIMITS.skillTotalBytes) return fail("too_large");
  // A path may not be both a file and a folder (`a` and `a/b`).
  for (const p of seen) for (const q of seen) if (q.startsWith(`${p}/`)) return fail("invalid_path", { path: p });
  const skillMd = out.find((f) => f.path === "SKILL.md");
  if (!skillMd) return fail("missing_skill_md");
  const fm = parseSkillFrontmatter(skillMd.content);
  if (!fm.ok) return fail("bad_frontmatter", { path: "SKILL.md" });
  if (fm.data.name !== id) return fail("name_mismatch", { path: "SKILL.md", detail: typeof fm.data.name === "string" ? fm.data.name.slice(0, 80) : "" });
  const description = typeof fm.data.description === "string" ? fm.data.description.trim() : "";
  if (!description) return fail("missing_description", { path: "SKILL.md" });
  if (description.length > LIBRARY_LIMITS.descriptionChars) return fail("too_large", { path: "SKILL.md", detail: "description" });
  const findings = out.flatMap((f) => scanForSecrets(f.path, f.content));
  if (findings.length) return fail("secret_found", { findings });
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { ok: true, id, files: out, meta: { description } };
}

// ── MCP servers ────────────────────────────────────────────────────────

/** The file's own marker, as `agend_export: 1` marks an export file. */
export const MCP_FILE_VERSION = 1;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** Variables an MCP server may not be given from `.env`: the ones that change how a program is found or loaded (the secret store refuses them too). */
const RESERVED_ENV_NAMES = new Set(["PATH", "HOME", "PWD", "SHELL", "ENV", "BASH_ENV", "NODE_OPTIONS", "LD_PRELOAD"]);
const isVariableName = (n: unknown): n is string => typeof n === "string" && ENV_NAME_RE.test(n) && !RESERVED_ENV_NAMES.has(n);
const HEADER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

/** What an MCP library file holds. `env` and `headers` name VARIABLES: the values live where the agent runs, never here. */
export interface McpItem {
  name: string;
  description?: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  /** stdio: the environment variables the server reads (names only). */
  env?: string[];
  url?: string;
  /** http: header name → the variable that holds its value (e.g. `Authorization: GITHUB_TOKEN`). */
  headers?: Record<string, string>;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const KEYS = new Set(["agend_library", "kind", "name", "description", "transport", "command", "args", "env", "url", "headers"]);

/** One MCP library file's text → its checked content, or why not. `id` is the file's name without `.yaml`. */
export function validateMcpText(id: unknown, text: unknown): { ok: true; id: string; item: McpItem; text: string } | LibraryError {
  if (!isLibraryId(id)) return fail("invalid_id");
  if (typeof text !== "string" || !text.trim()) return fail("invalid_request");
  if (byteLength(text) > LIBRARY_LIMITS.mcpBytes) return fail("too_large");
  if (text.includes("\u0000")) return fail("not_text");
  let doc: unknown;
  try { doc = parse(text, { maxAliasCount: 0 }); } catch { return fail("invalid_yaml"); }
  if (!isObj(doc)) return fail("invalid_yaml");
  const bad = (detail: string): LibraryError => fail("bad_mcp", { detail });
  if (doc.agend_library !== MCP_FILE_VERSION) return bad("agend_library");
  if (doc.kind !== "mcp") return bad("kind");
  for (const k of Object.keys(doc)) if (!KEYS.has(k)) return bad(k);
  if (doc.name !== id) return fail("name_mismatch", { detail: typeof doc.name === "string" ? doc.name.slice(0, 80) : "" });
  const item: McpItem = { name: id, transport: "stdio" };
  if (doc.description !== undefined) {
    if (typeof doc.description !== "string" || doc.description.length > LIBRARY_LIMITS.descriptionChars) return bad("description");
    if (doc.description.trim()) item.description = doc.description.trim();
  }
  if (doc.transport !== "stdio" && doc.transport !== "http") return bad("transport");
  item.transport = doc.transport;
  const oneLine = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
  if (item.transport === "stdio") {
    if (!oneLine(doc.command, LIBRARY_LIMITS.mcpArgChars)) return bad("command");
    item.command = doc.command;
    if (doc.args !== undefined) {
      if (!Array.isArray(doc.args) || doc.args.length > LIBRARY_LIMITS.mcpArgs || !doc.args.every((a) => typeof a === "string" && a.length <= LIBRARY_LIMITS.mcpArgChars && !a.includes("\u0000"))) return bad("args");
      if (doc.args.length) item.args = doc.args as string[];
    }
    if (doc.env !== undefined) {
      // A map (`KEY: value`) is the shape that carries a value: refused, whatever the value is.
      if (!Array.isArray(doc.env) || doc.env.length > LIBRARY_LIMITS.mcpEnv || !doc.env.every(isVariableName)) return bad("env");
      if (new Set(doc.env).size !== doc.env.length) return bad("env");
      if (doc.env.length) item.env = [...(doc.env as string[])];
    }
    if (doc.url !== undefined || doc.headers !== undefined) return bad(doc.url !== undefined ? "url" : "headers");
  } else {
    if (!oneLine(doc.url, 2048)) return bad("url");
    let u: URL;
    try { u = new URL(doc.url); } catch { return bad("url"); }
    // A credential or a query string in the address is a secret kept in a file: use `headers` with a variable instead.
    if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username || u.password || u.search || u.hash) return bad("url");
    item.url = doc.url;
    if (doc.headers !== undefined) {
      if (!isObj(doc.headers) || Object.keys(doc.headers).length > LIBRARY_LIMITS.mcpEnv) return bad("headers");
      const headers: Record<string, string> = {};
      for (const [h, v] of Object.entries(doc.headers)) {
        if (!HEADER_NAME_RE.test(h) || !isVariableName(v)) return bad("headers");
        headers[h] = v;
      }
      if (Object.keys(headers).length) item.headers = headers;
    }
    if (doc.command !== undefined || doc.args !== undefined || doc.env !== undefined) return bad(doc.command !== undefined ? "command" : doc.args !== undefined ? "args" : "env");
  }
  const canonical = stringifyMcp(item);
  // `env` and `headers` hold only variable NAMES (checked above), which the scan's patterns would mistake for a value
  // (`X-Api-Key: SOME_LONG_VARIABLE_NAME`): everything else is scanned.
  const findings = scanForSecrets("mcp", [item.description, item.command, ...(item.args ?? []), item.url].filter((v): v is string => !!v).join("\n"));
  if (findings.length) return fail("secret_found", { findings });
  return { ok: true, id, item, text: canonical };
}

/** The one text a library item is stored as: fixed key order, so the same item always has the same hash. */
export function stringifyMcp(item: McpItem): string {
  const doc: Record<string, unknown> = { agend_library: MCP_FILE_VERSION, kind: "mcp", name: item.name };
  if (item.description) doc.description = item.description;
  doc.transport = item.transport;
  if (item.command) doc.command = item.command;
  if (item.args?.length) doc.args = item.args;
  if (item.env?.length) doc.env = item.env;
  if (item.url) doc.url = item.url;
  if (item.headers && Object.keys(item.headers).length) doc.headers = item.headers;
  return stringify(doc, { lineWidth: 0 });
}
