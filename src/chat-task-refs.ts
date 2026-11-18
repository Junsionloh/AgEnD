/**
 * Task cards referenced in a web chat message (AGEND-298).
 *
 * The person types `#` in the chat box, picks a card, and the box holds its number (`#M-3`; a main task is M-, a sub task
 * S-). A hand-typed `#M-3` / `#s3` is read the same way. Only the `#` form is a reference: a bare `M-3` is the word it
 * is (an upstream-style "M-3304" in a sentence must not pull in a card that happens to have that number). Nothing about a
 * reference is stored with the message: the text is the message, so an old chat and an older AgEnD both read it as text.
 *
 * Two readers use this file:
 *  - POST /ui/send: the cards a message names, read from the board now, go to the agent as a short block under the
 *    person's words (number, status, title, who has it, how to read the whole card) — so the agent does not have to guess.
 *    A number that is no card (never was, or since deleted) is left as the text it is: no error, no block for it. A number
 *    in code (an inline `code` span or a fenced block) or in a link's label is not a reference, as the page draws no chip there.
 *  - GET /ui/tasks/refs: the page draws the same numbers as chips (number, title, status) and offers cards while `#` is typed.
 *
 * Pure but for the board it is handed (reads only).
 */
import { cardCode, type Card, type TaskBoard } from "./scheduler/task-board.js";
import { cardLine, oneLine } from "./scheduler/task-board-text.js";

/** The most cards one message brings to the agent (more numbers than this are plain text). */
export const TASK_REF_MAX = 10;
/** The longest a card's title is made on the agent's line. */
const TITLE_MAX = 120;

/**
 * `#M-3` / `#s34`: a `#`, the letter (either case), an optional hyphen, the number. Not inside a longer word, a path or a URL
 * ("a#M-3", "/x/#M-3"), and not a decimal ("#M-3.5"). Only ASCII counts as "a longer word": a Chinese sentence runs straight
 * into a number ("看#M-3怎麼了"). A bare "M-3" is not a reference.
 */
const REF = /(?<![A-Za-z0-9_/&#@-])#([MmSs])-?(\d{1,9})(?![A-Za-z0-9_-]|\.\d)/g;

// What the page draws as code, a link or a URL it draws no chip in (shared/chat-render.js, the same order: fences, `code`,
// [label](url), bare URLs); so the agent is not handed a card for a number written there either.
const FENCE = /```([A-Za-z0-9_+.-]{0,32})[^\n]*\n([\s\S]*?)(?:```|$)/g;
const CJK = "\\u3000-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uac00-\\ud7af\\uf900-\\ufaff\\uff00-\\uffef";
const BARE_URL = new RegExp(`(^|[\\s(${CJK}])((?:https?:\\/\\/)[^\\s<${CJK}]+[^\\s<.,;:!?)\\]'"&${CJK}])`, "g");
const safeHref = (u: string) => /^(https?:\/\/|mailto:)[^\s]+$/i.test(u) && !/["'<>\u0000]/.test(u);

/** The text a person wrote as prose: without fenced code, `code` spans, the labels of links the page draws as links, and bare URLs. */
export function proseOf(text: string): string {
  return String(text ?? "").replace(/\r\n?/g, "\n").replace(/\u0000/g, "")
    .replace(FENCE, "\n")
    .replace(/`([^`\n]+)`/g, " ")
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, _label: string, url: string) => (safeHref(url) ? " " : m))
    .replace(BARE_URL, (_m, pre: string) => `${pre} `);
}

/** The card numbers a text names, normalised ("#s3" → "S-3"), each once, in order, at most `max`. */
export function taskRefCodes(text: string, max = TASK_REF_MAX): string[] {
  const out: string[] = [];
  if (typeof text !== "string" || !text) return out;
  for (const m of proseOf(text).matchAll(REF)) {
    const code = cardCode(`${m[1]}-${m[2]}`);
    if (code && !out.includes(code)) out.push(code);
    if (out.length >= max) break;
  }
  return out;
}

/** The board's cards for these numbers, in the order asked; a number with no card (or one `hidden` says to leave out) is skipped. */
export function cardsForRefs(board: Pick<TaskBoard, "cardsByCode">, codes: readonly string[], hidden?: (card: Card) => boolean): Card[] {
  if (!codes.length) return [];
  let found: Card[];
  try { found = board.cardsByCode([...codes]); } catch { return []; }   // a board that cannot be read is no reason to refuse the message
  const byCode = new Map(found.map((c) => [c.code, c]));
  return codes.flatMap((code) => { const c = byCode.get(code); return c && !(hidden && hidden(c)) ? [c] : []; });
}

/** What opens the block under the person's words. Tests and the native-runtime retry check read it. */
export const TASK_REF_HEADER = "[Task cards this message refers to]";
/** What sits between the person's words and the block. */
export const TASK_REF_SEPARATOR = `\n\n${TASK_REF_HEADER}`;

/**
 * The block for the agent, or "" when there is no card: one line a card — "M-3 [in progress] Build the login API @dev-a",
 * and "sub task of M-1" for a sub task ("sub task" alone when its main task is one `hidden` says to leave out) — then how to
 * read a whole card. `hint: false` leaves that out (a runtime with no `task` tool). Text only; a title is cut to one line.
 */
export function taskRefBlock(board: Pick<TaskBoard, "findCard">, cards: readonly Card[], opts: { hint?: boolean; hidden?: (card: Card) => boolean } = {}): string {
  if (!cards.length) return "";
  const lines = cards.map((c) => {
    const line = cardLine({ ...c, title: oneLine(c.title, TITLE_MAX) });
    if (c.kind === "main") return `${line} (main task)`;
    // A sub task whose main task is hidden over the public link does not name it.
    const main = c.parent ? board.findCard(c.parent) : undefined;
    return main && !(opts.hidden && opts.hidden(main)) ? `${line} (sub task of ${main.code})` : `${line} (sub task)`;
  });
  if (opts.hint !== false) lines.push(`Read a card in full with the task tool: task get ${cards[0]!.code} (or agend-agent task get ${cards[0]!.code} --detail).`);
  return `${TASK_REF_SEPARATOR}\n${lines.join("\n")}`;
}

/** A chip's data: what the page needs to draw a card without the whole card (GET /ui/tasks/refs). */
export interface TaskRefView {
  code: string;
  title: string;
  status: Card["status"];
  assignee: string | null;
  kind: Card["kind"];
}
export const taskRefView = (c: Card): TaskRefView => ({ code: c.code, title: oneLine(c.title, 200), status: c.status, assignee: c.assignee, kind: c.kind });
