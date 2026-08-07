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

export const FILTER_KEYS = ["a1", "a2", "a3", "b1", "b2", "b5", "c1", "c3", "c4"] as const;
export type FilterKey = (typeof FILTER_KEYS)[number];

/** 顯示名與 iOS 的濾鏡面板一致。 */
export const FILTER_LABELS: Record<FilterKey, string> = {
  a1: "銀鹽硬調", a2: "經典中性", a3: "褪色霧面",
  b1: "紅色濾鏡", b2: "正片負沖", b5: "仿紅外線",
  c1: "報紙", c3: "底片顆粒", c4: "高級紙",
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
