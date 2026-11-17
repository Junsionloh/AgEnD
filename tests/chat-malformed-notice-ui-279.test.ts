/**
 * AGEND-279, the page: agy's notice about a malformed tool call (see acp-malformed-call-279.test.ts) is one quiet line in the chat's block —
 * "agy retried a malformed tool call" / "agy 重試了一次格式錯誤的工具呼叫" — with the CLI's own words folded behind it, never "Said".
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { fire, installDom } from "./helpers/mini-dom.js";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";

type Mod = any;
let row: Mod, i18n: Mod, html: Mod, render: Mod;
beforeAll(async () => {
  const base = installDom({ storage: { agend_tour_done: "1" } });
  row = await import("/ui/js/log-row.js");
  i18n = await import("/assets/app-i18n.js");
  ({ html, render } = await import("/assets/app-html.js"));
  base.restore();
});
let pg: AppPage | null = null;
afterEach(async () => { await pg?.unmount(); pg?.restore(); pg = null; i18n.setLang("en"); });
void h;

const NOTICE = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "acp", "agy-malformed-call-update.json"), "utf8")).content.text as string;
const notice = { id: "n-T-3", turn: "T", ts: 1, kind: "state", note: "malformed_call", status: "done", body: NOTICE };
const said = { id: "a-T-4", turn: "T", ts: 2, kind: "assistant", status: "done", body: "指令執行完成" };

async function draw(x: Record<string, unknown>, props: Record<string, unknown> = { compact: true, chat: true }) {
  pg = page();
  const host = (pg.document as any).createElement("ol"); (pg.document as any).body.append(host);
  render(html`<${row.LogRow} x=${x} ...${props} />`, host);
  await settle();
  return host;
}

describe("in the chat's block", () => {
  it("one line with the notice's name in English, the CLI's words hidden until the line is opened", async () => {
    const host = await draw(notice);
    expect(host.querySelector(".log-label, .log-sum").textContent).toBe("agy retried a malformed tool call");
    expect(host.textContent).not.toContain("Said");
    expect(host.textContent).not.toContain("SYSTEM_MESSAGE");                                    // the internals are not on the line
    fire(host.querySelector("button.log-toggle"), "click"); await settle();
    expect(host.querySelector(".log-detail .log-text").textContent).toContain("Retries remaining: 3");
  });
  it("in Chinese", async () => {
    i18n.setLang("zh-TW");
    const host = await draw(notice);
    expect(host.querySelector(".log-sum").textContent).toBe("agy 重試了一次格式錯誤的工具呼叫");
  });
  it("what the agent said is still 'Said', with its own words on the line", async () => {
    const host = await draw(said);
    expect(host.textContent).toContain("Said");
    expect(host.textContent).toContain("指令執行完成");
  });
  it("the header that names the current step says the same thing", () => {
    expect(row.stepLine(notice)).toBe("agy retried a malformed tool call");
    expect(row.stepLine(said)).toContain("Said");
  });
});

describe("in the Log tab", () => {
  it("the same name as a heading, the CLI's words as the text beneath it", async () => {
    const host = await draw(notice, {});
    expect(host.querySelector(".log-label").textContent).toBe("agy retried a malformed tool call");
    expect(host.querySelector(".log-text").textContent).toContain("Retries remaining: 3");
    expect(host.querySelector(".log-item").className).toContain("k-state");
  });
});
