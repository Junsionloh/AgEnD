import type { CliBackend } from "../backend/types.js";
import { bindAdapter } from "./registry.js";
import { TmuxAdapter, tmuxCapabilities } from "./tmux-adapter.js";
import { cliAdapterProblem } from "./config.js";
import { acpProfileFor } from "./acp/profiles.js";
import type { AcpAdapter } from "./acp/acp-adapter.js";
import type { AdapterCapabilities, TmuxRunner } from "./types.js";

/** How to build each adapter's runner; `selectAdapter` calls exactly one. */
export interface AdapterBuilders {
  tmux(): { runner: TmuxRunner; backend: Pick<CliBackend, "getSessionId"> };
  /** Builds an `AcpAdapter` (and the runner it hosts) for the backend's ACP profile. */
  acp?(): AcpAdapter;
}

/**
 * The one place that chooses how an instance runs: `tmux` unless the instance says `cli_adapter: acp`. A value that
 * is not supported for the backend throws; it is refused at config load first, so this is the backstop for a config
 * that never went through it. There is no fallback from one adapter to the other.
 */
export function selectAdapter(backendName: string, config: { cli_adapter?: unknown }, build: AdapterBuilders): TmuxAdapter | AcpAdapter {
  const problem = cliAdapterProblem(config.cli_adapter, backendName);
  if (problem) throw new Error(`cli_adapter ${problem}`);
  if (config.cli_adapter === "acp") {
    if (!build.acp) throw new Error("cli_adapter acp is not available here");
    const adapter = build.acp();
    bindAdapter(adapter);
    return adapter;
  }
  const { runner, backend } = build.tmux();
  const adapter = new TmuxAdapter(runner, backend, backendName);
  bindAdapter(adapter);
  return adapter;
}

/** What an instance's configured adapter can do, for callers with no running instance (the CLI reading fleet.yaml). */
export function configuredCapabilities(backendName: string, config: { cli_adapter?: unknown }): AdapterCapabilities {
  const problem = cliAdapterProblem(config.cli_adapter, backendName);
  if (problem) throw new Error(`cli_adapter ${problem}`);
  if (config.cli_adapter === "acp") return acpProfileFor(backendName)!.capabilities;
  return tmuxCapabilities(backendName);
}
