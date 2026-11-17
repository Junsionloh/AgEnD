import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bounded, promptAnchor, replyAnchor, replyResult, stepBody, stepInput, stepSubject, TEXT_MAX, type LogStep, type StepCat } from "../../log-steps.js";
import type { AdapterEvent } from "../types.js";

/** A thought can be long, and "the full thought" is the point of showing it: more room than an assistant reply. */
export const THOUGHT_MAX = 32_000;
const FILE = "acp-steps.jsonl";
/** Most steps kept in memory, and read back at start. */
const KEEP = 600;
/** The file is rewritten (from the steps kept) when it grows past this many lines. */
const COMPACT_AT = 3000;

/** AgEnD's reply tool as a transcript names it (what the chat's grouping looks for). */
const REPLY_TOOL_NAME = "mcp__agend__reply";
/** The CLIs' own spellings: grok `agend__reply`, agy `mcp_agend_reply` (optionally led by "Run "). */
const OWN_REPLY = /^(?:run\s+)?(?:mcp_{1,2})?agend[\w-]*?_{1,2}reply$/i;
/** The call's input when this tool call is AgEnD's own `reply` (never a look-alike such as another server's `reply`). */
function replyCall(e: Extract<AdapterEvent, { kind: "tool" }>): { input: unknown } | null {
  const raw = e.rawInput && typeof e.rawInput === "object" ? e.rawInput as Record<string, unknown> : {};
  const name = typeof raw.tool_name === "string" ? raw.tool_name : e.title;
  if (!OWN_REPLY.test(name.trim())) return null;
  return { input: raw.tool_input !== undefined ? raw.tool_input : e.rawInput };
}

const CAT: Record<string, StepCat> = {
  read: "read", edit: "edit", delete: "edit", move: "edit", search: "search", execute: "run", fetch: "web",
  think: "other", switch_mode: "other", other: "other",
};

/** A step's answer slot for a permission request, as the page shows it. */
export interface PermissionStepInfo {
  readonly requestId: string;
  /** The timeline step that shows it (JSON-RPC ids restart at 0 with every agent process, so the step id is its own). */
  readonly stepId: string;
  readonly options: readonly { id: string; name: string; kind: string }[];
  readonly tool: unknown;
}

export interface StepsAnswer {
  /** Steps new or changed since `after` (all of the newest `limit` when `after` is undefined). */
  steps: LogStep[];
  /** The cursor to ask `after=` with next. */
  rev: number;
  /** Whether older steps than the ones returned exist (only on an initial read). */
  older: boolean;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * The chat timeline of one ACP instance: `LogStep`s built from adapter events instead of from a transcript file.
 * Thought and message chunks are coalesced into one step each (finalised by the next event of another kind), tool
 * calls are one step updated in place, and a permission request is a step that stays "running" until it is answered.
 * Every strings is masked and bounded by the same code the transcript parsers use. Thought text is never written to
 * disk; every other step is appended to `acp-steps.jsonl` when it settles, so a restart still shows the conversation.
 */
export class AcpStepStore {
  private steps: Mutable<LogStep>[] = [];
  private readonly byId = new Map<string, Mutable<LogStep>>();
  private readonly revOf = new Map<string, number>();
  private rev = 0;
  private seq = 0;
  private turn = "";
  private open: { kind: "thinking" | "assistant"; id: string } | null = null;
  private lines = 0;
  private readonly listeners = new Set<() => void>();
  private readonly permissions = new Map<string, PermissionStepInfo>();

  /**
   * True while the instance skips permissions (`skipPermissions`, on unless false): the CLI was started with its own
   * auto-approve flag, so it runs its tools without ever asking AgEnD, and every tool call says so (`auto`) instead of
   * showing a card. Read per call: a settings change is seen by the next tool.
   */
  constructor(private readonly dir: string, private readonly now: () => number = Date.now, private readonly skipping: () => boolean = () => false) {
    this.load();
  }

  onChange(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  /** The turn's own id and the person's message. `wire`: what was sent to the CLI — the ids the chat joins by are in it. */
  beginTurn(turnId: string, text: string, ts = this.now(), wire = text): void {
    this.closeOpen();
    this.turn = turnId;
    const step: LogStep = { id: `u-${turnId}`, turn: turnId, ts, kind: "user" };
    stepBody(step, text, TEXT_MAX);
    // What ties this turn to the chat's rows (the ids AgEnD wrote into the delivered prompt), as a transcript's user step has.
    const anchor = promptAnchor(wire);
    if (anchor) step.anchor = anchor;
    this.put(step, true);
  }

  /** A person's message added to the turn that is running (`interject`): a step of its own in that turn, after what has happened so far. */
  addUserMessage(text: string, ts = this.now()): string {
    this.closeOpen();
    const step: LogStep = { id: `ui-${this.turn || "x"}-${++this.seq}`, turn: this.turn, ts, kind: "user" };
    stepBody(step, text, TEXT_MAX);
    this.put(step, true);
    return step.id;
  }

  /**
   * The chat row AgEnD's `reply` tool call produced, known to the daemon exactly (the fleet's answer to the MCP call names the
   * message): the call's step gains that `messageId`. An ACP CLI's own update for the call does not always say (agy's carries no
   * result), so this is the exact anchor and the text the call came with is only how the step is found. The call's step may
   * not be here yet (its update and the MCP call race): the id waits for it, and a turn that ends first gives it to the oldest
   * reply step still without one, else a step of its own.
   */
  anchorReply(text: string, messageId: string): void {
    const head = replyAnchor({ text })?.replyText;
    if (!head || !messageId) return;
    const step = this.turnReplies().reverse().find(s => s.anchor?.replyText === head);
    if (step) { this.setReplyId(step, messageId); return; }
    this.pendingReplies.push({ head, messageId, at: this.turn, ends: 0 });
    if (this.pendingReplies.length > 20) this.pendingReplies.shift();
  }
  /**
   * Ids waiting for their call's update. `at`: the turn the fleet's answer came in. An agent that works while no prompt is running
   * (agy, after a command it left in the background finished) calls `reply` then, but its updates only come with its next prompt: an
   * id is matched by its words in whichever turn the update arrives. Only an id from this turn is handed to a step by order or given a step
   * of its own (`settlePendingReplies`), and one nothing claimed in two turns' ends is dropped.
   */
  private readonly pendingReplies: { head: string; messageId: string; at: string; ends: number }[] = [];

  /** This turn's reply steps (calls that did not fail) that no message is named for yet, oldest first. */
  private turnReplies(): Mutable<LogStep>[] {
    return this.steps.filter(s => s.turn === this.turn && s.kind === "tool" && s.tool === REPLY_TOOL_NAME && s.status !== "failed" && s.status !== "interrupted" && !s.anchor?.messageId);
  }

  private setReplyId(step: Mutable<LogStep>, messageId: string): void {
    step.anchor = { ...step.anchor, messageId };
    this.put(step, step.status !== "running");
  }

  /**
   * The agent used no `reply` tool and AgEnD sent its closing text as the reply (`messageId`: the bubble it made): the timeline
   * gets the reply step a tool call would have left — so the steps before it are anchored to that bubble exactly — and the text
   * the turn wrote is marked as sent, so the chat does not show it a second time inside the activity block.
   */
  addProxyReply(text: string, messageId?: string): void {
    this.closeOpen();
    const anchor = { ...replyAnchor({ text }), ...(messageId ? { messageId } : {}) };
    const step: LogStep = { id: `pr-${this.turn || "x"}-${++this.seq}`, turn: this.turn, ts: this.now(), kind: "tool", tool: REPLY_TOOL_NAME, cat: "message", status: "done" };
    if (anchor.replyText || anchor.messageId) step.anchor = anchor;
    stepBody(step, text, 2000);
    for (const s of this.steps) {
      if (s.turn !== this.turn || s.kind !== "assistant" || s.sent) continue;
      s.sent = true;
      this.put(s, true);
    }
    this.put(step, true);
  }

  /** The CLI took a message added to the turn and then refused it: the step says so (the message is sent again as a message of its own). */
  refuseUserMessage(id: string): void {
    const step = this.byId.get(id);
    if (!step || step.kind !== "user") return;
    step.status = "failed";
    step.note = "the CLI refused this message; it is sent again as its own";
    this.put(step, true);
  }

  /** Fold one adapter event into the timeline. Events with no place in it (usage, quota, user echo) are ignored. */
  apply(event: AdapterEvent): void {
    switch (event.kind) {
      case "thought": return this.chunk("thinking", event.text);
      case "message": return this.chunk("assistant", event.text);
      case "tool": return this.tool(event);
      case "plan": return this.plan(event.entries);
      case "permission": return this.permission(event);
      case "turn_end": return this.endTurn(event.stopReason);
      default: return;
    }
  }

  /** A failure of the turn that is not a stop reason (the process died, the request was refused). */
  error(message: string, o: { running?: "keep" } = {}): string {
    // A notice that is not about the running turn (a setting that was not applied, a server that did not connect) leaves the turn's open steps alone.
    if (o.running !== "keep") { this.closeOpen(); this.settleRunning("interrupted"); }
    const step: LogStep = { id: `e-${this.turn || "x"}-${++this.seq}`, turn: this.turn, ts: this.now(), kind: "error" };
    stepBody(step, message, TEXT_MAX);
    this.put(step, true);
    return step.id;
  }

  /**
   * An error that turned out not to be one (a warning that was raised too early): the step stays in the Log, as a plain state
   * line that says what happened, and the chat no longer shows it (the chat shows errors, not state lines). Saved the same
   * way, so a restart does not bring the error back. False when the step is gone or is not an error.
   */
  retractError(id: string, note: string): boolean {
    const step = this.byId.get(id);
    if (!step || step.kind !== "error") return false;
    step.kind = "state";
    step.note = note;
    delete step.body;
    delete step.bodyCut;
    this.put(step, true);
    return true;
  }

  /** A permission step's outcome: its buttons are gone, `note` says what was chosen. */
  resolvePermission(requestId: string, note: string): void {
    const step = this.byId.get(this.permissions.get(requestId)?.stepId ?? `perm-${requestId}`);
    this.permissions.delete(requestId);
    if (!step || step.status !== "running") return;
    step.status = note === "cancelled" ? "interrupted" : "done";
    step.note = note;
    delete step.options;
    this.put(step, true);
  }

  private readonly autoIds = new Set<string>();
  /**
   * The CLI asked to run this tool call and AgEnD's policy allowed it (`skipPermissions`): the tool step says so (`auto`). The
   * request may come before or after the call's own update, so an id seen first is remembered.
   */
  noteAuto(toolCallId: string): void {
    const step = this.byId.get(`t-${toolCallId}`);
    if (!step) { this.autoIds.add(toolCallId); if (this.autoIds.size > 500) this.autoIds.delete(this.autoIds.values().next().value as string); return; }
    if (step.auto) return;
    step.auto = true;
    this.put(step, step.status !== "running");
  }

  /** Pending permission requests (what the page may answer). */
  pendingPermissions(): PermissionStepInfo[] { return [...this.permissions.values()]; }

  /** The turn ended without the agent saying so: tools still marked running did not finish. */
  interrupt(): void {
    this.closeOpen();
    this.settleRunning("interrupted");
  }

  snapshot(after: number | undefined, opts: { thoughts: boolean; limit?: number }): StepsAnswer {
    const limit = opts.limit ?? 200;
    const visible = (s: LogStep) => opts.thoughts || s.kind !== "thinking";
    let out: LogStep[];
    let older = false;
    if (after === undefined) {
      const all = this.steps.filter(visible);
      older = all.length > limit;
      out = all.slice(-limit);
    } else {
      out = this.steps.filter(s => visible(s) && (this.revOf.get(s.id) ?? 0) > after);
    }
    return { steps: out.map(s => ({ ...s })), rev: this.rev, older };
  }

  /** Every settled non-thought step is on disk; call before the process ends. */
  flush(): void { /* appends are synchronous; kept for symmetry and future batching */ }

  // ───────────────────────────────────────────────────────────── building

  private chunk(kind: "thinking" | "assistant", text: string): void {
    if (!text) return;
    if (this.open && this.open.kind !== kind) this.closeOpen();
    let step = this.open ? this.byId.get(this.open.id) : undefined;
    if (!step) {
      step = { id: `${kind === "thinking" ? "th" : "a"}-${this.turn || "x"}-${++this.seq}`, turn: this.turn, ts: this.now(), kind, status: "running" };
      this.open = { kind, id: step.id };
      step.body = "";
    }
    // Keep the raw text while it grows, so a secret split across two chunks is still masked when the step is shown.
    const raw = ((this.rawOf.get(step.id) ?? "") + text);
    this.rawOf.set(step.id, raw.length > THOUGHT_MAX * 2 ? raw.slice(0, THOUGHT_MAX * 2) : raw);
    const b = bounded(this.rawOf.get(step.id)!, kind === "thinking" ? THOUGHT_MAX : TEXT_MAX);
    step.body = b.text;
    if (b.cut) step.bodyCut = b.cut;
    this.put(step, false);
  }
  private readonly rawOf = new Map<string, string>();

  private tool(e: Extract<AdapterEvent, { kind: "tool" }>): void {
    this.closeOpen();
    const id = `t-${e.id}`;
    let step = this.byId.get(id);
    if (!step) { step = { id, turn: this.turn, ts: this.now(), kind: "tool" }; }
    step.tool = e.title.slice(0, 120);
    step.cat = CAT[e.toolKind] ?? "other";
    // AgEnD's own `reply` tool, by whatever name the CLI gives it: the chat joins a timeline to its bubbles by this call
    // (log-steps.ts: replyAnchor / replyResult), so it carries the canonical name and the same anchor as a transcript's.
    const named = replyCall(e);
    if (named) {
      step.tool = REPLY_TOOL_NAME;
      step.cat = "message";
      const anchor = replyAnchor(named.input);
      if (anchor) step.anchor = { ...anchor, ...(step.anchor?.messageId ? { messageId: step.anchor.messageId } : {}) };
      const waiting = this.pendingReplies.findIndex(p => p.head === step!.anchor?.replyText);
      if (waiting >= 0 && !step.anchor?.messageId) step.anchor = { ...step.anchor, messageId: this.pendingReplies.splice(waiting, 1)[0]!.messageId };
    }
    // The plan and AgEnD's own `reply` are the agent talking, not a tool that would have asked.
    if (this.autoIds.has(e.id) || (this.skipping() && step.cat !== "plan" && step.cat !== "message")) step.auto = true;
    const subject = subjectFromInput(e.rawInput) ?? e.title;
    const s = stepSubject(subject);
    if (s) step.subject = s;
    if (e.rawInput !== undefined) stepInput(step, e.rawInput);
    step.status = e.status === "completed" ? "done" : e.status === "failed" ? "failed" : "running";
    if (e.rawOutput !== undefined && e.status !== "pending" && e.status !== "in_progress") {
      const text = typeof e.rawOutput === "string" ? e.rawOutput : outputText(e.rawOutput);
      if (text) stepBody(step, text, 2000);
      if (named && text) replyResult(step, text);
    }
    const settled = step.status !== "running";
    this.put(step, settled);
  }

  private plan(entries: unknown[]): void {
    this.closeOpen();
    const text = entries.map(e => {
      const r = e && typeof e === "object" ? e as Record<string, unknown> : {};
      const mark = r.status === "completed" ? "[x]" : r.status === "in_progress" ? "[~]" : "[ ]";
      return `${mark} ${typeof r.content === "string" ? r.content : ""}`;
    }).join("\n");
    const step: LogStep = { id: `p-${this.turn || "x"}`, turn: this.turn, ts: this.now(), kind: "tool", tool: "plan", cat: "plan", status: "done" };
    stepBody(step, text, TEXT_MAX);
    this.put(step, true);
  }

  private permission(e: Extract<AdapterEvent, { kind: "permission" }>): void {
    this.closeOpen();
    const tool = e.tool && typeof e.tool === "object" ? e.tool as Record<string, unknown> : {};
    const title = typeof tool.title === "string" ? tool.title : "tool";
    const stepId = `perm-${e.requestId}-${this.turn || "x"}-${++this.seq}`;
    const step: Mutable<LogStep> = { id: stepId, turn: this.turn, ts: this.now(), kind: "permission", status: "running", tool: title.slice(0, 120) };
    const cat = typeof tool.kind === "string" ? CAT[tool.kind] : undefined;
    if (cat) step.cat = cat;
    const subject = stepSubject(subjectFromInput(tool.rawInput) ?? title);
    if (subject) step.subject = subject;
    if (tool.rawInput !== undefined) stepInput(step, tool.rawInput);
    stepBody(step, title, 600);
    // Never offer a choice that changes the CLI's own stored policy: only the one-shot answers reach the page.
    step.options = e.options.filter(o => o.kind === "allow_once" || o.kind === "reject_once").map(o => ({ id: o.id, name: o.name.slice(0, 80), kind: o.kind as "allow_once" | "reject_once" }));
    this.permissions.set(e.requestId, { requestId: e.requestId, stepId, options: e.options, tool: e.tool });
    this.put(step, false);
  }

  private endTurn(stopReason: string): void {
    this.closeOpen();
    this.settlePendingReplies();
    this.settleRunning(stopReason === "cancelled" ? "interrupted" : "done");
    const step: LogStep = { id: `end-${this.turn || "x"}-${++this.seq}`, turn: this.turn, ts: this.now(), kind: "turn_end", note: stopReason };
    this.put(step, true);
  }

  /** A reply the fleet confirmed that no step of the turn has claimed by now: the oldest reply step without an id takes it, else it gets a step. */
  private settlePendingReplies(): void {
    const waiting = this.pendingReplies.splice(0);
    for (const p of waiting) {
      if (p.at !== this.turn) { if (++p.ends < 2) this.pendingReplies.push(p); continue; }
      const step = this.turnReplies()[0];
      if (step) { this.setReplyId(step, p.messageId); continue; }
      const made: LogStep = { id: `pr-${this.turn || "x"}-${++this.seq}`, turn: this.turn, ts: this.now(), kind: "tool", tool: REPLY_TOOL_NAME, cat: "message", status: "done", anchor: { replyText: p.head, messageId: p.messageId } };
      this.put(made, true);
    }
  }

  private closeOpen(): void {
    if (!this.open) return;
    const step = this.byId.get(this.open.id);
    this.open = null;
    if (!step) return;
    step.status = "done";
    this.rawOf.delete(step.id);
    this.put(step, true);
  }

  private settleRunning(status: "done" | "interrupted"): void {
    for (const step of this.steps) {
      if (step.turn !== this.turn || step.status !== "running") continue;
      if (step.kind === "permission") {
        for (const [req, info] of this.permissions) if (info.stepId === step.id) this.permissions.delete(req);
        step.note ??= "cancelled"; delete step.options; step.status = "interrupted";
      }
      else if (step.kind === "tool") step.status = "interrupted";
      else step.status = status;
      this.put(step, true);
    }
  }

  private put(step: Mutable<LogStep>, settled: boolean): void {
    if (!this.byId.has(step.id)) { this.steps.push(step); }
    this.byId.set(step.id, step);
    this.revOf.set(step.id, ++this.rev);
    if (this.steps.length > KEEP * 1.5) this.trim();
    if (settled && step.kind !== "thinking") this.persist(step);
    for (const l of this.listeners) { try { l(); } catch { /* an observer cannot break the timeline */ } }
  }

  private trim(): void {
    const drop = this.steps.splice(0, this.steps.length - KEEP);
    for (const s of drop) { this.byId.delete(s.id); this.revOf.delete(s.id); }
  }

  // ───────────────────────────────────────────────────────────── disk

  private persist(step: LogStep): void {
    try {
      appendFileSync(join(this.dir, FILE), JSON.stringify(step) + "\n", { mode: 0o600 });
      if (++this.lines > COMPACT_AT) this.compact();
    } catch { /* the live timeline does not depend on the file */ }
  }

  private compact(): void {
    try {
      const keep = this.steps.filter(s => s.kind !== "thinking" && s.status !== "running");
      const file = join(this.dir, FILE);
      writeFileSync(`${file}.tmp`, keep.map(s => JSON.stringify(s)).join("\n") + (keep.length ? "\n" : ""), { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
      this.lines = keep.length;
    } catch { /* try again at the next threshold */ }
  }

  private load(): void {
    try {
      const file = join(this.dir, FILE);
      if (!existsSync(file)) return;
      const latest = new Map<string, LogStep>();
      const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
      this.lines = lines.length;
      for (const line of lines.slice(-KEEP * 3)) {
        try {
          const s = JSON.parse(line) as LogStep;
          if (s && typeof s.id === "string" && typeof s.kind === "string") { latest.set(s.id, s); }   // a step keeps the place it first had (as in memory); a later line only updates it
        } catch { /* a torn last line */ }
      }
      for (const s of [...latest.values()].slice(-KEEP)) {
        // Whatever was waiting when the process ended is not waiting any more.
        if (s.status === "running") { s.status = "interrupted"; if (s.kind === "permission") { s.note ??= "cancelled"; delete s.options; } }
        this.steps.push(s); this.byId.set(s.id, s); this.revOf.set(s.id, ++this.rev);
      }
    } catch { /* unreadable history: start with an empty timeline */ }
  }
}

const SUBJECT_KEYS = ["command", "cmd", "file_path", "filePath", "path", "Path", "AbsolutePath", "TargetFile", "url", "Url", "query", "Query", "pattern", "Pattern"];
function subjectFromInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return typeof input === "string" ? input : undefined;
  const r = input as Record<string, unknown>;
  for (const k of SUBJECT_KEYS) if (typeof r[k] === "string" && r[k]) return r[k] as string;
  return undefined;
}

const OUTPUT_KEYS = ["tool_output_for_prompt_concise", "tool_output_for_prompt", "OkayOutput", "output", "stdout", "text"];
/**
 * The text of a tool's result, wherever the CLI nests it: grok puts an MCP result in `output.OkayOutput`, a shell result in
 * `output` / `stdout`. The first string found under a known key, looking a few objects deep.
 */
function outputText(out: unknown, depth = 0): string {
  if (!out || typeof out !== "object" || depth > 3) return "";
  const r = out as Record<string, unknown>;
  for (const k of OUTPUT_KEYS) if (typeof r[k] === "string") return r[k] as string;
  for (const k of OUTPUT_KEYS) {
    const v = r[k];
    if (v && typeof v === "object") { const inner = outputText(v, depth + 1); if (inner) return inner; }
  }
  for (const v of Object.values(r)) {
    if (v && typeof v === "object") { const inner = outputText(v, depth + 1); if (inner) return inner; }
  }
  return "";
}
