/**
 * The Notices page shows a `task` notice (a main task that finished by itself, or waits for the person): labelled Task / 任務, with
 * the tasks icon, the card to open (Fleet › Tasks, `?card=`) and, as for any notice about an agent, the chat of its owner. A notice
 * with no card (or an owner that is no agent of this fleet) shows only what it can open. The real panel in the mini DOM.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";

let p: AppPage, app: any, N: any, i18n: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/notices", storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = async (url: string, o: any = {}) => {
    if (url === "/ui/notices/seen") return { ok: true, json: async () => ({ seen: JSON.parse(o.body).id, unread: 0 }) };
    return { ok: false, json: async () => ({}) };
  };
  app = await import("/assets/app-store.js" as string);
  i18n = await import("/assets/app-i18n.js" as string);
  N = await import("/ui/js/panel-notices.js" as string);
});
afterAll(() => { p.restore(); delete (globalThis as any).fetch; i18n.setLang("en"); });
beforeEach(async () => { await p.unmount(); i18n.setLang("en"); });

const text = (el: any) => (el ? el.textContent.replace(/\s+/g, " ").trim() : null);
const task = (id: number, extra: Record<string, unknown> = {}) => ({ id, at: Date.now(), kind: "task", text: `✅ M-${id} "Publish the report" finished by itself.`, ...extra });
async function show(items: unknown[], instances: unknown[] = [{ name: "lead" }]) {
  app.appStore.set({ notices: app.mergeNoticeList(null, { enabled: true, items, seen: 0 }), instances });
  await p.mount(h(N.NoticesPanel, { navKey: `notices:|${Math.random()}|en` }));
  await settle();
}

describe("a task notice on the Notices page", () => {
  it("is labelled Task with its owner, says what happened, and opens the card and the owner's chat", async () => {
    await show([task(1, { instance: "lead", card: "M-1" })]);
    const item = p.root.querySelector("article.notice");
    expect(text(item.querySelector(".n-title strong"))).toBe("Task · lead");
    expect(text(item.querySelector(".notice-text"))).toBe('✅ M-1 "Publish the report" finished by itself.');
    expect(item.classList.contains("bad")).toBe(false);
    const links = item.querySelectorAll(".n-actions a").map((a: any) => [text(a), a.getAttribute("href")]);
    expect(links).toEqual([["Open the card", "/ui/fleet?card=M-1"], ["Open chat", "/ui/chat/lead"]]);
    // The same buttons as any other: the primary one opens the card, the chat one is quiet.
    expect(item.querySelectorAll(".n-actions a").map((a: any) => a.className.includes("btn-ghost"))).toEqual([false, true]);
  });

  it("a notice with no owner that is an agent here still opens its card; one with neither shows no buttons", async () => {
    await show([task(2, { instance: "gone", card: "M-2" }), task(3)], [{ name: "lead" }]);
    const items = p.root.querySelectorAll("article.notice");
    // Newest first.
    expect(items[0].querySelectorAll(".n-actions a").length).toBe(0);
    expect(items[1].querySelectorAll(".n-actions a").map((a: any) => text(a))).toEqual(["Open the card"]);
  });

  it("a card number is encoded into the address", async () => {
    await show([task(4, { card: "M-4" })]);
    expect(p.root.querySelector(".n-actions a").getAttribute("href")).toBe("/ui/fleet?card=M-4");
  });

  it("speaks 繁體中文: the label and the buttons", async () => {
    i18n.setLang("zh-TW");
    await show([task(5, { instance: "lead", card: "M-5" })]);
    const item = p.root.querySelector("article.notice");
    expect(text(item.querySelector(".n-title strong"))).toBe("任務 · lead");
    expect(item.querySelectorAll(".n-actions a").map(text)).toEqual(["打開卡片", "開啟聊天"]);
  });

  it("the other kinds are as they were: an agent notice still has only its chat button", async () => {
    await show([{ id: 6, at: Date.now(), kind: "instance", instance: "lead", text: "crashed" }]);
    const item = p.root.querySelector("article.notice");
    expect(text(item.querySelector(".n-title strong"))).toBe("Agent · lead");
    expect(item.querySelectorAll(".n-actions a").map(text)).toEqual(["Open chat"]);
  });
});
