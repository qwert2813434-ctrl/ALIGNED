// 英文語言包。key＝程式碼裡的繁中原文（見 ../i18n.ts）。
// 缺譯的 key 會自動回中文原文，所以漏掉不會壞、只是那一條顯示中文。
//
// 翻譯守則：
//   - 鍵盤快捷鍵原樣保留（⌘Z／⇧⌘Z／⌫…），不譯不改。
//   - 介面空間窄，優先簡短：面板標籤用名詞，動作用動詞原形。
//   - 同一個中文 key 只能有一個英譯 —— 「中」在水平／垂直對齊都用 Center
//     （兩排各有自己的標題，不會混淆）。

export const en: Record<string, string> = {
  // ── index.html：工具列與畫布控制 ──
  "回首頁（最近專案）": "Home (recent projects)",
  "加文字": "Add text",
  "加矩形": "Add rectangle",
  "加圓形": "Add ellipse",
  "加線條": "Add line",
  "加照片": "Add photo",
  "專案資訊（頁數・尺寸・選取座標）": "Project info (pages, size, selection)",
  "復原（⌘Z）": "Undo (⌘Z)",
  "重做（⇧⌘Z）": "Redo (⇧⌘Z)",
  "新專案（⌘N）": "New project (⌘N)",
  "開啟（⌘O）": "Open (⌘O)",
  "存檔（⌘S）": "Save (⌘S)",
  "匯出範本（不含素材）": "Export template (no assets)",
  "匯出 PNG（⌘E）": "Export PNG (⌘E)",
  "縮放至整台 stage": "Fit whole stage",
  "未命名專案": "Untitled project",
  "縮小（⌘−）": "Zoom out (⌘−)",
  "全部看到（⌘0）": "Fit to view (⌘0)",
  "放大（⌘＋）": "Zoom in (⌘＋)",
  "有聲／靜音": "Sound / mute",
  "白盒／暗房": "Light / dark",

  // ── 畫布比例（label 而已，key 是 "4:5" 那種，不受影響）──
  "1:1 方形": "1:1 Square",
  "4:5 直式": "4:5 Portrait",
  "3:4 直式": "3:4 Portrait",
  "9:16 全螢幕": "9:16 Full screen",
  "1.91:1 橫式": "1.91:1 Landscape",

  // ── 濾鏡顯示名（資料鍵是 a1/a2/c4，翻譯不影響存檔）──
  "銀鹽硬調": "Silver Halide",
  "經典中性": "Classic Neutral",
  "褪色霧面": "Faded Matte",
  "紅色濾鏡": "Red Filter",
  "正片負沖": "Cross Process",
  "仿紅外線": "Infrared",
  "報紙": "Newsprint",
  "底片顆粒": "Film Grain",
  "高級紙": "Fine Paper",

  // ── 字型與字重（value 是家族鍵，翻譯不影響存檔）──
  "黑體（系統）": "Sans (system)",
  "粉圓體": "Huninn",
  "思源宋體": "Noto Serif TC",
  "源樣明體": "GenYo Min",
  "極細": "Thin",
  "細": "Light",
  "標準": "Regular",
  "粗": "Bold",
  "特粗": "Black",

  // ── 檢視器：選取與對齊 ──
  "（空白文字）": "(empty text)",
  "矩形": "Rectangle",
  "圓形": "Ellipse",
  "線條": "Line",
  "形狀": "Shape",
  "影片": "Video",
  "圖片": "Image",
  "空欄位": "Empty",
  "點選畫布上的元件來調整；\n拖曳＝移動並吸附、方向鍵＝微移":
    "Select an element on the canvas to adjust it.\nDrag to move and snap, arrow keys to nudge.",
  "已選 {n} 個元件": "{n} elements selected",
  "文字（{n} 個一起改）": "Text ({n} together)",
  "（混合）": "(Mixed)",
  "對齊頁面": "Align to page",
  "拷貝": "Copy",
  "貼上": "Paste",
  "已拷貝 {n} 個元件——⌘V 貼上，開另一份專案貼也行": "Copied {n} element(s) — ⌘V to paste, even into another project",
  "貼上了 {n} 個元件": "Pasted {n} element(s)",
  "貼上了 {n} 個，{m} 個素材的來源檔找不到（顯示成佔位框）": "Pasted {n}; {m} asset source file(s) missing (shown as placeholders)",
  "貼上失敗：{msg}": "Paste failed: {msg}",
  "透明": "Transparent",
  "只留文字": "Text only",
  "_透明": "_alpha",
  "透明背景：跳過頁底色與紙張，出 RGBA PNG（給剪輯疊層用）":
    "Transparent background: skip the page color and paper, export RGBA PNG (for editing overlays)",
  "只留文字：藏起圖片與影片，出字幕／片尾疊層":
    "Text only: hide images and videos, export a subtitle / credits overlay",
  "輸出倍率：2×＝畫布兩倍像素（16:9 畫布＝4K）":
    "Output scale: 2× = double the canvas pixels (16:9 canvas = 4K)",
  "貼左頁邊": "Left page edge",
  "頁面水平置中": "Center horizontally on page",
  "貼右頁邊": "Right page edge",
  "貼頁頂": "Top page edge",
  "頁面垂直置中": "Center vertically on page",
  "貼頁底": "Bottom page edge",
  "水平對齊": "Align horizontally",
  "垂直對齊": "Align vertically",
  "左": "Left",
  "中": "Center",
  "右": "Right",
  "上": "Top",
  "下": "Bottom",
  "等距分布": "Distribute evenly",
  "水平": "Horizontal",
  "垂直": "Vertical",
  "等距分布至少要選三個": "Select at least three elements to distribute",
  "複製一份": "Duplicate",
  "刪除 {n} 個（⌫）": "Delete {n} (⌫)",
  "⇧／⌘ 點＝加減選、空白處拖曳＝框選；\n拖曳任一個＝整組移動（相對位置不變）":
    "⇧/⌘ click to add or remove, drag empty space to marquee.\nDrag any one to move the whole group (relative positions stay).",

  // ── 檢視器：專案 ──
  "專案": "Project",
  "{cur}　{w}×{h}（目前）": "{cur}　{w}×{h} (current)",
  "畫布比例": "Canvas ratio",
  "紙張": "Paper",
  "無": "None",
  "頁面背景": "Page background",
  "第 {n} 頁": "Page {n}",

  // ── 檢視器：參考線 ──
  "參考線": "Guides",
  "狀態": "State",
  "已隱藏": "Hidden",
  "顯示中": "Visible",
  "已鎖定": "Locked",
  "可拖曳": "Draggable",
  "新增": "Add",
  "垂直線": "Vertical guide",
  "水平線": "Horizontal guide",
  "刪除": "Delete",
  "已鎖定：畫布上碰不到，改數值或解鎖": "Locked — can't be grabbed on canvas. Edit the value or unlock.",
  "畫布上可直接拖；拖出頁面外＝丟掉": "Drag directly on the canvas. Drag past the page to discard.",
  "還沒有參考線。加一條，或從畫布上拖出來": "No guides yet. Add one, or pull one off the canvas edge.",

  // ── 檢視器：圖層 ──
  "圖層": "Layers",
  "圖層　第 {n} 頁": "Layers　page {n}",
  "解除鎖定": "Unlock",
  "鎖定": "Lock",
  "上＝最前面，拖曳換前後": "Top = frontmost. Drag to reorder.",
  "這一頁還沒有元件": "Nothing on this page yet",

  // ── 檢視器：位置與尺寸 ──
  "位置與圖層": "Position & layer",
  "位置": "Position",
  "尺寸": "Size",
  "旋轉": "Rotation",
  "不透明": "Opacity",
  "移到最前": "Bring to front",
  "移到最後": "Send to back",
  "刪除元件（⌫）": "Delete element (⌫)",

  // ── 檢視器：文字 ──
  "文字": "Text",
  "內容": "Content",
  "字型": "Font",
  "字重": "Weight",
  "字級": "Size",
  "字距 em": "Tracking (em)",
  "行高 ×": "Line height ×",
  "對齊": "Align",
  "段落間距": "Paragraph spacing",
  "直排": "Vertical writing",
  "欄序左起": "Columns left to right",
  "顏色": "Color",
  "長文框": "Text frame",
  "框大小": "Frame size",
  "框內對齊": "Align in frame",
  "特效": "Effects",
  "陰影": "Shadow",
  "柔和": "Soft",
  "明顯": "Strong",
  "陰影色": "Shadow color",
  "底色": "Background",

  // ── 檢視器：形狀 ──
  "類型": "Type",
  "圓角": "Corner radius",
  "粗細": "Thickness",

  // ── 檢視器：圖片與影片 ──
  "更換圖片／影片…": "Replace image / video…",
  "選擇圖片／影片…": "Choose image / video…",
  "濾鏡": "Filter",
  "遮罩": "Mask",
  "圓角矩形": "Rounded rectangle",
  "橢圓": "Ellipse",
  "外框色": "Border color",
  "外框寬": "Border width",
  "拉直": "Straighten",
  "裁切比例": "Crop ratio",
  "自由": "Free",

  // ── 檢視器：排開文字 ──
  "排開文字": "Text wrap",
  "排開方式": "Wrap mode",
  "單側": "One side",
  "兩側": "Both sides",
  "上下": "Above & below",
  "這一頁沒有長文框，排開不會有反應——選那段文字，把「長文框」打開":
    "No text frame on this page, so wrapping does nothing. Select the text and turn on Text frame.",

  // ── 檢視器：介面字體 ──
  "介面字體": "Interface font",
  "自訂": "Custom",
  "系統字體": "System font",
  "{cur}（未安裝）": "{cur} (not installed)",
  "＋ 匯入字型檔…": "＋ Import font file…",

  // ── 主畫面：元件類型與操作 ──
  "續流文字": "Flowing text",
  "填圖失敗：{msg}": "Couldn't fill image: {msg}",
  "<影片名>.poster.jpg": "<video name>.poster.jpg",
  "頁數上限 20 頁": "20 pages maximum",
  "影像或影片": "Image or video",
  "匯入字型要在 App 內用（瀏覽器只是開發預覽）": "Font import only works in the app (the browser build is a dev preview)",
  "字型檔": "Font file",
  "這個字型檔讀不進來": "Couldn't read this font file",
  "已匯入字型：{name}": "Font imported: {name}",
  "匯入字型失敗：{msg}": "Font import failed: {msg}",
  "ALIGN 專案": "ALIGN project",
  "開啟失敗：{msg}": "Couldn't open: {msg}",
  "3D 物件載入失敗：{f}——檔案可能過大，減面或縮貼圖後重新置入": "3D object failed to load: {f} — the file may be too large; reduce polygons or texture size and place it again",
  "這顆模型 {mb} MB，偏大——載入慢或失敗時，建議減面或縮貼圖再置入": "This model is {mb} MB — on the heavy side. If it loads slowly or fails, reduce polygons or texture size and place it again",
  "目前參考線已存進記憶欄 {n}": "Current guides saved to memory slot {n}",
  "記憶欄 {n} 是空的——參考線面板上 ⌥點數字可存入": "Memory slot {n} is empty — ⌥-click a number in the guides panel to save into it",
  "已套用參考線記憶欄 {n}": "Applied guide memory slot {n}",
  "參考線已隱藏（⌘; 開回）": "Guides hidden (⌘; to show)",
  "參考線顯示中": "Guides shown",
  "記憶欄": "Memory",
  "點＝套用；⌥點＝存入目前參考線；⇧點＝清空": "Click = apply; ⌥-click = save current guides; ⇧-click = clear",
  "點＝套用｜⌥點＝存入目前參考線｜⇧點＝清空\n鍵盤：⌥1–9 套用、⇧⌥1–9 存入": "Click = apply | ⌥-click = save current guides | ⇧-click = clear\nKeys: ⌥1–9 apply, ⇧⌥1–9 save",
  "匯出範本失敗：{msg}": "Template export failed: {msg}",

  // ── 主畫面：頁面與元件選單 ──
  "複製這一頁（含內容）": "Duplicate page (with contents)",
  "在後面插入空白頁": "Insert blank page after",
  "往前一頁": "Move page earlier",
  "往後一頁": "Move page later",
  "刪除這一頁": "Delete page",
  "{n} 個": "{n} selected",
  "複製到其他頁": "Copy to other pages",
  "複製到第…頁": "Copy to page…",
  "移到第…頁": "Move to page…",
  "修剪影片…": "Trim video…",
  "水平置中對齊": "Center horizontally",
  "垂直置中對齊": "Center vertically",
  "在這裡加文字": "Add text here",
  "在這裡加矩形": "Add rectangle here",
  "整台縮到剛好": "Fit whole stage",
  "搬照片模式：拖曳＝在框內移動照片，Esc 離開": "Reposition mode — drag to move the photo inside its frame, Esc to exit",

  // ── 主畫面：最近專案 ──
  "{n} 分鐘前": "{n} min ago",
  "{n} 小時前": "{n} h ago",
  "{n} 天前": "{n} d ago",
  "還沒有最近專案。開一份新的，或打開 iPad AirDrop 過來的 .alignproj。":
    "No recent projects yet. Start a new one, or open an .alignproj AirDropped from iPad.",
  "從清單移除": "Remove from list",
  "開不起來：{msg}": "Couldn't open: {msg}",
  "新專案：⌘S 存檔之後才能匯入素材": "New project — save with ⌘S before importing assets",
  "匯出範本要在 App 內用": "Template export only works in the app",
  "{name}_範本.alignproj": "{name}_template.alignproj",
  "ALIGN 範本": "ALIGN template",
  "已匯出範本　{file}": "Template exported　{file}",

  // ── 主畫面：預覽與匯出 ──
  "{n} 頁為影片": "{n} pages are video",
  "第 {cur} ／ {total} 張・← → 翻頁{tail}": "{cur} of {total}・← → to flip{tail}",
  "頁貼著頁・檢查跨頁圖在接縫處對不對得齊{tail}": "Pages edge to edge・check that cross-page images line up at the seams{tail}",
  "一頁一張卡・多圖貼文的樣子{tail}": "One card per page・how the carousel will look{tail}",
  "{n} 頁　{w} × {h}": "{n} pages　{w} × {h}",
  "{base}　合成影片中…": "{base}　Encoding video…",
  "{base}　合成影片第 {n} 頁…": "{base}　Encoding video, page {n}…",
  "{base}　輸出第 {n} 頁…": "{base}　Exporting page {n}…",
  "{base}　✓ 已存入 {dir}": "{base}　✓ Saved to {dir}",
  "匯入素材要在 App 內用（瀏覽器只是開發預覽）": "Asset import only works in the app (the browser build is a dev preview)",
  "先 ⌘S 另存專案，素材才有地方放": "Save the project with ⌘S first so assets have somewhere to live",
  "影像載入失敗": "Couldn't load image",
  "影片讀太久，抓不到海報": "Video took too long to read — couldn't grab a poster frame",
  "影片解碼失敗": "Video decoding failed",
  "{n} 頁 · {w}×{h} · {blocks}": "{n} pages · {w}×{h} · {blocks}",
  "（素材 {have}/{want}）": "(assets {have}/{want})",

  // ── 主畫面：影片修剪 ──
  "這支 {secs} 秒——右鍵可以修剪（回 iPad 匯出會比較慢）":
    "This one is {secs}s — right-click to trim (long clips export slowly on iPad)",
  "這支": "This clip",
  "修剪中…": "Trimming…",
  "已修剪：{secs} 秒": "Trimmed to {secs}s",
  "修剪失敗：{msg}": "Trim failed: {msg}",
  "已修剪": "Trimmed",
  "播放／暫停": "Play / pause",
  "{in} – {out}　選取 {sel} 秒（原長 {dur} 秒）": "{in} – {out}　{sel}s selected (original {dur}s)",
  "超過 30 秒——回 iPad 匯出會比較慢、專案檔也大":
    "Over 30s — slower to export on iPad and the project file gets large",

  // ── 主畫面：其他 ──
  "雙擊編輯文字": "Double-click to edit text",
  "匯入失敗：{msg}": "Import failed: {msg}",
  "新增失敗：{msg}": "Couldn't add: {msg}",
  "存檔失敗：{msg}": "Save failed: {msg}",
  "已儲存　{time}": "Saved　{time}",
  "載入失敗：{msg}": "Load failed: {msg}",
  "失敗：{msg}": "Failed: {msg}",
  "新增一頁": "Add page",
  "PNG 編碼失敗": "PNG encoding failed",
  "未知的 block 型別: {type}": "Unknown block type: {type}",
  "環境不支援工人管線": "This environment doesn't support the worker pipeline",

  // ── 更新橫幅 ──
  "有新版 {version}": "Version {version} available",
  "前往下載": "Download",
  "略過此版": "Skip this version",
  "關閉": "Close",

  // ── 1.0.12：互動導覽（英文使用者的第一印象，語氣照中文版：帶著做、可以玩壞）──
  "歡迎。照著藍框走——每一步做到了會自動前進，這幾頁隨你玩壞。":
    "Welcome. Follow the blue outline — each step advances on its own once you've done it. Feel free to wreck these pages.",
  "先動視角：在畫布上雙指捲動（或 ⌘＋滾輪）縮放一下；按住空白處拖曳＝平移。":
    "Get your bearings: two-finger scroll (or ⌘ + scroll) to zoom, drag empty space to pan.",
  "搬東西：把藍框這個元件拖去別的位置——靠近別的元件會跳出吸附線，貼齊了有磁力。":
    "Move something: drag the outlined element somewhere else. Snap lines appear as you approach another element, and it pulls into place.",
  "改字：雙擊藍框這段文字，改幾個字，點外面完成。":
    "Edit text: double-click the outlined text, change a few words, then click outside.",
  "加東西：從上排這排工具加一個新元件——按 T 加文字，或按矩形。":
    "Add something: use the toolbar above — press T for text, or click the rectangle.",
  "招牌來了。點選藍框這段文字，到右側把「長文框」打開——固定容器，這是排開的前提。":
    "Here comes the signature feature. Select the outlined text and switch on Text frame on the right — a fixed container is what makes wrapping possible.",
  "再選旁邊被框住的圖，打開「排開文字」——長文會當場繞著它重新流動。開完拖拖看那張圖。":
    "Now select the outlined image beside it and switch on Text wrap — the text reflows around it immediately. Try dragging the image afterwards.",
  "就這樣。⌘S 存檔、⌘Z 反悔；之後隨時從右上齒輪回到這份導覽。":
    "That's it. ⌘S to save, ⌘Z to undo. You can reopen this tour any time from the gear menu.",
  "完成": "Done",
  "跳過這步": "Skip this step",
  "下一步": "Next",
  "結束導覽 esc": "Exit tour (esc)",

  // ── 1.0.12：齒輪選單 ──
  "操作導覽（帶著做一次）": "Interactive tour (walk through once)",
  "線上說明": "Online help",
  "回報問題（Email）": "Report a problem (email)",
  "回報問題（GitHub Issues）": "Report a problem (GitHub Issues)",
  "檢查更新": "Check for updates",
  "已是最新版（{version}）": "You're up to date ({version})",
  "連不上更新來源——檢查網路後再試": "Couldn't reach the update server — check your connection and try again",
  "ALIGNED Mac {version} 問題回報": "ALIGNED Mac {version} problem report",
  "發生了什麼事：\n\n\n怎麼重現（做了哪幾步）：\n1. \n\n———\n":
    "What happened:\n\n\nHow to reproduce it (which steps):\n1. \n\n———\n",
  "版本 {version}（build {build}）": "Version {version} (build {build})",

  // ── 1.0.12：未存草稿救援 ──
  "未儲存的草稿": "Unsaved draft",
  "「{name}」上次關掉時還沒存檔（{when}）。要接續編輯嗎？":
    "“{name}” wasn't saved when it was last closed ({when}). Pick up where you left off?",
  "接續編輯": "Continue editing",
  "捨棄": "Discard",

  // ── 頁面／元件選單的動態片語（拆成完整句，避免英文語序被中文切壞）──
  "刪除選取的 {n} 個": "Delete {n} selected",
  "　{n} 頁為影片": "　{n} pages are video",
  "{n} 頁 · {w}×{h} · {blocks} 個 block": "{n} pages · {w}×{h} · {blocks} blocks",

  // ── 1.0.22：參考線產生器 ──
  "產生器": "Generator",
  "IG 安全區": "IG safe area",
  "邊界框": "Margins",
  "欄格": "Columns",
  "模組網格": "Modular grid",
  "基線網格": "Baseline grid",
  "三分法": "Rule of thirds",
  "黃金分割": "Golden ratio",
  "格狀預覽": "Grid preview",
  "3:4（現行）": "3:4 (current)",
  "1:1（舊版）": "1:1 (legacy)",
  "邊距": "Margin",
  "欄數": "Columns",
  "溝寬": "Gutter",
  "組合": "Combo",
  "接觸印樣": "Contact sheet",
  "雜誌主從": "Editorial",
  "格比例": "Cell ratio",
  "最多列數": "Max rows",
  "列數": "Rows",
  "說明帶高": "Caption band",
  "行距": "Line step",
  "生成": "Generate",
  "收走生成的": "Remove generated",

  // ── 1.0.21：絕對對齊——貼字寬 ──
  "框寬": "Frame",
  "貼字寬": "Hug text",
  "貼字寬（全部）": "Hug text (all)",
  "把框收到剛好包住字——斷行與字的位置都不會變":
    "Shrink the frame to hug the text — line breaks and glyph positions stay put",
  "把每個文字的框收到剛好包住字——斷行與字的位置都不會變":
    "Shrink every text frame to hug its text — line breaks and glyph positions stay put",

  // ── 1.1.0～1.1.2：出場動畫／輪播／3D 物件／紙紋新選項 ──
  "出場動畫": "Entrance animation",
  "出場方式": "Entrance style",
  "移除動畫": "Remove animations",
  "陸續出現": "Appear one by one",
  "間隔": "Stagger",
  "停留": "Hold",
  "延遲": "Delay",
  "秒數": "Duration (s)",
  "方向": "Direction",
  "從上": "From top",
  "從下": "From bottom",
  "從左": "From left",
  "從右": "From right",
  "打字": "Typewriter",
  "逐句": "Phrase by phrase",
  "位移": "Slide",
  "隨機閃現": "Random flicker",
  "淡入": "Fade in",
  "縮放": "Scale",
  "兩段式": "Two-stage",
  "接著放大": "Then enlarge",
  "接著滿版": "Then full-bleed",
  "第二段大小": "Second-stage size",
  "第二段秒數": "Second-stage duration (s)",
  "播放整個版面（含影片，循環）": "Play the whole layout (videos included, loops)",
  "暫停（影片與出場動畫一起）": "Pause (videos and entrance animations together)",
  "{base}　烤動畫影格中…": "{base}　baking animation frames…",
  "{base}　動畫影格 {done}/{total}…": "{base}　animation frames {done}/{total}…",
  "{base}　烤動畫第 {n} 頁…": "{base}　baking animation page {n}…",

  "輪播": "Carousel",
  "加輪播圖…": "Add carousel images…",
  "加輪播圖失敗：{msg}": "Couldn't add carousel images: {msg}",
  // 「輪播共」是「輪播共 {n} 張」的 startsWith 前綴判斷——兩條譯文的開頭必須一致
  "輪播共": "Carousel — ",
  "輪播共 {n} 張": "Carousel — {n} images",
  "輪播間隔": "Carousel interval",
  "切換方式": "Transition",
  "直切": "Hard cut",
  "連續遮罩": "Mask wipe",
  "清空": "Clear",
  "素材": "Media",

  "3D 物件": "3D object",
  "3D 物件（GLB）": "3D object (GLB)",
  "展示方式": "Display mode",
  "靜止": "Still",
  "慢慢轉圈": "Slow spin",
  "快轉煞停": "Spin & brake",
  "圈數": "Turns",
  "秒／圈": "Sec / turn",
  "角度": "Angle",

  "套用到": "Apply to",
  "物件": "Elements",
  "背景": "Background",
  "全部頁套用": "Apply to all pages",
  "手抄紙": "Handmade paper",
  "粗手抄紙": "Rough handmade paper",
  "刪除元件": "Delete element",

  // ── 修剪影片對話框（模板字串內文，1.1.2 之前漏包） ──
  "修剪影片": "Trim video",
  "取消": "Cancel",
  "整支": "Full length",
};
