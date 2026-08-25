// 影片頁匯出：把一頁拆成「靜態圖層 ↔ 影片」的堆疊，交給 alignvideo（AVFoundation）合成。
//
// 分工的理由：**畫面歸畫面、影片歸影片**。靜態圖層、遮罩、外框都由這邊的畫布渲染
// （那條路已經跟 iOS 逐像素比對過，重畫一次反而是新的漂移來源）；影片的解碼、裁切、
// 循環、音軌、編碼交給 AVFoundation——那是 iPad 版用的同一套框架。
//
// 層的順序與 iOS `VideoPageExporter` 相同：由下而上，第一段靜態圖層帶頁面背景、
// 之後每一段只有「上一支影片與這一支影片之間」的 block，最後一段是最上面那支影片之上的全部。

import type { Block, Project } from "./core/schema";
import { ANIM_STAGGER, effectiveHold, motionTempo, timelineCycle, type BlockAnim } from "./core/anim";
import { pageRect } from "./core/geometry";
import { applyFilter } from "./core/filters";
import { maskAndStrokeCanvases, renderPageCanvas, type RenderOptions } from "./core/render";
import { toBlob } from "./core/export";
import { hiddenHost } from "./videopool";

export interface VideoLayerSpec {
  type: "still" | "video";
  path: string;
  x?: number; y?: number; w?: number; h?: number;
  crop?: { x: number; y: number; w: number; h: number };
  filter?: string;
  mask?: string;
  stroke?: string;
}

export interface VideoPageSpec {
  output: string;
  pageWidth: number;
  pageHeight: number;
  fps: number;
  mute: boolean;
  paper?: string;
  layers: VideoLayerSpec[];
}

/** 這一頁有沒有「真的帶素材」的影片。空欄位框不算——它是靜態佔位樣式。 */
export function pageHasVideo(p: Project, index: number): boolean {
  const page = pageRect(p, index);
  return p.blocks.some((b) => b.content.type === "video" && !!b.content.media.assetFileName
    && b.frame.x < page.x + page.w && page.x < b.frame.x + b.frame.w
    && b.frame.y < page.y + page.h && page.y < b.frame.y + b.frame.h);
}

/** 這一頁有沒有「會動的東西」（出場動畫、多圖輪播或 3D 展示）——有就走逐格影格匯出。 */
export function pageHasMotion(p: Project, index: number): boolean {
  const page = pageRect(p, index);
  return p.blocks.some((b) =>
    b.frame.x < page.x + page.w && page.x < b.frame.x + b.frame.w
    && b.frame.y < page.y + page.h && page.y < b.frame.y + b.frame.h
    && (!!b.anim
      || (b.content.type === "image" && !!b.content.media.carouselAssets?.length)
      || (b.content.type === "model" && !!b.content.model.mode)
      || (b.content.type === "doodle" && !!(b.content.doodle.play || b.content.doodle.wobble))));
}

/** 烤片的目標像素——**偶數**（H.264 的 chroma 取樣要求），與工具端的 roundEven 一致。 */
const roundEven = (v: number): number => {
  const n = Math.round(v);
  return n - (n % 2);
};

export interface BuildDeps {
  /** 存 PNG（base64）到指定路徑。 */
  savePng: (path: string, base64: string) => Promise<void>;
  /** 素材檔名 → 磁碟上的絕對路徑。 */
  assetPath: (file: string) => string;
  renderOpts: RenderOptions;
}

async function pngBase64(canvas: HTMLCanvasElement): Promise<string> {
  const bytes = new Uint8Array(await (await toBlob(canvas)).arrayBuffer());
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

// ── 出場動畫頁：逐格渲染（2026-08-16）──────────────────────────────────
// 動畫頁走**跟預覽同一條 renderPageCanvas 路**逐格烤成 JPEG，alignvideo 的
// frames 模式只負責編碼——所見即所得，不存在第二套動畫實作。
// 頁上有真影片＝逐格 seek 取樣（同 t 永遠取同格，兩次匯出一模一樣）。無聲。

export interface AnimExportDeps {
  /** 存 JPEG（base64）到指定路徑（與 save_png 同一條命令——bytes 就是 bytes）。 */
  saveJpg: (path: string, base64: string) => Promise<void>;
  /** 影片素材檔名 → 可播放 URL；null＝取不到（畫海報）。 */
  videoUrl: ((file: string) => string) | null;
  renderOpts: RenderOptions;
  onProgress?: (done: number, total: number) => void;
}

/** 把一頁的動畫逐格烤進 `dir`（f-000000.jpg…），回影格數與循環秒數。 */
export async function buildAnimFrames(
  project: Project, index: number, dir: string,
  opts: { fps: number }, deps: AnimExportDeps,
): Promise<{ count: number; cycle: number }> {
  const page = pageRect(project, index);
  const onPage = project.blocks.filter((b) =>
    b.frame.x < page.x + page.w && page.x < b.frame.x + b.frame.w
    && b.frame.y < page.y + page.h && page.y < b.frame.y + b.frame.h);

  const anims = new Map<string, BlockAnim>();
  for (const b of onPage) if (b.anim) anims.set(b.id, b.anim);

  // 頁上的真影片：各開一個 seek 用的播放器（靜音、不真播，只跳格取像）。
  // ⚠️ **濾鏡代號要一起記**：drawMedia 查影格的鍵是「檔名|濾鏡」，只塞裸檔名的話
  // 有濾鏡的影片查不到即時影格 → 退回海報圖 → 整支片在成品裡定格
  // （2026-08-16 使用者回報「濾鏡效果會讓影片輸出定格」的根因）。
  const vids = new Map<string, {
    el: HTMLVideoElement; canvas: HTMLCanvasElement;
    /** 這個檔被哪些濾鏡用（""＝無濾鏡）→ 每格各產一份，鍵與 drawMedia 對齊。 */
    keys: Set<string>; scratch: Map<string, HTMLCanvasElement>;
  }>();
  if (deps.videoUrl) {
    for (const b of onPage) {
      if (b.content.type !== "video" || !b.content.media.assetFileName) continue;
      const file = b.content.media.assetFileName;
      const fk = b.content.media.filterKey ?? "";
      const had = vids.get(file);
      if (had) { had.keys.add(fk); continue; }
      const el = document.createElement("video");
      el.muted = true; el.playsInline = true; el.preload = "auto";
      const src = deps.videoUrl(file);
      if (src.startsWith("http")) el.crossOrigin = "anonymous";   // 不加會 taint 畫布
      el.src = src;
      hiddenHost().append(el);
      await new Promise<void>((res) => {
        if (el.readyState >= 1) { res(); return; }
        el.addEventListener("loadedmetadata", () => res(), { once: true });
        setTimeout(res, 3000);   // 讀不到 metadata 就放棄這支（畫海報）
      });
      if (!el.videoWidth) { el.remove(); continue; }
      const cap = Math.min(1, 1350 / Math.max(el.videoWidth, el.videoHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(2, Math.round(el.videoWidth * cap));
      canvas.height = Math.max(2, Math.round(el.videoHeight * cap));
      vids.set(file, { el, canvas, keys: new Set([fk]), scratch: new Map() });
    }
  }

  // 時間軸在影片 metadata 之後才算：片長要進週期（循環進位到片長整數倍＝影片演完整支），
  // 而且頁上有會播的內容時停留自動歸零（effectiveHold，2026-08-26 規則）。
  const tempo = motionTempo(onPage, (file) => {
    const d = vids.get(file)?.el.duration;
    return Number.isFinite(d) ? d : undefined;
  });
  const { lead, cycle } = timelineCycle(anims.values(), tempo.periods,
    effectiveHold(tempo, project.animHold), project.animStagger ?? ANIM_STAGGER, tempo.minEnd);

  const videos = new Map<string, CanvasImageSource>();
  const total = Math.round(cycle * opts.fps);
  try {
    for (let f = 0; f < total; f++) {
      const t = f / opts.fps - lead;   // 與 editor.paint 同一條取時：負的那段＝0 狀態
      for (const [file, v] of vids) {
        const d = v.el.duration;
        if (!Number.isFinite(d) || d <= 0) continue;
        const target = Math.max(0, t) % d;
        if (Math.abs(v.el.currentTime - target) > 1 / (opts.fps * 2)) {
          v.el.currentTime = target;
          await new Promise<void>((res) => {
            const done = (): void => { v.el.removeEventListener("seeked", done); res(); };
            v.el.addEventListener("seeked", done);
            setTimeout(done, 500);   // seek 卡住＝用當前格，匯出不能死在這
          });
        }
        v.canvas.getContext("2d")!.drawImage(v.el, 0, 0, v.canvas.width, v.canvas.height);
        for (const fk of v.keys) {
          if (!fk || !deps.renderOpts.filters) { videos.set(file, v.canvas); continue; }
          // 有濾鏡：套在這一格上，鍵帶濾鏡代號（與 drawMedia 的查表鍵一致）
          let sc = v.scratch.get(fk);
          if (!sc) {
            sc = document.createElement("canvas");
            sc.width = v.canvas.width; sc.height = v.canvas.height;
            v.scratch.set(fk, sc);
          }
          const scx = sc.getContext("2d", { willReadFrequently: true })!;
          scx.drawImage(v.canvas, 0, 0);
          const px = scx.getImageData(0, 0, sc.width, sc.height);
          applyFilter(fk, px, deps.renderOpts.filters);
          scx.putImageData(px, 0, 0);
          videos.set(`${file}|${fk}`, sc);
        }
      }
      const c = renderPageCanvas(project, index, {
        ...deps.renderOpts, videos, anims, time: t,
        placeholderForMissingMedia: false,
      });
      await deps.saveJpg(`${dir}/f-${String(f).padStart(6, "0")}.jpg`,
                         c.toDataURL("image/jpeg", 0.92).split(",")[1]);
      deps.onProgress?.(f + 1, total);
    }
  } finally {
    for (const v of vids.values()) v.el.remove();
  }
  return { count: total, cycle };
}

/**
 * 組出一頁的匯出規格，並把需要的 PNG 都寫進 `dir`。
 * 回 null＝這一頁沒有影片（呼叫端該走 PNG 匯出）。
 */
export async function buildPageSpec(
  project: Project, index: number, dir: string, output: string,
  opts: { fps: number; mute: boolean }, deps: BuildDeps,
): Promise<VideoPageSpec | null> {
  const page = pageRect(project, index);
  const onPage = project.blocks
    .filter((b) => b.frame.x < page.x + page.w && page.x < b.frame.x + b.frame.w
                && b.frame.y < page.y + page.h && page.y < b.frame.y + b.frame.h)
    .sort((a, b) => a.zIndex - b.zIndex);
  const isLiveVideo = (b: Block) => b.content.type === "video" && !!b.content.media.assetFileName;
  const videoIdx = onPage.map((b, i) => (isLiveVideo(b) ? i : -1)).filter((i) => i >= 0);
  if (!videoIdx.length) return null;

  const layers: VideoLayerSpec[] = [];
  let file = 0;

  /** 把 (lower, upper) 之間的靜態 block 畫成一張透明 PNG；沒有 block 也要畫第一段（它帶背景）。 */
  const still = async (lower: number, upper: number, withBackground: boolean): Promise<void> => {
    const ids = new Set(onPage.slice(lower + 1, upper).filter((b) => !isLiveVideo(b)).map((b) => b.id));
    if (!ids.size && !withBackground) return;
    const canvas = renderPageCanvas(project, index, {
      ...deps.renderOpts,
      onlyBlockIds: ids,
      transparent: !withBackground,
      placeholderForMissingMedia: false,   // 匯出不畫編輯用的缺圖虛線
      // 紙張**只能由合成器套一次**（applyPaperCILive 蓋整個 composite）。
      // 這裡再烤進去的話，靜態圖層會被套兩次、影片區只有一次——整頁深淺不一
      filters: undefined,
    });
    const path = `${dir}/still-${file++}.png`;
    await deps.savePng(path, await pngBase64(canvas));
    layers.push({ type: "still", path });
  };

  let prev = -1;
  for (const [n, idx] of videoIdx.entries()) {
    await still(prev, idx, n === 0);
    const b = onPage[idx];
    if (b.content.type !== "video") continue;
    const m = b.content.media;
    const w = roundEven(b.frame.w), h = roundEven(b.frame.h);
    const { mask, stroke } = maskAndStrokeCanvases(m, w, h);
    const layer: VideoLayerSpec = {
      type: "video",
      path: deps.assetPath(m.assetFileName),
      x: b.frame.x - page.x, y: b.frame.y - page.y, w, h,
      crop: { ...m.cropRect },
      filter: m.filterKey,
    };
    if (mask) {
      layer.mask = `${dir}/mask-${file++}.png`;
      await deps.savePng(layer.mask, await pngBase64(mask));
    }
    if (stroke) {
      layer.stroke = `${dir}/stroke-${file++}.png`;
      await deps.savePng(layer.stroke, await pngBase64(stroke));
    }
    layers.push(layer);
    prev = idx;
  }
  await still(prev, onPage.length, false);

  return {
    output, pageWidth: page.w, pageHeight: page.h,
    fps: opts.fps, mute: opts.mute, paper: project.paperKey, layers,
  };
}
