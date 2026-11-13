# Library (Skills and MCP servers)

The library is a place inside the AgEnD data folder to keep **skills** and **MCP server definitions**. An agent gets a library
**skill** only when an administrator mounts it on that agent (see [Mounting skills](#mounting-skills-on-an-agent)); an agent with
nothing mounted is exactly as it was, whether the library is empty or full. MCP servers are stored but cannot be mounted yet, and
sharing library items inside an exported agent file is a separate later step (the export file already reserves an empty `library:`
section for it).

Open it from the sidebar (**Library**, `/ui/library`). It is for an administrator; a fleet that never opens it gets no `library/` folder.

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

## Mounting skills on an agent

An administrator gives an agent library skills in **Settings → the agent → Workspace → Library** (tick the team skills), or in
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

`GET /ui/library/list`, `GET /ui/library/item?kind=skill|mcp&id=<id>`, `POST /ui/library/save`, `POST /ui/library/delete`.
