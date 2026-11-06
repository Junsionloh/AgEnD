import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { RemoteSignIn, allowedSignInUrl, plainText, type RemoteSignInDeps } from "../src/runtime-remote-signin.js";

const URL_OK = "https://claude.com/cai/oauth/authorize?code=true&client_id=x&response_type=code&state=s&code_challenge=c";

/** A CLI stand-in: prints what claude prints, reads lines from stdin, can be told to answer a code. */
function fakeCli() {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams & { sent: string[]; say: (text: string) => void; end: (code: number) => void; killed2: boolean };
  const stdout = new PassThrough(), stderr = new PassThrough(), stdin = new PassThrough();
  Object.assign(child, { stdout, stderr, stdin, sent: [] as string[], killed2: false });
  stdin.on("data", d => child.sent.push(String(d)));
  child.say = text => { stdout.write(text); };
  child.end = code => { child.emit("close", code, null); };
  child.kill = () => { child.killed2 = true; queueMicrotask(() => child.emit("close", null, "SIGTERM")); return true; };
  return child;
}
const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));
function make(overrides: Partial<RemoteSignInDeps> = {}) {
  const cli = fakeCli(), audit: string[] = [];
  const deps: RemoteSignInDeps = {
    prepare: async () => ({ directory: "C:\\rt\\credential-profiles\\claude-code\\work", executable: { command: "claude.exe", args: [] }, env: { PATH: "x" } }),
    confirm: async () => ({ loggedIn: true, identity: { maskedEmail: "ab***@example.com", plan: "team" } as never }),
    audit: e => audit.push(`${e.event}|${e.profile}|${e.actor ?? ""}|${e.outcome ?? ""}`),
    spawn: vi.fn(() => cli),
    ...overrides,
  };
  return { cli, audit, deps, signin: new RemoteSignIn(deps) };
}
async function toAwaiting(ctx: ReturnType<typeof make>) {
  await ctx.signin.start({ cli: "claude-code", profile: "work", actor: "admin-1" });
  ctx.cli.say(`Opening browser to sign in…\nIf the browser didn't open, visit: ${URL_OK}\nPaste code here if prompted > `);
  await tick();
}

describe("remote sign-in prototype (AGEND-77)", () => {
  it("hands the URL back only while waiting, takes the code, and trusts the CLI's own status answer", async () => {
    const ctx = make(); await toAwaiting(ctx);
    expect(ctx.signin.view()).toMatchObject({ state: "awaiting-code", url: URL_OK });
    ctx.signin.submitCode("abcdEFGH12345#state-1");
    expect(ctx.cli.sent).toEqual(["abcdEFGH12345#state-1\n"]);
    expect(ctx.signin.view()?.url).toBeUndefined();
    ctx.cli.say("Login successful\n"); await tick(30);
    expect(ctx.signin.view()).toMatchObject({ state: "signed-in", loggedIn: true, identity: { maskedEmail: "ab***@example.com" } });
    expect(ctx.signin.view()?.url).toBeUndefined();
    expect(ctx.audit).toEqual(["signin.start|work|admin-1|", "signin.code|work|admin-1|", "signin.done|work|admin-1|signed-in"]);
    expect(JSON.stringify(ctx.audit)).not.toContain("abcdEFGH");
  });
  it("says success in words is not enough: the CLI's status must agree", async () => {
    const ctx = make({ confirm: async () => ({ loggedIn: false }) }); await toAwaiting(ctx);
    ctx.signin.submitCode("abcdEFGH12345#state-1"); ctx.cli.say("Login successful\n"); await tick(30);
    expect(ctx.signin.view()).toMatchObject({ state: "failed", failure: "not-confirmed" });
  });
  it("drops a URL that is not https on an allowed host, and never relays one", async () => {
    expect(allowedSignInUrl("https://claude.ai/oauth/authorize?x=1", ["claude.ai"])).toBeTruthy();
    for (const bad of ["http://claude.ai/x", "https://evil.example/claude.ai", "https://claude.ai.evil.example/x", "https://user:pw@claude.ai/x", `https://claude.ai/${"a".repeat(3000)}`, "javascript:alert(1)"]) {
      expect(allowedSignInUrl(bad, ["claude.ai"])).toBeUndefined();
    }
    const ctx = make(); await ctx.signin.start({ cli: "claude-code", profile: "work" });
    ctx.cli.say("visit https://evil.example/phish now\n"); await tick();
    expect(ctx.signin.view()).toMatchObject({ state: "starting" });
    expect(ctx.signin.view()?.url).toBeUndefined();
  });
  it("reads the URL out of a pseudo-console's OSC 8 hyperlink as well", () => {
    const wrapped = `visit: \x1b]8;id=1;${URL_OK}\x1b\\${URL_OK}\x1b]8;;\x1b\\\r\n`;
    // the hyperlink wrapper (which repeats the URL) is dropped; the visible text stays
    expect(plainText(wrapped).match(/https:\/\/[^\s]+/g)).toEqual([URL_OK]);
  });
  it("accepts the shape of a code once, and goes back to waiting when the CLI calls it malformed", async () => {
    const ctx = make(); await toAwaiting(ctx);
    for (const bad of ["", "short", "has space inside it", "x;y;z;rm -rf /", "a".repeat(601), 42]) expect(() => ctx.signin.submitCode(bad)).toThrow(/does not look like/);
    ctx.signin.submitCode("not-a-real-code");
    ctx.cli.say("Invalid code. Please make sure the full code was copied.\n"); await tick();
    expect(ctx.signin.view()).toMatchObject({ state: "awaiting-code", invalidCode: true, url: URL_OK });
    ctx.signin.submitCode("abcdEFGH12345#state-1");
    expect(() => ctx.signin.submitCode("abcdEFGH12345#state-2")).toThrow(/No sign-in is waiting/);
  });
  it("reports a refused code (HTTP 400) as a failure with the next step, not as success", async () => {
    const ctx = make(); await toAwaiting(ctx);
    ctx.signin.submitCode("abcdEFGH12345#state-1"); ctx.cli.say("Login failed: Request failed with status code 400\n"); await tick();
    expect(ctx.signin.view()).toMatchObject({ state: "failed", failure: "code-rejected" });
    expect(ctx.cli.killed2).toBe(true);
  });
  it("runs one sign-in at a time and limits how fast they start", async () => {
    const ctx = make(); await toAwaiting(ctx);
    await expect(ctx.signin.start({ cli: "claude-code", profile: "other" })).rejects.toThrow(/already running/);
    await ctx.signin.cancel("admin-1");
    expect(ctx.signin.view()).toMatchObject({ state: "cancelled" });
    expect(ctx.cli.killed2).toBe(true);
    // five starts in the window are allowed, the sixth is refused
    const many = make({ spawn: vi.fn(() => fakeCli()) });
    for (let i = 0; i < 5; i++) { await many.signin.start({ cli: "claude-code", profile: "work" }); await many.signin.cancel(); }
    await expect(many.signin.start({ cli: "claude-code", profile: "work" })).rejects.toThrow(/Too many/);
  });
  it("times out and kills the child it started", async () => {
    vi.useFakeTimers();
    try {
      const ctx = make({ timeoutMs: 1000 }); await ctx.signin.start({ cli: "claude-code", profile: "work" });
      await vi.advanceTimersByTimeAsync(1100);
      expect(ctx.signin.view()).toMatchObject({ state: "failed", failure: "timed-out" });
      expect(ctx.cli.killed2).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it("takes only a known CLI, a valid profile name and a method from the closed list; the environment keeps the browser off", async () => {
    const ctx = make();
    await expect(ctx.signin.start({ cli: "codex", profile: "work" })).rejects.toThrow(/Claude Code only/);
    await expect(ctx.signin.start({ cli: "claude-code", profile: "..\\evil" })).rejects.toThrow(/names use/);
    await expect(ctx.signin.start({ cli: "claude-code", profile: "CON" })).rejects.toThrow(/names use/);
    await expect(ctx.signin.start({ cli: "claude-code", profile: "work", method: "--dangerously" })).rejects.toThrow(/Unknown sign-in method/);
    await ctx.signin.start({ cli: "claude-code", profile: "work", method: "sso" });
    const [command, args, options] = (ctx.deps.spawn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(command).toBe("claude.exe"); expect(args).toEqual(["auth", "login", "--sso"]);
    expect(options.env.BROWSER).toBe("true"); expect(options.env.CLAUDE_CONFIG_DIR).toBe("C:\\rt\\credential-profiles\\claude-code\\work");
  });
  it("a CLI that exits by itself before any verdict is a failure", async () => {
    const ctx = make(); await toAwaiting(ctx);
    ctx.cli.end(1); await tick();
    expect(ctx.signin.view()).toMatchObject({ state: "failed", failure: "cli-failed" });
  });
});
