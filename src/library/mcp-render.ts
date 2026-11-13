/**
 * AGEND-261: how a resolved library MCP entry is written into each backend's own config. Pure (strings in, strings out): the backends'
 * `writeConfig` call these only when an agent has something mounted, so an agent with nothing mounted gets the exact bytes it got before.
 *
 *  - Claude Code: one JSON object per server in `mcp-config.json` (`--mcp-config`), under `mcpServers`;
 *  - Codex: one `[mcp_servers.<name>]` table (and a sub-table for the environment / headers) in the isolated `CODEX_HOME/config.toml`.
 *    TOML is where a value can break the file, so every string goes through `tomlBasic`, and the whole block is parsed again before
 *    it is used: a block that does not parse back to exactly what was meant is dropped (the caller keeps the config without it).
 *
 * These functions hold secret values (that is their job): they never log and never put one in an error message.
 */
import { parse as parseToml } from "smol-toml";
import { libraryMcpName, type LibraryMcpEntry } from "./mcp-mount.js";

/** What goes under `mcpServers` in Claude Code's file for one entry. */
export function claudeMcpEntry(entry: LibraryMcpEntry): Record<string, unknown> {
  if (entry.transport === "http") {
    return { type: "http", url: entry.url, ...(Object.keys(entry.headers).length ? { headers: entry.headers } : {}) };
  }
  return { command: entry.command, args: entry.args, ...(Object.keys(entry.env).length ? { env: entry.env } : {}) };
}

/**
 * A TOML basic string. Stricter than JSON.stringify, which is what the rest of the Codex writer uses for text AgEnD itself produces:
 * a secret or an argument can hold anything, so every control character (and DEL) is escaped, and a lone surrogate — which TOML
 * does not allow, even escaped — becomes U+FFFD.
 */
export function tomlBasic(value: string): string {
  let out = "\"";
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    const ch = value[i]!;
    if (ch === "\"") out += "\\\"";
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (c < 0x20 || c === 0x7f) out += `\\u${c.toString(16).padStart(4, "0")}`;
    else if (c >= 0xd800 && c <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { out += ch + value[i + 1]!; i++; } else out += "�";
    } else if (c >= 0xdc00 && c <= 0xdfff) out += "�";
    else out += ch;
  }
  return `${out}"`;
}

const bare = /^[A-Za-z0-9_-]+$/;
const tomlKey = (k: string): string => (bare.test(k) ? k : tomlBasic(k));

/** One entry as TOML tables. `name` is the config name (`agend-lib-<id>`). */
export function codexMcpToml(name: string, entry: LibraryMcpEntry): string {
  const table = `mcp_servers.${tomlKey(name)}`;
  const lines: string[] = [`[${table}]`];
  if (entry.transport === "stdio") {
    lines.push(`command = ${tomlBasic(entry.command)}`, `args = [${entry.args.map(tomlBasic).join(", ")}]`);
    const env = Object.entries(entry.env).sort(([a], [b]) => (a < b ? -1 : 1));
    if (env.length) lines.push("", `[${table}.env]`, ...env.map(([k, v]) => `${tomlKey(k)} = ${tomlBasic(v)}`));
  } else {
    lines.push(`url = ${tomlBasic(entry.url)}`);
    const headers = Object.entries(entry.headers).sort(([a], [b]) => (a < b ? -1 : 1));
    if (headers.length) lines.push("", `[${table}.http_headers]`, ...headers.map(([k, v]) => `${tomlKey(k)} = ${tomlBasic(v)}`));
  }
  lines.push("");
  return lines.join("\n");
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * All mounted entries as one TOML block (each starts after a blank line, as the agend server's table does), plus the names that were
 * dropped because their text did not read back as the entry they came from. The check parses the block and compares the result with
 * the entry — an escape that was wrong, or a value that ended a string early, shows up as a difference.
 */
export function codexMcpBlock(entries: Readonly<Record<string, LibraryMcpEntry>>): { text: string; dropped: string[] } {
  let text = "";
  const dropped: string[] = [];
  for (const name of Object.keys(entries).sort()) {
    const entry = entries[name]!;
    const block = codexMcpToml(name, entry);
    if (!roundTrips(name, entry, block)) { dropped.push(name); continue; }
    text += `\n${block}`;
  }
  return { text, dropped };
}

function roundTrips(name: string, entry: LibraryMcpEntry, block: string): boolean {
  try {
    const parsed = parseToml(block) as { mcp_servers?: Record<string, Record<string, unknown>> };
    const got = parsed.mcp_servers?.[name];
    if (!got || Object.keys(parsed).length !== 1 || Object.keys(parsed.mcp_servers!).length !== 1) return false;
    if (entry.transport === "stdio") {
      return got.command === entry.command && same(got.args, entry.args)
        && (Object.keys(entry.env).length ? same(sorted(got.env), sorted(entry.env)) : got.env === undefined);
    }
    return got.url === entry.url
      && (Object.keys(entry.headers).length ? same(sorted(got.http_headers), sorted(entry.headers)) : got.http_headers === undefined);
  } catch { return false; }
}
const sorted = (o: unknown): unknown => (o && typeof o === "object" ? Object.fromEntries(Object.entries(o as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))) : o);

export { libraryMcpName };
