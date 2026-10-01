// 散字（2026-10-01）：文字庫一篇 → 切成詞 → 隨機落在頁面上。純計算，不碰專案與畫面。
// 與 iOS `Engines/ScatterLayout.swift` 同一套規則（同 seed 不保證跨平台同位置，規則一樣就好）；
// 桌面版多了規則可調（順序、吸格線、錯開、間距、邊界）與釘住——原型＝01 - 研究/樣本間/散字/index.html。

export interface ScatterOptions {
  /** seq＝照順序由上往下（高度切 N 段，每詞落自己那段）；free＝整頁隨機 */
  order: "seq" | "free";
  /** 左緣吸隨機欄數的格線、上緣吸基線 */
  snap: boolean;
  /** 上下兩詞中心左右至少差頁寬的幾成（0＝不限） */
  zig: number;
  /** 詞與詞最小間距（專案座標 px） */
  gap: number;
  /** 邊界佔頁寬／頁高的比例 */
  margin: number;
}

export const DEFAULT_SCATTER: ScatterOptions = { order: "seq", snap: true, zig: 0.25, gap: 60, margin: 0.06 };

export interface Box { x: number; y: number; w: number; h: number }

/** 一篇切成要散的詞：有幾行就幾個（空行略過）；只有一行時再用空白／頓號／逗號切。 */
export function scatterWords(body: string, limit = 24): string[] {
  const lines = body.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const pieces = lines.length === 1 ? lines[0].split(/[\s、，,／/]+/).map((s) => s.trim()).filter(Boolean) : lines;
  return pieces.slice(0, limit);
}

/** 可重現的亂數（SplitMix32 變體）：同 seed 同序列 */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return ((z ^ (z >>> 16)) >>> 0) / 4294967296;
  };
}

export interface ScatterResult {
  /** 每個詞左上角（頁面內座標） */
  origins: { x: number; y: number }[];
  /** 這輪的欄線（頁面內 x），吸格線關掉＝空 */
  gridX: number[];
}

/**
 * `sizes`＝每個詞的框大小；`pinned`＝第 i 個詞釘在哪（頁面內座標），釘住的不動、其他的避開它。
 */
export function scatterLayout(sizes: { w: number; h: number }[], page: { w: number; h: number }, seed: number,
                              opt: ScatterOptions, pinned: Map<number, Box> = new Map()): ScatterResult {
  const r = rng(seed);
  const columns = [6, 8, 10, 12][Math.floor(r() * 4)];
  const n = sizes.length;
  const mx = page.w * opt.margin, my = page.h * opt.margin;
  const colW = (page.w - 2 * mx) / columns;
  const gridX = opt.snap ? Array.from({ length: columns + 1 }, (_, i) => mx + i * colW) : [];
  if (!n) return { origins: [], gridX };
  const typical = [...sizes].map((s) => s.h).sort((a, b) => a - b)[Math.floor(n / 2)];
  const row = Math.max(4, typical * 0.75);
  const zig = page.w * opt.zig;
  const band = (page.h - 2 * my) / n;

  const snapX = (x: number, w: number) => {
    if (!opt.snap) return Math.max(mx, Math.min(x, page.w - mx - w));
    let c = Math.round((x - mx) / colW);
    while (c > 0 && mx + c * colW + w > page.w - mx) c--;
    return Math.max(mx, mx + c * colW);
  };
  const snapY = (y: number, h: number) => {
    const s = opt.snap ? my + Math.round((y - my) / row) * row : y;
    return Math.min(Math.max(my, s), Math.max(my, page.h - my - h));
  };
  const hit = (a: Box, b: Box, g: number) =>
    a.x < b.x + b.w + g && b.x < a.x + a.w + g && a.y < b.y + b.h + g && b.y < a.y + a.h + g;

  let best: Box[] = [];
  for (let attempt = 0; attempt < 40; attempt++) {
    const relax = attempt < 30 ? 1 : 0.4;
    const placed: (Box | null)[] = sizes.map((_, i) => pinned.get(i) ?? null);
    let ok = true;
    for (let i = 0; i < n; i++) {
      if (pinned.has(i)) continue;
      const s = sizes[i];
      let found: Box | null = null;
      for (let k = 0; k < 200 && !found; k++) {
        const rx = mx + r() * Math.max(1, page.w - 2 * mx - s.w);
        const ry = opt.order === "seq"
          ? my + band * i + r() * Math.max(1, band - s.h)
          : my + r() * Math.max(1, page.h - 2 * my - s.h);
        const c: Box = { x: snapX(rx, s.w), y: snapY(ry, s.h), w: s.w, h: s.h };
        if (placed.some((p) => p && hit(p, c, opt.gap * relax))) continue;
        const prev = i > 0 ? placed[i - 1] : null;
        if (zig > 0 && prev && page.w - 2 * mx - Math.max(prev.w, c.w) > zig &&
            Math.abs((prev.x + prev.w / 2) - (c.x + c.w / 2)) < zig * relax) continue;
        found = c;
      }
      if (!found) {
        ok = false;
        found = { x: mx, y: snapY(my + band * i, s.h), w: s.w, h: s.h };
      }
      placed[i] = found;
    }
    best = placed as Box[];
    if (ok) break;
  }
  return { origins: best.map((b) => ({ x: b.x, y: b.y })), gridX };
}
