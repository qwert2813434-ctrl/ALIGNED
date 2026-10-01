// 散字面板（桌面版，2026-10-01）：文字庫一篇 → 散字。小高：「Mac 可以複雜一點，保留參考線以及調整間隔方式」。
// 跟 iOS 一樣字一開始就是真的文字塊（看到的就是成品的字），面板只管位置：
//   散（空白鍵）＝整組重抽、← →＝回到前幾次、點下方的詞＝釘住（拖過的詞自動釘住）、
//   規則＝順序／吸格線／錯開／間距／邊界；字型字級顏色照舊用右邊檢視器（整組已選取）。
//   確定（Enter）＝記一步復原、清掉參考線；取消（Esc）＝這輪的字全拿掉。
// 位置計算在 core/scatter.ts；原型＝01 - 研究/樣本間/散字/index.html。
import { DEFAULT_SCATTER, scatterLayout, type Box, type ScatterOptions } from "./core/scatter";
import type { StageOverlay } from "./core/render";
import { __, __f } from "./i18n";

export interface ScatterHost {
  /** 建好每個詞的文字塊（已量好大小、已選取）；回傳 id 與當頁（專案座標） */
  create(words: string[]): { ids: string[]; page: Box } | null;
  /** 目前每個字的框（專案座標）；有任何一個不見了（被復原掉）＝null */
  frames(ids: string[]): Box[] | null;
  /** 搬到這些左上角（專案座標），不記復原 */
  move(ids: string[], origins: { x: number; y: number }[]): void;
  overlay(o: StageOverlay["scatter"] | null): void;
  /** keep＝確定（記一步復原）；否則把這輪的字全部拿掉 */
  finish(ids: string[], keep: boolean): void;
}

interface Session {
  host: ScatterHost;
  words: string[];
  ids: string[];
  page: Box;
  seed: number;
  opt: ScatterOptions;
  pinned: Set<number>;
  gridX: number[];
  /** 最後一次是我們擺的位置（頁面內）——位置不一樣＝他拖過，自動釘住 */
  placed: { x: number; y: number }[];
  sizes: { w: number; h: number }[];
  history: { seed: number; origins: { x: number; y: number }[] }[];
  hi: number;
  timer: number;
}

let s: Session | null = null;
let panel: HTMLDivElement | null = null;
const PREF = "aligned.scatter.opt";

function loadOpt(): ScatterOptions {
  try { return { ...DEFAULT_SCATTER, ...JSON.parse(localStorage.getItem(PREF) ?? "{}") }; } catch { return { ...DEFAULT_SCATTER }; }
}
function saveOpt(o: ScatterOptions): void {
  try { localStorage.setItem(PREF, JSON.stringify(o)); } catch { /* 存不了就算了 */ }
}

export function scatterActive(): boolean { return !!s; }

export function startScatter(host: ScatterHost, words: string[]): void {
  if (s) finish(true);
  if (!words.length) return;
  const made = host.create(words);
  if (!made) return;
  s = { host, words, ids: made.ids, page: made.page, seed: newSeed(), opt: loadOpt(), pinned: new Set(), gridX: [],
        placed: [], sizes: [], history: [], hi: -1, timer: 0 };
  buildPanel();
  roll(true);
  // 檢視器改了字級／字型→同一個 seed 再排（構圖不變、字不疊）；他拖過的→自動釘住；被復原掉→結束
  s.timer = window.setInterval(watch, 250);
}

const newSeed = () => (Math.random() * 4294967296) >>> 0;

function localFrames(): Box[] | null {
  if (!s) return null;
  const f = s.host.frames(s.ids);
  return f && f.map((b) => ({ x: b.x - s!.page.x, y: b.y - s!.page.y, w: b.w, h: b.h }));
}

function roll(fresh: boolean): void {
  if (!s) return;
  const f = localFrames();
  if (!f) { finish(false, true); return; }
  if (fresh) s.seed = newSeed();
  const pins = new Map<number, Box>();
  s.pinned.forEach((i) => pins.set(i, f[i]));
  const r = scatterLayout(f, { w: s.page.w, h: s.page.h }, s.seed, s.opt, pins);
  apply(r.origins, r.gridX, f);
  if (fresh) {
    s.history = s.history.slice(0, s.hi + 1);
    s.history.push({ seed: s.seed, origins: r.origins });
    if (s.history.length > 30) s.history.shift();
    s.hi = s.history.length - 1;
  } else if (s.history[s.hi]) {
    s.history[s.hi] = { seed: s.seed, origins: r.origins };
  }
  render();
}

function apply(origins: { x: number; y: number }[], gridX: number[], f: Box[]): void {
  if (!s) return;
  s.host.move(s.ids, origins.map((o) => ({ x: o.x + s!.page.x, y: o.y + s!.page.y })));
  s.placed = origins;
  s.sizes = f.map((b) => ({ w: b.w, h: b.h }));
  s.gridX = gridX;
  drawOverlay();
}

function go(d: number): void {
  if (!s || !s.history.length) return;
  s.hi = Math.max(0, Math.min(s.history.length - 1, s.hi + d));
  const h = s.history[s.hi];
  const f = localFrames();
  if (!f) { finish(false, true); return; }
  s.seed = h.seed;
  s.gridX = scatterLayout(f, { w: s.page.w, h: s.page.h }, s.seed, s.opt).gridX;
  apply(h.origins, s.gridX, f);
  render();
}

function watch(): void {
  if (!s) return;
  const f = localFrames();
  if (!f) { finish(false, true); return; }
  let moved = false;
  f.forEach((b, i) => {
    const p = s!.placed[i];
    if (p && (Math.abs(b.x - p.x) > 0.5 || Math.abs(b.y - p.y) > 0.5)) {
      s!.pinned.add(i); s!.placed[i] = { x: b.x, y: b.y }; moved = true;
    }
  });
  const resized = f.some((b, i) => !s!.sizes[i] || Math.abs(b.w - s!.sizes[i].w) > 0.5 || Math.abs(b.h - s!.sizes[i].h) > 0.5);
  if (resized) roll(false);
  else if (moved) { drawOverlay(); render(); }
}

function drawOverlay(): void {
  if (!s) return;
  const f = s.host.frames(s.ids);
  if (!f) return;
  s.host.overlay({
    page: s.page, gridX: s.opt.snap ? s.gridX : [],
    boxes: f.map((b, i) => ({ ...b, pinned: s!.pinned.has(i) })),
  });
}

function finish(keep: boolean, silent = false): void {
  if (!s) return;
  window.clearInterval(s.timer);
  const cur = s;
  s = null;
  cur.host.overlay(null);
  if (!silent) cur.host.finish(cur.ids, keep);
  panel?.remove();
  panel = null;
}

// ── 面板 ──────────────────────────────────────────────

function buildPanel(): void {
  panel?.remove();
  injectStyle();
  panel = document.createElement("div");
  panel.id = "scatterpanel";
  panel.innerHTML = `
    <div class="sp-row">
      <b class="sp-title">${__("散字")}</b>
      <button class="sp-btn sp-main" data-act="roll" title="${__("空白鍵")}">${__("重新落字")}</button>
      <button class="sp-btn sp-icon" data-act="prev" title="←">‹</button>
      <span class="sp-hist"></span>
      <button class="sp-btn sp-icon" data-act="next" title="→">›</button>
      <span class="sp-grow"></span>
      <button class="sp-btn" data-act="cancel" title="Esc">${__("取消")}</button>
      <button class="sp-btn sp-ok" data-act="ok" title="Enter">${__("確定")}</button>
    </div>
    <div class="sp-row sp-rules">
      <span class="sp-seg" data-k="order">
        <button data-v="seq">${__("照順序往下")}</button><button data-v="free">${__("完全隨機")}</button>
      </span>
      <span class="sp-seg" data-k="snap">
        <button data-v="1">${__("吸格線")}</button><button data-v="0">${__("不吸")}</button>
      </span>
      <label>${__("錯開")}<input type="range" data-k="zig" min="0" max="0.5" step="0.01"><em data-out="zig"></em></label>
      <label>${__("間距")}<input type="range" data-k="gap" min="0" max="240" step="2"><em data-out="gap"></em></label>
      <label>${__("邊界")}<input type="range" data-k="margin" min="0.02" max="0.15" step="0.005"><em data-out="margin"></em></label>
    </div>
    <div class="sp-row sp-words"></div>
    <div class="sp-hint">${__("點詞＝釘住（拖過的會自動釘住）｜字型、字級、顏色用右邊的檢視器")}</div>`;
  document.body.append(panel);
  panel.addEventListener("click", onClick);
  panel.addEventListener("input", onInput);
  window.addEventListener("keydown", onKey, true);
}

function onClick(e: MouseEvent): void {
  if (!s) return;
  const t = e.target as HTMLElement;
  const act = t.closest<HTMLElement>("[data-act]")?.dataset.act;
  if (act === "roll") roll(true);
  else if (act === "prev") go(-1);
  else if (act === "next") go(1);
  else if (act === "ok") finish(true);
  else if (act === "cancel") finish(false);
  const seg = t.closest<HTMLElement>(".sp-seg");
  const v = t.closest<HTMLElement>("[data-v]")?.dataset.v;
  if (seg && v !== undefined) {
    if (seg.dataset.k === "order") s.opt.order = v as ScatterOptions["order"];
    if (seg.dataset.k === "snap") s.opt.snap = v === "1";
    saveOpt(s.opt);
    roll(false);
  }
  const w = t.closest<HTMLElement>("[data-word]");
  if (w) {
    const i = Number(w.dataset.word);
    if (s.pinned.has(i)) s.pinned.delete(i); else s.pinned.add(i);
    drawOverlay(); render();
  }
}

function onInput(e: Event): void {
  if (!s) return;
  const t = e.target as HTMLInputElement;
  const k = t.dataset.k as "zig" | "gap" | "margin" | undefined;
  if (!k) return;
  s.opt[k] = Number(t.value);
  saveOpt(s.opt);
  roll(false);
}

function onKey(e: KeyboardEvent): void {
  if (!s) { window.removeEventListener("keydown", onKey, true); return; }
  const tgt = e.target as HTMLElement | null;
  if (tgt && (tgt.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(tgt.tagName)) && !(tgt as HTMLInputElement).type?.includes("range")) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const map: Record<string, () => void> = {
    " ": () => roll(true), ArrowLeft: () => go(-1), ArrowRight: () => go(1),
    Enter: () => finish(true), Escape: () => finish(false),
  };
  const f = map[e.key];
  if (!f) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  f();
}

function render(): void {
  if (!s || !panel) return;
  const q = <T extends HTMLElement>(sel: string) => panel!.querySelector<T>(sel)!;
  q(".sp-hist").textContent = s.history.length ? __f("第 {n} 次", { n: s.hi + 1 }) : "";
  panel.querySelectorAll<HTMLElement>(".sp-seg").forEach((seg) => {
    const cur = seg.dataset.k === "order" ? s!.opt.order : (s!.opt.snap ? "1" : "0");
    seg.querySelectorAll<HTMLElement>("[data-v]").forEach((b) => b.classList.toggle("on", b.dataset.v === cur));
  });
  for (const k of ["zig", "gap", "margin"] as const) {
    const input = q<HTMLInputElement>(`input[data-k="${k}"]`);
    if (document.activeElement !== input) input.value = String(s.opt[k]);
    q(`[data-out="${k}"]`).textContent = k === "gap" ? String(Math.round(s.opt.gap))
      : k === "zig" ? (s.opt.zig ? `${Math.round(s.opt.zig * 100)}%` : __("不限")) : `${(s.opt.margin * 100).toFixed(1)}%`;
  }
  q(".sp-words").innerHTML = s.words.map((w, i) =>
    `<button class="sp-word${s!.pinned.has(i) ? " on" : ""}" data-word="${i}">${escapeHtml(w)}</button>`).join("");
}

const escapeHtml = (t: string) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

function injectStyle(): void {
  if (document.getElementById("scatterpanel-css")) return;
  const st = document.createElement("style");
  st.id = "scatterpanel-css";
  st.textContent = `
  #scatterpanel { position: fixed; left: 50%; top: 64px; transform: translateX(-50%); z-index: 60; width: min(760px, calc(100vw - 32px));
    background: var(--chrome, #fff); color: var(--ink); border: 1px solid var(--line, rgba(0,0,0,.1)); border-radius: 14px;
    box-shadow: 0 12px 40px -18px rgba(0,0,0,.45); padding: 10px 14px 8px; font-size: 12.5px; }
  #scatterpanel .sp-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  #scatterpanel .sp-row + .sp-row { margin-top: 8px; }
  #scatterpanel .sp-title { font-size: 14px; margin-right: 4px; }
  #scatterpanel .sp-grow { flex: 1; }
  #scatterpanel .sp-hist { min-width: 52px; text-align: center; color: var(--ink2); font-variant-numeric: tabular-nums; }
  #scatterpanel button { font: inherit; color: inherit; cursor: pointer; }
  #scatterpanel .sp-btn { border: none; border-radius: 999px; padding: 6px 14px; background: color-mix(in srgb, var(--ink) 8%, transparent); }
  #scatterpanel .sp-icon { padding: 4px 11px; font-size: 16px; line-height: 1; }
  #scatterpanel .sp-main, #scatterpanel .sp-ok { background: #2F7CF6; color: #fff; font-weight: 600; }
  #scatterpanel .sp-seg { display: inline-flex; background: color-mix(in srgb, var(--ink) 7%, transparent); border-radius: 999px; padding: 2px; }
  #scatterpanel .sp-seg button { border: none; background: transparent; border-radius: 999px; padding: 4px 11px; color: var(--ink2); }
  #scatterpanel .sp-seg button.on { background: var(--chrome, #fff); color: var(--ink); box-shadow: 0 1px 3px rgba(0,0,0,.15); }
  #scatterpanel label { display: inline-flex; align-items: center; gap: 6px; color: var(--ink2); }
  #scatterpanel input[type=range] { width: 92px; }
  #scatterpanel em { font-style: normal; min-width: 38px; color: var(--ink); font-variant-numeric: tabular-nums; }
  #scatterpanel .sp-word { border: 1px dashed color-mix(in srgb, #2F7CF6 70%, transparent); background: transparent; border-radius: 8px;
    padding: 3px 9px; max-width: 220px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #scatterpanel .sp-word.on { border-style: solid; border-color: #2F7CF6; background: color-mix(in srgb, #2F7CF6 12%, transparent); }
  #scatterpanel .sp-hint { margin-top: 7px; color: var(--ink2); font-size: 11.5px; }`;
  document.head.append(st);
}
