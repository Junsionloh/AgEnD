# AGEND-367: a comment's status, and the person's unread (real app)

Captures of the real web app and task board (`scripts/manual/smoke-fixture`) with a scratch scheduler database of made-up cards, taken headless with Chromium (motion reduced). The board's real data stays off GitHub. Script: `scripts/manual/task-comment-status-agend367/capture.mts`; `*/receipt.json` lists the commit it ran on (its `src` clean), every check and each PNG's sha256. `after` ran 92/92 checks, `before` 8/8.

```
REPO=<checkout> PW_DIR=<checkout> CHROME=<chrome> OUT=<dir> PHASE=before|after npx tsx scripts/manual/task-comment-status-agend367/capture.mts
```

`before` is AGEND-365's branch (`7318b906e`, fork PR #107) with the same comments written the same way; it has no status line, dot, strip or number. `after` is this branch.

**The fixture.** One card, "Serve the weekly leaderboard", assigned to `general` (the fleet's own waker hands the comments to a real delivery outbox; the script moves one row on to *delivered + consumed*, as a running agent's transcript does, and sets each instance's state as the status frames say it: `general` working, `fleet-lead` offline, `core-dev` with the task board off). Comments, in order: the viewer's question, answered by `general` (so *replied*, and the answer is **unread**); a comment to `general` that also `@`-names `core-dev` (*working…* and *not woken: its task board is off*); a comment to `fleet-lead` (*offline — gets this when it is back*); and a comment that has just been sent (*Sent to general*).

| What | After | Before |
|---|---|---|
| **The board.** A dot on the card's tile, a strip above the board ("1 task card has new replies — general answered you · 1 min ago"), and — on the desk — the number 1 on the sidebar's Fleet row (a phone's drawer has no counts, M-3166: the strip says it there) | `*-1-board.png` | `*-1-board.png` (nothing) |
| **The card.** Under each comment written for an agent, where it stands; the answer tagged *New* (the card was just opened: it is marked read a moment after, and the number is gone) | `*-2-card.png` | `*-2-card.png` (comments with nothing under them) |

Combinations: desk and phone × light and dark × English and 繁體中文 (8).

**Shared components used, none new.** The status line reads the instance's state with the same inference as the card's "Running" (`instanceStates` / `dotState`, #92) and the delivery outbox's own state and `consumed_at` (#1201); the page's `Icon` set (`clock`, `check`, `alert`, `info`, `bell` — no new icon), `.tb-link`, `.tb-tag`, `.tl-card`; the strip reuses the Waiting box's frame (`.tb-waiting`, `.tb-section-title`, `.tb-wait-title`, `.rows` / `.row-item`) as Home's "No project" list does; the sidebar number is the Needs-you row's `.nav-count`. Colours and spacing are tokens (`--accent`, `--accent-dim`, `--ok`, `--danger`, `--text-2`, `--s-*`); no inline style (`web-csp-1300`).

**Measured on the way.** The first capture showed "general was not woken: the card no longer waits on it" under the assignee's *own* answer (its own comment was recorded as written for itself); the board now keeps nothing for a writer's own words, and a test says so.
