// AGEND-243 / AGEND-248: the Library (/ui/library) — an OVERVIEW of what this AgEnD has: skills, tools and MCP servers, and which agents use
// them. Three cards (Skills, Tools, MCP servers), each one box holding its title and its rows. What AgEnD ships (the built-in skills, the
// tool sets and its own `agend` MCP server) is read only and comes from GET /ui/library/overview (src/library/overview.ts, which only
// reads); what the team adds is the AGEND-243 library: GET /ui/library/list, POST /ui/library/save and /delete (src/library/web.ts, which
// hold all the rules — this page only shows what they answer). "Used by" is read from the existing settings, so the page changes no agent.
// Admin only: a session without that is told so.
import { html, useCallback, useEffect, useState } from "/assets/app-html.js";
import { t, register } from "/assets/app-i18n.js";
import { useLease } from "/assets/app-ctx.js";
import { PanelHeader, setTitle } from "/assets/app-shell.js";
import { Empty, ErrorState, Skeleton } from "/assets/ui-states.js";
import { Dialog } from "/assets/ui-dialog.js";
import { confirmDialog } from "/assets/ui-confirm.js";
import { toast } from "/assets/ui-toast.js";
import { Icon } from "/assets/ui-icons.js";

register("library", {
  en: {
    title: "Library", sub: "An overview of what this AgEnD has: skills, tools and MCP servers, and which agents use them. Built-in items come with AgEnD and are read only. Team items are the ones you add here; give a team skill to an agent in Settings → the agent → Workspace. This page changes no agent.",
    skills: "Skills", tools: "Tools", mcp: "MCP servers",
    teamGroup: "Added by your team", teamSkillsLead: "Skills you added. Give one to an agent in Settings → the agent → Workspace.", teamMcpLead: "MCP server definitions you added. They are kept here and are not given to agents yet.",
    builtinSkillsGroup: "Built in · read only", builtinSkillsLead: "Skills that come with AgEnD. Each is given to agents by their role.",
    builtinToolsGroup: "Built in · read only", builtinToolsLead: "A tool set is the list of AgEnD tools an agent may use. An agent’s `tool_set` setting picks one.",
    builtinMcpGroup: "Built in · read only", builtinMcpLead: "AgEnD’s own MCP server.",
    builtin: "Built in", team: "Team",
    role_general: "General", role_worker: "Workers", role_classic: "Classic bots", givenTo: "Given to",
    usedBy: "Used by", noUse: "No agent uses it", usedByAll: "Every agent",
    toolsCount: "{0} tools", toolsShow: "Show the tools", noTools: "No tools",
    ts_full: "Every tool.", ts_worker: "Everything an agent needs to do the work; nothing that runs the fleet.", ts_coordinator: "The worker tools plus the tools that run the fleet.",
    ts_general: "For the General, the fleet’s administrator.", ts_standard: "A smaller everyday set.", ts_minimal: "Reply and message only.",
    agendMcp: "agend", agendMcpHint: "Gives each agent the tools of its tool set.",
    noFolder: "{0}: its CLI ({1}) has no skills folder, so this skill does not take effect there.",
    overviewFailed: "Could not read the built-in skills and tools.", overviewRetry: "Try again",
    addSkill: "Add skill", addMcp: "Add MCP server", add: "Add", view: "View", delete: "Delete", close: "Close", cancel: "Cancel", save: "Save", saving: "Saving…",
    emptyHint: "Add a skill (a SKILL.md with a name and a description) or an MCP server definition. Passwords and keys never go in: an MCP item only names the variables it needs.",
    noneSkills: "No team skills yet.", noneMcp: "No team MCP servers yet.", noneHint: "Add one with the button above.",
    files: "{0} files", file1: "1 file", bytes: "{0} KB",
    st_ok: "", st_modified: "Changed by hand", st_untracked: "Not recorded", st_missing: "Missing", st_invalid: "Not usable",
    hint_modified: "The files no longer match the recorded hash.", hint_untracked: "Found in the library folder but not added through this page.", hint_missing: "Recorded, but the files are gone.",
    src_local: "Added here", src_import: "Imported",
    hash: "Hash", source: "Source", updated: "Updated",
    newSkillTitle: "Add a skill", newMcpTitle: "Add an MCP server",
    idLabel: "Name", idHint: "Lowercase letters, digits and dashes (up to 64). It is the folder or file name, and the `name` inside.",
    skillMdLabel: "SKILL.md", mcpLabel: "MCP server file (YAML)",
    skillTemplate: "---\nname: {0}\ndescription: Say what this skill does and when to use it.\n---\n\n# {0}\n\nSteps…\n",
    mcpTemplate: "agend_library: 1\nkind: mcp\nname: {0}\ndescription: What this server does\ntransport: stdio\ncommand: npx\nargs:\n  - -y\n  - some-mcp-server\n# The variables the server reads — names only, never values.\nenv:\n  - EXAMPLE_API_TOKEN\n",
    replaceTitle: "Replace “{0}”?", replaceBody: "A {1} named “{0}” is already in the library. Saving replaces it completely.", replace: "Replace",
    deleteTitle: "Delete “{0}”?", deleteBody: "It is removed from the library. Nothing else changes.", deleteBodyUsed: "It is removed from the library. {0} still have it mounted and lose it the next time they start.", deleted: "Deleted “{0}”.", saved: "Saved “{0}”.",
    loadFailed: "Could not load the library.", saveFailed: "Could not save.", deleteFailed: "Could not delete.",
    adminOnly: "The library is for an administrator.",
    e_invalid_id: "The name must be lowercase letters, digits and dashes, starting with a letter or digit (up to 64).",
    e_invalid_path: "That file path is not allowed: {0}", e_duplicate_path: "Two files have the same path: {0}", e_missing_skill_md: "A skill needs a SKILL.md.",
    e_bad_frontmatter: "SKILL.md must start with a --- block holding name and description.", e_name_mismatch: "The `name` inside must be the same as the name above.",
    e_missing_description: "SKILL.md needs a description.", e_too_large: "That is too large for the library.", e_too_many_files: "Too many files.",
    e_not_text: "Only text files can be kept.", e_exists: "That name is already in use.", e_not_found: "It is not in the library.", e_too_many_items: "The library is full.",
    e_invalid_yaml: "That is not valid YAML.", e_bad_mcp: "The MCP file has a problem in “{0}”. Variables are listed by name only; an address may not hold a password or a query.",
    e_secret_found: "Something here looks like a secret ({0}). Remove it first: the library keeps no keys or passwords.", e_unsafe_item: "That item cannot be read safely.", e_invalid_request: "The request was not valid.",
    secretAt: "{0}, line {1}",
  },
  "zh-TW": {
    title: "資源庫", sub: "這一頁是總覽：這個 AgEnD 有哪些 Skill、工具和 MCP server，以及哪些 Agent 正在使用。內建項目隨 AgEnD 附帶，唯讀；團隊項目是你在這裡新增的，要給某個 Agent 請到「設定 → 該 Agent → 工作區」。這一頁不會改變任何 Agent。",
    skills: "Skills", tools: "工具", mcp: "MCP server",
    teamGroup: "團隊新增", teamSkillsLead: "你新增的 Skill。要給 Agent 請到「設定 → 該 Agent → 工作區」。", teamMcpLead: "你新增的 MCP server 定義。目前只存放在這裡，還不會交給 Agent。",
    builtinSkillsGroup: "內建・唯讀", builtinSkillsLead: "隨 AgEnD 附帶的 Skill，依 Agent 的角色自動帶入。",
    builtinToolsGroup: "內建・唯讀", builtinToolsLead: "工具組是 Agent 可以使用的 AgEnD 工具清單，由 Agent 的 `tool_set` 設定選擇。",
    builtinMcpGroup: "內建・唯讀", builtinMcpLead: "AgEnD 自己的 MCP server。",
    builtin: "內建", team: "團隊",
    role_general: "General", role_worker: "一般 Agent", role_classic: "Classic bot", givenTo: "適用",
    usedBy: "使用中", noUse: "目前沒有 Agent 使用", usedByAll: "所有 Agent",
    toolsCount: "{0} 個工具", toolsShow: "顯示工具清單", noTools: "沒有工具",
    ts_full: "所有工具。", ts_worker: "做事所需的一切，不含管理 fleet 的工具。", ts_coordinator: "一般工具，加上管理 fleet 的工具。",
    ts_general: "給 General（fleet 的管理員）。", ts_standard: "較精簡的日常組合。", ts_minimal: "只能回覆與傳訊息。",
    agendMcp: "agend", agendMcpHint: "把各 Agent 所屬工具組的工具交給它。",
    noFolder: "{0}：它的 CLI（{1}）沒有 skill 資料夾，這個 Skill 在那裡不會生效。",
    overviewFailed: "無法讀取內建的 Skill 和工具。", overviewRetry: "重試",
    addSkill: "新增 Skill", addMcp: "新增 MCP server", add: "新增", view: "檢視", delete: "刪除", close: "關閉", cancel: "取消", save: "儲存", saving: "儲存中…",
    emptyHint: "新增一個 Skill（含名稱與說明的 SKILL.md）或 MCP server 定義。密碼和金鑰不會存進來：MCP 項目只記它需要哪些變數的名稱。",
    noneSkills: "還沒有團隊 Skill。", noneMcp: "還沒有團隊 MCP server。", noneHint: "用上面的按鈕新增。",
    files: "{0} 個檔案", file1: "1 個檔案", bytes: "{0} KB",
    st_ok: "", st_modified: "被手動改過", st_untracked: "未記錄", st_missing: "檔案不見了", st_invalid: "無法使用",
    hint_modified: "檔案內容和記錄的雜湊不一致。", hint_untracked: "在資源庫資料夾裡，但不是從這個頁面加入的。", hint_missing: "有記錄，但檔案已經不在了。",
    src_local: "在這裡新增", src_import: "匯入",
    hash: "雜湊", source: "來源", updated: "更新時間",
    newSkillTitle: "新增 Skill", newMcpTitle: "新增 MCP server",
    idLabel: "名稱", idHint: "小寫英文、數字和連字號（最多 64 字）。它是資料夾或檔案名稱，也是檔案內的 `name`。",
    skillMdLabel: "SKILL.md", mcpLabel: "MCP server 檔案（YAML）",
    skillTemplate: "---\nname: {0}\ndescription: 說明這個 skill 做什麼、什麼時候用。\n---\n\n# {0}\n\n步驟…\n",
    mcpTemplate: "agend_library: 1\nkind: mcp\nname: {0}\ndescription: 這個 server 做什麼\ntransport: stdio\ncommand: npx\nargs:\n  - -y\n  - some-mcp-server\n# server 會讀的變數——只寫名稱，不寫值。\nenv:\n  - EXAMPLE_API_TOKEN\n",
    replaceTitle: "要取代「{0}」嗎？", replaceBody: "資源庫裡已經有一個叫「{0}」的 {1}。儲存會整個取代它。", replace: "取代",
    deleteTitle: "要刪除「{0}」嗎？", deleteBody: "它會從資源庫移除，其他都不變。", deleteBodyUsed: "它會從資源庫移除。{0} 還掛著它，下次啟動時會失去這個 Skill。", deleted: "已刪除「{0}」。", saved: "已儲存「{0}」。",
    loadFailed: "無法載入資源庫。", saveFailed: "無法儲存。", deleteFailed: "無法刪除。",
    adminOnly: "資源庫只有管理員可以使用。",
    e_invalid_id: "名稱只能是小寫英文、數字和連字號，開頭要是英文或數字（最多 64 字）。",
    e_invalid_path: "這個檔案路徑不允許：{0}", e_duplicate_path: "有兩個檔案路徑相同：{0}", e_missing_skill_md: "Skill 需要一個 SKILL.md。",
    e_bad_frontmatter: "SKILL.md 開頭必須有 --- 區塊，寫上 name 和 description。", e_name_mismatch: "裡面的 `name` 必須和上面的名稱相同。",
    e_missing_description: "SKILL.md 需要 description。", e_too_large: "太大了，資源庫放不下。", e_too_many_files: "檔案太多。",
    e_not_text: "只能存文字檔。", e_exists: "這個名稱已經有人用了。", e_not_found: "資源庫裡沒有這一項。", e_too_many_items: "資源庫已滿。",
    e_invalid_yaml: "這不是有效的 YAML。", e_bad_mcp: "MCP 檔案的「{0}」有問題。變數只能寫名稱；網址不能含密碼或查詢字串。",
    e_secret_found: "這裡有東西看起來像密鑰（{0}）。請先移除：資源庫不存金鑰或密碼。", e_unsafe_item: "這一項無法安全讀取。", e_invalid_request: "請求不正確。",
    secretAt: "{0}，第 {1} 行",
  },
});
const tn = (k, ...v) => t(`library.${k}`, ...v);

/** An error answer → the words for it. */
export function libraryErrorText(body, fallbackKey) {
  if (!body || typeof body.error !== "string") return tn(fallbackKey);
  const key = `e_${body.error}`;
  const known = t(`library.${key}`) !== `library.${key}`;
  if (!known) return tn(fallbackKey);
  if (body.error === "secret_found") {
    const at = Array.isArray(body.findings) ? body.findings.slice(0, 3).map((f) => tn("secretAt", f.field, f.line)).join("; ") : "";
    return tn(key, at);
  }
  return tn(key, body.path || body.detail || "");
}

async function call(path, body) {
  const init = body === undefined ? { credentials: "same-origin", cache: "no-store" }
    : { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  const r = await fetch(path, init);
  let data = null;
  try { data = await r.json(); } catch { /* not JSON */ }
  return { ok: r.ok, status: r.status, data };
}

const kb = (n) => Math.max(1, Math.round((n || 0) / 1024));

/** Add: one dialog for both kinds. A name already in use asks before it replaces. */
function AddDialog({ kind, existing, onClose, onSaved }) {
  const [id, setId] = useState("");
  const [text, setText] = useState(() => tn(kind === "skill" ? "skillTemplate" : "mcpTemplate", "my-item"));
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // The template carries the name; until the text is edited by hand it follows the name field.
  const rename = (next) => { setId(next); if (!touched) setText(tn(kind === "skill" ? "skillTemplate" : "mcpTemplate", next || "my-item")); };
  const submit = async () => {
    setError("");
    const taken = existing.has(id);
    if (taken && !(await confirmDialog({ title: tn("replaceTitle", id), message: tn("replaceBody", id, kind === "skill" ? "skill" : "MCP"), confirmLabel: tn("replace"), danger: true }))) return;
    setBusy(true);
    try {
      const payload = kind === "skill" ? { kind, id, files: [{ path: "SKILL.md", content: text }], overwrite: taken } : { kind, id, text, overwrite: taken };
      const r = await call("/ui/library/save", payload);
      if (r.ok) { toast(tn("saved", id)); onSaved(); onClose(); } else setError(libraryErrorText(r.data, "saveFailed"));
    } catch { setError(tn("saveFailed")); } finally { setBusy(false); }
  };
  return html`<${Dialog} title=${tn(kind === "skill" ? "newSkillTitle" : "newMcpTitle")} onClose=${onClose} busy=${busy} wide=${true}
    actions=${html`<button type="button" class="btn" onClick=${onClose} disabled=${busy}>${tn("cancel")}</button>
      <button type="button" class="btn btn-primary" onClick=${submit} disabled=${busy || !id} data-library-save>${busy ? tn("saving") : tn("save")}</button>`}>
    <div class="form">
      <div class="field"><label for="library-id">${tn("idLabel")}</label>
        <input id="library-id" type="text" value=${id} maxlength="64" autocomplete="off" autocapitalize="none" spellcheck=${false} data-library-id onInput=${(e) => rename(e.target.value.trim())} />
        <span class="note">${tn("idHint")}</span></div>
      <div class="field"><label for="library-text">${tn(kind === "skill" ? "skillMdLabel" : "mcpLabel")}</label>
        <textarea id="library-text" rows="14" spellcheck=${false} value=${text} data-library-text onInput=${(e) => { setTouched(true); setText(e.target.value); }} /></div>
      ${error ? html`<p class="feedback error" role="alert" data-library-error>${error}</p>` : null}
    </div>
  </${Dialog}>`;
}

/** View: the item as stored — a skill's files, or the MCP file. Read only. */
function ViewDialog({ item, onClose }) {
  const [state, setState] = useState({ loading: true });
  useEffect(() => {
    let live = true;
    call(`/ui/library/item?kind=${item.kind}&id=${encodeURIComponent(item.id)}`).then((r) => {
      if (live) setState(r.ok && r.data && r.data.detail ? { detail: r.data.detail } : { error: libraryErrorText(r.data, "loadFailed") });
    }, () => { if (live) setState({ error: tn("loadFailed") }); });
    return () => { live = false; };
  }, [item.kind, item.id]);
  const d = state.detail;
  const files = d && d.kind === "skill" ? d.files : d ? [{ path: `${d.id}.yaml`, content: d.text }] : [];
  return html`<${Dialog} title=${item.id} onClose=${onClose} wide=${true} actions=${html`<button type="button" class="btn" onClick=${onClose}>${tn("close")}</button>`}>
    <div class="form">
      ${state.loading ? html`<${Skeleton} lines=${3} />` : null}
      ${state.error ? html`<p class="feedback error" role="alert">${state.error}</p>` : null}
      ${d ? html`<p class="note">${tn("hash")}: <code>${d.sha256.slice(0, 16)}…</code>${item.updatedAt ? html` · ${tn("updated")}: ${new Date(item.updatedAt).toLocaleString()}` : null}</p>` : null}
      ${files.map((f) => html`<div class="field" key=${f.path}><label>${f.path}</label>
        ${f.content !== undefined ? html`<textarea rows=${Math.min(14, Math.max(3, f.content.split("\n").length + 1))} readonly spellcheck=${false} value=${f.content} data-library-file=${f.path} />` : html`<p class="note">${tn("e_not_text")}</p>`}</div>`)}
    </div>
  </${Dialog}>`;
}

/** At most six names, then how many more: a fleet can have dozens of agents. */
const MAX_NAMES = 6;
const nameList = (names) => (names.length > MAX_NAMES ? `${names.slice(0, MAX_NAMES).join(", ")} +${names.length - MAX_NAMES}` : names.join(", "));

/** The agents that use an item, or that none does. */
function UsedBy({ names, extra }) {
  return html`<div class="note" data-library-used-by>${names.length ? html`${tn("usedBy")}: ${nameList(names)}` : tn("noUse")}${extra ? html` · ${extra}` : null}</div>`;
}

/** A team item's row: what it is, who uses it (skills), and View / Delete. */
function Row({ item, used, unsupported, onView, onDelete }) {
  const meta = item.kind === "skill" && item.files ? (item.files === 1 ? tn("file1") : tn("files", item.files)) : item.size ? tn("bytes", kb(item.size)) : "";
  const hint = tn(`hint_${item.status}`);
  const hasHint = hint !== "library.hint_" + item.status;
  return html`<div class=${`row-item${item.status === "ok" && !unsupported.length ? "" : " is-warn"}`} data-library-item=${`${item.kind}:${item.id}`}>
    <${Icon} name=${item.kind === "skill" ? "book" : "plug"} size=${18} />
    <div class="grow"><span class="strong">${item.id}</span>${item.description ? html`<div class="note">${item.description}</div>` : null}
      ${item.status === "invalid" && item.reason ? html`<div class="note">${item.reason}</div>` : null}
      ${hasHint ? html`<div class="note">${hint}</div>` : null}
      ${used ? html`<${UsedBy} names=${used} />` : null}
      ${unsupported.map((u) => html`<div class="note" key=${u.name} data-library-no-folder=${u.name}>${tn("noFolder", u.name, u.backend)}</div>`)}</div>
    ${item.status !== "ok" ? html`<span class="pill off">${tn(`st_${item.status}`)}</span>` : null}
    ${meta ? html`<span class="note">${meta}</span>` : null}
    ${item.status !== "missing" && item.status !== "invalid" ? html`<button type="button" class="btn btn-sm" onClick=${() => onView(item)} data-library-view>${tn("view")}</button>` : null}
    <button type="button" class="btn btn-sm btn-ghost" onClick=${() => onDelete(item)} data-library-delete aria-label=${`${tn("delete")} ${item.id}`}>${tn("delete")}</button>
  </div>`;
}

/** One category: a single card, its title (and Add) in the same box as its rows. */
function LibCard({ id, title, add, children }) {
  return html`<section class="card lib-card" aria-label=${title} data-library-card=${id}>
    <div class="lib-head"><h3 class="grow">${title}</h3>${add || null}</div>${children}</section>`;
}
/** A group of rows inside a card: a heading, one line saying what they are, the rows. */
function Group({ id, title, lead, children }) {
  return html`<div class="lib-group" data-library-group=${id}><h4>${title}</h4><p class="note">${lead}</p><div class="rows">${children}</div></div>`;
}
const Builtin = () => html`<span class="pill">${tn("builtin")}</span>`;

function BuiltinSkillRow({ s }) {
  return html`<div class="row-item" data-library-builtin=${`skill:${s.name}`}>
    <${Icon} name="book" size=${18} />
    <div class="grow"><span class="strong">${s.name}</span>${s.description ? html`<div class="note">${s.description}</div>` : null}
      <${UsedBy} names=${s.agents} extra=${`${tn("givenTo")}: ${s.roles.map((r) => (t(`library.role_${r}`) !== `library.role_${r}` ? tn(`role_${r}`) : r)).join(", ")}`} /></div>
    <${Builtin} /></div>`;
}
function ToolSetRow({ ts }) {
  const key = `ts_${ts.name}`, known = t(`library.${key}`) !== `library.${key}`;
  return html`<div class="row-item" data-library-builtin=${`tools:${ts.name}`}>
    <${Icon} name="sliders" size=${18} />
    <div class="grow"><span class="strong">${ts.name}</span>${known ? html`<div class="note">${tn(key)}</div>` : null}
      <${UsedBy} names=${ts.agents} />
      <details class="lib-tools"><summary class="note">${tn("toolsShow")}</summary><p class="note">${ts.tools.length ? ts.tools.join(" · ") : tn("noTools")}</p></details></div>
    <span class="note">${tn("toolsCount", ts.tools.length)}</span><${Builtin} /></div>`;
}
function McpBuiltinRow({ m }) {
  return html`<div class="row-item" data-library-builtin=${`mcp:${m.name}`}>
    <${Icon} name="plug" size=${18} />
    <div class="grow"><span class="strong">${m.name}</span><div class="note">${tn("agendMcpHint")}</div><${UsedBy} names=${m.agents} /></div>
    <${Builtin} /></div>`;
}

export function LibraryPanel({ navKey }) {
  useLease(navKey);
  const [state, setState] = useState({ loading: true });
  const [ov, setOv] = useState({ loading: true });
  const [dialog, setDialog] = useState(null);
  useEffect(() => { setTitle(tn("title")); }, [navKey]);
  const load = useCallback(async () => {
    try {
      const r = await call("/ui/library/list");
      if (r.ok && r.data && Array.isArray(r.data.items)) setState({ items: r.data.items });
      else setState({ error: r.status === 403 ? tn("adminOnly") : tn("loadFailed"), denied: r.status === 403 });
    } catch { setState({ error: tn("loadFailed") }); }
  }, []);
  // The overview is read apart from the team's list: if it cannot be read the team's items are still there to use.
  const loadOverview = useCallback(async () => {
    setOv({ loading: true });
    try {
      const r = await call("/ui/library/overview");
      setOv(r.ok && r.data && Array.isArray(r.data.builtinSkills) ? { data: r.data } : { error: true });
    } catch { setOv({ error: true }); }
  }, []);
  useEffect(() => { load(); loadOverview(); }, [load, loadOverview]);
  const data = ov.data;
  const agents = (data && data.agents) || [];
  const teamUsage = (data && data.teamUsage) || {};
  const usedBy = (item) => (item.kind === "skill" && data ? (Object.hasOwn(teamUsage, item.id) ? teamUsage[item.id] : []) : null);
  const noFolder = (item) => (usedBy(item) || []).map((n) => agents.find((a) => a.name === n)).filter((a) => a && !a.nativeSkills).map((a) => ({ name: a.name, backend: a.backend }));
  const remove = async (item) => {
    const used = usedBy(item) || [];
    const message = used.length ? tn("deleteBodyUsed", nameList(used)) : tn("deleteBody");
    if (!(await confirmDialog({ title: tn("deleteTitle", item.id), message, confirmLabel: tn("delete"), danger: true }))) return;
    try {
      const r = await call("/ui/library/delete", { kind: item.kind, id: item.id });
      if (r.ok) toast(tn("deleted", item.id)); else toast(libraryErrorText(r.data, "deleteFailed"), false);
    } catch { toast(tn("deleteFailed"), false); }
    load(); loadOverview();
  };
  const items = state.items || [];
  const skills = items.filter((i) => i.kind === "skill"), mcp = items.filter((i) => i.kind === "mcp");
  const existing = (kind) => new Set(items.filter((i) => i.kind === kind).map((i) => i.id));
  const add = (kind) => html`<button type="button" class="btn btn-sm" onClick=${() => setDialog({ type: "add", kind })} data-library-add=${kind}><${Icon} name="plus" size=${15} /> ${tn(kind === "skill" ? "addSkill" : "addMcp")}</button>`;
  const teamRows = (list, none) => (list.length
    ? list.map((i) => html`<${Row} key=${`${i.kind}:${i.id}`} item=${i} used=${usedBy(i)} unsupported=${noFolder(i)} onView=${(it) => setDialog({ type: "view", item: it })} onDelete=${remove} />`)
    : html`<${Empty} icon="book" title=${none} hint=${tn("noneHint")} />`);
  // What AgEnD ships: shown as soon as it is read; a failed read says so and the team's items stay usable.
  const builtin = (rows) => (ov.loading ? html`<${Skeleton} variant="rows" lines=${3} />`
    : ov.error ? html`<div class="error-state" role="alert"><p>${tn("overviewFailed")}</p><button type="button" class="btn" onClick=${loadOverview}>${tn("overviewRetry")}</button></div>` : rows());
  const body = () => html`
    <${LibCard} id="skills" title=${tn("skills")} add=${add("skill")}>
      <${Group} id="team-skills" title=${tn("teamGroup")} lead=${tn("teamSkillsLead")}>${teamRows(skills, tn("noneSkills"))}</${Group}>
      <${Group} id="builtin-skills" title=${tn("builtinSkillsGroup")} lead=${tn("builtinSkillsLead")}>${builtin(() => data.builtinSkills.map((s) => html`<${BuiltinSkillRow} key=${s.name} s=${s} />`))}</${Group}>
    </${LibCard}>
    <${LibCard} id="tools" title=${tn("tools")}>
      <${Group} id="builtin-tools" title=${tn("builtinToolsGroup")} lead=${tn("builtinToolsLead")}>${builtin(() => data.toolSets.map((ts) => html`<${ToolSetRow} key=${ts.name} ts=${ts} />`))}</${Group}>
    </${LibCard}>
    <${LibCard} id="mcp" title=${tn("mcp")} add=${add("mcp")}>
      <${Group} id="team-mcp" title=${tn("teamGroup")} lead=${tn("teamMcpLead")}>${teamRows(mcp, tn("noneMcp"))}</${Group}>
      <${Group} id="builtin-mcp" title=${tn("builtinMcpGroup")} lead=${tn("builtinMcpLead")}>${builtin(() => data.mcp.map((m) => html`<${McpBuiltinRow} key=${m.name} m=${m} />`))}</${Group}>
    </${LibCard}>`;
  return html`<div data-effect-panel="library" class="panel p-library">
    <${PanelHeader} title=${tn("title")} />
    <div data-trust="panel-content" class="panel-body"><div class="col form">
      <p class="note">${tn("sub")}</p>
      ${state.loading ? html`<${Skeleton} variant="rows" lines=${3} />`
        : state.error ? (state.denied ? html`<${Empty} icon="key" title=${state.error} />` : html`<${ErrorState} onRetry=${load} />`)
        : body()}
    </div></div>
    ${dialog && dialog.type === "add" ? html`<${AddDialog} kind=${dialog.kind} existing=${existing(dialog.kind)} onClose=${() => setDialog(null)} onSaved=${() => { load(); loadOverview(); }} />` : null}
    ${dialog && dialog.type === "view" ? html`<${ViewDialog} item=${dialog.item} onClose=${() => setDialog(null)} />` : null}
  </div>`;
}
