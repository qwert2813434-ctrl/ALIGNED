import { __ } from "./i18n";
// 畫布上的影片預覽。
//
// iOS 的畫布上影片是**靜音、自動循環的真播放**（VideoBlockPreview）；Mac 這裡對齊。
//
// 效能架構（2026-08-05 以真專案量測後重設計；當時的專案＝15 支 4K .mov）：
// 1. **只解碼看得見的**——視野外的影片 pause 掉。15 條 4K 解碼管線同時跑，
//    在 WKWebView 上就是「開專案就卡」的主因之一。暫停的影片畫面上停在最後一格
//    （比跳回海報圖安靜）。
// 2. **所有影片都經過暫存畫布**，不讓 `<video>` 直接進 renderStage——
//    WKWebView 的 drawImage(<video>) 每次都走 YUV→RGBA 慢路徑（實測一支 4K 約
//    16–26ms）。轉進暫存畫布後：每個**新影格**轉一次（而不是每次重畫轉一次），
//    而且轉的是縮過的尺寸（長邊上限 1080＝畫布頁寬，預覽不會超過匯出細節）。
// 3. **有新影格才重畫**——requestVideoFrameCallback 舉手才去拿（沒有 rVFC 的環境
//    退回 currentTime 比對）。舊版只要 readyState≥2 就以 20fps 強制整台重畫，
//    影片根本沒出新影格也在畫。
// 4. **同時真播放上限 MAX_LIVE 支**＋**document.hidden 全停**——15 條 4K 解碼
//    一起跑會把 WebContent 逼到被系統砍掉（詳見 MAX_LIVE 註解）。
//
// 兩個沿用的取捨：
// - **匯出仍然畫海報圖**（frames 只餵給編輯畫布）——同一份專案匯出兩次要一模一樣。
// - 有濾鏡的影片套在長邊上限 512px 的暫存畫布上，但空間性效果（顆粒/網屏/bloom）
//   以 scale 參數對齊輸出頻率——預覽顆粒大小＝輸出顆粒大小，只是軟一點。

import type { Project, Rect } from "./core/schema";
import { aspectFillCrop, intersects } from "./core/geometry";
import { rotatedBounds } from "./core/align";
import { applyFilter, type FilterAssets } from "./core/filters";

const LIVE_FPS = 20;
const FILTER_CAP = 512;    // 逐像素濾鏡的成本上限
const PLAIN_CAP = 1080;    // 無濾鏡的轉檔上限（＝畫布頁寬）

/** 同時真播放的上限。2026-08-06 黑盒子實測（分鏡展示＝15 支 4K）：
 *  15 條解碼一起跑，45 秒左右 WebContent 會被系統整個砍掉（silent kill，
 *  wry 靜默重載＝使用者眼裡專案自己消失）。超過上限的取畫面上最大的幾支播，
 *  其餘凍在最後一格——縮到全覽時每支才百來 px，凍結幾乎無感。 */
const MAX_LIVE = 6;

interface LiveVideo {
  el: HTMLVideoElement;
  /** 上一次轉進暫存畫布的影格時間——沒前進就不重轉、不重畫（無 rVFC 時的舊路）。 */
  lastTime: number;
  /** requestVideoFrameCallback 舉手：有「已合成好的」新影格可拿。
   *  這是 2026-08-06 抓到的主兇之一的解法——對還在暖機的 4K 解碼器呼叫
   *  drawImage() 會同步等 GPU 整整 1 秒（黑盒子實測 tickMs≈1004），
   *  開專案後主執行緒被埋 10–20 秒＝「一開就卡死」。rVFC 只在影格真的
   *  存在時舉手，之後的 drawImage 是現成 IOSurface 的拷貝，1ms 等級。 */
  newFrame: boolean;
  /** 這支影片支援 rVFC（Safari 15.4+ 都有；沒有就退回 currentTime 比對）。 */
  rvfc: boolean;
  /** 無濾鏡的縮小影格。 */
  plain?: HTMLCanvasElement;
  /** 濾鏡代號 → 套好濾鏡的縮小影格。 */
  scratch: Map<string, HTMLCanvasElement>;
  /** 濾鏡代號 → 顯示畫布（控制權已移交濾鏡工人；主執行緒只拿它合成）。 */
  display: Map<string, HTMLCanvasElement>;
}


/** 可見性判定用的外接框——必須與 render.ts 的 cullBounds 同數學（旋轉 AABB）。 */
export function videoCullBounds(b: { frame: Rect; rotation: number }): Rect {
  return b.rotation ? rotatedBounds(b.frame, b.rotation) : b.frame;
}

/** pass 1 收集：這個檔案被哪些 block 用、要不要活著。 */
interface FileNeed {
  visible: boolean;
  /** 這個檔在畫面上最大的 block 面積（專案座標）——超過 MAX_LIVE 時排大小用。 */
  area: number;
  /** 濾鏡代號 → 該 block 的（裁切寬fraction, 畫格寬)——算空間濾鏡的 scale 用。 */
  filters: Map<string, { cropW: number; frameW: number; frameH: number }>;
}

/** 每一拍花在「影格轉檔」上的時間上限（ms）。很多支影片同時入鏡時，
 *  超過預算的下一拍再輪（輪替起點會轉），所以是各支平均降 fps、UI 永不被卡死——
 *  而不是全部照轉然後整台掉格。 */
const TICK_BUDGET_MS = 8;

/** 播放器要**掛在文件裡**才會真的前進——WebKit（＝Mac App 的 WKWebView）對
 *  detached 的 <video> 不推進 currentTime（paused 還是 false，純凍結，很陰）。
 *  Chromium 沒這規矩，所以這顆雷只有真 App 踩得到。容器藏在畫面外，
 *  不用 display:none——那個也會讓 WebKit 停解碼。 */
export function hiddenHost(): HTMLElement {
  let host = document.getElementById("videopool-host");
  if (!host) {
    host = document.createElement("div");
    host.id = "videopool-host";
    host.style.cssText = "position:fixed;left:-99999px;top:0;width:2px;height:2px;overflow:hidden;pointer-events:none";
    document.body.append(host);
  }
  return host;
}

export class VideoPool {
  /** 渲染用的即時影格表，鍵同 images（檔名＋濾鏡）。呼叫端拿的是同一個 Map 參照。 */
  readonly frames = new Map<string, CanvasImageSource>();
  /** 轉檔輪替的起點——預算用完時，下一拍從沒輪到的那支開始。 */
  private rotate = 0;
  /** 診斷儀表（?diag=1 用）：上一拍的轉檔耗時／本秒轉了幾格／目前活著幾支。
   *  bmpSyncMs＝createImageBitmap **呼叫本身**的同步耗時峰值（抓 WebKit 偷偷同步讀回）。 */
  readonly stats: {
    tickMs: number; converts: number; playing: number; files: number;
    bmpSyncMs: number; bmpAwaitMs: number; workerMs?: Record<string, number>;
    postMs?: number; replyMs?: number; readMs?: number; workerFrameMs?: number;
  } = { tickMs: 0, converts: 0, playing: 0, files: 0, bmpSyncMs: 0, bmpAwaitMs: 0 };
  /** rVFC 當下拷貝的張數（兩拍之間累計，pump 收進 stats.converts）。 */
  private rvfcConverts = 0;
  /** 檔名 → 播放器。**一個檔一個播放器**，同檔不同濾鏡共用同一條解碼。 */
  private pool = new Map<string, LiveVideo>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private url: ((file: string) => string) | null = null;
  /** 濾鏡工人。undefined＝還沒試著建；null＝這環境建不起來（走同步舊路）。 */
  private worker: Worker | null | undefined;
  /** 已發包、還沒回貨的 token（file|filter）——同一格不重複發，天然掉格。 */
  private inFlight = new Set<string>();

  /**
   * 建濾鏡工人（一次）。成功＝逐像素運算全部離開主執行緒
   * （同步路一次轉檔堵 125ms，是「開著濾鏡會卡」的元兇——2026-08-09 探針）。
   * OffscreenCanvas／createImageBitmap 不支援就回 null，走原本的同步路。
   */
  private ensureWorker(): Worker | null {
    if (this.worker !== undefined) return this.worker;
    try {
      if (typeof OffscreenCanvas === "undefined" || typeof VideoFrame === "undefined"
          || typeof HTMLCanvasElement.prototype.transferControlToOffscreen !== "function") {
        throw new Error(__("環境不支援工人管線"));
      }
      const w = new Worker(new URL("./filterworker.ts", import.meta.url), { type: "module" });
      w.postMessage({ type: "assets", assets: this.filters() });
      w.onmessage = (e: MessageEvent<{ token: string; ms: number }>) => {
        // 工人已直接畫進顯示畫布（控制權在它手上）——這裡只解鎖＋請編輯器合成一次
        this.inFlight.delete(e.data.token);
        this.stats.workerFrameMs = Math.max(this.stats.workerFrameMs ?? 0, e.data.ms);
        this.onFrame();
      };
      w.onerror = () => { this.worker = null; };   // 工人掛了＝之後全走同步舊路
      this.worker = w;
    } catch {
      this.worker = null;
    }
    return this.worker;
  }

  constructor(
    private project: () => Project | null,
    private filters: () => FilterAssets,
    private onFrame: () => void,
    /** 目前「看得見」的區域（專案座標，可多塊——匯出台是頁的集合）。
     *  null＝全部暫停。兩邊（渲染裁切、解碼開關）必須看同一份視野。 */
    private visible: () => Rect[] | null = () => null,
  ) {}

  /** 這份專案的影片素材怎麼變成 URL。null＝這個來源沒有素材（裸 JSON），只畫海報。 */
  attach(resolve: ((file: string) => string) | null): void {
    this.stop();
    this.url = resolve;
    if (!resolve) return;
    // 沒有影片 block 也照樣起拍：之後拖進來／填進來的影片才會自己接上
    // （每一拍只是掃一遍 blocks，空專案等於零成本）
    this.pump();
    this.timer = setInterval(() => this.pump(), 1000 / LIVE_FPS);
  }

  /** 暫停／恢復所有影片（工具列播放鍵用）。
   *  跟 stop() 不同：不釋放解碼器、不清畫格表，只是不再前進——按下播放能立刻接回去。 */
  private paused = false;
  setPaused(on: boolean): void {
    this.paused = on;
    if (on) for (const v of this.pool.values()) if (!v.el.paused) v.el.pause();
  }
  get isPaused(): boolean { return this.paused; }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    for (const v of this.pool.values()) this.release(v);
    this.pool.clear();
    for (const f of this.frames.values()) if (f instanceof ImageBitmap) f.close();
    this.frames.clear();
    this.inFlight.clear();   // 換專案＝路上的包裹全作廢，別讓舊 token 擋住新發包
    this.worker?.postMessage({ type: "reset" });   // 工人那邊的顯示畫布表也清掉
  }

  private release(v: LiveVideo): void {
    v.el.pause();
    v.el.removeAttribute("src");
    v.el.load();   // 真的放掉解碼器——只 pause 的話換幾次專案就會疊出一堆
    v.el.remove();
  }

  /** 把當前影格拷進無濾鏡暫存畫布並通知重畫。**rVFC 舉手的當下**呼叫——
   *  跟片子自己的節奏走（24 格片就是 24fps）。丟給 20Hz 節拍器批次處理的話：
   *  (a) 24 格收不滿＝抽格；(b) 拖到下一拍才 drawImage，影格可能已換到一半。
   *  單次拷貝實測 0.3ms 等級（影格現成時 drawImage 是 IOSurface 拷貝）。 */
  private copyPlain(file: string, live: LiveVideo): void {
    const el = live.el;
    if (document.hidden || !el.videoWidth) return;
    if (!live.plain) {
      const k = Math.min(1, PLAIN_CAP / Math.max(el.videoWidth, el.videoHeight));
      live.plain = document.createElement("canvas");
      live.plain.width = Math.max(2, Math.round(el.videoWidth * k));
      live.plain.height = Math.max(2, Math.round(el.videoHeight * k));
    }
    live.plain.getContext("2d")!.drawImage(el, 0, 0, live.plain.width, live.plain.height);
    if (this.frames.get(file) !== live.plain) this.frames.set(file, live.plain);
    this.rvfcConverts++;
    this.onFrame();
  }

  /** 每一拍：只養「看得見」的影片，且只在有新影格時轉檔＋通知重畫。 */
  private pump(): void {
    const p = this.project();
    const url = this.url;
    if (!p || !url) return;
    // 整個 App 不在螢幕上（收到背景/被蓋住）＝全部停解碼。
    // 15 條 4K 解碼在背景燒電池毫無意義，而且燒久了 WebContent 會被系統盯上
    if (document.hidden || this.paused) {
      for (const v of this.pool.values()) if (!v.el.paused) v.el.pause();
      this.stats.playing = 0;
      return;
    }
    const vis = this.visible();

    // pass 1：每個檔案的需求（可見性、濾鏡與其幾何）
    const need = new Map<string, FileNeed>();
    for (const b of p.blocks) {
      if (b.content.type !== "video") continue;
      const m = b.content.media;
      if (!m.assetFileName) continue;
      let n = need.get(m.assetFileName);
      if (!n) { n = { visible: false, area: 0, filters: new Map() }; need.set(m.assetFileName, n); }
      // 用**旋轉 AABB** 判可見——渲染裁切（render.ts cullBounds）也是這個形狀。
      // 兩邊不一致的話，轉過的影片會「畫得到卻停止解碼」＝畫面上凍結
      if (vis?.some((r) => intersects(videoCullBounds(b), r))) {
        n.visible = true;
        n.area = Math.max(n.area, b.frame.w * b.frame.h);
      }
      if (m.filterKey && !n.filters.has(m.filterKey)) {
        n.filters.set(m.filterKey, {
          cropW: m.cropRect.w, frameW: b.frame.w, frameH: b.frame.h,
        });
      }
    }
    // 可見的超過 MAX_LIVE：只播畫面上最大的幾支，其餘視同不可見（凍最後一格）
    const inView = [...need.values()].filter((n) => n.visible);
    if (inView.length > MAX_LIVE) {
      inView.sort((a, b) => b.area - a.area);
      for (const n of inView.slice(MAX_LIVE)) n.visible = false;
    }

    let drew = false;
    let converts = 0;
    const t0 = performance.now();
    let budgetOut = false;
    const files = [...need.keys()];
    for (let step = 0; step < files.length; step++) {
      const file = files[(this.rotate + step) % files.length];
      const n = need.get(file)!;
      let live = this.pool.get(file);
      if (!n.visible) {
        // 看不見＝停解碼。畫面停在最後一格（frames 留著），回到視野再繼續播
        if (live && !live.el.paused) live.el.pause();
        continue;
      }
      if (budgetOut) continue;   // 預算用完：播放器照管（上面幾行），轉檔下一拍輪
      if (!live) {
        const el = document.createElement("video");
        el.muted = true; el.loop = true; el.playsInline = true; el.preload = "auto";
        const src = url(file);
        // 媒體伺服器（127.0.0.1）跨源：要 anonymous＋伺服器的 ACAO 頭，
        // 畫進 canvas 才不會 taint（濾鏡 getImageData 與 ⌘E 匯出都會死）
        if (src.startsWith("http")) el.crossOrigin = "anonymous";
        el.src = src;
        hiddenHost().append(el);     // 必須進 DOM，理由見 hiddenHost
        el.play().catch(() => {});   // 靜音自動播放瀏覽器允許；真失敗就維持海報圖
        const v: LiveVideo = { el, lastTime: -1, newFrame: false, rvfc: false, scratch: new Map(), display: new Map() };
        if ("requestVideoFrameCallback" in el) {
          v.rvfc = true;
          const arm = (): void => {
            el.requestVideoFrameCallback(() => {
              this.copyPlain(file, v);   // 舉手當下拷＝原生節奏，理由見 copyPlain
              v.newFrame = true;         // 濾鏡版貴，留給 pump 的預算制
              arm();
            });
          };
          arm();
        }
        live = v;
        this.pool.set(file, live);
      }
      const el = live.el;
      if (el.paused) el.play().catch(() => {});
      if (live.rvfc) {
        // plain 影格已在 rVFC 舉手當下拷走（copyPlain）；這裡只剩濾鏡版要轉。
        // 沒舉手絕不碰 video——對暖機中的解碼器 drawImage 會同步卡 1 秒
        if (!live.newFrame || n.filters.size === 0) continue;
      } else {
        if (el.readyState < 2 || !el.videoWidth) continue;   // 還沒有可畫的影格
        if (el.currentTime === live.lastTime) continue;      // 沒有新影格＝什麼都不做
        live.lastTime = el.currentTime;
      }
      live.newFrame = false;
      if (!el.videoWidth) continue;

      // 無濾鏡（只有沒 rVFC 的舊路走這裡；rVFC 路在 copyPlain 已拷）
      if (!live.rvfc) {
        const kPlain = Math.min(1, PLAIN_CAP / Math.max(el.videoWidth, el.videoHeight));
        if (!live.plain) {
          live.plain = document.createElement("canvas");
          live.plain.width = Math.max(2, Math.round(el.videoWidth * kPlain));
          live.plain.height = Math.max(2, Math.round(el.videoHeight * kPlain));
        }
        live.plain.getContext("2d")!.drawImage(el, 0, 0, live.plain.width, live.plain.height);
        if (this.frames.get(file) !== live.plain) this.frames.set(file, live.plain);
        drew = true;
        converts++;
      }

      // 有濾鏡：逐格套在 512 上限的暫存畫布；空間性效果用 scale 對齊輸出頻率
      // （rVFC 路的濾鏡版也走這裡＝上限 20fps，逐像素濾鏡跟原生節奏跑不動）
      for (const [fk, geo] of n.filters) {
        const k = Math.min(1, FILTER_CAP / Math.max(el.videoWidth, el.videoHeight));
        const sw = Math.max(2, Math.round(el.videoWidth * k));
        const sh = Math.max(2, Math.round(el.videoHeight * k));
        // scale＝「暫存畫布的一像素」對「輸出的一像素」：輸出把裁切區縮放到 block
        // 像素寬（bakeClip 的 target），暫存畫布上同一段裁切區是 cropW×sw 寬
        const cropW = (geo.cropW === 1 && sw && sh)
          ? aspectFillCrop(el.videoWidth, el.videoHeight, geo.frameW, geo.frameH).w
          : geo.cropW;
        const scale = (cropW * sw) / geo.frameW;   // >1 也成立（大影片塞小 block）

        // 首選：VideoFrame 直送濾鏡工人。主執行緒每格只花 ~2ms（包影格＋轉移）；
        // 讀回／濾鏡／上屏全在工人，結果直接畫進控制權已移交的顯示畫布。
        // 為什麼不走別條（全部量過、全是毒）：主緒 getImageData ~170ms、
        // createImageBitmap(video) 453ms、GPU 位圖轉移 155ms、主緒 putImageData 18ms。
        const w = this.ensureWorker();
        if (w) {
          const token = `${file}|${fk}`;
          if (this.inFlight.has(token)) continue;   // 上一格還在路上＝這格自然掉，不排隊
          let disp = live.display.get(fk);
          if (!disp) {
            // 顯示畫布：建一次、控制權移交工人；frames 直接掛它，渲染端 drawImage 合成（0ms 級）
            disp = document.createElement("canvas");
            disp.width = sw; disp.height = sh;
            const off = disp.transferControlToOffscreen();
            w.postMessage({ type: "canvas", token, off }, [off]);
            live.display.set(fk, disp);
          }
          if (this.frames.get(token) !== disp) this.frames.set(token, disp);
          try {
            const vf = new VideoFrame(el);
            this.inFlight.add(token);
            w.postMessage({ type: "frame", token, key: fk, scale, sw, sh, vf }, [vf as unknown as Transferable]);
            converts++;
          } catch { /* 這格抓不到就下一拍再來 */ }
          continue;
        }

        // 退路（老 WebKit 沒有 OffscreenCanvas）：原本的同步路
        let sc = live.scratch.get(fk);
        if (!sc) {
          sc = document.createElement("canvas");
          sc.width = sw; sc.height = sh;
          live.scratch.set(fk, sc);
        }
        const cx = sc.getContext("2d", { willReadFrequently: true })!;
        cx.drawImage(el, 0, 0, sc.width, sc.height);
        const d = cx.getImageData(0, 0, sc.width, sc.height);
        applyFilter(fk, d, this.filters(), scale);
        cx.putImageData(d, 0, 0);
        this.frames.set(`${file}|${fk}`, sc);
        drew = true;
        converts++;
      }
      if (performance.now() - t0 > TICK_BUDGET_MS) {
        budgetOut = true;
        this.rotate = (this.rotate + step + 1) % files.length;   // 下一拍從下一支接著輪
      }
    }

    this.stats.tickMs = Math.round(performance.now() - t0);
    this.stats.converts = converts + this.rvfcConverts;   // 本拍濾鏡版＋兩拍間 rVFC 拷貝
    this.rvfcConverts = 0;
    this.stats.files = need.size;
    this.stats.playing = [...this.pool.values()].filter((v) => !v.el.paused).length;

    // 已經不在專案裡的影片：收掉解碼器
    for (const [file, live] of this.pool) {
      if (need.has(file)) continue;
      this.release(live);
      this.pool.delete(file);
      for (const k of [...this.frames.keys()]) {
        if (k === file || k.startsWith(`${file}|`)) this.frames.delete(k);
      }
    }
    if (drew) this.onFrame();
  }
}
