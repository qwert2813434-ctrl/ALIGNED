// 殼層跑在哪個桌面平台。只有「介面語彙」該問這個問題——
// 按鍵判斷一律同時吃 metaKey 與 ctrlKey，不靠這支分岔。
export const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** 加／減選的修飾鍵：Mac 是 ⇧／⌘，Windows 是 Shift／Ctrl。
 *  Mac 不能收 ctrlKey——那邊 ctrl＋點是叫出右鍵選單，會變成誤加選。 */
export const additiveClick = (e: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) =>
  e.shiftKey || (IS_MAC ? e.metaKey : e.ctrlKey);

/** 介面現在是不是深色——先看手動外觀（html[data-theme]，齒輪選單設），沒設才問系統。
 *  reload 策略（跟語言切換同款）下開機讀一次即可，不用監聽變化。 */
export function uiDark(): boolean {
  const t = document.documentElement.dataset.theme;
  return t ? t === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
}
