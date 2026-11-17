/**
 * AGEND-279: the version policy is a floor, not a list (Multica's `MinVersions`): a release older than the profile's minimum is refused, any other
 * runs — one newer than the newest verified with a warning in the log. Decided by the user: a CLI that updates itself (agy does, even with
 * `AGY_CLI_DISABLE_AUTO_UPDATE` set) must not leave the instance stopped. This file is the "nothing else still refuses a new release" half: the
 * Runtime / CLI switch, the dashboard's availability and its update view never read a version to say no to a new one, and the only place that
 * refuses is the profile's floor in the ACP adapter's start.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ADAPTER_BACKENDS, adaptersForBackend, cliAdapterProblem } from "../src/adapters/config.js";
import { AGY_PROFILE, GROK_PROFILE, checkVersion } from "../src/adapters/acp/profiles.js";
import { MIN_SUPPORTED_VERSION, availabilityState } from "../src/backend-availability.js";
import { cliUpdateView } from "../src/cli-audited.js";

describe("a new release is not refused by anything but the profile's floor", () => {
  it("the Runtime / CLI switch decides by the backend alone: no version goes in, so none can be refused", () => {
    expect(cliAdapterProblem.length).toBe(2);                                                       // (value, backend)
    for (const backend of ADAPTER_BACKENDS.acp) { expect(cliAdapterProblem("acp", backend)).toBeNull(); expect(adaptersForBackend(backend)).toEqual(["tmux", "acp"]); }
  });
  it("the dashboard's availability has no floor for grok or agy, so an installed new release is `ready`, never `too_old`", () => {
    expect(Object.keys(MIN_SUPPORTED_VERSION).sort()).toEqual(["kiro-cli"]);
    for (const version of ["1.0.77", "1.0.99", "9.9.9", "1.5.10", "2.0.0"]) {
      expect(availabilityState({ installed: true, version, auth: "signed_in" as never, minVersion: MIN_SUPPORTED_VERSION.grok ?? MIN_SUPPORTED_VERSION.antigravity ?? null }), version).not.toBe("too_old");
    }
  });
  it("the dashboard's update view only says where an installed release stands (newer is `newer`, a label), and offers nothing that refuses it", () => {
    expect(cliUpdateView("antigravity", "1.5.10", false)).toMatchObject({ state: "newer", button: false });
    expect(cliUpdateView("grok", "1.0.99", false)).toMatchObject({ state: "newer", button: false });
  });
  it("only the ACP adapter's start reads the floor: no other module refuses on a version of grok or agy", () => {
    const here = join(process.cwd(), "src");
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : /\.(ts|js)$/.test(e.name) ? [join(d, e.name)] : []));
    const users = walk(here).filter((f) => !f.includes(join("scheduler", "task-board")) && /\b(checkVersion|AcpVersionRefusedError|profile\.(?:minVersion|verifiedVersion))\b/.test(readFileSync(f, "utf8"))).map((f) => f.slice(here.length + 1)).sort();
    expect(users).toEqual(["adapters/acp/acp-adapter.ts", "adapters/acp/acp-runner.ts", "adapters/acp/profiles.ts"]);
    expect(walk(here).filter((f) => /\bsupportedVersions\b/.test(readFileSync(f, "utf8")) && !/hub\//.test(f))).toEqual([]);   // the list is gone (the Hub's protocol versions are another thing)
  });
});

describe("the floors", () => {
  it("are the oldest verified release of each CLI; a release below them is refused with what to do", () => {
    expect([GROK_PROFILE.minVersion, AGY_PROFILE.minVersion]).toEqual(["1.0.77", "1.5.8"]);
    expect(checkVersion(AGY_PROFILE, { agentInfo: { version: "1.5.7" } })).toMatchObject({ ok: false });
    expect(checkVersion(GROK_PROFILE, { _meta: { agentVersion: "1.0.76" } })).toMatchObject({ ok: false });
  });
  it("and every release at or above starts: the one that updated itself on the preview (agy 1.5.10) included", () => {
    for (const v of ["1.5.8", "1.5.9", "1.5.10", "1.5.11", "1.6.0", "2.0.0"]) expect(checkVersion(AGY_PROFILE, { agentInfo: { version: v } }), v).toMatchObject({ ok: true });
    for (const v of ["1.0.77", "1.0.78", "1.1.0", "2.0.0"]) expect(checkVersion(GROK_PROFILE, { _meta: { agentVersion: v } }), v).toMatchObject({ ok: true });
  });
});
