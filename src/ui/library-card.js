// AGEND-261: the shared parts of the agent settings' "Skills" and "MCP servers" cards (Settings → agent → Workspace). Each card lists ONLY what the
// agent has switched on:
//   - the built-in items it gets by itself, as ONE line ("9 built in · automatic") that opens to a read-only list;
//   - the Library's items that are enabled, one row each: its name, what is wrong with it (no value for a variable, changed since it was
//     confirmed, gone from the Library…) and a × to remove it;
//   - an empty state when no Library item is enabled.
// A "+ Add" button in the card's title row opens a picker (a Dialog): the Library's items that are NOT enabled yet, with a filter; one is
// read first (its preview — SKILL.md for a skill, the command / address and variables for an MCP server), and "Enable" adds it. Several can be
// enabled one after the other; closing the dialog returns to the card. Nothing is written here: enabling and removing change the form's
// `library.skills` / `library.mcp` lists, and Save is the settings page's own (settings-model.js agentPatch).
//
// This file holds what the two cards share and their words (namespace `libraryCard`); the data and the per-kind rules are in
// library-mount-field.js (skills) and library-mcp-field.js (MCP servers).
import { html, useEffect, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import { Dialog } from "/assets/ui-dialog.js";
import { Icon } from "/assets/ui-icons.js";
import { Skeleton } from "/assets/ui-states.js";

register("libraryCard", {
  en: {
    add: "Add", addLabel: "Add to this agent",
    builtinSummary: "{0} built in · automatic", builtinHint: "Given automatically; they cannot be turned off here.",
    libraryTag: "Library", remove: "Remove {0}",
    back: "Back", enable: "Enable", done: "Done", enabledNote: "“{0}” is enabled. It applies after you Save and the agent restarts.",
    noMatch: "Nothing matches “{0}”.", loadingPreview: "Reading it…", previewFailed: "Could not read it. Go back and try again.",
    notReady: "Not available: it was changed outside the Library or breaks a rule — check it on the Library page",
  },
  "zh-TW": {
    add: "新增", addLabel: "加到這個 Agent",
    builtinSummary: "內建 {0} 個・自動", builtinHint: "自動帶入，無法在這裡取消。",
    libraryTag: "資源庫", remove: "移除 {0}",
    back: "返回", enable: "啟用", done: "完成", enabledNote: "已啟用「{0}」。按儲存並重啟 Agent 後生效。",
    noMatch: "沒有符合「{0}」的項目。", loadingPreview: "讀取中…", previewFailed: "無法讀取。請返回再試一次。",
    notReady: "無法使用：它在資源庫外被改過或不符規則，請到資源庫頁檢查",
  },
});
const lc = (key, ...values) => t(`libraryCard.${key}`, ...values);

/** The card itself: a title row (title on the left, "+ Add" on the right) and what the card holds. `attrs`: the data attributes the callers and tests find it by. */
export function LibraryCardShell({ title, onAdd, addDisabled, addTitle, innerRef, attrs, children }) {
  return html`<section class="card ap-span2 lib-card" ref=${innerRef} ...${attrs}>
    <div class="lib-card-head"><h3>${title}</h3>
      <button type="button" class="btn btn-sm lib-card-add" onClick=${onAdd} disabled=${!!addDisabled} title=${addTitle || lc("addLabel")} data-library-add-open><${Icon} name="plus" size=${14} /> ${lc("add")}</button></div>
    ${children}
  </section>`;
}

/** The built-in items as one line; it opens to a read-only list (name and what it is for). Nothing built in: nothing drawn. */
export function BuiltinSummary({ items, attr }) {
  const [open, setOpen] = useState(false);
  if (!items.length) return null;
  return html`<div class="lib-builtin-box" data-library-builtin-summary>
    <button type="button" class="lib-builtin-toggle" aria-expanded=${open ? "true" : "false"} onClick=${() => setOpen(!open)} data-library-builtin-toggle>
      <${Icon} name="chevron" size=${14} /><span>${lc("builtinSummary", items.length)}</span></button>
    ${open ? html`<ul class="lib-builtin-list" data-library-builtin-list><li class="note lib-builtin-hint">${lc("builtinHint")}</li>
      ${items.map((b) => html`<li key=${b.name} class="lib-builtin" ...${{ [attr]: b.name }}><span class="strong">${b.name}</span><span class="note lib-builtin-desc" title=${b.description || undefined}>${b.description || ""}</span></li>`)}</ul>` : null}
  </div>`;
}

/** One enabled Library item: its name and description, a × to remove it, and what the caller says about it (`children`). */
export function EnabledRow({ id, description, onRemove, attr, children }) {
  return html`<div class="lib-en-row" ...${{ [attr]: id }}>
    <div class="lib-en-main"><span class="strong">${id}</span><span class="note lib-en-desc" title=${description || undefined}>${description || ""}</span><span class="pill lib-kind">${lc("libraryTag")}</span></div>
    <button type="button" class="icon-btn lib-en-x" onClick=${onRemove} aria-label=${lc("remove", id)} title=${lc("remove", id)} data-library-remove=${id}><${Icon} name="close" size=${14} /></button>
    ${children ? html`<div class="lib-en-status">${children}</div>` : null}
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

export const cardWords = { notReady: () => lc("notReady"), libraryTag: () => lc("libraryTag") };
