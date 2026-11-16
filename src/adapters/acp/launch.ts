import { appendFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dashboardAccessOf, dashboardFeaturesOff } from "../../dashboard-permissions.js";
import { buildFleetInstructions, type FleetInstructionsParams } from "../../instructions.js";
import { assembleSystemPrompt, resolveWorkflowText } from "../../prompt-file-ref.js";
import { resolveToolSet } from "../../tool-permissions.js";
import { scopedFleetConfigEnvironment } from "../../web-experimental.js";
import type { InstanceConfig } from "../../types.js";
import type { AcpMcpServer } from "./acp-adapter.js";
import { ACP_MCP_SERVER_NAME } from "./profiles.js";

export { ACP_MCP_SERVER_NAME };

const here = dirname(fileURLToPath(import.meta.url));

export interface AcpLaunchInput {
  readonly name: string;
  readonly config: InstanceConfig;
  readonly instanceDir: string;
  readonly runtimeIdentity: NonNullable<FleetInstructionsParams["runtimeIdentity"]>;
  readonly decisions?: { title: string; content: string }[];
  readonly statusEmojis?: string[];
  readonly agendVersion?: string;
}

export interface AcpLaunchParts {
  /** This instance's own `agend` MCP server for `session/new`: its identity is in the entry, nowhere shared. */
  readonly mcpServers: readonly AcpMcpServer[];
  /** The fleet instructions, put in front of the first prompt of a new session. */
  readonly preamble: string;
}

/** The compiled MCP server the CLIs start (`dist/channel/mcp-server.js` next to this build, or the repo's `dist`). */
export function mcpServerPath(): string {
  const candidates = [
    join(here, "..", "..", "channel", "mcp-server.js"),
    join(here, "..", "..", "..", "dist", "channel", "mcp-server.js"),
  ];
  return candidates.find(existsSync) ?? candidates[0]!;
}

/**
 * What an ACP instance is launched with: the `agend` MCP server declared in `session/new` (the same server, with the
 * same per-instance environment, the tmux backends write into their own config files) and the instructions that tmux
 * backends inject as a system prompt. ACP has no system-prompt field, so they go in front of the first prompt.
 */
export function buildAcpLaunch(input: AcpLaunchInput, serverJs = mcpServerPath()): AcpLaunchParts {
  const { name, config, instanceDir, runtimeIdentity } = input;
  const promptFiles = {
    workingDirectory: config.working_directory,
    fleetCwd: process.cwd(),
    onWarning: () => { /* the tmux path reports these; the content just comes out empty */ },
  };
  let workflow: string | false | undefined;
  if (config.workflow === false) workflow = false;
  else { const w = config.workflow ?? "builtin"; if (w !== "builtin") workflow = resolveWorkflowText(w, promptFiles) || undefined; }
  const customPrompt = config.systemPrompt ? assembleSystemPrompt(config.systemPrompt, promptFiles) : undefined;
  const fleetEnv = scopedFleetConfigEnvironment(join(instanceDir, "..", ".."));
  const isGeneral = config.general_topic === true || name === "general";
  const toolSet = isGeneral ? resolveToolSet(config, name, "general") : resolveToolSet(config, name);
  const off = dashboardFeaturesOff(dashboardAccessOf(config));

  const env: Record<string, string> = {
    AGEND_FLEET_DATA_DIR: fleetEnv.AGEND_FLEET_DATA_DIR ?? "",
    AGEND_FLEET_CONFIG_PATH: fleetEnv.AGEND_FLEET_CONFIG_PATH ?? "",
    AGEND_SOCKET_PATH: join(instanceDir, "channel.sock"),
    AGEND_INSTANCE_NAME: name,
    AGEND_WORKING_DIR: config.working_directory,
    AGEND_INSTANCE_KIND: runtimeIdentity.kind,
    AGEND_BACKEND: runtimeIdentity.backend,
    AGEND_MODEL: runtimeIdentity.model,
    AGEND_TOOL_SET: toolSet,
  };
  if (off.length) env.AGEND_DASHBOARD_OFF = off.join(",");
  if (config.display_name) env.AGEND_DISPLAY_NAME = config.display_name;
  if (config.description) env.AGEND_DESCRIPTION = config.description;
  if (workflow === false) env.AGEND_WORKFLOW = "false"; else if (workflow) env.AGEND_WORKFLOW = workflow;
  if (customPrompt) env.AGEND_CUSTOM_PROMPT = customPrompt;
  if (input.decisions?.length) env.AGEND_DECISIONS = JSON.stringify(input.decisions);

  const preamble = buildFleetInstructions({
    instanceName: name,
    taskBoard: !off.includes("task_board"),
    workingDirectory: config.working_directory,
    runtimeIdentity,
    displayName: config.display_name,
    description: config.description,
    customPrompt,
    workflow,
    decisions: input.decisions,
    statusEmojis: input.statusEmojis,
    ...(input.agendVersion ? { agendVersion: input.agendVersion } : {}),
  });

  return {
    mcpServers: [{
      name: ACP_MCP_SERVER_NAME,
      // The Node this process runs on, as the tmux backends do: not a `node` from PATH.
      command: process.execPath,
      args: [serverJs],
      env: Object.entries(env).map(([n, value]) => ({ name: n, value })),
    }],
    preamble: `[fleet instructions for this session — follow them; they are not a message from the user]\n${preamble}\n${toolNameHint(runtimeIdentity.backend)}\n[end of fleet instructions]`,
  };
}

/**
 * The agend tools are the MCP server `agend_acp` here, and each CLI prefixes its tools' names with the server's: said once
 * in the instructions, so the agent calls `reply` by its full name instead of searching its tool list for it first
 * (which cost grok four model calls before the first reply).
 */
export function toolNameHint(backend: string): string {
  const full = (tool: string): string => backend === "grok" ? `${ACP_MCP_SERVER_NAME}__${tool}` : `mcp_${ACP_MCP_SERVER_NAME}_${tool}`;
  return `Your agend tools (reply, set_display_name, send_to_instance and the rest of the list above) come from the MCP server "${ACP_MCP_SERVER_NAME}" and are called by their full names: ${full("reply")}, ${full("set_display_name")}, ${full("<tool>")}. Use them by those names; do not search for them or for a differently named reply tool.`;
}

/** A debugging sink for `AGEND_ACP_TRACE=1`: one JSON line per frame, in the instance directory, readable by its owner only. */
export function acpTraceSink(instanceDir: string): (direction: "in" | "out", line: string) => void {
  const file = join(instanceDir, "acp-trace.jsonl");
  return (direction, line) => {
    try { appendFileSync(file, JSON.stringify({ t: Date.now(), dir: direction, line }) + "\n", { mode: 0o600 }); } catch { /* tracing never breaks a turn */ }
  };
}
