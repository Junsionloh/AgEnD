/**
 * AGEND-260: mounting library MCP servers on an agent — Claude Code only (the first backend; the others say "not supported yet").
 *
 * An agent's `library.mcp` (fleet.yaml, set by an administrator only) lists library MCP ids. At each start the daemon turns the ones that
 * can run into entries of the agent's own `mcp-config.json` (instanceDir, loaded with `--mcp-config` beside the CLI's other MCP
 * sources), named `agend-lib-<id>`. Nothing else in the file is derived from the library, and an agent with no mount gets the file
 * it always got, byte for byte.
 *
 * Secrets. A library item names VARIABLES (`env`, `headers`), never values. The value comes from the daemon's own environment when the
 * agent starts, and is never written to a file, a log or an API answer:
 *  - the config entry holds a reference, `${AGEND_LIBMCP_<n>_<NAME>}`, which Claude Code expands when it reads the file;
 *  - the launch command gives Claude Code that one alias (`AGEND_LIBMCP_<n>_<NAME>=<value>`, the way the fleet's own API key is given),
 *    so the real name (`GITHUB_TOKEN`) is set only in the MCP server's environment, where the entry maps it (`env: { NAME: "${alias}" }`);
 *  - an item whose variable is not set in the daemon's environment is NOT enabled; the Settings page says which one is missing.
 *
 * What this does not do: the alias is in the Claude Code process's environment (the same exposure as the fleet's `ANTHROPIC_API_KEY`;
 * AGEND-229 §5), and the MCP server's tools are not restricted (`--allowedTools`) — both are follow-ups.
 */
import { normalizeMount, type McpItem } from "./schema.js";
import type { LibraryStore } from "./store.js";

/** The server name prefix: it marks an entry as the library's, and keeps it apart from `agend` and anything the person has. */
export const LIBRARY_MCP_PREFIX = "agend-lib-";
/** The alias prefix of the variables handed to the CLI. */
export const LIBRARY_MCP_ALIAS_PREFIX = "AGEND_LIBMCP_";
/** The backends that take a mounted MCP server. A native Windows agent does not (its CLI is on another PC). */
export const LIBRARY_MCP_BACKENDS: readonly string[] = ["claude-code"];
export const supportsLibraryMcp = (backend: string | undefined, runtime?: string): boolean => runtime !== "windows" && LIBRARY_MCP_BACKENDS.includes(backend ?? "claude-code");

/** What Claude Code's `mcpServers` takes for a server (a stdio command, or an http endpoint). */
export type LibraryMcpEntry =
  | { command: string; args: string[]; env: Record<string, string> }
  | { type: "http"; url: string; headers: Record<string, string> };

/** One mounted server that can run now. `secrets` names the daemon variables to read, and the alias each is handed to the CLI under. */
export interface ResolvedLibraryMcp {
  id: string;
  serverName: string;
  entry: LibraryMcpEntry;
  secrets: Array<{ alias: string; name: string }>;
}

/** Why a mounted id is not enabled (`missing_vars`: `missing` names the variables the daemon does not have). */
export type LibraryMcpState =
  | { id: string; status: "active"; vars: string[] }
  | { id: string; status: "missing_vars"; vars: string[]; missing: string[] }
  | { id: string; status: "not_found" | "invalid" | "untracked" | "modified" };

/** The variable names an item reads: `env` for a stdio server, the `headers` values for an http one. */
export function mcpVariables(item: McpItem): string[] {
  return [...new Set(item.transport === "http" ? Object.values(item.headers ?? {}) : (item.env ?? []))];
}

/** A variable is "set" when the daemon has it with a value (an empty string is not a secret). */
const isSet = (env: NodeJS.ProcessEnv, name: string): boolean => typeof env[name] === "string" && env[name]!.length > 0;

/** The names of the variables of `item` the environment lacks. Reads the environment's keys and lengths only. */
export function missingVariables(item: McpItem, env: NodeJS.ProcessEnv): string[] {
  return mcpVariables(item).filter((name) => !isSet(env, name));
}

/** The entry for an item. `aliasOf(name)` gives the reference each variable is read through. Pure: no value is ever seen here. */
export function buildLibraryMcpEntry(item: McpItem, aliasOf: (name: string) => string): LibraryMcpEntry {
  const ref = (name: string): string => `\${${aliasOf(name)}}`;
  if (item.transport === "http") {
    const headers: Record<string, string> = {};
    for (const [header, name] of Object.entries(item.headers ?? {})) headers[header] = ref(name);
    return { type: "http", url: item.url!, headers };
  }
  const env: Record<string, string> = {};
  for (const name of item.env ?? []) env[name] = ref(name);
  return { command: item.command!, args: [...(item.args ?? [])], env };
}

export interface ResolveLibraryMcpInput {
  /** The agent's `library.mcp`. */
  mount: unknown;
  store: LibraryStore;
  /** The daemon's environment: read for which variables exist, never copied or returned. */
  env: NodeJS.ProcessEnv;
}

/** The mounted servers that can run (in id order, so the file is the same for the same mount) and what became of every mounted id. */
export function resolveLibraryMcp(input: ResolveLibraryMcpInput): { active: ResolvedLibraryMcp[]; states: LibraryMcpState[] } {
  const ids = normalizeMount(input.mount).sort();
  const active: ResolvedLibraryMcp[] = [];
  const states: LibraryMcpState[] = [];
  for (const id of ids) {
    const got = input.store.mcpForMount(id);
    if (!got.ok) { states.push({ id, status: got.reason }); continue; }
    const vars = mcpVariables(got.item);
    const missing = missingVariables(got.item, input.env);
    if (missing.length) { states.push({ id, status: "missing_vars", vars, missing }); continue; }
    const n = active.length;
    const aliasOf = (name: string): string => `${LIBRARY_MCP_ALIAS_PREFIX}${n}_${name}`;
    active.push({ id, serverName: `${LIBRARY_MCP_PREFIX}${id}`, entry: buildLibraryMcpEntry(got.item, aliasOf), secrets: vars.map((name) => ({ alias: aliasOf(name), name })) });
    states.push({ id, status: "active", vars });
  }
  return { active, states };
}

/** Read-only: which agents mount which library MCP server (the setting only), `{ id: [agent names, sorted] }`. Same rule as `librarySkillUsage`. */
export function libraryMcpUsage(instances: Record<string, { library?: { mcp?: unknown }; runtime?: string } | null | undefined> | null | undefined): Record<string, string[]> {
  const usage: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  for (const name of Object.keys(instances ?? {}).sort()) {
    const def = instances![name];
    if (!def || def.runtime === "windows") continue;
    for (const id of normalizeMount(def.library?.mcp)) (usage[id] ??= []).push(name);
  }
  return usage;
}
