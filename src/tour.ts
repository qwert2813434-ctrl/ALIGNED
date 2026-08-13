import { __, __f } from "./i18n";
// 操作導覽：藍框框住「現在要動的那個東西」，帶著把核心動作與排開系統各做一次。
// 引擎是通用的：主程式給步驟（說什麼／框誰／怎麼算做到），這裡只管卡片、藍框、節奏。
// 藍框每幀重算——元件被拖走、視角縮放、目標從畫布換到檢視器開關，框都跟著走。
// Esc 或「結束導覽」隨時退出；狀態式判定在進步時就成立的（例如長文框本來就開著）直接跳過，不卡人。

export type Rect = { x: number; y: number; w: number; h: number };

export interface TourStep {
  say: string;
  /** 藍框框誰；回 null＝這步不框（純說明） */
  target?: () => Rect | null;
  /** 動作訊號（commit tag／"zoom"）進來時判定過關；進步時會先用 "" 試一次 */
  done?: (tag: string) => boolean;
}

let card: HTMLDivElement | null = null;
let spot: HTMLDivElement | null = null;
let steps: TourStep[] = [];
let at = 0;
let raf = 0;

export function tourActive(): boolean { return card !== null; }

/** main 的 commit()／onZoom 把動作訊號丟進來；不在導覽中＝什麼都不做。 */
export function tourNotify(tag: string): void {
  if (!card || !steps[at]?.done?.(tag)) return;
  advance();
}

export function startTour(list: TourStep[], startAt = 0): void {
  endTour();
  steps = list;
  at = Math.max(0, Math.min(startAt, steps.length - 1));
  card = document.createElement("div"); card.id = "tourcard";
  spot = document.createElement("div"); spot.id = "tourspot";
  document.body.append(spot, card);
  window.addEventListener("keydown", onKey, true);
  const track = (): void => { placeSpot(); raf = requestAnimationFrame(track); };
  raf = requestAnimationFrame(track);
  paint();
}

export function endTour(): void {
  cancelAnimationFrame(raf);
  card?.remove(); spot?.remove();
  card = spot = null;
  window.removeEventListener("keydown", onKey, true);
}

function onKey(e: KeyboardEvent): void {
  if (e.key !== "Escape" || !card) return;
  e.stopPropagation();   // Esc 先退導覽，別同時觸發取消選取那些
  endTour();
}

function advance(): void {
  if (at >= steps.length - 1) { endTour(); return; }
  at++;
  if (steps[at].done?.("") === true) { advance(); return; }   // 一進步就已成立＝跳過
  paint();
  // 做到了的回饋：卡片輕彈一下（比打勾安靜，也不用圖示）
  card?.animate(
    [{ transform: "translateX(-50%) translateY(0)" }, { transform: "translateX(-50%) translateY(-7px)" }, { transform: "translateX(-50%) translateY(0)" }],
    { duration: 260, easing: "ease-out" });
}

function placeSpot(): void {
  if (!spot) return;
  const r = steps[at]?.target?.() ?? null;
  if (!r || r.w <= 0 || r.h <= 0) { spot.style.display = "none"; return; }
  const pad = 7;
  spot.style.display = "block";
  spot.style.left = `${r.x - pad}px`;
  spot.style.top = `${r.y - pad}px`;
  spot.style.width = `${r.w + pad * 2}px`;
  spot.style.height = `${r.h + pad * 2}px`;
}

function paint(): void {
  if (!card) return;
  const s = steps[at];
  const last = at === steps.length - 1;
  card.replaceChildren();

  const n = document.createElement("span");
  n.className = "tourn";
  n.textContent = `${at + 1}／${steps.length}`;

  const txt = document.createElement("span");
  txt.className = "tourtxt";
  txt.textContent = s.say;

  const next = document.createElement("button");
  next.className = "tourgo";
  next.textContent = last ? __("完成") : s.done ? __("跳過這步") : __("下一步");
  next.addEventListener("click", advance);

  const quit = document.createElement("button");
  quit.className = "tourquit";
  quit.textContent = __("結束導覽 esc");
  quit.addEventListener("click", endTour);

  card.append(n, txt, next, quit);
}
