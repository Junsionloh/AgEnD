/**
 * AGEND-242 — environment isolation for agent processes: what an agent's process would no longer inherit from the
 * daemon's environment (Telegram/Discord bot tokens, tunnel tokens, other providers' API keys, …).
 *
 * This first step is "off by default, then a dry run": `env_isolation: off` (or unset) changes nothing at all, and
 * `dry-run` only REPORTS the variable NAMES an allowlist would remove — the environment, and the launch command, stay
 * exactly as they are. An enforcing `allowlist` mode is a later, separate change; until it exists the value is
 * accepted and treated as `off` (so a config written ahead of time never breaks a start).
 *
 * Nothing in this file ever holds, returns or logs a variable VALUE: it only reads `Object.keys(env)`.
 */

export const ENV_ISOLATION_MODES = ["off", "dry-run", "allowlist"] as const;
export type EnvIsolationMode = typeof ENV_ISOLATION_MODES[number];

/** The modes that exist today. `allowlist` is reserved (see above). */
export type EnvIsolationEffect = "off" | "dry-run";

export function isEnvIsolationMode(value: unknown): value is EnvIsolationMode {
  return typeof value === "string" && (ENV_ISOLATION_MODES as readonly string[]).includes(value);
}

/** A name that can be an environment variable in a shell command: also the only kind this module will ever print. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
export function isEnvVariableName(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && ENV_NAME.test(value);
}

/**
 * Base allowlist — what a CLI needs to start, find files and reach the network, whatever its backend.
 *
 * It follows the Windows native pane's `NATIVE_ENV_ALLOWED` (PR #2939, src/windows-cli-worker.ts): the same three
 * groups (where things are / the network the user configured / language and terminal), with the POSIX spellings of the
 * first and both cases of the proxy names (POSIX tools read the lowercase ones). tests/env-isolation.test.ts keeps the
 * network and language groups from drifting away from that set.
 */
export const ENV_ALLOWED_BASE: ReadonlySet<string> = new Set([
  // Where it is, how it finds programs, who and where the user is.
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "PWD", "TMPDIR", "TMP", "TEMP", "HOSTNAME",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR",
  "DISPLAY", "WAYLAND_DISPLAY",
  // WSL: a Linux CLI that starts a Windows .exe needs these.
  "WSL_DISTRO_NAME", "WSL_INTEROP", "WSLENV",
  // The network the user configured: proxies and certificate stores.
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
  // Language and terminal.
  "LANG", "LANGUAGE", "TZ", "TERM", "COLORTERM", "NO_COLOR", "FORCE_COLOR", "TERMINFO", "TERMINFO_DIRS",
  // Node version managers: a CLI started from a shell shim looks for its own node through these.
  "NVM_DIR", "NVM_BIN", "NVM_INC",
]);

/** Whole families kept by prefix: the locale, and AgEnD's own variables for the agent (socket, instance name, port…). */
const ENV_ALLOWED_PREFIXES: readonly string[] = ["LC_", "AGEND_"];

/**
 * What each backend's own CLI reads for its config directory and its LLM credentials — the variables an isolated
 * environment must still hand it. Best-effort: from what each backend's code reads or injects and what each CLI
 * documents. A gap shows up in the dry run as a name it "would remove"; the person then adds it to `env_passthrough`.
 */
export const ENV_ALLOWED_BY_BACKEND: Readonly<Record<string, readonly string[]>> = {
  "claude-code": ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CONFIG_DIR"],
  codex: ["CODEX_HOME", "OPENAI_API_KEY", "OPENAI_BASE_URL"],
  opencode: ["OPENCODE_CONFIG_DIR"],
  "kiro-cli": ["KIRO_HOME"],
  antigravity: ["GEMINI_HOME", "GEMINI_API_KEY", "GOOGLE_API_KEY"],
  grok: ["GROK_HOME", "XAI_API_KEY"],
  muse: [],
  mock: ["MOCK_RESPONSE", "MOCK_DELAY"],
};

/** What `env_isolation` resolves to for one instance: a value that is not a known mode is `off`, never an error. */
export function resolveEnvIsolation(configured: unknown): { mode: EnvIsolationEffect; requested: EnvIsolationMode | null } {
  if (!isEnvIsolationMode(configured)) return { mode: "off", requested: null };
  // `allowlist` is reserved for the enforcing follow-up: today it behaves as `off`.
  return { mode: configured === "dry-run" ? "dry-run" : "off", requested: configured };
}

/** The usable names of `env_passthrough` (an instance's own list; anything that is not a valid name is dropped). */
export function envPassthroughNames(configured: unknown): string[] {
  if (!Array.isArray(configured)) return [];
  return [...new Set(configured.filter(isEnvVariableName))];
}

export function isEnvAllowed(name: string, backend?: string, passthrough: readonly string[] = []): boolean {
  if (ENV_ALLOWED_BASE.has(name)) return true;
  if (ENV_ALLOWED_PREFIXES.some(prefix => name.startsWith(prefix))) return true;
  if (backend && ENV_ALLOWED_BY_BACKEND[backend]?.includes(name)) return true;
  return passthrough.includes(name);
}

export interface EnvIsolationReport {
  mode: "dry-run";
  backend: string | null;
  /** Names an enforcing allowlist would remove from the agent's environment, sorted. Never values. */
  wouldRemove: string[];
  /** How many variables the allowlist would keep. */
  keptCount: number;
  /** Variables whose name is not a plain identifier: counted, not printed. */
  unnamedCount: number;
  /** The names the instance's `env_passthrough` asked to keep that exist in this environment. */
  passthroughApplied: string[];
}

/** The dry-run: reads only the NAMES in `env` and returns what an allowlist would remove. `env` is never modified. */
export function planEnvIsolation(
  env: NodeJS.ProcessEnv,
  opts: { backend?: string; passthrough?: readonly string[] } = {},
): EnvIsolationReport {
  const passthrough = opts.passthrough ?? [];
  const wouldRemove: string[] = [];
  const passthroughApplied: string[] = [];
  let keptCount = 0;
  let unnamedCount = 0;
  for (const name of Object.keys(env)) {
    if (env[name] === undefined) continue;
    if (!isEnvVariableName(name)) { unnamedCount++; continue; }
    if (isEnvAllowed(name, opts.backend)) keptCount++;
    else if (passthrough.includes(name)) { keptCount++; passthroughApplied.push(name); }
    else wouldRemove.push(name);
  }
  wouldRemove.sort();
  passthroughApplied.sort();
  return { mode: "dry-run", backend: opts.backend ?? null, wouldRemove, keptCount, unnamedCount, passthroughApplied };
}

export interface EnvIsolationLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

/**
 * The one call at the launch point. Returns the launch command UNCHANGED in every mode that exists today — `off`,
 * `dry-run` and the reserved `allowlist` — so enabling this can never alter an agent's command or environment; in
 * `dry-run` it additionally logs the names it would have removed.
 */
export function applyEnvIsolation(input: {
  command: string;
  env: NodeJS.ProcessEnv;
  config: { env_isolation?: unknown; env_passthrough?: unknown; backend?: string };
  logger?: EnvIsolationLogger;
}): string {
  const { mode, requested } = resolveEnvIsolation(input.config.env_isolation);
  if (requested === "allowlist") {
    input.logger?.warn({ env_isolation: requested }, "env_isolation: allowlist is not available yet — the environment is left as it is (use dry-run to preview)");
  }
  if (mode === "dry-run") {
    const report = planEnvIsolation(input.env, { backend: input.config.backend, passthrough: envPassthroughNames(input.config.env_passthrough) });
    input.logger?.info(
      { ...report },
      `env_isolation dry-run: ${report.wouldRemove.length} variable(s) would be removed from the agent's environment, ${report.keptCount} kept (names only; nothing was changed)`,
    );
  }
  return input.command;
}
