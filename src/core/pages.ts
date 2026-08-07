// ALIGN Core — 頁面操作（新增／刪除／換位）。iOS `EditorViewModel` 同名函式的移植。
//
// 頁在這個模型裡不是容器，是**共享座標空間的一段**：第 i 頁佔 x ∈ [i·canvasWidth, (i+1)·canvasWidth]。
// 所以所有頁面操作都只是「平移 block 的 x」與「重新編號背景色」，沒有搬移歸屬這回事。
//
// 一條貫穿的規則：**block 屬於它的中心所在的那一頁**（跨頁 bleed 的元件也只算一頁）。
// iOS 的刪頁與換頁都用這條，這裡逐條照抄。

import type { Block, Project } from "./schema";
import { pageIndexForX } from "./geometry";

/** iOS 同值：頁數上限 20。 */
export const MAX_PAGES = 20;

const centerPage = (p: Project, i: number): number =>
  pageIndexForX(p, p.blocks[i].frame.x + p.blocks[i].frame.w / 2);

/** 背景色字典重新編號。map 回 null＝那一頁被刪掉。 */
function remapBackgrounds(p: Project, map: (page: number) => number | null): void {
  const dict = p.pageBackgroundHex;
  if (!dict) return;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(dict)) {
    const k = Number(key);
    if (!Number.isFinite(k)) continue;
    const to = map(k);
    if (to != null) out[String(to)] = value;
  }
  p.pageBackgroundHex = Object.keys(out).length ? out : undefined;
}

/** 在最後面加一頁。**繼承前一頁的背景色**——一整串同色頁不必逐頁重挑（iOS 的使用者回饋）。 */
export function addPage(p: Project): boolean {
  if (p.pageCount >= MAX_PAGES) return false;
  const prev = p.pageCount - 1;
  const hex = p.pageBackgroundHex?.[String(prev)];
  p.pageCount += 1;
  if (hex) p.pageBackgroundHex = { ...(p.pageBackgroundHex ?? {}), [String(p.pageCount - 1)]: hex };
  return true;
}

/**
 * 刪掉一頁：**中心在該頁的 block 一起刪掉**，後面每一頁的 block 與背景色往前挪一格。
 * 最後一頁刪不掉（專案至少要有一頁）。可以 undo，所以不另外做確認步驟——與刪元件同級。
 */
export function deletePage(p: Project, index: number): boolean {
  if (p.pageCount <= 1 || index < 0 || index >= p.pageCount) return false;
  const shift = p.canvasWidth;
  const keep = p.blocks.filter((_, i) => centerPage(p, i) !== index);
  const moved = keep.map((b) => (pageIndexForX(p, b.frame.x + b.frame.w / 2) > index
    ? { ...b, frame: { ...b.frame, x: b.frame.x - shift } }
    : b));
  p.blocks = moved;
  remapBackgrounds(p, (k) => (k === index ? null : k > index ? k - 1 : k));
  p.pageCount -= 1;
  return true;
}

/**
 * 相鄰兩頁互換。背景色是綁在「頁槽」上的，不跟著 block 走——所以要一起交換，
 * 否則顏色會留在原位、跟它本來要襯的內容脫鉤（iOS 的註解特別點名這個坑）。
 */
export function swapAdjacentPages(p: Project, a: number, b: number): boolean {
  if (Math.abs(a - b) !== 1) return false;
  if (a < 0 || b < 0 || a >= p.pageCount || b >= p.pageCount) return false;
  const lower = Math.min(a, b), upper = Math.max(a, b);
  const shift = p.canvasWidth;
  p.blocks = p.blocks.map((blk, i) => {
    const page = centerPage(p, i);
    if (page === lower) return { ...blk, frame: { ...blk.frame, x: blk.frame.x + shift } };
    if (page === upper) return { ...blk, frame: { ...blk.frame, x: blk.frame.x - shift } };
    return blk;
  });
  remapBackgrounds(p, (k) => (k === lower ? upper : k === upper ? lower : k));
  return true;
}

/** 複製一頁：內容整份複製到它的右邊，後面的頁往後挪。 */
export function duplicatePage(p: Project, index: number, newId: () => string): boolean {
  if (p.pageCount >= MAX_PAGES || index < 0 || index >= p.pageCount) return false;
  const shift = p.canvasWidth;
  const copies = p.blocks
    .filter((_, i) => centerPage(p, i) === index)
    .map((b) => ({ ...b, id: newId(), frame: { ...b.frame, x: b.frame.x + shift } }));
  // 先把後面的頁推開，再放複製品——順序反了會把複製品也一起推走
  p.blocks = p.blocks.map((b, i) => (centerPage(p, i) > index
    ? { ...b, frame: { ...b.frame, x: b.frame.x + shift } }
    : b));
  p.blocks = [...p.blocks, ...copies];
  remapBackgrounds(p, (k) => (k > index ? k + 1 : k));
  const hex = p.pageBackgroundHex?.[String(index)];
  if (hex) p.pageBackgroundHex = { ...(p.pageBackgroundHex ?? {}), [String(index + 1)]: hex };
  p.pageCount += 1;
  return true;
}

/**
 * 輕量範本：把素材拔掉，圖／影片全部變回**空欄位框**（iOS 2026-07-31 的「輕量匯出」）。
 * 保留外框、遮罩、描邊、濾鏡、排開設定與整頁紙張；裁切與拉直重置——那兩個是屬於
 * 被拿掉的那張圖的。影片轉成 image 型別（填圖時再轉回來）。
 * 回新的 Project，不動原本那份。
 */
export function stripToTemplate(p: Project): Project {
  return {
    ...p,
    blocks: p.blocks.map((b) => {
      if (b.content.type !== "image" && b.content.type !== "video") return structuredClone(b);
      const m = structuredClone(b.content.media);
      m.assetFileName = "";
      m.cropRect = { x: 0, y: 0, w: 1, h: 1 };
      m.rotationDegrees = undefined;
      return { ...structuredClone(b), content: { type: "image" as const, media: m } };
    }),
  };
}

/**
 * 把 blocks 搬到（copy=true 則複製到）第 to 頁。
 * **頁內位置不動**——只把「所屬的那一格」換掉，所以視覺上落在新頁的同一個位置。
 * 複製出來的疊在最上面（回傳新的 block，呼叫端負責 push 進專案）。
 */
export function retargetToPage(
  p: Project, blocks: Block[], to: number, copy: boolean, newId: () => string,
): Block[] {
  const w = p.canvasWidth;
  let top = p.blocks.length ? Math.max(...p.blocks.map((k) => k.zIndex)) : 0;
  const made: Block[] = [];
  for (const b of blocks) {
    const from = Math.floor((b.frame.x + b.frame.w / 2) / w);
    const dx = (to - from) * w;
    if (copy) {
      const k = structuredClone(b);
      k.id = newId(); k.zIndex = ++top; k.frame.x += dx;
      made.push(k);
    } else {
      b.frame.x += dx;
    }
  }
  return made;
}
