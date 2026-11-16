import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import * as nodePath from "node:path";
import { dirname, resolve, sep } from "node:path";
import { credentialHomeSpec, credentialProfileHome, credentialProfileLoginCommand, prepareCredentialProfileHome, resolveCredentialProfile } from "../../backend/credential-profile.js";
import type { AcpProfile } from "./profiles.js";

/** What an ACP instance's child is started with for a named account (AGEND-279). */
export interface AcpAccountLaunch {
  /** The account's name (`backend_options.<cli>.credential_profile`). */
  readonly name: string;
  /** The account's own folder under AgEnD's `credential-profiles`: its sign-in and everything else the CLI keeps for it. */
  readonly folder: string;
  readonly env: Record<string, string>;
  readonly args: string[];
  /** The shell line that signs this account in, for the "not signed in" message. */
  readonly loginCommand: string;
}

/**
 * The named account an ACP instance runs as, or null for the CLI's own sign-in (nothing is created and nothing is added: the child
 * starts exactly as before). The account's folder is a real folder of its own and never a link: a link would make it another
 * account's. grok is told its folder by `GROK_HOME`; agy by `--app_data_dir` (the terminal backend's own launch). Throws for a name
 * that is not a valid profile name, and for a CLI profile that cannot take an account.
 */
/**
 * Every level from the AgEnD home down to the account's folder (`credential-profiles`, `credential-profiles/<cli>`, `<name>`) is a real directory that
 * stays under the home: a link at any level would make the account share another place's sign-in. Looked at before anything is made and again after
 * (the folder is created in between), so a link put there in the meantime is seen too.
 */
/**
 * Whether `real` lies under `realHome`. On Windows `relative()` between two drives is not a `..` path but the other drive's absolute path (so it must
 * also be refused when it is absolute); `api` is the path module to judge with (a test passes `path.win32`).
 */
export function isUnder(realHome: string, real: string, api: Pick<typeof nodePath, "relative" | "resolve" | "isAbsolute"> = nodePath): boolean {
  const inside = api.relative(realHome, real);
  return inside !== "" && !inside.startsWith("..") && !api.isAbsolute(inside) && api.resolve(realHome, inside) === real;
}

function assertIsolated(agendHome: string, folder: string): void {
  const home = resolve(agendHome);
  const levels: string[] = [];
  for (let at = resolve(folder); at !== home && at.startsWith(home + sep); at = dirname(at)) levels.unshift(at);
  for (const level of levels) {
    let link = false;
    try { link = lstatSync(level).isSymbolicLink(); } catch { /* absent: created below, checked again after */ }
    if (link) throw new Error(`credential profile path is a symlink, so it is not isolated: ${level}. Remove the link and let AgEnD create a real directory.`);
  }
  let real: string | null = null;
  try { real = realpathSync(folder); } catch { /* not there yet */ }
  if (real !== null) {
    let realHome = home;
    try { realHome = realpathSync(home); } catch { /* the home itself is not there */ }
    if (!isUnder(realHome, real)) throw new Error(`credential profile folder resolves outside the AgEnD home: ${folder}`);
  }
}

export function acpAccountLaunch(profile: AcpProfile, agendHome: string, backendOptions: Record<string, unknown> | undefined): AcpAccountLaunch | null {
  const name = resolveCredentialProfile(backendOptions);
  if (!name) return null;
  if (!profile.accountLaunch) throw new Error(`cli_adapter: acp for ${profile.label} cannot run a named account (backend_options.${profile.backend}.credential_profile)`);
  const folder = credentialProfileHome(agendHome, profile.backend, name);
  assertIsolated(agendHome, folder);
  const spec = credentialHomeSpec(profile.backend);
  if (spec) prepareCredentialProfileHome(spec, folder);
  else mkdirSync(folder, { recursive: true, mode: 0o700 });
  assertIsolated(agendHome, folder);
  const launch = profile.accountLaunch(folder);
  if (!launch) throw new Error(`cli_adapter: acp could not set up the named account "${name}" for ${profile.label} on this host`);
  const env = Object.entries(launch.env).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ");
  const loginCommand = credentialProfileLoginCommand(agendHome, profile.backend, name)
    ?? [env, profile.binary, ...launch.args.map(a => JSON.stringify(a)), "login", "--device-auth"].filter(Boolean).join(" ");
  return { name, folder, env: launch.env, args: launch.args, loginCommand };
}
