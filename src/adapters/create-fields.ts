import { cliAdapterProblem } from "./config.js";

/**
 * The adapter fields of a create-instance request (`POST /ui/instances`), judged once:
 *  - `cli_adapter` must be acceptable for the backend the new agent will run (its own, else the fleet default, else
 *    claude-code). `tmux` is the default, so it is not written: the field is dropped rather than stored.
 *  - `acp_always_approve` must be a boolean and only means something with `acp`; it is written only when true.
 */
export function createInstanceAdapterFields<T extends Record<string, unknown>>(
  args: T,
  defaultBackend: string | undefined,
): { ok: true; args: T } | { ok: false; error: string } {
  const { cli_adapter, acp_always_approve, ...rest } = args;
  if (cli_adapter === undefined && acp_always_approve === undefined) return { ok: true, args };
  const backend = (typeof args.backend === "string" ? args.backend : undefined) ?? defaultBackend ?? "claude-code";
  if (cli_adapter !== undefined && cli_adapter !== null) {
    const problem = cliAdapterProblem(cli_adapter, backend);
    if (problem) return { ok: false, error: `cli_adapter ${problem}` };
  }
  if (acp_always_approve !== undefined && typeof acp_always_approve !== "boolean") {
    return { ok: false, error: "acp_always_approve must be a boolean" };
  }
  if (acp_always_approve === true && cli_adapter !== "acp") {
    return { ok: false, error: 'acp_always_approve only applies with cli_adapter "acp"' };
  }
  return {
    ok: true,
    args: {
      ...rest,
      ...(cli_adapter === "acp" ? { cli_adapter: "acp" } : {}),
      ...(cli_adapter === "acp" && acp_always_approve === true ? { acp_always_approve: true } : {}),
    } as unknown as T,
  };
}
