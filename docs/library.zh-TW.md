# 資源庫（Skill 與 MCP server）

資源庫是 AgEnD 資料夾裡的一個地方，用來存放 **Skill** 和 **MCP server 定義**。Agent 只有在管理員把某個 **Skill** 掛載到它身上時才會拿到
（見下方「把 Skill 掛載到 Agent」）；沒掛載任何東西的 Agent 完全不變，不論資源庫是空的還是滿的。資源庫 **MCP server** 用同樣方式掛載，目前只支援 Claude Code 和 Codex 的 Agent（見「把 MCP server 掛載到 Agent」）；
在匯出的 Agent 檔案裡引用資源庫項目是之後另外的步驟（匯出檔已經預留一個空的 `library:` 欄位）。

從側邊欄的 **資源庫**（`/ui/library`）開啟。只有管理員可以使用；沒用過的 fleet 不會產生 `library/` 資料夾。

## 總覽

這一頁是總覽：這個 AgEnD 有哪些 **Skill**、**工具**和 **MCP server**，以及哪些 Agent 在使用。版面和設定頁一樣：左邊是分類列表（設定頁自己的 `.s-nav`），
右邊只顯示選到的分類，上面有篩選框；手機上 `/ui/library` 是分類列表，點一個分類才進到它自己的頁面（`/ui/library/skills`、`/tools`、`/mcp`），有返回連結。
每個項目是**兩行**的一列，三個分類一模一樣：第一行是名稱和說明（截斷成一行），第二行是使用中的 Agent、適用角色或大小、以及內建／團隊標記。
「詳細內容」固定在列的右側、對列垂直置中，不會跟著內容移位（旁邊還有導出和刪除；寬度小於 600 px 時，列裡只留「詳細內容」，導出和刪除在它打開的對話框裡）。
一列最多顯示三個 Agent 標籤（手機一個），其餘收成 **+N**，點它會打開該項目，不會讓列變高。每個分類有兩組：

- **內建・唯讀**：隨 AgEnD 附帶，從套件與程式碼列出，不能在這裡修改：內建 Skill（`src/general-knowledge/skills`，並標出適用角色：General、一般 Agent、Classic bot）、
  `tool_set` 各 profile（`TOOL_PROFILES`，含工具清單）、AgEnD 自己的 `agend` MCP server。
- **團隊新增**：下面的資源庫項目，可新增、導入、導出、檢視、編輯（Skill）、刪除。

**使用中**是一排標籤，每個 Agent 一個：內建 Skill 依 Agent 的角色（General 拿到全部，其他 Agent 拿到標給一般 Agent 的，且只算 CLI 有 skill 資料夾的）、
工具組依 Agent 的 `tool_set`（和 daemon 用同一條規則）、`agend` MCP server 是所有 Agent、團隊 Skill 依掛載到哪些 Agent。點標籤會開啟該 Agent：
團隊 Skill 直接到「設定 → 該 Agent → 工作目錄 → 團隊 Skill（來自資源庫）」，其他到該 Agent 頁。團隊 Skill 另有一個 **＋** 標籤：挑 Agent 就會寫進它們的設定，
寫的是同一個 `library` 值、同一個 `PATCH /api/settings/fleet/instances/<name>`、同一個 Apply，和在 Agent 自己的設定頁勾選完全一樣
（`settings-model.js` 的 `agentPatchRequest`／`libraryMountPatch` 是這個寫入唯一的一份）。下次啟動時生效。內建的標籤只能跳轉，內建項目不能加也不能改。

這一頁只讀現有設定，自己不改任何東西：除非你用 **＋**（或 Agent 自己的設定），否則不會改變任何 Agent 的檔案、設定或啟動指令。
團隊 Skill 掛在 CLI 沒有 skill 資料夾的 Agent 上（對照表在 `src/native-skills-dir.ts`），標籤和 Agent 設定頁的「團隊 Skill」欄位都會標出：它在那裡不會生效。
團隊 MCP server 同樣有 **＋** 標籤和「使用中」標籤（掛在 CLI 不支援資源庫 MCP 的 Agent 上會標出）；按 **＋** 會先顯示它要執行什麼並請你確認（見下）。

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

管理員在 **設定 → 該 Agent → 工作目錄 → 團隊 Skill（來自資源庫）** 勾選團隊 Skill，或直接寫在 `fleet.yaml`：

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

## 把 MCP server 掛載到 Agent

*AGEND-261。* 管理員在 **設定 → 該 Agent → 工作目錄 → 團隊 MCP（來自資源庫）**（在「團隊 Skill」下面）勾選，或用資源庫 MCP 列上的 **＋** 標籤。它是 Agent 在 `fleet.yaml` 裡的
`library.mcp: [id, …]`，權限和 `library.skills` 同一條線：只能設給單一 Agent、只有管理員能改、沒有任何 Agent 工具（含 General）能寫、是冷鍵（重啟 Agent 才生效）。

**寫了什麼。** 每次啟動時，daemon 把掛載的項目變成該 CLI 自己的 MCP 設定項目，名稱是 `agend-lib-<id>`，和 AgEnD 自己的 `agend` server 並列：

| CLI | 位置 | 形式 |
|---|---|---|
| Claude Code | `<instance 目錄>/mcp-config.json`（`--mcp-config`），有值時權限 0600 | `command`/`args`/`env`，或 `type: http` + `url` + `headers` |
| Codex | 隔離的 `CODEX_HOME/config.toml`（0600） | `[mcp_servers.agend-lib-<id>]`（另有 `.env`／`.http_headers` 表）；每個字串都以 TOML 基本字串跳脫，寫完會再解析回來比對，讀回來不一樣的就不寫入 |

你自己的 MCP 設定一律不讀、不動。沒掛載任何東西的 Agent，設定檔和啟動指令逐 byte 不變（有 golden 測試固定）。其他 CLI（OpenCode、Kiro、Grok、Muse、Antigravity…）暫不支援：
設定卡和資源庫標籤都會標示，來源是 `src/library/mcp-support.ts` 的對照表（只有這一張表，頁面裡沒有清單）；掛在這些 CLI 上的 Agent 啟動時不寫任何東西，並記一次日誌。

**變數。** 項目只寫變數名稱（stdio 用 `env`、http 用 `headers`），不寫值。值在寫設定的當下從資料夾的 `.env` 取。缺值或值是空的，該 MCP **不啟動**（什麼都不寫）——
Agent 設定卡會顯示缺哪個變數，日誌也會寫出名稱。值不會出現在任何畫面、日誌、API 回應或導出裡。少數會改變程式尋找或載入方式的變數（`PATH`、`HOME`、`NODE_OPTIONS`、`LD_PRELOAD` 等）項目不能指名。

**確認。** 把 server 交給 Agent 之前，頁面會顯示它實際會執行什麼——完整的 `command` 和 `args`，或網址與網域——以及變數名稱和「已設定／缺少」。按確認會替該 Agent 記下項目的雜湊
（`library/mcp-confirmed.json`，僅擁有者可讀寫，只有管理員的 `POST /ui/library/mcp-confirm` 會寫）。之後項目被編輯，或在資源庫外被改動，要再確認一次才會重新寫入；設定卡會顯示「內容已變更，需重新確認」。

**誠實說明：**變數值會在 Agent 啟動時交給該 MCP server，和現在 `.env` 的做法相同；讓 Agent 完全拿不到密鑰是之後的閘道工作。

## 密鑰

任何看起來像金鑰、token 或密碼的內容（和 Agent 匯出用同一套掃描）都會被拒絕，並說明哪個檔案、第幾行，不會顯示值。

## 安全

讀取時把資料夾當作不可信：不跟隨 symlink（含有 symlink 的項目會顯示「無法使用」）、限制大小、只列出合法 id。寫入先驗證再原子地寫入。
鎖檔讓之後的步驟能分辨「被手動改過」、「不是從這個頁面加入」和「檔案不見了」的項目。

## Web 路由（僅管理員）

`GET /ui/library/list`、`GET /ui/library/item?kind=skill|mcp&id=<id>`、`GET /ui/library/overview`（內建 Skill、工具組、`agend` MCP server 與使用情形；唯讀）、`POST /ui/library/save`（`expect`：編輯器讀到的雜湊；項目已被改過則回 `changed`；**取代**（`overwrite: true`）不帶 `expect` 會被拒絕（`expect_required`），Skill 和內建同名則回 `exists`）、`POST /ui/library/delete`。Skill 的 `item` 另外附 `fields` 和 `body`（把 SKILL.md 拆開給畫面用）。

MCP 掛載（AGEND-261）：`GET /ui/library/mcp-status?agent=<名稱>`（該 Agent 設定頁需要的所有 MCP 項目：會執行什麼、變數的「已設定／缺少」——只有名稱——、是否已為該 Agent 確認過目前版本、以及哪些 CLI 支援資源庫 MCP）和 `POST /ui/library/mcp-confirm`（`{ agent, id, sha256 }`；項目已是別的版本則回 `changed`）。`GET /ui/library/list` 另附 `mcpBackends`；`overview` 附 `teamMcpUsage`，每個 Agent 另有 `libraryMcp`。

Skill 的導入與導出（AGEND-257）：`GET /ui/library/export?id=<id>[&builtin=1]`、`GET /ui/library/export-all`（zip 下載）、`GET /ui/library/builtin?name=<name>`（顯示用的內建 Skill）、
`POST /ui/library/import/preview?filename=` 和 `POST /ui/library/import?sha256=&decisions=`（body 是上傳檔案的 bytes；`decisions` 是 URL 編碼的 JSON：`{ "<名稱>": { "action": "overwrite"|"rename"|"skip", "as": "<新名稱>" } }`）。
