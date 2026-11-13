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
import { AddDialog, BuiltinSummary, EnabledRow, LibraryCardShell, LoadedPreview } from "./library-card.js";
import { SkillPreviewPane } from "./library-skill.js";

register("libraryMount", {
  en: {
    card: "Skills",
    tip: "The skills this agent gets: the built-in ones, given automatically by its role, and the ones you enable from the Library. Library skills are written into the agent's CLI skills folder when the agent starts, so a change applies after a restart.",
    empty: "No Library skills enabled yet.",
    none: "The Library has no usable skills yet. Add one on the Library page.", allOn: "Every skill in the Library is already enabled.",
    loadFailed: "Could not read the Library.", loading: "Reading the Library…",
    gone: "Not in the Library any more", notReady: "Not given: it was changed outside the Library or breaks a rule — check it on the Library page",
    note: "A skill folder of the same name that you made yourself, or a built-in skill of the same name, always wins; the library skill is skipped.",
    noFolder: "This agent’s CLI ({0}) has no skills folder, so Library skills do not take effect on it.",
    pickerTitle: "Add a skill", filter: "Filter skills",
  },
  "zh-TW": {
    card: "Skills",
    tip: "這個 Agent 會拿到的 Skill：內建的依 Agent 的角色自動帶入，以及你從資源庫啟用的。資源庫的 Skill 會在 Agent 啟動時寫進它 CLI 的 skill 資料夾，所以變更要重啟後才生效。",
    empty: "還沒有啟用資源庫的 Skill。",
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

/** `m`: useAgentForm's result (its `f.library_skills`, `set`, `name`). `title`: the card's title node (settings-dialogs.js builds it with the usual tip and restart badge). */
export function LibrarySkillsCard({ m, title }) {
  const { f, set } = m;
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
  const chosen = f.library_skills || [];
  const listed = state.skills || [];
  const enable = (id) => set("library_skills")([...chosen.filter((x) => x !== id), id]);
  const remove = (id) => set("library_skills")(chosen.filter((x) => x !== id));
  // A skill the agent has but the Library does not list (deleted there) stays visible, so it can be removed.
  const rows = chosen.map((id) => listed.find((s) => s.id === id) || { id, description: "", status: "missing" });
  // The server says which CLIs read a skills folder (no list is written here); until it has, nothing is claimed.
  const noFolder = !!state.folderBackends && !!f.backend && !state.folderBackends.includes(f.backend);
  const candidates = listed.filter((s) => !chosen.includes(s.id)).map((s) => ({ id: s.id, description: s.description, disabled: s.status !== "ok", note: lw("notReady") }));
  const emptyPicker = state.error ? lw("loadFailed") : listed.length ? lw("allOn") : lw("none");
  return html`<${LibraryCardShell} title=${title} innerRef=${box} attrs=${{ "data-library-skills": "" }} onAdd=${() => setAdding(true)}>
    ${noFolder ? html`<p class="feedback warning" role="note" data-library-no-folder>${lw("noFolder", f.backend)}</p>` : null}
    <${BuiltinSummary} items=${builtin} attr="data-library-builtin-skill" />
    ${state.loading ? html`<p class="note">${lw("loading")}</p>` : null}
    ${state.error && !rows.length ? html`<p class="note">${lw("loadFailed")}</p>` : null}
    ${!state.loading && !state.error && !rows.length ? html`<p class="note" data-library-empty>${lw("empty")}</p>` : null}
    ${rows.map((s) => html`<${EnabledRow} key=${s.id} id=${s.id} description=${s.description} attr="data-library-skill" onRemove=${() => remove(s.id)}>
      ${s.status === "missing" ? html`<span class="note">${lw("gone")}</span>` : s.status !== "ok" ? html`<span class="note">${lw("notReady")}</span>` : null}</${EnabledRow}>`)}
    ${rows.length ? html`<p class="note">${lw("note")}</p>` : null}
    ${adding ? html`<${AddDialog} title=${lw("pickerTitle")} items=${candidates} filterLabel=${lw("filter")} emptyText=${emptyPicker} onClose=${() => setAdding(false)}
      onEnable=${async (item) => { enable(item.id); return { ok: true }; }}
      renderPreview=${(item) => html`<${LoadedPreview} deps=${[item.id]}
        load=${() => fetch(`/ui/library/item?kind=skill&id=${encodeURIComponent(item.id)}`, { credentials: "same-origin", cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((d) => (d && d.detail ? d.detail : null))}
        render=${(detail) => html`<${SkillPreviewPane} d=${detail} />`} />`} />` : null}
  </${LibraryCardShell}>`;
}
