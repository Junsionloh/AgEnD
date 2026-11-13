// AGEND-243 / AGEND-248: the Library (/ui/library) — an OVERVIEW of what this AgEnD has: skills, tools and MCP servers, and which agents use
// them. Laid out like Settings: a list of categories on the left (the same `.p-settings` page, `.s-nav`, `.s-back`, PageHead and search box;
// on a phone the list is the page and a category opens with "‹ Library"), the chosen category on the right, one compact row per item with a
// filter. What AgEnD ships (built-in skills, tool sets, its own `agend` MCP server) is read only and comes from GET /ui/library/overview
// (src/library/overview.ts, which only reads); what is added to the library is the AGEND-243 library: GET /ui/library/list, POST /ui/library/save
// and /delete (src/library/web.ts, which hold all the rules). "Used by" is read from the existing settings; an agent tag opens that agent's
// settings, and the "+" on a library skill writes the same `library` value, through the same PATCH and the same Apply, as the agent's own
// Settings page does (settings-model.js agentPatchRequest / libraryMountPatch). Admin only: a session without that is told so.
import { html, useCallback, useEffect, useRef, useState } from "/assets/app-html.js";
import { t, register } from "/assets/app-i18n.js";
import { useLease } from "/assets/app-ctx.js";
import { PanelHeader, setTitle } from "/assets/app-shell.js";
import { Empty, ErrorState, Skeleton } from "/assets/ui-states.js";
import { Dialog } from "/assets/ui-dialog.js";
import { confirmDialog } from "/assets/ui-confirm.js";
import { toast } from "/assets/ui-toast.js";
import { Icon } from "/assets/ui-icons.js";
import { PageHead } from "/assets/page-head.js";
import { appStore } from "/assets/app-store.js";
import { LIBRARY_SECTIONS, detailsPath, librarySectionPath } from "/assets/app-route.js";
import { DEFAULT_SCHEMA, agentPatchRequest, libraryMcpMountPatch, libraryMountPatch, requestImpact } from "./settings-model.js";
import { operationActive, startOperation } from "./settings-apply.js";
import { McpDetails } from "./library-mcp-field.js";   // AGEND-261: what a library MCP server runs, shown before it is given to an agent
import { ImportDialog, SkillDialog } from "./library-skill.js";   // AGEND-257: Preview / Edit, and Import — their own module and words

register("library", {
  en: {
    title: "Library", sub: "An overview of what this AgEnD has: skills, tools and MCP servers, and which agents use them. Built-in items come with AgEnD and are read only; Library items are the ones you add here. This page changes no agent except through the “+” tag, which does what enabling the skill in the agent’s Settings does.",
    skills: "Skills", tools: "Tools", mcp: "MCP servers", groupResources: "Resources",
    lead_skills: "Skills agents can load. Built-in ones are given by an agent’s role; Library skills are given to the agents you pick.",
    lead_tools: "A tool set is the list of AgEnD tools an agent may use; an agent’s `tool_set` setting picks one.",
    lead_mcp: "MCP servers. AgEnD’s own comes with it; the ones you add can be given to agents (Claude Code and Codex for now).",
    counts: "{0} built in · {1} library",
    filterSkills: "Filter skills", filterTools: "Filter tool sets", filterMcp: "Filter MCP servers", noMatch: "Nothing matches “{0}”.",
    teamGroup: "Library", builtinGroup: "Built in · read only",
    teamSkillsLead: "Skills you added. Give one to an agent with the “+” tag, or in Settings → the agent → Workspace.", teamMcpLead: "MCP servers you added. Give one to an agent with the “+” tag (it shows what it runs first), or in Settings → the agent → Workspace. Claude Code and Codex agents only for now.",
    builtinSkillsLead: "Skills that come with AgEnD. Each is given to agents by their role.", builtinToolsLead: "Tool sets that come with AgEnD.", builtinMcpLead: "AgEnD’s own MCP server.",
    builtin: "Built in", team: "Library",
    role_general: "General", role_worker: "Workers", role_classic: "Classic bots", givenTo: "Given to", roles: "Roles",
    usedBy: "Used by", noUse: "No agent", classicNote: "Classic bots (not listed here)",
    toolsCount: "{0} tools", toolsOf: "Tools in “{0}”", noTools: "No tools", details: "Details", more: "{0} more", less: "Fewer",
    ts_full: "Every tool.", ts_worker: "Everything an agent needs to do the work; nothing that runs the fleet.", ts_coordinator: "The worker tools plus the tools that run the fleet.",
    ts_general: "For the General, the fleet’s administrator.", ts_standard: "A smaller everyday set.", ts_minimal: "Reply and message only.",
    agendMcp: "agend", agendMcpHint: "Gives each agent the tools of its tool set.",
    tagOpen: "Open the settings of {0}", tagOpenSkill: "Open {0} — Skills", tagNoFolder: "{0}: its CLI ({1}) has no skills folder, so this skill does not take effect there.",
    addTag: "Add to an agent", addTagLabel: "Add “{0}” to an agent", tagOpenMcp: "Open {0} — MCP servers", tagNoMcp: "{0}: its CLI ({1}) does not support Library MCP servers yet, so this one does not take effect there.",
    addToBodyMcp: "Pick the agents that should get this MCP server. Check what it runs below: confirming records this exact version for each agent you pick, then writes it into the agent’s settings, exactly as enabling it in Settings → the agent → MCP servers would. Takes effect the next time the agent starts.", addToNoMcp: "not supported yet", addToMcpLoading: "Reading what it runs…", addToMcpFailed: "Could not read the server. Close this and try again.", addToConfirmMcp: "Confirm and add", addToChanged: "It was changed after you opened this. Close it and open it again.", addToConfirmFailed: "Could not save the confirmation.",
    deleteBodyUsedMcp: "It is removed from the library. {0} still have it mounted and lose this MCP server the next time they start.",
    addToTitle: "Add “{0}” to agents", addToBody: "Pick the agents that should get this skill. It is written into each agent’s settings, exactly as enabling it in Settings → the agent → Skills would. Takes effect the next time the agent starts.",
    addToNone: "Every agent already has it.", addToNoFolder: "no skills folder", addToConfirm: "Add", addingLabel: "Add “{0}” to {1}", addBusy: "Another change is being saved. Try again in a moment.",
    addStarted: "Adding “{0}”. It takes effect when the agent next starts.", addLoadFailed: "Could not read the agents’ settings.",
    nextStart: "Takes effect at the agent’s next start",
    overviewFailed: "Could not read the built-in skills and tools.", overviewRetry: "Try again",
    addSkill: "Add skill", addMcp: "Add MCP server", add: "Add", view: "View", delete: "Delete", close: "Close", cancel: "Cancel", save: "Save", saving: "Saving…",
    emptyHint: "Add a skill (a SKILL.md with a name and a description) or an MCP server definition. Passwords and keys never go in: an MCP item only names the variables it needs.",
    noneSkills: "No library skills yet.", noneMcp: "No library MCP servers yet.", noneHint: "Add one with the button above.",
    files: "{0} files", file1: "1 file", bytes: "{0} KB",
    st_ok: "", st_modified: "Changed by hand", st_untracked: "Not recorded", st_missing: "Missing", st_invalid: "Not usable",
    hint_modified: "The files no longer match the recorded hash.", hint_untracked: "Found in the library folder but not added through this page.", hint_missing: "Recorded, but the files are gone.",
    src_local: "Added here", src_import: "Imported",
    hash: "Hash", source: "Source", updated: "Updated",
    newSkillTitle: "Add a skill", newMcpTitle: "Add an MCP server",
    idLabel: "Name", idHint: "Lowercase letters, digits and dashes (up to 64). It is the folder or file name, and the `name` inside.",
    skillMdLabel: "SKILL.md", mcpLabel: "MCP server file (YAML)",
    skillTemplate: "---\nname: {0}\ndescription: Say what this skill does and when to use it.\n---\n\n# {0}\n\nSteps…\n",
    mcpTemplate: "agend_library: 1\nkind: mcp\nname: {0}\ndescription: What this server does\ntransport: stdio\ncommand: npx\nargs:\n  - -y\n  - some-mcp-server\n# The variables the server reads — names only, never values. Each starts with MCP_ and has its value in the .env file.\nenv:\n  - MCP_EXAMPLE_API_TOKEN\n# To give the server another name for one: env: { NAME_IT_SEES: ${MCP_EXAMPLE_API_TOKEN} }\n",
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
    exportAll: "Export all", exportAllTitle: "Download every library skill in one .zip", exportOne: "Export “{0}”", importBtn: "Import", importTitle: "Import skills from a .zip, .skill or SKILL.md file",
    moreAgents: "{0} more: {1}", seeAll: "See every agent that uses it",
    e_bad_archive: "That file is not a ZIP, a .skill file or a SKILL.md, or it is damaged or uses something that is not supported.",
    e_no_skill: "No skill found. The archive needs a SKILL.md, in a folder named for the skill or at the top.",
    e_changed: "It was changed after you opened it. Close this and open it again.",
    e_mcp_var_prefix: "Variable names need to start with MCP_ (in “{0}”). Put the value in the .env file under an MCP_… name; to give the server another name for it, write NAME: ${MCP_…} under env.",
    e_expect_required: "This item cannot be replaced from here. Delete it first, then add it again.",
  },
  "zh-TW": {
    title: "資源庫", sub: "這一頁是總覽：這個 AgEnD 有哪些 Skill、工具和 MCP server，以及哪些 Agent 正在使用。內建項目隨 AgEnD 附帶，唯讀；資源庫項目是你在這裡新增的。除了「＋」標籤（效果等同在該 Agent 的設定裡啟用這個 Skill），這一頁不會改變任何 Agent。",
    skills: "Skills", tools: "工具", mcp: "MCP server", groupResources: "資源",
    lead_skills: "Agent 可以載入的 Skill。內建的依 Agent 的角色自動帶入；資源庫的 Skill 交給你挑的 Agent。",
    lead_tools: "工具組是 Agent 可以使用的 AgEnD 工具清單，由 Agent 的 `tool_set` 設定選擇。",
    lead_mcp: "MCP server。AgEnD 自己的隨附；你新增的可以交給 Agent（目前支援 Claude Code 和 Codex）。",
    counts: "內建 {0}・資源庫 {1}",
    filterSkills: "篩選 Skill", filterTools: "篩選工具組", filterMcp: "篩選 MCP server", noMatch: "沒有符合「{0}」的項目。",
    teamGroup: "資源庫", builtinGroup: "內建・唯讀",
    teamSkillsLead: "你新增的 Skill。用「＋」標籤交給 Agent，或到「設定 → 該 Agent → 工作目錄」。", teamMcpLead: "你新增的 MCP server。用「＋」標籤交給 Agent（會先顯示它要執行什麼），或到「設定 → 該 Agent → 工作目錄」。目前只支援 Claude Code 和 Codex 的 Agent。",
    builtinSkillsLead: "隨 AgEnD 附帶的 Skill，依 Agent 的角色自動帶入。", builtinToolsLead: "隨 AgEnD 附帶的工具組。", builtinMcpLead: "AgEnD 自己的 MCP server。",
    builtin: "內建", team: "資源庫",
    role_general: "General", role_worker: "一般 Agent", role_classic: "Classic bot", givenTo: "適用", roles: "角色",
    usedBy: "使用中", noUse: "沒有 Agent", classicNote: "Classic bot（不在這裡列出）",
    toolsCount: "{0} 個工具", toolsOf: "「{0}」的工具", noTools: "沒有工具", details: "詳細內容", more: "另外 {0} 個", less: "收合",
    ts_full: "所有工具。", ts_worker: "做事所需的一切，不含管理 fleet 的工具。", ts_coordinator: "一般工具，加上管理 fleet 的工具。",
    ts_general: "給 General（fleet 的管理員）。", ts_standard: "較精簡的日常組合。", ts_minimal: "只能回覆與傳訊息。",
    agendMcp: "agend", agendMcpHint: "把各 Agent 所屬工具組的工具交給它。",
    tagOpen: "開啟 {0} 的設定", tagOpenSkill: "開啟 {0}：Skills", tagNoFolder: "{0}：它的 CLI（{1}）沒有 skill 資料夾，這個 Skill 在那裡不會生效。",
    addTag: "加給 Agent", addTagLabel: "把「{0}」加給 Agent", tagOpenMcp: "開啟 {0}：MCP servers", tagNoMcp: "{0}：它的 CLI（{1}）暫不支援資源庫 MCP，這個 server 在那裡不會生效。",
    addToBodyMcp: "選要拿到這個 MCP server 的 Agent。請先看下面它會執行什麼：按下確認會替你選的每個 Agent 記下這個版本，再寫進各 Agent 的設定，效果和在「設定 → 該 Agent → MCP servers」啟用完全一樣，下次啟動時生效。", addToNoMcp: "暫不支援", addToMcpLoading: "讀取它會執行的內容…", addToMcpFailed: "無法讀取這個 server，請關掉再試一次。", addToConfirmMcp: "確認並加入", addToChanged: "你打開之後它被改過了，請關掉再重新打開。", addToConfirmFailed: "無法儲存確認。",
    deleteBodyUsedMcp: "它會從資源庫移除。{0} 還掛著它，下次啟動時會失去這個 MCP server。",
    addToTitle: "把「{0}」加給 Agent", addToBody: "選要拿到這個 Skill 的 Agent。它會寫進各 Agent 的設定，效果和在「設定 → 該 Agent → Skills」啟用完全一樣，下次啟動時生效。",
    addToNone: "每個 Agent 都已經有了。", addToNoFolder: "沒有 skill 資料夾", addToConfirm: "加入", addingLabel: "把「{0}」加給 {1}", addBusy: "還有另一項變更在儲存，請稍後再試。",
    addStarted: "正在加入「{0}」，Agent 下次啟動時生效。", addLoadFailed: "無法讀取 Agent 的設定。",
    nextStart: "下次啟動時生效",
    overviewFailed: "無法讀取內建的 Skill 和工具。", overviewRetry: "重試",
    addSkill: "新增 Skill", addMcp: "新增 MCP server", add: "新增", view: "檢視", delete: "刪除", close: "關閉", cancel: "取消", save: "儲存", saving: "儲存中…",
    emptyHint: "新增一個 Skill（含名稱與說明的 SKILL.md）或 MCP server 定義。密碼和金鑰不會存進來：MCP 項目只記它需要哪些變數的名稱。",
    noneSkills: "資源庫裡還沒有 Skill。", noneMcp: "資源庫裡還沒有 MCP server。", noneHint: "用上面的按鈕新增。",
    files: "{0} 個檔案", file1: "1 個檔案", bytes: "{0} KB",
    st_ok: "", st_modified: "被手動改過", st_untracked: "未記錄", st_missing: "檔案不見了", st_invalid: "無法使用",
    hint_modified: "檔案內容和記錄的雜湊不一致。", hint_untracked: "在資源庫資料夾裡，但不是從這個頁面加入的。", hint_missing: "有記錄，但檔案已經不在了。",
    src_local: "在這裡新增", src_import: "匯入",
    hash: "雜湊", source: "來源", updated: "更新時間",
    newSkillTitle: "新增 Skill", newMcpTitle: "新增 MCP server",
    idLabel: "名稱", idHint: "小寫英文、數字和連字號（最多 64 字）。它是資料夾或檔案名稱，也是檔案內的 `name`。",
    skillMdLabel: "SKILL.md", mcpLabel: "MCP server 檔案（YAML）",
    skillTemplate: "---\nname: {0}\ndescription: 說明這個 skill 做什麼、什麼時候用。\n---\n\n# {0}\n\n步驟…\n",
    mcpTemplate: "agend_library: 1\nkind: mcp\nname: {0}\ndescription: 這個 server 做什麼\ntransport: stdio\ncommand: npx\nargs:\n  - -y\n  - some-mcp-server\n# server 會讀的變數——只寫名稱，不寫值。名稱要以 MCP_ 開頭，值寫在 .env 檔裡。\nenv:\n  - MCP_EXAMPLE_API_TOKEN\n# 要給 server 另一個名稱：env: { 它看到的名稱: ${MCP_EXAMPLE_API_TOKEN} }\n",
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
    exportAll: "導出全部", exportAllTitle: "把資源庫的所有 Skill 下載成一個 .zip", exportOne: "導出「{0}」", importBtn: "導入", importTitle: "從 .zip、.skill 或 SKILL.md 檔案導入 Skill",
    moreAgents: "另外 {0} 個：{1}", seeAll: "查看所有使用它的 Agent",
    e_bad_archive: "這個檔案不是 ZIP、.skill 或 SKILL.md，或是已經損壞，或使用了不支援的功能。",
    e_no_skill: "找不到 Skill。壓縮檔裡需要有 SKILL.md，放在以 Skill 名稱命名的資料夾裡，或放在最上層。",
    e_changed: "它在你打開之後被改過了。請關掉再重新打開。",
    e_mcp_var_prefix: "變數名稱需以 MCP_ 開頭（出錯的欄位：{0}）。請把值寫在 .env 裡、名稱用 MCP_… 開頭；要給 MCP 另一個名稱，在 env 下寫 名稱: ${MCP_…}。",
    e_expect_required: "這一項無法從這裡取代。請先刪除，再重新新增。",
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

/** A POST whose body is a file's bytes (the import routes). */
async function callRaw(path, bytes) {
  const r = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/octet-stream" }, body: bytes });
  let data = null;
  try { data = await r.json(); } catch { /* not JSON */ }
  return { ok: r.ok, status: r.status, data };
}
const api = { call, callRaw, errorText: libraryErrorText };

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
    // Replacing says which version it started from (the list's hash): the server refuses a blind overwrite.
    const expect = existing.get(id);
    if (taken && !(await confirmDialog({ title: tn("replaceTitle", id), message: tn("replaceBody", id, kind === "skill" ? "skill" : "MCP"), confirmLabel: tn("replace"), danger: true }))) return;
    setBusy(true);
    try {
      const payload = kind === "skill" ? { kind, id, files: [{ path: "SKILL.md", content: text }], overwrite: taken, ...(taken && expect ? { expect } : {}) } : { kind, id, text, overwrite: taken, ...(taken && expect ? { expect } : {}) };
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
function ViewDialog({ item, onClose, onDelete }) {
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
  return html`<${Dialog} title=${item.id} onClose=${onClose} wide=${true} actions=${html`${onDelete ? html`<button type="button" class="btn btn-ghost" onClick=${() => onDelete(item)} data-library-dialog-delete>${tn("delete")}</button><span class="dlg-spacer"></span>` : null}<button type="button" class="btn" onClick=${onClose}>${tn("close")}</button>`}>
    <div class="form">
      ${state.loading ? html`<${Skeleton} lines=${3} />` : null}
      ${state.error ? html`<p class="feedback error" role="alert">${state.error}</p>` : null}
      ${d ? html`<p class="note">${tn("hash")}: <code>${d.sha256.slice(0, 16)}…</code>${item.updatedAt ? html` · ${tn("updated")}: ${new Date(item.updatedAt).toLocaleString()}` : null}</p>` : null}
      ${files.map((f) => html`<div class="field" key=${f.path}><label>${f.path}</label>
        ${f.content !== undefined ? html`<textarea rows=${Math.min(14, Math.max(3, f.content.split("\n").length + 1))} readonly spellcheck=${false} value=${f.content} data-library-file=${f.path} />` : html`<p class="note">${tn("e_not_text")}</p>`}</div>`)}
    </div>
  </${Dialog}>`;
}

/** An agent's tag: a link to that agent's settings. Library skills go straight to the Skills card (`?cat=work#library-skills`). */
const agentHref = (name, to) => (to === "skill" ? `${detailsPath(name)}?cat=work#library-skills` : to === "mcp-team" ? `${detailsPath(name)}?cat=work#library-mcp` : to === "tools" ? `${detailsPath(name)}?cat=work` : detailsPath(name));

/** How many agent tags a row shows before "+N": fewer on a phone, where the line is short. The rest is "+N", which opens the item (its Details lists every one): a row never grows taller for it. */
function useTagLimit() {
  const query = "(max-width: 599px)";
  const has = typeof window !== "undefined" && typeof window.matchMedia === "function";
  const [narrow, setNarrow] = useState(() => has && window.matchMedia(query).matches);
  useEffect(() => {
    if (!has) return undefined;
    const m = window.matchMedia(query), on = () => setNarrow(m.matches);
    on();
    if (m.addEventListener) { m.addEventListener("change", on); return () => m.removeEventListener("change", on); }
    return undefined;
  }, []);
  return narrow ? 1 : 3;
}

/** The agents that use an item, as tags that open them (and, for a library skill, a "+" that gives it to more). Always one line: what does not fit is "+N". */
function UsedBy({ names, to, agents, limit, onMore, onAdd }) {
  const shown = names.slice(0, limit);
  const noFolder = (n) => { const a = agents.find((x) => x.name === n); return a && !a.nativeSkills ? a : null; };
  const noMcp = (n) => { const a = agents.find((x) => x.name === n); return a && !a.windows && a.libraryMcp === false ? a : null; };
  return html`<span class="lib-tags" data-library-used-by>
    ${names.length ? null : html`<span class="note">${tn("noUse")}</span>`}
    ${shown.map((n) => {
      const bad = to === "skill" ? noFolder(n) : to === "mcp-team" ? noMcp(n) : null;
      return html`<a key=${n} class=${`pill lib-tag${bad ? " warn" : ""}`} href=${agentHref(n, to)} data-library-tag=${n}
        title=${bad ? tn(to === "mcp-team" ? "tagNoMcp" : "tagNoFolder", n, bad.backend) : to === "skill" ? tn("tagOpenSkill", n) : to === "mcp-team" ? tn("tagOpenMcp", n) : tn("tagOpen", n)}>${bad ? html`<${Icon} name="alert" size=${12} />` : null}${n}</a>`;
    })}
    ${names.length > limit ? html`<button type="button" class="pill lib-tag lib-more" onClick=${onMore} data-library-more title=${tn("moreAgents", names.length - limit, names.slice(limit).join(", "))}
      aria-label=${tn("seeAll")}>+${names.length - limit}</button>` : null}
    ${onAdd ? html`<button type="button" class="pill lib-tag lib-add" onClick=${onAdd} data-library-add-agent aria-label=${onAdd.label} title=${onAdd.label}><${Icon} name="plus" size=${12} /></button>` : null}
  </span>`;
}

/**
 * One row, the same in every category (skills, tools, MCP servers; built in or from the library): two lines. Line 1 is the name and its description;
 * line 2 is who uses it, what it is for / how big it is, and whether it is built in or the team's. The actions are one column at the right,
 * centered on the row: Export and Delete (on a screen wide enough) and, always last — so always in the same place — "Details". A row with no agent tags has the same two lines.
 */
function ItemRow({ icon, name, description, tags, extra, warn, rowAttrs, children }) {
  return html`<div class=${`row-item lib-row${warn ? " is-warn" : ""}`} ...${rowAttrs}>
    <span class="lib-ico"><${Icon} name=${icon} size=${18} /></span>
    <div class="lib-main"><span class="strong">${name}</span><span class="note lib-desc" title=${description || undefined}>${description || ""}</span></div>
    <div class="lib-meta">${tags}${extra}</div>
    <div class="lib-actions">${children}</div>
  </div>`;
}

const exportLink = (item, builtin = false) => html`<a class="icon-btn lib-act-extra" href=${`/ui/library/export?id=${encodeURIComponent(item.id)}${builtin ? "&builtin=1" : ""}`} download=${`${item.id}.zip`}
  aria-label=${tn("exportOne", item.id)} title=${tn("exportOne", item.id)} data-library-export=${item.id}><${Icon} name="download" size=${16} /></a>`;

/** A library item's row. */
function Row({ item, used, agents, limit, onView, onDelete, onAdd }) {
  const meta = item.kind === "skill" && item.files ? (item.files === 1 ? tn("file1") : tn("files", item.files)) : item.size ? tn("bytes", kb(item.size)) : "";
  const hint = tn(`hint_${item.status}`);
  const hasHint = hint !== "library.hint_" + item.status;
  const warn = item.status !== "ok";
  const openable = item.status !== "missing" && item.status !== "invalid";
  const add = onAdd ? Object.assign(() => onAdd(item), { label: tn("addTagLabel", item.id) }) : null;
  const tags = used ? html`<${UsedBy} names=${used} to=${item.kind === "skill" ? "skill" : "mcp-team"} agents=${agents} limit=${limit} onMore=${() => onView(item)} onAdd=${add} />` : null;
  const extra = html`${warn ? html`<span class="pill off" title=${hasHint ? hint : undefined}>${tn(`st_${item.status}`)}</span>` : null}
    ${meta ? html`<span class="note lib-size">${meta}</span>` : null}<span class="pill lib-kind">${tn("team")}</span>`;
  return html`<${ItemRow} icon=${item.kind === "skill" ? "book" : "plug"} name=${item.id}
    description=${`${item.description || ""}${item.status === "invalid" && item.reason ? ` ${item.reason}` : ""}`.trim()}
    tags=${tags} extra=${extra} warn=${warn} rowAttrs=${{ "data-library-item": `${item.kind}:${item.id}` }}>
    ${item.kind === "skill" ? (openable ? exportLink(item) : html`<button type="button" class="icon-btn lib-act-extra" disabled aria-label=${tn("exportOne", item.id)}><${Icon} name="download" size=${16} /></button>`) : null}
    <button type="button" class="icon-btn lib-act-extra" onClick=${() => onDelete(item)} data-library-delete aria-label=${`${tn("delete")} ${item.id}`} title=${`${tn("delete")} ${item.id}`}><${Icon} name="trash" size=${16} /></button>
    <button type="button" class="btn btn-sm" onClick=${() => onView(item)} disabled=${!openable} data-library-view>${tn("details")}</button>
  </${ItemRow}>`;
}

/** A built-in row: read only — the same two lines and the same place for Details (and Export, for a skill); no Delete. */
function BuiltinRow({ kind, name, icon, description, agents, to, onDetails, extra, limit, exportable }) {
  const tags = html`<${UsedBy} names=${agents.names} to=${to} agents=${agents.all} limit=${limit} onMore=${onDetails} onAdd=${null} />`;
  const more = html`${extra ? html`<span class="note lib-size">${extra}</span>` : null}<span class="pill lib-kind">${tn("builtin")}</span>`;
  return html`<${ItemRow} icon=${icon} name=${name} description=${description} tags=${tags} extra=${more} rowAttrs=${{ "data-library-builtin": `${kind}:${name}` }}>
    ${exportable ? exportLink({ id: name }, true) : null}
    <button type="button" class="btn btn-sm" onClick=${onDetails} data-library-details>${tn("details")}</button>
  </${ItemRow}>`;
}

/** What a built-in item is, whole: its full description, roles, tools and who uses it. Read only. */
function DetailsDialog({ detail, onClose }) {
  const { title, description, rows } = detail;
  return html`<${Dialog} title=${title} onClose=${onClose} wide=${true} actions=${html`<button type="button" class="btn" onClick=${onClose}>${tn("close")}</button>`}>
    <div class="form" data-library-details-dialog>
      ${description ? html`<p>${description}</p>` : null}
      ${rows.map(([label, value]) => html`<div class="field" key=${label}><label>${label}</label><p class="note">${value}</p></div>`)}
    </div>
  </${Dialog}>`;
}

/** "+" on a library skill: pick agents; the write is the agent Settings page's own (agentPatchRequest, libraryMountPatch, startOperation). */
function AddToAgentsDialog({ item, agents, usedNames, onClose, onStarted }) {
  const mcp = item.kind === "mcp";
  const [picked, setPicked] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // An MCP server is confirmed before it is given: what it runs is read from the server (the same answer the agent's Settings card uses).
  const [detail, setDetail] = useState(mcp ? { loading: true } : null);
  const probe = (agents.find((a) => !a.windows) || {}).name;
  useEffect(() => {
    if (!mcp) return undefined;
    if (!probe) { setDetail({ failed: true }); return undefined; }
    let live = true;
    call(`/ui/library/mcp-status?agent=${encodeURIComponent(probe)}`).then((r) => {
      const found = r.ok && r.data && Array.isArray(r.data.items) ? r.data.items.find((x) => x.id === item.id && x.summary && x.sha256) : null;
      if (live) setDetail(found ? { item: found } : { failed: true });
    }, () => { if (live) setDetail({ failed: true }); });
    return () => { live = false; };
  }, [mcp, item.id, probe]);
  const eligible = agents.filter((a) => !a.windows && !usedNames.includes(a.name));
  const usable = (a) => (mcp ? a.libraryMcp !== false : a.nativeSkills);
  const toggle = (name, on) => setPicked(on ? [...picked.filter((n) => n !== name), name] : picked.filter((n) => n !== name));
  const submit = async () => {
    if (!picked.length) return;
    if (operationActive()) { setError(tn("addBusy")); return; }
    setBusy(true); setError("");
    try {
      // The agent's own saved settings (not the defaults merged in), as Settings reads them before it writes.
      const [raw, schemaRes] = await Promise.all([call("/api/settings/fleet/raw"), call("/api/settings/schema")]);
      if (!raw.ok || !raw.data || typeof raw.data.instances !== "object") { setError(tn("addLoadFailed")); return; }
      const schema = schemaRes.ok && schemaRes.data ? schemaRes.data : DEFAULT_SCHEMA;
      const changes = [];
      if (mcp) {
        // Confirm the exact version that was shown, for each agent picked, before anything is written to its settings.
        const shown = detail && detail.item;
        if (!shown) { setError(tn("addToMcpFailed")); return; }
        for (const name of picked) {
          const c = await call("/ui/library/mcp-confirm", { agent: name, id: item.id, sha256: shown.sha256 });
          if (!c.ok) { setError(c.status === 409 ? tn("addToChanged") : tn("addToConfirmFailed")); return; }
        }
      }
      for (const name of picked) {
        const inst = raw.data.instances[name];
        if (!inst) continue;
        const patch = mcp ? libraryMcpMountPatch(inst, item.id) : libraryMountPatch(inst, item.id);
        if (!Object.keys(patch).length) continue;
        const request = agentPatchRequest(name, inst, patch);
        changes.push({ label: tn("addingLabel", item.id, name), impact: requestImpact(schema, request), request });
      }
      if (!changes.length) { onClose(); return; }
      if (!startOperation(changes)) { setError(tn("addBusy")); return; }
      toast(tn("addStarted", item.id));
      onStarted(appStore.get().settingsOp && appStore.get().settingsOp.id);
      onClose();
    } catch { setError(tn("addLoadFailed")); } finally { setBusy(false); }
  };
  return html`<${Dialog} title=${tn("addToTitle", item.id)} onClose=${onClose} busy=${busy}
    actions=${html`<button type="button" class="btn" onClick=${onClose} disabled=${busy}>${tn("cancel")}</button>
      <button type="button" class="btn btn-primary" onClick=${submit} disabled=${busy || !picked.length || (mcp && !(detail && detail.item))} data-library-add-confirm>${tn(mcp ? "addToConfirmMcp" : "addToConfirm")}</button>`}>
    <div class="form" data-library-add-dialog>
      <p class="note">${tn(mcp ? "addToBodyMcp" : "addToBody")}</p>
      ${mcp && detail && detail.loading ? html`<p class="note">${tn("addToMcpLoading")}</p>` : null}
      ${mcp && detail && detail.failed ? html`<p class="feedback error" role="alert">${tn("addToMcpFailed")}</p>` : null}
      ${mcp && detail && detail.item ? html`<${McpDetails} item=${detail.item} agent=${null} />` : null}
      ${eligible.length ? html`<div class="checks">${eligible.map((a) => html`<label key=${a.name} class="check" data-library-pick=${a.name}>
        <input type="checkbox" checked=${picked.includes(a.name)} disabled=${!usable(a)} onChange=${(e) => toggle(a.name, e.target.checked)} />
        <span><span class="strong">${a.name}</span>${!usable(a) ? html` <span class="note">(${tn(mcp ? "addToNoMcp" : "addToNoFolder")}: ${a.backend})</span>` : null}</span></label>`)}</div>`
        : html`<p class="note">${tn("addToNone")}</p>`}
      <p class="note">${tn("nextStart")}.</p>
      ${error ? html`<p class="feedback error" role="alert" data-library-error>${error}</p>` : null}
    </div>
  </${Dialog}>`;
}

const SECTION_ICON = { skills: "book", tools: "sliders", mcp: "plug" };
const matches = (q, ...texts) => !q || texts.some((x) => typeof x === "string" && x.toLowerCase().includes(q));

export function LibraryPanel({ route, navKey }) {
  useLease(navKey);
  const section = route && LIBRARY_SECTIONS.includes(route.section) ? route.section : "skills";
  const [state, setState] = useState({ loading: true });
  const [ov, setOv] = useState({ loading: true });
  const [dialog, setDialog] = useState(null);
  const [filter, setFilter] = useState("");
  const watching = useRef(null);
  const limit = useTagLimit();
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
    setOv((o) => (o.data ? o : { loading: true }));
    try {
      const r = await call("/ui/library/overview");
      setOv(r.ok && r.data && Array.isArray(r.data.builtinSkills) ? { data: r.data } : { error: true });
    } catch { setOv({ error: true }); }
  }, []);
  useEffect(() => { load(); loadOverview(); }, [load, loadOverview]);
  // A "+" starts the app-level Apply (settings-apply.js); when that one settles the usage is read again.
  useEffect(() => appStore.subscribe((s) => {
    const o = s.settingsOp;
    if (watching.current !== null && o && o.id === watching.current && !["writing", "posting", "watching"].includes(o.phase)) { watching.current = null; loadOverview(); }
  }), [loadOverview]);

  const data = ov.data;
  const agents = (data && data.agents) || [];
  const teamUsage = (data && data.teamUsage) || {};
  const teamMcpUsage = (data && data.teamMcpUsage) || {};
  const usedBy = (item) => (!data ? null : item.kind === "skill" ? (Object.hasOwn(teamUsage, item.id) ? teamUsage[item.id] : []) : (Object.hasOwn(teamMcpUsage, item.id) ? teamMcpUsage[item.id] : []));
  const remove = async (item) => {
    const used = usedBy(item) || [];
    const message = used.length ? tn(item.kind === "mcp" ? "deleteBodyUsedMcp" : "deleteBodyUsed", used.join(", ")) : tn("deleteBody");
    if (!(await confirmDialog({ title: tn("deleteTitle", item.id), message, confirmLabel: tn("delete"), danger: true }))) return;
    try {
      const r = await call("/ui/library/delete", { kind: item.kind, id: item.id });
      if (r.ok) toast(tn("deleted", item.id)); else toast(libraryErrorText(r.data, "deleteFailed"), false);
    } catch { toast(tn("deleteFailed"), false); }
    load(); loadOverview();
  };
  const items = state.items || [];
  const skills = items.filter((i) => i.kind === "skill"), mcp = items.filter((i) => i.kind === "mcp");
  const existing = (kind) => new Map(items.filter((i) => i.kind === kind).map((i) => [i.id, i.sha256]));
  const q = filter.trim().toLowerCase();
  const names = (list, to) => ({ names: list, all: agents });
  const roleText = (r) => (t(`library.role_${r}`) !== `library.role_${r}` ? tn(`role_${r}`) : r);
  const detailsOf = (title, description, rows) => setDialog({ type: "details", detail: { title, description, rows } });

  const builtin = (rows) => (ov.loading ? html`<${Skeleton} variant="rows" lines=${3} />`
    : ov.error ? html`<div class="error-state" role="alert"><p>${tn("overviewFailed")}</p><button type="button" class="btn" onClick=${loadOverview}>${tn("overviewRetry")}</button></div>` : rows());
  const group = (id, title, lead, rows) => html`<div class="lib-group" data-library-group=${id}><h4>${title}</h4><p class="note">${lead}</p><div class="rows">${rows}</div></div>`;
  const none = (list) => (list.length ? null : html`<${Empty} icon=${SECTION_ICON[section]} title=${tn("noMatch", filter.trim())} />`);

  const teamRows = (list, kind) => {
    const shown = list.filter((i) => matches(q, i.id, i.description));
    return shown.length ? shown.map((i) => html`<${Row} key=${`${i.kind}:${i.id}`} item=${i} used=${usedBy(i)} agents=${agents} limit=${limit}
        onView=${(it) => setDialog(it.kind === "skill" ? { type: "skill", id: it.id, item: it } : { type: "view", item: it })} onDelete=${remove} onAdd=${data ? (it) => setDialog({ type: "addto", item: it }) : null} />`)
      : (list.length ? none([]) : html`<${Empty} icon=${kind === "skill" ? "book" : "plug"} title=${kind === "skill" ? tn("noneSkills") : tn("noneMcp")} hint=${tn("emptyHint")} />`);
  };

  const sectionBody = () => {
    if (section === "skills") {
      const b = data ? data.builtinSkills.filter((s) => matches(q, s.name, s.description)) : [];
      return html`${group("team-skills", tn("teamGroup"), tn("teamSkillsLead"), teamRows(skills, "skill"))}
        ${group("builtin-skills", tn("builtinGroup"), tn("builtinSkillsLead"), builtin(() => b.length ? b.map((s) => html`<${BuiltinRow} key=${s.name} kind="skill" name=${s.name} icon="book" description=${s.description}
          agents=${names(s.agents)} to="skill-built" extra=${s.roles.map(roleText).join(", ")} limit=${limit} exportable=${true}
          onDetails=${() => setDialog({ type: "skill", id: s.name, builtin: true, used: s.agents })} />`) : none(b)))}`;
    }
    if (section === "tools") {
      const b = data ? data.toolSets.filter((ts) => matches(q, ts.name, tn(`ts_${ts.name}`), ...ts.tools)) : [];
      return group("builtin-tools", tn("builtinGroup"), tn("builtinToolsLead"), builtin(() => b.length ? b.map((ts) => {
        const key = `ts_${ts.name}`, known = t(`library.${key}`) !== `library.${key}`;
        return html`<${BuiltinRow} key=${ts.name} kind="tools" name=${ts.name} icon="sliders" description=${known ? tn(key) : ""} agents=${names(ts.agents)} to="tools" extra=${tn("toolsCount", ts.tools.length)} limit=${limit}
          onDetails=${() => detailsOf(tn("toolsOf", ts.name), known ? tn(key) : "", [[tn("toolsCount", ts.tools.length), ts.tools.length ? ts.tools.join(" · ") : tn("noTools")], [tn("usedBy"), ts.agents.length ? ts.agents.join(", ") : tn("noUse")]])} />`;
      }) : none(b)));
    }
    const m = data ? data.mcp.filter((x) => matches(q, x.name, tn("agendMcpHint"))) : [];
    return html`${group("team-mcp", tn("teamGroup"), tn("teamMcpLead"), teamRows(mcp, "mcp"))}
      ${group("builtin-mcp", tn("builtinGroup"), tn("builtinMcpLead"), builtin(() => m.length ? m.map((x) => html`<${BuiltinRow} key=${x.name} kind="mcp" name=${x.name} icon="plug" description=${tn("agendMcpHint")} agents=${names(x.agents)} to="mcp" limit=${limit}
        onDetails=${() => detailsOf(x.name, tn("agendMcpHint"), [[tn("usedBy"), x.agents.length ? x.agents.join(", ") : tn("noUse")]])} />`) : none(m)))}`;
  };

  const countOf = (name) => (!data ? null : name === "skills" ? tn("counts", data.builtinSkills.length, skills.length) : name === "tools" ? String(data.toolSets.length) : tn("counts", data.mcp.length, mcp.length));
  const addKind = section === "skills" ? "skill" : section === "mcp" ? "mcp" : null;
  // Settings' own rule (panel-settings.js): on a phone /ui/library is the list of categories, a category opens on its own with "‹ Library".
  const atList = typeof location !== "undefined" && location.pathname === "/ui/library";
  return html`<div data-effect-panel="library" class="panel p-library p-settings" data-view=${atList ? "index" : "section"}>
    <${PanelHeader} title=${tn("title")} />
    <nav data-trust="panel-navigation" class="seg s-nav" aria-label=${tn("title")}><div class="s-nav-groups"><div class="s-nav-group" role="group" aria-labelledby="lib-grp">
      <span class="s-nav-head" id="lib-grp">${tn("groupResources")}</span>
      ${LIBRARY_SECTIONS.map((k) => html`<a key=${k} href=${librarySectionPath(k)} class=${`seg-item${k === section ? " active" : ""}`} title=${tn(k)} data-library-nav=${k}
        aria-current=${k === section ? "page" : undefined}><${Icon} name=${SECTION_ICON[k]} size=${16} /><span>${tn(k)}</span></a>`)}</div></div></nav>
    <div data-trust="panel-content" class="panel-body"><div class="col" data-library-section=${section}>
      <a class="s-back" href="/ui/library"><${Icon} name="back" size=${16} /><span>${tn("title")}</span><span class="s-back-here">${tn(section)}</span></a>
      ${state.loading ? html`<${Skeleton} variant="rows" lines=${3} />`
        : state.error ? (state.denied ? html`<${Empty} icon="key" title=${state.error} />` : html`<${ErrorState} onRetry=${load} />`)
        : html`<${PageHead} title=${tn(section)} scope=${countOf(section) || ""} lead=${tn(`lead_${section}`)}>${addKind === "skill" ? html`${skills.length ? html`<a class="btn" href="/ui/library/export-all" download="agend-team-skills.zip" title=${tn("exportAllTitle")} data-library-export-all><${Icon} name="download" size=${15} /> ${tn("exportAll")}</a>`
              : html`<button type="button" class="btn" disabled title=${tn("exportAllTitle")} data-library-export-all><${Icon} name="download" size=${15} /> ${tn("exportAll")}</button>`}
            <button type="button" class="btn" onClick=${() => setDialog({ type: "import" })} title=${tn("importTitle")} data-library-import><${Icon} name="up" size=${15} /> ${tn("importBtn")}</button>` : null}
          ${addKind ? html`<button type="button" class="btn btn-primary" onClick=${() => setDialog({ type: "add", kind: addKind })} data-library-add=${addKind}><${Icon} name="plus" size=${15} /> ${tn(addKind === "skill" ? "addSkill" : "addMcp")}</button>` : null}</${PageHead}>
          <div class="s-toolbar"><label class="s-search"><${Icon} name="search" size=${14} /><span class="sr-only">${tn(section === "skills" ? "filterSkills" : section === "tools" ? "filterTools" : "filterMcp")}</span>
            <input type="search" value=${filter} placeholder=${tn(section === "skills" ? "filterSkills" : section === "tools" ? "filterTools" : "filterMcp")} data-library-filter onInput=${(e) => setFilter(e.target.value)} /></label></div>
          <section class="card lib-card" aria-label=${tn(section)} data-library-card=${section}>${sectionBody()}</section>
          <p class="note lib-foot">${tn("sub")}</p>`}
    </div></div>
    ${dialog && dialog.type === "add" ? html`<${AddDialog} kind=${dialog.kind} existing=${existing(dialog.kind)} onClose=${() => setDialog(null)} onSaved=${() => { load(); loadOverview(); }} />` : null}
    ${dialog && dialog.type === "view" ? html`<${ViewDialog} item=${dialog.item} onClose=${() => setDialog(null)} onDelete=${(it) => { setDialog(null); remove(it); }} />` : null}
    ${dialog && dialog.type === "skill" ? html`<${SkillDialog} key=${`${dialog.builtin ? "b" : "t"}:${dialog.id}`} id=${dialog.id} builtin=${!!dialog.builtin} api=${api}
      used=${dialog.builtin ? dialog.used : (usedBy({ kind: "skill", id: dialog.id }) || [])} onClose=${() => setDialog(null)} onSaved=${() => { load(); loadOverview(); }}
      onDelete=${dialog.builtin ? null : () => { setDialog(null); remove(dialog.item || { kind: "skill", id: dialog.id }); }} />` : null}
    ${dialog && dialog.type === "import" ? html`<${ImportDialog} api=${api} onClose=${() => setDialog(null)} onDone=${() => { load(); loadOverview(); }} />` : null}
    ${dialog && dialog.type === "details" ? html`<${DetailsDialog} detail=${dialog.detail} onClose=${() => setDialog(null)} />` : null}
    ${dialog && dialog.type === "addto" ? html`<${AddToAgentsDialog} item=${dialog.item} agents=${agents} usedNames=${usedBy(dialog.item) || []} onClose=${() => setDialog(null)} onStarted=${(id) => { watching.current = id; }} />` : null}
  </div>`;
}
