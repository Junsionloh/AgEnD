import type { EventEmitter } from "node:events";
import type { Daemon } from "../daemon.js";

/**
 * Adapter interface (#3731, phase 0).
 *
 * Two layers:
 *  - `CliAdapter` is what differs by CLI protocol, one per instance. It is the only thing `selectAdapter` chooses.
 *  - `InstanceRunner` is what the rest of the fleet calls on a running instance. For `tmux` the two layers are one
 *    object's worth of behaviour: `Daemon` already is the runner (crash/backoff, idle/busy state, hang timer, delivery,
 *    pause/wake) and also owns the pane, so `TmuxAdapter` is a thin facade over it and `Daemon` satisfies
 *    `InstanceRunner` as it is.
 */

import type { CliAdapterId } from "./config.js";
export type { CliAdapterId };

/** What an adapter can do. Read by the validator, the web API and the UI instead of testing an adapter's name. */
export interface AdapterCapabilities {
  /** A message sent while a turn runs is taken into that turn. tmux: per backend (src/steer-capability.ts). */
  readonly steer: boolean;
  /** Permission requests arrive as structured requests that can be answered by id. tmux: false (dialogs are scraped). */
  readonly livePermissions: boolean;
  /** Thinking text is available while the turn runs. tmux: false (it is read from the transcript afterwards). */
  readonly liveThought: boolean;
  /** A structured source for context usage exists. */
  readonly contextUsage: boolean;
  /** A structured source for quota / rate-limit windows exists. */
  readonly quota: boolean;
  /** There is a terminal pane: attach, pane capture, raw keys and the web terminal make sense. True only for tmux. */
  readonly paneView: boolean;
}

export type PermissionDecision = { readonly optionId: string } | { readonly cancelled: true };

export interface PromptRequest {
  readonly content: string;
  readonly meta: Record<string, string>;
  /** Delivery epoch captured when the message was admitted; a stale epoch means the user cancelled it. */
  readonly deliveryEpoch?: number;
  readonly targetSession?: string;
}

export interface PromptAck {
  /** The runner took the message. Whether and when the CLI consumed it is reported by the delivery path, not here. */
  readonly accepted: true;
}

export interface AdapterStartContext {
  /** Throws when the start has been superseded; called before and after the spawn. */
  readonly admission?: () => void;
}

export interface AdapterHealth {
  readonly process: "running" | "crashed" | "stopped";
  /** Time of the last event the adapter emitted; null when it has no event stream (tmux). */
  readonly lastEventAt: number | null;
}

/** What every structured adapter translates its wire format into. `tmux` emits none (see `TmuxAdapter.events`). */
export type AdapterEvent =
  | { kind: "thought"; text: string }
  | { kind: "message"; text: string }
  | { kind: "tool"; id: string; title: string; toolKind: string; status: "pending" | "in_progress" | "completed" | "failed"; rawInput?: unknown; rawOutput?: unknown }
  | { kind: "plan"; entries: unknown[] }
  | { kind: "permission"; requestId: string; tool: unknown; options: { id: string; name: string; kind: string }[] }
  | { kind: "usage"; used?: number; size?: number }
  | { kind: "quota"; window?: string; resetsAt?: number }
  | { kind: "turn_end"; stopReason: string }
  | { kind: "auth_required" };

/**
 * Exactly the members other modules call on a running instance's runner (found by changing `lifecycle.daemons` to this
 * type and letting the compiler list what was missing). Signatures are taken from `Daemon`, so the two cannot drift;
 * a new caller that needs another member adds its name here.
 */
type RunnerMembers = Pick<Daemon,
  | "bootId" | "isPaused" | "lastPausedAt" | "usageHold" | "notAcceptingReason"
  | "isErrorState" | "isCrashLoop" | "errorStateCause" | "lastErrorType"
  | "getConfigSnapshot" | "applyConfigUpdate" | "getInstanceState" | "getInteractionSnapshot"
  | "getProcessStatus" | "getWorkingStateObservation" | "getWorkingRecoveryState" | "deliverWorkingRecovery"
  | "getModelOverride" | "setModelOverride" | "launchSupportsSteer" | "isNewSession" | "logLaunch" | "logTranscriptPath"
  | "stop" | "waitForIdle" | "requestPauseWhenIdle" | "pause" | "wake" | "waitForPauseWakeTransition" | "hasPendingPauseWake"
  | "fenceDeliveryWritesForStop" | "waitForDeliveryWritesToDrain" | "clearPendingDeliveries"
  | "isSessionOomStopped" | "isUnclearOomStopped" | "collectHandoverContext"
  | "captureHumanReceiptOwner" | "humanReceiptWire" | "answerRemoteCard" | "repostRemoteCard"
  | "subagentSource" | "sendEscape" | "seedErrorPatternOccurrenceCount" | "noteLegacyRestartReminder"
  | "kiroMigrationIdle" | "kiroMigrationObservation" | "getPaneContextSource" | "compactPaneUi"
  | "confirmAuthFailure" | "clearSuspectedAuthFailure"
  // Windows Runtime (native pane) and later callers: a native pane is a tmux-adapter feature, so these are all `tmux`.
  | "usesNativePane" | "nativePaneCurrent" | "nativePaneHasExited" | "nativePauseReady" | "nativePauseStillReady"
  | "nativePaneCliVersion" | "nativeDeliveryHold" | "reconcileNativeDeliveries"
  | "getInstanceStateSnapshot" | "generalHostOwner" | "quotaPaused" | "modelObservation"
  | "noteHumanReceiptSettlement" | "registerHumanReceiptPreparation"
>;

/** What the fleet holds per running instance. Events are the existing daemon events (`on`/`once`/`off`). */
export interface InstanceRunner extends RunnerMembers, EventEmitter {}

/** The `tmux` runner is the daemon itself, with everything it has (the lifecycle still wires its tmux-specific hooks). */
export type TmuxRunner = Daemon;

export interface CliAdapter {
  readonly id: CliAdapterId;
  readonly capabilities: AdapterCapabilities;
  /** The runner the fleet holds for this instance (`lifecycle.daemons`). */
  readonly runner: InstanceRunner;

  // lifecycle
  start(ctx: AdapterStartContext): Promise<void>;
  stop(): Promise<void>;
  health(): AdapterHealth;

  // turn control
  sendPrompt(request: PromptRequest): PromptAck;
  /** Present only when `capabilities.steer` can be true for this adapter. */
  steer?(content: string, meta: Record<string, string>, deliveryEpoch?: number): void;
  cancel(): Promise<void>;
  /** Answers a structured permission request. Returns false when this adapter has no such request to answer. */
  answerPermission(requestId: string, decision: PermissionDecision): boolean;

  // observation
  events(): AsyncIterable<AdapterEvent>;
  sessionId(): string | null;
}
