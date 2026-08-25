// ALIGN Core — 塗鴉（2026-08-23，小高規格）。
//
// 一個塗鴉 block ＝ 一張「紙」，上面多筆畫；畫第一筆就自動生成 block，之後的筆畫
// 都進同一個 block（不用分圖層——它本身就是頁面上的一層）。
//
// 規格：
//   筆刷  pen 鋼筆／marker 麥克筆／pencil 鉛筆（顆粒）／crayon 蠟筆／brush 毛筆（兩端收細）／
//         highlighter 螢光筆／dotted 點線
//   播放  grow＝生長（沿畫的順序長出來，走出場動畫 kind "draw"）
//         travel＝移動（前面生長、後面消失，循環；週期進 motionTempo）
//   動態  boil 沸騰（8fps 抖線）／sketch 疊線／flow 流動（虛線沿筆順跑）／pulse 呼吸（粗細脈動）
//         （2026-08-23 小高：「飄」用不到，已拿掉）
//
// 存檔：點座標正規化到 frame（0–1），筆寬＝frame 短邊分數——拉框就是等比縮放整張塗鴉。
// **三平台同一份公式**：iOS 端移植時逐條對應這支，不要自己再寫一套。

/** 筆刷鍵＝BRUSHES 的 key（存檔值；未知鍵回落鋼筆，舊檔不炸）。 */
export type BrushKind = string;
export type DoodleWobble = "boil" | "sketch";

export interface DoodleStroke {
  /** 扁平 [x,y,x,y…]，0–1 正規化於 block frame。 */
  pts: number[];
  /** 筆寬＝frame 短邊分數。 */
  w: number;
  /** 無 "#"。 */
  color: string;
  brush?: BrushKind;
  /** 每點筆壓（0.2–1.4 的寬度倍率，與 pts 對齊）。未設＝等寬。iPad 存真實 Pencil 筆壓，滑鼠／手指存速度模擬。 */
  press?: number[];
  /** 軟鉛筆參數快照：畫下當時偏好裡**非預設**的部分（spd 除外——它已烤進 press）。
   *  渲染以這份優先——之後改偏好只影響新筆畫，畫過的不變（不毀掉先前創作），
   *  專案帶著它跨裝置渲染也一致。未設＝吃當下全域偏好（偏好視窗預覽／全預設的筆畫）。 */
  sp?: Partial<SoftPrefs>;
}

export interface DoodleBlock {
  strokes: DoodleStroke[];
  /** 持續動態：travel＝前面生長、後面消失（循環）。未設＝靜止（出場動畫另計）。 */
  play?: "travel";
  /** travel 一圈秒數，預設 DOODLE_TRAVEL_DUR。 */
  travelDur?: number;
  /** travel 尾巴長度（相對全路徑 0.05–1），預設 DOODLE_TAIL。 */
  tail?: number;
  /** 同時：所有筆畫一起生長／一起巡（未設＝照畫的順序一筆接一筆）。 */
  sync?: boolean;
  /** 筆刷感動態（塗鴉動畫）。 */
  wobble?: DoodleWobble;
  /** 抖動幅度（frame 短邊分數），預設 DOODLE_WOBBLE_AMP。 */
  wobbleAmp?: number;
}

export const DOODLE_TRAVEL_DUR = 3;
export const DOODLE_TAIL = 0.35;
export const DOODLE_WOBBLE_AMP = 0.006;
/** 沸騰的拍率（手繪動畫慣例 8–12 fps，太快變成雜訊）。 */
export const DOODLE_BOIL_FPS = 8;
/** 新筆畫預設筆寬（短邊分數）。 */
export const DOODLE_DEFAULT_W = 0.02;
/** 生長出場的預設秒數：跟路徑長走（約 1.2 秒／frame 寬），與文字吃字數同一個道理。 */
export function doodleGrowDur(d: DoodleBlock, frameW: number, frameH: number): number {
  const L = totalLength(d, frameW, frameH);
  const secs = L / Math.max(1, frameW) * 1.2;
  return Math.min(30, Math.max(0.6, Math.round(secs * 10) / 10));
}

/** 固定雜湊 → 0…1（同一個輸入每次一樣，預覽／匯出才一致）。 */
export function hash01(a: number, b: number, c = 0): number {
  let h = (a * 374761393 + b * 668265263 + c * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** 一筆畫在 frame 座標的點列。 */
function strokePoints(s: DoodleStroke, w: number, h: number): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i + 1 < s.pts.length; i += 2) out.push({ x: s.pts[i] * w, y: s.pts[i + 1] * h });
  return out;
}

/** 整張塗鴉的路徑總長（frame 座標）。 */
export function totalLength(d: DoodleBlock, w: number, h: number): number {
  let L = 0;
  for (const s of d.strokes) {
    const p = strokePoints(s, w, h);
    for (let i = 1; i < p.length; i++) L += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y);
    if (p.length === 1) L += 1;   // 點一下也算一格，生長時才會出現
  }
  return L;
}

/**
 * 時間 t 時要畫的區段，以「路徑長度的倍數」表示（0…1＝整條；travel 的頭可超過 1）。
 * - 靜止：[0,1]。reveal（生長）：[0,reveal]。
 * - travel：頭在 head，尾在 head − tail；頭從 0 跑到 1＋tail 再繞回，循環無縫。
 * 呼叫端乘上「整張總長」（順序模式）或「這一筆的長度」（同時模式）。
 */
export function doodleWindow(
  d: DoodleBlock, t: number | undefined, reveal: number | undefined,
): { from: number; to: number } {
  if (reveal !== undefined && reveal < 1) return { from: 0, to: Math.max(0, reveal) };
  if (d.play === "travel" && t !== undefined) {
    const tail = Math.max(0.05, Math.min(1, d.tail ?? DOODLE_TAIL));
    const dur = Math.max(0.3, d.travelDur ?? DOODLE_TRAVEL_DUR);
    const head = ((Math.max(0, t) / dur) % 1) * (1 + tail);
    return { from: head - tail, to: head };
  }
  return { from: 0, to: 1 };
}

/** 筆刷感動態（點位移型）：時間 t、第 k 個點的位移（frame 座標）。未設或非位移型＝0。 */
export function wobbleOffset(
  d: DoodleBlock, t: number | undefined, strokeIdx: number, ptIdx: number, short: number,
): { x: number; y: number } {
  if (!d.wobble || t === undefined) return { x: 0, y: 0 };
  const amp = (d.wobbleAmp ?? DOODLE_WOBBLE_AMP) * short;
  switch (d.wobble) {
    case "boil": {
      // 8fps 步進：每一拍整條線換一組隨機位移——手繪逐格的「線在沸騰」
      const f = Math.floor(Math.max(0, t) * DOODLE_BOIL_FPS);
      return { x: (hash01(strokeIdx, ptIdx, f) - 0.5) * 2 * amp,
               y: (hash01(strokeIdx, ptIdx + 7919, f) - 0.5) * 2 * amp };
    }
    case "sketch": {
      // 疊線：每遍一組固定偏移（由呼叫端傳不同 ptIdx 基底），隨時間慢換遍
      const f = Math.floor(Math.max(0, t) * 4);
      return { x: (hash01(strokeIdx, ptIdx, f) - 0.5) * 2 * amp * 1.2,
               y: (hash01(strokeIdx + 31, ptIdx, f) - 0.5) * 2 * amp * 1.2 };
    }
    default: return { x: 0, y: 0 };
  }
}

// ── 筆刷＝層的配方 ───────────────────────────────────────────────────
// 一種筆刷＝一到多層，每層是「線」或「蓋章」。渲染只有一條路（下面 drawDoodle），
// 新筆刷＝加一條配方，不加程式碼。三平台同一份表。

export interface BrushLayer {
  /** line＝描線；stamp＝蓋章撒點；fill＝外形多邊形一次填滿（perfect-freehand 的招，
   *  半透明也不會有接縫疊深，筆壓寬度絲滑）。 */
  kind: "line" | "stamp" | "fill" | "soft";
  /** 寬度倍率（相對筆寬）。 */
  w: number;
  alpha: number;
  cap?: CanvasLineCap;
  /** 這層的點固定偏移（雙線粗糙感；倍率×筆寬）。 */
  jitter?: number;
  /** 逐段亂透明度（0–1 強度）。 */
  grain?: number;
  /** 逐段亂寬（0–1 強度）。 */
  grainW?: number;
  /** 兩端收細（大：4 筆寬、壓到 15%——墨筆的尖）。 */
  taper?: boolean;
  /** 小筆尖（fill 用）：頭尾 n 個筆寬內收到 50%——鋼筆的起收筆感。 */
  tip?: number;
  /** 平頭筆尖角度（度）：寬度隨筆畫方向變化。 */
  nib?: number;
  /** 虛線 [實, 空]（倍率×筆寬）。 */
  dash?: [number, number];
  /** 沿筆畫的正弦波：[振幅倍率, 每筆寬幾個週期]。 */
  wave?: [number, number];
  /** 垂直位移（倍率×筆寬）：雙線用。 */
  offset?: number;
  /** 顏色變化：darker／lighter／white／rainbow。 */
  color?: "darker" | "lighter" | "white" | "rainbow";
  /** 蓋章：每筆寬距離蓋幾次、每次幾顆、顆半徑倍率、散布半徑倍率（相對筆寬）、透明度範圍。 */
  stamp?: { perWidth: number; count: number; r: number; spread: number; aMin: number; aMax: number };
  /** 這層用固定種子（不同層不同雜湊）。 */
  seed?: number;
}

export const BRUSHES: Record<string, { name: string; layers: BrushLayer[] }> = {
  pen:    { name: "鋼筆",   layers: [{ kind: "fill", w: 1, alpha: 1, tip: 1.5 }] },
  marker: { name: "麥克筆", layers: [{ kind: "fill", w: 1.6, alpha: 0.55, cap: "butt" }] },
  pencil: { name: "鉛筆",   layers: [
    { kind: "stamp", w: 0.9, alpha: 1, stamp: { perWidth: 10, count: 12, r: 0.075, spread: 0.34, aMin: 0.12, aMax: 0.7 }, seed: 1 },
    { kind: "line", w: 0.22, alpha: 0.55, grain: 0.8, jitter: 0.35, seed: 2 },
  ] },
  chalk:  { name: "粉筆",   layers: [
    { kind: "stamp", w: 1.4, alpha: 1, stamp: { perWidth: 8, count: 16, r: 0.12, spread: 0.5, aMin: 0.2, aMax: 0.75 }, seed: 5 },
  ] },
  ink:    { name: "墨筆",   layers: [
    { kind: "fill", w: 1.1, alpha: 1, taper: true, grainW: 0.35 },
    { kind: "stamp", w: 1, alpha: 1, stamp: { perWidth: 1.5, count: 1, r: 0.12, spread: 0.9, aMin: 0.2, aMax: 0.6 }, seed: 8 },
  ] },
  // 軟鉛筆（2026-08-26 落地＝樣本間第 7 格「軟邊鉛筆」，小高 8/25 定案參數）。
  // 專屬渲染路 kind "soft"（見 drawSoft）：筆身線性長、顆粒毛邊次線性（絕對尺度）、
  // 高斯軟點、紙紋紋理化（鎖 block 座標）。規格＝01 - 研究/樣本間/筆刷/ALIGNED筆刷落地規格.md。
  soft:   { name: "軟鉛筆", layers: [{ kind: "soft", w: 1, alpha: 1 }] },
};
// 2026-08-23 小高定案只留這五種（22 種總覽看過後：「剩下不要太多了」）。
// 其他配方（炭筆／蠟筆／毛筆／平頭筆／霓虹／噴漆／彩虹…）在 git 歷史，要回來就加一條。

/** 筆刷清單順序（面板用）。 */
export const BRUSH_ORDER = Object.keys(BRUSHES);

export function brushLayers(b: string | undefined): BrushLayer[] {
  return (BRUSHES[b ?? "pen"] ?? BRUSHES.pen).layers;
}

/** 顏色變化：hex（無 #）→ CSS 色。 */
export function layerColor(hex: string, mod: BrushLayer["color"], hue01 = 0): string {
  if (!mod) return `#${hex}`;
  if (mod === "white") return "#FFFFFF";
  if (mod === "rainbow") return `hsl(${Math.round(hue01 * 360)} 85% 55%)`;
  const n = (i: number) => parseInt(hex.slice(i, i + 2), 16);
  const k = mod === "darker" ? 0.55 : 1.45;
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * k)));
  return `rgb(${c(n(0))},${c(n(2))},${c(n(4))})`;
}

/** 一條可見折線（已裁到視窗、已加位移），每點帶「在整筆中的弧長位置 0–1」與弧長。 */
interface Piece { pts: { x: number; y: number; u: number; a: number; wm: number }[] }

/**
 * 把一張塗鴉畫到 ctx（block 本地座標 0,0–w,h）。
 * `t`＝時間（travel／wobble 用）、`reveal`＝出場生長比例；都不給＝靜態全畫。
 * 渲染只有這一條路——編輯畫布、匯出、縮圖全部走這裡。
 */
export function drawDoodle(
  ctx: CanvasRenderingContext2D, d: DoodleBlock, w: number, h: number,
  t?: number, reveal?: number,
): void {
  const short = Math.min(w, h);
  const total = totalLength(d, w, h);
  if (total <= 0) return;
  const nw = doodleWindow(d, t, reveal);
  if (nw.to <= nw.from) return;

  ctx.save();
  ctx.lineJoin = "round";
  let acc = 0;   // 走到目前為止的弧長（順序模式用）
  d.strokes.forEach((s, si) => {
    const raw = strokePoints(s, w, h);
    if (!raw.length) return;
    const layers = brushLayers(s.brush);
    const lw0 = Math.max(0.5, s.w * short);
    const sLen = raw.length === 1 ? 1 : strokeLen(raw);
    // 同時＝每一筆各自從自己的 0 走到自己的長度；順序＝整張一條弧長接著走
    const base = d.sync ? 0 : acc;
    const span = d.sync ? sLen : total;
    const win = { from: nw.from * span, to: nw.to * span };
    layers.forEach((L, li) => {
      const seed = (L.seed ?? 0) * 1000 + li * 97;
      const lw = Math.max(0.3, lw0 * L.w);
      ctx.lineCap = L.cap ?? "round";
      ctx.lineWidth = lw;
      ctx.setLineDash(L.dash ? [Math.max(0.001, L.dash[0] * lw), L.dash[1] * lw] : []);
      ctx.strokeStyle = layerColor(s.color, L.color);
      ctx.fillStyle = ctx.strokeStyle;
      // 單點（點一下）＝一顆圓點
      if (raw.length === 1) {
        const o = wobbleOffset(d, t, si, 0, short);
        if (base < win.to && base + 1 > win.from && L.kind !== "stamp") {
          ctx.globalAlpha = L.alpha;
          ctx.beginPath();
          ctx.arc(raw[0].x + o.x, raw[0].y + o.y, lw / 2, 0, Math.PI * 2);
          ctx.fill();
        }
        return;
      }
      const jit = (i: number): { x: number; y: number } => !L.jitter ? { x: 0, y: 0 }
        : { x: (hash01(si, i, 700 + seed) - 0.5) * lw0 * L.jitter, y: (hash01(si + 13, i, 700 + seed) - 0.5) * lw0 * L.jitter };
      const off = (i: number): { x: number; y: number } => {
        const wo = wobbleOffset(d, t, si, i + seed, short), j = jit(i);
        return { x: wo.x + j.x, y: wo.y + j.y };
      };
      // 收集視窗內的折線段（wm＝筆壓寬度倍率，沿段內插）
      const pr = s.press;
      const prAt = (i: number): number => (pr && pr.length === raw.length ? pr[i] : 1);
      const pieces: Piece[] = [];
      let a = base, cur: Piece | null = null;
      let prev = raw[0], prevO = off(0);
      for (let i = 1; i < raw.length; i++) {
        const nx = raw[i];
        const seg = Math.hypot(nx.x - prev.x, nx.y - prev.y);
        const curO = off(i);
        const a0 = a, a1 = a + seg;
        if (a1 > win.from && a0 < win.to && seg > 0) {
          const u0 = Math.max(0, (win.from - a0) / seg), u1 = Math.min(1, (win.to - a0) / seg);
          const ex = nx.x - prev.x + curO.x - prevO.x, ey = nx.y - prev.y + curO.y - prevO.y;
          const s0 = a0 - base + seg * u0, s1 = a0 - base + seg * u1;
          const w0 = prAt(i - 1), w1 = prAt(i);
          const p0 = { x: prev.x + prevO.x + ex * u0, y: prev.y + prevO.y + ey * u0, u: s0 / sLen, a: s0, wm: w0 + (w1 - w0) * u0 };
          const p1 = { x: prev.x + prevO.x + ex * u1, y: prev.y + prevO.y + ey * u1, u: s1 / sLen, a: s1, wm: w0 + (w1 - w0) * u1 };
          if (!cur || u0 > 0) { cur = { pts: [p0] }; pieces.push(cur); }
          cur.pts.push(p1);
        } else if (cur && a0 >= win.to) {
          cur = null;
        }
        a = a1; prev = nx; prevO = curO;
      }
      // 波浪／雙線：沿法線位移每個點
      if (L.wave || L.offset) {
        for (const pc of pieces) {
          const src = pc.pts.map((p) => ({ ...p }));
          for (let i = 0; i < src.length; i++) {
            const q0 = src[Math.max(0, i - 1)], q1 = src[Math.min(src.length - 1, i + 1)];
            const dx = q1.x - q0.x, dy = q1.y - q0.y, n = Math.hypot(dx, dy) || 1;
            const nxv = -dy / n, nyv = dx / n;
            let dist = (L.offset ?? 0) * lw0;
            if (L.wave) dist += Math.sin((src[i].a / lw0) * L.wave[1] * Math.PI * 2) * L.wave[0] * lw0;
            pc.pts[i].x = src[i].x + nxv * dist; pc.pts[i].y = src[i].y + nyv * dist;
          }
        }
      }
      if (L.kind === "soft") {
        drawSoft(ctx, pieces, { si, seed, lw0, lw, sLen, color: s.color, sp: s.sp });
        return;
      }
      if (L.kind === "fill") {
        // 外形多邊形（perfect-freehand 的招）：沿中心線兩側依「半徑=筆寬/2×筆壓×收細」撒
        // 左右緣點，圍成一圈一次填滿——半透明不疊深、寬度絲滑。帽＝旋轉取樣的半圓（兩平台同式）。
        ctx.globalAlpha = L.alpha;
        const flat = L.cap === "butt";
        const zone = Math.min(lw0 * 4, sLen * 0.45);
        for (const pc of pieces) {
          // 依筆寬重取樣：外形點距 ≥ 0.35 筆寬——法線才穩。點太密時半徑大於轉彎半徑，
          // 左右緣會自己打摺，畫圓圈／8 字會出現鋸齒與直角（2026-08-24 鋼筆最粗＋墨筆回饋）
          const spacing = Math.max(2, lw * 0.35);
          const src = pc.pts;
          let pts = src;
          if (src.length > 2) {
            pts = [src[0]];
            for (let i = 1; i < src.length - 1; i++) {
              const l = pts[pts.length - 1];
              if (Math.hypot(src[i].x - l.x, src[i].y - l.y) >= spacing) pts.push(src[i]);
            }
            pts.push(src[src.length - 1]);
          }
          if (pts.length < 2) {
            if (pts.length === 1) { ctx.beginPath(); ctx.arc(pts[0].x, pts[0].y, Math.max(0.15, lw * pts[0].wm / 2), 0, Math.PI * 2); ctx.fill(); }
            continue;
          }
          const rs = pts.map((pt, i) => {
            let wmul = pt.wm;
            const dEnd = Math.min(pt.a, sLen - pt.a);
            if (L.taper) wmul *= 0.15 + 0.85 * Math.min(1, zone <= 0 ? 1 : dEnd / zone);
            if (L.tip) {
              const tz = lw0 * L.tip;
              wmul *= 0.5 + 0.5 * Math.min(1, tz <= 0 ? 1 : dEnd / tz);
            }
            if (L.grainW) wmul *= 1 - L.grainW / 2 + L.grainW * hash01(si + 7, i, seed);
            return Math.max(0.15, (lw * wmul) / 2);
          });
          const nx: number[] = [], ny: number[] = [];
          for (let i = 0; i < pts.length; i++) {
            const q0 = pts[Math.max(0, i - 1)], q1 = pts[Math.min(pts.length - 1, i + 1)];
            const dx = q1.x - q0.x, dy = q1.y - q0.y, len = Math.hypot(dx, dy) || 1;
            nx.push(-dy / len); ny.push(dx / len);
          }
          ctx.beginPath();
          // 左緣去程
          ctx.moveTo(pts[0].x + nx[0] * rs[0], pts[0].y + ny[0] * rs[0]);
          for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x + nx[i] * rs[i], pts[i].y + ny[i] * rs[i]);
          // 尾帽：左緣向量繞 -π 轉到右緣（經過前進方向）
          const e = pts.length - 1;
          if (!flat) {
            for (let k2 = 1; k2 <= 8; k2++) {
              const th = (-Math.PI * k2) / 8, c = Math.cos(th), sn = Math.sin(th);
              const vx = nx[e] * rs[e], vy = ny[e] * rs[e];
              ctx.lineTo(pts[e].x + vx * c - vy * sn, pts[e].y + vx * sn + vy * c);
            }
          } else {
            ctx.lineTo(pts[e].x - nx[e] * rs[e], pts[e].y - ny[e] * rs[e]);
          }
          // 右緣回程
          for (let i = pts.length - 2; i >= 0; i--) ctx.lineTo(pts[i].x - nx[i] * rs[i], pts[i].y - ny[i] * rs[i]);
          // 頭帽：右緣向量繞 -π 轉回左緣（經過反方向）
          if (!flat) {
            for (let k2 = 1; k2 < 8; k2++) {
              const th = (-Math.PI * k2) / 8, c = Math.cos(th), sn = Math.sin(th);
              const vx = -nx[0] * rs[0], vy = -ny[0] * rs[0];
              ctx.lineTo(pts[0].x + vx * c - vy * sn, pts[0].y + vx * sn + vy * c);
            }
          }
          ctx.closePath();
          ctx.fill();
        }
        return;
      }
      if (L.kind === "stamp" && L.stamp) {
        // 蓋章：沿路徑等距撒點（鉛筆／炭筆／粉筆／噴漆的顆粒）
        const st = L.stamp;
        const step = lw0 / st.perWidth;
        for (const pc of pieces) {
          for (let i = 1; i < pc.pts.length; i++) {
            const p = pc.pts[i - 1], q = pc.pts[i];
            const seg = q.a - p.a;
            if (seg <= 0) continue;
            const dx = (q.x - p.x) / seg, dy = (q.y - p.y) / seg;
            // 從整筆弧長的固定格點取樣，片段切換不會讓點跳動
            let k = Math.ceil(p.a / step);
            for (let pos = k * step; pos < q.a; pos += step, k++) {
              const cx = p.x + dx * (pos - p.a), cy = p.y + dy * (pos - p.a);
              const wm = p.wm + (q.wm - p.wm) * ((pos - p.a) / seg);
              for (let j = 0; j < st.count; j++) {
                const r1 = hash01(si, k * 31 + j, seed), r2 = hash01(si + 5, k * 31 + j, seed), r3 = hash01(si + 9, k * 31 + j, seed);
                // 中心密、邊緣疏（兩個均勻相加≈三角分布）
                const rad = (r1 + r2 - 1) * st.spread * lw0 * wm;
                const ang = r3 * Math.PI * 2;
                ctx.globalAlpha = L.alpha * (st.aMin + (st.aMax - st.aMin) * hash01(si + 3, k * 31 + j, seed)) * Math.min(1, wm + 0.25);
                ctx.beginPath();
                ctx.arc(cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad, Math.max(0.25, st.r * lw0 * (0.6 + 0.8 * r2) * wm), 0, Math.PI * 2);
                ctx.fill();
              }
            }
          }
        }
        return;
      }
      ctx.globalAlpha = L.alpha;
      const nibRad = L.nib !== undefined ? (L.nib * Math.PI) / 180 : undefined;
      const segmented = !!(L.grain || L.grainW || L.taper || nibRad !== undefined || L.color === "rainbow" || pr);
      for (const pc of pieces) {
        if (segmented) {
          for (let i = 1; i < pc.pts.length; i++) {
            const p = pc.pts[i - 1], q = pc.pts[i];
            let wmul = (p.wm + q.wm) / 2;
            if (L.taper) {
              // 收細帶＝**絕對長度**（4 個筆寬，短筆畫再壓到 45%）——用整筆比例的話，
              // 邊寫邊畫時起筆的尖會隨筆畫變長一直改（2026-08-24 墨筆回饋）
              const mid = (p.a + q.a) / 2;
              const zone = Math.min(lw0 * 4, sLen * 0.45);
              const dEnd = Math.min(mid, sLen - mid);
              wmul *= 0.15 + 0.85 * Math.min(1, zone <= 0 ? 1 : dEnd / zone);
            }
            if (nibRad !== undefined) {
              const ang = Math.atan2(q.y - p.y, q.x - p.x);
              wmul *= 0.12 + 0.88 * Math.abs(Math.sin(ang - nibRad));
            }
            if (L.grainW) wmul *= 1 - L.grainW / 2 + L.grainW * hash01(si + 7, i, seed);
            ctx.lineWidth = Math.max(0.3, lw * wmul);
            ctx.globalAlpha = L.alpha * (L.grain ? (1 - L.grain) + L.grain * hash01(si, i, 4242 + seed) : 1);
            if (L.color === "rainbow") ctx.strokeStyle = layerColor(s.color, "rainbow", ((p.u + q.u) / 2 + si * 0.13) % 1);
            ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
          }
        } else {
          ctx.beginPath();
          ctx.moveTo(pc.pts[0].x, pc.pts[0].y);
          for (let i = 1; i < pc.pts.length; i++) ctx.lineTo(pc.pts[i].x, pc.pts[i].y);
          ctx.stroke();
        }
      }
    });
    acc += sLen;
  });
  ctx.restore();
}

// ── 軟鉛筆（kind "soft"）────────────────────────────────────────────
// 樣本間「7. 軟邊鉛筆」的落地版（01 - 研究/樣本間/筆刷/，小高 2026-08-25 定案參數）。
// 走同一條 pieces 管線＝生長／移動／沸騰／筆壓全部自動相容；所有亂數走 hash01
// （決定性，動畫每格重算不閃）。
//
// 與樣本的兩個刻意差異（理由都在 ALIGNED筆刷落地規格.md 的雷區章）：
//   1. **黏性不走 ctx.filter 模糊**——WKWebView 的 canvas filter 屬性在、功能不在
//      （去背編輯間 8/25 實錘）。改把「霧感」烤進軟點筆尖的高斯剖面（下方 softTip），
//      點與點交疊時 alpha 自然融合，視覺近似模糊後再疊濃。
//   2. 「紋理化（鎖畫布）」的畫布＝**block 座標**：塗鴉這張「紙」本來就是 block，
//      搬動 block 紙紋跟著走，比鎖專案畫布更合理，而且離線渲染也決定性。

/** 軟鉛筆的可調參數（偏好設定視窗，2026-08-26）。預設值＝8/25 定案的那組——
 *  全預設時渲染與參數化前**逐位元一致**（selftest 靠這個守）。
 *  P1 存 localStorage（跟使用者／裝置走）；紙張與紋路搬進專案檔是 P3 檔案欄位定稿的事。 */
export interface SoftPrefs {
  /** 速度影響（無筆壓時）：1＝現況（速度模擬原汁），0＝等寬。捕捉端用（editor）。 */
  spd: number;
  /** 基礎黑度（softResp 的增益）。定案 1.5。 */
  gain: number;
  /** 收筆長度倍率。定案 1。 */
  tip: number;
  /** 紙張：0 細紋（定案）／1 粗紋・水彩紙／2 織紋・帆布／3 纖維・和紙／4 平滑・影印紙／5 無紋。 */
  paper: number;
  /** 紋路行為：1 紋理化・鎖畫布（定案）／0 移動・跟著筆跑。 */
  gmode: number;
  /** 紋路強度。定案 0.8。 */
  tooth: number;
  /** 紋路比例。定案 0.35。 */
  gscale: number;
  /** 紋路粗細（px 尺度）。定案 8。 */
  ts: number;
  /** 紋路拉伸：>1 橫向拉長。定案 1。 */
  aspect: number;
  /** 黏性（霧感與疊濃的替身——WKWebView 沒有可用的 canvas 模糊）。定案 0.92。 */
  goo: number;
  /** 散布成長（次線性指數）。定案 0.55。 */
  scExp: number;
  /** 散布（毛邊振幅倍率）。定案 1。 */
  scatter: number;
  /** 顆粒（跳點比率倍率）。定案 1。 */
  grain: number;
}
// 預設＝2026-08-26 小高實機定案（「蠻好的，可以包 Beta」那組）：和紙、細粒 0.45、黑度 240%。
// ⚠️ 已隨 Beta 發版＝這組**凍結**——sp 快照只存「非預設」，改預設會回頭動到省略欄位的舊筆畫。
export const SOFT_DEFAULTS: SoftPrefs = {
  spd: 0.5, gain: 2.4, tip: 1.4, paper: 3, gmode: 1, tooth: 0.75, gscale: 1.45,
  ts: 0.45, aspect: 1, goo: 0.54, scExp: 0.3, scatter: 1, grain: 1,
};
let softPrefs: SoftPrefs = { ...SOFT_DEFAULTS };
export function setSoftPrefs(p: Partial<SoftPrefs>): void { softPrefs = { ...SOFT_DEFAULTS, ...p }; }
export function getSoftPrefs(): SoftPrefs { return { ...softPrefs }; }
/** 目前偏好裡非預設的部分（spd 除外）。空＝undefined——全預設時檔案一個位元組都不多。 */
export function softSnapshot(): Partial<SoftPrefs> | undefined {
  const out: Partial<SoftPrefs> = {};
  for (const k of Object.keys(SOFT_DEFAULTS) as (keyof SoftPrefs)[]) {
    if (k !== "spd" && softPrefs[k] !== SOFT_DEFAULTS[k]) out[k] = softPrefs[k];
  }
  return Object.keys(out).length ? out : undefined;
}

/** 值雜訊（樣本間同款 h2/vn/vnr，決定性）。 */
function vnh(x: number, y: number): number {
  let h = (Math.floor(x) * 374761393 + Math.floor(y) * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function vn2(x: number, y: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = vnh(xi, yi), b = vnh(xi + 1, yi), c = vnh(xi, yi + 1), dd = vnh(xi + 1, yi + 1);
  const p = a + (b - a) * u, q = c + (dd - c) * u;
  return p + (q - p) * v;
}
function vnr2(x: number, y: number, sc: number, ang: number, ox: number, oy: number): number {
  const c = Math.cos(ang), n = Math.sin(ang);
  return vn2((x * c - y * n) / sc + ox, (x * n + y * c) / sc + oy);
}
const cl01 = (v: number): number => Math.max(0, Math.min(1, v));
/** 紙紋：低頻扭曲＋各紙種配方（樣本間同款）。s＝紋路尺度（px）；paper／aspect 見 SoftPrefs。 */
function tooth(x: number, y: number, sc: number, paper = 0, aspect = 1): number {
  if (paper === 5) return 1;                                  // 無紋＝乾淨
  if (aspect !== 1) { x /= aspect; y *= aspect; }             // 面積不變，只改長寬比
  const wx = vn2(x / (sc * 7) + 3.1, y / (sc * 7) + 8.7) - 0.5;
  const wy = vn2(x / (sc * 7) + 19.3, y / (sc * 7) + 5.2) - 0.5;
  const X = x + wx * sc * 2.6, Y = y + wy * sc * 2.6;
  switch (paper) {
    case 1: {   // 粗紋（水彩紙）：尺度大、對比強、塊狀
      const v = 0.55 * vnr2(X, Y, sc * 1.9, 0.37, 4.3, 9.1) + 0.30 * vnr2(X, Y, sc * 0.8, 1.71, 31.7, 11.3)
              + 0.15 * vnr2(X, Y, sc * 0.3, 2.62, 57.2, 23.9);
      return cl01((v - 0.5) * 1.55 + 0.5);
    }
    case 2: {   // 織紋（帆布）：經緯交織——這種紋路本來就有規律
      const a = 0.5 + 0.5 * Math.sin((X / (sc * 1.15)) * 6.2832);
      const b = 0.5 + 0.5 * Math.sin((Y / (sc * 1.15)) * 6.2832);
      return cl01(Math.min(a, b) * 0.58 + vnr2(X, Y, sc * 0.5, 0.9, 12.1, 7.7) * 0.42);
    }
    case 3: {   // 纖維（和紙）：長條、有方向性
      const v = 0.55 * vn2(X / (sc * 4.2) + 2.2, Y / (sc * 0.42) + 6.1)
              + 0.30 * vn2(X / (sc * 1.6) + 9.4, Y / (sc * 0.28) + 3.3)
              + 0.15 * vnr2(X, Y, sc * 0.5, 1.2, 21, 4);
      return cl01((v - 0.5) * 1.30 + 0.5);
    }
    case 4: {   // 平滑（影印紙）：很細、對比低
      const v = 0.6 * vnr2(X, Y, sc * 0.45, 0.37, 4.3, 9.1) + 0.4 * vnr2(X, Y, sc * 0.2, 1.71, 31.7, 11.3);
      return cl01((v - 0.5) * 0.62 + 0.5);
    }
    default:    // 0 細紋（定案）
      return 0.50 * vnr2(X, Y, sc, 0.37, 4.3, 9.1)
           + 0.32 * vnr2(X, Y, sc * 0.44, 1.71, 31.7, 11.3)
           + 0.18 * vnr2(X, Y, sc * 0.19, 2.62, 57.2, 23.9);
  }
}

/** 力道→黑度校正表（樣本間探針量出來的響應反函數：施力 50% ≈ 看到 50% 黑）。 */
const SOFT_RESP = [0, 0.1205, 0.2453, 0.3599, 0.4148, 0.4584, 0.4901, 0.5215, 0.5527, 0.5808,
  0.6094, 0.6371, 0.6614, 0.6845, 0.7055, 0.7254, 0.757, 0.8075, 0.8695, 0.9346, 1];
function softResp(u: number, gain = 1.5): number {
  let x = Math.max(0, Math.min(1, u)) * gain;   // 基礎黑度（定案 1.5）
  const K = 0.80;
  if (x > K) x = K + (1 - K) * Math.tanh((x - K) / (1 - K));
  x = Math.max(0, Math.min(1, x));
  const t = x * (SOFT_RESP.length - 1), i = Math.floor(t), f = t - i;
  return SOFT_RESP[i] + (SOFT_RESP[Math.min(SOFT_RESP.length - 1, i + 1)] - SOFT_RESP[i]) * f;
}

// ── 軟鉛筆的合成管線（2026-08-26 修正版；小高驗收「模糊不見了、紋理化沒顯現」後照移交診斷重做）──
// 樣本 drawSoftStroke 的四步全搬：白 dab 疊遮罩（lighter）→ 黏性（模糊＋boost 疊濃）
// → 紙紋 destination-in 鏤空 → source-in 一次上色 → 以 strokeA≈0.96 合成回畫布。
// 模糊不用 ctx.filter（WKWebView 有屬性沒功能）——用樣本 gooey() 本來就備著的退路：
// 5 個小位移各 alpha .3 疊出近似高斯，WKWebView 走得通（移交診斷已驗，別再繞開整條管線）。

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
function mkCanvas(w: number, h: number): AnyCanvas | null {
  if (typeof document !== "undefined") {
    const c = document.createElement("canvas"); c.width = w; c.height = h; return c;
  }
  return typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h) : null;
}
function growCv(c: AnyCanvas, w: number, h: number): void {
  if (c.width < w) c.width = w;
  if (c.height < h) c.height = h;
}

/** 白色軟點筆尖：高斯剖面＋fbm 斑（樣本 bakeSoft 同款）。純白單張——顏色最後 source-in。 */
const SOFT_PX = 40;
let softTipCv: AnyCanvas | null = null;
function softTipWhite(): AnyCanvas | null {
  if (softTipCv) return softTipCv;
  const c = mkCanvas(SOFT_PX, SOFT_PX);
  const g = c?.getContext("2d") as CanvasRenderingContext2D | null;
  if (!c || !g) return null;
  const im = g.createImageData(SOFT_PX, SOFT_PX), D = im.data, h = SOFT_PX / 2;
  const fbm = (x: number, y: number): number =>
    0.62 * vn2(x, y) + 0.38 * vn2(x * 2.3 + 5.1, y * 2.3 + 9.7);
  for (let y = 0; y < SOFT_PX; y++) for (let x = 0; x < SOFT_PX; x++) {
    const dx = (x - h + 0.5) / h, dy = (y - h + 0.5) / h, r = Math.hypot(dx, dy);
    let a = r >= 1 ? 0 : Math.exp(-2.6 * r * r) - Math.exp(-2.6);   // 高斯：中心實、外緣自己淡掉
    a *= 0.55 + 0.60 * fbm(x / 3.4, y / 3.4);
    const i = (y * SOFT_PX + x) * 4;
    D[i] = D[i + 1] = D[i + 2] = 255;
    D[i + 3] = Math.round(Math.max(0, Math.min(1, a)) * 255);
  }
  g.putImageData(im, 0, 0);
  softTipCv = c;
  return c;
}

/** ctx.filter 的模糊到底能不能用——WKWebView 屬性在、功能不在（去背編輯間 8/25 實錘），
 *  用「畫一點糊糊看」特徵測試一次定生死。能用＝跟樣本像素級同款；不能用才走縮放鏈退路。 */
let filterOK: boolean | null = null;
function filterWorks(): boolean {
  if (filterOK !== null) return filterOK;
  // dev：?nofilter 強制走縮放鏈退路——WKWebView 沒真模糊時長怎樣，Chrome 裡就看得到
  if (typeof location !== "undefined" && location.search.indexOf("nofilter") >= 0) { filterOK = false; return false; }
  const c = mkCanvas(8, 8);
  const g = c?.getContext("2d") as CanvasRenderingContext2D | null;
  if (!g || !("filter" in g)) { filterOK = false; return false; }
  g.filter = "blur(2px)"; g.fillStyle = "#fff"; g.fillRect(3, 3, 2, 2); g.filter = "none";
  filterOK = g.getImageData(1, 4, 1, 1).data[3] > 0;   // 有暈開＝真的在模糊
  return filterOK;
}

// 遮罩／黏性暫存（逐筆重用、只長不縮；用到的區域每筆先清）
let maskCv: AnyCanvas | null = null, gooCv: AnyCanvas | null = null;

/** 紋理化的紙紋快取：鎖 block 座標的純函式烤一張，key＝參數組＋尺度。
 *  覆蓋 [-PAD, need]²、進位 256 只長不縮——活筆畫畫中 frame 一直長，讓重烤偶發。
 *  面積太大烤半解析度（紙紋軟一點可接受）。 */
const GRAIN_PAD = 160;   // 要蓋過最大筆寬的外接框邊距（lw 200 時 pad≈140）
let grainCv: AnyCanvas | null = null;
let grainKey = "";
let grainW = 0, grainH = 0;
let grainScale = 1;      // 畫布 px／block 單位（半解析度時＝scale/2）
function grainFor(maxX: number, maxY: number, scale: number,
                  gstr: number, gs: number, paper: number, aspect: number): AnyCanvas | null {
  const needW = Math.ceil(((maxX + GRAIN_PAD) * scale) / 256) * 256;
  const needH = Math.ceil(((maxY + GRAIN_PAD) * scale) / 256) * 256;
  const key = `${paper}|${aspect.toFixed(2)}|${gstr.toFixed(2)}|${gs.toFixed(2)}|${scale.toFixed(2)}`;
  if (grainCv && key === grainKey && needW <= grainW && needH <= grainH) return grainCv;
  grainW = Math.max(grainW, needW); grainH = Math.max(grainH, needH); grainKey = key;
  // 粗紋照樣本 1× 烤完拉伸＝自帶柔化，顆粒不會利成纖維；
  // 細紋（gs<2，8/26 起預設就是）必須裝置解析度烤——1× 烤會被內插整個抹掉。
  grainScale = gs < 2 ? scale : Math.min(1, scale);
  if (grainW * grainH * (grainScale / scale) * (grainScale / scale) > 4e6) grainScale /= 2;
  const cw = Math.ceil((grainW * grainScale) / scale), ch = Math.ceil((grainH * grainScale) / scale);
  if (!grainCv) grainCv = mkCanvas(cw, ch);
  else growCv(grainCv, cw, ch);
  const g = grainCv?.getContext("2d") as CanvasRenderingContext2D | null;
  if (!grainCv || !g) return null;
  const im = g.createImageData(cw, ch), D = im.data;
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const t = tooth(x / grainScale - GRAIN_PAD, y / grainScale - GRAIN_PAD, gs, paper, aspect);
    const a = t < gstr * 0.30 ? 0
      : Math.max(0, Math.min(1, (1 - gstr) + gstr * Math.min(1, 0.28 + 1.3 * t)));
    const i = (y * cw + x) * 4;
    D[i] = D[i + 1] = D[i + 2] = 255;
    D[i + 3] = Math.round(a * 255);
  }
  g.putImageData(im, 0, 0);
  return grainCv;
}

/** 軟鉛筆 dab 用的強雪崩雜湊。原本沿用 hash01（兩輪混合）——它相鄰索引高度相關，
 *  dab 的散布會結成一團一團的捲雲紋（樣本間 2026-08-25「規律橫紋」同一顆雷；
 *  mock 不踩是因為它用 mulberry 序列）。這裡照樣本 h2 的四輪混合，逐點決定性不變。 */
function hashS(a: number, b: number, c: number): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1);
  h ^= h >>> 15; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16; return (h >>> 0) / 4294967296;
}

/** 軟鉛筆本體。座標都在 block 本地 px；參數＝SOFT_DEFAULTS（8/25 定案）疊筆畫快照／偏好。 */
function drawSoft(
  ctx: CanvasRenderingContext2D,
  pieces: Piece[],
  o: { si: number; seed: number; lw0: number; lw: number; sLen: number; color: string; sp?: Partial<SoftPrefs> },
): void {
  const tip = softTipWhite();
  if (!tip) return;
  const P: SoftPrefs = o.sp ? { ...SOFT_DEFAULTS, ...o.sp } : softPrefs;   // 筆畫自帶快照優先
  const REF = 10;
  const wpx = Math.max(1, o.lw);
  const gr = Math.pow(wpx / REF, P.scExp);                          // 散布成長（定案 0.55）
  const dotR = Math.max(0.32, 0.085 * REF * Math.pow(wpx / REF, 0.35));   // 樣本原值（不再 ×1.8）
  const fuzz = 0.30 * REF * gr * P.scatter;                         // 毛邊振幅（絕對尺度）
  const step = Math.max(0.42, dotR * 0.9);                          // 樣本原值
  const N = Math.max(1, Math.min(46, Math.round(0.45 * wpx / dotR)));     // 樣本原值
  const nrm = Math.pow(REF / wpx, 0.22);
  const dabA = 0.80;         // 樣本原值（縮放模糊保留 alpha 總量，不需要 5 位移版的 ×1.2 補償）
  const grainP = Math.min(1, 0.92 * P.grain);
  const gstr = 0.85 * P.tooth;
  const gs = Math.max(0.12, P.ts * P.gscale);   // 8/26 粗細往下開到 0.1，舊 0.6 下限會夾死
  const blur = dotR * 2.6 * P.goo;                                  // 黏性＝模糊半徑（樣本同式）
  const boost = 1 + Math.round(3 * P.goo);                          // 疊濃次數（樣本同式）
  const tipLen = Math.max(1.5, Math.min(o.sLen * 0.35, 1.6 * P.tip * REF * Math.pow(wpx / REF, 0.5)));
  const sd = o.seed + o.si * 7919;
  const MOVE = P.gmode === 0;

  // 外接框（block 座標）：毛邊、點徑、模糊全要蓋到
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const pc of pieces) for (const pt of pc.pts) {
    if (pt.x < x0) x0 = pt.x; if (pt.y < y0) y0 = pt.y;
    if (pt.x > x1) x1 = pt.x; if (pt.y > y1) y1 = pt.y;
  }
  if (x0 > x1) return;
  const pad = wpx / 2 + fuzz + dotR * 2 + blur * 2 + 8;
  x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
  const bw = x1 - x0, bh = y1 - y0;

  // 尺度＝ctx 目前的縮放（編輯器 zoom／匯出 DPR）——遮罩照它開，放大看才不糊（上限 3 防爆記憶體）
  const mtr = ctx.getTransform();
  const scale = Math.min(3, Math.max(0.1, Math.hypot(mtr.a, mtr.b)));
  const dw = Math.ceil(bw * scale), dh = Math.ceil(bh * scale);
  if (dw <= 0 || dh <= 0) return;
  if (!maskCv) maskCv = mkCanvas(dw, dh); else growCv(maskCv, dw, dh);
  if (!gooCv) gooCv = mkCanvas(dw, dh); else growCv(gooCv, dw, dh);
  const m = maskCv?.getContext("2d") as CanvasRenderingContext2D | null;
  const g2 = gooCv?.getContext("2d") as CanvasRenderingContext2D | null;
  if (!maskCv || !gooCv || !m || !g2) return;

  // ── 1. dab 疊遮罩（lighter＝同一筆內不互相加深）──
  m.setTransform(1, 0, 0, 1, 0, 0);
  m.globalCompositeOperation = "source-over";
  m.globalAlpha = 1;
  m.clearRect(0, 0, maskCv.width, maskCv.height);
  m.setTransform(scale, 0, 0, scale, -x0 * scale, -y0 * scale);
  m.globalCompositeOperation = "lighter";
  for (const pc of pieces) {
    for (let i = 1; i < pc.pts.length; i++) {
      const p = pc.pts[i - 1], q = pc.pts[i];
      const seg = q.a - p.a;
      if (seg <= 0) continue;
      const ux = (q.x - p.x) / seg, uy = (q.y - p.y) / seg;
      let k = Math.ceil(p.a / step);
      for (let pos = k * step; pos < q.a; pos += step, k++) {
        const t = (pos - p.a) / seg;
        const cx = p.x + ux * (pos - p.a), cy = p.y + uy * (pos - p.a);
        const wm = p.wm + (q.wm - p.wm) * t;
        // 收筆（絕對長度；尾端收得比頭端兇——真鉛筆離紙是拖出去的）
        const dS = pos, dE = Math.max(0, o.sLen - pos);
        const tIn = Math.min(1, dS / (tipLen * 0.55)), tOut = Math.min(1, dE / tipLen);
        const tp = Math.min(tIn, tOut), tps = tp * tp * (3 - 2 * tp);
        const half = (o.lw * wm) / 2 * (0.16 + 0.84 * tps);          // 筆身：線性
        const u = Math.max(0, Math.min(1, (wm - 0.2) / 1.2));        // 筆壓倍率 → 0–1 力道
        const press = softResp(u, P.gain);
        for (let j = 0; j < N; j++) {
          const kj = k * 131 + j;
          const r1 = hashS(o.si, kj, sd);
          if (r1 >= grainP * Math.max(0.4, wm)) continue;            // 顆粒＝跳點
          const r2 = hashS(o.si + 5, kj, sd), r2b = hashS(o.si + 11, kj, sd);
          const r3 = hashS(o.si + 17, kj, sd), r4 = hashS(o.si + 23, kj, sd);
          const r5 = hashS(o.si + 29, kj, sd);
          // 中心密、邊緣疏（三角分布）＋絕對尺度毛邊
          const perp = half * Math.max(-1.25, Math.min(1.25, (r2 + r2b - 1) * 1.5)) + fuzz * (r3 + r4 - 1);
          const alng = (r5 - 0.5) * step * 1.6;
          const qq = Math.abs(perp) / (half + fuzz + 0.001);
          const edgeF = Math.max(0, 1 - qq * qq * qq);               // 軟收邊：不切齊、不外爆
          if (edgeF <= 0) continue;
          let av = dabA * nrm * edgeF * press * (0.18 + 0.82 * tps) * (0.7 + 0.5 * r1);
          const dx = cx + perp * -uy + alng * ux, dy = cy + perp * ux + alng * uy;
          // 「移動」模式：紙紋跟著筆跑（筆畫座標逐點吃）；紋理化改在整筆之後鏤空
          if (MOVE && gstr > 0) {
            const tv = tooth(pos / 2.4, perp + o.si * 53 * gs, gs, P.paper, P.aspect);
            if (tv < gstr * 0.30) continue;
            av *= (1 - gstr) + gstr * Math.min(1, 0.28 + 1.3 * tv);
          }
          m.globalAlpha = Math.min(1, av);
          const rr = dotR * (0.75 + 0.5 * r2);
          m.drawImage(tip, dx - rr, dy - rr, rr * 2, rr * 2);
        }
      }
    }
  }

  // ── 2. 黏性：縮小再放大＝免 ctx.filter 的模糊（雙線性內插把點暈成塊，
  //    WKWebView 走得通、alpha 總量守恆）→ 疊回濃度（boost，樣本同式）──
  m.setTransform(1, 0, 0, 1, 0, 0);
  m.globalAlpha = 1;
  if (blur > 0.05) {
    // 目標：gooCv 裡放一張「全尺寸的模糊版」，再 copy 回 mask ＋ boost 疊濃（樣本同構）
    g2.setTransform(1, 0, 0, 1, 0, 0);
    g2.globalCompositeOperation = "copy";
    g2.globalAlpha = 1;
    g2.imageSmoothingEnabled = true;
    if (filterWorks()) {
      g2.filter = `blur(${(blur * scale).toFixed(2)}px)`;
      g2.drawImage(maskCv, 0, 0, dw, dh, 0, 0, dw, dh);
      g2.filter = "none";
    } else {
      // 縮放鏈：一路 2× 下、再一路 2× 上（雙線性內插），一大跳會有格狀失真所以逐級走
      const k = Math.max(1.5, Math.min(6, blur * scale * 0.9));
      let rw = dw, rh = dh;
      g2.drawImage(maskCv, 0, 0, dw, dh, 0, 0, rw, rh);
      for (let f = k; f > 1.01; f /= 2) {
        const st = Math.min(2, f);
        const nw = Math.max(2, Math.round(rw / st)), nh = Math.max(2, Math.round(rh / st));
        g2.drawImage(gooCv, 0, 0, rw, rh, 0, 0, nw, nh);   // 自畫自：drawImage 先快照再合成，安全
        rw = nw; rh = nh;
      }
      while (rw < dw || rh < dh) {
        const nw = Math.min(dw, rw * 2), nh = Math.min(dh, rh * 2);
        g2.drawImage(gooCv, 0, 0, rw, rh, 0, 0, nw, nh);
        rw = nw; rh = nh;
      }
    }
    m.globalCompositeOperation = "copy";
    m.drawImage(gooCv, 0, 0, dw, dh, 0, 0, dw, dh);
    m.globalCompositeOperation = "source-over";
    for (let i = 1; i < boost; i++) m.drawImage(gooCv, 0, 0, dw, dh, 0, 0, dw, dh);
  }

  // ── 3. 紋理化：紙紋鏤空（鎖 block 座標——線壓過去才露出紙的低谷）──
  if (!MOVE && gstr > 0) {
    const gc = grainFor(x1, y1, scale, gstr, gs, P.paper, P.aspect);
    if (gc) {
      m.globalCompositeOperation = "destination-in";
      m.drawImage(gc,
        (x0 + GRAIN_PAD) * grainScale, (y0 + GRAIN_PAD) * grainScale, bw * grainScale, bh * grainScale,
        0, 0, dw, dh);
      m.globalCompositeOperation = "source-over";
    }
  }

  // ── 4. 一次上色 → 以 strokeA 合成回畫布（同一筆不變黑、兩筆交叉才變黑）──
  m.globalCompositeOperation = "source-in";
  m.fillStyle = `#${o.color}`;
  m.fillRect(0, 0, dw, dh);
  m.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 0.96;
  ctx.drawImage(maskCv, 0, 0, dw, dh, x0, y0, bw, bh);
  ctx.globalAlpha = 1;
}

function strokeLen(p: { x: number; y: number }[]): number {
  let L = 0;
  for (let i = 1; i < p.length; i++) L += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y);
  return L;
}

// ── 編輯用幾何（輸入端）──────────────────────────────────────────────

/** 把「專案座標的筆畫們」包成 frame（含筆寬留白），並回傳正規化後的 strokes。 */
export function packStrokes(
  strokes: { pts: { x: number; y: number }[]; w: number; color: string; brush?: BrushKind; press?: number[]; sp?: Partial<SoftPrefs> }[],
  /** 筆寬（專案座標 px）——留白用。 */
  padPx: number,
): { frame: { x: number; y: number; w: number; h: number }; strokes: DoodleStroke[] } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of strokes) for (const p of s.pts) {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  const pad = Math.max(8, padPx);
  x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
  const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0), short = Math.min(w, h);
  return {
    frame: { x: x0, y: y0, w, h },
    strokes: strokes.map((s) => ({
      pts: s.pts.flatMap((p) => [(p.x - x0) / w, (p.y - y0) / h]),
      w: s.w / short, color: s.color, brush: s.brush, press: s.press, sp: s.sp,
    })),
  };
}

/** 把 block 內的正規化筆畫還原成專案座標（重新打包前用）。 */
export function unpackStrokes(
  d: DoodleBlock, frame: { x: number; y: number; w: number; h: number },
): { pts: { x: number; y: number }[]; w: number; color: string; brush?: BrushKind; press?: number[]; sp?: Partial<SoftPrefs> }[] {
  const short = Math.min(frame.w, frame.h);
  return d.strokes.map((s) => {
    const pts: { x: number; y: number }[] = [];
    for (let i = 0; i + 1 < s.pts.length; i += 2) pts.push({ x: frame.x + s.pts[i] * frame.w, y: frame.y + s.pts[i + 1] * frame.h });
    return { pts, w: s.w * short, color: s.color, brush: s.brush, press: s.press, sp: s.sp };
  });
}

/** 橡皮擦命中：點 p（專案座標）碰到哪一筆（距離 ≤ 半筆寬＋容差）。回傳索引或 -1。 */
export function strokeHit(
  d: DoodleBlock, frame: { x: number; y: number; w: number; h: number },
  p: { x: number; y: number }, tolPx: number,
): number {
  const strokes = unpackStrokes(d, frame);
  for (let si = strokes.length - 1; si >= 0; si--) {
    const s = strokes[si];
    const r = s.w / 2 + tolPx;
    if (s.pts.length === 1) { if (Math.hypot(p.x - s.pts[0].x, p.y - s.pts[0].y) <= r) return si; continue; }
    for (let i = 1; i < s.pts.length; i++) {
      if (distToSeg(p, s.pts[i - 1], s.pts[i]) <= r) return si;
    }
  }
  return -1;
}

function distToSeg(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const L2 = dx * dx + dy * dy;
  const u = L2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2)) : 0;
  return Math.hypot(p.x - (a.x + dx * u), p.y - (a.y + dy * u));
}

/**
 * 速度模擬筆壓（滑鼠／手指用；Pencil 有真壓力就不走這裡）：
 * 畫得快＝線細、慢＝線粗（手寫墨水筆的自然感），頭尾再收細一點。
 * 回傳與 pts 對齊的寬度倍率（0.45–1.15），已做雙向平滑。三平台同一份。
 */
export function speedPress(pts: { x: number; y: number }[], refWidth: number): number[] {
  const n = pts.length;
  if (n < 3) return pts.map(() => 1);
  // perfect-freehand simulatePressure（非對稱收斂：變細快、回粗慢）——
  // sp＝速度（點距/筆寬），目標壓力＝1−sp，往目標走 sp×0.275 步
  let p = 0.35;   // 起筆偏細（PF 的 DEFAULT_FIRST_PRESSURE 精神）
  const raw: number[] = [p];
  for (let i = 1; i < n; i++) {
    const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    const sp = Math.min(1, d / (refWidth * 1.6));
    const rp = Math.min(1, 1 - sp);
    p = Math.min(1, p + (rp - p) * (sp * 0.275));
    raw.push(p);
  }
  // 收筆端回向平滑（起筆端已由累積收斂自然升起，不再回向抹）
  for (let i = n - 2; i >= 0; i--) raw[i] = raw[i + 1] * 0.3 + raw[i] * 0.7;
  // 壓力 0…1 → 寬度倍率（0.45–1.15）
  return raw.map((v) => Math.round((0.45 + 0.7 * Math.max(0, Math.min(1, v))) * 100) / 100);
}

/**
 * 輸入平滑（perfect-freehand 的 streamline）：每個新點＝上一個「平滑後的點」往原始點
 * 走 t 步——手抖被吸掉、線變順。**前向一遍**，即時預覽與放手後跑同一條公式結果一致。
 */
export function streamlinePts(pts: { x: number; y: number }[], t = 0.55): { x: number; y: number }[] {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const l = out[i - 1];
    out.push({ x: l.x + (pts[i].x - l.x) * t, y: l.y + (pts[i].y - l.y) * t });
  }
  // 尾端貼回真實最後一點（PF 的 last:true 語意）——不貼的話筆尾永遠短一截
  out[out.length - 1] = pts[pts.length - 1];
  return out;
}

/** 手繪點太密會抖——距離小於 minDist 的點丟掉（保留首尾）。 */
export function thinPoints(pts: { x: number; y: number }[], minDist: number): { x: number; y: number }[] {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const l = out[out.length - 1];
    if (Math.hypot(pts[i].x - l.x, pts[i].y - l.y) >= minDist) out.push(pts[i]);
  }
  out.push(pts[pts.length - 1]);
  return out;
}
