# 資源庫（Skill 與 MCP server）

資源庫是 AgEnD 資料夾裡的一個地方，用來存放 **Skill** 和 **MCP server 定義**。Agent 只有在管理員把某個 **Skill** 掛載到它身上時才會拿到
（見下方「把 Skill 掛載到 Agent」）；沒掛載任何東西的 Agent 完全不變，不論資源庫是空的還是滿的。MCP server 目前只能存放、還不能掛載；
在匯出的 Agent 檔案裡引用資源庫項目是之後另外的步驟（匯出檔已經預留一個空的 `library:` 欄位）。

從側邊欄的 **資源庫**（`/ui/library`）開啟。只有管理員可以使用；沒用過的 fleet 不會產生 `library/` 資料夾。

## 總覽

這一頁是總覽：這個 AgEnD 有哪些 **Skill**、**工具**和 **MCP server**（各一張卡片），以及哪些 Agent 在使用。每張卡片有兩種項目：

- **內建・唯讀**：隨 AgEnD 附帶，從套件與程式碼列出，不能在這裡修改：內建 Skill（`src/general-knowledge/skills`，並標出適用角色：General、一般 Agent、Classic bot）、
  `tool_set` 各 profile（`TOOL_PROFILES`，含工具清單）、AgEnD 自己的 `agend` MCP server。
- **團隊新增**：下面的資源庫項目，可新增、檢視、刪除。

每個項目都標出「使用中」：內建 Skill 依 Agent 的角色（General 拿到全部，其他 Agent 拿到標給一般 Agent 的）、工具組依 Agent 的 `tool_set`（和 daemon 用同一條規則）、
`agend` MCP server 是所有 Agent、團隊 Skill 依掛載到哪些 Agent。這一頁只讀現有設定，不會改變任何 Agent 的檔案、設定或啟動指令。
團隊 Skill 掛在 CLI 沒有 skill 資料夾的 Agent 上（對照表在 `src/native-skills-dir.ts`）會被標出來：它在那裡不會生效。Agent 設定頁的「團隊 Skill」欄位也會顯示同樣的提醒。

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
- **取消掛載**只刪記錄裡列出的資料夾，而且只刪「內容仍和 AgEnD 寫入時完全一樣」的（記錄裡保存了它的 hash）。沒掛載過、也沒有記錄的 Agent 不會多出任何檔案。
- **只有通過所有規則、且仍是儲存當時內容的 Skill 才會交出去。** 在資源庫資料夾裡被手動改過、或沒經過資源庫頁儲存就放進去的 Skill，要重新儲存後才會交出去；已經交出去的維持原樣。
- **共用同一個工作目錄的 Agent** 共用它的 skill 資料夾，所以該資料夾拿到它們掛載的聯集（否則每次啟動都會刪掉另一個 Agent 拿到的東西）。
- **你在已發佈資料夾裡做的修改就是你的。** 若已發佈的資料夾和 AgEnD 寫入的內容不同（你改過，或換成你自己的同名資料夾），AgEnD 不會用資源庫的更新覆蓋它，
  也絕不刪除它，連取消掛載也不會（只是把它從記錄移除，並在 log 說明）。想拿回資源庫的版本，請刪掉該資料夾並重啟 Agent。
- **何時同步：** 只有 fleet Agent 或 General 啟動時才會發佈（ClassicBot 房間、Windows native Agent 不會）。已刪除的 Agent 留在共用資料夾的 skill，
  要等同一資料夾的另一個 Agent 重啟後才會被清掉（那次啟動會清除不再掛載的項目）。

## 密鑰

任何看起來像金鑰、token 或密碼的內容（和 Agent 匯出用同一套掃描）都會被拒絕，並說明哪個檔案、第幾行，不會顯示值。

## 安全

讀取時把資料夾當作不可信：不跟隨 symlink（含有 symlink 的項目會顯示「無法使用」）、限制大小、只列出合法 id。寫入先驗證再原子地寫入。
鎖檔讓之後的步驟能分辨「被手動改過」、「不是從這個頁面加入」和「檔案不見了」的項目。

## Web 路由（僅管理員）

`GET /ui/library/list`、`GET /ui/library/item?kind=skill|mcp&id=<id>`、`GET /ui/library/overview`（內建 Skill、工具組、`agend` MCP server 與使用情形；唯讀）、`POST /ui/library/save`、`POST /ui/library/delete`。
