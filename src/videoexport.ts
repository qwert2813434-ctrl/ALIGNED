// 影片頁匯出：把一頁拆成「靜態圖層 ↔ 影片」的堆疊，交給 alignvideo（AVFoundation）合成。
//
// 分工的理由：**畫面歸畫面、影片歸影片**。靜態圖層、遮罩、外框都由這邊的畫布渲染
// （那條路已經跟 iOS 逐像素比對過，重畫一次反而是新的漂移來源）；影片的解碼、裁切、
// 循環、音軌、編碼交給 AVFoundation——那是 iPad 版用的同一套框架。
//
// 層的順序與 iOS `VideoPageExporter` 相同：由下而上，第一段靜態圖層帶頁面背景、
// 之後每一段只有「上一支影片與這一支影片之間」的 block，最後一段是最上面那支影片之上的全部。

import type { Block, Project } from "./core/schema";
import { pageRect } from "./core/geometry";
import { maskAndStrokeCanvases, renderPageCanvas, type RenderOptions } from "./core/render";
import { toBlob } from "./core/export";

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
