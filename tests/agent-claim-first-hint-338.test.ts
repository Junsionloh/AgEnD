/**
 * AGEND-338: a real agent went straight to `move … review` on a card it had not claimed and was refused; the built-in workflow
 * template and the CLI instructions now say to claim a card before working on it. The words are in every agent's prompt, so the
 * sentence is short — and with the task board switched off it leaves with the rest of the board's guidance, as before.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildFleetInstructions } from "../src/instructions.js";
import { withoutTaskBoardGuidance, withoutTaskCommands } from "../src/dashboard-permissions.js";

const template = readFileSync(new URL("../src/workflow-templates/default.md", import.meta.url), "utf8");
const cli = readFileSync(new URL("../src/agent-cli-instructions.md", import.meta.url), "utf8");
const base = { instanceName: "dev-a", workingDirectory: "/work/a" };
const CLAIM = "Claim a card (`task claim`) before you work on it";

describe("claim a card before working on it (AGEND-338)", () => {
  it("the built-in workflow's task board section says so, in one clause of the status line", () => {
    const section = template.slice(template.indexOf("## Progress Tracking"), template.indexOf("## Context Protection"));
    expect(section).toContain(CLAIM);
    // One clause, not a new bullet: the board section keeps its six bullets, and the sentence stays short.
    expect(section.split("\n").filter((l) => l.startsWith("- ")).length).toBe(6);
    expect(CLAIM.length).toBeLessThan(60);
  });
  it("an agent with the board on is told; the whole section leaves with the board switched off", () => {
    const on = buildFleetInstructions({ ...base, taskBoard: true });
    expect(on).toContain(CLAIM);
    const off = buildFleetInstructions({ ...base, taskBoard: false });
    expect(off).not.toContain("task claim");
    expect(off).not.toContain("Progress Tracking");
    expect(off).not.toContain("Task Board");
    // The helper that does it: the section is cut, the rest of the template is whole.
    expect(withoutTaskBoardGuidance(template)).not.toContain("task claim");
    expect(withoutTaskBoardGuidance(template)).toContain("## Context Protection");
  });
  it("a custom workflow is the person's own: the sentence is not added to it", () => {
    expect(buildFleetInstructions({ ...base, workflow: "## My flow\n\nDo it well." })).not.toContain("task claim");
  });
  it("the CLI instructions say it on the claim command; with the board off the line is gone", () => {
    expect(cli).toMatch(/^agend-agent task claim ID\s+# Claim a card before you work on it$/m);
    expect(withoutTaskCommands(cli)).not.toContain("task claim");
  });
});
