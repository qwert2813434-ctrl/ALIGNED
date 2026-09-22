// ALIGN Core — 跨專案剪貼簿的純邏輯（檔案搬運與素材載入在殼層 main.ts）。
//
// 設計：⌘C 把選取序列化（素材記**絕對來源路徑**）存 localStorage——換專案、
// 重開 App 都還在；⌘V 時殼層把來源檔複製進目標專案的 assets/（copy_asset
// 重取檔名，天生避開同名不同檔的碰撞），這裡負責改寫 id／zIndex／
// assetFileName／座標。
//
// 座標規則：貼到「正在看的那一頁」，保留選取內的相對排列與頁內位置
// （跨多頁的選取整組平移，頁距照舊）；**貼回同一份專案的同一頁**才偏移 48
// （跟 ⌘D 同款錯開量），不然疊在原件上看不出貼了。

import type { Block, Project, Rect } from "./schema";

export interface BlockClipboard {
  projectId: string;
  canvasWidth: number;
  blocks: Block[];
  /** assetFileName（含影片海報 `<名>.poster.jpg`）→ 絕對來源路徑。
   *  來源專案沒有 assets/（範本、還沒存檔）就不會有對應項。 */
  assetSrc: Record<string, string>;
}

/** 收集選取成剪貼簿內容。assetsRoot＝來源專案 assets/ 的絕對路徑（可為 null）。 */
export function buildClipboard(
  project: Project, blocks: Block[], assetsRoot: string | null,
): BlockClipboard {
  const assetSrc: Record<string, string> = {};
  for (const b of blocks) {
    if (!assetsRoot) continue;
    if (b.content.type === "image" || b.content.type === "video") {
      const m = b.content.media;
      if (!m.assetFileName) continue;
      assetSrc[m.assetFileName] = `${assetsRoot}/${m.assetFileName}`;
      if (b.content.type === "video") {
        assetSrc[`${m.assetFileName}.poster.jpg`] = `${assetsRoot}/${m.assetFileName}.poster.jpg`;
      }
      // 輪播的後續張數（漏了的話貼到新專案只剩第一張）
      for (const f of m.carouselAssets ?? []) assetSrc[f] = `${assetsRoot}/${f}`;
      // 去背遮罩：漏了的話貼過去的去背圖／填顏色層變成一整塊實心方形，
      // 而且不報錯（渲染端查不到遮罩就整段跳過 destination-in）。2026-09-01 審查。
      if (m.matteFileName) assetSrc[m.matteFileName] = `${assetsRoot}/${m.matteFileName}`;
    } else if (b.content.type === "model" && b.content.model.assetFileName) {
      // 3D 的 .glb 同理——不搬檔的話貼過去是個懸空檔名，只畫得出佔位
      assetSrc[b.content.model.assetFileName] = `${assetsRoot}/${b.content.model.assetFileName}`;
    }
  }
  return {
    projectId: project.id, canvasWidth: project.canvasWidth,
    blocks: structuredClone(blocks), assetSrc,
  };
}

/**
 * 把剪貼簿內容改寫成可插入目標專案的新 blocks（不動 target，插入由殼層做）。
 * renamed＝殼層搬完素材後的「舊名 → 新名」；搬失敗的不在表裡，
 * 舊名留著會畫成佔位框（placeholderForMissingMedia），不會炸。
 */
export function pasteBlocks(
  clip: BlockClipboard, target: Project, viewPage: number,
  renamed: Map<string, string>, newId: () => string,
): Block[] {
  if (!clip.blocks.length) return [];
  const zs = target.blocks.map((k) => k.zIndex);
  let top = zs.length ? Math.max(...zs) : 0;
  const srcW = clip.canvasWidth || target.canvasWidth;
  const basePage = Math.min(...clip.blocks.map((b) => Math.floor((b.frame.x + b.frame.w / 2) / srcW)));
  const dx = viewPage * target.canvasWidth - basePage * srcW;
  const nudge = clip.projectId === target.id && dx === 0 ? 48 : 0;
  return clip.blocks.map((b) => {
    const nb = structuredClone(b);
    nb.id = newId();
    nb.zIndex = ++top;
    nb.locked = false;   // 鎖著的拷過去還鎖＝貼完點不到，先解開
    nb.frame = { ...nb.frame, x: nb.frame.x + dx + nudge, y: nb.frame.y + nudge };
    if ((nb.content.type === "image" || nb.content.type === "video") && nb.content.media.assetFileName) {
      const m = nb.content.media;
      const nn = renamed.get(m.assetFileName);
      if (nn) m.assetFileName = nn;
      // 輪播清單逐張改名（搬失敗的留舊名＝那一張畫佔位，其餘照常輪播）
      if (m.carouselAssets?.length) m.carouselAssets = m.carouselAssets.map((f) => renamed.get(f) ?? f);
      // 遮罩：搬到了就改新名，**搬不到就清掉**——留死引用只會靜靜換掉外觀（變實心方塊），
      // 清掉至少讓人看得出「這張沒去背」，也不會被下一次存檔寫成永久的壞參照。
      if (m.matteFileName) m.matteFileName = renamed.get(m.matteFileName);
    } else if (nb.content.type === "model" && nb.content.model.assetFileName) {
      const nn = renamed.get(nb.content.model.assetFileName);
      if (nn) nb.content.model.assetFileName = nn;
    }
    return nb;
  });
}

// ── 貼進既有的框（2026-09-23 小高：「貼上到另一個圖形上，大小跟邊框照著那一個」） ──
//
// 用途是**搬欄位**：拷貝一張照片，貼到另一個框裡，版面一格都不動。
// 換的是「照片那一半」（素材、輪播、去背、拉直、濾鏡、調整），
// 留的是「框那一半」（位置大小、旋轉、描邊、圓角／遮罩形狀、撕紙邊、陰影、文繞圖）。

/** 完全以目標框為準的欄位——框的長相是版面的一部分，不該被貼進來的照片帶走。
 *  目標沒設的就刪掉來源的值（「沒有邊框」也是一種設定）。 */
const FRAME_FIELDS = [
  "maskShape", "maskIsCircle", "maskCornerRadius",
  "strokeHex", "strokeWidth", "excludesText", "textWrapMode",
  "tornStyle", "tornSides", "tornAmt", "tornDeform", "tornRough", "tornSeed",
  "shadowOpacity", "shadowBlur", "shadowDx", "shadowDy", "shadowHex",
] as const;

/**
 * 把來源裁切區收成目標框的長寬比，中心不動。
 * 照抄 cropRect 會把畫面拉扁（來源框 4:5、目標框 1:1 時最明顯）；
 * 這裡**只收不放**，所以永遠不會露白。natural＝素材原尺寸（像素）。
 */
export function refitCrop(c: Rect, natural: { w: number; h: number }, frame: Rect): Rect {
  const uncropped = !(c.w > 0.001 && c.h > 0.001) || (c.w > 0.999 && c.h > 0.999);
  const c0 = uncropped ? { x: 0, y: 0, w: 1, h: 1 } : c;
  const want = frame.w / frame.h;
  const have = (c0.w * natural.w) / (c0.h * natural.h);
  if (!(want > 0) || !(have > 0)) return { ...c0 };
  const w = have > want ? c0.w * (want / have) : c0.w;
  const h = have > want ? c0.h : c0.h * (have / want);
  const cx = c0.x + c0.w / 2, cy = c0.y + c0.h / 2;
  return {
    x: Math.min(Math.max(cx - w / 2, 0), Math.max(0, 1 - w)),
    y: Math.min(Math.max(cy - h / 2, 0), Math.max(0, 1 - h)),
    w, h,
  };
}

/**
 * 剪貼簿裡是不是「單獨一張照片／影片」——只有這種才談得上貼進某個框。
 * 多選、純文字、圖形、3D 一律照舊貼成新元件。
 */
export function clipIsSingleMedia(clip: BlockClipboard | null): boolean {
  const b = clip?.blocks.length === 1 ? clip.blocks[0] : null;
  return !!b && (b.content.type === "image" || b.content.type === "video")
    && !!b.content.media.assetFileName;
}

/** 這個 block 收不收得下貼進來的畫面（空欄位槽也算——範本的填圖欄位就是這樣填的）。 */
export function canPasteInto(b: Block | null): boolean {
  return !!b && !b.locked && (b.content.type === "image" || b.content.type === "video");
}

/**
 * 把剪貼簿那一張貼進 target（就地改，不動 frame／rotation／zIndex／locked）。
 * renamed＝素材搬進目標專案後的新檔名表；natural＝新素材的原尺寸，
 * 拿不到就退回哨兵值 (0,0,1,1)＝滿版置中，之後雙擊調整照樣能搬。
 */
export function pasteMediaInto(
  target: Block, clip: BlockClipboard, renamed: Map<string, string>,
  natural: { w: number; h: number } | null,
): boolean {
  const src = clip.blocks[0];
  if (!clipIsSingleMedia(clip) || !canPasteInto(target)) return false;
  if (src.content.type !== "image" && src.content.type !== "video") return false;
  if (target.content.type !== "image" && target.content.type !== "video") return false;
  const tm = target.content.media;
  const m = structuredClone(src.content.media);
  const rn = (f: string | undefined): string | undefined => (f ? renamed.get(f) ?? f : undefined);

  m.assetFileName = rn(m.assetFileName) ?? m.assetFileName;
  if (m.carouselAssets?.length) m.carouselAssets = m.carouselAssets.map((f) => rn(f) ?? f);
  // 遮罩搬不過來就清掉：留死引用會安靜變成一塊實心方形（同 pasteBlocks 的理由）
  if (m.matteFileName) m.matteFileName = renamed.get(m.matteFileName);
  m.cropRect = natural ? refitCrop(m.cropRect, natural, target.frame) : { x: 0, y: 0, w: 1, h: 1 };

  for (const k of FRAME_FIELDS) {
    const v = (tm as unknown as Record<string, unknown>)[k];
    if (v === undefined) delete (m as unknown as Record<string, unknown>)[k];
    else (m as unknown as Record<string, unknown>)[k] = v;
  }
  // 影片貼進圖片框（或反過來）要連型別一起換，否則畫得出來卻不會播
  target.content = src.content.type === "video"
    ? { type: "video", media: m }
    : { type: "image", media: m };
  return true;
}
