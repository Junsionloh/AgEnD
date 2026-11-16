import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IpcServer } from "../../channel/ipc-bridge.js";
import { daemonBudgetMs } from "../../channel/ipc-timeouts.js";
import { formatHumanInboundMessage } from "../../human-delivery-receipts.js";
import { formatCrossInstanceInboundMessage } from "../../cross-instance-envelope.js";
import { AutoPauseController, readLastInboundAt, writeLastInboundAt } from "../../auto-pause.js";
import { generalByName } from "../../general-instance.js";
import { clampContextPercent, type TokenContextRatio } from "../../context-percent.js";
import { redactSecrets } from "../../tool-progress.js";
import { HangDetector } from "../../hang-detector.js";
import { clearPausedMarker, readPausedAt, writePausedMarker, type PauseReason } from "../../pause-marker.js";
import { turnExpectsPersonReply } from "../../turn-reply-guard.js";
import type { InteractionSnapshot, InstanceState, InstanceStateSnapshot } from "../../backend/types.js";
import type { DeliveryOutbox } from "../../delivery-outbox.js";
import type { InstanceConfig } from "../../types.js";
import type { WorkingStateObservation } from "../../working-state-journal.js";
import type { RecoveryLive } from "../../working-recovery.js";
import { AcpAuthRequiredError, AcpVersionRefusedError, type AcpAdapter } from "./acp-adapter.js";
import { AcpStepStore, type PermissionStepInfo } from "./steps.js";
import type { RemoteCardAction, RemoteCardOutcome } from "../../remote-card-answer.js";
import type { RemoteCardOption, RemoteQuestionCard } from "../../backend/types.js";
import { ACP_MCP_SERVER_NAME } from "./profiles.js";
import { splitAcpModel } from "./model-id.js";
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
  /** How long after the session opens the instance's own MCP server may take to connect before it is reported missing (default 45 s). */
  readonly mcpGraceMs?: number;
  readonly now?: () => number;
}

interface InboundItem {
  readonly content: string;
  readonly meta: Record<string, string>;
  readonly epoch: number;
  readonly turnId: string;
  /** Sent to the agent exactly as given, with no `[user:]` envelope (a silent schedule's text). */
  readonly raw?: boolean;
  /** An interruption (`/steer`, `steer: true`): who sent it. The turn it found running was cancelled, and the agent is told so before the message. */
  readonly interrupts?: { readonly by: string };
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
 *    discriminator; the model's arguments are nested under `tool_input`) and `rawInput.tool_name === "<server>__<tool>"`.
 *    A Bash or Write call has another variant and another `_meta` name, whatever extra keys the model puts in its input.
 *  - agy: `kind: "other"` and the tool's registered name in `name` (`mcp_<server>_<tool>`); its `rawInput` is the model's
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
  const m = (grokMeta ? new RegExp(`^${ACP_MCP_SERVER_NAME}__([a-z][a-z0-9_]{0,63})$`) : new RegExp(`^mcp_${ACP_MCP_SERVER_NAME}_([a-z][a-z0-9_]{0,63})$`)).exec(candidate);
  return m ? m[1]! : null;
}

const DEFAULT_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];
/** Both CLIs start the declared MCP server while the session opens, so seconds are enough; a loaded host needs room for a Node cold start. */
const MCP_GRACE_MS = 45_000;
const PROXY_TEXT_MAX = 12_000;

/** The line put in front of an interrupting message: the agent must continue the same work, not start over. */
export function interruptedNote(by: string): string {
  return `[AgEnD: your previous turn was interrupted by ${by} before it finished. This is the same conversation: keep what you already know, treat the unfinished work as cut short (a tool call that was running may not have completed), and now handle the message below.]`;
}

/** The identity of a permission card: the request's own step id (JSON-RPC ids restart with every agent process; the step id does not repeat). */
export const permissionCardIdentity = (p: { stepId: string }): string => `acp-permission:${p.stepId}`;

/** What a permission card asks, from the tool call the agent named: its title and the one argument that says what it would touch (never the whole input). */
export function permissionQuestion(tool: unknown): string {
  const t = tool && typeof tool === "object" ? tool as Record<string, unknown> : {};
  const title = typeof t.title === "string" && t.title.trim() ? t.title.trim() : "a tool";
  const input = t.rawInput && typeof t.rawInput === "object" ? t.rawInput as Record<string, unknown> : {};
  const subject = ["command", "cmd", "path", "file_path", "filePath", "url", "query"].map(k => input[k]).find((v): v is string => typeof v === "string" && v.trim() !== "");
  const clip = (text: string, max: number): string => { const one = text.replace(/\s+/g, " ").trim(); return one.length > max ? `${one.slice(0, max - 1)}…` : one; };
  // Masked first, cut after: a token cut in half would no longer be recognised as one.
  const shownTitle = redactSecrets(title), shownSubject = subject ? redactSecrets(subject) : undefined;
  return `Permission request: ${clip(shownTitle, 160)}${shownSubject && !shownTitle.includes(shownSubject.trim()) ? ` — ${clip(shownSubject, 240)}` : ""}`;
}

/** A token count as grok's own screen writes it: `850`, `14.9K`, `256K`, `1.2M`. */
export function tokenLabel(n: number): string {
  if (n < 1000) return String(Math.round(n));
  const fmt = (v: number, unit: string): string => `${(Math.round(v * 10) / 10).toString().replace(/\.0$/, "")}${unit}`;
  return Math.round(n / 100) < 10_000 ? fmt(n / 1000, "K") : fmt(n / 1_000_000, "M");
}

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

  // the instance's own MCP server: connected (it announced itself on the IPC socket) since this launch?
  private mcpServed = false;
  private mcpReported = false;
  private mcpTimer: NodeJS.Timeout | null = null;
  /** The CLI starts its MCP servers with the first prompt (agy): the check waits for a turn to end instead of counting from the launch. */
  private mcpAwaitingTurn = false;
  /** The timeline step of the current never-connected report, so a late connection can take it back. */
  private mcpErrorStepId: string | null = null;

  // turns
  private chain: Promise<void> = Promise.resolve();
  private queued = 0;
  private deliveryEpoch = 0;
  private writesFenced = false;
  private busy = false;
  private stuck = false;
  private stateChangedAt: number;
  private lastActivityAt = 0;
  // idle auto-pause (`auto_pause_after`): the terminal daemon's own clock, fed by ACP's busy / idle instead of the pane
  private readonly autoPause: AutoPauseController;
  private autoPauseRequested = false;
  private workLease: (() => boolean) | null = null;
  private turn: { item: InboundItem; startedAt: number; text: string; outbound: boolean; consumed: boolean; deliveryId: string | null; attemptNo: number; cancelled: boolean; interjected: { chatId: string; messageId: string; threadId?: string }[];
    /** A cancel was asked for before the prompt left (the agent was still being started): sent right after it. */ cancelPending: boolean;
    /** How the turn ended (its stop reason, or `error`), once it has. */ ended: string | null } | null = null;
  /** Messages waiting for their turn, in the order they will run (an interruption goes in front of the others). `queued` counts these and the one running. */
  private readonly inbox: InboundItem[] = [];
  private pumping = false;
  /** The message `runItem` has taken from the inbox and not yet started a turn for (it may be waking a paused agent). An interruption in that gap cancels the turn as it starts. */
  private startingItem: InboundItem | null = null;
  private startInterrupted = false;
  private turnSeq = 0;
  private readonly idleWaiters = new Set<() => void>();
  private lastChatId = ""; private lastThreadId: string | undefined; private lastAdapterId: string | undefined;
  private readonly cancelledHumans: { chatId: string; messageId: string; threadId?: string }[] = [];
  private cancelledHumansTimer: NodeJS.Timeout | null = null;

  // fleet requests
  private readonly pending = new Map<string, (msg: Msg) => void>();
  /** The permission cards posted in the chat (`skipPermissions: false`): card identity → the request and what each option does. */
  private readonly permissionCards = new Map<string, { requestId: string; choices: Map<number, "allow" | "deny" | "cancel"> }>();
  private fleetSeq = 0;
  private readonly sessionNames = new Map<Socket, string>();

  constructor(readonly adapter: AcpAdapter, private readonly opts: AcpRunnerOptions) {
    super();
    this.config = opts.config;
    this.now = opts.now ?? Date.now;
    this.stateChangedAt = this.now();
    this.autoPause = new AutoPauseController(this.autoPauseMs(this.config), readLastInboundAt(opts.instanceDir) ?? this.now());
    this.steps = new AcpStepStore(opts.instanceDir, this.now, () => this.config.skipPermissions !== false);
    this.steps.onChange(() => { this.emit("steps_changed"); this.syncPermissionCards(); });
    this.restoreLastChat();
    adapter.onEvent(e => this.onAdapterEvent(e));
    adapter.onExit(info => this.onAdapterExit(info));
    const stored = readPausedAt(opts.instanceDir);
    if (stored !== null) { this.pausedAt = stored; this.autoPause.markPaused(stored); }
  }

  /** The idle threshold in ms (`auto_pause_after` minutes; unset or 0: never). General is the dispatcher and is never auto-paused, as in a terminal. */
  private autoPauseMs(config: InstanceConfig): number {
    const general = config.general_topic === true || generalByName(this.opts.name, config);
    const minutes = typeof config.auto_pause_after === "number" && Number.isFinite(config.auto_pause_after) ? config.auto_pause_after : 0;
    return general ? 0 : Math.max(0, minutes) * 60_000;
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
  setWorkLeaseCheck(check?: () => boolean): void { this.workLease = check ?? null; }
  seedActivityNow(): void { this.lastActivityAt = this.now(); this.autoPause.recordActivity(this.now()); }
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
    if (!value || typeof value !== "object") return;
    const update = value as Partial<InstanceConfig> & { auto_pause_after?: unknown };
    const before = this.autoPauseMs(this.config);
    this.config = { ...this.config, ...(update as Partial<InstanceConfig>) };
    // null drops the setting (as the terminal daemon reads it); a new threshold starts a fresh countdown.
    if (update.auto_pause_after === null) delete (this.config as { auto_pause_after?: number }).auto_pause_after;
    const after = this.autoPauseMs(this.config);
    if (after !== before) this.autoPause.reconfigure(after, this.now());
  }
  getInstanceState(): InstanceState | "paused" { return this.isPaused ? "paused" : this.stuck ? "stuck" : this.busy ? "working" : "idle"; }
  getProcessStatus(): "running" | "crashed" | "stopped" { return this.adapter.health().process; }
  /** `/steer` and `steer: true` work over ACP as an interruption (see `interruptMessage`). */
  launchSupportsSteer(): boolean | undefined { return true; }
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
  /**
   * A button of a permission card posted in the chat (AGEND-279): option `n` is what `choices` of that card says (allow once, deny,
   * cancel the turn), applied exactly as the web's buttons apply it. A request that is no longer waiting is `stale`.
   */
  async answerRemoteCard(identity: string, action: RemoteCardAction): Promise<RemoteCardOutcome> {
    const card = this.permissionCards.get(identity);
    const pending = card ? this.steps.pendingPermissions().find(p => p.requestId === card.requestId) : undefined;
    if (!card || !pending) return { outcome: "stale" };
    if (action.kind !== "option") return { outcome: "refused", reason: "a permission request is answered with its buttons" };
    const decision = card.choices.get(action.n);
    if (!decision) return { outcome: "refused", reason: `no option ${action.n}` };
    const error = this.answerPermissionByUser(pending.stepId, decision);
    return error ? { outcome: "refused", reason: error } : { outcome: "answered" };
  }
  /** The fleet could not apply an answer: the request is still waiting, so its card is posted again. */
  repostRemoteCard(): void {
    const pending = this.steps.pendingPermissions()[0];
    if (!pending) return;
    this.permissionCards.delete(permissionCardIdentity(pending));
    this.postPermissionCard(pending);
  }
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
      this.clearMcpTimer();
      await this.adapter.stop().catch(() => undefined);
      this.pauseWake = "paused";
      this.autoPause.markPaused(this.pausedAt);
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
      this.autoPauseRequested = false;
      this.autoPause.markAwake(this.now());
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
      // A stop that came in while the agent was starting has already cleared the timers: nothing is armed for an instance that is going away.
      if (!this.stopping) this.armMcpWatch();
      void this.applyConfiguredSettings(this.spawnGeneration);
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

  private clearMcpTimer(): void { if (this.mcpTimer) { clearTimeout(this.mcpTimer); this.mcpTimer = null; } }

  private clearTimers(): void {
    this.clearRespawn();
    if (this.hangTimer) { clearInterval(this.hangTimer); this.hangTimer = null; }
    this.clearMcpTimer();
    if (this.cancelledHumansTimer) { clearTimeout(this.cancelledHumansTimer); this.cancelledHumansTimer = null; }
  }

  // ───────────────────────────────────────────────────────────────── hang

  private startHangTimer(): void {
    const every = this.opts.hangCheckEveryMs ?? 15_000;
    this.hangTimer = setInterval(() => { this.checkHang(); this.checkAutoPause(); }, every);
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

  /**
   * Idle auto-pause: the same rule as a terminal agent (daemon.ts), with ACP's own idle. Nothing is running or waiting, no permission
   * request waits for a person, the agent was last given work longer than `auto_pause_after` minutes ago, and no work lease holds it.
   * The fleet pauses it (the agent process is stopped; the next message wakes it and resumes its conversation).
   */
  checkAutoPause(): void {
    if (this.autoPauseRequested || this.pauseWake !== "active" || this.stopping || !this.started) return;
    if (this.busy || this.queued > 0 || this.steps.pendingPermissions().length > 0 || this.getInstanceState() !== "idle") return;
    if (!this.autoPause.observe("idle", this.now())) return;
    try { if (this.workLease?.() === true) return; } catch { return; }
    this.autoPauseRequested = true;
    this.emit("auto_pause_requested", { name: this.name, idleSince: this.stateChangedAt, reason: "idle" satisfies PauseReason });
  }

  /** Work reached the agent (a delivery, a person's message): the idle clock restarts, and survives a restart like a terminal's. */
  private noteWorkActivity(): void {
    const at = this.now();
    this.autoPause.recordActivity(at);
    try { writeLastInboundAt(this.opts.instanceDir, at); } catch (err) { this.log.warn({ error: (err as Error).message }, "acp: could not persist the last activity time"); }
  }

  private cancelHangEpisode(): void {
    this.hangEmitted = false;
    if (this.stuck) { this.stuck = false; this.touchState(); }
  }

  private hangAfterFromConfig(): number {
    const minutes = (this.config as { hang_detector?: { timeout_minutes?: number } }).hang_detector?.timeout_minutes;
    return (typeof minutes === "number" && minutes > 0 ? minutes : 10) * 60_000;
  }

  // ───────────────────────────────────────────────────────────────── the instance's own MCP server

  /** A launch starts the count again: the server is declared in `session/new`, so each new session must bring it up. */
  private armMcpWatch(): void {
    this.mcpServed = false;
    this.mcpReported = false;
    this.mcpErrorStepId = null;
    this.clearMcpTimer();
    // agy declares the server in `session/new` but starts it with the first prompt: an instance nobody has written to has
    // not had the chance to connect, so counting from the launch reports every idle agy. The count starts when a turn ends.
    this.mcpAwaitingTurn = this.adapter.profile.mcpConnects === "first_prompt";
    if (!this.mcpAwaitingTurn) this.startMcpTimer();
  }

  private startMcpTimer(): void {
    this.clearMcpTimer();
    const generation = this.spawnGeneration;
    const session = this.adapter.sessionId();
    this.mcpTimer = setTimeout(() => {
      this.mcpTimer = null;
      // Only for the launch that armed it, and only while that launch is the one running: an agent that was stopped, paused or
      // replaced since has nothing to report.
      if (generation !== this.spawnGeneration || this.stopping || (this.pauseWake !== "active" && this.pauseWake !== "waking")) return;
      if (this.adapter.health().process !== "running" || this.adapter.sessionId() !== session) return;
      this.checkMcpConnected();
    }, this.opts.mcpGraceMs ?? MCP_GRACE_MS);
    this.mcpTimer.unref?.();
  }

  /** A turn has ended: for a CLI that starts its server with the first prompt, the grace period starts now. */
  private mcpTurnEnded(): void {
    if (!this.mcpAwaitingTurn) return;
    this.mcpAwaitingTurn = false;
    if (!this.mcpServed && !this.mcpReported) this.startMcpTimer();
  }

  /** The server's first word on the IPC socket (`mcp_ready`, or a tool call) is the proof it is up; it also retracts an earlier report. */
  private noteMcpServing(_socket: Socket): void {
    if (this.mcpServed) return;
    this.mcpServed = true;
    this.mcpAwaitingTurn = false;
    this.clearMcpTimer();
    if (!this.mcpReported) return;
    this.mcpReported = false;
    // The error line the report put in the chat is taken back: the person saw a failure that did not happen.
    if (this.mcpErrorStepId) this.steps.retractError(this.mcpErrorStepId, "The agend MCP server connected after all: the earlier warning was a false alarm and nothing was lost.");
    this.mcpErrorStepId = null;
    if (this.lastError === "mcp") { this.errorCause = null; this.lastError = null; }
    this.log.info({ name: this.name }, "acp: the agend MCP server connected after all");
    this.emit("mcp_recovered", { name: this.name, source: "late_connect" });
  }

  /**
   * The agent is running and nothing of this instance's MCP server ever connected: no `reply`, no cross-instance tools.
   * As for a tmux instance: logged, kept in the event log, told in the topic and on the web (the shared `mcp_died` incident
   * with `neverConnected`), and shown in the chat timeline. No automatic restart: a restart of the same declaration would not
   * change what this launch did, and the agent still answers (its text is relayed as the reply).
   */
  private checkMcpConnected(): void {
    if (this.mcpServed || this.mcpReported) return;
    this.mcpReported = true;
    this.errorCause = "error_detected";
    this.lastError = "mcp";
    const grace = this.opts.mcpGraceMs ?? MCP_GRACE_MS;
    this.log.error({ name: this.name, graceMs: grace }, "acp: the agend MCP server never connected after the session opened — instance has no agend tools");
    this.mcpErrorStepId = this.steps.error("The agend MCP server never connected: this agent has no agend tools (it cannot reply through the reply tool or reach other instances). Restart the instance; if it repeats, check the CLI's own MCP messages in the Log.", { running: "keep" });
    this.emit("mcp_died", { name: this.name, pid: 0, autoRestart: false, authSuspected: false, neverConnected: true, acp: true });
  }

  /** Whether the instance's MCP server has connected since this launch (for status and tests). */
  get mcpConnected(): boolean { return this.mcpServed; }

  // ───────────────────────────────────────────────────────────────── terminal-only input

  /**
   * `raw_paste` is a tmux operation: bytes typed into a pane (`/effort`, `/model`, `/compact`, `/clear`, `/save`, `/chat load`).
   * An ACP agent has no pane, and what it gets is a prompt, so a command pasted here would be read as a question and cost a
   * whole turn. The fleet answers each of those commands itself before sending (`FleetManager.instanceRunsAcp`), so the only
   * `raw_paste` that is meant for an ACP instance is a silent schedule's text, which goes in as a prompt as it is; anything else
   * is dropped here, with a log line, as the backstop for a caller that did not ask first.
   */
  private onRawPaste(msg: Msg): void {
    const content = String(msg.content ?? msg.text ?? "");
    if (msg.silent_schedule === true && typeof msg.delivery_id === "string") {
      const meta: Record<string, string> = { delivery_id: msg.delivery_id, delivery_attempt: String(msg.delivery_attempt ?? ""), source: "schedule" };
      this.pushChannelMessage(content, meta, undefined, this.captureEpoch(msg.delivery_epoch), true);
      return;
    }
    this.log.warn({ name: this.name, preview: content.slice(0, 60), type: msg.type }, "acp: terminal input was not sent — an ACP instance has no terminal; it is not a prompt");
    if (typeof msg.notify_written === "string") this.ipc?.broadcast({ type: "raw_paste_written", id: msg.notify_written, outcome: "not_written" });
  }

  /**
   * Apply the instance's configured model and effort to the session through ACP (`session/set_config_option`): the way an
   * agent that takes no launch flag for them (agy) honours fleet.yaml, and the same for one that does (grok). A value the
   * agent does not offer is reported as a launch warning, never typed anywhere.
   */
  private async applyConfiguredSettings(generation: number): Promise<void> {
    const effort = (this.config as InstanceConfig & { effort?: string }).effort;
    // The configured model may be a tmux-style id that carries its effort level (`gemini-4-hydrogen-medium`): ACP takes the
    // model and the effort apart, so it is split first. A level the id carried is used only when no effort is configured.
    const configuredModel = this.modelOverride ?? this.config.model;
    const offeredModels = this.adapter.configOption("model")?.values ?? [];
    const split = configuredModel && offeredModels.length ? splitAcpModel(configuredModel, offeredModels) : null;
    const wanted: [string, string | undefined][] = [["model", split?.model ?? configuredModel], ["thought_level", effort ?? split?.level]];
    for (const [category, value] of wanted) {
      if (!value || generation !== this.spawnGeneration) continue;
      const current = this.adapter.configOption(category)?.currentValue;
      if (current === value) continue;
      const result = await this.adapter.setConfigOption(category, value);
      if (!result.ok) {
        this.log.warn({ name: this.name, category, value, reason: result.reason, accepted: result.accepted }, "acp: a configured setting was not applied");
        if (result.reason === "invalid" || result.reason === "failed") {
          const message = `${category === "model" ? "model" : "effort"} "${value}" was not applied: ${result.message}${result.accepted.length ? ` (it offers: ${result.accepted.join(", ")})` : ""}. It runs on its own setting.`;
          this.emit("backend_launch_warning", { name: this.name, message });
          // The log line and the topic message are not where a person looks first: the chat says it too.
          if (generation === this.spawnGeneration) this.steps.error(`The configured ${message}`, { running: "keep" });
        }
      }
    }
  }

  /**
   * Set the live session's reasoning effort or model through ACP. The caller has already persisted the value for the next start.
   * A tmux-style model id (model plus effort level) is split as at start; the level it carries is applied only when no effort is configured.
   */
  async setSessionSetting(kind: "effort" | "model", value: string): Promise<import("./acp-adapter.js").SetConfigResult> {
    if (kind === "effort") return this.adapter.setConfigOption("thought_level", value);
    const split = splitAcpModel(value, this.sessionSettingValues("model"));
    const result = await this.adapter.setConfigOption("model", split?.model ?? value);
    if (result.ok && split?.level && !(this.config as InstanceConfig & { effort?: string }).effort) await this.adapter.setConfigOption("thought_level", split.level);
    return result;
  }
  /** The values the live session offers for `effort` / `model` (empty when the agent is not running or offers none). */
  sessionSettingValues(kind: "effort" | "model"): readonly string[] { return this.adapter.configOption(kind === "effort" ? "thought_level" : "model")?.values ?? []; }

  // ───────────────────────────────────────────────────────────────── inbound messages and turns

  /** Admit one message (a person's, another instance's, a schedule's). Returns at once; the turn runs when its turn comes. */
  pushChannelMessage(content: string, meta: Record<string, string>, _targetSession?: string, deliveryEpoch = this.deliveryEpoch, raw = false): void {
    this.admit(content, meta, deliveryEpoch, raw, false);
  }

  /**
   * An interruption (`/steer`, or `steer: true` from another instance). Where the CLI has its own way to add a message to the running turn
   * (grok's `_x.ai/interject`) that is used: the turn is not cancelled, the message joins it at the CLI's next safe point. Otherwise (agy; or the
   * CLI did not take it) ACP has no mid-turn input, so the running turn is cancelled (`session/cancel`, and any permission request it waits on is
   * answered "cancelled") and when it has ended with `cancelled` this message runs next, in the same session, with a line in front saying the
   * previous turn was cut short. That form goes ahead of the messages already queued, which keep their order behind it. An idle agent just
   * receives it, as any message.
   */
  interruptMessage(content: string, meta: Record<string, string>, deliveryEpoch = this.deliveryEpoch): void {
    this.admit(content, meta, deliveryEpoch, false, true);
  }

  /** How an interruption sent now would be delivered: `add` (into the running turn, the CLI's own way), `interrupt` (cancel and a new prompt), `idle` (nothing runs: sent as it is). */
  interruptMode(): "add" | "interrupt" | "idle" {
    if (this.queued === 0) return "idle";
    const turn = this.turn;
    return turn && !turn.cancelled && !this.inbox.some(i => i.interrupts) && this.adapter.canInterject ? "add" : "interrupt";
  }

  /**
   * The CLI took `content` into the turn that is running: it is a step of that turn, delivered, and confirmed when the turn ends as it should.
   * When the CLI does not take it (an error, a refusal, the turn ended meanwhile) the message goes the other way: cancel and a new prompt.
   */
  private async interjectInto(turn: NonNullable<AcpRunner["turn"]>, content: string, meta: Record<string, string>, deliveryEpoch: number): Promise<void> {
    const status = statusOf(meta);
    let taken: false | "taken" | "announced" = false;
    try {
      taken = await this.adapter.interject(this.format(content, meta), error => {
        // The CLI took the message and then refused it: it was not delivered. Sent again (queued, or interrupting what is running by then).
        if (status) { const at = turn.interjected.findIndex(s => s.messageId === status.messageId); if (at >= 0) turn.interjected.splice(at, 1); }
        this.log.warn({ name: this.name, error: error.message }, "acp: the interjection was refused after being taken; sending the message again");
        this.admit(content, meta, deliveryEpoch, false, true, false);
      });
    } catch { taken = false; }
    if (!taken) {
      this.log.info({ name: this.name }, "acp: the CLI did not take the interjection; interrupting the turn instead");
      this.admit(content, meta, deliveryEpoch, false, true, false);
      return;
    }
    // Taken, but the turn it was meant for has ended or been cancelled in the meantime: it joins no turn, so it is sent again as a message of its own
    // (next in line, or interrupting what runs by then) rather than left without a state. If the CLI did act on the first copy it may be seen twice.
    // (A message the CLI announced as taken while its answer was late is counted as in a turn that ended normally: it was in it.)
    const endedNormally = taken === "announced" && turn.ended === "end_turn" && !turn.cancelled;
    if (!endedNormally && (this.turn !== turn || turn.cancelled || turn.ended !== null)) {
      this.log.warn({ name: this.name, ended: turn.ended }, "acp: the turn ended or was cancelled while the interjection was in flight; sending the message again as its own");
      this.admit(content, meta, deliveryEpoch, false, true, false);
      return;
    }
    this.steps.addUserMessage(content);
    this.noteWorkActivity();
    if (status) this.emit("message_delivered", status);
    const attempt = this.durableAttempt(meta);
    if (attempt && this.outbox && this.outbox.begin(attempt.deliveryId, this.bootId, attempt.attemptNo) === "begun") {
      this.outbox.markEnterStarted(attempt.deliveryId, this.bootId, attempt.attemptNo);
      this.outbox.complete(attempt.deliveryId, this.bootId, attempt.attemptNo, "delivered", "acp:interjected");
    }
    if (endedNormally) { if (status) this.emit("message_confirmed", status); }
    else if (status) turn.interjected.push(status);
    this.log.info({ name: this.name }, "acp: the message was added to the running turn (the CLI's own interjection)");
  }

  private admit(content: string, meta: Record<string, string>, deliveryEpoch: number, raw: boolean, interrupt: boolean, tryNative = true): void {
    if (deliveryEpoch !== this.deliveryEpoch) {
      this.log.info({ name: this.name }, "acp: pending delivery dropped by cancel");
      this.deferDurable(meta, "delivery epoch changed before queue admission");
      this.noteCancelledHuman(meta);
      return;
    }
    if (!this.started && !this.adapter.health().process) return;
    this.updateLastChat(meta.chat_id, meta.thread_id, meta.adapter_id);
    if (meta.chat_id) this.noteWorkActivity();
    if (interrupt && tryNative && !raw && this.interruptMode() === "add") { void this.interjectInto(this.turn!, content, meta, deliveryEpoch); return; }
    const interrupts = interrupt && this.queued > 0 ? { by: meta.from_instance ? `another agent (${meta.from_display || meta.from_instance})` : "the user" } : undefined;
    const item: InboundItem = { content, meta, epoch: deliveryEpoch, turnId: `${this.bootId.slice(0, 8)}-${++this.turnSeq}`, ...(raw ? { raw: true } : {}), ...(interrupts ? { interrupts } : {}) };
    this.queued++;
    if (interrupts) {
      // In front of everything waiting, but behind an interruption that is already waiting (they keep their own order).
      const first = this.inbox.findIndex(i => !i.interrupts);
      this.inbox.splice(first < 0 ? this.inbox.length : first, 0, item);
      const turn = this.turn;
      if (turn && !turn.cancelled) {
        turn.cancelled = true;
        // Only a cancel that reaches a running prompt counts: before the prompt has left it is held and sent right after (`cancelPending`), never dropped.
        if (this.adapter.busy) void this.adapter.cancel(); else turn.cancelPending = true;
      } else if (!turn && this.startingItem) this.startInterrupted = true;
    } else {
      if (this.queued > 1) { const status = statusOf(meta); if (status) this.emit("message_queued", status); }
      this.inbox.push(item);
    }
    this.pump();
  }

  /** The messages waiting, in the order they will run (a test seam, and what a diagnosis would ask). */
  inboxOrder(): string[] { return this.inbox.map(i => i.content); }

  /** Runs the waiting messages one after another (one turn at a time, in the inbox's order). */
  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    this.chain = (async () => {
      try {
        while (this.inbox.length) {
          const item = this.inbox.shift()!;
          this.startingItem = item;
          try { await this.runItem(item); }
          catch (err) { this.log.error({ error: (err as Error).message }, "acp: a delivery failed"); }
          finally { this.queued--; this.startingItem = null; this.startInterrupted = false; }
        }
      } finally { this.pumping = false; }
    })();
  }

  /** `/steer` and `steer: true`: an interruption (see `interruptMessage`). */
  steerMessage(content: string, meta: Record<string, string>, deliveryEpoch?: number): void { this.interruptMessage(content, meta, deliveryEpoch); }

  private async runItem(item: InboundItem): Promise<void> {
    const { meta, content } = item;
    const status = statusOf(meta);
    if (this.stopping || this.writesFenced) { this.deferDurable(meta, "the instance is stopping"); return; }
    // `/raw <text>` is "type this into the CLI as it is" (tmux only, see `onRawPaste`): not a message for an agent with no terminal.
    if (!item.raw && !meta.from_instance && content.startsWith("/raw ")) {
      this.log.warn({ name: this.name }, "acp: /raw was not sent — an ACP instance has no terminal");
      if (status && !meta.delivery_id) this.emit("message_failed", status);
      return;
    }
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
    const wire = item.raw ? content : this.format(content, meta);
    const t: NonNullable<AcpRunner["turn"]> = { item, startedAt: this.now(), text: "", outbound: false, consumed: false, deliveryId: attempt ? attempt.deliveryId : null, attemptNo: attempt ? attempt.attemptNo : 0, cancelled: false, interjected: [], cancelPending: false, ended: null };
    this.turn = t;
    this.startingItem = null;
    // An interruption arrived while this message was being started (a paused agent waking): this turn is cut short as soon as its prompt has left.
    if (this.startInterrupted) { this.startInterrupted = false; t.cancelled = true; t.cancelPending = true; }
    this.noteWorkActivity();
    this.steps.beginTurn(item.turnId, content, undefined, wire);
    this.setBusy(true);
    if (meta.chat_id) this.lastActivityAt = this.now();
    if (attempt) this.outbox?.markEnterStarted(attempt.deliveryId, this.bootId, attempt.attemptNo);
    let stopReason = "error";
    try {
      const sent = this.adapter.prompt(item.interrupts ? `${interruptedNote(item.interrupts.by)}\n\n${wire}` : wire);
      if (t.cancelPending) { t.cancelPending = false; void this.adapter.cancel(); }     // asked for before the prompt left: nothing was running to cancel then
      const result = await sent;
      stopReason = result.stopReason;
      this.proveConsumed(t, "prompt-response");
    } catch (err) {
      const message = (err as Error).message;
      t.ended = "error";
      this.log.warn({ name: this.name, error: message }, "acp: the turn failed");
      if (!t.consumed) this.finishDurable(t, attempt ? "uncertain" : null, `acp:${message.slice(0, 120)}`);
      else this.steps.error(message);
      if (status && !attempt && !t.cancelled) this.emit("message_failed", status);
      this.endTurn(t, "error");
      return;
    }
    t.ended = stopReason;
    this.steps.apply({ kind: "turn_end", stopReason });
    if (stopReason !== "cancelled" && !t.cancelled && status) this.emit("message_confirmed", status);
    if (stopReason !== "cancelled" && !t.cancelled) for (const s of t.interjected) this.emit("message_confirmed", s);
    await this.maybeProxyReply(t, stopReason);
    this.endTurn(t, stopReason);
  }

  private endTurn(t: NonNullable<AcpRunner["turn"]>, _stopReason: string): void {
    if (this.turn === t) this.turn = null;
    // A turn that ends is activity too: a long one must not be followed by an idle pause a few seconds later (`auto_pause_after` counts from here).
    this.noteWorkActivity();
    this.setBusy(false);
    this.mcpTurnEnded();
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

  /** The latest context reading the agent reported (tokens in use, and the window when it is known). */
  private contextReading: { used: number; size: number | null } | null = null;
  private noteUsage(e: { used?: number; size?: number }): void {
    const prev = this.contextReading;
    const used = e.used ?? prev?.used;
    if (used === undefined) return;
    this.contextReading = { used, size: e.size ?? prev?.size ?? null };
  }

  /**
   * What the dashboard's context figure and `/ctx` show for this agent (an ACP agent has no screen to read it from): tokens in use over the
   * window, as a percentage (and, for grok, as the used / total pair its screen shows). Null until the agent has reported one, and for a CLI
   * that reports none; the figure never comes from a guess.
   */
  contextReport(): { context: number; tokenRatio: TokenContextRatio | null } | null {
    const r = this.contextReading;
    if (!this.adapter.capabilities.contextUsage || !r || !r.size || r.size <= 0) return null;
    const context = clampContextPercent(r.used / r.size * 100);
    if (context === null) return null;
    return { context, tokenRatio: this.opts.backend === "grok" ? { usedLabel: tokenLabel(r.used), totalLabel: tokenLabel(r.size), percentage: context } : null };
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
    if (e.kind === "usage") { this.noteUsage(e); return; }
    if (e.kind === "user" || e.kind === "turn_end") return;
    this.steps.apply(e);
  }

  // ───────────────────────────────────────────────────────────────── permissions

  /**
   * The permission policy. `skipPermissions` (unset = true, as for the tmux backends): every request is answered here with the
   * CLI's one-shot "allow once" — never an "always" option (it changes state the CLI keeps), and never another option when
   * there is no "allow once": that request waits for a person. The tool call it was for is marked `auto` in the timeline; no
   * permission card appears. `skipPermissions: false`: requests wait for a person in the chat, except those for this instance's
   * own `agend` tools (found only by fields the CLI sets, `ownToolName`) other than the ones that change the fleet.
   */
  /**
   * Keep the chat's permission card in step with the requests that wait: the first one is put to the people in the chat as a card (the
   * fleet posts it, admins only; a fleet with no chat connection has nowhere to post it and the dashboard's card stands), and when it was
   * answered anywhere, cancelled, or lost with the turn its card is retired and the next waiting request, if any, is put up.
   */
  private syncPermissionCards(): void {
    const pending = this.steps.pendingPermissions();
    const live = new Set(pending.map(permissionCardIdentity));
    for (const identity of [...this.permissionCards.keys()]) {
      if (live.has(identity)) continue;
      this.permissionCards.delete(identity);
      this.emit("remote_card_gone", { name: this.name, identity });
    }
    // One card at a time (the fleet keeps one post per instance): the next waiting request is put up when the one shown is gone.
    if (this.permissionCards.size === 0 && pending[0]) this.postPermissionCard(pending[0]);
  }

  private postPermissionCard(p: PermissionStepInfo): void {
    const identity = permissionCardIdentity(p);
    const choices = new Map<number, "allow" | "deny" | "cancel">();
    const options: RemoteCardOption[] = [];
    const add = (title: string, decision: "allow" | "deny" | "cancel"): void => { choices.set(options.length + 1, decision); options.push({ n: options.length + 1, title, recommended: false, description: null }); };
    if (p.options.some(o => o.kind === "allow_once")) add("Allow once", "allow");
    add("Deny", "deny");
    add("Cancel the turn", "cancel");
    this.permissionCards.set(identity, { requestId: p.requestId, choices });
    this.emit("remote_card", { name: this.name, card: {
      kind: "question", identity, title: "Permission", question: permissionQuestion(p.tool), page: "options", options, freeText: false,
      cursor: null, typed: null, rowWidth: 0, noSkip: true, webOnly: true, acpPermission: true,
    } satisfies RemoteQuestionCard });
  }

  private onPermission(e: Extract<AdapterEvent, { kind: "permission" }>): void {
    const own = ownToolName(e.tool);
    const auto = this.config.skipPermissions !== false || (own !== null && !OWN_TOOLS_ASK.has(own));
    const allow = auto ? e.options.find(o => o.kind === "allow_once") : undefined;
    if (allow && this.adapter.answerPermission(e.requestId, { optionId: allow.id })) {
      const tool = e.tool && typeof e.tool === "object" ? e.tool as Record<string, unknown> : {};
      if (typeof tool.toolCallId === "string") this.steps.noteAuto(tool.toolCallId);
      this.emit("steps_changed");
      return;
    }
    this.steps.apply(e);
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
      case "tool_call": this.noteMcpServing(socket); this.handleToolCall(msg, socket); return;
      case "mcp_ready": {
        const sessionName = msg.sessionName as string | undefined;
        if (!sessionName || sessionName === this.name) this.noteMcpServing(socket);
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
      case "steer": {
        const meta = (msg.meta ?? {}) as Record<string, string>;
        this.steerMessage(String(msg.content ?? msg.text ?? ""), meta, this.captureEpoch(msg.delivery_epoch));
        return;
      }
      // A side question does not interrupt: it waits its turn like any message.
      case "btw": {
        const meta = (msg.meta ?? {}) as Record<string, string>;
        this.pushChannelMessage(String(msg.content ?? msg.text ?? ""), meta, undefined, this.captureEpoch(msg.delivery_epoch));
        return;
      }
      case "raw_paste": this.onRawPaste(msg); return;
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
    if (busy) this.autoPauseRequested = false;
    if (!busy) this.stuck = false;
    this.touchState();
    if (!busy) this.wakeIdleWaiters();
  }
  private touchState(): void { this.stateChangedAt = this.now(); this.publishState(); }

  /**
   * Tell the fleet a state change when it happens, as the tmux daemon does (`instance_state` over the instance socket): the
   * dashboard's status, the idle gates and "needs you" read the fleet's cache of it, which a query alone only seeds.
   */
  private publishState(): void {
    if (!this.ipc || this.isPaused) return;
    const at = this.now();
    this.ipc.broadcast({
      type: "instance_state", name: this.name, state: this.stuck ? "stuck" : this.busy ? "working" : "idle",
      unchangedForMs: 0, observedAt: at, stateChangedAt: this.stateChangedAt, interaction: this.getInteractionSnapshot(),
    });
  }
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
