/**
 * #1218 phase 1: the Log tab's server side — on demand only (the user's decision on load, 2026-10-13). Off by default
 * (`web.log_tab`); off, it answers `{ enabled: false }` and does no work at all. On:
 *
 * - **Nothing runs in the background.** No collector, no step log on disk: each GET /ui/steps reads a bounded range of
 *   the instance's own transcript (async, ≤ 8 MiB back or ≤ 4 MiB forward) and parses it with the backend's parser
 *   (log-steps.ts). Step ids depend on the bytes, not on the range, so the page merges ranges.
 * - **Live only under a watch.** A request with `watch` holds a lease (WATCH_LEASE_MS, renewed by every request); while
 *   one is held the fleet looks at the transcript's size every WATCH_POLL_MS and, when it moved, broadcasts a tiny
 *   `steps_tick { instance }` — the page then fetches `after=` its cursor. No lease: no timer, no read.
 * - **Fleet events** (crash, restart, hang, a prompt waiting, a pause) come from the existing event log, by id.
 *
 * Nothing here runs in the daemon, and nothing reads a CLI's file on a tool call.
 */
import { stat } from "node:fs/promises";
import { ClaudeStepParser, CodexStepParser, bounded, readTailRecords, type LogStep } from "./log-steps.js";
import { SCREEN_MAX_BYTES } from "./dialog-screen-text.js";
import { LOOKS_PER_POLL, isClaudeAssistantHead, readNewLines, readWholeLine, type LongLine } from "./transcript-jsonl.js";

export const LOG_STEPS_LIMIT = 200;
export const LOG_OLDER_LIMIT = 100;
export const LOG_RESPONSE_MAX_BYTES = 512 * 1024;
export const WATCH_LEASE_MS = 45_000;
export const WATCH_POLL_MS = 2_000;
export const LOG_EVENTS_LIMIT = 50;

/** Where an instance's steps come from, as the fleet resolves it (only when the Log asks). */
export interface LogSource {
  backend: string;
  /** The transcript to read, or null: none known now. */
  path: string | null;
  /** The parser for it: claude / codex (kiro: its own reader, later in phase 1); null: this backend has none. */
  format: "claude" | "codex" | null;
  /** Why there is nothing to read: "not_running" (its transcript is found while it runs), "no_transcript", "unsupported". */
  reason?: string;
  /** Set for an instance that produces its steps live (no file): they are served from here, `path` and `format` unused. */
  live?: LiveSteps;
}

/**
 * Steps an instance produces itself, live, instead of a transcript file (an `acp` instance, #3731). The cursor is a
 * revision counter; `key` names this run's timeline, so a page holding a cursor of another run starts again.
 */
export interface LiveSteps {
  readonly key: string;
  snapshot(after: number | undefined, opts: { thoughts: boolean; limit?: number }): { steps: LogStep[]; rev: number; older: boolean };
  /** Told when a step is added or changed; returns the way to stop being told. */
  subscribe(listener: () => void): () => void;
}

export interface LogEventRow { id: number; event_type: string; payload: unknown; created_at: string }

export interface LogServiceDeps {
  enabled(): boolean;
  /** `web.log_thinking`: whether an admin may be shown thought text (it is never shown to anyone else). */
  thinking?(): boolean;
  /** An instance the Log may show (a fleet instance or a ClassicBot room). */
  known(name: string): boolean;
  source(name: string): LogSource;
  /** The instance's newest event-log rows (newest first), at most `limit`. */
  events(name: string, limit: number): LogEventRow[];
  /** Broadcast to the web stream. */
  emit(event: string, data: unknown): void;
  now?(): number;
  setInterval?(fn: () => void, ms: number): unknown;
  clearInterval?(handle: unknown): void;
}

export interface LogQuery { after?: number; before?: number; key?: string; skip?: boolean; limit?: number; watch?: boolean; ev?: number;
  /** The reader is an admin of this fleet (not a guest, not the public link): the only reader thought text and permission buttons are for. */
  admin?: boolean }

/** A fleet event as the page shows it: its type (the page words it) and its details, masked. */
export interface LogEvent { id: number; ts: number; type: string; detail?: string;
  /** M-2269: the dialog or prompt as it was on screen (dialog_parked, interactive_prompt), masked; shown folded. */
  screen?: string }

/** The event types a Log shows: what changed for the instance itself, not bookkeeping (tips, cost snapshots). */
export const LOG_EVENT_TYPES: ReadonlySet<string> = new Set([
  "working_state", "kiro_reconcile",
  "crash_respawn", "crash_loop", "hang_detected", "hang_action", "instance_paused", "instance_resumed",
  "interactive_prompt", "interactive_prompt_assist", "dialog_parked", "model_failover", "model_recovered",
  "mcp_died", "mcp_recovered", "mcp_auto_restart", "message_failed", "messages_cancelled", "pty_error", "pty_recovered",
  "backend_unreachable", "startup_backend_unreachable", "backend_launch_warning", "clear_action", "normal_exit_action",
  "reply_drop_detected", "reply_drop_recovered", "reply_drop_unrecovered", "supervision_ended", "tmux_server_crash",
  "malformed_tool_call", "health_check_error", "context_lost", "remote_card", "remote_card_answer",
]);

export type LogAnswer =
  | { enabled: false }
  | {
    enabled: true; instance: string; backend: string; supported: boolean; reason?: string;
    /** The transcript's identity (device-inode): a cursor of another one is reset. */
    key?: string;
    steps: LogStep[]; events: LogEvent[];
    /** Offset to ask `before=` for older steps; null: nothing older. */
    before: number | null;
    /** Offset to ask `after=` for newer steps (with `skip` when it is inside a long record). */
    after: number | null; skip?: boolean;
    /** More is already waiting after `after`. */
    more?: boolean;
    /** The page's cursor was for another transcript (a new session) or past its end: start again from this answer. */
    reset?: boolean;
    /** The newest event id this answer saw (for `ev=`). */
    ev: number;
  };

/** LogService.readBack's answer: the steps before `end`, or why there are none (`reason`, no `steps`). */
export type ReadBack =
  | { backend: string; format: "claude" | "codex" | null; reason: string; key?: undefined; steps?: undefined }
  | { backend: string; format: "claude" | "codex"; key: string; steps: LogStep[]; before: number | null; end: number; reset?: boolean; reason?: undefined };

const parserFor = (format: "claude" | "codex") => (format === "claude" ? new ClaudeStepParser() : new CodexStepParser());
/** The long records worth reading whole for a Log (a reply, a turn record); every other long one by its head. */
const wholeFor = (format: "claude" | "codex") => (head: string) => (format === "claude"
  ? isClaudeAssistantHead(head)
  : head.includes('"type":"event_msg"') || (head.includes('"type":"response_item"') && /"payload":\{"type":"message"/.test(head)));

const dbTime = (s: string): number => { const t = Date.parse(s.replace(" ", "T") + "Z"); return Number.isFinite(t) ? t : 0; };

export class LogService {
  private readonly watches = new Map<string, { until: number; path: string; size: number; ino: number; timer: unknown }>();
  constructor(private readonly deps: LogServiceDeps) {}

  private now(): number { return this.deps.now ? this.deps.now() : performance.now(); }

  /** GET /ui/steps — null: no such instance. */
  async steps(name: string, q: LogQuery): Promise<LogAnswer | null> {
    if (!this.deps.enabled()) { this.unwatchAll(); return { enabled: false }; }
    if (!this.deps.known(name)) return null;
    const src = this.deps.source(name);
    const evs = this.eventsFor(name, q.ev);
    const base = { enabled: true as const, instance: name, backend: src.backend, events: evs.events, ev: evs.ev };
    if (src.live) return this.liveAnswer(name, src.live, q, base);
    if (!src.format || !src.path) {
      return { ...base, supported: !!src.format, reason: src.reason ?? (src.format ? "no_transcript" : "unsupported"), steps: [], before: null, after: null };
    }
    let st: { dev: number; ino: number; size: number };
    try { st = await stat(src.path); } catch { return { ...base, supported: true, reason: "no_transcript", steps: [], before: null, after: null }; }
    const key = `${st.dev}-${st.ino}`;
    if (q.watch) this.watch(name, src.path, st.size, st.ino);
    const answer = { ...base, supported: true, key };
    const fresh = q.key !== undefined && q.key !== key;
    const past = q.after !== undefined && q.after > st.size;
    if (q.after !== undefined && !fresh && !past) return { ...answer, ...(await this.forward(src.path, src.format, q.after, !!q.skip)) };
    if (q.before !== undefined && !fresh) return { ...answer, ...(await this.backward(src.path, src.format, q.before, Math.min(q.limit ?? LOG_OLDER_LIMIT, LOG_OLDER_LIMIT))), after: null };
    const back = await this.backward(src.path, src.format, undefined, Math.min(q.limit ?? LOG_STEPS_LIMIT, LOG_STEPS_LIMIT));
    return { ...answer, ...back, ...((fresh || past) && (q.after !== undefined || q.before !== undefined) ? { reset: true } : {}) };
  }

  private readonly liveWatches = new Map<string, { until: number; stop: () => void; timer: unknown }>();

  /** An instance's own live steps: only what changed since the page's cursor, thought text and answer buttons for an admin alone. */
  private liveAnswer(name: string, live: LiveSteps, q: LogQuery, base: { enabled: true; instance: string; backend: string; events: LogEvent[]; ev: number }): LogAnswer {
    if (q.watch) this.watchLive(name, live);
    const admin = q.admin === true;
    const thoughts = admin && this.deps.thinking?.() === true;
    const stale = (q.key !== undefined && q.key !== live.key) || (q.after !== undefined && q.after > live.snapshot(undefined, { thoughts, limit: 1 }).rev);
    const after = stale ? undefined : q.after;
    const got = live.snapshot(after, { thoughts, ...(q.limit !== undefined ? { limit: Math.min(q.limit, LOG_STEPS_LIMIT) } : {}) });
    // A person who is not an admin sees that a request is waiting, and never its answer buttons.
    const steps = admin ? got.steps : got.steps.map(s => { if (s.kind !== "permission" || !s.options) return s; const { options: _options, ...rest } = s; return rest; });
    return {
      ...base, supported: true, key: live.key, steps: fitBytes(steps), before: null, after: got.rev,
      ...(stale && (q.after !== undefined || q.before !== undefined) ? { reset: true } : {}),
    };
  }

  /** Tell the page (`steps_tick`) when the live timeline moved, while it holds a watch lease. */
  private watchLive(name: string, live: LiveSteps): void {
    const until = this.now() + WATCH_LEASE_MS;
    const held = this.liveWatches.get(name);
    if (held) { held.until = until; return; }
    const setT = this.deps.setInterval ?? ((fn: () => void, ms: number) => { const t = setInterval(fn, ms); (t as { unref?: () => void }).unref?.(); return t; });
    const entry = { until, stop: () => undefined as void, timer: null as unknown };
    let queued = false;
    const unsubscribe = live.subscribe(() => {
      if (this.now() > entry.until || !this.deps.enabled()) { this.stopLive(name); return; }
      if (queued) return;
      queued = true;
      // Coalesce a burst of chunks into one tick: the page fetches what changed after it.
      setTimeout(() => { queued = false; this.deps.emit("steps_tick", { instance: name }); }, 200).unref?.();
    });
    entry.stop = unsubscribe;
    // A lease that nobody renews ends even when the timeline is quiet.
    entry.timer = setT(() => { if (this.now() > entry.until) this.stopLive(name); }, WATCH_POLL_MS);
    this.liveWatches.set(name, entry);
  }

  private stopLive(name: string): void {
    const w = this.liveWatches.get(name);
    if (!w) return;
    w.stop();
    (this.deps.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>)))(w.timer);
    this.liveWatches.delete(name);
  }

  /**
   * Claude history in the View (view-history.ts): the steps before `end` (the newest when undefined), at most `limit` —
   * read the way the Log reads them, but without the Log's switch, its watch or its events: the View's own access rules
   * were applied before this is asked (view-api.ts). `end` of a cursor for another transcript (a new session), or past
   * this one's end, reads the newest instead (`reset`). Null: no such instance.
   */
  async readBack(name: string, q: { end?: number; key?: string; limit: number }): Promise<ReadBack | null> {
    if (!this.deps.known(name)) return null;
    const src = this.deps.source(name);
    if (!src.format || !src.path) return { backend: src.backend, format: src.format, reason: src.reason ?? (src.format ? "no_transcript" : "unsupported") };
    let st: { dev: number; ino: number; size: number };
    try { st = await stat(src.path); } catch { return { backend: src.backend, format: src.format, reason: "no_transcript" }; }
    const key = `${st.dev}-${st.ino}`;
    const limit = Math.max(1, Math.min(q.limit, LOG_STEPS_LIMIT));
    const stale = q.end !== undefined && ((q.key !== undefined && q.key !== key) || q.end > st.size);
    if (q.end !== undefined && !stale) {
      const back = await this.backward(src.path, src.format, q.end, limit);
      return { backend: src.backend, format: src.format, key, steps: back.steps, before: back.before, end: q.end };
    }
    const back = await this.backward(src.path, src.format, undefined, limit);
    return { backend: src.backend, format: src.format, key, steps: back.steps, before: back.before, end: back.after, ...(stale ? { reset: true } : {}) };
  }

  /** The steps before `end` (the newest when undefined), at most `limit`, and where older ones start. */
  private async backward(path: string, format: "claude" | "codex", end: number | undefined, limit: number): Promise<{ steps: LogStep[]; before: number | null; after: number }> {
    const tail = await readTailRecords(path, { maxLines: 4000, ...(end !== undefined ? { end } : {}) });
    const parser = parserFor(format);
    const whole = wholeFor(format);
    const firstAt = new Map<string, number>();
    for (const r of tail.records) {
      let record: string | LongLine = r.record;
      // #1788 review P3: a long reply or turn record is read whole here too, as the live read does.
      if (typeof record !== "string" && whole(record.head)) {
        const text = await readWholeLine(path, r.at, record.bytes).catch(() => null);
        if (text !== null) record = text;
      }
      for (const s of parser.push(record, r.at)) if (!firstAt.has(s.id)) firstAt.set(s.id, r.at);
    }
    let steps = fitBytes(parser.steps.slice(-limit));
    // #1788 review P3: cut only at a record's boundary — one record can make several steps (a reply's text and its
    // call): the oldest kept record comes whole, so `before` (its start) never leaves one of its steps out for good.
    let from = parser.steps.length - steps.length;
    const recordOf = (i: number) => firstAt.get(parser.steps[i]!.id);
    while (from > 0 && steps.length && recordOf(from - 1) === recordOf(from)) from--;
    steps = parser.steps.slice(from);
    // Older steps exist when the read stopped before the file's start, or when steps it parsed were left out (the limit,
    // the answer's size): they start at the record of the oldest step shown. Otherwise nothing is older.
    const all = !tail.truncated && steps.length === parser.steps.length;
    const first = steps.length ? Math.min(...steps.map(s => firstAt.get(s.id) ?? Infinity)) : (tail.records[0]?.at ?? 0);
    const before = !all && Number.isFinite(first) && first > 0 ? first : null;
    return { steps, before, after: tail.end };
  }

  /** The steps after `from` (≤ LOOKS_PER_POLL looks), and the cursor after them. */
  private async forward(path: string, format: "claude" | "codex", from: number, skip: boolean): Promise<{ steps: LogStep[]; before: null; after: number; skip?: boolean; more?: boolean }> {
    const parser = parserFor(format);
    const whole = wholeFor(format);
    let offset = from, skipping = skip, more = false;
    for (let look = 0; look < LOOKS_PER_POLL; look++) {
      const read = await readNewLines(path, offset, { skipping });
      const moved = read.newOffset !== offset;
      offset = read.newOffset; skipping = read.skipping; more = read.more;
      // In file order: complete lines with their offsets, long lines by their head — or whole, for a reply or turn record.
      let li = 0;
      const pushLong = async (l: LongLine) => {
        if (l.complete && whole(l.head)) {
          const text = await readWholeLine(path, l.offset, l.bytes).catch(() => null);
          if (text !== null) { parser.push(text, l.offset); return; }
        }
        parser.push(l, l.offset);
      };
      for (const l of read.long) {
        while (li < l.at) { parser.push(read.lines[li]!, read.offsets[li]!); li++; }
        await pushLong(l);
      }
      while (li < read.lines.length) { parser.push(read.lines[li]!, read.offsets[li]!); li++; }
      if (!moved || !read.more) break;
    }
    const steps = fitBytes(parser.steps);
    return { steps, before: null, after: offset, ...(skipping ? { skip: true } : {}), ...(more || skipping ? { more: true } : {}) };
  }

  private eventsFor(name: string, after: number | undefined): { events: LogEvent[]; ev: number } {
    let rows: LogEventRow[] = [];
    try { rows = this.deps.events(name, LOG_EVENTS_LIMIT); } catch { rows = []; }
    const ev = rows.reduce((m, r) => Math.max(m, r.id), after ?? 0);
    const events = rows
      .filter(r => (after === undefined || r.id > after) && LOG_EVENT_TYPES.has(r.event_type))
      .map(r => {
        // M-2269: a dialog's screen text is its own field, masked again here, never folded into the JSON detail.
        const rawScreen = r.payload && typeof r.payload === "object" ? (r.payload as Record<string, unknown>).screen : undefined;
        const screen = typeof rawScreen === "string" && rawScreen ? bounded(rawScreen, SCREEN_MAX_BYTES).text : undefined;
        const detail = r.payload && typeof r.payload === "object"
          ? (() => {
            const { screen: _screen, ...p } = r.payload as Record<string, unknown>;
            // When the payload is only (or includes) a `message`, show that text rather than raw JSON.
            if (typeof p.message === "string" && p.message) return bounded(p.message, 300).text;
            const keys = Object.keys(p);
            return keys.length ? bounded(JSON.stringify(p), 300).text : undefined;
          })()
          : undefined;
        return { id: r.id, ts: dbTime(r.created_at), type: r.event_type, ...(detail ? { detail } : {}), ...(screen ? { screen } : {}) };
      })
      .reverse();
    return { events, ev };
  }

  /** Hold (or renew) the watch on `name`: its transcript's size is looked at while the lease lasts. */
  private watch(name: string, path: string, size: number, ino: number): void {
    const until = this.now() + WATCH_LEASE_MS;
    const held = this.watches.get(name);
    if (held && held.path === path) { held.until = until; return; }
    if (held) this.unwatch(name);
    const setI = this.deps.setInterval ?? ((fn: () => void, ms: number) => { const t = setInterval(fn, ms); (t as { unref?: () => void }).unref?.(); return t; });
    const w = { until, path, size, ino, timer: null as unknown };
    w.timer = setI(() => { void this.look(name); }, WATCH_POLL_MS);
    this.watches.set(name, w);
  }

  private async look(name: string): Promise<void> {
    const w = this.watches.get(name);
    if (!w) return;
    if (this.now() > w.until || !this.deps.enabled()) { this.unwatch(name); return; }
    let st: { size: number; ino: number };
    try { st = await stat(w.path); } catch { return; }
    if (this.watches.get(name) !== w) return;
    if (st.size !== w.size || st.ino !== w.ino) {
      w.size = st.size; w.ino = st.ino;
      this.deps.emit("steps_tick", { instance: name });
    }
  }

  private unwatch(name: string): void {
    const w = this.watches.get(name);
    if (!w) return;
    (this.deps.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>)))(w.timer);
    this.watches.delete(name);
  }

  /** Every watch ends (the Log was turned off, the fleet stops). */
  unwatchAll(): void {
    for (const name of [...this.watches.keys()]) this.unwatch(name);
    for (const name of [...this.liveWatches.keys()]) this.stopLive(name);
  }

  /** How many instances are watched now (for tests and diagnostics). */
  watched(): number { return this.watches.size + this.liveWatches.size; }
}

/** The newest steps whose JSON fits LOG_RESPONSE_MAX_BYTES (each step is already bounded; this bounds their number). */
function fitBytes(steps: LogStep[]): LogStep[] {
  let total = 0, i = steps.length;
  while (i > 0) {
    const size = JSON.stringify(steps[i - 1]).length + 1;
    if (total + size > LOG_RESPONSE_MAX_BYTES) break;
    total += size; i--;
  }
  return steps.slice(i);
}
