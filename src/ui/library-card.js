// AGEND-261: the shared parts of the agent settings' "Skills" and "MCP servers" cards (Settings → agent → Workspace). Each card has two sections:
//   1. "Assigned to this agent" — the Library's items given to it. A bordered list, one row per item, a divider between rows: icon, the name in bold
//      with one line of what it is (and, under it, its state: no value for a variable, changed since it was confirmed, paused…), and on the right
//      an ON/OFF switch and a trash. The switch PAUSES the item without removing it (it moves from `library.skills` / `library.mcp` to
//      `library.paused`, which nothing that gives items reads); the trash removes it (after a confirmation). "+ Add" sits in this section's
//      header and opens a picker (a Dialog): the Library's items that are not assigned yet, with a filter; one is read first (its preview — SKILL.md
//      for a skill, the command / address and variables for an MCP server), and "Enable" assigns it. Several can follow one another.
//   2. "Built in (given by role)" — what AgEnD gives the agent by itself, read only, collapsed by default; opened, the same list style with a
//      "Built in" mark and no controls.
// Nothing is written here: switching, removing and adding change the form's lists, and Save is the settings page's own (settings-model.js agentPatch).
//
// This file holds what the two cards share and their words (namespace `libraryCard`); the data and the per-kind rules are in
// library-mount-field.js (skills) and library-mcp-field.js (MCP servers).
import { html, useEffect, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import { Dialog } from "/assets/ui-dialog.js";
import { confirmDialog } from "/assets/ui-confirm.js";
import { Icon } from "/assets/ui-icons.js";
import { Skeleton } from "/assets/ui-states.js";
import { Switch } from "./settings-shared.js";

register("libraryCard", {
  en: {
    add: "Add", addLabel: "Assign to this agent",
    assigned: "Assigned to this agent", assignedHint: "Turn a switch off to pause an item without removing it. Applies after this agent restarts.",
    builtinTitle: "Built in (given by role)", builtinHint: "AgEnD provides these automatically; they cannot be turned off here.", builtinTag: "Built in",
    libraryTag: "Library", paused: "Paused: not given to the agent", switchName: "{0}: on or paused", remove: "Remove {0}",
    removeTitle: "Remove “{0}” from this agent?", removeBody: "It stays in the Library. This agent stops getting it after its next restart.", removeConfirm: "Remove",
    back: "Back", enable: "Enable", done: "Done", enabledNote: "“{0}” is assigned. It applies after you Save and the agent restarts.",
    noMatch: "Nothing matches “{0}”.", previewFailed: "Could not read it. Go back and try again.",
    notReady: "Not available: it was changed outside the Library or breaks a rule — check it on the Library page",
  },
  "zh-TW": {
    add: "新增", addLabel: "指派給這個 Agent",
    assigned: "已指派給此 Agent", assignedHint: "關閉開關可暫停使用而不移除；重新啟動此 Agent 後生效。",
    builtinTitle: "內建（依角色自動帶入）", builtinHint: "AgEnD 自動提供，無法在這裡關閉。", builtinTag: "內建",
    libraryTag: "資源庫", paused: "已暫停：不會交給 Agent", switchName: "{0}：啟用或暫停", remove: "移除 {0}",
    removeTitle: "要把「{0}」從這個 Agent 移除嗎？", removeBody: "它仍在資源庫裡。這個 Agent 下次啟動後就不再拿到它。", removeConfirm: "移除",
    back: "返回", enable: "啟用", done: "完成", enabledNote: "已指派「{0}」。按儲存並重啟 Agent 後生效。",
    noMatch: "沒有符合「{0}」的項目。", previewFailed: "無法讀取。請返回再試一次。",
    notReady: "無法使用：它在資源庫外被改過或不符規則，請到資源庫頁檢查",
  },
});
const lc = (key, ...values) => t(`libraryCard.${key}`, ...values);

/** `list` in the order the saved settings had them (those first), then the rest as they came: switching an item off and on again writes back exactly what was saved. */
export const keepSavedOrder = (saved, list) => [...(Array.isArray(saved) ? saved.filter((id) => list.includes(id)) : []), ...list.filter((id) => !Array.isArray(saved) || !saved.includes(id))];

/** The card itself: its title row (the title node carries the usual tip and restart badge) and the sections. `attrs`: the data attributes the callers and tests find it by. */
export function LibraryCardShell({ title, innerRef, attrs, children }) {
  return html`<section class="card ap-span2 lib-card" ref=${innerRef} ...${attrs}><h3>${title}</h3>${children}</section>`;
}

/** Section 1's header: its title, a line of what a switch does, and "+ Add" at the right. */
export function AssignedHeader({ onAdd, addDisabled, addTitle }) {
  return html`<div class="lib-sec-head"><div class="lib-sec-text"><h4 class="lib-sec-title">${lc("assigned")}</h4><p class="note lib-sec-hint">${lc("assignedHint")}</p></div>
    <button type="button" class="btn btn-sm lib-card-add" onClick=${onAdd} disabled=${!!addDisabled} title=${addTitle || lc("addLabel")} data-library-add-open><${Icon} name="plus" size=${14} /> ${lc("add")}</button></div>`;
}

/** The bordered list: its rows are `ListRow`s, a divider between them. */
export const ItemList = ({ children, attr }) => html`<ul class="lib-list" ...${attr || {}}>${children}</ul>`;

/** An empty section: a dashed frame and one line. */
export const EmptyList = ({ text }) => html`<div class="lib-empty" data-library-empty>${text}</div>`;

/** One row: icon, the name in bold with one line under it (cut when long), what is wrong with it, and the controls at the right. */
export function ListRow({ icon, name, description, tag, status, controls, attr, off }) {
  return html`<li class=${`lib-li${off ? " is-off" : ""}`} ...${attr || {}}>
    <span class="lib-li-ico"><${Icon} name=${icon} size=${18} /></span>
    <div class="lib-li-main"><div class="lib-li-name"><span class="strong">${name}</span>${tag ? html`<span class="pill lib-kind">${tag}</span>` : null}</div>
      <div class="note lib-li-desc" title=${description || undefined}>${description || ""}</div>
      ${status ? html`<div class="lib-li-status">${status}</div>` : null}</div>
    ${controls ? html`<div class="lib-li-ctl">${controls}</div>` : null}
  </li>`;
}

/** The two controls of an assigned row: the ON / PAUSED switch (the page's own `Switch`) and the trash, which asks first. */
export function AssignedControls({ id, on, onToggle, onRemove }) {
  const remove = async () => { if (await confirmDialog({ title: lc("removeTitle", id), message: lc("removeBody"), confirmLabel: lc("removeConfirm"), danger: true })) onRemove(); };
  return html`<span class="lib-switch" data-library-switch=${id}><${Switch} id=${`lib-sw-${id}`} checked=${on} name=${lc("switchName", id)} onChange=${onToggle} /></span>
    <button type="button" class="icon-btn lib-li-x" onClick=${remove} aria-label=${lc("remove", id)} title=${lc("remove", id)} data-library-remove=${id}><${Icon} name="trash" size=${16} /></button>`;
}

/** Section 2: what the agent gets by itself — one header that opens a read-only list in the same style, each row marked "Built in". Nothing built in: nothing drawn. */
export function BuiltinSection({ items, attr, icon }) {
  const [open, setOpen] = useState(false);
  if (!items.length) return null;
  return html`<div class="lib-sec lib-builtin-box" data-library-builtin-summary>
    <button type="button" class="lib-builtin-toggle" aria-expanded=${open ? "true" : "false"} onClick=${() => setOpen(!open)} data-library-builtin-toggle>
      <${Icon} name="chevron" size=${14} /><span class="strong">${lc("builtinTitle")}</span><span class="note">${items.length}</span></button>
    ${open ? html`<p class="note lib-sec-hint">${lc("builtinHint")}</p>
      <${ItemList} attr=${{ "data-library-builtin-list": "" }}>${items.map((b) => html`<${ListRow} key=${b.name} icon=${icon} name=${b.name} description=${b.description} tag=${lc("builtinTag")} attr=${{ [attr]: b.name }} />`)}</${ItemList}>` : null}
  </div>`;
}

/**
 * The picker. `items`: `{ id, description, disabled?, note? }` — the Library's items that are not enabled. `renderPreview(item)`: what reading one shows
 * (a node, or a component's result). `onEnable(item)`: resolves `{ ok: true }` or `{ ok: false, error }`; the caller adds the item to the form, so it
 * leaves `items` and the picker is back at its list, with a line saying what was enabled. `enableDisabled(item)`: the caller can hold "Enable" back.
 */
export function AddDialog({ title, items, filterLabel, emptyText, renderPreview, onEnable, enableDisabled, onClose }) {
  const [filter, setFilter] = useState("");
  const [picked, setPicked] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const item = picked && items.find((i) => i.id === picked) ? items.find((i) => i.id === picked) : null;
  // The item that was open left the list (it was enabled): back to the list.
  useEffect(() => { if (picked && !item) setPicked(null); }, [picked, item]);
  const q = filter.trim().toLowerCase();
  const shown = items.filter((i) => !q || i.id.toLowerCase().includes(q) || (i.description || "").toLowerCase().includes(q));
  const enable = async () => {
    if (!item || busy) return;
    setBusy(true); setError("");
    try {
      const r = await onEnable(item);
      if (r && r.ok) { setDone(lc("enabledNote", item.id)); setPicked(null); } else setError((r && r.error) || "");
    } finally { setBusy(false); }
  };
  const actions = item
    ? html`<button type="button" class="btn" onClick=${() => { setPicked(null); setError(""); }} disabled=${busy} data-library-picker-back>${lc("back")}</button>
        <span class="dlg-spacer"></span>
        <button type="button" class="btn btn-primary" onClick=${enable} disabled=${busy || !!(enableDisabled && enableDisabled(item))} data-library-picker-enable>${lc("enable")}</button>`
    : html`<span class="dlg-spacer"></span><button type="button" class="btn btn-primary" onClick=${onClose} data-library-picker-done>${lc("done")}</button>`;
  return html`<${Dialog} title=${item ? item.id : title} onClose=${onClose} busy=${busy} wide=${true} actions=${actions}>
    <div class="form lib-picker" data-library-picker=${item ? "preview" : "list"}>
      ${item ? html`<div class="lib-picker-preview" data-library-picker-preview=${item.id}>${renderPreview(item)}</div>
        ${error ? html`<p class="feedback error" role="alert" data-library-error>${error}</p>` : null}`
        : html`<label class="s-search lib-picker-filter"><${Icon} name="search" size=${14} /><span class="sr-only">${filterLabel}</span>
            <input type="search" value=${filter} placeholder=${filterLabel} data-library-picker-filter onInput=${(e) => setFilter(e.target.value)} /></label>
          ${done ? html`<p class="feedback success" role="status" data-library-picker-done-note>${done}</p>` : null}
          ${shown.length ? html`<ul class="lib-picker-list" data-library-picker-list>${shown.map((i) => html`<li key=${i.id}>
              <button type="button" class="lib-picker-item" disabled=${!!i.disabled} onClick=${() => { setPicked(i.id); setDone(""); setError(""); }} data-library-pick-item=${i.id}>
                <span class="strong">${i.id}</span><span class="note lib-picker-desc">${i.description || ""}</span>${i.disabled && i.note ? html`<span class="note lib-picker-note">${i.note}</span>` : null}</button></li>`)}</ul>`
            : html`<p class="note" data-library-picker-empty>${q && items.length ? lc("noMatch", filter.trim()) : emptyText}</p>`}`}
    </div>
  </${Dialog}>`;
}

/** A preview that is read from the server when it opens: `load()` resolves what to show (`render(data)`), or null when it cannot be read. */
export function LoadedPreview({ load, render, deps }) {
  const [state, setState] = useState({ loading: true });
  useEffect(() => {
    let live = true;
    setState({ loading: true });
    Promise.resolve().then(load).then((data) => { if (live) setState(data ? { data } : { error: true }); }, () => { if (live) setState({ error: true }); });
    return () => { live = false; };
  }, deps);
  if (state.loading) return html`<${Skeleton} lines=${4} />`;
  if (state.error) return html`<p class="feedback error" role="alert">${lc("previewFailed")}</p>`;
  return render(state.data);
}

export const cardWords = { notReady: () => lc("notReady"), libraryTag: () => lc("libraryTag"), paused: () => lc("paused") };
