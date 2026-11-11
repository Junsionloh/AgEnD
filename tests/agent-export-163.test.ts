/**
 * AGEND-163: an agent's portable settings as a file and the way back — the allow-list in both directions (nothing outside it is
 * written or read), the secret scan that stops the download, and deploy_template forwarding `instructions` (an addition: a
 * template without it deploys exactly as before).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { parse as yamlParse } from "yaml";
import { buildAgentExport, parseAgentExport, scanForSecrets, AGENT_EXPORT_MAX_CHARS } from "../src/agent-export.js";
import { AGENT_INSTRUCTIONS_MAX_CHARS } from "../src/agent-instructions.js";
import { FleetManager } from "../src/fleet-manager.js";
import { outboundHandlers } from "../src/outbound-handlers.js";

const ALL = ["identity", "instructions", "systemPrompt", "runtime", "behavior"];
const saved = {
  description: "Reviews UI changes", tags: ["review", "ui"], instructions: "# Role\n\nBe exact.\n- one\n- two\n",
  systemPrompt: "You are a reviewer.", backend: "claude-code", model: "claude-sonnet-5-5", model_failover: ["claude-haiku-5-5"], tool_set: "coordinator", lightweight: true,
  hang_detector: { timeout_minutes: 15 }, tool_progress: "standard", reply_completion_guard: false, log_level: "debug", auto_pause_after: 30, agent_mode: "cli",
  cross_instance_visibility: "summary", board_cards_at_once: 2, resume_interrupted_work: false,
  // Never exported:
  working_directory: "/home/me/work", channel_id: "discord", topic_id: "123456789", general_topic: true, display_name: "Kasa", machine_id: "m-1", runtime: "windows",
  backend_options: { "claude-code": { credential_profile: "personal@example.com" } }, dashboard: { office: "full" }, skipPermissions: true,
  pre_task_command: "rm -rf /", status_emojis: { received: "<:x:1>" }, quota_notice: { threshold: 90 }, workflow: "wf", native_sandbox: "x",
} as any;

describe("export: a file of the portable fields and nothing else", () => {
  const built = buildAgentExport("claude-kasa", saved, ALL);
  const doc = yamlParse(built.text!) as any;
  it("is agend_export: 1, kind agent, the role, and the reserved empty library", () => {
    expect(doc).toMatchObject({ agend_export: 1, kind: "agent", role: "claude-kasa", library: { skills: [], mcp: [] } });
    expect(built.findings).toEqual([]);
    expect(built.empty).toBe(false);
  });
  it("carries every portable field, as written", () => {
    expect(doc.agent).toEqual({
      description: saved.description, tags: saved.tags, instructions: "# Role\n\nBe exact.\n- one\n- two", systemPrompt: saved.systemPrompt,
      backend: "claude-code", model: "claude-sonnet-5-5", model_failover: ["claude-haiku-5-5"], tool_set: "coordinator", lightweight: true,
    });
    expect(doc.behavior).toEqual({
      hang_detector: { timeout_minutes: 15 }, tool_progress: "standard", reply_completion_guard: false, log_level: "debug", auto_pause_after: 30, agent_mode: "cli",
      cross_instance_visibility: "summary", board_cards_at_once: 2, resume_interrupted_work: false,
    });
  });
  it("never writes an account, key, channel, folder, machine, permission, command or emoji — in any group", () => {
    for (const word of ["home/me", "discord", "123456789", "Kasa", "m-1", "windows", "personal@example.com", "credential_profile", "office", "skipPermissions", "rm -rf", "status_emojis", "quota", "workflow", "native_", "dashboard", "backend_options"]) {
      expect(built.text, word).not.toContain(word);
    }
  });
  it("writes only the chosen groups, and only what the agent itself saved", () => {
    const only = yamlParse(buildAgentExport("r", saved, ["instructions"]).text!) as any;
    expect(only.agent).toEqual({ instructions: "# Role\n\nBe exact.\n- one\n- two" });
    expect(only.behavior).toBeUndefined();
    const bare = buildAgentExport("r", { working_directory: "/w" }, ALL);
    expect(bare.empty).toBe(true);
    expect(yamlParse(bare.text!).agent).toEqual({});
    expect(buildAgentExport("r", saved, ["nonsense"]).empty).toBe(true);
  });
  it("leaves out a file: system prompt (a path on the exporter's computer) and a role name that is not a name", () => {
    const t = buildAgentExport("bad role/name", { systemPrompt: "file:prompts/a.md,prompts/b.md", description: "d" }, ALL).text!;
    expect(t).not.toContain("systemPrompt");
    expect(yamlParse(t).role).toBeUndefined();
  });
});

describe("export: a secret stops the file", () => {
  const secrets: Array<[string, string]> = [
    ["api_key", "use sk-abcdefghijklmnopqrstuvwx for it"], ["api_key", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"], ["private_key", "-----BEGIN RSA PRIVATE KEY-----"],
    ["bot_token", "bot 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw9"], ["jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkw.SflKxwRJSMeKKF2QT4fwpMeJf36"],
    ["bearer", "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345"], ["assignment", "api_key = Zm9vYmFyYmF6cXV4MTIzNDU2"], ["url_password", "postgres://admin:hunter2pass@db.local/x"],
  ];
  it.each(secrets)("%s in Instructions: no text, a finding with the field and line — and never the secret", (kind, line) => {
    const r = buildAgentExport("r", { instructions: `fine\n${line}\nalso fine` }, ["instructions"]);
    expect(r.text).toBeNull();
    expect(r.findings).toEqual([{ field: "instructions", line: 2, kind }]);
    expect(JSON.stringify(r)).not.toContain(line.slice(-12));
  });
  it("is scanned in Description and the inline System prompt too, but only when that group is chosen", () => {
    const key = "token: abcdefghijklmnopqrstuvwxyz1234";
    expect(buildAgentExport("r", { description: key }, ["identity"]).findings[0]).toMatchObject({ field: "description" });
    expect(buildAgentExport("r", { systemPrompt: key }, ["systemPrompt"]).findings[0]).toMatchObject({ field: "systemPrompt" });
    expect(buildAgentExport("r", { systemPrompt: key, description: "ok" }, ["identity"]).text).not.toBeNull();
  });
  it("does not stop ordinary prose or placeholders", () => {
    expect(scanForSecrets("instructions", "Store the token in the TOKEN env var. password: <your-password-here>\nset api_key: ${API_KEY}")).toEqual([]);
  });
});

describe("load: the round trip", () => {
  it("everything exported is read back (the fields the form has), under the form's own values", () => {
    const r = parseAgentExport(buildAgentExport("claude-kasa", saved, ALL).text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.role).toBe("claude-kasa");
    expect(r.fill).toEqual({
      description: saved.description, tags: saved.tags, instructions: "# Role\n\nBe exact.\n- one\n- two", model: "claude-sonnet-5-5", model_failover: "claude-haiku-5-5",
      tool_set: "coordinator", lightweight: true, hang_detector: 15, tool_progress: "standard", reply_completion_guard: false, log_level: "debug", auto_pause_after: 30,
      agent_mode: "cli", cross_instance_visibility: "summary", board_cards_at_once: 2, resume_interrupted_work: false,
    });
    // The two it does not fill, with the reason: an existing field and the runtime switch.
    expect(r.skipped).toEqual([{ path: "agent.systemPrompt", reason: "existingField" }, { path: "agent.backend", reason: "runtimeSwitch" }]);
    expect(r.libraryUsed).toBe(false);
  });
  it("an Instructions text is read back exactly (Markdown, quotes, colons, unicode, a long one)", () => {
    const text = `# 角色\n\nSay "hi": it's fine — 100%\n\n\`\`\`yaml\nkey: value\n\`\`\`\n${"x".repeat(AGENT_INSTRUCTIONS_MAX_CHARS - 80)}`;
    const r = parseAgentExport(buildAgentExport("r", { instructions: text }, ["instructions"]).text);
    expect(r.ok && r.fill.instructions).toBe(text);
  });
});

describe("load: a hand-edited file", () => {
  const file = (body: string) => `agend_export: 1\nkind: agent\n${body}`;
  const skippedOf = (body: string) => { const r = parseAgentExport(file(body)); if (!r.ok) throw new Error(r.error); return Object.fromEntries(r.skipped.map((s) => [s.path, s.reason])); };
  it("skips every excluded field with its reason and fills nothing from it", () => {
    const r = parseAgentExport(file(`agent:
  working_directory: /etc
  channel_id: discord
  topic_id: "1"
  general_topic: true
  display_name: X
  machine_id: m
  runtime: windows
  native_sandbox: x
  backend_options: { claude-code: { credential_profile: me } }
  dashboard: { office: full }
  office_access: full
  skipPermissions: true
  pre_task_command: "rm -rf /"
  status_emojis: { received: "x" }
  quota_notice: {}
  workflow: wf
  cost_guard: {}
  restart_policy: {}
  profile: p
  something_new: 1
behavior:
  mcp_proxy_reply: true
  pre_task_command: x
`));
    expect(r.ok && r.fill).toEqual({});
    expect(skippedOf(`agent:\n  working_directory: /etc\n  channel_id: d\n  topic_id: "1"\n  general_topic: true\n  display_name: X\n  machine_id: m\n  runtime: windows\n  native_sandbox: x\n  backend_options: {}\n  dashboard: {}\n  office_access: full\n  skipPermissions: true\n  pre_task_command: x\n  status_emojis: {}\n  quota_notice: {}\n  workflow: wf\n  cost_guard: {}\n  profile: p\n  something_new: 1\nbehavior:\n  mcp_proxy_reply: true\n`)).toEqual({
      "agent.working_directory": "machine", "agent.channel_id": "binding", "agent.topic_id": "binding", "agent.general_topic": "binding", "agent.display_name": "name",
      "agent.machine_id": "machine", "agent.runtime": "machine", "agent.native_sandbox": "machine", "agent.backend_options": "account", "agent.dashboard": "permission",
      "agent.office_access": "permission", "agent.skipPermissions": "permission", "agent.pre_task_command": "command", "agent.status_emojis": "emoji", "agent.quota_notice": "notice",
      "agent.workflow": "fleetOnly", "agent.cost_guard": "fleetOnly", "agent.profile": "fleetOnly", "agent.something_new": "unknown", "behavior.mcp_proxy_reply": "permission",
    });
  });
  it("skips values that are the wrong type, not allowed or too long, and keeps the good ones beside them", () => {
    const r = parseAgentExport(file(`agent:
  description: 12
  tags: [a, 5]
  instructions: ${JSON.stringify("x".repeat(AGENT_INSTRUCTIONS_MAX_CHARS + 1))}
  model: "bad model;rm"
  tool_set: god
  lightweight: "yes"
  model_failover: []
behavior:
  hang_detector: { timeout_minutes: -3 }
  tool_progress: loud
  auto_pause_after: -1
  agent_mode: x
  board_cards_at_once: 1.5
  log_level: info
`));
    if (!r.ok) throw new Error(r.error);
    expect(r.fill).toEqual({ log_level: "info" });
    expect(Object.fromEntries(r.skipped.map((s) => [s.path, s.reason]))).toMatchObject({
      "agent.description": "badValue", "agent.tags": "badValue", "agent.instructions": "tooLong", "agent.model": "badValue", "agent.tool_set": "badValue", "agent.lightweight": "badValue",
      "agent.model_failover": "badValue", "behavior.hang_detector": "badValue", "behavior.tool_progress": "badValue", "behavior.auto_pause_after": "badValue", "behavior.agent_mode": "badValue", "behavior.board_cards_at_once": "badValue",
    });
  });
  it("reads only the first of several fallback models and says so", () => {
    const r = parseAgentExport(file("agent:\n  model_failover: [a-1, b-2]\n"));
    expect(r.ok && r.fill.model_failover).toBe("a-1");
    expect(r.ok && r.extraFailover).toBe(true);
  });
  it("a unknown top-level key is skipped, a non-empty library is noted and never an error", () => {
    const r = parseAgentExport(file("extra: 1\nlibrary:\n  skills: [{ ref: ui-review, version: 1 }]\n  mcp: []\n  other: 1\nagent:\n  description: d\n"));
    if (!r.ok) throw new Error(r.error);
    expect(r.libraryUsed).toBe(true);
    expect(r.fill).toEqual({ description: "d" });
    expect(r.skipped).toEqual(expect.arrayContaining([{ path: "extra", reason: "unknown" }, { path: "library.other", reason: "unknown" }]));
  });
  it("an inherited-looking key (__proto__, constructor) is just an unknown field", () => {
    const r = parseAgentExport(file("agent:\n  __proto__: { polluted: 1 }\n  constructor: x\n  description: d\n"));
    if (!r.ok) throw new Error(r.error);
    expect(r.fill).toEqual({ description: "d" });
    expect(({} as any).polluted).toBeUndefined();
  });
});

describe("load: files that are refused", () => {
  const err = (text: unknown) => { const r = parseAgentExport(text); return r.ok ? "ok" : r.error; };
  it("empty, too large, not YAML, not an export, a newer version, another kind", () => {
    expect(err("")).toBe("empty");
    expect(err(undefined)).toBe("empty");
    expect(err("agend_export: 1\n" + "a".repeat(AGENT_EXPORT_MAX_CHARS))).toBe("too_large");
    expect(err("agent: [unclosed")).toBe("invalid_yaml");
    expect(err("agent:\n  description: d\n")).toBe("not_export");
    expect(err("- a\n- b\n")).toBe("not_export");
    expect(err("agend_export: 2\nagent: {}\n")).toBe("unsupported_version");
    expect(err("agend_export: '1'\n")).toBe("unsupported_version");
    expect(err("agend_export: 1\nkind: fleet\n")).toBe("wrong_kind");
  });
  it("duplicate keys and aliases (nothing to expand) are refused", () => {
    expect(err("agend_export: 1\nagent:\n  description: a\n  description: b\n")).toBe("invalid_yaml");
    expect(err("agend_export: 1\nagent:\n  tags: &t [a]\n  description: *t\n")).toBe("invalid_yaml");
  });
  it("custom tags do not become code or binary: the value stays plain text", () => {
    const r = parseAgentExport("agend_export: 1\nagent:\n  description: !!js/function 'x'\n  tags: !!binary aGk=\n");
    if (!r.ok) throw new Error(r.error);
    expect(r.fill.description).toBe("x");
    expect(r.fill.tags).toBeUndefined();
  });
});

// ── deploy_template forwards `instructions` ──

const dirs: string[] = [];
const temp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("deploy_template: instructions are forwarded; a template without them is unchanged", () => {
  const rig = (instanceDef: Record<string, unknown>) => {
    const handleCreate = vi.fn(async (_a: unknown, respond: (r: unknown) => void) => respond({ name: "x", status: "running" }));
    const ctx: any = {
      fleetConfig: { defaults: {}, instances: { x: {} }, templates: { t: { instances: { a: instanceDef } } }, teams: {} },
      lifecycle: { handleCreate }, getWorldForInstance: vi.fn(), saveFleetConfig: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    };
    return { ctx, handleCreate };
  };
  const deploy = async (instanceDef: Record<string, unknown>) => {
    const r = rig(instanceDef);
    let error: unknown = null;
    await outboundHandlers.get("deploy_template")!(r.ctx, { template: "t", directory: temp("agend-163-") }, (_res: unknown, e: unknown) => { error = e ?? null; }, undefined as any);
    return { ...r, error };
  };
  it("passes a template role's instructions to the instance it creates", async () => {
    const { handleCreate, error } = await deploy({ description: "d", instructions: "# Role\nBe exact." });
    expect(error).toBeNull();
    expect(handleCreate.mock.calls[0][0]).toMatchObject({ description: "d", instructions: "# Role\nBe exact." });
  });
  it("a template with no instructions creates exactly what it did before (no instructions key at all)", async () => {
    const { handleCreate } = await deploy({ description: "d", systemPrompt: "p", tool_set: "worker", lightweight: false, tags: ["t"] });
    const args = handleCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(args).sort()).toEqual(["description", "directory", "lightweight", "systemPrompt", "tags", "tool_set", "topic_name"]);
  });
  it("a role whose instructions are not text, or longer than 24,000 characters, creates nothing and says why", async () => {
    for (const bad of [5, "x".repeat(AGENT_INSTRUCTIONS_MAX_CHARS + 1)]) {
      const { handleCreate, error } = await deploy({ instructions: bad });
      expect(handleCreate).not.toHaveBeenCalled();
      expect(String(error)).toMatch(/instructions must be text of at most 24000 characters/);
    }
  });
});

describe("create: the instance's fleet.yaml gets the instructions (and nothing when there are none)", () => {
  async function created(args: Record<string, unknown>) {
    const dataDir = temp("agend-163-fleet-");
    const configPath = join(dataDir, "fleet.yaml");
    writeFileSync(configPath, yaml.dump({ instances: { general: { working_directory: temp("agend-163-g-"), general_topic: true } } }));
    const fm = new FleetManager(dataDir);
    vi.spyOn(fm as any, "startCliEnvProbeWorker").mockReturnValue({ promise: Promise.resolve(null), stopped: Promise.resolve(), terminate() {} });
    fm.loadConfig(configPath);
    vi.spyOn(fm, "createForumTopic").mockResolvedValue("901" as any);
    vi.spyOn(fm.lifecycle, "start").mockResolvedValue(undefined);
    vi.spyOn(fm, "connectIpcToInstance").mockResolvedValue(undefined);
    let name = "", error: string | undefined;
    await fm.lifecycle.handleCreate({ directory: temp("agend-163-p-"), topic_name: "pomodoro", ...args } as any, (r: any, e?: string) => { name = r?.name; error = e; });
    expect(error).toBeUndefined();
    return (yaml.load(readFileSync(configPath, "utf8")) as any).instances[name] as Record<string, unknown>;
  }
  it("writes a valid text as given, and no key for blank, over-long or no text", async () => {
    expect((await created({ instructions: "# Role\nBe exact.\n" })).instructions).toBe("# Role\nBe exact.");
    expect(await created({ instructions: "  \n" })).not.toHaveProperty("instructions");
    expect(await created({ instructions: "x".repeat(AGENT_INSTRUCTIONS_MAX_CHARS + 1) })).not.toHaveProperty("instructions");
    expect(await created({})).not.toHaveProperty("instructions");
  });
});
