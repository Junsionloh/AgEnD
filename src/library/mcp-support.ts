/**
 * AGEND-261: which backends can be given a library MCP server. One table, read by the launch code (fleet-manager.ts), by the Library
 * overview and by the agent settings page (through the API), so none of them keeps a list of its own — the same way
 * `native-skills-dir.ts` answers it for skills.
 *
 * A backend is listed only when its config writer renders `CliBackendConfig.libraryMcp` (src/backend/claude-code.ts, codex.ts).
 * Every other backend ignores the field: the page says "this backend does not support library MCP yet" for it. Adding one is a
 * line here and the writer for it; nothing else changes.
 */
export const LIBRARY_MCP_BACKENDS: Readonly<Record<string, { config: string }>> = Object.freeze({
  // The instance folder's mcp-config.json, loaded with --mcp-config.
  "claude-code": { config: "mcp-config.json" },
  // The isolated CODEX_HOME's config.toml.
  "codex": { config: "config.toml" },
});

/** True when the backend's launch takes library MCP servers (own property only: a name from a config is not trusted). */
export function supportsLibraryMcp(backend: unknown): boolean {
  return typeof backend === "string" && Object.hasOwn(LIBRARY_MCP_BACKENDS, backend);
}
