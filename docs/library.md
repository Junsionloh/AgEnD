# Library (Skills and MCP servers)

The library is a place inside the AgEnD data folder to keep **skills** and **MCP server definitions**. An agent gets a library
**skill** or **MCP server** only when an administrator mounts it on that agent (see [Mounting skills](#mounting-skills-on-an-agent) and
[Mounting MCP servers](#mounting-mcp-servers-on-an-agent-claude-code-only)); an agent with nothing mounted is exactly as it was, whether
the library is empty or full. MCP servers can be mounted on **Claude Code** agents only for now, and sharing library items inside an exported agent file is a separate later step (the export file already reserves an empty `library:`
section for it).

Open it from the sidebar (**Library**, `/ui/library`). It is for an administrator; a fleet that never opens it gets no `library/` folder.

## The overview

The page is an overview of what this AgEnD has — **Skills**, **Tools** and **MCP servers** — and of which agents use them. It is laid out
like Settings: the categories in a list on the left (the Settings page's own `.s-nav`), the chosen one on the right, a filter box on top;
on a phone `/ui/library` is the list of categories and a category opens on its own (`/ui/library/skills`, `/tools`, `/mcp`) with a back link.
Every item is one row of **two lines**, the same in every category: line 1 is the name and its description (cut to one line), line 2 is who uses it, what it is for or how big it is, and
whether it is built in or the team's. *Details* sits in a column at the right of the row, centered on it, so it never moves with the content (Export and Delete sit beside it; under 600 px wide only *Details* stays in the row —
Export and Delete are in the dialog it opens). A row shows at most three agent tags (one on a phone) and then **+N**, which opens the item rather than making the row taller. Each category has two groups:

- **Built in · read only** — what ships with AgEnD, listed from the package and the code, never editable here: the bundled skills
  (`src/general-knowledge/skills`, with the roles they are published to: General, workers, classic bots), the `tool_set` profiles
  (`TOOL_PROFILES`, with each tool list) and AgEnD's own `agend` MCP server.
- **Added by your team** — the library items below: add, import, export, view, edit (skills), delete.

**Used by** is a row of tags, one per agent: bundled skills by the agent's role (General gets every one; any other agent those marked for
workers, and only an agent whose CLI has a skills folder), tool sets by the agent's `tool_set` (the rule the daemon itself uses), the `agend`
MCP server by every agent, and team skills by the agents they are mounted on. A tag opens that agent: for a team skill straight to
*Settings → the agent → Workspace → Team skills (from the Library)*, otherwise to the agent. A team skill also has a **+** tag: pick agents
and it is written into their settings — the same `library` value, through the same `PATCH /api/settings/fleet/instances/<name>` and the same
Apply as ticking the skill on the agent's own Settings page (`agentPatchRequest` / `libraryMountPatch` in `settings-model.js` are the one copy
of that write). It takes effect the next time the agent starts. Built-in tags only open an agent; nothing built in can be added or changed.

The page reads the existing settings and changes nothing by itself: no agent file, setting or launch command moves unless you use **+**
(or the agent's own Settings). A team skill mounted on an agent whose CLI has no skills folder (the backend table in
`src/native-skills-dir.ts`) is flagged on its tag and on the agent's *Team skills* field: it cannot take effect there. A team MCP server's tags count the agents that mount it (flagged the same way on a backend that cannot take
one), and a server that needs a variable AgEnD's environment does not have shows **Missing X**.

## Preview and Edit (skills)

*Details* on a skill opens a dialog with two tabs. **Preview** draws `SKILL.md` as Markdown with AgEnD's own chat renderer (it escapes the text first: no raw HTML, no script, nothing new is
loaded), shows the frontmatter as fields (name, description, roles…), the agents that use it, and lists the other files, each opening as text. **Edit** (team skills only) changes the text of
`SKILL.md` and of the other files; a save is the library's own save, so it runs the same checks and the same secret scan as adding a skill, writes **nothing** when one fails, and records the new
hash in `library.lock.json` when it succeeds. The editor sends the hash it read: a skill that was saved by someone else since is not overwritten (the answer is `changed`). If agents have the
skill mounted, the dialog names them first — they get the new text the next time they start. A **built-in** skill has Preview only (no Edit tab); it can be exported as a copy.

## Export and import (skills)

- **Export.** Every skill row has an **Export** button that downloads `<id>.zip` (`<id>/SKILL.md` and its other files); the Skills page has **Export all** for every team skill in one zip. A built-in skill can be exported
  too — a copy; the shipped skill is untouched. Exporting a skill and importing it again gives back every byte (the same hash).
- **Import.** **Import** takes a `.zip`, a `.skill` file (the same zip under another name — the bytes decide, not the name) or a single `SKILL.md`. A zip may hold one skill (`<id>/SKILL.md…`, or `SKILL.md` at
  the top, named by its `name:`) or several (one folder each, what *Export all* writes; up to 100). Before anything is stored you read the **preview**: each skill's name, description, file list and the full `SKILL.md` (a
  skill is instructions an AI will follow), and what was left out (`__MACOSX/`, `.DS_Store`). Nothing is stored until you confirm, and **no agent is given the skill** — it only lands in the library.
- **A name that is taken** is settled by you, per skill: **replace** the team skill, **import under another name** (only the `name:` line of `SKILL.md` changes), or **skip** (the default). A name shared with a **built-in** skill is
  never replaced: rename or skip.
- **The rules are the library's own** (`validateSkill`): names, size and file-count limits, text only, no hidden file, no Windows device name (`con`, `nul.txt`…), and the secret scan (a hit refuses that skill and reports
  the file and line, never the value). The archive reader adds its own: a path that would leave the folder (`../`, `/x`, `C:\x`, backslashes — "zip slip"), a symbolic link or any entry that is not a plain file, an encrypted entry,
  ZIP64, a method other than stored/deflate, a bad CRC, a header that lies about its size (inflating stops at the size it declared), two entries with the same name (also by case), and the limits (16 MiB uploaded, 32 MiB
  unpacked, 200 KiB a file, 4000 entries). A skill that fails is shown with the reason and is not imported; the others still are (each skill is saved on its own, atomically).
- **The file you previewed is the file that is stored:** the import carries the preview's SHA-256 and is refused (`changed`) if the bytes are not the same.
- **Not in this version:** importing from a URL (GitHub etc. — that touches the network and trust in a source), and exporting or importing MCP items.

## Where it lives

```
<AGEND_HOME>/library/
  skills/<id>/SKILL.md          # + optional supporting files (references/, scripts/, …)
  mcp/<id>.yaml
  library.lock.json             # sha256, size and source of every item added through AgEnD
```

`<id>` is lowercase letters, digits and dashes (up to 64), the same rule as the bundled skills.

## Skills

The usual Claude Code / Multica layout: a folder with a `SKILL.md` that starts with a `---` block holding `name` (must equal `<id>`) and
`description`, then the instructions. Supporting files must be text. Limits: `SKILL.md` 100 KiB, other files 200 KiB each, 384 KiB and 64
files in all; file paths are relative, `/`-separated, at most 6 deep, made of letters, digits, `.`, `_` and `-`, none hidden, none leaving
the folder.

## MCP servers

One YAML file that names the **variables** a server needs — never their values:

```yaml
agend_library: 1
kind: mcp
name: github
description: GitHub issues and pull requests
transport: stdio            # or http
command: npx
args: [-y, "@modelcontextprotocol/server-github"]
env: [GITHUB_TOKEN]         # names only; a `KEY: value` map is refused
```

An `http` server has `url` (no credentials, no query string) and `headers`, a map from header name to the variable holding its value
(`Authorization: GITHUB_TOKEN`).

## Mounting MCP servers on an agent (Claude Code only)

AGEND-260, a first trial on one backend. An administrator ticks MCP servers in **Settings → the agent → Workspace → Team MCP servers (from
the Library)**, or lists their ids in `fleet.yaml` (`instances.<name>.library.mcp`). No agent tool can write it. It is a cold key: an agent
restart applies it.

- **Where it goes.** At each start the daemon adds the mounted servers to the agent's own `mcp-config.json` (in its instance folder, loaded
  with `--mcp-config`) as `agend-lib-<id>`. Nothing else is derived from the library, and an agent with no mount gets exactly the file
  and launch command it always had (a golden test holds that). Un-mounting writes the file without them. The person's own MCP servers
  (Claude's user, project and local config) are never touched. Other backends and native Windows agents show *Not supported yet*, and
  `fleet.yaml` warns that `library.mcp` is ignored there.
- **Only a saved item runs.** An item that was edited outside the Library, placed there by hand, or breaks a rule is not enabled (it
  runs a command), and neither is one that is gone. Save it on the Library page to record its hash and it can be mounted.
- **Secrets.** The library holds variable *names* only. The value comes from the environment AgEnD runs in when the agent starts. It is
  never written to a file, a log or an API answer: the config entry holds `${AGEND_LIBMCP_<n>_<NAME>}` and the launch command gives
  Claude Code that alias (the way the fleet's own `ANTHROPIC_API_KEY` is given), so the real name (`GITHUB_TOKEN`) is set only in the MCP
  server's own environment. A server whose variable is not set (or empty) is **not enabled**: Settings and the Library page say *Missing X*,
  and the daemon log names it (names only). The agent still starts.
- **`env_isolation` (AGEND-242).** The alias reaches Claude Code through the launch command, not through what the process inherits, so
  the dry run changes nothing and an enforcing allowlist later could not take it away.
- **Known limits.** The alias is in the Claude Code process's environment, and the value is in the launch command tmux keeps (`pane_start_command`) —
  the same exposure as the fleet's `ANTHROPIC_API_KEY` today (AGEND-229 §5; handing it over with tmux's `-e` instead is a follow-up); and
  the server's tools are not restricted (`--allowedTools` is a follow-up). A Claude Code agent with permissions skipped can call them.

## Mounting skills on an agent

An administrator gives an agent library skills in **Settings → the agent → Workspace → Team skills (from the Library)** (tick them), with the **+** tag on the Library page, or in
`fleet.yaml`:

```yaml
instances:
  reviewer:
    library:
      skills: [pr-review, triage]
```

Only an administrator can set it (Settings or `fleet.yaml`); no agent tool can, and the fleet `defaults` cannot. It is applied at
the agent's next start, so a change restarts the agent. The built-in skills are given by the agent's role and are not part of this list.

At each start AgEnD copies the mounted skills into the folder the agent's CLI reads (`.claude/skills`, `.agents/skills`, `.grok/skills`,
`.kiro/skills`, as for the built-in skills), and records what it wrote in its **own** file, `.agend-library-skills.json`, beside
the built-in record (`.agend-managed-skills.json`), which it never touches.

- **Who wins a name:** a folder you made yourself > a built-in skill > a library skill. A folder that is not in the record is yours and is
  never changed or removed; a library skill named like a built-in one is skipped (and said once in the log).
- **Un-mounting** removes only the folders listed in the record, and only one that is still exactly what AgEnD wrote (the record keeps its hash). An agent with nothing mounted and no record gets no new file.
- **Only a skill that passes every rule and is still the saved one is given.** A skill edited by hand in the library folder, or put there
  without saving it on the Library page, is not given until it is saved again; one that was already given is left as it is.
- **Agents that share one working directory** share its skills folder, so the folder gets the union of their mounts (otherwise each start
  would remove what the other was given).
- **A change you make in a published folder is yours.** If a published folder no longer matches what AgEnD wrote — you edited it, or replaced it with a
  folder of your own of the same name — AgEnD does not overwrite it with library updates and never deletes it, not even when you un-mount
  the skill (it just leaves its record, and the log says so). To get the library version back, delete the folder and restart the agent.
- **When it runs:** skills are published only when a fleet agent or the General starts (not for a ClassicBot room or a Windows native agent). An agent that was
  deleted leaves its skills in a shared folder until another agent that shares the folder restarts, which then cleans up what is no longer mounted.

## Secrets

Anything that looks like a key, token or password (the same scan the agent export uses) is refused with the file and line, never the value.

## Safety

Every read treats the folder as untrusted: symlinks are never followed (an item that is or contains one is listed as *Not usable*),
sizes are capped, and only valid ids are listed. Writes validate first and land atomically. The lock lets a later step tell an item
changed by hand (*Changed by hand*), one added outside this page (*Not recorded*) and one whose files are gone (*Missing*).

## Web routes (admin only)

`GET /ui/library/list`, `GET /ui/library/item?kind=skill|mcp&id=<id>` (a skill also comes as `fields` + `body`, SKILL.md split for display), `GET /ui/library/overview` (built-in skills, tool sets, the `agend` MCP server and who uses what; read only),
`POST /ui/library/save` (`expect`: the hash an editor read — **required** when `overwrite` is true, `changed` if the item is another one now; a built-in skill's name is refused), `POST /ui/library/delete`.
`GET /ui/library/list` also gives each MCP item `mcp: { transport, vars, missing }` (names only) and `mcpBackends`; the overview gives `teamMcpUsage` and, per agent, `libraryMcp`.

Skills in and out (AGEND-257): `GET /ui/library/export?id=<id>[&builtin=1]` and `GET /ui/library/export-all` (zip downloads), `GET /ui/library/builtin?name=<name>` (a built-in skill for display),
`POST /ui/library/import/preview?filename=` and `POST /ui/library/import?sha256=&decisions=` (the body is the uploaded file's bytes; `decisions` is URL-encoded JSON `{ "<name>": { "action": "overwrite"|"rename"|"skip", "as": "<new name>" } }`).
