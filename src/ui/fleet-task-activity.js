// A card's activity (Fleet › Tasks › a card's page), as Multica draws an issue's: the comments, the progress log and the
// history are one timeline, oldest first, with the comment box under it. The card API still returns the three lists
// apart (comments, logs, history); they are merged here, so nothing on the server changes. A history line that only
// repeats a comment or a log entry ("commented", "logged") is dropped from the merge — the entry itself is shown. The one
// "logged" line with no entry of its own, a change of the card's watchers (`data.watchers`), stays as a history line.
// The comment box completes `@` with the fleet's instance names: it only types `@<instance name>` into the text; what an
// @ does to that instance is the board's business (it reads the same plain text), not this box's.
// No style attribute anywhere (the CSP).
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { t } from "/assets/app-i18n.js";
import { Icon } from "/assets/ui-icons.js";
import { Who, relTime } from "./fleet-task-common.js";
import { AgentTag } from "./fleet-task-run.js";
import { insertAtTrigger, triggerAt, withoutCode } from "./trigger-complete.js";

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
    if (ev.type === "commented" || ev.type === "reordered") continue;
    if (ev.type === "logged" && !(ev.data && ev.data.watchers)) continue;   // a log entry is shown as itself; a watcher change has none (the board writes the event only)
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

// The word at the caret and its replacement are the shared trigger-complete.js's, with the trigger "@" (AGEND-305): the list
// is offered only where the board would read the name as a mention (task-board-mentions.ts), and what is typed in is read
// back as that instance. withoutCode is the board's own, re-exported for the tests.
export { withoutCode };

/** The `@name` being typed at the caret, or null: { start: where the "@" is, query: the characters after it }. */
export const mentionAt = (text, caret) => triggerAt(text, caret, "@");

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
 * caret goes. `names`: the fleet's — the board reads the longest instance name that fits, so a name that the text after the
 * caret would run on into a longer one gets a space of its own.
 */
export const insertMention = (text, m, caret, name, names = []) => insertAtTrigger(text, m, caret, "@", name, names);

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
    return html`<li class=${`tl-item tl-line tl-log${mark}`}><${Icon} name="check" size=${14} /><span class="tl-who"><b>${entry.who}</b>${agent ? html` <${AgentTag} />` : null}</span><span class="tl-text">${entry.text}</span>${time}</li>`;
  }
  return html`<li class=${`tl-item tl-line tl-event${mark}`}><span class="tb-dot" aria-hidden="true"></span><span class="tl-who"><b>${entry.who}</b>${agent ? html` <${AgentTag} />` : null}</span><span class="tl-text">${describe(entry.ev)}</span>${time}</li>`;
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
