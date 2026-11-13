/**
 * AGEND-243: the library's web routes, admin only (as Settings is). web-api.ts hands over the few helpers it owns, so this file
 * stays outside the big router:
 *
 *   GET  /ui/library/list                          every item and its status (see LibraryStatus)
 *   GET  /ui/library/item?kind=skill|mcp&id=<id>   one item, whole
 *   GET  /ui/library/overview                      AGEND-248: bundled skills, tool profiles, the agend MCP server and which agents use what (read only)
 *   POST /ui/library/save   {kind, id, files | text, overwrite?, expect?}   a skill's files, or an MCP file's YAML text (`expect`: the hash the editor read — 409 `changed` if the item is not that any more; `overwrite: true` without it is 400 `expect_required`; a skill named like a built-in one is 409 `exists`)
 *   POST /ui/library/delete {kind, id}
 *
 * AGEND-257 (Skills only; MCP items are not moved):
 *   GET  /ui/library/export?id=<id>[&builtin=1]    one skill as <id>.zip (`<id>/SKILL.md` + files); a built-in one is a copy
 *   GET  /ui/library/export-all                    every team skill in one zip
 *   GET  /ui/library/builtin?name=<name>           a built-in skill for display (its SKILL.md, split into fields and Markdown)
 *   POST /ui/library/import/preview?filename=      the body is the upload (.zip, .skill or SKILL.md): what is in it, checked, nothing stored
 *   POST /ui/library/import?sha256=&decisions=     the same bytes again, with the preview's hash and the admin's per-skill choices (URL-encoded JSON): stores
 *   Importing only puts a skill in the library; no agent is given it.
 *
 * AGEND-261 (library MCP servers mounted on an agent, Claude Code and Codex; src/library/mcp-mount.ts):
 *   GET  /ui/library/mcp-status?agent=<name>           every MCP item as the agent's settings page needs it: what it would run, the variables it names
 *                                                  (set / missing — names only, never a value), and whether it was confirmed for this agent at its current version
 *   POST /ui/library/mcp-confirm {agent, id, sha256}   the administrator saw that exact version and confirms it for that agent (409 `changed` if the item is another now)
 *   Mounting itself is `library.mcp` in the agent's settings; the confirmation is the second key: an item that was edited after it is not written until confirmed again.
 *
 * Nothing here hands an agent anything: the library is a place to keep and look at items, the overview only reads settings, and what an agent is given is decided at its launch.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { LibraryStore } from "./store.js";
import { readBoundedWebBody } from "../web-body.js";
import { allTeamSkillsArchive, applyImport, builtinSkillFiles, builtinSkillNames, describeSkillText, parseUpload, previewUpload, skillArchive, takenNames, teamSkillFiles, type ImportDecision } from "./transfer.js";
import { ZIP_LIMITS } from "./zip.js";
import { NATIVE_SKILLS_DIR_SEGMENTS } from "../native-skills-dir.js";
import { buildOverview, type OverviewInstances } from "./overview.js";
import { LIBRARY_LIMITS, isLibraryId, type LibraryError, type LibraryKind } from "./schema.js";
import { McpConfirmations, envNamesSet, mcpSummary, mcpVariables, type McpSummary } from "./mcp-mount.js";
import { LIBRARY_MCP_BACKENDS, supportsLibraryMcp } from "./mcp-support.js";
import { join } from "node:path";

export interface LibraryWebHost {
  method: string;
  path: string;
  url: URL;
  req: IncomingMessage;
  res: ServerResponse;
  /** The fleet's data folder (`AGEND_HOME`); the library is its `library/` folder. */
  home: string;
  json(res: ServerResponse, status: number, data: unknown): void;
  readJson(req: IncomingMessage): Promise<Record<string, unknown>>;
  /** The admin's admission, or null when the request is not an administrator's. */
  admission(): string | null;
  /** AGEND-248: the fleet's `instances` and default backend, for the overview (read only). */
  fleet?(): { instances?: OverviewInstances | null; defaultBackend?: string } | null | undefined;
  /** False (and the answer already sent) when the connection was closed or the session changed while the body was read. */
  stillOpen(): boolean;
}

const STATUS: Record<LibraryError["error"], number> = {
  invalid_request: 400, invalid_id: 400, invalid_path: 400, duplicate_path: 400, missing_skill_md: 400, bad_frontmatter: 400, name_mismatch: 400,
  missing_description: 400, too_large: 413, too_many_files: 413, not_text: 400, secret_found: 400, exists: 409, not_found: 404, too_many_items: 409,
  invalid_yaml: 400, bad_mcp: 400, unsafe_item: 422, bad_archive: 400, no_skill: 400, changed: 409, expect_required: 400,
};
/** The `decisions` parameter: `{ "<name in the upload>": { action, as? } }`, kept as a Map so a name like `constructor` is just a name. Null when it is not that shape. */
function readDecisions(raw: string | null): Map<string, ImportDecision> | null {
  const out = new Map<string, ImportDecision>();
  if (!raw) return out;
  if (raw.length > 32 * 1024) return null;
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  for (const [id, d] of Object.entries(v as Record<string, unknown>)) {
    if (!d || typeof d !== "object") return null;
    const { action, as } = d as { action?: unknown; as?: unknown };
    if (action !== "add" && action !== "overwrite" && action !== "rename" && action !== "skip") return null;
    if (as !== undefined && typeof as !== "string") return null;
    out.set(id, { action, ...(typeof as === "string" ? { as } : {}) });
  }
  return out;
}
/** The agent's definition as the page needs it: its backend (the fleet's default when it names none) and runtime. Null: no such agent. */
function agentOf(h: LibraryWebHost, name: string): { backend: string; runtime?: string; library?: { mcp?: unknown } } | null {
  const fleet = h.fleet?.();
  const instances = fleet?.instances;
  if (!name || !instances || !Object.hasOwn(instances, name) || !instances[name]) return null;
  const def = instances[name]!;
  return { backend: def.backend ?? fleet?.defaultBackend ?? "claude-code", ...(def.runtime ? { runtime: def.runtime } : {}), ...(def.library ? { library: def.library } : {}) };
}
const mcpMountedOn = (def: { library?: { mcp?: unknown } }, id: string): boolean => Array.isArray(def.library?.mcp) && (def.library!.mcp as unknown[]).includes(id);
interface McpMountItem {
  id: string; description: string; status: string; sha256?: string; confirmed: boolean; mounted: boolean;
  summary?: McpSummary; variables?: Array<{ name: string; set: boolean }>;
}
const kindOf = (v: unknown): LibraryKind | null => (v === "skill" || v === "mcp" ? v : null);

/** True when the request was a library route (answered here, whatever the outcome). */
export function handleLibraryRequest(h: LibraryWebHost): boolean {
  const { method, path, res } = h;
  const route = method === "GET"
    ? (path === "/ui/library/list" || path === "/ui/library/item" || path === "/ui/library/overview" || path === "/ui/library/export" || path === "/ui/library/export-all" || path === "/ui/library/builtin" || path === "/ui/library/mcp-status")
    : method === "POST" && (path === "/ui/library/save" || path === "/ui/library/mcp-confirm" || path === "/ui/library/delete" || path === "/ui/library/import/preview" || path === "/ui/library/import");
  if (!route) return false;
  const admission = h.admission();
  if (!admission) { h.json(res, 403, { error: "admin_required" }); return true; }
  const store = new LibraryStore(h.home);
  const send = (r: { ok: boolean }): void => {
    if (r.ok) { h.json(res, 200, r); return; }
    const e = r as LibraryError;
    h.json(res, STATUS[e.error] ?? 400, { error: e.error, ...(e.path ? { path: e.path } : {}), ...(e.detail ? { detail: e.detail } : {}), ...(e.findings ? { findings: e.findings } : {}) });
  };
  try {
    if (method === "GET") {
      if (path === "/ui/library/list") { h.json(res, 200, { items: store.list(), limits: LIBRARY_LIMITS, skillsFolderBackends: Object.keys(NATIVE_SKILLS_DIR_SEGMENTS), mcpBackends: Object.keys(LIBRARY_MCP_BACKENDS) }); return true; }
      if (path === "/ui/library/mcp-status") {
        const agent = h.url.searchParams.get("agent") ?? "";
        const def = agentOf(h, agent);
        if (!def) { h.json(res, 404, { error: "not_found" }); return true; }
        const confirmed = new McpConfirmations(store).forAgent(agent);
        const envPath = join(h.home, ".env");
        const items: McpMountItem[] = [];
        for (const it of store.list()) {
          if (it.kind !== "mcp") continue;
          const got = store.mcpForMount(it.id);
          const row: McpMountItem = { id: it.id, description: it.description, status: it.status, ...(it.sha256 ? { sha256: it.sha256 } : {}), confirmed: false, mounted: mcpMountedOn(def, it.id) };
          if (got.ok) {
            const summary = mcpSummary(got.item);
            const set = envNamesSet(envPath, summary.variables);
            row.summary = summary;
            row.variables = summary.variables.map((name) => ({ name, set: set.has(name) }));
            row.confirmed = Object.hasOwn(confirmed, it.id) && confirmed[it.id] === got.sha256;
          }
          items.push(row);
        }
        h.json(res, 200, { agent, backend: def.backend, supported: supportsLibraryMcp(def.backend), windows: def.runtime === "windows", items });
        return true;
      }
      if (path === "/ui/library/overview") {
        const fleet = h.fleet?.();
        h.json(res, 200, buildOverview({ instances: fleet?.instances, defaultBackend: fleet?.defaultBackend }));
        return true;
      }
      if (path === "/ui/library/export" || path === "/ui/library/export-all") {
        let name: string, archive: Buffer;
        if (path === "/ui/library/export-all") {
          const all = allTeamSkillsArchive(store);
          if (!all.ok) { send(all); return true; }
          name = "agend-team-skills.zip"; archive = all.archive;
        } else {
          const id = h.url.searchParams.get("id") ?? "";
          if (!isLibraryId(id)) { h.json(res, 400, { error: "invalid_id" }); return true; }
          const r = h.url.searchParams.get("builtin") === "1" ? builtinSkillFiles(id) : teamSkillFiles(store, id);
          if (!r.ok) { send(r); return true; }
          name = `${id}.zip`; archive = skillArchive(id, r.files);
        }
        res.writeHead(200, { "Content-Type": "application/zip", "Content-Length": archive.length, "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
        res.end(archive);
        return true;
      }
      if (path === "/ui/library/builtin") {
        const name = h.url.searchParams.get("name") ?? "";
        const r = isLibraryId(name) ? builtinSkillFiles(name) : null;
        if (!r || !r.ok) { h.json(res, 404, { error: "not_found" }); return true; }
        const md = r.files[0]!.content;
        h.json(res, 200, { ok: true, detail: { kind: "skill", id: name, builtin: true, files: [{ path: "SKILL.md", content: md, size: Buffer.byteLength(md) }], ...describeSkillText(md) } });
        return true;
      }
      const kind = kindOf(h.url.searchParams.get("kind")), id = h.url.searchParams.get("id") ?? "";
      if (!kind || !isLibraryId(id)) { h.json(res, 400, { error: "invalid_request" }); return true; }
      const got = store.get(kind, id);
      if (got.ok && got.detail.kind === "skill") {
        const md = got.detail.files.find((f) => f.path === "SKILL.md")?.content ?? "";
        h.json(res, 200, { ...got, detail: { ...got.detail, ...describeSkillText(md) } });
        return true;
      }
      send(got);
      return true;
    }
  } catch { h.json(res, 500, { error: "library_failed" }); return true; }
  if (path === "/ui/library/import/preview" || path === "/ui/library/import") {
    void (async () => {
      let bytes: Buffer;
      try { bytes = await readBoundedWebBody(h.req, ZIP_LIMITS.archiveBytes); } catch { h.json(res, 413, { error: "too_large" }); return; }
      if (!h.stillOpen()) return;
      if (h.admission() !== admission) { h.json(res, 403, { error: "admin_required" }); return; }
      const parsed = parseUpload(bytes);
      if (!parsed.ok) { send(parsed); return; }
      const builtin = builtinSkillNames();
      if (path === "/ui/library/import/preview") { h.json(res, 200, { ok: true, ...previewUpload(parsed.upload, takenNames(store, builtin)) }); return; }
      // The bytes the admin read are the bytes stored: the preview's hash must match.
      if (h.url.searchParams.get("sha256") !== parsed.upload.sha256) { send({ ok: false, error: "changed" } as LibraryError); return; }
      const decisions = readDecisions(h.url.searchParams.get("decisions"));
      if (!decisions) { h.json(res, 400, { error: "invalid_request" }); return; }
      const from = (h.url.searchParams.get("filename") ?? "").replace(/[\u0000-\u001f\u007f]/g, "").split(/[\\/]/).pop()!.slice(0, 120);
      h.json(res, 200, { ok: true, results: applyImport(store, parsed.upload.skills, decisions, builtin, from || undefined) });
    })().catch(() => { if (!res.headersSent) h.json(res, 500, { error: "library_failed" }); });
    return true;
  }
  void (async () => {
    let body: Record<string, unknown>;
    try { body = await h.readJson(h.req); } catch { h.json(res, 400, { error: "Invalid JSON" }); return; }
    if (!h.stillOpen()) return;
    if (h.admission() !== admission) { h.json(res, 403, { error: "admin_required" }); return; }
    if (path === "/ui/library/mcp-confirm") {
      if (!body || Array.isArray(body) || typeof body !== "object") { h.json(res, 400, { error: "invalid_request" }); return; }
      const agent = typeof body.agent === "string" ? body.agent : "";
      if (!isLibraryId(body.id) || typeof body.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(body.sha256)) { h.json(res, 400, { error: "invalid_request" }); return; }
      if (!agentOf(h, agent)) { h.json(res, 404, { error: "not_found" }); return; }
      // The version the administrator was shown must be the one stored now, and one the library would hand on at all.
      const got = store.mcpForMount(body.id);
      if (!got.ok) { h.json(res, got.reason === "not_found" ? 404 : 422, { error: got.reason === "not_found" ? "not_found" : "unsafe_item", detail: got.reason }); return; }
      if (got.sha256 !== body.sha256) { send({ ok: false, error: "changed" } as LibraryError); return; }
      new McpConfirmations(store).confirm(agent, body.id, got.sha256);
      h.json(res, 200, { ok: true });
      return;
    }
    const kind = kindOf(body?.kind);
    if (!body || Array.isArray(body) || typeof body !== "object" || !kind) { h.json(res, 400, { error: "invalid_request" }); return; }
    if (path === "/ui/library/delete") { send(store.remove(kind, body.id)); return; }
    const overwrite = body.overwrite === true;
    // A skill may not take a built-in skill's name (importing already refuses it): the bundled copy is what an agent would get.
    if (kind === "skill" && isLibraryId(body.id) && builtinSkillNames().has(body.id)) { send({ ok: false, error: "exists", detail: "builtin" } as LibraryError); return; }
    // Replacing says which version it started from (AGEND-261, from the review of #76): a call that does not is refused, so the API
    // cannot overwrite blind. The version is the hash of what is stored now; one that is another now is not overwritten.
    if (overwrite && typeof body.expect !== "string") { send({ ok: false, error: "expect_required" } as LibraryError); return; }
    if (typeof body.expect === "string") {
      const now = isLibraryId(body.id) ? store.get(kind, body.id) : null;
      if (!now || !now.ok || now.detail.sha256 !== body.expect) { send({ ok: false, error: "changed" } as LibraryError); return; }
    }
    send(kind === "skill" ? store.addSkill(body.id, body.files, { overwrite }) : store.addMcp(body.id, body.text, { overwrite }));
  })().catch(() => { if (!res.headersSent) h.json(res, 500, { error: "library_failed" }); });
  return true;
}
