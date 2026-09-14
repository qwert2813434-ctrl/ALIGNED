// 文字庫面板（桌面版，2026-09-14）：左邊清單＋搜尋，右邊「寫／稿紙」，下面字數、每排格數與「排進畫面」。
// 資料與存檔規則在 textlib.ts（跟 iPhone／iPad 同一個 iCloud 資料夾），格式與數字在 core/textmemo.ts。
// 字眼照 iOS 文字庫；桌面有空間，所以清單與編輯並排、每排格數一直看得到。
//
// 面板開著時整個畫布不收鍵盤（window 捕獲階段擋下）：在這裡按 ⌫ 刪字，不能刪到後面選著的物件。

import { __, __f } from "./i18n";
import { bodyTextLines } from "./core/render";
import {
  MEMO_CANVAS_WIDTH, characterCount, displayTitle, manuscriptCells, manuscriptTextBlock, memoPreview, newMemo,
  paragraphCount, sentenceCount, trimWS, type ManuscriptCell, type TextMemo,
} from "./core/textmemo";
import type { TextLibraryStore } from "./textlib";

export interface TextLibraryHost {
  store: TextLibraryStore;
  /** 量字用的 canvas（要掛在隱形 host 上，見 render.ts attachedCanvas）。 */
  measureCtx: CanvasRenderingContext2D;
  inApp: boolean;
  /** 有打開的專案＝可以「排進畫面」。 */
  canPlace(): boolean;
  /** 排成新的長文框（呼叫前面板已關）。 */
  place(memo: TextMemo, cellsPerRow: number): void;
  pickFolder(): Promise<string | null>;
  confirm(message: string): Promise<boolean>;
}

export function textLibraryIcon(size = 18): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 15.8V4.9A1.9 1.9 0 016.4 3h9.1v11H6.4a1.9 1.9 0 00-1.9 1.8z"/><path d="M4.5 15.8a1.9 1.9 0 001.9 1.9h9.1V14"/><path d="M8 6.8h4.6"/></svg>`;
}
const PENCIL_ICON = `<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4.5H5.5A1.5 1.5 0 004 6v8.5A1.5 1.5 0 005.5 16H14a1.5 1.5 0 001.5-1.5V11"/><path d="M14.2 3.3l2.5 2.5-6.4 6.4-3 .5.5-3z"/></svg>`;
const CLOSE_ICON = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7"/></svg>`;

interface Editing {
  draft: TextMemo;
  /** 打開時（或上次存檔後）的檔案原文；還沒存過的新篇＝null。 */
  baseRaw: string | null;
  /** 上次存進檔案的標題／內文／格數：跟 draft 不同＝要存。 */
  saved: { title: string; body: string; cells: number | undefined };
  isNew: boolean;
}

let host: TextLibraryHost | null = null;
let overlay: HTMLDivElement | null = null;
let unsubscribe: (() => void) | null = null;
let resizeObs: ResizeObserver | null = null;
let pollTimer = 0;
let saveTimer = 0;
let statsTimer = 0;
let noteTimer = 0;
let saving: Promise<void> | null = null;
let editing: Editing | null = null;
let cells = 14;
let mode: "write" | "grid" = "write";
let query = "";
let rows: ManuscriptCell[][] = [];
let closeWarned = false;
const listCache = new WeakMap<TextMemo, { chars: number; sentences: number; preview: string }>();

const el = <T extends HTMLElement = HTMLElement>(sel: string): T => overlay!.querySelector<T>(sel)!;
const has = (sel: string): boolean => !!overlay?.querySelector(sel);
const snap = (m: TextMemo): Editing["saved"] => ({ title: m.title, body: m.body, cells: m.cellsPerRow });
const isDirty = (ed: Editing): boolean =>
  ed.draft.title !== ed.saved.title || ed.draft.body !== ed.saved.body || ed.draft.cellsPerRow !== ed.saved.cells;
const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function isTextLibraryOpen(): boolean { return overlay != null; }

/** 打開文字庫。`select`＝打開就選那一篇（收進文字庫之後）；`note`＝底部提示一句。 */
export function openTextLibrary(h: TextLibraryHost, opts: { select?: string; note?: string } = {}): void {
  host = h;
  if (!overlay) build();
  if (opts.note) showNote(opts.note);
  void (async () => {
    await h.store.resolveFolder();
    await h.store.refresh();
    if (!overlay) return;
    if (opts.select && h.store.memo(opts.select)) openMemo(opts.select);
    else if (!editing && h.store.memos.length) openMemo(h.store.memos[0].id);
    render();
    loadIntoForm();
  })();
}

export function closeTextLibrary(): Promise<void> { return close(); }

function build(): void {
  injectStyle();
  overlay = document.createElement("div");
  overlay.id = "textlib";
  overlay.innerHTML = `<div class="tl-panel" role="dialog" aria-modal="true" aria-label="${__("文字庫")}">
    <div class="tl-head">
      <span class="tl-title">${textLibraryIcon(17)}<span>${__("文字庫")}</span></span>
      <span class="tl-count"></span>
      <span class="tl-grow"></span>
      <button class="tl-new">${PENCIL_ICON}<span>${__("寫新的一篇")}</span></button>
      <button class="tl-close" title="${__("關閉")}" aria-label="${__("關閉")}">${CLOSE_ICON}</button>
    </div>
    <div class="tl-main"></div>
    <div class="tl-foot">
      <span class="tl-where"></span>
      <button class="tl-change">${__("換位置…")}</button>
      <button class="tl-auto">${__("改回自動找 iCloud 雲碟")}</button>
      <span class="tl-grow"></span>
      <span class="tl-note"></span>
    </div>
  </div>`;
  document.body.append(overlay);
  overlay.addEventListener("pointerdown", (e) => { if (e.target === overlay) void close(); });
  el(".tl-close").addEventListener("click", () => void close());
  el(".tl-new").addEventListener("click", () => startNew());
  el(".tl-change").addEventListener("click", () => void pickFolder());
  el(".tl-auto").addEventListener("click", () => void useAutomaticFolder());
  window.addEventListener("keydown", guardKeys, true);
  window.addEventListener("keyup", swallowKeys, true);
  window.addEventListener("focus", onWindowFocus);
  unsubscribe = host!.store.subscribe(onStoreChange);
  // 開著的時候每 3 秒看一次資料夾：手機剛同步上來的、Finder／Obsidian 改的，幾秒內出現
  pollTimer = window.setInterval(() => { void host?.store.refresh(); }, 3000);
  closeWarned = false;
  render();
}

async function close(): Promise<void> {
  if (!overlay) return;
  await flushSave();
  if (editing && isDirty(editing) && host?.store.dir && !closeWarned) {
    closeWarned = true;   // 存不進去：先別關，免得字不見；再按一次才放棄
    showNote(__("還沒存好，再按一次關閉會放棄這次的修改"));
    return;
  }
  window.clearInterval(pollTimer);
  window.clearTimeout(saveTimer);
  window.clearTimeout(statsTimer);
  window.clearTimeout(noteTimer);
  pollTimer = saveTimer = statsTimer = noteTimer = 0;
  window.removeEventListener("keydown", guardKeys, true);
  window.removeEventListener("keyup", swallowKeys, true);
  window.removeEventListener("focus", onWindowFocus);
  resizeObs?.disconnect();
  resizeObs = null;
  unsubscribe?.();
  unsubscribe = null;
  overlay.remove();
  overlay = null;
  editing = null;
  query = "";
}

function guardKeys(e: KeyboardEvent): void {
  if (!overlay) return;
  e.stopPropagation();
  if (e.key === "Escape" && !e.isComposing) { e.preventDefault(); void close(); return; }
  if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "f") {
    e.preventDefault();
    overlay.querySelector<HTMLInputElement>(".tl-search")?.focus();
  }
}

function swallowKeys(e: KeyboardEvent): void { if (overlay) e.stopPropagation(); }

function onWindowFocus(): void { void host?.store.refresh(); }

// ── 畫面 ──────────────────────────────────────────────────────────────

function render(): void {
  if (!overlay || !host) return;
  const s = host.store;
  const f = s.folder;
  el(".tl-count").textContent = s.dir ? __f("{n} 篇", { n: s.memos.length }) : "";
  el<HTMLButtonElement>(".tl-new").disabled = !s.dir;
  el(".tl-where").textContent = whereText();
  el(".tl-change").style.display = host.inApp && s.dir ? "" : "none";
  el(".tl-auto").style.display = host.inApp && (f.kind === "ready" || f.kind === "error") && f.chosen ? "" : "none";
  const main = el(".tl-main");
  if (!s.dir) {
    if (f.kind === "unknown") main.replaceChildren(); else renderSetup(main);
    return;
  }
  if (!main.querySelector(".tl-side")) buildSplit(main);
  renderList();
  updateButtons();
}

function whereText(): string {
  const h = host!;
  const f = h.store.folder;
  if (!h.inApp) return __("瀏覽器預覽：文字庫只存在這個分頁");
  if (f.kind === "error") return __f("讀不到文字庫資料夾：{msg}", { msg: f.message });
  if (f.kind !== "ready") return "";
  const waiting = h.store.placeholders.length;
  return prettyFolder(f.dir) + (waiting ? `　${__f("還有 {n} 篇在 iCloud 下載中", { n: waiting })}` : "");
}

/** 資料夾路徑講成人話：iCloud 雲碟 › ALIGNED › TextLibrary。 */
export function prettyFolder(dir: string): string {
  const parts = dir.split(/[\\/]/).filter(Boolean);
  const i = parts.findIndex((p) => p === "com~apple~CloudDocs" || p === "iCloudDrive");
  if (i >= 0) return [__("iCloud 雲碟"), ...parts.slice(i + 1)].join(" › ");
  const home = /^\/Users\/[^/]+\//.exec(dir);
  return home ? ["~", ...dir.slice(home[0].length).split("/").filter(Boolean)].join(" › ") : parts.join(" › ");
}

function renderSetup(main: HTMLElement): void {
  const h = host!;
  const f = h.store.folder;
  main.replaceChildren();
  const box = document.createElement("div");
  box.className = "tl-setup";
  const title = document.createElement("div");
  title.className = "tl-setup-title";
  title.textContent = __("找不到文字庫資料夾");
  const text = document.createElement("div");
  text.className = "tl-setup-text";
  text.textContent = __("iPhone、iPad 在「設定 › 傳輸資料夾」選的位置裡會有 TextLibrary。這台選同一個位置，就會看到同一批文字。");
  const acts = document.createElement("div");
  acts.className = "tl-setup-acts";
  const canCreate = f.kind === "missing" && !!f.icloudRoot;
  if (canCreate) {
    acts.append(actionButton(__("在 iCloud 雲碟建立 ALIGNED 資料夾"), true, async () => {
      try { await h.store.createInICloud(); } catch (e) { showNote(errorText(e)); }
      await afterFolderChange();
    }));
  }
  if (h.inApp) acts.append(actionButton(__("選資料夾…"), !canCreate, () => pickFolder()));
  box.append(title, text, acts);
  main.append(box);
}

function actionButton(label: string, primary: boolean, run: () => Promise<void>): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  if (primary) b.className = "primary";
  b.addEventListener("click", () => void run());
  return b;
}

function buildSplit(main: HTMLElement): void {
  main.innerHTML = `<div class="tl-side">
      <input class="tl-search" type="search" placeholder="${__("搜尋文字")}" spellcheck="false" autocomplete="off">
      <div class="tl-list"></div>
    </div>
    <div class="tl-editor">
      <div class="tl-empty">${__("選左邊一篇來看，或按「寫新的一篇」。")}</div>
      <div class="tl-form">
        <input class="tl-name" type="text" placeholder="${__("標題（可不填）")}" spellcheck="false" autocomplete="off">
        <div class="tl-bar">
          <span class="tl-seg"><button data-mode="write">${__("寫")}</button><button data-mode="grid">${__("稿紙")}</button></span>
          <span class="tl-grow"></span>
          <button class="tl-copy">${__("拷貝全文")}</button>
          <button class="tl-del">${__("刪除")}</button>
        </div>
        <textarea class="tl-body" spellcheck="false"></textarea>
        <div class="tl-grid"></div>
        <div class="tl-stats">
          <span class="tl-chars"></span><span class="tl-sents"></span><span class="tl-paras"></span>
          <span class="tl-grow"></span>
          <button class="tl-step" data-step="-1" title="${__("減少")}" aria-label="${__("減少")}">−</button>
          <span class="tl-cells"></span>
          <button class="tl-step" data-step="1" title="${__("增加")}" aria-label="${__("增加")}">＋</button>
          <span class="tl-rows"></span>
        </div>
        <button class="tl-place"></button>
      </div>
    </div>`;
  el<HTMLInputElement>(".tl-search").addEventListener("input", (e) => {
    query = (e.target as HTMLInputElement).value;
    renderList();
  });
  el(".tl-name").addEventListener("input", onFormInput);
  el(".tl-body").addEventListener("input", onFormInput);
  for (const b of main.querySelectorAll<HTMLButtonElement>(".tl-seg button")) {
    b.addEventListener("click", () => { mode = b.dataset.mode === "grid" ? "grid" : "write"; applyMode(); });
  }
  for (const b of main.querySelectorAll<HTMLButtonElement>(".tl-step")) {
    b.addEventListener("click", () => stepCells(Number(b.dataset.step)));
  }
  el(".tl-copy").addEventListener("click", () => void copyAll());
  el(".tl-del").addEventListener("click", () => void deleteCurrent());
  el(".tl-place").addEventListener("click", () => void placeNow());
  resizeObs?.disconnect();
  resizeObs = new ResizeObserver(() => { if (mode === "grid") renderGrid(); });
  resizeObs.observe(el(".tl-grid"));
  loadIntoForm();
}

function renderList(): void {
  if (!has(".tl-list") || !host) return;
  const s = host.store;
  const list = el(".tl-list");
  const q = query.trim().toLocaleLowerCase();
  const shown = q
    ? s.memos.filter((m) => m.title.toLocaleLowerCase().includes(q) || m.body.toLocaleLowerCase().includes(q))
    : s.memos;
  const scroll = list.scrollTop;
  list.replaceChildren();
  if (!s.memos.length || !shown.length) {
    const empty = document.createElement("div");
    empty.className = "tl-listempty";
    const b = document.createElement("b");
    b.textContent = s.memos.length ? __("沒有符合的文字") : __("還沒有文字");
    empty.append(b);
    if (!s.memos.length) empty.append(__("想法先放這裡，不一定要排進版面。按右上角寫第一篇。"));
    list.append(empty);
  }
  for (const m of shown) list.append(listRow(m));
  list.scrollTop = scroll;
}

function listRow(m: TextMemo): HTMLButtonElement {
  let info = listCache.get(m);
  if (!info) {
    info = { chars: characterCount(m.body), sentences: sentenceCount(m.body), preview: memoPreview(m) };
    listCache.set(m, info);
  }
  const row = document.createElement("button");
  row.className = "tl-row";
  if (editing && !editing.isNew && editing.draft.id === m.id) row.classList.add("on");
  const top = document.createElement("div");
  top.className = "tl-rtop";
  const name = document.createElement("span");
  name.className = "tl-rname";
  name.textContent = displayTitle(m) ?? __("未命名");
  const date = document.createElement("span");
  date.className = "tl-rdate";
  const d = new Date(m.updated);
  date.textContent = `${d.getMonth() + 1}/${d.getDate()}`;
  top.append(name, date);
  row.append(top);
  if (info.preview) {
    const pv = document.createElement("div");
    pv.className = "tl-rpv";
    pv.textContent = info.preview;
    row.append(pv);
  }
  const meta = document.createElement("div");
  meta.className = "tl-rmeta";
  meta.textContent = [__f("字數 {n}", { n: info.chars }), __f("句數 {n}", { n: info.sentences }),
    ...(m.usedCount > 0 ? [__f("已排進 {n} 次", { n: m.usedCount })] : [])].join(" · ");
  row.append(meta);
  row.addEventListener("click", () => openMemo(m.id));
  return row;
}

function loadIntoForm(keepCaret = false): void {
  if (!has(".tl-form")) return;
  const ed = editing;
  el(".tl-empty").style.display = ed ? "none" : "flex";
  el(".tl-form").style.display = ed ? "flex" : "none";
  if (!ed) return;
  const name = el<HTMLInputElement>(".tl-name");
  const body = el<HTMLTextAreaElement>(".tl-body");
  if (name.value !== ed.draft.title) name.value = ed.draft.title;
  if (body.value !== ed.draft.body) {
    const focused = document.activeElement === body;
    const [a, b] = [body.selectionStart, body.selectionEnd];
    body.value = ed.draft.body;
    if (keepCaret && focused) body.setSelectionRange(Math.min(a, body.value.length), Math.min(b, body.value.length));
    else body.scrollTop = 0;
  }
  applyMode();
}

function applyMode(): void {
  if (!has(".tl-form") || !overlay) return;
  for (const b of overlay.querySelectorAll<HTMLButtonElement>(".tl-seg button")) b.classList.toggle("on", b.dataset.mode === mode);
  el(".tl-body").style.display = mode === "write" ? "" : "none";
  el(".tl-grid").style.display = mode === "grid" ? "" : "none";
  updateStats();
}

function rowsOf(text: string): ManuscriptCell[][] {
  if (!text || !host) return [];
  const { text: t, width } = manuscriptTextBlock(text, cells);
  let lines = bodyTextLines(host.measureCtx, t, MEMO_CANVAS_WIDTH, width);
  // 結尾的換行不多算一排（跟 iOS 稿紙一樣）
  if (text.endsWith("\n") && lines.length > 1 && lines[lines.length - 1] === "") lines = lines.slice(0, -1);
  return lines.map(manuscriptCells);
}

function updateStats(): void {
  window.clearTimeout(statsTimer);
  statsTimer = 0;
  const ed = editing;
  if (!ed || !has(".tl-form")) return;
  const body = ed.draft.body;
  el(".tl-chars").textContent = __f("字數 {n}", { n: characterCount(body) });
  el(".tl-sents").textContent = __f("句數 {n}", { n: sentenceCount(body) });
  el(".tl-paras").textContent = __f("段數 {n}", { n: paragraphCount(body) });
  el(".tl-cells").textContent = __f("每排 {n} 格", { n: cells });
  rows = rowsOf(body);
  el(".tl-rows").textContent = __f("共 {n} 排", { n: rows.length });
  el(".tl-place").textContent = `${__("排進畫面")} · ${__f("每排 {n} 格", { n: cells })}`;
  updateButtons();
  if (mode === "grid") renderGrid();
}

function scheduleStats(): void {
  window.clearTimeout(statsTimer);
  statsTimer = window.setTimeout(updateStats, 150);
}

/** 稿紙：每排 N 格，全形一格、英數半格；一排塞超過 N 格（英文字寬不一）就整排等比壓回格子裡。 */
function renderGrid(): void {
  if (!has(".tl-grid")) return;
  const grid = el(".tl-grid");
  grid.replaceChildren();
  if (!rows.length) {
    const hint = document.createElement("div");
    hint.className = "tl-gridhint";
    hint.textContent = __("先在「寫」打字，這裡會照每排格數排出來");
    grid.append(hint);
    return;
  }
  const side = Math.max(12, Math.min(44, Math.floor((grid.clientWidth - 30) / (cells + 0.2))));
  const frag = document.createDocumentFragment();
  for (const row of rows) {
    const r = document.createElement("div");
    r.className = "tl-mrow";
    r.style.width = `${side * cells + 1}px`;
    r.style.height = `${side}px`;
    r.style.marginBottom = `${Math.round(side * 0.2)}px`;
    r.style.backgroundImage = `repeating-linear-gradient(to right, var(--tl-line) 0 1px, transparent 1px ${side}px)`;
    const total = row.reduce((sum, c) => sum + c.units, 0);
    const unit = side * Math.min(1, cells / Math.max(total, 1));
    let offset = 0;
    for (const c of row) {
      const g = document.createElement("span");
      g.textContent = c.text;
      g.style.left = `${unit * offset}px`;
      g.style.width = `${unit * c.units}px`;
      g.style.fontSize = `${side * (c.units < 1 ? 0.6 : 0.64)}px`;
      offset += c.units;
      r.append(g);
    }
    frag.append(r);
  }
  grid.append(frag);
}

function updateButtons(): void {
  if (!has(".tl-form") || !host) return;
  const ed = editing;
  const noBody = !ed || trimWS(ed.draft.body) === "";
  const place = el<HTMLButtonElement>(".tl-place");
  place.style.display = host.canPlace() ? "" : "none";
  place.disabled = noBody;
  el<HTMLButtonElement>(".tl-copy").disabled = !ed || (noBody && trimWS(ed.draft.title) === "");
  el<HTMLButtonElement>(".tl-del").disabled = !ed || ed.isNew;
}

function showNote(message: string): void {
  if (!overlay) return;
  el(".tl-note").textContent = message;
  window.clearTimeout(noteTimer);
  noteTimer = window.setTimeout(() => { if (overlay) el(".tl-note").textContent = ""; }, 8000);
}

// ── 動作 ──────────────────────────────────────────────────────────────

/** 換到另一篇（或新的一篇）：畫面立刻換，上一篇沒存的在背景存（存檔排隊，不會互相蓋）。 */
function switchTo(next: Editing): void {
  const prev = editing;
  window.clearTimeout(saveTimer);
  saveTimer = 0;
  editing = next;
  closeWarned = false;
  if (prev && isDirty(prev)) void saveNow(prev);
}

function openMemo(id: string): void {
  if (editing && !editing.isNew && editing.draft.id === id) return;
  const s = host?.store;
  const m = s?.memo(id);
  if (!s || !m) return;
  switchTo({ draft: { ...m }, baseRaw: s.raw(id), saved: snap(m), isNew: false });
  cells = m.cellsPerRow ?? s.lastCellsPerRow;
  loadIntoForm();
  renderList();
}

function startNew(): void {
  const s = host?.store;
  if (!s?.dir) return;
  switchTo({ draft: newMemo(Date.now()), baseRaw: null, saved: { title: "", body: "", cells: undefined }, isNew: true });
  cells = s.lastCellsPerRow;
  mode = "write";
  loadIntoForm();
  renderList();
  el<HTMLTextAreaElement>(".tl-body").focus();
}

function onFormInput(): void {
  const ed = editing;
  if (!ed) return;
  const title = el<HTMLInputElement>(".tl-name").value;
  const body = el<HTMLTextAreaElement>(".tl-body").value;
  if (title === ed.draft.title && body === ed.draft.body) return;
  ed.draft = { ...ed.draft, title, body, updated: Date.now() };
  closeWarned = false;
  scheduleSave();
  scheduleStats();
  updateButtons();
}

function stepCells(step: number): void {
  const ed = editing;
  if (!ed || !host) return;
  const n = Math.min(40, Math.max(4, cells + step));
  if (n === cells) return;
  cells = n;
  host.store.lastCellsPerRow = n;
  ed.draft = { ...ed.draft, cellsPerRow: n };
  scheduleSave();
  updateStats();
}

/** 打字停 0.7 秒自動存（同 iOS）；換篇、關面板、排進畫面前都先存。 */
function scheduleSave(): void {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void saveNow(), 700);
}

/** 把手上這篇沒存的存掉，並等排著的存檔都做完（關面板、換位置前）。 */
async function flushSave(): Promise<void> {
  if (editing && (saveTimer || isDirty(editing))) await saveNow(editing);
  while (saving) await saving;
}

async function saveNow(target: Editing | null = editing): Promise<void> {
  if (target === editing) {
    window.clearTimeout(saveTimer);
    saveTimer = 0;
  }
  while (saving) await saving;
  const ed = target;
  const s = host?.store;
  if (!ed || !s || !s.dir || !isDirty(ed)) return;
  const draft = { ...ed.draft };
  saving = (async () => {
    try {
      const res = await s.save(draft, ed.baseRaw);
      ed.saved = snap(draft);
      if (!res) {
        // 整篇清空＝這篇不留（同 iOS）；再打字會重新存成一篇
        ed.baseRaw = null;
        ed.isNew = true;
        return;
      }
      ed.baseRaw = res.raw;
      ed.isNew = false;
      if (res.kept === "draft") {
        ed.draft = { ...ed.draft, id: res.memo.id, usedCount: res.memo.usedCount, usedIn: res.memo.usedIn };
        if (res.copy) showNote(__f("另一台也改了這篇，對方的版本另存成「{name}」", { name: displayTitle(res.copy) ?? __("未命名") }));
      } else {
        ed.draft = { ...res.memo };
        ed.saved = snap(res.memo);
        if (editing === ed) {
          cells = res.memo.cellsPerRow ?? cells;
          loadIntoForm(true);
        }
        showNote(__f("另一台的版本比較新，已換成那一份；你剛打的另存成「{name}」", { name: displayTitle(res.copy!) ?? __("未命名") }));
      }
    } catch (e) {
      showNote(__f("存檔失敗：{msg}", { msg: errorText(e) }));
    }
  })();
  await saving;
  saving = null;
  if (!overlay) return;
  renderList();
  updateButtons();
  if (editing === ed && isDirty(ed) && !saveTimer) scheduleSave();   // 存的時候又打了字
}

/** 資料夾有變化（手機同步上來、別處改檔）：這篇沒有沒存的修改就換成最新的一份。 */
function onStoreChange(): void {
  if (!overlay || !host) return;
  render();
  const ed = editing;
  if (!ed || ed.isNew || saving || saveTimer || isDirty(ed)) return;
  const s = host.store;
  const raw = s.raw(ed.draft.id);
  if (raw === ed.baseRaw) return;
  const m = s.memo(ed.draft.id);
  if (!m) {
    editing = null;
    loadIntoForm();
    showNote(__("這篇在別台被刪掉了"));
    return;
  }
  editing = { draft: { ...m }, baseRaw: raw, saved: snap(m), isNew: false };
  cells = m.cellsPerRow ?? cells;
  loadIntoForm(true);
  renderList();
}

async function copyAll(): Promise<void> {
  const ed = editing;
  if (!ed) return;
  const t = trimWS(ed.draft.title);
  const text = t ? `${t}\n\n${ed.draft.body}` : ed.draft.body;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;opacity:0;pointer-events:none";
    document.body.append(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  showNote(__("已拷貝"));
}

async function deleteCurrent(): Promise<void> {
  const ed = editing;
  const h = host;
  if (!ed || !h || ed.isNew) return;
  const name = displayTitle(ed.draft) ?? __("未命名");
  if (!(await h.confirm(__f("刪除「{name}」？iPhone、iPad 上的也會一起刪掉。", { name })))) return;
  window.clearTimeout(saveTimer);
  saveTimer = 0;
  while (saving) await saving;
  try {
    await h.store.delete(ed.draft.id);
  } catch (e) {
    showNote(errorText(e));
    return;
  }
  editing = null;
  const next = h.store.memos[0];
  if (next) openMemo(next.id); else loadIntoForm();
  renderList();
}

async function placeNow(): Promise<void> {
  const ed = editing;
  const h = host;
  if (!ed || !h || !h.canPlace() || trimWS(ed.draft.body) === "") return;
  ed.draft = { ...ed.draft, cellsPerRow: cells };
  await saveNow();
  const memo = { ...ed.draft };
  const n = cells;
  await close();
  if (!overlay) h.place(memo, n);
}

async function pickFolder(): Promise<void> {
  const h = host;
  if (!h) return;
  const dir = await h.pickFolder();
  if (!dir || !overlay) return;
  await flushSave();
  editing = null;
  try { await h.store.chooseFolder(dir); } catch (e) { showNote(errorText(e)); }
  await afterFolderChange();
}

async function useAutomaticFolder(): Promise<void> {
  const h = host;
  if (!h) return;
  await flushSave();
  editing = null;
  try { await h.store.useAutomaticFolder(); } catch (e) { showNote(errorText(e)); }
  await afterFolderChange();
}

async function afterFolderChange(): Promise<void> {
  if (!overlay || !host) return;
  editing = null;
  render();
  const first = host.store.memos[0];
  if (first) openMemo(first.id);
  render();
  loadIntoForm();
}

function injectStyle(): void {
  if (document.getElementById("textlib-style")) return;
  const s = document.createElement("style");
  s.id = "textlib-style";
  s.textContent = `
  #textlib { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center;
    background: color-mix(in srgb, var(--ink) 18%, transparent);
    --tl-line: color-mix(in srgb, var(--ink) 16%, transparent); --tl-accent: #2F7CF6; }
  #textlib button { font: inherit; color: inherit; }
  #textlib button:disabled { opacity: .4; cursor: default; }
  #textlib .tl-panel { width: min(1000px, 94vw); height: min(700px, 88vh); display: flex; flex-direction: column;
    background: var(--card); color: var(--ink); border: 1px solid var(--line); border-radius: 14px; overflow: hidden;
    box-shadow: 0 18px 60px rgba(0,0,0,.18); }
  #textlib .tl-grow { flex: 1; }
  #textlib .tl-head { display: flex; align-items: center; gap: 10px; padding: 11px 12px 11px 18px; border-bottom: 1px solid var(--line); }
  #textlib .tl-title { display: inline-flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 600; }
  #textlib .tl-title svg { display: block; }
  #textlib .tl-count { font-size: 12px; color: var(--ink2); font-variant-numeric: tabular-nums; }
  #textlib .tl-new { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line); background: transparent;
    border-radius: 8px; padding: 5px 12px; font-size: 12.5px; cursor: pointer; }
  #textlib .tl-new svg { display: block; }
  #textlib .tl-close { border: none; background: transparent; color: var(--ink2); cursor: pointer; width: 30px; height: 30px;
    border-radius: 999px; display: inline-flex; align-items: center; justify-content: center; }
  #textlib .tl-new:hover:not(:disabled), #textlib .tl-close:hover, #textlib .tl-copy:hover:not(:disabled),
  #textlib .tl-del:hover:not(:disabled), #textlib .tl-setup-acts button:hover:not(.primary) {
    background: color-mix(in srgb, var(--ink) 7%, transparent); }
  #textlib .tl-main { flex: 1; display: flex; min-height: 0; }
  #textlib .tl-side { width: 300px; flex: none; display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--line); }
  #textlib .tl-search { margin: 10px 12px 8px; padding: 7px 10px; border-radius: 8px; border: 1px solid var(--line);
    background: var(--chrome); color: var(--ink); font: inherit; font-size: 12.5px; outline: none; }
  #textlib .tl-search:focus { border-color: var(--tl-accent); }
  #textlib .tl-list { flex: 1; overflow-y: auto; padding: 0 6px 10px; }
  #textlib .tl-row { display: block; width: 100%; text-align: left; border: none; background: transparent; border-radius: 9px;
    padding: 9px 10px; cursor: pointer; }
  #textlib .tl-row:hover { background: color-mix(in srgb, var(--ink) 5%, transparent); }
  #textlib .tl-row.on { background: color-mix(in srgb, var(--tl-accent) 13%, transparent); }
  #textlib .tl-rtop { display: flex; align-items: baseline; gap: 8px; }
  #textlib .tl-rname { flex: 1; min-width: 0; font-size: 13.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #textlib .tl-rdate { font-size: 11px; color: var(--ink2); font-variant-numeric: tabular-nums; }
  #textlib .tl-rpv { font-size: 12px; line-height: 1.45; color: var(--ink2); margin-top: 3px; overflow: hidden;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  #textlib .tl-rmeta { font-size: 11px; color: var(--ink2); opacity: .85; margin-top: 4px; font-variant-numeric: tabular-nums; }
  #textlib .tl-listempty { padding: 44px 20px; text-align: center; color: var(--ink2); font-size: 12.5px; line-height: 1.7; }
  #textlib .tl-listempty b { display: block; color: var(--ink); font-size: 14px; margin-bottom: 6px; }
  #textlib .tl-editor { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  #textlib .tl-empty { flex: 1; align-items: center; justify-content: center; color: var(--ink2); font-size: 13px; padding: 20px; text-align: center; }
  #textlib .tl-form { flex: 1; min-height: 0; flex-direction: column; gap: 10px; padding: 12px 18px 14px; }
  #textlib .tl-name { border: none; background: transparent; color: var(--ink); font: inherit; font-size: 17px; font-weight: 600;
    outline: none; padding: 4px 0; }
  #textlib .tl-bar { display: flex; align-items: center; gap: 8px; }
  #textlib .tl-seg { display: inline-flex; gap: 4px; }
  #textlib .tl-seg button { border: none; border-radius: 999px; padding: 5px 16px; font-size: 12.5px; cursor: pointer;
    background: color-mix(in srgb, var(--ink) 8%, transparent); }
  #textlib .tl-seg button.on { background: var(--tl-accent); color: #fff; font-weight: 600; }
  #textlib .tl-copy, #textlib .tl-del { border: 1px solid var(--line); background: transparent; border-radius: 8px;
    padding: 4px 11px; font-size: 12px; cursor: pointer; }
  #textlib .tl-del { color: #D14343; }
  #textlib .tl-body { flex: 1; min-height: 0; resize: none; border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px;
    background: var(--chrome); color: var(--ink); font: inherit; font-size: 15px; line-height: 1.75; outline: none; }
  #textlib .tl-body:focus { border-color: color-mix(in srgb, var(--tl-accent) 60%, var(--line)); }
  #textlib .tl-grid { flex: 1; min-height: 0; overflow: auto; border: 1px solid var(--line); border-radius: 10px; padding: 14px;
    background: var(--chrome); }
  #textlib .tl-mrow { position: relative; box-shadow: inset 0 1px 0 var(--tl-line), inset 0 -1px 0 var(--tl-line); }
  #textlib .tl-mrow span { position: absolute; top: 0; height: 100%; display: flex; align-items: center; justify-content: center;
    line-height: 1; color: var(--ink); }
  #textlib .tl-gridhint { color: var(--ink2); font-size: 13px; text-align: center; padding: 48px 10px; }
  #textlib .tl-stats { display: flex; align-items: center; gap: 12px; font-size: 12px; color: var(--ink2); font-variant-numeric: tabular-nums; }
  #textlib .tl-step { width: 26px; height: 26px; border-radius: 999px; border: none; cursor: pointer; font-size: 14px; line-height: 1;
    background: color-mix(in srgb, var(--ink) 9%, transparent); }
  #textlib .tl-cells { color: var(--ink); font-weight: 500; min-width: 66px; text-align: center; }
  #textlib .tl-place { border: none; border-radius: 10px; padding: 11px; background: var(--tl-accent); color: #fff;
    font-size: 14px; font-weight: 600; cursor: pointer; }
  #textlib .tl-foot { display: flex; align-items: center; gap: 10px; padding: 9px 18px; border-top: 1px solid var(--line);
    font-size: 11.5px; color: var(--ink2); min-height: 20px; }
  #textlib .tl-where { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  #textlib .tl-note { color: var(--ink); text-align: right; }
  #textlib .tl-change, #textlib .tl-auto { border: none; background: transparent; color: var(--tl-accent); cursor: pointer;
    font-size: 11.5px; padding: 2px 4px; white-space: nowrap; }
  #textlib .tl-setup { margin: auto; max-width: 460px; text-align: center; padding: 30px; }
  #textlib .tl-setup-title { font-size: 16px; font-weight: 600; margin-bottom: 10px; }
  #textlib .tl-setup-text { font-size: 13px; line-height: 1.75; color: var(--ink2); margin-bottom: 22px; }
  #textlib .tl-setup-acts { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; }
  #textlib .tl-setup-acts button { border: 1px solid var(--line); background: transparent; border-radius: 9px; padding: 8px 16px;
    font-size: 13px; cursor: pointer; }
  #textlib .tl-setup-acts button.primary { background: var(--tl-accent); border-color: var(--tl-accent); color: #fff; }`;
  document.head.append(s);
}
