// AGEND-296: what the agent is doing on a card (Fleet › Tasks). The board knows a card's assignee and its status; the
// dashboard already knows each instance's state (working, waiting for you, stuck, idle) and, for an admin, its steps (the
// chat's activity block). This puts them side by side: a card in progress whose assignee is working is "running".
//
// The match is an INFERENCE, not a record: AgEnD has no run per card — an instance is one continuing session. A card in
// `claimed` and its assignee working are taken for one thing, which is exact while the assignee has that one card in
// progress (the default, `board_cards_at_once: 1`). With several in progress (a higher limit, or a person dragged some
// there) nothing says which one the assignee is on: each of them says "busy, N cards" and none says "running". Nothing is
// stored and nothing is added to the API; an instance the viewer cannot see, a card nobody has, or steps that are not
// offered show nothing (or the state alone). No style attribute anywhere (the CSP).
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { t, register } from "/assets/app-i18n.js";
import { appStore, useStore } from "/assets/app-store.js";
import { dotState } from "/assets/instance-nav.js";
import { chatPath, detailsPath } from "/assets/app-route.js";
import { Icon } from "/assets/ui-icons.js";
import { ActivityBlock, activityDrawCtx, activityOffered, activityPrefs, activitySnapshot, observeActivity } from "./chat-activity.js";
import { SHOWN, TIME_SLACK_MS, hasSubstance } from "./chat-activity-groups.js";
import { Who } from "./fleet-task-common.js";

register("taskrun", {
  en: {
    title: "Agent activity", running: "Running", needs: "Needs you", stuck: "Looks stuck", idle: "Idle", sharedMark: "Busy · {0} cards", byAgent: "Agent", byAgentTip: "Made by an agent",
    openChat: "Open conversation", openChatTip: "{0}'s conversation: its replies and, where shown, its steps",
    idleNote: "{0} has this card in progress but is idle right now.",
    sharedNote: "{0} has {1} cards in progress, so what it is doing now may belong to another of them.",
    stepsOff: "{0}'s tool progress is off, so its steps are not shown here.", stepsOffLink: "Turn it on in its settings",
    noSteps: "This agent's runtime does not offer its steps.",
  },
  "zh-TW": {
    title: "Agent 活動", running: "執行中", needs: "等你回應", stuck: "似乎卡住", idle: "閒置", sharedMark: "忙碌中 · {0} 張卡", byAgent: "Agent", byAgentTip: "由 Agent 做的",
    openChat: "開啟對話", openChatTip: "{0} 的對話：它的回覆，以及（有顯示時）它的步驟",
    idleNote: "{0} 手上有這張進行中的卡，但目前閒置。",
    sharedNote: "{0} 同時有 {1} 張卡在進行中，目前的動作可能屬於其中另一張。",
    stepsOff: "{0} 的工具進度是關閉的，所以這裡不顯示它的步驟。", stepsOffLink: "到它的設定開啟",
    noSteps: "這個 Agent 的執行環境沒有提供步驟。",
  },
});

// ── What is running (pure: tests import these) ───────────────

/** The states a card shows, strongest first: working, then waiting for the person, then stuck, then idle. */
export const RUN_RANK = { working: 0, needs: 1, stuck: 2, idle: 3 };

/**
 * How many board cards each instance has in progress, by name — what `task mine` counts: cards in `claimed`, a main task
 * that follows its sub tasks aside (its sub tasks are the work).
 */
export function inProgressBy(cards) {
  const out = new Map();
  for (const c of Array.isArray(cards) ? cards : []) {
    if (!c || c.status !== "claimed" || !c.assignee) continue;
    if (c.kind === "main" && c.progress && c.progress.total > 0) continue;
    out.set(c.assignee, (out.get(c.assignee) || 0) + 1);
  }
  return out;
}

/**
 * What a card's assignee is doing on it, or null (nothing to say): { instance, state: working | needs | stuck | idle, shared }
 * — `shared`: how many cards the assignee has in progress when that is more than this one (then which one it is on is
 * not known), else 0. Only a card in progress has one, and only while its assignee is an instance the viewer sees, running.
 * A main task that follows its sub tasks has its running sub tasks' (the strongest); `subs`: the ones the page shows.
 * `ctx`: { instances, exec, awaiting, doing } — the dashboard's store and `inProgressBy` of the board.
 */
export function runOf(card, ctx, subs = []) {
  if (!card || card.status !== "claimed") return null;
  if (card.kind === "main" && card.progress && card.progress.total > 0) {
    const runs = (subs || []).map((s) => runOf(s, ctx)).filter(Boolean).sort((a, b) => RUN_RANK[a.state] - RUN_RANK[b.state]);
    return runs[0] || null;
  }
  const name = card.assignee;
  if (!name) return null;
  const it = (ctx.instances || []).find((i) => i.name === name);
  if (!it) return null;
  const state = dotState(it, (ctx.exec || {})[name], (ctx.awaiting || {})[name]);
  if (!(state in RUN_RANK)) return null;
  const n = (ctx.doing && ctx.doing.get(name)) || 0;
  return { instance: name, state, shared: n > 1 ? n : 0 };
}

/** The same, read from the dashboard's store: a tile's or a row's, redrawn when an instance's state changes. */
export function useRun(card, doing, subs) {
  const { instances, exec, awaiting } = useStore(appStore);
  return runOf(card, { instances, exec, awaiting, doing }, subs);
}

/**
 * When the card was last put in progress, in epoch ms (0: unknown): its newest move to `claimed` in the history, else
 * the time it first started. Steps older than this are not this card's.
 */
export function claimedSince(detail) {
  let at = 0;
  for (const ev of (detail && detail.history) || []) {
    if (ev && ev.type === "moved" && ev.data && ev.data.to === "claimed") at = Math.max(at, Date.parse(ev.at) || 0);
  }
  return at || Date.parse((detail && detail.card && detail.card.startedAt) || "") || 0;
}

/**
 * The live group the chat's ActivityBlock draws, from the steps an instance's feed holds: those since `since` (the
 * newest turn's, when it is not known), thinking left to the block's own switch. Null when there is nothing to draw
 * from: no answer yet, the server offers nothing for good, the agent's tool_progress is off, or its backend has no steps.
 */
export function liveGroupOf(snap, { since = 0, busy = true } = {}) {
  if (!snap || snap.dead || !snap.info || snap.info.level === "off" || snap.info.supported === false) return null;
  const shown = (snap.steps || []).filter((s) => SHOWN.has(s.kind) && hasSubstance(s));
  let items;
  if (since) items = shown.filter((s) => !s.ts || s.ts >= since - TIME_SLACK_MS);
  else {
    const last = shown[shown.length - 1];
    items = last ? shown.filter((s) => s.turn === last.turn) : [];
  }
  const from = (items[0] && items[0].ts) || since || 0;
  const first = (snap.steps || [])[0];
  const partial = !!since && !snap.complete && !!first && Number.isFinite(first.ts) && first.ts > since;
  return {
    key: "act:card", turn: "card", n: 0, level: "live", rowKey: null, items, trailing: [], ts: from, from, to: 0, ended: false, turnEnded: false,
    busy, atEnd: true, ...(snap.phase ? { phase: snap.phase } : {}), ...(partial ? { partial: true } : {}),
  };
}

// ── What is drawn ─────────────────────────────────────────

/** A state in words, capitalised for a chip ("needs you" is the dashboard's own wording). */
const stateWord = (state) => t(`taskrun.${state === "working" ? "running" : state}`);

/** "Running" (or "Busy · N cards", "Needs you", "Looks stuck") beside a tile's or a row's number; idle says nothing there. */
export function RunMark({ run }) {
  if (!run || run.state === "idle") return null;
  const word = run.state === "working" && run.shared ? t("taskrun.sharedMark", run.shared) : stateWord(run.state);
  return html`<span class=${`tr-mark s-${run.state}${run.shared ? " shared" : ""}`} title=${`${run.instance}: ${word}`}>
    <span class="tr-dot" aria-hidden="true"></span>${word}</span>`;
}

/** A timeline entry's "Agent" tag: made by an instance (the entry says so; an older one that does not gets none). */
export function AgentTag() {
  return html`<span class="tb-tag tr-by" title=${t("taskrun.byAgentTip")}><${Icon} name="bot" size=${12} />${t("taskrun.byAgent")}</span>`;
}

/** The feed of `name`'s steps (the chat's own read, live by `steps_tick`), held while `on`; redraws when it changes. */
function useFeed(name, on, busy) {
  const [, bump] = useState(0);
  const working = useRef(busy);
  working.current = busy;
  useEffect(() => {
    if (!on || !name) return undefined;
    const feed = observeActivity(name, {
      changed: () => bump((n) => n + 1),
      streamOn: appStore.get().streamOn,
      polling: () => globalThis.document?.body?.dataset?.webTransport === "poll" || appStore.get().connection === "polling",
      wantThinking: () => activityPrefs.get().thinking,
      working: () => working.current,
    });
    feed.start();
    return () => feed.stop();
  }, [name, on]);
}

/**
 * A card's page: who has it, what they are doing now, and the way to their conversation. Shown for a card whose assignee
 * is an instance the viewer sees (for any status: the conversation link is the way to what it did); the state and the
 * live steps only while the card is in progress. `doing`: `inProgressBy` of the board. A main task that follows its sub
 * tasks has none (its sub tasks' pages do).
 */
export function AgentRun({ card, detail, doing }) {
  const { instances, exec, awaiting } = useStore(appStore);
  useStore(activityPrefs);
  const name = card.assignee;
  const it = name ? (instances || []).find((i) => i.name === name) : null;
  const run = runOf(card, { instances, exec, awaiting, doing });
  const live = !!run && run.state !== "idle";
  const offered = live && activityOffered() && activityPrefs.get().on;
  useFeed(name, offered, live);
  if (!it) return null;
  const snap = offered ? activitySnapshot(name) : null;
  const group = snap ? liveGroupOf(snap, { since: claimedSince(detail), busy: live }) : null;
  const off = snap && !snap.dead && snap.info && snap.info.level === "off";
  const none = snap && snap.info && snap.info.supported === false;   // (the feed then holds nothing for good: dead)
  const word = run ? stateWord(run.state) : "";
  return html`<section class="card tr-run" aria-label=${t("taskrun.title")}>
    <div class="tr-head">
      <h3 class="tr-title">${t("taskrun.title")}</h3>
      <${Who} name=${name} />
      ${run ? html`<span class=${`tr-state s-${run.state}`}><span class="tr-dot" aria-hidden="true"></span>${word}</span>` : null}
      <span class="tb-grow"></span>
      <a class="btn btn-sm tr-open" href=${chatPath(name)} title=${t("taskrun.openChatTip", name)}><${Icon} name="chat" size=${14} />${t("taskrun.openChat")}</a>
    </div>
    ${run && run.state === "idle" ? html`<p class="muted tr-note">${t("taskrun.idleNote", name)}</p>` : null}
    ${run && run.shared ? html`<p class="muted tr-note">${t("taskrun.sharedNote", name, run.shared)}</p>` : null}
    ${group ? html`<${ActivityBlock} group=${group} ctx=${activityDrawCtx(name)} />` : null}
    ${off ? html`<p class="muted tr-note">${t("taskrun.stepsOff", name)} <a class="link" href=${detailsPath(name)}>${t("taskrun.stepsOffLink")}</a></p>` : null}
    ${none ? html`<p class="muted tr-note">${t("taskrun.noSteps")}</p>` : null}
  </section>`;
}
