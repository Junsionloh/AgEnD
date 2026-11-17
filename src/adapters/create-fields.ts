import { cliAdapterProblem } from "./config.js";

/**
 * The adapter fields of a create-instance request (`POST /ui/instances`), judged once:
 *  - `cli_adapter` must be acceptable for the backend the new agent will run (its own, else the fleet default, else
 *    claude-code). `tmux` is the default, so it is not written: the field is dropped rather than stored.
 *  - Permissions are not a create-time choice: `skipPermissions` is on by default, as for tmux, and is changed in Settings.
 */
export function createInstanceAdapterFields<T extends Record<string, unknown>>(
  args: T,
  defaultBackend: string | undefined,
): { ok: true; args: T } | { ok: false; error: string } {
  const { cli_adapter, ...rest } = args;
  if (cli_adapter === undefined) return { ok: true, args };
  const backend = (typeof args.backend === "string" ? args.backend : undefined) ?? defaultBackend ?? "claude-code";
  if (cli_adapter !== undefined && cli_adapter !== null) {
    const problem = cliAdapterProblem(cli_adapter, backend);
    if (problem) return { ok: false, error: `cli_adapter ${problem}` };
  }
  return {
    ok: true,
    args: {
      ...rest,
      ...(cli_adapter === "acp" ? { cli_adapter: "acp" } : {}),
    } as unknown as T,
  };
}
