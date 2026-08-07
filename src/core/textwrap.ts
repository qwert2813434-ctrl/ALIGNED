// ALIGN Core — 文繞圖（排開文字）。iOS `Engines/TextWrap.swift` 的逐條移植。
//
// 範圍與 iOS 完全一致（2026-07-27 拍板）：**只有長文框**（isBodyFrame）、橫排、
// 未旋轉的文字會繞排——標題文字的框是貼字盒，被洞擠開只會把尾巴擠出框外。
// 直排／旋轉文字回空洞列表＝走原路渲染，這也是路由訊號。
//
// iOS 端曾試過把洞交給 CTFramesetter 的 clippingPaths——macOS 分兩側、iOS 實機
// 只會整列跳過，跨平台不一致，所以 iOS 自己手刻逐列分段。我們在 canvas 上
// 本來就得手刻，等於天生跟它同構。

import type { Block, Rect } from "./schema";

export interface WrapHole {
  /** 文字區塊本地座標（y 向下），margin 已含。 */
  rect: Rect;
  shape: "rect" | "ellipse";
  mode: "side" | "around" | "push";
  rotation: number;
}

/** 洞的視覺邊與文字之間的空氣（專案座標，canvasWidth≈1080 時約半個 em 弱）。 */
export const WRAP_MARGIN = 18;

/** 與 iOS TextWrapMode.init 相同：未知／未設一律 side（單側）。 */
const wrapMode = (raw?: string): WrapHole["mode"] =>
  raw === "around" || raw === "push" ? raw : "side";

const intersects = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** 旋轉後的軸對齊外接框（旋轉的洞用外接框擋字——逐角度輪廓不值得那個複雜度）。 */
function rotatedBounds(r: Rect, deg: number): Rect {
  if (!deg) return r;
  const rad = (deg * Math.PI) / 180;
  const c = Math.abs(Math.cos(rad)), s = Math.abs(Math.sin(rad));
  const w = r.w * c + r.h * s, h = r.w * s + r.h * c;
  return { x: r.x + r.w / 2 - w / 2, y: r.y + r.h / 2 - h / 2, w, h };
}

/**
 * 影響 `self` 的所有排開洞（回傳為 self 的本地座標）。
 * 專案是單一共享座標空間，所以完全不需要頁邏輯——跨頁縫的島嶼自然成立。
 */
export function wrapHoles(self: Block, blocks: Block[]): WrapHole[] {
  if (self.content.type !== "text" && self.content.type !== "textFlow") return [];
  const t = self.content.text;
  if (t.isBodyFrame !== true || t.vertical === true || self.rotation !== 0) return [];

  const out: WrapHole[] = [];
  for (const b of blocks) {
    if (b.id === self.id) continue;
    let r: Rect;
    let shape: WrapHole["shape"];
    let mode: WrapHole["mode"];

    if (b.content.type === "shape") {
      const s = b.content.shape;
      if (s.excludesText !== true) continue;
      r = { ...b.frame };
      if (s.kind === "line") {
        // 線的墨是置中細桿——洞要貼著桿，不是整個 frame
        const th = Math.max(0.25, Math.min(s.lineWidth ?? Math.max(2, r.h * 0.5), r.h));
        r = { x: r.x, y: r.y + r.h / 2 - th / 2, w: r.w, h: th };
      }
      shape = s.kind === "ellipse" ? "ellipse" : "rect";
      mode = wrapMode(s.textWrapMode);
    } else if (b.content.type === "image" || b.content.type === "video") {
      const m = b.content.media;
      // 空欄位槽不擋字（iOS !isEmptySlot 同款）
      if (m.excludesText !== true || !m.assetFileName) continue;
      r = { ...b.frame };
      shape = m.maskShape === "ellipse" ? "ellipse" : "rect";
      mode = wrapMode(m.textWrapMode);
    } else continue;

    r = { x: r.x - WRAP_MARGIN, y: r.y - WRAP_MARGIN, w: r.w + WRAP_MARGIN * 2, h: r.h + WRAP_MARGIN * 2 };
    if (!intersects(r, self.frame)) continue;
    out.push({
      rect: { x: r.x - self.frame.x, y: r.y - self.frame.y, w: r.w, h: r.h },
      shape, mode, rotation: b.rotation,
    });
  }
  return out;
}

export interface Segment { x: number; width: number }

/**
 * 一列裡**沒被洞擋住**的 x 區間，由左到右。
 * 橢圓用該列「最靠中心的 y」的真實弧寬（島嶼看起來才像島嶼）；
 * 矩形／線／旋轉過的洞用（外接）bounds。
 */
export function freeIntervals(
  bandTop: number, bandBottom: number,
  width: number, holes: WrapHole[], minWidth: number,
): Segment[] {
  const blocked: [number, number][] = [];
  for (const hole of holes) {
    const r = hole.rotation === 0 ? hole.rect : rotatedBounds(hole.rect, hole.rotation);
    if (!(bandBottom > r.y && bandTop < r.y + r.h)) continue;

    let lo: number, hi: number;
    if (hole.shape === "ellipse" && hole.rotation === 0) {
      const a = r.w / 2, b = Math.max(r.h / 2, 1);
      const cx = r.x + a, cy = r.y + b;
      const yNearest = Math.min(Math.max(cy, bandTop), bandBottom);
      const t = (yNearest - cy) / b;
      const dx = a * Math.sqrt(Math.max(0, 1 - t * t));
      if (dx <= 0) continue;
      lo = cx - dx; hi = cx + dx;
    } else {
      lo = r.x; hi = r.x + r.w;
    }

    switch (hole.mode) {
      case "push":    blocked.push([0, width]); break;          // 上下：整列讓開
      case "around":  blocked.push([lo, hi]); break;            // 兩側：島嶼
      case "side":
        // 單側：閱讀動線不在句中跳過圖。圖自己的中心決定它站哪側（拖曳中穩定），
        // 圖與那側框緣之間的長條連同圖一起被擋掉。
        if (r.x + r.w / 2 <= width / 2) blocked.push([0, hi]);  // 圖靠左 → 字留右
        else blocked.push([lo, width]);                          // 圖靠右 → 字留左
        break;
    }
  }
  if (!blocked.length) return [{ x: 0, width }];

  blocked.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const seg of blocked) {
    const last = merged[merged.length - 1];
    if (last && seg[0] <= last[1]) last[1] = Math.max(last[1], seg[1]);
    else merged.push([...seg] as [number, number]);
  }
  const free: Segment[] = [];
  let cursor = 0;
  for (const [a, b] of merged) {
    if (a - cursor >= minWidth) free.push({ x: cursor, width: a - cursor });
    cursor = Math.max(cursor, b);
  }
  if (width - cursor >= minWidth) free.push({ x: cursor, width: width - cursor });
  return free;
}
