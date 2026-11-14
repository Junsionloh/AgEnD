// #3731 (ACP adapter, phase 1): how an agent runs — `cli_adapter` "tmux" (a terminal pane, today's way) or "acp" (the CLI
// spoken to over ACP on stdio: no terminal, but live thinking, tool progress and permission requests in the Log).
// One module for what the pages share: the execution-mode fields of the create and edit forms, the confirmation before
// a switch, the mode badge, the terminal gating (`pane_view`), and the Log's two new rows — a thought and a permission
// request with its Allow / Deny / Cancel turn buttons. Behind the session gate (/ui/js/).
import { html, useRef, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import { confirmDialog } from "/assets/ui-confirm.js";

register("adapter", {
  en: {
    modeLabel: "Execution mode", modeTmux: "Terminal (tmux)", modeAcp: "ACP (no terminal)",
    modeHint: "ACP shows live thinking and tool progress in chat and asks for permission in chat. There is no terminal view and no attach.",
    approveLabel: "Always approve tool permissions",
    approveHint: "Warning: every tool the agent asks to use is allowed without asking you, including commands and file changes. Leave it off to approve each request in chat.",
    badge: "ACP", badgeTitle: "Runs over ACP: no terminal. Live thinking and permission requests show in the Log.",
    switchTitle: "Switch execution mode?",
    switchToAcp: "{0} will restart in ACP mode. Its terminal screen will be lost: ACP has no terminal view and no attach. Whether the conversation carries over depends on the CLI.",
    switchToTmux: "{0} will restart in a terminal (tmux). Live thinking and permission buttons go away and a terminal appears. Whether the conversation carries over depends on the CLI.",
    switchConfirm: "Switch and restart",
    noPane: "No terminal: this agent runs over ACP.",
    thought: "Thinking", showThought: "Show thinking", hideThought: "Hide thinking",
    permission: "Permission requested", allow: "Allow", deny: "Deny", cancelTurn: "Cancel turn",
    waiting: "Waiting for you", sending: "Answer sent…", sendFailed: "Could not send the answer: {0}",
    answered: "Answered: {0}", outcomeCancelled: "Turn cancelled", notOffered: "The CLI did not offer this choice",
    what: "Wants to use", noSubject: "(no details)",
  },
  "zh-TW": {
    modeLabel: "執行模式", modeTmux: "終端機（tmux）", modeAcp: "ACP（沒有終端機）",
    modeHint: "ACP 會在聊天裡即時顯示思考與工具進度，並在聊天裡詢問權限。沒有終端畫面，也不能 attach。",
    approveLabel: "一律允許工具權限",
    approveHint: "警告：Agent 要求使用的每個工具都會直接放行、不會詢問你，包括執行指令與修改檔案。關閉時，每個要求都會在聊天裡等你決定。",
    badge: "ACP", badgeTitle: "以 ACP 執行：沒有終端機。即時思考與權限要求顯示在「紀錄」。",
    switchTitle: "切換執行模式？",
    switchToAcp: "{0} 會以 ACP 模式重新啟動，目前的終端畫面會消失：ACP 沒有終端畫面，也不能 attach。對話是否延續取決於這個 CLI。",
    switchToTmux: "{0} 會改用終端機（tmux）重新啟動。即時思考與權限按鈕會消失，並出現終端機。對話是否延續取決於這個 CLI。",
    switchConfirm: "切換並重新啟動",
    noPane: "沒有終端機：這個 Agent 以 ACP 執行。",
    thought: "思考", showThought: "顯示思考", hideThought: "收合思考",
    permission: "要求權限", allow: "允許", deny: "拒絕", cancelTurn: "取消這一輪",
    waiting: "等你決定", sending: "已送出回覆…", sendFailed: "無法送出回覆：{0}",
    answered: "已回覆：{0}", outcomeCancelled: "這一輪已取消", notOffered: "CLI 沒有提供這個選項",
    what: "想要使用", noSubject: "（沒有細節）",
  },
});
const ta = (key, ...a) => t(`adapter.${key}`, ...a);

// ── What a status row says about how the agent runs ──

/** "acp" or "tmux": an instance (a status frame's entry, or a config) with no cli_adapter runs in a terminal. */
export const modeOf = (inst) => (inst && inst.cli_adapter === "acp" ? "acp" : "tmux");
/** Whether the agent has a terminal pane (attach, screen, keys). Unknown (an older server's row) counts as yes. */
export const paneViewOf = (inst) => !inst || inst.pane_view !== false;
/** The adapters a backend may run, from /ui/backends (`adapters`); a server that does not say offers the terminal only. */
export function adaptersOf(rows, backend) {
  const row = Array.isArray(rows) ? rows.find((r) => r && r.name === backend) : null;
  const list = row && Array.isArray(row.adapters) ? row.adapters.filter((a) => a === "tmux" || a === "acp") : [];
  return list.length ? list : ["tmux"];
}
/** The mode in force for a form: the chosen one when the backend offers it, else the terminal. */
export const effectiveMode = (mode, adapters) => (mode === "acp" && adapters.includes("acp") ? "acp" : "tmux");

/** The mode's name as the forms show it ("ACP (no terminal)" / "Terminal (tmux)"), and the field's label. */
export const modeText = (inst) => ta(modeOf(inst) === "acp" ? "modeAcp" : "modeTmux");
export const modeFieldLabel = () => ta("modeLabel");

/** Why a terminal control is off for an agent without one (its tooltip), or undefined when it has one. */
export const noPaneReason = (inst) => (paneViewOf(inst) ? undefined : ta("noPane"));

// ── The form fields (create and edit) ──

/**
 * The "Execution mode" select and, with ACP chosen, the approve-all checkbox. Shown only when `adapters` offers more than
 * the terminal (the selected backend's own list). `mode` / `approve` are the form's values; a mode the backend does not
 * offer reads as the terminal (a backend change never leaves ACP chosen on one that cannot run it).
 */
export function ExecutionModeFields({ adapters, mode, approve, onMode, onApprove, id = "ag-mode", disabled = false, impact = null }) {
  if (!adapters.includes("acp")) return null;
  const shown = effectiveMode(mode, adapters);
  return html`<div class="field exec-mode">
      <label for=${id}>${ta("modeLabel")}${impact ? html` ${impact}` : null}</label>
      <select id=${id} value=${shown} disabled=${disabled} onChange=${(e) => onMode(e.target.value)}>
        <option value="tmux">${ta("modeTmux")}</option>
        <option value="acp">${ta("modeAcp")}</option>
      </select>
      <p class="note">${ta("modeHint")}</p>
    </div>
    ${shown === "acp" ? html`<div class="field exec-approve">
      <label class="check"><input id=${`${id}-approve`} type="checkbox" checked=${!!approve} disabled=${disabled} onChange=${(e) => onApprove(e.target.checked)} /><span>${ta("approveLabel")}</span></label>
      <p class="note exec-warn" role="note">${ta("approveHint")}</p>
    </div>` : null}`;
}

/** Ask before an existing agent's mode changes (either way): it restarts. Resolves true to go ahead. */
export function confirmModeSwitch(name, to) {
  return confirmDialog({ title: ta("switchTitle"), message: ta(to === "acp" ? "switchToAcp" : "switchToTmux", name), confirmLabel: ta("switchConfirm") });
}

// ── The badge ──

/** A small "ACP" marker for an agent that runs over ACP; nothing for a terminal agent (the default). */
export function ModeBadge({ inst, className = "" }) {
  if (modeOf(inst) !== "acp") return null;
  return html`<span class=${`mode-badge${className ? ` ${className}` : ""}`} title=${ta("badgeTitle")}>${ta("badge")}</span>`;
}

// ── The Log's rows ──

/** A thought longer than this many lines (or characters) is folded until opened. */
export const THOUGHT_FOLD_LINES = 4;
export const THOUGHT_FOLD_CHARS = 280;
export const thoughtIsLong = (body) => !!body && (body.split("\n").length > THOUGHT_FOLD_LINES || body.length > THOUGHT_FOLD_CHARS);

/** Thinking text: muted, italic, and collapsed to its label when long (the reader opens it). */
export function ThoughtBlock({ step, label = true }) {
  const long = thoughtIsLong(step.body);
  const [open, setOpen] = useState(false);
  const shown = !long || open;
  return html`<div class=${`log-thought${shown ? "" : " collapsed"}`}>
    ${label ? html`<span class="log-thought-label">${ta("thought")}</span>` : null}
    ${shown && step.body ? html`<div class="log-text log-thought-text">${step.body}</div>` : null}
    ${long ? html`<button type="button" class="link-btn log-more" aria-expanded=${open ? "true" : "false"} onClick=${() => setOpen(!open)}>${open ? ta("hideThought") : ta("showThought")}</button>` : null}</div>`;
}

/** The choices a permission step offers that the page may press: only once-only ones, never an *_always. */
export function permissionChoices(step) {
  const options = Array.isArray(step.options) ? step.options : [];
  return {
    allow: options.find((o) => o && o.kind === "allow_once") || null,
    deny: options.find((o) => o && o.kind === "reject_once") || null,
  };
}
/** A permission step still waits for a person. */
export const permissionPending = (step) => step.status === "running";

/** POST /ui/permission → null on success, else the message to show. */
export async function sendPermission(fetcher, instance, requestId, decision) {
  let r;
  try {
    r = await fetcher("/ui/permission", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ instance, request_id: requestId, decision }) });
  } catch (err) { return (err && err.message) || "network"; }
  let body = null;
  try { body = await r.json(); } catch { /* not JSON */ }
  if (r.ok && body && body.ok === true) return null;
  return (body && body.error) || `HTTP ${r.status}`;
}

/**
 * A permission request as a card: what it wants, and Allow / Deny / Cancel turn while it waits; once answered, the
 * outcome from the step's note. `fetcher` is the page's (a lease's) fetch; `instance` names the agent.
 */
export function PermissionCard({ step, instance, fetcher }) {
  const [sent, setSent] = useState(null);       // the decision just sent, until the step itself says it was answered
  const [error, setError] = useState("");
  const pending = permissionPending(step);
  const choices = permissionChoices(step);
  const busy = sent !== null;
  // A second press before the page has redrawn must not send a second answer.
  const inFlight = useRef(false);
  const answer = async (decision) => {
    if (!pending || busy || inFlight.current) return;
    inFlight.current = true;
    setError(""); setSent(decision);
    const problem = await sendPermission(fetcher || ((u, o) => fetch(u, o)), instance, step.id, decision);
    inFlight.current = false;
    if (problem) { setSent(null); setError(ta("sendFailed", problem)); }
  };
  const button = (decision, label, enabled, why) => html`<button type="button" class=${`btn btn-sm perm-${decision}${decision === "allow" ? " btn-primary" : ""}`}
    disabled=${!pending || busy || !enabled} title=${!enabled && pending ? why : undefined} onClick=${() => answer(decision)}>${label}</button>`;
  const outcome = step.note === "cancelled" ? ta("outcomeCancelled") : step.note ? ta("answered", step.note) : "";
  return html`<div class=${`perm-card${pending ? " pending" : ""}`}>
    <div class="perm-what"><span class="perm-label">${ta("what")}</span>${step.tool ? html` <span class="log-tool mono">${step.tool}</span>` : null}
      ${step.subject ? html` <span class="log-subject mono">${step.subject}</span>` : null}</div>
    ${step.body ? html`<div class="log-text perm-title">${step.body}</div>` : null}
    <div class="perm-actions" role="group" aria-label=${ta("permission")}>
      ${button("allow", ta("allow"), !!choices.allow, ta("notOffered"))}${button("deny", ta("deny"), !!choices.deny, ta("notOffered"))}${button("cancel", ta("cancelTurn"), true)}
    </div>
    ${pending && busy ? html`<p class="note perm-sending" role="status">${ta("sending")}</p>` : null}
    ${pending && !busy && !error ? html`<p class="note perm-waiting">${ta("waiting")}</p>` : null}
    ${!pending && outcome ? html`<p class="note perm-outcome" role="status">${outcome}</p>` : null}
    ${error ? html`<p class="err perm-error" role="alert">${error}</p>` : null}
  </div>`;
}
