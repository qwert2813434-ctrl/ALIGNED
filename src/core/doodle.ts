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
  kind: "line" | "stamp" | "fill";
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

function strokeLen(p: { x: number; y: number }[]): number {
  let L = 0;
  for (let i = 1; i < p.length; i++) L += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y);
  return L;
}

// ── 編輯用幾何（輸入端）──────────────────────────────────────────────

/** 把「專案座標的筆畫們」包成 frame（含筆寬留白），並回傳正規化後的 strokes。 */
export function packStrokes(
  strokes: { pts: { x: number; y: number }[]; w: number; color: string; brush?: BrushKind; press?: number[] }[],
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
      w: s.w / short, color: s.color, brush: s.brush, press: s.press,
    })),
  };
}

/** 把 block 內的正規化筆畫還原成專案座標（重新打包前用）。 */
export function unpackStrokes(
  d: DoodleBlock, frame: { x: number; y: number; w: number; h: number },
): { pts: { x: number; y: number }[]; w: number; color: string; brush?: BrushKind; press?: number[] }[] {
  const short = Math.min(frame.w, frame.h);
  return d.strokes.map((s) => {
    const pts: { x: number; y: number }[] = [];
    for (let i = 0; i + 1 < s.pts.length; i += 2) pts.push({ x: frame.x + s.pts[i] * frame.w, y: frame.y + s.pts[i + 1] * frame.h });
    return { pts, w: s.w * short, color: s.color, brush: s.brush, press: s.press };
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
