/**
 * AGEND-248: the Library page's overview — one read-only answer to "which skills, tools and MCP servers does this AgEnD have, and which
 * agents use them". It only READS: the bundled skills in the package, the tool profiles in tool-permissions.ts, and the fleet's
 * settings (`instances`). No agent's file, setting or launch command is touched, and nothing here is saved.
 *
 *  - bundled skills (src/general-knowledge/skills): name, description, the roles they are published to, and the agents that get them
 *    by role (General gets every one; any other agent gets those marked `worker`; a native Windows agent has no skills folder here);
 *  - tool profiles (`tool_set`): each profile and its tools, and the agents that run under it (resolveToolSet, the one rule the daemon uses);
 *  - the `agend` MCP server every agent is given (its tools are the profile's);
 *  - team skills' usage: `librarySkillUsage` (AGEND-244) — and, per agent, whether its CLI has a skills folder at all (a skill mounted on
 *    a backend without one cannot take effect).
 */
import { BUNDLED_SKILLS_DIR, listBundledSkills, parseBundledSkillRoles, readBundledSkill, type BundledSkillRole } from "../bundled-skills.js";
import { hasNativeSkillsDir } from "../native-skills-dir.js";
import { TOOL_PROFILES, resolveToolSet } from "../tool-permissions.js";
import { generalByName } from "../general-instance.js";
import { librarySkillUsage } from "./mount.js";

/** The fleet's `instances`, as far as the overview reads them. */
export type OverviewInstances = Record<string, {
  backend?: string; runtime?: string; general_topic?: boolean; tool_set?: string; library?: { skills?: unknown };
} | null | undefined>;

export interface OverviewAgent {
  name: string;
  backend: string;
  /** The skill role it is published to: "general" for the General, "worker" for every other agent. */
  role: "general" | "worker";
  toolSet: string;
  /** A native Windows agent: its CLI is on another PC, so no skills folder is written here. */
  windows: boolean;
  /** Its CLI reads skills from a folder in the workspace (false: a skill mounted on it cannot take effect). */
  nativeSkills: boolean;
}
export interface Overview {
  agents: OverviewAgent[];
  builtinSkills: Array<{ name: string; description: string; roles: BundledSkillRole[]; agents: string[] }>;
  toolSets: Array<{ name: string; tools: string[]; agents: string[] }>;
  mcp: Array<{ name: string; agents: string[] }>;
  /** `{ librarySkillId: [agent names] }`, only for ids mounted somewhere (librarySkillUsage). */
  teamUsage: Record<string, string[]>;
}

export interface OverviewInput {
  instances: OverviewInstances | null | undefined;
  /** The fleet's default backend, for an agent that names none. */
  defaultBackend?: string;
  /** Where the bundled skills are (tests point it at a fixture). */
  bundledDir?: string;
}

export function buildOverview(input: OverviewInput): Overview {
  const instances = input.instances ?? {};
  const agents: OverviewAgent[] = [];
  for (const name of Object.keys(instances).sort()) {
    const def = instances[name];
    if (!def) continue;
    const backend = def.backend ?? input.defaultBackend ?? "claude-code";
    const general = def.general_topic === true || generalByName(name, def);
    agents.push({
      name, backend, role: general ? "general" : "worker", toolSet: resolveToolSet(def, name),
      windows: def.runtime === "windows", nativeSkills: hasNativeSkillsDir(backend),
    });
  }
  const publishing = agents.filter(a => !a.windows);
  const dir = input.bundledDir ?? BUNDLED_SKILLS_DIR;
  const builtinSkills = listBundledSkills(dir).map(({ name, description }) => {
    const read = readBundledSkill(name, dir);
    const roles = read.ok ? parseBundledSkillRoles(read.text).roles : (["general"] as BundledSkillRole[]);
    return { name, description, roles, agents: publishing.filter(a => roles.includes(a.role)).map(a => a.name) };
  });
  const toolSets = (Object.keys(TOOL_PROFILES) as Array<keyof typeof TOOL_PROFILES>).map(name => ({
    name, tools: [...TOOL_PROFILES[name]], agents: agents.filter(a => a.toolSet === name).map(a => a.name),
  }));
  return {
    agents, builtinSkills, toolSets,
    mcp: [{ name: "agend", agents: agents.map(a => a.name) }],
    teamUsage: { ...librarySkillUsage(instances as never) },
  };
}
