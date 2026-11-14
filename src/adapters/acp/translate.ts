import type { AdapterEvent } from "../types.js";

type ToolStatus = "pending" | "in_progress" | "completed" | "failed";
const RANK: Record<ToolStatus, number> = { pending: 0, in_progress: 1, completed: 2, failed: 2 };

interface ToolState { title: string; toolKind: string; status: ToolStatus; rawInput?: unknown; rawOutput?: unknown }

const asObject = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null);

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

  reset(): void { this.tools.clear(); }

  /** `update` is the `update` member of `session/update` params. Unknown update kinds yield nothing. */
  translate(update: unknown): AdapterEvent[] {
    const u = asObject(update);
    if (!u || typeof u.sessionUpdate !== "string") return [];
    switch (u.sessionUpdate) {
      case "agent_thought_chunk": { const text = textOf(u.content); return text ? [{ kind: "thought", text }] : []; }
      case "agent_message_chunk": { const text = textOf(u.content); return text ? [{ kind: "message", text }] : []; }
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
