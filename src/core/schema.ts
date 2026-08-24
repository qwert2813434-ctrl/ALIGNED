import { __f } from "../i18n";
// ALIGN Core — 專案 schema 解碼。
//
// iOS 端是 Swift 合成的 Codable，JSON 形狀不是手寫的那種漂亮結構，三處要翻譯：
//   CGRect           → [[x,y],[w,h]]（unkeyed 容器）
//   enum 關聯值      → {"text":{"_0":{…}}}
//   AttributedString → ["文字", {屬性}, "文字", {屬性}…] 交錯陣列
// 這三個形狀是拿 92 份真實範本、2,423 個 block 實際比對出來的，不是照 Swift 原始碼猜的。
//
// 相容策略沿用 iOS：純加法。所有後加的欄位都 optional，absent 走舊路徑——
// 所以這裡幾乎每個欄位都是 `?`，那是刻意的，不是偷懶。

export interface Rect { x: number; y: number; w: number; h: number }

export type TextAlign = "leading" | "center" | "trailing";
export type VAlign = "top" | "middle" | "bottom";
export type ShapeKind = "rectangle" | "ellipse" | "line";

import type { BlockAnim } from "./anim";
import type { DoodleBlock } from "./doodle";
export type { DoodleBlock, DoodleStroke, BrushKind, DoodleWobble } from "./doodle";

export interface TextBlock {
  text: string;            // AttributedString 已攤平成純文字
  inkColor?: string;       // 從 run 屬性取出的 CSS 色（見 runColor 的說明，優先於 colorHex）
  alignment: TextAlign;
  manualWidth?: number;    // 未設＝貼字寬（單列不換行，可自由跨頁）
  manualHeight?: number;   // 橫排幾乎廢棄；直排時語意變成「欄高」
  verticalAlignment?: VAlign;
  isBodyFrame?: boolean;   // true＝長文框（固定容器、會裁切、吃文繞圖）
  vertical?: boolean;
  verticalLeftToRight?: boolean;  // 直排欄序，預設由右到左
  fontSize?: number;       // 未設 → canvasWidth * 0.045
  fontName?: string;       // 家族鍵（該家族 Regular 的 PostScript 名），未設＝系統黑體
  fontWeightValue?: number;// 0…4，未設 → 3 (bold)
  colorHex?: string;       // 無 "#"，未設＝黑
  kerning?: number;        // 舊：點
  kerningEm?: number;      // 新：em 分數（優先）
  lineSpacing?: number;    // 舊：額外點數（只能加不能減）
  lineHeightMultiple?: number;  // 新：行高倍數（<1 可壓緊）
  paragraphSpacingEm?: number;  // 僅橫排
  shadowStyle?: string;
  shadowColorHex?: string;
  backgroundColorHex?: string;
}

export interface MediaBlock {
  assetFileName: string;   // "" ＝空欄位槽
  /** 多圖輪播（2026-08-16 加）：主圖之後的其他張。設了＝播放時這個框一直 loop 換圖。
   *  只對 image 有意義；全部共用同一個 cropRect／遮罩／外框。 */
  carouselAssets?: string[];
  /** 輪播每張停的秒數，預設 CAROUSEL_INTERVAL。 */
  carouselInterval?: number;
  /** 輪播切換方式：cut＝直切（預設）；maskWipe＝連續遮罩（帶同方向位移）。 */
  carouselMode?: "cut" | "maskWipe";
  /** 連續遮罩的揭示方向，預設 left（從左）。與入場 maskWipe 同語彙。 */
  carouselDir?: "up" | "down" | "left" | "right";
  cropRect: Rect;          // 正規化 0–1；(0,0,1,1) 有特殊語意，見 geometry.aspectFillCrop
  rotationDegrees?: number;// 拉直（-45…45），轉的是內容不是 block
  maskShape?: "rectangle" | "ellipse";
  maskCornerRadius?: number;  // 短邊一半的分數
  strokeHex?: string;
  strokeWidth?: number;       // 短邊分數
  excludesText?: boolean;
  textWrapMode?: string;      // side | around | push
  filterKey?: string;         // a1…c4
}

export interface ShapeBlock {
  kind: ShapeKind;
  colorHex: string;
  cornerRadius?: number;
  lineWidth?: number;
  excludesText?: boolean;
  textWrapMode?: string;
}

/** 3D 物件（2026-08-16）。專案裡它永遠是「活的物件」（.glb 進 assets/，這裡只存
 *  引用＋展示參數）；匯出那一刻才逐格烤進影格。⚠️ 新內容型別＝舊版 iPad 會整檔拒讀，
 *  iOS 端必須同步加 case（哪怕只畫佔位圖）。 */
export interface ModelBlock {
  assetFileName: string;
  /** 展示方式：spin＝慢慢轉圈（循環）；spinStop＝快轉煞停（終點停在 yaw）。未設＝靜止。 */
  mode?: "spin" | "spinStop";
  /** spin：幾秒轉一圈，預設 MODEL_SECS_PER_TURN。 */
  secsPerTurn?: number;
  /** spinStop：轉幾圈（0.5 步進，半圈也行），預設 MODEL_TURNS。 */
  turns?: number;
  /** spinStop：煞停總秒數，預設 MODEL_SPIN_DUR。 */
  dur?: number;
  /** 靜止／終點角度（度）——排版上看到的那一面，也是快轉煞停的收尾面。 */
  yaw?: number;
}

export type BlockContent =
  | { type: "text"; text: TextBlock }
  | { type: "textFlow"; text: TextBlock }
  | { type: "image"; media: MediaBlock }
  | { type: "video"; media: MediaBlock }
  | { type: "shape"; shape: ShapeBlock }
  | { type: "model"; model: ModelBlock }
  /** 塗鴉（2026-08-23）。定義在 doodle.ts。⚠️ 同 model：新型別＝舊版 iPad 拒讀，iOS 要同步加 case。 */
  | { type: "doodle"; doodle: DoodleBlock };

export interface Block {
  id: string;
  /** 出場動畫（2026-08-16 加）。未設＝不動畫，舊檔零影響；
   *  encodeBlock 是展開式的，這個欄位自動進出存檔。 */
  anim?: BlockAnim;
  frame: Rect;       // 專案共享座標空間（不是頁內座標）
  rotation: number;  // 度
  zIndex: number;
  locked: boolean;
  opacity: number;
  content: BlockContent;
}

export interface Project {
  id: string;
  /** 出場動畫跑完的停留秒數（未設＝ANIM_HOLD 5 秒）。循環與匯出都吃這個值。 */
  animHold?: number;
  /** 「陸續出現」排順序時，每個元件之間的間隔秒數（未設＝ANIM_STAGGER）。 */
  animStagger?: number;
  name: string;
  createdAt: string;
  updatedAt: string;
  canvasWidth: number;   // ⚠️ 不保證是 1080——橫式 16:9 專案是 1920×1080
  pageHeight: number;
  pageCount: number;
  blocks: Block[];
  group?: string;
  pageBackgroundHex?: Record<string, string>;  // key 是頁 index 的字串 "0","1"…
  guidesX?: number[];    // 頁內座標，每頁重複繪製
  guidesY?: number[];    // 絕對座標（y 全頁共用）
  guidesLocked?: boolean;   // 鎖住＝畫布上滑鼠碰不到（線還在、吸附照舊）
  paperKey?: string;     // 全專案單一，刻意不逐頁（逐頁不同紙會在接縫露餡）
  /** 紙張套用範圍（2026-08-16）：未設＝true＝整頁都套（舊檔行為零變動）。
   *  關掉某一類＝那一類的像素不吃紙張，其餘照舊——分層渲染，z 序不變。 */
  paperOnObjects?: boolean;      // 物件（圖片／影片／形狀／3D）
  paperOnBackground?: boolean;   // 頁面底色
  paperOnText?: boolean;         // 文字
}

// ── 解碼 ──────────────────────────────────────────────────────────────

function rect(v: unknown): Rect {
  const [[x, y], [w, h]] = v as [[number, number], [number, number]];
  return { x, y, w, h };
}

/** AttributedString 攤平成純文字：屬性字典夾在字串之間，只挑出 string。 */
function plainText(runs: unknown): string {
  if (typeof runs === "string") return runs;
  if (!Array.isArray(runs)) return "";
  return runs.filter((r): r is string => typeof r === "string").join("");
}

/** 線性 RGB ↔ sRGB。SwiftUI 的 AttributedString 顏色**存線性值**（實測：colorHex
 *  8A8A8A＝sRGB 0.541 的 run 存 0.255＝其線性值）——直讀會讓中間調整組偏暗。 */
function linToSrgb(v: number): number {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}
function srgbToLin(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/**
 * 取 AttributedString 內的前景色。
 * iOS 渲染讀的是這個而非 colorHex——已知地雷：外部產生的 JSON 只給 colorHex、
 * AttributedString 沒有色屬性，深色模式會變白字、白底頁直接隱形。
 * 所以這裡以 run 屬性優先，colorHex 當後備。存檔值是線性 RGB，要轉回 sRGB。
 */
function runColor(runs: unknown): string | undefined {
  if (!Array.isArray(runs)) return undefined;
  for (const r of runs) {
    const v = (r as Record<string, { value?: Record<string, number> }>)?.["SwiftUI.ForegroundColor"]?.value;
    if (v && typeof v.red === "number") {
      const c = (n: number) => Math.round(linToSrgb(n) * 255);
      return `rgba(${c(v.red)},${c(v.green!)},${c(v.blue!)},${v.opacity ?? 1})`;
    }
  }
  return undefined;
}

function textBlock(o: Record<string, unknown>): TextBlock {
  return { ...o, text: plainText(o.text), inkColor: runColor(o.text) } as TextBlock;
}

function content(o: Record<string, unknown>): BlockContent {
  const [type] = Object.keys(o);
  const p = (o[type] as { _0: Record<string, unknown> })._0;
  switch (type) {
    case "text":     return { type: "text", text: textBlock(p) };
    case "textFlow": return { type: "textFlow", text: textBlock({ ...p, text: p.fullText }) };
    case "image":    return { type: "image", media: media(p) };
    case "video":    return { type: "video", media: media(p) };
    case "shape":    return { type: "shape", shape: p as unknown as ShapeBlock };
    case "model":    return { type: "model", model: p as unknown as ModelBlock };
    case "doodle":   return { type: "doodle", doodle: p as unknown as DoodleBlock };
    default: throw new Error(__f("未知的 block 型別: {type}", { type }));
  }
}

function media(o: Record<string, unknown>): MediaBlock {
  return { ...o, cropRect: o.cropRect ? rect(o.cropRect) : { x: 0, y: 0, w: 1, h: 1 } } as unknown as MediaBlock;
}

export function decodeProject(json: unknown): Project {
  const o = json as Record<string, unknown>;
  const blocks = (o.blocks as Record<string, unknown>[]).map((b) => ({
    ...b,
    frame: rect(b.frame),
    content: content(b.content as Record<string, unknown>),
  })) as unknown as Block[];
  return { ...o, blocks } as unknown as Project;
}

// ── 衍生值（iOS 端同名函式的移植）────────────────────────────────────

/** 字距的唯一解析器：em 制優先，否則舊點制。對應 TextBlock.resolvedKerning。 */
export function resolvedKerning(t: TextBlock, canvasWidth: number): number {
  if (t.kerningEm != null) return t.kerningEm * (t.fontSize ?? canvasWidth * 0.045);
  return t.kerning ?? 0;
}

export function resolvedFontSize(t: TextBlock, canvasWidth: number): number {
  return t.fontSize ?? canvasWidth * 0.045;
}

/** 未設 colorHex ＝黑；hex 不帶 "#"。 */
export function hex(h: string | undefined, fallback = "000000"): string {
  return `#${h ?? fallback}`;
}

// ── 編碼（存檔）──────────────────────────────────────────────────────
//
// 解碼時 spread 保留了所有未知欄位（shadowStyle、isBodyFrame、textWrapMode…），
// 所以編碼從模型就能無損還原，不需要另存原始 JSON。三個形狀反向翻譯回去：
// Rect → [[x,y],[w,h]]、content → {"text":{"_0":…}}、文字 → AttributedString runs。

function encRect(r: Rect): number[][] {
  return [[r.x, r.y], [r.w, r.h]];
}

/**
 * 把純文字＋顏色重建成 AttributedString 的 runs。
 *
 * ⚠️ 顏色**必須**烤進 runs（iOS 渲染讀的是 run 屬性不是 colorHex）——只給 colorHex
 * 的外部 JSON 在深色模式會變白字（已知地雷）。形狀照抄真實存檔逐字對齊：
 * `{"SwiftUI.ForegroundColor":{"tag":{"constant":{}},"value":{red,green,blue,opacity}}}`。
 * 這也是 iOS 自己存檔的格式（fontStripped 之後 runs 只剩前景色），所以重建＝同構。
 */
function colorRuns(text: string, hexColor: string): unknown[] {
  const n = (i: number) => srgbToLin(parseInt(hexColor.slice(i, i + 2), 16) / 255);
  return [text, {
    "SwiftUI.ForegroundColor": {
      tag: { constant: {} },
      value: { red: n(0), green: n(2), blue: n(4), opacity: 1 },
    },
  }];
}

export function encodeProject(p: Project): unknown {
  const { blocks, ...rest } = p;
  return {
    ...rest,
    // iOS 用預設的 ISO8601DateFormatter 解日期——**吃不下毫秒**，
    // toISOString() 的 ".123Z" 會讓整份檔解不開，要剪掉。
    updatedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    blocks: blocks.map(encodeBlock),
  };
}

function encodeBlock(b: Block): unknown {
  const { content, frame, ...bb } = b;
  let c: unknown;
  switch (content.type) {
    case "text": case "textFlow": {
      const { inkColor, text, ...t } = content.text;
      void inkColor;   // 模型內部欄位，不進存檔
      const runs = colorRuns(text, content.text.colorHex ?? "000000");
      const payload = content.type === "textFlow"
        ? { ...t, fullText: runs }
        : { ...t, text: runs };
      c = { [content.type]: { _0: payload } };
      break;
    }
    case "image": case "video": {
      const { cropRect, ...m } = content.media;
      c = { [content.type]: { _0: { ...m, cropRect: encRect(cropRect) } } };
      break;
    }
    case "shape":
      c = { shape: { _0: { ...content.shape } } };
      break;
    case "model":
      c = { model: { _0: { ...content.model } } };
      break;
    case "doodle":
      c = { doodle: { _0: { ...content.doodle } } };
      break;
  }
  return { ...bb, frame: encRect(frame), content: c };
}
