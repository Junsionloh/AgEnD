// AGEND-257: a skill on the Library page — the Preview / Edit dialog, and Import.
//
//  - Preview: SKILL.md drawn as Markdown by the chat's own renderer (chat-thread.js drawMarkdown → chat-render.js: it escapes the text first,
//    so nothing in a skill becomes markup and nothing new is loaded); its frontmatter as plain fields (name, description, roles…); the other
//    files as a list that opens as text. A built-in skill has only this tab.
//  - Edit (library skills only): the text of SKILL.md and of each other file. A save is the library's own save (POST /ui/library/save): the same
//    checks and secret scan as adding one, nothing written when one fails, the recorded hash updated when it succeeds. `expect` is the hash
//    this editor read, so a skill saved by someone else meanwhile is not overwritten. If agents have the skill, the admin is told who gets
//    the new text (at their next start) before it is saved.
//  - Import: a .zip, .skill or SKILL.md is sent to the preview route (nothing stored), the admin reads each skill in full and settles each
//    name clash (replace / import under another name / skip — never replace a built-in one), and the same file is sent again with the hash
//    of what was previewed. Importing only puts skills in the library; no agent is given one.
//
// The words live here (their own namespace) so a tab opened before an upgrade never shows a raw key. `api` is the page's own { call, callRaw,
// errorText }, so there is one way of talking to /ui/library/*.
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import "/assets/chat-render.js";
import { drawMarkdown } from "/assets/chat-thread.js";
import { Dialog } from "/assets/ui-dialog.js";
import { confirmDialog } from "/assets/ui-confirm.js";
import { toast } from "/assets/ui-toast.js";
import { Icon } from "/assets/ui-icons.js";
import { Skeleton } from "/assets/ui-states.js";

register("librarySkill", {
  en: {
    tabs: "{0}: preview or edit", tabPreview: "Preview", tabEdit: "Edit",
    fName: "Name", fDescription: "Description", fRoles: "Roles", noFields: "This SKILL.md has no frontmatter block.",
    filesTitle: "Files", show: "Show", hide: "Hide", kb: "{0} KB", usedBy: "Used by", noUse: "No agent yet",
    builtinNote: "Built in with AgEnD: preview only. Export gives you a copy; the built-in skill itself never changes.",
    teamNote: "Hash {0}", unsaved: "You have unsaved changes in Edit. This preview shows the saved version.",
    editLead: "Edit the text of this skill. It is checked the same way as when you add one, and nothing is saved if a check fails.",
    editFile: "File", save: "Save", saving: "Saving…", close: "Close", cancel: "Cancel", exportLabel: "Export", exportTitle: "Download “{0}” as a .zip",
    discardTitle: "Discard your changes?", discardBody: "What you edited in “{0}” has not been saved.", discard: "Discard", del: "Delete",
    usedTitle: "Save “{0}”?", usedBody: "These agents have this skill: {0}. They get the new text the next time they start.", saved: "Saved “{0}”.",
    saveFailed: "Could not save.", loadFailed: "Could not read it.",
    importTitle: "Import skills", importLead: "Choose a .zip, .skill or SKILL.md file. You read what is in it first; nothing is stored until you confirm, and no agent is given the skill.",
    chooseFile: "Choose a file", chooseAnother: "Choose another file", checking: "Checking “{0}”…", tooBig: "That file is larger than {0} MB.", importFailed: "Could not import.", previewFailed: "Could not read that file.",
    found: "{0} skills in “{1}”", found1: "1 skill in “{0}”", leftOut: "Left out of the archive: {0}",
    notUsable: "Cannot be imported", importIt: "Import this skill", showText: "Show SKILL.md", hideText: "Hide SKILL.md", filesIn: "{0} files", file1: "1 file",
    clashTeam: "A library skill named “{0}” is already in the library.", clashBuiltin: "“{0}” is the name of a built-in skill. A built-in skill is never replaced.",
    actReplace: "Replace it", actRename: "Import under another name", actSkip: "Skip it", newName: "New name", nameBad: "Lowercase letters, digits and dashes, up to 64.",
    importCount: "Import ({0})", importNone: "Nothing to import",
    doneTitle: "Import finished", doneNote: "The skills are in the library. No agent has them yet: give one to an agent with the “+” tag on its row.",
    r_imported: "Imported", r_replaced: "Replaced the existing one", r_renamed: "Imported as “{0}”", r_skipped: "Skipped", r_rejected: "Not imported",
    why_undecided: "no choice was made", why_chosen: "you chose to skip it", why_builtin: "a built-in skill’s name",
    done: "Done", imported: "Imported {0} of {1}.",
  },
  "zh-TW": {
    tabs: "{0}：預覽或編輯", tabPreview: "預覽", tabEdit: "編輯",
    fName: "名稱", fDescription: "說明", fRoles: "角色", noFields: "這個 SKILL.md 沒有 frontmatter 區塊。",
    filesTitle: "檔案", show: "展開", hide: "收合", kb: "{0} KB", usedBy: "使用中", noUse: "還沒有 Agent",
    builtinNote: "AgEnD 內建：只能預覽。「導出」會給你一份副本，內建 Skill 本身不會改變。",
    teamNote: "雜湊 {0}", unsaved: "「編輯」裡有尚未儲存的修改。這個預覽顯示的是已儲存的版本。",
    editLead: "編輯這個 Skill 的文字。儲存前會做和新增時相同的檢查，任何一項不過就完全不儲存。",
    editFile: "檔案", save: "儲存", saving: "儲存中…", close: "關閉", cancel: "取消", exportLabel: "導出", exportTitle: "把「{0}」下載成 .zip",
    discardTitle: "要捨棄修改嗎？", discardBody: "你在「{0}」裡的修改還沒有儲存。", discard: "捨棄", del: "刪除",
    usedTitle: "要儲存「{0}」嗎？", usedBody: "這些 Agent 有這個 Skill：{0}。它們下次啟動時會拿到新的內容。", saved: "已儲存「{0}」。",
    saveFailed: "無法儲存。", loadFailed: "無法讀取。",
    importTitle: "導入 Skill", importLead: "選一個 .zip、.skill 或 SKILL.md 檔案。先讓你看過裡面的內容；確認前不會存任何東西，也不會把 Skill 交給任何 Agent。",
    chooseFile: "選擇檔案", chooseAnother: "改選別的檔案", checking: "正在檢查「{0}」…", tooBig: "這個檔案超過 {0} MB。", importFailed: "無法導入。", previewFailed: "無法讀取這個檔案。",
    found: "「{1}」裡有 {0} 個 Skill", found1: "「{0}」裡有 1 個 Skill", leftOut: "壓縮檔中略過的項目：{0}",
    notUsable: "無法導入", importIt: "導入這個 Skill", showText: "顯示 SKILL.md", hideText: "收合 SKILL.md", filesIn: "{0} 個檔案", file1: "1 個檔案",
    clashTeam: "資源庫裡已經有一個叫「{0}」的 Skill。", clashBuiltin: "「{0}」是內建 Skill 的名稱。內建 Skill 不會被取代。",
    actReplace: "取代它", actRename: "用別的名稱導入", actSkip: "略過", newName: "新名稱", nameBad: "小寫英文、數字和連字號，最多 64 字。",
    importCount: "導入（{0}）", importNone: "沒有可導入的項目",
    doneTitle: "導入完成", doneNote: "Skill 已放進資源庫。還沒有 Agent 拿到它們：用該列的「＋」標籤交給 Agent。",
    r_imported: "已導入", r_replaced: "已取代原有的", r_renamed: "已用「{0}」導入", r_skipped: "已略過", r_rejected: "未導入",
    why_undecided: "沒有做選擇", why_chosen: "你選擇略過", why_builtin: "內建 Skill 的名稱",
    done: "完成", imported: "已導入 {0} / {1} 個。",
  },
});
const tn = (k, ...v) => t(`librarySkill.${k}`, ...v);
const kb = (n) => Math.max(1, Math.round((n || 0) / 1024));
export const IMPORT_MAX_MB = 16;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** SKILL.md's Markdown, drawn by the chat's renderer (it escapes first; this is the module that is allowed to write rendered Markdown). */
function Markdown({ text }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current) drawMarkdown(ref.current, text); }, [text]);
  return html`<div ref=${ref} class="pv-code pv-md lib-md" data-library-md />`;
}

const fieldLabel = (key) => (key === "name" ? tn("fName") : key === "description" ? tn("fDescription") : key === "roles" ? tn("fRoles") : key);

/** The two tabs, as the app's other tab strips: buttons with role=tab, the arrow keys move between them. */
function Tabs({ label, tabs, value, onChange }) {
  const keys = (e, i) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    onChange(tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length].id);
  };
  return html`<div class="seg-inline lib-tabs" role="tablist" aria-label=${label}>${tabs.map((x, i) => html`<button key=${x.id} type="button" role="tab" id=${`lib-tab-${x.id}`}
    class=${`btn btn-sm${value === x.id ? " btn-primary" : ""}`} aria-selected=${value === x.id ? "true" : "false"} aria-controls=${`lib-panel-${x.id}`} tabindex=${value === x.id ? 0 : -1}
    data-library-tab=${x.id} onClick=${() => onChange(x.id)} onKeyDown=${(e) => keys(e, i)}>${x.label}</button>`)}</div>`;
}

/** A skill, whole: Preview (always) and Edit (a library skill only — a built-in one is read only and has no such tab). */
export function SkillDialog({ id, builtin, used, api, onClose, onSaved, onDelete }) {
  const [state, setState] = useState({ loading: true });
  const [tab, setTab] = useState("preview");
  const [drafts, setDrafts] = useState({});
  const [sel, setSel] = useState("SKILL.md");
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = () => api.call(builtin ? `/ui/library/builtin?name=${encodeURIComponent(id)}` : `/ui/library/item?kind=skill&id=${encodeURIComponent(id)}`).then((r) => {
    setState(r.ok && r.data && r.data.detail ? { detail: r.data.detail } : { error: api.errorText(r.data, "loadFailed") });
  }, () => setState({ error: tn("loadFailed") }));
  useEffect(() => { load(); }, [id, builtin]);
  const d = state.detail;
  const original = (path) => { const f = d && d.files.find((x) => x.path === path); return f ? f.content : ""; };
  const dirty = !!d && Object.keys(drafts).some((p) => drafts[p] !== original(p));
  const close = async () => {
    if (dirty && !(await confirmDialog({ title: tn("discardTitle"), message: tn("discardBody", id), confirmLabel: tn("discard"), danger: true }))) return;
    onClose();
  };
  const save = async () => {
    if (!d || busy) return;
    setError("");
    if (used.length && !(await confirmDialog({ title: tn("usedTitle", id), message: tn("usedBody", used.join(", ")), confirmLabel: tn("save") }))) return;
    setBusy(true);
    try {
      const files = d.files.map((f) => ({ path: f.path, content: Object.hasOwn(drafts, f.path) ? drafts[f.path] : f.content }));
      const r = await api.call("/ui/library/save", { kind: "skill", id, files, overwrite: true, expect: d.sha256 });
      if (r.ok) { toast(tn("saved", id)); setDrafts({}); setTab("preview"); setState({ loading: true }); await load(); onSaved(); }
      else setError(api.errorText(r.data, "saveFailed"));
    } catch { setError(tn("saveFailed")); } finally { setBusy(false); }
  };
  const tabs = [{ id: "preview", label: tn("tabPreview") }, ...(builtin ? [] : [{ id: "edit", label: tn("tabEdit") }])];
  const exportHref = `/ui/library/export?id=${encodeURIComponent(id)}${builtin ? "&builtin=1" : ""}`;
  const actions = html`${onDelete ? html`<button type="button" class="btn btn-ghost" onClick=${onDelete} disabled=${busy} data-library-dialog-delete>${tn("del")}</button>` : null}
    <a class="btn" href=${exportHref} download=${`${id}.zip`} title=${tn("exportTitle", id)} data-library-export-one><${Icon} name="download" size=${14} /> ${tn("exportLabel")}</a>
    <span class="dlg-spacer"></span>
    <button type="button" class="btn" onClick=${close} disabled=${busy}>${tn("close")}</button>
    ${tab === "edit" ? html`<button type="button" class="btn btn-primary" onClick=${save} disabled=${busy || !dirty} data-library-skill-save>${busy ? tn("saving") : tn("save")}</button>` : null}`;
  return html`<${Dialog} title=${id} onClose=${close} busy=${busy} wide=${true} actions=${actions}>
    <div class="form lib-skill" data-library-skill-dialog=${builtin ? "builtin" : "team"}>
      ${state.loading ? html`<${Skeleton} lines=${4} />` : null}
      ${state.error ? html`<p class="feedback error" role="alert">${state.error}</p>` : null}
      ${d ? html`<${Tabs} label=${tn("tabs", id)} tabs=${tabs} value=${tab} onChange=${setTab} />` : null}
      ${d && tab === "preview" ? html`<div role="tabpanel" id="lib-panel-preview" aria-labelledby="lib-tab-preview" class="lib-pane" data-library-pane="preview">
        ${builtin ? html`<p class="note">${tn("builtinNote")}</p>` : html`<p class="note">${tn("teamNote", d.sha256.slice(0, 12))}</p>`}
        ${dirty ? html`<p class="note feedback warning" role="status">${tn("unsaved")}</p>` : null}
        ${d.fields && d.fields.length ? html`<dl class="lib-fields" data-library-fields>${d.fields.map((f) => html`<div key=${f.key} class="lib-field"><dt>${fieldLabel(f.key)}</dt><dd>${f.value}</dd></div>`)}</dl>` : html`<p class="note">${tn("noFields")}</p>`}
        <div class="lib-field"><dt>${tn("usedBy")}</dt><dd data-library-skill-used>${used.length ? used.join(", ") : tn("noUse")}</dd></div>
        <${Markdown} text=${d.body || ""} />
        <h4 class="lib-files-h">${tn("filesTitle")}</h4>
        <ul class="lib-files" data-library-files>${d.files.map((f) => html`<li key=${f.path}>
          <div class="lib-file-row"><code>${f.path}</code><span class="note">${tn("kb", kb(f.size))}</span>
            <button type="button" class="btn btn-sm btn-ghost" aria-expanded=${open === f.path ? "true" : "false"} data-library-file-toggle=${f.path}
              onClick=${() => setOpen(open === f.path ? null : f.path)}>${open === f.path ? tn("hide") : tn("show")}</button></div>
          ${open === f.path ? html`<pre class="pv-code lib-src" tabindex="0" data-library-file-text=${f.path}><code>${f.content}</code></pre>` : null}</li>`)}</ul>
      </div>` : null}
      ${d && tab === "edit" && !builtin ? html`<div role="tabpanel" id="lib-panel-edit" aria-labelledby="lib-tab-edit" class="lib-pane" data-library-pane="edit">
        <p class="note">${tn("editLead")}</p>
        ${d.files.length > 1 ? html`<div class="field"><label for="library-edit-file">${tn("editFile")}</label>
          <select id="library-edit-file" value=${sel} data-library-edit-file onChange=${(e) => setSel(e.target.value)}>${d.files.map((f) => html`<option key=${f.path} value=${f.path} selected=${f.path === sel}>${f.path}${Object.hasOwn(drafts, f.path) && drafts[f.path] !== f.content ? " •" : ""}</option>`)}</select></div>` : null}
        <div class="field"><label for="library-edit-text" class="sr-only">${sel}</label>
          <textarea id="library-edit-text" rows="16" spellcheck=${false} value=${Object.hasOwn(drafts, sel) ? drafts[sel] : original(sel)} data-library-edit-text=${sel}
            onInput=${(e) => { const v = e.target.value; setDrafts((x) => ({ ...x, [sel]: v })); }} /></div>
        ${error ? html`<p class="feedback error" role="alert" data-library-error>${error}</p>` : null}
      </div>` : null}
    </div>
  </${Dialog}>`;
}

// ── Import ─────────────────────────────────────────────────────────────

/** What the preview says is wrong with one skill, in words (the page's own error words, with the place). */
const whyText = (api, s) => api.errorText({ error: s.error, path: s.path, detail: s.detail, findings: s.findings }, "importFailed");

/** One skill of the preview: its name and description, its files, SKILL.md in full (a skill is instructions an AI will follow), and — when its name is taken — the choice. */
function PreviewSkill({ s, choice, setChoice, api }) {
  const [text, setText] = useState(false);
  const clash = s.conflict !== "none";
  const c = choice;
  const nameOk = c.action !== "rename" || (ID_RE.test(c.as) && c.as !== s.id);
  return html`<section class=${`card lib-import-skill${s.ok ? "" : " is-bad"}`} data-library-import-skill=${s.id}>
    <div class="lib-import-head"><span class="strong">${s.id}</span>${s.ok ? null : html`<span class="pill off">${tn("notUsable")}</span>`}</div>
    ${s.ok ? html`<p class="note">${s.description}</p>` : html`<p class="feedback error" role="alert" data-library-import-error>${whyText(api, s)}</p>`}
    ${s.ok ? html`
      <p class="note">${s.files.length === 1 ? tn("file1") : tn("filesIn", s.files.length)}: ${s.files.map((f) => f.path).join(", ")}</p>
      <button type="button" class="btn btn-sm" aria-expanded=${text ? "true" : "false"} data-library-import-text-toggle onClick=${() => setText(!text)}>${text ? tn("hideText") : tn("showText")}</button>
      ${text ? html`<pre class="pv-code lib-src" tabindex="0" data-library-import-text><code>${s.skillMd}</code></pre>` : null}
      ${clash ? html`<fieldset class="lib-clash" data-library-clash=${s.conflict}>
        <legend class="note">${s.conflict === "builtin" ? tn("clashBuiltin", s.id) : tn("clashTeam", s.id)}</legend>
        <div class="checks">
          ${s.conflict === "team" ? html`<label class="check"><input type="radio" name=${`lib-clash-${s.id}`} checked=${c.action === "overwrite"} data-library-choice="overwrite" onChange=${() => setChoice({ ...c, action: "overwrite" })} /><span>${tn("actReplace")}</span></label>` : null}
          <label class="check"><input type="radio" name=${`lib-clash-${s.id}`} checked=${c.action === "rename"} data-library-choice="rename" onChange=${() => setChoice({ ...c, action: "rename" })} /><span>${tn("actRename")}</span></label>
          <label class="check"><input type="radio" name=${`lib-clash-${s.id}`} checked=${c.action === "skip"} data-library-choice="skip" onChange=${() => setChoice({ ...c, action: "skip" })} /><span>${tn("actSkip")}</span></label>
        </div>
        ${c.action === "rename" ? html`<div class="field"><label for=${`lib-as-${s.id}`}>${tn("newName")}</label>
          <input id=${`lib-as-${s.id}`} type="text" maxlength="64" value=${c.as} autocomplete="off" autocapitalize="none" spellcheck=${false} data-library-rename
            onInput=${(e) => setChoice({ ...c, as: e.target.value.trim() })} />
          ${nameOk ? null : html`<span class="note feedback error" role="alert">${tn("nameBad")}</span>`}</div>` : null}
      </fieldset>`
      : html`<label class="check"><input type="checkbox" checked=${c.action !== "skip"} data-library-choice="include" onChange=${(e) => setChoice({ ...c, action: e.target.checked ? "add" : "skip" })} /><span>${tn("importIt")}</span></label>`}` : null}
  </section>`;
}

const startChoice = (s) => (s.conflict === "none" ? { action: "add", as: "" } : { action: "skip", as: `${s.id}-2`.slice(0, 64) });
const decisionOf = (s, c) => (c.action === "skip" ? { action: "skip" } : c.action === "rename" ? { action: "rename", as: c.as } : { action: c.action });

/** Import: choose a file → read what is in it → choose what to do about each name → stored. */
export function ImportDialog({ api, onClose, onDone }) {
  const [step, setStep] = useState("pick");          // pick | checking | preview | importing | done
  const [file, setFile] = useState(null);             // { name, bytes }
  const [preview, setPreview] = useState(null);
  const [choices, setChoices] = useState({});
  const [results, setResults] = useState(null);
  const [error, setError] = useState("");
  const input = useRef(null);
  const busy = step === "checking" || step === "importing";
  const pick = async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    setError("");
    if (f.size > IMPORT_MAX_MB * 1024 * 1024) { setError(tn("tooBig", IMPORT_MAX_MB)); e.target.value = ""; return; }
    setFile({ name: f.name }); setStep("checking");
    try {
      const bytes = await f.arrayBuffer();
      const r = await api.callRaw(`/ui/library/import/preview?filename=${encodeURIComponent(f.name)}`, bytes);
      if (r.ok && r.data && Array.isArray(r.data.skills)) {
        setFile({ name: f.name, bytes }); setPreview(r.data);
        setChoices(Object.fromEntries(r.data.skills.map((s) => [s.id, startChoice(s)])));
        setStep("preview");
      } else { setError(api.errorText(r.data, "previewFailed")); setStep("pick"); }
    } catch { setError(tn("previewFailed")); setStep("pick"); }
    e.target.value = "";
  };
  const chosen = preview ? preview.skills.filter((s) => s.ok && (choices[s.id] || startChoice(s)).action !== "skip") : [];
  const renameBad = chosen.some((s) => { const c = choices[s.id]; return c.action === "rename" && !(ID_RE.test(c.as) && c.as !== s.id); });
  const submit = async () => {
    if (!preview || !file || !file.bytes || busy || !chosen.length || renameBad) return;
    setError(""); setStep("importing");
    const decisions = {};
    for (const s of preview.skills) if (s.ok) decisions[s.id] = decisionOf(s, choices[s.id] || startChoice(s));
    try {
      const q = `sha256=${preview.sha256}&filename=${encodeURIComponent(file.name)}&decisions=${encodeURIComponent(JSON.stringify(decisions))}`;
      const r = await api.callRaw(`/ui/library/import?${q}`, file.bytes);
      if (r.ok && r.data && Array.isArray(r.data.results)) {
        setResults(r.data.results); setStep("done"); onDone();
        const n = r.data.results.filter((x) => x.status === "imported" || x.status === "replaced" || x.status === "renamed").length;
        toast(tn("imported", n, r.data.results.length));
      } else { setError(api.errorText(r.data, "importFailed")); setStep("preview"); }
    } catch { setError(tn("importFailed")); setStep("preview"); }
  };
  const resultLine = (x) => {
    const word = x.status === "renamed" ? tn("r_renamed", x.savedAs) : tn(`r_${x.status}`);
    const why = x.status === "rejected" ? whyText(api, x) : x.reason ? tn(`why_${x.reason}`) : "";
    return html`<li key=${x.id} data-library-result=${x.id} data-status=${x.status}><span class="strong">${x.id}</span> — ${word}${why ? html`<span class="note"> · ${why}</span>` : null}</li>`;
  };
  const actions = step === "done"
    ? html`<button type="button" class="btn btn-primary" onClick=${onClose} data-library-import-close>${tn("done")}</button>`
    : html`<button type="button" class="btn" onClick=${onClose} disabled=${busy}>${tn("cancel")}</button>
      ${step === "preview" || step === "importing" ? html`<button type="button" class="btn btn-primary" onClick=${submit} disabled=${busy || !chosen.length || renameBad} data-library-import-go>${chosen.length ? tn("importCount", chosen.length) : tn("importNone")}</button>` : null}`;
  return html`<${Dialog} title=${step === "done" ? tn("doneTitle") : tn("importTitle")} onClose=${onClose} busy=${busy} wide=${true} actions=${actions}>
    <div class="form lib-import" data-library-import-dialog=${step}>
      ${step === "pick" || step === "checking" || step === "preview" ? html`<p class="note">${tn("importLead")}</p>
        <div class="field"><label class="btn btn-sm" data-library-import-label><${Icon} name="file" size=${15} /> ${step === "preview" ? tn("chooseAnother") : tn("chooseFile")}
          <input ref=${input} type="file" accept=".zip,.skill,.md,application/zip,text/markdown,text/plain" hidden disabled=${busy} data-library-import-file onChange=${pick} /></label></div>` : null}
      ${step === "checking" ? html`<p class="note" role="status">${tn("checking", file ? file.name : "")}</p><${Skeleton} lines=${3} />` : null}
      ${preview && (step === "preview" || step === "importing") ? html`
        <p class="strong" data-library-import-found>${preview.skills.length === 1 ? tn("found1", file.name) : tn("found", preview.skills.length, file.name)}</p>
        ${preview.ignored && preview.ignored.length ? html`<p class="note">${tn("leftOut", preview.ignored.slice(0, 5).join(", ") + (preview.ignored.length > 5 ? ` +${preview.ignored.length - 5}` : ""))}</p>` : null}
        <div class="lib-import-list">${preview.skills.map((s) => html`<${PreviewSkill} key=${s.id} s=${s} api=${api} choice=${choices[s.id] || startChoice(s)} setChoice=${(c) => setChoices((x) => ({ ...x, [s.id]: c }))} />`)}</div>` : null}
      ${step === "done" && results ? html`<p class="note">${tn("doneNote")}</p><ul class="lib-results" data-library-results>${results.map(resultLine)}</ul>` : null}
      ${error ? html`<p class="feedback error" role="alert" data-library-error>${error}</p>` : null}
    </div>
  </${Dialog}>`;
}
