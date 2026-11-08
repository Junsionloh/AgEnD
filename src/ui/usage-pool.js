// AGEND-113: which quota pool an account's usage window is, when the provider has several (Antigravity: "Gemini", "Claude & others"). The server sends only the most used pool's window,
// with its `pool` (a short label and the usage panel's own word reference); this says its name under the window, in the page's language. A module of its own, its words registered
// here: a tab that loaded an older accounts-view.js keeps working, and nothing of the Accounts view's own strings or meter markup is touched.
import { html } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import "/assets/view-strings.js";   // the usage panel's own words (`view.usage.metric.*`)

register("usagePool", {
  en: { mostUsed: "most used: {0}" },
  "zh-TW": { mostUsed: "用量最高：{0}" },
});

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

/** One window of the usage block (`Window`: the Accounts view's own component) and, when it has a pool, its name under it. A window with no pool is drawn exactly as before. */
export function UsageCell({ u, kind, Window }) {
  if (!u || !u.pool) return html`<${Window} u=${u} kind=${kind} />`;
  const name = poolName(u.pool);
  return html`<div class="s-usage-cell"><${Window} u=${u} kind=${kind} />${name ? html`<small class="s-usage-pool">${t("usagePool.mostUsed", name)}</small>` : null}</div>`;
}
