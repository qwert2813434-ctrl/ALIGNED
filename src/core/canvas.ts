// ALIGN Core — 畫布尺寸與新專案。iOS `CanvasSizePreset` / `CanvasSizeMath` 的移植。
//
// 規則只有一條：**短邊固定 1080，長邊照比例長**。所以直式 4:5 是 1080×1350，
// 翻成橫式的 9:16（＝16:9）是 1920×1080 而不是 1080×608。

import type { Block, Project } from "./schema";
import { pageIndexForX } from "./geometry";

export const REFERENCE_SIZE = 1080;

export interface CanvasPreset { key: string; label: string; ratio: number | null }

/** ratio ＝未翻轉時的 height / width。 */
export const CANVAS_PRESETS: CanvasPreset[] = [
  { key: "1:1", label: "1:1 方形", ratio: 1 },
  { key: "4:5", label: "4:5 直式", ratio: 5 / 4 },
  { key: "3:4", label: "3:4 直式", ratio: 4 / 3 },
  { key: "9:16", label: "9:16 全螢幕", ratio: 16 / 9 },
  { key: "1.91:1", label: "1.91:1 橫式", ratio: 1 / 1.91 },
];

/** 預設鍵（＋翻轉）→ 實際畫布尺寸。 */
export function canvasSize(presetKey: string, flipped = false): { w: number; h: number } {
  const base = CANVAS_PRESETS.find((p) => p.key === presetKey)?.ratio ?? 1;
  const effective = flipped ? 1 / base : base;
  return effective >= 1
    ? { w: REFERENCE_SIZE, h: Math.round(REFERENCE_SIZE * effective) }
    : { w: Math.round(REFERENCE_SIZE / effective), h: REFERENCE_SIZE };
}

/** 「1080:1350」→「4:5」：兩個沙發都用它當說明文字。 */
export function simplifiedRatio(w: number, h: number): string {
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const g = Math.max(gcd(Math.round(w), Math.round(h)), 1);
  return `${Math.round(w) / g}:${Math.round(h) / g}`;
}

/**
 * 改既有專案的畫布形狀。**尺寸與位置都不等比縮放**（iOS 端使用者拍板的取捨：
 * 寧可有內容跑到新頁邊外，也不要整份版面被自動縮放）。
 *
 * 與 iOS 的唯一差別：這裡**保住「哪一頁」**。頁是共享座標的一段
 * （第 i 頁＝x ∈ [i·canvasWidth, …]），canvasWidth 一變，第 2 頁以後的絕對 x
 * 就會落到別頁去。所以逐個 block 換算成「頁內座標」再放回同一頁的新起點——
 * 頁內位置與尺寸一格不動，只有絕對 x 跟著新的頁寬平移。
 */
export function changeCanvasRatio(p: Project, w: number, h: number): void {
  const oldW = p.canvasWidth;
  if (oldW !== w) {
    p.blocks = p.blocks.map((b: Block) => {
      const page = pageIndexForX(p, b.frame.x + b.frame.w / 2);
      const localX = b.frame.x - page * oldW;
      return { ...b, frame: { ...b.frame, x: page * w + localX } };
    });
  }
  p.canvasWidth = w;
  p.pageHeight = h;
}

/** 空白新專案。頁背景不設＝白（additive：不寫進檔案就是預設）。 */
export function newProject(
  name: string, presetKey: string, flipped: boolean, pageCount: number, id: string,
): Project {
  const { w, h } = canvasSize(presetKey, flipped);
  // iOS 的 ISO8601 解不了毫秒，這裡就先剪乾淨（存檔時 encodeProject 也會再剪一次）
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  return {
    id, name, createdAt: now, updatedAt: now,
    canvasWidth: w, pageHeight: h,
    pageCount: Math.max(1, Math.min(pageCount, 20)),
    blocks: [],
  };
}
