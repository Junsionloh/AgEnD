import type { AdapterCapabilities } from "../types.js";

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
  args(options: { model?: string; effort?: string }): string[];
  /** The agent's version as it reports it in the `initialize` result, or null when it does not. */
  versionOf(initializeResult: unknown): string | null;
  /** Environment variables (besides the common ones) this CLI needs to reach its account or endpoint. */
  readonly passEnv: readonly (string | RegExp)[];
  /** Variables always set on the child (after the allow-list). */
  readonly fixedEnv?: Readonly<Record<string, string>>;
  /** What the instance can do under this profile. */
  readonly capabilities: AdapterCapabilities;
  /**
   * How the per-instance `agend` MCP server may be declared in `session/new`: stdio always works; http / sse only
   * when the agent advertised `mcpCapabilities` for it (agy advertises none, so only stdio).
   */
  readonly mcpTransport: "stdio";
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
  args: ({ model, effort }) => ["--no-auto-update", "agent", "--no-leader", ...(model ? ["--model", model] : []), ...(effort ? ["--reasoning-effort", effort] : []), "stdio"],
  versionOf: result => {
    const v = obj(obj(result)?._meta)?.agentVersion;
    return typeof v === "string" ? v : null;
  },
  passEnv: ["XAI_API_KEY", /^GROK_/],
  capabilities: { ...COMMON, contextUsage: false },
  mcpTransport: "stdio",
};

export const AGY_PROFILE: AcpProfile = {
  id: "agy",
  backend: "antigravity",
  label: "agy",
  binary: "agy",
  supportedVersions: ["1.5.8", "1.5.9"],
  args: () => ["acp"],
  // agy has no flag to stop its self-update, but the binary reads this variable (not exercised: no newer release was
  // available to update to). Without it, an update moves the instance off the exact version list above.
  fixedEnv: { AGY_CLI_DISABLE_AUTO_UPDATE: "1" },
  versionOf: result => {
    const v = obj(obj(result)?.agentInfo)?.version;
    return typeof v === "string" ? v : null;
  },
  passEnv: ["GEMINI_API_KEY", "GOOGLE_API_KEY", /^GOOGLE_/, /^ANTIGRAVITY_/],
  capabilities: { ...COMMON, contextUsage: true },
  mcpTransport: "stdio",
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
export function buildChildEnv(profile: AcpProfile, source: NodeJS.ProcessEnv, extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  const wanted = [...COMMON_ENV, ...profile.passEnv];
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (wanted.some(w => (typeof w === "string" ? w === key : w.test(key)))) env[key] = value;
  }
  env.TERM = "dumb";
  return { ...env, ...profile.fixedEnv, ...extra };
}
