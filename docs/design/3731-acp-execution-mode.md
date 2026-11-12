# #3731: an opt-in "structured" execution mode (ACP and native protocols)

Status: **draft design for review after 2.5. Nothing here is implemented.** No code change accompanies this document.
Issue: [#3731](https://github.com/songsid/AgEnD/issues/3731) (Step 2 of the plan in that issue). Related: #3648, #739, #1411, #1209, #2950, #1218.

## 0. How to read this document

### Evidence labels

Every statement about a CLI or the protocol carries one of these labels, so a reviewer can tell a measurement from a guess.

| Label | Meaning |
|---|---|
| **[V]** | Verified on the machine where this was written, with the version shown. Only protocol handshakes, `--help` output and offline schema generation were run. **No prompt was ever sent to any CLI** and no model request was made. |
| **[S]** | Stated by the Agent Client Protocol specification (https://agentclientprotocol.com), read on the day of writing. The spec is the only source for protocol semantics here. |
| **[U]** | Unverified. An inference, a claim from a public listing, or something that can only be checked by running a real turn. Each [U] is repeated in §9 as something to check before building. |

### Code references

AgEnD code references are `path:line`, relative to the repository root.

- Unqualified references are at **`main` @ `43e570835`**.
- References prefixed **`alpha:`** are at `release/2.3.5-alpha` @ `aed5a074a`. The Windows runtime, and the #3648 chat timeline work, are on that line and are **not on `main` yet**. Line numbers will drift; the file and symbol names are the stable part.

### Terms

- **tmux mode**: today's execution model. The CLI is a TUI in a tmux window, and `Daemon` (`src/daemon.ts:1401`) observes and drives it through the pane.
- **Structured mode**: this proposal. The daemon owns the CLI process and talks to it over stdio with a structured protocol. The CLI's terminal UI is never started and never parsed.
- **ACP**: the Agent Client Protocol, JSON-RPC 2.0 over stdio between a *client* (here, AgEnD) and an *agent* (the CLI).

## 1. Summary

1. Add a **per-instance, opt-in** structured mode next to tmux mode. It never replaces tmux and is off by default. An instance that does not opt in behaves exactly as today.
2. The mode is implemented as **a new execution class beside `Daemon`**, not as a fake `Pane`. `Daemon` assumes a pane in well over a thousand places (§5.1); faking one would make every guess about screen text a hidden dependency.
3. **Protocol rule:** use ACP when the CLI speaks it natively. Use the CLI's own structured protocol where it is materially richer than ACP's. Never parse a TUI in this mode.
4. By that rule (§3): grok and agy use ACP [V]. Codex uses its own `app-server` protocol [V]. Claude Code uses its own `stream-json` mode [V flags; behaviour U]. Kiro and OpenCode are expected to speak ACP but are **not verified** [U]. Muse has no known structured protocol and stays on tmux.
5. What is lost is real: **no pane view and no `agend attach`** for these instances. §2.2 says what replaces the pane view in the web chat, and what has no replacement.
6. Phasing (§8): grok + agy first, then Kiro + OpenCode, then Claude + Codex. About 2–3 weeks for the first phase and 1–2 weeks per additional CLI, as estimated in #3731. No phase merges before the maintainers decide, after 2.5.

## 2. Positioning

### 2.1 What the mode is

A new per-instance setting selects how the CLI is run. Two values: the existing tmux behaviour (default) and structured. The name is an open question (§9): the obvious spelling, `runtime: acp`, **collides** with the existing `runtime` field, which already means *execution host* (`wsl` | `windows`; `alpha:src/types.ts:106`), and the mode is not always ACP (Codex and Claude use native protocols). A neutral name such as `execution: tmux | structured` avoids both problems.

The mode is chosen **when the instance is created or edited**, like `backend` is. It is not a global switch and there is no automatic fallback between modes: an instance that fails in structured mode fails visibly and is not silently relaunched in a TUI (that would change what the user's agent is, mid-conversation).

### 2.2 What is lost, and what replaces it

| In tmux mode today | In structured mode |
|---|---|
| Live pane view in the web terminal / dashboard (`src/web-terminal.ts`, `src/tmux-manager.ts:99`) | **Not available.** There is no screen. Replaced by the chat timeline and the Log tab (below). |
| `agend attach` and `agend ls` showing a window | **Not available.** `ls` shows the instance with a "structured" marker and no window. |
| Typing into the CLI by hand in the pane | **Not available.** The operator sends through chat, the same way every other user does. A future "send raw prompt" admin action is possible, but is not a keyboard. |
| Seeing a dialog the CLI is showing | Replaced by structured permission requests (§4, "Dialogs and permissions"), shown as buttons in web chat and Telegram. |
| Seeing "what is it doing right now" | **Better than today:** thought chunks, tool starts/updates/ends and plans arrive as they happen, and feed the same timeline #3648 builds from transcripts (§5.5). |

Where a person needs the real TUI (first login, debugging a CLI bug, trying a CLI feature that only exists in its UI), they use tmux mode on that instance, or on a second instance. Switching an instance between modes starts a new execution; whether the conversation carries over depends on the CLI's session storage (§4, "Session id").

### 2.3 Non-goals

- Not a replacement for tmux mode, and not a deprecation path for it.
- Not a general ACP agent host. AgEnD is the ACP *client*; this document does not make AgEnD an ACP *agent* for editors.
- Not Windows-specific. The Windows per-turn adapter is a precedent (§5.2), not a target.

## 3. Protocol selection and per-CLI routes

### 3.1 Rule

For each backend, in order:

1. **Native ACP** exists on the CLI → use ACP.
2. Otherwise, the CLI has its own structured, documented-by-schema protocol → use it, via a small per-CLI driver implementing the same internal interface as the ACP client (§5.3).
3. Otherwise → the backend is **not available in structured mode**. It stays on tmux. There is no "TUI fallback inside structured mode."

Where both exist and they differ, use the richer one only if the difference matters to a feature in §4 and can be named. Today that is exactly one case: Codex's `turn/steer` and `thread/tokenUsage/updated` (§3.2).

A third-party ACP *adapter* that wraps a different stack (for example one built on an SDK rather than on the CLI binary) is **not** the CLI. It is a different program with its own login, billing and behaviour surface, and is out of scope unless a maintainer decides otherwise.

### 3.2 Routes

Versions are the ones present where this was written: grok 1.0.77, agy 1.5.6, Claude Code 2.1.322, Codex 0.167.2. Kiro CLI, OpenCode and Muse were **not installed**, so everything about them is [U].

| Backend (`src/backend/factory.ts:12`) | Route | Launch (structured) | Evidence |
|---|---|---|---|
| **grok** | ACP | `grok --no-auto-update agent --no-leader [--always-approve] [--model …] [--reasoning-effort …] stdio` | `initialize` handshake **[V]**; `agent` subcommands `stdio`, `headless`, `serve`, `leader` **[V]**; `--always-approve`, `--reasoning-effort` on `agent` **[V]**. Live `agent_thought_chunk` emission **[U]** (needs a real turn). |
| **agy** (`antigravity`) | ACP | `agy acp` (flags such as `--dangerously-skip-permissions` stay launch args or a mode, to be settled in phase 1) | `initialize` handshake **[V]** (`agentInfo` "Antigravity ACP Server" 1.5.6). `agy` also has a print mode with `--input-format stream-json --output-format stream-json` **[V]**, which is a second, non-ACP structured route if ACP gaps appear. Live thought chunks **[U]**. |
| **kiro-cli** | ACP, expected | `kiro-cli acp` (name and flags to be confirmed) | **[U]** entirely: the binary was not available. Listed in the public ACP agent registry per the issue text. Today's backend is `kiro-cli chat` (`src/backend/kiro.ts:1691`) with a large Kiro-specific layer (`src/kiro-*.ts`). |
| **opencode** | ACP, expected | `opencode acp` (to be confirmed) | **[U]** entirely, same reason. Today: a bare TUI, config via `OPENCODE_CONFIG` (`src/backend/opencode.ts:50`). |
| **claude-code** | Native `stream-json` | `claude -p --input-format stream-json --output-format stream-json --include-partial-messages --permission-prompt-tool <mcp tool> --mcp-config <file> --strict-mcp-config [--resume <id>\|--session-id <uuid>]` | No `acp` entry point in `claude --help` **[V]**. All of the flags above appear in `--help` **[V]**. That partial messages include thinking deltas, that `--permission-prompt-tool` routes every permission request, and the exact event shapes: **[U]** until a turn is run. |
| **codex** | Native `app-server` | `codex app-server` (JSON-RPC over stdio, experimental) | No ACP **[V]**. `codex app-server generate-json-schema` works offline **[V]** and the schema contains: `thread/start`, `thread/resume`, `thread/fork`, `turn/start`, **`turn/steer`**, `turn/interrupt`, `item/reasoning/textDelta`, `item/reasoning/summaryTextDelta`, `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `thread/tokenUsage/updated`, `account/rateLimits/updated` **[V]**. The server is labelled "[experimental]" **[V]**, which drives the version-gate requirement (§9). |
| **muse** | None known | stays tmux | **[U]**: not installed, no protocol known. Today's steering is a TUI feature (`src/steer-capability.ts:5`). Revisit if Muse publishes a protocol. |
| **mock** | In-process fake | an ACP/native-protocol fake for tests | Needed in phase 1 so the daemon-side machinery is testable without a real CLI (§8). |

Why Codex and not ACP for Codex: ACP's [S] turn model has no way to add input to a running turn (the spec says only that the client may send another `session/prompt` once the turn completes). Codex's `turn/steer` does, and AgEnD already treats mid-turn steering as a feature for Codex, Claude, grok and muse (`src/steer-capability.ts:5`). For the same reason Codex's `thread/tokenUsage/updated` and `account/rateLimits/updated` serve §4's context % and quota rows directly.

Why Claude on `stream-json` and not an ACP adapter: the only ACP route to Claude is a third-party adapter on another stack (§3.1). `--input-format stream-json` keeps the actual CLI binary and its own auth.

## 4. Feature parity: what each pane-derived feature becomes

Legend: **Replaced** = a structured signal exists and is named. **Partial** = exists for some CLIs. **Unsupported** = no replacement; the feature is hidden for these instances. Evidence labels as in §0; the right-hand column of the ACP spec is [S], and the per-CLI availability is in the sub-bullets.

| Feature | Today (tmux mode) | Structured mode | Status |
|---|---|---|---|
| **Idle / busy** | Pane scraped on a timer by a state machine (`src/daemon.ts:342`, `:487`, `:7008`, `:7338`), with backend ready/busy patterns (`src/backend/types.ts:849`, `:870`). | Busy = a `session/prompt` request is outstanding; idle = its response arrived with a `stopReason` [S]. Codex: `turn/start` … turn-completed notification. Claude: `result` event [U]. No hashing, no timers. | **Replaced** |
| **Hang / stuck** | The same pane state machine emits `hang` when the pane stops changing (`src/hang-detector.ts:1`, `src/daemon.ts:7434`); lifecycle surfaces it (`src/instance-lifecycle.ts:988`). | A turn that is outstanding with **no `session/update` for N seconds** (N from the existing `hang_detector` config). The signal is weaker than "pane changed" in one way and stronger in another: a long silent model call looks the same as a stall, but a running tool reports `in_progress` and a spinner redraw can no longer mask a stall. | **Replaced** (different semantics, §9) |
| **Dialogs and permissions** | Runtime/startup dialogs matched on screen text and answered with keys (`src/backend/types.ts:903`, `:916`; `src/daemon.ts:8416`, `:5088`). | ACP: the agent calls `session/request_permission` with the tool call and options `allow_once` / `allow_always` / `reject_once` / `reject_always` [S]. Codex: `item/*/requestApproval` [V]. Claude: via `--permission-prompt-tool` [U]. AgEnD answers from policy (§7) or forwards to web chat / Telegram as buttons and returns the chosen `optionId`. Dialogs that are not tool permissions (update prompts, trust prompts) do not exist, because no TUI runs. | **Replaced**, better |
| **Steer** (add input to a running turn) | Keys/paste into the composer while busy (`src/daemon.ts:7830`, `:9304`), gated per backend (`src/steer-capability.ts:5`). | Codex: `turn/steer` [V]. Claude: a further `stream-json` user message mid-turn [U]. **ACP: no mid-turn input is defined** [S]. grok/agy therefore queue the message until the turn ends, which is the same as today's "queued input" behaviour, not steering. | **Partial** (Codex yes; ACP CLIs queue) |
| **Cancel** | Send the backend's cancel key into the pane (`src/daemon.ts:4856`; grok `C-c`, `src/backend/grok.ts:666`; agy `Escape`, `src/backend/antigravity.ts:508`). | ACP `session/cancel` notification; the prompt response returns `cancelled` [S]. The client must answer any pending permission request with the `cancelled` outcome and mark unfinished tool calls cancelled [S]. Codex: `turn/interrupt` [V]. Claude: interrupt control message [U]. | **Replaced**, better |
| **Context %** | Backend-specific: statusline file for Claude (`src/context-guardian.ts`, `src/daemon.ts:3265`), pane footers for others (`src/backend/grok.ts:583`, `src/backend/types.ts:834`). | Codex: `thread/tokenUsage/updated` [V]. grok: `initialize` advertises per-model `totalContextTokens` in `_meta` [V]; per-turn usage not seen **[U]**. ACP spec lists a `usage_update` session update (context window usage) [S]; whether grok and agy emit it **[U]**. Claude: usage fields in `result` [U]. | **Partial** |
| **Quota / rate-limit notices** | Regex error patterns over the pane (`src/backend/types.ts:162`, `:897`; `src/daemon.ts:2119`, `:4309`). | Codex: `account/rateLimits/updated` [V]. ACP: errors come back as JSON-RPC errors or `stopReason: refusal` / `max_tokens` [S]; the *quota* wording is CLI-specific and its presence in those errors is **[U]**. The existing usage scanners that read provider data (`src/usage/…`) are independent of the pane and are kept. | **Partial** |
| **Session id / resume** | Per-backend: file scans, footers, transcripts; persisted as `session-id` (`src/daemon.ts:13730`–`:13768`, `src/backend/grok.ts:401`). | The id is returned by `session/new` [S] and persisted by the same code path. Resume: `session/load` (replays history as updates; response only after replay) or `session/resume` (no replay) [S]. Capabilities seen: grok `loadSession` + `list`/`resume`/`close` [V]; agy `loadSession` + `list`/`load`/`resume`/`close`/`additionalDirectories` [V]. Codex: `thread/resume` [V]. Claude: `--resume` / `--session-id` [V]. | **Replaced**, simpler |
| **Login / sign-in** | Web sign-in runs the CLI's login command in a pane and scrapes the URL/code (`src/web-backend-login.ts:33`, `:137`; `src/structured-signin.ts:12`; `src/web-terminal.ts:40`). | ACP `initialize` returns `authMethods` and `authenticate` takes a `methodId` [S]. Seen: grok `cached_token`, `grok.com` [V]; agy `oauth-personal`, `oauth-business`, `gemini-api-key`, `agent-platform` [V]. The browser-based methods still need a human and a URL, and **the CLI's own login command is still a TUI/terminal flow**. The existing web login flow is therefore **kept unchanged**: it logs in with the CLI's login command in a terminal pane, which is independent of the instance's execution mode (the credentials land where the CLI keeps them). Structured mode only needs "authenticated, or not" from `initialize`/`session/new` (`auth_required`, -32000 [S]). | **Kept as is** |
| **Delivery proof** ("was the message consumed?") | Pane + transcript marker checks and a consumed watcher (`src/daemon.ts:8142`, `src/delivery-consumed-watch.ts:79`, `src/delivery-reconciliation.ts:61`). | The `session/prompt` request is accepted, and its `user_message_chunk` echo / eventual response is the proof. The durable outbox contract (`src/delivery-outbox.ts:562`) is unchanged: it needs one "consumed" callback per attempt, which the structured runner provides from the protocol. The pane-ownership and "typed into the wrong composer" classes of failure disappear. | **Replaced**, simpler |
| **Crash / respawn** | tmux window death detected via pane liveness, then backoff respawn (`src/daemon.ts:3825`, `:4018`, `:4124`, `:8804`). | The child process exit / stdio EOF is the signal. The same backoff and `crash_loop` events (`src/instance-lifecycle.ts:1106`) are reused; on respawn the runner does `session/load`/`resume` with the stored id. | **Replaced**, simpler |
| **Reply tool / MCP calls** | The CLI calls the `agend` MCP server, which reports over the daemon IPC (`src/daemon.ts:3089`, `:6860`). | **Unchanged.** MCP is a separate channel from the pane. Only how the MCP server is *declared to the CLI* changes (§6). | **Kept as is** |
| **Chat activity / Log tab** | Transcript parsers: `TranscriptMonitor` (`src/transcript-monitor.ts:25`), `LogStep` parsers (`src/log-steps.ts:24`, `:365`, `:452`), served by `src/log-service.ts` and `GET /ui/steps` (`src/web-api.ts:1982`). | The runner emits the same `LogStep`s directly from `session/update` (`agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`) [S]. No transcript file is needed, and thinking arrives live instead of after the block ends. | **Replaced**, better |
| **Pane view, attach, raw typing** | See §2.2. | — | **Unsupported** |
| **Startup banner / trust / update dialogs** | Startup dialog handlers and `--no-auto-update` flags (`src/backend/types.ts:916`, `src/backend/grok.ts:376`). | None exist without a TUI. The agent's own "auto-update" must still be disabled by flag where it exists. | **Not needed** |
| **Context rotation / compaction** | CLIs auto-compact; AgEnD only observes (`src/context-guardian.ts:1`). | Unchanged. ACP defines `compaction_update` updates behind a client capability [S]; optional. | **Kept as is** |
| **Effort / model selection** | Launch flags (`src/backend/grok.ts:394`, `src/backend/antigravity.ts:230`). | Launch flags where they exist [V for grok `--reasoning-effort`], or ACP `session/set_config_option` / model state in `initialize` [S/V]. | **Replaced** |

## 5. Architecture

### 5.1 Why a parallel class, not a pane substitute

`Daemon` is 14,143 lines (`src/daemon.ts`), and about 1,400 lines mention `tmux`/`pane` (counted with `grep -c "tmux\|Pane\|pane"`); #3731 estimated "roughly 280" *call sites*, and the two numbers measure different things (all mentions vs. places that read or write a pane). Either way the assumption is pervasive: state machine, delivery, dialogs, hang, cancel, quota. A fake `Pane` that returned empty screens would make every pattern matcher silently report "idle, nothing wrong". The honest shape is a second class that implements only what the rest of the fleet needs from an instance.

### 5.2 Precedent: the Windows per-turn adapter

The closest existing precedent is the Windows runtime's `native_adapter: "exec"` path, which runs one process per turn without a pane. **It lives on the alpha line, not `main`.**

- Config: `native_adapter?: "exec" | "pane"` (`alpha:src/types.ts:112`), validated in `alpha:src/config-validator.ts:663`.
- Dispatch: a single predicate `isNativeExecInstance(config)` (`alpha:src/native-instance-registry.ts:25`) is the fork. `FleetManager` branches on it at many sites (e.g. `alpha:src/fleet-manager.ts:1502`, `:2483`, `:2554`, `:4896`, `:5136`), and returns early or delegates to `FleetWindowsRuntime` (`alpha:src/fleet-windows-runtime.ts:52`) instead of going through a `Daemon`.
- Contract: `FleetWindowsRuntime` takes a small `host` interface (`alpha:src/fleet-windows-runtime.ts:20`) rather than the whole `FleetManager`.

Lessons to take, and one to avoid:

- **Take:** a single predicate, a separate runtime object, and a narrow host interface.
- **Take:** an explicit refusal list (the Windows path has `WINDOWS_CREATE_REFUSED`, defined in `alpha:src/native-instance-registry.ts` and used at `alpha:src/instance-lifecycle.ts:2636`) so unsupported operations (attach, raw keys) fail with a clear message.
- **Avoid:** growing the number of `if (isNative…)` branches inside `FleetManager`. The Windows path needed many. Structured mode should instead put the branch in **one place** (§5.3) and have the rest of the fleet talk to an interface.

### 5.3 Proposed shape

```
FleetManager ──► InstanceLifecycle ──► InstanceRunner (interface)
                                         ├─ Daemon              (tmux mode; unchanged)
                                         └─ StructuredInstance  (new)
                                               ├─ AcpClient         (JSON-RPC over stdio; grok, agy, kiro, opencode)
                                               ├─ CodexAppServerDriver   (phase 3)
                                               └─ ClaudeStreamDriver     (phase 3)
```

`InstanceLifecycle` already owns the instance registry as `readonly daemons = new Map<string, Daemon>()` (`src/instance-lifecycle.ts:556`) and constructs daemons in one place (`src/instance-lifecycle.ts:1872`, from `start` at `:1789`). The first refactor is to introduce an `InstanceRunner` interface containing **only the methods other modules already call on a daemon**, make `Daemon` satisfy it without behaviour change, and let the registry hold `InstanceRunner`. This refactor is useful on its own and can be reviewed (and rejected) separately from any protocol work.

Sketch of the interface (names illustrative; the real list comes from grepping call sites in phase 0):

```ts
interface InstanceRunner {
  start(): Promise<void>;
  stop(): Promise<void>;
  getProcessStatus(): "running" | "crashed" | "stopped";      // src/daemon.ts:2027
  getInstanceStateSnapshot(): InstanceStateSnapshot;           // src/daemon.ts:5524
  deliver(message: DeliveryRequest): Promise<DeliveryResult>;  // src/daemon.ts:8142
  steer?(content: string, meta: Record<string, string>): void; // src/daemon.ts:7830 (capability-gated)
  cancel(): Promise<void>;                                     // src/daemon.ts:4856
  getSessionId(): string | null;                               // src/backend/types.ts:840
  on(event: "crash_respawn" | "crash_loop" | "hang" | "steps" | "permission" | …, cb): this;
}
```

`StructuredInstance` implements it over a small internal event vocabulary:

```ts
type RunnerEvent =
  | { kind: "thought"; text: string }
  | { kind: "message"; text: string }
  | { kind: "tool"; id: string; title: string; toolKind: string; status: "pending"|"in_progress"|"completed"|"failed"; rawInput?: unknown; rawOutput?: unknown }
  | { kind: "plan"; entries: unknown[] }
  | { kind: "permission"; requestId: string; tool: unknown; options: { id: string; name: string; kind: string }[] }
  | { kind: "turn_end"; stopReason: string }
  | { kind: "usage"; used?: number; size?: number }
  | { kind: "auth_required" };
```

The ACP client, the Codex driver and the Claude driver each translate their wire format into `RunnerEvent`. Everything above that line (permissions UI, timeline, outbox, hang) is written once. **The protocol difference is confined to three small translators, and to the one place where Codex adds `steer`.**

### 5.4 Modules that change

| Module | Change | Size |
|---|---|---|
| `src/types.ts` | New per-instance field (name: §9) and its validation in `src/config-validator.ts`. | small |
| `src/instance-lifecycle.ts` (`:556`, `:1789`, `:1872`) | Hold `InstanceRunner`; construct a `StructuredInstance` when the instance opts in; reuse crash/backoff event wiring (`:988`, `:1106`). | medium |
| `src/fleet-manager.ts` (`startInstance` `:5916`) | Pass-through; reject pane-only operations (attach, raw keys, pane capture) for structured instances with a clear error. | medium (many touch points, each small) |
| `src/backend/types.ts` (`CliBackend`, `:550`) | **Not extended.** Structured launch profiles are a separate small type (binary, args, env, protocol, version gate). `CliBackend` stays pane-shaped so tmux mode is untouched. | small |
| New `src/structured/` | `StructuredInstance`, `AcpClient`, drivers, profiles (one file per CLI), fakes for tests. | the bulk |
| `src/log-service.ts`, `src/log-steps.ts` | A second `LogSource` kind: "runner" (push) alongside "transcript file" (pull). `LogStep` is the shared shape. | small–medium |
| `src/web-api.ts` (`:1982`, `:2015`) | `/ui/steps` and `/ui/send` route to the runner. Permission buttons need a request/answer endpoint following the existing prompt/card pattern. Poll answers must include anything stream-only (#1386, #1500). | medium |
| `src/delivery-outbox.ts` (`:562`) | Unchanged contract; one new "consumed" source. | small |
| `src/daemon.ts` | **No change** other than satisfying `InstanceRunner`. | none |
| `src/web-terminal.ts`, login flow | Unchanged (§4, Login). | none |
| UI (`src/ui/`) | Hide pane/attach affordances for structured instances; permission buttons; mode marker. | medium |
| Docs, `changes/` fragments, i18n | Per repository rules. | small |

### 5.5 Relationship to the #3648 timeline

#3648 builds the chat timeline from transcripts, parsed into `LogStep`s (`src/log-steps.ts:24`). Structured mode is a **second producer** of the same `LogStep`s, not a second UI. This is the main reason the mode is cheap to adopt for the chat: the front end does not change. Differences to handle: thought text arrives incrementally (chunks must be coalesced into one step and finalised on the next non-thought update), and a step can be updated after it first appears (`tool_call_update`), which the existing step ids (stable per content) must tolerate.

## 6. MCP identity (#1411)

Today every backend has its own way of injecting the per-instance `agend` MCP server, and several are fragile because the CLI, not AgEnD, spawns the MCP child:

- Claude: a per-instance `--mcp-config` file (`src/backend/claude-code.ts:1141`).
- grok: an identity-free project shim plus launch environment, to stop same-cwd instances seeing each other's identity (`src/backend/grok-mcp.ts:101`; evidence in `docs/evidence/grok-mcp-1411/README.md`), and `--no-leader` so each agent owns its MCP children (`src/backend/grok.ts:376`).
- agy: a global MCP config the CLI process environment is inherited into, hence an owner-only wrapper script (`src/backend/antigravity.ts:217`).
- Codex, Kiro, OpenCode, Muse: files or wrapper scripts of their own (`src/backend/codex.ts:810`, `src/backend/kiro.ts:1856`, `src/backend/opencode.ts:99`).

In structured mode the declaration is part of the session: **`session/new` and `session/load` take an `mcpServers` array for that session** [S]. A stdio entry is `{ name, command (absolute path), args, env: [{ name, value }] }` and is required of every agent [S]; `http` and `sse` entries need the matching `mcpCapabilities` [S]. Consequences:

- **Identity isolation is by construction.** Each instance is its own process with its own `session/new` call; nothing is discovered from a shared project file or inherited from a first caller. The shim/wrapper machinery is not needed in this mode.
- **stdio is the portable choice.** grok advertises `mcpCapabilities` `http` and `sse` [V], but agy advertises **no** `mcpCapabilities` [V], so only the stdio form can be assumed for it. The `agend` MCP entry should therefore be stdio everywhere, as it is today.
- **Residual leak to check [U]:** whether a CLI *also* loads its user/global MCP configuration in addition to the `mcpServers` it was given. #1411's evidence says grok has no exclusive-configuration switch (`docs/evidence/grok-mcp-1411/README.md`, "Migration and limits"). In ACP mode that only matters for the user's own servers, not for AgEnD identity, but it must be stated in the profile for each CLI.
- Claude and Codex are different: Claude takes `--mcp-config` + `--strict-mcp-config` [V], which is exclusive and per-process. Codex's `app-server` takes configuration through its `-c key=value` overrides [V help] and per-thread settings [U].

Environment is also per-process in this mode: the runner builds the child's environment explicitly and does not inherit AgEnD's secrets by default (§7).

## 7. Security

### 7.1 Permissions: default and policy

- **Default to asking, not approving.** In tmux mode the fleet launches with the CLI's skip-permissions switch unless configured otherwise (`src/backend/types.ts:114`, `skipPermissions`). In structured mode, permission requests are first-class, so the default policy for a *new* structured instance should be **ask** (forward to the operator), with the existing `skipPermissions` setting mapped to an **auto-approve-once** policy for those who want the old behaviour. This is a deliberate change of default and is called out in §9.
- **Policy lives in AgEnD, not the CLI.** The runner answers `session/request_permission` from a policy table (tool `kind` and path/command class → allow / ask / reject). `allow_always` and `reject_always` options are **never** chosen automatically; they change CLI-side state AgEnD cannot see.
- **Timeouts fail closed.** An unanswered request is answered with the cancelled outcome [S] when the turn is cancelled or the instance stops, never with an allow.
- **Who can answer.** Only users who can act on the instance today (admins, and the same authority checks the dashboard already uses; `src/dashboard-permissions.ts`, `src/slash-authz.ts`). A guest or public-link viewer never answers a permission request, and sees at most a "waiting for approval" state.
- **Structured, not parsed.** Because the tool call arrives as data, buttons can show the real command/path instead of a screen capture, and the existing redaction (`src/tool-progress.ts:26`, `src/log-steps.ts:120`) applies before anything is shown.

### 7.2 Thinking is admin-only

Thought text is the most sensitive stream: it can quote secrets the model read, and it was not written for a reader. Same rule as the chat timeline: **thought chunks are delivered only to admins**, are not persisted unless the timeline persistence rule already does so, and are never sent to Telegram/Discord or to guest or public-link views. Tool inputs and outputs go through the existing masking/bounding (`src/log-steps.ts:56`–`:154`).

### 7.3 Paths and file access

ACP lets a client advertise `fs/read_text_file`, `fs/write_text_file` and `terminal/*` [S]. **AgEnD advertises none of them.** The CLI does its own file and process work in its own sandbox/cwd, exactly as in tmux mode, and AgEnD never becomes a file broker for the agent. This keeps the blast radius equal to today's and avoids building an authorization layer for a capability nobody needs here.

Other rules:

- `session/new`/`session/load` take an **absolute `cwd`** [S]; it is the instance's working directory, validated by the same code that validates it today.
- Locations/paths in tool-call updates are display metadata only [S] and are never used to read files by the daemon. If the timeline wants to show a file, it uses the existing bounded, path-validated readers.
- Child process: spawned without a shell, with an explicit argument array and an explicit environment (no inheritance of fleet tokens), `stdio` pipes only, one process per instance, killed on stop. Any CLI-specific socket/IPC path is derived by AgEnD from the instance directory, never from request content (the existing short-path/UUID validation pattern, e.g. `src/backend/grok.ts:401`).
- Frames from the child are untrusted input: bounded line length, bounded outstanding requests, JSON-RPC ids validated, unknown methods answered with `-32601`, unknown notifications ignored.

## 8. Phasing

| Phase | Scope | Acceptance | Estimate |
|---|---|---|---|
| **0. Interface only** | `InstanceRunner` extracted from the call sites; `Daemon` satisfies it; no behaviour change. | All existing tests pass unchanged; a mutation check shows the interface is what the fleet actually uses. Reviewable and revertible on its own. | 2–4 days |
| **1. grok + agy (ACP)** | `StructuredInstance` + `AcpClient`; launch profiles for grok and agy; `mock` fake; chat timeline and Log tab fed live; permission buttons; cancel; resume; crash/respawn; one opt-in config field. | (a) Protocol-level tests against recorded, redacted fixtures **and** the in-tree fake, including: out-of-order updates, partial JSON lines, child exit mid-turn, cancel with a pending permission. (b) A scripted real-CLI smoke run: handshake, one short prompt, one cancelled prompt, one resume, one restart. Needs a person to run it with real credentials and accept the small quota use. (c) tmux-mode instances are byte-for-byte unaffected (existing suites). (d) Version gate: an unknown `agentVersion` is refused with a clear message unless the profile lists it. | **2–3 weeks** |
| **2. kiro + opencode (ACP)** | Verify first (§9); then a profile each. | The same acceptance as phase 1 for each CLI, preceded by a one-day verification spike per CLI that fills in every [U] in §3. If a CLI turns out not to speak ACP usefully, it is dropped from this phase, not forced. | 1–2 weeks each |
| **3. claude + codex (native)** | `ClaudeStreamDriver` and `CodexAppServerDriver`, behind the same `RunnerEvent`s; Codex `steer` exposed through the capability gate. | Fixtures generated from the CLI's own schema where it offers one (Codex: `generate-json-schema`, [V]); real-CLI smoke runs; explicit handling of the "experimental" flag. | 1–2 weeks each |

Phase 0 is the only phase that touches shared code paths in a way existing users could notice, which is why it is separated and why it is the first thing to be reviewed if the maintainers agree with the direction. Each phase is a separate PR and is opt-in at runtime; none of them changes defaults.

## 9. Risks and open questions

### 9.1 Things this document could not verify

The following are all [U] in §3/§4 and must be confirmed before building the phase that depends on them. None requires more than a short, supervised real run:

1. That grok and agy emit `agent_thought_chunk`, `tool_call`/`tool_call_update` and `usage_update` live during a real turn, and the exact field shapes.
2. Whether grok/agy answer `session/cancel` promptly, and what they do with pending permission requests.
3. Kiro CLI and OpenCode: whether an ACP entry point exists, its flags, and its `initialize` result.
4. Claude `stream-json`: thinking deltas with `--include-partial-messages`, the permission-prompt tool contract, interrupt, and whether a long-lived `-p` process keeps one conversation across user messages.
5. Codex `app-server`: approval flow, steering during a tool call, and the stability of an "[experimental]" protocol (the schema can be regenerated per version, which helps).
6. Whether each CLI loads its own user-level MCP servers in addition to the session's `mcpServers` (§6).
7. What a CLI does when `session/load` is given an id from a TUI session (do conversations created in tmux mode resume in structured mode, and the reverse?). This decides whether switching modes keeps the conversation.

### 9.2 Risks

- **Version drift.** CLIs change fast and the protocol fields they emit vary by version (grok's `initialize` carries many `x.ai/*` extension fields [V]). Mitigation: a per-CLI profile with a **version gate** and a redacted fixture per supported version; an unrecognised version fails loudly rather than guessing.
- **Signals ACP does not give.** Context % and quota hints may be partial (§4). Where a feature has no structured source, it is shown as unavailable for that CLI instead of approximated from output.
- **Hang semantics change.** "No `session/update` for N seconds" is a different, arguably better, but different signal from "pane unchanged" (§4). Thresholds need re-tuning, not copying.
- **Support burden.** Two modes double the matrix. Mitigation: the `InstanceRunner` seam keeps the matrix small, and the fakes keep the daemon-side tests independent of real CLIs.
- **Loss of the pane.** The mode removes AgEnD's most distinctive affordance for those instances. The opt-in rule and §2.2 are the mitigation; a maintainer may reasonably decide the trade is not worth it for a given CLI.
- **Default permission change** (§7.1). A structured instance that asks by default is a different experience from the always-approve default today. This needs an explicit maintainer decision.

### 9.3 Relationship to Step 1 (grok per-instance leader spike)

Step 1 keeps the TUI and adds a **read-only ACP observer** attached to a per-instance grok leader. Structured mode **does not depend on it, and it does not depend on structured mode**:

- They solve different problems. Step 1 is "keep the pane **and** get live thought text, for grok only". Structured mode is "drop the pane for any CLI with a structured protocol".
- They share the **ACP client code**: the observer needs the framing, `initialize`, `session/load` and `session/update` decoding that `AcpClient` needs. If Step 1 lands first, `AcpClient` should be extracted from it, not rewritten; the observer's read-only rule (never send prompts, cancels or keys; never become the "last active client" for permission routing) is a *restriction on a client*, which the full client can honour by construction.
- They differ on identity: Step 1 must use **one leader per instance** (and a short socket path) to keep MCP identity isolated; structured mode with `--no-leader` and a per-process `session/new` needs no leader at all.
- If both exist, a grok instance would be either tmux + observer, or structured, never both at once. If Step 1 shows the TUI can join a per-instance leader cleanly, it is the lower-cost route for grok *only* and structured mode's grok phase may be reduced to "for users who want no TUI at all".

### 9.4 Questions for the maintainers

1. Is an opt-in structured mode acceptable in principle, given #739's earlier decision? (Same question as in #3731; this document is the detail behind it.)
2. **Naming.** `runtime: acp` collides with `runtime: wsl | windows`. Preferred spelling? Proposal: `execution: tmux | structured`.
3. Should phase 0 (the `InstanceRunner` interface) be proposed on its own first, since it is behaviour-neutral and useful regardless?
4. **Default permission policy** for a new structured instance: ask (proposed) or inherit today's always-approve?
5. Is Codex via its own `app-server` (rather than an ACP adapter) acceptable, accepting the "experimental" label for the sake of `turn/steer` and quota/usage events?
6. Where should the mode be selectable (create form only, or editable later)? Editing implies the conversation-continuity question in §9.1 (7).
7. Is a recorded-fixture + fake-CLI test strategy (no real CLI in CI) acceptable, with real-CLI smoke runs left to a manual step?

## Appendix A. Handshake evidence

Collected with a throwaway client that sent only `initialize` (protocol version 1, no client capabilities beyond "none") and then closed stdin. No `session/new`, no `session/prompt`, no authentication call, no model request.

**grok 1.0.77** (`grok --no-auto-update agent --no-leader stdio`), `initialize` result, abridged:

- `protocolVersion: 1`
- `agentCapabilities`: `loadSession: true`; `promptCapabilities` `{image: true, audio: false, embeddedContext: true}`; `mcpCapabilities` `{http: true, sse: true}`; `sessionCapabilities` `{list, resume, close}`; `auth: {}`.
- `authMethods`: `cached_token` (cached token from the CLI's own auth file), `grok.com`.
- `_meta`: `agentVersion`, `currentWorkingDirectory`, `modelState` (current model, available models, each with `totalContextTokens` and reasoning-effort options), `availableCommands` (e.g. `compact`, `always-approve`, `context`, `session-info`), several `x.ai/*` extension fields.
- Followed by two unsolicited notifications (`_x.ai/mcp/servers_updated`, `_x.ai/announcements/update`), i.e. the client must tolerate unknown `_`-prefixed methods.

**agy 1.5.6** (`agy acp`), `initialize` result, abridged:

- `protocolVersion: 1`; `agentInfo` `{name: "Antigravity ACP Server", version: "1.5.6"}`.
- `agentCapabilities`: `loadSession: true`; `promptCapabilities` `{image: true, audio: false, embeddedContext: true}`; `sessionCapabilities` `{resume, close, load, list, additionalDirectories}`; `auth: {logout: {}}`; **no `mcpCapabilities`**; `_meta.antigravity` `{tier, systemPrompt: {append}}`. (It repeats some capability keys in both camelCase and snake_case.)
- `authMethods`: `oauth-personal`, `oauth-business`, `gemini-api-key`, `agent-platform`.

**Codex 0.167.2**: `codex app-server generate-json-schema --out <dir>` ran offline and produced the schema set. Method and notification names listed in §3.2 were read from it. The `--remote <ADDR>` option on the `codex` TUI (connect the TUI to a remote app server) appears in `codex --help` [V]; whether a TUI and a second client can share one thread was **not** tested.

**Claude Code 2.1.322**: `claude --help` lists `--output-format`, `--input-format`, `--include-partial-messages`, `--permission-prompt-tool`, `--mcp-config`, `--strict-mcp-config`, `--resume`, `--session-id`; there is no ACP subcommand.

## Appendix B. ACP surface this design uses [S]

- Agent methods: `initialize`, `authenticate`, `session/new`, `session/load` (replays history), `session/resume` (no replay), `session/prompt`, `session/list`, `session/close`, `session/set_mode`, `session/set_config_option`; notification `session/cancel`.
- Client methods AgEnD would implement: `session/request_permission` only. `fs/*` and `terminal/*` are not advertised (§7.3).
- `session/update` kinds read: `agent_message_chunk`, `agent_thought_chunk`, `user_message_chunk`, `tool_call`, `tool_call_update`, `plan`, `usage_update`, `available_commands_update`, `current_mode_update`, `config_option_update`, `session_info_update`. Others are ignored.
- Tool call fields: `toolCallId`, `title`, `kind` (`read`, `edit`, `delete`, `move`, `search`, `execute`, `think`, `fetch`, `switch_mode`, `other`), `status` (`pending`, `in_progress`, `completed`, `failed`), `content`, `locations`, `rawInput`, `rawOutput`.
- Stop reasons: `end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, `cancelled`.
- Permission options: `allow_once`, `allow_always`, `reject_once`, `reject_always`; outcome `selected{optionId}` or `cancelled`.
