// AGEND-340: an account signed in under Settings → Accounts is not used by any agent until it is chosen. An agent that names none
// (and whose fleet default names none) runs on the CLI's default sign-in; when that is signed out it stops at the CLI's sign-in screen
// and is paused, and nothing said why. This is the banner that says so — on the agent's chat and Log pages — with the way to choose
// an account (its settings), and, when exactly one account is signed in, a "Use <account>" button.
//
// It only says so. It never picks an account for the agent: "Use <account>" is a press, and it is the same write Settings' Save does for an
// agent's account (a PATCH of `backend_options.<cli>.credential_profile`, run by Settings' own operation runner, so the shell shows its
// progress); the server merges it per CLI, so nothing else the agent has is touched.
// The facts come from GET /ui/account-hint/<agent> (admin session only; a guest or a read-only link gets no banner).
import { html, useEffect, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import { appStore, guestPage, useStore } from "/assets/app-store.js";
import { navigate } from "/assets/app-nav.js";
import { detailsPath } from "/assets/app-route.js";
import { toast } from "/assets/ui-toast.js";

register("accountHint", {
  en: {
    lead: "{0} is not signed in on this host, and {1} uses no account of its own, so it cannot start. {2}",
    one: "The account {0} is signed in.", many: "These accounts are signed in: {0}.",
    choose: "Choose an account", use: "Use {0}", useLabel: "{1}: use the account {0}", busy: "Another change is being applied. Try again in a moment.",
    chooseHint: "Opens {0}'s settings, where its account is chosen.",
  },
  "zh-TW": {
    lead: "這台主機上的 {0} 尚未登入，而 {1} 沒有指定自己的帳號，所以無法啟動。{2}",
    one: "帳號 {0} 已登入。", many: "這些帳號已登入：{0}。",
    choose: "選擇帳號", use: "使用 {0}", useLabel: "{1}：使用帳號 {0}", busy: "正在套用另一項變更，請稍後再試。",
    chooseHint: "開啟 {0} 的設定，在那裡選擇它的帳號。",
  },
});

/** The agent's account choice: its settings page, on the category that holds the Account field. */
export const accountSettingsPath = (name) => `${detailsPath(name)}?cat=runtime`;

/** One line for a failed Start or Restart: the server's error and, when it sent one, the hint beside it. */
export const startFailureText = (body) => {
  const error = body && typeof body.error === "string" ? body.error : "";
  const hint = body && typeof body.hint === "string" ? body.hint : "";
  return hint ? `${error} ${hint}`.trim() : error;
};

/** `{ hint }` of the route → the hint, or null for anything else (no admin session, an older server, a network error). */
export async function readAccountHint(name, fetcher = (url, init) => fetch(url, init)) {
  try {
    const res = await fetcher(`/ui/account-hint/${encodeURIComponent(name)}`, { cache: "no-store" });
    if (!res.ok) return null;
    const body = await res.json();
    const hint = body && body.hint;
    return hint && typeof hint.backend === "string" && Array.isArray(hint.accounts) && hint.accounts.length ? hint : null;
  } catch { return null; }
}

/**
 * "Use <account>": Settings' own write for an agent's account, as an operation of the app (so the shell shows its progress whatever page
 * is open). Returns false when another operation is in hand, and does nothing then.
 */
export async function useAccount(name, hint, account) {
  const { startOperation } = await import("./settings-apply.js");
  return startOperation([{
    label: t("accountHint.useLabel", account, name), impact: "instance",
    request: { method: "PATCH", url: `/api/settings/fleet/instances/${encodeURIComponent(name)}`, body: { backend_options: { [hint.backend]: { credential_profile: account } } } },
  }]);
}

/** The banner (nothing when there is nothing to say). `inst`: the agent's entry in the app's list. */
export function AccountHint({ name, inst }) {
  const app = useStore(appStore);
  const [hint, setHint] = useState(null);
  const op = app.settingsOp ? app.settingsOp.phase : "";
  // A running agent has a working sign-in, whatever else is signed in: nothing to say, and no request (a chat page opens with the
  // reads #1374 counts, and a page revisited reads nothing — tests/web-app-panels-1408.test.ts). A Windows agent signs in on its own computer.
  const host = !!inst && inst.runtime !== "windows" && inst.status !== "running";
  // Read when the page opens, when the agent's state changes (a paused agent is the case) and when a Save or "Use" finishes.
  useEffect(() => {
    if (!host || guestPage()) { setHint(null); return undefined; }
    let alive = true;
    readAccountHint(name).then((h) => { if (alive) setHint(h); });
    return () => { alive = false; };
  }, [name, host, inst && inst.status, op]);
  if (!hint) return null;
  const label = hint.label || hint.backend;
  const accounts = hint.only ? t("accountHint.one", hint.only) : t("accountHint.many", hint.accounts.join(", "));
  const use = async () => {
    const started = await useAccount(name, hint, hint.only).catch(() => false);
    if (!started) toast(t("accountHint.busy"), false);
  };
  return html`<div class="windows-agent-blocked account-hint" role="status" data-account-hint=${name}>
    <p>${t("accountHint.lead", label, name, accounts)}</p>
    <button type="button" class="btn" title=${t("accountHint.chooseHint", name)} onClick=${() => navigate(accountSettingsPath(name))}>${t("accountHint.choose")}</button>
    ${hint.only ? html`<button type="button" class="btn btn-primary" onClick=${use}>${t("accountHint.use", hint.only)}</button>` : null}
  </div>`;
}
