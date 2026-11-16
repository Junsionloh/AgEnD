import { lstatSync, mkdirSync } from "node:fs";
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
export function acpAccountLaunch(profile: AcpProfile, agendHome: string, backendOptions: Record<string, unknown> | undefined): AcpAccountLaunch | null {
  const name = resolveCredentialProfile(backendOptions);
  if (!name) return null;
  if (!profile.accountLaunch) throw new Error(`cli_adapter: acp for ${profile.label} cannot run a named account (backend_options.${profile.backend}.credential_profile)`);
  const folder = credentialProfileHome(agendHome, profile.backend, name);
  const spec = credentialHomeSpec(profile.backend);
  if (spec) prepareCredentialProfileHome(spec, folder);
  else {
    let link = false;
    try { link = lstatSync(folder).isSymbolicLink(); } catch { /* absent: created below */ }
    if (link) throw new Error(`credential profile path is a symlink, so it is not isolated: ${folder}. Remove the link and let AgEnD create a real directory.`);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
  }
  const launch = profile.accountLaunch(folder);
  if (!launch) throw new Error(`cli_adapter: acp could not set up the named account "${name}" for ${profile.label} on this host`);
  const env = Object.entries(launch.env).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ");
  const loginCommand = credentialProfileLoginCommand(agendHome, profile.backend, name)
    ?? [env, profile.binary, ...launch.args.map(a => JSON.stringify(a)), "login", "--device-auth"].filter(Boolean).join(" ");
  return { name, folder, env: launch.env, args: launch.args, loginCommand };
}
