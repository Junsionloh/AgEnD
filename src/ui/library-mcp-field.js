// AGEND-261: the "MCP servers" card of an agent's settings (Settings → agent → Workspace, under "Skills"). It lists what the agent has switched on —
// AgEnD's own `agend` server as one "built in · automatic" line that opens to a read-only list, and the Library's MCP servers that are enabled,
// each with a × and what is wrong with it (no value for a variable, changed since it was confirmed) — and a "+ Add" in its title row opens the
// picker of the Library's servers that are not enabled yet (src/ui/library-card.js has the shared parts). Reading one in the picker shows exactly
// what it would run and the variables it needs, and "Enable" is also the confirmation: it records that version for this agent
// (POST /ui/library/mcp-confirm) and then adds the id to the form. An enabled server that is edited afterwards asks to be confirmed again here.
// The agent gets the server in its CLI's MCP config at its next start (src/library/mcp-mount.ts): a server with a variable that has no value in
// `.env` is NOT started, and its row says which variable is missing. Values are never shown here — the server sends names only
// (GET /ui/library/mcp-status).
//
// The words live in a module of their own, registered with the card (as library-mount-field.js does), so a tab opened before an upgrade never
// shows a raw key. Nothing here writes settings: the enabled ids become the `library.mcp` value of the agent's patch (settings-model.js).
import { html, useCallback, useEffect, useRef, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import { Dialog } from "/assets/ui-dialog.js";
import { builtinFor } from "./library-mount-field.js";
import { AddDialog, AssignedControls, AssignedHeader, BuiltinSection, EmptyList, ItemList, LibraryCardShell, ListRow, cardWords, keepSavedOrder } from "./library-card.js";

register("libraryMcp", {
  en: {
    card: "MCP servers",
    tip: "The MCP servers this agent gets: the ones assigned to it from the Library, and AgEnD’s own, given automatically. Library servers are written into the agent’s CLI MCP config when the agent starts, so a change applies after a restart. Your own MCP settings are not touched.",
    agendHint: "AgEnD’s own tools, by this agent’s tool set.",
    empty: "No Library MCP servers assigned yet.",
    none: "The Library has no usable MCP server yet. Add one on the Library page.", allOn: "Every MCP server in the Library is already enabled.",
    loadFailed: "Could not read the Library.", loading: "Reading the Library…",
    gone: "Not in the Library any more", notReady: "Not given: it was changed outside the Library or breaks a rule — check it on the Library page",
    unsupported: "This agent’s CLI ({0}) does not support Library MCP servers yet, so they do not take effect on it.", unsupportedAdd: "This agent’s CLI does not support Library MCP servers yet.",
    pickerTitle: "Add an MCP server", filter: "Filter MCP servers",
    needsConfirm: "Changed — confirm again", review: "Review and confirm",
    missing: "Not started: no value for {0}. Set it in the .env file next to fleet.yaml and restart the agent.",
    missingOne: "Not started: no value for {0}.", varsSet: "set", varsMissing: "missing",
    badVars: "Not given: variable {0} does not follow the MCP_ rule (names must start with MCP_).", seenAs: "the server sees it as {0}", sentAs: "sent as the {0} header",
    honest: "A variable’s value is handed to its MCP server when the agent starts, the same as today’s .env approach. Keeping the keys away from the agent altogether is later gateway work.",
    confirmTitle: "Give “{0}” to {1}?", confirmLead: "This is exactly what will run when {0} starts. Check it before you confirm.",
    enableLead: "This is exactly what will run when {0} starts. Enabling it confirms this version for {0}.",
    runs: "Runs", address: "Connects to", domain: "Domain", vars: "Variables it is given", noVars: "None.", describe: "What it is for",
    confirmBtn: "Confirm", cancel: "Cancel", saving: "Saving…", close: "Close",
    confirmNote: "Applies after {0} restarts. If the server’s definition is changed in the Library later, it is not written again until you confirm it again.",
    changedMeanwhile: "It was changed after you opened this. Review it again.", confirmFailed: "Could not save the confirmation.",
  },
  "zh-TW": {
    card: "MCP servers",
    tip: "這個 Agent 會拿到的 MCP server：你從資源庫指派給它的，以及 AgEnD 自己的（自動帶入）。資源庫的 server 會在 Agent 啟動時寫進它 CLI 的 MCP 設定，所以變更要重啟後才生效。你自己的 MCP 設定不會被動到。",
    agendHint: "AgEnD 自己的工具，依這個 Agent 的工具組。",
    empty: "還沒有指派資源庫的 MCP server。",
    none: "資源庫裡還沒有可用的 MCP server，請先到「資源庫」頁新增。", allOn: "資源庫的 MCP server 都已經啟用了。",
    loadFailed: "無法讀取資源庫。", loading: "讀取資源庫中…",
    gone: "已不在資源庫", notReady: "不會交給 Agent：它在資源庫外被改過或不符規則，請到資源庫頁檢查",
    unsupported: "這個 Agent 的 CLI（{0}）暫不支援資源庫 MCP，啟用了也不會生效。", unsupportedAdd: "這個 Agent 的 CLI 暫不支援資源庫 MCP。",
    pickerTitle: "新增 MCP server", filter: "篩選 MCP server",
    needsConfirm: "內容已變更，需重新確認", review: "檢視並確認",
    missing: "未啟動：缺少 {0} 的值。請在 fleet.yaml 旁的 .env 檔設定後重啟 Agent。",
    missingOne: "未啟動：缺少 {0} 的值。", varsSet: "已設定", varsMissing: "缺少",
    badVars: "不會交給 Agent：變數 {0} 不符合 MCP_ 規則（名稱需以 MCP_ 開頭）。", seenAs: "MCP 那邊的名稱：{0}", sentAs: "以 {0} 標頭送出",
    honest: "變數值會在 Agent 啟動時交給該 MCP server，和現在 .env 的做法相同；讓 Agent 完全拿不到密鑰是之後的閘道工作。",
    confirmTitle: "要把「{0}」交給 {1} 嗎？", confirmLead: "這就是 {0} 啟動時會執行的內容。請確認後再同意。",
    enableLead: "這就是 {0} 啟動時會執行的內容。啟用即表示替 {0} 確認這個版本。",
    runs: "會執行", address: "會連到", domain: "網域", vars: "會交給它的變數", noVars: "沒有。", describe: "用途",
    confirmBtn: "確認", cancel: "取消", saving: "儲存中…", close: "關閉",
    confirmNote: "{0} 重啟後生效。之後若資源庫裡這個 server 的定義被改動，要再確認一次才會重新寫入。",
    changedMeanwhile: "你打開之後它被改過了，請重新檢視。", confirmFailed: "無法儲存確認。",
  },
});
const lw = (key, ...values) => t(`libraryMcp.${key}`, ...values);
export const libraryMcpCardTitle = () => lw("card");
export const libraryMcpCardTip = () => lw("tip");

/** One line a person can read: the command and each argument, quoted only where a space would blur it. */
export const commandLine = (summary) => [summary.command, ...(summary.args || [])].map((p) => (/[\s"'\\]/.test(p) || p === "" ? JSON.stringify(p) : p)).join(" ");

/** What the confirmation shows for one item: exactly what runs (a command line, or an address and its domain) and the variables it is given. */
export function McpDetails({ item }) {
  const s = item.summary;
  const vars = item.variables || [];
  return html`<div class="form lib-mcp-details" data-library-mcp-details=${item.id}>
    ${item.description ? html`<div class="field"><label>${lw("describe")}</label><p>${item.description}</p></div>` : null}
    ${s && s.transport === "stdio" ? html`<div class="field"><label>${lw("runs")}</label><pre class="lib-mcp-cmd" data-library-mcp-command>${commandLine(s)}</pre></div>` : null}
    ${s && s.transport === "http" ? html`<div class="field"><label>${lw("address")}</label><pre class="lib-mcp-cmd" data-library-mcp-url>${s.url}</pre>
      <p class="note">${lw("domain")}: <strong data-library-mcp-domain>${s.host}</strong></p></div>` : null}
    <div class="field"><label>${lw("vars")}</label>
      ${vars.length ? html`<ul class="lib-mcp-vars">${vars.map((v) => html`<li key=${v.name} data-library-mcp-var=${v.name}><code>${v.name}</code> <span class=${`pill${v.set ? "" : " off"}`}>${v.set ? lw("varsSet") : lw("varsMissing")}</span>${(v.as || []).filter((a) => a.kind === "header" || a.name !== v.name).map((a) => html` <span class="note" key=${a.name} data-library-mcp-as=${a.name}>→ ${a.kind === "header" ? lw("sentAs", a.name) : lw("seenAs", a.name)}</span>`)}</li>`)}</ul>` : html`<p class="note">${lw("noVars")}</p>`}</div>
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
      <button type="button" class="btn btn-primary" onClick=${submit} disabled=${busy} data-library-mcp-confirm>${busy ? lw("saving") : lw("confirmBtn")}</button>`}>
    <div class="form" data-library-mcp-review=${item.id}>
      <p class="note">${lw("confirmLead", agent)}</p>
      <${McpDetails} item=${item} agent=${agent} />
      <p class="note">${lw("confirmNote", agent)}</p>
      ${error ? html`<p class="feedback error" role="alert" data-library-error>${error}</p>` : null}
    </div>
  </${Dialog}>`;
}

/** `m`: useAgentForm's result (its `f.library_mcp`, `f.library_paused`, `set`, `setF`, `name`). `title`: the card's title node (settings-dialogs.js builds it with the usual tip and restart badge). */
export function LibraryMcpCard({ m, title }) {
  const { f, setF, name } = m;
  const [state, setState] = useState({ loading: true });
  const [review, setReview] = useState(null);
  const [adding, setAdding] = useState(false);
  // What this agent gets by itself (AgEnD's own server), from the overview; read apart so the card still lists the library's without it.
  const [builtin, setBuiltin] = useState([]);
  useEffect(() => {
    let live = true;
    fetch("/ui/library/overview", { credentials: "same-origin", cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data) => { if (live) setBuiltin(builtinFor(Array.isArray(data && data.mcp) ? data.mcp.map((x) => ({ ...x, description: lw("agendHint") })) : [], name)); }, () => {});
    return () => { live = false; };
  }, [name]);
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
    if (typeof location === "undefined" || location.hash !== "#library-mcp" || !box.current || typeof box.current.scrollIntoView !== "function") return undefined;
    // The cards above and below fill in as their lists arrive and move this one: look again once they have (and after the last of them).
    const again = setTimeout(() => { if (box.current) box.current.scrollIntoView({ block: "center" }); }, 400);
    box.current.scrollIntoView({ block: "center" });
    return () => clearTimeout(again);
  }, [state.loading, builtin.length]);
  const active = f.library_mcp || [];
  const paused = (f.library_paused && f.library_paused.mcp) || [];
  const listed = (state.items || []).filter((i) => i.kind === undefined || i.kind === "mcp");
  // On = in `library.mcp`; paused = in `library.paused.mcp` (assigned, not written). One place changes both lists, from the form's latest state.
  const apply = (nextActive, nextPaused) => setF((x) => ({ ...x, library_mcp: keepSavedOrder(m.inst && m.inst.library && m.inst.library.mcp, nextActive), library_paused: { skills: [], mcp: [], ...(x.library_paused || {}), mcp: nextPaused } }));
  const without = (list, id) => list.filter((x) => x !== id);
  const toggle = (id, on) => (on ? apply([...without(active, id), id], without(paused, id)) : apply(without(active, id), [...without(paused, id), id]));
  const remove = (id) => apply(without(active, id), without(paused, id));
  // Everything assigned, in one stable order. A server the agent has but the Library does not list (deleted there) stays, so it can be removed.
  const assigned = [...new Set([...active, ...paused])].sort();
  const rows = assigned.map((id) => listed.find((s) => s.id === id) || { id, description: "", status: "missing", confirmed: false });
  // The server says which CLIs take library MCP (the table in src/library/mcp-support.ts); until it has, nothing is claimed.
  const unsupported = !!state.backends && !!f.backend && !state.backends.includes(f.backend);
  const missingOf = (s) => (s.variables || []).filter((v) => !v.set).map((v) => v.name);
  const candidates = listed.filter((s) => !assigned.includes(s.id)).map((s) => ({ ...s, disabled: !(s.status === "ok" && s.summary), note: s.badVars && s.badVars.length ? lw("badVars", s.badVars.join(", ")) : lw("notReady") }));
  const emptyPicker = state.error ? lw("loadFailed") : listed.length ? lw("allOn") : lw("none");
  // "Enable" is the confirmation: this exact version is recorded for this agent, then the id joins the form (a 409 means it changed meanwhile).
  const enable = async (item) => {
    try {
      const r = await fetch("/ui/library/mcp-confirm", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent: name, id: item.id, sha256: item.sha256 }) });
      if (!r.ok) { if (r.status === 409) load(); return { ok: false, error: r.status === 409 ? lw("changedMeanwhile") : lw("confirmFailed") }; }
    } catch { return { ok: false, error: lw("confirmFailed") }; }
    apply([...without(active, item.id), item.id], without(paused, item.id));
    load();
    return { ok: true };
  };
  return html`<${LibraryCardShell} title=${title} innerRef=${box} attrs=${{ "data-library-mcp-field": "" }}>
    <div class="lib-sec" data-library-assigned>
      <${AssignedHeader} onAdd=${() => setAdding(true)} addDisabled=${unsupported} addTitle=${unsupported ? lw("unsupportedAdd") : undefined} />
      ${unsupported ? html`<p class="feedback warning" role="note" data-library-mcp-unsupported>${lw("unsupported", f.backend)}</p>` : null}
      ${state.loading ? html`<p class="note">${lw("loading")}</p>` : null}
      ${state.error && !rows.length ? html`<p class="note">${lw("loadFailed")}</p>` : null}
      ${!state.loading && !state.error && !rows.length ? html`<${EmptyList} text=${lw("empty")} />` : null}
      ${rows.length ? html`<${ItemList}>${rows.map((s) => {
        const on = active.includes(s.id);
        // What is wrong only matters while it is on: a paused server is not written, so a missing variable or a change is not news.
        const miss = on ? missingOf(s) : [];
        const changed = on && s.status === "ok" && s.summary && !s.confirmed;
        const status = [
          s.status === "missing" ? html`<span class="note" key="g">${lw("gone")}</span>` : s.badVars && s.badVars.length ? html`<span class="feedback warning lib-mcp-sub" role="note" key="b" data-library-mcp-badvars=${s.badVars.join(",")}>${lw("badVars", s.badVars.join(", "))}</span>` : s.status !== "ok" ? html`<span class="note" key="n">${lw("notReady")}</span>` : null,
          !on ? html`<span class="note" key="p">${cardWords.paused()}</span>` : null,
          miss.length ? html`<span class="feedback warning lib-mcp-sub" role="note" key="m" data-library-mcp-missing=${miss.join(",")}>${miss.length === 1 ? lw("missingOne", miss[0]) : lw("missing", miss.join(", "))}</span>` : null,
          changed ? html`<span class="lib-mcp-sub" key="c"><span class="pill off" data-library-mcp-changed>${lw("needsConfirm")}</span> <button type="button" class="btn btn-sm" onClick=${() => setReview(s)} data-library-mcp-review-open>${lw("review")}</button></span>` : null,
        ].filter(Boolean);
        return html`<${ListRow} key=${s.id} icon="plug" name=${s.id} description=${s.description} off=${!on} attr=${{ "data-library-mcp": s.id, "data-library-on": on ? "1" : "0" }}
          status=${status.length ? status : null}
          controls=${html`<${AssignedControls} id=${s.id} on=${on} onToggle=${(v) => toggle(s.id, v)} onRemove=${() => remove(s.id)} />`} />`;
      })}</${ItemList}>` : null}
      ${rows.length ? html`<p class="note">${lw("honest")}</p>` : null}
    </div>
    <${BuiltinSection} items=${builtin} attr="data-library-builtin-mcp" icon="plug" />
    ${adding ? html`<${AddDialog} title=${lw("pickerTitle")} items=${candidates} filterLabel=${lw("filter")} emptyText=${emptyPicker} onClose=${() => setAdding(false)} onEnable=${enable}
      renderPreview=${(item) => html`<div class="form"><p class="note">${lw("enableLead", name)}</p><${McpDetails} item=${item} agent=${name} /><p class="note">${lw("confirmNote", name)}</p></div>`} />` : null}
    ${review ? html`<${ReviewDialog} item=${review} agent=${name} mounted=${true} onClose=${() => setReview(null)} onConfirmed=${() => { setReview(null); load(); }} />` : null}
  </${LibraryCardShell}>`;
}
