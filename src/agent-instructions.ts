/**
 * AGEND-162: an agent's own `instructions` — plain Markdown the person writes for that agent, kept beside `systemPrompt`
 * (never in place of it). The daemon appends it as the last section of the agent's instructions (instructions.ts), so an
 * agent without it is told exactly what it was told before.
 */

/** The longest `instructions` fleet.yaml may hold, in characters. */
export const AGENT_INSTRUCTIONS_MAX_CHARS = 24_000;

/**
 * The text to inject: the value as written, or undefined when there is nothing to say — not a string, empty, or only
 * whitespace. The text itself is not rewritten (a leading indent in a Markdown block is the person's).
 */
export function agentInstructionsText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.replace(/\s+$/, "") : undefined;
}
