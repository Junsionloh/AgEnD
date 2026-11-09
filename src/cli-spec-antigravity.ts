/** Antigravity (Google; the `agy` command). See cli-capability.ts for what each capability means. Built-ins only: part of the Runtime bundle. */
import { byDesign, yes, notYetBuilt, type CliSpec } from "./cli-capability.js";

export const ANTIGRAVITY_SPEC = {
  id: "antigravity",
  host: {
    install: yes({ binary: "agy", command: "curl -fsSL https://antigravity.google/cli/install.sh | bash" }),
    chatLogin: yes({ aliases: ["agy"], mode: "declined" }),
    dashboardSignIn: byDesign("Bare `agy` is the whole agent CLI, not a login command, so it never gets the browser terminal (login-flows.ts: `remoteLogin: \"unsupported\"`)."),
    // `agy acp --login` ("Log in with Google interactively, then exit", agy 1.5.0 and later). It prints no success line that has been seen, so the sign-in is over only when the command ended
    // with exit 0 AND `authCheck` passes; its screen has a closed table of its own (runtime-signin.ts `reduceAgyLoginScreen`). A Google-account (subscription) sign-in only.
    structuredSignIn: yes({ argv: ["agy", "acp", "--login"], rank: 3, ends: "exit-code", screen: "own", answer: "code-or-address", minVersion: "1.5.0", named: true }),
    // The first-run page still only names the console command for it (a browser sign-in needs a version check and the person's own confirmation, which the Accounts page has).
    firstRunSignIn: yes({ mode: "console", rank: 3 }),
    authCheck: yes({ argv: ["agy", "models"] }),
    // The masked `id_token_email` of agy's own token file (`~/.gemini/antigravity-cli/antigravity-oauth-token`), read locally: that one field only, no process, no network request.
    identity: yes({ source: "token-file", field: "id_token_email" }),
    // AGEND-119: several accounts on this host. agy takes the account's folder as `--app_data_dir <path relative to ~/.gemini>` (a `..` path reaches AgEnD's own credential-profiles folder), and keeps the
    // sign-in in `<folder>/antigravity-oauth-token`. Its keyring is shared by every folder (the folder is ignored there), so each launch also carries `pin`: `SSH_CONNECTION` makes agy 1.5.3 log
    // "Using file-based token storage because SSH session detected" and keep the sign-in in the file (checked on Linux and on Windows; a sign-in first proves it, see structured-signin.ts). A Move starts
    // a new conversation: agy keeps them in the same folder as the sign-in.
    // Side effect to know: there is no agy-only switch for this (agy 1.5.3's strings on Linux and Windows hold no AGY_*/flag for the token store: AGY_ACCOUNT, AGY_ADC_AUTH, AGY_BROWSER_WS_URL, AGY_CLI_*, AGY_LLM_GATEWAY_*,
    // AGY_PROXY_STRICT_SSL … none of them), so `pin` is a variable that means "an SSH session" to every program the agent starts: an agent on a named account sees SSH_CONNECTION in its shell, tools and MCP servers.
    namedAccounts: yes({ home: "launch-argument", arg: "--app_data_dir", store: "antigravity-oauth-token", pin: { SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 0" }, carry: "handover" }),
    // agy has no logout command (the TUI's `/logout` is interactive only): AgEnD removes the account's token file and then asks `agy models`, so a sign-out that did not take effect (a sign-in kept in the system
    // keyring) is reported as that. The default sign-in is `~/.gemini/antigravity-cli/antigravity-oauth-token`; a named account's is the same file in its own folder.
    signOut: yes({ remove: ["antigravity-oauth-token"] }),
    // `agy models` refreshes the access token (an hour) when it is past it, and the refresh token behind it outlives idle days (measured on Windows: 66 starts after the access token had lapsed, up to 4 days 20 hours
    // past it, none refused), so a scheduled run keeps the usage row current and tells a login that was revoked.
    keepAlive: yes(),
    accountCard: yes({ rank: 3 }),
    // Pools the CLI names (Gemini; Claude & others; Gemini 4 Argon), each with its own 5h and weekly limit, or one number when only per-model data exists: an Accounts row shows every pool and every window.
    usage: yes({ providerId: "antigravity", name: "Antigravity", rank: 5, profileRows: true, hostRows: true, pools: "several", windows: ["session", "weekly", "unwindowed"] }),
  },
  runtime: {
    provider: yes({
      name: "Antigravity", company: "Google", binaryNames: ["agy.exe"],
      supports: { execution: true, resume: true, model: true }, readOnlySupport: false,
      permission: "native-policy", permissionNote: "Uses the native CLI permission policy. Plan mode and terminal sandboxing do not guarantee read-only workspace access.",
      promptTransport: "stdin-json", modelProbe: ["models"], rank: 2,
    }),
    install: byDesign("Antigravity installs with a vendor PowerShell script, not an npm package (runtime-cli-install.ts); the dashboard shows the official command for the computer's owner."),
    // The computer's OWN login (no profile): Windows keeps it in the Credential Manager under one fixed name, so signing in REPLACES that Windows user's Antigravity login.
    signIn: yes({ argv: ["agy", "acp", "--login"], profile: "none" }),
    // AGEND-119 re-check of AGEND-112 (whose "one login per Windows user" was only true of agy.exe's default store): agy.exe keeps its login in the Credential Manager (`gemini:antigravity`, one for every folder) unless it detects
    // WSL (a \\wsl.localhost working directory) or an SSH session (SSH_CONNECTION / SSH_TTY / SSH_CLIENT set), when it keeps `<--app_data_dir>/antigravity-oauth-token` instead ("Using file-based token storage because SSH
    // session detected" in its log). Measured on agy.exe 1.5.3 with a planted token in a test folder: the folder's login is read, deleting the file signs it out, the Credential Manager login is untouched, and a `..`
    // relative --app_data_dir into the Runtime's own folder works (not across drives). So named accounts on a computer are possible with the host's `pin`; the Runtime side (profile folders, sign-in, probes, an agent's launch) is not built.
    namedAccounts: notYetBuilt("undecided", "Possible (agy.exe keeps a named folder's login in a file under SSH_CONNECTION, measured AGEND-119) but the Runtime's profile folders are Claude Code's only; not built."),
    accountRows: yes({ defaultRow: "sign-in" }),
    // agy has no status command: the model listing the Runtime asks for anyway says whether it is signed in (exit code and words), so no extra process is started.
    authStatus: yes({ argv: ["models"], source: "model-listing" }),
    identity: byDesign("The account could only be read from the Credential Manager entry `gemini:antigravity`, which holds the login's tokens: the Runtime does not read credentials (agy has no command that names the account, and its log files are not a reliable source)."),
    usage: notYetBuilt("undecided", "A computer reports no usage for any CLI yet; and the usage read needs the account's token, which on Windows is in the Credential Manager."),
  },
} satisfies CliSpec;
