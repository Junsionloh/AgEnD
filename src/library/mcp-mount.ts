/**
 * AGEND-261: mounting library MCP servers into an agent (Claude Code and Codex first).
 *
 * An agent's `library.mcp` (fleet.yaml `instances.<name>.library.mcp`, set by an administrator only — no agent tool can write it) lists
 * library MCP ids. At each launch the daemon turns them into entries of the CLI's own MCP config, named `agend-lib-<id>`; the user's own
 * MCP settings are never read or changed here. This file is the PURE part — what to write and what to skip, and why:
 *
 *  - an item is mounted only when it passes every library rule AND is the version the library's lock recorded (`LibraryStore.mcpForMount`),
 *    AND an administrator confirmed exactly that version for this agent (`McpConfirmations`): an item that was edited afterwards is
 *    not written until it is confirmed again;
 *  - the item names VARIABLES (`env` for a stdio server, `headers` for an http one), never values. The values are read from the data
 *    folder's `.env` at the moment the config is written. A variable with no value means the server is NOT started (not started with
 *    a hole in its environment): the agent gets nothing for it and the settings page says which variable is missing;
 *  - nothing in a result that is meant to be shown (`skipped`, the status) ever holds a value, only names. The values exist only inside
 *    `entries`, which goes to the backend's config writer and nowhere else.
 *
 * Honest about what this is: the values are handed to the MCP server when the agent starts, the same as the `.env` approach today.
 * Keeping the agent from ever holding the keys is the later gateway work.
 */
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "../atomic-write.js";
import { parseEnvText } from "../env-file.js";
import { isLibraryId, normalizeMount, type McpItem } from "./schema.js";
import type { LibraryStore } from "./store.js";

/** The name an entry has in the CLI's config. The prefix also keeps Codex's own cleanup (`agend-…` tables) in charge of stale ones. */
export const LIBRARY_MCP_PREFIX = "agend-lib-";
export const libraryMcpName = (id: string): string => `${LIBRARY_MCP_PREFIX}${id}`;

/** What a backend's config writer gets: values resolved. Never logged, never shown. */
export type LibraryMcpEntry =
  | { transport: "stdio"; command: string; args: string[]; env: Record<string, string> }
  | { transport: "http"; url: string; headers: Record<string, string> };

export type McpSkipReason = "not_found" | "invalid" | "untracked" | "modified" | "unconfirmed" | "missing_vars" | "bad_value";
export interface McpMountResult {
  /** Config name (`agend-lib-<id>`) → entry. Holds values: hand it to the backend, do not log it. */
  entries: Record<string, LibraryMcpEntry>;
  /** Ids that were written. */
  mounted: string[];
  /** Ids that were not, with why; `names`: the variables that were missing (or whose value cannot be used) — names only. */
  skipped: Array<{ id: string; reason: McpSkipReason; names?: string[] }>;
}

/** The variable names an item needs, in the order it lists them, once each. */
export function mcpVariables(item: McpItem): string[] {
  const names = item.transport === "stdio" ? (item.env ?? []) : Object.values(item.headers ?? {});
  return [...new Set(names)];
}

/** What an administrator is shown before an item is mounted: exactly what will run, and the variables it will be given. */
export interface McpSummary { transport: "stdio" | "http"; command?: string; args?: string[]; url?: string; host?: string; variables: string[] }
export function mcpSummary(item: McpItem): McpSummary {
  let host: string | undefined;
  if (item.url) { try { host = new URL(item.url).host; } catch { /* validated on save; nothing to show */ } }
  return {
    transport: item.transport,
    ...(item.command ? { command: item.command } : {}),
    ...(item.args?.length ? { args: item.args } : {}),
    ...(item.url ? { url: item.url } : {}),
    ...(host ? { host } : {}),
    variables: mcpVariables(item),
  };
}

// ── The values (`.env`) ────────────────────────────────────────────────

/**
 * The values of the named variables in `<dataDir>/.env` — only those that are set and not empty. Read at the moment a config is
 * written; a missing or unreadable file, or a symlink, gives none. Only the names asked for are kept: the rest of the file is not
 * held on to.
 */
export function readEnvValues(envPath: string, names: Iterable<string>): Map<string, string> {
  const wanted = new Set(names);
  const out = new Map<string, string>();
  if (!wanted.size) return out;
  let text: string;
  try {
    if (lstatSync(envPath).isSymbolicLink()) return out;
    text = readFileSync(envPath, "utf-8");
  } catch { return out; }
  for (const [key, raw] of parseEnvText(text)) {
    const value = raw.replace(/\r$/, "");
    if (wanted.has(key) && value) out.set(key, value);
  }
  return out;
}

/** The names of the variables in `.env` that have a value — for the settings page ("set / missing"); never the values. */
export function envNamesSet(envPath: string, names: Iterable<string>): Set<string> {
  return new Set(readEnvValues(envPath, names).keys());
}

/** A value an http header or a command-line environment can carry: one line, no control character. */
const usable = (v: string): boolean => !/[\u0000-\u001f\u007f]/.test(v);

// ── Confirmations ──────────────────────────────────────────────────────

export const MCP_CONFIRMED_FILENAME = "mcp-confirmed.json";
/** `{ agent: { mcpId: sha256 } }`: the version of each item an administrator confirmed for each agent. */
export type McpConfirmed = Record<string, Record<string, string>>;

/**
 * The record of what an administrator confirmed (`<library>/mcp-confirmed.json`). Written only by the admin-only confirm route; an
 * agent cannot reach it. Absent, corrupt or of another shape: nothing is confirmed.
 */
export class McpConfirmations {
  readonly path: string;
  constructor(store: Pick<LibraryStore, "root">) { this.path = join(store.root, MCP_CONFIRMED_FILENAME); }

  read(): McpConfirmed {
    const out: McpConfirmed = Object.create(null) as McpConfirmed;
    try {
      const st = lstatSync(this.path);
      if (!st.isFile() || st.size > 1024 * 1024) return out;
      const data = JSON.parse(readFileSync(this.path, "utf-8")) as { agents?: unknown };
      if (!data || typeof data !== "object" || !data.agents || typeof data.agents !== "object" || Array.isArray(data.agents)) return out;
      for (const [agent, items] of Object.entries(data.agents as Record<string, unknown>)) {
        if (!items || typeof items !== "object" || Array.isArray(items)) continue;
        const kept: Record<string, string> = Object.create(null) as Record<string, string>;
        for (const [id, sha] of Object.entries(items as Record<string, unknown>)) {
          if (isLibraryId(id) && typeof sha === "string" && /^[0-9a-f]{64}$/.test(sha)) kept[id] = sha;
        }
        if (Object.keys(kept).length) out[agent] = kept;
      }
    } catch { /* nothing confirmed */ }
    return out;
  }

  /** The versions confirmed for one agent (`{ id: sha256 }`). */
  forAgent(agent: string): Record<string, string> {
    const all = this.read();
    return Object.hasOwn(all, agent) ? all[agent]! : Object.create(null) as Record<string, string>;
  }

  /** Records that `sha256` of `id` was confirmed for `agent`. */
  confirm(agent: string, id: string, sha256: string): void {
    const all = this.read();
    const mine = Object.hasOwn(all, agent) ? all[agent]! : (all[agent] = Object.create(null) as Record<string, string>);
    mine[id] = sha256;
    const agents: Record<string, Record<string, string>> = {};
    for (const a of Object.keys(all).sort()) {
      const items: Record<string, string> = {};
      for (const i of Object.keys(all[a]!).sort()) items[i] = all[a]![i]!;
      agents[a] = items;
    }
    atomicWriteFileSync(this.path, `${JSON.stringify({ version: 1, agents }, null, 2)}\n`, { mode: 0o600 });
  }
}

// ── Resolving a mount ──────────────────────────────────────────────────

export interface ResolveMcpInput {
  /** The agent's `library.mcp`. */
  ids: readonly string[];
  store: Pick<LibraryStore, "mcpForMount">;
  /** `McpConfirmations.forAgent(agent)`. */
  confirmed: Readonly<Record<string, string>>;
  /** `readEnvValues(...)` for the variables the items name. */
  values: ReadonlyMap<string, string>;
}

/** See the file's header. Pure: reads nothing but what it is given, and its `skipped` never holds a value. */
export function resolveMcpMount(input: ResolveMcpInput): McpMountResult {
  const result: McpMountResult = { entries: {}, mounted: [], skipped: [] };
  for (const id of normalizeMount([...input.ids])) {
    const got = input.store.mcpForMount(id);
    if (!got.ok) { result.skipped.push({ id, reason: got.reason }); continue; }
    if (!Object.hasOwn(input.confirmed, id) || input.confirmed[id] !== got.sha256) { result.skipped.push({ id, reason: "unconfirmed" }); continue; }
    const item = got.item;
    const names = mcpVariables(item);
    const missing = names.filter((n) => !input.values.has(n));
    if (missing.length) { result.skipped.push({ id, reason: "missing_vars", names: missing }); continue; }
    const value = (n: string): string => input.values.get(n)!;
    if (item.transport === "stdio") {
      result.entries[libraryMcpName(id)] = {
        transport: "stdio", command: item.command!, args: [...(item.args ?? [])],
        env: Object.fromEntries((item.env ?? []).map((n) => [n, value(n)])),
      };
    } else {
      const headers: Record<string, string> = {};
      const bad: string[] = [];
      for (const [h, n] of Object.entries(item.headers ?? {})) { if (usable(value(n))) headers[h] = value(n); else bad.push(n); }
      if (bad.length) { result.skipped.push({ id, reason: "bad_value", names: [...new Set(bad)] }); continue; }
      result.entries[libraryMcpName(id)] = { transport: "http", url: item.url!, headers };
    }
    result.mounted.push(id);
  }
  return result;
}

/**
 * Read-only: which agents are given which library MCP server, from the fleet's `instances` — `{ mcpId: [agent names, sorted] }`. The
 * setting only (what an administrator mounted): the same shape as `librarySkillUsage`, for the overview's "in use" tags. A Windows native
 * agent is left out (its CLI is on another PC).
 */
export function libraryMcpUsage(instances: Record<string, { library?: { mcp?: unknown }; runtime?: string } | null | undefined> | null | undefined): Record<string, string[]> {
  const usage: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  for (const name of Object.keys(instances ?? {}).sort()) {
    const def = instances![name];
    if (!def || def.runtime === "windows") continue;
    for (const id of normalizeMount(def.library?.mcp)) (usage[id] ??= []).push(name);
  }
  return usage;
}
