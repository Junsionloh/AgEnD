// AGEND-261: the "Team MCP" card of an agent's settings (Settings → agent → Workspace, under "Team skills"): which of the team's library MCP
// servers (the Library page, /ui/library/mcp) this agent is given. An administrator ticks them; ticking one that is not confirmed yet first
// shows exactly what it would run and the variables it needs, and the confirmation is recorded for this agent at that version
// (POST /ui/library/mcp-confirm). The agent gets the server in its CLI's MCP config at its next start (src/library/mcp-mount.ts): a server
// with a variable that has no value in `.env` is NOT started, and the row says which variable is missing. Values are never shown here —
// the server sends names only (GET /ui/library/mcp-status).
//
// The words live in a module of their own, registered with the field (as library-mount-field.js does), so a tab opened before an upgrade never
// shows a raw key. Nothing here writes settings: the ticked ids become the `library.mcp` value of the agent's patch (settings-model.js).
import { html, useCallback, useEffect, useRef, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import { Dialog } from "/assets/ui-dialog.js";

register("libraryMcp", {
  en: {
    card: "Team MCP servers (from the Library)", label: "Team MCP servers",
    tip: "Team MCP servers from the Library that this agent is given, beside AgEnD’s own. They are written into the agent’s CLI MCP config when the agent starts, so a change applies after a restart. Your own MCP settings are not touched.",
    none: "The Library has no usable MCP server yet. Add one on the Library page.", loadFailed: "Could not read the Library.", loading: "Reading the Library…",
    gone: "Not in the Library any more", notReady: "Not given: it was changed outside the Library or breaks a rule — check it on the Library page",
    unsupported: "This agent’s CLI ({0}) does not support Library MCP servers yet, so they do not take effect on it.",
    needsConfirm: "Changed — confirm again", review: "Review and confirm",
    missing: "Not started: no value for {0}. Set it in the .env file next to fleet.yaml and restart the agent.",
    missingOne: "Not started: no value for {0}.", varsSet: "set", varsMissing: "missing",
    honest: "A variable’s value is handed to its MCP server when the agent starts, the same as today’s .env approach. Keeping the keys away from the agent altogether is later gateway work.",
    confirmTitle: "Give “{0}” to {1}?", confirmLead: "This is exactly what will run when {0} starts. Check it before you confirm.",
    runs: "Runs", address: "Connects to", domain: "Domain", vars: "Variables it is given", noVars: "None.", describe: "What it is for",
    headerVar: "{0} ← {1}", confirmBtn: "Confirm", confirmMount: "Confirm and give", cancel: "Cancel", saving: "Saving…", close: "Close",
    confirmNote: "Applies after {0} restarts. If the server’s definition is changed in the Library later, it is not written again until you confirm it again.",
    changedMeanwhile: "It was changed after you opened this. Review it again.", confirmFailed: "Could not save the confirmation.",
  },
  "zh-TW": {
    card: "團隊 MCP（來自資源庫）", label: "團隊 MCP server",
    tip: "從資源庫選給這個 Agent 的團隊 MCP server，和 AgEnD 自己的並用。Agent 啟動時會寫進它 CLI 的 MCP 設定，所以變更要重啟後才生效。你自己的 MCP 設定不會被動到。",
    none: "資源庫裡還沒有可用的 MCP server，請先到「資源庫」頁新增。", loadFailed: "無法讀取資源庫。", loading: "讀取資源庫中…",
    gone: "已不在資源庫", notReady: "不會交給 Agent：它在資源庫外被改過或不符規則，請到資源庫頁檢查",
    unsupported: "這個 Agent 的 CLI（{0}）暫不支援資源庫 MCP，掛上去也不會生效。",
    needsConfirm: "內容已變更，需重新確認", review: "檢視並確認",
    missing: "未啟動：缺少 {0} 的值。請在 fleet.yaml 旁的 .env 檔設定後重啟 Agent。",
    missingOne: "未啟動：缺少 {0} 的值。", varsSet: "已設定", varsMissing: "缺少",
    honest: "變數值會在 Agent 啟動時交給該 MCP server，和現在 .env 的做法相同；讓 Agent 完全拿不到密鑰是之後的閘道工作。",
    confirmTitle: "要把「{0}」交給 {1} 嗎？", confirmLead: "這就是 {0} 啟動時會執行的內容。請確認後再同意。",
    runs: "會執行", address: "會連到", domain: "網域", vars: "會交給它的變數", noVars: "沒有。", describe: "用途",
    headerVar: "{0} ← {1}", confirmBtn: "確認", confirmMount: "確認並交給它", cancel: "取消", saving: "儲存中…", close: "關閉",
    confirmNote: "{0} 重啟後生效。之後若資源庫裡這個 server 的定義被改動，要再確認一次才會重新寫入。",
    changedMeanwhile: "你打開之後它被改過了，請重新檢視。", confirmFailed: "無法儲存確認。",
  },
});
const lw = (key, ...values) => t(`libraryMcp.${key}`, ...values);
export const libraryMcpCardTitle = () => lw("card");

/** One line a person can read: the command and each argument, quoted only where a space would blur it. */
export const commandLine = (summary) => [summary.command, ...(summary.args || [])].map((p) => (/[\s"'\\]/.test(p) || p === "" ? JSON.stringify(p) : p)).join(" ");

/** What the confirmation shows for one item: exactly what runs (a command line, or an address and its domain) and the variables it is given. */
export function McpDetails({ item }) {
  const s = item.summary;
  const vars = item.variables || [];
  return html`<div class="lib-mcp-details" data-library-mcp-details=${item.id}>
    ${item.description ? html`<div class="field"><label>${lw("describe")}</label><p>${item.description}</p></div>` : null}
    ${s && s.transport === "stdio" ? html`<div class="field"><label>${lw("runs")}</label><pre class="lib-mcp-cmd" data-library-mcp-command>${commandLine(s)}</pre></div>` : null}
    ${s && s.transport === "http" ? html`<div class="field"><label>${lw("address")}</label><pre class="lib-mcp-cmd" data-library-mcp-url>${s.url}</pre>
      <p class="note">${lw("domain")}: <strong data-library-mcp-domain>${s.host}</strong></p></div>` : null}
    <div class="field"><label>${lw("vars")}</label>
      ${vars.length ? html`<ul class="lib-mcp-vars">${vars.map((v) => html`<li key=${v.name} data-library-mcp-var=${v.name}><code>${v.name}</code> <span class=${`pill${v.set ? "" : " off"}`}>${v.set ? lw("varsSet") : lw("varsMissing")}</span></li>`)}</ul>` : html`<p class="note">${lw("noVars")}</p>`}</div>
    <p class="note">${lw("honest")}</p>
  </div>`;
}

/** The confirmation dialog of the agent's settings card. */
function ReviewDialog({ item, agent, mounted, onClose, onConfirmed }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    setBusy(true); setError("");
    try {
      const r = await fetch("/ui/library/mcp-confirm", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent, id: item.id, sha256: item.sha256 }) });
      if (r.ok) { onConfirmed(item.id); return; }
      setError(r.status === 409 ? lw("changedMeanwhile") : lw("confirmFailed"));
    } catch { setError(lw("confirmFailed")); } finally { setBusy(false); }
  };
  return html`<${Dialog} title=${lw("confirmTitle", item.id, agent)} onClose=${onClose} busy=${busy} wide=${true}
    actions=${html`<button type="button" class="btn" onClick=${onClose} disabled=${busy}>${lw("cancel")}</button>
      <button type="button" class="btn btn-primary" onClick=${submit} disabled=${busy} data-library-mcp-confirm>${busy ? lw("saving") : lw(mounted ? "confirmBtn" : "confirmMount")}</button>`}>
    <div class="form" data-library-mcp-review=${item.id}>
      <p class="note">${lw("confirmLead", agent)}</p>
      <${McpDetails} item=${item} agent=${agent} />
      <p class="note">${lw("confirmNote", agent)}</p>
      ${error ? html`<p class="feedback error" role="alert" data-library-error>${error}</p>` : null}
    </div>
  </${Dialog}>`;
}

/** `m`: useAgentForm's result (its `f.library_mcp`, `set`, `name`). `L`: the label maker of the fields around it (AgentFields'). */
export function LibraryMcpField({ m, L }) {
  const { f, set, name } = m;
  const [state, setState] = useState({ loading: true });
  const [review, setReview] = useState(null);
  const box = useRef(null);
  const load = useCallback(() => {
    let live = true;
    fetch(`/ui/library/mcp-status?agent=${encodeURIComponent(name)}`, { credentials: "same-origin", cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data) => { if (live) setState({ items: Array.isArray(data && data.items) ? data.items.filter((i) => i && typeof i.id === "string") : [], backends: Array.isArray(data && data.backends) ? data.backends : null }); }, () => { if (live) setState({ error: true }); });
    return () => { live = false; };
  }, [name]);
  useEffect(() => load(), [load]);
  // The Library's agent tags link here (`…?cat=work#library-mcp`): bring the card into view once it is drawn.
  useEffect(() => {
    if (typeof location === "undefined" || location.hash !== "#library-mcp" || !box.current || typeof box.current.scrollIntoView !== "function") return;
    box.current.scrollIntoView({ block: "center" });
  }, []);
  const chosen = f.library_mcp || [];
  const listed = (state.items || []).filter((i) => i.kind === undefined || i.kind === "mcp");
  // A server the agent has but the Library does not list (deleted there) stays visible, so it can be unticked.
  const rows = [...listed, ...chosen.filter((id) => !listed.some((s) => s.id === id)).map((id) => ({ id, description: "", status: "missing", confirmed: false }))];
  // The server says which CLIs take library MCP (the table in src/library/mcp-support.ts); until it has, nothing is claimed.
  const unsupported = !!state.backends && !!f.backend && !state.backends.includes(f.backend);
  const pickable = (s) => (s.status === "ok" && !!s.summary) || chosen.includes(s.id);
  const untick = (id) => set("library_mcp")(chosen.filter((x) => x !== id));
  const tick = (id) => set("library_mcp")([...chosen.filter((x) => x !== id), id]);
  const toggle = (item, on) => {
    if (!on) { untick(item.id); return; }
    // Confirmed for this agent at this very version: nothing new to show. Otherwise the person sees what it runs first.
    if (item.confirmed) tick(item.id); else setReview(item);
  };
  const confirmed = (id) => { setReview(null); tick(id); load(); };
  const reconfirmed = () => { setReview(null); load(); };
  const missingOf = (s) => (s.variables || []).filter((v) => !v.set).map((v) => v.name);
  return html`<div class="field" data-library-mcp-field ref=${box}>${L(lw("label"), "instance.library", undefined, lw("tip"))}
    ${unsupported ? html`<p class="feedback warning" role="note" data-library-mcp-unsupported>${lw("unsupported", f.backend)}</p>` : null}
    ${state.loading ? html`<p class="note">${lw("loading")}</p>` : null}
    ${state.error && !rows.length ? html`<p class="note">${lw("loadFailed")}</p>` : null}
    ${!state.loading && !state.error && !rows.length ? html`<p class="note">${lw("none")}</p>` : null}
    ${rows.map((s) => {
      const on = chosen.includes(s.id);
      const miss = on ? missingOf(s) : [];
      const changed = on && s.status === "ok" && s.summary && !s.confirmed;
      return html`<div key=${s.id} class="lib-mcp-row" data-library-mcp=${s.id}>
        <label class="check">
          <input type="checkbox" disabled=${!pickable(s) || (unsupported && !on)} checked=${on} onChange=${(e) => toggle(s, e.target.checked)} />
          <span><span class="strong">${s.id}</span>${s.description ? html` — ${s.description}` : null}${s.status === "missing" ? html` <span class="note">(${lw("gone")})</span>` : s.status !== "ok" ? html` <span class="note">(${lw("notReady")})</span>` : null}</span></label>
        ${miss.length ? html`<p class="feedback warning lib-mcp-sub" role="note" data-library-mcp-missing=${miss.join(",")}>${miss.length === 1 ? lw("missingOne", miss[0]) : lw("missing", miss.join(", "))}</p>` : null}
        ${changed ? html`<p class="lib-mcp-sub"><span class="pill off" data-library-mcp-changed>${lw("needsConfirm")}</span> <button type="button" class="btn btn-sm" onClick=${() => setReview(s)} data-library-mcp-review-open>${lw("review")}</button></p>` : null}
      </div>`;
    })}
    ${rows.length ? html`<p class="note">${lw("honest")}</p>` : null}
    ${review ? html`<${ReviewDialog} item=${review} agent=${name} mounted=${chosen.includes(review.id)} onClose=${() => setReview(null)} onConfirmed=${chosen.includes(review.id) ? reconfirmed : confirmed} />` : null}</div>`;
}
