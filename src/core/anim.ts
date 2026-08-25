// ALIGN Core — 出場動畫求值（純函式，無 DOM）。
//
// **設計原則：求值與繪製分離。** 這支只回答「時間 t 時這個 block 長什麼樣」，
// 不碰畫布。預覽、逐格匯出、未來的 iOS 端都吃同一份求值結果——
// 與 render.ts 同一條鐵則：**畫面只有一條路，兩條路一定會漂移**。
//
// 規格（2026-08-16 使用者定）：
//   文字＝in 點固定在「文字開頭」，方向朝尾端（橫排向右、直排向下）
//   物件＝in 點方向可自訂上下左右
//   所有出場最後停留 5 秒
//   緩入曲線先寫死，之後再開放可調
//
// ⚠️ 尚未接上專案存檔與 UI（Stage 2）。目前設定由呼叫端以 Map 餵入。

import type { Rect } from "./schema";
import { DOODLE_TRAVEL_DUR } from "./doodle";

/** 停留秒數的**預設值**——規格是 5 秒，但長文入場 30 秒配 5 秒停留就走味了，
 *  所以真正的值存在 Project.animHold，這裡只是沒設時的回落。 */
export const ANIM_HOLD = 5;
/** 停留秒數上限。 */
export const ANIM_HOLD_MAX = 60;
/** 入場預設秒數（物件用）。 */
export const ANIM_DUR = 0.9;
/** 入場秒數上限——長文打字要慢慢跑，5 秒遠遠不夠（2026-08-16 使用者反饋）。 */
export const ANIM_DUR_MAX = 30;

/**
 * 逐字／逐句／閃現這類「把文字攤開」的效果，預設秒數要跟字數走——
 * 同一個 0.9 秒，短標題剛好、長文變成一閃而過。約 8 字／秒，接近讀得完的速度。
 */
export function textRevealDur(text: string, charsPerSec = 8): number {
  const n = text.replace(/\s/g, "").length;
  return Math.min(ANIM_DUR_MAX, Math.max(0.6, Math.round((n / charsPerSec) * 10) / 10));
}

/** 這個效果是不是「把文字攤開」型（預設秒數要吃字數）。 */
export const isTextReveal = (k: AnimKind): boolean =>
  k === "typewriter" || k === "textPhrase" || k === "textFlicker";

/** 塗鴉的生長出場：reveal 語意（0…1 沿路徑長度），渲染端交給 drawDoodle。 */

/**
 * 每種效果的合理預設秒數。
 * **攤開型吃字數**（長文要慢慢跑）；**動作型是固定的**——位移就是位移，
 * 跟文字多長無關，沿用攤開型的秒數會慢到不像話（2026-08-16 使用者反饋）。
 */
export function defaultDur(kind: AnimKind, text = ""): number {
  switch (kind) {
    case "typewriter": return textRevealDur(text, 8);    // 逐字，讀得完的速度
    case "textPhrase": return textRevealDur(text, 12);   // 逐句整塊落地，可以快一點
    case "textFlicker": return textRevealDur(text, 14);  // 質感效果，不必等它讀完
    case "textSlide": return 0.8;                        // ↓ 以下都是「一個動作」，與長度無關
    case "slide": return 0.9;
    case "fade": return 0.7;
    case "scale": return 0.8;
    case "maskWipe": return 1.2;                         // 要看得到遮罩推進＋內容位移
    default: return ANIM_DUR;
  }
}
/** 「陸續出現」的**預設**間隔秒數；真正的值存在 Project.animStagger。 */
export const ANIM_STAGGER = 0.2;
/** 間隔秒數上限。 */
export const ANIM_STAGGER_MAX = 5;

/** 兩段式第二段的預設秒數。 */
export const ANIM_STAGE2_DUR = 0.6;
/** 「接著放大」的預設倍率（150%）。 */
export const ANIM_STAGE2_SCALE = 1.5;

/** 兩段式**縮放**出場的第二段（物件限定）。模型（2026-08-16 使用者定案）：
 *  整條都是縮放語彙——第一段＝在版面位置**從 0 放大到 100%**（第一個位置），
 *  第二段＝接著放大到**第二個位置**並**停在那裡**（停留期間維持）——
 *  scale＝自訂倍率（scale2，預設 150%）；fullscreen＝蓋滿整頁。
 *  所以 stage2 設了之後，第一段不跑 kind 的效果（淡入／遮罩…），就是縮放。
 *  ⚠️ 曾短暫做成「先放大入場再縮回」（settle）——三個並排的物件入場時會互相打架，已廢。 */
export type Stage2 = "scale" | "fullscreen";

/** 文字四種、物件四種。文字的方向是固定的（開頭→尾端），所以沒有 dir。 */
export type AnimKind =
  | "typewriter"    // 打字效果（逐字）
  | "textPhrase"    // 逐句出場（依空白／逗點／換行切段，一段一段出現）
  | "textSlide"     // 位移出場
  | "textFlicker"   // 隨機閃現出場
  | "slide"         // 物件：位移出場
  | "fade"          // 物件：淡入
  | "scale"         // 物件：縮放出場
  | "maskWipe"      // 物件：遮罩出場（遮罩未到位時內容仍有定向位移）
  | "draw";         // 塗鴉：生長（沿畫的順序長出來）

export type AnimDir = "up" | "down" | "left" | "right";

export interface BlockAnim {
  kind: AnimKind;
  /** 物件用；文字忽略（文字永遠從開頭往尾端）。預設 left＝從左邊進來。 */
  dir?: AnimDir;
  /** 入場秒數，預設 ANIM_DUR。 */
  dur?: number;
  /** 起始延遲秒數，預設 0。 */
  delay?: number;
  /** 兩段式：入場後接著放大到第二個位置。未設＝單段，入場就結束。 */
  stage2?: Stage2;
  /** 第二段秒數，預設 ANIM_STAGE2_DUR。 */
  dur2?: number;
  /** stage2="scale" 的目標倍率，預設 ANIM_STAGE2_SCALE（1.5＝150%）。 */
  scale2?: number;
}

export interface AnimState {
  /** 位移（專案座標） */
  dx: number;
  dy: number;
  /** 以 frame 中心等比縮放 */
  scale: number;
  opacity: number;
  /** 遮罩矩形（專案座標）。未給＝不裁切。 */
  clip?: Rect;
  /** 文字顯示比例 0…1。未給＝全部顯示。 */
  reveal?: number;
  /** 文字顯示的切法：逐字／逐句／隨機閃現。 */
  revealMode?: "char" | "phrase" | "flicker" | "draw";
}

/** 靜止狀態（沒有動畫、或動畫已結束）。 */
const REST: AnimState = { dx: 0, dy: 0, scale: 1, opacity: 1 };

/** 緩入曲線——先寫死 ease-out cubic（規格：之後再開放可調）。 */
const ease = (p: number): number => 1 - Math.pow(1 - p, 3);

/** 位移方向的單位向量（從哪個方向進來）。 */
function vec(dir: AnimDir | undefined): { x: number; y: number } {
  switch (dir ?? "left") {
    case "up": return { x: 0, y: -1 };
    case "down": return { x: 0, y: 1 };
    case "right": return { x: 1, y: 0 };
    default: return { x: -1, y: 0 };
  }
}

/** 這個動畫總共佔多久（不含停留）。兩段式＝第一段＋第二段。 */
export function animEnd(a: BlockAnim): number {
  return (a.delay ?? 0) + (a.dur ?? ANIM_DUR) + (a.stage2 ? (a.dur2 ?? ANIM_STAGE2_DUR) : 0);
}

/** 整頁時間軸長度＝最晚結束的動畫 ＋ 停留。 */
export function timelineDuration(anims: Iterable<BlockAnim>, hold = ANIM_HOLD): number {
  let end = 0;
  for (const a of anims) end = Math.max(end, animEnd(a));
  return end + hold;
}

/** 一個輪播框的完整週期秒數（張數 × 間隔）。0＝這個框沒有輪播。 */
export function carouselPeriod(m: { carouselAssets?: string[]; carouselInterval?: number }): number {
  const n = (m.carouselAssets?.length ?? 0) + 1;
  return n > 1 ? n * Math.max(0.2, m.carouselInterval ?? CAROUSEL_INTERVAL) : 0;
}

/**
 * 一輪的長度與開頭的「0 狀態」空拍。
 * **預覽（editor.playAnim）與匯出（buildAnimFrames）都必須走這一個函式**——
 * 節奏是同一件事，寫成兩份算式一定會漂。
 * cycle 會進位到最長輪播週期的整數倍——循環繞回時輪播才不會跳張。
 */
export function timelineCycle(
  anims: Iterable<BlockAnim>, carouselPeriods: Iterable<number>,
  hold = ANIM_HOLD, stagger = ANIM_STAGGER,
  /** 額外的「至少要演完」秒數——3D 快轉煞停的總長走這裡（它不是 BlockAnim）。 */
  minEnd = 0,
): { lead: number; cycle: number } {
  let end = minEnd, n = 0;
  for (const a of anims) { end = Math.max(end, animEnd(a)); n++; }
  const lead = n ? stagger : 0;
  let cycle = Math.max(end + hold, 1) + lead;
  let longest = 0;
  for (const p of carouselPeriods) longest = Math.max(longest, p);
  if (longest > 0) cycle = Math.ceil(cycle / longest) * longest;
  return { lead, cycle };
}

/** 收集會影響時間軸的「非 BlockAnim」節奏：輪播與 3D 慢轉的週期（循環要進位到整數倍）、
 *  3D 快轉煞停的總長（循環至少要演完它）。編輯預覽與匯出共用——節奏只有一份。
 *
 *  `videoDur`（2026-08-26 規則）：頁上有真影片時，影片長度也進週期——循環會進位到
 *  片長的整數倍，影片永遠演完整支不被腰斬。長度是素材的執行期屬性（metadata），
 *  不進檔案，由呼叫端供應（編輯端＝VideoPool、匯出端＝已載入的播放器、iOS＝AVAsset）。 */
export function motionTempo(
  blocks: Iterable<{ content: { type: string;
    media?: { assetFileName?: string; carouselAssets?: string[]; carouselInterval?: number };
    model?: { mode?: "spin" | "spinStop"; secsPerTurn?: number; dur?: number };
    doodle?: { play?: "travel"; travelDur?: number; wobble?: string } } }>,
  videoDur?: (file: string) => number | undefined,
): { periods: number[]; minEnd: number; auto: boolean } {
  const periods: number[] = [];
  let minEnd = 0;
  for (const b of blocks) {
    const c = b.content;
    if (c.type === "image" && c.media) {
      const p = carouselPeriod(c.media);
      if (p) periods.push(p);
    }
    if (c.type === "video" && c.media?.assetFileName && videoDur) {
      const d = videoDur(c.media.assetFileName);
      if (d && Number.isFinite(d) && d > 0.05) periods.push(d);
    }
    if (c.type === "model" && c.model) {
      if (c.model.mode === "spin") periods.push(Math.max(0.5, c.model.secsPerTurn ?? MODEL_SECS_PER_TURN));
      if (c.model.mode === "spinStop") minEnd = Math.max(minEnd, c.model.dur ?? MODEL_SPIN_DUR);
    }
    // 塗鴉巡線：一圈的秒數進週期，循環繞回時頭尾才接得上
    if (c.type === "doodle" && c.doodle?.play === "travel") {
      periods.push(Math.max(0.3, c.doodle.travelDur ?? DOODLE_TRAVEL_DUR));
    }
  }
  return { periods, minEnd, auto: periods.length > 0 || minEnd > 0 };
}

/** 停留秒數的取值（2026-08-26 使用者定）：頁上有會播的內容（影片／輪播／3D 展示／
 *  塗鴉巡線）＝停留自動「跟著播放長度」（hold 取 0，循環由週期進位補滿）；
 *  只有純出場動畫的頁，手動的停留秒數才有意義。UI 的停留鈕同一條規則收放。 */
export function effectiveHold(tempo: { auto: boolean }, animHold: number | undefined): number {
  return tempo.auto ? 0 : (animHold ?? ANIM_HOLD);
}

/**
 * 求 block 在時間 t（秒）的狀態。
 * `frame` 是 block 在專案座標的矩形，`page` 是所在頁的矩形——位移距離以頁寬／頁高為尺度，
 * 這樣同一組設定在任何畫布比例下的體感一致。
 */
export function animStateAt(
  a: BlockAnim | undefined,
  t: number,
  frame: Rect,
  page: Rect,
  vertical = false,
): AnimState {
  if (!a) return REST;
  const delay = a.delay ?? 0;
  const dur = a.dur ?? ANIM_DUR;
  // 認得的第二段才走兩段式；其餘（含舊試驗值）一律當單段，不炸檔
  const s2 = a.stage2 === "scale" || a.stage2 === "fullscreen" ? a.stage2 : undefined;
  const t1 = t - delay;
  const p1 = dur <= 0 ? 1 : t1 / dur;
  if (p1 < 1) {
    if (s2) {
      // 兩段式＝縮放語彙：第一段就是 0→100（在版面位置從無放大到原尺寸）。
      // scale 0 本身就是看不見，所以 0 狀態／還沒開始都自然成立。
      return { ...REST, scale: p1 <= 0 ? 0 : ease(p1) };
    }
    // 單段：照 kind 入場到版面位置。還沒開始＝停在起點（起點本來就在畫面外或全透明）
    // 塗鴉生長走**等速**——畫畫是勻速把線拉出來，緩出會像最後在拖慢（2026-08-23）
    return atProgress(a, p1 <= 0 ? 0 : a.kind === "draw" ? p1 : ease(p1), frame, page, vertical);
  }
  if (!s2) return REST;   // 單段：入場完＝定格在版面位置

  // ── 第二段：從版面位置放大到第二個位置，到位後**停在那裡**（停留期間維持） ──
  const d2 = a.dur2 ?? ANIM_STAGE2_DUR;
  const q = d2 <= 0 ? 1 : (t1 - dur) / d2;
  const k = q >= 1 ? 1 : ease(Math.max(q, 0));
  if (s2 === "scale") {
    const S = a.scale2 ?? ANIM_STAGE2_SCALE;
    return { ...REST, scale: 1 + (S - 1) * k };
  }
  // fullscreen：等比放大到蓋滿整頁、中心對齊頁中心。超出頁面由逐頁裁切收掉，不會溢到隔壁頁。
  const cover = Math.max(page.w / frame.w, page.h / frame.h);
  const dx = page.x + page.w / 2 - (frame.x + frame.w / 2);
  const dy = page.y + page.h / 2 - (frame.y + frame.h / 2);
  return { ...REST, scale: 1 + (cover - 1) * k, dx: dx * k, dy: dy * k };
}

function atProgress(
  a: BlockAnim, p: number, frame: Rect, page: Rect, vertical: boolean,
): AnimState {
  const v = vec(a.dir);
  switch (a.kind) {
    // ── 文字：in 點固定在開頭，方向朝尾端 ──
    case "typewriter":
      return { ...REST, reveal: p, revealMode: "char" };
    case "textPhrase":
      // 逐句：依空白／逗點／換行切段，一段一段出現（不是遮罩掃描——那是另一種語彙）
      return { ...REST, reveal: p, revealMode: "phrase" };
    case "textSlide": {
      // 從開頭那一側滑入（橫排從左、直排從上），距離取字框的一半
      const d = (1 - p) * (vertical ? frame.h : frame.w) * 0.5;
      return { ...REST, dx: vertical ? 0 : -d, dy: vertical ? -d : 0, opacity: p };
    }
    case "textFlicker":
      return { ...REST, reveal: p, revealMode: "flicker" };
    case "draw":
      return { ...REST, reveal: p, revealMode: "draw" };

    // ── 物件：方向可自訂 ──
    case "slide": {
      const d = 1 - p;
      return { ...REST, dx: v.x * page.w * 0.35 * d, dy: v.y * page.h * 0.35 * d, opacity: Math.min(1, p * 1.6) };
    }
    case "fade":
      return { ...REST, opacity: p };
    case "scale":
      return { ...REST, scale: 0.86 + 0.14 * p, opacity: p };
    case "maskWipe": {
      const w = maskWipeState(frame, p, a.dir);
      return { ...REST, clip: w.clip, dx: w.dx, dy: w.dy };
    }
    default:
      return REST;
  }
}

/**
 * 遮罩揭示的幾何：遮罩沿指定方向長出來；**遮罩還沒到位時內容仍有定向位移**，
 * 且與遮罩**同方向**（使用者 2026-08-16 更正：對沖看起來像被推回去）。
 * 入場的 maskWipe 與多圖輪播的「連續遮罩」都吃這一份——兩邊語彙必須一致。
 */
export function maskWipeState(
  frame: Rect, p: number, dir?: AnimDir,
): { clip: Rect; dx: number; dy: number } {
  const v = vec(dir);
  const clip = { ...frame };
  if (v.x !== 0) {
    clip.w = frame.w * p;
    if (v.x > 0) clip.x = frame.x + frame.w * (1 - p);   // 從右往左揭
  } else {
    clip.h = frame.h * p;
    if (v.y > 0) clip.y = frame.y + frame.h * (1 - p);
  }
  const drift = (1 - p) * 0.18;
  return { clip, dx: v.x * frame.w * drift, dy: v.y * frame.h * drift };
}

/**
 * 打字／閃現時，文字要顯示到第幾個字。
 * 打字＝前 n 個字；閃現＝用固定雜湊決定每個字的出現時機（同一段文字每次都一樣）。
 */
export function revealText(
  text: string, reveal: number | undefined, mode: "char" | "phrase" | "flicker" = "char",
): string {
  if (reveal === undefined || reveal >= 1) return text;
  if (reveal <= 0) return blankOut(text);

  if (mode === "phrase") {
    // 一段＝一串非分隔字元＋跟在後面的分隔字元（空白／逗點／句點／換行）
    const segs = text.match(/[^\s,，、。;；]+[\s,，、。;；]*|[\s,，、。;；]+/g) ?? [text];
    const n = Math.ceil(segs.length * reveal);
    return segs.map((sg, i) => (i < n ? sg : blankOut(sg))).join("");
  }
  if (mode === "flicker") {
    let out = "";
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === "\n") { out += c; continue; }
      // 固定雜湊 → 每個字有自己的出現門檻，但同一段文字每次算都一樣
      out += ((i * 2654435761) % 1000) / 1000 < reveal ? c : " ";
    }
    return out;
  }
  const n = Math.floor(text.length * reveal);
  return text.slice(0, n) + blankOut(text.slice(n));
}

/** 換成等量空白——換行要留著，不然字塊高度會跳動。 */
const blankOut = (s: string): string => s.replace(/[^\n]/g, " ");

// ── 3D 物件展示（2026-08-16 使用者定案）─────────────────────────────────
// 兩種方式，速率／圈數都可調：spin＝慢慢轉圈循環（秒/圈）；
// spinStop＝快轉煞停（圈數 0.5 步進、半圈也行），**終點永遠停在 yaw（正面）**——
// 起始角用終點反推，快轉的收尾就是 money shot。

/** spin 預設幾秒轉一圈。 */
export const MODEL_SECS_PER_TURN = 8;
/** spinStop 預設轉幾圈。 */
export const MODEL_TURNS = 1.5;
/** spinStop 預設煞停秒數。 */
export const MODEL_SPIN_DUR = 2.2;

/** 3D 物件在時間 t 的朝向（度）。t 未給或模式未設＝靜止在 yaw。 */
export function modelYawAt(
  m: { mode?: "spin" | "spinStop"; secsPerTurn?: number; turns?: number; dur?: number; yaw?: number },
  t?: number,
): number {
  const yaw0 = m.yaw ?? 0;
  if (t === undefined || !m.mode) return yaw0;
  const tt = Math.max(0, t);   // 0 狀態（負時間）停在起點
  if (m.mode === "spin") {
    return yaw0 + (360 * tt) / Math.max(0.5, m.secsPerTurn ?? MODEL_SECS_PER_TURN);
  }
  const turns = Math.max(0.5, m.turns ?? MODEL_TURNS);
  const d = m.dur ?? MODEL_SPIN_DUR;
  const p = d <= 0 ? 1 : Math.min(1, tt / d);
  return yaw0 - 360 * turns * (1 - ease(p));
}

// ── 多圖輪播（2026-08-16 使用者定案）───────────────────────────────────
// 單一畫框內多張圖一直 loop，「不停留」＝不理會頁面的停留段，整個循環都在換。
// 兩種切換：cut＝到點直接換；maskWipe＝新圖從左以遮罩揭進來、蓋在舊圖上。

/** 輪播每張停的預設秒數。 */
export const CAROUSEL_INTERVAL = 1;
/** 遮罩切換窗的秒數（間隔太短時取間隔的一半，不然永遠在切）。 */
export const CAROUSEL_WIPE = 0.35;

export interface CarouselState {
  /** 現在畫哪一張（底層）。 */
  cur: number;
  /** 遮罩切換中：正在揭進來的那張（畫在 cur 上面）。 */
  next?: number;
  /** 揭示比例 0…1（已過 ease）。 */
  wipe?: number;
}

/** 時間 t 時輪播該畫哪張。t 用頁面循環的時間即可——循環繞回就從第一張重來，成品才是完美 loop。 */
export function carouselAt(
  count: number, t: number,
  interval = CAROUSEL_INTERVAL, mode: "cut" | "maskWipe" = "cut",
): CarouselState {
  if (count <= 1) return { cur: 0 };
  const iv = Math.max(0.2, interval);
  const tt = Math.max(0, t);            // 0 狀態（負時間）停在第一張
  const idx = Math.floor(tt / iv) % count;
  if (mode !== "maskWipe") return { cur: idx };
  const into = tt % iv;
  const w = Math.min(CAROUSEL_WIPE, iv / 2);
  if (into < w && tt >= iv) {           // 第一張的開頭沒有「舊圖」，不做揭示
    const prev = (idx + count - 1) % count;
    return { cur: prev, next: idx, wipe: ease(into / w) };
  }
  return { cur: idx };
}
