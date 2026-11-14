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

  constructor(private readonly dir: string, private readonly now: () => number = Date.now) {
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
  error(message: string): void {
    this.closeOpen();
    this.settleRunning("interrupted");
    const step: LogStep = { id: `e-${this.turn || "x"}-${++this.seq}`, turn: this.turn, ts: this.now(), kind: "error" };
    stepBody(step, message, TEXT_MAX);
    this.put(step, true);
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
      if (anchor) step.anchor = anchor;
    }
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
    this.settleRunning(stopReason === "cancelled" ? "interrupted" : "done");
    const step: LogStep = { id: `end-${this.turn || "x"}-${++this.seq}`, turn: this.turn, ts: this.now(), kind: "turn_end", note: stopReason };
    this.put(step, true);
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
          if (s && typeof s.id === "string" && typeof s.kind === "string") { latest.delete(s.id); latest.set(s.id, s); }
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

function outputText(out: unknown): string {
  if (!out || typeof out !== "object") return "";
  const r = out as Record<string, unknown>;
  for (const k of ["tool_output_for_prompt_concise", "output", "stdout", "text"]) if (typeof r[k] === "string") return r[k] as string;
  const nested = Object.values(r).find(v => v && typeof v === "object") as Record<string, unknown> | undefined;
  const inner = nested && ["tool_output_for_prompt_concise", "tool_output_for_prompt", "output"].map(k => nested[k]).find(v => typeof v === "string");
  return typeof inner === "string" ? inner : "";
}
