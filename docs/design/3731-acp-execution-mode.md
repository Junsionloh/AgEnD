# #3731: per-instance CLI adapters: tmux (default), official ACP, and native protocols

Status: **draft design for review after 2.5. Nothing here is implemented.** No code change accompanies this document.
Direction (maintainer): **official ACP first, otherwise a native adapter.** One adapter per instance; `tmux` stays the default adapter.
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

- **Adapter**: the piece that runs one CLI for one instance and exposes the same interface to the rest of the fleet (§5). Every instance selects exactly one adapter. The **`tmux` adapter** is today's behaviour and the default.
- **tmux mode**: the `tmux` adapter. The CLI is a TUI in a tmux window, and `Daemon` (`src/daemon.ts:1401`) observes and drives it through the pane.
- **Structured mode / structured adapter**: any adapter other than `tmux`. The daemon owns the CLI process and talks to it over stdio with a structured protocol. The CLI's terminal UI is never started and never parsed.
- **ACP**: the Agent Client Protocol, JSON-RPC 2.0 over stdio between a *client* (here, AgEnD) and an *agent* (the CLI).
- **Official ACP**: an ACP entry point shipped by the CLI's own vendor, inside the CLI itself (for example a subcommand of the CLI binary). A separate third-party program that wraps a CLI or an SDK and speaks ACP is **not** official ACP.

## 1. Summary

**Per the maintainer's direction: official ACP first, otherwise a native adapter.**

1. Each instance selects **one adapter**, one per CLI protocol family. The adapters are `tmux` (today's behaviour, the default), `acp` (one shared adapter for every CLI with official ACP), `claude-stream-json` and `codex-app-server`. An instance that does not select a structured adapter behaves exactly as today. Nothing replaces tmux.
2. **Selection rule (§3):** if the CLI ships official ACP, use the `acp` adapter. If it does not, keep one adapter that uses the CLI's own native protocol. Third-party ACP wrappers are not used. The TUI is never parsed in a structured adapter.
3. By that rule: grok and agy have official ACP **[V]** and use `acp`. Claude Code and Codex have none **[V]** and use their native protocols (`claude -p` with `stream-json`, and `codex app-server`). Kiro and OpenCode are expected to have official ACP but this is **not verified** **[U]**. Muse has no known structured protocol and stays on `tmux`.
4. The structured adapters are implemented as **new execution classes beside `Daemon`**, not as a fake `Pane`. `Daemon` assumes a pane in well over a thousand places (§5.1). The adapter interface (§5.3) makes the choice visible in one place, and `tmux` becomes its first implementation, with no behaviour change.
5. What is lost is real: **no pane view and no `agend attach`** for instances on a structured adapter. §2.2 says what replaces the pane view in the web chat, and what has no replacement.
6. Phasing (§8): extract the adapter interface and wrap `tmux` as the first adapter; then `acp` for grok + agy; then Kiro + OpenCode; then the Claude and Codex adapters. About 2–3 weeks for the first protocol phase and 1–2 weeks per additional adapter, as estimated in #3731. No phase merges before the maintainers decide, after 2.5.

## 2. Positioning

### 2.1 What the setting is

A new per-instance setting selects the adapter. The recommended spelling is **`cli_adapter: tmux | acp | claude-stream-json | codex-app-server`**; absent means `tmux`. §9.3 gives the reasons. In short: the key must not be `runtime` (already *execution host*, `wsl` | `windows`; `alpha:src/types.ts:106`) and should not be a bare `adapter` (that word already means the *channel* adapter in this code base: `ChannelAdapter`, `src/channel/types.ts:78`; `channel_id`, `src/types.ts:145`; and on the alpha line `native_adapter` is a Windows-only setting, `alpha:src/types.ts:112`).

Only some adapter values are valid for a given `backend`. The validator (`src/config-validator.ts`) holds one table and rejects a pair the table does not list, for example `backend: claude-code` with `cli_adapter: acp`:

| `backend` | Allowed `cli_adapter` values |
|---|---|
| `grok`, `antigravity` | `tmux`, `acp` |
| `kiro-cli`, `opencode` | `tmux`, and `acp` once verified (§3.2) |
| `claude-code` | `tmux`, `claude-stream-json` |
| `codex` | `tmux`, `codex-app-server` |
| `muse` | `tmux` |
| `mock` | `tmux`, and the test fakes (§5.3) |

The adapter is chosen **when the instance is created or edited**, like `backend` is. It is not a global switch and there is no automatic fallback between adapters: an instance whose structured adapter fails fails visibly and is not silently relaunched in a TUI (that would change what the user's agent is, mid-conversation).

### 2.2 What is lost, and what replaces it

| On the `tmux` adapter (today) | On a structured adapter (`acp`, `claude-stream-json`, `codex-app-server`) |
|---|---|
| Live pane view in the web terminal / dashboard (`src/web-terminal.ts`, `src/tmux-manager.ts:99`) | **Not available.** There is no screen. Replaced by the chat timeline and the Log tab (below). |
| `agend attach` and `agend ls` showing a window | **Not available.** `ls` shows the instance with a "structured" marker and no window. |
| Typing into the CLI by hand in the pane | **Not available.** The operator sends through chat, the same way every other user does. A future "send raw prompt" admin action is possible, but is not a keyboard. |
| Seeing a dialog the CLI is showing | Replaced by structured permission requests (§4, "Dialogs and permissions"), shown as buttons in web chat and Telegram. |
| Seeing "what is it doing right now" | **Better than today:** thought chunks, tool starts/updates/ends and plans arrive as they happen, and feed the same timeline #3648 builds from transcripts (§5.6). |

Where a person needs the real TUI (first login, debugging a CLI bug, trying a CLI feature that only exists in its UI), they use tmux mode on that instance, or on a second instance. Switching an instance between adapters starts a new execution; whether the conversation carries over depends on the CLI's session storage (§4, "Session id").

### 2.3 Non-goals

- Not a replacement for tmux mode, and not a deprecation path for it.
- Not a general ACP agent host. AgEnD is the ACP *client*; this document does not make AgEnD an ACP *agent* for editors.
- Not Windows-specific. The Windows per-turn adapter is a precedent (§5.2), not a target.

## 3. Adapter selection and per-CLI routes

### 3.1 Rule

For each backend, in order:

1. The CLI ships **official ACP** → its adapter is `acp`.
2. Otherwise → the backend keeps **one adapter that uses the CLI's own native structured protocol** (today: `claude-stream-json`, `codex-app-server`).
3. Otherwise (no official ACP and no native structured protocol known) → the backend has no structured adapter and stays on `tmux`. There is no "TUI fallback inside a structured adapter".

This replaces an earlier draft of this document, which let the richer of two protocols win. The rule is now about *who provides the interface*, not which one is richer: a CLI's official ACP is used even where a native protocol has more features, and a native adapter exists only where there is no official ACP. Consequences:

- **Third-party ACP wrappers are not used.** A wrapper built on a different stack (for example on an SDK rather than on the CLI binary) is a different program with its own login, billing and behaviour surface, not the CLI. Claude Code and Codex therefore use native adapters.
- **Native-only extras stay native-only.** Codex's `turn/steer` has no ACP equivalent [S], and Codex has no official ACP, so steering is a feature of the `codex-app-server` adapter only (§4).
- **The rule is re-applied when a CLI changes.** If Claude Code or Codex later ship official ACP, the right outcome is a new adapter value and a profile (opt-in, per instance), not a silent switch of existing instances. "Official" is judged by what the CLI's own `--help` and `initialize` show, as in §3.2.

### 3.2 Routes

Versions are the ones present where this was written: grok 1.0.77, agy 1.5.6, Claude Code 2.1.322, Codex 0.167.2. Kiro CLI, OpenCode and Muse were **not installed**, so everything about them is [U].

| Backend (`src/backend/factory.ts:12`) | Official ACP? | Adapter (`cli_adapter`) | Launch (structured) | Evidence |
|---|---|---|---|---|
| **grok** | **Yes [V]** (`grok agent stdio`) | `acp` | `grok --no-auto-update agent --no-leader [--always-approve] [--model …] [--reasoning-effort …] stdio` | `initialize` handshake **[V]**; `agent` subcommands `stdio`, `headless`, `serve`, `leader` **[V]**; `--always-approve`, `--reasoning-effort` on `agent` **[V]**. Live `agent_thought_chunk` emission **[U]** (needs a real turn). |
| **agy** (`antigravity`) | **Yes [V]** (`agy acp`, "Start the Agent Client Protocol (ACP) stdio server") | `acp` | `agy acp` (flags such as `--dangerously-skip-permissions` stay launch args or a mode, to be settled in phase 1) | `initialize` handshake **[V]** (`agentInfo` "Antigravity ACP Server" 1.5.6). agy also has a print mode with `--input-format stream-json --output-format stream-json` **[V]**; under the rule it is **not** selected, because official ACP exists. Live thought chunks **[U]**. |
| **kiro-cli** | Expected yes **[U]** | `acp` if verified. If it turns out not to exist, a native adapter for Kiro's own mechanism has to be designed, or Kiro stays on `tmux`. | `kiro-cli acp` (name and flags to be confirmed) | **[U]** entirely: the binary was not available. Listed in the public ACP agent registry per the issue text. Today's backend is `kiro-cli chat` (`src/backend/kiro.ts:1691`) with a large Kiro-specific layer (`src/kiro-*.ts`). |
| **opencode** | Expected yes **[U]** | `acp` if verified; same fallback as Kiro | `opencode acp` (to be confirmed) | **[U]** entirely, same reason. Today: a bare TUI, config via `OPENCODE_CONFIG` (`src/backend/opencode.ts:50`). |
| **claude-code** | **No [V]** (no ACP entry point in `claude --help`) | `claude-stream-json` | `claude -p --input-format stream-json --output-format stream-json --include-partial-messages --permission-prompt-tool <mcp tool> --mcp-config <file> --strict-mcp-config [--resume <id>\|--session-id <uuid>]` | All of these flags appear in `--help` **[V]**. That partial messages include thinking deltas, that `--permission-prompt-tool` routes every permission request, and the exact event shapes: **[U]** until a turn is run. |
| **codex** | **No [V]** (no ACP entry point) | `codex-app-server` | `codex app-server` (JSON-RPC over stdio, labelled "[experimental]") | `codex app-server generate-json-schema` works offline **[V]** and the schema contains: `thread/start`, `thread/resume`, `thread/fork`, `turn/start`, **`turn/steer`**, `turn/interrupt`, `item/reasoning/textDelta`, `item/reasoning/summaryTextDelta`, `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `thread/tokenUsage/updated`, `account/rateLimits/updated` **[V]**. The "[experimental]" label **[V]** drives the version-gate requirement (§9). |
| **muse** | Unknown **[U]** | `tmux` only | stays tmux | **[U]**: not installed, no protocol known. Today's steering is a TUI feature (`src/steer-capability.ts:5`). Revisit if Muse publishes a protocol. |
| **mock** | n/a | `tmux`, and in-tree fakes of the `acp`, `claude-stream-json` and `codex-app-server` wire formats | an in-process fake | Needed in the first protocol phase so the daemon-side machinery is testable without a real CLI (§8). |

Claude Code's official-ACP answer is based on the absence of an ACP entry point in `--help` of the installed version. It should be re-checked whenever the version gate for a new Claude Code release is updated.

## 4. Feature parity: what each pane-derived feature becomes, per adapter

Legend: **Replaced** = a structured signal exists and is named. **Partial** = exists, but incomplete or needs a per-CLI check. **Unsupported** = no replacement; the feature is hidden for instances on that adapter. **Kept** = does not depend on the pane and is unchanged. Evidence labels as in §0.

The `acp` column describes the protocol [S] and the two CLIs that ship it [V]: grok and agy. Items that depend on a real turn are [U]. The `claude-stream-json` column is mostly [U], because only `--help` could be checked. The `codex-app-server` column is mostly [V], because the schema could be generated offline.

| Feature | `tmux` (today) | `acp` (grok, agy) | `claude-stream-json` | `codex-app-server` |
|---|---|---|---|---|
| **Idle / busy** | Pane scraped on a timer by a state machine (`src/daemon.ts:342`, `:487`, `:7008`, `:7338`), with backend ready/busy patterns (`src/backend/types.ts:849`, `:870`). | **Replaced.** Busy = a `session/prompt` request is outstanding; idle = its response arrived with a `stopReason` [S]. | **Replaced** [U]. Busy until the turn's final `result` event. | **Replaced** [V names]. `turn/start` until the turn-completed notification. |
| **Hang / stuck** | The same state machine emits `hang` when the pane stops changing (`src/hang-detector.ts:1`, `src/daemon.ts:7434`); lifecycle surfaces it (`src/instance-lifecycle.ts:988`). | **Replaced**, different semantics. An outstanding turn with **no `session/update` for N seconds** (N from the existing `hang_detector` config). A running tool reports `in_progress`, and a spinner redraw can no longer mask a stall; but a long silent model call looks like a stall. | Same rule on the event stream [U]. | Same rule on notifications [U]. |
| **Dialogs and permissions** | Runtime/startup dialogs matched on screen text and answered with keys (`src/backend/types.ts:903`, `:916`; `src/daemon.ts:8416`, `:5088`). | **Replaced.** `session/request_permission` with the tool call and options `allow_once` / `allow_always` / `reject_once` / `reject_always` [S]. | **Replaced** [U]. Via `--permission-prompt-tool` (an MCP tool that receives each request); the exact contract is unverified. | **Replaced** [V names]. `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`. |
| **Steer** (add input to a running turn) | Keys/paste into the composer while busy (`src/daemon.ts:7830`, `:9304`), gated per backend (`src/steer-capability.ts:5`). | **Unsupported (queues).** No mid-turn input is defined [S]. A message sent during a turn waits for it to end, which is today's "queued input" behaviour, not steering. | **Partial** [U]. A further `stream-json` user message mid-turn is possible in principle; its effect is unverified. | **Replaced** [V]. `turn/steer`. |
| **Cancel** | Send the backend's cancel key into the pane (`src/daemon.ts:4856`; grok `C-c`, `src/backend/grok.ts:666`; agy `Escape`, `src/backend/antigravity.ts:508`). | **Replaced.** `session/cancel`; the prompt response returns `cancelled`. The client answers pending permission requests with the `cancelled` outcome and marks unfinished tool calls cancelled [S]. | **Replaced** [U]. An interrupt control message or process signal; to be verified. | **Replaced** [V]. `turn/interrupt`. |
| **Context %** | Backend-specific: statusline file for Claude (`src/context-guardian.ts`, `src/daemon.ts:3265`), pane footers for others (`src/backend/grok.ts:583`, `src/backend/types.ts:834`). | **Partial.** The spec lists a `usage_update` session update [S]; whether grok and agy emit it is **[U]**. grok's `initialize` carries per-model `totalContextTokens` [V], which gives the window size but not the usage. | **Partial** [U]. Usage fields in the `result` event. | **Replaced** [V]. `thread/tokenUsage/updated`. |
| **Quota / rate-limit notices** | Regex error patterns over the pane (`src/backend/types.ts:162`, `:897`; `src/daemon.ts:2119`, `:4309`). | **Partial.** Errors come back as JSON-RPC errors or `stopReason` `refusal` / `max_tokens` [S]; whether quota wording appears in them is CLI-specific **[U]**. | **Partial** [U]. API errors in the stream. | **Replaced** [V]. `account/rateLimits/updated`. |
| **Session id / resume** | Per-backend: file scans, footers, transcripts; persisted as `session-id` (`src/daemon.ts:13730`–`:13768`, `src/backend/grok.ts:401`). | **Replaced.** `session/new` returns the id; `session/load` (replays history; responds after the replay) or `session/resume` (no replay) [S]. grok: `loadSession` + `list`/`resume`/`close` [V]. agy: `loadSession` + `list`/`load`/`resume`/`close`/`additionalDirectories` [V]. | **Replaced.** `--resume <id>` / `--session-id <uuid>` [V]. | **Replaced** [V names]. `thread/start`, `thread/resume`, `thread/fork`. |
| **Login / sign-in** | Web sign-in runs the CLI's login command in a pane and scrapes the URL/code (`src/web-backend-login.ts:33`, `:137`; `src/structured-signin.ts:12`; `src/web-terminal.ts:40`). | **Kept.** `initialize` returns `authMethods` and `authenticate` takes a `methodId` [S]; seen: grok `cached_token`, `grok.com` [V]; agy `oauth-personal`, `oauth-business`, `gemini-api-key`, `agent-platform` [V]. Browser-based methods still need a human and a URL, so the existing web login (the CLI's own login command in a terminal pane, independent of the adapter) is unchanged. The adapter only needs "authenticated or not" (`auth_required`, -32000 [S]). | **Kept.** Same: the existing login flow; the adapter reports "not signed in" from the process's error. | **Kept.** Same. |
| **Delivery proof** ("was the message consumed?") | Pane + transcript marker checks and a consumed watcher (`src/daemon.ts:8142`, `src/delivery-consumed-watch.ts:79`, `src/delivery-reconciliation.ts:61`). | **Replaced.** The accepted `session/prompt` and its `user_message_chunk` echo / response. The outbox contract (`src/delivery-outbox.ts:562`) is unchanged: one "consumed" callback per attempt. "Typed into the wrong composer" failures disappear. | **Replaced** [U]. The user message is written to the process's stdin and echoed in the stream. | **Replaced** [V names]. `turn/start` accepted / item events. |
| **Crash / respawn** | tmux window death detected via pane liveness, then backoff respawn (`src/daemon.ts:3825`, `:4018`, `:4124`, `:8804`). | **Replaced.** Child process exit / stdio EOF; the same backoff and `crash_loop` events (`src/instance-lifecycle.ts:1106`); on respawn `session/load`/`resume` with the stored id. | **Replaced.** Same; respawn with `--resume`. | **Replaced.** Same; respawn then `thread/resume`. |
| **Reply tool / MCP calls** | The CLI calls the `agend` MCP server, which reports over the daemon IPC (`src/daemon.ts:3089`, `:6860`). | **Kept.** MCP is a separate channel from the pane. Only how the MCP server is *declared to the CLI* changes (§6). | **Kept** (declared with `--mcp-config`). | **Kept** (declared in the thread/config settings [U]). |
| **Chat activity / Log tab** | Transcript parsers: `TranscriptMonitor` (`src/transcript-monitor.ts:25`), `LogStep` parsers (`src/log-steps.ts:24`, `:365`, `:452`), served by `src/log-service.ts` and `GET /ui/steps` (`src/web-api.ts:1982`). | **Replaced, better.** `LogStep`s directly from `session/update` (`agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`) [S]; thinking arrives live instead of after the block ends. | **Replaced** [U]. From stream events; live thinking depends on partial messages carrying thinking deltas. | **Replaced, better** [V names]. `item/*` events including `item/reasoning/textDelta`. |
| **Pane view, attach, raw typing** | See §2.2. | **Unsupported** | **Unsupported** | **Unsupported** |
| **Startup banner / trust / update dialogs** | Startup dialog handlers and `--no-auto-update` flags (`src/backend/types.ts:916`, `src/backend/grok.ts:376`). | **Not needed.** No TUI. The CLI's own auto-update is still disabled by flag where it exists. | **Not needed** | **Not needed** |
| **Context rotation / compaction** | CLIs auto-compact; AgEnD only observes (`src/context-guardian.ts:1`). | **Kept.** ACP defines `compaction_update` behind a client capability [S]; optional. | **Kept** | **Kept** |
| **Effort / model selection** | Launch flags (`src/backend/grok.ts:394`, `src/backend/antigravity.ts:230`). | **Replaced.** Launch flags [V for grok `--reasoning-effort`], or `session/set_config_option` and the model state in `initialize` [S/V]. | **Replaced** [V `--help`]. Launch flags. | **Replaced** [U]. Per-thread/turn settings. |

## 5. Architecture: switching adapters

### 5.1 Why parallel classes, not a pane substitute

`Daemon` is 14,143 lines (`src/daemon.ts`), and about 1,400 lines mention `tmux`/`pane` (counted with `grep -c "tmux\|Pane\|pane"`); #3731 estimated "roughly 280" *call sites*, and the two numbers measure different things (all mentions vs. places that read or write a pane). Either way the assumption is pervasive: state machine, delivery, dialogs, hang, cancel, quota. A fake `Pane` that returned empty screens would make every pattern matcher silently report "idle, nothing wrong". The honest shape is separate classes that implement only what the rest of the fleet needs from an instance.

### 5.2 Precedent: the Windows per-turn adapter

The closest existing precedent is the Windows runtime's `native_adapter: "exec"` path, which runs one process per turn without a pane. **It lives on the alpha line, not `main`.**

- Config: `native_adapter?: "exec" | "pane"` (`alpha:src/types.ts:112`), validated in `alpha:src/config-validator.ts:663`.
- Dispatch: a single predicate `isNativeExecInstance(config)` (`alpha:src/native-instance-registry.ts:25`) is the fork. `FleetManager` branches on it at many sites (e.g. `alpha:src/fleet-manager.ts:1502`, `:2483`, `:2554`, `:4896`, `:5136`), and returns early or delegates to `FleetWindowsRuntime` (`alpha:src/fleet-windows-runtime.ts:52`) instead of going through a `Daemon`.
- Contract: `FleetWindowsRuntime` takes a small `host` interface (`alpha:src/fleet-windows-runtime.ts:20`) rather than the whole `FleetManager`.

Lessons to take, and one to avoid:

- **Take:** a separate runtime object per execution style, and a narrow host interface.
- **Take:** an explicit refusal list (the Windows path has `WINDOWS_CREATE_REFUSED`, defined in `alpha:src/native-instance-registry.ts` and used at `alpha:src/instance-lifecycle.ts:2636`) so unsupported operations (attach, raw keys) fail with a clear message.
- **Avoid:** growing the number of `if (isNative…)` branches inside `FleetManager`. The Windows path needed many. The adapter choice should be made in **one place** (§5.4) and the rest of the fleet should talk to an interface.

### 5.3 The adapter interface

```
                         instance config: cli_adapter  (absent = tmux)
                                        │
                                        ▼
        InstanceLifecycle ── selectAdapter(backend, cli_adapter) ──► one CliAdapter per instance
                                        │
        ┌───────────────────┬───────────┴───────────┬──────────────────────────┐
        ▼                   ▼                       ▼                          ▼
   TmuxAdapter          AcpAdapter          ClaudeStreamJsonAdapter     CodexAppServerAdapter
   (default; wraps      (one class; grok,   (claude-code)               (codex)
    Daemon + CliBackend; agy, kiro, opencode;
    unchanged)          a profile per CLI)
```

There are two layers, and the split is what makes the choice easy to see and cheap to add to:

- **`CliAdapter`**: what differs by CLI protocol. One instance of it per fleet instance. It is the only thing `selectAdapter` chooses.
- **`InstanceRunner`**: what is the same for every structured adapter and is written once: crash/backoff, the busy/idle state snapshot, the hang timer, the permission policy (§7), mapping adapter events to timeline `LogStep`s, and the "consumed" callback for the delivery outbox. `InstanceLifecycle` holds an `InstanceRunner` per instance (today it holds a `Daemon`: `readonly daemons = new Map<string, Daemon>()`, `src/instance-lifecycle.ts:556`, built in one place at `:1872` from `start` at `:1789`).
- **For `tmux` the two layers are the same object.** The `Daemon` already contains all of the runner logic *and* the pane logic, so the `TmuxAdapter` is a thin facade over `Daemon`, and `Daemon` satisfies the `InstanceRunner` surface directly. Phase 0 (§8) does not move any of that code.

The capabilities an adapter provides (names illustrative; the real list comes from grepping what other modules call on a daemon, in phase 0):

```ts
interface CliAdapter {
  readonly id: "tmux" | "acp" | "claude-stream-json" | "codex-app-server";
  readonly capabilities: {                     // static per adapter + profile; the UI and validator read this
    steer: boolean;                            // Codex: true. ACP: false (queues). tmux: per backend (src/steer-capability.ts:5)
    livePermissions: boolean;                  // structured permission requests (false for tmux: dialog scraping)
    liveThought: boolean;                      // thought text while the turn runs
    contextUsage: boolean; quota: boolean;     // a structured source exists
    paneView: boolean;                         // true only for tmux
  };

  // lifecycle
  start(ctx: AdapterStartContext): Promise<void>;     // spawn / open; resume by stored session id        (src/daemon.ts:2996)
  stop(): Promise<void>;                              //                                                     (src/daemon.ts:5405)
  health(): { process: "running" | "crashed" | "stopped"; lastEventAt: number | null };  // (src/daemon.ts:2027)

  // turn control
  sendPrompt(p: PromptRequest): Promise<PromptAck>;   // the delivery path                                  (src/daemon.ts:8142)
  steer?(text: string, meta: Record<string, string>): void;   // only when capabilities.steer             (src/daemon.ts:7830)
  cancel(): Promise<void>;                            //                                                     (src/daemon.ts:4856)
  answerPermission(requestId: string, decision: PermissionDecision): void;

  // observation
  events(): AsyncIterable<AdapterEvent>;              // the one stream: thought, message, tool, plan, permission, usage, quota, turn_end, auth_required
  sessionId(): string | null;                         //                                                     (src/backend/types.ts:840)
}
```

`tmux` implements `sendPrompt`, `steer`, `cancel`, `health` and `sessionId` with today's code, and implements `events()` by feeding the existing transcript monitor and pane state machine; it reports `livePermissions`, `liveThought` and `paneView` as the fixed values that describe it today. The structured adapters implement everything from protocol messages. The event vocabulary is one small union that every structured adapter translates into:

```ts
type AdapterEvent =
  | { kind: "thought"; text: string }
  | { kind: "message"; text: string }
  | { kind: "tool"; id: string; title: string; toolKind: string; status: "pending"|"in_progress"|"completed"|"failed"; rawInput?: unknown; rawOutput?: unknown }
  | { kind: "plan"; entries: unknown[] }
  | { kind: "permission"; requestId: string; tool: unknown; options: { id: string; name: string; kind: string }[] }
  | { kind: "usage"; used?: number; size?: number }
  | { kind: "quota"; window?: string; resetsAt?: number }
  | { kind: "turn_end"; stopReason: string }
  | { kind: "auth_required" };
```

What each adapter translates:

| Adapter | Wire format | Where the translation lives | What is specific to it |
|---|---|---|---|
| `acp` | JSON-RPC 2.0 over stdio, ACP [S] | one `AcpClient` plus a **profile per CLI** (binary, args, env, version gate, which optional updates the CLI emits) | `session/new`/`load`/`prompt`/`cancel`/`request_permission`; no steer; a profile for grok and one for agy, later Kiro and OpenCode |
| `claude-stream-json` | NDJSON on the process's stdin/stdout (`-p`, stream-json in and out) | `ClaudeStreamJsonAdapter` | `--permission-prompt-tool` bridge; `--resume`/`--session-id`; thinking deltas from partial messages [U] |
| `codex-app-server` | JSON-RPC over stdio, Codex's own protocol | `CodexAppServerAdapter` | `turn/steer`; `thread/tokenUsage/updated`; `account/rateLimits/updated`; types generated from `codex app-server generate-json-schema` |

The protocol difference is therefore confined to three translators, and to the capabilities each one reports. Everything above `AdapterEvent` (permissions UI, timeline, outbox, hang) is written once.

### 5.4 How the daemon picks an adapter

1. **Config.** `cli_adapter` is read from the instance (or fleet defaults), validated against the `backend` table in §2.1 by `src/config-validator.ts`. An absent value is `tmux`. A value the table does not allow is a config error, reported at load, not at launch.
2. **Selection point.** `InstanceLifecycle.start` (`src/instance-lifecycle.ts:1789`) is the only place that constructs a runner (`:1872`). It calls `selectAdapter(backendName, config)`:
   - `tmux` → today's path unchanged: `createBackend(...)` (`src/backend/factory.ts:12`) and `new Daemon(...)`.
   - anything else → an `InstanceRunner` that hosts the chosen adapter, built from that CLI's launch profile (§3.2).
3. **Registry.** `lifecycle.daemons` becomes a map of `InstanceRunner` (keeping the name for the first change to keep the diff small). Code that needs pane-only operations (attach, pane capture, raw keys, the web terminal) asks `adapter.capabilities.paneView` and refuses with a clear message when it is false, rather than testing the adapter's name.
4. **Switching.** Changing `cli_adapter` on an existing instance is a configuration change that restarts it on the new adapter, like changing `backend`. Whether the conversation carries over is §9.1 item 7. Nothing switches automatically.
5. **Failure.** A structured adapter that cannot start (version gate refuses, binary lacks the entry point) reports the reason on the instance and stays stopped. It does not fall back to `tmux`.

### 5.5 Modules that change

| Module | Change | Size |
|---|---|---|
| `src/types.ts` | New per-instance field `cli_adapter`, and its validation in `src/config-validator.ts` (the backend × adapter table). | small |
| `src/instance-lifecycle.ts` (`:556`, `:1789`, `:1872`) | `selectAdapter`; hold `InstanceRunner`; reuse crash/backoff event wiring (`:988`, `:1106`). | medium |
| `src/fleet-manager.ts` (`startInstance` `:5916`) | Pass-through; refuse pane-only operations by capability. | medium (many touch points, each small) |
| `src/backend/types.ts` (`CliBackend`, `:550`) | **Not extended.** It stays the `tmux` adapter's pane-shaped backend description. Structured launch profiles are a separate small type (binary, args, env, wire format, version gate). | small |
| New `src/adapters/` | `CliAdapter` and `InstanceRunner` types, `TmuxAdapter` facade, `AcpAdapter` + `AcpClient` + profiles, `ClaudeStreamJsonAdapter`, `CodexAppServerAdapter`, fakes for tests. | the bulk |
| `src/log-service.ts`, `src/log-steps.ts` | A second `LogSource` kind: "adapter events" (push) alongside "transcript file" (pull). `LogStep` is the shared shape. | small–medium |
| `src/web-api.ts` (`:1982`, `:2015`) | `/ui/steps` and `/ui/send` route to the runner. Permission buttons need a request/answer endpoint following the existing prompt/card pattern. Poll answers must include anything stream-only (#1386, #1500). | medium |
| `src/delivery-outbox.ts` (`:562`) | Unchanged contract; one new "consumed" source. | small |
| `src/daemon.ts` | **No change** other than satisfying the `InstanceRunner` surface. | none |
| `src/web-terminal.ts`, login flow | Unchanged (§4, Login). | none |
| UI (`src/ui/`) | Hide pane/attach affordances when `paneView` is false; permission buttons; adapter marker and an adapter selector in the create/edit form. | medium |
| Docs, `changes/` fragments, i18n | Per repository rules. | small |

### 5.6 Relationship to the #3648 timeline

#3648 builds the chat timeline from transcripts, parsed into `LogStep`s (`src/log-steps.ts:24`). A structured adapter is a **second producer** of the same `LogStep`s, not a second UI. This is the main reason the adapters are cheap to adopt for the chat: the front end does not change. Differences to handle: thought text arrives incrementally (chunks must be coalesced into one step and finalised on the next non-thought event), and a step can be updated after it first appears (`tool_call_update`, `item/*` updates), which the existing step ids (stable per content) must tolerate.

## 6. MCP identity (#1411)

Today every backend has its own way of injecting the per-instance `agend` MCP server, and several are fragile because the CLI, not AgEnD, spawns the MCP child:

- Claude: a per-instance `--mcp-config` file (`src/backend/claude-code.ts:1141`).
- grok: an identity-free project shim plus launch environment, to stop same-cwd instances seeing each other's identity (`src/backend/grok-mcp.ts:101`; evidence in `docs/evidence/grok-mcp-1411/README.md`), and `--no-leader` so each agent owns its MCP children (`src/backend/grok.ts:376`).
- agy: a global MCP config the CLI process environment is inherited into, hence an owner-only wrapper script (`src/backend/antigravity.ts:217`).
- Codex, Kiro, OpenCode, Muse: files or wrapper scripts of their own (`src/backend/codex.ts:810`, `src/backend/kiro.ts:1856`, `src/backend/opencode.ts:99`).

With an `acp` adapter the declaration is part of the session: **`session/new` and `session/load` take an `mcpServers` array for that session** [S]. A stdio entry is `{ name, command (absolute path), args, env: [{ name, value }] }` and is required of every agent [S]; `http` and `sse` entries need the matching `mcpCapabilities` [S]. Consequences:

- **Identity isolation is by construction.** Each instance is its own process with its own `session/new` call; nothing is discovered from a shared project file or inherited from a first caller. The shim/wrapper machinery is not needed in this mode.
- **stdio is the portable choice.** grok advertises `mcpCapabilities` `http` and `sse` [V], but agy advertises **no** `mcpCapabilities` [V], so only the stdio form can be assumed for it. The `agend` MCP entry should therefore be stdio everywhere, as it is today.
- **Residual leak to check [U]:** whether a CLI *also* loads its user/global MCP configuration in addition to the `mcpServers` it was given. #1411's evidence says grok has no exclusive-configuration switch (`docs/evidence/grok-mcp-1411/README.md`, "Migration and limits"). In ACP mode that only matters for the user's own servers, not for AgEnD identity, but it must be stated in the profile for each CLI.
- Claude and Codex are different: Claude takes `--mcp-config` + `--strict-mcp-config` [V], which is exclusive and per-process. Codex's `app-server` takes configuration through its `-c key=value` overrides [V help] and per-thread settings [U].

Environment is also per-process in this mode: the runner builds the child's environment explicitly and does not inherit AgEnD's secrets by default (§7).

## 7. Security

### 7.1 Permissions: default and policy

- **Default to asking, not approving.** On the `tmux` adapter the fleet launches with the CLI's skip-permissions switch unless configured otherwise (`src/backend/types.ts:114`, `skipPermissions`). In structured mode, permission requests are first-class, so the default policy for a *new* structured instance should be **ask** (forward to the operator), with the existing `skipPermissions` setting mapped to an **auto-approve-once** policy for those who want the old behaviour. This is a deliberate change of default and is called out in §9.
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
| **0. Adapter interface, `tmux` as the first adapter** | Extract `CliAdapter` / `InstanceRunner` from the call sites; `TmuxAdapter` wraps the existing `Daemon` + `CliBackend`; `selectAdapter` always returns `tmux`; the `cli_adapter` field is parsed and validated but only `tmux` is accepted. **No behaviour change.** | All existing tests pass unchanged; a mutation check shows the interface is what the fleet actually uses; a fleet with no `cli_adapter` is byte-for-byte the same at runtime. Reviewable and revertible on its own. | 3–5 days |
| **1. `acp` for grok + agy** | `AcpAdapter` + `AcpClient`; profiles for grok and agy; in-tree ACP fake; chat timeline and Log tab fed live; permission buttons; cancel; resume; crash/respawn; `cli_adapter: acp` accepted for those two backends. | (a) Protocol-level tests against recorded, redacted fixtures **and** the in-tree fake, including: out-of-order updates, partial JSON lines, child exit mid-turn, cancel with a pending permission. (b) A scripted real-CLI smoke run: handshake, one short prompt, one cancelled prompt, one resume, one restart. Needs a person to run it with real credentials and accept the small quota use. (c) `tmux` instances are unaffected (existing suites). (d) Version gate: an unknown `agentVersion` is refused with a clear message unless the profile lists it. | **2–3 weeks** |
| **2. `acp` for kiro + opencode** | Verify first (§9); then a profile each. | The same acceptance as phase 1 for each CLI, preceded by a one-day verification spike per CLI that fills in every [U] in §3. If a CLI turns out **not** to have official ACP, the rule in §3.1 applies: it needs its own native adapter (a separate design and estimate) or stays on `tmux`. It is not forced onto `acp`. | 1–2 weeks each |
| **3. `claude-stream-json` and `codex-app-server`** | One adapter each, behind the same `AdapterEvent`s; Codex `steer` exposed through the capability flag. | Fixtures generated from the CLI's own schema where it offers one (Codex: `generate-json-schema`, [V]); real-CLI smoke runs; explicit handling of Codex's "experimental" label. Claude: a verification spike first for every Claude [U] in §3.2 (thinking deltas, the permission-prompt contract, interrupt). | 1–2 weeks each |

Phase 0 is the only phase that touches shared code paths in a way existing users could notice, which is why it is separated and why it is the first thing to be reviewed if the maintainers agree with the direction. Each later phase is a separate PR and is opt-in per instance at runtime; none of them changes defaults.

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
- **Support burden.** Four adapters multiply the matrix. Mitigation: the `CliAdapter` / `InstanceRunner` seam keeps it small (three translators into one event type), and the fakes keep the daemon-side tests independent of real CLIs.
- **Loss of the pane.** The mode removes AgEnD's most distinctive affordance for those instances. The opt-in rule and §2.2 are the mitigation; a maintainer may reasonably decide the trade is not worth it for a given adapter.
- **Default permission change** (§7.1). A structured instance that asks by default is a different experience from the always-approve default today. This needs an explicit maintainer decision.

### 9.3 Config key naming

The maintainer asked for an adapter choice per instance. Three spellings were considered:

| Spelling | For | Against |
|---|---|---|
| **`cli_adapter: tmux \| acp \| claude-stream-json \| codex-app-server`** (recommended) | One field says everything. The value names the adapter, so the backend × adapter validation is a plain table. Mirrors the existing `CliBackend` naming. Cannot be confused with the channel adapter or the Windows `native_adapter`. | A slightly longer key. |
| `adapter: …` (same values) | Matches the maintainer's wording exactly. | In this code base "adapter" already means the *channel* adapter (`ChannelAdapter`, `src/channel/types.ts:78`; an instance's `channel_id` is documented as "which channel adapter this instance is bound to", `src/types.ts:145`; `src/web-api.ts:372`) and, on the alpha line, `native_adapter` (`alpha:src/types.ts:112`). A reader or a grep would hit the wrong thing. |
| `execution: tmux \| structured` plus a sub-field for the adapter | Keeps "tmux or not" separate from "which protocol". | Two fields that must agree, and the second is meaningless unless the first is `structured`. Nothing needs the coarse split that the capability flags (§5.3) do not already give. |

Also avoided: `runtime` (already `wsl` | `windows`, `alpha:src/types.ts:106`) and anything with `acp` in the key, since two of the four adapters are not ACP. A Windows-runtime instance keeps `native_adapter` and does **not** accept `cli_adapter`; the validator rejects the combination. Unifying the two is out of scope here.

### 9.4 Relationship to Step 1 (grok per-instance leader spike)

Step 1 keeps the TUI and adds a **read-only ACP observer** attached to a per-instance grok leader. The `acp` adapter **does not depend on it, and it does not depend on the `acp` adapter**:

- They solve different problems. Step 1 is "keep the pane **and** get live thought text, for grok only". The `acp` adapter is "drop the pane for any CLI with official ACP".
- They share the **ACP client code**: the observer needs the framing, `initialize`, `session/load` and `session/update` decoding that `AcpClient` needs. If Step 1 lands first, `AcpClient` should be extracted from it, not rewritten; the observer's read-only rule (never send prompts, cancels or keys; never become the "last active client" for permission routing) is a *restriction on a client*, which the full client can honour by construction.
- They differ on identity: Step 1 must use **one leader per instance** (and a short socket path) to keep MCP identity isolated; the `acp` adapter with `--no-leader` and a per-process `session/new` needs no leader at all.
- If both exist, a grok instance would be either tmux + observer, or `acp`, never both at once. If Step 1 shows the TUI can join a per-instance leader cleanly, it is the lower-cost route for grok *only* and the `acp` adapter's grok phase may be reduced to "for users who want no TUI at all".

### 9.5 Questions for the maintainers

Answered by the maintainer's direction and therefore removed: whether the mode may be per-instance and opt-in with an adapter chosen per CLI (adopted as the design); whether Codex may use its own `app-server` rather than an ACP wrapper (yes: no official ACP means a native adapter); the choice between an ACP wrapper and the native protocol for Claude (native).

Still open:

1. Is an opt-in structured adapter acceptable in principle, given #739's earlier "not ACP" decision? (Same question as in #3731; this document is the detail behind it.)
2. **Config key** (§9.3): `cli_adapter` is recommended; is a bare `adapter` preferred despite the existing channel-adapter meaning?
3. Should **phase 0** (the adapter interface, with `tmux` as its first implementation) be proposed on its own first, since it is behaviour-neutral and useful regardless?
4. **Default permission policy** for a new structured instance: ask (proposed in §7.1) or inherit today's always-approve?
5. If Kiro or OpenCode turn out **not** to have official ACP, is a dedicated native adapter per CLI wanted, or should they stay on `tmux`?
6. Where should the adapter be selectable (create form only, or editable later)? Editing implies the conversation-continuity question in §9.1 (7).
7. Is a recorded-fixture + fake-CLI test strategy (no real CLI in CI) acceptable, with real-CLI smoke runs left to a manual step?
8. Codex's `app-server` is labelled "[experimental]". Is an adapter on an experimental interface acceptable behind a strict version gate?

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
