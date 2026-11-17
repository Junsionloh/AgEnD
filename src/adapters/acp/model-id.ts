import { agyVariantOf } from "../../backend/effort-metadata.js";

/**
 * The model menus (Web Settings, `/model`) and fleet.yaml name an antigravity model the tmux way: one catalog slug per effort
 * level (`gemini-4-hydrogen-medium`). Over ACP the agent offers the model alone (`gemini-4-hydrogen`) and the effort is a
 * separate setting, so a configured id is split before it is applied: the model the agent offers, and the level the slug carried.
 *
 * An id the agent offers as it is stays as it is (grok's ids; an agent that does list the variants). Null: neither the id nor
 * its base is offered, so there is nothing to apply and the caller says so.
 */
export function splitAcpModel(value: string, offered: readonly string[]): { model: string; level?: string } | null {
  if (offered.includes(value)) return { model: value };
  const variant = agyVariantOf(value);
  if (variant && offered.includes(variant.base)) return { model: variant.base, level: variant.level };
  return null;
}
