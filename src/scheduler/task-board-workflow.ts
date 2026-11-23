/**
 * The task board's workflow: the statuses a board shows, with the name, colour and order each has (AGEND-332, PR 1 of the
 * custom-status design). A workflow belongs to a project; a project without one uses the default workflow, and the
 * default is the code constant below until somebody edits it — so a database with no workflow rows (every existing one)
 * reads exactly as before, and an upgrade writes nothing.
 *
 * What a workflow can change here is how the six built-in statuses LOOK: their names, colours, order and whether an empty
 * column is hidden. Which card may move where, who is woken, what a move needs written, the statistics, the
 * dependencies — all of it keeps reading `tasks.status`, one of the six, and nothing in this file touches it. The
 * status list itself (add / delete a status, a category per status) is a later step; the table already has the
 * `category` column it will need, and in this step it always equals the key.
 */
import type { CardStatus } from "./task-board.js";

/**
 * The six statuses. A copy of task-board.ts's CARD_STATUSES (a test pins that they are the same): this file is imported by
 * task-board.ts, and a runtime import back would read the constant before it exists.
 */
const CARD_STATUSES: readonly CardStatus[] = ["open", "claimed", "blocked", "review", "done", "cancelled"];

/** The palette: names, not hex values — the page's CSP allows no style attribute, so each name is a class that reads a theme token. */
export const WORKFLOW_COLORS = ["gray", "blue", "green", "yellow", "red"] as const;
export type WorkflowColor = (typeof WORKFLOW_COLORS)[number];

/** Limits in characters (code points). A workflow keeps at most 12 statuses; the text limits are small because an agent will read them. */
export const WORKFLOW_LIMITS = { statuses: 12, name: 40, description: 300, instructions: 600 } as const;

export interface WorkflowStatus {
  /** One of the six built-in statuses. Immutable. */
  key: CardStatus;
  /** What the board calls it; "" is the built-in word (in the page's language). */
  name: string;
  /** What it means in this project, for a reader's tooltip (and, later, for an agent). */
  description: string;
  color: WorkflowColor;
  /** Hide the column while no card is in it (it shows again when one arrives). Only some statuses may. */
  hideEmpty: boolean;
}

/** The colours the board has always drawn: to do and cancelled neutral, in progress the accent, blocked danger, to confirm warn, done ok. */
export const DEFAULT_COLORS: Readonly<Record<CardStatus, WorkflowColor>> = {
  open: "gray", claimed: "blue", blocked: "red", review: "yellow", done: "green", cancelled: "gray",
};

/** The statuses whose column may be hidden while empty. To do and In progress are the way a card moves through, so they stay. */
export const HIDEABLE: ReadonlySet<CardStatus> = new Set<CardStatus>(["blocked", "review", "done"]);

/** The built-in workflow: today's six statuses, in today's order, with today's words and colours. */
export const DEFAULT_WORKFLOW: ReadonlyArray<Readonly<WorkflowStatus>> = Object.freeze(
  CARD_STATUSES.map((key) => Object.freeze({ key, name: "", description: "", color: DEFAULT_COLORS[key], hideEmpty: false })),
);

export const cloneStatuses = (list: ReadonlyArray<Readonly<WorkflowStatus>>): WorkflowStatus[] => list.map((s) => ({ ...s }));

/** A refusal of a workflow's input; the board turns it into its own error (a code and the page's sentence). */
export class WorkflowInputError extends Error {
  constructor(message: string, readonly key: string, readonly args: Array<string | number> = []) {
    super(message);
  }
}

const length = (s: string): number => [...s].length;

function text(field: string, key: string, value: unknown, max: number): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new WorkflowInputError(`${field} must be text`, "workflow_invalid");
  // eslint-disable-next-line no-control-regex
  const v = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
  if (length(v) > max) throw new WorkflowInputError(`${field} is too long: ${length(v)} characters, at most ${max}`, "too_long", [key, length(v), max]);
  return v;
}

/**
 * What a person sends for a workflow, checked: every built-in status exactly once, in the order they want, each with a
 * name (or "" for the built-in word), a description, a colour from the palette and whether its empty column hides.
 * Throws WorkflowInputError. Pure: the tests call it.
 */
export function checkWorkflow(input: unknown): WorkflowStatus[] {
  if (!Array.isArray(input)) throw new WorkflowInputError("a workflow is a list of statuses", "workflow_invalid");
  if (input.length > WORKFLOW_LIMITS.statuses) throw new WorkflowInputError(`a workflow has at most ${WORKFLOW_LIMITS.statuses} statuses`, "workflow_max", [WORKFLOW_LIMITS.statuses]);
  const seen = new Set<string>();
  const names = new Set<string>();
  const out: WorkflowStatus[] = [];
  for (const raw of input) {
    const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const key = s.key as CardStatus;
    if (!CARD_STATUSES.includes(key)) throw new WorkflowInputError(`unknown status "${String(s.key).slice(0, 40)}": the statuses are ${CARD_STATUSES.join(", ")}`, "workflow_status_unknown", [String(s.key).slice(0, 40)]);
    if (seen.has(key)) throw new WorkflowInputError(`status "${key}" is listed twice`, "workflow_status_twice", [key]);
    seen.add(key);
    const name = text("the name", "name", s.name, WORKFLOW_LIMITS.name);
    const description = text("the description", "description", s.description, WORKFLOW_LIMITS.description);
    const color = s.color === undefined || s.color === null ? DEFAULT_COLORS[key] : s.color as WorkflowColor;
    if (!WORKFLOW_COLORS.includes(color)) throw new WorkflowInputError(`colour "${String(s.color).slice(0, 20)}" is not in the palette: ${WORKFLOW_COLORS.join(", ")}`, "workflow_color", [String(s.color).slice(0, 20)]);
    const hideEmpty = s.hideEmpty === true;
    if (hideEmpty && !HIDEABLE.has(key)) throw new WorkflowInputError(`the column "${key}" cannot be hidden`, "workflow_not_hideable", [key]);
    // Two statuses with one name could not be told apart on the board.
    const folded = name.toLocaleLowerCase();
    if (name && names.has(folded)) throw new WorkflowInputError(`two statuses are named "${name}"`, "workflow_name_twice", [name]);
    if (name) names.add(folded);
    out.push({ key, name, description, color, hideEmpty });
  }
  const missing = CARD_STATUSES.filter((k) => !seen.has(k));
  if (missing.length) throw new WorkflowInputError(`a workflow lists every status; missing: ${missing.join(", ")}`, "workflow_status_missing", [missing.join(", ")]);
  return out;
}

/**
 * A stored workflow read back, forgiving: a row of a status this release does not know is left out, a colour it does not
 * know falls back to the status's own, and a status the rows lack is put after the others in its built-in place — so a
 * file edited by another release never makes the board unreadable.
 */
export function readWorkflow(rows: Array<{ key: string; name: string; description: string; color: string; sort: number; hide_empty: number }>): WorkflowStatus[] {
  const out: WorkflowStatus[] = [];
  for (const r of [...rows].sort((a, b) => a.sort - b.sort)) {
    const key = r.key as CardStatus;
    if (!CARD_STATUSES.includes(key) || out.some((s) => s.key === key)) continue;
    const color = WORKFLOW_COLORS.includes(r.color as WorkflowColor) ? r.color as WorkflowColor : DEFAULT_COLORS[key];
    out.push({
      key,
      name: [...String(r.name ?? "")].slice(0, WORKFLOW_LIMITS.name).join(""),
      description: [...String(r.description ?? "")].slice(0, WORKFLOW_LIMITS.description).join(""),
      color,
      hideEmpty: Number(r.hide_empty) === 1 && HIDEABLE.has(key),
    });
  }
  for (const d of DEFAULT_WORKFLOW) if (!out.some((s) => s.key === d.key)) out.push({ ...d });
  return out;
}
