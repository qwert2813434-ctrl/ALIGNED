# ALIGNED Local MCP

ALIGNED 的本機 MCP server。它不連 OpenAI API、不上傳專案，也不需要雲端伺服器；AI 客戶端透過 stdio 啟動這支程式。

協議層採官方 MCP TypeScript SDK v2，可服務目前的 MCP `2026-07-28` 協議，也保留對 2025 年版客戶端的相容。

## 現有工具

- `aligned_inspect_project`：讀專案摘要與驗證結果
- `aligned_validate_project`：檢查結構、畫布、跨頁文字、素材與重複 ID
- `aligned_render_preview`：呼叫 ALIGNED 本人的渲染核心產生單頁 PNG，圖片直接回傳給 AI
- `aligned_create_project`：建立空白專案
- `aligned_add_text`：加入可編輯文字，正確烤入 iOS AttributedString 顏色
- `aligned_add_shape`：加入矩形、橢圓或線
- `aligned_update_blocks`：依 block ID 更新位置、尺寸、文字與狀態
- `aligned_mobile_connection`：用行動版設定頁顯示的位址與配對碼，連接／查看／中止 iPhone 或 iPad
- `aligned_get_app_state`：讀取正在執行的 ALIGNED App、未儲存 revision 與目前選取
- `aligned_update_live_blocks`：直接修改已開啟畫布；版本不一致就拒絕，並進入 ALIGNED Undo
- `aligned_add_live_text`：在已開啟畫布加入可編輯標題或長文框，同樣檢查 revision 並進入 Undo
- `aligned_app_history`：對已開啟畫布執行 Undo／Redo

修改工具預設另存 `<原名> AI.<副檔名>`。只有明確傳入 `overwrite: true` 才能覆寫來源；第一次覆寫前會留下 `.bak`。
預覽沒有指定 `output_path` 時只建立暫存 PNG，回傳圖片後立即清除；需要保留檔案時才指定輸出位置，且不會覆蓋既有檔案。

## 本機執行

需求：Node.js 20 以上。

```zsh
npm run mcp
```

macOS 可直接讀寫 `.alignproj`；Windows 目前與 ALIGNED 桌面版本身相同，只支援 `project.json` 專案資料夾。

## Codex 設定

把下列設定加入 Codex 的 `config.toml`，將路徑換成自己的 ALIGNED repo：

```toml
[mcp_servers.aligned]
command = "node"
args = ["/absolute/path/to/align-core/mcp/server.mjs"]
```

重新啟動 Codex 後，要求它列出 ALIGNED 工具，或直接說：

> 建立一份兩頁 1080×1350 的 ALIGNED 專案，第二頁放一個標題，完成後驗證專案。

## 即時共編測試

先開啟 ALIGNED 桌面版與一份專案，在畫布點選一個物件，再對 AI 說：

> 讀取 ALIGNED 現在的 App state，告訴我選到什麼；把選取文字改成「AI 正在共編」，先不要存檔。

也可以直接要求：

> 在目前專案第五頁加入一個「MCP・與 AI 共編」標題，再加入一段說明；動手前先讀取 revision。

即時修改必須帶前一次讀到的 project ID 與 revision。期間只要使用者、另一個 AI 或 Undo 改過畫布，
舊 revision 就失效，MCP 會拒絕覆蓋並要求重讀。AI 修改會出現在 ALIGNED 自己的 Undo 歷史；
第一版不啟動 2.5 秒自動存檔，但使用者之後存檔、繼續編輯或關閉 App 時仍遵守 ALIGNED 原本的保存機制。

## 連接 iPhone／iPad（同一個 Wi-Fi）

1. 在行動版 ALIGNED 的「設定 → AI 共編（區域網路）」打開開關。
2. 保持 ALIGNED 在前景並打開要修改的專案。
3. 直接把畫面上的連線位置與配對碼告訴 AI；AI 呼叫 `aligned_mobile_connection` 後，本次 MCP session 的即時畫布工具就會切到行動版。連線不會永久保存。

開發者也可以在啟動 MCP server 時直接帶入環境變數：

```zsh
ALIGNED_LAN_HOST=192.168.1.20 \
ALIGNED_LAN_PORT=49777 \
ALIGNED_LAN_TOKEN=12345678 \
npm run mcp
```

只要三個 `ALIGNED_LAN_*` 其中之一存在，server 就切到行動版區網傳輸；三個都沒設時維持原本的桌面 App 本機 IPC。資料不經 ALIGNED 伺服器，App 進背景或關閉開關會立即停止連線。

## 開發測試

```zsh
npm run test:mcp
```

目前同時有「修改專案 → 看預覽圖 → 再修」的檔案式閉環，以及可讀取目前選取、直接改畫布、
新增文字並共用 Undo 的 App IPC。預覽支援內嵌／系統字型、
圖片、影片海報、濾鏡、紙張與去背遮罩；3D 物件暫時顯示線框佔位，僅安裝在 ALIGNED App
資料夾而未隨專案攜帶的自訂字型可能回落。App IPC 目前可新增文字，並修改既有 block 的位置、尺寸、
旋轉、透明度、文字與文字色；新增圖形、置入素材與即時頁面預覽仍是下一階段。
