/**
 * AGEND-248: where each backend natively loads on-demand skills from, relative to the workspace. One table, read by the skill
 * publishing in fleet-manager.ts and by the library overview (which says which agents cannot be given a skill).
 *
 * Backends without a native skill mechanism are deliberately absent: dropping files a CLI never reads is clutter, not
 * capability. Unknown directories are ignored by older CLI versions, so publishing is fail-open across upgrades.
 */
export const NATIVE_SKILLS_DIR_SEGMENTS: Record<string, string[]> = {
  "kiro-cli": [".kiro", "skills"],
  "claude-code": [".claude", "skills"],
  "codex": [".agents", "skills"],
  // Live-verified: OpenCode and Antigravity scan .agents/skills; Grok's
  // vendor-canonical location is .grok/skills.
  "opencode": [".agents", "skills"],
  "grok": [".grok", "skills"],
  // Live-verified on muse 1.3.0: `muse skills list --source project` sees
  // .agents/skills and ignores .muse/skills.
  "muse": [".agents", "skills"],
  "antigravity": [".agents", "skills"],
};

/** True when the backend reads skills from a folder in the workspace (own property only: a name from a config is not trusted). */
export function hasNativeSkillsDir(backend: unknown): boolean {
  return typeof backend === "string" && Object.hasOwn(NATIVE_SKILLS_DIR_SEGMENTS, backend);
}
