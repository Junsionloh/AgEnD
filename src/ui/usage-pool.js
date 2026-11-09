// AGEND-113: an account's usage block on Settings → Accounts: EVERY pool and EVERY window the account reports, as the server sends them (accounts-view.ts `accountUsage`), never one picked from
// several. A provider with one set of limits (Claude, Codex) draws its windows side by side, as it always did; a provider with pools (Antigravity: Gemini, Claude & others, Gemini 4 Argon) draws a
// block per pool, named, with that pool's windows in it. The meter is the Usage panel's own (`CompactMeter`); the order is the full card's. A module of its own, its stylesheet linked from here:
// a tab that loaded an older accounts-view.js keeps working, and nothing of the Accounts view's own strings or meter markup is touched.
import { html } from "/assets/app-html.js";
import { t } from "/assets/app-i18n.js";
import "/assets/view-strings.js";   // the usage panel's own words (`view.usage.metric.*`)
import { CompactMeter, usageClock, usageText } from "/assets/usage-meter.js";

/**
 * The pool's name in the page's language from the usage panel's own reference (`labelI18n`), else the label the server sent. Text only; a reference that does not name a
 * `usage.metric.*` word is not looked up.
 */
export function poolName(pool) {
  if (!pool || typeof pool.label !== "string") return "";
  const ref = pool.labelI18n;
  if (ref && typeof ref.key === "string" && /^usage\.metric\.[a-z_]+$/.test(ref.key)) {
    const key = `view.${ref.key}`, word = t(key);
    if (word && word !== key) return (Array.isArray(ref.args) ? ref.args : []).reduce((text, value, i) => text.split(`{${i}}`).join(String(value)), word);
  }
  return pool.label;
}

/** This module's stylesheet, linked once (an older accounts.css has no rules for it). */
function linkPoolCss(doc = typeof document !== "undefined" ? document : null) {
  try {
    if (!doc || !doc.head || doc.querySelector('link[data-accounts-usage-pool-css="1"]')) return;
    const link = doc.createElement("link");
    link.setAttribute("rel", "stylesheet"); link.setAttribute("href", "/assets/accounts-usage-pool.css"); link.setAttribute("data-accounts-usage-pool-css", "1");
    doc.head.appendChild(link);
  } catch { /* the block still reads without it */ }
}

/**
 * One window: the Usage panel's meter with its tag ("5h", "7d"). A window that has reset since the numbers were read has no number to trust, so it says so, in the full card's own words,
 * instead of the old percent.
 */
function UsageWindow({ w, tag }) {
  if (w.resetPassed) {
    const note = usageText("", { key: "usage.metric.reset_since", args: [usageClock(w.resetsAt)] });
    return html`<span class="u-cm s-usage-reset" title=${note}><span class="u-cm-tag">${tag}</span><span class="s-usage-reset-note">${note}</span></span>`;
  }
  return html`<${CompactMeter} m=${{ used: Number(w.percent) || 0, windowMs: w.windowMs, resetsAt: w.resetsAt, label: tag }} tag=${tag} />`;
}

/**
 * The usage block. `groups`: the server's `usageGroups` (each `{ pool?, windows: [{ kind, percent, windowMs?, resetsAt?, resetPassed? }] }`); `tagOf(window)`: the window's short name in the
 * page's language (the Accounts view's own words); `stale`/`staleText`: the numbers are the last known ones.
 */
export function UsageBlock({ groups, stale, tagOf, label, staleText }) {
  const pooled = groups.length > 1 || groups.some((g) => g.pool);
  if (pooled) linkPoolCss();
  const cls = `s-account-usage${stale ? " is-stale" : ""}${pooled ? " is-pooled" : ""}`;
  return html`<div class=${cls} role="group" aria-label=${label}>
    ${pooled ? groups.map((g, i) => {
      const name = poolName(g.pool);
      return html`<div key=${i} class="s-usage-group" role="group" aria-label=${name || label}>
        ${name ? html`<small class="s-usage-pool">${name}</small>` : null}
        ${g.windows.map((w, j) => html`<${UsageWindow} key=${j} w=${w} tag=${tagOf(w)} />`)}
      </div>`;
    }) : groups[0].windows.map((w, j) => html`<${UsageWindow} key=${j} w=${w} tag=${tagOf(w)} />`)}
    ${stale ? html`<small class="s-usage-stale">${staleText}</small>` : null}
  </div>`;
}
