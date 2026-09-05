import { __ } from "./i18n";
import { PALETTE } from "./palette";

// 自家選色面板（2026-09-05 小高：「希望色票裡有標準色，以及我們自己配色的深淺差異」）。
// WebKit 原生 <input type=color> 的色格改不了，所以入口全部換成這一片；原生選色器只留在
// 最底下「任何顏色…」那顆（要吸管、要細調的人再進去）。
// 三區：色票（十顆）→ 深淺（十欄各五階，墨／紙兩欄就是灰階）→ 標準色；底下 hex 欄＋任何顏色。

const STANDARD = ["C8102E", "E87722", "F2C230", "6BA539", "2E8B57", "1F9E9E", "2E6DB4", "4B4E9E", "7B4F9D", "C85A8C"];
/** 彩色五階：往白 60%／30%、本色、往黑 25%／50%。墨與紙是中性階（一路往白／一路往黑），
 *  所以深淺格本身就含灰階，不另開一列。 */
const STEPS: [number, boolean][] = [[0.6, true], [0.3, true], [0, true], [0.25, false], [0.5, false]];
const INK_STEPS: [number, boolean][] = [[0.75, true], [0.55, true], [0.35, true], [0.15, true], [0, true]];
const PAPER_STEPS: [number, boolean][] = [[0, true], [0.08, false], [0.2, false], [0.35, false], [0.55, false]];

function mix(hex: string, amt: number, toWhite: boolean): string {
  const t = toWhite ? 255 : 0;
  return [0, 2, 4].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16);
    return Math.round(v + (t - v) * amt).toString(16).padStart(2, "0");
  }).join("").toUpperCase();
}
export function shades(hex: string): string[] {
  const steps = hex === "1A1A1A" ? INK_STEPS : hex === "FFFFFF" ? PAPER_STEPS : STEPS;
  return steps.map(([a, w]) => (a === 0 ? hex : mix(hex, a, w)));
}

let pop: HTMLDivElement | null = null;
let offClose: (() => void) | null = null;

export function closeColorPop(): void { offClose?.(); offClose = null; pop?.remove(); pop = null; }

export function openColorPop(anchor: HTMLElement, cur: string,
                             on: { live?: (hex: string) => void; pick: (hex: string) => void }): void {
  closeColorPop();
  const el = document.createElement("div");
  el.id = "colorpop";
  const norm = (h: string): string => h.replace(/^#/, "").toUpperCase().slice(0, 6);
  let current = norm(cur);
  const sw = (hex: string): HTMLButtonElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cp-sw" + (hex === current ? " on" : "");
    b.style.background = `#${hex}`;
    b.title = `#${hex}`;
    b.addEventListener("click", () => { on.pick(hex); closeColorPop(); });
    return b;
  };
  const head = (title: string): void => {
    const h = document.createElement("div"); h.className = "cp-h"; h.textContent = title; el.append(h);
  };
  const row = (title: string, hexes: readonly string[]): void => {
    head(title);
    const g = document.createElement("div"); g.className = "cp-row";
    for (const x of hexes) g.append(sw(x));
    el.append(g);
  };
  row(__("色票"), PALETTE);
  head(__("深淺"));
  // 跟上面的色票一格對一格（十欄），方格為主
  const grid = document.createElement("div"); grid.className = "cp-grid";
  grid.style.gridTemplateColumns = `repeat(${PALETTE.length}, 1fr)`;
  for (let s = 0; s < STEPS.length; s++) for (const h of PALETTE) grid.append(sw(shades(h)[s]));
  el.append(grid);
  row(__("標準色"), STANDARD);
  const foot = document.createElement("div"); foot.className = "cp-foot";
  const hexIn = document.createElement("input");
  hexIn.type = "text"; hexIn.className = "cp-hex"; hexIn.spellcheck = false; hexIn.value = `#${current}`;
  hexIn.addEventListener("change", () => {
    const v = norm(hexIn.value);
    if (/^[0-9A-F]{6}$/.test(v)) { on.pick(v); closeColorPop(); } else hexIn.value = `#${current}`;
  });
  const any = document.createElement("label"); any.className = "cp-any"; any.textContent = __("任何顏色…");
  const native = document.createElement("input");
  native.type = "color"; native.value = `#${current}`;
  native.addEventListener("input", () => { current = norm(native.value); hexIn.value = `#${current}`; on.live?.(current); });
  native.addEventListener("change", () => { on.pick(norm(native.value)); closeColorPop(); });
  any.append(native);
  foot.append(hexIn, any);
  el.append(foot);
  document.body.append(el);
  // 定位：錨點下方；貼右邊就往左收；超出底部就翻到上面
  const r = anchor.getBoundingClientRect();
  const W = el.offsetWidth, H = el.offsetHeight;
  let y = r.bottom + 6;
  if (y + H > window.innerHeight - 8) y = Math.max(8, r.top - H - 6);
  el.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - W - 8))}px`;
  el.style.top = `${y}px`;
  pop = el;
  // 點外面／Esc 關。原生選色器是系統視窗，點它事件不會進 document，不算「外面」。
  const onDown = (e: PointerEvent): void => {
    if (!el.contains(e.target as Node) && e.target !== anchor) closeColorPop();
  };
  const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") closeColorPop(); };
  window.setTimeout(() => {
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
  }, 0);
  offClose = () => {
    document.removeEventListener("pointerdown", onDown, true);
    document.removeEventListener("keydown", onKey, true);
  };
}
