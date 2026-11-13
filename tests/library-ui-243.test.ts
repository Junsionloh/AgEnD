/** AGEND-243: the library page — the real panel in the mini DOM with the list answered by a stub; wiring in both route tables; both languages. */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { shellRoute } from "../src/web-shell-routes.js";

let p: AppPage, L: any, R: any, I: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/library", storage: { agend_tour_done: "1" } });
  I = await import("/assets/app-i18n.js" as string);
  R = await import("/assets/app-route.js" as string);
  L = await import("/ui/js/panel-library.js" as string);
});
afterAll(() => { p.restore(); });
afterEach(async () => { await p.unmount(); vi.unstubAllGlobals(); });

const answer = (status: number, body: unknown) => vi.stubGlobal("fetch", vi.fn(async () => ({ ok: status < 400, status, json: async () => body })));

describe("the page", () => {
  it("lists skills and MCP servers (a category each, like Settings), marks one that was changed by hand, and offers View / Delete / Add", async () => {
    answer(200, { items: [
      { kind: "skill", id: "review", description: "Reviews code", status: "ok", files: 2, size: 2048, sha256: "a".repeat(64) },
      { kind: "skill", id: "old", description: "", status: "modified", files: 1, size: 10 },
      { kind: "mcp", id: "github", description: "GitHub", status: "ok", size: 300 },
    ] });
    await p.mount(h(L.LibraryPanel, { route: { panel: "library", section: "skills" }, navKey: "library:skills|1|en" })); await settle();
    const rows = p.document.querySelectorAll("[data-library-item]").map((e: any) => e.getAttribute("data-library-item"));
    expect(rows).toEqual(["skill:review", "skill:old"]);
    const text = p.document.querySelector(".p-library")!.textContent;
    expect(text).toContain("Reviews code"); expect(text).toContain("Changed by hand"); expect(text).toContain("2 files");
    expect(p.document.querySelectorAll("[data-library-view]").length).toBe(2);
    expect(p.document.querySelectorAll("[data-library-delete]").length).toBe(2);
    expect(p.document.querySelector('[data-library-add="skill"]')).not.toBeNull();
    await p.unmount();
    await p.mount(h(L.LibraryPanel, { route: { panel: "library", section: "mcp" }, navKey: "library:mcp|1|en" })); await settle();
    expect(p.document.querySelectorAll("[data-library-item]").map((e: any) => e.getAttribute("data-library-item"))).toEqual(["mcp:github"]);
    expect(p.document.querySelector('[data-library-add="mcp"]')).not.toBeNull();
  });

  it("an empty library says so in each category and offers its add; no read carries a body", async () => {
    answer(200, { items: [] });
    await p.mount(h(L.LibraryPanel, { navKey: "library:|1|en" })); await settle();
    expect(p.document.querySelector(".p-library .empty")).not.toBeNull();
    expect(p.document.querySelectorAll("[data-library-add]").length).toBe(1);
    const calls = (globalThis as any).fetch.mock.calls;
    // AGEND-248: the page also reads the overview (built-in skills and tools, who uses what); both are plain reads, neither carries a body.
    expect(calls.map((c: any) => c[0]).sort()).toEqual(["/ui/library/list", "/ui/library/overview"]);
    for (const c of calls) expect(c[1].method).toBeUndefined();
  });

  it("a session that is not an administrator is told so (not a retry)", async () => {
    answer(403, { error: "admin_required" });
    await p.mount(h(L.LibraryPanel, { navKey: "library:|1|en" })); await settle();
    expect(p.document.querySelector(".p-library")!.textContent).toContain("administrator");
    expect(p.document.querySelector(".p-library .error-state")).toBeNull();
  });

  it("a failed read is an error with Retry; the list is not shown as empty", async () => {
    answer(500, { error: "library_failed" });
    await p.mount(h(L.LibraryPanel, { navKey: "library:|1|en" })); await settle();
    expect(p.document.querySelector(".p-library .error-state")).not.toBeNull();
    expect(p.document.querySelector(".p-library .empty")).toBeNull();
  });
});

describe("the server's error codes become words, never the secret", () => {
  it("names the place of a secret and the field of a bad MCP file", () => {
    expect(L.libraryErrorText({ error: "secret_found", findings: [{ field: "notes.md", line: 3, kind: "api_key" }] }, "saveFailed")).toContain("notes.md, line 3");
    expect(L.libraryErrorText({ error: "bad_mcp", detail: "env" }, "saveFailed")).toContain("“env”");
    expect(L.libraryErrorText({ error: "exists" }, "saveFailed")).toContain("already");
    expect(L.libraryErrorText({ error: "something_new" }, "saveFailed")).toBe("Could not save.");
    expect(L.libraryErrorText(null, "saveFailed")).toBe("Could not save.");
  });
});

describe("wiring", () => {
  it("/ui/library is a shell route on the server and the client, and routePath goes back to it", () => {
    expect(shellRoute("GET", "/ui/library")).toEqual({ kind: "shell", route: { panel: "library" } });
    expect(shellRoute("POST", "/ui/library")).toBeNull();
    expect(shellRoute("GET", "/ui/library/list")).toBeNull();                 // the data routes are not pages
    expect(R.parseRoute("/ui/library")).toEqual({ panel: "library" });
    expect(R.routePath({ panel: "library" })).toBe("/ui/library");
  });

  it("the panel is loaded lazily from app.js, behind the session (not for a guest)", () => {
    const app = readFileSync("src/ui/shared/app.js", "utf8");
    expect(app).toContain('retryUrl("/ui/js/panel-library.js", a');
    expect(app.indexOf('panels.set("library"')).toBeGreaterThan(app.indexOf("if (!guest) {"));
  });

  it("every word exists in English and zh-TW, with the same placeholders", () => {
    const src = readFileSync("src/ui/panel-library.js", "utf8");
    const en = src.slice(src.indexOf("  en: {"), src.indexOf('  "zh-TW": {')), zh = src.slice(src.indexOf('  "zh-TW": {'), src.indexOf("const tn ="));
    const table = (block: string) => new Map([...block.matchAll(/(?:^|[\s,{])([a-zA-Z_0-9]+): "((?:[^"\\]|\\.)*)"/g)].map((m) => [m[1]!, m[2]!] as const));
    const holes = (v: string) => [...new Set(v.match(/\{\d\}/g) ?? [])].sort().join("");
    const e = table(en), z = table(zh);
    expect(e.size).toBeGreaterThan(60);
    expect([...z.keys()].sort()).toEqual([...e.keys()].sort());
    for (const [k, v] of e) {
      if (k === "st_ok") continue;                                   // intentionally empty: a healthy item shows no status
      expect(v.length, k).toBeGreaterThan(0);
      expect(holes(z.get(k)!), k).toBe(holes(v));
    }
    // and the registered text is the one that shows
    expect(I.t("library.title")).toBe("Library");
  });
});
