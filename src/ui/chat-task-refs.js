// AGEND-298: task cards in the web chat. The person types `#` in the chat box, picks a card, and the box holds its number
// (`#M-3`; M- is a main task, S- a sub task). A hand-typed `#M-3` / `#s3` counts the same; a bare `M-3` does not.
// Nothing about a reference is stored with the message — the text is the message — so an older chat, and an older AgEnD, read
// it as the text it is. This file is the page's side:
//   - taskRefAt / insertTaskRef: the `#query` being typed at the caret, and the number put in its place (pure);
//   - createTaskRefIndex: what the page knows of the cards its messages name (GET /ui/tasks/refs, only the numbers asked,
//     each once per page and again after the board changed), and the cards offered while `#` is typed. Until a card's answer
//     arrives (or if the number is no card) the message shows the number as text; when it arrives the messages are drawn again.
// The chip itself is drawn by the shared renderer (shared/chat-render.js), which asks `taskRefs(code)`.
//
// The `@` completion of Fleet › Tasks' comment box (fleet-task-activity.js) has the same shape — mentionAt / insertMention —
// and these two pairs are meant to be one: both are a trigger character, the word typed after it up to the caret, and the
// replacement. They are kept apart only so that neither feature waits for the other's pull request.

/** The same rule as the renderer's and the server's (src/chat-task-refs.ts): a test holds the three to one list of cases. */
const REF = /(?<![A-Za-z0-9_/&#@-])#([MmSs])-?(\d{1,9})(?![A-Za-z0-9_-]|\.\d)/g;
const MAX_CODES = 50;
/** A card number as the board writes it: "#s3" / "m 3" → "S-3"; null when it is not one. */
export function taskRefCode(raw) {
  const m = /^\s*#?\s*([MmSs])\s*-?\s*(\d{1,9})\s*$/.exec(String(raw));
  return m ? `${m[1].toUpperCase()}-${Number(m[2])}` : null;
}

/** The card numbers a text names, normalised, each once, in order. */
export function taskRefCodes(text, max = 10) {
  const out = [];
  if (typeof text !== "string" || !text) return out;
  for (const m of text.matchAll(REF)) {
    const code = taskRefCode(`${m[1]}-${m[2]}`);
    if (code && !out.includes(code)) out.push(code);
    if (out.length >= max) break;
  }
  return out;
}

// ── Typing a `#` ──────────────────────────────────────────

/** What may follow the `#` while it is still being typed: no space, no second `#`; a card number or a word of a title. */
const QUERY_CHAR = /[^\s#]/u;
const MAX_QUERY = 60;

/**
 * The `#query` being typed at the caret, or null: a "#" that starts the text or follows a space, a bracket or a full-width
 * punctuation mark (not a word, a path or a URL: "page#top", "a/b#c"), then what was typed after it up to the caret.
 * { start: where the "#" is, query: the characters after it }. A line that starts with "/" is a command, not a message: null.
 */
export function taskRefAt(text, caret) {
  const s = String(text);
  if (/^\s*\//.test(s)) return null;
  const end = Math.min(Math.max(0, caret), s.length);
  let i = end;
  while (i > 0 && QUERY_CHAR.test(s[i - 1]) && end - i <= MAX_QUERY) i--;
  if (i === 0 || s[i - 1] !== "#") return null;
  const start = i - 1;
  if (start > 0 && /[A-Za-z0-9_/&#@-]/.test(s[start - 1])) return null;   // the renderer's and the server's rule for what comes before a `#`
  return { start, query: s.slice(i, end) };
}

/** The text with the `#query` at `at` replaced by `#M-3 ` (one space after, unless one is already there), and where the caret goes. */
export function insertTaskRef(text, at, caret, code) {
  const s = String(text);
  const after = s.slice(Math.max(caret, at.start));
  const spaced = after.startsWith(" ");
  const head = `${s.slice(0, at.start)}#${code}${after.startsWith("\n") || spaced ? "" : " "}`;
  return { text: head + after, caret: head.length + (spaced ? 1 : 0) };
}

// ── What the page knows of the cards ──────────────────────

/**
 * `fetchImpl(url)` → a Response (or null: no board for this page). Keeps, per card number, the view the server gave
 * ({ code, title, status, assignee, kind }) — or null for a number that is no card (asked once; asked again only after the
 * board changed, which `refresh()` is told of). The messages that name a number come in `ensure(msgs)`; only a person's own
 * words count (`role: "user"`): an agent's "M-3" is its prose, not a reference.
 */
export function createTaskRefIndex(fetchImpl) {
  const known = new Map();      // code → view | null
  const asked = new Set();      // codes asked and answered (or being asked)
  const listeners = new Set();
  let inFlight = 0;
  let suggestSeq = 0;

  const read = (url) => Promise.resolve().then(() => fetchImpl(url)).then((r) => (r && r.ok ? r.json() : null), () => null);
  const notify = () => { for (const f of [...listeners]) f(); };

  function ask(codes) {
    for (let i = 0; i < codes.length; i += MAX_CODES) {
      const batch = codes.slice(i, i + MAX_CODES);
      for (const c of batch) asked.add(c);
      inFlight++;
      read(`/ui/tasks/refs?codes=${encodeURIComponent(batch.join(","))}`).then((body) => {
        if (!body || !Array.isArray(body.refs)) return;   // not answered: the numbers stay text (and are asked again after a change)
        let changed = false;
        const got = new Map(body.refs.filter((v) => v && typeof v.code === "string").map((v) => [v.code, v]));
        for (const c of batch) {
          const next = got.get(c) || null;
          const before = known.get(c) || null;
          if (JSON.stringify(before) !== JSON.stringify(next)) changed = true;
          known.set(c, next);
        }
        if (changed) notify();
      }).finally(() => { inFlight--; });
    }
  }

  return {
    /** The card a number is, or null (not asked yet, not a card, or the board cannot be read here). */
    get: (code) => known.get(code) || null,
    /** Ask for the numbers in these messages (a person's own words) that have not been asked about yet. */
    ensure(msgs) {
      const want = [];
      for (const x of msgs || []) {
        if (!x || x.role !== "user" || typeof x.text !== "string" || x.text.length < 3) continue;
        for (const c of taskRefCodes(x.text)) if (!asked.has(c) && !want.includes(c)) want.push(c);
      }
      if (want.length) ask(want);
    },
    /** The board changed: the numbers asked about are asked again (the status and title in a chip follow the card). */
    refresh() {
      const again = [...asked];
      asked.clear();
      if (again.length) ask(again);
    },
    /** The cards to offer for what follows a `#` ("" → the latest changes). Resolves to [] when none, or when a newer call came first. */
    async suggest(query) {
      const mine = ++suggestSeq;
      const body = await read(`/ui/tasks/refs?limit=8&q=${encodeURIComponent(query)}`);
      if (mine !== suggestSeq || !body || !Array.isArray(body.refs)) return [];
      // What the list shows is what the page now knows of those cards (a chip drawn later says the same).
      for (const v of body.refs) if (v && typeof v.code === "string") known.set(v.code, v);
      return body.refs.filter((v) => v && typeof v.code === "string" && typeof v.title === "string");
    },
    subscribe(f) { listeners.add(f); return () => listeners.delete(f); },
    /** Requests not answered yet (tests). */
    pending: () => inFlight,
  };
}
