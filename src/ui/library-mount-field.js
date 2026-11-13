// AGEND-244 / AGEND-261: the "Skills" card of an agent's settings (Settings → agent → Workspace). It lists what the agent has switched on — the
// built-in skills it gets by its role as one line that opens to a read-only list, and the Library's skills that are enabled, each with a × — and a
// "+ Add" in its title row opens the picker of the Library's skills that are not enabled yet (src/ui/library-card.js has the shared parts). The
// administrator's choices become the `library.skills` value of the agent's patch (settings-model.js); nothing here writes. The skills are
// published into the agent's CLI skills folder at its next start (src/library/mount.ts).
//
// The words live in a module of their own, registered with the card (as effort-field-strings.js does), so a tab opened before an
// upgrade never shows a raw key. The Library is read once, from GET /ui/library/list (admin only, as the Settings page is), and the built-in
// skills the agent gets from GET /ui/library/overview.
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";
import { AddDialog, AssignedControls, AssignedHeader, BuiltinSection, EmptyList, ItemList, LibraryCardShell, ListRow, LoadedPreview, cardWords, keepSavedOrder } from "./library-card.js";
import { SkillPreviewPane } from "./library-skill.js";

register("libraryMount", {
  en: {
    card: "Skills",
    tip: "The skills this agent gets: the ones assigned to it from the Library, and the built-in ones its role gives it automatically. Library skills are written into the agent's CLI skills folder when the agent starts, so a change applies after a restart.",
    empty: "No Library skills assigned yet.",
    none: "The Library has no usable skills yet. Add one on the Library page.", allOn: "Every skill in the Library is already enabled.",
    loadFailed: "Could not read the Library.", loading: "Reading the Library…",
    gone: "Not in the Library any more", notReady: "Not given: it was changed outside the Library or breaks a rule — check it on the Library page",
    note: "A skill folder of the same name that you made yourself, or a built-in skill of the same name, always wins; the library skill is skipped.",
    noFolder: "This agent’s CLI ({0}) has no skills folder, so Library skills do not take effect on it.",
    pickerTitle: "Add a skill", filter: "Filter skills",
  },
  "zh-TW": {
    card: "Skills",
    tip: "這個 Agent 會拿到的 Skill：你從資源庫指派給它的，以及它的角色自動帶入的內建 Skill。資源庫的 Skill 會在 Agent 啟動時寫進它 CLI 的 skill 資料夾，所以變更要重啟後才生效。",
    empty: "還沒有指派資源庫的 Skill。",
    none: "資源庫裡還沒有可用的 Skill，請先到「資源庫」頁新增。", allOn: "資源庫的 Skill 都已經啟用了。",
    loadFailed: "無法讀取資源庫。", loading: "讀取資源庫中…",
    gone: "已不在資源庫", notReady: "不會交給 Agent：它在資源庫外被改過或不符規則，請到資源庫頁檢查",
    note: "若有同名的自建 skill 資料夾或內建 Skill，一律以它們為準，資源庫的 Skill 會被略過。",
    noFolder: "這個 Agent 的 CLI（{0}）沒有 skill 資料夾，資源庫的 Skill 在它身上不會生效。",
    pickerTitle: "新增 Skill", filter: "篩選 Skill",
  },
});
const lw = (key, ...values) => t(`libraryMount.${key}`, ...values);
export const libraryCardTitle = () => lw("card");
export const libraryCardTip = () => lw("tip");

/** The ids a skill list names that can be given (the library's own `ok` status: valid, and the file is the one that was saved). */
export function mountableSkills(items) {
  return (Array.isArray(items) ? items : []).filter((i) => i && i.kind === "skill" && typeof i.id === "string").map((i) => ({ id: i.id, description: i.description || "", status: i.status }));
}

/** The built-in entries (`{ name, description, agents }`) an agent gets: those that list it. Anything that is not that shape is left out. */
export function builtinFor(list, agent) {
  if (!agent || !Array.isArray(list)) return [];
  return list.filter((s) => s && typeof s.name === "string" && Array.isArray(s.agents) && s.agents.includes(agent)).map((s) => ({ name: s.name, description: typeof s.description === "string" ? s.description : "" }));
}

/** `m`: useAgentForm's result (its `f.library_skills`, `f.library_paused`, `setF`, `name`). `title`: the card's title node (settings-dialogs.js builds it with the usual tip and restart badge). */
export function LibrarySkillsCard({ m, title }) {
  const { f, setF } = m;
  const [state, setState] = useState({ loading: true });
  // The built-in skills this agent gets by its role, from the overview (the one place that says who gets what). Read apart: without it the card still lists the library's.
  const [builtin, setBuiltin] = useState([]);
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    let live = true;
    fetch("/ui/library/list", { credentials: "same-origin", cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data) => { if (live) setState({ skills: mountableSkills(data && data.items), folderBackends: Array.isArray(data && data.skillsFolderBackends) ? data.skillsFolderBackends : null }); }, () => { if (live) setState({ error: true }); });
    fetch("/ui/library/overview", { credentials: "same-origin", cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data) => { if (live) setBuiltin(builtinFor(data && data.builtinSkills, m.name)); }, () => {});
    return () => { live = false; };
  }, []);
  // AGEND-248: the Library's agent tags link here (`…?cat=work#library-skills`): bring the card into view once it is drawn.
  const box = useRef(null);
  useEffect(() => {
    if (typeof location === "undefined" || location.hash !== "#library-skills" || !box.current || typeof box.current.scrollIntoView !== "function") return undefined;
    // The cards above and below fill in as their lists arrive and move this one: look again once they have (and after the last of them).
    const again = setTimeout(() => { if (box.current) box.current.scrollIntoView({ block: "center" }); }, 400);
    box.current.scrollIntoView({ block: "center" });
    return () => clearTimeout(again);
  }, [state.loading, builtin.length]);
  const active = f.library_skills || [];
  const paused = (f.library_paused && f.library_paused.skills) || [];
  const listed = state.skills || [];
  // On = in `library.skills`; paused = in `library.paused.skills` (assigned, not given). One place changes both lists, from the form's latest state.
  const apply = (nextActive, nextPaused) => setF((x) => ({ ...x, library_skills: keepSavedOrder(m.inst && m.inst.library && m.inst.library.skills, nextActive), library_paused: { skills: [], mcp: [], ...(x.library_paused || {}), skills: nextPaused } }));
  const without = (list, id) => list.filter((x) => x !== id);
  const toggle = (id, on) => (on ? apply([...without(active, id), id], without(paused, id)) : apply(without(active, id), [...without(paused, id), id]));
  const remove = (id) => apply(without(active, id), without(paused, id));
  const enable = (id) => apply([...without(active, id), id], without(paused, id));
  // Everything assigned, in one stable order (a switch does not move a row). A skill the agent has but the Library does not list (deleted there) stays, so it can be removed.
  const assigned = [...new Set([...active, ...paused])].sort();
  const rows = assigned.map((id) => listed.find((s) => s.id === id) || { id, description: "", status: "missing" });
  // The server says which CLIs read a skills folder (no list is written here); until it has, nothing is claimed.
  const noFolder = !!state.folderBackends && !!f.backend && !state.folderBackends.includes(f.backend);
  const candidates = listed.filter((s) => !assigned.includes(s.id)).map((s) => ({ id: s.id, description: s.description, disabled: s.status !== "ok", note: lw("notReady") }));
  const emptyPicker = state.error ? lw("loadFailed") : listed.length ? lw("allOn") : lw("none");
  return html`<${LibraryCardShell} title=${title} innerRef=${box} attrs=${{ "data-library-skills": "" }}>
    <div class="lib-sec" data-library-assigned>
      <${AssignedHeader} onAdd=${() => setAdding(true)} />
      ${noFolder ? html`<p class="feedback warning" role="note" data-library-no-folder>${lw("noFolder", f.backend)}</p>` : null}
      ${state.loading ? html`<p class="note">${lw("loading")}</p>` : null}
      ${state.error && !rows.length ? html`<p class="note">${lw("loadFailed")}</p>` : null}
      ${!state.loading && !state.error && !rows.length ? html`<${EmptyList} text=${lw("empty")} />` : null}
      ${rows.length ? html`<${ItemList}>${rows.map((s) => {
        const on = active.includes(s.id);
        return html`<${ListRow} key=${s.id} icon="book" name=${s.id} description=${s.description} off=${!on} attr=${{ "data-library-skill": s.id, "data-library-on": on ? "1" : "0" }}
          status=${s.status === "missing" ? html`<span class="note">${lw("gone")}</span>` : s.status !== "ok" ? html`<span class="note">${lw("notReady")}</span>` : !on ? html`<span class="note">${cardWords.paused()}</span>` : null}
          controls=${html`<${AssignedControls} id=${s.id} on=${on} onToggle=${(v) => toggle(s.id, v)} onRemove=${() => remove(s.id)} />`} />`;
      })}</${ItemList}>` : null}
      ${rows.length ? html`<p class="note">${lw("note")}</p>` : null}
    </div>
    <${BuiltinSection} items=${builtin} attr="data-library-builtin-skill" icon="book" />
    ${adding ? html`<${AddDialog} title=${lw("pickerTitle")} items=${candidates} filterLabel=${lw("filter")} emptyText=${emptyPicker} onClose=${() => setAdding(false)}
      onEnable=${async (item) => { enable(item.id); return { ok: true }; }}
      renderPreview=${(item) => html`<${LoadedPreview} deps=${[item.id]}
        load=${() => fetch(`/ui/library/item?kind=skill&id=${encodeURIComponent(item.id)}`, { credentials: "same-origin", cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((d) => (d && d.detail ? d.detail : null))}
        render=${(detail) => html`<${SkillPreviewPane} d=${detail} />`} />`} />` : null}
  </${LibraryCardShell}>`;
}
