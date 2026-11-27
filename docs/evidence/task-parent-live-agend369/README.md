# AGEND-369: a main task says what its sub tasks' agents are doing, and how the baton passes (real app)

Captures of the real web app and task board (`scripts/manual/smoke-fixture`) with a scratch scheduler database of made-up cards, taken headless with Chromium (motion reduced, so the turning ring is still). The board's real data stays off GitHub. Script: `scripts/manual/task-parent-live-agend369/capture.mts`; `*/receipt.json` lists the commit it ran on (its `src` clean), every check and each PNG's sha256. `after` ran 204/204 checks, `before` 40/40.

```
REPO=<checkout> PW_DIR=<checkout> CHROME=<chrome> OUT=<dir> PHASE=before|after npx tsx scripts/manual/task-parent-live-agend369/capture.mts
```

`before` is AGEND-367's branch (`f76b84aaf`, fork PR #108) with the same cards moved the same way; `after` is this branch.

**The fixture.** Six instances (`game-designer`, `game-dev`, `game-qa`, `game-ops`, `game-art`, `game-sound`; `game-dev`, `game-art` and `game-sound` are working, `game-ops` is offline). Four main tasks, each with three sub tasks, S-2 after S-1 (in the last two it does not wait for S-1) and S-3 after S-2:
- *RPG shooter* — S-1 finished by `game-designer`, S-2 handed to `game-dev` (the fleet's own waker puts the notice in a real delivery outbox; the script then marks that row delivered + consumed, as a running agent's transcript does) and claimed by it, S-3 waits. `game-dev`'s steps are answered by the script (`/ui/steps` needs a live backend's transcript) with real steps parsed from a Claude transcript line: the row says "game-dev · Edit game/enemy-ai.js".
- *Card game* — S-1 finished, S-2 handed to the offline `game-ops`: the notice waits in the outbox ("game-ops is offline — it gets this when it is back"), S-3 waits.

| What | After | Before |
|---|---|---|
| **The board.** The main task's tile says Running while a sub task's agent works (already so, #92) | `*-1-board.png` | `*-1-board.png` (same) |
| **A main task whose sub task is running.** A line under each sub task — the ring and the step, "Waits for S-2" —, the Agent activity block listing what is going on instead of "The work is in its sub tasks", "Running" beside the status, the sub tasks' moves and a row per hand-over ("S-1 done → handed to game-dev to start S-2 — game-dev started S-2") in the activity | `*-2-card-running.png` | `*-2-card-running.png` (no line, the one quiet block, 2 activities) |
| **An agent working on the card it was given without claiming it** (the owner's survivor-dev, 2026-11-26). `game-art` was assigned S-2 and is working, with nothing in progress: the row, the block, the hand-over row, the mark beside the status and the board's tile all say it is running — "game-art · Edit game/enemy-ai.js (not claimed yet)", "Running · not claimed" — instead of "working… (not started yet)" beside a card still To do | `*-4-card-unclaimed.png` (and its tile in `*-1-board.png`) | `*-4-card-unclaimed.png` (nothing: the card is To do and nothing turns) |
| **The same for six minutes** (`game-sound`; the script backdates the hand-over): the line is flagged — "(still not claimed)", the warning colour, and a tooltip to ask it to claim or move the card yourself | `*-5-card-unclaimed-late.png` | `*-5-card-unclaimed-late.png` (nothing) |
| **A main task whose next agent is offline.** "game-ops is offline — it gets this when it is back" on S-2's row, in the block, and under the hand-over row | `*-3-card-handoff.png` | `*-3-card-handoff.png` (nothing says who has the baton) |

The script keeps `game-art`'s hand-over fresh for every picture (the run takes minutes) and backdates `game-sound`'s by six minutes; the notices to both are marked delivered + consumed like `game-dev`'s. Combinations: desk and phone × light and dark × English and 繁體中文 (8).

**Shared components used.** The ring is the page's `.out-spin` (the file-send spinner; still with reduced motion); the line reads the instance's state with the same inference as the card's "Running" (`runOf` / `instanceStates`, #92), the step the way the chat's activity block says it (`observeActivity`, `stepLine`), and the hand-over's delivery as the comment status does (`wakeViews`' states, the delivery outbox's own state and `consumed_at`); `RunMark` beside the status; `Icon` (`forward`, `clock`, `check`, `alert`, `info` — no new icon), `.tb-link`, `.tl-wake`, `.tl-line`, `.tr-run`. New: `fleet-task-flow.js` (the lines and the hand-over row), `.tc-child-line`, `.tf-*`, `.tl-baton` (task-board.css). Colours and spacing are tokens; no inline style (`web-csp-1300`).
