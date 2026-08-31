// 濾鏡工人：影片濾鏡的整條像素管線都在這條執行緒上跑。
//
// 主執行緒每格只做兩件 1ms 級的事：new VideoFrame(video)（GPU 把手的零拷貝包裝）
// ＋轉移過來。這裡 drawImage(VideoFrame→512 快取畫布)＋getImageData＋applyFilter
// ＋putImageData 直接畫進 **transferControlToOffscreen 過來的顯示畫布**——
// 連結果都不用運回主執行緒，主執行緒只要把那張 DOM canvas 合成上畫面（0ms 級）。
//
// 為什麼繞這麼大圈（2026-08-09 全部量過）：這台 WKWebView 的主執行緒
// canvas 像素上下 GPU 每條路都毒——getImageData ~170ms、createImageBitmap(video)
// 453ms、GPU 位圖 postMessage 轉移 155ms、putImageData 18ms。工人的軟體 canvas
// 同樣操作是 0–13ms 級，而且卡也只卡工人自己。
import { applyFilter, type FilterAssets } from "./core/filters";

let assets: FilterAssets | null = null;

/** token（file|filter）→ 顯示畫布（主執行緒移交控制權過來的）。 */
const displays = new Map<string, OffscreenCanvas>();
/** token → 縮小快照畫布（重用，別每格新建）。 */
const snaps = new Map<string, OffscreenCanvas>();

type Msg =
  | { type: "assets"; assets: FilterAssets }
  | { type: "canvas"; token: string; off: OffscreenCanvas }
  | { type: "reset" }
  /** c5 參數拖曳每個中間值都是新 token——不逐一丟，displays/snaps 只增不減（審查抓的洩漏）。 */
  | { type: "drop"; token: string }
  | { type: "frame"; token: string; key: string; scale: number; sw: number; sh: number; vf: VideoFrame }
  /** 靜態圖 c5 烤圖（2026-09-01 滑桿卡頓修正）：來源像素先寄一次快取在這，
   *  之後每次參數變只寄 sig 字串，烤完 transfer 回主執行緒貼進變體。 */
  | { type: "bakesrc"; skey: string; w: number; h: number; buf: ArrayBuffer }
  | { type: "bake"; skey: string; sig: string; seq: number; tier: "quick" | "full" };

/** skey（檔名|尺寸）→ 來源像素。位元組預算制：張數上限會讓「兩檔以上輪流調參」
 *  必觸發 needsrc 往返（720＋2560 每檔佔兩格），改成 96MB 上限自然容納多檔的 720，
 *  只有多張 2560 才互擠（審查 fyi）。 */
const bakeSrcs = new Map<string, ImageData>();
let bakeSrcBytes = 0;

self.onmessage = (e: MessageEvent<Msg>): void => {
  const m = e.data;
  if (m.type === "assets") { assets = m.assets; return; }
  if (m.type === "bakesrc") {
    const prev = bakeSrcs.get(m.skey);
    if (prev) bakeSrcBytes -= prev.data.byteLength;
    bakeSrcs.set(m.skey, new ImageData(new Uint8ClampedArray(m.buf), m.w, m.h));
    bakeSrcBytes += m.buf.byteLength;
    while (bakeSrcBytes > 96 * 1024 * 1024 && bakeSrcs.size > 1) {
      const k = bakeSrcs.keys().next().value as string;
      bakeSrcBytes -= bakeSrcs.get(k)!.data.byteLength;
      bakeSrcs.delete(k);
    }
    return;
  }
  if (m.type === "bake") {
    const src = bakeSrcs.get(m.skey);
    if (!src) {   // 來源被擠掉＝叫主執行緒補寄（自癒，不用兩邊對帳）
      (self as unknown as Worker).postMessage({ needsrc: m.skey, sig: m.sig, seq: m.seq, tier: m.tier });
      return;
    }
    bakeSrcs.delete(m.skey); bakeSrcs.set(m.skey, src);   // LRU touch
    const d = new ImageData(new Uint8ClampedArray(src.data), src.width, src.height);
    applyFilter(m.sig, d, assets ?? ({} as FilterAssets));   // c5 不吃材質，assets 沒寄過也安全
    (self as unknown as Worker).postMessage(
      { bake: m.skey, sig: m.sig, seq: m.seq, tier: m.tier, w: d.width, h: d.height, buf: d.data.buffer },
      [d.data.buffer],
    );
    return;
  }
  if (m.type === "canvas") { displays.set(m.token, m.off); return; }
  if (m.type === "reset") { displays.clear(); snaps.clear(); bakeSrcs.clear(); bakeSrcBytes = 0; return; }
  if (m.type === "drop") { displays.delete(m.token); snaps.delete(m.token); return; }
  if (m.type !== "frame") return;

  const t0 = performance.now();
  const vf = m.vf;
  try {
    const display = displays.get(m.token);
    if (!display || !assets) return;
    let snap = snaps.get(m.token);
    if (!snap || snap.width !== m.sw || snap.height !== m.sh) {
      snap = new OffscreenCanvas(m.sw, m.sh);
      snaps.set(m.token, snap);
    }
    const scx = snap.getContext("2d", { willReadFrequently: true })!;
    scx.drawImage(vf, 0, 0, m.sw, m.sh);
    const d = scx.getImageData(0, 0, m.sw, m.sh);
    applyFilter(m.key, d, assets, m.scale);
    if (display.width !== m.sw || display.height !== m.sh) {
      display.width = m.sw; display.height = m.sh;
    }
    display.getContext("2d")!.putImageData(d, 0, 0);
  } finally {
    vf.close();   // VideoFrame 是解碼器資源，不還會把解碼管線堵死
    (self as unknown as Worker).postMessage({
      token: m.token,
      ms: Math.round((performance.now() - t0) * 10) / 10,
    });
  }
};
