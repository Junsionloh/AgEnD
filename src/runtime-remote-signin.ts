/**
 * PROTOTYPE (AGEND-77, not for merge): a Windows Runtime signs a CLI in for the dashboard.
 *
 * The dashboard (through AgEnD) asks "sign in profile NAME"; this Runtime starts the CLI's own `auth login` on a NEW profile folder it
 * owns, hands the sign-in URL back, takes the one-time code the administrator pastes, types it into the CLI and reports signed in / failed.
 *
 * What it relies on (measured on Windows, claude 2.1.318, with pipes only, no TTY needed):
 *   - `claude auth login` prints "If the browser didn't open, visit: <https url>" and "Paste code here if prompted >" within ~1 s,
 *   - a code is read from stdin as one line; a malformed one prints "Invalid code..." and the prompt stays open,
 *   - BROWSER=true stops it opening a browser on the (unattended) computer,
 *   - the CLI can be killed by its exact PID with nothing left behind.
 *
 * Boundaries (the server cannot widen any of them):
 *   - a closed table of flows: the CLI, its argv and the allowed URL hosts are written here; the request carries only a CLI id, a profile
 *     NAME (the existing name rule) and a method from a closed list;
 *   - the URL and the code exist only in memory: never logged, never written to disk, never part of an error message;
 *   - one sign-in at a time per Runtime, a start rate limit, a hard timeout, cancel by exact child;
 *   - success is the CLI's own `auth status` answer (the shared parser), never just output text.
 */
import { randomBytes } from "node:crypto";
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { AccountIdentity } from "./claude-auth-status.js";
import { assertCredentialProfileCli, assertCredentialProfileName, withCredentialProfile, type CredentialProfileCli } from "./runtime-credential-profiles.js";

export const REMOTE_SIGNIN_CAPABILITY = "remote-signin";
export const SIGNIN_TIMEOUT_MS = 10 * 60 * 1000;
const START_LIMIT = { count: 5, windowMs: 10 * 60 * 1000 };
const MAX_OUTPUT = 64 * 1024;
const MAX_URL = 2048;
/** The sign-in code the administrator pastes back. Claude's looks like `<code>#<state>`; anything with a space, a control byte or a quote is not one. */
const CODE_SHAPE = /^[A-Za-z0-9_\-#.~%=+/]{8,600}$/;

export type SignInMethod = "claudeai" | "console" | "sso";
interface SignInFlow {
  argv: (method: SignInMethod) => string[];
  /** https only, these hosts only: a sign-in URL that points anywhere else is dropped, never relayed. */
  hosts: readonly string[];
  success: RegExp;
  failures: ReadonlyArray<{ pattern: RegExp; reason: SignInFailure }>;
}
export type SignInFailure = "code-rejected" | "cli-failed" | "not-confirmed" | "timed-out";
const FLOWS: Readonly<Record<CredentialProfileCli, SignInFlow>> = Object.freeze({
  "claude-code": {
    argv: method => ["auth", "login", `--${method}`],
    hosts: ["claude.com", "claude.ai", "platform.claude.com", "console.anthropic.com"],
    success: /Login successful|Logged in as/,
    // live-verified by the host's LOGIN_FLOWS (claude 2.1.289): a well-formed but refused code ends the command with exit 1 and this line.
    failures: [{ pattern: /Login failed: Request failed with status code 400/, reason: "code-rejected" }],
  },
});

export type SignInState = "starting" | "awaiting-code" | "verifying" | "signed-in" | "failed" | "cancelled";
export interface SignInView {
  id: string; state: SignInState; cli: CredentialProfileCli; profile: string;
  /** Present only while the CLI waits for the code. In memory only; the transport must not log it. */
  url?: string;
  identity?: AccountIdentity; loggedIn?: boolean | null; failure?: SignInFailure;
  /** The CLI refused the pasted text as malformed and is waiting for another try (the same URL is still valid). */
  invalidCode?: true;
  expiresAt: number;
}
export interface RemoteSignInDeps {
  /** The profile folder for a NAME (ensureCredentialProfile under this Runtime's fixed root) and the CLI to run. */
  prepare: (cli: CredentialProfileCli, name: string) => Promise<{ directory: string; executable: { command: string; args: string[] }; env: NodeJS.ProcessEnv }>;
  /** The CLI's own `auth status` for that folder (probeCredentialProfileStatus). */
  confirm: (cli: CredentialProfileCli, directory: string) => Promise<{ loggedIn: boolean | null; identity?: AccountIdentity }>;
  /** Audit trail kept on this computer: who (as the server named them), what, which profile. Never a URL, a code or output. */
  audit?: (event: { at: number; event: "signin.start" | "signin.code" | "signin.done" | "signin.cancel"; cli: string; profile: string; actor?: string; outcome?: string }) => void;
  spawn?: (command: string, args: string[], options: { env: NodeJS.ProcessEnv; cwd?: string }) => ChildProcessWithoutNullStreams;
  now?: () => number;
  timeoutMs?: number;
}

/** Hosts check on a URL the CLI printed. Returns the URL or undefined. */
export function allowedSignInUrl(candidate: string, hosts: readonly string[]): string | undefined {
  if (candidate.length > MAX_URL) return undefined;
  let url: URL; try { url = new URL(candidate); } catch { return undefined; }
  return url.protocol === "https:" && !url.username && !url.password && hosts.includes(url.hostname) ? url.href : undefined;
}
/** What the pipe or ConPTY carries, without terminal escapes (an OSC 8 hyperlink wraps the URL when a pseudo-console is used). */
export function plainText(text: string): string {
  return text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r/g, "");
}

export class RemoteSignIn {
  private active: { view: SignInView; child: ChildProcessWithoutNullStreams; text: string; url?: string; codeSent: boolean; verifying: boolean; timer: ReturnType<typeof setTimeout>; actor?: string; done: Promise<void> } | undefined;
  private starts: number[] = [];
  constructor(private readonly deps: RemoteSignInDeps) {}
  private now(): number { return (this.deps.now ?? Date.now)(); }

  /** Starts a sign-in. Refuses while another one runs or when starts come too fast; both are plain errors the dashboard can show. */
  async start(input: { cli: unknown; profile: unknown; method?: unknown; actor?: string }): Promise<SignInView> {
    const cli = assertCredentialProfileCli(input.cli), profile = assertCredentialProfileName(input.profile);
    const method = (input.method ?? "claudeai") as SignInMethod;
    if (!["claudeai", "console", "sso"].includes(method)) throw new Error("Unknown sign-in method");
    if (this.active && !["signed-in", "failed", "cancelled"].includes(this.active.view.state)) throw new Error("Another sign-in is already running on this computer");
    const now = this.now();
    this.starts = this.starts.filter(at => now - at < START_LIMIT.windowMs);
    if (this.starts.length >= START_LIMIT.count) throw new Error("Too many sign-in attempts; try again in a few minutes");
    this.starts.push(now);
    const flow = FLOWS[cli], prepared = await this.deps.prepare(cli, profile);
    const env = { ...withCredentialProfile(prepared.env, cli, prepared.directory), BROWSER: "true", DISABLE_AUTOUPDATER: "1" };
    const child = (this.deps.spawn ?? ((c, a, o) => nodeSpawn(c, a, { ...o, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })))(prepared.executable.command, [...prepared.executable.args, ...flow.argv(method)], { env, cwd: prepared.directory });
    const view: SignInView = { id: randomBytes(8).toString("hex"), state: "starting", cli, profile, expiresAt: now + (this.deps.timeoutMs ?? SIGNIN_TIMEOUT_MS) };
    let resolveDone!: () => void; const done = new Promise<void>(resolve => { resolveDone = resolve; });
    const run = { view, child, text: "", url: undefined as string | undefined, codeSent: false, verifying: false, actor: input.actor, done, timer: setTimeout(() => { if (this.active === run) { this.finish(run, "failed", "timed-out"); child.kill(); } }, this.deps.timeoutMs ?? SIGNIN_TIMEOUT_MS) };
    this.active = run;
    this.deps.audit?.({ at: now, event: "signin.start", cli, profile, actor: input.actor });
    const onData = (data: Buffer): void => {
      if (this.active !== run) return;
      run.text = (run.text + data.toString("utf8")).slice(-MAX_OUTPUT);
      const text = plainText(run.text);
      if (flow.success.test(text) && !run.verifying && (view.state === "awaiting-code" || view.state === "verifying")) { void this.verify(run, prepared.directory); return; }
      if (view.state === "verifying" && !run.verifying && /Invalid code/.test(text)) {
        // A malformed code: the CLI keeps its prompt open. Back to waiting, with the same URL, so the administrator can paste it again.
        run.codeSent = false; run.text = ""; view.state = "awaiting-code"; view.invalidCode = true; view.url = run.url; return;
      }
      for (const failure of flow.failures) if (failure.pattern.test(text) && (view.state === "awaiting-code" || view.state === "verifying") && !run.verifying) { this.finish(run, "failed", failure.reason); return; }
      if (view.state === "starting") {
        for (const match of text.match(/https:\/\/[^\s"'<>]+/g) ?? []) { const url = allowedSignInUrl(match, flow.hosts); if (url) { view.url = url; run.url = url; view.state = "awaiting-code"; break; } }
      }
    };
    child.stdout.on("data", onData); child.stderr.on("data", onData);
    child.stdin.on("error", () => { /* the CLI closed its input: the exit handler reports it */ });
    child.on("error", () => { if (this.active === run) this.finish(run, "failed", "cli-failed"); });
    child.on("close", () => {
      clearTimeout(run.timer);
      // A CLI that exits on its own before success or a verdict is a failure; one we cancelled or finished is already settled.
      if (this.active === run && !["verifying", "signed-in", "failed", "cancelled"].includes(view.state)) this.finish(run, "failed", "cli-failed");
      resolveDone();
    });
    return this.view()!;
  }
  /** The state now. A URL is part of it only while the CLI waits for the code. */
  view(): SignInView | undefined {
    if (!this.active) return undefined;
    const { url, ...rest } = this.active.view;
    return this.active.view.state === "awaiting-code" ? { ...rest, url } : { ...rest };
  }
  /** Types the pasted code into the CLI: once per sign-in (a second paste breaks the CLI's exchange), only in the shape of a code. */
  submitCode(code: unknown): SignInView {
    const run = this.active;
    if (!run || run.view.state !== "awaiting-code") throw new Error("No sign-in is waiting for a code");
    if (run.codeSent) throw new Error("A code was already entered for this sign-in; start it again");
    if (typeof code !== "string" || !CODE_SHAPE.test(code.trim())) throw new Error("That does not look like a sign-in code");
    run.codeSent = true; run.text = ""; run.view.state = "verifying"; delete run.view.url; delete run.view.invalidCode;
    this.deps.audit?.({ at: this.now(), event: "signin.code", cli: run.view.cli, profile: run.view.profile, actor: run.actor });
    run.child.stdin.write(`${code.trim()}\n`);
    // `verifying` until the CLI says so; the CLI's verdict arrives through onData (success) or its exit (failure).
    run.child.once("close", () => { if (this.active === run && run.view.state === "verifying") void this.verify(run, undefined); });
    return this.view()!;
  }
  /** Stops the sign-in by killing exactly the child this Runtime started. */
  async cancel(actor?: string): Promise<void> {
    const run = this.active;
    if (!run || ["signed-in", "failed", "cancelled"].includes(run.view.state)) return;
    this.deps.audit?.({ at: this.now(), event: "signin.cancel", cli: run.view.cli, profile: run.view.profile, actor: actor ?? run.actor });
    this.finish(run, "cancelled"); run.child.kill(); await run.done;
  }
  /** Resolves when the child has ended (tests, shutdown). */
  async settled(): Promise<void> { await this.active?.done; }
  private async verify(run: NonNullable<RemoteSignIn["active"]>, directory: string | undefined): Promise<void> {
    if (run.verifying) return;
    run.verifying = true; run.view.state = "verifying"; delete run.view.url;
    try {
      const dir = directory ?? (await this.deps.prepare(run.view.cli, run.view.profile)).directory;
      const answer = await this.deps.confirm(run.view.cli, dir);
      if (this.active !== run) return;
      if (answer.loggedIn === true) { run.view.loggedIn = true; if (answer.identity) run.view.identity = answer.identity; this.finish(run, "signed-in"); }
      else { run.view.loggedIn = answer.loggedIn; this.finish(run, "failed", "not-confirmed"); }
    } catch { if (this.active === run) this.finish(run, "failed", "not-confirmed"); }
    finally { run.child.kill(); }
  }
  private finish(run: NonNullable<RemoteSignIn["active"]>, state: "signed-in" | "failed" | "cancelled", failure?: SignInFailure): void {
    if (this.active !== run || ["signed-in", "failed", "cancelled"].includes(run.view.state)) return;
    clearTimeout(run.timer); run.view.state = state; delete run.view.url; delete run.url; run.text = ""; if (failure) run.view.failure = failure;
    if (state !== "cancelled") this.deps.audit?.({ at: this.now(), event: "signin.done", cli: run.view.cli, profile: run.view.profile, actor: run.actor, outcome: failure ?? state });
    if (state === "failed") run.child.kill();
  }
}
