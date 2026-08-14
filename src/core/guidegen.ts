// ALIGN Core — 參考線產生器（優化項目 #13，2026-08-14 定案）。
//
// 一鍵長出可調的預設參考線，生成到**現有 guidesX/guidesY**——檔案格式零改動、
// iOS GuidePanel 直接相容，生完每條都能拖、能刪、能重生成。
//
// 鐵則（Armin 拍板）：**所有預設一律「隨畫布比例生成」、不寫死座標**——
// 全部從 canvasWidth/pageHeight 現算，換畫布比例重按一次就對。
//
// 定案清單：8 IG 安全區＝主用置頂；1 邊界框、2 欄格、3 模組網格、4 基線網格、
// 5 三分法、6 黃金分割入選；7 中心十字、9 跨頁接縫未入選。
// 分鏡不做獨立預設，收進模組網格的「格比例」參數（16:9／2.35:1 就是分鏡格）：
// Letterbox＝1 欄置中、接觸印樣＝2 欄 3 列、雜誌主從＝3 欄自由列，
// 全是同一套格子的出廠組合。

export type GuidePreset =
  | "igsafe" | "margins" | "columns" | "modular" | "baseline" | "thirds" | "golden";

/** 面板順序＝定案順序：主用置頂，之後照樣本間編號。 */
export const GUIDE_PRESETS: GuidePreset[] = [
  "igsafe", "margins", "columns", "modular", "baseline", "thirds", "golden",
];

export interface GuideGenParams {
  margin: number;       // 邊距 px（預設 8% 短邊）
  gutter: number;       // 溝寬 px
  cols: number;         // 欄數（欄格／模組）
  rows: number;         // 列數（模組：自由比例＝實列數；鎖比例＝最多幾列）
  cellRatio: number;    // 模組格比例 寬/高；0＝自由（用 rows 均分）
  captionH: number;     // 說明帶高 px（0＝不要）——分鏡格下方的字幕/編號帶
  step: number;         // 基線網格行距 px
  gridPreview: "3:4" | "1:1";  // IG 個人頁格狀預覽的裁切比（2025 起現行＝3:4）
}

export function defaultParams(W: number, H: number): GuideGenParams {
  const short = Math.min(W, H);
  return {
    margin: Math.round(short * 0.08),
    gutter: Math.round(W * 0.022),
    cols: 3,
    rows: 3,
    cellRatio: 0,
    captionH: 0,
    step: Math.round(W * 0.055),
    gridPreview: "3:4",
  };
}

/** 模組網格的出廠組合（分鏡定案）：只是參數預填，格子邏輯同一套。 */
export const MODULAR_COMBOS: Record<string, Partial<GuideGenParams>> = {
  letterbox:  { cols: 1, rows: 1, cellRatio: 16 / 9 },   // 滿寬影格置中壓黑邊
  contact:    { cols: 2, rows: 3, cellRatio: 16 / 9 },   // 接觸印樣：一頁看全段落
  editorial:  { cols: 3, rows: 2, cellRatio: 0 },        // 雜誌主從：主圖跨格、側欄講話
};

/** 生成一組參考線（頁內座標；guidesY 各頁同高所以頁內＝絕對）。 */
export function generateGuides(
  preset: GuidePreset,
  p: GuideGenParams,
  W: number,
  H: number,
): { x: number[]; y: number[] } {
  const x: number[] = [], y: number[] = [];
  const m = p.margin;
  const x0 = m, x1 = W - m, y0 = m, y1 = H - m;

  switch (preset) {
    case "margins":
      x.push(x0, x1); y.push(y0, y1);
      break;

    case "columns": {
      x.push(x0, x1); y.push(y0, y1);
      pushColumnLines(x, x0, x1, p.cols, p.gutter);
      break;
    }

    case "modular": {
      x.push(x0, x1);
      pushColumnLines(x, x0, x1, p.cols, p.gutter);
      const colW = (x1 - x0 - (p.cols - 1) * p.gutter) / p.cols;
      const cellH = p.cellRatio > 0
        ? colW / p.cellRatio
        : (y1 - y0 - (p.rows - 1) * p.gutter) / Math.max(p.rows, 1) - p.captionH;
      const blockH = cellH + p.captionH;
      // 鎖比例＝能放幾列放幾列（上限 rows），整組垂直置中——Letterbox 的「置中壓黑邊」
      const fit = Math.max(1, Math.floor((y1 - y0 + p.gutter) / (blockH + p.gutter)));
      const rows = p.cellRatio > 0 ? Math.min(fit, Math.max(p.rows, 1)) : Math.max(p.rows, 1);
      const gridH = rows * blockH + (rows - 1) * p.gutter;
      const top = p.cellRatio > 0 ? y0 + (y1 - y0 - gridH) / 2 : y0;
      for (let r = 0; r < rows; r++) {
        const t = top + r * (blockH + p.gutter);
        y.push(t, t + cellH);                     // 格頂、格底（分鏡的影格線）
        if (p.captionH > 0) y.push(t + blockH);   // 說明帶底（字幕/編號的基線帶）
      }
      break;
    }

    case "baseline": {
      for (let v = y0; v <= y1 + 0.01; v += Math.max(p.step, 8)) y.push(v);
      break;
    }

    case "thirds":
      x.push(W / 3, (W * 2) / 3); y.push(H / 3, (H * 2) / 3);
      break;

    case "golden":
      x.push(W * 0.382, W * 0.618); y.push(H * 0.382, H * 0.618);
      break;

    case "igsafe": {
      if (H / W >= 1.6) {
        // 直式（Reels 類）：Meta 官方安全區模板 1080×1920＝上 220、下 420、側 60
        x.push(W * (60 / 1080), W * (1 - 60 / 1080));
        y.push(H * (220 / 1920), H * (1 - 420 / 1920));
      } else {
        // 貼文型：個人頁格狀預覽的裁切框（置中）＋底部帳名/文案遮擋帶。
        // 預覽比貼文「高」（例：3:4 預覽吃 4:5 貼文）＝裁左右；比貼文「矮」＝裁上下。
        const [rw, rh] = p.gridPreview === "1:1" ? [1, 1] : [3, 4];
        const cropH = (W * rh) / rw;
        if (cropH < H - 1) {
          const t = (H - cropH) / 2;
          y.push(t, t + cropH);
        } else {
          const cropW = (H * rw) / rh;
          if (cropW < W - 1) {
            const l = (W - cropW) / 2;
            x.push(l, l + cropW);
          }
        }
        y.push(H * 0.82);
      }
      break;
    }
  }

  // 收尾：四捨五入、去掉貼著頁緣的（頁邊本來就是吸附目標）、去重
  const tidy = (arr: number[], max: number): number[] =>
    [...new Set(arr.map((v) => Math.round(v)))].filter((v) => v > 1 && v < max - 1).sort((a, b) => a - b);
  return { x: tidy(x, W), y: tidy(y, H) };
}

/** 欄的內側線（每條溝兩邊各一條）。 */
function pushColumnLines(x: number[], x0: number, x1: number, cols: number, gutter: number): void {
  const n = Math.max(cols, 1);
  const colW = (x1 - x0 - (n - 1) * gutter) / n;
  for (let i = 1; i < n; i++) {
    const g = x0 + i * (colW + gutter);
    x.push(g - gutter, g);
  }
}

/**
 * 重生成＝把**上次生成的那批**換掉，手動加的與拖過的線都留著
 * （值完全相等才算同一條——拖過的線值變了，代表你要它，不收走）。
 */
export function replaceBatch(current: number[], prevBatch: number[], next: number[]): number[] {
  const remain = [...current];
  for (const v of prevBatch) {
    const i = remain.indexOf(v);
    if (i >= 0) remain.splice(i, 1);
  }
  for (const v of next) if (!remain.includes(v)) remain.push(v);
  return remain;
}
