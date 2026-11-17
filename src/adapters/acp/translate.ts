import type { AdapterEvent } from "../types.js";

type ToolStatus = "pending" | "in_progress" | "completed" | "failed";
const RANK: Record<ToolStatus, number> = { pending: 0, in_progress: 1, completed: 2, failed: 2 };

interface ToolState { title: string; toolKind: string; status: ToolStatus; rawInput?: unknown; rawOutput?: unknown }

const asObject = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null);

/**
 * agy (1.5.x) tells the model — and the ACP client, as an `agent_message_chunk` with nothing else on it — that a tool call it wrote was not a call:
 * "\n⚠ Your previous response contained an improperly formatted function call: Malformed function call: … Please retry with a properly formatted
 * function call\nRetries remaining: 3\n". It is not something the agent said, and agy has already retried it.
 */
const MALFORMED_CALL = /^\s*(?:⚠\s*)?Your previous response contained an improperly formatted function call/;
/**
 * Where it ends: agy's closing request, with the "Retries …" line that follows it when that is there too (so a different wording of that
 * line, or the line in a chunk of its own, does not leave the notice open); or, failing that sentence, the "Retries remaining: N" line.
 */
const MALFORMED_END_REQUEST = /Please retry with a properly formatted function call[^\n]*(?:\r?\n|$)(?:[ \t]*Retries[^\n]*(?:\r?\n|$))?/;
const MALFORMED_END_COUNT = /Retries remaining:\s*\d+[ \t]*\r?\n?/;
/** The "Retries …" line when it comes alone, after a chunk that ended at the request. */
const MALFORMED_TRAILER = /^\s*Retries[^\n]*\s*$/;
/** The most an unfinished notice takes: agy's own is about 1.5 KB in one or two chunks. */
const NOTICE_MAX_CHARS = 4000;
const NOTICE_MAX_CHUNKS = 20;

function textOf(content: unknown): string {
  const c = asObject(content);
  return c && c.type === "text" && typeof c.text === "string" ? c.text : "";
}

function normalizeStatus(v: unknown): ToolStatus | undefined {
  if (typeof v !== "string") return undefined;
  switch (v.toLowerCase()) {
    case "pending": return "pending";
    case "in_progress": case "inprogress": case "running": return "in_progress";
    case "completed": case "complete": case "done": return "completed";
    case "failed": case "error": return "failed";
    default: return undefined;
  }
}

/**
 * Turns `session/update` notifications into `AdapterEvent`s. Stateful only for tool calls: a `tool_call_update` may
 * arrive before its `tool_call`, a later update may carry only the fields that changed, and a stale update must not
 * move a finished call back to running — so the translator keeps one merged record per tool call id.
 */
export class UpdateTranslator {
  private readonly tools = new Map<string, ToolState>();
  /** Inside an agy notice whose last chunk has not come (it ends with "Retries remaining: N"). */
  private noticeOpen = false;
  /** What the open notice has taken so far (a notice whose ending never comes must not take the agent's answer with it). */
  private noticeChars = 0;
  private noticeChunks = 0;
  /** The last chunk ended at agy's closing request: a lone "Retries …" line may still follow, and is the notice's. */
  private noticeTrailer = false;

  /** A new prompt: the tool records and any unfinished notice end here. */
  reset(): void { this.tools.clear(); this.closeNotice(); }
  private closeNotice(): void { this.noticeOpen = false; this.noticeChars = 0; this.noticeChunks = 0; this.noticeTrailer = false; }

  /** `update` is the `update` member of `session/update` params. Unknown update kinds yield nothing. */
  translate(update: unknown): AdapterEvent[] {
    const u = asObject(update);
    // Anything but the notice's own message chunks ends one that was never finished.
    if ((this.noticeOpen || this.noticeTrailer) && u?.sessionUpdate !== "agent_message_chunk") this.closeNotice();
    if (!u || typeof u.sessionUpdate !== "string") return [];
    switch (u.sessionUpdate) {
      case "agent_thought_chunk": { const text = textOf(u.content); return text ? [{ kind: "thought", text }] : []; }
      case "agent_message_chunk": {
        const text = textOf(u.content);
        if (!text) return [];
        // agy reports its own retry of a malformed tool call as message text (no marker on the update: only its words tell it apart).
        // An unfinished notice takes the chunks that follow only up to a bound: agy may word its ending otherwise one day, and a
        // notice that never ends must not swallow the agent's answer.
        if (this.noticeOpen && (this.noticeChars + text.length > NOTICE_MAX_CHARS || this.noticeChunks >= NOTICE_MAX_CHUNKS)) this.closeNotice();
        if (this.noticeTrailer) {
          this.noticeTrailer = false;
          if (MALFORMED_TRAILER.test(text)) return [{ kind: "notice", code: "malformed_call", text, more: true }];
        }
        const starts = !this.noticeOpen && MALFORMED_CALL.test(text);
        if (starts || this.noticeOpen) {
          const more = this.noticeOpen;
          // The ending sentence closes it, wherever in the chunk it is: what is before it (and the sentence) is the notice, what follows is said.
          const end = MALFORMED_END_REQUEST.exec(text) ?? MALFORMED_END_COUNT.exec(text);
          const cut = end ? end.index + end[0].length : text.length;
          const notice = text.slice(0, cut), rest = text.slice(cut);
          if (end) {
            this.closeNotice();
            this.noticeTrailer = !rest.trim() && !/Retries/.test(end[0]) && MALFORMED_END_REQUEST.test(end[0]);    // it ended at the request: a lone "Retries …" line may come
          } else { this.noticeOpen = true; this.noticeChars += text.length; this.noticeChunks++; }
          const events: AdapterEvent[] = [{ kind: "notice", code: "malformed_call", text: notice, ...(more ? { more: true } : {}) }];
          if (rest.trim()) events.push({ kind: "message", text: rest.replace(/^\s+/, "") });
          return events;
        }
        return [{ kind: "message", text }];
      }
      case "user_message_chunk": { const text = textOf(u.content); return text ? [{ kind: "user", text }] : []; }
      case "tool_call": case "tool_call_update": return this.tool(u, u.sessionUpdate === "tool_call");
      case "plan": return [{ kind: "plan", entries: Array.isArray(u.entries) ? u.entries : [] }];
      case "usage_update": {
        const used = typeof u.used === "number" ? u.used : undefined;
        const size = typeof u.size === "number" ? u.size : undefined;
        return used === undefined && size === undefined ? [] : [{ kind: "usage", ...(used !== undefined ? { used } : {}), ...(size !== undefined ? { size } : {}) }];
      }
      default: return [];
    }
  }

  /**
   * grok's own notification (`_x.ai/session_notification`, not part of ACP): each model call ends with a `response_completed` carrying
   * that call's token counts. The context in use is the size of the prompt it sent: the tokens it paid for plus the ones read from the
   * cache (measured on grok 1.0.77: input 14877 + cache read 2176 = the 17053 the turn's own usage reports as its input).
   */
  translateGrokNotification(params: unknown): AdapterEvent[] {
    const update = asObject(asObject(params)?.update);
    if (update?.sessionUpdate !== "response_completed") return [];
    const usage = asObject(update.usage);
    if (!usage) return [];
    const n = (k: string): number => (typeof usage[k] === "number" && Number.isFinite(usage[k]) && (usage[k] as number) >= 0 ? usage[k] as number : 0);
    const used = n("input_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens");
    return used > 0 ? [{ kind: "usage", used }] : [];
  }

  private tool(u: Record<string, unknown>, first: boolean): AdapterEvent[] {
    const id = typeof u.toolCallId === "string" ? u.toolCallId : null;
    if (!id) return [];
    const meta = asObject(asObject(u._meta)?.["x.ai/tool"]);
    const prev = this.tools.get(id);
    const incoming = normalizeStatus(u.status) ?? (first ? "pending" : undefined);
    let status: ToolStatus = incoming ?? prev?.status ?? "pending";
    if (prev && RANK[status] < RANK[prev.status]) status = prev.status; // never backwards
    const title = typeof u.title === "string" && u.title ? u.title : prev?.title ?? (typeof u.name === "string" ? u.name : "tool");
    const kindRaw = typeof u.kind === "string" ? u.kind : typeof meta?.kind === "string" ? meta.kind : undefined;
    // grok's first `tool_call` has no kind and its update names it ("edit"); keep the more specific one.
    const toolKind = kindRaw && kindRaw !== "other" ? kindRaw : prev?.toolKind ?? kindRaw ?? "other";
    const rawInput = u.rawInput !== undefined ? u.rawInput : u.args !== undefined ? u.args : prev?.rawInput;
    const rawOutput = u.rawOutput !== undefined ? u.rawOutput : prev?.rawOutput;
    const next: ToolState = { title, toolKind, status, ...(rawInput !== undefined ? { rawInput } : {}), ...(rawOutput !== undefined ? { rawOutput } : {}) };
    this.tools.set(id, next);
    if (this.tools.size > 500) this.tools.delete(this.tools.keys().next().value as string);
    return [{ kind: "tool", id, ...next }];
  }
}
