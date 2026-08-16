// ALIGN Core — 整頁紙張。iOS `FilterEngine.applyPaperCI` 的移植。
//
// 紙張與區塊濾鏡的差別：**紙張不動內容的像素結構**。報紙的半調網點是區塊濾鏡 c1
// 的事，頁面版只給紙感。這是為了跨頁無縫——與「全系列無暗角」同一條鐵則：
// 任何有結構、有邊際的東西都會在頁縫露餡。
//
// 三層，順序不可換：multiply 紙色 → screen 抬黑 → softLight 纖維。
// 纖維參數與濾鏡 c1/c3/c4 完全相同，所以直接共用同一批顆粒貼片。

import type { FilterAssets } from "./filters";
import { softLightBlend } from "./filters";

interface Paper {
  tint?: [number, number, number];
  lift: number;
  /** 顆粒貼片的鍵——與同名濾鏡共用。 */
  fiber: string;
}

/** PagePaper 的 rawValue 就是 c1/c3/c4，與濾鏡代號同名（iOS 端刻意如此）。
 *  h1/h2＝手抄紙系（2026-08-16 加），不走貼片走整頁程序化生成，見下方 HANDMADE。 */
const PAPERS: Record<string, Paper> = {
  c1: { tint: [0.91, 0.88, 0.78], lift: 0, fiber: "c1" },      // 報紙
  c3: { lift: 0, fiber: "c3" },                                 // 顆粒
  c4: { tint: [0.96, 0.93, 0.87], lift: 0.07, fiber: "c4" },    // 高級紙
  h1: { tint: [0.863, 0.867, 0.784], lift: 0.05, fiber: "" },   // 手抄紙（素淨）
  h2: { tint: [0.863, 0.867, 0.784], lift: 0.05, fiber: "" },   // 粗手抄紙（絮重）
};

// ── 手抄紙（handmade paper）──────────────────────────────────────────────
// C 系紙張的纖維是**均勻噪點**，無結構所以 256 貼片平鋪就無縫；手抄紙的絮是**有結構的**，
// 塞進 256 貼片會看得出重複。所以改成整頁生成一次＋快取（與 iOS 的 paperFiber 同策略）。
// 配方來自樣本間 `01 - 研究/樣本間/濾鏡/紙紋.html`（2026-08-16 使用者選定 ②③）。

interface Handmade {
  fine: number;      // 細纖維根數（瞇眼才看得見的絮）
  coarse: number;    // 粗絮根數（一眼看得到的那幾根）
  specks: number;    // 紙漿雜點顆數
  alpha: number;     // 整層強度倍率（1＝與樣本間 HTML 完全一致）
}

/** 配方在 2160 寬的畫布上寫成（＝1080 設計的 2 倍超取樣）。
 *  **根數固定不隨頁面縮放**——參考圖就是「2160 畫成、縮到 1080 看」，縮放的是尺寸不是數量。
 *  只有長度／線寬按 `頁寬 / 2160` 換算，所以 1x 匯出與 2x 匯出的紙感一模一樣。 */
const HANDMADE_BASE_W = 2160;
const HANDMADE: Record<string, Handmade> = {
  h1: { fine: 900, coarse: 40, specks: 2500, alpha: 1.0 },
  h2: { fine: 3200, coarse: 380, specks: 11000, alpha: 1.0 },
};

/** 整頁纖維層快取，key＝「紙|寬x高」。同一頁尺寸只生成一次。 */
const handmadeCache = new Map<string, { rgb: Float32Array; a: Float32Array }>();

/** 固定種子 LCG——同一張紙每次生成都一模一樣（換頁、重開檔都不會變）。 */
function makeRnd(seed: number): () => number {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

/**
 * 生成整頁的手抄紙纖維層（透明底上的絮與雜點），與樣本間 HTML 同一套畫法。
 *
 * ⚠️ **不能用 softLight 疊**：softLight 的變化量正比於 `b×(1−b)`，在亮底（紙就是亮底）
 * 幾乎歸零，纖維會完全看不見。C 系紙張看得見是因為它的噪點對比極高。
 * 手抄紙改**直接 alpha 合成**（＝HTML 那條路），所見即所得。
 */
function handmadeFiber(key: string, w: number, h: number): { rgb: Float32Array; a: Float32Array } | undefined {
  const r = HANDMADE[key];
  if (!r) return undefined;
  const ck = `${key}|${w}x${h}`;
  const hit = handmadeCache.get(ck);
  if (hit) return hit;

  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const cx = c.getContext("2d", { willReadFrequently: true });
  if (!cx) return undefined;

  const rnd = makeRnd(20260816);
  const s = w / HANDMADE_BASE_W;                // 長度／線寬換算（根數不動）
  const n = (v: number) => v;

  const strokes = (count: number, w0: number, w1: number,
                   aDark: number, aLight: number, l0: number, l1: number): void => {
    for (let i = 0; i < count; i++) {
      const x = rnd() * w, y = rnd() * h;
      const a = rnd() * Math.PI, len = (l0 + rnd() * l1) * s;
      cx.strokeStyle = rnd() > 0.45 ? `rgba(96,98,74,${aDark})` : `rgba(255,255,246,${aLight})`;
      cx.lineWidth = (w0 + rnd() * w1) * s;
      cx.beginPath();
      cx.moveTo(x, y);
      cx.quadraticCurveTo(x + Math.cos(a) * len * 0.5 + (rnd() - 0.5) * 6 * s,
                          y + Math.sin(a) * len * 0.5 + (rnd() - 0.5) * 6 * s,
                          x + Math.cos(a) * len, y + Math.sin(a) * len);
      cx.stroke();
    }
  };
  strokes(n(r.fine), 0.4, 0.7, 0.14, 0.24, 7, 34);      // 細纖維
  strokes(n(r.coarse), 0.9, 0.8, 0.20, 0.30, 16, 50);   // 粗絮
  for (let i = 0; i < n(r.specks); i++) {                // 紙漿雜點
    cx.fillStyle = rnd() > 0.5 ? "rgba(110,112,86,.10)" : "rgba(255,255,248,.16)";
    cx.beginPath();
    cx.arc(rnd() * w, rnd() * h, (0.35 + rnd() * 1.2) * s, 0, 6.284);
    cx.fill();
  }

  const d = cx.getImageData(0, 0, w, h).data;
  const rgb = new Float32Array(w * h * 3);
  const a = new Float32Array(w * h);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    rgb[p * 3] = d[i]; rgb[p * 3 + 1] = d[i + 1]; rgb[p * 3 + 2] = d[i + 2];
    a[p] = d[i + 3] / 255;
  }
  const out = { rgb, a };
  handmadeCache.set(ck, out);
  return out;
}

const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

export function applyPaper(key: string | null | undefined, img: ImageData, a: FilterAssets): void {
  const p = key ? PAPERS[key] : undefined;
  if (!p) return;
  const d = img.data, w = img.width, h = img.height;
  const tile = a.grain.get(p.fiber);
  const hand = key ? handmadeFiber(key, w, h) : undefined;   // 手抄紙走整頁層，不走貼片
  const handA = key && HANDMADE[key] ? HANDMADE[key].alpha : 0;
  const lift = p.lift * 255;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        let v = d[i + c];
        if (p.tint) v *= p.tint[c];                    // multiply 紙色
        if (lift > 0) v = 255 - (255 - v) * (1 - lift / 255);  // screen 抬黑
        d[i + c] = clamp(v);
      }
      if (hand) {
        const p3 = (y * w + x) * 3;
        const al = hand.a[y * w + x] * handA;          // 直接 alpha 合成，不走 softLight
        if (al > 0) {
          for (let c = 0; c < 3; c++) {
            d[i + c] = clamp(d[i + c] * (1 - al) + hand.rgb[p3 + c] * al);
          }
        }
      } else if (tile) {
        const g = tile.rgb[(y & 255) * 256 + (x & 255)];
        const al = tile.alpha[(y & 255) * 256 + (x & 255)] / 255;
        for (let c = 0; c < 3; c++) {
          d[i + c] = clamp(d[i + c] * (1 - al) + softLightBlend(d[i + c], g) * al);
        }
      }
    }
  }
}
