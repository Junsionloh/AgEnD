/** Antigravity (Google; the `agy` command). See cli-capability.ts for what each capability means. Built-ins only: part of the Runtime bundle. */
import { byDesign, none, toVerify, yes, notYetBuilt, type CliSpec } from "./cli-capability.js";

export const ANTIGRAVITY_SPEC = {
  id: "antigravity",
  host: {
    install: yes({ binary: "agy", command: "curl -fsSL https://antigravity.google/cli/install.sh | bash" }),
    // AGEND-153 (#3521, the maintainer's decision on #3539): the NAMED EXCEPTION. Antigravity updates itself and `agy update` cannot choose a release, so the button runs it as it is and the
    // CLI goes to the newest release Google serves, which AgEnD has NOT audited (`release: "latest-unaudited"`; the page says so on the button). Same gate as any update otherwise.
    update: yes({ binary: "agy", command: "agy update", release: "latest-unaudited" }),
    chatLogin: yes({ aliases: ["agy"], mode: "declined" }),
    dashboardSignIn: byDesign("Bare `agy` is the whole agent CLI, not a login command, so it never gets the browser terminal (login-flows.ts: `remoteLogin: \"unsupported\"`)."),
    // `agy acp --login` ("Log in with Google interactively, then exit", agy 1.5.0 and later). It prints no success line that has been seen, so the sign-in is over only when the command ended
    // with exit 0 AND `authCheck` passes; its screen has a closed table of its own (runtime-signin.ts `reduceAgyLoginScreen`). A Google-account (subscription) sign-in only.
    structuredSignIn: yes({ argv: ["agy", "acp", "--login"], rank: 3, named: false, ends: "exit-code", screen: "own", answer: "code-or-address", minVersion: "1.5.0" }),
    // The first-run page still only names the console command for it (a browser sign-in needs a version check and the person's own confirmation, which the Accounts page has).
    firstRunSignIn: yes({ mode: "console", rank: 3 }),
    authCheck: yes({ argv: ["agy", "models"] }),
    // The masked `id_token_email` of agy's own token file (`~/.gemini/antigravity-cli/antigravity-oauth-token`), read locally: that one field only, no process, no network request.
    identity: yes({ source: "token-file", field: "id_token_email" }),
    namedAccounts: byDesign("AGEND-112: the user decided against several Antigravity accounts. (`agy acp --app_data_dir` can separate them on Linux; Windows keeps one login per Windows user, so a second could not be signed in there.)"),
    signOut: none("`agy --help` lists no logout command (checked on agy 1.5.3); signing out would mean deleting its token file or Credential Manager entry, which AgEnD does not do."),
    keepAlive: toVerify("Whether Antigravity's sign-in needs a keep-alive run has not been checked."),
    accountCard: yes({ rank: 3 }),
    // Two quota pools (Gemini; Claude & others), each with a 5h and a weekly window: an Accounts row shows the most used pool of each window and names it.
    usage: yes({ providerId: "antigravity", name: "Antigravity", rank: 5, profileRows: false, pools: "several" }),
  },
  runtime: {
    provider: yes({
      name: "Antigravity", company: "Google", binaryNames: ["agy.exe"],
      supports: { execution: true, resume: true, model: true }, readOnlySupport: false,
      permission: "native-policy", permissionNote: "Uses the native CLI permission policy. Plan mode and terminal sandboxing do not guarantee read-only workspace access.",
      promptTransport: "stdin-json", modelProbe: ["models"], rank: 2,
    }),
    // AGEND-135 (#3521), measured 2026-11-09: there is no npm package (`agy` / `antigravity-cli` on npm are not Google's), but the vendor script downloads a versioned, immutable file named by a
    // manifest (https://storage.googleapis.com/antigravity-public/antigravity-cli/<version>/windows-x64/cli_windows_x64.exe, manifest `sha512`), and that file IS Authenticode-signed
    // (Google LLC, status Valid; its sha512 matches the manifest). The Runtime pins the exact URL, size and sha512, downloads that one file itself (the vendor script is not run), checks all
    // of them, then the signer, and refuses on any mismatch (runtime-cli-install.ts, `kind: "download"`). Windows x64 only.
    // AGEND-148: 1.5.3 is on the maintainer-confirmed audited ledger (cli-audited.ts), so this download is pinned to an AUDITED release, not for its integrity only.
    install: yes({ kind: "download", pin: "audited" }),
    // AGEND-153: the named exception on a computer. NOT the pinned install: the Runtime downloads the newest release Google's own manifest names (from a fixed address, only from the vendor's
    // fixed file prefix), checks its sha512 against that manifest and the Authenticode signer (Google LLC), and only then switches to it (runtime-cli-install.ts, `LATEST_UNAUDITED`). The vendor's
    // own updater is never run there. The release is not one AgEnD has audited, and the page says so.
    update: yes({ kind: "latest-unaudited" }),
    // The computer's OWN login (no profile): Windows keeps it in the Credential Manager under one fixed name, so signing in REPLACES that Windows user's Antigravity login.
    signIn: yes({ argv: ["agy", "acp", "--login"], profile: "none" }),
    namedAccounts: byDesign("Windows keeps agy's login in the Credential Manager under one fixed name (`gemini:antigravity`), the same for every folder and every HOME (AGEND-112), so there is one per Windows user and a profile folder cannot hold another."),
    accountRows: yes({ defaultRow: "sign-in" }),
    // agy has no status command: the model listing the Runtime asks for anyway says whether it is signed in (exit code and words), so no extra process is started.
    authStatus: yes({ argv: ["models"], source: "model-listing" }),
    identity: byDesign("The account could only be read from the Credential Manager entry `gemini:antigravity`, which holds the login's tokens: the Runtime does not read credentials (agy has no command that names the account, and its log files are not a reliable source)."),
    usage: notYetBuilt("undecided", "A computer reports no usage for any CLI yet; and the usage read needs the account's token, which on Windows is in the Credential Manager."),
  },
} satisfies CliSpec;
