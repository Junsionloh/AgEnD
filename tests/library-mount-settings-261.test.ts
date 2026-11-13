/**
 * AGEND-261: the settings confirmation layer lets an administrator mount library items. It used to refuse every `library.skills` / `library.mcp`
 * change ("unsupported_sensitive_effect": a string list under a key it does not know), so ticking a team skill or MCP server in Settings, or the
 * Library's "+", never applied. Exactly a list of library ids is an ordinary setting now; anything else under `library` is still refused.
 */
import { describe, expect, it } from "vitest";
import { settingsChangeDiff } from "../src/settings-change.js";

const fleet = (library?: unknown) => ({ fleet: { instances: { coder: { working_directory: "/w", ...(library === undefined ? {} : { library }) } } } });
const diff = (before: unknown, after: unknown) => settingsChangeDiff(before, after, { operation: "test" });
/** Not applied quietly: refused outright, or held for a confirmation card. */
const notQuiet = (before: unknown, after: unknown): boolean => { try { return diff(before, after) !== null; } catch { return true; } };
const refused = (before: unknown, after: unknown): string | null => { try { diff(before, after); return null; } catch (e) { return (e as any)?.code ?? String(e); } };

describe("mounting library items is an ordinary setting", () => {
  it.each(["skills", "mcp"])("adding, changing and removing a %s list applies directly (no confirmation card)", (key) => {
    expect(diff(fleet(), fleet({ [key]: ["a-1", "b"] }))).toBeNull();
    expect(diff(fleet({ [key]: ["a"] }), fleet({ [key]: ["a", "b"] }))).toBeNull();
    expect(diff(fleet({ [key]: ["a"] }), fleet())).toBeNull();
    expect(diff(fleet({ skills: ["s"], mcp: ["m"] }), fleet({ skills: ["s"], mcp: ["m", "n"] }))).toBeNull();
  });

  it.each(["skills", "mcp"])("a %s list that is not exactly library ids is still refused", (key) => {
    for (const bad of [["../x"], ["A"], ["a b"], [3], [{ id: "a" }], ["a".repeat(65)], "a", { a: 1 }, ["con\nfig"]]) {
      expect(notQuiet(fleet(), fleet({ [key]: bad })), JSON.stringify(bad)).toBe(true);
    }
    expect(refused(fleet(), fleet({ [key]: ["../x"] }))).toBe("unsupported_sensitive_effect");
  });

  it.each(["skills", "mcp"])("AGEND-261: the paused %s list is an ordinary setting too, and only when it is exactly library ids", (key) => {
    expect(diff(fleet(), fleet({ paused: { [key]: ["a"] } }))).toBeNull();
    expect(diff(fleet({ skills: ["a"] }), fleet({ paused: { skills: ["a"] } }))).toBeNull();            // switching one off: it moves from the given list to the paused one
    expect(diff(fleet({ paused: { [key]: ["a"] } }), fleet())).toBeNull();
    for (const bad of [["../x"], [3], [{ id: "a" }], "a", { a: 1 }]) expect(notQuiet(fleet(), fleet({ paused: { [key]: bad } })), JSON.stringify(bad)).toBe(true);
    expect(refused(fleet(), fleet({ paused: { [key]: ["../x"] } }))).toBe("unsupported_sensitive_effect");
    expect(notQuiet(fleet(), fleet({ paused: { other: ["a"] } }))).toBe(true);
  });

  it("only an agent's own library: another key, or the same key anywhere else, is judged as before", () => {
    expect(refused(fleet(), fleet({ other: ["a"] }))).toBe("unsupported_sensitive_effect");
    expect(refused({ fleet: { defaults: {} } }, { fleet: { defaults: { library: { mcp: ["a"] } } } })).toBe("unsupported_sensitive_effect");
    expect(refused({ fleet: { instances: { coder: { tools: {} } } } }, { fleet: { instances: { coder: { tools: { mcp: ["a"] } } } } })).toBe("unsupported_sensitive_effect");
  });
});
