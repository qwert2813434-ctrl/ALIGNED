// 介面偏好（2026-09-01）。跟**使用者**走不跟專案走，所以存 localStorage、
// 不進 project.json（進了就綁三平台同版，為了一顆開關不值得）。
//
// ⚠️ 這支只給殼層（main.ts／偏好設定視窗）用，**不要被 core/ 或 worker 鏈 import**——
// worker 沒有 localStorage，頂層一碰整個 worker 當場死（i18n 就這樣靜靜害死影片濾鏡，
// 2026-09-01 才查出來）。下面還是加了守衛，但別把它拉進那條鏈裡。

const KEY = "alignedUIPrefs";

export interface UIPrefs {
  /** 選取元件時旁邊那排浮動小按鈕。預設開；不想要的人自己關。 */
  selbar: boolean;
}

export const UI_DEFAULTS: UIPrefs = { selbar: true };

let cur: UIPrefs = { ...UI_DEFAULTS };
try {
  if (typeof localStorage !== "undefined") {
    const j = localStorage.getItem(KEY);
    if (j) Object.assign(cur, JSON.parse(j) as Partial<UIPrefs>);
  }
} catch { /* 壞值＝回預設 */ }

const listeners: (() => void)[] = [];

export function getUIPrefs(): UIPrefs { return cur; }

export function setUIPref<K extends keyof UIPrefs>(k: K, v: UIPrefs[K]): void {
  if (cur[k] === v) return;
  cur = { ...cur, [k]: v };
  try { localStorage.setItem(KEY, JSON.stringify(cur)); } catch { /* 私隱模式：只影響下次開機 */ }
  for (const f of listeners) f();
}

/** 偏好改了就通知殼層重畫（回傳解除訂閱）。 */
export function onUIPrefsChanged(f: () => void): () => void {
  listeners.push(f);
  return () => { const i = listeners.indexOf(f); if (i >= 0) listeners.splice(i, 1); };
}
