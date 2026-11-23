/**
 * AGEND-340: a signed-in account that no agent uses is not a signed-in agent.
 *
 * Settings → Accounts signs a CLI in under a NAMED credential profile; that login is not applied to any agent. An agent that names
 * no profile (and whose fleet default names none) runs on the CLI's default sign-in, which may be signed out: it then sits at the
 * CLI's sign-in screen and is paused (`CLI is waiting at its sign-in screen`), and nothing says why or what to do — the account the
 * person just signed in is right there, unused.
 *
 * The hint says so, and only says so: it never chooses an account for an agent (with several accounts the pick would be a guess).
 * Pure: the host's facts come in, the hint (or null) goes out, so every case is a test. `FleetManager.accountHintFor` reads the facts.
 */
import type { AvailabilityState } from "./backend-availability.js";

export interface AccountHint {
  /** The CLI the agent runs on (`claude-code`, `codex`, `grok`, `antigravity`, …). */
  backend: string;
  /** The named accounts of that CLI that are signed in on this host, by name, in order. Never empty. */
  accounts: string[];
  /** The one account to offer as "Use <name>" — set only when exactly one is signed in (otherwise the person chooses). */
  only: string | null;
}

export interface AccountHintFacts {
  /** The agent's CLI, and the credential profile it ends up with (its own, else the fleet default's; null = the CLI's default sign-in). */
  agent: { backend: string; profile: string | null };
  /** The CLI's default sign-in on this host, as the sign-in list reads it. */
  defaultState: AvailabilityState | undefined;
  /** The CLI's named profiles on this host and whether each is signed in. Read only when the agent could be affected. */
  profiles: () => ReadonlyArray<{ profile: string; state: AvailabilityState }>;
}

/**
 * The hint for an agent, or null: it names an account of its own (nothing to say), the default sign-in works or cannot be told
 * to be signed out (only "not signed in" is certain: `unknown` and `not installed` are not this problem), or no named account of
 * that CLI is signed in (nothing to offer).
 */
export function accountHint(facts: AccountHintFacts): AccountHint | null {
  if (facts.agent.profile !== null) return null;
  if (facts.defaultState !== "not_signed_in") return null;
  const accounts = facts.profiles().filter(row => row.state === "usable").map(row => row.profile).sort((a, b) => a.localeCompare(b));
  if (!accounts.length) return null;
  return { backend: facts.agent.backend, accounts, only: accounts.length === 1 ? accounts[0]! : null };
}

const LABELS: Readonly<Record<string, string>> = { "claude-code": "Claude Code", codex: "Codex", antigravity: "Antigravity", grok: "Grok", "kiro-cli": "Kiro", opencode: "OpenCode", muse: "Muse" };
/** A CLI's name as the dashboard calls it (the id itself for one it has no name for). */
export const accountHintLabel = (backend: string): string => LABELS[backend] ?? backend;

/** The hint in words, for a notice or a toast (English, like the notices around it); the page words its own banner. `label`: the CLI's name. */
export function accountHintText(hint: AccountHint, agent: string, label: string): string {
  const who = hint.only ? `The ${label} account ${hint.only} is signed in` : `These ${label} accounts are signed in: ${hint.accounts.join(", ")}`;
  return `${label} is not signed in on this host, and ${agent} uses no account of its own, so it cannot start. ${who}: choose one for ${agent} in its settings (Details → Runtime → Account).`;
}
