import type { AdapterCapabilities, CliAdapter, InstanceRunner } from "./types.js";
import { tmuxCapabilities } from "./tmux-adapter.js";

/** The adapter each runner was built by. Weak: a runner that is dropped takes its entry with it. */
const adapters = new WeakMap<object, CliAdapter>();

export function bindAdapter(adapter: CliAdapter): void {
  adapters.set(adapter.runner, adapter);
}

export function adapterOf(runner: InstanceRunner): CliAdapter | undefined {
  return adapters.get(runner);
}

/**
 * What a running instance's adapter can do. A runner with no adapter bound is a `tmux` daemon built before adapters
 * existed (or a test double for one): `tmux` is the only adapter that ever lacks a binding.
 */
export function capabilitiesOf(runner: InstanceRunner | undefined): AdapterCapabilities {
  return (runner && adapters.get(runner)?.capabilities) ?? tmuxCapabilities("");
}

/** The message a pane-only operation gives when the instance's adapter has no pane. */
export function noPaneMessage(instance: string, operation: string): string {
  return `${operation} is not available for "${instance}": its adapter has no terminal pane.`;
}

/** Interrupt the running turn through the instance's adapter (the daemon's own cancel key when none is bound). */
export function cancelRunner(runner: InstanceRunner): Promise<void> {
  const adapter = adapters.get(runner);
  return adapter ? adapter.cancel() : runner.sendEscape();
}
