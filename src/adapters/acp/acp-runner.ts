import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IpcServer } from "../../channel/ipc-bridge.js";
import { daemonBudgetMs } from "../../channel/ipc-timeouts.js";
import { formatHumanInboundMessage } from "../../human-delivery-receipts.js";
import { formatCrossInstanceInboundMessage } from "../../cross-instance-envelope.js";
import { HangDetector } from "../../hang-detector.js";
import { clearPausedMarker, readPausedAt, writePausedMarker, type PauseReason } from "../../pause-marker.js";
import { turnExpectsPersonReply } from "../../turn-reply-guard.js";
import type { InteractionSnapshot, InstanceState, InstanceStateSnapshot } from "../../backend/types.js";
import type { DeliveryOutbox } from "../../delivery-outbox.js";
import type { InstanceConfig } from "../../types.js";
import type { WorkingStateObservation } from "../../working-state-journal.js";
import type { RecoveryLive } from "../../working-recovery.js";
import { AcpAuthRequiredError, AcpVersionRefusedError, type AcpAdapter } from "./acp-adapter.js";
import { AcpStepStore } from "./steps.js";
import type { LiveSteps } from "../../log-service.js";
import type { AdapterEvent } from "../types.js";

type Logger = { info(o: object, m?: string): void; warn(o: object, m?: string): void; error(o: object, m?: string): void; debug(o: object, m?: string): void };
type Socket = import("node:net").Socket;
type Msg = Record<string, unknown>;

export interface AcpRunnerOptions {
  readonly name: string;
  readonly config: InstanceConfig;
  readonly instanceDir: string;
  readonly topicMode: boolean;
  readonly backend: string;
  readonly logger: Logger;
  /** Waits before each respawn after a crash (the last repeats). */
  readonly respawnDelaysMs?: readonly number[];
  /** This many crashes within the window stop the respawning (`crash_loop`). */
  readonly crashLoop?: { readonly count: number; readonly windowMs: number };
  /** A running turn with no word from the agent this long is reported as hung. */
  readonly hangAfterMs?: number;
  readonly hangCheckEveryMs?: number;
  readonly now?: () => number;
}

interface InboundItem {
  readonly content: string;
  readonly meta: Record<string, string>;
  readonly epoch: number;
  readonly turnId: string;
}

const FLEET_RESPONSE_TYPES = new Set([
  "fleet_schedule_response", "fleet_outbound_response", "fleet_decision_response", "fleet_task_response",
  "fleet_display_name_response", "fleet_description_response", "fleet_persona_emoji_response", "fleet_web_theme_response",
]);
const CROSS_INSTANCE_TOOLS = new Set(["send_to_instance", "broadcast", "list_instances", "start_instance", "restart_instance", "create_instance", "delete_instance", "replace_instance", "request_information", "delegate_task", "report_result", "delivery_status", "describe_instance"]);
const TURN_OUTBOUND_TOOLS = new Set(["reply", "react", "edit_message", "send_to_instance", "report_result", "request_information", "delegate_task", "broadcast"]);
const TYPED_TOOLS: Readonly<Record<string, { type: string; prefix: string }>> = {
  set_display_name: { type: "fleet_set_display_name", prefix: "dn" }, set_description: { type: "fleet_set_description", prefix: "desc" },
  list_emojis: { type: "fleet_list_emojis", prefix: "emoji" }, preview_emojis: { type: "fleet_preview_emojis", prefix: "emoji" },
  list_stickers: { type: "fleet_list_stickers", prefix: "emoji" }, preview_stickers: { type: "fleet_preview_stickers", prefix: "emoji" },
  set_persona_emoji: { type: "fleet_set_persona_emoji", prefix: "emoji" },
  task: { type: "fleet_task", prefix: "task" },
  post_decision: { type: "fleet_decision_create", prefix: "dec" }, list_decisions: { type: "fleet_decision_list", prefix: "dec" }, update_decision: { type: "fleet_decision_update", prefix: "dec" },
  create_schedule: { type: "fleet_schedule_create", prefix: "sched" }, list_schedules: { type: "fleet_schedule_list", prefix: "sched" },
  update_schedule: { type: "fleet_schedule_update", prefix: "sched" }, delete_schedule: { type: "fleet_schedule_delete", prefix: "sched" },
};
/** Tools that read files on the agent's side before sending (the tmux daemon does it); not available here. */
const UNSUPPORTED_TOOLS = new Set(["checkout_repo", "release_repo", "get_web_theme", "set_web_theme", "set_web_theme_asset", "reset_web_theme", "get_web_appearance", "preview_web_appearance",
  "set_web_widget", "remove_web_widget", "set_web_ambient", "clear_web_ambient", "office_view", "office_set", "office_pack_check", "office_pack_upload", "office_pack_delete",
  "office_pack_restore", "office_pack_list", "office_set_style"]);

/** AgEnD's own MCP tools that still ask a person, whatever the policy for the rest of the server: they change the fleet. */
const OWN_TOOLS_ASK: ReadonlySet<string> = new Set(["create_instance", "delete_instance", "replace_instance", "start_instance", "restart_instance", "checkout_repo", "release_repo"]);

/**
 * The tool's name when the request is for a tool of this instance's own `agend` MCP server, else null — and null means
 * "ask". Only fields the CLI itself sets are believed; `rawInput` (the model's arguments) and `title` (display text, and
 * for a shell tool the command line) can both be made to say `agend__reply`, so neither is ever read on its own.
 * Shapes, from real permission requests (grok 1.0.77, agy 1.5.9; tests/fixtures/acp/*agend-tool-permission*):
 *  - grok: `kind: "other"`, `_meta["x.ai/tool"].name === "use_tool"`, `rawInput.variant === "UseTool"` (the CLI's own
 *    discriminator; the model's arguments are nested under `tool_input`) and `rawInput.tool_name === "agend__<tool>"`.
 *    A Bash or Write call has another variant and another `_meta` name, whatever extra keys the model puts in its input.
 *  - agy: `kind: "other"` and the tool's registered name in `name` (`mcp_agend_<tool>`); its `rawInput` is the model's
 *    arguments and its `title` is "Run <name>", so only `name` is read. A shell or file tool has its own name and kind.
 */
export function ownToolName(tool: unknown): string | null {
  const t = tool && typeof tool === "object" ? tool as Record<string, unknown> : null;
  if (!t || t.kind !== "other") return null;
  const input = t.rawInput && typeof t.rawInput === "object" ? t.rawInput as Record<string, unknown> : null;
  const meta = t._meta && typeof t._meta === "object" ? (t._meta as Record<string, unknown>)["x.ai/tool"] : undefined;
  const grokMeta = meta && typeof meta === "object" ? meta as Record<string, unknown> : null;
  let candidate: unknown;
  if (grokMeta) {
    if (grokMeta.name !== "use_tool" || !input || input.variant !== "UseTool") return null;
    candidate = input.tool_name;
  } else {
    candidate = t.name;
  }
  if (typeof candidate !== "string") return null;
  const m = (grokMeta ? /^agend__([a-z][a-z0-9_]{0,63})$/ : /^mcp_agend_([a-z][a-z0-9_]{0,63})$/).exec(candidate);
  return m ? m[1]! : null;
}

const DEFAULT_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];
const PROXY_TEXT_MAX = 12_000;

/**
 * The fleet-facing side of an ACP instance: what `Daemon` is for a tmux instance, written once for every ACP CLI.
 * It owns the instance's IPC socket (the MCP server and the fleet talk to it), serialises inbound messages into
 * turns, tracks busy/idle/hung, respawns the agent after a crash with backoff, applies the permission policy,
 * builds the chat timeline from adapter events, and reports delivery to the outbox. The protocol itself is the
 * adapter's.
 */
export class AcpRunner extends EventEmitter {
  readonly bootId = randomUUID();
  readonly steps: AcpStepStore;
  private readonly hang = new HangDetector();
  private ipc: IpcServer | null = null;
  private config: InstanceConfig;
  private readonly now: () => number;

  private outbox: DeliveryOutbox | undefined;
  private decisionSource: (() => readonly { title: string; content: string }[]) | undefined;
  private decisionTeams: (() => string[]) | undefined;
  private statusEmojis: (() => string[] | undefined) | undefined;
  private modelOverride: string | undefined;

  // lifecycle
  private started = false;
  private stopping = false;
  private pausedAt: number | null = null;
  private pauseWake: "active" | "pausing" | "paused" | "waking" = "active";
  private pauseWhenIdle = false;
  private pauseTransition: Promise<void> | null = null;
  private spawnGeneration = 0;
  private crashTimes: number[] = [];
  private respawnTimer: NodeJS.Timeout | null = null;
  private crashLoop = false;
  private errorCause: "unsupervised" | "tmux_recovering" | "error_detected" | null = null;
  private lastError: string | null = null;
  private hangTimer: NodeJS.Timeout | null = null;
  private hangEmitted = false;

  // turns
  private chain: Promise<void> = Promise.resolve();
  private queued = 0;
  private deliveryEpoch = 0;
  private writesFenced = false;
  private busy = false;
  private stuck = false;
  private stateChangedAt: number;
  private lastActivityAt = 0;
  private turn: { item: InboundItem; startedAt: number; text: string; outbound: boolean; consumed: boolean; deliveryId: string | null; attemptNo: number; cancelled: boolean } | null = null;
  private turnSeq = 0;
  private readonly idleWaiters = new Set<() => void>();
  private lastChatId = ""; private lastThreadId: string | undefined; private lastAdapterId: string | undefined;
  private readonly cancelledHumans: { chatId: string; messageId: string; threadId?: string }[] = [];
  private cancelledHumansTimer: NodeJS.Timeout | null = null;

  // fleet requests
  private readonly pending = new Map<string, (msg: Msg) => void>();
  private fleetSeq = 0;
  private readonly sessionNames = new Map<Socket, string>();

  constructor(readonly adapter: AcpAdapter, private readonly opts: AcpRunnerOptions) {
    super();
    this.config = opts.config;
    this.now = opts.now ?? Date.now;
    this.stateChangedAt = this.now();
    this.steps = new AcpStepStore(opts.instanceDir, this.now);
    this.steps.onChange(() => this.emit("steps_changed"));
    this.restoreLastChat();
    adapter.onEvent(e => this.onAdapterEvent(e));
    adapter.onExit(info => this.onAdapterExit(info));
    const stored = readPausedAt(opts.instanceDir);
    if (stored !== null) this.pausedAt = stored;
  }

  /** The chat timeline, for the Log's live source: this boot's own cursor space. */
  get liveSteps(): LiveSteps {
    // The page's `key` parameter is `<digits>-<digits>` (a transcript's device-inode): this boot's id, as two numbers.
    const [a, b] = [this.bootId.slice(0, 8), this.bootId.slice(9, 13) + this.bootId.slice(14, 18)].map(h => parseInt(h, 16));
    return { key: `${a}-${b}`, snapshot: (after, o) => this.steps.snapshot(after, o), subscribe: l => this.steps.onChange(l) };
  }

  private get log(): Logger { return this.opts.logger; }
  get name(): string { return this.opts.name; }

  // ───────────────────────────────────────────────────────────────── the launch surface (what the lifecycle calls)

  /** Starts the IPC socket and the agent. Throws when the agent refuses (version gate, not signed in). */
  async start(admission?: () => void): Promise<void> {
    admission?.();
    await this.openIpc();
    admission?.();
    try {
      if (this.pausedAt === null) await this.launch(admission);
      else { this.pauseWake = "paused"; this.log.info({ name: this.name }, "acp: started paused; the agent starts on the next message"); }
    } catch (err) {
      await this.closeIpc();
      throw err;
    }
    this.started = true;
    this.startHangTimer();
  }

  /** Drops what a start that did not finish left behind. */
  async abortStartup(): Promise<void> {
    this.stopping = true;
    this.clearTimers();
    await this.adapter.stop().catch(() => undefined);
    await this.closeIpc();
  }

  setAgentCredentialIssuer(_issue?: (token: string) => void): void { /* the agent authenticates with its own CLI credentials */ }
  setDeliveryOutboxPort(outbox: DeliveryOutbox | undefined): void { this.outbox = outbox; }
  setWorkLeaseCheck(_check?: () => boolean): void { /* no auto-pause timer to guard */ }
  seedActivityNow(): void { this.lastActivityAt = this.now(); }
  setDecisionTeams(teams?: () => string[]): void { this.decisionTeams = teams; }
  setDecisionSource(source?: () => readonly { title: string; content: string }[]): void { this.decisionSource = source; }
  setPeerWorkingDirectories(_peers?: () => string[]): void { /* a tmux/kiro matter */ }
  setStatusEmojiAvoidList(list?: () => string[] | undefined): void { this.statusEmojis = list; }
  /** What a (re)launch needs from the fleet, read at each start so a restart sees current decisions. */
  launchInputs(): { decisions: readonly { title: string; content: string }[] | undefined; teams: string[]; statusEmojis: string[] | undefined; config: InstanceConfig } {
    let teams: string[] = [];
    try { teams = this.decisionTeams?.() ?? []; } catch { /* no teams: fleet and project decisions only */ }
    return { decisions: this.decisionSource?.(), teams, statusEmojis: this.statusEmojis?.(), config: this.config };
  }
  holdStartupIncidents(): void { /* no startup scan raises incidents */ }
  releaseStartupIncidents(): void { /* ditto */ }
  getHangDetector(): HangDetector { return this.hang; }

  // ───────────────────────────────────────────────────────────────── InstanceRunner

  get isPaused(): boolean { return this.pauseWake !== "active"; }
  get lastPausedAt(): number | null { return this.pausedAt; }
  usageHold(): { model: string; since: number } | null { return null; }
  notAcceptingReason(): string | null { return this.pausedAt !== null ? "paused" : this.crashLoop ? "crash loop" : null; }
  get isErrorState(): boolean { return this.errorCause !== null; }
  get errorStateCause(): "unsupervised" | "tmux_recovering" | "error_detected" | null { return this.errorCause; }
  get isCrashLoop(): boolean { return this.crashLoop; }
  get lastErrorType(): string | null { return this.lastError; }
  getConfigSnapshot(): InstanceConfig { return this.config; }
  applyConfigUpdate(value: unknown): void {
    if (value && typeof value === "object") this.config = { ...this.config, ...(value as Partial<InstanceConfig>) };
  }
  getInstanceState(): InstanceState | "paused" { return this.isPaused ? "paused" : this.stuck ? "stuck" : this.busy ? "working" : "idle"; }
  getProcessStatus(): "running" | "crashed" | "stopped" { return this.adapter.health().process; }
  launchSupportsSteer(): boolean | undefined { return false; }
  get isNewSession(): boolean { return this.adapter.isNewSession; }
  logLaunch(): null { return null; }
  logTranscriptPath(): null { return null; }
  getModelOverride(): string | undefined { return this.modelOverride; }
  setModelOverride(model: string | undefined): void { this.modelOverride = model; }
  isSessionOomStopped(): boolean { return false; }
  isUnclearOomStopped(): boolean { return false; }
  collectHandoverContext(): string { return ""; }
  captureHumanReceiptOwner(): string | null { return null; }
  humanReceiptWire(content: string, meta: Record<string, string>, _kind: string): string { return this.format(content, meta); }
  async answerRemoteCard(): Promise<{ outcome: "stale" }> { return { outcome: "stale" }; }
  repostRemoteCard(): void { /* permission requests are chat steps, not cards */ }
  subagentSource(): null { return null; }
  seedErrorPatternOccurrenceCount(): void { /* no pane error patterns */ }
  noteLegacyRestartReminder(): void { /* no legacy continuation */ }
  async kiroMigrationIdle(): Promise<boolean> { return false; }
  async kiroMigrationObservation(): Promise<null> { return null; }
  getPaneContextSource(): null { return null; }
  compactPaneUi(): null { return null; }
  confirmAuthFailure(): boolean { return false; }
  clearSuspectedAuthFailure(): boolean { return false; }

  /** A paused runner reads as `working`: a gate that waits for "idle" must not take a paused instance for a free one. */
  getInstanceStateSnapshot(): InstanceStateSnapshot {
    const at = this.now(), state = this.getInstanceState();
    return { state: state === "paused" ? "working" : state, unchangedForMs: 0, observedAt: at, stateChangedAt: at, interaction: this.getInteractionSnapshot() };
  }

  // What only the tmux runner has (a native pane, the model the CLI reports, a General host pane): an ACP runner has none of it.
  modelObservation(): null { return null; }
  quotaPaused(): boolean { return false; }
  usesNativePane(): boolean { return false; }
  nativePaneCliVersion(): undefined { return undefined; }
  nativePaneCurrent(): boolean { return false; }
  nativePaneHasExited(): boolean { return false; }
  async nativePauseReady(): Promise<boolean> { return false; }
  nativePauseStillReady(): boolean { return false; }
  nativeDeliveryHold(): null { return null; }
  async reconcileNativeDeliveries(): Promise<boolean> { return false; }
  async generalHostOwner(): Promise<never> { throw new Error("General host owner is unavailable: an ACP instance has no terminal pane"); }
  noteHumanReceiptSettlement(): void { /* no human-receipt reminders for an ACP runner */ }

  getInteractionSnapshot(): InteractionSnapshot {
    const waiting = this.steps.pendingPermissions().length > 0;
    const at = this.now();
    return {
      phase: waiting ? "waiting" : "clear", kind: waiting ? "permission" : null, reason: waiting ? "permission" : null,
      episode: null, owner: this.owner(), since: waiting ? at : null, observedAt: at, confirmedAt: waiting ? at : null,
      ageMs: waiting ? 0 : null, stale: false, suspected: false,
    };
  }

  private owner() { return { bootId: this.bootId, spawnGeneration: this.spawnGeneration, launchAttempt: this.spawnGeneration, launchFenceEpoch: this.spawnGeneration }; }

  getWorkingStateObservation(): WorkingStateObservation {
    const backend = this.opts.backend;
    const t = this.turn;
    return {
      owner: this.owner(), backend,
      configuration: createHash("sha256").update(JSON.stringify([backend, this.config.working_directory, "acp"])).digest("hex"),
      executionState: this.getProcessStatus() === "running" ? this.isPaused ? "paused" : this.stuck ? "stuck" : this.busy ? "working" : "idle" : null,
      processStatus: this.getProcessStatus(), sessionId: this.adapter.sessionId(), backendTurnId: null, backgroundWork: null,
      turn: t ? { generation: this.turnSeq, deliveryId: t.deliveryId, correlationId: t.item.meta.correlation_id ?? null, messageId: t.item.meta.message_id ?? null, cancelled: t.cancelled, completionDelivered: t.outbound } : null,
    };
  }

  /** Never continues an interrupted turn: ACP has no safe way to know what a half-finished turn already did. */
  getWorkingRecoveryState(): RecoveryLive {
    const o = this.getWorkingStateObservation();
    return { owner: JSON.stringify(o.owner), configuration: o.configuration, sessionId: o.sessionId, idle: false, paused: this.isPaused, stopped: false,
      legacyPending: false, legacyCovered: true, nativeWork: false, cancelled: true, background: null };
  }
  async deliverWorkingRecovery(_content: string, delivery: { deliveryId: string; attemptNo: number }): Promise<void> {
    this.outbox?.retryBeforeBegin(delivery.deliveryId, this.bootId, delivery.attemptNo, "acp instances do not continue interrupted work", 60_000);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.clearTimers();
    await this.settleOnStop("stopped");
    await this.adapter.stop().catch(() => undefined);
    this.wakeIdleWaiters();
    await this.closeIpc();
    this.steps.interrupt();
  }

  waitForIdle(quietMs = 5000): Promise<void> {
    if (!this.busy) return Promise.resolve();
    return new Promise(resolve => {
      const done = () => { clearTimeout(t); this.idleWaiters.delete(done); resolve(); };
      const t = setTimeout(done, Math.max(quietMs, 1000)); t.unref?.();
      this.idleWaiters.add(done);
    });
  }

  requestPauseWhenIdle(opts: { reconfirmAuth?: boolean; reason?: PauseReason } = {}): void {
    if (this.pauseWake === "paused") return;
    if (!this.busy) { void this.pause(opts.reason ?? "auth"); return; }
    this.pauseWhenIdle = true;
  }

  get hasPendingPauseWake(): boolean { return this.pauseWake === "pausing" || this.pauseWake === "waking"; }
  async waitForPauseWakeTransition(): Promise<void> { await this.pauseTransition?.catch(() => undefined); }

  async pause(reason: PauseReason = "operator"): Promise<void> {
    if (this.pauseWake !== "active") return;
    if (this.busy) return; // the same rule as a pane that is not idle: not now
    this.pauseWake = "pausing";
    this.pauseTransition = (async () => {
      this.pausedAt = this.now();
      writePausedMarker(this.opts.instanceDir, this.pausedAt, reason);
      this.clearRespawn();
      await this.adapter.stop().catch(() => undefined);
      this.pauseWake = "paused";
      this.emit("auto_paused", { pausedAt: this.pausedAt });
    })().finally(() => { this.pauseTransition = null; });
    await this.pauseTransition;
  }

  async wake(timeoutMs = 30_000): Promise<void> {
    if (this.pauseWake === "waking" && this.pauseTransition) { await this.pauseTransition; return; }
    if (this.pauseWake === "pausing") await this.waitForPauseWakeTransition();
    if (this.pauseWake !== "paused") return;
    this.pauseWake = "waking";
    this.pauseTransition = (async () => {
      await Promise.race([
        this.launch(),
        new Promise<never>((_, rej) => { const t = setTimeout(() => rej(new Error("wake timed out")), timeoutMs); t.unref?.(); }),
      ]);
      clearPausedMarker(this.opts.instanceDir);
      this.pausedAt = null;
      this.pauseWake = "active";
      this.emit("auto_woke");
    })().catch(err => { this.pauseWake = "paused"; throw err; }).finally(() => { this.pauseTransition = null; });
    await this.pauseTransition;
  }

  fenceDeliveryWritesForStop(): void { this.writesFenced = true; }
  waitForDeliveryWritesToDrain(timeoutMs: number): Promise<boolean> {
    return Promise.race([this.chain.then(() => true), new Promise<boolean>(r => { const t = setTimeout(() => r(false), timeoutMs); t.unref?.(); })]);
  }

  /** A cancel from the person: messages that have not started are dropped (their epoch is stale), the running turn is cancelled by the caller. */
  clearPendingDeliveries(fleetEpoch?: number): void {
    this.deliveryEpoch = fleetEpoch === undefined ? this.deliveryEpoch + 1 : Math.max(this.deliveryEpoch, fleetEpoch);
    if (this.turn) this.turn.cancelled = true;
    this.log.info({ deliveryEpoch: this.deliveryEpoch }, "acp: pending deliveries cleared by cancel");
  }

  /** The cancel key for a tmux pane is a cancel request here (`cancelRunner` normally goes through the adapter). */
  async sendEscape(): Promise<void> { await this.adapter.cancel(); }

  // ───────────────────────────────────────────────────────────────── the agent process

  private async launch(admission?: () => void): Promise<void> {
    this.spawnGeneration++;
    this.stuck = false;
    try {
      await this.adapter.start({ admission });
      this.errorCause = null; this.lastError = null;
      this.touchState();
    } catch (err) {
      this.noteStartFailure(err);
      throw err;
    }
  }

  private noteStartFailure(err: unknown): void {
    const message = (err as Error).message;
    this.errorCause = "error_detected";
    this.lastError = err instanceof AcpAuthRequiredError ? "auth" : err instanceof AcpVersionRefusedError ? "version" : "start";
    this.log.error({ name: this.name, error: message, kind: this.lastError }, "acp: the agent did not start");
    // Shown in the topic and kept in the event log by the lifecycle's launch-warning handler.
    this.emit("backend_launch_warning", { name: this.name, message });
  }

  private onAdapterExit(info: { code: number | null; signal: NodeJS.Signals | null; expected: boolean }): void {
    this.cancelHangEpisode();
    if (info.expected || this.stopping) return;
    this.log.warn({ name: this.name, ...info }, "acp: the agent process ended unexpectedly");
    void this.settleOnStop("crashed");
    this.steps.error("The agent process ended unexpectedly.");
    this.setBusy(false);
    const at = this.now();
    const loop = this.opts.crashLoop ?? { count: 5, windowMs: 5 * 60_000 };
    this.crashTimes = [...this.crashTimes.filter(t => at - t < loop.windowMs), at];
    if (this.crashTimes.length >= loop.count) {
      this.crashLoop = true;
      this.errorCause = "error_detected";
      this.emit("crash_loop");
      return;
    }
    this.scheduleRespawn(this.crashTimes.length);
  }

  private scheduleRespawn(attempt: number): void {
    if (this.stopping || this.pausedAt !== null) return;
    const delays = this.opts.respawnDelaysMs ?? DEFAULT_DELAYS;
    const wait = delays[Math.min(attempt - 1, delays.length - 1)] ?? 1000;
    this.clearRespawn();
    this.respawnTimer = setTimeout(() => {
      this.respawnTimer = null;
      if (this.stopping || this.pausedAt !== null) return;
      void this.launch().then(() => {
        this.log.info({ name: this.name }, "acp: respawned");
        this.emit("crash_respawn");
      }).catch(err => {
        // A refusal (version, sign-in) does not get better by trying again: stay down and say why.
        if (err instanceof AcpVersionRefusedError || err instanceof AcpAuthRequiredError) return;
        this.crashTimes.push(this.now());
        this.scheduleRespawn(this.crashTimes.length);
      });
    }, wait);
    this.respawnTimer.unref?.();
  }

  private clearRespawn(): void { if (this.respawnTimer) { clearTimeout(this.respawnTimer); this.respawnTimer = null; } }

  private clearTimers(): void {
    this.clearRespawn();
    if (this.hangTimer) { clearInterval(this.hangTimer); this.hangTimer = null; }
    if (this.cancelledHumansTimer) { clearTimeout(this.cancelledHumansTimer); this.cancelledHumansTimer = null; }
  }

  // ───────────────────────────────────────────────────────────────── hang

  private startHangTimer(): void {
    const every = this.opts.hangCheckEveryMs ?? 15_000;
    this.hangTimer = setInterval(() => this.checkHang(), every);
    this.hangTimer.unref?.();
  }

  /** An outstanding turn with no word from the agent for `hangAfterMs` (a person has to answer a permission: not a hang). */
  checkHang(): void {
    if (!this.busy || !this.turn || this.steps.pendingPermissions().length > 0) { this.hangEmitted = false; return; }
    const limit = this.opts.hangAfterMs ?? this.hangAfterFromConfig();
    const last = Math.max(this.adapter.health().lastEventAt ?? 0, this.turn.startedAt);
    const quiet = this.now() - last;
    if (quiet < limit) { this.cancelHangEpisode(); return; }
    if (!this.stuck) { this.stuck = true; this.touchState(); }
    if (!this.hangEmitted) {
      this.hangEmitted = true;
      if ((this.config as { hang_detector?: { enabled?: boolean } }).hang_detector?.enabled !== false) this.hang.emit("hang", { unchangedForMs: quiet });
    }
  }

  private cancelHangEpisode(): void {
    this.hangEmitted = false;
    if (this.stuck) { this.stuck = false; this.touchState(); }
  }

  private hangAfterFromConfig(): number {
    const minutes = (this.config as { hang_detector?: { timeout_minutes?: number } }).hang_detector?.timeout_minutes;
    return (typeof minutes === "number" && minutes > 0 ? minutes : 10) * 60_000;
  }

  // ───────────────────────────────────────────────────────────────── inbound messages and turns

  /** Admit one message (a person's, another instance's, a schedule's). Returns at once; the turn runs when its turn comes. */
  pushChannelMessage(content: string, meta: Record<string, string>, _targetSession?: string, deliveryEpoch = this.deliveryEpoch): void {
    if (deliveryEpoch !== this.deliveryEpoch) {
      this.log.info({ name: this.name }, "acp: pending delivery dropped by cancel");
      this.deferDurable(meta, "delivery epoch changed before queue admission");
      this.noteCancelledHuman(meta);
      return;
    }
    if (!this.started && !this.adapter.health().process) return;
    this.updateLastChat(meta.chat_id, meta.thread_id, meta.adapter_id);
    const item: InboundItem = { content, meta, epoch: deliveryEpoch, turnId: `${this.bootId.slice(0, 8)}-${++this.turnSeq}` };
    if (this.queued > 0) { const status = statusOf(meta); if (status) this.emit("message_queued", status); }
    this.queued++;
    this.chain = this.chain.then(() => this.runItem(item)).catch(err => this.log.error({ error: (err as Error).message }, "acp: a delivery failed")).finally(() => { this.queued--; });
  }

  /** ACP has no mid-turn input: a steer or a /btw waits for the running turn like any message. */
  steerMessage(content: string, meta: Record<string, string>, deliveryEpoch?: number): void { this.pushChannelMessage(content, meta, undefined, deliveryEpoch); }

  private async runItem(item: InboundItem): Promise<void> {
    const { meta, content } = item;
    const status = statusOf(meta);
    if (this.stopping || this.writesFenced) { this.deferDurable(meta, "the instance is stopping"); return; }
    if (item.epoch !== this.deliveryEpoch) {
      this.deferDurable(meta, "delivery epoch changed while queued");
      this.noteCancelledHuman(meta);
      return;
    }
    // Wake a paused instance (an agent that was stopped to pause starts again, resuming its conversation).
    if (this.isPaused) {
      try { await this.wake(); } catch (err) { this.deferDurable(meta, `target wake failed: ${(err as Error).message}`); return; }
    }
    if (this.adapter.health().process !== "running") { this.deferDurable(meta, "the agent is not running"); if (status && !meta.delivery_id) this.emit("message_failed", status); return; }

    const attempt = this.durableAttempt(meta);
    if (attempt === false) { this.deferDurable(meta, "invalid durable delivery attempt metadata"); return; }
    if (attempt) {
      if (!this.outbox) { this.emit("durable_delivery_deferred", { ...attempt, targetBootId: this.bootId, reason: "outbox port unavailable before submission" }); return; }
      if (this.outbox.begin(attempt.deliveryId, this.bootId, attempt.attemptNo) !== "begun") return;
    }
    const wire = this.format(content, meta);
    const t = { item, startedAt: this.now(), text: "", outbound: false, consumed: false, deliveryId: attempt ? attempt.deliveryId : null, attemptNo: attempt ? attempt.attemptNo : 0, cancelled: false };
    this.turn = t;
    this.steps.beginTurn(item.turnId, content);
    this.setBusy(true);
    if (meta.chat_id) this.lastActivityAt = this.now();
    if (attempt) this.outbox?.markEnterStarted(attempt.deliveryId, this.bootId, attempt.attemptNo);
    let stopReason = "error";
    try {
      const result = await this.adapter.prompt(wire);
      stopReason = result.stopReason;
      this.proveConsumed(t, "prompt-response");
    } catch (err) {
      const message = (err as Error).message;
      this.log.warn({ name: this.name, error: message }, "acp: the turn failed");
      if (!t.consumed) this.finishDurable(t, attempt ? "uncertain" : null, `acp:${message.slice(0, 120)}`);
      else this.steps.error(message);
      if (status && !attempt && !t.cancelled) this.emit("message_failed", status);
      this.endTurn(t, "error");
      return;
    }
    this.steps.apply({ kind: "turn_end", stopReason });
    if (stopReason !== "cancelled" && !t.cancelled && status) this.emit("message_confirmed", status);
    await this.maybeProxyReply(t, stopReason);
    this.endTurn(t, stopReason);
  }

  private endTurn(t: NonNullable<AcpRunner["turn"]>, _stopReason: string): void {
    if (this.turn === t) this.turn = null;
    this.setBusy(false);
    if (this.pauseWhenIdle && this.steps.pendingPermissions().length === 0) { this.pauseWhenIdle = false; void this.pause("auth"); }
  }

  private proveConsumed(t: NonNullable<AcpRunner["turn"]>, proof: string): void {
    if (t.consumed) return;
    t.consumed = true;
    const status = statusOf(t.item.meta);
    if (status) this.emit("message_delivered", status);
    this.finishDurable(t, t.deliveryId ? "delivered" : null, `acp:${proof}`);
  }

  private finishDurable(t: NonNullable<AcpRunner["turn"]>, outcome: "delivered" | "uncertain" | "failed" | null, evidence: string): void {
    if (!outcome || !t.deliveryId) return;
    const id = t.deliveryId;
    t.deliveryId = null; // one verdict per attempt
    this.outbox?.complete(id, this.bootId, t.attemptNo, outcome, evidence);
  }

  /** A turn a person started that ended without the agent using a reply tool: its text is sent as the reply. */
  private async maybeProxyReply(t: NonNullable<AcpRunner["turn"]>, stopReason: string): Promise<void> {
    if (stopReason !== "end_turn" || t.outbound || t.cancelled || !turnExpectsPersonReply(t.item.meta)) return;
    const text = t.text.trim();
    if (!text) return;
    const args: Record<string, unknown> = { text: text.slice(0, PROXY_TEXT_MAX) };
    if (this.lastChatId) { args.chat_id = this.lastChatId; if (this.lastThreadId) args.thread_id = this.lastThreadId; }
    const ok = await this.fleetRequest("proxyreply", { type: "fleet_outbound", tool: "reply", args, adapterId: this.lastAdapterId }, "reply");
    if (!ok.ok) this.log.warn({ name: this.name, error: ok.error }, "acp: the proxy reply did not go out");
    else this.log.info({ name: this.name }, "acp: the agent's text was sent as the reply (it used no reply tool)");
  }

  private onAdapterEvent(e: AdapterEvent): void {
    this.lastActivityAt = this.now();
    this.cancelHangEpisode();
    const t = this.turn;
    if (t) {
      if (e.kind === "message") t.text = (t.text + e.text).slice(0, PROXY_TEXT_MAX * 2);
      if (e.kind === "user" || e.kind === "thought" || e.kind === "message" || e.kind === "tool" || e.kind === "plan") this.proveConsumed(t, e.kind === "user" ? "user-message-echo" : "first-update");
    }
    if (e.kind === "permission") { this.onPermission(e); return; }
    if (e.kind === "auth_required") { this.lastError = "auth"; this.errorCause = "error_detected"; return; }
    if (e.kind === "usage" || e.kind === "user" || e.kind === "turn_end") return;
    this.steps.apply(e);
  }

  // ───────────────────────────────────────────────────────────────── permissions

  private onPermission(e: Extract<AdapterEvent, { kind: "permission" }>): void {
    this.steps.apply(e);
    const own = ownToolName(e.tool);
    if (own && !OWN_TOOLS_ASK.has(own)) {
      // The instance's own `agend` MCP server is how it talks to the fleet (replying is the point of the chat); asking
      // for every `reply` would make the chat unusable. Tools that start, replace or remove instances still ask.
      const allow = e.options.find(o => o.kind === "allow_once");
      if (allow && this.adapter.answerPermission(e.requestId, { optionId: allow.id })) { this.steps.resolvePermission(e.requestId, `${allow.name} (agend tool)`); return; }
    }
    if (this.config.acp_always_approve === true) {
      // The policy is AgEnD's: answer with the one-shot allow, never an "always" option (it changes state the CLI keeps).
      const allow = e.options.find(o => o.kind === "allow_once");
      if (allow && this.adapter.answerPermission(e.requestId, { optionId: allow.id })) { this.steps.resolvePermission(e.requestId, `${allow.name} (auto)`); return; }
    }
    this.emit("steps_changed");
  }

  /**
   * A person's answer, from the web. `allow` / `deny` choose the one-shot options only; `cancel` cancels the turn.
   * Returns an error text, or null when it was applied.
   */
  answerPermissionByUser(rawId: string, decision: "allow" | "deny" | "cancel"): string | null {
    // The page names the request by its step's id; the agent's own request id works as well.
    const pending = this.steps.pendingPermissions().find(p => p.stepId === rawId || p.requestId === rawId);
    if (!pending) return "no such permission request is waiting";
    const requestId = pending.requestId;
    if (decision === "cancel") {
      void this.adapter.cancel();
      this.steps.resolvePermission(requestId, "cancelled");
      return null;
    }
    const option = pending.options.find(o => o.kind === (decision === "allow" ? "allow_once" : "reject_once"));
    if (!option) {
      if (decision === "deny") {
        // No refuse option offered: refusing is cancelling this request.
        if (this.adapter.answerPermission(requestId, { cancelled: true })) { this.steps.resolvePermission(requestId, "denied"); return null; }
      }
      return `the agent offered no "${decision}" option for this request`;
    }
    if (!this.adapter.answerPermission(requestId, { optionId: option.id })) return "the request is no longer waiting";
    this.steps.resolvePermission(requestId, option.name);
    return null;
  }

  // ───────────────────────────────────────────────────────────────── IPC with the fleet and the MCP server

  private async openIpc(): Promise<void> {
    if (this.ipc) return;
    const ipc = new IpcServer(join(this.opts.instanceDir, "channel.sock"), this.log);
    this.ipc = ipc;
    let listening = false;
    ipc.on("error", (err: Error) => { if (listening) { this.log.error({ err, name: this.name }, "IPC server error"); this.emit("error", err); } });
    await ipc.listen();
    listening = true;
    ipc.on("message", (msg: Msg) => this.routeFleetResponse(msg));
    ipc.on("message", (msg: Msg, socket: Socket) => this.onIpc(msg, socket));
  }

  private async closeIpc(): Promise<void> {
    const ipc = this.ipc;
    this.ipc = null;
    await (ipc as unknown as { close?: () => Promise<void> } | null)?.close?.().catch(() => undefined);
  }

  private onIpc(msg: Msg, socket: Socket): void {
    switch (msg.type) {
      case "tool_call": this.handleToolCall(msg, socket); return;
      case "mcp_ready": {
        const sessionName = msg.sessionName as string | undefined;
        if (sessionName) { this.sessionNames.set(socket, sessionName); socket.on("close", () => { this.sessionNames.delete(socket); if (sessionName !== this.name) this.ipc?.broadcast({ type: "session_disconnected", sessionName }); }); }
        this.ipc?.broadcast({ type: "mcp_ready", sessionName });
        return;
      }
      case "pong": return;
      case "query_sessions": {
        const sessions: string[] = [];
        for (const [s, n] of this.sessionNames) if (!s.destroyed && n !== this.name) { this.ipc?.send(socket, { type: "mcp_ready", sessionName: n }); sessions.push(n); }
        this.ipc?.send(socket, { type: "query_sessions_response", sessions });
        return;
      }
      case "fleet_inbound": {
        const meta = (msg.meta ?? {}) as Record<string, string>;
        const epoch = this.captureEpoch(msg.delivery_epoch);
        void this.wake().then(() => this.pushChannelMessage(String(msg.content ?? ""), meta, msg.targetSession as string | undefined, epoch))
          .catch(err => { this.deferDurable(meta, `target wake failed: ${(err as Error).message}`); });
        return;
      }
      case "steer": case "btw": case "raw_paste": {
        const meta = (msg.meta ?? {}) as Record<string, string>;
        this.steerMessage(String(msg.content ?? msg.text ?? ""), meta, this.captureEpoch(msg.delivery_epoch));
        return;
      }
      case "config_update": this.applyConfigUpdate(msg.config); return;
      case "fleet_schedule_trigger": {
        const payload = (msg.payload ?? {}) as Record<string, unknown>;
        const meta = (msg.meta ?? {}) as Record<string, string>;
        const epoch = this.captureEpoch(msg.delivery_epoch);
        void this.wake().then(() => this.pushChannelMessage(String(payload.message ?? ""), meta, undefined, epoch)).catch(() => undefined);
        return;
      }
      case "query_instance_state": {
        const at = this.now();
        this.ipc?.send(socket, {
          type: "instance_state_response", requestId: msg.requestId, instanceName: this.name,
          state: this.isPaused ? "paused" : this.stuck ? "stuck" : this.busy ? "working" : "idle",
          unchangedForMs: at - Math.max(this.lastActivityAt, this.stateChangedAt), observedAt: at, stateChangedAt: this.stateChangedAt,
          interaction: this.getInteractionSnapshot(), processStatus: this.getProcessStatus(), pausedAt: this.pausedAt,
        });
        return;
      }
      default: return;
    }
  }

  private captureEpoch(value: unknown): number {
    const epoch = typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : this.deliveryEpoch;
    if (epoch > this.deliveryEpoch) this.deliveryEpoch = epoch;
    return epoch;
  }

  private routeFleetResponse(msg: Msg): void {
    const type = msg.type as string | undefined;
    if (!type || !FLEET_RESPONSE_TYPES.has(type) || !msg.fleetRequestId) return;
    const key = String(msg.fleetRequestId);
    const handler = this.pending.get(key);
    if (!handler) return;
    this.pending.delete(key);
    handler(msg);
  }

  /** One request to the fleet over the IPC broadcast; resolves with its answer or an error (never rejects). */
  private fleetRequest(prefix: string, payload: Msg, budgetTool: string): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
    const ipc = this.ipc;
    if (!ipc) return Promise.resolve({ ok: false, error: "no fleet connection" });
    return new Promise(resolve => {
      const id = `${prefix}_${++this.fleetSeq}`;
      const timer = setTimeout(() => { this.pending.delete(id); resolve({ ok: false, error: `${budgetTool} timed out` }); }, daemonBudgetMs(budgetTool));
      timer.unref?.();
      this.pending.set(id, resp => { clearTimeout(timer); resp.error ? resolve({ ok: false, error: String(resp.error) }) : resolve({ ok: true, result: resp.result }); });
      ipc.broadcast({ ...payload, fleetRequestId: id });
    });
  }

  private handleToolCall(msg: Msg, socket: Socket): void {
    const tool = String(msg.tool ?? "");
    const args = ((msg.args ?? {}) as Record<string, unknown>);
    const requestId = msg.requestId as number;
    const operationId = typeof msg.operationId === "string" ? msg.operationId : undefined;
    const fromOwn = (this.sessionNames.get(socket) ?? this.name) === this.name;
    const respond = (result: unknown, error?: string): void => {
      if (!error && result != null && TURN_OUTBOUND_TOOLS.has(tool) && fromOwn && this.turn) this.turn.outbound = true;
      const sent = this.ipc?.send(socket, { requestId, result, error, operationId }) ?? false;
      if (sent && operationId) this.emit("mcp_tool_response_written", { operationId, daemonBootId: this.bootId });
    };
    if (UNSUPPORTED_TOOLS.has(tool)) { respond(null, `${tool} is not available on an instance that runs over ACP`); return; }
    const typed = TYPED_TOOLS[tool];
    const via = (payload: Msg): void => {
      void this.fleetRequest(typed?.prefix ?? "tool", payload, tool).then(r => r.ok ? respond(r.result) : respond(null, r.error));
    };
    if (typed) {
      const meta = tool.endsWith("schedule") || tool.includes("_schedule")
        ? { chat_id: this.lastChatId, thread_id: this.lastThreadId, adapter_id: this.lastAdapterId, instance_name: this.name }
        : { instance_name: this.name, working_directory: this.config.working_directory };
      via({ type: typed.type, payload: args, meta });
      return;
    }
    if (CROSS_INSTANCE_TOOLS.has(tool)) {
      if (!this.opts.topicMode) { respond(null, "Cross-instance messaging requires topic mode"); return; }
      via({ type: "fleet_outbound", tool, args, ...(operationId ? { operationId, sourceDaemonBootId: this.bootId } : {}), senderSessionName: this.sessionNames.get(socket) });
      return;
    }
    // reply / react / edit_message and the rest of the channel tools: routed by the fleet with this chat's context.
    const routed = { ...args };
    if (["reply", "react", "edit_message"].includes(tool) && this.lastChatId) {
      routed.chat_id = this.lastChatId;
      if (this.lastThreadId) routed.thread_id = this.lastThreadId;
    }
    via({ type: "fleet_outbound", tool, args: routed, ...(operationId ? { operationId, sourceDaemonBootId: this.bootId } : {}), adapterId: this.lastAdapterId });
  }

  // ───────────────────────────────────────────────────────────────── small helpers

  private format(content: string, meta: Record<string, string>): string {
    if (!meta.from_instance) return formatHumanInboundMessage(content, meta, "mcp");
    let formatted = formatCrossInstanceInboundMessage(content, meta, "mcp");
    if (meta.reply_to_text) formatted += '\n(reply_to: "' + meta.reply_to_text + '")';
    if (meta.delivery_id) formatted = "[agend-delivery-id:" + meta.delivery_id + "]\n" + formatted;
    return formatted;
  }

  private durableAttempt(meta: Record<string, string>): { deliveryId: string; attemptNo: number } | null | false {
    if (!meta.delivery_id) return null;
    const attemptNo = Number(meta.delivery_attempt);
    return Number.isSafeInteger(attemptNo) && attemptNo >= 1 ? { deliveryId: meta.delivery_id, attemptNo } : false;
  }

  private deferDurable(meta: Record<string, string>, reason: string): void {
    const attempt = this.durableAttempt(meta);
    if (!attempt) return;
    if (this.outbox) this.outbox.retryBeforeBegin(attempt.deliveryId, this.bootId, attempt.attemptNo, reason, 5_000);
    else this.emit("durable_delivery_deferred", { ...attempt, targetBootId: this.bootId, reason });
  }

  private noteCancelledHuman(meta: Record<string, string>): void {
    if (meta.from_instance || meta.delivery_id || !meta.chat_id || !meta.message_id) return;
    this.cancelledHumans.push({ chatId: meta.chat_id, messageId: meta.message_id, ...(meta.thread_id ? { threadId: meta.thread_id } : {}) });
    if (this.cancelledHumansTimer) clearTimeout(this.cancelledHumansTimer);
    this.cancelledHumansTimer = setTimeout(() => {
      this.cancelledHumansTimer = null;
      const messages = this.cancelledHumans.splice(0);
      if (messages.length) this.emit("human_messages_cancelled", { messages });
    }, 500);
    this.cancelledHumansTimer.unref?.();
  }

  /** The agent is gone or going: a turn in flight cannot finish. */
  private async settleOnStop(_why: "stopped" | "crashed"): Promise<void> {
    const t = this.turn;
    if (!t) return;
    if (!t.consumed) this.finishDurable(t, "uncertain", `acp:${_why}-before-proof`);
    this.steps.interrupt();
  }

  private setBusy(busy: boolean): void {
    if (this.busy === busy) return;
    this.busy = busy;
    if (!busy) this.stuck = false;
    this.touchState();
    if (!busy) this.wakeIdleWaiters();
  }
  private touchState(): void { this.stateChangedAt = this.now(); }
  private wakeIdleWaiters(): void { for (const w of [...this.idleWaiters]) w(); }

  private updateLastChat(chatId: string | undefined, threadId: string | undefined, adapterId: string | undefined): void {
    if (!chatId) return;
    this.lastChatId = chatId; this.lastThreadId = threadId || undefined; this.lastAdapterId = adapterId || undefined;
    try { writeFileSync(join(this.opts.instanceDir, "last-chat.json"), JSON.stringify({ chatId, threadId: threadId ?? "", adapterId: adapterId ?? "" })); } catch { /* best effort */ }
  }
  private restoreLastChat(): void {
    try {
      const file = join(this.opts.instanceDir, "last-chat.json");
      if (!existsSync(file)) return;
      const saved = JSON.parse(readFileSync(file, "utf8"));
      if (saved.chatId) { this.lastChatId = saved.chatId; this.lastThreadId = saved.threadId || undefined; this.lastAdapterId = saved.adapterId || undefined; }
    } catch { /* corrupt: ignore */ }
  }
}

function statusOf(meta: Record<string, string>): { chatId: string; messageId: string; threadId?: string } | undefined {
  const chatId = meta.chat_id, messageId = meta.message_id;
  if (!messageId || (!chatId && meta.source !== "web")) return undefined;
  if (meta.source === "agend-system") return undefined;
  if (!chatId) return { chatId: "", messageId };
  return meta.thread_id ? { chatId, messageId, threadId: meta.thread_id } : { chatId, messageId };
}
