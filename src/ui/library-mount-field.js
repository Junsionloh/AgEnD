// AGEND-244 / AGEND-261: the "Skills" card of an agent's settings (Settings → agent → Workspace): the built-in skills it gets by its role (grey, listed first) and which of the library skills
// (src/library, the Library page) this agent is given. An administrator ticks them; the agent gets them in its CLI's skills folder
// at its next start (src/library/mount.ts). The built-in skills are not listed: AgEnD gives those by the agent's role.
//
// The words live in a module of their own, registered with the field (as effort-field-strings.js does), so a tab opened before an
// upgrade never shows a raw key. The list is read once, from GET /ui/library/list (admin only, as the Settings page is); nothing
// here writes — the ticked ids become the `library` value of the agent's patch (settings-model.js).
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";

register("libraryMount", {
  en: {
    card: "Skills", label: "Skills", tip: "The skills this agent gets: the built-in ones, given automatically by its role (grey, they cannot be turned off), and the ones from the Library that you tick. Library skills are written into the agent's CLI skills folder when the agent starts, so a change applies after a restart.",
    builtinTag: "Built in · automatic", libraryTag: "Library", builtinTip: "Given automatically by this agent’s role; it cannot be turned off here.",
    none: "The Library has no usable skills yet. Add one on the Library page.", loadFailed: "Could not read the Library.", loading: "Reading the Library…",
    gone: "Not in the Library any more", notReady: "Not given: it was changed outside the Library or breaks a rule — check it on the Library page",
    note: "A skill folder of the same name that you made yourself, or a built-in skill of the same name, always wins; the library skill is skipped.",
    noFolder: "This agent’s CLI ({0}) has no skills folder, so Library skills do not take effect on it.",
  },
  "zh-TW": {
    card: "Skills", label: "Skills", tip: "這個 Agent 會拿到的 Skill：內建的依 Agent 的角色自動帶入（灰色，不能取消），以及你從資源庫勾選的。資源庫的 Skill 會在 Agent 啟動時寫進它 CLI 的 skill 資料夾，所以變更要重啟後才生效。",
    builtinTag: "內建・自動", libraryTag: "資源庫", builtinTip: "依這個 Agent 的角色自動帶入，無法在這裡取消。",
    none: "資源庫裡還沒有可用的 Skill，請先到「資源庫」頁新增。", loadFailed: "無法讀取資源庫。", loading: "讀取資源庫中…",
    gone: "已不在資源庫", notReady: "不會交給 Agent：它在資源庫外被改過或不符規則，請到資源庫頁檢查",
    note: "若有同名的自建 skill 資料夾或內建 Skill，一律以它們為準，資源庫的 Skill 會被略過。",
    noFolder: "這個 Agent 的 CLI（{0}）沒有 skill 資料夾，資源庫的 Skill 在它身上不會生效。",
  },
});
const lw = (key, ...values) => t(`libraryMount.${key}`, ...values);
export const libraryCardTitle = () => lw("card");

/** The ids a skill list names that can be given (the library's own `ok` status: valid, and the file is the one that was saved). */
export function mountableSkills(items) {
  return (Array.isArray(items) ? items : []).filter((i) => i && i.kind === "skill" && typeof i.id === "string").map((i) => ({ id: i.id, description: i.description || "", status: i.status }));
}

/** The built-in entries (`{ name, description, agents }`) an agent gets: those that list it. Anything that is not that shape is left out. */
export function builtinFor(list, agent) {
  if (!agent || !Array.isArray(list)) return [];
  return list.filter((s) => s && typeof s.name === "string" && Array.isArray(s.agents) && s.agents.includes(agent)).map((s) => ({ name: s.name, description: typeof s.description === "string" ? s.description : "" }));
}

/** One grey, ticked, disabled row: what the agent gets by itself. */
export const BuiltinRow = ({ name, description, attr, tag, tip }) => html`<div class="check lib-builtin" ...${{ [attr]: name }} title=${tip}>
  <input type="checkbox" checked disabled aria-label=${`${name} — ${tag}`} />
  <span class="lib-builtin-text"><span class="strong">${name}</span> <span class="pill lib-kind">${tag}</span><span class="note lib-builtin-desc" title=${description || undefined}>${description || ""}</span></span></div>`;

/** `m`: useAgentForm's result (its `f.library_skills` and `set`). `L`: the label maker of the fields around it (AgentFields'). */
export function LibrarySkillsField({ m, L }) {
  const { f, set } = m;
  const [state, setState] = useState({ loading: true });
  // The built-in skills this agent gets by its role, from the overview (the one place that says who gets what). Read apart: without it the card still lists the library's.
  const [builtin, setBuiltin] = useState([]);
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
  // AGEND-248: the Library's agent tags link here (`…?cat=work#library-skills`): bring the field into view once it is drawn.
  const box = useRef(null);
  useEffect(() => {
    if (typeof location === "undefined" || location.hash !== "#library-skills" || !box.current || typeof box.current.scrollIntoView !== "function") return;
    // The cards above and below fill in as their lists arrive and move this one: look again once they have (and after the last of them).
    const again = setTimeout(() => { if (box.current) box.current.scrollIntoView({ block: "center" }); }, 400);
    box.current.scrollIntoView({ block: "center" });
    return () => clearTimeout(again);
  }, [state.loading, builtin.length]);
  const chosen = f.library_skills || [];
  const toggle = (id, on) => set("library_skills")(on ? [...chosen.filter((x) => x !== id), id] : chosen.filter((x) => x !== id));
  const listed = state.skills || [];
  // A skill the agent has but the Library does not list (deleted there) stays visible, so it can be unticked.
  const rows = [...listed, ...chosen.filter((id) => !listed.some((s) => s.id === id)).map((id) => ({ id, description: "", status: "missing" }))];
  // The server says which CLIs read a skills folder (no list is written here); until it has, nothing is claimed.
  const noFolder = !!state.folderBackends && !!f.backend && !state.folderBackends.includes(f.backend);
  const pickable = (s) => s.status === "ok" || chosen.includes(s.id);
  return html`<div class="field" data-library-skills ref=${box}>${L(lw("label"), "instance.library", undefined, lw("tip"))}
    ${builtin.map((b) => html`<${BuiltinRow} key=${b.name} name=${b.name} description=${b.description} attr="data-library-builtin-skill" tag=${lw("builtinTag")} tip=${lw("builtinTip")} />`)}
    ${noFolder ? html`<p class="feedback warning" role="note" data-library-no-folder>${lw("noFolder", f.backend)}</p>` : null}
    ${state.loading ? html`<p class="note">${lw("loading")}</p>` : null}
    ${state.error && !rows.length ? html`<p class="note">${lw("loadFailed")}</p>` : null}
    ${!state.loading && !state.error && !rows.length ? html`<p class="note">${lw("none")}</p>` : null}
    ${rows.map((s) => html`<label key=${s.id} class="check" data-library-skill=${s.id}>
      <input type="checkbox" disabled=${!pickable(s)} checked=${chosen.includes(s.id)} onChange=${(e) => toggle(s.id, e.target.checked)} />
      <span><span class="strong">${s.id}</span>${s.description ? html` — ${s.description}` : null} <span class="pill lib-kind">${lw("libraryTag")}</span>${s.status === "missing" ? html` <span class="note">(${lw("gone")})</span>` : s.status !== "ok" ? html` <span class="note">(${lw("notReady")})</span>` : null}</span></label>`)}
    ${rows.length ? html`<p class="note">${lw("note")}</p>` : null}</div>`;
}
