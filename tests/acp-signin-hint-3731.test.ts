/**
 * #3731: an ACP instance whose CLI is not signed in says where to sign in on THIS host: Settings → Accounts when the dashboard can
 * connect that CLI here (its sign-in row says so), otherwise a terminal-mode agent's View tab or /login in a chat channel.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
const fleet = (targets: unknown) => {
  const dir = mkdtempSync(join(tmpdir(), "agend-3731-hint-")); dirs.push(dir);
  const fm = new FleetManager(dir);
  vi.spyOn(fm, "backendSignInTargets").mockImplementation(() => { if (targets instanceof Error) throw targets; return targets as never; });
  return fm;
};

describe("FleetManager.signInHint", () => {
  it("points to Settings → Accounts when the dashboard can connect that CLI", () => {
    const fm = fleet([{ backend: "antigravity", state: "not_signed_in", signIn: true }, { backend: "grok", state: "not_signed_in", signIn: true }]);
    expect(fm.signInHint("antigravity", "agy")).toBe("Connect it in Settings → Accounts (Connect, next to agy), then restart the instance.");
    expect(fm.signInHint("grok", "grok")).toContain("Settings → Accounts (Connect, next to grok)");
  });

  it("when it cannot (version unreadable, button off), points to a terminal-mode agent's View tab or /login", () => {
    const fm = fleet([{ backend: "antigravity", state: "not_signed_in", signIn: false, hostCommand: "agy" }, { backend: "grok", state: "usable", signIn: false }]);
    for (const [backend, label] of [["antigravity", "agy"], ["grok", "grok"]]) {
      const hint = fm.signInHint(backend, label);
      expect(hint).toContain(`The dashboard cannot connect ${label} on this host`);
      expect(hint).toMatch(/View tab of a terminal-mode \(tmux\) agent that runs .* and sign in there, or send \/login in a chat channel/);
      expect(hint).not.toContain("Settings → Accounts");
    }
  });

  it("a CLI the list does not know, a named-account row only, or a list that cannot be read: the terminal / /login advice", () => {
    expect(fleet([]).signInHint("grok", "grok")).toContain("The dashboard cannot connect grok");
    expect(fleet([{ backend: "grok", profile: "work", state: "usable", signIn: true }]).signInHint("grok", "grok")).toContain("The dashboard cannot connect grok");
    expect(fleet(new Error("probe failed")).signInHint("grok", "grok")).toContain("The dashboard cannot connect grok");
  });
});
