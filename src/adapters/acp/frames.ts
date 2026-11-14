import { StringDecoder } from "node:string_decoder";

/** The longest line accepted from the child. Longer lines are dropped whole (and counted), never buffered. */
export const MAX_LINE_BYTES = 8 * 1024 * 1024;

export interface FramerOptions {
  readonly maxLineBytes?: number;
  /** Called once per dropped over-long line, with the number of bytes it had when it was cut off. */
  readonly onOverflow?: (bytes: number) => void;
}

/**
 * Newline-delimited framing for a byte stream: a line may arrive in any number of pieces, several lines may arrive in
 * one piece, and a multi-byte character may be cut between pieces. Input from the child is untrusted, so a line over
 * the limit is discarded up to its newline instead of being held in memory.
 */
export class LineFramer {
  private readonly decoder = new StringDecoder("utf8");
  private readonly max: number;
  private buffer = "";
  private bufferBytes = 0;
  private discarding = false;
  private discardedBytes = 0;

  constructor(private readonly opts: FramerOptions = {}) {
    this.max = opts.maxLineBytes ?? MAX_LINE_BYTES;
  }

  /** Feed a piece; returns the complete, non-empty lines it finished (without their newline). */
  push(chunk: Buffer | string): string[] {
    const text = typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    const lines: string[] = [];
    let start = 0;
    for (;;) {
      const nl = text.indexOf("\n", start);
      const end = nl === -1 ? text.length : nl;
      const piece = text.slice(start, end);
      const pieceBytes = Buffer.byteLength(piece);
      if (this.discarding) {
        this.discardedBytes += pieceBytes;
      } else if (this.bufferBytes + pieceBytes > this.max) {
        this.discarding = true;
        this.discardedBytes = this.bufferBytes + pieceBytes;
        this.buffer = ""; this.bufferBytes = 0;
      } else {
        this.buffer += piece; this.bufferBytes += pieceBytes;
      }
      if (nl === -1) break;
      if (this.discarding) {
        this.opts.onOverflow?.(this.discardedBytes);
        this.discarding = false; this.discardedBytes = 0;
      } else {
        const line = this.buffer.endsWith("\r") ? this.buffer.slice(0, -1) : this.buffer;
        if (line.trim() !== "") lines.push(line);
      }
      this.buffer = ""; this.bufferBytes = 0;
      start = nl + 1;
    }
    return lines;
  }
}

export type JsonRpcId = string | number;

export type Frame =
  | { kind: "request"; id: JsonRpcId; method: string; params: unknown }
  | { kind: "notification"; method: string; params: unknown }
  | { kind: "response"; id: JsonRpcId; result: unknown }
  | { kind: "error"; id: JsonRpcId | null; code: number; message: string; data?: unknown }
  | { kind: "invalid"; reason: string };

const isId = (v: unknown): v is JsonRpcId => typeof v === "string" || (typeof v === "number" && Number.isFinite(v));

/** Classify one line. Never throws: anything that is not a well-formed JSON-RPC 2.0 message is `invalid`. */
export function decodeFrame(line: string): Frame {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return { kind: "invalid", reason: "not JSON" }; }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { kind: "invalid", reason: "not an object" };
  const m = value as Record<string, unknown>;
  const hasId = Object.hasOwn(m, "id") && m.id !== null;
  if (typeof m.method === "string") {
    if (hasId) {
      // id 0 is a valid id; only a missing, null or non-scalar id makes the request unanswerable.
      return isId(m.id) ? { kind: "request", id: m.id, method: m.method, params: m.params } : { kind: "invalid", reason: "request with an unusable id" };
    }
    return { kind: "notification", method: m.method, params: m.params };
  }
  if (Object.hasOwn(m, "error") && m.error && typeof m.error === "object") {
    const e = m.error as Record<string, unknown>;
    return { kind: "error", id: isId(m.id) ? m.id : null, code: typeof e.code === "number" ? e.code : -32603, message: typeof e.message === "string" ? e.message : "error", data: e.data };
  }
  if (Object.hasOwn(m, "result") && isId(m.id)) return { kind: "response", id: m.id, result: m.result };
  return { kind: "invalid", reason: "neither a request, a notification nor a response" };
}
