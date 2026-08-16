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

import type { Block, Project } from "./schema";

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
    } else if (nb.content.type === "model" && nb.content.model.assetFileName) {
      const nn = renamed.get(nb.content.model.assetFileName);
      if (nn) nb.content.model.assetFileName = nn;
    }
    return nb;
  });
}
