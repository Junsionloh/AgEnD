import { adapterOf } from "./registry.js";
import type { CliAdapterId } from "./config.js";
import type { InstanceRunner } from "./types.js";

/** What the web UI needs to know about how an instance runs (the status frame carries it per instance). */
export interface AdapterUiView {
  /** The effective `cli_adapter` (an unset one is `tmux`). */
  cli_adapter: CliAdapterId;
  /** There is a terminal pane: attach, pane capture, raw keys and the web terminal make sense. */
  pane_view: boolean;
  /** `acp` only: every permission request is approved without asking. */
  acp_always_approve?: boolean;
}

/**
 * The adapter view of one instance. A running instance answers with what its bound adapter can do; one that is not
 * running (or has no adapter bound) answers from its configuration: only `tmux` has a pane.
 */
export function adapterUiView(
  runner: InstanceRunner | undefined,
  config: { cli_adapter?: unknown; acp_always_approve?: unknown } | undefined,
  defaults?: { cli_adapter?: unknown },
): AdapterUiView {
  const configured = config?.cli_adapter ?? defaults?.cli_adapter;
  const cli_adapter: CliAdapterId = configured === "acp" ? "acp" : "tmux";
  const bound = runner ? adapterOf(runner) : undefined;
  const pane_view = bound ? bound.capabilities.paneView : cli_adapter === "tmux";
  return { cli_adapter, pane_view, ...(cli_adapter === "acp" ? { acp_always_approve: config?.acp_always_approve === true } : {}) };
}
