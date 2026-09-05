// ALIGN Core — 撕紙邊（2026-08-31）。正本＝工具間 filter-lab.html 的邊緣系統，
// 小高在那邊定的手感。四種樣式：孔版粗邊（riso）／撕毛邊（torn）／真撕紙（tear）／
// 羽化（feather）。真撕紙＝兩條各自起伏的曲線（紙斷線＋印刷停線）夾出忽寬忽窄的
// 紙芯白帶，帶內外唇亮內側暗，撕邊外壓一道細影。
//
// **烤成兩張畫布**，不逐幀算：
//   mask    —— 白底帶 alpha，destination-in 蓋到媒體上＝把照片沿撕痕裁掉
//   overlay —— 紙芯白帶＋細影（細影是半透明黑，落在被裁掉的透明區，疊到頁面自然成影）
// 靜態圖整組進 render.ts 的切圖快取（blockSig 吃整塊 JSON，新欄位自動進鍵）；
// 影片即時影格每幀只多兩次 drawImage。本模組自帶小 LRU 服務影片路與重烤。
//
// 空間正規化：噪訊波長基準＝短邊 600px（工具間樣本照的尺度），咬深 amt＝短邊分數
// ——同一組參數在小框、大框、匯出上長相一致。
// 細影鐵則（工具間 2026-08-31 實踩）：每邊的效果要用垂直兩側的輪廓夾住，
// 不然影線會沿輪廓延伸橫過整張紙＝穿幫。

import { hash1u, hash2u } from "./filters";

export interface TornParams {
  style: string;    // riso | torn | tear | feather
  sides: number;    // bitmask：1上 2右 4下 8左
  amt: number;      // 咬深（短邊分數）
  deform: number;   // 0–1 輪廓波幅（0.5＝基準）
  rough: number;    // 0–1 波長與對比（0.5＝基準）
  seed: number;
  core: string;     // 紙芯色 hex（c5 時＝油墨紙色提亮，否則米白）
}

export const TORN_STYLES = ["riso", "torn", "tear", "feather"] as const;
export const TORN_DEFAULTS = { amt: 0.055, deform: 0.5, rough: 0.5, seed: 7, sides: 15 };

/** 旋轉後「畫布方向」↔「物件自己的邊」換算（2026-09-05 小高定案：檔案永遠存物件邊，只在面板換算，
 *  舊專案渲染一個 px 不動）。索引 0上 1右 2下 3左（順時針＝位元序）。
 *  角度取最接近的 90°：floor((deg+45)/90)，45 算成 90；負角先 +4 再取餘（JS 的 % 對負數回負數，
 *  −90 會撕錯邊）。iOS TornEdge.quarterTurns／localSide 同一張表，改一邊必改另一邊。 */
export function tornQuarterTurns(rotation: number): number {
  const k = Math.floor((rotation + 45) / 90);
  return ((k % 4) + 4) % 4;
}
export function tornLocalSide(canvasIdx: number, rotation: number): number {
  return ((canvasIdx - tornQuarterTurns(rotation)) % 4 + 4) % 4;
}
export function tornCanvasSides(localMask: number, rotation: number): number {
  let out = 0;
  for (let l = 0; l < 4; l++) if (localMask & (1 << l)) out |= 1 << ((l + tornQuarterTurns(rotation)) % 4);
  return out;
}

/** media 欄位 → 參數；沒開撕紙邊回 null（absent＝舊專案零變動）。 */
export function tornOf(m: {
  tornStyle?: string; tornSides?: number; tornAmt?: number; tornDeform?: number;
  tornRough?: number; tornSeed?: number; filterKey?: string; risoPaper?: string;
}): TornParams | null {
  if (!m.tornStyle || !(TORN_STYLES as readonly string[]).includes(m.tornStyle)) return null;
  // 四個邊全部取消勾選＝當成沒開撕紙邊。不擋的話會變成「邊沒取代框、框卻被拿掉」
  // （抑制描邊只看 tornOf 有沒有值），而且每次還照烤一張全白遮罩＋全透明覆蓋層白燒
  // （跨頁寬圖 138ms）。2026-09-01 發版審查。
  if (!(m.tornSides ?? TORN_DEFAULTS.sides)) return null;
  const core = m.filterKey === "c5"
    ? brighten(m.risoPaper ?? "DDD7C9")
    : "F5F1E6";
  return {
    style: m.tornStyle,
    sides: m.tornSides ?? TORN_DEFAULTS.sides,
    amt: m.tornAmt ?? TORN_DEFAULTS.amt,
    deform: m.tornDeform ?? TORN_DEFAULTS.deform,
    rough: m.tornRough ?? TORN_DEFAULTS.rough,
    seed: m.tornSeed ?? TORN_DEFAULTS.seed,
    core,
  };
}

function brighten(hx: string): string {
  const v = parseInt(hx.replace("#", "").padEnd(6, "0"), 16) || 0;
  const f = (c: number, cap: number) => Math.min(Math.round(c * 1.09), cap);
  const r = f((v >> 16) & 255, 250), g = f((v >> 8) & 255, 248), b = f(v & 255, 244);
  return ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}

/** 1D 值雜訊曲線（工具間同款：smoothstep 內插）。 */
function noise1D(len: number, cell: number, seed: number): Float32Array {
  const n = Math.ceil(len / Math.max(cell, 1)) + 2, g = new Float32Array(n);
  for (let i = 0; i < n; i++) g[i] = hash1u(i, seed);
  const out = new Float32Array(len);
  for (let x = 0; x < len; x++) {
    const u = x / Math.max(cell, 1), i = u | 0, t = u - i, sm = t * t * (3 - 2 * t);
    out[x] = g[i] * (1 - sm) + g[i + 1] * sm;
  }
  return out;
}

interface SideCurve {
  I: number; af: number;
  base?: Float32Array; hi?: Float32Array;          // riso / torn
  mo?: Float32Array; bw?: Float32Array; sh?: Float32Array;   // tear（預算好的 1D 表）
}

function buildCurves(p: TornParams, W: number, H: number): (SideCurve | null)[] {
  const short = Math.min(W, H);
  const k = short / 600;
  const I = p.amt * short;
  const r = p.rough, rd = p.deform;
  const ff = 1.55 - 1.1 * r;                        // 波長倍率：50＝原樣
  const af = rd <= 0.5 ? rd * 2 : 1 + (rd - 0.5) * 2.4;   // 波幅：0 近直線、100→2.2 倍
  const seed = p.seed | 0;
  const mk = (len: number, sideIdx: number): SideCurve | null => {
    if (!(p.sides & (1 << sideIdx))) return null;
    const lo = noise1D(len, 34 * k * ff, seed + sideIdx * 7);
    if (p.style === "riso" || p.style === "feather") return { I, af, base: lo };
    if (p.style === "torn") {
      return { I, af, base: lo, hi: noise1D(len, 4 * k * ff, seed + 100 + sideIdx * 7) };
    }
    // tear：紙斷線（大浪＋中頻＋毛鬚）與印刷停線各自一條，預算成 1D 表
    const big = noise1D(len, 120 * k * ff, seed + 500 + sideIdx * 7);
    const mid = noise1D(len, 26 * k * ff, seed + 510 + sideIdx * 7);
    const hi = noise1D(len, 3 * k * ff, seed + 520 + sideIdx * 7);
    const band = noise1D(len, 90 * k * ff, seed + 530 + sideIdx * 7);
    const bmid = noise1D(len, 18 * k * ff, seed + 540 + sideIdx * 7);
    const sh = noise1D(len, 40 * k * ff, seed + 550 + sideIdx * 7);
    const ex = 1.2 + 2 * r;                         // 白帶對比：高隨機＝夾更死鼓更開
    const ja = 0.04 + 0.16 * r;                     // 斷線毛鬚幅度
    const mo = new Float32Array(len), bw = new Float32Array(len);
    for (let t = 0; t < len; t++) {
      // 平均咬深 0.60·I 固定，af 只縮放繞著平均的擺動——調變形不會整圈變深
      const wob = 0.50 * big[t] + 0.26 * mid[t] - 0.38;
      mo[t] = Math.max(I * (0.60 + af * wob) + (hi[t] - 0.5) * I * ja, I * 0.04);
      bw[t] = I * (0.06 + 1.5 * Math.pow(0.15 + 0.85 * band[t], ex)) * (1 + (bmid[t] - 0.5) * r);
    }
    return { I, af, mo, bw, sh };
  };
  return [mk(W, 0), mk(H, 1), mk(W, 2), mk(H, 3)];
}

// ── 小 LRU：服務影片即時影格與參數拖曳（靜態圖另有切圖快取罩著）。
// 逐出看**像素預算**不看張數（一張 8K 就能吃光記憶體；「countLimit 是懸崖」同款教訓）──
const _cache = new Map<string, { mask: HTMLCanvasElement; overlay: HTMLCanvasElement; px: number }>();
const CACHE_PX = 12_000_000;   // mask+overlay 每像素 8 bytes ≈ 96MB 上限
/**
 * 烤圖尺寸＝**正規化的**（與 iOS `TornEdge.layers(for:aspect:)` 逐行同式）：
 * 短邊固定 1024、長寬比量化到 1/32、超寬再等比縮回 4096。
 *
 * 🔴 為什麼不能用裝置畫素：那樣快取鍵裡就有顯示尺寸，**縮放畫布／拖參數滑桿
 * 每一幀尺寸都不同＝每一幀重烤整張撕痕**（「顯示尺寸當鑰匙」是畫布快取六鐵則第一條）。
 * 撕痕是低頻形狀，1024 放大到目標框看不出來——呼叫端本來就用明確寬高 drawImage。
 * 順帶把 iOS 註解裡點名的「撕痕波長跟 Mac 不同」補平：同一份參數兩邊烤同一個尺寸，
 * 撕痕相位從此逐位同相。（2026-09-01）
 */
export function tornBakeSize(W: number, H: number): { w: number; h: number } {
  const ar = Math.max(1 / 32, Math.round((Math.max(W, 1) / Math.max(H, 1)) * 32) / 32);
  const short = 1024;
  let w = ar >= 1 ? short * ar : short;
  let h = ar >= 1 ? short : short / ar;
  const over = Math.max(w, h) / 4096;      // 超寬圖等比縮，別各自 min() 硬剪壓扁比例
  if (over > 1) { w /= over; h /= over; }
  return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
}

export function tornKey(p: TornParams, W: number, H: number): string {
  return `${p.style}|${p.sides}|${p.amt}|${p.deform}|${p.rough}|${p.seed}|${p.core}|${W}x${H}`;
}

/** 烤撕紙邊。W/H＝目標裝置畫素。回 mask（destination-in 用）＋ overlay（疊最上）。 */
export function tornCanvases(p: TornParams, W0: number, H0: number):
    { mask: HTMLCanvasElement; overlay: HTMLCanvasElement } {
  const { w: W, h: H } = tornBakeSize(W0, H0);
  const key = tornKey(p, W, H);
  const hit = _cache.get(key);
  if (hit) { _cache.delete(key); _cache.set(key, hit); return hit; }

  const curves = buildCurves(p, W, H);
  const seed = p.seed | 0;
  const short = Math.min(W, H);
  const k = short / 600;
  const cvRaw = parseInt(p.core, 16);
  const cv = Number.isNaN(cvRaw) ? 0xF5F1E6 : cvRaw;   // ⚠️ 不能用 ||：純黑 0x000000 是合法紙芯色
  const cr = (cv >> 16) & 255, cg = (cv >> 8) & 255, cb = cv & 255;

  const mask = doc(W, H), overlay = doc(W, H);
  const mctx = mask.getContext("2d")!, octx = overlay.getContext("2d")!;
  const md = mctx.createImageData(W, H), od = octx.createImageData(W, H);
  const mp = md.data, op = od.data;

  const _d = new Float32Array(4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // 第一趟：四邊各自的 d（離自己輪廓多遠）——細影要靠它判斷「照片旁邊」
      for (let s = 0; s < 4; s++) {
        const c = curves[s];
        let dist: number, t: number;
        if (s === 0) { dist = y; t = x; } else if (s === 1) { dist = W - 1 - x; t = y; }
        else if (s === 2) { dist = H - 1 - y; t = x; } else { dist = x; t = y; }
        if (!c) { _d[s] = dist; continue; }
        if (p.style === "tear") _d[s] = dist - c.mo![t];
        else if (p.style === "feather") _d[s] = dist;
        else _d[s] = dist - c.I * Math.max(0.675 + c.af * 0.65 * (c.base![t] - 0.5), 0.02);
      }
      let cut = false, shade = 1, coreSh = 0, alpha = 0;
      for (let s = 0; s < 4; s++) {
        const c = curves[s];
        if (!c) continue;
        const d = _d[s], t = (s === 0 || s === 2) ? x : y;
        if (p.style === "tear") {
          if (d < 0) {
            cut = true;
            // 細影只落在照片旁邊：超出垂直兩側輪廓（角落外）就不畫——穿幫鐵則
            const o1 = (s === 0 || s === 2) ? 3 : 0, o2 = (s === 0 || s === 2) ? 1 : 2;
            if (_d[o1] >= 0 && _d[o2] >= 0) {
              const sw = Math.max(c.I * 0.14, 3);
              if (d > -sw) shade = Math.min(shade, 1 - 0.10 * (1 + d / sw));
            }
            continue;
          }
          const bw = c.bw![t];
          if (d < bw) {
            const u = d / Math.max(bw, 1);
            coreSh = Math.max(coreSh, 1.03 + 0.05 * (1 - u) - 0.16 * u * u + (c.sh![t] - 0.5) * 0.14);
          } else {
            const f = Math.max(c.I * 0.10, 2);
            if (d < bw + f && hash2u((x / k) | 0, (y / k) | 0, seed + 902) > (d - bw) / f)
              coreSh = Math.max(coreSh, 0.99);
          }
        } else if (p.style === "riso") {
          if (d < 0) cut = true;
        } else if (p.style === "torn") {
          if (d < 0) { cut = true; continue; }
          const F = Math.max(c.I * 0.55, 2);
          if (d < F) {
            const u = d / F;
            const hh = c.hi![t] * 0.7 + hash2u((x / k) | 0, (y / k) | 0, seed + 900) * 0.3;
            if (hh > u) coreSh = Math.max(coreSh, 1);
            else if (hash2u((x / k) | 0, (y / k) | 0, seed + 901) > u * 1.6) coreSh = Math.max(coreSh, 1);
          }
        } else {                                     // feather
          if (d < 0) { cut = true; continue; }
          const F = Math.max(c.I, 2);
          if (d < F) alpha = Math.max(alpha, 1 - d / F);
        }
      }
      const i = (y * W + x) * 4;
      // mask：留下＝白不透明；裁掉＝alpha 0；羽化＝漸淡
      mp[i] = mp[i + 1] = mp[i + 2] = 255;
      mp[i + 3] = cut ? 0 : alpha > 0 ? Math.round((1 - alpha) * 255) : 255;
      // overlay：紙芯白帶（帶明暗）蓋在照片上；細影落在被裁掉的透明區
      if (!cut && coreSh > 0) {
        op[i] = clamp255(cr * coreSh); op[i + 1] = clamp255(cg * coreSh);
        op[i + 2] = clamp255(cb * coreSh); op[i + 3] = 255;
      } else if (cut && shade < 1) {
        op[i] = op[i + 1] = op[i + 2] = 0;
        op[i + 3] = Math.round((1 - shade) * 235);   // 10% 峰值的細影 → alpha 黑
      }
    }
  }
  mctx.putImageData(md, 0, 0);
  octx.putImageData(od, 0, 0);

  const entry = { mask, overlay, px: W * H };
  _cache.set(key, entry);
  let total = 0;
  for (const v of _cache.values()) total += v.px;
  while (total > CACHE_PX && _cache.size > 1) {
    const oldest = _cache.keys().next().value as string;
    total -= _cache.get(oldest)!.px;
    _cache.delete(oldest);
  }
  return entry;
}

const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
function doc(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
}
