/**
 * The `cli_adapter` setting, kept free of imports so the config loader and validator can use it without pulling in
 * the runtime (the setup host must not be able to reach the daemon).
 */

/** The adapters `cli_adapter` may name. Only `tmux` exists; a later phase adds ids here together with the code. */
export type CliAdapterId = "tmux";

/** Adapters a `cli_adapter` value may name today. */
export const SUPPORTED_CLI_ADAPTERS: readonly CliAdapterId[] = ["tmux"];

/**
 * Why a `cli_adapter` value is refused, or null when it is acceptable. Absent (or null) means `tmux`.
 * One rule for the config validator, the loader and `selectAdapter`.
 */
export function cliAdapterProblem(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return "must be a string";
  if ((SUPPORTED_CLI_ADAPTERS as readonly string[]).includes(value)) return null;
  return `"${value}" is not supported yet (only "tmux" is available; leave it unset for the default)`;
}
