// ALIGN Core — 設計漸層（2026-10-12，iOS PageGradient.swift 逐步移植）。
//
// 頁面底色／圖形填色／文字色的第二種填法。演算法與 iOS `PageGradientRenderer` 同源：
// t＝線性投影或放射距離 → 加霧 → (t−start)/length 夾 0…1 → 緩動 → 查 OKLab LUT → 加顆粒。
// 顆粒用固定種子的 mulberry32 逐像素取，同參數同尺寸＝同一張圖（跨平台也同一張，誤差 ±1）。
//
// 🔴 跨平台契約：欄位名與演算法改動要三平台同版（iOS 檔頭同一句）。
// kind／ease 用字串不用列舉——舊版讀到不認得的值只會退回預設，不會整檔拒讀。

import { __ } from "../i18n";

export interface GradientStop { p: number; hex: string }

export interface PageGradient {
  preset?: string;
  kind: string;            // "linear" | "radial"
  stops: GradientStop[];
  angle?: number;          // linear：度，0＝由下往上、90＝由左往右（同 CSS）
  cx?: number;             // radial：光源中心（頁寬／頁高比例）
  cy?: number;
  radius?: number;         // radial：半徑（頁寬比例）
  start: number;           // 停留區：t 小於它都是第一色
  length: number;          // 轉折長度
  ease: string;            // linear｜smooth｜soft｜late｜early
  grain: number;           // 顆粒（±grain/2 的亮度雜訊）
  haze?: number;           // 霧：大塊低頻雜訊推 t
  hue?: number;            // 整體色相偏移（度）
  depth?: number;          // 色深（−0.3…0.3）：OKLab 明度整體減去它，正＝變深
  saturation?: number;     // 飽和度倍率（0…2，absent＝1）
}

// ── OKLab（Björn Ottosson）────────────────────────────────────────────

const lin = (c: number): number => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const gam = (c: number): number => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

export function rgb01(hexStr: string): [number, number, number] {
  const h = hexStr.startsWith("#") ? hexStr.slice(1) : hexStr;
  let v = /^[0-9a-fA-F]{1,8}$/.test(h) ? parseInt(h, 16) : 0xffffff;
  if (!Number.isFinite(v) || v > 0xffffffff) v = 0xffffff;
  return [((v >>> 16) & 0xff) / 255, ((v >>> 8) & 0xff) / 255, (v & 0xff) / 255];
}

export function toLab(rgb: readonly number[]): [number, number, number] {
  const r = lin(rgb[0]), g = lin(rgb[1]), b = lin(rgb[2]);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
          1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
          0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

/** 回 0…255（夾限） */
export function toRGB255(lab: readonly number[]): [number, number, number] {
  const L = lab[0], a = lab[1], b = lab[2];
  const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
  const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
  const s = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3);
  const f = (x: number) => Math.max(0, Math.min(1, gam(x))) * 255;
  return [f(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
          f(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
          f(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)];
}

const hex2 = (n: number): string => Math.round(n).toString(16).toUpperCase().padStart(2, "0");

/** 色相＋明度＋彩度一起調：繞色相、彩度乘 k、明度加 dL（0…1 夾限）。白黑只動明度。 */
export function okAdjust(hexStr: string, hueDegrees: number, dL: number, k = 1): string {
  const L = toLab(rgb01(hexStr));
  const C = Math.hypot(L[1], L[2]);
  if (C >= 1e-4 && (hueDegrees !== 0 || k !== 1)) {
    const a = Math.atan2(L[2], L[1]) + hueDegrees * Math.PI / 180;
    L[1] = C * k * Math.cos(a); L[2] = C * k * Math.sin(a);
  }
  L[0] = Math.max(0, Math.min(1, L[0] + dL));
  const c = toRGB255(L);
  return hex2(c[0]) + hex2(c[1]) + hex2(c[2]);
}

// ── 欄位衍生值 ────────────────────────────────────────────────────────

/** 實際上色用的色點（整體色相／色深／飽和度調整後）。 */
export function effectiveStops(g: PageGradient): GradientStop[] {
  const h = g.hue ?? 0, d = g.depth ?? 0, k = g.saturation ?? 1;
  if (h === 0 && d === 0 && k === 1) return g.stops;
  return g.stops.map((s) => ({ p: s.p, hex: okAdjust(s.hex, h, -d, k) }));
}

/** 個別色點存回去：扣掉整體調整（飽和度 0 反推不回原彩度，只好照選的色存）。iOS setStop 同義。 */
export function stopHexFromPicked(g: PageGradient, picked: string): string {
  const h = g.hue ?? 0, d = g.depth ?? 0, k = g.saturation ?? 1;
  if (h === 0 && d === 0 && k === 1) return picked.toUpperCase();
  return okAdjust(picked, -h, d, k > 0.01 ? 1 / k : 1);
}

/** 固定欄位順序的身分字串——快取鍵與「是不是同一個漸層」都用它（物件鍵順序不可靠）。 */
export function gradientKey(g: PageGradient): string {
  return JSON.stringify([g.kind, g.stops.map((s) => [s.p, s.hex]), g.angle ?? null, g.cx ?? null, g.cy ?? null,
    g.radius ?? null, g.start, g.length, g.ease, g.grain, g.haze ?? null, g.hue ?? null, g.depth ?? null,
    g.saturation ?? null]);
}
export const sameGradient = (a: PageGradient | undefined | null, b: PageGradient | undefined | null): boolean =>
  !!a && !!b && a.preset === b.preset && gradientKey(a) === gradientKey(b);

// ── 渲染 ──────────────────────────────────────────────────────────────

export function lut(stops: readonly GradientStop[], n = 1024): Float32Array {
  const S = [...stops].sort((a, b) => a.p - b.p).map((s) => ({ p: s.p, c: toLab(rgb01(s.hex)) }));
  const out = new Float32Array(n * 3);
  if (!S.length) return out;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    let k = 0;
    while (k < S.length - 2 && t > S[k + 1].p) k++;
    const s0 = S[k], s1 = S[Math.min(k + 1, S.length - 1)];
    const u = s1.p > s0.p ? Math.min(1, Math.max(0, (t - s0.p) / (s1.p - s0.p))) : 0;
    const c0 = s0.c, c1 = s1.c;
    const rgb = toRGB255([c0[0] + (c1[0] - c0[0]) * u, c0[1] + (c1[1] - c0[1]) * u, c0[2] + (c1[2] - c0[2]) * u]);
    out[i * 3] = rgb[0]; out[i * 3 + 1] = rgb[1]; out[i * 3 + 2] = rgb[2];
  }
  return out;
}

export function ease(name: string, u: number): number {
  switch (name) {
    case "smooth": return u * u * (3 - 2 * u);
    case "soft": return u < 0.5 ? 2 * u * u : 1 - 2 * (1 - u) * (1 - u);
    case "late": return Math.pow(u, 2.2);
    case "early": return 1 - Math.pow(1 - u, 2.2);
    default: return u;
  }
}

/** mulberry32（同樣本間 rng()、iOS PageGradientRenderer.RNG）。 */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s) >>> 0;
    t = ((t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t) >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 值雜訊（同樣本間 vnoise）：gw×gh 格、smoothstep 內插。 */
export function valueNoise(seed: number, gw: number, gh: number): (x0: number, y0: number) => number {
  const r = mulberry32(seed);
  const g = Array.from({ length: (gw + 2) * (gh + 2) }, () => r());
  const v = (i: number, j: number): number =>
    g[Math.max(0, Math.min(gh + 1, j)) * (gw + 2) + Math.max(0, Math.min(gw + 1, i))];
  return (x0, y0) => {
    const x = x0 * gw, y = y0 * gh;
    const xi = Math.floor(x), yi = Math.floor(y);
    const fx = x - xi, fy = y - yi;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = v(xi, yi), b = v(xi + 1, yi), c = v(xi, yi + 1), d = v(xi + 1, yi + 1);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
}

/** 逐像素算成 RGBA（不碰 canvas，Node／worker 也能跑）。 */
export function gradientPixels(g: PageGradient, width: number, height: number): Uint8ClampedArray {
  const W = Math.max(1, Math.round(width)), H = Math.max(1, Math.round(height));
  const T = lut(effectiveStops(g));
  const aspect = H / W;
  const haze = g.haze ?? 0;
  const N1 = haze > 0 ? valueNoise(11, 3, 4) : null;
  const N2 = haze > 0 ? valueNoise(29, 7, 9) : null;
  const radial = g.kind === "radial";
  const a = (g.angle ?? 0) * Math.PI / 180;
  const dx = Math.sin(a), dy = -Math.cos(a);
  const corners = [0, W * dx, H * dy, W * dx + H * dy];
  const mn = Math.min(...corners), mx = Math.max(...corners);
  const span = mx - mn || 1;
  const cx = g.cx ?? 0.5, cy = g.cy ?? 0.5, rad = Math.max(0.001, g.radius ?? 1);
  const start = g.start ?? 0, len = Math.max(0.001, g.length ?? 1);
  const rng = mulberry32(7);
  const grain = (g.grain ?? 0) * 255;
  const D = new Uint8ClampedArray(W * H * 4);
  for (let j = 0; j < H; j++) {
    const v = j / H;
    for (let i = 0; i < W; i++) {
      const u = i / W;
      let t = radial ? Math.hypot(u - cx, (v - cy) * aspect) / rad : ((i * dx + j * dy) - mn) / span;
      if (N1 && N2) t += (N1(u, v) - 0.5) * haze * 2 + (N2(u, v) - 0.5) * haze * 0.6;
      let q = (t - start) / len;
      q = q > 1 ? 1 : q > 0 ? q : 0;          // NaN 也落 0
      const k = Math.round(ease(g.ease, q) * 1023) * 3;
      const n = (rng() - 0.5) * grain;
      const o = (j * W + i) * 4;
      // iOS：UInt8(max(0, min(255, Double(T)+n)))＝夾限後**截斷**，不是四捨五入
      D[o] = Math.max(0, Math.min(255, T[k] + n)) | 0;
      D[o + 1] = Math.max(0, Math.min(255, T[k + 1] + n)) | 0;
      D[o + 2] = Math.max(0, Math.min(255, T[k + 2] + n)) | 0;
      D[o + 3] = 255;
    }
  }
  return D;
}

/** 平均色（寫進 pageBackgroundHex／shape.colorHex 當後備色）：16×20 小圖取畫面平均，不是色點平均。 */
export function averageHex(g: PageGradient): string {
  if (!g.stops?.length) return "FFFFFF";
  const D = gradientPixels(g, 16, 20);
  const s = [0, 0, 0], n = 16 * 20;
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) s[c] += D[i * 4 + c];
  return s.map((x) => Math.floor(x / n).toString(16).toUpperCase().padStart(2, "0")).join("");
}

/**
 * 拖拉桿／選色中＝true：頁面底色改烤 1/3 寬的草稿，放開回全尺寸（iOS `interactive` 同義）。
 * 只影響頁面底色（圖形／文字本來就小）。pageSig 會把它納入，草稿不會被當成定稿快取。
 */
let _interactive = false;
export function setGradientInteractive(on: boolean): void { _interactive = on; }
export function gradientInteractive(): boolean { return _interactive; }

/** LRU：張數＋總畫素兩道上限。整頁 1080×1350 一張 146 萬畫素，16M＝畫布＋頁條＋匯出同時在用也夠。 */
const _cache = new Map<string, HTMLCanvasElement>();
const CACHE_PIXELS = 16_000_000;
const CACHE_MAX = 48;
export const gradientCounters = { hit: 0, miss: 0 };

export function gradientCanvas(g: PageGradient, width: number, height: number): HTMLCanvasElement {
  const W = Math.max(1, Math.round(width)), H = Math.max(1, Math.round(height));
  const key = `${W}x${H}|${gradientKey(g)}`;
  const hit = _cache.get(key);
  if (hit) { _cache.delete(key); _cache.set(key, hit); gradientCounters.hit++; return hit; }
  gradientCounters.miss++;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const x = c.getContext("2d")!;
  const img = x.createImageData(W, H);
  img.data.set(gradientPixels(g, W, H));
  x.putImageData(img, 0, 0);
  _cache.set(key, c);
  let px = 0;
  for (const v of _cache.values()) px += v.width * v.height;
  while (_cache.size > CACHE_MAX || (px > CACHE_PIXELS && _cache.size > 1)) {
    const oldest = _cache.keys().next().value as string;
    const oc = _cache.get(oldest)!;
    px -= oc.width * oc.height;
    _cache.delete(oldest);
  }
  return c;
}

/** 圖形／文字的烤圖尺寸：照顯示寬、以 64 為級距（縮放不會每格重烤），比例照框。iOS 同一套。 */
export function blockGradientSize(w: number, h: number): { w: number; h: number } {
  const gw = Math.max(64, Math.min(1600, Math.ceil(w / 64) * 64));
  return { w: gw, h: Math.max(1, Math.round(gw * h / Math.max(1, w))) };
}

// ── 預設與「上次」────────────────────────────────────────────────────

const S = (p: number, hex: string): GradientStop => ({ p, hex });

/** 小高挑的 6 個（10/12），第一個＝預設。數字與 iOS presets 逐值相同。 */
export const GRADIENT_PRESETS: readonly { key: string; gradient: PageGradient }[] = [
  { key: "greenSide", gradient: { preset: "greenSide", kind: "linear",
    stops: [S(0, "D5D6D3"), S(0.2, "D2DCCA"), S(0.45, "9DD08A"), S(0.7, "3BA552"), S(0.9, "0E7438"), S(1, "0A6531")],
    angle: 90, start: 0.4, length: 0.6, ease: "linear", grain: 0.035 } },
  { key: "mistBlue", gradient: { preset: "mistBlue", kind: "linear",
    stops: [S(0, "9CCFE6"), S(0.4, "CBE6F1"), S(0.85, "F1F5F4"), S(1, "F7F6F2")],
    angle: 180, start: 0, length: 0.78, ease: "early", grain: 0.02, haze: 0.10 } },
  { key: "amberDark", gradient: { preset: "amberDark", kind: "radial",
    stops: [S(0, "F39A3A"), S(0.22, "D2601E"), S(0.55, "6A2A12"), S(1, "1C0E0A")],
    cx: 0.5, cy: 0.78, radius: 0.95, start: 0, length: 1, ease: "soft", grain: 0.05 } },
  { key: "horizon", gradient: { preset: "horizon", kind: "linear",
    stops: [S(0, "8DBBD6"), S(0.45, "A9CADB"), S(0.5, "5F9CC4"), S(1, "1C6EA6")],
    angle: 180, start: 0.5, length: 0.14, ease: "smooth", grain: 0.025, haze: 0.04 } },
  { key: "darkroomTop", gradient: { preset: "darkroomTop", kind: "radial",
    stops: [S(0, "4A4844"), S(0.35, "252423"), S(1, "0B0B0C")],
    cx: 0.5, cy: -0.1, radius: 1.15, start: 0, length: 1, ease: "early", grain: 0.04 } },
  { key: "ricePaperSun", gradient: { preset: "ricePaperSun", kind: "linear",
    stops: [S(0, "F3D9B8"), S(0.4, "F1E6D6"), S(1, "EEEAE2")],
    angle: 135, start: 0, length: 0.7, ease: "soft", grain: 0.03, haze: 0.05 } },
];

/** 預設名（介面字）。字面量寫死，check-locale 才掃得到。 */
export function presetName(key: string): string {
  switch (key) {
    case "greenSide": return __("綠側光");
    case "mistBlue": return __("晨霧藍");
    case "amberDark": return __("琥珀暗場");
    case "horizon": return __("海平線");
    case "darkroomTop": return __("暗室頂光");
    case "ricePaperSun": return __("米紙暖陽");
    default: return key;
  }
}

export const cloneGradient = (g: PageGradient): PageGradient =>
  ({ ...g, stops: g.stops.map((s) => ({ ...s })) });

const LAST_KEY = "align.gradient.last";
/** 上次調好的漸層（App 偏好、不進專案檔）。編輯器每次 commit 都更新；新物件切到「漸層」先用它。 */
export function lastUsedGradient(): PageGradient | null {
  try {
    const s = localStorage.getItem(LAST_KEY);
    if (!s) return null;
    const g = JSON.parse(s) as PageGradient;
    return g && Array.isArray(g.stops) && g.stops.length ? g : null;
  } catch { return null; }
}
export function setLastUsedGradient(g: PageGradient | null): void {
  try {
    if (g) localStorage.setItem(LAST_KEY, JSON.stringify(g)); else localStorage.removeItem(LAST_KEY);
  } catch { /* 無 storage：只是不記 */ }
}
/** 切到「漸層」時的起點：上次的，沒有就綠側光。 */
export function startingGradient(): PageGradient {
  return cloneGradient(lastUsedGradient() ?? GRADIENT_PRESETS[0].gradient);
}
