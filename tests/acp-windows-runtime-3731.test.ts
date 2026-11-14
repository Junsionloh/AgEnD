/**
 * #3731 on the alpha line: a Windows runtime agent (`runtime: windows`) does not take `cli_adapter` or
 * `acp_always_approve` — it runs through its own `native_adapter`, which is not changed.
 */
import { describe, expect, it } from "vitest";
import { validateFleetConfig } from "../src/config-validator.js";
import { loadFleetConfigSource } from "../src/config.js";
import { windowsAdapterProblem } from "../src/adapters/config.js";
import { NativeInstanceCreateArgs } from "../src/native-instance-input.js";
import { adapterConfigOf, selectAdapter } from "../src/adapters/select.js";

const AGENT = "11111111-1111-4111-8111-111111111111";
const win = (extra: Record<string, unknown> = {}) => ({
  runtime: "windows", backend: "codex", native_adapter: "exec", native_agent_id: AGENT, native_sandbox: "workspace-write",
  working_directory: "C:\\work", ...extra,
});
const errors = (inst: Record<string, unknown>, backend?: string) =>
  validateFleetConfig({ defaults: backend ? { backend } : {}, instances: { w: inst } }).errors.map(e => e.path);

describe("a Windows runtime agent and the adapter keys", () => {
  it("the same agent without them validates (its native_adapter is untouched), for exec and pane", () => {
    expect(errors(win())).toEqual([]);
    expect(errors(win({ native_adapter: "pane" }))).toEqual([]);
  });

  it("cli_adapter is refused at validation, whatever its value, with the key named", () => {
    for (const value of ["tmux", "acp", "nonsense"]) expect(errors(win({ cli_adapter: value }))).toContain("instances.w.cli_adapter");
    expect(errors(win({ cli_adapter: "tmux", native_adapter: "pane" }))).toContain("instances.w.cli_adapter");
  });

  it("acp_always_approve is refused too", () => {
    expect(errors(win({ acp_always_approve: true }))).toContain("instances.w.acp_always_approve");
  });

  it("an agent on this host is unaffected: cli_adapter tmux still validates", () => {
    expect(validateFleetConfig({ instances: { h: { working_directory: "/tmp/h", cli_adapter: "tmux" } } }).errors).toEqual([]);
  });

  it("the loader refuses it at load, naming the key", () => {
    const base = `instances:\n  w:\n    runtime: windows\n    backend: codex\n    native_adapter: exec\n    native_agent_id: ${AGENT}\n    native_sandbox: workspace-write\n    working_directory: 'C:\\work'\n`;
    expect(() => loadFleetConfigSource(base + "    cli_adapter: tmux\n")).toThrow(/instances\.w\.cli_adapter: is not accepted for a Windows runtime agent/);
    expect(() => loadFleetConfigSource(base + "    acp_always_approve: true\n")).toThrow(/instances\.w\.acp_always_approve/);
    expect(() => loadFleetConfigSource(base)).not.toThrow();
  });

  it("the shared rule: null and absent count as not set", () => {
    expect(windowsAdapterProblem({})).toBeNull();
    expect(windowsAdapterProblem({ cli_adapter: null, acp_always_approve: null })).toBeNull();
    expect(windowsAdapterProblem({ cli_adapter: "tmux" })?.key).toBe("cli_adapter");
  });

  it("the dashboard's create body for a Windows agent has no place for them", () => {
    const body = { runtime: "windows", backend: "codex", directory: "C:\\work", topic_name: "w" };
    expect(NativeInstanceCreateArgs.safeParse(body).success).toBe(true);
    expect(NativeInstanceCreateArgs.safeParse({ ...body, cli_adapter: "acp" }).success).toBe(false);
    expect(NativeInstanceCreateArgs.safeParse({ ...body, acp_always_approve: true }).success).toBe(false);
  });
});

describe("a native Windows pane always builds the tmux adapter", () => {
  const built = { runner: { on() {} } as never, backend: { getSessionId: () => null } };
  const builders = { tmux: () => built, acp: () => { throw new Error("an ACP adapter was built for a native pane"); } };
  it("whatever cli_adapter the config carries, the pane's config selects tmux", () => {
    expect(adapterConfigOf({ cli_adapter: "acp" }, true).cli_adapter).toBeUndefined();
    const adapter = selectAdapter("grok", adapterConfigOf({ cli_adapter: "acp" }, true), builders as never);
    expect(adapter.id).toBe("tmux");
  });
  it("a host agent keeps its own choice", () => {
    expect(adapterConfigOf({ cli_adapter: "acp" }, false).cli_adapter).toBe("acp");
  });
});

describe("an acp instance and a named account", () => {
  const acp = (extra: Record<string, unknown> = {}) => ({ working_directory: "/tmp/a", backend: "antigravity", cli_adapter: "acp", ...extra });
  const paths = (inst: Record<string, unknown>) => validateFleetConfig({ instances: { a: inst } }).errors.map(e => e.path);
  it("runs under the CLI's own sign-in; naming an account is refused rather than quietly ignored", () => {
    expect(paths(acp())).toEqual([]);
    expect(paths(acp({ backend_options: { antigravity: { credential_profile: "work" } } }))).toContain("instances.a.backend_options");
    // The same account on a terminal instance is the feature it always was.
    expect(paths({ working_directory: "/tmp/a", backend: "antigravity", backend_options: { antigravity: { credential_profile: "work" } } })).toEqual([]);
  });
});
