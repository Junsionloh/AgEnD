# AGEND-365: comment threads on a task card (real app)

Captures of the real web app and task board (`scripts/manual/smoke-fixture`) with a scratch scheduler database of made-up cards, taken headless with Chromium (motion reduced, Noto Color Emoji installed for the emoji). The board's real data stays off GitHub. Script: `scripts/manual/task-comment-threads-agend365/capture.mts`; `*/receipt.json` lists the commit it ran on (its `src` clean), every check and each PNG's sha256. `after` ran 96/96 checks, `before` 8/8.

```
REPO=<checkout> PW_DIR=<checkout> CHROME=<chrome> OUT=<dir> PHASE=before|after npx tsx scripts/manual/task-comment-threads-agend365/capture.mts
```

`before` is `upstream/release/2.3.5-alpha` (`846da8c0a`) with the same seven comments written plainly: that release has no reply, reaction, edit, resolve, delete or recipient. `after` is this branch.

**The fixture.** One card, "Serve the weekly leaderboard", assigned to `general`. The comments, in order: the viewer's question; `general`'s answer under it (a reply); the viewer's follow-up under that (a reply, **edited**); `general`'s comment of its own with 👍 ×2 (the viewer's among them, pressed) and 🎉; a **deleted** comment; and an old thread, **resolved**, of two comments.

| What | After | Before |
|---|---|---|
| **The stream.** Each comment's head ends with a reaction button and a ⋯ menu; a reply is a card of its own under its thread's first comment, indented, and "edited" follows its time; reactions are the chat's chip (the viewer's own pressed); a deleted comment is one line, a resolved thread one line (who resolved it, the first comment, how many replies); the box ends with the recipient chip, "general · starts when sent" (送出後開始處理) | `*-1-stream.png` | `*-1-stream.png` (the plain comments and a box with Send only) |
| **The ⋯ menu** of the viewer's own comment: Reply, Add reaction, Edit, Resolve thread, Copy, Copy link, Delete (the last in the danger colour). Someone else's comment has no Edit (tests) | `*-2-menu.png` | — |
| **Reply.** The box opened under the thread of `general`'s answer; its recipient chip starts as that comment's author; the chip's list is open: Assignee, Other agents (each once), and "No agent notified" | `*-3-reply.png` | — |

Combinations: desk and phone × light and dark × English and 繁體中文 (8).

**Shared components used, none new.** The app's `Menu` (`ui-menu.js`) for the ⋯ and for the chip's list; the chat's reaction chip and its quick set (`.msg-reactions .reaction`, `QUICK_REACTIONS` of `chat-thread.js`); the chat's Markdown renderer (`MdBody`) for the words; `confirmDialog` for Delete; `toast` for Copy and Copy link; the stream's own `.tl-card`, `.tl-more` and `.tb-link`; the page's `.tc-composer`, `.btn` and `.icon-btn`. Three icons are added to the shared set (`reply`, `smile`, `link`). Colours and spacing are tokens (`--surface`, `--border`, `--accent`, `--text`, `--s-*`, `--r-md`); no inline style (`web-csp-1300`).

**Measured on the way.** A reaction's count was drawn in the chip's font, the emoji font, whose digits are grey pictures (the first capture showed them nearly invisible); it is drawn in the page's font now, and the script checks it. A reply's head, on a phone, wrapped the tools onto a second line; the head stays one line now (the name gives way with an ellipsis).
