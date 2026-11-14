/**
 * The `cli_adapter` setting, kept free of imports so the config loader and validator can use it without pulling in
 * the runtime (the setup host must not be able to reach the daemon).
 */

/** The adapters `cli_adapter` may name. An id is added together with the code that implements it. */
export type CliAdapterId = "tmux" | "acp";

/** Adapters a `cli_adapter` value may name. */
export const SUPPORTED_CLI_ADAPTERS: readonly CliAdapterId[] = ["tmux", "acp"];

/**
 * Which backends each adapter may run (design §2.1). `tmux` runs every backend, so it is not listed. A backend that
 * is not listed for an adapter is refused at config load, never at launch.
 */
export const ADAPTER_BACKENDS: Readonly<Record<Exclude<CliAdapterId, "tmux">, readonly string[]>> = {
  acp: ["grok", "antigravity"],
};

/** The adapters the UI may offer for `backend` (always starts with `tmux`). */
export function adaptersForBackend(backend: string): CliAdapterId[] {
  return SUPPORTED_CLI_ADAPTERS.filter(id => id === "tmux" || ADAPTER_BACKENDS[id].includes(backend));
}

/**
 * Why a `cli_adapter` value is refused, or null when it is acceptable. Absent (or null) means `tmux`.
 * One rule for the config validator, the loader and `selectAdapter`. `backend` is the instance's effective backend;
 * without one only `tmux` is acceptable (a structured adapter always runs one specific CLI).
 */
export function cliAdapterProblem(value: unknown, backend?: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return "must be a string";
  if (value === "tmux") return null;
  if (!(SUPPORTED_CLI_ADAPTERS as readonly string[]).includes(value)) {
    return `"${value}" is not supported yet (use "tmux", or "acp" for ${ADAPTER_BACKENDS.acp.join(" / ")}; leave it unset for the default)`;
  }
  const allowed = ADAPTER_BACKENDS[value as Exclude<CliAdapterId, "tmux">];
  if (backend === undefined) return `"${value}" is not supported yet without a backend (it is set per instance, for ${allowed.join(" / ")})`;
  if (!allowed.includes(backend)) return `"${value}" is not supported yet for backend "${backend}" (only ${allowed.join(" / ")})`;
  return null;
}

/**
 * Why a Windows runtime agent may not name an adapter, or null when it names none. A Windows agent runs through its own
 * `native_adapter` (`exec` or `pane`); `cli_adapter` and `acp_always_approve` are for an agent on this host, so setting
 * either on one is refused at config load instead of being quietly ignored. The one rule for the loader and the validator.
 */
export function windowsAdapterProblem(inst: { cli_adapter?: unknown; acp_always_approve?: unknown }): { key: "cli_adapter" | "acp_always_approve"; message: string } | null {
  for (const key of ["cli_adapter", "acp_always_approve"] as const) {
    if (inst[key] !== undefined && inst[key] !== null) {
      return { key, message: `is not accepted for a Windows runtime agent (it runs through native_adapter: exec or pane, and its behaviour does not change)` };
    }
  }
  return null;
}

/**
 * An `acp` instance runs the CLI under its own sign-in (the one `agy acp --login` / the CLI's login writes): the
 * adapter does not yet pass a named account (`backend_options.<cli>.credential_profile`) to the child, so naming one
 * is refused instead of quietly running under the default login. Null when there is nothing to refuse.
 */
export function acpAccountProblem(inst: { cli_adapter?: unknown; backend_options?: unknown }, backend: string): string | null {
  if (inst.cli_adapter !== "acp") return null;
  const options = inst.backend_options && typeof inst.backend_options === "object" ? (inst.backend_options as Record<string, unknown>)[backend] : undefined;
  const profile = options && typeof options === "object" ? (options as Record<string, unknown>).credential_profile : undefined;
  if (profile === undefined || profile === null || profile === "") return null;
  return `cli_adapter: acp runs under the CLI's own sign-in; a named account (backend_options.${backend}.credential_profile) is not supported with it yet`;
}
