// ALIGN Core — canvas 渲染。
//
// 渲染模型直譯自 iOS 的 PageExportRenderer：把整個 stage 的 block 依 zIndex 排序，
// 過濾出與本頁矩形相交的，平移到頁內座標後畫，最後靠 clip 裁掉溢出的部分。
// **跨頁 bleed 沒有特例處理**——clip 就是「跨頁切割」的全部。
//
// 文字的定位鐵則：block frame 貼的是**墨跡**不是排版框（iOS 的 TextInkInset）。
// canvas 的 actualBoundingBoxAscent 就是墨跡上緣，所以把基線放在
// frame.y + actualBoundingBoxAscent 就等於 iOS 的貼字盒。這是文字會不會落在對的
// 位置的關鍵，不是細節。

import type { Block, MediaBlock, Project, Rect, ShapeBlock, TextBlock } from "./schema";
import { hex, resolvedFontSize, resolvedKerning } from "./schema";
import { aspectFillCrop, intersects, pageRect } from "./geometry";
import { cssFont } from "./fonts";
import type { GuideLine, SpacingBadge } from "./align";
import type { FilterAssets } from "./filters";
import { applyPaper } from "./paper";
import { freeIntervals, wrapHoles } from "./textwrap";

/** 直排的預設欄距（em）。iOS：baseline 1.5em 減掉 defaultVerticalLineSpacing 0.28em。 */
const VERTICAL_PITCH_EM = 1.22;

export interface RenderOptions {
  /** 缺圖時畫佔位框（範本的 asset 是被剝掉的，正常）。 */
  placeholderForMissingMedia?: boolean;
  images?: Map<string, CanvasImageSource>;
  /**
   * 影片的**即時影格**（`<video>` 或已套濾鏡的暫存畫布），鍵同 images。
   * 只有編輯畫布傳——匯出維持海報圖，PNG 才有決定性（同一份專案匯出兩次要一樣）。
   */
  videos?: Map<string, CanvasImageSource>;
  /** 整頁紙張需要顆粒貼片。未提供＝不套紙張。 */
  filters?: FilterAssets;
  /** 行內編輯中的 block——畫布跳過不畫（DOM 編輯層在上面，畫了就疊影）。 */
  skipBlockId?: string;
  /** 只畫這些 block（影片匯出要把「影片上下的靜態圖層」分段渲染）。未給＝全畫。 */
  onlyBlockIds?: Set<string>;
  /** 不畫頁面底色，留透明（分段圖層要疊在影片上，只有最底那段畫背景）。 */
  transparent?: boolean;
  /** 輸出倍率（只有 renderPageCanvas 吃）：2＝畫布兩倍像素，16:9 畫布即 4K。
   *  文字與形狀是向量重畫所以是真解析度，不是放大圖。 */
  scale?: number;
  /** 編輯畫布的視野（專案座標）。給了就跳過視野外的頁與 block——
   *  clip 語意不變，只是不畫看不見的。匯出／縮圖不給＝全畫。 */
  viewRect?: Rect;
}

/** 視野裁切用的外接框：轉過的 block 用旋轉 AABB，沒轉的直接用 frame。 */
function cullBounds(b: Block): Rect {
  if (!b.rotation) return b.frame;
  const r = (b.rotation * Math.PI) / 180;
  const c = Math.abs(Math.cos(r)), sn = Math.abs(Math.sin(r));
  const w = b.frame.w * c + b.frame.h * sn, h = b.frame.w * sn + b.frame.h * c;
  return { x: b.frame.x + b.frame.w / 2 - w / 2, y: b.frame.y + b.frame.h / 2 - h / 2, w, h };
}

/**
 * 單頁渲染成原尺寸的 canvas。**匯出與編輯預覽共用這條路**，兩者不可能分家。
 * iOS 的 ImageRenderer 用 scale 1——畫布尺寸本身就是目標像素，沒有 2x/3x。
 */
export function renderPageCanvas(project: Project, index: number, opts: RenderOptions = {}): HTMLCanvasElement {
  const page = pageRect(project, index);
  const S = opts.scale ?? 1;
  const c = document.createElement("canvas");
  c.width = Math.round(page.w * S);
  c.height = Math.round(page.h * S);
  const ctx = c.getContext("2d", { willReadFrequently: !!project.paperKey })!;
  if (S !== 1) ctx.scale(S, S);   // renderPage 照樣畫頁座標，transform 負責放大
  renderPage(ctx, project, index, opts);
  if (project.paperKey && opts.filters) {
    const d = ctx.getImageData(0, 0, c.width, c.height);
    applyPaper(project.paperKey, d, opts.filters);
    ctx.putImageData(d, 0, 0);
  }
  return c;
}

export function renderPage(
  ctx: CanvasRenderingContext2D,
  project: Project,
  index: number,
  opts: RenderOptions = {},
): void {
  const page = pageRect(project, index);

  ctx.save();
  ctx.clearRect(0, 0, page.w, page.h);
  const bg = project.pageBackgroundHex?.[String(index)] ?? "FFFFFF";
  if (!opts.transparent) {
    ctx.fillStyle = hex(bg);
    ctx.fillRect(0, 0, page.w, page.h);
  }
  // 頁底亮暗——空欄位框的墨色依所在頁切換（iOS emptySlotPlaceholder 同款）
  const n = parseInt(bg, 16);
  const pageLight = (((n >> 16) & 255) * 0.2126 + ((n >> 8) & 255) * 0.7152 + (n & 255) * 0.0722) > 140;

  const blocks = project.blocks
    .filter((b) => intersects(b.frame, page) && b.id !== opts.skipBlockId
                   && (!opts.onlyBlockIds || opts.onlyBlockIds.has(b.id))
                   && (!opts.viewRect || intersects(cullBounds(b), opts.viewRect)))
    .sort((a, b) => a.zIndex - b.zIndex);

  for (const b of blocks) drawBlock(ctx, project, b, page, opts, pageLight);
  ctx.restore();
}

/** 編輯用的整台 stage：所有頁面連續排開（頁與頁之間沒有間隙，那是專案的座標語意），
 *  加上選取框、參考線、等距徽章。座標一律用專案座標，view 變換由呼叫端先套好。 */
export interface StageOverlay {
  selection?: Rect[];
  guides?: GuideLine[];
  badges?: SpacingBadge[];
  /** 框選中的橡皮筋矩形（編輯畫布專用）。 */
  marquee?: Rect;
  /** 把專案裡的使用者參考線藏起來（只是看不到，不會刪掉）。 */
  hideProjectGuides?: boolean;
  /** 手把（專案座標，旋轉後的真實位置），固定螢幕尺寸。
   *  無 bar＝圓點（角，等比縮放）；bar＝長條（邊，裁切）——兩種角色不同，長相就要不同。 */
  handles?: { x: number; y: number; bar?: "v" | "h" }[];
  accent?: string;
}

export function renderStage(
  ctx: CanvasRenderingContext2D,
  project: Project,
  opts: RenderOptions = {},
  overlay: StageOverlay = {},
): void {
  const accent = overlay.accent ?? "#2F7CF6";

  // 有紙張時走離屏逐頁渲染——紙張是整頁的逐像素運算，套在被 view 變換過的
  // 畫布上會糊掉。沒紙張時直接畫，拖曳才不會每格都做一次 getImageData。
  const viaCanvas = !!(project.paperKey && opts.filters);
  for (let i = 0; i < project.pageCount; i++) {
    const page = pageRect(project, i);
    if (opts.viewRect && !intersects(page, opts.viewRect)) continue;   // 視野外的頁整頁跳過
    ctx.save();
    ctx.beginPath();
    ctx.rect(page.x, page.y, page.w, page.h);
    ctx.clip();                      // 逐頁裁切＝跨頁 bleed 的全部實作
    if (viaCanvas) {
      ctx.drawImage(renderPageCanvas(project, i, opts), page.x, page.y, page.w, page.h);
    } else {
      ctx.translate(page.x, page.y); // renderPage 內部用頁內座標
      renderPage(ctx, project, i, opts);
    }
    ctx.restore();
  }

  // 頁縫：畫布本身沒有縫，這條線只是給編輯時看的
  ctx.save();
  ctx.strokeStyle = "rgba(128,128,128,.45)";
  ctx.lineWidth = 1 / (ctx.getTransform().a || 1);
  for (let i = 1; i < project.pageCount; i++) {
    const x = i * project.canvasWidth;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, project.pageHeight); ctx.stroke();
  }
  ctx.restore();

  const px = 1 / (ctx.getTransform().a || 1);   // 一個螢幕像素等於多少專案單位

  // 使用者參考線（存在專案裡的那種）。**只有編輯畫布畫**——它是編輯用的參考，
  // 不是版面的一部分，所以匯出（renderPage）與頁面縮圖都看不到。
  // 垂直的存頁內座標＝每頁重複一條；水平的 y 是絕對座標＝跨整台 stage 一條。
  ctx.save();
  ctx.strokeStyle = "rgb(38,153,255)";   // iOS guideColor (0.15, 0.6, 1.0)
  ctx.lineWidth = px;
  for (const gx of overlay.hideProjectGuides ? [] : project.guidesX ?? []) {
    for (let i = 0; i < project.pageCount; i++) {
      if (opts.viewRect && !intersects(pageRect(project, i), opts.viewRect)) continue;
      const x = i * project.canvasWidth + gx;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, project.pageHeight); ctx.stroke();
    }
  }
  const stageW = project.canvasWidth * project.pageCount;
  for (const gy of overlay.hideProjectGuides ? [] : project.guidesY ?? []) {
    ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(stageW, gy); ctx.stroke();
  }
  ctx.restore();

  for (const g of overlay.guides ?? []) {
    ctx.save();
    ctx.strokeStyle = accent;
    ctx.lineWidth = px;
    ctx.beginPath();
    if (g.axis === "vertical") { ctx.moveTo(g.position, g.start); ctx.lineTo(g.position, g.end); }
    else { ctx.moveTo(g.start, g.position); ctx.lineTo(g.end, g.position); }
    ctx.stroke();
    ctx.restore();
  }

  for (const r of overlay.selection ?? []) {
    ctx.save();
    ctx.strokeStyle = accent;
    ctx.lineWidth = px * 1.5;
    ctx.setLineDash([px * 5, px * 4]);
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.restore();
  }

  if (overlay.marquee) {
    const r = overlay.marquee;
    ctx.save();
    ctx.fillStyle = "rgba(47,124,246,.10)";
    ctx.strokeStyle = accent;
    ctx.lineWidth = px;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.restore();
  }

  // 手把畫在選取框之後（壓在虛線上），尺寸固定在螢幕上——縮放時手感才一致
  for (const p of overlay.handles ?? []) {
    ctx.save();
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = accent;
    ctx.lineWidth = px * 1.5;
    ctx.beginPath();
    if (!p.bar) {
      ctx.arc(p.x, p.y, px * 4.5, 0, Math.PI * 2);
    } else {
      const long = px * 20, thick = px * 5;
      const w = p.bar === "h" ? long : thick, h = p.bar === "h" ? thick : long;
      ctx.roundRect(p.x - w / 2, p.y - h / 2, w, h, px * 2.5);
    }
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  // 等距徽章畫成藥丸（Figma 同款）：拖曳中要一眼讀到間距值，
  // 裸字 11px 疊在畫面上小到看不見（2026-08-14 使用者回報），改 14px 白字＋色底
  for (const b of overlay.badges ?? []) {
    ctx.save();
    ctx.font = `600 ${14 * px}px system-ui, sans-serif`;
    const label = String(b.value);
    const tw = ctx.measureText(label).width;
    const padX = 5 * px, ph = 19 * px;
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.roundRect(b.x - tw / 2 - padX, b.y - ph / 2, tw + padX * 2, ph, 5 * px);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, b.x, b.y);
    ctx.restore();
  }
}

function drawBlock(
  ctx: CanvasRenderingContext2D,
  project: Project,
  b: Block,
  page: Rect,
  opts: RenderOptions,
  pageLight = true,
): void {
  const { frame: f } = b;
  // 平移到頁內座標，並把原點移到 block 中心（旋轉繞中心）
  const cx = f.x + f.w / 2 - page.x;
  const cy = f.y + f.h / 2 - page.y;

  ctx.save();
  ctx.globalAlpha = b.opacity;
  ctx.translate(cx, cy);
  if (b.rotation) ctx.rotate((b.rotation * Math.PI) / 180);
  ctx.translate(-f.w / 2, -f.h / 2); // 之後一律用 block 本地座標 (0,0)-(f.w,f.h)

  switch (b.content.type) {
    case "shape":
      drawShape(ctx, b.content.shape, f.w, f.h);
      break;
    case "text":
    case "textFlow": {
      const t = b.content.text;
      // 長文框＝固定容器：超出裁切、可繞排。直排的長文框維持欄排路徑。
      if (t.isBodyFrame === true && t.vertical !== true) {
        drawBodyFrame(ctx, project, b, t, f.w, f.h);
      } else {
        drawText(ctx, t, f.w, f.h, project.canvasWidth, project.pageHeight);
      }
      break;
    }
    case "image":
    case "video":
      drawMedia(ctx, b.content.media, f.w, f.h, opts, pageLight);
      break;
  }
  ctx.restore();
}

function drawShape(ctx: CanvasRenderingContext2D, s: ShapeBlock, w: number, h: number): void {
  ctx.fillStyle = hex(s.colorHex);
  switch (s.kind) {
    case "rectangle": {
      const r = Math.min(s.cornerRadius ?? 0, Math.min(w, h) / 2);
      ctx.beginPath();
      ctx.roundRect(0, 0, w, h, r);
      ctx.fill();
      break;
    }
    case "ellipse":
      ctx.beginPath();
      ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      ctx.fill();
      break;
    case "line": {
      // 水平膠囊，垂直置中；未設粗細時給一個跟框高綁定的預設，clamp 不溢出框。
      const t = Math.max(1, Math.min(s.lineWidth ?? Math.max(2, h * 0.5), h));
      ctx.beginPath();
      ctx.roundRect(0, (h - t) / 2, w, t, t / 2);
      ctx.fill();
      break;
    }
  }
}

/** 遮罩路徑。maskCornerRadius 存的是「短邊一半」的分數，strokeWidth 是短邊的分數。 */
function maskPath(ctx: CanvasRenderingContext2D, m: MediaBlock, w: number, h: number): void {
  ctx.beginPath();
  if (m.maskShape === "ellipse") {
    ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    return;
  }
  const r = (m.maskCornerRadius ?? 0) * (Math.min(w, h) / 2);
  ctx.roundRect(0, 0, w, h, r);
}

/** 空欄位框（範本的填圖欄位）。墨色依頁底亮暗（iOS emptySlotPlaceholder 同款），
 *  匯出也畫——這就是範本該有的樣子，不是編輯器裝飾。圖示照定律用線性向量。 */
function drawEmptySlot(ctx: CanvasRenderingContext2D, m: MediaBlock, w: number, h: number, light: boolean): void {
  const ink = light ? "0,0,0" : "255,255,255";
  ctx.save();
  maskPath(ctx, m, w, h);
  ctx.clip();
  ctx.fillStyle = `rgba(${ink},${light ? 0.08 : 0.1})`;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();

  ctx.save();
  maskPath(ctx, m, w, h);
  ctx.strokeStyle = `rgba(${ink},${light ? 0.35 : 0.45})`;
  ctx.setLineDash([10, 8]);
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.setLineDash([]);

  // 中央圖示：山與太陽的線性小圖
  const s = Math.min(w, h) * 0.2;
  const cx = w / 2, cy = h / 2;
  ctx.strokeStyle = `rgba(${ink},0.4)`;
  ctx.lineWidth = Math.max(1.5, s * 0.06);
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  ctx.beginPath();
  ctx.roundRect(cx - s, cy - s * 0.75, s * 2, s * 1.5, s * 0.16);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx - s * 0.42, cy - s * 0.28, s * 0.14, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx - s * 0.85, cy + s * 0.55);
  ctx.lineTo(cx - s * 0.15, cy - s * 0.05);
  ctx.lineTo(cx + s * 0.25, cy + s * 0.3);
  ctx.lineTo(cx + s * 0.55, cy + s * 0.05);
  ctx.lineTo(cx + s * 0.9, cy + s * 0.4);
  ctx.stroke();
  ctx.restore();
}

/** 素材的原始像素尺寸。`<video>` 的自然尺寸在 videoWidth（naturalWidth 是 undefined，
 *  而 `.width` 是 HTML 屬性、預設 0）——查錯欄位會讓影片的 aspect-fill 整個歪掉。 */
export function naturalSize(img: CanvasImageSource): { w: number; h: number } {
  const v = img as HTMLVideoElement;
  if (v.videoWidth) return { w: v.videoWidth, h: v.videoHeight };
  const i = img as HTMLImageElement;
  return {
    w: i.naturalWidth || (img as HTMLCanvasElement).width,
    h: i.naturalHeight || (img as HTMLCanvasElement).height,
  };
}

/**
 * 影片匯出用：把媒體的遮罩烤成「形狀內不透明」的圖（Core Image 的 CIBlendWithMask 吃 alpha），
 * 以及往內描的外框圖。兩張都在**烤好的片段自己的像素尺寸**上畫，合成器逐格直接套。
 * 回 null＝這個 block 沒有遮罩／沒有外框。
 */
export function maskAndStrokeCanvases(
  m: MediaBlock, w: number, h: number,
): { mask: HTMLCanvasElement | null; stroke: HTMLCanvasElement | null } {
  const has = m.maskShape != null || (m.maskCornerRadius ?? 0) > 0;
  const sw = (m.strokeWidth ?? 0) * Math.min(w, h);
  let mask: HTMLCanvasElement | null = null;
  let stroke: HTMLCanvasElement | null = null;
  if (has) {
    mask = document.createElement("canvas");
    mask.width = Math.round(w); mask.height = Math.round(h);
    const c = mask.getContext("2d")!;
    c.fillStyle = "#ffffff";
    maskPath(c, m, w, h);
    c.fill();
  }
  if (sw > 0 && m.strokeHex) {
    stroke = document.createElement("canvas");
    stroke.width = Math.round(w); stroke.height = Math.round(h);
    const c = stroke.getContext("2d")!;
    maskPath(c, m, w, h);
    c.clip();
    maskPath(c, m, w, h);
    c.strokeStyle = hex(m.strokeHex);
    c.lineWidth = sw * 2;      // 形狀會把線寬對半切，加倍再裁回去＝往內描
    c.stroke();
  }
  return { mask, stroke };
}

function drawMedia(
  ctx: CanvasRenderingContext2D,
  m: MediaBlock,
  w: number,
  h: number,
  opts: RenderOptions,
  pageLight = true,
): void {
  // 空欄位槽＝範本欄位，永遠畫佔位樣式（含匯出）
  if (!m.assetFileName) { drawEmptySlot(ctx, m, w, h, pageLight); return; }
  // 影片畫的是海報圖（檔名＝影片名 + ".poster.jpg"），與 iOS 的預覽一致。
  // 濾鏡是預先套好的，所以查圖的鍵要帶上濾鏡代號——同一張圖套不同濾鏡是不同的快取項。
  const suffix = m.filterKey ? `|${m.filterKey}` : "";
  // 編輯中的影片優先畫即時影格（iOS 畫布上是靜音自動循環的真播放）；沒有就退回海報
  const img = m.assetFileName
    ? (opts.videos?.get(m.assetFileName + suffix)
       ?? opts.images?.get(m.assetFileName + suffix)
       ?? opts.images?.get(`${m.assetFileName}.poster.jpg${suffix}`))
    : undefined;

  ctx.save();
  if (m.maskShape != null || (m.maskCornerRadius ?? 0) > 0) {
    maskPath(ctx, m, w, h);
    ctx.clip();
  }

  if (img) {
    const { w: iw, h: ih } = naturalSize(img);
    // ⚠️ cropRect 的 (0,0,1,1) 是「未曾裁切」的哨兵值，**不可照字面拉伸**——
    // 要解成置中的 aspect-fill，否則換圖後會變形、裁切介面也會出現零餘裕的死狀態。
    const c = (m.cropRect.x === 0 && m.cropRect.y === 0 && m.cropRect.w === 1 && m.cropRect.h === 1)
      ? aspectFillCrop(iw, ih, w, h)
      : m.cropRect;
    const deg = m.rotationDegrees ?? 0;
    if (!deg) {
      // 沒拉直（絕大多數）＝原本那條路，逐位不變——不能讓沒轉過的圖有任何位移
      ctx.drawImage(img, c.x * iw, c.y * ih, c.w * iw, c.h * ih, 0, 0, w, h);
    } else {
      // 拉直：把**放大後的整張圖**繞自己的中心轉，再平移讓裁切區中心落到視窗中心。
      // 平移量本身也要被同一個角度轉過（那是螢幕空間的位移）——iOS 修過的 parity bug，
      // 少轉這一下圖會隨角度漂走。順序與裁切取景器完全相同：先轉再平移。
      const sw = w / c.w, sh = h / c.h;
      const ax = (c.x + c.w / 2 - 0.5) * sw, ay = (c.y + c.h / 2 - 0.5) * sh;
      const r = (deg * Math.PI) / 180, cs = Math.cos(r), sn = Math.sin(r);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, w, h);
      ctx.clip();
      ctx.translate(w / 2 - (cs * ax - sn * ay), h / 2 - (sn * ax + cs * ay));
      ctx.rotate(r);
      ctx.drawImage(img, -sw / 2, -sh / 2, sw, sh);
      ctx.restore();
    }
  } else if (opts.placeholderForMissingMedia) {
    ctx.strokeStyle = "rgba(128,128,128,.45)";
    ctx.setLineDash([8, 8]);
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, w - 2, h - 2);
    ctx.setLineDash([]);
  }
  ctx.restore();

  const sw = (m.strokeWidth ?? 0) * Math.min(w, h);
  if (sw > 0 && m.strokeHex) {
    ctx.save();
    // 描邊畫在遮罩輪廓上，線寬會被形狀對半切，所以加倍再裁回去才是「往內描」
    maskPath(ctx, m, w, h);
    ctx.clip();
    maskPath(ctx, m, w, h);
    ctx.strokeStyle = hex(m.strokeHex);
    ctx.lineWidth = sw * 2;
    ctx.stroke();
    ctx.restore();
  }
}

/**
 * 長文框：固定容器、超出裁切、逐列繞排。iOS `drawWrapText` 的移植——
 * 逐列算自由區間、每段塞到滿為止；一個字都塞不下的段留空（絕不滲進洞）。
 * 垂直對齊只在**無洞**時生效（iOS 同款：有洞時 middle/bottom 刻意忽略）。
 */
function drawBodyFrame(
  ctx: CanvasRenderingContext2D,
  project: Project,
  b: Block,
  t: TextBlock,
  w: number,
  h: number,
): void {
  const size = resolvedFontSize(t, project.canvasWidth);
  const kern = resolvedKerning(t, project.canvasWidth);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.clip();                       // 固定容器：溢出就是被裁掉，這是長文框的本義
  ctx.font = cssFont(t, size);
  ctx.letterSpacing = `${kern}px`;
  ctx.fillStyle = t.inkColor ?? hex(t.colorHex);
  ctx.textBaseline = "alphabetic";
  drawTextBackground(ctx, t, w, h, size);
  applyTextShadow(ctx, t, size);

  const holes = b.rotation === 0 ? wrapHoles(b, project.blocks) : [];
  const m = ctx.measureText("字");
  const natural = m.fontBoundingBoxAscent + m.fontBoundingBoxDescent;
  const rowH = natural * (t.lineHeightMultiple ?? 1) + (t.lineSpacing ?? 0);
  const ascent = m.fontBoundingBoxAscent + (rowH - natural) / 2;   // 行高撐開時字垂直置中
  const paraGap = (t.paragraphSpacingEm ?? 0) * size;
  const minSeg = size * 1.05;      // 窄過一個字的段塞不了字
  const chars = [...t.text];

  let y0 = 0;
  if (!holes.length && t.verticalAlignment && t.verticalAlignment !== "top") {
    const lines = wrap(ctx, t.text, w, kern);
    const paras = (t.text.match(/\n/g) ?? []).length;
    const total = lines.length * rowH + paras * paraGap;
    y0 = t.verticalAlignment === "middle" ? (h - total) / 2 : h - total;
  }

  let i = 0;
  let yTop = y0;
  while (i < chars.length && yTop + rowH <= h + 0.5) {
    const segs = freeIntervals(yTop, yTop + rowH, w, holes, minSeg);
    let endedParagraph = false;
    for (const seg of segs) {
      if (i >= chars.length) break;
      if (chars[i] === "\n") { i++; endedParagraph = true; break; }
      // 先量再收：一個字都塞不下＝這段留空，**不消耗字**（否則字會滲進洞）
      let acc = "", count = 0;
      while (i + count < chars.length && chars[i + count] !== "\n") {
        const next = acc + chars[i + count];
        if (count > 0 && lineWidth(ctx, next, kern) > seg.width) break;
        acc = next; count++;
      }
      if (!count) continue;
      const lw = lineWidth(ctx, acc, kern);
      if (count === 1 && lw > seg.width + 1) continue;
      i += count;
      let x = seg.x;
      if (t.alignment === "center") x = seg.x + (seg.width - lw) / 2;
      else if (t.alignment === "trailing") x = seg.x + seg.width - lw;
      ctx.fillText(acc, x, yTop + ascent);
      if (i < chars.length && chars[i] === "\n") { i++; endedParagraph = true; break; }
    }
    yTop += rowH + (endedParagraph ? paraGap : 0);
  }
  ctx.restore();
}

// ── 文字 ──────────────────────────────────────────────────────────────
// 這裡是第一版：橫排（含字距、行高、對齊、墨跡貼合）與直排的基本欄排。
// 尚未移植的在 Phase 1 第 2 塊：每字體自然欄距補償、文繞圖、離屏墨跡掃描定位。


// ── 文字的渲染層特效（iOS `TextShadow.swift`）───────────────────────────
// 兩個都**只是畫上去**：不進 AttributedString、不影響量測／貼字盒／吸附。

/** 陰影檔位的 em 參數表（iOS TextShadowStyle.params 逐值照抄）。 */
const SHADOW: Record<string, { dx: number; dy: number; blur: number; opacity: number }> = {
  soft:   { dx: 0,    dy: 0.06, blur: 0.12, opacity: 0.35 },
  strong: { dx: 0.03, dy: 0.06, blur: 0.04, opacity: 0.60 },
};

/**
 * 套上文字陰影。兩個 canvas 的坑：
 * 1. `shadowOffset`／`shadowBlur` **不吃 CTM**（規格如此）——所以要自己把偏移量
 *    乘進目前的變換矩陣。用矩陣的線性部分乘，旋轉過的文字陰影才會跟著轉
 *    （iOS 的陰影是在旋轉前的區域座標系裡加的）。
 * 2. canvas 的 `shadowBlur` 是**兩倍標準差**，CALayer／SwiftUI 的 radius 就是標準差
 *    ——所以要 ×2 才是同一團模糊。
 */
function applyTextShadow(ctx: CanvasRenderingContext2D, t: TextBlock, size: number): void {
  const p = SHADOW[t.shadowStyle ?? ""];
  if (!p) return;
  const c = hex(t.shadowColorHex, "000000");
  const ch = (i: number) => parseInt(c.slice(i, i + 2), 16);
  const m = ctx.getTransform();
  const ox = p.dx * size, oy = p.dy * size;
  ctx.shadowColor = `rgba(${ch(1)},${ch(3)},${ch(5)},${p.opacity})`;
  ctx.shadowOffsetX = m.a * ox + m.c * oy;
  ctx.shadowOffsetY = m.b * ox + m.d * oy;
  ctx.shadowBlur = p.blur * size * 2 * Math.hypot(m.a, m.b);
}

/** 文字底色：圓角矩形往外撐 0.25em、圓角 0.2em（iOS 的 `.padding(-pad)`）。
 *  底色自己不帶陰影——陰影是字的，畫在底色**之上**。 */
function drawTextBackground(
  ctx: CanvasRenderingContext2D, t: TextBlock, w: number, h: number, size: number,
): void {
  if (!t.backgroundColorHex) return;
  const pad = 0.25 * size;
  ctx.save();
  ctx.shadowColor = "transparent";
  ctx.fillStyle = hex(t.backgroundColorHex);
  ctx.beginPath();
  ctx.roundRect(-pad, -pad, w + pad * 2, h + pad * 2, 0.2 * size);
  ctx.fill();
  ctx.restore();
}

function drawText(
  ctx: CanvasRenderingContext2D,
  t: TextBlock,
  w: number,
  h: number,
  canvasWidth: number,
  pageHeight: number,
): void {
  const size = resolvedFontSize(t, canvasWidth);
  const kern = resolvedKerning(t, canvasWidth);

  ctx.font = cssFont(t, size);
  ctx.fillStyle = t.inkColor ?? hex(t.colorHex);
  ctx.textBaseline = "alphabetic";
  ctx.letterSpacing = `${kern}px`;

  drawTextBackground(ctx, t, w, h, size);
  applyTextShadow(ctx, t, size);

  if (t.vertical) drawVertical(ctx, t, w, size, kern, columnHeight(t, pageHeight));
  else drawHorizontal(ctx, t, w, h, size, kern);
}

/**
 * 量測一行的實際墨寬。
 * canvas 的 letterSpacing 跟 iOS 的 tracking 一樣，**每個字後面都加**，包含最後一個——
 * 所以量到的寬度多了一個字距，置中會偏半個字距、靠右不貼邊。這裡減回去。
 * （iOS 端對應 KernApplier.applyStrippingTrailing。）
 */
function lineWidth(ctx: CanvasRenderingContext2D, line: string, kern: number): number {
  if (!line) return 0;
  return ctx.measureText(line).width - kern;
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number, kern: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    if (!para) { out.push(""); continue; }
    let line = "";
    for (const ch of para) {
      const next = line + ch;
      if (line && lineWidth(ctx, next, kern) > maxW) { out.push(line); line = ch; }
      else line = next;
    }
    out.push(line);
  }
  return out;
}

/**
 * 直排的「欄高」——換行約束，直排時 manualHeight 的語意就是它。
 *
 * ⚠️ **絕不能拿 frame 高度當欄高。** 貼字盒的高度是由排版結果算出來的，
 * 再拿它回去當切欄約束就成了循環相依：框一縮、每欄裝得下的字變少、
 * 四個字被切成兩欄（2026-08-01 實際踩過，第 1 頁的「作品名稱」當場裂開）。
 */
function columnHeight(t: TextBlock, pageHeight: number): number {
  return t.manualHeight ?? pageHeight * 0.6;
}

/**
 * 直排的版面度量。量測與繪製共用同一份，欄數與位置不可能對不上。
 *
 * 關於欄距：iOS 端有一套「逐字體量測自然欄距再補償」的機制，看起來很嚇人，
 * 但把它的三段公式代開會發現 **最終欄距恆等於 1.22em × 行高倍數，字體被消掉了**——
 * 那套補償的用途就是抵銷 CoreText 自作主張套上的字體自然欄距
 * （黑體 1.5em、宋/明/粉圓 1.0em）。canvas 是自己逐欄擺位的，沒有東西要抵銷，
 * 所以直接用 1.22em 就是正確的最終值，不需要移植那套量測。
 */
function verticalMetrics(
  ctx: CanvasRenderingContext2D, t: TextBlock, size: number, kern: number, columnHeight: number,
) {
  const advance = size + kern;
  const pitch = size * VERTICAL_PITCH_EM * (t.lineHeightMultiple ?? 1);
  const perCol = Math.max(1, Math.floor(columnHeight / advance));

  const cols: string[] = [];
  for (const para of t.text.split("\n")) {
    if (!para) { cols.push(""); continue; }
    for (let i = 0; i < para.length; i += perCol) cols.push(para.slice(i, i + perCol));
  }

  // 墨跡尺寸逐字量測取最大值——中日文與英數的字身寬高差很多，用 em 猜會鬆。
  // 量測時字距必須歸零：letterSpacing 會被算進 measureText，直排的進距是我們
  // 自己逐字推的，讓它再加一次就會多算。
  let inkW = 0, inkTop = 0, inkBottom = 0;
  const spacing = ctx.letterSpacing;
  ctx.letterSpacing = "0px";
  for (const ch of t.text) {
    if (ch === "\n") continue;
    const m = ctx.measureText(ch);
    inkW = Math.max(inkW, m.actualBoundingBoxLeft + m.actualBoundingBoxRight);
    inkTop = Math.max(inkTop, m.actualBoundingBoxAscent);
    inkBottom = Math.max(inkBottom, m.actualBoundingBoxDescent);
  }
  ctx.letterSpacing = spacing;
  if (!inkW) { inkW = size; inkTop = size * 0.88; inkBottom = 0; }

  const longest = Math.max(...cols.map((c) => c.length), 1);
  return {
    cols, pitch, advance, inkW,
    // 貼字盒＝真實墨跡涵蓋範圍。最後一個字後面不再有進距（與橫排的
    // 「尾字字距要減掉」是同一回事，只是換到縱軸）。
    extentW: (cols.length - 1) * pitch + inkW,
    extentH: (longest - 1) * advance + inkTop + inkBottom,
  };
}

/** 橫排的行高與段距。量測與繪製共用，兩邊不可能分家。 */
function lineMetrics(ctx: CanvasRenderingContext2D, t: TextBlock, size: number, sample: string) {
  const m = ctx.measureText(sample || "字");
  const lineH = (m.fontBoundingBoxAscent + m.fontBoundingBoxDescent) * (t.lineHeightMultiple ?? 1)
    + (t.lineSpacing ?? 0);
  return { lineH, paraGap: (t.paragraphSpacingEm ?? 0) * size };
}

/**
 * 字身上下的空白帶。字體的 ascent 遠高於墨跡起點，中間那條空帶是留給重音符號的
 * （iOS 實測 point size 100 下：明體約 31、粉圓約 6、Inter 約 24）。
 * 把它從貼字盒扣掉，框才會真的貼在字上而不是貼在 ascent/descent 線上——
 * **這就是「外緣吸附」能對到真實字身的原因**，不是細節。
 * canvas 的 actualBoundingBox* 就是墨跡邊界，fontBoundingBox* 是排版邊界，相減即是。
 */
function inkInsets(ctx: CanvasRenderingContext2D, first: string, last: string, lineHeightMultiple: number) {
  const a = ctx.measureText(first || "字");
  const b = ctx.measureText(last || "字");
  const fragmentExtra = (a.fontBoundingBoxAscent + a.fontBoundingBoxDescent) * (lineHeightMultiple - 1);
  return {
    top: Math.max(0, a.fontBoundingBoxAscent - a.actualBoundingBoxAscent + fragmentExtra),
    bottom: Math.max(0, b.fontBoundingBoxDescent - b.actualBoundingBoxDescent),
  };
}

/**
 * 貼字盒的自然尺寸——iOS `naturalContentSize` / `naturalVerticalWidth` 的移植。
 *
 * ⚠️ 為什麼一定要有這支：範本檔裡存的 frame 是 **TemplateForge 寫的估值**
 * （橫排加 25%、直排加 10% 餘裕），不是實際尺寸；iOS 端載入後由 resizeToFitText
 * 依內容重算，所以手機上的框是貼著字的。少了這步，框就會鬆一圈。
 */
export function naturalTextSize(
  ctx: CanvasRenderingContext2D,
  t: TextBlock,
  canvasWidth: number,
  pageHeight: number,
): { w: number; h: number } {
  const size = resolvedFontSize(t, canvasWidth);
  const kern = resolvedKerning(t, canvasWidth);
  const minWidth = canvasWidth * 0.08;
  ctx.save();
  ctx.font = cssFont(t, size);
  ctx.letterSpacing = `${kern}px`;

  if (t.vertical) {
    // 直排：欄高是換行約束、寬度是自動長的那一軸（與橫排的角色互換）。
    // ⚠️ 高度用**實際墨跡涵蓋範圍**而不是欄高約束——iOS 是直接把 frame 高度設成
    //    欄高（未設時＝頁高 60%），單字的框就會有一整頁高。那個框對吸附毫無意義。
    const v = verticalMetrics(ctx, t, size, kern, columnHeight(t, pageHeight));
    ctx.restore();
    return { w: Math.max(Math.ceil(v.extentW), minWidth), h: Math.max(Math.ceil(v.extentH), 1) };
  }

  const lines = t.manualWidth != null ? wrap(ctx, t.text, t.manualWidth, kern) : t.text.split("\n");
  const { lineH, paraGap } = lineMetrics(ctx, t, size, lines[0] ?? "");
  const ink = inkInsets(ctx, lines[0] ?? "", lines[lines.length - 1] ?? "", t.lineHeightMultiple ?? 1);
  const measuredW = Math.max(...lines.map((l) => lineWidth(ctx, l, kern)), 0);
  const measuredH = lines.length * lineH + Math.max(0, lines.length - 1) * paraGap;
  ctx.restore();

  // 絕對對齊（2026-08-14）：有墨跡就貼墨跡。1.3em 保底只留給空文字（框要選得到）
  // 與置中/置底的殘留框（關掉長文框後 verticalAlignment 會留下）——那些框的字是
  // 照框高排的，改高度字會位移；版面穩定鐵則：舊值走舊碼。
  const legacy = !t.text.trim() || (t.verticalAlignment ?? "top") !== "top";
  const minHeight = legacy ? size * 1.3 : 1;
  return {
    w: t.manualWidth ?? Math.max(Math.ceil(measuredW), minWidth),
    h: Math.max(Math.max(Math.ceil(measuredH), minHeight) - ink.top - ink.bottom, 1),
  };
}

/**
 * 貼字寬一鍵（絕對對齊 2026-08-14）：把殘留的手動寬度收到剛好包住現有的行。
 * ClaudeForge 這類建構器會在單行標題留 manualWidth（900 vs 墨跡 ~285），
 * 框的「空氣」全從這來——吸附咬的是框，框鬆了什麼都對不準。
 *
 * 定律「不破壞使用者文字」＝**斷行一個都不能變、字待在原地**：
 * - 沒軟換行 → manualWidth 純屬殘留，整個交還自動貼字盒；
 * - 有軟換行（或長文框）→ 收到最寬行的墨寬。收緊不會改變 greedy 斷行：
 *   每行都是塞不下下一個字才斷的，收窄後更塞不下。收完仍驗一次斷行，
 *   對不上（理論上不會）就放棄不動——寧可不收也不能重排。
 * - 錨點照對齊方式修：置中的框兩邊往內收、靠右的固定右緣。
 */
export function snugTextWidth(
  ctx: CanvasRenderingContext2D,
  b: Block,
  canvasWidth: number,
  pageHeight: number,
): boolean {
  if (b.content.type !== "text" && b.content.type !== "textFlow") return false;
  const t = b.content.text;
  if (t.vertical || t.manualWidth == null) return false;
  const size = resolvedFontSize(t, canvasWidth);
  const kern = resolvedKerning(t, canvasWidth);

  ctx.save();
  ctx.font = cssFont(t, size);
  ctx.letterSpacing = `${kern}px`;
  const lines = wrap(ctx, t.text, t.manualWidth, kern);
  const hard = t.text.split("\n");
  const same = (x: string[], y: string[]) => x.length === y.length && x.every((l, i) => l === y[i]);

  if (t.isBodyFrame || !same(lines, hard)) {
    let tight = Math.ceil(Math.max(...lines.map((l) => lineWidth(ctx, l, kern)), 1));
    let ok = same(wrap(ctx, t.text, tight, kern), lines);
    for (let i = 0; i < 6 && !ok; i++) { tight++; ok = same(wrap(ctx, t.text, tight, kern), lines); }
    ctx.restore();
    if (!ok || tight >= t.manualWidth) return false;   // 收了會重排／本來就貼著＝不動
    t.manualWidth = tight;
  } else {
    ctx.restore();
    t.manualWidth = undefined;
  }

  const oldW = b.frame.w;
  const nat = naturalTextSize(ctx, t, canvasWidth, pageHeight);
  const delta = nat.w - oldW;
  if (t.alignment === "center") b.frame.x -= delta / 2;
  else if (t.alignment === "trailing") b.frame.x -= delta;
  b.frame.w = nat.w;
  b.frame.h = nat.h;
  if (t.isBodyFrame) t.manualHeight = nat.h;   // 長文框連高度一起收到內容
  return true;
}

/**
 * 文字的「印刷線」——大寫線與基線（絕對對齊 2026-08-14）。
 * 框頂是最高墨跡（i 點、重音、括號），人眼在畫面上對的卻是這兩條線；
 * 吸附引擎多咬這兩條，「明明對了卻差幾 px」才會消失。
 * 數學逐行鏡射 drawHorizontal——量測與繪製不可能分家。
 * 基線：貼字盒取最末行（整框看得見）、長文框取第一行（末行可能被裁掉）。
 * 大寫線：第一行含拉丁/數字才有；與框頂重合（全大寫）就不另給。
 */
export function textPrintLines(
  ctx: CanvasRenderingContext2D,
  t: TextBlock,
  frame: Rect,
  canvasWidth: number,
  _pageHeight: number,   // 直排支援時要用（欄高），先收著讓呼叫端不用改
): { base: number; cap?: number } | null {
  if (t.vertical) return null;
  const size = resolvedFontSize(t, canvasWidth);
  const kern = resolvedKerning(t, canvasWidth);
  ctx.save();
  ctx.font = cssFont(t, size);
  ctx.letterSpacing = `${kern}px`;
  const lines = t.manualWidth != null ? wrap(ctx, t.text, frame.w, kern) : t.text.split("\n");
  const { lineH, paraGap } = lineMetrics(ctx, t, size, lines[0] ?? "");
  const blockH = lines.length * lineH + Math.max(0, lines.length - 1) * paraGap;
  let y0 = 0;
  if (t.verticalAlignment === "middle") y0 = (frame.h - blockH) / 2;
  else if (t.verticalAlignment === "bottom") y0 = frame.h - blockH;
  const firstAsc = ctx.measureText(lines[0] || "字").actualBoundingBoxAscent;
  const bi = t.isBodyFrame ? 0 : lines.length - 1;
  const baseAsc = bi === 0 ? firstAsc : ctx.measureText(lines[bi] || "字").actualBoundingBoxAscent;
  const base = frame.y + y0 + bi * (lineH + paraGap) + baseAsc;
  let cap: number | undefined;
  if (/[A-Za-z0-9]/.test(lines[0] ?? "")) {
    const c = frame.y + y0 + firstAsc - ctx.measureText("H").actualBoundingBoxAscent;
    if (Math.abs(c - frame.y) > 0.5) cap = c;
  }
  ctx.restore();
  return { base, cap };
}

/**
 * 把所有自動貼字盒的文字 block 重算成自然尺寸——iOS `resizeToFitText` 的移植。
 * 長文框（isBodyFrame）是固定容器，兩軸都不動。
 * 寬度變化時依對齊方式調 origin.x，否則置中的標題會往一邊飄。
 */
export function autoFitText(ctx: CanvasRenderingContext2D, project: Project): void {
  for (const b of project.blocks) {
    if (b.content.type !== "text" && b.content.type !== "textFlow") continue;
    const t = b.content.text;
    if (t.isBodyFrame) continue;   // 長文框是固定容器，兩軸都是使用者設的，不重算

    // ⛔ 直排暫不重算。我們的欄距還是估的（統一 1.22em），而 iOS 是逐字體量測
    //    「自然欄距」再補償（黑體 1.5em、宋/明/粉圓 1.0em）。用估值去「修正」
    //    只會把字推到錯的位置——實測第 7 頁的「終」就往左跑了。
    //    等 Phase 1 第 2 塊把逐字體欄距補償做完再開。
    const nat = naturalTextSize(ctx, t, project.canvasWidth, project.pageHeight);
    const delta = nat.w - b.frame.w;
    if (t.vertical) {
      // 直排由右往左排（除非 verticalLeftToRight），閱讀起點在右邊——
      // 所以收框時要固定**右緣**，字才會留在原地。固定左緣的話整段會往左跳。
      if (t.verticalLeftToRight !== true) b.frame.x -= delta;
    } else if (t.manualWidth == null) {
      // 只有自動貼字寬的才需要錨點修正——手動指定寬度的框寬度不由這裡長。
      if (t.alignment === "center") b.frame.x -= delta / 2;
      else if (t.alignment === "trailing") b.frame.x -= delta;
    }
    b.frame.w = nat.w;
    b.frame.h = nat.h;
  }
}

function drawHorizontal(
  ctx: CanvasRenderingContext2D,
  t: TextBlock,
  w: number,
  h: number,
  size: number,
  kern: number,
): void {
  // manualWidth 未設＝貼字寬、單列不換行（可自由跨頁），這是 iOS 的 auto-fit 語意。
  const lines = t.manualWidth != null ? wrap(ctx, t.text, w, kern) : t.text.split("\n");
  const { lineH, paraGap } = lineMetrics(ctx, t, size, lines[0] ?? "");

  const blockH = lines.length * lineH + Math.max(0, lines.length - 1) * paraGap;
  let y = 0;
  if (t.verticalAlignment === "middle") y = (h - blockH) / 2;
  else if (t.verticalAlignment === "bottom") y = h - blockH;

  for (const line of lines) {
    const lm = ctx.measureText(line || "字");
    const baseline = y + lm.actualBoundingBoxAscent; // 墨跡上緣貼齊 → 等同 iOS 的貼字盒
    const lw = lineWidth(ctx, line, kern);
    let x = 0;
    if (t.alignment === "center") x = (w - lw) / 2;
    else if (t.alignment === "trailing") x = w - lw;
    if (line) ctx.fillText(line, x, baseline);
    y += lineH + paraGap;
  }
}

/**
 * 直排第一版：逐字往下堆、欄由右到左（除非 verticalLeftToRight）。
 *
 * ⚠️ 待補（Phase 1 第 2 塊）：iOS 對每個字體量測「自然欄距」再補償到統一基準，
 * 因為黑體自然欄距 1.5em、宋/明/粉圓只有 1.0em——不補償的話同一個行距值在不同
 * 字體看起來差很多。這版先用 iOS 的預設落點 1.22em，只有預設字體會準。
 */
function drawVertical(
  ctx: CanvasRenderingContext2D,
  t: TextBlock,
  w: number,
  size: number,
  kern: number,
  colH: number,
): void {
  const v = verticalMetrics(ctx, t, size, kern, colH);
  const ltr = t.verticalLeftToRight === true;

  ctx.save();
  ctx.letterSpacing = "0px"; // 直排的進距是自己逐字推的，不能讓 canvas 再加一次
  v.cols.forEach((col, i) => {
    // 欄心距框邊 inkW/2——與 verticalMetrics 的 extentW 同一個約定，
    // 所以貼字盒會剛好包住墨跡，兩邊不會各算各的。
    const cx = ltr ? v.inkW / 2 + i * v.pitch : w - v.inkW / 2 - i * v.pitch;
    let y = 0;
    for (const ch of col) {
      const m = ctx.measureText(ch);
      ctx.fillText(ch, cx - m.width / 2, y + m.actualBoundingBoxAscent);
      y += v.advance;
    }
  });
  ctx.restore();
}
