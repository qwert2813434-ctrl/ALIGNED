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

/** PagePaper 的 rawValue 就是 c1/c3/c4，與濾鏡代號同名（iOS 端刻意如此）。 */
const PAPERS: Record<string, Paper> = {
  c1: { tint: [0.91, 0.88, 0.78], lift: 0, fiber: "c1" },      // 報紙
  c3: { lift: 0, fiber: "c3" },                                 // 顆粒
  c4: { tint: [0.96, 0.93, 0.87], lift: 0.07, fiber: "c4" },    // 高級紙
};

const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

export function applyPaper(key: string | null | undefined, img: ImageData, a: FilterAssets): void {
  const p = key ? PAPERS[key] : undefined;
  if (!p) return;
  const d = img.data, w = img.width, h = img.height;
  const tile = a.grain.get(p.fiber);
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
      if (tile) {
        const g = tile.rgb[(y & 255) * 256 + (x & 255)];
        const al = tile.alpha[(y & 255) * 256 + (x & 255)] / 255;
        for (let c = 0; c < 3; c++) {
          d[i + c] = clamp(d[i + c] * (1 - al) + softLightBlend(d[i + c], g) * al);
        }
      }
    }
  }
}
