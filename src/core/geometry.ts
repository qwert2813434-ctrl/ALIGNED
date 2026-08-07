// ALIGN Core — 座標系與幾何。
//
// 最重要的一條：**整個專案是一個連續的座標空間**，頁與頁之間沒有間隙。
// 第 i 頁佔 x ∈ [i·canvasWidth, (i+1)·canvasWidth]，y 全頁共用 [0, pageHeight]。
// Block 不記自己在第幾頁（存了一拖曳就過期），頁屬由 frame 中心推導。
// 「匯出某一頁」＝把專案裁到那一頁的矩形，跨頁 bleed 因此是天然行為而非特例。

import type { Project, Rect } from "./schema";

/** 短邊永遠 1080——所以 4:5 專案＝1080×1350，橫式 16:9＝1920×1080。 */
export const REFERENCE_SIZE = 1080;
export const MIN_HEIGHT = 565;
export const MAX_HEIGHT = 1920;

export function pageRect(p: Project, index: number): Rect {
  return { x: index * p.canvasWidth, y: 0, w: p.canvasWidth, h: p.pageHeight };
}

export function stageBounds(p: Project): Rect {
  return { x: 0, y: 0, w: p.canvasWidth * p.pageCount, h: p.pageHeight };
}

export function pageIndexForX(p: Project, x: number): number {
  return Math.min(Math.max(Math.floor(x / p.canvasWidth), 0), p.pageCount - 1);
}

export function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** 旋轉後的 AABB——吸附要咬的是這個，不是看不見的原始 frame。 */
export function rotatedBounds(f: Rect, degrees: number): Rect {
  const r = (degrees * Math.PI) / 180;
  const c = Math.abs(Math.cos(r)), s = Math.abs(Math.sin(r));
  const w = f.w * c + f.h * s, h = f.w * s + f.h * c;
  return { x: f.x + (f.w - w) / 2, y: f.y + (f.h - h) / 2, w, h };
}

/**
 * cropRect (0,0,1,1) 的正確解讀。
 *
 * ⚠️ 不可照字面拉伸——(0,0,1,1) 的語意是「未曾裁切」，要解成置中的 aspect-fill。
 * 照字面拉會讓換圖後變形，且裁切介面出現零餘裕的死狀態。
 */
export function aspectFillCrop(imageW: number, imageH: number, frameW: number, frameH: number): Rect {
  const scale = Math.max(frameW / imageW, frameH / imageH);
  const w = frameW / (imageW * scale), h = frameH / (imageH * scale);
  return { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
}
