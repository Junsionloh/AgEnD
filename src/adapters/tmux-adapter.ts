import type { CliBackend } from "../backend/types.js";
import { backendSupportsSteer } from "../steer-capability.js";
import type {
  AdapterCapabilities, AdapterEvent, AdapterHealth, AdapterStartContext, CliAdapter, PermissionDecision,
  PromptAck, PromptRequest, TmuxRunner,
} from "./types.js";

/** What `tmux` provides for a backend. Every flag but `steer` is fixed by what the adapter is. */
export function tmuxCapabilities(backendName: string): AdapterCapabilities {
  return {
    steer: backendSupportsSteer(backendName),
    livePermissions: false, // dialogs are found by reading the pane, and answered by pressing keys
    liveThought: false, // thinking text is read from the transcript after the fact
    contextUsage: true, // footer / statusline / transcript
    quota: true, // pane notices and the backend usage probes
    paneView: true,
  };
}

/**
 * The first adapter: today's tmux execution, unchanged. A thin facade; every method forwards to the `Daemon` (which
 * holds the pane, the state machine and delivery) or to its `CliBackend`. No daemon code moved to make this possible.
 */
export class TmuxAdapter implements CliAdapter {
  readonly id = "tmux" as const;
  readonly capabilities: AdapterCapabilities;

  constructor(
    /** The daemon is the runner: it satisfies `InstanceRunner` as it is. */
    readonly runner: TmuxRunner,
    private readonly backend: Pick<CliBackend, "getSessionId">,
    backendName: string,
  ) {
    this.capabilities = tmuxCapabilities(backendName);
  }

  start(ctx: AdapterStartContext): Promise<void> {
    // Same call shape the lifecycle always used: no argument when there is no admission fence.
    return ctx.admission ? this.runner.start(ctx.admission) : this.runner.start();
  }

  stop(): Promise<void> {
    return this.runner.stop();
  }

  health(): AdapterHealth {
    // The daemon's process state. There is no event stream, so there is no "last event" time.
    return { process: this.runner.getProcessStatus(), lastEventAt: null };
  }

  sendPrompt(request: PromptRequest): PromptAck {
    // The same entry the daemon's own IPC handler uses for an inbound message.
    if (request.deliveryEpoch === undefined) this.runner.pushChannelMessage(request.content, request.meta, request.targetSession);
    else this.runner.pushChannelMessage(request.content, request.meta, request.targetSession, request.deliveryEpoch);
    return { accepted: true };
  }

  steer(content: string, meta: Record<string, string>, deliveryEpoch?: number): void {
    if (deliveryEpoch === undefined) this.runner.steerMessage(content, meta);
    else this.runner.steerMessage(content, meta, deliveryEpoch);
  }

  /** Cancel is the backend's cancel key sent to the pane (Escape for most). */
  cancel(): Promise<void> {
    return this.runner.sendEscape();
  }

  /**
   * Always false: under tmux a permission request is a dialog on the screen. The daemon recognises it by reading the
   * pane and a human answers it with keys (`livePermissions` is false), so there is no request id to answer.
   */
  answerPermission(_requestId: string, _decision: PermissionDecision): boolean {
    return false;
  }

  /**
   * Always empty: tmux has no push stream. Chat steps are built from the transcript file and state from the pane by the
   * existing monitors, which keep working exactly as before; they are not re-expressed as events in phase 0.
   */
  events(): AsyncIterable<AdapterEvent> {
    return { [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true as const, value: undefined }) }) };
  }

  sessionId(): string | null {
    return this.backend.getSessionId?.() ?? null;
  }
}
