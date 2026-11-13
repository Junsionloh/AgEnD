// AGEND-244: the "Library skills" field of an agent's settings (Settings → agent → Workspace): which of the team's library skills
// (src/library, the Library page) this agent is given. An administrator ticks them; the agent gets them in its CLI's skills folder
// at its next start (src/library/mount.ts). The built-in skills are not listed: AgEnD gives those by the agent's role.
//
// The words live in a module of their own, registered with the field (as effort-field-strings.js does), so a tab opened before an
// upgrade never shows a raw key. The list is read once, from GET /ui/library/list (admin only, as the Settings page is); nothing
// here writes — the ticked ids become the `library` value of the agent's patch (settings-model.js).
import { html, useEffect, useState } from "/assets/app-html.js";
import { register, t } from "/assets/app-i18n.js";

register("libraryMount", {
  en: {
    card: "Library", label: "Team skills", tip: "Team skills from the Library that this agent is given, beside the built-in ones. They are written into the agent's CLI skills folder when the agent starts, so a change applies after a restart. The built-in skills are given by the agent's role and are not listed here.",
    none: "The Library has no usable skills yet. Add one on the Library page.", loadFailed: "Could not read the Library.", loading: "Reading the Library…",
    gone: "Not in the Library any more", notReady: "Not given: it was changed outside the Library or breaks a rule — check it on the Library page",
    note: "A skill folder of the same name that you made yourself, or a built-in skill of the same name, always wins; the library skill is skipped.",
    noFolder: "This agent’s CLI ({0}) has no skills folder, so team skills do not take effect on it.",
  },
  "zh-TW": {
    card: "資源庫", label: "團隊 Skill", tip: "從資源庫選給這個 Agent 的團隊 Skill，和內建 Skill 並用。Agent 啟動時會寫進它 CLI 的 skill 資料夾，所以變更要重啟後才生效。內建 Skill 依 Agent 的角色自動帶入，不在這裡列出。",
    none: "資源庫裡還沒有可用的 Skill，請先到「資源庫」頁新增。", loadFailed: "無法讀取資源庫。", loading: "讀取資源庫中…",
    gone: "已不在資源庫", notReady: "不會交給 Agent：它在資源庫外被改過或不符規則，請到資源庫頁檢查",
    note: "若有同名的自建 skill 資料夾或內建 Skill，一律以它們為準，資源庫的 Skill 會被略過。",
    noFolder: "這個 Agent 的 CLI（{0}）沒有 skill 資料夾，團隊 Skill 在它身上不會生效。",
  },
});
const lw = (key, ...values) => t(`libraryMount.${key}`, ...values);
export const libraryCardTitle = () => lw("card");

/** The ids a skill list names that can be given (the library's own `ok` status: valid, and the file is the one that was saved). */
export function mountableSkills(items) {
  return (Array.isArray(items) ? items : []).filter((i) => i && i.kind === "skill" && typeof i.id === "string").map((i) => ({ id: i.id, description: i.description || "", status: i.status }));
}

/** `m`: useAgentForm's result (its `f.library_skills` and `set`). `L`: the label maker of the fields around it (AgentFields'). */
export function LibrarySkillsField({ m, L }) {
  const { f, set } = m;
  const [state, setState] = useState({ loading: true });
  useEffect(() => {
    let live = true;
    fetch("/ui/library/list", { credentials: "same-origin", cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data) => { if (live) setState({ skills: mountableSkills(data && data.items), folderBackends: Array.isArray(data && data.skillsFolderBackends) ? data.skillsFolderBackends : null }); }, () => { if (live) setState({ error: true }); });
    return () => { live = false; };
  }, []);
  const chosen = f.library_skills || [];
  const toggle = (id, on) => set("library_skills")(on ? [...chosen.filter((x) => x !== id), id] : chosen.filter((x) => x !== id));
  const listed = state.skills || [];
  // A skill the agent has but the Library does not list (deleted there) stays visible, so it can be unticked.
  const rows = [...listed, ...chosen.filter((id) => !listed.some((s) => s.id === id)).map((id) => ({ id, description: "", status: "missing" }))];
  // The server says which CLIs read a skills folder (no list is written here); until it has, nothing is claimed.
  const noFolder = !!state.folderBackends && !!f.backend && !state.folderBackends.includes(f.backend);
  const pickable = (s) => s.status === "ok" || chosen.includes(s.id);
  return html`<div class="field" data-library-skills>${L(lw("label"), "instance.library", undefined, lw("tip"))}
    ${noFolder ? html`<p class="feedback warning" role="note" data-library-no-folder>${lw("noFolder", f.backend)}</p>` : null}
    ${state.loading ? html`<p class="note">${lw("loading")}</p>` : null}
    ${state.error && !rows.length ? html`<p class="note">${lw("loadFailed")}</p>` : null}
    ${!state.loading && !state.error && !rows.length ? html`<p class="note">${lw("none")}</p>` : null}
    ${rows.map((s) => html`<label key=${s.id} class="check" data-library-skill=${s.id}>
      <input type="checkbox" disabled=${!pickable(s)} checked=${chosen.includes(s.id)} onChange=${(e) => toggle(s.id, e.target.checked)} />
      <span><span class="strong">${s.id}</span>${s.description ? html` — ${s.description}` : null}${s.status === "missing" ? html` <span class="note">(${lw("gone")})</span>` : s.status !== "ok" ? html` <span class="note">(${lw("notReady")})</span>` : null}</span></label>`)}
    ${rows.length ? html`<p class="note">${lw("note")}</p>` : null}</div>`;
}
