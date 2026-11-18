// A card's activity (Fleet › Tasks › a card's page), as Multica draws an issue's: the comments, the progress log and the
// history are one timeline, oldest first, with the comment box under it. The card API still returns the three lists
// apart (comments, logs, history); they are merged here, so nothing on the server changes. A history line that only
// repeats a comment or a log entry ("commented", "logged") is dropped from the merge — the entry itself is shown.
// The comment box completes `@` with the fleet's instance names: it only types `@<instance name>` into the text; what an
// @ does to that instance is the board's business (it reads the same plain text), not this box's.
// No style attribute anywhere (the CSP).
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { t } from "/assets/app-i18n.js";
import { Icon } from "/assets/ui-icons.js";
import { Who, relTime } from "./fleet-task-common.js";
import { AgentTag } from "./fleet-task-run.js";

export const TIMELINE_FILTERS = ["all", "comments", "log", "history"];
const RANK = { event: 0, log: 1, comment: 2 };   // at one instant: the move first, then the words that came with it

const when = (iso) => { const n = Date.parse(iso); return Number.isFinite(n) ? n : 0; };

/**
 * The card detail's three lists as one timeline, oldest first (pure: tests import it). Each entry:
 * { key, type: "comment" | "log" | "event", at, who, by, text?, kind?, authorKind?, ev? } — `ev` is the history event;
 * `by` is who made it (person | instance | script | system) when the server said, else "" (an older entry): an instance's is
 * marked in the timeline (AGEND-296).
 */
export function timelineOf(detail) {
  const out = [];
  for (const e of (detail && detail.comments) || []) out.push({ key: `c${e.id}`, type: "comment", at: e.at, who: e.author, by: e.authorKind || "", text: e.text, kind: e.kind, authorKind: e.authorKind });
  for (const e of (detail && detail.logs) || []) out.push({ key: `l${e.id}`, type: "log", at: e.at, who: e.author, by: e.authorKind || "", text: e.text });
  for (const ev of (detail && detail.history) || []) {
    if (ev.type === "commented" || ev.type === "logged" || ev.type === "reordered") continue;
    out.push({ key: `h${ev.id}`, type: "event", at: ev.at, who: ev.actor, by: ev.actorKind || "", ev });
  }
  return out.map((e, i) => ({ e, i })).sort((a, b) => when(a.e.at) - when(b.e.at) || RANK[a.e.type] - RANK[b.e.type] || a.i - b.i).map((x) => x.e);
}

/** The entries a filter shows: everything, or one kind of them. */
export function timelineShown(entries, filter) {
  const type = { comments: "comment", log: "log", history: "event" }[filter];
  return type ? entries.filter((e) => e.type === type) : entries;
}

// ── Completing an @ ───────────────────────────────────────

/** The characters a name being typed is made of (an instance's name may be CJK, so letters of any script). */
const NAME_CHAR = /[\p{L}\p{N}_.\-]/u;
/**
 * What may not stand right before an `@` for it to be a mention: an address (`me@host`), a path (`a/@x`, `C:\@x`), a
 * doubled `@`. The board's own rule (task-board-mentions.ts, NOT_BEFORE) — ASCII only, so a letter of another script
 * before the `@` ("請@lead") is fine there and here.
 */
const NOT_BEFORE = /[A-Za-z0-9_.@/\\-]/;

/**
 * The text with fenced blocks and inline code blanked, as the board reads a comment (task-board-mentions.ts, withoutCode):
 * an `@name` in code names an instance without waking it. A fence not closed runs to the end of the text; inline code
 * is between two backticks on one line.
 */
export function withoutCode(text) {
  const blank = (s) => s.replace(/[^\n]/g, " ");
  return String(text).replace(/```[\s\S]*?(?:```|$)/g, blank).replace(/`[^`\n]*`/g, blank);
}

/**
 * The `@name` being typed at the caret, or null — null wherever the board would not read the name as a mention, so the
 * list is never offered for a name that would wake nobody: the "@" must start the text or follow something that is not
 * in NOT_BEFORE, and must not be in code (inline or fenced). Then the name's characters up to the caret.
 * { start: where the "@" is, query: the characters after it }.
 */
export function mentionAt(text, caret) {
  const s = String(text);
  let i = Math.min(Math.max(0, caret), s.length);
  while (i > 0 && NAME_CHAR.test(s[i - 1])) i--;
  if (i === 0 || s[i - 1] !== "@") return null;
  const start = i - 1;
  const read = withoutCode(s);
  if (read[start] !== "@") return null;
  if (start > 0 && NOT_BEFORE.test(read[start - 1])) return null;
  return { start, query: s.slice(i, caret) };
}

/** The names that complete a query: those starting with it first, then those containing it; case does not matter. */
export function mentionMatches(names, query, limit = 8) {
  const q = query.toLocaleLowerCase();
  const lower = (n) => n.toLocaleLowerCase();
  const starts = names.filter((n) => lower(n).startsWith(q));
  const inside = names.filter((n) => !lower(n).startsWith(q) && lower(n).includes(q));
  return [...starts, ...inside].slice(0, limit);
}

/**
 * The text with the `@query` at `m` replaced by `@name ` (one space after, unless one is already there), and where the
 * caret goes. The board reads the longest instance name that fits, so when the text after the caret would run the name
 * on into a longer one (`@a` before " b", with an instance `a b` too — `names`: the fleet's), a space of its own is
 * put in: the name typed is the name read.
 */
export function insertMention(text, m, caret, name, names = []) {
  const s = String(text);
  const after = s.slice(caret);
  const lower = name.toLowerCase(), tail = after.toLowerCase();
  const runsOn = names.some((n) => n.length > name.length && n.toLowerCase().startsWith(lower) && tail.startsWith(n.toLowerCase().slice(name.length)));
  const spaced = after.startsWith(" ") && !runsOn;
  const head = `${s.slice(0, m.start)}@${name}${after.startsWith("\n") || spaced ? "" : " "}`;
  return { text: head + after, caret: head.length + (spaced ? 1 : 0) };
}

// ── The timeline ──────────────────────────────────────────

const fullTime = (iso) => { const d = new Date(iso); return Number.isFinite(d.getTime()) ? d.toLocaleString() : ""; };

function Entry({ entry, describe }) {
  const time = html`<time class="muted tl-time" dateTime=${entry.at} title=${fullTime(entry.at)}>${relTime(entry.at)}</time>`;
  const agent = entry.by === "instance";
  const mark = agent ? " by-agent lbar" : "";   // the shared straight bar (app.css `.lbar`), as the app draws a coloured left edge
  if (entry.type === "comment") {
    return html`<li class=${`tl-item tl-comment${entry.authorKind === "person" ? " person" : ""}${mark}`}>
      <div class="tl-head"><${Who} name=${entry.who} />${agent ? html`<${AgentTag} />` : null}
        ${entry.kind === "reject" ? html`<span class="tb-tag st-blocked">${t("taskcard.rejectTag")}</span>` : null}
        ${entry.kind === "approve" ? html`<span class="tb-tag st-done">${t("taskcard.approveTag")}</span>` : null}
        ${time}</div>
      <div class="tl-body">${entry.text}</div></li>`;
  }
  if (entry.type === "log") {
    return html`<li class=${`tl-item tl-line tl-log${mark}`}><${Icon} name="check" size=${14} /><span class="tl-text"><b>${entry.who}</b>${agent ? html` <${AgentTag} />` : null} ${entry.text}</span>${time}</li>`;
  }
  return html`<li class=${`tl-item tl-line tl-event${mark}`}><span class="tb-dot" aria-hidden="true"></span><span class="tl-text"><b>${entry.who}</b>${agent ? html` <${AgentTag} />` : null} ${describe(entry.ev)}</span>${time}</li>`;
}

/** The merged timeline with its filter (all, comments, progress log, history). `describe(ev)` words a history event. */
export function Timeline({ detail, describe }) {
  const [filter, setFilter] = useState("all");
  const all = timelineOf(detail);
  const count = (f) => timelineShown(all, f).length;
  const shown = timelineShown(all, filter);
  return html`<section class="tl" aria-label=${t("taskcard.activity")}>
    <div class="tl-bar"><h3>${t("taskcard.activity")}</h3>
      <div class="tb-seg tl-filter" role="group" aria-label=${t("taskcard.activityShow")}>${TIMELINE_FILTERS.map((f) =>
        html`<button key=${f} type="button" aria-pressed=${filter === f ? "true" : "false"} class=${`tb-seg-btn${filter === f ? " active" : ""}`} onClick=${() => setFilter(f)}>${t(`taskcard.show.${f}`)}${f === "all" ? "" : ` ${count(f)}`}</button>`)}</div></div>
    ${shown.length ? html`<ol class="tl-list">${shown.map((e) => html`<${Entry} key=${e.key} entry=${e} describe=${describe} />`)}</ol>`
      : html`<p class="muted tl-none">${t(all.length ? "taskcard.nothingHere" : "taskcard.noActivity")}</p>`}
  </section>`;
}

// ── The comment box ───────────────────────────────────────

/**
 * The comment box: Ctrl+Enter or Send posts it; typing `@` offers the instance names (arrows and Enter or Tab choose, Esc
 * closes the list, not the box). `names`: [{ name, off }] — an instance with the task board off is listed, not choosable.
 * `onSend(text)` resolves "ok" for the text to clear.
 */
export function Composer({ placeholder, names, onSend }) {
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [hidden, setHidden] = useState(false);
  const [active, setActive] = useState(0);
  const [sending, setSending] = useState(false);
  const busy = useRef(false);
  const box = useRef(null);
  const pending = useRef(null);   // where the caret goes once the inserted name is in the box
  const m = hidden ? null : mentionAt(text, caret);
  const found = m ? mentionMatches(names.map((n) => n.name), m.query).map((n) => names.find((x) => x.name === n)) : [];
  const open = found.length > 0;
  useEffect(() => { setActive(0); }, [m ? m.query : null, open]);
  useEffect(() => {
    if (pending.current === null || !box.current) return;
    const c = pending.current;
    pending.current = null;
    try { box.current.focus(); box.current.setSelectionRange(c, c); } catch { /* no selection API */ }
  });
  const note = (e) => setCaret(e.target.selectionStart ?? e.target.value.length);
  function choose(item) {
    if (!item || item.off || !m) return;
    const r = insertMention(text, m, caret, item.name, names.map((n) => n.name));
    pending.current = r.caret;
    setText(r.text);
    setCaret(r.caret);
  }
  async function send() {
    if (!text.trim() || busy.current) return;
    busy.current = true;
    setSending(true);
    try { if ((await onSend(text.trim())) === "ok") { setText(""); setCaret(0); } } finally { setSending(false); busy.current = false; }
  }
  function onKey(e) {
    if (open && (e.key === "ArrowDown" || e.key === "ArrowUp")) { e.preventDefault(); setActive((i) => (i + (e.key === "ArrowDown" ? 1 : found.length - 1)) % found.length); return; }
    if (open && (e.key === "Enter" || e.key === "Tab") && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.isComposing) {
      if (found[active] && !found[active].off) { e.preventDefault(); choose(found[active]); return; }
    }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (open) setHidden(true); else e.currentTarget.blur(); return; }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(); }
  }
  return html`<div class="tc-composer">
    <div class="tc-compose-box">
      ${open ? html`<ul class="tc-mentions" role="listbox" aria-label=${t("taskcard.mentionList")}>${found.map((n, i) => html`<li key=${n.name} role="option" aria-selected=${i === active ? "true" : "false"} class=${i === active ? "active" : ""}>
        <button type="button" tabindex="-1" disabled=${!!n.off} title=${n.off ? t("tasks.boardOffHint") : undefined}
          onPointerDown=${(e) => e.preventDefault()} onClick=${() => choose(n)}>
          <span class="tc-mention-name">@${n.name}</span>${n.off ? html`<span class="muted">${t("taskcard.boardOffShort")}</span>` : null}</button></li>`)}</ul>` : null}
      <textarea ref=${box} rows="3" value=${text} placeholder=${placeholder} aria-label=${t("taskcard.commentHint")}
        aria-autocomplete="list" aria-expanded=${open ? "true" : "false"}
        onInput=${(e) => { setText(e.target.value); setHidden(false); note(e); }} onClick=${note} onKeyUp=${(e) => { if (/^(Arrow|Home$|End$)/.test(String(e.key || ""))) note(e); }}
        onKeyDown=${onKey}></textarea>
    </div>
    <button type="button" class="btn btn-primary btn-sm" disabled=${sending || !text.trim()} onClick=${send}>${t("taskcard.send")}</button>
  </div>`;
}
