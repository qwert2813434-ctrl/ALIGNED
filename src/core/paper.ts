// ALIGN Core — 整頁紙張。iOS `FilterEngine.applyPaperCI` 的移植。
//
// 紙張與區塊濾鏡的差別：**紙張不動內容的像素結構**。報紙的半調網點是區塊濾鏡 c1
// 的事，頁面版只給紙感。這是為了跨頁無縫——與「全系列無暗角」同一條鐵則：
// 任何有結構、有邊際的東西都會在頁縫露餡。
//
// 三層，順序不可換：multiply 紙色 → screen 抬黑 → softLight 纖維。
// 纖維參數與濾鏡 c1/c3/c4 完全相同，所以直接共用同一批顆粒貼片。

import type { FilterAssets } from "./filters";
import { softLightBlend } from "./filters";

interface Paper {
  tint?: [number, number, number];
  lift: number;
  /** 顆粒貼片的鍵——與同名濾鏡共用。 */
  fiber: string;
}

/** PagePaper 的 rawValue 就是 c1/c3/c4，與濾鏡代號同名（iOS 端刻意如此）。
 *  h1/h2＝手抄紙系（2026-08-16 加），不走貼片走整頁程序化生成，見下方 HANDMADE。 */
const PAPERS: Record<string, Paper> = {
  c1: { tint: [0.91, 0.88, 0.78], lift: 0, fiber: "c1" },      // 報紙
  c3: { lift: 0, fiber: "c3" },                                 // 顆粒
  c4: { tint: [0.96, 0.93, 0.87], lift: 0.07, fiber: "c4" },    // 高級紙
  h1: { tint: [0.863, 0.867, 0.784], lift: 0.05, fiber: "" },   // 手抄紙（素淨）
  h2: { tint: [0.863, 0.867, 0.784], lift: 0.05, fiber: "" },   // 粗手抄紙（絮重）
};

// ── 手抄紙（handmade paper）──────────────────────────────────────────────
// C 系紙張的纖維是**均勻噪點**，無結構所以 256 貼片平鋪就無縫；手抄紙的絮是**有結構的**，
// 塞進 256 貼片會看得出重複。所以改成整頁生成一次＋快取（與 iOS 的 paperFiber 同策略）。
// 配方來自樣本間 `01 - 研究/樣本間/濾鏡/紙紋.html`（2026-08-16 使用者選定 ②③）。

interface Handmade {
  fine: number;      // 細纖維根數（瞇眼才看得見的絮）
  coarse: number;    // 粗絮根數（一眼看得到的那幾根）
  specks: number;    // 紙漿雜點顆數
  alpha: number;     // 整層強度倍率（1＝與樣本間 HTML 完全一致）
}

/** 配方在 2160 寬的畫布上寫成（＝1080 設計的 2 倍超取樣）。
 *  **根數固定不隨頁面縮放**——參考圖就是「2160 畫成、縮到 1080 看」，縮放的是尺寸不是數量。
 *  只有長度／線寬按 `頁寬 / 2160` 換算，所以 1x 匯出與 2x 匯出的紙感一模一樣。 */
const HANDMADE_BASE_W = 2160;
const HANDMADE: Record<string, Handmade> = {
  h1: { fine: 900, coarse: 40, specks: 2500, alpha: 1.0 },
  h2: { fine: 3200, coarse: 380, specks: 11000, alpha: 1.0 },
};

/** 整頁纖維層快取，key＝「紙|寬x高」。同一頁尺寸只生成一次。
 *  canvas 是 GPU 路徑用的同一張畫（見 applyPaperGPU），跟陣列同源所以兩路必然同紋。 */
const handmadeCache = new Map<string, { rgb: Float32Array; a: Float32Array; canvas: HTMLCanvasElement }>();

/** 固定種子 LCG——同一張紙每次生成都一模一樣（換頁、重開檔都不會變）。 */
function makeRnd(seed: number): () => number {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

/**
 * 生成整頁的手抄紙纖維層（透明底上的絮與雜點），與樣本間 HTML 同一套畫法。
 *
 * ⚠️ **不能用 softLight 疊**：softLight 的變化量正比於 `b×(1−b)`，在亮底（紙就是亮底）
 * 幾乎歸零，纖維會完全看不見。C 系紙張看得見是因為它的噪點對比極高。
 * 手抄紙改**直接 alpha 合成**（＝HTML 那條路），所見即所得。
 */
function handmadeFiber(key: string, w: number, h: number): { rgb: Float32Array; a: Float32Array; canvas: HTMLCanvasElement } | undefined {
  const r = HANDMADE[key];
  if (!r) return undefined;
  const ck = `${key}|${w}x${h}`;
  const hit = handmadeCache.get(ck);
  if (hit) return hit;

  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const cx = c.getContext("2d", { willReadFrequently: true });
  if (!cx) return undefined;

  const rnd = makeRnd(20260816);
  const s = w / HANDMADE_BASE_W;                // 長度／線寬換算（根數不動）
  const n = (v: number) => v;

  const strokes = (count: number, w0: number, w1: number,
                   aDark: number, aLight: number, l0: number, l1: number): void => {
    for (let i = 0; i < count; i++) {
      const x = rnd() * w, y = rnd() * h;
      const a = rnd() * Math.PI, len = (l0 + rnd() * l1) * s;
      cx.strokeStyle = rnd() > 0.45 ? `rgba(96,98,74,${aDark})` : `rgba(255,255,246,${aLight})`;
      cx.lineWidth = (w0 + rnd() * w1) * s;
      cx.beginPath();
      cx.moveTo(x, y);
      cx.quadraticCurveTo(x + Math.cos(a) * len * 0.5 + (rnd() - 0.5) * 6 * s,
                          y + Math.sin(a) * len * 0.5 + (rnd() - 0.5) * 6 * s,
                          x + Math.cos(a) * len, y + Math.sin(a) * len);
      cx.stroke();
    }
  };
  strokes(n(r.fine), 0.4, 0.7, 0.14, 0.24, 7, 34);      // 細纖維
  strokes(n(r.coarse), 0.9, 0.8, 0.20, 0.30, 16, 50);   // 粗絮
  for (let i = 0; i < n(r.specks); i++) {                // 紙漿雜點
    cx.fillStyle = rnd() > 0.5 ? "rgba(110,112,86,.10)" : "rgba(255,255,248,.16)";
    cx.beginPath();
    cx.arc(rnd() * w, rnd() * h, (0.35 + rnd() * 1.2) * s, 0, 6.284);
    cx.fill();
  }

  const d = cx.getImageData(0, 0, w, h).data;
  const rgb = new Float32Array(w * h * 3);
  const a = new Float32Array(w * h);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    rgb[p * 3] = d[i]; rgb[p * 3 + 1] = d[i + 1]; rgb[p * 3 + 2] = d[i + 2];
    a[p] = d[i + 3] / 255;
  }
  const out = { rgb, a, canvas: c };
  handmadeCache.set(ck, out);
  return out;
}

const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

export function applyPaper(key: string | null | undefined, img: ImageData, a: FilterAssets): void {
  const p = key ? PAPERS[key] : undefined;
  if (!p) return;
  const d = img.data, w = img.width, h = img.height;
  const tile = a.grain.get(p.fiber);
  const hand = key ? handmadeFiber(key, w, h) : undefined;   // 手抄紙走整頁層，不走貼片
  const handA = key && HANDMADE[key] ? HANDMADE[key].alpha : 0;
  const lift = p.lift * 255;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        let v = d[i + c];
        if (p.tint) v *= p.tint[c];                    // multiply 紙色
        if (lift > 0) v = 255 - (255 - v) * (1 - lift / 255);  // screen 抬黑
        d[i + c] = clamp(v);
      }
      if (hand) {
        const p3 = (y * w + x) * 3;
        const al = hand.a[y * w + x] * handA;          // 直接 alpha 合成，不走 softLight
        if (al > 0) {
          for (let c = 0; c < 3; c++) {
            d[i + c] = clamp(d[i + c] * (1 - al) + hand.rgb[p3 + c] * al);
          }
        }
      } else if (tile) {
        const g = tile.rgb[(y & 255) * 256 + (x & 255)];
        const al = tile.alpha[(y & 255) * 256 + (x & 255)] / 255;
        for (let c = 0; c < 3; c++) {
          d[i + c] = clamp(d[i + c] * (1 - al) + softLightBlend(d[i + c], g) * al);
        }
      }
    }
  }
}

// ── GPU 紙張（2026-09-01，只給編輯畫布；匯出仍走上面的 CPU 版逐位不動）─────
// C 系（tint→lift→softLight 纖維）走 **WebGL 片元著色器**：公式跟 CPU 版逐字同源。
// ⚠️ 不能用 canvas 原生 soft-light——實測 WKWebView 的 soft-light 不是 W3C 公式
// （b=32,s=200,α=1 它給 48、規格是 64），而且 Chrome 又是另一套＝跨引擎不一致。
// 手抄紙（h1/h2）三層全是原生可精確表達的操作（multiply／screen／source-over），
// 走 2D 原生合成就好，實測 |Δ|≤2/255 只在捨入。
// 實測（WKWebView 1080×1350）：CPU 30–210ms／頁 → GPU ≤3ms／頁。

// WebGL 單例（lazy）：一張玻璃畫布重複用，換頁只換紋理與 uniform
interface PaperGL {
  canvas: HTMLCanvasElement; gl: WebGLRenderingContext;
  uTint: WebGLUniformLocation; uLift: WebGLUniformLocation; uSize: WebGLUniformLocation;
  uFiberSize: WebGLUniformLocation; uMode: WebGLUniformLocation; uFiberAlpha: WebGLUniformLocation;
  pageTex: WebGLTexture; fiberTex: Map<string, WebGLTexture | null>;
}
let paperGL: PaperGL | null | undefined;   // undefined＝還沒試過；null＝環境不支援
let paperGLLost = 0;                       // context lost 次數；連丟三次就永久退 CPU 不再重建

function initPaperGL(): PaperGL | null {
  if (paperGL !== undefined) return paperGL;
  try {
    const canvas = document.createElement("canvas");
    // premultipliedAlpha:false＝drawImage 拿到的就是著色器寫的直通 alpha 值
    const gl = canvas.getContext("webgl", { premultipliedAlpha: false, alpha: true,
                                            antialias: false, depth: false, stencil: false })!;
    // 🔴 context lost 一定要處理：丟了之後每個 GL 呼叫都靜靜 no-op，畫布變全透明，
    // 而下面是用 `copy` 把它整張蓋回頁面——結果是**整頁被擦成空白，還存進快取**。
    // 睡醒、切換顯示卡、開太多 WebGL context 都會發生。丟了就把單例清掉，下一幀重建；
    // 重建失敗就回 CPU 路（applyPaperGPU 回 false）。
    canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      paperGL = ++paperGLLost >= 3 ? null : undefined;   // 一直丟＝這台機器不適合，別每幀重建
    });
    const vs = gl.createShader(gl.VERTEX_SHADER)!;
    gl.shaderSource(vs, "attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}");
    gl.compileShader(vs);
    const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
    // 公式照 applyPaper／softLightBlend 逐字翻譯，0–1 域。highp：mediump 的 sqrt 會壞比對
    gl.shaderSource(fs, `precision highp float;
uniform sampler2D uPage, uFiber;
uniform vec3 uTint; uniform float uLift; uniform vec2 uSize;
uniform vec2 uFiberSize;    // 貼片 256×256（C 系）或整頁（手抄紙）
uniform float uMode;        // 0＝softLight 貼片；1＝手抄紙直接 alpha 合成
uniform float uFiberAlpha;  // 手抄紙整層強度
float slb(float b, float s){
  float d = b <= 0.25 ? ((16.*b-12.)*b+4.)*b : sqrt(b);
  return s <= 0.5 ? b-(1.-2.*s)*b*(1.-b) : b+(2.*s-1.)*(d-b);
}
void main(){
  // 統一用「頂端起算」的像素座標：跟 CPU 的 (x,y) 與 (x&255,y&255) 一一對齊。
  // gl_FragCoord 原點在左下，翻 y 一次；紋理不翻著上傳（v=0＝影像第一列）。
  vec2 px = vec2(gl_FragCoord.x, uSize.y - gl_FragCoord.y);
  vec4 page = texture2D(uPage, px / uSize);
  vec3 v = page.rgb * uTint;                       // multiply 紙色（無 tint＝(1,1,1)）
  v = 1. - (1. - v) * (1. - uLift);                // screen 抬黑
  vec4 f = texture2D(uFiber, px / uFiberSize);     // 貼片 REPEAT＝CPU 的 x&255
  vec3 outc;
  if (uMode < 0.5) {
    vec3 b = vec3(slb(v.r, f.r), slb(v.g, f.r), slb(v.b, f.r));
    outc = mix(v, b, f.a);
  } else {
    outc = mix(v, f.rgb, f.a * uFiberAlpha);       // 手抄紙：CPU 的直接 alpha 合成同式
  }
  gl_FragColor = vec4(outc, page.a);
}`);
    gl.compileShader(fs);
    const pr = gl.createProgram()!;
    gl.attachShader(pr, vs); gl.attachShader(pr, fs); gl.linkProgram(pr);
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) { paperGL = null; return null; }
    gl.useProgram(pr);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(pr, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const pageTex = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, pageTex);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST],
                          [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]] as const) {
      gl.texParameteri(gl.TEXTURE_2D, k, v);
    }
    gl.uniform1i(gl.getUniformLocation(pr, "uPage"), 0);
    gl.uniform1i(gl.getUniformLocation(pr, "uFiber"), 1);
    paperGL = {
      canvas, gl,
      uTint: gl.getUniformLocation(pr, "uTint")!,
      uLift: gl.getUniformLocation(pr, "uLift")!,
      uSize: gl.getUniformLocation(pr, "uSize")!,
      uFiberSize: gl.getUniformLocation(pr, "uFiberSize")!,
      uMode: gl.getUniformLocation(pr, "uMode")!,
      uFiberAlpha: gl.getUniformLocation(pr, "uFiberAlpha")!,
      pageTex, fiberTex: new Map(),
    };
  } catch { paperGL = null; }
  return paperGL;
}

/** 纖維貼片上傳成 REPEAT 紋理（256 恰是 POT，WebGL1 可 REPEAT）。r＝灰階、a＝強度。 */
function fiberTexture(g: PaperGL, key: string, a: FilterAssets): WebGLTexture | null {
  const hit = g.fiberTex.get(key);
  if (hit !== undefined) return hit;
  const t = a.grain.get(key);
  if (!t) { g.fiberTex.set(key, null); return null; }
  const px = new Uint8Array(256 * 256 * 4);
  for (let i = 0; i < 65536; i++) {
    const v = Math.round(t.rgb[i]);
    px[i * 4] = v; px[i * 4 + 1] = v; px[i * 4 + 2] = v;
    px[i * 4 + 3] = Math.round(t.alpha[i]);
  }
  const { gl } = g;
  const tex = gl.createTexture()!;
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 256, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST],
                        [gl.TEXTURE_WRAP_S, gl.REPEAT], [gl.TEXTURE_WRAP_T, gl.REPEAT]] as const) {
    gl.texParameteri(gl.TEXTURE_2D, k, v);
  }
  g.fiberTex.set(key, tex);
  return tex;
}

/** 手抄紙整頁纖維上傳成紋理（非 POT → CLAMP_TO_EDGE；取樣都在 [0,1] 內）。 */
function handmadeTexture(g: PaperGL, key: string, w: number, h: number): WebGLTexture | null {
  const ck = `hm:${key}|${w}x${h}`;
  const hit = g.fiberTex.get(ck);
  if (hit !== undefined) return hit;
  const hf = handmadeFiber(key, w, h);
  if (!hf) { g.fiberTex.set(ck, null); return null; }
  const { gl } = g;
  const tex = gl.createTexture()!;
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);   // CPU 版也是拿非預乘值算，同源
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, hf.canvas);
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST],
                        [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]] as const) {
    gl.texParameteri(gl.TEXTURE_2D, k, v);
  }
  g.fiberTex.set(ck, tex);
  return tex;
}

/** 回 true＝已在 GPU 上套完；false＝走不了（環境／key），呼叫端 fallback CPU 版。 */
export function applyPaperGPU(ctx: CanvasRenderingContext2D, key: string | null | undefined,
                              a: FilterAssets, opaque: boolean): boolean {
  const p = key ? PAPERS[key] : undefined;
  if (!p || !key) return false;
  const W = ctx.canvas.width, H = ctx.canvas.height;
  const hm = HANDMADE[key];

  if (hm && opaque) {
    // 不透明的手抄紙：multiply＋screen＋source-over 全是引擎規格內的精確操作（0ms 級）。
    // ⚠️ 透明層不能走這裡——multiply fillRect 在反鋸齒邊緣會把顏色漂向未混合的紙色
    // （實測 |Δ| 到 50/255），透明層一律進下面的 WebGL 路（實測 ≤3/255）。
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (p.tint) {
      ctx.globalCompositeOperation = "multiply";
      ctx.fillStyle = `rgb(${Math.round(p.tint[0] * 255)},${Math.round(p.tint[1] * 255)},${Math.round(p.tint[2] * 255)})`;
      ctx.fillRect(0, 0, W, H);
    }
    if (p.lift > 0) {
      const l = Math.round(p.lift * 255);
      ctx.globalCompositeOperation = "screen";
      ctx.fillStyle = `rgb(${l},${l},${l})`;
      ctx.fillRect(0, 0, W, H);
    }
    const hf = handmadeFiber(key, W, H);
    if (hf) {
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = hm.alpha;
      ctx.drawImage(hf.canvas, 0, 0);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
    return true;
  }

  // C 系（任何情況）＋手抄紙透明層：WebGL 一趟（tint＋lift＋softLight 纖維同一個著色器）
  const g = initPaperGL();
  if (!g) return false;
  const { gl } = g;
  // 事件是非同步送達的，這一幀就可能已經丟了——畫之前再問一次，丟了就當場退 CPU
  if (gl.isContextLost()) { paperGL = ++paperGLLost >= 3 ? null : undefined; return false; }
  if (g.canvas.width !== W || g.canvas.height !== H) {
    g.canvas.width = W; g.canvas.height = H;
    gl.viewport(0, 0, W, H);
  }
  const ft = hm ? handmadeTexture(g, key, W, H) : fiberTexture(g, p.fiber, a);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, ft);   // null 也只是黑纖維不炸
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, g.pageTex);
  gl.uniform1f(g.uMode, hm ? 1 : 0);
  gl.uniform1f(g.uFiberAlpha, hm ? hm.alpha : 1);
  gl.uniform2f(g.uFiberSize, hm ? W : 256, hm ? H : 256);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);   // 不翻：著色器自己以頂端起算 y
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, ctx.canvas);
  gl.uniform3f(g.uTint, p.tint?.[0] ?? 1, p.tint?.[1] ?? 1, p.tint?.[2] ?? 1);
  gl.uniform1f(g.uLift, p.lift);
  gl.uniform2f(g.uSize, W, H);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  // 這一趟中途丟掉的話 g.canvas 是全透明的，蓋上去＝整頁被擦白，寧可退 CPU 重畫
  if (gl.isContextLost()) { paperGL = ++paperGLLost >= 3 ? null : undefined; return false; }
  // 畫回 2D：copy＝整張置換（連 alpha），著色器已保留原 alpha 通道
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = "copy";
  // 著色器已把「FB 底列＝影像底列」對齊好，GL 畫布經 drawImage 拿到的就是正的
  ctx.drawImage(g.canvas, 0, 0);
  ctx.restore();
  return true;
}
