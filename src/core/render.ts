// ALIGN Core — canvas 渲染。
//
// 渲染模型直譯自 iOS 的 PageExportRenderer：把整個 stage 的 block 依 zIndex 排序，
// 過濾出與本頁矩形相交的，平移到頁內座標後畫，最後靠 clip 裁掉溢出的部分。
// **跨頁 bleed 沒有特例處理**——clip 就是「跨頁切割」的全部。
//
// 文字的定位鐵則：block frame 貼的是**墨跡**不是排版框（iOS 的 TextInkInset）。
// canvas 的 actualBoundingBoxAscent 就是墨跡上緣，所以把基線放在
// frame.y + actualBoundingBoxAscent 就等於 iOS 的貼字盒。這是文字會不會落在對的
// 位置的關鍵，不是細節。

import type { Block, MediaBlock, Project, Rect, ShapeBlock, TextBlock } from "./schema";
import { hex, resolvedFontSize, resolvedKerning } from "./schema";
import { aspectFillCrop, intersects, pageRect } from "./geometry";
import { cssFont } from "./fonts";
import type { GuideLine, SpacingBadge } from "./align";
import type { FilterAssets } from "./filters";
import { filterSig } from "./filters";
import { tornOf, tornCanvases } from "./tornedge";
import { applyPaper, applyPaperGPU } from "./paper";
import { animStateAt, carouselAt, maskWipeState, revealText, type BlockAnim } from "./anim";
import { drawDoodle } from "./doodle";
import { freeIntervals, wrapHoles } from "./textwrap";

/** 直排的預設欄距（em）。iOS：baseline 1.5em 減掉 defaultVerticalLineSpacing 0.28em。 */
const VERTICAL_PITCH_EM = 1.22;

export interface RenderOptions {
  /** 缺圖時畫佔位框（範本的 asset 是被剝掉的，正常）。 */
  placeholderForMissingMedia?: boolean;
  /** 去背遮罩查表：鍵＝`matte:<檔名>` 或 `matte:<檔名>!`（反轉），值＝已轉好的 alpha 畫布。
   *  由 main.ts 的 matteCanvas 在載入時轉一次；渲染只做一次 destination-in。 */
  mattes?: Map<string, CanvasImageSource>;
  images?: Map<string, CanvasImageSource>;
  /**
   * 影片的**即時影格**（`<video>` 或已套濾鏡的暫存畫布），鍵同 images。
   * 只有編輯畫布傳——匯出維持海報圖，PNG 才有決定性（同一份專案匯出兩次要一樣）。
   */
  videos?: Map<string, CanvasImageSource>;
  /** 3D 物件的渲染入口（modelpool）。未給＝3D block 畫佔位框。
   *  用介面不用 Map——角度由 time 決定，得現場算，快取在 pool 自己手上。 */
  models?: { render(b: Block, time?: number): CanvasImageSource | undefined };
  /** 整頁紙張需要顆粒貼片。未提供＝不套紙張。 */
  filters?: FilterAssets;
  /** 行內編輯中的 block——畫布跳過不畫（DOM 編輯層在上面，畫了就疊影）。 */
  skipBlockId?: string;
  /** 只畫這些 block（影片匯出要把「影片上下的靜態圖層」分段渲染）。未給＝全畫。 */
  onlyBlockIds?: Set<string>;
  /** 不畫頁面底色，留透明（分段圖層要疊在影片上，只有最底那段畫背景）。 */
  transparent?: boolean;
  /** 出場動畫：時間（秒）與每個 block 的設定。未給＝靜態（舊行為，零變動）。 */
  time?: number;
  anims?: Map<string, BlockAnim>;
  /** 輸出倍率（只有 renderPageCanvas 吃）：2＝畫布兩倍像素，16:9 畫布即 4K。
   *  文字與形狀是向量重畫所以是真解析度，不是放大圖。 */
  scale?: number;
  /** 編輯畫布的視野（專案座標）。給了就跳過視野外的頁與 block——
   *  clip 語意不變，只是不畫看不見的。匯出／縮圖不給＝全畫。 */
  viewRect?: Rect;
  /** 紙張走 GPU 原生混合（**只有編輯畫布開**）。匯出／縮圖一律不開＝CPU 版逐位不動；
   *  兩路數學同式（見 paper.ts applyPaperGPU 檔頭），差別只在反鋸齒邊緣 ≤1/255 級。
   *  紙張＋影片頁的 8→60fps 就是這一顆（2026-09-01，卡頓根因＝每幀整頁 CPU 逐畫素）。 */
  paperGPU?: boolean;
}

/** 視野裁切用的外接框：轉過的 block 用旋轉 AABB，沒轉的直接用 frame。 */
function cullBounds(b: Block): Rect {
  if (!b.rotation) return b.frame;
  const r = (b.rotation * Math.PI) / 180;
  const c = Math.abs(Math.cos(r)), sn = Math.abs(Math.sin(r));
  const w = b.frame.w * c + b.frame.h * sn, h = b.frame.w * sn + b.frame.h * c;
  return { x: b.frame.x + b.frame.w / 2 - w / 2, y: b.frame.y + b.frame.h / 2 - h / 2, w, h };
}

/** 這一頁「畫得到」的 block，已依 z 序排好。**renderPage 與分層紙張共用這一份**——
 *  兩邊各自 filter 的話，遲早會出現「有紙張的那層少畫一個東西」這種鬼。 */
function pageBlocks(project: Project, page: Rect, opts: RenderOptions): Block[] {
  return project.blocks
    .filter((b) => intersects(b.frame, page) && b.id !== opts.skipBlockId
                   && (!opts.onlyBlockIds || opts.onlyBlockIds.has(b.id))
                   && (!opts.viewRect || intersects(cullBounds(b), opts.viewRect)))
    .sort((a, b) => a.zIndex - b.zIndex);
}

/** 紙張套用範圍。未設＝全都套（舊檔零變動）。 */
export function paperScope(p: Project): { objects: boolean; background: boolean; text: boolean } {
  return {
    objects: p.paperOnObjects !== false,
    background: p.paperOnBackground !== false,
    text: p.paperOnText !== false,
  };
}

/** 這個 block 屬於紙張範圍的哪一類。 */
const paperClassOf = (b: Block): "text" | "objects" =>
  (b.content.type === "text" || b.content.type === "textFlow" ? "text" : "objects");

/**
 * 單頁渲染成原尺寸的 canvas。**匯出與編輯預覽共用這條路**，兩者不可能分家。
 * iOS 的 ImageRenderer 用 scale 1——畫布尺寸本身就是目標像素，沒有 2x/3x。
 */
/**
 * 整頁烤好的結果快取。
 *
 * 紙張是**整頁的逐畫素運算**，開了之後每一頁每一幀都要：開一張整頁離屏畫布 →
 * 畫整頁 → `getImageData` 讀回 CPU → 逐畫素套紙 → 寫回 → 貼上去。讀回 CPU 是
 * 畫布上最貴的操作（會逼 GPU 停下來等）。而且不是全套的時候還要照 z 序分段，
 * 每段各一張整頁畫布。2026-08-30 小高那份實測：5 頁、17 塊，**每一幀 12 次整頁
 * 渲染＋5 次整頁讀回＝730 萬畫素的 CPU 迴圈**，平移一下就卡死。
 *
 * 但平移、縮放的時候頁面內容一個畫素都沒變。所以整頁存一張，內容沒變就直接貼。
 * 鑰匙走 `blockSig` 那套（見它的檔頭）：新增欄位自動涵蓋，不必回來改這裡。
 */
const _pageCache = new Map<string, HTMLCanvasElement>();
// 同一頁會有好幾種變體：畫布（S=1）、膠捲、卡片縮圖、匯出（S=2）各一張。
// 五頁的專案就可能同時要 15–20 張——上限訂 8 的話它們會互相擠掉，
// 每一幀全部重算，比沒有快取還糟（2026-08-30 差點踩到）。真正的煞車是總畫素。
const PAGE_CACHE_MAX = 32;
/** 2400 萬畫素 ≈ 96 MB。一頁 1080×1350 是 146 萬，所以編輯時八張都放得下。 */
const PAGE_CACHE_PIXELS = 24_000_000;

/**
 * 這一塊會不會「同樣的資料、不同的時間，畫出來不一樣」。會的話整頁就不能存。
 *
 * 五種：正在跑出場動畫、3D（角度由 pool 現算）、塗鴉的巡線／抖動、多圖輪播、
 * 影片的即時影格。其餘的（照片、文字、形狀、靜態塗鴉）跟時間無關，
 * **就算畫布正在「播放中」也照樣可以存**。
 */
function timeDependent(b: Block, opts: RenderOptions): boolean {
  if (opts.anims?.has(b.id)) return true;
  if (opts.time !== undefined && b.anim) return true;
  const c = b.content;
  if (c.type === "model") return true;
  if (c.type === "doodle") return !!(c.doodle.play || c.doodle.wobble);
  if (c.type === "image" || c.type === "video") {
    const m = c.media;
    if (m.carouselAssets?.length) return true;
    const sig = filterSig(m);
    const suffix = sig ? `|${sig}` : "";
    if (opts.videos?.get(m.assetFileName + suffix)) return true;
  }
  return false;
}

/**
 * 這一頁「畫出來會長怎樣」由什麼決定。回 null＝這一頁不可以快取。
 *
 * 不可以快取的三種內容——它們的畫面會變、但 block 的 JSON 不會變，
 * 存起來就會凍住（**這種錯不會報錯，只會看起來壞掉**，所以寧可保守）：
 *   ① 動畫播放中（每一格的位置都不同）
 *   ② 影片的即時影格（同一張 canvas 一直被覆寫，身分編號抓不到它變了）
 *   ③ 3D 物件（角度由 pool 現算，也不在 JSON 裡）
 *
 * `pageBlocks` 已經把 `skipBlockId`／`onlyBlockIds`／`viewRect` 過濾掉了，
 * 所以那三個選項自動反映在下面的清單裡，不必另外進鑰匙。
 */
function pageSig(project: Project, index: number, opts: RenderOptions, S: number): string | null {
  const page = pageRect(project, index);
  const blocks = pageBlocks(project, page, opts);
  // ⚠️ 判斷「這一頁會不會隨時間變」要看**這一頁上真的有沒有會動的東西**，
  // 不能看 `opts.time` 有沒有值。畫布開檔就是「播放中」，即使整份專案一個動畫
  // 都沒有，time 仍然每幀都被設——照 time 判斷等於把整頁快取永久關掉，
  // 而且面板還會顯示「命中 0・重算 0」，看起來像沒被呼叫（2026-08-30 小高錄影實測：
  // 切圖全命中、整頁永遠 0／0、卻還是 180 ms 一幀，就是這個）。
  for (const b of blocks) if (timeDependent(b, opts)) return null;
  let h = fnv(`${index}|${S}|${project.paperKey ?? ""}|${project.pageHeight}|${project.canvasWidth}`);
  h = fnv(`${project.paperOnObjects}|${project.paperOnBackground}|${project.paperOnText}`, h);
  // paperGPU 進 sig：編輯畫布（GPU 紙）與匯出（CPU 紙）像素有反鋸齒邊緣級的差，
  // 共用同一格快取會讓匯出拿到 GPU 版——兩路必須各自一格
  h = fnv(`${!!opts.transparent}|${!!opts.filters}|${!!opts.placeholderForMissingMedia}|${!!opts.paperGPU}`, h);
  h = fnv(`${JSON.stringify(project.pageBackgroundHex ?? null)}`, h);
  for (const b of blocks) h = fnv(`|${blockSig(b, opts)}`, h);
  return String(h);
}

/**
 * 對外版：**永遠回一張自己的畫布**。
 *
 * ⚠️ 不可以把快取那張本尊交出去。膠捲會把拿到的 canvas 直接塞進 DOM、掛點擊與
 * 拖曳事件；卡片縮圖會拿去縮。一個 DOM 節點只能待在一個地方，本尊被搬走之後
 * 畫布那邊還在拿它畫，事件也會一輪一輪疊上去。複製一張只是一次 drawImage，
 * 比重畫整頁＋逐畫素套紙便宜好幾個數量級（2026-08-30，這是加快取當天埋的雷）。
 */
/** WKWebView 鐵則（2026-08-31 小高「匯出掉字型/掉標點、套紙後窄體消失」三症狀的統一根因）：
 *  **沒掛進 DOM 的 canvas 走另一條殘缺的字型解析路**——使用者自裝字型整個解析不到
 *  （整段回落襯線備援）、缺字備援在 normal 字重下直接畫豆腐（・①→□）。
 *  Chrome 沒這病所以 dev 測不到，正式版（WKWebView）才發作。
 *  對策：**所有會畫文字的離屏畫布一律掛進這個隱形 host**（display:none 不進排版、
 *  實測掛著畫與可見畫逐位相同；畫完移除也安全——位圖還在，只是之後再畫字會退化）。 */
let _canvasHost: HTMLDivElement | null = null;
export function attachedCanvas(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  if (typeof document !== "undefined" && document.body) {
    if (!_canvasHost || !_canvasHost.isConnected) {
      _canvasHost = document.createElement("div");
      _canvasHost.style.display = "none";
      _canvasHost.dataset.role = "offscreen-canvas-host";
      document.body.append(_canvasHost);
    }
    _canvasHost.append(c);
  }
  return c;
}

export function renderPageCanvas(project: Project, index: number, opts: RenderOptions = {}): HTMLCanvasElement {
  const c = pageCanvas(project, index, opts);
  // ⚠️ 不可快取那張也要複製：內部畫布掛在隱形 host（字型鐵則）且排了微任務回收，
  // 直接交出去會在下一輪微任務被 remove()——膠捲/匯出台把它塞進 DOM 後畫面瞬間消失
  // （2026-09-01 實病：去背宣傳2 的動畫塗鴉頁縮圖全空白）。「對外永遠回複製品」無例外。
  const copy = document.createElement("canvas");
  copy.width = c.canvas.width; copy.height = c.canvas.height;
  copy.getContext("2d")!.drawImage(c.canvas, 0, 0);
  return copy;
}

/** 內部版：畫布每一幀都在呼叫，直接用快取那張不複製（只拿去 drawImage，不進 DOM）。 */
function pageCanvas(
  project: Project, index: number, opts: RenderOptions,
): { canvas: HTMLCanvasElement; shared: boolean } {
  const page = pageRect(project, index);
  const S = opts.scale ?? 1;
  const sig = pageSig(project, index, opts, S);
  if (sig) {
    const hit = _pageCache.get(sig);
    if (hit) {
      _pageCache.delete(sig); _pageCache.set(sig, hit);   // LRU
      renderCounters.pageHit++;
      return { canvas: hit, shared: true };
    }
    renderCounters.pageMiss++;
  } else {
    renderCounters.pageSkip++;
  }
  const c = attachedCanvas();   // 畫文字：必掛 DOM（見 attachedCanvas 的 WKWebView 鐵則）
  c.width = Math.round(page.w * S);
  c.height = Math.round(page.h * S);
  if (!sig) queueMicrotask(() => c.remove());   // 不進快取＝用完即棄；同步呼叫端畫完才輪到微任務
  const ctx = c.getContext("2d", { willReadFrequently: !!project.paperKey && !opts.paperGPU })!;
  if (S !== 1) ctx.scale(S, S);   // renderPage 照樣畫頁座標，transform 負責放大
  const hasPaper = !!project.paperKey && !!opts.filters;
  const scope = paperScope(project);
  const keep = (): { canvas: HTMLCanvasElement; shared: boolean } => {
    if (sig) {
      _pageCache.set(sig, c);
      // 張數與總畫素兩道上限：匯出 2× 的整頁是 23 MB 一張，只看張數會吃掉快 200 MB
      let px = 0;
      for (const v of _pageCache.values()) px += v.width * v.height;
      while (_pageCache.size > PAGE_CACHE_MAX
             || (px > PAGE_CACHE_PIXELS && _pageCache.size > 1)) {
        const oldest = _pageCache.keys().next().value as string;
        const oc = _pageCache.get(oldest);
        px -= (oc?.width ?? 0) * (oc?.height ?? 0);
        oc?.remove();   // 逐出＝也從隱形 host 卸下
        _pageCache.delete(oldest);
      }
    }
    return { canvas: c, shared: !!sig };
  };

  // 有紙張、而且**不是全套**：分層畫（背景一層＋依 z 序把連續同設定的段各一層），
  // 只在該套的那幾層套紙。分段而不是「先畫全部再補畫例外」——後者會把 z 序弄亂。
  if (hasPaper && !(scope.objects && scope.background && scope.text)) {
    const blocks = pageBlocks(project, page, opts);
    const layer = (ids: Set<string> | undefined, bg: boolean, paper: boolean): void => {
      const lc = attachedCanvas();   // 這層也畫文字，同一條鐵則
      lc.width = c.width; lc.height = c.height;
      const lx = lc.getContext("2d", { willReadFrequently: !opts.paperGPU })!;
      if (S !== 1) lx.scale(S, S);
      // 只有背景層畫底色，其餘層一律透明；呼叫端要求透明匯出時連背景層也不填
      renderPage(lx, project, index, {
        ...opts, onlyBlockIds: ids ?? new Set(), transparent: bg ? !!opts.transparent : true,
      });
      if (paper) {
        // 背景層不透明（除非透明匯出）＝GPU 路免快照；文字段透明層走快照＋還原 alpha
        if (!(opts.paperGPU && applyPaperGPU(lx, project.paperKey, opts.filters!,
                                             bg && !opts.transparent))) {
          const d = lx.getImageData(0, 0, lc.width, lc.height);
          applyPaper(project.paperKey, d, opts.filters!);
          lx.putImageData(d, 0, 0);
        }
      }
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(lc, 0, 0);
      ctx.restore();
      lc.remove();
    };
    layer(undefined, true, scope.background);
    // ⚠️ 分段要照**「這一段要不要套紙」**分，不是照「文字／物件」分。
    // 文字與物件的設定相同時（很常見，例如只有背景套紙），照類別分會把
    // 「圖／字／圖」切成三段＝三次整頁重畫，但那三段的畫法一模一樣，
    // 合成一段結果逐位相同。2026-08-30 小高那份光這一項就少一次整頁重畫。
    for (let i = 0; i < blocks.length;) {
      const paper = scope[paperClassOf(blocks[i])];
      let j = i;
      while (j < blocks.length && scope[paperClassOf(blocks[j])] === paper) j++;
      layer(new Set(blocks.slice(i, j).map((b) => b.id)), false, paper);
      i = j;
    }
    return keep();
  }

  renderPage(ctx, project, index, opts);
  if (hasPaper) {
    if (!(opts.paperGPU && applyPaperGPU(ctx, project.paperKey, opts.filters!, !opts.transparent))) {
      const d = ctx.getImageData(0, 0, c.width, c.height);
      applyPaper(project.paperKey, d, opts.filters!);
      ctx.putImageData(d, 0, 0);
    }
  }
  return keep();
}

export function renderPage(
  ctx: CanvasRenderingContext2D,
  project: Project,
  index: number,
  opts: RenderOptions = {},
): void {
  const page = pageRect(project, index);

  ctx.save();
  ctx.clearRect(0, 0, page.w, page.h);
  const bg = project.pageBackgroundHex?.[String(index)] ?? "FFFFFF";
  if (!opts.transparent) {
    ctx.fillStyle = hex(bg);
    ctx.fillRect(0, 0, page.w, page.h);
  }
  // 頁底亮暗——空欄位框的墨色依所在頁切換（iOS emptySlotPlaceholder 同款）
  const n = parseInt(bg, 16);
  const pageLight = (((n >> 16) & 255) * 0.2126 + ((n >> 8) & 255) * 0.7152 + (n & 255) * 0.0722) > 140;

  const blocks = pageBlocks(project, page, opts);

  // 多圖輪播：時間決定畫哪一張；遮罩模式在切換窗內畫兩張（舊的全幅＋新的從左揭示）。
  // 包在 drawBlock 外面——出場動畫的變換已套在 ctx 上，輪播就在同一個座標系裡發生。
  const drawTimed = (blk: Block, reveal?: number): void => {
    if (blk.content.type !== "image" || !blk.content.media.carouselAssets?.length
        || opts.time === undefined) {
      drawBlock(ctx, project, blk, page, opts, pageLight, reveal);
      return;
    }
    const m = blk.content.media;
    const list = [m.assetFileName, ...m.carouselAssets!];
    const cs = carouselAt(list.length, opts.time, m.carouselInterval, m.carouselMode);
    const withAsset = (name: string): Block =>
      ({ ...blk, content: { type: "image", media: { ...m, assetFileName: name } } });
    drawBlock(ctx, project, withAsset(list[cs.cur]), page, opts, pageLight);
    if (cs.next !== undefined && cs.wipe !== undefined) {
      // 與入場 maskWipe 同一份幾何：遮罩沿方向揭示、新圖帶同方向位移
      const w = maskWipeState(blk.frame, cs.wipe, m.carouselDir);
      ctx.save();
      ctx.beginPath();
      ctx.rect(w.clip.x - page.x, w.clip.y - page.y, w.clip.w, w.clip.h);
      ctx.clip();
      if (w.dx || w.dy) ctx.translate(w.dx, w.dy);
      drawBlock(ctx, project, withAsset(list[cs.next]), page, opts, pageLight);
      ctx.restore();
    }
  };

  for (const b of blocks) {
    // 動畫層：求值與繪製分離——這裡只把狀態變成 canvas 變換，drawBlock 完全不知道有動畫
    const a = opts.anims?.get(b.id);
    if (a && opts.time !== undefined) {
      const vert = b.content.type === "text" && !!b.content.text.vertical;
      const st = animStateAt(a, opts.time, b.frame, page, vert);
      if (st.opacity <= 0) continue;
      ctx.save();
      if (st.clip) {
        ctx.beginPath();
        ctx.rect(st.clip.x - page.x, st.clip.y - page.y, st.clip.w, st.clip.h);
        ctx.clip();
      }
      if (st.opacity < 1) ctx.globalAlpha *= st.opacity;
      if (st.dx || st.dy) ctx.translate(st.dx, st.dy);
      if (st.scale !== 1) {
        const cx = b.frame.x - page.x + b.frame.w / 2, cy = b.frame.y - page.y + b.frame.h / 2;
        ctx.translate(cx, cy); ctx.scale(st.scale, st.scale); ctx.translate(-cx, -cy);
      }
      // 打字／閃現＝換一份截短的文字進去（不動 drawBlock 的內部）
      let bb = b;
      if (st.reveal !== undefined && b.content.type === "text") {
        bb = { ...b, content: { ...b.content,
          text: { ...b.content.text, text: revealText(b.content.text.text, st.reveal, st.revealMode === "draw" ? "char" : st.revealMode) } } };
      }
      // 塗鴉生長＝reveal 交給 drawDoodle 沿路徑裁（不換內容）
      drawTimed(bb, st.revealMode === "draw" ? st.reveal : undefined);
      ctx.restore();
    } else {
      drawTimed(b);
    }
  }
  ctx.restore();
}

/** 編輯用的整台 stage：所有頁面連續排開（頁與頁之間沒有間隙，那是專案的座標語意），
 *  加上選取框、參考線、等距徽章。座標一律用專案座標，view 變換由呼叫端先套好。 */
export interface StageOverlay {
  selection?: Rect[];
  guides?: GuideLine[];
  badges?: SpacingBadge[];
  /** 框選中的橡皮筋矩形（編輯畫布專用）。 */
  marquee?: Rect;
  /** 把專案裡的使用者參考線藏起來（只是看不到，不會刪掉）。 */
  hideProjectGuides?: boolean;
  /** 手把（專案座標，旋轉後的真實位置），固定螢幕尺寸。
   *  無 bar＝圓點（角，等比縮放）；bar＝長條（邊，裁切）——兩種角色不同，長相就要不同。 */
  handles?: { x: number; y: number; bar?: "v" | "h" }[];
  accent?: string;
}

export function renderStage(
  ctx: CanvasRenderingContext2D,
  project: Project,
  opts: RenderOptions = {},
  overlay: StageOverlay = {},
): void {
  const accent = overlay.accent ?? "#2F7CF6";

  // 有紙張時走離屏逐頁渲染——紙張是整頁的逐像素運算，套在被 view 變換過的
  // 畫布上會糊掉。沒紙張時直接畫，拖曳才不會每格都做一次 getImageData。
  const viaCanvas = !!(project.paperKey && opts.filters);
  for (let i = 0; i < project.pageCount; i++) {
    const page = pageRect(project, i);
    if (opts.viewRect && !intersects(page, opts.viewRect)) continue;   // 視野外的頁整頁跳過
    ctx.save();
    ctx.beginPath();
    ctx.rect(page.x, page.y, page.w, page.h);
    ctx.clip();                      // 逐頁裁切＝跨頁 bleed 的全部實作
    if (viaCanvas) {
      ctx.drawImage(pageCanvas(project, i, opts).canvas, page.x, page.y, page.w, page.h);
    } else {
      ctx.translate(page.x, page.y); // renderPage 內部用頁內座標
      renderPage(ctx, project, i, opts);
    }
    ctx.restore();
  }

  // 頁縫：畫布本身沒有縫，這條線只是給編輯時看的
  ctx.save();
  ctx.strokeStyle = "rgba(128,128,128,.45)";
  ctx.lineWidth = 1 / (ctx.getTransform().a || 1);
  for (let i = 1; i < project.pageCount; i++) {
    const x = i * project.canvasWidth;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, project.pageHeight); ctx.stroke();
  }
  ctx.restore();

  const px = 1 / (ctx.getTransform().a || 1);   // 一個螢幕像素等於多少專案單位

  // 使用者參考線（存在專案裡的那種）。**只有編輯畫布畫**——它是編輯用的參考，
  // 不是版面的一部分，所以匯出（renderPage）與頁面縮圖都看不到。
  // 垂直的存頁內座標＝每頁重複一條；水平的 y 是絕對座標＝跨整台 stage 一條。
  ctx.save();
  ctx.strokeStyle = "rgb(38,153,255)";   // iOS guideColor (0.15, 0.6, 1.0)
  ctx.lineWidth = px;
  for (const gx of overlay.hideProjectGuides ? [] : project.guidesX ?? []) {
    for (let i = 0; i < project.pageCount; i++) {
      if (opts.viewRect && !intersects(pageRect(project, i), opts.viewRect)) continue;
      const x = i * project.canvasWidth + gx;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, project.pageHeight); ctx.stroke();
    }
  }
  const stageW = project.canvasWidth * project.pageCount;
  for (const gy of overlay.hideProjectGuides ? [] : project.guidesY ?? []) {
    ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(stageW, gy); ctx.stroke();
  }
  ctx.restore();

  for (const g of overlay.guides ?? []) {
    ctx.save();
    ctx.strokeStyle = accent;
    ctx.lineWidth = px;
    ctx.beginPath();
    if (g.axis === "vertical") { ctx.moveTo(g.position, g.start); ctx.lineTo(g.position, g.end); }
    else { ctx.moveTo(g.start, g.position); ctx.lineTo(g.end, g.position); }
    ctx.stroke();
    ctx.restore();
  }

  for (const r of overlay.selection ?? []) {
    ctx.save();
    ctx.strokeStyle = accent;
    ctx.lineWidth = px * 1.5;
    ctx.setLineDash([px * 5, px * 4]);
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.restore();
  }

  if (overlay.marquee) {
    const r = overlay.marquee;
    ctx.save();
    ctx.fillStyle = "rgba(47,124,246,.10)";
    ctx.strokeStyle = accent;
    ctx.lineWidth = px;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.restore();
  }

  // 手把畫在選取框之後（壓在虛線上），尺寸固定在螢幕上——縮放時手感才一致
  for (const p of overlay.handles ?? []) {
    ctx.save();
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = accent;
    ctx.lineWidth = px * 1.5;
    ctx.beginPath();
    if (!p.bar) {
      ctx.arc(p.x, p.y, px * 4.5, 0, Math.PI * 2);
    } else {
      const long = px * 20, thick = px * 5;
      const w = p.bar === "h" ? long : thick, h = p.bar === "h" ? thick : long;
      ctx.roundRect(p.x - w / 2, p.y - h / 2, w, h, px * 2.5);
    }
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  // 等距徽章畫成藥丸（Figma 同款）：拖曳中要一眼讀到間距值，
  // 裸字 11px 疊在畫面上小到看不見（2026-08-14 使用者回報），改 14px 白字＋色底
  for (const b of overlay.badges ?? []) {
    ctx.save();
    ctx.font = `600 ${14 * px}px system-ui, sans-serif`;
    const label = String(b.value);
    const tw = ctx.measureText(label).width;
    const padX = 5 * px, ph = 19 * px;
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.roundRect(b.x - tw / 2 - padX, b.y - ph / 2, tw + padX * 2, ph, 5 * px);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, b.x, b.y);
    ctx.restore();
  }
}

function drawBlock(
  ctx: CanvasRenderingContext2D,
  project: Project,
  b: Block,
  page: Rect,
  opts: RenderOptions,
  pageLight = true,
  /** 塗鴉生長出場的比例（只有 doodle 用）。 */
  reveal?: number,
): void {
  const { frame: f } = b;
  // 平移到頁內座標，並把原點移到 block 中心（旋轉繞中心）
  const cx = f.x + f.w / 2 - page.x;
  const cy = f.y + f.h / 2 - page.y;

  ctx.save();
  ctx.globalAlpha = b.opacity;
  ctx.translate(cx, cy);
  if (b.rotation) ctx.rotate((b.rotation * Math.PI) / 180);
  ctx.translate(-f.w / 2, -f.h / 2); // 之後一律用 block 本地座標 (0,0)-(f.w,f.h)

  switch (b.content.type) {
    case "shape":
      drawShape(ctx, b.content.shape, f.w, f.h);
      break;
    case "text":
    case "textFlow": {
      const t = b.content.text;
      // 長文框＝固定容器：橫排走 drawBodyFrame（裁切＋可繞排）；
      // 直排走 drawText 內的固定容器分支（整欄制＋裁切，2026-08-19）。
      if (t.isBodyFrame === true && t.vertical !== true) {
        drawBodyFrame(ctx, project, b, t, f.w, f.h);
      } else {
        drawText(ctx, t, f.w, f.h, project.canvasWidth, project.pageHeight);
      }
      break;
    }
    case "image":
    case "video":
      drawMedia(ctx, b, b.content.media, f.w, f.h, opts, pageLight);
      break;
    case "doodle":
      // 塗鴉：時間給巡線／筆刷感動態，reveal 給生長；都沒有＝靜態全畫
      drawDoodle(ctx, b.content.doodle, f.w, f.h, opts.time, reveal);
      break;
    case "model": {
      // 3D 物件：向 modelpool 要「時間 time 的那一格」——渲染核心只認得 CanvasImageSource
      const img = opts.models?.render(b, opts.time);
      if (img) {
        ctx.drawImage(img, 0, 0, f.w, f.h);
      } else {
        // 還沒載好／WebGL 不可用：畫個立方體線框佔位（沿用空欄位的墨色邏輯）
        ctx.strokeStyle = pageLight ? "rgba(60,60,60,.5)" : "rgba(240,240,240,.6)";
        ctx.lineWidth = Math.max(1, Math.min(f.w, f.h) * 0.008);
        ctx.strokeRect(0, 0, f.w, f.h);
        const s = Math.min(f.w, f.h) * 0.22, mx = f.w / 2, my = f.h / 2, o = s * 0.45;
        ctx.strokeRect(mx - s / 2, my - s / 2 + o / 2, s, s);
        ctx.strokeRect(mx - s / 2 + o, my - s / 2 - o / 2, s, s);
        ctx.beginPath();
        for (const [ax, ay] of [[0, 0], [s, 0], [0, s], [s, s]] as const) {
          ctx.moveTo(mx - s / 2 + ax, my - s / 2 + o / 2 + ay);
          ctx.lineTo(mx - s / 2 + o + ax, my - s / 2 - o / 2 + ay);
        }
        ctx.stroke();
      }
      break;
    }
  }
  ctx.restore();
}

function drawShape(ctx: CanvasRenderingContext2D, s: ShapeBlock, w: number, h: number): void {
  ctx.fillStyle = hex(s.colorHex);
  switch (s.kind) {
    case "rectangle": {
      const r = Math.min(s.cornerRadius ?? 0, Math.min(w, h) / 2);
      ctx.beginPath();
      ctx.roundRect(0, 0, w, h, r);
      ctx.fill();
      break;
    }
    case "ellipse":
      ctx.beginPath();
      ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      ctx.fill();
      break;
    case "line": {
      // 水平膠囊，垂直置中；未設粗細時給一個跟框高綁定的預設，clamp 不溢出框。
      const t = Math.max(1, Math.min(s.lineWidth ?? Math.max(2, h * 0.5), h));
      ctx.beginPath();
      ctx.roundRect(0, (h - t) / 2, w, t, t / 2);
      ctx.fill();
      break;
    }
  }
}

/** 遮罩路徑。maskCornerRadius 存的是「短邊一半」的分數，strokeWidth 是短邊的分數。 */
function maskPath(ctx: CanvasRenderingContext2D, m: MediaBlock, w: number, h: number): void {
  ctx.beginPath();
  if (m.maskShape === "ellipse") {
    ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    return;
  }
  const r = (m.maskCornerRadius ?? 0) * (Math.min(w, h) / 2);
  ctx.roundRect(0, 0, w, h, r);
}

/** 空欄位框（範本的填圖欄位）。墨色依頁底亮暗（iOS emptySlotPlaceholder 同款），
 *  匯出也畫——這就是範本該有的樣子，不是編輯器裝飾。圖示照定律用線性向量。 */
function drawEmptySlot(ctx: CanvasRenderingContext2D, m: MediaBlock, w: number, h: number, light: boolean): void {
  const ink = light ? "0,0,0" : "255,255,255";
  ctx.save();
  maskPath(ctx, m, w, h);
  ctx.clip();
  ctx.fillStyle = `rgba(${ink},${light ? 0.08 : 0.1})`;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();

  ctx.save();
  maskPath(ctx, m, w, h);
  ctx.strokeStyle = `rgba(${ink},${light ? 0.35 : 0.45})`;
  ctx.setLineDash([10, 8]);
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.setLineDash([]);

  // 中央圖示：山與太陽的線性小圖
  const s = Math.min(w, h) * 0.2;
  const cx = w / 2, cy = h / 2;
  ctx.strokeStyle = `rgba(${ink},0.4)`;
  ctx.lineWidth = Math.max(1.5, s * 0.06);
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  ctx.beginPath();
  ctx.roundRect(cx - s, cy - s * 0.75, s * 2, s * 1.5, s * 0.16);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx - s * 0.42, cy - s * 0.28, s * 0.14, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx - s * 0.85, cy + s * 0.55);
  ctx.lineTo(cx - s * 0.15, cy - s * 0.05);
  ctx.lineTo(cx + s * 0.25, cy + s * 0.3);
  ctx.lineTo(cx + s * 0.55, cy + s * 0.05);
  ctx.lineTo(cx + s * 0.9, cy + s * 0.4);
  ctx.stroke();
  ctx.restore();
}

/** 素材的原始像素尺寸。`<video>` 的自然尺寸在 videoWidth（naturalWidth 是 undefined，
 *  而 `.width` 是 HTML 屬性、預設 0）——查錯欄位會讓影片的 aspect-fill 整個歪掉。 */
export function naturalSize(img: CanvasImageSource): { w: number; h: number } {
  const v = img as HTMLVideoElement;
  if (v.videoWidth) return { w: v.videoWidth, h: v.videoHeight };
  const i = img as HTMLImageElement;
  return {
    w: i.naturalWidth || (img as HTMLCanvasElement).width,
    h: i.naturalHeight || (img as HTMLCanvasElement).height,
  };
}

/**
 * 影片匯出用：把媒體的遮罩烤成「形狀內不透明」的圖（Core Image 的 CIBlendWithMask 吃 alpha），
 * 以及往內描的外框圖。兩張都在**烤好的片段自己的像素尺寸**上畫，合成器逐格直接套。
 * 回 null＝這個 block 沒有遮罩／沒有外框。
 */
export function maskAndStrokeCanvases(
  m: MediaBlock, w: number, h: number,
): { mask: HTMLCanvasElement | null; stroke: HTMLCanvasElement | null } {
  const has = m.maskShape != null || (m.maskCornerRadius ?? 0) > 0;
  // 與 drawFrameStroke 同一條 1px 下限——同一道描邊，畫布上看得見、匯出的影片裡
  // 就不能變成半畫素淡線（兩處要一致，改一邊必改另一邊）
  const rawSw = (m.strokeWidth ?? 0) * Math.min(w, h);
  const sw = rawSw > 0 ? Math.max(rawSw, 1) : 0;
  let mask: HTMLCanvasElement | null = null;
  let stroke: HTMLCanvasElement | null = null;
  if (has) {
    mask = document.createElement("canvas");
    mask.width = Math.round(w); mask.height = Math.round(h);
    const c = mask.getContext("2d")!;
    c.fillStyle = "#ffffff";
    maskPath(c, m, w, h);
    c.fill();
  }
  if (sw > 0 && m.strokeHex) {
    stroke = document.createElement("canvas");
    stroke.width = Math.round(w); stroke.height = Math.round(h);
    const c = stroke.getContext("2d")!;
    maskPath(c, m, w, h);
    c.clip();
    maskPath(c, m, w, h);
    c.strokeStyle = hex(m.strokeHex);
    c.lineWidth = sw * 2;      // 形狀會把線寬對半切，加倍再裁回去＝往內描
    c.stroke();
  }
  // 撕紙邊：烤進這兩張圖，合成器（alignvideo）就零改動——
  // 撕痕 alpha 併進 mask（destination-in＝交集）、紙芯白帶＋細影搭 stroke 的疊圖位。
  // 撕紙邊開著＝邊取代框（同 drawFrameStroke 的抑制），矩形描邊不出。
  const torn = tornOf(m);
  if (torn) {
    const W = Math.round(w), H = Math.round(h);
    const tc = tornCanvases(torn, W, H);
    if (!mask) {
      mask = document.createElement("canvas");
      mask.width = W; mask.height = H;
      mask.getContext("2d")!.drawImage(tc.mask, 0, 0, W, H);   // 快取項不外流，畫一份（烤圖有帽）
    } else {
      const c = mask.getContext("2d")!;
      c.globalCompositeOperation = "destination-in";
      c.drawImage(tc.mask, 0, 0, W, H);
      c.globalCompositeOperation = "source-over";
    }
    stroke = document.createElement("canvas");
    stroke.width = W; stroke.height = H;
    const sc = stroke.getContext("2d")!;
    sc.drawImage(tc.overlay, 0, 0, W, H);
    if (mask) {
      // 同 drawMedia：紙芯白帶要被最終遮罩夾住，否則去背照片旁邊會浮一圈白
      sc.globalCompositeOperation = "destination-in";
      sc.drawImage(mask, 0, 0);
      sc.globalCompositeOperation = "source-over";
    }
  }
  return { mask, stroke };
}

/** 去背合成用的離屏畫布。重用一張——拖曳時每格都會進來，每格 new 一張會頓。 */
let _stage: HTMLCanvasElement | null = null;
function mediaStage(w: number, h: number): HTMLCanvasElement {
  const W = Math.max(1, Math.round(w)), H = Math.max(1, Math.round(h));
  if (!_stage) _stage = document.createElement("canvas");
  if (_stage.width !== W || _stage.height !== H) { _stage.width = W; _stage.height = H; }
  else {
    // ⚠️ 先歸零 transform 再清——這張畫布上一輪被設過縮放，帶著它清會清錯區域
    const g = _stage.getContext("2d")!;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);
  }
  return _stage;
}

/**
 * 給每張來源圖一個穩定編號。**快取鍵不能用檔名**——去背編輯間「完成」是把烤好的
 * 遮罩**寫回同一個檔**，檔名一個字都沒變但畫素變了（`refreshMatteVariants` 會換掉
 * 那張 canvas）。認物件身分就不會拿到修邊前的舊圖。
 */
const _srcIds = new WeakMap<CanvasImageSource, number>();
let _srcSeq = 0;
function srcId(s: CanvasImageSource | undefined): number {
  if (!s) return 0;
  let id = _srcIds.get(s);
  if (id === undefined) { id = ++_srcSeq; _srcIds.set(s, id); }
  return id;
}

/**
 * 一塊 block 的「內容指紋」。
 *
 * **快取鑰匙一律用它，不要手寫欄位清單。**手寫的清單有一個很難查的失效模式：
 * 以後誰加了一個新的外觀欄位、忘了加進鑰匙，畫面就會靜靜地沿用舊的那張，
 * 不報錯、不當掉，只是畫錯（2026-08-30 定案，第一版鑰匙就是手寫清單）。
 * 走 JSON 的話，新欄位自動被涵蓋——**正確是預設值，不是要記得的事**。
 *
 * 代價量過：17 塊的專案 stringify＋雜湊 0.37 ms／次，而且只在真的要重畫時算一次。
 * 對照它省下來的東西（一次整頁重畫就是幾十毫秒），這個價錢很便宜。
 *
 * 解析出來的來源圖要另外算：圖片是**載入後才換上去的**，換圖、重跑去背都不會
 * 改到 block 的 JSON，只會換掉素材表裡的那個物件，所以身分編號也要進指紋。
 */
function fnv(s: string, h = 0x811c9dc5): number {
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function blockSig(b: Block, opts: RenderOptions): number {
  let h = fnv(JSON.stringify(b));
  const c = b.content;
  if (c.type === "image" || c.type === "video") {
    const m = c.media;
    const sig = filterSig(m);
    const suffix = sig ? `|${sig}` : "";
    const src = opts.videos?.get(m.assetFileName + suffix)
      ?? opts.images?.get(m.assetFileName + suffix)
      ?? opts.images?.get(`${m.assetFileName}.poster.jpg${suffix}`);
    const matte = m.matteFileName
      ? opts.mattes?.get(`matte:${m.matteFileName}${m.matteInverted ? "!" : ""}`)
      : undefined;
    h = fnv(`|${srcId(src)}|${srcId(matte)}`, h);
  }
  return h;
}

/**
 * 「切好的圖」快取：一塊圖在**目前這個顯示尺寸**下畫出來的樣子，存一張。
 *
 * 沒這一層的話，每一幀每一塊圖都要從原始點陣圖重新取樣。畫布只有 1080 寬、匯出
 * 上限 2×，但相機照片進來就是 6000——一塊 756 寬的框每幀在縮 2400 萬畫素。
 * 去背再乘四道（配畫布→縮原圖→destination-in→貼回）。2026-08-29 實測小高的
 * 「去背宣傳2」：4 頁 8 塊圖，每幀取樣 **1.9 億畫素**，其中 7200 萬還是沒去背的圖。
 *
 * 快取鍵吃的是**這塊圖自己的顯示尺寸**，不是頁面寬——所以跨頁圖天生保住畫質
 * （跨四頁的框就是 4320 寬，它的 stage 就有 4320 寬），縮放、匯出 2× 也各自是
 * 不同的鍵、各自從原圖重畫一次，**任何路徑都沒有畫質損失**。
 *
 * 內容會動的不能進來：影片的即時影格是同一張 canvas 一直被覆寫，認物件身分抓不到
 * 它變了。所以 `live` 那條一律走共用畫布、每幀重算（本來就是每幀不同的東西）。
 */
const _cutCache = new Map<string, HTMLCanvasElement>();
/** 兩道上限：張數，以及總畫素（一張 stage 是顯示尺寸，跨頁圖那張會很寬）。
 *  3200 萬畫素 ≈ 128 MB，比原本一張 6000×4000 遮罩的 alpha 版還省。 */
const CUT_CACHE_MAX = 24;
const CUT_CACHE_PIXELS = 32_000_000;
function cutCacheGet(key: string): HTMLCanvasElement | undefined {
  const hit = _cutCache.get(key);
  if (hit) { _cutCache.delete(key); _cutCache.set(key, hit); }   // 命中就移到尾端＝LRU
  return hit;
}
function cutCacheSet(key: string, c: HTMLCanvasElement): void {
  _cutCache.set(key, c);
  let px = 0;
  for (const v of _cutCache.values()) px += v.width * v.height;
  while (_cutCache.size > CUT_CACHE_MAX || (px > CUT_CACHE_PIXELS && _cutCache.size > 1)) {
    const oldest = _cutCache.keys().next().value as string;   // 最久沒用到的在最前面
    const v = _cutCache.get(oldest)!;
    px -= v.width * v.height;
    _cutCache.delete(oldest);
  }
}

/** 效能計數器。每幀由讀的人歸零——渲染核心只管加。全是整數 ++，可以永遠開著。 */
export const renderCounters = {
  media: 0,        // 這一幀畫了幾塊圖／影片
  matte: 0,        // 其中幾塊有去背遮罩
  video: 0,        // 其中幾塊是影片的即時影格（不進快取）
  cutHit: 0,       // 切好的圖：快取命中
  cutMiss: 0,      // 切好的圖：重算（＝那一幀真的去縮了原圖）
  pageHit: 0,      // 整頁：快取命中（紙張那條才會用到）
  pageMiss: 0,     // 整頁：重烤（＝整頁重畫＋逐畫素套紙）
  pageSkip: 0,     // 整頁：這一頁**不能**快取（有動畫／影片／3D／會動的塗鴉）
  reset(): void {
    this.media = this.matte = this.video = 0;
    this.cutHit = this.cutMiss = 0;
    this.pageHit = this.pageMiss = this.pageSkip = 0;
  },
  get cutCached(): number { return _cutCache.size; },
  get pageCached(): number { return _pageCache.size; },
};

function drawMedia(
  ctx: CanvasRenderingContext2D,
  b: Block,
  m: MediaBlock,
  w: number,
  h: number,
  opts: RenderOptions,
  pageLight = true,
): void {
  // 空欄位槽＝範本欄位，永遠畫佔位樣式（含匯出）
  if (!m.assetFileName) { drawEmptySlot(ctx, m, w, h, pageLight); return; }
  // 影片畫的是海報圖（檔名＝影片名 + ".poster.jpg"），與 iOS 的預覽一致。
  // 濾鏡是預先套好的，所以查圖的鍵要帶上濾鏡代號——同一張圖套不同濾鏡是不同的快取項。
  const sig = filterSig(m);
  const suffix = sig ? `|${sig}` : "";
  // 編輯中的影片優先畫即時影格（iOS 畫布上是靜音自動循環的真播放）；沒有就退回海報。
  // live＝影片的即時影格。它是**同一張 canvas 一直被覆寫**，認物件身分抓不到它變了，
  // 所以下面的快取一律跳過它——它本來就是每幀都不一樣的東西。
  renderCounters.media++;
  const live = opts.videos?.get(m.assetFileName + suffix);
  if (live) renderCounters.video++;
  const img = live
    ?? opts.images?.get(m.assetFileName + suffix)
    ?? opts.images?.get(`${m.assetFileName}.poster.jpg${suffix}`);

  // 去背遮罩：媒體要先畫進離屏畫布再 destination-in，不能直接對頁面 ctx 做——
  // destination-in 會把「這個 block 以外」已經畫好的東西一起擦掉。
  const matte = m.matteFileName
    ? opts.mattes?.get(`matte:${m.matteFileName}${m.matteInverted ? "!" : ""}`)
    : undefined;
  if (matte) renderCounters.matte++;

  // stage 要照**裝置畫素**烤，不是照頁座標。w／h 是頁座標，ctx 身上帶著縮放與
  // Retina 倍率——照 w／h 烤再讓 ctx 放大，去背圖在 Retina 上就只剩一半解析度
  // （這是快取加進來之前就有的毛病，一併修掉）。
  const tf = ctx.getTransform();
  const kx = Math.hypot(tf.a, tf.b) || 1, ky = Math.hypot(tf.c, tf.d) || 1;
  // ⚠️ 夾限**絕不能夾到比頁座標還小**——那會比改這段之前還糊（原本就是照 w／h 烤的）。
  // 8192 是留在 WebKit 畫布上限之內；跨二十頁那種極端寬的圖才碰得到。
  const CAP = 8192;
  const SW = Math.max(Math.round(w), Math.min(Math.max(1, Math.round(w * kx)), CAP));
  const SH = Math.max(Math.round(h), Math.min(Math.max(1, Math.round(h * ky)), CAP));
  // 太大就不進快取：一張就把別人全擠出去，反而每塊都在重算
  const tooBig = SW * SH > 12_000_000;

  // 這一塊「畫出來的樣子」由什麼決定：來源圖的身分＋幾何＋裝置尺寸。都沒變就整張
  // 重用，每幀只剩一次 drawImage。圖還沒載進來（畫佔位框）不能快取——載好了就換不掉了。
  // 鑰匙＝內容指紋＋裝置尺寸。指紋涵蓋整塊 block 的 JSON，所以新增外觀欄位
  // 不必回來改這裡（見 blockSig 的檔頭）。
  const key = img && !live && !tooBig ? `${blockSig(b, opts)}|${SW}|${SH}` : null;
  const hit = key ? cutCacheGet(key) : undefined;
  if (hit) {
    renderCounters.cutHit++;
    ctx.drawImage(hit, 0, 0, w, h);
    if (!tornOf(m)) drawFrameStroke(ctx, m, w, h);   // 撕紙邊＝邊取代框（同下方主路）
    return;
  }
  if (key) renderCounters.cutMiss++;

  // 沒遮罩又不進快取（影片即時影格、極端縮放、圖還沒載到）＝走原本那條直接畫的路，
  // 逐位不變。其餘都畫進離屏 stage：進快取的自己一張，不進的用共用那張。
  const torn = tornOf(m);
  let stage: HTMLCanvasElement | null = null;
  if (matte || key || torn) {
    if (key) {
      stage = document.createElement("canvas");
      stage.width = SW; stage.height = SH;
    } else {
      stage = mediaStage(SW, SH);
    }
  }
  const target = stage ? stage.getContext("2d")! : ctx;
  // stage 內部用頁座標作畫（下面整段程式碼一個字都不用改），由 transform 換算到裝置畫素
  if (stage) target.setTransform(stage.width / w, 0, 0, stage.height / h, 0, 0);

  target.save();
  if (m.maskShape != null || (m.maskCornerRadius ?? 0) > 0) {
    maskPath(target, m, w, h);
    target.clip();
  }

  if (img) {
    const { w: iw, h: ih } = naturalSize(img);
    // ⚠️ cropRect 的 (0,0,1,1) 是「未曾裁切」的哨兵值，**不可照字面拉伸**——
    // 要解成置中的 aspect-fill，否則換圖後會變形、裁切介面也會出現零餘裕的死狀態。
    const c = (m.cropRect.x === 0 && m.cropRect.y === 0 && m.cropRect.w === 1 && m.cropRect.h === 1)
      ? aspectFillCrop(iw, ih, w, h)
      : m.cropRect;
    const deg = m.rotationDegrees ?? 0;
    if (!deg) {
      // 沒拉直（絕大多數）＝原本那條路，逐位不變——不能讓沒轉過的圖有任何位移
      target.drawImage(img, c.x * iw, c.y * ih, c.w * iw, c.h * ih, 0, 0, w, h);
    } else {
      // 拉直：把**放大後的整張圖**繞自己的中心轉，再平移讓裁切區中心落到視窗中心。
      // 平移量本身也要被同一個角度轉過（那是螢幕空間的位移）——iOS 修過的 parity bug，
      // 少轉這一下圖會隨角度漂走。順序與裁切取景器完全相同：先轉再平移。
      const sw = w / c.w, sh = h / c.h;
      const ax = (c.x + c.w / 2 - 0.5) * sw, ay = (c.y + c.h / 2 - 0.5) * sh;
      const r = (deg * Math.PI) / 180, cs = Math.cos(r), sn = Math.sin(r);
      target.save();
      target.beginPath();
      target.rect(0, 0, w, h);
      target.clip();
      target.translate(w / 2 - (cs * ax - sn * ay), h / 2 - (sn * ax + cs * ay));
      target.rotate(r);
      target.drawImage(img, -sw / 2, -sh / 2, sw, sh);
      target.restore();
    }
  } else if (opts.placeholderForMissingMedia) {
    target.strokeStyle = "rgba(128,128,128,.45)";
    target.setLineDash([8, 8]);
    target.lineWidth = 2;
    target.strokeRect(1, 1, w - 2, h - 2);
    target.setLineDash([]);
  }
  target.restore();

  if (stage) {
    // 遮罩不能直接拉滿整格——它要跟「它描述的那張照片」用同一套裁切，
    // 否則人形會相對背景整個偏掉。遮罩與原圖同尺寸，所以：
    //   cropRect 是哨兵值（沒手動裁過）→ 對遮罩自己算一次 aspect-fill，
    //     結果與照片那次完全相同，兩者天然對齊；
    //     「人形當窗口填材質」也走這條——材質框自己 aspect-fill，
    //     遮罩仍對齊底下那張照片。
    //   有手動裁過 → 同一個 cropRect 直接套（遮罩與原圖同尺寸，比例一致）。
    if (matte) {
      const sg = stage.getContext("2d")!;
      const { w: mw, h: mh } = naturalSize(matte);
      const mc = (m.cropRect.x === 0 && m.cropRect.y === 0 && m.cropRect.w === 1 && m.cropRect.h === 1)
        ? aspectFillCrop(mw, mh, w, h)
        : m.cropRect;
      sg.globalCompositeOperation = "destination-in";
      sg.drawImage(matte, mc.x * mw, mc.y * mh, mc.w * mw, mc.h * mh, 0, 0, w, h);
      sg.globalCompositeOperation = "source-over";
    }
    if (torn) {
      // 撕紙邊：烤好的遮罩把照片沿撕痕裁掉，覆蓋層補紙芯白帶＋細影。
      // 靜態圖整組跟著進切圖快取（blockSig 吃整塊 JSON），影片每幀只多兩次 drawImage。
      const tc = tornCanvases(torn, stage.width, stage.height);
      const sg = stage.getContext("2d")!;
      sg.save();
      sg.setTransform(1, 0, 0, 1, 0, 0);
      if (matte) {
        // 🔴 **去背圖撕的是背後那張紙**（2026-09-01 小高實測回報「撕紙邊在去背圖上不管用」）。
        // 主體已經被遮罩剪成人形，圖片外框附近本來就沒有東西，撕外框與它不相交＝
        // 什麼都不會發生。改成在主體背後鋪一張撕邊的紙、人疊在紙上面——孔版拼貼那個語彙。
        // 刻意**不加欄位**：「有去背＋有撕紙邊」現況是條死路（畫不出任何東西），
        // 所以改行為不會動到任何既有專案，也就不觸發「動 project.json 就三平台同發」。
        // 之後要讓人選「撕外框／背紙／沿輪廓」再加 tornTarget，那時候才三平台同發。
        const sheet = document.createElement("canvas");
        sheet.width = stage.width; sheet.height = stage.height;
        const hg = sheet.getContext("2d")!;
        // 紙也要吃形狀遮罩（橢圓／大圓角），不然紙會從形狀外面露出來
        hg.setTransform(sheet.width / w, 0, 0, sheet.height / h, 0, 0);
        hg.save();
        if (m.maskShape != null || (m.maskCornerRadius ?? 0) > 0) { maskPath(hg, m, w, h); hg.clip(); }
        hg.fillStyle = hex(torn.core);
        hg.fillRect(0, 0, w, h);
        hg.restore();
        hg.setTransform(1, 0, 0, 1, 0, 0);
        hg.globalCompositeOperation = "destination-in";
        hg.drawImage(tc.mask, 0, 0, sheet.width, sheet.height);
        hg.globalCompositeOperation = "source-atop";
        hg.drawImage(tc.overlay, 0, 0, sheet.width, sheet.height);
        sg.globalCompositeOperation = "destination-over";   // 紙在下、人在上
        sg.drawImage(sheet, 0, 0);
      } else {
        sg.globalCompositeOperation = "destination-in";
        sg.drawImage(tc.mask, 0, 0, stage.width, stage.height);   // 烤圖有帽，明確拉到目標尺寸
        // 🔴 覆蓋層要用 source-atop 不是 source-over：stage 這時可能已經被
        // 橢圓／大圓角挖過，source-over 會讓紙芯白帶浮在形狀外面一整圈（2026-09-01 審查）。
        sg.globalCompositeOperation = "source-atop";
        sg.drawImage(tc.overlay, 0, 0, stage.width, stage.height);
      }
      sg.restore();
    }
    if (key) cutCacheSet(key, stage);
    ctx.drawImage(stage, 0, 0, w, h);
  }

  // 撕紙邊開著＝邊取代框，矩形描邊不畫（畫了會浮在被撕掉的缺口上）
  if (!torn) drawFrameStroke(ctx, m, w, h);
}

/** 外框：描的是**框**（矩形／橢圓），不是去背的輪廓。 */
function drawFrameStroke(
  ctx: CanvasRenderingContext2D, m: MediaBlock, w: number, h: number,
): void {
  // 至少一個頁面畫素：描邊寬度存的是「短邊的比例」，面板最小刻度 1 ＝ 短邊的 0.12%，
  // 短邊 400 的框上就是 0.48 畫素——畫得出來，但只有 36% 不透明度，匯出的圖上等於沒有
  //（2026-08-30 小高在 iPad 回報「線寬 1 以下沒辦法被輸出」，CoreGraphics 實測
  // 0.49px → alpha 93；桌面版的 canvas 同一條算式，同病）。iOS 端＝MediaMaskModifier.minStroke。
  const rawSw = (m.strokeWidth ?? 0) * Math.min(w, h);
  const sw = rawSw > 0 ? Math.max(rawSw, 1) : 0;
  if (sw > 0 && m.strokeHex) {
    ctx.save();
    // 描邊畫在遮罩輪廓上，線寬會被形狀對半切，所以加倍再裁回去才是「往內描」
    maskPath(ctx, m, w, h);
    ctx.clip();
    maskPath(ctx, m, w, h);
    ctx.strokeStyle = hex(m.strokeHex);
    ctx.lineWidth = sw * 2;
    ctx.stroke();
    ctx.restore();
  }
}

/**
 * 長文框：固定容器、超出裁切、逐列繞排。iOS `drawWrapText` 的移植——
 * 逐列算自由區間、每段塞到滿為止；一個字都塞不下的段留空（絕不滲進洞）。
 * 垂直對齊只在**無洞**時生效（iOS 同款：有洞時 middle/bottom 刻意忽略）。
 */
function drawBodyFrame(
  ctx: CanvasRenderingContext2D,
  project: Project,
  b: Block,
  t: TextBlock,
  w: number,
  h: number,
): void {
  const size = resolvedFontSize(t, project.canvasWidth);
  const kern = resolvedKerning(t, project.canvasWidth);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.clip();                       // 固定容器：溢出就是被裁掉，這是長文框的本義
  ctx.font = cssFont(t, size);
  ctx.letterSpacing = `${kern}px`;
  ctx.fillStyle = t.inkColor ?? hex(t.colorHex);
  ctx.textBaseline = "alphabetic";
  drawTextBackground(ctx, t, w, h, size);
  applyTextShadow(ctx, t, size);

  const holes = b.rotation === 0 ? wrapHoles(b, project.blocks) : [];
  const m = ctx.measureText("字");
  const natural = m.fontBoundingBoxAscent + m.fontBoundingBoxDescent;
  const rowH = natural * (t.lineHeightMultiple ?? 1) + (t.lineSpacing ?? 0);
  const ascent = m.fontBoundingBoxAscent + (rowH - natural) / 2;   // 行高撐開時字垂直置中
  const paraGap = (t.paragraphSpacingEm ?? 0) * size;
  const minSeg = size * 1.05;      // 窄過一個字的段塞不了字
  // 段落 → 斷行單位序列（"\n" 自成一個單位當段落界）。逐字元會剖開英文單字與
  // 版本號，跟 iOS 對不上（見 breakUnits 的說明）
  const units: BreakUnit[] = [];
  t.text.split("\n").forEach((para, pi) => {
    if (pi) units.push({ text: "\n", trail: "" });
    units.push(...breakUnits(para));
  });

  let y0 = 0;
  if (!holes.length && t.verticalAlignment && t.verticalAlignment !== "top") {
    const lines = wrap(ctx, t.text, w, kern);
    const paras = (t.text.match(/\n/g) ?? []).length;
    const total = lines.length * rowH + paras * paraGap;
    y0 = t.verticalAlignment === "middle" ? (h - total) / 2 : h - total;
  }

  let i = 0;
  let yTop = y0;
  while (i < units.length && yTop + rowH <= h + 0.5) {
    const segs = freeIntervals(yTop, yTop + rowH, w, holes, minSeg);
    const widest = segs.length ? Math.max(...segs.map((s) => s.width)) : 0;
    let endedParagraph = false;
    for (const seg of segs) {
      if (i >= units.length) break;
      if (units[i].text === "\n") { i++; endedParagraph = true; break; }
      // 先量再收：一個單位都塞不下＝這段留空，**不消耗字**（否則字會滲進洞）
      let acc = "", pending = "", count = 0;
      while (i + count < units.length && units[i + count].text !== "\n") {
        const u = units[i + count];
        const next = acc + pending + u.text;
        if (count > 0 && lineWidth(ctx, next, kern) > seg.width) break;
        acc = next; pending = u.trail; count++;
      }
      if (!count) continue;
      let lw = lineWidth(ctx, acc, kern);     // 行尾空白不計寬
      let consume = count;
      if (count === 1 && lw > seg.width + 1) {
        // 這一段塞不下這個單位。它若還窄過本行最寬的那一段，就留白讓更寬的段／下一行去接。
        // 🔴 但**連本行最寬的段都放不下**（超長網址、長英數字串）就會永遠卡在同一個
        // 單位上：i 不前進、yTop 一路加到框底，**這個單位以後的字整段消失**
        // （2026-09-01 發版審查抓到的回歸——逐字元那版天生不會卡）。
        // CoreText 這時是在字內硬斷，照做。
        if (seg.width < widest - 0.5) continue;
        const chars = [...units[i].text];
        let take = 1;
        while (take < chars.length
               && lineWidth(ctx, chars.slice(0, take + 1).join(""), kern) <= seg.width) take++;
        if (take < chars.length) {
          acc = chars.slice(0, take).join("");
          lw = lineWidth(ctx, acc, kern);
          units[i] = { text: chars.slice(take).join(""), trail: units[i].trail };
          consume = 0;                        // 這個單位還剩一截，下一段／下一行接著畫
        }
        // take 已經是整串＝連一個字元都比這段寬（字級大到爆框）：照畫讓它溢出，
        // 但 consume 維持 1 一定要前進，否則又是同一個「後面全部不見」的死結。
      }
      i += consume;
      let x = seg.x;
      if (t.alignment === "center") x = seg.x + (seg.width - lw) / 2;
      else if (t.alignment === "trailing") x = seg.x + seg.width - lw;
      ctx.fillText(acc, x, yTop + ascent);
      if (i < units.length && units[i].text === "\n") { i++; endedParagraph = true; break; }
    }
    yTop += rowH + (endedParagraph ? paraGap : 0);
  }
  ctx.restore();
}

// ── 文字 ──────────────────────────────────────────────────────────────
// 這裡是第一版：橫排（含字距、行高、對齊、墨跡貼合）與直排的基本欄排。
// 尚未移植的在 Phase 1 第 2 塊：每字體自然欄距補償、文繞圖、離屏墨跡掃描定位。


// ── 文字的渲染層特效（iOS `TextShadow.swift`）───────────────────────────
// 兩個都**只是畫上去**：不進 AttributedString、不影響量測／貼字盒／吸附。

/** 陰影檔位的 em 參數表（iOS TextShadowStyle.params 逐值照抄）。 */
const SHADOW: Record<string, { dx: number; dy: number; blur: number; opacity: number }> = {
  soft:   { dx: 0,    dy: 0.06, blur: 0.12, opacity: 0.35 },
  strong: { dx: 0.03, dy: 0.06, blur: 0.04, opacity: 0.60 },
};

/**
 * 套上文字陰影。兩個 canvas 的坑：
 * 1. `shadowOffset`／`shadowBlur` **不吃 CTM**（規格如此）——所以要自己把偏移量
 *    乘進目前的變換矩陣。用矩陣的線性部分乘，旋轉過的文字陰影才會跟著轉
 *    （iOS 的陰影是在旋轉前的區域座標系裡加的）。
 * 2. canvas 的 `shadowBlur` 是**兩倍標準差**，CALayer／SwiftUI 的 radius 就是標準差
 *    ——所以要 ×2 才是同一團模糊。
 */
function applyTextShadow(ctx: CanvasRenderingContext2D, t: TextBlock, size: number): void {
  const p = SHADOW[t.shadowStyle ?? ""];
  if (!p) return;
  const c = hex(t.shadowColorHex, "000000");
  const ch = (i: number) => parseInt(c.slice(i, i + 2), 16);
  const m = ctx.getTransform();
  const ox = p.dx * size, oy = p.dy * size;
  ctx.shadowColor = `rgba(${ch(1)},${ch(3)},${ch(5)},${p.opacity})`;
  ctx.shadowOffsetX = m.a * ox + m.c * oy;
  ctx.shadowOffsetY = m.b * ox + m.d * oy;
  ctx.shadowBlur = p.blur * size * 2 * Math.hypot(m.a, m.b);
}

/** 文字底色：圓角矩形往外撐 0.25em、圓角 0.2em（iOS 的 `.padding(-pad)`）。
 *  底色自己不帶陰影——陰影是字的，畫在底色**之上**。 */
function drawTextBackground(
  ctx: CanvasRenderingContext2D, t: TextBlock, w: number, h: number, size: number,
): void {
  if (!t.backgroundColorHex) return;
  const pad = 0.25 * size;
  ctx.save();
  ctx.shadowColor = "transparent";
  ctx.fillStyle = hex(t.backgroundColorHex);
  ctx.beginPath();
  ctx.roundRect(-pad, -pad, w + pad * 2, h + pad * 2, 0.2 * size);
  ctx.fill();
  ctx.restore();
}

function drawText(
  ctx: CanvasRenderingContext2D,
  t: TextBlock,
  w: number,
  h: number,
  canvasWidth: number,
  pageHeight: number,
): void {
  const size = resolvedFontSize(t, canvasWidth);
  const kern = resolvedKerning(t, canvasWidth);

  ctx.font = cssFont(t, size);
  ctx.fillStyle = t.inkColor ?? hex(t.colorHex);
  ctx.textBaseline = "alphabetic";
  ctx.letterSpacing = `${kern}px`;

  drawTextBackground(ctx, t, w, h, size);
  applyTextShadow(ctx, t, size);

  if (t.vertical) {
    if (t.isBodyFrame === true) {
      // 直排長文框＝固定容器（與橫排 drawBodyFrame 同義）：整欄放不下就不排
      // （對齊橫排「整行放不下就停」的規矩），再裁切保底擋住殘餘墨跡。
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, w, h);
      ctx.clip();
      drawVertical(ctx, t, w, size, kern, columnHeight(t, pageHeight), true);
      ctx.restore();
    } else {
      drawVertical(ctx, t, w, size, kern, columnHeight(t, pageHeight));
    }
  } else drawHorizontal(ctx, t, w, h, size, kern);
}

/**
 * 量測一行的實際墨寬。
 * canvas 的 letterSpacing 跟 iOS 的 tracking 一樣，**每個字後面都加**，包含最後一個——
 * 所以量到的寬度多了一個字距，置中會偏半個字距、靠右不貼邊。這裡減回去。
 * （iOS 端對應 KernApplier.applyStrippingTrailing。）
 */
function lineWidth(ctx: CanvasRenderingContext2D, line: string, kern: number): number {
  if (!line) return 0;
  return ctx.measureText(line).width - kern;
}

/**
 * 斷行單位（2026-09-01）。
 *
 * ⚠️ **不可以逐字元斷。** 原本的寫法一個字元一個字元塞，塞不下就地斷——
 * 英文單字會被從中間剖開（`outside` → `out`／`side`）、版本號也是
 * （`1.2.1~1.2.2` → `1.2.1~`／`1.2.2`）。iOS 走 CoreText 的 Unicode 斷行不會這樣，
 * 於是同一份專案兩邊的換行位置全不同——小高 2026-09-01 用 iPad 截圖對照抓到的。
 *
 * 這裡做 CoreText 那套的近似：
 *   - 中日韓字元：一字一單位（字與字之間都可以斷）
 *   - 拉丁字母／數字／半形標點：連著算一個單位（**中間不准斷**）
 *   - 空白：併進前一個單位的 `trail`。行尾的 trail 不計寬——CoreText 也是這樣，
 *     不然「詞 + 一排空白」會因為空白撐爆而提早換行。
 *   - 避頭尾：收尾標點（。、，）」…）不能站行首＝併進前一單位；
 *     起頭標點（（「『…）不能站行尾＝併進後一單位。
 */
interface BreakUnit { text: string; trail: string }

const CJK_RE = /[\u1100-\u11FF\u2E80-\u303F\u3040-\u30FF\u3130-\u318F\u3400-\u4DBF\u4E00-\u9FFF\uA960-\uA97F\uAC00-\uD7FF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/;
const CLOSE_RE = /[。、，．：；！？》）］｝」』】〉〕〙〗,.:;!?)\]}]/;
const OPEN_RE = /[《（［｛「『【〈〔〘〖([{]/;

function breakUnits(para: string): BreakUnit[] {
  const us: BreakUnit[] = [];
  for (const ch of para) {
    const last = us[us.length - 1];
    if (ch === " " || ch === "\t" || ch === "\u3000") {
      if (last) last.trail += ch; else us.push({ text: "", trail: ch });
      continue;
    }
    const cjk = CJK_RE.test(ch);
    // 接得上前一個單位的條件：前面沒有空白隔開，而且兩邊都是非中日韓（＝同一個詞）
    if (last && !last.trail && !cjk && last.text && !CJK_RE.test(last.text[last.text.length - 1])) {
      last.text += ch;
    } else {
      us.push({ text: ch, trail: "" });
    }
  }
  // 避頭尾：收尾標點往前併、起頭標點往後併
  const out: BreakUnit[] = [];
  for (const u of us) {
    const prev = out[out.length - 1];
    if (prev && !prev.trail && u.text.length === 1 && CLOSE_RE.test(u.text)) {
      prev.text += u.text; prev.trail = u.trail; continue;
    }
    out.push({ ...u });
  }
  for (let i = out.length - 2; i >= 0; i--) {
    const u = out[i];
    if (!u.trail && u.text.length === 1 && OPEN_RE.test(u.text)) {
      out[i + 1] = { text: u.text + out[i + 1].text, trail: out[i + 1].trail };
      out.splice(i, 1);
    }
  }
  return out;
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number, kern: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    if (!para) { out.push(""); continue; }
    let line = "";        // 已確定要畫的（含詞間空白）
    let pending = "";     // 上一個單位的尾隨空白：只有後面真的還有字才算進去
    for (const u of breakUnits(para)) {
      let word = u.text;
      if (line && lineWidth(ctx, line + pending + word, kern) > maxW) {
        out.push(line);            // 行尾的空白不帶走（CoreText 同樣捨棄）
        line = ""; pending = "";
      }
      // 一個「不可斷單位」自己就比行寬還寬（超長網址、長英數字串）——CoreText 這時
      // 是在字內硬斷。逐字元那版天生會斷，改成單位化之後不補這段的話它會整條溢出框外。
      while (lineWidth(ctx, word, kern) > maxW) {
        const chars = [...word];
        let take = 1;
        while (take < chars.length
               && lineWidth(ctx, chars.slice(0, take + 1).join(""), kern) <= maxW) take++;
        if (take >= chars.length) break;   // 連一個字元都超寬＝沒得再斷，讓它溢出
        out.push(chars.slice(0, take).join(""));
        word = chars.slice(take).join("");
      }
      line += pending + word;
      pending = u.trail;
    }
    out.push(line);
  }
  return out;
}

/**
 * 直排的「欄高」——換行約束，直排時 manualHeight 的語意就是它。
 *
 * ⚠️ **絕不能拿 frame 高度當欄高。** 貼字盒的高度是由排版結果算出來的，
 * 再拿它回去當切欄約束就成了循環相依：框一縮、每欄裝得下的字變少、
 * 四個字被切成兩欄（2026-08-01 實際踩過，第 1 頁的「作品名稱」當場裂開）。
 */
export function columnHeight(t: TextBlock, pageHeight: number): number {
  return t.manualHeight ?? pageHeight * 0.6;
}

/**
 * 直排的版面度量。量測與繪製共用同一份，欄數與位置不可能對不上。
 *
 * 關於欄距：iOS 端有一套「逐字體量測自然欄距再補償」的機制，看起來很嚇人，
 * 但把它的三段公式代開會發現 **最終欄距恆等於 1.22em × 行高倍數，字體被消掉了**——
 * 那套補償的用途就是抵銷 CoreText 自作主張套上的字體自然欄距
 * （黑體 1.5em、宋/明/粉圓 1.0em）。canvas 是自己逐欄擺位的，沒有東西要抵銷，
 * 所以直接用 1.22em 就是正確的最終值，不需要移植那套量測。
 */
function verticalMetrics(
  ctx: CanvasRenderingContext2D, t: TextBlock, size: number, kern: number, columnHeight: number,
) {
  const advance = size + kern;
  const pitch = size * VERTICAL_PITCH_EM * (t.lineHeightMultiple ?? 1);
  const perCol = Math.max(1, Math.floor(columnHeight / advance));

  const cols: string[] = [];
  for (const para of t.text.split("\n")) {
    if (!para) { cols.push(""); continue; }
    for (let i = 0; i < para.length; i += perCol) cols.push(para.slice(i, i + perCol));
  }

  // 墨跡尺寸逐字量測取最大值——中日文與英數的字身寬高差很多，用 em 猜會鬆。
  // 量測時字距必須歸零：letterSpacing 會被算進 measureText，直排的進距是我們
  // 自己逐字推的，讓它再加一次就會多算。
  let inkW = 0, inkTop = 0, inkBottom = 0;
  const spacing = ctx.letterSpacing;
  ctx.letterSpacing = "0px";
  for (const ch of t.text) {
    if (ch === "\n") continue;
    const m = ctx.measureText(ch);
    inkW = Math.max(inkW, m.actualBoundingBoxLeft + m.actualBoundingBoxRight);
    inkTop = Math.max(inkTop, m.actualBoundingBoxAscent);
    inkBottom = Math.max(inkBottom, m.actualBoundingBoxDescent);
  }
  ctx.letterSpacing = spacing;
  if (!inkW) { inkW = size; inkTop = size * 0.88; inkBottom = 0; }

  const longest = Math.max(...cols.map((c) => c.length), 1);
  return {
    cols, pitch, advance, inkW,
    // 貼字盒＝真實墨跡涵蓋範圍。最後一個字後面不再有進距（與橫排的
    // 「尾字字距要減掉」是同一回事，只是換到縱軸）。
    extentW: (cols.length - 1) * pitch + inkW,
    extentH: (longest - 1) * advance + inkTop + inkBottom,
  };
}

/** 橫排的行高與段距。量測與繪製共用，兩邊不可能分家。 */
function lineMetrics(ctx: CanvasRenderingContext2D, t: TextBlock, size: number, sample: string) {
  const m = ctx.measureText(sample || "字");
  const lineH = (m.fontBoundingBoxAscent + m.fontBoundingBoxDescent) * (t.lineHeightMultiple ?? 1)
    + (t.lineSpacing ?? 0);
  return { lineH, paraGap: (t.paragraphSpacingEm ?? 0) * size };
}

/**
 * 字身上下的空白帶。字體的 ascent 遠高於墨跡起點，中間那條空帶是留給重音符號的
 * （iOS 實測 point size 100 下：明體約 31、粉圓約 6、Inter 約 24）。
 * 把它從貼字盒扣掉，框才會真的貼在字上而不是貼在 ascent/descent 線上——
 * **這就是「外緣吸附」能對到真實字身的原因**，不是細節。
 * canvas 的 actualBoundingBox* 就是墨跡邊界，fontBoundingBox* 是排版邊界，相減即是。
 */
function inkInsets(ctx: CanvasRenderingContext2D, first: string, last: string, lineHeightMultiple: number) {
  const a = ctx.measureText(first || "字");
  const b = ctx.measureText(last || "字");
  const fragmentExtra = (a.fontBoundingBoxAscent + a.fontBoundingBoxDescent) * (lineHeightMultiple - 1);
  return {
    top: Math.max(0, a.fontBoundingBoxAscent - a.actualBoundingBoxAscent + fragmentExtra),
    bottom: Math.max(0, b.fontBoundingBoxDescent - b.actualBoundingBoxDescent),
  };
}

/**
 * 貼字盒的自然尺寸——iOS `naturalContentSize` / `naturalVerticalWidth` 的移植。
 *
 * ⚠️ 為什麼一定要有這支：範本檔裡存的 frame 是 **TemplateForge 寫的估值**
 * （橫排加 25%、直排加 10% 餘裕），不是實際尺寸；iOS 端載入後由 resizeToFitText
 * 依內容重算，所以手機上的框是貼著字的。少了這步，框就會鬆一圈。
 */
export function naturalTextSize(
  ctx: CanvasRenderingContext2D,
  t: TextBlock,
  canvasWidth: number,
  pageHeight: number,
): { w: number; h: number } {
  const size = resolvedFontSize(t, canvasWidth);
  const kern = resolvedKerning(t, canvasWidth);
  const minWidth = canvasWidth * 0.08;
  ctx.save();
  ctx.font = cssFont(t, size);
  ctx.letterSpacing = `${kern}px`;

  if (t.vertical) {
    // 直排：欄高是換行約束、寬度是自動長的那一軸（與橫排的角色互換）。
    // ⚠️ 高度用**實際墨跡涵蓋範圍**而不是欄高約束——iOS 是直接把 frame 高度設成
    //    欄高（未設時＝頁高 60%），單字的框就會有一整頁高。那個框對吸附毫無意義。
    const v = verticalMetrics(ctx, t, size, kern, columnHeight(t, pageHeight));
    ctx.restore();
    return { w: Math.max(Math.ceil(v.extentW), minWidth), h: Math.max(Math.ceil(v.extentH), 1) };
  }

  const lines = t.manualWidth != null ? wrap(ctx, t.text, t.manualWidth, kern) : t.text.split("\n");
  const { lineH, paraGap } = lineMetrics(ctx, t, size, lines[0] ?? "");
  const ink = inkInsets(ctx, lines[0] ?? "", lines[lines.length - 1] ?? "", t.lineHeightMultiple ?? 1);
  const measuredW = Math.max(...lines.map((l) => lineWidth(ctx, l, kern)), 0);
  const measuredH = lines.length * lineH + Math.max(0, lines.length - 1) * paraGap;
  ctx.restore();

  // 絕對對齊（2026-08-14）：有墨跡就貼墨跡。1.3em 保底只留給空文字（框要選得到）
  // 與置中/置底的殘留框（關掉長文框後 verticalAlignment 會留下）——那些框的字是
  // 照框高排的，改高度字會位移；版面穩定鐵則：舊值走舊碼。
  const legacy = !t.text.trim() || (t.verticalAlignment ?? "top") !== "top";
  const minHeight = legacy ? size * 1.3 : 1;
  return {
    w: t.manualWidth ?? Math.max(Math.ceil(measuredW), minWidth),
    h: Math.max(Math.max(Math.ceil(measuredH), minHeight) - ink.top - ink.bottom, 1),
  };
}

/**
 * 貼字寬一鍵（絕對對齊 2026-08-14）：把殘留的手動寬度收到剛好包住現有的行。
 * ClaudeForge 這類建構器會在單行標題留 manualWidth（900 vs 墨跡 ~285），
 * 框的「空氣」全從這來——吸附咬的是框，框鬆了什麼都對不準。
 *
 * 定律「不破壞使用者文字」＝**斷行一個都不能變、字待在原地**：
 * - 沒軟換行 → manualWidth 純屬殘留，整個交還自動貼字盒；
 * - 有軟換行（或長文框）→ 收到最寬行的墨寬。收緊不會改變 greedy 斷行：
 *   每行都是塞不下下一個字才斷的，收窄後更塞不下。收完仍驗一次斷行，
 *   對不上（理論上不會）就放棄不動——寧可不收也不能重排。
 * - 錨點照對齊方式修：置中的框兩邊往內收、靠右的固定右緣。
 */
export function snugTextWidth(
  ctx: CanvasRenderingContext2D,
  b: Block,
  canvasWidth: number,
  pageHeight: number,
): boolean {
  if (b.content.type !== "text" && b.content.type !== "textFlow") return false;
  const t = b.content.text;
  if (t.vertical || t.manualWidth == null) return false;
  const size = resolvedFontSize(t, canvasWidth);
  const kern = resolvedKerning(t, canvasWidth);

  ctx.save();
  ctx.font = cssFont(t, size);
  ctx.letterSpacing = `${kern}px`;
  const lines = wrap(ctx, t.text, t.manualWidth, kern);
  const hard = t.text.split("\n");
  const same = (x: string[], y: string[]) => x.length === y.length && x.every((l, i) => l === y[i]);

  if (t.isBodyFrame || !same(lines, hard)) {
    let tight = Math.ceil(Math.max(...lines.map((l) => lineWidth(ctx, l, kern)), 1));
    let ok = same(wrap(ctx, t.text, tight, kern), lines);
    for (let i = 0; i < 6 && !ok; i++) { tight++; ok = same(wrap(ctx, t.text, tight, kern), lines); }
    ctx.restore();
    if (!ok || tight >= t.manualWidth) return false;   // 收了會重排／本來就貼著＝不動
    t.manualWidth = tight;
  } else {
    ctx.restore();
    t.manualWidth = undefined;
  }

  const oldW = b.frame.w;
  const nat = naturalTextSize(ctx, t, canvasWidth, pageHeight);
  const delta = nat.w - oldW;
  if (t.alignment === "center") b.frame.x -= delta / 2;
  else if (t.alignment === "trailing") b.frame.x -= delta;
  b.frame.w = nat.w;
  b.frame.h = nat.h;
  if (t.isBodyFrame) t.manualHeight = nat.h;   // 長文框連高度一起收到內容
  return true;
}

/**
 * 文字的「印刷線」——大寫線與基線（絕對對齊 2026-08-14）。
 * 框頂是最高墨跡（i 點、重音、括號），人眼在畫面上對的卻是這兩條線；
 * 吸附引擎多咬這兩條，「明明對了卻差幾 px」才會消失。
 * 數學逐行鏡射 drawHorizontal——量測與繪製不可能分家。
 * 基線：貼字盒取最末行（整框看得見）、長文框取第一行（末行可能被裁掉）。
 * 大寫線：第一行含拉丁/數字才有；與框頂重合（全大寫）就不另給。
 */
export function textPrintLines(
  ctx: CanvasRenderingContext2D,
  t: TextBlock,
  frame: Rect,
  canvasWidth: number,
  _pageHeight: number,   // 直排支援時要用（欄高），先收著讓呼叫端不用改
): { base: number; cap?: number } | null {
  if (t.vertical) return null;
  const size = resolvedFontSize(t, canvasWidth);
  const kern = resolvedKerning(t, canvasWidth);
  ctx.save();
  ctx.font = cssFont(t, size);
  ctx.letterSpacing = `${kern}px`;
  const lines = t.manualWidth != null ? wrap(ctx, t.text, frame.w, kern) : t.text.split("\n");
  const { lineH, paraGap } = lineMetrics(ctx, t, size, lines[0] ?? "");
  const blockH = lines.length * lineH + Math.max(0, lines.length - 1) * paraGap;
  let y0 = 0;
  if (t.verticalAlignment === "middle") y0 = (frame.h - blockH) / 2;
  else if (t.verticalAlignment === "bottom") y0 = frame.h - blockH;
  const firstAsc = ctx.measureText(lines[0] || "字").actualBoundingBoxAscent;
  const bi = t.isBodyFrame ? 0 : lines.length - 1;
  const baseAsc = bi === 0 ? firstAsc : ctx.measureText(lines[bi] || "字").actualBoundingBoxAscent;
  const base = frame.y + y0 + bi * (lineH + paraGap) + baseAsc;
  let cap: number | undefined;
  if (/[A-Za-z0-9]/.test(lines[0] ?? "")) {
    const c = frame.y + y0 + firstAsc - ctx.measureText("H").actualBoundingBoxAscent;
    if (Math.abs(c - frame.y) > 0.5) cap = c;
  }
  ctx.restore();
  return { base, cap };
}

/**
 * 把所有自動貼字盒的文字 block 重算成自然尺寸——iOS `resizeToFitText` 的移植。
 * 長文框（isBodyFrame）是固定容器，兩軸都不動。
 * 寬度變化時依對齊方式調 origin.x，否則置中的標題會往一邊飄。
 */
export function autoFitText(ctx: CanvasRenderingContext2D, project: Project): void {
  for (const b of project.blocks) {
    if (b.content.type !== "text" && b.content.type !== "textFlow") continue;
    const t = b.content.text;
    if (t.isBodyFrame) continue;   // 長文框是固定容器，兩軸都是使用者設的，不重算

    // ⛔ 直排暫不重算。我們的欄距還是估的（統一 1.22em），而 iOS 是逐字體量測
    //    「自然欄距」再補償（黑體 1.5em、宋/明/粉圓 1.0em）。用估值去「修正」
    //    只會把字推到錯的位置——實測第 7 頁的「終」就往左跑了。
    //    等 Phase 1 第 2 塊把逐字體欄距補償做完再開。
    const nat = naturalTextSize(ctx, t, project.canvasWidth, project.pageHeight);
    const delta = nat.w - b.frame.w;
    if (t.vertical) {
      // 直排由右往左排（除非 verticalLeftToRight），閱讀起點在右邊——
      // 所以收框時要固定**右緣**，字才會留在原地。固定左緣的話整段會往左跳。
      if (t.verticalLeftToRight !== true) b.frame.x -= delta;
    } else if (t.manualWidth == null) {
      // 只有自動貼字寬的才需要錨點修正——手動指定寬度的框寬度不由這裡長。
      if (t.alignment === "center") b.frame.x -= delta / 2;
      else if (t.alignment === "trailing") b.frame.x -= delta;
    }
    b.frame.w = nat.w;
    b.frame.h = nat.h;
  }
}

function drawHorizontal(
  ctx: CanvasRenderingContext2D,
  t: TextBlock,
  w: number,
  h: number,
  size: number,
  kern: number,
): void {
  // manualWidth 未設＝貼字寬、單列不換行（可自由跨頁），這是 iOS 的 auto-fit 語意。
  const lines = t.manualWidth != null ? wrap(ctx, t.text, w, kern) : t.text.split("\n");
  const { lineH, paraGap } = lineMetrics(ctx, t, size, lines[0] ?? "");

  const blockH = lines.length * lineH + Math.max(0, lines.length - 1) * paraGap;
  let y = 0;
  if (t.verticalAlignment === "middle") y = (h - blockH) / 2;
  else if (t.verticalAlignment === "bottom") y = h - blockH;

  for (const line of lines) {
    const lm = ctx.measureText(line || "字");
    const baseline = y + lm.actualBoundingBoxAscent; // 墨跡上緣貼齊 → 等同 iOS 的貼字盒
    const lw = lineWidth(ctx, line, kern);
    let x = 0;
    if (t.alignment === "center") x = (w - lw) / 2;
    else if (t.alignment === "trailing") x = w - lw;
    if (line) ctx.fillText(line, x, baseline);
    y += lineH + paraGap;
  }
}

/**
 * 直排第一版：逐字往下堆、欄由右到左（除非 verticalLeftToRight）。
 *
 * ⚠️ 待補（Phase 1 第 2 塊）：iOS 對每個字體量測「自然欄距」再補償到統一基準，
 * 因為黑體自然欄距 1.5em、宋/明/粉圓只有 1.0em——不補償的話同一個行距值在不同
 * 字體看起來差很多。這版先用 iOS 的預設落點 1.22em，只有預設字體會準。
 */
// 直排標點（2026-08-19）：iOS 端 CoreText 的 'vert' 特性會自動換直排字形，
// canvas 沒有這條路，用幾何等價做——
//   轉 90°＝括號、書名號、破折號、刪節號、波浪、底線（順時針轉即是直排形）；
//   頂右位＝句逗頓號（直排的點座落在字格右上，不轉）。
// ！？：；照台灣直排慣例維持直立。半形英數維持現狀（逐字直立）。
const VERT_ROTATE = new Set([..."（）「」『』《》〈〉【】〔〕〖〗﹙﹚()[]{}＜＞<>—–―ー～〜…‥＝=＿_￣"]);
const VERT_SHIFT  = new Set([..."、。，．"]);

function drawVertical(
  ctx: CanvasRenderingContext2D,
  t: TextBlock,
  w: number,
  size: number,
  kern: number,
  colH: number,
  wholeColumnsOnly = false,
): void {
  const v = verticalMetrics(ctx, t, size, kern, colH);
  const ltr = t.verticalLeftToRight === true;

  ctx.save();
  ctx.letterSpacing = "0px"; // 直排的進距是自己逐字推的，不能讓 canvas 再加一次
  v.cols.forEach((col, i) => {
    // 欄心距框邊 inkW/2——與 verticalMetrics 的 extentW 同一個約定，
    // 所以貼字盒會剛好包住墨跡，兩邊不會各算各的。
    const cx = ltr ? v.inkW / 2 + i * v.pitch : w - v.inkW / 2 - i * v.pitch;
    // 長文框：整欄放不下容器就不排（RTL 溢出在左、LTR 在右，一條件兩向都蓋）
    if (wholeColumnsOnly && (cx - v.inkW / 2 < -0.5 || cx + v.inkW / 2 > w + 0.5)) return;
    let y = 0;
    for (const ch of col) {
      const m = ctx.measureText(ch);
      if (VERT_ROTATE.has(ch)) {
        // 繞字格中心順時針轉 90°；轉完把墨跡置中（括號的墨在 em 裡偏一側，不置中會歪）
        ctx.save();
        ctx.translate(cx, y + size / 2);
        ctx.rotate(Math.PI / 2);
        ctx.fillText(ch, -m.width / 2,
          (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2);
        ctx.restore();
      } else if (VERT_SHIFT.has(ch)) {
        // 句逗頓號：墨跡從字格左下搬到右上（直排排版慣例），位移半個字格
        ctx.fillText(ch, cx - m.width / 2 + size * 0.5, y + m.actualBoundingBoxAscent - size * 0.5);
      } else {
        ctx.fillText(ch, cx - m.width / 2, y + m.actualBoundingBoxAscent);
      }
      y += v.advance;
    }
  });
  ctx.restore();
}
