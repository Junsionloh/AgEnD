# 資源庫（Skill 與 MCP server）

資源庫是 AgEnD 資料夾裡的一個地方，用來存放 **Skill** 和 **MCP server 定義**。目前只負責存放與檢視：資源庫的內容不會交給任何 Agent，
所以不論資源庫是空的還是滿的，任何 Agent 的檔案、設定與指示都不會改變。（把資源庫的 Skill 交給 Agent、以及在匯出的 Agent 檔案裡引用
資源庫項目，是之後另外的步驟；匯出檔已經預留一個空的 `library:` 欄位給它們。）

從側邊欄的 **資源庫**（`/ui/library`）開啟。只有管理員可以使用；沒用過的 fleet 不會產生 `library/` 資料夾。

## 位置

```
<AGEND_HOME>/library/
  skills/<id>/SKILL.md          # 另可有附屬檔（references/、scripts/ …）
  mcp/<id>.yaml
  library.lock.json             # 每個項目的 sha256、大小與來源
```

`<id>` 是小寫英文、數字和連字號（最多 64 字），規則和內建 skill 相同。

## Skill

沿用 Claude Code／Multica 的格式：一個資料夾，裡面的 `SKILL.md` 以 `---` 區塊開頭，寫上 `name`（必須等於 `<id>`）和 `description`，
後面是指示內容。附屬檔必須是文字檔。上限：`SKILL.md` 100 KiB、其他檔案各 200 KiB、全部 384 KiB 與 64 個檔案；路徑為相對路徑、以 `/` 分隔、
最深 6 層，只能用英文、數字、`.`、`_`、`-`，不能隱藏，也不能跳出資料夾。

## MCP server

一個 YAML 檔，只寫 server 需要的**變數名稱**，不寫值：

```yaml
agend_library: 1
kind: mcp
name: github
description: GitHub issues and pull requests
transport: stdio            # 或 http
command: npx
args: [-y, "@modelcontextprotocol/server-github"]
env: [GITHUB_TOKEN]         # 只寫名稱；`KEY: value` 這種寫法會被拒絕
```

`http` 類型有 `url`（不能含帳密或查詢字串）和 `headers`（標頭名稱對應到存放其值的變數，例如 `Authorization: GITHUB_TOKEN`）。

## 密鑰

任何看起來像金鑰、token 或密碼的內容（和 Agent 匯出用同一套掃描）都會被拒絕，並說明哪個檔案、第幾行，不會顯示值。

## 安全

讀取時把資料夾當作不可信：不跟隨 symlink（含有 symlink 的項目會顯示「無法使用」）、限制大小、只列出合法 id。寫入先驗證再原子地寫入。
鎖檔讓之後的步驟能分辨「被手動改過」、「不是從這個頁面加入」和「檔案不見了」的項目。

## Web 路由（僅管理員）

`GET /ui/library/list`、`GET /ui/library/item?kind=skill|mcp&id=<id>`、`POST /ui/library/save`、`POST /ui/library/delete`。
