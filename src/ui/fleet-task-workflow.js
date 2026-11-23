// The task board's statuses, as a project words them (Fleet › Tasks › a project › Statuses; AGEND-332): each of the six
// statuses gets its own name, a colour from the palette, a place in the order, a one-line meaning, and (for the ones that
// may) a column that hides while it is empty. This changes how a status LOOKS on the board, the list, the filters, the
// card and the public link — never what it does: who may move a card, who is woken, what a move needs written, the
// numbers and the dependencies still read the six statuses. Saving gives the project a workflow of its own (until then
// it reads the default one); the default one covers the cards in no project and every project without its own.
// Only a signed-in person saves (the host refuses a token and the read-only public link). No style attribute (the CSP):
// a colour is a class from the palette (`sc-<name>`, app.css).
import { html, useState } from "/assets/app-html.js";
import { t, register } from "/assets/app-i18n.js";
import { Dialog } from "/assets/ui-dialog.js";
import { Icon } from "/assets/ui-icons.js";
import { toast } from "/assets/ui-toast.js";
import { HIDEABLE, NO_PROJECT, STATUS_COLORS, STATUS_LIMITS, boardApi, defaultIsCustom, errorText, hasOwnWorkflow, workflowOf } from "./fleet-task-common.js";

register("taskflow", {
  en: {
    button: "Statuses", tip: "Rename, recolour and reorder this project's statuses", menu: "Statuses…",
    default: "Default statuses", defaultTip: "The statuses of cards in no project, and of every project that has none of its own",
    title: "Statuses: {0}", titleDefault: "Default statuses",
    introOwn: "These names, colours and this order are this project's own. What each status does — who is told, what a move needs — does not change.",
    introInherit: "This project uses the default statuses. Saving gives it statuses of its own.",
    introDefault: "These cover cards in no project, and every project that has no statuses of its own. What each status does — who is told, what a move needs — does not change.",
    name: "Name", namePlaceholder: "{0}", description: "Meaning", descriptionHint: "Shown when you hover the status",
    color: "Colour", colorOf: "{0}: colour", up: "Move {0} up", down: "Move {0} down",
    hideEmpty: "Hide this column while it is empty", notColumn: "Not a column", is: "is", categoryOf: "Built-in: {0}",
    "color.gray": "Gray", "color.blue": "Blue", "color.green": "Green", "color.yellow": "Yellow", "color.red": "Red",
    "meaning.open": "Not started. New cards begin here.",
    "meaning.claimed": "Being worked on. An instance works on one card at a time.",
    "meaning.blocked": "Waiting for an answer: needs a reason, and a card you handed out waits in your list.",
    "meaning.review": "Finished, waiting for someone to confirm it.",
    "meaning.done": "Finished. Cards that depend on it can start.",
    "meaning.cancelled": "Not a column. A cancelled card can be restored, and still holds back the cards that depend on it.",
    save: "Save", cancel: "Cancel", reset: "Use the default", resetOwn: "Use the default statuses", saved: "Statuses saved", resetDone: "Back to the default statuses",
    dupe: "Two statuses have the same name", count: "{0}/{1}",
  },
  "zh-TW": {
    button: "狀態", tip: "改這個專案各個狀態的名稱、顏色和順序", menu: "狀態…",
    default: "預設狀態", defaultTip: "沒有專案的卡片，以及沒有自己一套狀態的專案，都用這一組",
    title: "狀態：{0}", titleDefault: "預設狀態",
    introOwn: "這裡的名稱、顏色和順序只屬於這個專案。每個狀態的作用（誰會被通知、移動要寫什麼）不會變。",
    introInherit: "這個專案目前用預設狀態。儲存後，它會有自己一套。",
    introDefault: "沒有專案的卡片，以及沒有自己一套狀態的專案，都用這一組。每個狀態的作用（誰會被通知、移動要寫什麼）不會變。",
    name: "名稱", namePlaceholder: "{0}", description: "意思", descriptionHint: "滑鼠移到狀態上時顯示",
    color: "顏色", colorOf: "{0}：顏色", up: "把{0}往前移", down: "把{0}往後移",
    hideEmpty: "這一欄沒有卡片時先隱藏", notColumn: "不是欄位", is: "是", categoryOf: "內建：{0}",
    "color.gray": "灰", "color.blue": "藍", "color.green": "綠", "color.yellow": "黃", "color.red": "紅",
    "meaning.open": "還沒開始。新卡片從這裡開始。",
    "meaning.claimed": "正在做。Agent 同時只做一張卡。",
    "meaning.blocked": "卡在等人回答：要寫原因；你派出的卡會出現在待你處理。",
    "meaning.review": "做完了，等人確認。",
    "meaning.done": "已完成。依賴它的卡可以開始。",
    "meaning.cancelled": "不是欄位。已取消的卡可以恢復，依賴它的卡仍然會等。",
    save: "儲存", cancel: "取消", reset: "改用預設", resetOwn: "改用預設狀態", saved: "狀態已儲存", resetDone: "已改回預設狀態",
    dupe: "有兩個狀態同名", count: "{0}/{1}",
  },
});

/** The rows a dialog starts from: the workflow `scope` reads, the columns in its order and the cancelled status last (it is no column). */
export function startRows(scope) {
  const list = workflowOf(scope);
  const cols = list.filter((s) => s.key !== "cancelled");
  const rest = list.filter((s) => s.key === "cancelled");
  return [...cols, ...rest].map((s) => ({ key: s.key, name: s.name || "", description: s.description || "", color: s.color, hideEmpty: s.hideEmpty === true && HIDEABLE.includes(s.key) }));
}

/** What a save sends: the rows as they stand, in order, the cancelled status last. */
export function workflowBody(rows) {
  const cols = rows.filter((r) => r.key !== "cancelled");
  const rest = rows.filter((r) => r.key === "cancelled");
  return [...cols, ...rest].map((r) => ({ key: r.key, name: r.name.trim(), description: r.description.trim(), color: r.color, hideEmpty: HIDEABLE.includes(r.key) && r.hideEmpty }));
}

/** Rows with `key` moved one place up (-1) or down (+1) among the columns; the same rows when it cannot move. */
export function moveRow(rows, key, by) {
  const cols = rows.filter((r) => r.key !== "cancelled");
  const i = cols.findIndex((r) => r.key === key), j = i + by;
  if (i < 0 || j < 0 || j >= cols.length) return rows;
  const next = [...cols];
  [next[i], next[j]] = [next[j], next[i]];
  return [...next, ...rows.filter((r) => r.key === "cancelled")];
}

/** The first name two rows share (case-insensitive, blanks ignored), or null. */
export function sharedName(rows) {
  const seen = new Set();
  for (const r of rows) {
    const n = r.name.trim().toLocaleLowerCase();
    if (!n) continue;
    if (seen.has(n)) return r.name.trim();
    seen.add(n);
  }
  return null;
}

/**
 * The Statuses dialog of a project (`project`: its object) or of the default workflow (`project`: NO_PROJECT).
 * `onSaved()` runs after a save or a reset, once the board is to be read again.
 */
export function WorkflowDialog({ project, onClose, onSaved }) {
  const isDefault = project === NO_PROJECT || !project;
  const id = isDefault ? null : project.id;
  const scope = isDefault ? NO_PROJECT : project.id;
  const [rows, setRows] = useState(() => startRows(scope));
  const [busy, setBusy] = useState(false);
  const was = JSON.stringify(workflowBody(startRows(scope)));
  const own = isDefault ? defaultIsCustom() : hasOwnWorkflow(id);
  const clash = sharedName(rows);
  const changed = JSON.stringify(workflowBody(rows)) !== was;
  const set = (key, patch) => setRows((cur) => cur.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  async function run(call, said) {
    setBusy(true);
    try { await call(); toast(t(said)); onSaved(); } catch (err) { toast(errorText(err), false); setBusy(false); }
  }
  const save = () => { if (!clash && (changed || !own)) void run(() => boardApi.setWorkflow(id, workflowBody(rows)), "taskflow.saved"); };
  const reset = () => void run(() => boardApi.setWorkflow(id, null), "taskflow.resetDone");
  const columns = rows.filter((r) => r.key !== "cancelled");
  return html`<${Dialog} title=${isDefault ? t("taskflow.titleDefault") : t("taskflow.title", project.name)} onClose=${onClose} busy=${busy} wide
    actions=${html`${own ? html`<button type="button" class="btn btn-ghost tf-reset" onClick=${reset} disabled=${busy}>${t(isDefault ? "taskflow.reset" : "taskflow.resetOwn")}</button>` : null}
      <span class="dlg-spacer"></span>
      <button type="button" class="btn" onClick=${onClose} disabled=${busy}>${t("taskflow.cancel")}</button>
      <button type="button" class="btn btn-primary" onClick=${save} disabled=${busy || !!clash || (own && !changed)}>${t("taskflow.save")}</button>`}>
    <form class="form tf" onSubmit=${(e) => { e.preventDefault(); save(); }}><fieldset class="form tf" disabled=${busy}>
      <p class="tf-note">${t(isDefault ? "taskflow.introDefault" : own ? "taskflow.introOwn" : "taskflow.introInherit")}</p>
      ${clash ? html`<p class="tf-note tf-error" role="alert">${t("taskflow.dupe")}: ${clash}</p>` : null}
      <ul class="tf-rows">${rows.map((r) => {
        const col = columns.findIndex((c) => c.key === r.key);
        const label = r.name.trim() || t(`tasks.${r.key}`);
        return html`<li key=${r.key} class="tf-row" data-status=${r.key}>
          <div class="tf-move">
            ${col >= 0 ? html`<button type="button" class="icon-btn" title=${t("taskflow.up", label)} aria-label=${t("taskflow.up", label)} disabled=${col === 0} onClick=${() => setRows(moveRow(rows, r.key, -1))}><${Icon} name="up" size=${14} /></button>
            <button type="button" class="icon-btn" title=${t("taskflow.down", label)} aria-label=${t("taskflow.down", label)} disabled=${col === columns.length - 1} onClick=${() => setRows(moveRow(rows, r.key, 1))}><${Icon} name="down" size=${14} /></button>` : null}
          </div>
          <div class="tf-body">
            <div class="tf-main">
              <div class="tf-colors" role="radiogroup" aria-label=${t("taskflow.colorOf", label)}>${STATUS_COLORS.map((c) => html`<button key=${c} type="button" role="radio" class="tf-swatch" aria-checked=${r.color === c ? "true" : "false"}
                title=${t(`taskflow.color.${c}`)} aria-label=${t(`taskflow.color.${c}`)} onClick=${() => set(r.key, { color: c })}><span class=${`tb-dot sc-${c}`}></span></button>`)}</div>
              <input class="tf-name" value=${r.name} maxlength=${STATUS_LIMITS.name} placeholder=${t(`tasks.${r.key}`)} aria-label=${`${t("taskflow.name")}: ${t(`tasks.${r.key}`)}`}
                onInput=${(e) => { const v = e.target.value; set(r.key, { name: v }); }} />
              <span class="tf-cat" title=${t(`taskflow.meaning.${r.key}`)}>${t("taskflow.categoryOf", t(`tasks.${r.key}`))}</span>
            </div>
            <input class="tf-desc" value=${r.description} maxlength=${STATUS_LIMITS.description} placeholder=${t(`taskflow.meaning.${r.key}`)} aria-label=${`${t("taskflow.description")}: ${label}`}
              title=${t("taskflow.descriptionHint")} onInput=${(e) => { const v = e.target.value; set(r.key, { description: v }); }} />
            ${HIDEABLE.includes(r.key) ? html`<label class="tb-check tf-hide"><input type="checkbox" checked=${r.hideEmpty} onChange=${(e) => { const v = e.target.checked; set(r.key, { hideEmpty: v }); }} />${t("taskflow.hideEmpty")}</label>` : null}
            ${r.key === "cancelled" ? html`<p class="tf-hint">${t("taskflow.notColumn")}</p>` : null}
          </div>
        </li>`;
      })}</ul>
    </fieldset></form></${Dialog}>`;
}
