import { credentialProfileLaunchAt } from "../../backend/credential-profile.js";
import type { AdapterCapabilities } from "../types.js";

/**
 * The name an ACP instance's own MCP server is declared under in `session/new`. It is deliberately not `agend`, the name
 * every tmux backend writes into its config files: grok merges the project's `.mcp.json` over what the client passes, by
 * name, so a leftover tmux `agend` entry (a launch shim that needs variables only a tmux launch sets, shared by every
 * instance in that folder) replaced the ACP one and the agent started with no tools. A name no tmux backend writes cannot
 * collide with anything they leave behind, and nothing of theirs has to be edited or removed (the file can be shared with
 * a tmux instance that is running). Tools are named `<name>__<tool>` by grok and `mcp_<name>_<tool>` by agy.
 */
export const ACP_MCP_SERVER_NAME = "agend_acp";

/**
 * One launch profile per CLI that ships official ACP. A profile is data: how to start the CLI's ACP server, which
 * versions are known to behave, and what that CLI's `initialize` answer looks like. The shared client does the rest.
 */
export interface AcpProfile {
  readonly id: "grok" | "agy";
  /** The `backend` value this profile serves. */
  readonly backend: string;
  /** Name used in messages. */
  readonly label: string;
  /** The binary's name, for locating it. */
  readonly binary: string;
  /** Exact versions this profile has been checked against (an allow-list, not a range). Others are refused. */
  readonly supportedVersions: readonly string[];
  /** Arguments after the binary. */
  args(options: { model?: string; effort?: string; skipPermissions?: boolean }): string[];
  /** The agent's version as it reports it in the `initialize` result, or null when it does not. */
  versionOf(initializeResult: unknown): string | null;
  /** Environment variables (besides the common ones) this CLI needs to reach its account or endpoint. */
  readonly passEnv: readonly (string | RegExp)[];
  /** Variables always set on the child (after the allow-list). */
  readonly fixedEnv?: Readonly<Record<string, string>>;
  /**
   * How a NAMED account (`backend_options.<cli>.credential_profile`) is told to the CLI, given the account's own folder: the
   * variables it is started with and the arguments that go right after the binary. Everything the CLI keeps for that sign-in
   * (login, sessions) lives in that folder. A profile without it cannot run a named account.
   */
  accountLaunch?(folder: string): { env: Record<string, string>; args: string[] } | null;
  /**
   * How a message is added to the turn that is running, without cancelling it (ACP itself has none). `method`: the CLI's own extension (grok).
   * `prompt`: a second `session/prompt` for the same session while the first is outstanding, which the CLI folds into the running turn (agy). Absent:
   * an interruption can only be `session/cancel` and a new prompt. Only valid while a `session/prompt` is outstanding.
   */
  readonly interject?:
    | {
      readonly via: "method";
      readonly method: string;
      params(sessionId: string, text: string): unknown;
      /** Whether the CLI's answer says the message was taken into the turn. */
      accepted(result: unknown): boolean;
    }
    | { readonly via: "prompt" };
  /** What the instance can do under this profile. */
  readonly capabilities: AdapterCapabilities;
  /**
   * The context window (tokens) of the session's current model, read from what the CLI sends when it opens a session and when its
   * models change (grok: `models` of `session/new`, and `_x.ai/models/update`), for a CLI whose usage reports carry no window of their
   * own. Absent: the usage report carries its own (`usage_update.size`).
   */
  contextWindowOf?(models: unknown): number | null;
  /**
   * How the per-instance `agend` MCP server may be declared in `session/new`: stdio always works; http / sse only
   * when the agent advertised `mcpCapabilities` for it (agy advertises none, so only stdio).
   */
  readonly mcpTransport: "stdio";
  /**
   * When the CLI starts the MCP servers a `session/new` declares. `with_session`: while the session opens (grok), so a server
   * that is still not connected 45 s later is missing. `first_prompt`: only when the first prompt arrives (agy builds its
   * toolbox per turn), so an instance nobody has written to yet is not a missing server, and the check waits for a turn.
   */
  readonly mcpConnects: "with_session" | "first_prompt";
}

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null);

const COMMON: AdapterCapabilities = {
  steer: false, // no mid-turn input is defined by ACP: a message sent during a turn waits for it to end
  livePermissions: true,
  liveThought: true,
  contextUsage: false,
  quota: false,
  paneView: false,
};

export const GROK_PROFILE: AcpProfile = {
  id: "grok",
  backend: "grok",
  label: "grok",
  binary: "grok",
  supportedVersions: ["1.0.77"],
  // --no-auto-update: the allow-list above is exact, so the CLI must not move to another version by itself.
  // --no-leader: this process is the only client and owns its own MCP children (no shared leader to leak identity).
  // --always-approve: `skipPermissions` (default on, as for the tmux backend, src/backend/grok.ts). The runner's own answer is the backstop.
  args: ({ model, effort, skipPermissions }) => ["--no-auto-update", "agent", "--no-leader", ...(skipPermissions !== false ? ["--always-approve"] : []), ...(model ? ["--model", model] : []), ...(effort ? ["--reasoning-effort", effort] : []), "stdio"],
  versionOf: result => {
    const v = obj(obj(result)?._meta)?.agentVersion;
    return typeof v === "string" ? v : null;
  },
  // grok's `_x.ai/interject` {sessionId, text} → {"result": {"status": "queued"}}: the message joins the running turn at its next safe point, the tool call that was
  // running is not cancelled (measured on 1.0.77: one turn, one `end_turn`, the answer covers both messages). Not announced in `initialize` (grok 1.0.14+).
  interject: { via: "method", method: "_x.ai/interject", params: (sessionId, text) => ({ sessionId, text }), accepted: result => (obj(obj(result)?.result) ?? obj(result))?.status === "queued" },   // grok wraps the answer: `{"result":{"status":"queued"}}` (1.0.77)
  passEnv: ["XAI_API_KEY", /^GROK_/],
  // grok reports each model call's tokens in its own `_x.ai/session_notification`, and the current model's window in `models` (`_meta.totalContextTokens`).
  contextWindowOf: models => {
    const m = obj(models);
    const current = typeof m?.currentModelId === "string" ? m.currentModelId : null;
    const list = Array.isArray(m?.availableModels) ? m.availableModels : [];
    const entry = list.map(obj).find(e => e && e.modelId === current);
    const size = obj(entry?._meta)?.totalContextTokens;
    return typeof size === "number" && Number.isFinite(size) && size > 0 ? size : null;
  },
  // grok keeps its login (`auth.json`), sessions and settings under GROK_HOME (default ~/.grok); checked with grok 1.0.77: a fresh GROK_HOME answers "You are not authenticated".
  accountLaunch: folder => ({ env: { GROK_HOME: folder }, args: [] }),
  capabilities: { ...COMMON, contextUsage: true },
  mcpTransport: "stdio",
  mcpConnects: "with_session",
};

export const AGY_PROFILE: AcpProfile = {
  id: "agy",
  backend: "antigravity",
  label: "agy",
  binary: "agy",
  supportedVersions: ["1.5.8", "1.5.9"],
  // --dangerously-skip-permissions: listed by `agy acp --help` ("Auto-approve all tool permission requests"); `skipPermissions`, as for the tmux backend.
  args: ({ skipPermissions }) => ["acp", ...(skipPermissions !== false ? ["--dangerously-skip-permissions"] : [])],
  // agy has no flag to stop its self-update, but the binary reads this variable (not exercised: no newer release was
  // available to update to). Without it, an update moves the instance off the exact version list above.
  fixedEnv: { AGY_CLI_DISABLE_AUTO_UPDATE: "1" },
  versionOf: result => {
    const v = obj(obj(result)?.agentInfo)?.version;
    return typeof v === "string" ? v : null;
  },
  // agy folds a second `session/prompt` sent for the same session while the first runs into the running turn: the tool in progress is not cancelled, the first request is
  // answered `end_turn` at once and the work goes on, and the second request answers (`end_turn`) when everything is done (measured on 1.5.9). See `AcpAdapter.interject`.
  interject: { via: "prompt" },
  passEnv: ["GEMINI_API_KEY", "GOOGLE_API_KEY", /^GOOGLE_/, /^ANTIGRAVITY_/],
  // The same launch the terminal backend gives a named agy account (`--app_data_dir <folder relative to ~/.gemini>` right after the binary, and the registry's pin that keeps the sign-in in the folder's file).
  accountLaunch: folder => credentialProfileLaunchAt("antigravity", folder),
  capabilities: { ...COMMON, contextUsage: true },
  mcpTransport: "stdio",
  mcpConnects: "first_prompt",
};

const PROFILES: readonly AcpProfile[] = [GROK_PROFILE, AGY_PROFILE];

export function acpProfileFor(backend: string): AcpProfile | undefined {
  return PROFILES.find(p => p.backend === backend);
}

export type VersionVerdict = { ok: true; version: string } | { ok: false; message: string };

/** The version gate: an unlisted version is refused with a message that says what to do, never run anyway. */
export function checkVersion(profile: AcpProfile, initializeResult: unknown): VersionVerdict {
  const version = profile.versionOf(initializeResult);
  const listed = profile.supportedVersions.join(", ");
  if (!version) {
    return { ok: false, message: `${profile.label} did not report its version in the ACP handshake, so it cannot be checked against the supported list (${listed}). Set cli_adapter to tmux for this instance, or use a listed version.` };
  }
  if (!profile.supportedVersions.includes(version)) {
    return { ok: false, message: `${profile.label} ${version} is not on the supported list for cli_adapter: acp (${listed}). It is not started, and it does not fall back to tmux. Use a listed version, or set cli_adapter to tmux for this instance.` };
  }
  return { ok: true, version };
}

const COMMON_ENV: readonly (string | RegExp)[] = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", /^LC_/, "TMPDIR", "TZ",
  /^XDG_/, "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
  /^https?_proxy$/i, /^no_proxy$/i, "WSL_DISTRO_NAME", "WSL_INTEROP",
];

/**
 * The child's whole environment, built from an allow-list: common process basics plus what this CLI needs for its
 * account. Fleet tokens, web secrets and other instances' variables are not passed on.
 */
export function buildChildEnv(profile: AcpProfile, source: NodeJS.ProcessEnv, extra: Readonly<Record<string, string>> = {}, named = false): Record<string, string> {
  const env: Record<string, string> = {};
  // A NAMED account is its own sign-in: the variables that reach the default account (an API key, the CLI's home) are not passed on, so it can never run under them.
  const wanted = [...COMMON_ENV, ...(named ? [] : profile.passEnv)];
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (wanted.some(w => (typeof w === "string" ? w === key : w.test(key)))) env[key] = value;
  }
  env.TERM = "dumb";
  return { ...env, ...profile.fixedEnv, ...extra };
}
