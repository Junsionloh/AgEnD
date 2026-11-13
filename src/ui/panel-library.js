// AGEND-243: the Skill / MCP library (/ui/library) — a place to keep skills (SKILL.md folders) and MCP server definitions (variable
// names only, never values). It is storage and a viewer: nothing here is given to an agent (that is a later step), so no agent's files
// or behaviour change. Read from GET /ui/library/list; save and delete go to POST /ui/library/save and /delete (src/library/web.ts),
// which hold all the rules — this page only shows what they answer. Admin only: a session without that is told so.
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
    title: "Library", sub: "Skills and MCP servers kept here for later use. Nothing in the library is given to an agent yet, so no agent changes.",
    skills: "Skills", mcp: "MCP servers", addSkill: "Add skill", addMcp: "Add MCP server", add: "Add", view: "View", delete: "Delete", close: "Close", cancel: "Cancel", save: "Save", saving: "Saving…",
    emptyTitle: "The library is empty", emptyHint: "Add a skill (a SKILL.md with a name and a description) or an MCP server definition. Passwords and keys never go in: an MCP item only names the variables it needs.",
    noneSkills: "No skills yet.", noneMcp: "No MCP servers yet.",
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
    deleteTitle: "Delete “{0}”?", deleteBody: "It is removed from the library. Nothing else changes.", deleted: "Deleted “{0}”.", saved: "Saved “{0}”.",
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
    title: "資源庫", sub: "把 Skill 和 MCP server 存在這裡，之後再用。目前資源庫的內容不會交給任何 Agent，所以不會改變任何 Agent。",
    skills: "Skills", mcp: "MCP server", addSkill: "新增 Skill", addMcp: "新增 MCP server", add: "新增", view: "檢視", delete: "刪除", close: "關閉", cancel: "取消", save: "儲存", saving: "儲存中…",
    emptyTitle: "資源庫還是空的", emptyHint: "新增一個 Skill（含名稱與說明的 SKILL.md）或 MCP server 定義。密碼和金鑰不會存進來：MCP 項目只記它需要哪些變數的名稱。",
    noneSkills: "還沒有 Skill。", noneMcp: "還沒有 MCP server。",
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
    deleteTitle: "要刪除「{0}」嗎？", deleteBody: "它會從資源庫移除，其他都不變。", deleted: "已刪除「{0}」。", saved: "已儲存「{0}」。",
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

function Row({ item, onView, onDelete }) {
  const meta = item.kind === "skill" && item.files ? (item.files === 1 ? tn("file1") : tn("files", item.files)) : item.size ? tn("bytes", kb(item.size)) : "";
  const hint = tn(`hint_${item.status}`);
  const hasHint = hint !== "library.hint_" + item.status;
  return html`<div class=${`row-item${item.status === "ok" ? "" : " is-warn"}`} data-library-item=${`${item.kind}:${item.id}`}>
    <${Icon} name=${item.kind === "skill" ? "book" : "plug"} size=${18} />
    <div class="grow"><span class="strong">${item.id}</span>${item.description ? html`<div class="note">${item.description}</div>` : null}
      ${item.status === "invalid" && item.reason ? html`<div class="note">${item.reason}</div>` : null}
      ${hasHint ? html`<div class="note">${hint}</div>` : null}</div>
    ${item.status !== "ok" ? html`<span class="pill off">${tn(`st_${item.status}`)}</span>` : null}
    ${meta ? html`<span class="note">${meta}</span>` : null}
    ${item.status !== "missing" && item.status !== "invalid" ? html`<button type="button" class="btn btn-sm" onClick=${() => onView(item)} data-library-view>${tn("view")}</button>` : null}
    <button type="button" class="btn btn-sm btn-ghost" onClick=${() => onDelete(item)} data-library-delete aria-label=${`${tn("delete")} ${item.id}`}>${tn("delete")}</button>
  </div>`;
}

export function LibraryPanel({ navKey }) {
  useLease(navKey);
  const [state, setState] = useState({ loading: true });
  const [dialog, setDialog] = useState(null);
  useEffect(() => { setTitle(tn("title")); }, [navKey]);
  const load = useCallback(async () => {
    try {
      const r = await call("/ui/library/list");
      if (r.ok && r.data && Array.isArray(r.data.items)) setState({ items: r.data.items });
      else setState({ error: r.status === 403 ? tn("adminOnly") : tn("loadFailed"), denied: r.status === 403 });
    } catch { setState({ error: tn("loadFailed") }); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const remove = async (item) => {
    if (!(await confirmDialog({ title: tn("deleteTitle", item.id), message: tn("deleteBody"), confirmLabel: tn("delete"), danger: true }))) return;
    try {
      const r = await call("/ui/library/delete", { kind: item.kind, id: item.id });
      if (r.ok) toast(tn("deleted", item.id)); else toast(libraryErrorText(r.data, "deleteFailed"), false);
    } catch { toast(tn("deleteFailed"), false); }
    load();
  };
  const items = state.items || [];
  const skills = items.filter((i) => i.kind === "skill"), mcp = items.filter((i) => i.kind === "mcp");
  const existing = (kind) => new Set(items.filter((i) => i.kind === kind).map((i) => i.id));
  const section = (kind, title, list, none) => html`<section class="form" aria-label=${title}>
    <div class="row-item"><h2 class="grow strong">${title}</h2>
      <button type="button" class="btn btn-sm" onClick=${() => setDialog({ type: "add", kind })} data-library-add=${kind}><${Icon} name="plus" size=${15} /> ${tn(kind === "skill" ? "addSkill" : "addMcp")}</button></div>
    ${list.length ? list.map((i) => html`<${Row} key=${`${i.kind}:${i.id}`} item=${i} onView=${(it) => setDialog({ type: "view", item: it })} onDelete=${remove} />`) : html`<p class="note">${none}</p>`}
  </section>`;
  return html`<div data-effect-panel="library" class="panel p-library">
    <${PanelHeader} title=${tn("title")} />
    <div data-trust="panel-content" class="panel-body"><div class="col form">
      <p class="note">${tn("sub")}</p>
      ${state.loading ? html`<${Skeleton} variant="rows" lines=${3} />`
        : state.error ? (state.denied ? html`<${Empty} icon="key" title=${state.error} />` : html`<${ErrorState} onRetry=${load} />`)
        : !items.length ? html`<${Empty} icon="book" title=${tn("emptyTitle")} hint=${tn("emptyHint")} />
            <div class="row-item"><button type="button" class="btn btn-primary" onClick=${() => setDialog({ type: "add", kind: "skill" })} data-library-add="skill">${tn("addSkill")}</button>
              <button type="button" class="btn" onClick=${() => setDialog({ type: "add", kind: "mcp" })} data-library-add="mcp">${tn("addMcp")}</button></div>`
        : html`${section("skill", tn("skills"), skills, tn("noneSkills"))}${section("mcp", tn("mcp"), mcp, tn("noneMcp"))}`}
    </div></div>
    ${dialog && dialog.type === "add" ? html`<${AddDialog} kind=${dialog.kind} existing=${existing(dialog.kind)} onClose=${() => setDialog(null)} onSaved=${load} />` : null}
    ${dialog && dialog.type === "view" ? html`<${ViewDialog} item=${dialog.item} onClose=${() => setDialog(null)} />` : null}
  </div>`;
}
