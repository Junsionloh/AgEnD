// the "Instructions" field of an agent's Basic info — Markdown the person writes for the agent, with an Edit /
// Preview switch. The preview is the chat's own Markdown renderer (chat-thread.js drawMarkdown → chat-render.js: it escapes
// the text first, so nothing typed here becomes markup); nothing is rendered by this file.
import { html, useEffect, useRef, useState } from "/assets/app-html.js";
import "/assets/chat-render.js";
import { drawMarkdown } from "/assets/chat-thread.js";
import { pt } from "./agent-page-strings.js";

/** instructions.ts / agent-instructions.ts AGENT_INSTRUCTIONS_MAX_CHARS: the most fleet.yaml accepts. */
export const INSTRUCTIONS_MAX_CHARS = 24000;
/**
 * Codex reads at most 32 KiB of AGENTS.md in total (backend/codex.ts) and AgEnD's own guidance already takes about 12 KiB
 * of it, so past this many bytes of instructions the end — this field is the last part — may be cut.
 */
export const CODEX_AGENTS_MD_BYTES = 32 * 1024;
export const CODEX_NOTE_BYTES = 16 * 1024;

const utf8Bytes = (text) => (typeof TextEncoder === "function" ? new TextEncoder().encode(text).length : text.length);
/** What the counter shows: characters (what the limit counts) and bytes (what Codex counts). */
export const instructionsSize = (text) => ({ chars: text.length, bytes: utf8Bytes(text) });
const fmt = (n) => Number(n).toLocaleString("en-US");

/** The preview: the text drawn by the chat's Markdown renderer. */
function InstructionsPreview({ text }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current && text.trim()) drawMarkdown(ref.current, text); }, [text]);
  if (!text.trim()) return html`<p class="note">${pt("instrPreviewEmpty")}</p>`;
  return html`<div ref=${ref} class="pv-code pv-md" data-instructions-preview />`;
}

/** `id`: the textarea's id (the field's label points at it). `value`/`onChange`: the draft. */
export function InstructionsField({ id, value, onChange }) {
  const [mode, setMode] = useState("edit");
  const { chars, bytes } = instructionsSize(value);
  const over = chars > INSTRUCTIONS_MAX_CHARS;
  const codexNear = bytes > CODEX_NOTE_BYTES;
  const modeBtn = (m, label) => html`<button type="button" class=${`btn btn-sm${mode === m ? " btn-primary" : ""}`} aria-pressed=${mode === m ? "true" : "false"} data-instructions-mode=${m}
    onClick=${() => setMode(m)}>${label}</button>`;
  return html`<div class="instructions-field">
    <div class="seg-inline" role="group" aria-label=${pt("lbl_instructions")}>${modeBtn("edit", pt("instrEdit"))}${modeBtn("preview", pt("instrPreview"))}</div>
    ${mode === "edit"
      ? html`<textarea id=${id} rows="12" spellcheck=${false} aria-describedby=${`${id}-size`} class=${over ? "invalid" : ""} placeholder=${pt("instrPlaceholder")} value=${value}
          onInput=${(e) => onChange(e.target.value)} />`
      : html`<${InstructionsPreview} text=${value} />`}
    <p class=${`note${over ? " feedback error" : ""}`} id=${`${id}-size`} role=${over ? "alert" : undefined} data-instructions-size>${over ? pt("instrTooLong", fmt(chars), fmt(INSTRUCTIONS_MAX_CHARS)) : pt("instrSize", fmt(chars), fmt(INSTRUCTIONS_MAX_CHARS), fmt(bytes))}</p>
    <p class=${`note${codexNear ? " feedback warning" : ""}`} data-instructions-codex>${pt(codexNear ? "instrCodexNear" : "instrCodex")}</p>
  </div>`;
}
