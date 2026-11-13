// AGEND-244: the "Library skills" field of an agent's settings (Settings → agent → Workspace): which of the team's library skills
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
    card: "Team skills (from the Library)", label: "Team skills", tip: "Team skills from the Library that this agent is given, beside the built-in ones. They are written into the agent's CLI skills folder when the agent starts, so a change applies after a restart. The built-in skills are given by the agent's role and are not listed here.",
    none: "The Library has no usable skills yet. Add one on the Library page.", loadFailed: "Could not read the Library.", loading: "Reading the Library…",
    gone: "Not in the Library any more", notReady: "Not given: it was changed outside the Library or breaks a rule — check it on the Library page",
    note: "A skill folder of the same name that you made yourself, or a built-in skill of the same name, always wins; the library skill is skipped.",
    noFolder: "This agent’s CLI ({0}) has no skills folder, so team skills do not take effect on it.",
    // AGEND-260: team MCP servers
    mcpCard: "Team MCP servers (from the Library)", mcpLabel: "Team MCP servers",
    mcpTip: "MCP servers from the Library that this agent is given. They run commands (or call a web address) for the agent, so only an administrator sets this. They are added to the agent's Claude Code MCP config when it starts, so a change applies after a restart. A secret is never stored in the Library: the server names the variables it reads, and their values come from the environment AgEnD runs in.",
    mcpNone: "The Library has no MCP servers yet. Add one on the Library page.",
    mcpUnsupported: "Not supported yet: this agent’s CLI ({0}) cannot take a mounted MCP server. Only Claude Code can for now.",
    mcpMissing: "Missing {0} — not set in the environment AgEnD runs in, so this server is not enabled",
    mcpNote: "The server is started by Claude Code with only the variables it names. A server that is not enabled is left out; the agent still starts.",
    mcpUses: "Reads: {0}", mcpNoVars: "Needs no secret",
    mcpStdio: "Runs a local command", mcpHttp: "Calls a web address",
  },
  "zh-TW": {
    card: "團隊 Skill（來自資源庫）", label: "團隊 Skill", tip: "從資源庫選給這個 Agent 的團隊 Skill，和內建 Skill 並用。Agent 啟動時會寫進它 CLI 的 skill 資料夾，所以變更要重啟後才生效。內建 Skill 依 Agent 的角色自動帶入，不在這裡列出。",
    none: "資源庫裡還沒有可用的 Skill，請先到「資源庫」頁新增。", loadFailed: "無法讀取資源庫。", loading: "讀取資源庫中…",
    gone: "已不在資源庫", notReady: "不會交給 Agent：它在資源庫外被改過或不符規則，請到資源庫頁檢查",
    note: "若有同名的自建 skill 資料夾或內建 Skill，一律以它們為準，資源庫的 Skill 會被略過。",
    noFolder: "這個 Agent 的 CLI（{0}）沒有 skill 資料夾，團隊 Skill 在它身上不會生效。",
    // AGEND-260: 團隊 MCP
    mcpCard: "團隊 MCP（來自資源庫）", mcpLabel: "團隊 MCP",
    mcpTip: "從資源庫選給這個 Agent 的 MCP。MCP 會替 Agent 執行指令（或連到網址），所以只有管理者能設定。Agent 啟動時會加進它的 Claude Code MCP 設定，變更要重啟後才生效。密鑰不會存在資源庫：MCP 只寫它要讀的變數名稱，值取自 AgEnD 執行環境。",
    mcpNone: "資源庫裡還沒有 MCP，請先到「資源庫」頁新增。",
    mcpUnsupported: "尚未支援：這個 Agent 的 CLI（{0}）還不能掛載 MCP。目前只有 Claude Code 可以。",
    mcpMissing: "缺少 {0}：AgEnD 執行環境沒有設定這個變數，所以這一項不會啟用",
    mcpNote: "MCP 由 Claude Code 啟動，只會拿到它自己寫的變數。沒有啟用的項目會被略過，Agent 仍會正常啟動。",
    mcpUses: "讀取：{0}", mcpNoVars: "不需要密鑰",
    mcpStdio: "執行本機指令", mcpHttp: "連到網址",
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
  // AGEND-248: the Library's agent tags link here (`…?cat=work#library-skills`): bring the field into view once it is drawn.
  const box = useRef(null);
  useEffect(() => {
    if (typeof location === "undefined" || location.hash !== "#library-skills" || !box.current || typeof box.current.scrollIntoView !== "function") return;
    box.current.scrollIntoView({ block: "center" });
  }, []);
  const chosen = f.library_skills || [];
  const toggle = (id, on) => set("library_skills")(on ? [...chosen.filter((x) => x !== id), id] : chosen.filter((x) => x !== id));
  const listed = state.skills || [];
  // A skill the agent has but the Library does not list (deleted there) stays visible, so it can be unticked.
  const rows = [...listed, ...chosen.filter((id) => !listed.some((s) => s.id === id)).map((id) => ({ id, description: "", status: "missing" }))];
  // The server says which CLIs read a skills folder (no list is written here); until it has, nothing is claimed.
  const noFolder = !!state.folderBackends && !!f.backend && !state.folderBackends.includes(f.backend);
  const pickable = (s) => s.status === "ok" || chosen.includes(s.id);
  return html`<div class="field" data-library-skills ref=${box}>${L(lw("label"), "instance.library", undefined, lw("tip"))}
    ${noFolder ? html`<p class="feedback warning" role="note" data-library-no-folder>${lw("noFolder", f.backend)}</p>` : null}
    ${state.loading ? html`<p class="note">${lw("loading")}</p>` : null}
    ${state.error && !rows.length ? html`<p class="note">${lw("loadFailed")}</p>` : null}
    ${!state.loading && !state.error && !rows.length ? html`<p class="note">${lw("none")}</p>` : null}
    ${rows.map((s) => html`<label key=${s.id} class="check" data-library-skill=${s.id}>
      <input type="checkbox" disabled=${!pickable(s)} checked=${chosen.includes(s.id)} onChange=${(e) => toggle(s.id, e.target.checked)} />
      <span><span class="strong">${s.id}</span>${s.description ? html` — ${s.description}` : null}${s.status === "missing" ? html` <span class="note">(${lw("gone")})</span>` : s.status !== "ok" ? html` <span class="note">(${lw("notReady")})</span>` : null}</span></label>`)}
    ${rows.length ? html`<p class="note">${lw("note")}</p>` : null}</div>`;
}

// AGEND-260: the "Team MCP servers" field — the same shape as the skills field above. Ticking writes `library.mcp` (a list of ids); the
// Library keeps the item, the daemon's environment keeps the secret values. Only Claude Code takes a mounted server for now: for any
// other backend the field says "not supported yet" and cannot add one (an id that is already there can still be unticked).
export const libraryMcpCardTitle = () => lw("mcpCard");

/** The MCP items of a list answer, as the field shows them. */
export function mountableMcp(items) {
  return (Array.isArray(items) ? items : []).filter((i) => i && i.kind === "mcp" && typeof i.id === "string").map((i) => ({
    id: i.id, description: i.description || "", status: i.status,
    transport: i.mcp && i.mcp.transport, vars: (i.mcp && i.mcp.vars) || [], missing: (i.mcp && i.mcp.missing) || [],
  }));
}

export function LibraryMcpField({ m, L }) {
  const { f, set } = m;
  const [state, setState] = useState({ loading: true });
  useEffect(() => {
    let live = true;
    fetch("/ui/library/list", { credentials: "same-origin", cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data) => { if (live) setState({ servers: mountableMcp(data && data.items), backends: Array.isArray(data && data.mcpBackends) ? data.mcpBackends : null }); }, () => { if (live) setState({ error: true }); });
    return () => { live = false; };
  }, []);
  // The Library's agent tags link here (`…?cat=work#library-mcp`): bring the field into view once it is drawn.
  const box = useRef(null);
  useEffect(() => {
    if (typeof location === "undefined" || location.hash !== "#library-mcp" || !box.current || typeof box.current.scrollIntoView !== "function") return;
    box.current.scrollIntoView({ block: "center" });
  }, []);
  const chosen = f.library_mcp || [];
  const toggle = (id, on) => set("library_mcp")(on ? [...chosen.filter((x) => x !== id), id] : chosen.filter((x) => x !== id));
  const listed = state.servers || [];
  const rows = [...listed, ...chosen.filter((id) => !listed.some((s) => s.id === id)).map((id) => ({ id, description: "", status: "missing", vars: [], missing: [] }))];
  const unsupported = !!state.backends && !!f.backend && !state.backends.includes(f.backend);
  const pickable = (s) => (s.status === "ok" && !unsupported) || chosen.includes(s.id);
  return html`<div class="field" data-library-mcp ref=${box}>${L(lw("mcpLabel"), "instance.library", undefined, lw("mcpTip"))}
    ${unsupported ? html`<p class="feedback warning" role="note" data-library-mcp-unsupported>${lw("mcpUnsupported", f.backend)}</p>` : null}
    ${state.loading ? html`<p class="note">${lw("loading")}</p>` : null}
    ${state.error && !rows.length ? html`<p class="note">${lw("loadFailed")}</p>` : null}
    ${!state.loading && !state.error && !rows.length ? html`<p class="note">${lw("mcpNone")}</p>` : null}
    ${rows.map((s) => html`<div key=${s.id} class="lib-mcp-item" data-library-mcp-item=${s.id}>
      <label class="check">
        <input type="checkbox" disabled=${!pickable(s)} checked=${chosen.includes(s.id)} onChange=${(e) => toggle(s.id, e.target.checked)} />
        <span><span class="strong">${s.id}</span>${s.description ? html` — ${s.description}` : null}
          ${s.status === "missing" ? html` <span class="note">(${lw("gone")})</span>` : s.status !== "ok" ? html` <span class="note">(${lw("notReady")})</span>` : null}
          ${s.status === "ok" ? html`<span class="note lib-sub">${s.transport === "http" ? lw("mcpHttp") : lw("mcpStdio")} · ${s.vars.length ? lw("mcpUses", s.vars.join(", ")) : lw("mcpNoVars")}</span>` : null}</span></label>
      ${s.missing.length ? html`<p class="feedback warning" role="note" data-library-mcp-missing=${s.missing.join(",")}>${lw("mcpMissing", s.missing.join(", "))}</p>` : null}</div>`)}
    ${rows.length ? html`<p class="note">${lw("mcpNote")}</p>` : null}</div>`;
}
