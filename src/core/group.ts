// ALIGN Core — 多選群組的對齊與分布。iOS `EditorViewModel+Group` 的移植。
//
// 兩條與 iOS 一致的規則：
// - **對齊的基準是選取集合自己的外框**（不是頁面）——「把這幾個東西對齊」講的是彼此。
// - **分布是等距（邊到邊的間隙相等），兩端不動**，所以至少要三個才有意義。
// 旋轉在 v1 忽略（用各自的 frame，不用旋轉外接框），與 iOS 現況相同。

import type { Block, Project, Rect } from "./schema";

export type GroupAlign = "left" | "hCenter" | "right" | "top" | "vCenter" | "bottom";
export type GroupAxis = "horizontal" | "vertical";

/** 選取集合的外框（軸對齊聯集）。空集合回 null。 */
export function boundingBox(blocks: Block[]): Rect | null {
  if (!blocks.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of blocks) {
    x0 = Math.min(x0, b.frame.x); y0 = Math.min(y0, b.frame.y);
    x1 = Math.max(x1, b.frame.x + b.frame.w); y1 = Math.max(y1, b.frame.y + b.frame.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** 對齊到集合外框的某一邊／中線。鎖定的略過。 */
export function alignGroup(blocks: Block[], edge: GroupAlign): void {
  const box = boundingBox(blocks);
  if (!box || blocks.length < 2) return;
  for (const b of blocks) {
    if (b.locked) continue;
    const f = b.frame;
    switch (edge) {
      case "left":    f.x = box.x; break;
      case "hCenter": f.x = box.x + box.w / 2 - f.w / 2; break;
      case "right":   f.x = box.x + box.w - f.w; break;
      case "top":     f.y = box.y; break;
      case "vCenter": f.y = box.y + box.h / 2 - f.h / 2; break;
      case "bottom":  f.y = box.y + box.h - f.h; break;
    }
  }
}

/**
 * 等距分布：相鄰的**間隙**相等，頭尾兩個不動。少於三個沒有東西可以分。
 * 鎖定的不移動，但仍然佔位（游標照樣跨過它），否則後面的會疊上去。
 */
export function distributeGroup(blocks: Block[], axis: GroupAxis): void {
  if (blocks.length < 3) return;
  const horiz = axis === "horizontal";
  const lead = (f: Rect) => (horiz ? f.x : f.y);
  const size = (f: Rect) => (horiz ? f.w : f.h);
  const sorted = [...blocks].sort((a, b) => lead(a.frame) - lead(b.frame));

  const first = sorted[0].frame, last = sorted[sorted.length - 1].frame;
  const span = lead(last) + size(last) - lead(first);
  const total = sorted.reduce((sum, b) => sum + size(b.frame), 0);
  const gap = (span - total) / (sorted.length - 1);

  let cursor = lead(first) + size(first) + gap;
  for (let i = 1; i < sorted.length - 1; i++) {
    const f = sorted[i].frame;
    if (!sorted[i].locked) {
      if (horiz) f.x = cursor; else f.y = cursor;
    }
    cursor += size(f) + gap;
  }
}

/**
 * 依「由前而後」的 id 順序重排 zIndex——圖層清單第一筆＝最上層。
 * 沒列到的 block（不在這一頁）不動。
 */
export function applyLayerOrder(p: Project, idsTopFirst: string[]): void {
  const n = idsTopFirst.length;
  idsTopFirst.forEach((id, i) => {
    const b = p.blocks.find((k) => k.id === id);
    if (b) b.zIndex = n - i;
  });
}
