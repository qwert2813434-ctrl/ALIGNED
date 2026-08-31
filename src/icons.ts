// 選取浮動晶片與檢視器**共用**的一組動作圖示（20×20 viewBox）。
//
// 為什麼要共用一份：同一個動作在兩個地方出現就得長一樣。小高 2026-09-01：
// 「上下移動 icon 沒有改到，我希望他可以跟小按鈕圖案 icon」——檢視器那兩顆還是舊的
// 疊方塊，而晶片列早就換成箭頭語意了（三顆都畫成疊方塊實測分不出來）。
// 抄兩份遲早會再分岔，所以路徑資料只留這一份。

export const CHIP = {
  copy: '<rect x="7" y="7" width="9.5" height="9.5" rx="1.6"/><path d="M13 4.5H5.2A1.7 1.7 0 003.5 6.2V14"/>',
  del: '<path d="M4.5 6h11"/><path d="M8 6V4.4h4V6"/><path d="M6 6l.8 9.2A1.3 1.3 0 008.1 16.4h3.8a1.3 1.3 0 001.3-1.2L14 6"/>',
  lock: '<rect x="4.5" y="9" width="11" height="7.5" rx="1.5"/><path d="M7 9V6.8a3 3 0 016 0V9"/>',
  unlock: '<rect x="4.5" y="9" width="11" height="7.5" rx="1.5"/><path d="M7 9V6.8a3 3 0 015.6-1.4"/>',
  // 前／後用箭頭講語意——「一個方塊＋它往哪邊走」比兩個疊方塊好認太多
  front: '<rect x="3" y="8.5" width="8.5" height="8.5" rx="1.5"/><path d="M14.5 8V2.8"/><path d="M12.2 5.1l2.3-2.3 2.3 2.3"/>',
  back: '<rect x="3" y="3" width="8.5" height="8.5" rx="1.5"/><path d="M14.5 12v5.2"/><path d="M12.2 14.9l2.3 2.3 2.3-2.3"/>',
  // 續畫：一支筆。選到塗鴉時晶片列第一顆＝直接回去畫那張
  draw: '<path d="M12.2 3.8l4 4L8 16H4v-4z"/><path d="M10.5 5.5l4 4"/>',
  check: '<path d="M4.5 10.4l3.6 3.4 7.4-8"/>',
} as const;

/** 包成 svg。size 只改渲染尺寸，viewBox 固定 20——線寬跟著等比縮，兩處看起來一致。 */
export const chipIcon = (path: string, size = 17): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 20 20" fill="none" stroke="currentColor"
    stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
