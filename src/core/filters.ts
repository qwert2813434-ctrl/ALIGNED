import { __ } from "../i18n";
// ALIGN Core — 九顆濾鏡。iOS `Engines/FilterEngine.swift` 的移植。
//
// **策略：能烤成查找表的就不要重算。**
//
// - a1/a2/a3/b2 全鏈都是逐像素運算 → 整條鏈烤成 32³ 的 3D 查找表，精確度是構造保證的。
//   （a1 Noir、a2 Mono、a3 Tonal 是 Apple 私有濾鏡，本來就沒有公開參數可抄。）
// - b1/b5/c1/c3/c4 含空間效果（Bloom／半調網點／顆粒），沒辦法整條烤，
//   色彩段用查找表、空間段在這裡實作。
//
// ⚠️ **色調曲線一定要用查找表，不可以照控制點自己刻。** App 的 CIContext 工作空間
//    設成 sRGB，`CIToneCurve` 在該空間下的實際輸出**不會**落在控制點上：
//    以 faded 為例，輸入 0/64/128/192/255 出來是 3/71/129/174/211，
//    而照控制點刻會得到 26/79/136/192/235——整組顏色偏掉。
//
// ⚠️ **顆粒用的是 Apple 的 CIRandomGenerator，TS 無法重現**——但它的重複單元只有
//    256×256，所以整層顆粒（去飽和→強度→偏移→模糊，全套）直接烤成貼片平鋪。
//    不要嘗試導原始噪點自己算：CIRandomGenerator 連 alpha 都是隨機的，存 PNG
//    走預乘會失真（實測自算的顆粒層平均 162 vs 真實 198），而且還得猜對亮度權重、
//    偏移與高斯核。烤成貼片就一個猜測都不剩。
//
// 查找表與噪點場由 `filtertest/main.swift` 產生（配方直接取自 App 原始檔，非手抄），
// 重跑：`./filtertest/run.sh`

const LUT_N = 32;

export interface FilterAssets {
  cube: Map<string, Uint8Array>;    // a1 / a2 / a3 / b2 / mono，每格 RGB 三位元組
  curve: Map<string, Uint8Array>;   // faded / redFilter / infrared / finePaper，256 階
  grain: Map<string, { rgb: Float32Array; alpha: Float32Array }>; // 256×256 貼片，RGB 與 alpha 分存
  dots: Uint8Array;                 // 半調網屏表 32×32×17
}

export const FILTER_KEYS = ["a1", "a2", "a3", "b1", "b2", "b5", "c1", "c3", "c4", "c5"] as const;
export type FilterKey = (typeof FILTER_KEYS)[number];

/** 顯示名與 iOS 的濾鏡面板一致。 */
export const FILTER_LABELS: Record<FilterKey, string> = {
  a1: __("銀鹽硬調"), a2: __("經典中性"), a3: __("褪色霧面"),
  b1: __("紅色濾鏡"), b2: __("正片負沖"), b5: __("仿紅外線"),
  c1: __("報紙"), c3: __("底片顆粒"), c4: __("高級紙"), c5: __("孔版印刷"),
};

/** 3D 查找表，三線性內插。輸入輸出都是 0…255。 */
function cube(lut: Uint8Array, r: number, g: number, b: number, out: number[]): void {
  const s = (LUT_N - 1) / 255;
  const fr = r * s, fg = g * s, fb = b * s;
  const r0 = Math.min(Math.floor(fr), LUT_N - 2), g0 = Math.min(Math.floor(fg), LUT_N - 2), b0 = Math.min(Math.floor(fb), LUT_N - 2);
  const dr = fr - r0, dg = fg - g0, db = fb - b0;
  for (let c = 0; c < 3; c++) {
    let acc = 0;
    for (let i = 0; i < 8; i++) {
      const xr = r0 + (i & 1), xg = g0 + ((i >> 1) & 1), xb = b0 + ((i >> 2) & 1);
      const wr = (i & 1) ? dr : 1 - dr, wg = ((i >> 1) & 1) ? dg : 1 - dg, wb = ((i >> 2) & 1) ? db : 1 - db;
      acc += lut[((xb * LUT_N + xg) * LUT_N + xr) * 3 + c] * wr * wg * wb;
    }
    out[c] = acc;
  }
}

const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

/** CIColorMatrix 三個通道向量設成同一組＝混成灰階。 */
function matrix(d: Uint8ClampedArray, w: [number, number, number]): void {
  for (let i = 0; i < d.length; i += 4) {
    const v = clamp(w[0] * d[i] + w[1] * d[i + 1] + w[2] * d[i + 2]);
    d[i] = d[i + 1] = d[i + 2] = v;
  }
}

function curve1D(d: Uint8ClampedArray, lut: Uint8Array): void {
  for (let i = 0; i < d.length; i += 4) {
    d[i] = lut[d[i]]; d[i + 1] = lut[d[i + 1]]; d[i + 2] = lut[d[i + 2]];
  }
}

function cubeAll(d: Uint8ClampedArray, lut: Uint8Array): void {
  const o = [0, 0, 0];
  for (let i = 0; i < d.length; i += 4) {
    cube(lut, d[i], d[i + 1], d[i + 2], o);
    d[i] = o[0]; d[i + 1] = o[1]; d[i + 2] = o[2];
  }
}

// ── 混合模式（都在 sRGB 編碼域運算，與 App 的工作色彩空間一致）──────────
export const softLightBlend = (b: number, s: number): number => {
  const bn = b / 255, sn = s / 255;
  const d = bn <= 0.25 ? ((16 * bn - 12) * bn + 4) * bn : Math.sqrt(bn);
  const r = sn <= 0.5 ? bn - (1 - 2 * sn) * bn * (1 - bn) : bn + (2 * sn - 1) * (d - bn);
  return r * 255;
};

/** 顆粒貼片取樣：256×256 以 modulo 平鋪（噪點場的重複單元就是 256）。 */
const grainAt = (t: Float32Array, x: number, y: number) => t[(y & 255) * 256 + (x & 255)];

/**
 * 可分離高斯模糊。
 *
 * ⚠️ 不要用「盒狀模糊跑三次」來近似——顆粒用的半徑只有 0.4～1.4，
 * 盒狀半徑至少是 1、再跑三次就糊過頭，c3（純顆粒）的誤差因此從 0.6 變成 5.5。
 * 小半徑一定要用真的高斯核。CI 的 inputRadius 對應到 σ = radius / 2。
 */
function gaussBlur(src: Float32Array, w: number, h: number, radius: number): Float32Array {
  const sigma = radius / 2;
  if (sigma < 0.05) return src;
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
    sum += k[i + r];
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;

  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0, wt = 0;
      for (let i = -r; i <= r; i++) {
        const xx = x + i;
        if (xx < 0 || xx >= w) continue;
        acc += src[y * w + xx] * k[i + r]; wt += k[i + r];
      }
      tmp[y * w + x] = acc / wt;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let acc = 0, wt = 0;
      for (let i = -r; i <= r; i++) {
        const yy = y + i;
        if (yy < 0 || yy >= h) continue;
        acc += tmp[yy * w + x] * k[i + r]; wt += k[i + r];
      }
      out[y * w + x] = acc / wt;
    }
  }
  return out;
}

/**
 * 顆粒疊上去。**必須做 alpha 合成**：顆粒層的 alpha 也是隨機的
 * （CIColorMatrix 只動 RGB 向量、alpha 直接穿過去），而 CISoftLightBlendMode
 * 是 alpha 感知的。當成不透明層直接混，誤差是 12；照標準合成是 2。
 *   Co = (1−αs)·Cb + αs·B(Cb,Cs)     （背景不透明，所以 αb = 1）
 */
function applyGrain(d: Uint8ClampedArray, w: number, h: number,
                    tile: { rgb: Float32Array; alpha: Float32Array }, scale = 1): void {
  // scale<1＝這張圖比輸出小：顆粒取樣要跟著變粗（x/scale 最近鄰），
  // 放大回輸出尺寸後顆粒頻率才會跟全解析度套的一樣
  const inv = 1 / scale;
  for (let y = 0; y < h; y++) {
    const sy = scale === 1 ? y : Math.round(y * inv);
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const sx = scale === 1 ? x : Math.round(x * inv);
      const g = grainAt(tile.rgb, sx, sy);
      const a = grainAt(tile.alpha, sx, sy) / 255;
      for (let c = 0; c < 3; c++) {
        d[i + c] = clamp(d[i + c] * (1 - a) + softLightBlend(d[i + c], g) * a);
      }
    }
  }
}

function multiplyConst(d: Uint8ClampedArray, c: [number, number, number]): void {
  for (let i = 0; i < d.length; i += 4) {
    d[i] = clamp(d[i] * c[0]); d[i + 1] = clamp(d[i + 1] * c[1]); d[i + 2] = clamp(d[i + 2] * c[2]);
  }
}

/** CIBloom 的近似：抽出亮部、模糊、以 screen 疊回。CI 的內部演算法未公開。 */
function bloom(d: Uint8ClampedArray, w: number, h: number, radius: number, intensity: number): void {
  const bright = new Float32Array(w * h);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const lum = d[i] * 0.2126 + d[i + 1] * 0.7152 + d[i + 2] * 0.0722;
    bright[p] = Math.max(0, lum - 128) * 2;
  }
  const blurred = gaussBlur(bright, w, h, radius);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const s = (blurred[p] / 255) * intensity;
    for (let c = 0; c < 3; c++) {
      const bn = d[i + c] / 255;
      d[i + c] = clamp((bn + s - bn * s) * 255);   // screen
    }
  }
}

/**
 * 半調網點。查表版。
 *
 * ⚠️ 不要試著用 sin(x)·sin(y) 去擬合 CIDotScreen——它的網屏函數沒有公開規格，
 * 實測擬合殘差 37/255（等於完全不對）。但它確實是「週期內相對位置 × 輸入亮度」
 * 的函數：**角度 −0.3 rad**（不是配方裡寫的 +0.3，CI 的 y 軸朝上所以符號相反）、
 * 間距 5.0 px。烤成 32×32×17 的表之後殘差降到 3/255。
 */
const DOT_B = 32, DOT_LEVELS = 17, DOT_PITCH = 5.0, DOT_ANGLE = -0.3;

function dotScreen(d: Uint8ClampedArray, w: number, h: number, table: Uint8Array,
                   scale = 1): void {
  const ca = Math.cos(DOT_ANGLE), sa = Math.sin(DOT_ANGLE);
  const plane = DOT_B * DOT_B;
  const pitch = DOT_PITCH * scale;   // 縮小的暫存畫布上，網點間距也要縮同倍率
  for (let y = 0; y < h; y++) {
    // 換回 Core Image 的座標系（原點左下）再旋轉，相位才對得上
    const dy = (h - 1 - y) - h / 2;
    for (let x = 0; x < w; x++) {
      const dx = x - w / 2;
      let rx = (dx * ca - dy * sa) % pitch; if (rx < 0) rx += pitch;
      let ry = (dx * sa + dy * ca) % pitch; if (ry < 0) ry += pitch;
      const bx = Math.min((rx / pitch * DOT_B) | 0, DOT_B - 1);
      const by = Math.min((ry / pitch * DOT_B) | 0, DOT_B - 1);
      const i = (y * w + x) * 4;

      const lf = (d[i] / 255) * (DOT_LEVELS - 1);
      const l0 = Math.min(lf | 0, DOT_LEVELS - 2), t = lf - l0;
      const p = by * DOT_B + bx;
      const v = table[l0 * plane + p] * (1 - t) + table[(l0 + 1) * plane + p] * t;
      d[i] = d[i + 1] = d[i + 2] = clamp(v);
    }
  }
}

/**
 * 套一顆濾鏡。**就地修改** imageData。
 * key 為 null／未知＝原圖不動（與 iOS 相同，舊專案零變動）。
 */
/**
 * @param scale 這張 ImageData 的像素相對於**輸出像素**的倍率（預設 1＝同尺寸）。
 *   影片預覽把 4K 縮進小暫存畫布再套濾鏡：顆粒、網屏、bloom 都是**像素單位**的
 *   空間效果，不縮同倍率的話，放大回畫面上顆粒會比輸出大一大圈——這正是
 *   「預覽跟輸出差很大」的主因之一。LUT／曲線類跟解析度無關，不用動。
 */
export function applyFilter(key: string | null | undefined, img: ImageData, a: FilterAssets,
                            scale = 1): void {
  if (!key) return;
  const d = img.data, w = img.width, h = img.height;
  // c5 孔版：唯一帶參數的濾鏡。身份字串＝"c5" 或 "c5:序列化參數"（見 filterSig），
  // 參數就藏在 key 裡，所以 worker／匯出這些只傳字串的管線一個都不用改。
  if (key === "c5" || key.startsWith("c5:")) { applyRiso(d, w, h, parseRisoSig(key)); return; }
  const lut = (n: string) => a.cube.get(n)!;
  const cv = (n: string) => a.curve.get(n)!;

  switch (key) {
    case "a1": case "a2": case "a3": case "b2":
      cubeAll(d, lut(key));                       // 全鏈逐像素＝查找表就是精確解
      return;
    case "b1":
      matrix(d, [1.60, 0.18, -0.80]);
      curve1D(d, cv("redFilter"));
      bloom(d, w, h, 6.0 * scale, 0.15);
      applyGrain(d, w, h, a.grain.get("b1")!, scale);
      return;
    case "b5":
      matrix(d, [0.2, 1.5, -0.7]);
      curve1D(d, cv("infrared"));
      bloom(d, w, h, 6.0 * scale, 0.4);
      return;
    case "c1":
      cubeAll(d, lut("mono"));
      dotScreen(d, w, h, a.dots, scale);
      multiplyConst(d, [0.91, 0.88, 0.78]);
      applyGrain(d, w, h, a.grain.get("c1")!, scale);
      return;
    case "c3":
      applyGrain(d, w, h, a.grain.get("c3")!, scale);
      return;
    case "c4":
      curve1D(d, cv("finePaper"));
      multiplyConst(d, [0.96, 0.93, 0.87]);
      applyGrain(d, w, h, a.grain.get("c4")!, scale);
      return;
  }
}

/** 載入查找表與顆粒貼片。`applyFilter` 之前必須先跑完。 */
export async function loadFilterAssets(base = "/luts/"): Promise<FilterAssets> {
  const bin = async (n: string) => new Uint8Array(await (await fetch(base + n)).arrayBuffer());
  const cubeNames = ["a1", "a2", "a3", "b2", "mono"];
  const curveNames = ["faded", "redFilter", "infrared", "finePaper"];
  const grainNames = ["b1", "c1", "c3", "c4"];

  const plane = async (file: string): Promise<Float32Array> => {
    const img = new Image();
    await new Promise((ok, err) => { img.onload = ok; img.onerror = err; img.src = base + file; });
    const c = document.createElement("canvas");
    c.width = 256; c.height = 256;
    const cx = c.getContext("2d", { willReadFrequently: true })!;
    cx.drawImage(img, 0, 0);
    const d = cx.getImageData(0, 0, 256, 256).data;
    const out = new Float32Array(256 * 256);
    for (let i = 0, p = 0; i < d.length; i += 4, p++) out[p] = d[i];   // 灰階，取一個通道就好
    return out;
  };
  const tile = async (n: string) => ({
    rgb: await plane(`grain_${n}.png`), alpha: await plane(`grainA_${n}.png`),
  });

  const [cubes, curves, grains, dots] = await Promise.all([
    Promise.all(cubeNames.map((n) => bin(`lut_${n}.bin`))),
    Promise.all(curveNames.map((n) => bin(`curve_${n}.lut`))),
    Promise.all(grainNames.map(tile)),
    bin("dotscreen.bin"),
  ]);

  return {
    cube: new Map(cubeNames.map((n, i) => [n, cubes[i]])),
    curve: new Map(curveNames.map((n, i) => [n, curves[i]])),
    grain: new Map(grainNames.map((n, i) => [n, grains[i]])),
    dots,
  };
}

// ════════════════════ c5 孔版印刷（Risograph）════════════════════
// 正本＝工具間 filter-lab.html（小高在那邊調參數研究）。演算法：把顏色減成 1–3 支
// 油墨（log 空間最小平方分色）→ 各墨 45°/15°/75° AM 過網 → 套印偏移 → multiply
// 疊印回紙色 → 確定性顆粒。與其他濾鏡不同：**帶參數**、且顆粒用確定性雜湊
// （不是 CIRandomGenerator），iOS/Mac 可以逐位一致。
//
// 空間正規化：pitch／reg 的單位＝「長邊 900px 時的 px」（工具間預覽基準，
// 這樣小高在工具間定案的數字搬過來就是同一個長相）。實際間距＝pitch×長邊/900，
// 顆粒取樣座標同除——不同解析度的照片、預覽與匯出，網點相對大小都一樣。

export interface RisoParams {
  inks: string[];   // 1–3 支油墨 hex（不帶 #，schema 慣例同 strokeHex）
  paper: string;    // 紙色 hex
  pitch: number;    // 網點間距（900 基準 px）
  hard: number;     // 網點硬度 0–1
  reg: number;      // 套印偏移（900 基準 px）
  dens: number;     // 油墨濃度倍率
  grain: number;    // 紙張顆粒 0–24
}

/** 定案預設＝工具間「藍＋暖棕」配方（2026-08-31 小高定案）。 */
export const RISO_DEFAULTS: RisoParams = {
  inks: ["236996", "966946"], paper: "DDD7C9",
  pitch: 4, hard: 0.45, reg: 2.25, dens: 0.9, grain: 7,
};

/** 三組定案油墨（工具間同款一鍵配方）。 */
export const RISO_PRESETS: { name: string; inks: string[] }[] = [
  { name: __("藍＋暖棕"), inks: ["236996", "966946"] },
  { name: __("綠＋暖棕"), inks: ["3c7846", "a06e46"] },
  { name: __("單墨・黑"), inks: ["282622"] },
];

/** media 欄位 → 完整參數（absent 補預設；欄位形狀見 schema.ts riso*）。 */
export function risoOf(m: { risoInks?: string[]; risoPaper?: string; risoPitch?: number;
  risoHard?: number; risoReg?: number; risoDens?: number; risoGrain?: number }): RisoParams {
  return {
    inks: (m.risoInks?.length ? m.risoInks : RISO_DEFAULTS.inks).slice(0, 3),
    paper: m.risoPaper ?? RISO_DEFAULTS.paper,
    pitch: m.risoPitch ?? RISO_DEFAULTS.pitch,
    hard: m.risoHard ?? RISO_DEFAULTS.hard,
    reg: m.risoReg ?? RISO_DEFAULTS.reg,
    dens: m.risoDens ?? RISO_DEFAULTS.dens,
    grain: m.risoGrain ?? RISO_DEFAULTS.grain,
  };
}

/**
 * 濾鏡身份字串＝整條管線（變體鍵、切圖鍵、videopool、影片匯出 spec）的濾鏡成分。
 * 普通濾鏡＝代號本身（既有鍵逐位不變）；c5＝代號＋canonical 參數序列化——
 * **參數變了鍵就變**，不同參數不會共用同一份快取（審查點名的靜靜畫錯）。
 */
export function filterSig(m: { filterKey?: string } & Parameters<typeof risoOf>[0]): string | undefined {
  if (m.filterKey !== "c5") return m.filterKey || undefined;
  const p = risoOf(m);
  return `c5:${p.inks.join(",")};${p.paper};${p.pitch};${p.hard};${p.reg};${p.dens};${p.grain}`;
}

export function parseRisoSig(key: string): RisoParams {
  if (!key.includes(":")) return RISO_DEFAULTS;
  const seg = key.slice(key.indexOf(":") + 1).split(";");
  if (seg.length < 7) return RISO_DEFAULTS;
  const num = (v: string, fb: number) => { const n = parseFloat(v); return Number.isFinite(n) ? n : fb; };
  return {
    inks: seg[0].split(",").filter(Boolean).slice(0, 3),
    paper: seg[1] || RISO_DEFAULTS.paper,
    pitch: num(seg[2], RISO_DEFAULTS.pitch), hard: num(seg[3], RISO_DEFAULTS.hard),
    reg: num(seg[4], RISO_DEFAULTS.reg), dens: num(seg[5], RISO_DEFAULTS.dens),
    grain: num(seg[6], RISO_DEFAULTS.grain),
  };
}

// 確定性雜湊（工具間同款）。⚠️ 一定要無號位移 >>>：帶號 >> 的符號延伸會讓
// bit31 自我抵消，輸出永遠 < 0.5（顆粒只變暗、幅度砍半——工具間審查實踩）。
export const hash1u = (i: number, seed: number): number => {
  let s = (i * 374761393 + seed * 668265263) >>> 0;
  s = (s ^ (s >>> 13)) >>> 0; s = Math.imul(s, 1274126177) >>> 0;
  return ((s ^ (s >>> 16)) >>> 0) / 4294967295;
};
export const hash2u = (x: number, y: number, seed: number): number =>
  hash1u((x * 73856093) ^ (y * 19349663), seed);

const hex3 = (hx: string): [number, number, number] => {
  const v = parseInt(hx.replace("#", "").padEnd(6, "0"), 16) || 0;
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};

const RISO_ANGLES = [45, 15, 75];

/**
 * 孔版本體。單趟逐像素、不配置整張浮點平面（24MP 相片 × 3 墨的濃度平面要 288MB，
 * 這裡每像素現解現用）。輸出＝紙色 × Π(1 − cov·(1 − 墨/255))。
 */
export function applyRiso(d: Uint8ClampedArray, w: number, h: number, p: RisoParams): void {
  // 🔴 紙色任何一個通道是 0（純黑、純紅、檸檬黃…色盤上點得到）就會讓 log(x/0)＝∞
  // 灌進分色矩陣，整張照片變成一塊噪點。油墨那邊本來就有 max(c,1)，紙色漏了。
  // 夾到 1 在畫面上與 0 無異（1/255），預設紙色 DDD7C9 逐位不受影響。
  const paper = hex3(p.paper).map((v) => Math.max(v, 1)) as [number, number, number];
  const inks = (p.inks.length ? p.inks : RISO_DEFAULTS.inks).map(hex3);
  const N = inks.length;
  const k5 = Math.max(w, h) / 900;                    // 工具間 900px 預覽基準
  const pitch = Math.max(p.pitch * k5, 0.8);
  const soft = Math.max((0.55 - p.hard * 0.5) * 0.5, 0.02);

  // 分色矩陣 M＝(AᵀA)⁻¹Aᵀ：log 空間最小平方的閉式解，N ≤ 3 直接高斯消去
  const A = inks.map((c) => [0, 1, 2].map((q) => Math.log(Math.max(c[q], 1) / paper[q])));
  const AtA: number[][] = [];
  for (let i = 0; i < N; i++) {
    AtA.push([]);
    for (let j = 0; j < N; j++) AtA[i].push(A[i][0] * A[j][0] + A[i][1] * A[j][1] + A[i][2] * A[j][2]);
  }
  // 高斯–約旦求逆（帶單位陣），N ≤ 3
  const aug = AtA.map((r, i) => r.concat(Array.from({ length: N }, (_, j) => (i === j ? 1 : 0))));
  for (let i = 0; i < N; i++) {
    let piv = i;
    for (let r = i + 1; r < N; r++) if (Math.abs(aug[r][i]) > Math.abs(aug[piv][i])) piv = r;
    [aug[i], aug[piv]] = [aug[piv], aug[i]];
    const pv = aug[i][i] || 1e-9;
    for (let c = 0; c < 2 * N; c++) aug[i][c] /= pv;
    for (let r = 0; r < N; r++) {
      if (r === i) continue;
      const f = aug[r][i];
      for (let c = 0; c < 2 * N; c++) aug[r][c] -= f * aug[i][c];
    }
  }
  // M[n][q]＝第 n 支墨對 log 通道 q 的權重
  const M: number[][] = [];
  for (let n = 0; n < N; n++) {
    M.push([0, 0, 0]);
    for (let q = 0; q < 3; q++) {
      let acc = 0;
      for (let j = 0; j < N; j++) acc += aug[n][N + j] * A[j][q];
      M[n][q] = acc;
    }
  }

  // 每支墨的旋轉基底與套印偏移
  const bases = inks.map((_, n) => {
    const rad = (RISO_ANGLES[n % 3] * Math.PI) / 180;
    return { ca: Math.cos(rad), sa: Math.sin(rad),
             ox: p.reg * k5 * Math.cos(n * 2.1), oy: p.reg * k5 * Math.sin(n * 2.1) };
  });
  const inkF = inks.map((c) => [1 - c[0] / 255, 1 - c[1] / 255, 1 - c[2] / 255]);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      // log 空間目標向量（相對紙色）
      const b0 = Math.log(Math.max(d[i], 1) / paper[0]);
      const b1 = Math.log(Math.max(d[i + 1], 1) / paper[1]);
      const b2 = Math.log(Math.max(d[i + 2], 1) / paper[2]);
      let r = paper[0], g = paper[1], bl = paper[2];
      for (let n = 0; n < N; n++) {
        let dn = M[n][0] * b0 + M[n][1] * b1 + M[n][2] * b2;
        dn = dn < 0 ? 0 : dn > 1 ? 1 : dn;
        if (p.dens !== 1) dn = Math.min(1, dn * p.dens);
        // AM 過網：週期內相對位置 vs 濃度半徑
        const bb = bases[n];
        const px = x + bb.ox, py = y + bb.oy;
        const u = (px * bb.ca + py * bb.sa) / pitch;
        const v = (-px * bb.sa + py * bb.ca) / pitch;
        const fu = u - Math.floor(u) - 0.5, fv = v - Math.floor(v) - 0.5;
        const rr = Math.hypot(fu, fv);
        const R = Math.sqrt(dn) * 0.72;
        const t = (R - rr) / soft;
        const cov = t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
        if (cov > 0) {
          r *= 1 - cov * inkF[n][0];
          g *= 1 - cov * inkF[n][1];
          bl *= 1 - cov * inkF[n][2];
        }
      }
      // 顆粒：確定性雜湊、種子 55、座標除 k5（匯出與預覽同顆粒頻率——工具間同款修法）
      const gr = p.grain ? (hash2u(((x / k5) | 0), ((y / k5) | 0), 55) - 0.5) * p.grain : 0;
      d[i] = clamp(r + gr); d[i + 1] = clamp(g + gr); d[i + 2] = clamp(bl + gr);
    }
  }
}
