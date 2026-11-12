# grok per-instance leader + read-only ACP observer — spike evidence (AGEND-236, upstream #3731 step 1)

Experiment, opt-in, **off by default**. Everything below was measured on a real grok **1.0.77** (Linux/WSL2, signed in), a
real tmux TUI and a few minimal turns ("think briefly, run `echo`", "create a file", "reply OK"). Times are UTC from the
observer's own wire log; they are the leader's stream, not the page's.

Reproduce: `harness/` (the spike observer, the two end-to-end runs that drive the production `GrokLeaderHost` +
`GrokBackend.buildCommand` against real grok, the socket-length probe). Logs of those runs: `logs/`. The redacted wire capture
the tests replay: `tests/fixtures/grok-leader-observer-236/<version>/`.

## How it works

```
 daemon (per grok instance, opt-in: backend_options.grok.leader_observer: true, an audited grok version: 1.0.77)
   prepare():  stop the instance's old leader (pid from its own lock file), choose  <XDG_RUNTIME_DIR|tmp>/agend-grok-<uid>/<12 hex>.sock
   launch:     [instance env] grok --no-auto-update --leader --leader-socket <S> …        (instead of --no-leader)
                  └─ the TUI spawns ITS leader at <S>: a child of the TUI, with the TUI's environment
   begin():    every 2 s, once <S>'s leader is alive and the TUI's session id is known:
               observer = `grok agent --leader --leader-socket <S> stdio`  →  initialize, session/load   (the ONLY two requests)
                  └─ session/update: agent_thought_chunk · tool_call · tool_call_update · pending_interaction · turn_completed
   chat block: LogService answers `live` {running calls, permission waiting, thought (admin + web.log_thinking only)} + steps_tick
   stop():     the TUI first, then the observer, then the leader (SIGTERM by lock-file pid, verified to be this socket's `agent leader`)
```

Code: `src/backend/grok-leader.ts` (gate, socket, flags, stop), `grok-acp-observer.ts` (transport, reducer, view),
`grok-leader-host.ts` (lifecycle); wiring in `grok.ts` (`buildCommand`), `daemon.ts` (3 places), `fleet-manager.ts`, `log-service.ts`,
`ui/chat-activity.js`.

## The four questions

### 1. Can the TUI join a leader, and does the observer get thoughts while the turn runs?

**Yes to both.** The TUI takes `grok --leader --leader-socket S` (a root flag that `grok --help` does not list, like `--no-leader`;
it parses on 1.0.77 and the TUI registers as `client_type=grok-shell mode=Stdio`). With no leader listening it spawns one itself.
The observer (`grok agent --leader --leader-socket S stdio`, `session/load` of the TUI's session id) receives the TUI's turn:

Turn 4 of the capture (`session-turns.jsonl`), prompt "run `sleep 6; echo step-a`, think briefly, run `sleep 6; echo step-b`, reply OK":

| UTC | what the observer received | vs. turn end |
|---|---|---|
| 09:11:54.939 | `user_message_chunk` (the prompt, typed in the TUI) | −18.3 s |
| 09:11:56.983 | `agent_thought_chunk` ×2 ("Running the first command, then pausing briefly…") | **−16.2 s** |
| 09:11:57.051 | `tool_call` + `tool_call_update` ("Execute `sleep 6; echo step-a`") | |
| 09:11:57.066 → 09:12:03.097 | `in_progress` … `completed` (6 s) | |
| 09:12:05.161 → 09:12:11.193 | second call, `in_progress` → `completed` | |
| 09:12:12.673 | `agent_message_chunk` "OK" | |
| **09:12:13.223** | `turn_completed` | 0 |

So a thought and every tool call are in hand while the turn is running, seconds before it ends. Honest limit: grok's thought
text is a **summary delivered in a burst at the end of each reasoning segment**, not token by token. A turn with no tool call
(turn 3: prompt 09:11:06.949, thought 09:11:12.083, answer chunk 09:11:12.096, end 09:11:12.473) gets its thought only just
before the answer; in a multi-step turn each segment's thought arrives as that segment ends. The transcript (`updates.jsonl`)
only gets a thought when it ends, which is the gap #3648 could not close.

End to end through the production code (`logs/e2e-tui-turn.log`): observer loaded 2.5 s after the launch; `live` events
(thought at 09:24:35.667, 2 s after the prompt; `running:Execute sleep 5; echo e2e-a` 09:24:37.369; `completed` 09:24:42.384;
turn end 09:24:51.664).

### 2. Where does a permission request go?

**To every attached client, as a copy; the first answer wins.** In the permission turn of the capture the TUI (no
`--always-approve`) showed "Allow Edit to …?" and the observer received, on its own wire, `pending_interaction` at
09:09:20.534 and `session/request_permission` (id 0, the same tool call, four options) at 09:09:20.535. The observer **sent
nothing back**. The person pressed Enter in the TUI at 09:09:38.654; the observer then saw `interaction_resolved` (09:09:38.670)
and the call `completed` (09:09:38.713); the file was written. Same through the production code, including after a TUI crash and
respawn (`logs/e2e-tui-crash-respawn.log`: `permissionDialogInTui: true`, `observerSaysWaiting: true`, the TUI answered,
`observerWaiting: false`).

The leader's own log does **not** record the routing of a request (not even at DEBUG; I could not make it). What it does
record (`logs/leader-clients.log`): each client's registration (`client_id=4 client_type=grok agent --leader … stdio` is the
observer, distinguishable from the TUI's `grok-shell`), `Using fallback routing to last active client` only at a TUI's
`session/new` (ids 1, 2, 3, 5), **never** for the observer, and `Transferred session driver after disconnect … old_driver=3
new_driver=4` when the TUI died. The grok binary's strings name the mechanism (`permission/client_attachment.rs`: "a copy of the
permission request failed; awaiting the others", "client re-attached; re-sending pending permission request") — read from
the binary, not from source. So the proof of routing is the observer's wire log plus the TUI's dialog, not the leader's log.

Consequences, all enforced: the observer declares no capabilities, sends only `initialize` + `session/load`, and leaves every
agent→client request unanswered (counted in `observer.unanswered`). When the TUI dies the observer becomes the session's
*driver*; the daemon's respawn path stops that leader before starting a new TUI, so a permission request is never left with a
silent driver (and with no TUI there is nobody to answer one anyway).

### 3. Unix socket path length

Linux `sun_path` is 108 bytes including the NUL: **a 107-byte path works, 108 fails** (`logs`/`harness/socket-length-probe.sh`
on 1.0.77: 100, 103, 104, 106, 107 listen; 108 does not — the leader logs `path must be shorter than SUN_LEN`, the client prints
`Timeout waiting for IPC socket to be created`). macOS: 104 (103 usable). grok also writes `<socket minus .sock>.lock` (the
leader's pid) beside the socket.

AgEnD never puts an instance's path in the socket path: it is `<runtime dir>/agend-grok-<uid>/<12 hex of sha256(instanceDir)>.sock`
(48 bytes under `/run/user/1000`), the hex making it unique per instance *and* per fleet home. `XDG_RUNTIME_DIR` first, then the
temp dir, then `/tmp`; a candidate over **100 bytes** is skipped. The directory is created 0700 and refused if it is a symlink or
another user's. No Windows support (the mode stays off).

### 4. Leader lifecycle

Measured: a leader the **TUI** spawns runs `agent leader --no-exit-on-disconnect --relay-on-demand …` as a child of the TUI, with
the TUI's environment (`/proc/<pid>/environ` has the launch's `AGEND_PROBE_BINDING`), and it **outlives the TUI**. A TUI
launched later joins it and its tools run with the *first* launch's environment: launch A `AGEND_PROBE_BINDING=binding-A`,
leader left alive, launch B `…=binding-B` → the model's `echo $AGEND_PROBE_BINDING` printed `binding-A`. That is #1411 again, so the
daemon owns the leader's lifetime (never `grok leader kill`, which stops every leader on the machine):

| event | what happens (measured unless marked) |
|---|---|
| instance stop | the TUI exits; leader still alive (`leaderAlive: true`); `host.stop()` SIGTERMs it by the lock-file pid after checking it is `agent leader` of this socket; socket and lock are gone (`e2e-tui-turn.log`) |
| instance restart | `prepare()` stops whatever is at the socket **before** the new TUI starts, so its leader is new, with the new launch's environment |
| TUI crash (`kill -9`) | leader survives, the observer stays loaded and becomes the session driver; the daemon's respawn runs `prepare()` (leader stopped), the new TUI resumes the session (`--resume`), the observer re-attaches within one poll; the permission dialog appears in the new TUI (`e2e-tui-crash-respawn.log`) |
| observer disconnect (bridge exits, killed) | the TUI is unaffected (leader log: `Client disconnected client_id=4` only); the host backs off 2/5/15/30 s and re-attaches while the leader is alive; the leader stays (TUI-spawned: `--no-exit-on-disconnect`) |
| daemon restart / crash | the observer's bridge exits on stdin EOF (measured) and takes nothing else with it; TUI and leader keep running in tmux. A new daemon that re-adopts the running pane (no relaunch) has no host → **no live view until the next launch**, behaviour otherwise as today; the old leader is stopped at that launch's `prepare()` (or the next stop) |
| a leader we start by hand without `--no-exit-on-disconnect` | exits when its last client disconnects (measured) — not used: the TUI's own spawn is what carries the instance's environment |
| the observer's bridge with no leader at its socket | **spawns one** (measured), with the daemon's environment — so the host starts the observer only while *this instance's* leader is alive |

`--no-exit-on-disconnect` is on the leader the TUI spawns; the pid file is `<socket minus .sock>.lock`; leader logs go to the shared
`~/.grok/leader.log`.

## Upstream's ground rules → where each is enforced

| rule | enforced by | tested in `tests/grok-leader-observer-236.test.ts` |
|---|---|---|
| 1. one leader per instance, own env and socket, no shared leader, `~/.grok/config.toml` untouched, CLI flags only | `grokLeaderSocketPath`, `GrokLeaderHost.prepare/stop`, `grokLeaderLaunchFlags`; no config write anywhere | "rule 1" (socket, dir, flags, stop only a verified leader of this socket), host lifecycle |
| 2. permission requests stay in the TUI | the observer never answers; declares no capabilities | "rule 2" (frame by frame over the real turn: sent = initialize, session/load; no response ever written; `unanswered` = 1) |
| 3. read-only | `OBSERVER_ALLOWED_METHODS`, one `transport.send` call site | "rule 3" (whole session sends two requests; `send("session/prompt" …)` throws; the module's source names no other method) |
| 4. version gate + fixture | `grokLeaderVersionOk`: an **exact list** of audited versions (`GROK_LEADER_AUDIT`, one row each; today 1.0.77 only), on the binary *and* on the `initialize` answer's `agentVersion`; `loadSession` required; an unlisted version launches `--no-leader` with a warning | "rule 4" (exact versions; every listed version has its audit row, its entry below and its fixture); fixture = real, redacted capture |
| 5. default unchanged | opt-in literal `true`; no socket ⇒ `--no-leader`; no observer ⇒ no `live` key | "rule 5" (command string, validator, a not-requested host touches nothing) |

Counter-proof: with the wiring removed (`grok.ts`, `log-service.ts`, `chat-activity.js`, the validator) and the new modules kept, 7
of the 47 tests fail; without the modules the file does not load.

## What this does not do / open points

- **Which session is the TUI's.** The observer attaches to `backend.getSessionId()` (the newest-active session of the cwd, the
  heuristic AgEnD already uses for `--resume`). The protocol has `session/list`, but that would be a third request; asking the
  leader which session the TUI holds is a design decision for step 2.
- **No live view after a daemon restart without a relaunch** (above).
- **`--leader` is a hidden root flag**; the gate is the exact list of audited versions below. A version that is not on it never gets `--leader`.
- The thought is a summary (burst per segment), see 1.
- A tool's `rawOutput` is **not** read or sent (only titles, only at `tool_progress: verbose`; `standard` gets the kind).
- Linux and macOS only; one extra `grok agent … stdio` process per observed instance (a thin bridge) while a turn is idle too.
- The bridge `grok agent --leader … stdio` reports `client_type=<its own argv>`, so the leader log distinguishes it from the TUI.

## Audit table (one entry per grok version that may use the mode)

The list in `src/backend/grok-leader.ts` (`GROK_LEADER_AUDIT`) is the allow-list; the gate is an exact match, not a range. A version
is added by adding its row there, its redacted real capture under `tests/fixtures/grok-leader-observer-236/<version>/`, and its entry
here, in one change; `tests/grok-leader-observer-236.test.ts` ("the allow-list is the audit rows…") fails if any of the three is missing
or a check is not `pass`. A version that is not listed launches as before (`--no-leader`), without an observer, and the instance log says so.

### grok 1.0.77 (50ca579fa996)

| | |
|---|---|
| Date, version and build, auditor | 2026-11-13 (checks re-run on the fixed code; the wire capture is from 2026-11-12) · grok 1.0.77 `50ca579fa996` [stable] · Junsionloh |
| The flag is still accepted and behaves as described | pass: `grok --leader --leader-socket S` starts a TUI that registers as `grok-shell` at S |
| TUI joins a per-instance leader | pass |
| The observer's `session/load` replay and live updates | pass |
| Permission copies reach the observer and only the TUI's answer resolves | pass |
| `Transferred session driver` appears on TUI death, and the stop-before-respawn path cleans up | pass |
| Socket path limit | 107 bytes (108 fails), unchanged |
| Fixture | `tests/fixtures/grok-leader-observer-236/1.0.77/session-turns.jsonl` |
