/**
 * #2868 / AGEND-122 (R1, upstream #3486): the pending-change card says where to confirm it, in the order a person can act on
 * it — the General card (the platform it was posted on), or why no General took it; "Apply now" when the server says this
 * session may confirm it itself (a signed-in fleet admin: no "Authorize this browser" DM step any more); the authenticator
 * code field while the owner's strict option asks for one (`totp: "ready"`); on a remote page (`remote: true`) the host's
 * command (`agend settings confirm <id>`) is never shown, on the AgEnD computer's own page it stays folded under "Advanced".
 * `totp: "host_only"` ("Only this computer can authorize") and `"on_host"` (a link-opening change over a link) say so, with
 * neither a field nor Apply now. The real app modules in the mini DOM; fetch is the only stub.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fire } from "./helpers/mini-dom.js";
import { settle, type AppPage } from "./helpers/app-harness.js";

const ID = "c".repeat(32);
const view = (o: Record<string, unknown> = {}) => ({ id: ID, state: "pending", section: "access", requested_at: 1, requested_by: "Chrome", expires_at: 2,
  remaining_ms: 280_000, source: "web_session", summary: ["web.session: 48 → 72"], can_withdraw: true, outcome: null, confirmation: { kind: "chat", code: ID }, ...o });
const mounted: AppPage[] = [];
afterEach(async () => { for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); } vi.unstubAllGlobals(); });

async function card(v: Record<string, unknown>, lang = "en", answers: Record<string, unknown> = {}) {
  for (const old of mounted.splice(0)) { await old.unmount(); old.restore(); }     // one page at a time
  vi.resetModules();
  const harness = await import("./helpers/app-harness.js");
  const p = harness.page({ storage: { agend_tour_done: "1", agend_lang: lang } });
  mounted.push(p);
  const calls: Array<[string, string, any]> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: { method?: string; body?: string } = {}) => {
    calls.push([init.method ?? "GET", url, init.body ? JSON.parse(init.body) : undefined]);
    const body = url in answers ? answers[url] : url === `/api/settings/pending/${ID}` ? v : {};
    const status = (body as any)?.__status ?? 200;
    return { ok: status < 400, status, json: async () => body };
  }));
  const i18n = await import("/assets/app-i18n.js" as string);
  if (lang !== "en") i18n.setLang(lang);
  const confirm = await import("/ui/js/settings-confirm.js" as string);
  const { PendingChanges } = await import("/assets/app-shell.js" as string);
  confirm.track(v, "Access & security");
  await p.mount(harness.h(PendingChanges, { inline: true }));
  await settle(4);
  const text = () => (p.root.querySelector(".pending-card")?.textContent ?? "").replace(/\s+/g, " ");
  const button = (label: string) => [...p.root.querySelectorAll(".pending-card button")].find((b: any) => b.textContent.trim() === label) as any;
  const fold = () => p.root.querySelector(".pending-card details.pending-host") as any;
  return { p, calls, text, button, confirm, fold };
}

describe("where to confirm it", () => {
  it("posting: the card is still being sent; the host's command is folded", async () => {
    const c = await card(view({ confirmation: { kind: "posting", code: ID } }));
    expect(c.text()).toContain("Sending the confirm card to General…");
    const fold = c.p.root.querySelector(".pending-card details.pending-host") as any;
    expect([fold?.querySelector("summary").textContent, fold?.querySelector("code").textContent, fold?.open ?? false]).toEqual(["Advanced: confirm on the host", `agend settings confirm ${ID}`, false]);
  });
  it("chat: names the platform the card was posted on — a connection with an id of its own by it too; none known: both", async () => {
    expect((await card(view({ confirmation: { kind: "chat", code: ID, where: [{ platform: "telegram", connection: "telegram" }] } }))).text()).toContain("To apply it, press Confirm on the card in General on Telegram.");
    expect((await card(view({ confirmation: { kind: "chat", code: ID, where: [{ platform: "discord", connection: "team-b" }] } }))).text()).toContain("in General on Discord (team-b).");
    expect((await card(view({ confirmation: { kind: "chat" } }))).text()).toContain("in General on Discord / Telegram.");
  });
  // alpha.6 feedback #2c (the user's decision hmsg-77256f66): never "type this on the host" as the card's instruction — it says
  // why no General could take it and what would; the host's command stays folded under Advanced, a last resort.
  it("host_cli: says no General could take it, never as a host command; the command only folded under Advanced; nothing to authorize", async () => {
    const c = await card(view({ confirmation: { kind: "host_cli", code: ID } }));
    expect(c.text()).toContain("No General could take the confirm card for this change.");
    expect(c.text()).not.toContain("Confirm it on the host");
    const fold = c.p.root.querySelector(".pending-card details.pending-host") as any;
    expect([fold?.querySelector("code").textContent, fold?.open ?? false]).toEqual([`agend settings confirm ${ID}`, false]);
    expect(c.button("Authorize this browser")).toBeUndefined();
  });
  it.each([
    ["no_chat", "This fleet has no chat app connected, so there is no General to send the confirm card to.", "/settings/chat"],
    ["cross_platform", "This change affects chat apps on more than one platform, so no single General can confirm it.", null],
    ["no_general", "No agent is the General in a connected chat app, so there is nowhere to send the confirm card.", "/settings"],
    ["chat_disconnected", "General's chat app is not connected right now, so the confirm card could not be sent.", "/settings/chat"],
    ["no_topic", "General has no topic in its chat yet, so the confirm card had nowhere to go.", null],
    ["post_failed", "The confirm card could not be posted in General.", "/settings/chat"],
  ])("host_cli %s: why in plain words, what to do, and where", async (reason, why, href) => {
    const c = await card(view({ confirmation: { kind: "host_cli", code: ID, reason } }));
    expect(c.text()).toContain(why);
    expect(!!c.p.root.querySelector(".pending-card .pending-why")).toBe(true);
    const link = c.p.root.querySelector(".pending-card .pending-why a") as any;
    expect(link ? link.getAttribute("href") : null).toBe(href);
    // The command is never the instruction: outside the Advanced fold the card does not show it.
    const outside = (c.p.root.querySelector(".pending-card")!.textContent ?? "").replace(c.p.root.querySelector(".pending-card details.pending-host")!.textContent ?? "", "");
    expect(outside).not.toContain("agend settings confirm");
  });
  it("a reason this page does not know (a newer server) reads as the general sentence", async () => {
    expect((await card(view({ confirmation: { kind: "host_cli", code: ID, reason: "something_new" } }))).text()).toContain("No General could take the confirm card for this change.");
  });
  it("zh-TW", async () => {
    const c = await card(view({ can_self_confirm: true, confirmation: { kind: "chat", code: ID, where: [{ platform: "discord", connection: "discord" }] } }), "zh-TW");
    expect(c.text()).toContain("要套用，請到 Discord 的 General，在確認卡上按「確認」。");
    expect(c.text()).toContain("你已用管理員身分登入，可以直接在這裡套用。");
    expect(c.button("直接套用"), "the apply button is in Chinese too").toBeDefined();
    expect(c.text()).not.toContain("授權這個瀏覽器");
    expect(c.p.root.querySelector(".pending-host summary").textContent).toBe("進階：在主機上確認");
  });
});

describe("this session (a signed-in admin)", () => {
  it("not able to confirm it here: only the General instruction — no Authorize-this-browser step, no DM authorization request, no Apply now", async () => {
    const c = await card(view());
    expect(c.text()).toContain("press Confirm on the card in General");
    expect([c.button("Apply now"), c.button("Authorize this browser")]).toEqual([undefined, undefined]);
    expect(c.text()).not.toContain("Authorize this browser");
    expect(c.text()).not.toContain("without General");
    await settle(4);
    expect(c.calls.filter(([, u]) => u.includes("authorization")), "the card never asks for the #1939 DM authorization any more").toEqual([]);
  });
  it("allowed (the server's can_self_confirm): Apply now posts the confirm and follows the answer", async () => {
    const applying = view({ state: "applying", can_withdraw: false, confirmation: { kind: "web" } });
    const c = await card(view({ can_self_confirm: true }), "en",
      { [`/api/settings/pending/${ID}/confirm`]: { __status: 202, ok: true, result: "pending_confirmation", pending_change: applying } });
    expect(c.text()).toContain("You are signed in as an admin, so you can apply it here.");
    expect(c.text()).not.toContain("This browser is verified");
    expect(c.button("Authorize this browser"), "nothing to authorize").toBe(undefined);
    fire(c.button("Apply now"), "click"); await settle(4);
    expect(c.calls.filter(([m, u]) => m === "POST" && u === `/api/settings/pending/${ID}/confirm`)).toHaveLength(1);
    expect(c.p.root.querySelector(".pending-card").className).toContain("applying");
  });
  it("Apply now refused (no longer allowed here): it says so, Apply now goes, the General instruction stays", async () => {
    const c = await card(view({ can_self_confirm: true }), "en",
      { [`/api/settings/pending/${ID}/confirm`]: { __status: 403, error: "self_confirm_unavailable" } });
    fire(c.button("Apply now"), "click"); await settle(4);
    expect([c.button("Apply now"), c.text().includes("This browser can't apply it here now. Another way to confirm it: the card in General (if this fleet has chat), or the code if your owner asks for one."), c.text().includes("press Confirm on the card in General")])
      .toEqual([undefined, true, true]);
  });
});

// AGEND-122: a page that is not the AgEnD computer's own browser (`remote: true`, any fleet) never shows the host's command.
describe("a remote page: no host command", () => {
  const outsideFold = (c: Awaited<ReturnType<typeof card>>) => (c.p.root.querySelector(".pending-card")!.textContent ?? "");
  it("remote: no Advanced fold and no `agend settings confirm` anywhere — the General instruction and Apply now stay", async () => {
    const c = await card(view({ remote: true, can_self_confirm: true }));
    expect([c.fold(), outsideFold(c).includes("agend settings confirm"), c.text().includes("press Confirm on the card in General"), !!c.button("Apply now")]).toEqual([null, false, true, true]);
  });
  it("remote, no General could take it: why in plain words, and still no host command", async () => {
    const c = await card(view({ remote: true, confirmation: { kind: "host_cli", code: ID, reason: "no_chat" } }));
    expect(c.text()).toContain("This fleet has no chat app connected, so there is no General to send the confirm card to.");
    expect(c.text()).toContain("To confirm from Discord or Telegram, connect one in Settings → Chat & connections.");
    expect(c.text()).not.toContain("This computer's owner confirms it here");
    expect([c.fold(), outsideFold(c).includes("agend settings confirm")]).toEqual([null, false]);
  });
  it("not remote (the AgEnD computer's own browser): the command is there, folded", async () => {
    const c = await card(view({ remote: false }));
    expect([c.fold()?.querySelector("code").textContent, c.fold()?.open ?? false]).toEqual([`agend settings confirm ${ID}`, false]);
  });
  it("zh-TW: the same, in Chinese", async () => {
    const c = await card(view({ remote: true }), "zh-TW");
    expect([c.fold(), outsideFold(c).includes("agend settings confirm")]).toEqual([null, false]);
  });
});

// alpha.6 feedback #2c (the user's decision hmsg-468cc290 + the leader's ruling (b)): the authenticator-code confirmation.
describe("confirm with the authenticator code (strict mode: the owner asks for a code from other devices)", () => {
  const DIGEST = "d".repeat(32);
  const withCode = async (answer: { __status: number; [k: string]: unknown }, lang = "en", totp = "ready", extra: Record<string, unknown> = {}) =>
    card(view({ confirmation: { kind: "host_cli", code: ID, reason: "no_chat" }, totp, confirm_digest: DIGEST, remote: true, ...extra }), lang,
      { [`/api/settings/pending/${ID}/confirm-totp`]: answer });
  const enter = async (c: Awaited<ReturnType<typeof card>>, code: string) => {
    const input = c.p.root.querySelector(".pending-card .pending-code-input") as any;
    input.value = code; fire(input, "input"); await settle(3);
    fire(c.p.root.querySelector(".pending-card form.pending-code")!, "submit"); await settle(6);
  };
  it("ready: a code field and Confirm; the code goes with this change's digest; no host command on a remote page", async () => {
    const c = await withCode({ __status: 202, ok: true, result: "pending_confirmation", pending_change: view({ state: "applying" }) });
    const input = c.p.root.querySelector(".pending-card .pending-code-input") as any;
    expect([!!input, c.text()]).toEqual([true, expect.stringContaining("This fleet asks for an authenticator code to confirm changes from here. Enter the code your authenticator app shows.")]);
    expect(c.text()).not.toContain("Or confirm it here");
    expect(c.fold(), "a remote page shows no host command").toBe(null);
    await enter(c, "123 456");
    const call = c.calls.find(([m, u]) => m === "POST" && u.endsWith("/confirm-totp"));
    expect(call).toBeDefined();
    expect(call![2], "spaces dropped; the change's own digest goes with the code").toEqual({ code: "123456", digest: DIGEST });
  });
  it("ready, on the AgEnD computer's own page (not remote): the field and the folded command both", async () => {
    const c = await withCode({ __status: 200 }, "en", "ready", { remote: false });
    expect([!!c.p.root.querySelector(".pending-code-input"), c.fold()?.querySelector("code").textContent]).toEqual([true, `agend settings confirm ${ID}`]);
  });
  it("zh-TW: the code lead is in Chinese", async () => {
    const c = await withCode({ __status: 200 }, "zh-TW");
    expect(c.text()).toContain("這個 fleet 要求從這裡確認變更時輸入驗證器代碼。請輸入驗證器 App 目前顯示的代碼。");
  });
  it.each([
    [{ __status: 401, error: "wrong_code" }, "That code is not right. Use the current code in your authenticator app."],
    [{ __status: 409, error: "confirmation_changed" }, "This change is no longer the one shown here. Reload the page and check it again."],
    [{ __status: 429, error: "paused", retryAfterMs: 15 * 60_000 }, "Too many wrong codes. Try again in 15 minutes."],
  ])("refused (%j): says why, in plain words", async (answer, words) => {
    const c = await withCode(answer as any);
    await enter(c, "123456");
    expect(c.text()).toContain(words);
  });
  it("over a link (on_host): no field — a change that opens a public link can't be confirmed over a link; never a host command", async () => {
    const c = await withCode({ __status: 200 }, "en", "on_host");
    expect([!!c.p.root.querySelector(".pending-code-input"), c.text()]).toEqual([false, expect.stringContaining("A change that opens a public link can't be confirmed over a link. Confirm it from a direct connection, or in the browser on the computer running AgEnD.")]);
    expect([c.fold(), (c.p.root.querySelector(".pending-card")!.textContent ?? "").includes("agend settings confirm"), c.button("Apply now")]).toEqual([null, false, undefined]);
  });
  it("host_only (“Only this computer can authorize” is on): no field, no Apply now — only the AgEnD computer's own browser confirms", async () => {
    const c = await withCode({ __status: 200 }, "en", "host_only");
    expect(c.text()).toContain("Only the computer running AgEnD can confirm changes here: “Only this computer can authorize” is turned on. Confirm it in the browser on that computer.");
    expect([!!c.p.root.querySelector(".pending-code-input"), !!c.p.root.querySelector(".pending-host-only"), c.button("Apply now"), c.fold()]).toEqual([false, true, undefined, null]);
    expect(c.text()).not.toContain("authenticator code");
  });
  it("host_only, zh-TW", async () => {
    const c = await withCode({ __status: 200 }, "zh-TW", "host_only");
    expect(c.text()).toContain("目前只有執行 AgEnD 的那台電腦能確認變更（已開啟「只有這台電腦可以授權」）。請到那台電腦的瀏覽器確認。");
  });
  it("no authenticator set up (strict mode on, no app): says so, plain text — no link, no field; repair it on the AgEnD computer", async () => {
    const c = await withCode({ __status: 200 }, "en", "not_set_up");
    expect(c.text()).toContain("This fleet asks for an authenticator code to confirm changes from other devices, but no authenticator is set up. Set one up again on the computer running AgEnD (Settings → Access & security), or turn that option off there.");
    expect([!!c.p.root.querySelector(".pending-code-input"), c.p.root.querySelector(".pending-code-setup a")]).toEqual([false, null]);
    const zh = await withCode({ __status: 200 }, "zh-TW", "not_set_up");
    expect(zh.text()).toContain("這個 fleet 要求從其他裝置確認變更時輸入驗證器代碼，但還沒有設定驗證器。請到執行 AgEnD 的那台電腦，在「設定 → 存取與安全」重新設定驗證器 App，或在那裡關閉這個選項。");
  });
  it("Apply now wins: a session the server lets apply (can_self_confirm) gets no code field and no host-only / on-host line", async () => {
    const c = await withCode({ __status: 200 }, "en", "ready", { can_self_confirm: true });
    expect([!!c.button("Apply now"), !!c.p.root.querySelector(".pending-code-input"), !!c.p.root.querySelector(".pending-host-only")]).toEqual([true, false, false]);
  });
});
