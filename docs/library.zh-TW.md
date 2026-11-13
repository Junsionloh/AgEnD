# 資源庫（Skill 與 MCP server）

資源庫是 AgEnD 資料夾裡的一個地方，用來存放 **Skill** 和 **MCP server 定義**。Agent 只有在管理員把某個 **Skill** 掛載到它身上時才會拿到
（見下方「把 Skill 掛載到 Agent」）；沒掛載任何東西的 Agent 完全不變，不論資源庫是空的還是滿的。MCP server 目前只能存放、還不能掛載；
在匯出的 Agent 檔案裡引用資源庫項目是之後另外的步驟（匯出檔已經預留一個空的 `library:` 欄位）。

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

## 把 Skill 掛載到 Agent

管理員在 **設定 → 該 Agent → 工作區 → 資源庫** 勾選團隊 Skill，或直接寫在 `fleet.yaml`：

```yaml
instances:
  reviewer:
    library:
      skills: [pr-review, triage]
```

只有管理員能設定（設定頁或 `fleet.yaml`）；沒有任何 Agent 工具能改它，fleet 的 `defaults` 也不能。它在 Agent 下次啟動時套用，所以變更會重啟該 Agent。
內建 Skill 依 Agent 的角色自動帶入，不在這份清單裡。

每次啟動，AgEnD 會把掛載的 Skill 複製到 Agent 的 CLI 讀取的資料夾（`.claude/skills`、`.agents/skills`、`.grok/skills`、`.kiro/skills`，和內建 Skill 相同），
並把寫過的項目記在**自己的**檔案 `.agend-library-skills.json`，與內建 Skill 的記錄（`.agend-managed-skills.json`）並排，後者完全不碰。

- **同名誰優先：** 你自己建的資料夾 > 內建 Skill > 資源庫 Skill。記錄裡沒有的資料夾是你的，絕不更動或刪除；和內建 Skill 同名的資源庫 Skill 會被略過（並在 log 說一次）。
- **取消掛載**只刪記錄裡列出的資料夾。沒掛載過、也沒有記錄的 Agent 不會多出任何檔案。
- **只有通過所有規則、且仍是儲存當時內容的 Skill 才會交出去。** 在資源庫資料夾裡被手動改過、或沒經過資源庫頁儲存就放進去的 Skill，要重新儲存後才會交出去；已經交出去的維持原樣。
- **共用同一個工作目錄的 Agent** 共用它的 skill 資料夾，所以該資料夾拿到它們掛載的聯集（否則每次啟動都會刪掉另一個 Agent 拿到的東西）。
- 已發佈的 Skill 資料夾屬於 AgEnD：在裡面做的修改會在下次啟動被還原。要改 Skill，請改資源庫裡的那份。

## 密鑰

任何看起來像金鑰、token 或密碼的內容（和 Agent 匯出用同一套掃描）都會被拒絕，並說明哪個檔案、第幾行，不會顯示值。

## 安全

讀取時把資料夾當作不可信：不跟隨 symlink（含有 symlink 的項目會顯示「無法使用」）、限制大小、只列出合法 id。寫入先驗證再原子地寫入。
鎖檔讓之後的步驟能分辨「被手動改過」、「不是從這個頁面加入」和「檔案不見了」的項目。

## Web 路由（僅管理員）

`GET /ui/library/list`、`GET /ui/library/item?kind=skill|mcp&id=<id>`、`POST /ui/library/save`、`POST /ui/library/delete`。
