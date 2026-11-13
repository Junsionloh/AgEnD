import type { CliBackend } from "../backend/types.js";
import { bindAdapter } from "./registry.js";
import { TmuxAdapter, tmuxCapabilities } from "./tmux-adapter.js";
import { cliAdapterProblem } from "./config.js";
import type { AdapterCapabilities, TmuxRunner } from "./types.js";

/** How to build each adapter's runner; `selectAdapter` calls exactly one. */
export interface AdapterBuilders {
  tmux(): { runner: TmuxRunner; backend: Pick<CliBackend, "getSessionId"> };
}

/**
 * The one place that chooses how an instance runs. Phase 0: always `tmux`. A `cli_adapter` that is not supported
 * throws; it is refused at config load first, so this is the backstop for a config that never went through it.
 * The result is typed as the concrete `TmuxAdapter` while it is the only adapter: the lifecycle still wires the
 * daemon's tmux-specific hooks on `adapter.runner`. It widens to `CliAdapter` when a second adapter exists.
 */
export function selectAdapter(backendName: string, config: { cli_adapter?: unknown }, build: AdapterBuilders): TmuxAdapter {
  const problem = cliAdapterProblem(config.cli_adapter);
  if (problem) throw new Error(`cli_adapter ${problem}`);
  const { runner, backend } = build.tmux();
  const adapter = new TmuxAdapter(runner, backend, backendName);
  bindAdapter(adapter);
  return adapter;
}

/** What an instance's configured adapter can do, for callers with no running instance (the CLI reading fleet.yaml). */
export function configuredCapabilities(backendName: string, config: { cli_adapter?: unknown }): AdapterCapabilities {
  const problem = cliAdapterProblem(config.cli_adapter);
  if (problem) throw new Error(`cli_adapter ${problem}`);
  return tmuxCapabilities(backendName);
}
