/**
 * #2163: the skills AgEnD ships (general-knowledge/skills/<name>/SKILL.md, next to this file in src/ and dist/), read
 * on demand. Where a CLI has no skill folder, or a workspace AgEnD does not manage gets none published, an agent still
 * reads one with `agend-agent skill <name>`. Read-only and local: no fleet call, nothing written. A skill is
 * documentation shipped in the package, so any instance may read any of them (no role gate: nothing to protect).
 * #2799: one text per skill (Canvas Worker effects were removed, and with them the skills' alternate text).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

export const BUNDLED_SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), "general-knowledge", "skills");
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** #2275: managed publishers call this only after their normal ownership checks: the shipped SKILL.md, byte for byte. */
export function bundledSkillContents(skillDir: string): string {
  return readFileSync(join(skillDir, "SKILL.md"), "utf-8");
}

/** The bundled skills: name and the description from their current frontmatter. */
export function listBundledSkills(dir: string = BUNDLED_SKILLS_DIR): Array<{ name: string; description: string }> {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(n => NAME.test(n) && existsSync(join(dir, n, "SKILL.md"))).sort().map(name => {
    const head = bundledSkillContents(join(dir, name)).match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
    const description = head.match(/^description:[ \t]*(.*)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
    return { name, description };
  });
}

/** One bundled skill's SKILL.md, whole; or why not (a name that is not one of them). */
export function readBundledSkill(name: string, dir: string = BUNDLED_SKILLS_DIR): { ok: true; text: string } | { ok: false; error: string } {
  const known = listBundledSkills(dir).map(s => s.name);
  if (!NAME.test(name) || !known.includes(name)) return { ok: false, error: `no bundled skill "${name.slice(0, 64)}" — one of: ${known.join(", ")}` };
  return { ok: true, text: bundledSkillContents(join(dir, name)) };
}

/** The roles a bundled skill is published to (the `roles:` line of its frontmatter). */
export type BundledSkillRole = "general" | "worker" | "classic";

/**
 * AGEND-248: AgEnD's `roles` extension in a SKILL.md frontmatter, one rule for the publisher and the library overview. A skill with no
 * `roles` is General's only; a malformed or unknown value fails closed to General only too (`error` says why), so an administrative
 * skill never reaches a worker by a typo.
 */
export function parseBundledSkillRoles(text: string): { roles: BundledSkillRole[]; error?: unknown } {
  const fallback: BundledSkillRole[] = ["general"];
  try {
    const match = text.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!match) return { roles: fallback };
    const document = parseDocument(match[1]!);
    if (document.errors.length > 0) throw document.errors[0];
    const frontmatter = document.toJS() as { roles?: unknown } | null;
    if (!frontmatter || frontmatter.roles === undefined) return { roles: fallback };
    if (!Array.isArray(frontmatter.roles)) throw new Error("roles must be an array");
    const roles = [...new Set(frontmatter.roles)]
      .filter((value): value is BundledSkillRole => value === "general" || value === "worker" || value === "classic");
    if (roles.length !== frontmatter.roles.length || roles.length === 0) {
      throw new Error("roles must contain only general, worker and/or classic");
    }
    return { roles };
  } catch (error) {
    return { roles: fallback, error };
  }
}
