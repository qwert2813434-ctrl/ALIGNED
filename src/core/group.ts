// ALIGN Core — 多選群組的對齊與分布。iOS `EditorViewModel+Group` 的移植。
//
// 兩條與 iOS 一致的規則：
// - **對齊的基準是選取集合自己的外框**（不是頁面）——「把這幾個東西對齊」講的是彼此。
// - **分布是等距（邊到邊的間隙相等），兩端不動**，所以至少要三個才有意義。
// 旋轉在 v1 忽略（用各自的 frame，不用旋轉外接框），與 iOS 現況相同。

import { renumberZ, type Block, type Project, type Rect } from "./schema";

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
 * 對齊到頁面（2026-08-14，「對齊」主功能的快速入口）：
 * **整組當一個單位平移**，相對位置不變（單選＝一個成員的組，就是快速對齊）。
 * 基準＝未鎖成員的外框聯集；頁＝外框中心所在那一頁。鎖定的不動。
 */
export function alignToPage(blocks: Block[], edge: GroupAlign, canvasWidth: number, pageHeight: number): void {
  const movable = blocks.filter((b) => !b.locked);
  const box = boundingBox(movable);
  if (!box) return;
  const px = Math.floor((box.x + box.w / 2) / canvasWidth) * canvasWidth;
  let dx = 0, dy = 0;
  switch (edge) {
    case "left":    dx = px - box.x; break;
    case "hCenter": dx = px + (canvasWidth - box.w) / 2 - box.x; break;
    case "right":   dx = px + canvasWidth - box.w - box.x; break;
    case "top":     dy = -box.y; break;
    case "vCenter": dy = (pageHeight - box.h) / 2 - box.y; break;
    case "bottom":  dy = pageHeight - box.h - box.y; break;
  }
  for (const b of movable) { b.frame.x += dx; b.frame.y += dy; }
}

/**
 * 依「由前而後」的 id 順序重排圖層——圖層清單第一筆＝最上層。
 * 沒列到的 block（不在這一頁）留在原位：只把**列到的那些**在自己原本佔的
 * 那幾格位置上重新填一次，其餘元素一格都不動。
 *
 * ⚠️ 這裡搬的是 blocks 陣列本身（順序的單一真相），不是改 zIndex——
 * 舊做法只改 z，iOS 讀陣列排列，於是圖層面板拖過的順序帶去 iPad 全無效。
 */
export function applyLayerOrder(p: Project, idsTopFirst: string[]): void {
  const ids = new Set(idsTopFirst);
  const slots: number[] = [];
  p.blocks.forEach((b, i) => { if (ids.has(b.id)) slots.push(i); });
  if (slots.length !== idsTopFirst.length) return;   // 有 id 找不到＝清單過期，不動
  const byId = new Map(p.blocks.map((b) => [b.id, b]));
  // 清單是「由前而後」，陣列是「由後而前」，所以反過來填
  [...idsTopFirst].reverse().forEach((id, k) => { p.blocks[slots[k]] = byId.get(id)!; });
  renumberZ(p);
}
