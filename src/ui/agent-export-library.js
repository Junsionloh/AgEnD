// AGEND-245: the Library's part of an agent's Export and Load-template dialogs (agent-export-dialog.js).
//
//  - Export: a second group of checkboxes — the Library's skills and MCP servers this agent has assigned, and "bundle the definitions" (off by default: the
//    file then only refers to them by id and hash). What travels is said beside the boxes: for an MCP server only the NAMES of its variables, never a value.
//  - Load: each entry of the file is shown against this computer's Library in one of four states — present, differs (the Library has that id as another
//    version: never overwritten; use the local one, or save the file's as a new id), missing-embedded (the file carries it: read it, then it is added to the
//    Library on "Fill the form") and missing (only a reference: skipped with a warning, everything else still loads). An MCP server always needs the
//    person's explicit confirmation, with its whole command (or address) and variable names in view; a variable with no value in `.env` says which MCP_ name to set.
//
// The choices live in the dialog (`startSelection`, `choicesOf`, `blocked`, `applyMounts`): nothing here writes. "Fill the form" in the dialog sends them to
// POST /ui/agent-export/library-apply, which stores what was chosen in the Library and answers with the ids the form may take; the agent's settings are
// written only by Save, as ever. The words live in a namespace of their own (so a tab opened before an upgrade never shows a raw key).
import { html, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import { McpDetails } from "./library-mcp-field.js";

register("agentLibrary", {
  en: {
    pick: "From the Library", skillsBox: "Skills from the Library", mcpBox: "MCP servers from the Library", embedBox: "Bundle their definitions in the file",
    none: "This agent has no Library skills or MCP servers assigned.",
    pickNote: "By default the file only names each item (its id and a hash). Bundling adds the skill's files and the MCP server's definition, so whoever loads the file can add what their Library lacks — the file gets bigger. For an MCP server only the NAMES of its variables are ever written, never a value; paused items are marked paused.",
    o_gone: "{0} is assigned to this agent but is not in the Library any more, so it is left out of the file.",
    o_notReady: "{0} was changed outside the Library or breaks one of its rules (the agent is not given it either), so it is left out of the file. Open it on the Library page and save it first.",
    o_tooBigToEmbed: "{0} is too large to bundle in the file with the others, so the file only names it.",
    // Load
    title: "From the Library", skills: "Skills", mcp: "MCP servers", checking: "Comparing with this computer’s Library…", failed: "Could not compare the file with the Library. The other settings can still be filled in.",
    lead: "Nothing is added to the Library until you press “Fill the form”: then what you ticked is added, and the form gets the ids. Your agent’s settings change only when you press Save.",
    st_present: "In your Library", st_differs: "Different version in your Library", st_missingEmbedded: "Not in your Library — the file carries it", st_missing: "Not in your Library — only named in the file",
    paused: "paused", bundledBy: "from {0}",
    missingSkill: "Skipped: the file does not carry this skill and your Library does not have it. Add it on the Library page (Import) and load the file again.",
    missingMcp: "Skipped: the file does not carry this server and your Library does not have it. Add it on the Library page, then load the file again.",
    needsVars: "It needs these variables in the .env file next to fleet.yaml:", notSet: "not set", isSet: "set",
    skillUse: "Give it to this agent", skillAdd: "Add it to my Library and give it to this agent",
    differsLead: "Your Library has “{0}” as another version. It is never replaced.", useLocal: "Use my version", saveAs: "Save the file’s version under another id", skipIt: "Skip it",
    newId: "New id", idBad: "Use lowercase letters, digits and hyphens, an id that is free, and not the same id.",
    localNotReady: "Your version is not ready to give to an agent (it was changed outside the Library or breaks a rule). Check it on the Library page.",
    fileVersion: "In the file", localVersion: "On this computer", brokenFile: "The version bundled in the file cannot be used: {0}.",
    p_bad_archive: "it is not a readable skill archive", p_mismatch: "it is not the skill (or server) it says it is", p_hash: "it does not match its hash, so it was changed after it was exported",
    p_builtin: "its name is a built-in skill’s", p_invalid: "it breaks the Library’s rules", p_bad_definition: "its definition is missing",
    showText: "Read SKILL.md", hideText: "Hide SKILL.md", files: "Files",
    mcpConfirm: "I have read exactly what this runs and the variables it is given, and I give it to this agent", mcpAddConfirm: "I have read it: add it to my Library and give it to this agent",
    mcpLead: "An MCP server runs on this computer with the variables below. Read it before you confirm.",
    envHint: "Put the value in the .env file next to fleet.yaml under {0} (a name starting with MCP_), then restart the agent. The file never carries a value.",
    changeNote: "Added to what the agent already has; nothing is removed, and an item it already has keeps its on / paused state.",
    // results
    resultTitle: "Some Library items could not be added", r_exists: "an item with that id is already in your Library", r_changed: "it changed since you read it", r_unconfirmed: "it was not confirmed", r_notReady: "it is not ready to give to an agent",
    r_invalid: "it breaks the Library’s rules", r_builtin: "its name is a built-in skill’s", r_bad_id: "that is not a valid id", r_embedded: "the bundled version cannot be used", r_missing: "it is not in your Library",
    rAdded: "added", rUsed: "used", rRenamed: "saved as {0}", rFailed: "not added",
    applyFailed: "Could not add the Library items. Nothing was filled in.", applySome: "Library: {0} ready, {1} could not be added.",
    filledLibrary: "Library: {0} skills and MCP servers added to the form.",
  },
  "zh-TW": {
    pick: "資源庫的項目", skillsBox: "資源庫的 Skill", mcpBox: "資源庫的 MCP server", embedBox: "把定義一併打包進檔案",
    none: "這個 Agent 沒有指派資源庫的 Skill 或 MCP server。",
    pickNote: "預設檔案只列出每個項目的 id 與雜湊值。打包會附上 Skill 的檔案與 MCP server 的定義，讓載入的人能補上自己資源庫缺的項目，檔案也會變大。MCP server 只會寫入變數的「名稱」，絕不寫入值；暫停中的項目會標示暫停。",
    o_gone: "{0} 已指派給這個 Agent，但已不在資源庫，所以沒有放進檔案。",
    o_notReady: "{0} 在資源庫外被改過或不符規則（Agent 也不會拿到它），所以沒有放進檔案。請先到資源庫頁開啟並儲存它。",
    o_tooBigToEmbed: "{0} 太大，無法和其他項目一起打包，所以檔案只寫它的名稱。",
    title: "資源庫", skills: "Skill", mcp: "MCP server", checking: "正在和這台電腦的資源庫比對…", failed: "無法把檔案和資源庫比對。其他設定仍可填入。",
    lead: "按下「填入表單」之前不會動到資源庫：按下後，你勾選的項目才會加進資源庫，表單會拿到它們的 id。Agent 的設定要按「儲存」才會改。",
    st_present: "資源庫已有", st_differs: "資源庫有同 id 但版本不同", st_missingEmbedded: "資源庫沒有，檔案內有附上", st_missing: "資源庫沒有，檔案只寫了名稱",
    paused: "暫停", bundledBy: "來自 {0}",
    missingSkill: "略過：檔案沒有附上這個 Skill，你的資源庫也沒有。請先到資源庫頁匯入，再重新載入檔案。",
    missingMcp: "略過：檔案沒有附上這個 server，你的資源庫也沒有。請先到資源庫頁新增，再重新載入檔案。",
    needsVars: "它需要在 fleet.yaml 旁的 .env 檔設定這些變數：", notSet: "未設定", isSet: "已設定",
    skillUse: "交給這個 Agent", skillAdd: "加進我的資源庫並交給這個 Agent",
    differsLead: "你的資源庫已有「{0}」，但版本不同。不會被覆蓋。", useLocal: "用我的版本", saveAs: "把檔案裡的版本另存成新 id", skipIt: "略過",
    newId: "新 id", idBad: "請用小寫字母、數字與連字號，且是沒被用過、與原本不同的 id。",
    localNotReady: "你的版本目前不能交給 Agent（在資源庫外被改過或不符規則）。請到資源庫頁檢查。",
    fileVersion: "檔案內的版本", localVersion: "這台電腦上的版本", brokenFile: "檔案裡附的版本無法使用：{0}。",
    p_bad_archive: "不是可讀的 Skill 壓縮檔", p_mismatch: "它不是自稱的那個 Skill（或 server）", p_hash: "和它的雜湊值不符，代表匯出後被改過",
    p_builtin: "名稱和內建 Skill 相同", p_invalid: "不符合資源庫的規則", p_bad_definition: "缺少定義",
    showText: "閱讀 SKILL.md", hideText: "收起 SKILL.md", files: "檔案",
    mcpConfirm: "我已讀過它會執行的內容與交給它的變數，同意交給這個 Agent", mcpAddConfirm: "我已讀過：加進我的資源庫並交給這個 Agent",
    mcpLead: "MCP server 會用下面的變數在這台電腦上執行。請讀過再確認。",
    envHint: "請把值寫在 fleet.yaml 旁 .env 檔的 {0}（名稱以 MCP_ 開頭），再重啟 Agent。檔案本身絕不帶值。",
    changeNote: "會加進 Agent 現有的項目；不會移除任何東西，Agent 已有的項目維持它原本的啟用／暫停狀態。",
    resultTitle: "有些資源庫項目無法加入", r_exists: "你的資源庫已有同 id 的項目", r_changed: "你讀過之後它被改過了", r_unconfirmed: "尚未確認", r_notReady: "它目前不能交給 Agent",
    r_invalid: "不符合資源庫的規則", r_builtin: "名稱和內建 Skill 相同", r_bad_id: "不是有效的 id", r_embedded: "檔案附的版本無法使用", r_missing: "資源庫裡沒有它",
    rAdded: "已加入", rUsed: "已使用", rRenamed: "另存為 {0}", rFailed: "未加入",
    applyFailed: "無法加入資源庫項目，什麼都沒有填入。", applySome: "資源庫：{0} 項就緒，{1} 項無法加入。",
    filledLibrary: "資源庫：已把 {0} 個 Skill／MCP server 填進表單。",
  },
});
const lt = (key, ...values) => t(`agentLibrary.${key}`, ...values);
export const libraryWords = lt;

export const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const idOk = (v) => typeof v === "string" && ID_RE.test(v) && !WINDOWS_DEVICE.test(v.split(".")[0]);

// ── Export ─────────────────────────────────────────────────────────────

/** The Library's checkboxes of the Export dialog. `assigned`: `{ skills, mcp }` as the server counted them (null until it has). */
export function LibraryExportPick({ groups, toggle, embed, setEmbed, assigned }) {
  const none = !!assigned && assigned.skills + assigned.mcp === 0;
  const box = (g, label, n) => html`<label class="check" key=${g}><input type="checkbox" checked=${groups.has(g)} disabled=${none || n === 0} data-export-group=${g} onChange=${() => toggle(g)} /><span>${label}${assigned ? ` (${n})` : ""}</span></label>`;
  const any = groups.has("librarySkills") || groups.has("libraryMcp");
  return html`<fieldset class="field" data-export-library><legend>${lt("pick")}</legend>
    ${box("librarySkills", lt("skillsBox"), assigned ? assigned.skills : 0)}
    ${box("libraryMcp", lt("mcpBox"), assigned ? assigned.mcp : 0)}
    <label class="check"><input type="checkbox" checked=${embed && any} disabled=${!any} data-export-embed onChange=${(e) => setEmbed(e.target.checked)} /><span>${lt("embedBox")}</span></label>
    ${none ? html`<p class="note" data-export-library-none>${lt("none")}</p>` : null}
    <p class="note">${lt("pickNote")}</p></fieldset>`;
}

/** Why an assigned item is not (fully) in the file. */
export function LibraryOmittedNotes({ items }) {
  return (items || []).map((o) => html`<p class="feedback warning" role="status" key=${`${o.kind}:${o.id}`} data-export-library-omitted=${o.reason}>${lt(`o_${o.reason}`, o.id)}</p>`);
}

// ── Load ───────────────────────────────────────────────────────────────

const STATE_WORD = { present: "st_present", differs: "st_differs", "missing-embedded": "st_missingEmbedded", missing: "st_missing" };
const rowKey = (kind, id) => `${kind}:${id}`;

/** What each row starts as. Skills that are already here are on; everything that adds to the Library, or runs a server, starts off until the person says so. */
export function startSelection(view) {
  const sel = {};
  for (const s of view.skills) sel[rowKey("skill", s.id)] = { action: s.status === "present" && s.local && s.local.ready ? "use" : "skip", as: `${s.id}-imported`.slice(0, 64), confirmed: false };
  for (const m of view.mcp) sel[rowKey("mcp", m.id)] = { action: m.status === "present" ? "use" : m.status === "missing-embedded" ? "add" : "use", as: `${m.id}-imported`.slice(0, 64), confirmed: false };
  return sel;
}

/** The action a row will really take (an MCP server not confirmed is skipped, whatever is selected). */
const effective = (kind, sel) => (kind === "mcp" && !sel.confirmed ? "skip" : sel.action);

/** The `choices` the apply route takes: only rows that do something. An MCP row carries the hash of the version the person was shown. */
export function choicesOf(view, sel) {
  const out = { skills: {}, mcp: {} };
  for (const s of view.skills) {
    const c = sel[rowKey("skill", s.id)];
    if (c && c.action !== "skip") out.skills[s.id] = { action: c.action, ...(c.action === "rename" ? { as: c.as } : {}) };
  }
  for (const m of view.mcp) {
    const c = sel[rowKey("mcp", m.id)];
    const action = c ? effective("mcp", c) : "skip";
    if (action === "skip") continue;
    const sha = action === "use" ? m.local && m.local.sha256 : m.embedded && m.embedded.ok ? m.embedded.sha256 : "";
    out.mcp[m.id] = { action, ...(action === "rename" ? { as: c.as } : {}), confirm: sha };
  }
  return out;
}

/** True when a chosen rename has no usable new id (a malformed one, the same one, or another row's). */
export function blocked(view, sel) {
  const taken = new Set([...view.skills.map((s) => s.id)]);
  return view.skills.some((s) => { const c = sel[rowKey("skill", s.id)]; return c && c.action === "rename" && (!idOk(c.as) || c.as === s.id || taken.has(c.as)); })
    || view.mcp.some((m) => { const c = sel[rowKey("mcp", m.id)]; return c && effective("mcp", c) === "rename" && (!idOk(c.as) || c.as === m.id); });
}

/** How many rows will do something (the Fill button counts them). */
export const chosenCount = (view, sel) => Object.keys(choicesOf(view, sel).skills).length + Object.keys(choicesOf(view, sel).mcp).length;

/**
 * Put the ids the apply route answered into the form (useAgentForm's setF): added to what the agent already has — nothing is removed, and an id the agent
 * already has keeps its on / paused state. `mounts`: `{ skills: { on, paused }, mcp: { on, paused } }`.
 */
export function applyMounts(setF, mounts) {
  const take = (list, ids) => [...list, ...ids.filter((id) => !list.includes(id))];
  setF((form) => {
    const paused = { skills: [], mcp: [], ...(form.library_paused || {}) };
    const out = { ...form, library_paused: { ...paused } };
    for (const [kind, field] of [["skills", "library_skills"], ["mcp", "library_mcp"]]) {
      const have = new Set([...(form[field] || []), ...(paused[kind] || [])]);
      const fresh = (ids) => [...new Set(ids)].filter((id) => !have.has(id));
      out[field] = take(form[field] || [], fresh(mounts[kind].on));
      out.library_paused[kind] = take(paused[kind] || [], fresh(mounts[kind].paused));
    }
    return out;
  });
}

function SkillText({ row }) {
  const [open, setOpen] = useState(false);
  const e = row.embedded;
  return html`<div>
    ${e.description ? html`<p class="note">${e.description}</p>` : null}
    <p class="note">${lt("files")}: ${e.files.map((f) => f.path).join(", ")}</p>
    <button type="button" class="btn btn-sm" aria-expanded=${open ? "true" : "false"} data-import-skill-text-toggle=${row.id} onClick=${() => setOpen(!open)}>${open ? lt("hideText") : lt("showText")}</button>
    ${open ? html`<pre class="pv-code lib-src" tabindex="0" data-import-skill-text=${row.id}><code>${e.skillMd}</code></pre>` : null}</div>`;
}

const radio = (name, value, current, label, set, attr) => html`<label class="check"><input type="radio" name=${name} checked=${current === value} data-import-choice=${attr || value} onChange=${() => set(value)} /><span>${label}</span></label>`;

function IdField({ row, c, set }) {
  const bad = !idOk(c.as) || c.as === row.id;
  return html`<div class="field"><label>${lt("newId")}<input type="text" maxlength="64" value=${c.as} autocomplete="off" autocapitalize="none" spellcheck=${false} data-import-rename onInput=${(e) => set({ ...c, as: e.target.value.trim() })} /></label>
    ${bad ? html`<span class="note feedback error" role="alert">${lt("idBad")}</span>` : null}</div>`;
}

function SkillRow({ row, c, set }) {
  const readyLocal = !!row.local && row.local.ready;
  const emb = row.embedded && row.embedded.ok ? row.embedded : null;
  return html`<section class="card lib-import-skill" data-import-row=${`skill:${row.id}`} data-import-status=${row.status}>
    <div class="lib-import-head"><span class="strong">${row.id}</span> <span class="pill" data-import-state>${lt(STATE_WORD[row.status])}</span>${row.paused ? html` <span class="pill off">${lt("paused")}</span>` : null}</div>
    ${row.status === "present" ? html`
      ${row.local && row.local.description ? html`<p class="note">${row.local.description}</p>` : null}
      ${readyLocal ? html`<label class="check"><input type="checkbox" checked=${c.action === "use"} data-import-choice="use" onChange=${(e) => set({ ...c, action: e.target.checked ? "use" : "skip" })} /><span>${lt("skillUse")}</span></label>`
        : html`<p class="feedback warning" role="note">${lt("localNotReady")}</p>`}` : null}
    ${row.status === "missing-embedded" ? html`<${SkillText} row=${row} />
      <label class="check"><input type="checkbox" checked=${c.action === "add"} data-import-choice="add" onChange=${(e) => set({ ...c, action: e.target.checked ? "add" : "skip" })} /><span>${lt("skillAdd")}</span></label>` : null}
    ${row.status === "differs" ? html`<fieldset class="lib-clash"><legend class="note">${lt("differsLead", row.id)}</legend>
      ${row.local && !readyLocal ? html`<p class="feedback warning" role="note">${lt("localNotReady")}</p>` : null}
      ${emb ? html`<${SkillText} row=${row} />` : row.embedded ? html`<p class="feedback warning" role="note">${lt("brokenFile", lt(`p_${row.embedded.problem}`))}</p>` : null}
      <div class="checks">
        ${readyLocal ? radio(`imp-s-${row.id}`, "use", c.action, lt("useLocal"), (v) => set({ ...c, action: v })) : null}
        ${emb ? radio(`imp-s-${row.id}`, "rename", c.action, lt("saveAs"), (v) => set({ ...c, action: v })) : null}
        ${radio(`imp-s-${row.id}`, "skip", c.action, lt("skipIt"), (v) => set({ ...c, action: v }))}</div>
      ${c.action === "rename" ? html`<${IdField} row=${row} c=${c} set=${set} />` : null}</fieldset>` : null}
    ${row.status === "missing" ? html`<p class="feedback warning" role="note" data-import-missing>${row.embedded && !row.embedded.ok ? lt("brokenFile", lt(`p_${row.embedded.problem}`)) : lt("missingSkill")}</p>` : null}
  </section>`;
}

/** The variables a reference names, with whether `.env` has a value (never the value). */
function VarsNote({ vars }) {
  const missing = vars.filter((v) => !v.set);
  return html`<div class="note" data-import-vars>${lt("needsVars")} ${vars.map((v) => html`<code key=${v.name}>${v.name}</code> <span class=${`pill${v.set ? "" : " off"}`}>${v.set ? lt("isSet") : lt("notSet")}</span> `)}
    ${missing.length ? html`<br />${lt("envHint", missing.map((v) => v.name).join(", "))}` : null}</div>`;
}

function McpRow({ row, c, set }) {
  const local = row.local && row.local.summary ? { id: row.id, ...row.local } : null;
  const emb = row.embedded && row.embedded.ok ? { id: row.id, ...row.embedded } : null;
  const showLocal = local && (row.status === "present" || (row.status === "differs" && c.action === "use"));
  const showEmb = emb && (row.status === "missing-embedded" || (row.status === "differs" && c.action === "rename"));
  const can = (row.status === "present" && local) || (row.status === "missing-embedded" && emb) || (row.status === "differs" && (local || emb));
  return html`<section class="card lib-import-skill" data-import-row=${`mcp:${row.id}`} data-import-status=${row.status}>
    <div class="lib-import-head"><span class="strong">${row.id}</span> <span class="pill" data-import-state>${lt(STATE_WORD[row.status])}</span>${row.paused ? html` <span class="pill off">${lt("paused")}</span>` : null}</div>
    ${row.status === "missing" ? html`<p class="feedback warning" role="note" data-import-missing>${row.embedded && !row.embedded.ok ? lt("brokenFile", lt(`p_${row.embedded.problem}`)) : lt("missingMcp")}</p><${VarsNote} vars=${row.vars} />` : null}
    ${row.status === "differs" ? html`<fieldset class="lib-clash"><legend class="note">${lt("differsLead", row.id)}</legend>
      ${row.local && row.local.badVars && row.local.badVars.length ? html`<p class="feedback warning" role="note">${lt("localNotReady")}</p>` : null}
      ${row.embedded && !row.embedded.ok ? html`<p class="feedback warning" role="note">${lt("brokenFile", lt(`p_${row.embedded.problem}`))}</p>` : null}
      <div class="checks">
        ${local ? radio(`imp-m-${row.id}`, "use", c.action, `${lt("useLocal")} (${lt("localVersion")})`, (v) => set({ ...c, action: v })) : null}
        ${emb ? radio(`imp-m-${row.id}`, "rename", c.action, lt("saveAs"), (v) => set({ ...c, action: v })) : null}</div>
      ${c.action === "rename" ? html`<${IdField} row=${row} c=${c} set=${set} />` : null}</fieldset>` : null}
    ${can ? html`<p class="note">${lt("mcpLead")}</p>
      ${row.status === "differs" ? html`<p class="note strong">${showEmb ? lt("fileVersion") : lt("localVersion")}</p>` : null}
      ${showLocal ? html`<${McpDetails} item=${local} />` : null}
      ${showEmb ? html`<${McpDetails} item=${emb} />` : null}
      ${(showLocal ? local : emb).variables.some((v) => !v.set) ? html`<p class="note" data-import-envhint>${lt("envHint", (showLocal ? local : emb).variables.filter((v) => !v.set).map((v) => v.name).join(", "))}</p>` : null}
      <label class="check"><input type="checkbox" checked=${c.confirmed} data-import-confirm onChange=${(e) => set({ ...c, confirmed: e.target.checked })} /><span>${row.status === "missing-embedded" || (row.status === "differs" && c.action === "rename") ? lt("mcpAddConfirm") : lt("mcpConfirm")}</span></label>` : null}
  </section>`;
}

/** The Library part of the Load dialog: `view` is `{ skills, mcp }` from POST /ui/agent-export/library-status. */
export function LibraryImportSection({ view, sel, setSel }) {
  const setRow = (kind, id) => (c) => setSel((s) => ({ ...s, [rowKey(kind, id)]: c }));
  return html`<div data-load-library-section>
    <p><strong>${lt("title")}</strong></p>
    <p class="note">${lt("lead")}</p>
    ${view.skills.length ? html`<h4>${lt("skills")}</h4>${view.skills.map((s) => html`<${SkillRow} key=${s.id} row=${s} c=${sel[rowKey("skill", s.id)] || { action: "skip", as: "", confirmed: false }} set=${setRow("skill", s.id)} />`)}` : null}
    ${view.mcp.length ? html`<h4>${lt("mcp")}</h4>${view.mcp.map((m) => html`<${McpRow} key=${m.id} row=${m} c=${sel[rowKey("mcp", m.id)] || { action: "skip", as: "", confirmed: false }} set=${setRow("mcp", m.id)} />`)}` : null}
    <p class="note">${lt("changeNote")}</p>
  </div>`;
}

/** What the apply route could not do, in words (one line per item). */
export function ApplyFailures({ results }) {
  const bad = [...results.skills, ...results.mcp].filter((o) => o.outcome === "failed");
  if (!bad.length) return null;
  return html`<div class="feedback error" role="alert" data-import-failures><strong>${lt("resultTitle")}</strong>
    <ul>${bad.map((o) => html`<li key=${o.id} data-import-failure=${o.id}><code>${o.id}</code> — ${lt(`r_${o.reason}`)}</li>`)}</ul></div>`;
}
