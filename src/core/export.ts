import { __ } from "../i18n";
// ALIGN Core — 匯出。
//
// iOS 的 `PageExportRenderer` 用 `ImageRenderer(scale: 1)`：**畫布尺寸本身就是目標像素**，
// 沒有 2x/3x 選項。所以 4:5 專案匯出就是 1080×1350。
//
// 跨頁 bleed 不需要特例處理——把專案裁到該頁的矩形就是全部（renderPage 已經在做）。

import type { Project } from "./schema";
import { renderPageCanvas, type RenderOptions } from "./render";

export interface ExportOptions extends RenderOptions {
  pages?: number[];   // 未指定＝全部
}

export interface ExportedPage { index: number; name: string; canvas: HTMLCanvasElement }

export function renderAllPages(project: Project, opts: ExportOptions = {}): ExportedPage[] {
  const list = opts.pages ?? Array.from({ length: project.pageCount }, (_, i) => i);
  // 檔名補零，檔案總管才會照頁序排（10 不會插在 1 和 2 中間）
  const pad = String(project.pageCount).length;
  return list.map((i) => ({
    index: i,
    name: `${project.name}_${String(i + 1).padStart(pad, "0")}.png`,
    canvas: renderPageCanvas(project, i, opts),
  }));
}

export function toBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((ok, err) =>
    canvas.toBlob((b) => (b ? ok(b) : err(new Error(__("PNG 編碼失敗")))), "image/png"));
}

/** 給 IG 輪播的頁序。**存進系統相簿時要反轉**——相簿是「最近建立的排前面」，
 *  倒著寫入才會排成編輯順序。存成檔案不需要反轉（檔名已經帶頁碼）。 */
export function photoLibraryOrder<T>(pages: T[]): T[] {
  return [...pages].reverse();
}
