# ALIGNED 專案檔規格 — 給 AI 讀的版本

> 你是 AI（Claude、GPT 或其他），使用者把這份文件丟給你，是想要你**直接產生 ALIGNED 的專案檔**。
> ALIGNED 是免費的跨頁對齊排版工作檯（IG 輪播編輯器），Mac 版與 iPad 版。
> 你產出的檔案，使用者打開就是**每個區塊都可拖曳、可改字、可換圖的活專案**——不是烤死的圖片。
> 這份規格經過實測：手寫 JSON 用 App 本人的解碼器驗證通過，桌面版直接開啟。

## 兩條路，先選一條

| | A 路：裸 `project.json` | B 路：`.alignproj` 封裝 |
|---|---|---|
| 你需要 | 只要能輸出文字（任何 AI 都行） | macOS 終端機（Claude Code 等） |
| 素材 | 無素材，或空槽（使用者在 App 裡自己填圖） | 可帶真圖片、真影片 |
| 使用者怎麼開 | 存成 `xxx.json` → ALIGNED Mac 版 ⌘O 開啟 | Mac ⌘O，或 AirDrop 給 iPad 匯入 |

**A 路做法**：把本文末尾的〈最小可開範例〉當骨架，替換內容後把完整 JSON 給使用者存檔。
**B 路做法**：組一個資料夾（`project.json` ＋ `assets/素材檔…`），然後：
```zsh
aa archive -d 資料夾 -o "專案名.alignproj" -a lzfse   # aa 是 macOS 內建指令
```

## 核心概念（讀懂這段，其他都是欄位）

1. **整個專案是一條連續畫布**。頁與頁無縫拼接：頁 `i` 的 x 範圍＝`i×canvasWidth` 到 `(i+1)×canvasWidth`。匯出時按頁裁切。
2. **跨頁**＝把區塊的 frame 放在頁縫上（例：跨頁 1、2 的滿版圖 x=1080、寬 2160）。這是 ALIGNED 的招牌能力，IG 滑動時畫面連續。
3. **座標即像素**。直式 4:5 輪播：`canvasWidth: 1080`、`pageHeight: 1350`、`pageCount: 1–20`。
4. **文字分兩種**：標題文字（框貼字身、參與吸附）；長文框（`isBodyFrame: true`，框限制文字範圍、可被「排開文字」繞排）。
5. **檔案格式**＝Swift Codable 輸出的 JSON。日期 ISO8601、UUID 大寫、frame 寫成 `[[x,y],[w,h]]`。

## Project 欄位

```
id            UUID 字串（大寫）
name          專案名
createdAt / updatedAt   ISO8601（例 "2026-08-07T12:00:00Z"）
canvasWidth   1080（直式 4:5）；橫式專案短邊 1080、長邊等比放大
pageHeight    1350
pageCount     1–20
blocks        區塊陣列（見下）
pageBackgroundHex  選填 {"0":"EFEEE8","1":"131312",…}  頁索引字串→hex（無 #），缺頁＝白
guidesX / guidesY  選填 參考線（頁內座標，每頁重複畫）；建議 [64,1016] / [72,1244]
paperKey      選填 整專案紙張紋理 "c1"/"c3"/"c4"，nil＝無
```

## Block 欄位

```
id        UUID 字串
frame     [[x,y],[w,h]]   ← x 是全畫布座標（跨頁就靠它）
rotation  度數，0＝不轉
zIndex    疊序（大在上）
locked    false；opacity 0–1
content   {"text":{"_0":{…}}} 或 {"image":{"_0":{…}}} 或 {"video":{"_0":{…}}} 或 {"shape":{"_0":{…}}}
```
（`_0` 是 Swift enum 編碼的固定包裝，照抄。）

### 文字（text）

```
text                 AttributedString runs（見下方〈顏色編碼〉——顏色必須烤進這裡）
alignment            "leading"/"center"/"trailing"
fontSize             px；fontWeightValue 0–4（2 標準、3 粗、4 特粗）
colorHex             hex 無 #（渲染後備，仍要填）
kerningEm            字距（em 制，橫排用；0.02 正文、0.2–0.28 小標拉字距）
lineHeightMultiple   行距倍數（1.0 自然行高；大標 1.3、內文 1.7–1.95）
manualWidth          填了＝固定寬度換行；不填＝框貼內容
fontName             nil＝系統黑體；可用："GenYoMin2TC-R"源樣明體、"NotoSerifTC-Regular"思源宋、
                     "jf-openhuninn-2.1"粉圓、"FiraCode-Regular"等寬、"Inter-Regular"、
                     "PlayfairDisplayRoman-Regular"、"ArchivoBlack-Regular"（Mac/iPad 都內建）
vertical             true＝直排（直書）。⚠️ 直排字距用舊點制欄位 kerning（＝fontSize×0.3~0.5），
                     不用 kerningEm；建議配源樣明體
isBodyFrame          true＝長文框（給 manualWidth＋manualHeight，可被排開文字繞排）
shadowStyle          "soft"/"strong"/nil；shadowColorHex 選填
backgroundColorHex   文字底色（圓角墊片）選填
```

高度給估值即可（`fontSize×行距×行數×1.25`），App 會照內容重算。

### 🔴 文字的 y ＝「墨跡上緣」，不是字身上緣

這條沒照做，字會整塊往上跑，而且**版面越大跑越多**。

- `frame` 的 y ＝**該行墨跡的上緣**（這一行最高那一筆的頂）。渲染是
  `baseline = y + actualBoundingBoxAscent`——用的是墨跡 ascent，不是字型 ascent。
  所以「要大寫字頂落在 Y」就直接把 y 給 Y，**不要拿字型的 ascent 去反推**。
  反推的位移量（每 100px 字級）：系統字拉丁大寫 26.5px、系統字中文 14.5px、
  思源宋中文 29.3px、Inter 大寫 24.3px、FiraCode 20.1px。字級 156 就是差 40px。
- **從 Figma／Sketch／CSS 搬版面的人特別注意**：那邊的 y 是行框（line box）上緣，
  這裡是墨跡上緣，兩者差一個 ascent−capHeight。整份稿照搬會集體上移。
- **位移量跟那一行的內容有關**：同一個 y，`photowalk`（有 l／k 上伸）會比 `moon`
  （只有 x 高）高約 0.2em。要讓兩塊字共用基線，各自扣掉自己的墨跡 ascent。
- 這是刻意的設計（框貼真實字身，外緣吸附才對得準），不是 bug——照它算就好。

### 靠右／置中：行寬會先扣掉一個字距

`alignment` 是 `"trailing"` 或 `"center"` 且有設 `kerningEm` 時，行寬是
`measureText().width − kerningEm × fontSize`（canvas 每個字後面都加字距、含最後一個，這裡減回去）。
**負字距時靠右的字會比直覺位置再往左 |字距| px**，算右緣要把這段補回去。

### 圖片／影片（image／video）

```
assetFileName  assets/ 內的檔名；**空字串 ""＝空槽**，使用者點一下自己填圖（範本做法，A 路友善）
cropRect       [[0,0],[1,1]]＝未裁切（App 以置中 aspect-fill 顯示）
maskShape      "rectangle"/"ellipse"；maskCornerRadius 0–1（矩形圓角，短邊比例）
strokeHex      描邊色；strokeWidth 短邊比例（0.005 ≈ 髮絲）
excludesText   true＝排開文字；textWrapMode "side"單側/"around"兩側/"push"上下（只影響長文框）
filterKey      選填 App 濾鏡鍵值，不確定就省略
rotationDegrees  拉直微轉 ±45，選填
```

⚠️ **frame 比例照素材原始比例給**，否則 aspect-fill 會裁掉畫面（截圖尤其明顯）。
影片直接放 mp4/mov 進 assets/；poster 縮圖不用做，App 缺檔會自己生。

### 色塊／線（shape）

```
kind        "rectangle"/"ellipse"/"line"
colorHex    填色（矩形/橢圓）或線色（line）
cornerRadius  矩形圓角 px，選填
lineWidth   線粗（line 用；最細 0.25＝髮絲，會呈現為更淡而非更細）
excludesText / textWrapMode   同上，色塊也能排開文字
```

半透明黑矩形＋`opacity: 0.35`＝壓字 scrim（圖上放字的標配）。

## 顏色編碼（唯一的地雷，照抄就好）

文字顏色**必須**同時寫進 `colorHex` 和 `text` 的 run 屬性——iOS 渲染讀 run 屬性，只給 colorHex 會變黑字。
run 屬性存的是**線性 RGB**（不是 sRGB 0–255 直接除 255）：

```python
def lin(c255):                      # sRGB 0-255 → 線性值
    c = c255 / 255
    return c/12.92 if c <= 0.04045 else ((c+0.055)/1.055)**2.4
```

一個 run 的完整寫法（`text` 欄位＝`[字串, 屬性]` 交錯的陣列）：
```json
"text": ["你的文字", {"SwiftUI.ForegroundColor": {"tag": {"constant": {}},
         "value": {"red": 0.0194, "green": 0.0185, "blue": 0.0137, "opacity": 1}}}]
```
（上例＝#26251F。多行文字直接在字串裡放 `\n`，同色就同一個 run。）

## 版面建議（可直接沿用）

米白底 `EFEEE8`＋近黑 `26251F`＋灰 `6B6659`，無彩、明度分層；邊界 64、大標 76–94/特粗、
內文 34–40/標準/行距 1.7、小標 24–26 拉字距 0.2；每頁固定件（刊頭、頁碼、落款、進度條）讓輪播像一套系統。

## 最小可開範例（驗證過，改內容就能用）

```json
{
  "id": "9A6BF14E-30AF-4EBB-8393-3E1E28E9B818",
  "name": "最小可開範例",
  "createdAt": "2026-08-07T12:00:00Z",
  "updatedAt": "2026-08-07T12:00:00Z",
  "canvasWidth": 1080, "pageHeight": 1350, "pageCount": 1,
  "pageBackgroundHex": {"0": "EFEEE8"},
  "guidesX": [64, 1016], "guidesY": [72, 1244],
  "blocks": [
    {"id": "0B0E4E86-6EF9-42D7-89A8-6A4CBA6AF860",
     "frame": [[64, 260], [952, 260]], "rotation": 0, "zIndex": 1, "locked": false, "opacity": 1,
     "content": {"text": {"_0": {
       "text": ["你好，ALIGNED。\n這份檔案是手寫的。",
                {"SwiftUI.ForegroundColor": {"tag": {"constant": {}},
                 "value": {"red": 0.0194, "green": 0.0185, "blue": 0.0137, "opacity": 1}}}],
       "alignment": "leading", "fontSize": 94, "fontWeightValue": 4,
       "colorHex": "26251F", "kerningEm": 0.02, "lineHeightMultiple": 1.32}}}},
    {"id": "3D24C224-11F8-4E1B-B283-CA6AB3E7A5C2",
     "frame": [[64, 620], [952, 150]], "rotation": 0, "zIndex": 2, "locked": false, "opacity": 1,
     "content": {"text": {"_0": {
       "text": ["任何 AI 讀完規格書，都能直接產生這種專案檔——\n存成 .json，用 ALIGNED 打開就能編輯。",
                {"SwiftUI.ForegroundColor": {"tag": {"constant": {}},
                 "value": {"red": 0.147027, "green": 0.132868, "blue": 0.112158, "opacity": 1}}}],
       "alignment": "leading", "fontSize": 40, "fontWeightValue": 2,
       "colorHex": "6B6659", "kerningEm": 0.02, "lineHeightMultiple": 1.75, "manualWidth": 952}}}},
    {"id": "5E1C224E-58D0-4B7B-8E24-6AD6B1E64C22",
     "frame": [[64, 880], [120, 12]], "rotation": 0, "zIndex": 3, "locked": false, "opacity": 1,
     "content": {"shape": {"_0": {"kind": "line", "colorHex": "26251F", "lineWidth": 3}}}}
  ]
}
```

## 常見錯誤

1. 只填 `colorHex` 沒把顏色烤進 runs → iOS 上全變黑字
2. 圖片 frame 比例亂給 → aspect-fill 裁掉重要畫面
3. 直排用 `kerningEm` → 會被 App 面板清掉，直排要用點制 `kerning`
4. 排開文字對「標題文字」設定 → 沒效果，繞排只作用在長文框（`isBodyFrame: true`）
5. `_0` 包裝漏掉 → 解碼失敗
6. **拿字型 ascent 反推文字 y** → 整塊往上跑 0.2–0.3 個字級（見〈文字的 y ＝墨跡上緣〉）
7. **靠右對齊忘了行寬會扣一個字距** → 右緣對不齊，負字距時最明顯
6. 匯入/開啟後 App 會換新 UUID，同一檔開兩次不會互相覆蓋——放心重複給檔
