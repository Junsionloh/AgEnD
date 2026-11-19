// AGEND-316: who a card is with, on the board. The assignee's avatar and name on a tile (or a list row) is a button: it opens
// the same picker the card's page has for "Assignee" (nobody, each instance, Other…; the choice saves at once, through the
// board's own write — fleet-tasks.js — with the same 409 and error handling), and pointing at it (or the keyboard's focus
// on it) shows a small card: the instance, its state, what it is doing, how many cards it holds, and two things the card's
// page already has (is it the project's lead, who dispatched this card). Over a read-only link the avatar is not a button:
// it shows the card and changes nothing.
//
// The info card is built ONLY from what the viewer already has — the board's cards (a read-only link's board has left out
// the cards of instances kept out of sight) and the instances the dashboard shows them — so it can name nothing the page
// does not: an instance the viewer does not see has no state line, and a dispatcher that is not one of the viewer's
// instances is left out. No style attribute (the CSP): the card is placed through the CSSOM, as the card menu is.
import { html, useEffect, useLayoutEffect, useRef, useState } from "/assets/app-html.js";
import { t, register } from "/assets/app-i18n.js";
import { appStore } from "/assets/app-store.js";
import { Who, boardReadOnly } from "./fleet-task-common.js";
import { instanceStates } from "./fleet-task-run.js";

register("taskowner", {
  en: {
    change: "Change assignee", assign: "Assign", changeOf: "{0}: change assignee", info: "{0}: details",
    conflict: "{0} changed while you were choosing. The board is up to date: choose again.",
    running: "Running", needs: "Needs you", stuck: "Looks stuck", idle: "Idle", offline: "Offline",
    now: "Now", nowNothing: "Nothing in progress", cards: "Cards", cardsN: "{0} open", lead: "Role", leadValue: "Project lead", dispatcher: "Dispatched by",
    part_claimed: "{0} in progress", part_open: "{0} to do", part_blocked: "{0} blocked", part_review: "{0} to confirm",
  },
  "zh-TW": {
    change: "切換負責人", assign: "指派", changeOf: "{0}：切換負責人", info: "{0} 的資訊",
    conflict: "{0} 在你選擇時被改過了。看板已更新，請再選一次。",
    running: "執行中", needs: "等你回應", stuck: "似乎卡住", idle: "閒置", offline: "離線",
    now: "目前", nowNothing: "沒有進行中的卡", cards: "手上", cardsN: "{0} 張", lead: "角色", leadValue: "專案 leader", dispatcher: "派工者",
    part_claimed: "{0} 進行中", part_open: "{0} 待辦", part_blocked: "{0} 卡住", part_review: "{0} 待確認",
  },
});

// ── What the card says (pure: tests import these) ────────────

/** A card that is work in itself: a sub task, or a main task without sub tasks (a main task that follows its sub tasks is not). */
const isWork = (c) => !(c.kind === "main" && c.progress && c.progress.total > 0);

/**
 * What the board knows of `name`'s hands: the cards it is on, finished ones left out — `doing` (in progress, the work itself),
 * `by` status, `total` — and, for the card the avatar is on, whether `name` leads its project and who dispatched it. Only the
 * `cards` the viewer was sent count, so it cannot say more than the board does.
 */
export function ownerFacts(name, card, cards, lead = null) {
  const mine = (Array.isArray(cards) ? cards : []).filter((c) => c && c.assignee === name && c.status !== "done" && c.status !== "cancelled" && isWork(c));
  const by = { claimed: 0, open: 0, blocked: 0, review: 0 };
  for (const c of mine) if (c.status in by) by[c.status]++;
  return { doing: mine.filter((c) => c.status === "claimed"), by, total: mine.length, lead: !!lead && lead === name, dispatcher: card ? card.dispatcher || null : null };
}

/**
 * The state of `name` in words, or null: the viewer does not see that instance (no state is claimed for it — "offline" would
 * say something the page does not know). Running, needs you and stuck are the dashboard's own; every other state (stopped,
 * crashed, paused, starting) is "offline" here.
 */
export function ownerState(name, store = appStore.get()) {
  const state = instanceStates(store, [name]).get(name);
  if (!state) return null;
  const word = state === "working" ? "running" : state === "needs" || state === "stuck" || state === "idle" ? state : "offline";
  return { state: word, text: t(`taskowner.${word}`) };
}

/** The dispatcher the card may name: a person, or an instance the viewer sees (one kept out of sight is not named). */
export function visibleDispatcher(dispatcher, store = appStore.get()) {
  if (!dispatcher || !dispatcher.name) return null;
  if (dispatcher.kind !== "instance") return dispatcher.name;
  return ((store && store.instances) || []).some((i) => i.name === dispatcher.name) ? dispatcher.name : null;
}

const PARTS = ["claimed", "open", "blocked", "review"];

// ── The card ─────────────────────────────────────────────────

/** The info card's body (also pure of the DOM: tests draw it with facts). */
export function OwnerCard({ name, card, facts, state, dispatcher, id }) {
  const first = facts.doing[0];
  const parts = PARTS.filter((s) => facts.by[s]).map((s) => t(`taskowner.part_${s}`, facts.by[s]));
  return html`<div class="tb-owner-card" role="tooltip" id=${id}>
    <div class="toc-head"><${Who} name=${name} plain /><span class="toc-spacer"></span>
      ${state ? html`<span class=${`tr-mark s-${state.state === "running" ? "working" : state.state}${state.state === "offline" || state.state === "idle" ? " shared" : ""}`}><span class="tr-dot" aria-hidden="true"></span>${state.text}</span>` : null}</div>
    <dl class="toc-rows">
      <dt>${t("taskowner.now")}</dt>
      <dd>${first ? html`<span class="tb-now-label st-claimed">${t("tasks.nowDoing")}</span> <span class="tb-code">${first.id}</span> ${first.title}${facts.doing.length > 1 ? html` <span class="muted">${t("tasks.moreCards", facts.doing.length - 1)}</span>` : null}`
        : html`<span class="muted">${t("taskowner.nowNothing")}</span>`}</dd>
      <dt>${t("taskowner.cards")}</dt>
      <dd>${t("taskowner.cardsN", facts.total)}${parts.length ? html` <span class="muted">· ${parts.join(" · ")}</span>` : null}</dd>
      ${facts.lead ? html`<dt>${t("taskowner.lead")}</dt><dd>${t("taskowner.leadValue")}</dd>` : null}
      ${dispatcher ? html`<dt>${t("taskowner.dispatcher")}</dt><dd>${dispatcher}</dd>` : null}
    </dl>
  </div>`;
}

// One info card at a time (pointing at a second avatar while the first still has the keyboard's focus), and none when the
// focus comes back to an avatar from the picker it opened (the board calls `quietInfo` before it gives the focus back).
let current = null, quietUntil = 0;
export const quietInfo = (ms = 500) => { quietUntil = Date.now() + ms; };

/** Shown after a short pause on the pointer, at once for the keyboard's focus; Esc, a click, a scroll or leaving hides it. */
function useHoverCard(enabled, delay = 220) {
  const [shown, setShown] = useState(false);
  const timer = useRef(0), quiet = useRef(false);
  const clear = () => { if (timer.current) clearTimeout(timer.current); timer.current = 0; };
  const hide = () => { clear(); setShown(false); if (current === hide) current = null; };
  const hideRef = useRef(hide);
  hideRef.current = hide;
  useEffect(() => () => { clear(); if (current === hideRef.current) current = null; }, []);
  const show = () => { if (current && current !== hide) current(); current = hide; setShown(true); };
  useEffect(() => {
    if (!shown) return undefined;
    const away = () => hide();
    globalThis.addEventListener?.("scroll", away, true);
    globalThis.addEventListener?.("resize", away);
    return () => { globalThis.removeEventListener?.("scroll", away, true); globalThis.removeEventListener?.("resize", away); };
  }, [shown]);
  const bind = {
    onMouseEnter: () => { if (!enabled || quiet.current) return; clear(); timer.current = setTimeout(() => { timer.current = 0; show(); }, delay); },
    onMouseLeave: () => { quiet.current = false; hide(); },
    // Only the keyboard's focus shows it: a tap focuses the button too, and then opens the picker.
    onFocus: (e) => {
      if (!enabled || quiet.current || Date.now() < quietUntil) return;
      let key = true;
      try { if (globalThis.CSS?.supports?.("selector(:focus-visible)")) key = e.target.matches(":focus-visible"); } catch { key = true; }
      if (key) { clear(); show(); }
    },
    onBlur: () => { quiet.current = false; hide(); },
    onKeyDown: (e) => { if (e.key === "Escape" && shown) { hide(); } },
    onClickCapture: () => { quiet.current = true; hide(); },
  };
  return { shown, bind };
}

/** Above the avatar when there is room (a tile's foot is at the bottom), else under it; kept inside the window. */
function place(card, anchor) {
  if (!card || !anchor || typeof card.getBoundingClientRect !== "function") return;
  const a = anchor.getBoundingClientRect(), r = card.getBoundingClientRect();
  const w = globalThis.innerWidth || Infinity, h = globalThis.innerHeight || Infinity;
  let top = a.top - r.height - 8;
  if (top < 8) top = Math.min(a.bottom + 8, h - r.height - 8);
  card.style.left = `${Math.max(8, Math.min(a.left, w - r.width - 8))}px`;
  card.style.top = `${Math.max(8, top)}px`;
}

let seq = 0;

/**
 * The assignee on a tile or a row. `canAssign`: the viewer may change it (the card is not finished, the session is not
 * read-only — `boardReadOnly`); `onPick(card, button)` opens the picker (the board draws it, where menus are not clipped by
 * the columns' scroll box). `cards`: the board's, for what the instance is doing; `lead`: the project's lead instance, if any.
 */
export function OwnerChip({ card, cards = [], lead = null, canAssign = false, onPick }) {
  const name = card.assignee;
  const anchor = useRef(null), pop = useRef(null);
  const id = useRef(`toc-${++seq}`);
  const { shown, bind } = useHoverCard(!!name);
  const allowed = canAssign && !boardReadOnly() && typeof onPick === "function";
  useLayoutEffect(() => { if (shown) place(pop.current, anchor.current); }, [shown]);
  let info = null;
  if (shown && name) {
    const store = appStore.get();
    info = html`<${OwnerCard} id=${id.current} name=${name} card=${card} facts=${ownerFacts(name, card, cards, lead)} state=${ownerState(name, store)} dispatcher=${visibleDispatcher(card.dispatcher, store)} />`;
  }
  const label = name ? t(allowed ? "taskowner.changeOf" : "taskowner.info", name) : t("taskowner.assign");
  const body = html`<${Who} name=${name} empty=${t("tasks.nobody")} plain />`;
  return html`<span class="tb-owner">
    ${allowed
      ? html`<button ref=${anchor} type="button" class="tb-owner-btn" aria-haspopup="menu" aria-label=${label} aria-describedby=${info ? id.current : undefined}
          onClick=${(e) => { e.stopPropagation(); onPick(card, e.currentTarget); }} ...${bind}>${body}</button>`
      : html`<span ref=${anchor} class="tb-owner-btn is-static" tabindex=${name ? "0" : undefined} role=${name ? "group" : undefined} aria-label=${name ? label : undefined} aria-describedby=${info ? id.current : undefined} ...${bind}>${body}</span>`}
    ${info ? html`<div class="tb-owner-pop" ref=${pop}>${info}</div>` : null}
  </span>`;
}

/** What workers show beside the owner on a main task that follows its sub tasks: only those who are not the owner. */
export const otherWorkers = (workers, owner) => workers.filter((w) => w && w !== owner);
