import { __, __f, keys, localizeTitles } from "./i18n";
// ALIGN Core 的 Mac 殼組裝。
//
// 同一份程式跑兩種環境：
// - **Tauri（.app）**：開檔／匯出走原生對話框，`.alignproj` 由 Rust 端呼叫系統 `aa` 解包，
//   素材一律走殼層的 127.0.0.1 媒體伺服器（CORS 乾淨，canvas 不污染）。
// - **瀏覽器（npm run dev）**：開發與自測用。開檔只吃裸 project.json（讀不到同層
//   assets/，LZFSE 也解不了）——那是開發便利，不是產品路徑。
import { decodeProject, encodeProject, type Block, type Project } from "./core/schema";
import { loadFonts, registerSystemFonts, registerUserFont, type DynamicFont } from "./core/fonts";
import { applyFilter, loadFilterAssets, type FilterAssets } from "./core/filters";
import type { SnapStrength } from "./core/align";
import { Editor } from "./editor";
import { renderAllPages, toBlob, type ExportedPage } from "./core/export";
import { buildAnimFrames, buildPageSpec, pageHasMotion, pageHasVideo } from "./videoexport";
import { autoFitText, renderPage, renderPageCanvas } from "./core/render";
import { Inspector } from "./inspector";
import { PageStrip, type PageAction } from "./pagestrip";
import { pageIndexForX, pageRect } from "./core/geometry";
import { addPage, deletePage, duplicatePage, retargetToPage, stripToTemplate, swapAdjacentPages } from "./core/pages";
import { alignGroup, applyLayerOrder, distributeGroup, type GroupAlign, type GroupAxis } from "./core/group";
import { buildClipboard, pasteBlocks, type BlockClipboard } from "./core/clipboard";
import { CANVAS_PRESETS, canvasSize, changeCanvasRatio, newProject, simplifiedRatio } from "./core/canvas";
import { VideoPool, hiddenHost } from "./videopool";
import { ModelPool } from "./modelpool";
import { Gallery } from "./gallery";
import { openTrim } from "./trim";
import { checkUpdate } from "./updatecheck";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog, save as saveDialog, ask } from "@tauri-apps/plugin-dialog";
import { startTour, tourActive, tourNotify, type Rect as TourRect, type TourStep } from "./tour";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getVersion } from "@tauri-apps/api/app";

declare const __BUILD_STAMP__: string;

// ── 檔案對話框「分類記憶」：開專案／放媒體／匯出／字型各記各的起始資料夾 ──
// macOS 面板的位置記憶是全 App 一份，匯出去過哪、開專案面板就被帶去哪（2026-08-14 Armin 指正）。
const dirKey = (k: string) => `align.lastDir.${k}`;
const lastDir = (k: string) => localStorage.getItem(dirKey(k)) ?? undefined;
// 分隔符兩種都認：Windows 給的是 C:\…\x.alignproj，只找 "/" 會回 -1＝記憶靜默失效
const sepAt = (p: string) => Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
/** 路徑的檔名部分（顯示用）。 */
const baseName = (p: string) => p.slice(sepAt(p) + 1);
const rememberDir = (k: string, picked: string) => {
  const i = sepAt(picked);
  if (i > 0) localStorage.setItem(dirKey(k), picked.slice(0, i));
};
const rememberDirExact = (k: string, dir: string) => localStorage.setItem(dirKey(k), dir);
/** 存檔框的 defaultPath：帶上該分類記憶的資料夾 */
const inDir = (k: string, name: string) => {
  const d = lastDir(k);
  return d ? `${d}/${name}` : name;
};

const $ = <T extends HTMLElement>(s: string) => document.querySelector<T>(s)!;
const title = $<HTMLSpanElement>("#title");
const meta = $<HTMLSpanElement>("#meta");
const info = $<HTMLSpanElement>("#info");
const inApp = isTauri();

localizeTitles(); // index.html 寫死的 title="…" 一次翻完（中文語系時等於沒作用）

const editor = new Editor($<HTMLCanvasElement>("#canvas"));

editor.onSelectionChange = (blocks: Block[]) => {
  if (blocks.length > 1 && current) {
    inspector.showGroup(current, blocks);
    info.textContent = __f("已選 {n} 個元件", { n: blocks.length });
  }
};
editor.onSelect = (b: Block | null) => {
  // 多選時交給 onSelectionChange，這裡只處理「剛好一個」與「零個」
  if (b == null && editor.selectionBlocks().length > 1) return;
  inspector.show(current, b);
  if (!b) { info.textContent = ""; return; }
  const kind = { text: __("文字"), textFlow: __("續流文字"), image: __("圖片"), video: __("影片"), shape: __("形狀"), model: __("3D 物件") }[b.content.type];
  const f = b.frame;
  info.textContent = `${kind}　${Math.round(f.x)}, ${Math.round(f.y)}　${Math.round(f.w)}×${Math.round(f.h)}`
    + (b.rotation ? `　${Math.round(b.rotation)}°` : "");
};
editor.onCommit = () => {
  // ⇧ 點選多選的 up 也走這裡——不分流的話會用「最後點的那個」蓋掉多選面板
  // （2026-08-14 實案：點選多選批次欄位永遠被單選面板頂掉，框選反而正常）
  const sel = editor.selectionBlocks();
  if (current && sel.length > 1) inspector.showGroup(current, sel);
  else inspector.show(current, editor.getSelected());   // 拖完刷新位置數值
  scheduleThumbs();
  commit("drag");
};
editor.onFillSlot = (b) => {
  pickMediaForBlock(b).catch((x) => { meta.textContent = __f("填圖失敗：{msg}", { msg: x.message ?? x }); });
};
editor.onTextEdited = () => {
  inspector.show(current, editor.getSelected());   // 檢視器的內容欄同步新文字
  scheduleThumbs();
  commit("textedit");
};

// ── 專案載入 ──────────────────────────────────────────────────────────

/** 需要哪些「素材×濾鏡」的組合。同一張圖套不同濾鏡算兩項；
 *  影片畫的是海報圖（`<影片名>.poster.jpg`）。 */
function assetNames(p: Project): Map<string, { file: string; filter?: string }> {
  const out = new Map<string, { file: string; filter?: string }>();
  for (const b of p.blocks) {
    if (b.content.type !== "image" && b.content.type !== "video") continue;
    const m = b.content.media;
    if (!m.assetFileName) continue;
    const file = b.content.type === "video" ? `${m.assetFileName}.poster.jpg` : m.assetFileName;
    out.set(file + (m.filterKey ? `|${m.filterKey}` : ""), { file, filter: m.filterKey });
  }
  return out;
}

interface LoadedAssets {
  /** 「素材×濾鏡」變體——渲染直接查這個。 */
  variants: Map<string, CanvasImageSource>;
  /** 原圖。檢視器換濾鏡時從這裡重生變體。 */
  raw: Map<string, HTMLImageElement>;
}

/** 套一顆濾鏡到原圖，回快取用的 canvas。載入時套一次就好——每格重算拖曳會卡。 */
function filteredCanvas(img: HTMLImageElement, filter: string, fx: FilterAssets): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const cx = c.getContext("2d", { willReadFrequently: true })!;
  cx.drawImage(img, 0, 0);
  const d = cx.getImageData(0, 0, c.width, c.height);
  applyFilter(filter, d, fx);
  cx.putImageData(d, 0, 0);
  return c;
}

/** `resolve` 把素材檔名變成可載入的 URL——瀏覽器是 dev server 路徑、Tauri 是 asset 協定。
 *  載不到的就跳過：缺圖畫成虛線佔位框，不該讓整個專案開不起來。 */
async function loadAssets(
  p: Project,
  resolve: (file: string) => string,
  fx: FilterAssets,
): Promise<LoadedAssets> {
  const entries = [...assetNames(p)];
  const raw = new Map<string, HTMLImageElement>();
  await Promise.all([...new Set(entries.map(([, e]) => e.file))].map((file) => new Promise<void>((done) => {
    const img = new Image();
    const src = resolve(file);
    // 媒體伺服器跨源：CORS 乾淨載入——asset:// 在 WKWebView 會污染 canvas（濾鏡/匯出全滅）
    if (src.startsWith("http")) img.crossOrigin = "anonymous";
    img.onload = () => { raw.set(file, img); done(); };
    img.onerror = () => done();
    img.src = src;
  })));
  const variants = new Map<string, CanvasImageSource>();
  for (const [key, { file, filter }] of entries) {
    const img = raw.get(file);
    if (!img) continue;
    variants.set(key, filter ? filteredCanvas(img, filter, fx) : img);
  }
  return { variants, raw };
}

// 畫布上的影片預覽（實作在 videopool.ts，效能架構的理由都寫在檔頭）
const videos = new VideoPool(
  () => current,
  () => filterAssets,
  () => {
    if (!sheet.classList.contains("on")) editor.refresh();   // 匯出台蓋著時，底下那張畫布重畫也沒人看
  },
  // 「看得見」的定義：編輯中＝畫布視野；匯出台開著＝畫廊裡露出來的影片頁。
  // 視野外的影片會停止解碼——這正是大專案（15 支 4K）不再卡的關鍵
  () => {
    if (!current) return null;
    if (sheet.classList.contains("on")) {
      return visibleShotIndexes().map((i) => pageRect(current!, i));
    }
    return [editor.visibleRect()];
  },
);

// 畫布上的 3D 物件（實作在 modelpool.ts）——WebGL 離屏渲染，餵給畫布的只是普通畫布
const models = new ModelPool(() => {
  if (!sheet.classList.contains("on")) editor.refresh();
});

type Origin =
  | { kind: "sample" }
  | { kind: "json"; path: string }
  | { kind: "alignproj"; path: string; root: string };

let current: Project | null = null;
// 素材表整個 session 只換不補洞：editor.load 拿的是 variants 的**參照**，
// 這裡若在匯入時才 new 一顆新 Map，畫布永遠看不到新圖（只剩虛線框，重開才好——1.0.11 實際踩到）
let assets: LoadedAssets = { variants: new Map(), raw: new Map() };
let filterAssets: FilterAssets;
let origin: Origin = { kind: "sample" };

// ── 復原／重做：「已提交影子」模式 ────────────────────────────────────
// 每次改動完成後把整個專案快照成字串。連續的同源改動（滑桿拖動、按住方向鍵）
// 在 900ms 窗口內合併成一步——undo 回到的是「這串手勢開始之前」。
// 不用 pre-hook 的原因：檢視器的 setter 有十幾個，逐一插「改之前先快照」一定漏。
let undoStack: string[] = [];
let redoStack: string[] = [];
let committed = "";
let savedState = "";
let lastTag = ""; let lastPush = 0;

function snapshot(): string { return JSON.stringify(current); }

function commit(tag: string): void {
  const now = snapshot();
  if (now === committed) return;
  if (!(tag === lastTag && Date.now() - lastPush < 900)) {
    undoStack.push(committed);
    if (undoStack.length > 60) undoStack.shift();
  }
  committed = now; lastTag = tag; lastPush = Date.now();
  redoStack = [];
  updateDirty();
  tourNotify(tag);   // 導覽靠這裡知道「那個動作做到了」
}

function applySnapshot(s: string): void {
  current = JSON.parse(s) as Project;
  committed = s; lastTag = ""; lastPush = 0;
  editor.swapProject(current);
  inspector.show(current, editor.getSelected());
  scheduleThumbs();
  updateDirty();
}

function undo(): void {
  if (!undoStack.length) return;
  redoStack.push(committed);
  applySnapshot(undoStack.pop()!);
}
function redo(): void {
  if (!redoStack.length) return;
  undoStack.push(committed);
  applySnapshot(redoStack.pop()!);
}

function updateDirty(): void {
  if (!current) return;
  const dirty = committed !== savedState;
  title.textContent = current.name + (dirty ? "　●" : "");
  if (dirty) scheduleAutosave();   // 所有改動（commit／undo／redo）都經過這裡——自動保存掛這個漏斗
}

// ── 自動保存 ──────────────────────────────────────────────────────────
// 「編輯的不見了」不該發生（2026-08-13 真實回報）。三道防線：
// ① 已落地專案（json/alignproj）＝改完 2.5 秒閒置就靜默存檔；
// ② 未落地專案（⌘S 之前）＝寫 localStorage 草稿，開機時問要不要接續
//    （落地前不可能有匯入素材——assetsDir 擋著——所以 JSON 草稿就是完整備份）；
// ③ 關視窗前一律 flush，沒存完不放行。
const DRAFT_KEY = "align.draft";
let autosaveTimer: ReturnType<typeof setTimeout> | undefined;
let autosaving = false;

function scheduleAutosave(): void {
  if (!inApp) return;
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => { void autosaveNow(); }, 2500);
}

async function autosaveNow(): Promise<void> {
  if (!current || autosaving || committed === savedState) return;
  if (origin.kind === "sample") {
    if (tourActive()) return;   // 導覽在樣本上亂玩是設計的一部分——別把人家真正的草稿蓋掉
    localStorage.setItem(DRAFT_KEY, JSON.stringify(
      { json: encodeProject(current), name: current.name, when: Date.now() }));
    return;
  }
  autosaving = true;
  try { await saveProject(); } catch { /* 磁碟不順就等下一次改動再試——自動存檔不彈錯誤 */ }
  autosaving = false;
}

if (inApp) {
  void getCurrentWindow().onCloseRequested(async (e) => {
    if (!current || committed === savedState) return;   // 沒有未存的變更：直接關
    e.preventDefault();                                 // 要在任何 await 之前擋下
    clearTimeout(autosaveTimer);
    while (autosaving) await new Promise((ok) => setTimeout(ok, 50));   // 在途的那筆先讓它寫完
    await autosaveNow();
    void getCurrentWindow().destroy();
  });
}
const measureCtx = document.createElement("canvas").getContext("2d")!;   // 貼字盒重算用

const strip = new PageStrip($<HTMLDivElement>("#strip"), {
  pick: (i) => editor.focusPage(i),
  add: () => {
    if (!current || !addPage(current)) { meta.textContent = __("頁數上限 20 頁"); return; }
    afterPageChange(current.pageCount - 1);
  },
  move: (from: number, to: number) => {
    if (!current || from === to) return;
    const step = from < to ? 1 : -1;
    for (let i = from; i !== to; i += step) swapAdjacentPages(current, i, i + step);
    afterPageChange(to);
  },
  act: (action: PageAction, i: number) => doPageAct(action, i),
  menu: (i, at) => openMenu(pageMenu(i), at),
});

/** 頁面操作的唯一入口——右鍵選單與膠捲共用同一份。 */
function doPageAct(action: PageAction, i: number): void {
  if (!current) return;
  const ok = action === "delete" ? deletePage(current, i)
    : action === "duplicate" ? duplicatePage(current, i, newId)
    : action === "left" ? swapAdjacentPages(current, i, i - 1)
    : swapAdjacentPages(current, i, i + 1);
  if (!ok) return;
  afterPageChange(action === "left" ? i - 1 : action === "right" ? i + 1
                  : action === "duplicate" ? i + 1 : Math.min(i, current.pageCount - 1));
}

/** 頁面結構動過之後的共同收尾：畫布／膠捲／檢視器都要跟上，並記一步 undo。 */
function afterPageChange(focus: number): void {
  if (!current) return;
  editor.swapProject(current);          // 保留視野與選取，只是換內容
  editor.select(null);
  strip.render(current, renderOpts());
  editor.focusPage(Math.max(0, Math.min(focus, current.pageCount - 1)));
  inspector.show(current, null);
  commit("page");
}

/** 確保某個媒體 block 的「素材×濾鏡」變體已在快取（沒有就從原圖生）。 */
async function ensureVariantFor(b: Block): Promise<void> {
  if (b.content.type !== "image" && b.content.type !== "video") return;
  const m = b.content.media;
  if (!m.assetFileName) return;
  const file = b.content.type === "video" ? `${m.assetFileName}.poster.jpg` : m.assetFileName;
  const key = file + (m.filterKey ? `|${m.filterKey}` : "");
  if (assets.variants.has(key)) return;
  const img = assets.raw.get(file);
  if (!img) return;
  assets.variants.set(key, m.filterKey ? filteredCanvas(img, m.filterKey, filterAssets) : img);
}

/** 多圖輪播：選一張或多張圖，複製進 assets/ 後掛進這個框的輪播清單。
 *  只收圖片（輪播是「多圖」展示；影片自己會動，不進輪播）。
 *  框上有濾鏡的話，順手把每張的「素材×濾鏡」變體也生好，畫的時候才不會閃佔位框。 */
async function addCarouselImages(b: Block): Promise<void> {
  if (b.content.type !== "image" || !current) return;
  const dir = assetsDir();
  if (!dir) return;
  const picked = await openDialog({
    multiple: true,
    defaultPath: lastDir("media"),
    filters: [{ name: __("圖片"), extensions: IMG_EXT }],
  });
  const srcs = typeof picked === "string" ? [picked] : Array.isArray(picked) ? picked : [];
  if (!srcs.length) return;
  rememberDir("media", srcs[0]);
  const m = b.content.media;
  for (const src of srcs) {
    const name = await invoke<string>("copy_asset", { src, destDir: dir });
    const img = await loadImg(await localUrl(`${dir}/${name}`));
    assets.raw.set(name, img);
    assets.variants.set(name, img);
    if (m.filterKey) {
      assets.variants.set(`${name}|${m.filterKey}`, filteredCanvas(img, m.filterKey, filterAssets));
    }
    m.carouselAssets = [...(m.carouselAssets ?? []), name];
  }
  editor.refresh(); scheduleThumbs();
  inspector.show(current, editor.getSelected());
  commit("carousel");
  meta.textContent = __f("輪播共 {n} 張", { n: (m.carouselAssets?.length ?? 0) + 1 });
  setTimeout(() => { if (meta.textContent?.startsWith(__("輪播共"))) refreshMeta(); }, 2600);
}

/** 空欄位填圖／既有媒體換檔。裁切與拉直重置（屬於舊圖，iOS 同款）；
 *  遮罩／描邊／濾鏡／排開設定保留。選了影片會自動抓海報並轉型。 */
async function pickMediaForBlock(b: Block): Promise<void> {
  if (b.content.type !== "image" && b.content.type !== "video") return;
  const dir = assetsDir();
  if (!dir || !current) return;
  const src = await openDialog({
    multiple: false,
    defaultPath: lastDir("media"),
    filters: [{ name: __("影像或影片"), extensions: [...IMG_EXT, ...VID_EXT] }],
  });
  if (typeof src !== "string") return;
  rememberDir("media", src);
  const ext = src.split(".").pop()?.toLowerCase() ?? "";
  const isVid = VID_EXT.includes(ext);
  const name = await invoke<string>("copy_asset", { src, destDir: dir });
  let assetKey = name;
  if (isVid) {
    const poster = await capturePoster(await localUrl(`${dir}/${name}`));
    await invoke("save_png", { path: `${dir}/${name}.poster.jpg`, data: poster });
    assetKey = `${name}.poster.jpg`;
  }
  const img = await loadImg(await localUrl(`${dir}/${assetKey}`));
  assets.raw.set(assetKey, img);
  assets.variants.set(assetKey, img);
  const old = b.content.media;
  b.content = {
    type: isVid ? "video" : "image",
    media: { ...old, assetFileName: name, cropRect: { x: 0, y: 0, w: 1, h: 1 }, rotationDegrees: undefined },
  };
  await ensureVariantFor(b);
  editor.refresh();
  inspector.show(current, b);
  scheduleThumbs();
  commit("fill");
}

const inspector = new Inspector($<HTMLElement>("#inspector"), {
  onChange: (opts) => {
    // 文字內容/樣式動了＝貼字盒要重算（量測要在字型已載入的 ctx 上做）
    if (opts?.retext && current) autoFitText(measureCtx, current);
    editor.refresh();
    scheduleThumbs();
    commit("inspector");
  },
  ensureVariant: ensureVariantFor,
  fillMedia: (b) => { pickMediaForBlock(b).catch((x) => { meta.textContent = __f("填圖失敗：{msg}", { msg: x.message ?? x }); }); },
  addCarousel: (b) => { addCarouselImages(b).catch((x) => { meta.textContent = __f("加輪播圖失敗：{msg}", { msg: x.message ?? x }); }); },
  // 匯入字型檔（剪映語彙的「自訂」）：存進 App 資料夾 UserFonts/，重開還在。
  // 專案照舊只存 PostScript 名——iPad 也匯同一套字型，專案就兩邊長一樣。
  importFont: async () => {
    if (!inApp) { meta.textContent = __("匯入字型要在 App 內用（瀏覽器只是開發預覽）"); return null; }
    const src = await openDialog({
      multiple: false,
      defaultPath: lastDir("font"),
      filters: [{ name: __("字型檔"), extensions: ["ttf", "otf", "ttc"] }],
    });
    if (typeof src !== "string") return null;
    rememberDir("font", src);
    try {
      const f = await invoke<DynamicFont>("import_font", { src });
      // 匯入檔走 url()，必須 await 載完才能量測（字型鐵則）
      if (!f.path || !(await registerUserFont(f, await localUrl(f.path)))) {
        meta.textContent = __("這個字型檔讀不進來");
        return null;
      }
      meta.textContent = __f("已匯入字型：{name}", { name: f.label });
      return { label: f.label, value: f.ps };
    } catch (x) {
      meta.textContent = __f("匯入字型失敗：{msg}", { msg: (x as Error).message ?? x });
      return null;
    }
  },
  remove: () => deleteSelected(),
  guides: {
    hidden: () => editor.guidesHidden,
    toggleHidden: () => { editor.guidesHidden = !editor.guidesHidden; editor.refresh(); },
    add: (axis) => { editor.addGuide(axis); },
    remove: (axis, i) => {
      if (!current) return;
      (axis === "x" ? current.guidesX : current.guidesY)?.splice(i, 1);
      editor.refresh();
      inspector.show(current, editor.getSelected());
      commit("guide");
    },
    locked: () => !!current?.guidesLocked,
    toggleLocked: () => {
      if (!current) return;
      current.guidesLocked = !current.guidesLocked;
      editor.refresh();
      commit("guide");
    },
  },
  layers: {
    // 「目前這一頁」只有一個來源＝editor.currentPageIndex（有選取跟選取、否則跟視野中心）。
    // 這裡曾經自己算過一份，結果與別處分岔——同一個問題兩份答案，遲早出事。
    currentPage: () => (current ? editor.currentPageIndex() : 0),
    select: (id, additive) => {
      if (additive) editor.selectMany([...editor.selectionBlocks().map((b) => b.id), id]);
      else editor.select(id);
    },
    reorder: (idsTopFirst) => {
      if (!current) return;
      applyLayerOrder(current, idsTopFirst);
      editor.refresh();
      inspector.show(current, editor.getSelected());
      scheduleThumbs();
      commit("layerorder");
    },
    thumb: (b) => {
      if (b.content.type !== "image" && b.content.type !== "video") return undefined;
      const m = b.content.media;
      if (!m.assetFileName) return undefined;
      const file = b.content.type === "video" ? `${m.assetFileName}.poster.jpg` : m.assetFileName;
      return assets.variants.get(file + (m.filterKey ? `|${m.filterKey}` : ""));
    },
    toggleLock: (id) => {
      const b = current?.blocks.find((k) => k.id === id);
      if (!b) return;
      b.locked = !b.locked;
      editor.refresh();
      commit("lock");
    },
  },
  changeRatio: (w, h) => {
    if (!current) return;
    changeCanvasRatio(current, w, h);
    editor.swapProject(current);
    editor.fitAll();
    strip.render(current, renderOpts());
    inspector.show(current, null);
    commit("ratio");
  },
  group: {
    align: (edge: GroupAlign) => { applyToGroup((bs) => alignGroup(bs, edge), "align"); },
    distribute: (axis: GroupAxis) => { applyToGroup((bs) => distributeGroup(bs, axis), "distribute"); },
    duplicate: () => duplicateSelection(),
    remove: () => deleteSelected(),
  },
  // 出場動畫——面板選了效果就在畫布上循環播放，不必匯出
  playAnim: (b) => editor.playAnim(b),
  sequenceAll: (b) => editor.sequenceCurrentPage(b),
  clearAnims: (b) => editor.clearCurrentPageAnims(b),
  reorder: (b, dir) => {
    if (!current) return;
    const zs = current.blocks.map((k) => k.zIndex);
    b.zIndex = dir === "front" ? Math.max(...zs) + 1 : Math.min(...zs) - 1;
    editor.refresh();
    scheduleThumbs();
    commit("reorder");
  },
});

/** 目前專案的影片 URL 解析器（修剪後要重接影片池，所以留一份在模組層）。 */
let videoUrl: ((file: string) => string) | undefined;

function show(p: Project, a?: LoadedAssets, videoSrc?: (file: string) => string): void {
  current = p; assets = a ?? { variants: new Map(), raw: new Map() }; videoUrl = videoSrc;
  closeHome();   // 有專案上台，首頁退場
  title.textContent = p.name;
  refreshMeta();   // 素材數比對的是不重複素材，拿 block 數當分母會誤報載不齊
  editor.load(p, assets.variants);
  // undo／dirty 基準在 load **之後**取——load 會跑 autoFitText 重算貼字盒，
  // 先取基準的話使用者一動就被誤標「未存變更」
  undoStack = []; redoStack = [];
  committed = snapshot(); savedState = committed;
  updateDirty();
  inspector.show(p, null);
  strip.render(p, renderOpts());
  videos.attach(videoSrc ?? null);   // 換專案＝舊播放器全收掉，再照新來源接
  editor.setVideos(videoSrc ? videos.frames : undefined);
  models.attach(videoSrc ?? null);   // 3D 池同一個素材 URL 解析器（媒體伺服器通吃）
  editor.setModels(models);
}

function renderOpts() {
  return { images: assets.variants, filters: filterAssets, models, placeholderForMissingMedia: true };
}

// ── 匯出台的 PNG 選項（2026-08-14，優化項目 #11）──────────────────────
// 透明背景＝跳過頁底色與紙張（紙是背景面）；只留文字＝字幕／片尾疊層，
// 給剪輯軟體（達芬奇）直接壓在畫面上；2×＝畫布兩倍像素（16:9 即 4K）。
// 記在本機——他每次要的多半一樣，不用每回重勾。
const EXPORT_PNG_KEY = "align.exportPng";
const exportPng = { alpha: false, textOnly: true, scale2x: false };
try { Object.assign(exportPng, JSON.parse(localStorage.getItem(EXPORT_PNG_KEY) ?? "{}")); } catch { /* 壞值用預設 */ }

/** 匯出（存檔）用的渲染選項。透明模式不套紙張——紙是背景面，疊層不該帶。 */
function exportOpts() {
  const scale = exportPng.scale2x ? 2 : 1;
  if (!exportPng.alpha) return { ...renderOpts(), scale };
  return {
    images: assets.variants, models, placeholderForMissingMedia: true, scale,
    transparent: true,
    onlyBlockIds: exportPng.textOnly && current
      ? new Set(current.blocks
          .filter((b) => b.content.type === "text" || b.content.type === "textFlow")
          .map((b) => b.id))
      : undefined,
  };
}

/**
 * 匯出台的**預覽**用：跟匯出同一條渲染路（含透明／只留文字／倍率），
 * 但多餵即時影格，所以影片會動。存檔不能用這個——同一份專案匯出兩次
 * 必須一模一樣，抓「當下那一格」會讓 PNG 隨手速改變（VideoPool 開頭那條取捨）。
 */
function previewOpts() {
  return { ...exportOpts(), videos: videos.frames };
}

// 縮圖走全解析度渲染，改一個值重畫七頁沒必要——收斂到停手後 300ms 才更新
let thumbTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleThumbs(): void {
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(() => { if (current) strip.render(current, renderOpts()); }, 300);
}

async function openSample(base: string): Promise<void> {
  await autosaveNow();   // 換專案前 flush 手上的——別讓 2.5 秒 debounce 空窗吃掉最後一筆
  const p = decodeProject(await (await fetch(`${base}/project.json`)).json());
  origin = { kind: "sample" };
  const url = (f: string) => `${base}/assets/${encodeURIComponent(f)}`;
  show(p, await loadAssets(p, url, filterAssets), url);
}

async function openNative(): Promise<void> {
  const path = await openDialog({
    multiple: false,
    defaultPath: lastDir("open"),
    filters: [{ name: __("ALIGN 專案"), extensions: ["alignproj", "json"] }],
  });
  if (typeof path !== "string") return;
  rememberDir("open", path);
  await openPath(path);
}

/** 媒體伺服器位址（App 內所有磁碟媒體的唯一出口），第一次用時抓。 */
let mediaBasePromise: Promise<string> | null = null;

/**
 * 磁碟絕對路徑 → 可安全讀回的 URL。
 * **App 內一律走 127.0.0.1 媒體伺服器、不走 asset://**——兩個屍體都驗過：
 * ① asset:// 串流 range 回錯資料（綠色亂碼，README 第十九輪）；
 * ② asset:// 的圖在 WKWebView 會污染 canvas，濾鏡 getImageData 與 ⌘E 匯出
 *   直接 SecurityError（2026-08-09 探針證實，Chrome 測不出來）。
 * 搭配 <img>/<video> 的 crossOrigin="anonymous"＋伺服器整套 CORS 頭（含 preflight）。
 */
async function localUrl(absPath: string): Promise<string> {
  return `${await mediaBaseOnce()}/${encodeURIComponent(absPath)}`;
}

/** 開一個指定路徑的專案——⌘O 與 ?open=（診斷用旗標）共用同一條路。 */
async function openPath(path: string): Promise<void> {
  await autosaveNow();   // 換專案前 flush，理由同 openSample
  const r = await invoke<{ json: string; asset_dir: string | null; root_dir: string }>("load_project", { path });
  const p = decodeProject(JSON.parse(r.json));
  origin = path.endsWith(".alignproj")
    ? { kind: "alignproj", path, root: r.root_dir }
    : { kind: "json", path };
  const dir = r.asset_dir;
  const base = dir ? await mediaBaseOnce() : null;
  const fileUrl = dir && base
    ? (f: string) => `${base}/${encodeURIComponent(`${dir}/${f}`)}`
    : undefined;
  show(p, fileUrl ? await loadAssets(p, fileUrl, filterAssets) : undefined, fileUrl);
  rememberRecent();
}

async function mediaBaseOnce(): Promise<string> {
  mediaBasePromise ??= invoke<string>("media_base");
  return mediaBasePromise;
}

function openBrowser(): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "application/json";
  input.onchange = async () => {
    const f = input.files?.[0];
    if (!f) return;
    origin = { kind: "sample" };   // 瀏覽器拿不到路徑，存檔一律走下載
    show(decodeProject(JSON.parse(await f.text())));
  };
  input.click();
}

$<HTMLButtonElement>("#open").addEventListener("click", () => {
  (inApp ? openNative() : Promise.resolve(openBrowser())).catch((e) => {
    meta.textContent = __f("開啟失敗：{msg}", { msg: e.message ?? e });
  });
});

$<HTMLSelectElement>("#sample").addEventListener("change", (e) => {
  openSample((e.target as HTMLSelectElement).value);
});

$<HTMLButtonElement>("#exporttpl").addEventListener("click", () => {
  exportTemplate().catch((x) => { meta.textContent = __f("匯出範本失敗：{msg}", { msg: x.message ?? x }); });
});

$<HTMLSelectElement>("#snap").addEventListener("change", (e) => {
  editor.snapStrength = (e.target as HTMLSelectElement).value as SnapStrength;
});

// ── 右鍵選單 ──────────────────────────────────────────────────────────
// 桌面的第一直覺。項目只放「在這個物件上會想做的事」，其餘留給檢視器。

const menu = document.createElement("div");
menu.id = "ctxmenu";
document.body.append(menu);
const closeMenu = (): void => { menu.style.display = "none"; };
window.addEventListener("pointerdown", (e) => { if (!menu.contains(e.target as Node)) closeMenu(); }, true);

// ── 出場動畫播放鍵（播放器語彙：三角形＝播放、雙直槓＝暫停）──
const playBtn = document.querySelector<HTMLButtonElement>("#playBtn")!;
const ICON_PLAY = `<svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor" stroke="none"><path d="M6.5 4.2l9 5.8-9 5.8z"/></svg>`;
const ICON_PAUSE = `<svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor" stroke="none"><rect x="5.6" y="4.2" width="3.2" height="11.6" rx="0.6"/><rect x="11.2" y="4.2" width="3.2" height="11.6" rx="0.6"/></svg>`;
playBtn.onclick = () => editor.toggleAnim();
// 播放＝整個版面一起跑（影片＋出場動畫）；暫停＝兩者都停，回到原始版面。
// 影片平常在編輯畫布本來就是播的，所以「暫停」才是那個要主動下的指令。
editor.onAnimPlayChange = (playing) => {
  playBtn.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
  playBtn.title = playing ? __("暫停（影片與出場動畫一起）") : __("播放整個版面（含影片，循環）");
  playBtn.classList.toggle("on", playing);
  videos.setPaused(!playing);
};
// 開檔預設＝播放中：影片照常動（跟加播放鍵之前一樣），按一下才是暫停
videos.setPaused(false);
playBtn.innerHTML = ICON_PAUSE;
playBtn.title = __("暫停（影片與出場動畫一起）");
playBtn.classList.add("on");

window.addEventListener("blur", closeMenu);

/** 選單項：分隔線、或一顆（可帶子選單）。 */
type MenuItem = "-" | { label: string; key?: string; run?: () => void; sub?: MenuItem[] };

function buildMenu(host: HTMLElement, items: MenuItem[]): void {
  host.replaceChildren();
  for (const it of items) {
    if (it === "-") { host.append(document.createElement("hr")); continue; }
    const row = document.createElement("button");
    row.innerHTML = `<span>${it.label}</span><span class="k">${it.sub ? "▸" : it.key ?? ""}</span>`;
    if (it.sub) {
      const sub = document.createElement("div");
      sub.className = "sub";
      buildMenu(sub, it.sub);
      row.append(sub);
      row.classList.add("hassub");
    } else {
      row.onclick = () => { closeMenu(); it.run?.(); };
    }
    host.append(row);
  }
}

/** 把一個元件搬到（或複製到）第 to 頁：頁內位置不動，只換所屬的那一格。 */
function toPage(blocks: Block[], to: number, copy: boolean): void {
  if (!current) return;
  current.blocks.push(...retargetToPage(current, blocks, to, copy, newId));
  editor.refresh();
  scheduleThumbs();
  inspector.show(current, editor.getSelected());
  commit(copy ? "copyToPage" : "moveToPage");
}

/** 「複製這一頁」＝整頁複製並插在它後面（頁面操作共用這一支）。 */
function pageMenu(i: number): MenuItem[] {
  return [
    { label: __("複製這一頁（含內容）"), run: () => doPageAct("duplicate", i) },
    { label: __("在後面插入空白頁"), run: () => insertBlankAfter(i) },
    "-",
    { label: __("往前一頁"), run: () => doPageAct("left", i) },
    { label: __("往後一頁"), run: () => doPageAct("right", i) },
    "-",
    { label: __("刪除這一頁"), run: () => doPageAct("delete", i) },
  ];
}

function insertBlankAfter(i: number): void {
  if (!current || !addPage(current)) { meta.textContent = __("頁數上限 20 頁"); return; }
  for (let k = current.pageCount - 1; k > i + 1; k--) swapAdjacentPages(current, k, k - 1);
  afterPageChange(i + 1);
}

editor.onContextMenu = (b, at) => {
  if (!current) return;
  const sel = editor.selectionBlocks();
  const here = pageIndexForX(current, editor.centerPoint().x);
  const others = Array.from({ length: current.pageCount }, (_, i) => i)
    .filter((i) => !b || i !== pageIndexForX(current!, b.frame.x + b.frame.w / 2));
  const items: MenuItem[] = [];
  if (b) {
    const many = sel.length > 1;
    items.push({ label: __("拷貝"), key: keys("⌘C"), run: () => copySelection() });
    items.push({ label: __("複製一份"), key: keys("⌘D"), run: () => duplicateSelection() });
    if (others.length) {
      items.push({ label: many ? __("複製到其他頁") : __("複製到第…頁"),
                   sub: others.map((i) => ({ label: __f("第 {n} 頁", { n: i + 1 }), run: () => toPage(sel, i, true) })) });
      items.push({ label: __("移到第…頁"),
                   sub: others.map((i) => ({ label: __f("第 {n} 頁", { n: i + 1 }), run: () => toPage(sel, i, false) })) });
    }
    items.push("-");
    items.push({ label: b.locked ? __("解除鎖定") : __("鎖定"), key: keys("⌘L"), run: () => {
      for (const k of sel) k.locked = !b.locked;
      inspector.show(current, editor.getSelected());
      editor.refresh(); commit("lock");
    } });
    items.push({ label: __("移到最前"), run: () => inspectorReorder("front") });
    items.push({ label: __("移到最後"), run: () => inspectorReorder("back") });
    if (b.content.type === "video" && b.content.media.assetFileName && inApp) {
      items.push("-");
      items.push({ label: __("修剪影片…"), run: () => void trimBlock(b) });
    }
    if (sel.length > 1) {
      items.push("-");
      items.push({ label: __("水平置中對齊"), run: () => applyToGroup((bs) => alignGroup(bs, "hCenter"), "align") });
      items.push({ label: __("垂直置中對齊"), run: () => applyToGroup((bs) => alignGroup(bs, "vCenter"), "align") });
    }
    items.push("-");
    items.push({ label: sel.length > 1 ? __f("刪除選取的 {n} 個", { n: sel.length }) : __("刪除"), key: "⌫", run: () => deleteSelected() });
  } else {
    items.push({ label: __("在這裡加文字"), run: () => addBlock("text") });
    items.push({ label: __("在這裡加矩形"), run: () => addBlock("rectangle") });
    if (localStorage.getItem(CLIP_KEY)) {
      items.push({ label: __("貼上"), key: keys("⌘V"), run: () => void pasteClipboard() });
    }
    items.push("-");
    items.push({ label: __f("第 {n} 頁", { n: here + 1 }), sub: pageMenu(here) });
    items.push("-");
    items.push({ label: __("整台縮到剛好"), key: keys("⌘0"), run: () => editor.fitAll() });
  }
  openMenu(items, at);
};

function openMenu(items: MenuItem[], at: { x: number; y: number }): void {
  buildMenu(menu, items);
  menu.style.display = "block";
  menu.style.left = `${Math.min(at.x, window.innerWidth - 210)}px`;
  menu.style.top = `${Math.min(at.y, window.innerHeight - menu.offsetHeight - 12)}px`;
}

function inspectorReorder(dir: "front" | "back"): void {
  const b = editor.getSelected();
  if (!b || !current) return;
  const zs = current.blocks.map((k) => k.zIndex);
  b.zIndex = dir === "front" ? Math.max(...zs) + 1 : Math.min(...zs) - 1;
  editor.refresh(); scheduleThumbs(); commit("reorder");
}

// ⌥ 拖曳＝複製：殼層負責複製與 undo，編輯器只管拖
editor.onDuplicateForDrag = () => {
  const sel = editor.selectionBlocks();
  if (!current || !sel.length) return [];
  const zs = current.blocks.map((k) => k.zIndex);
  let top = Math.max(...zs);
  const copies = sel.map((b) => ({ ...structuredClone(b), id: newId(), zIndex: ++top }));
  current.blocks.push(...copies);
  scheduleThumbs();
  commit("duplicate");
  return copies;
};

editor.onGuidesChanged = () => {
  inspector.show(current, editor.getSelected());
  commit("guide");
};

editor.onContentMode = (on) => {
  meta.textContent = on ? __("搬照片模式：拖曳＝在框內移動照片，Esc 離開") : "";
};

// ── 開場首頁 ──────────────────────────────────────────────────────────
// 桌面 App 的第一眼：最近專案（localStorage 記路徑＋第一頁小縮圖）＋新專案／開啟。
// 只在 App 內出現（瀏覽器拿不到檔案路徑）；?open=／?export= 這類驗證旗標會跳過。
// Esc＝先逛範本（首頁底下墊著的就是範本樣本）。

interface RecentEntry { path: string; name: string; time: number; thumb?: string }
const RECENT_KEY = "align.recent";
const home = $<HTMLDivElement>("#home");

function recents(): RecentEntry[] {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as RecentEntry[]; }
  catch { return []; }
}
function saveRecents(list: RecentEntry[]): void {
  localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 12)));
}

/** 記住目前專案（開啟成功與存檔後呼叫）。縮圖＝第一頁縮成 JPEG，
 *  高度做 2×（卡片顯示框 128px、Retina 要 256——1.0.5 之前只存 148，糊）。 */
function rememberRecent(): void {
  if (!inApp || !current || origin.kind === "sample") return;
  const path = origin.path;
  let thumb: string | undefined;
  try {
    const c = renderPageCanvas(current, 0, renderOpts());
    const h = 296, w = Math.max(1, Math.round((c.width / c.height) * h));
    const s = document.createElement("canvas");
    s.width = w; s.height = h;
    s.getContext("2d")!.drawImage(c, 0, 0, w, h);
    thumb = s.toDataURL("image/jpeg", 0.72);
  } catch { /* 縮圖抓不到就不放，卡片顯示占位圖示 */ }
  saveRecents([{ path, name: current.name, time: Date.now(), thumb },
               ...recents().filter((r) => r.path !== path)]);
}

function timeAgo(t: number): string {
  const d = Date.now() - t;
  if (d < 3600_000) return __f("{n} 分鐘前", { n: Math.max(1, Math.round(d / 60000)) });
  if (d < 86400_000) return __f("{n} 小時前", { n: Math.round(d / 3600_000) });
  if (d < 7 * 86400_000) return __f("{n} 天前", { n: Math.round(d / 86400_000) });
  return new Date(t).toLocaleDateString("zh-TW");
}

function renderHome(): void {
  const grid = $<HTMLDivElement>("#recentgrid");
  grid.replaceChildren();
  const list = recents();
  if (!list.length) {
    const p = document.createElement("div");
    p.className = "empty";
    p.textContent = __("還沒有最近專案。開一份新的，或打開 iPad AirDrop 過來的 .alignproj。");
    grid.append(p);
    return;
  }
  for (const r of list) {
    const card = document.createElement("div");
    card.className = "recent";
    const shot = document.createElement("div");
    shot.className = "shot";
    if (r.thumb) {
      const img = document.createElement("img");
      img.src = r.thumb;
      shot.append(img);
    } else {
      shot.innerHTML = '<svg width="26" height="26" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="14" height="12" rx="2"/><path d="M3.4 13.6l3.8-2.9 3.4 2.5 2.4-1.7 3.6 2.5"/></svg>';
    }
    const nm = document.createElement("div");
    nm.className = "nm"; nm.textContent = r.name;
    const pt = document.createElement("div");
    pt.className = "pt";
    pt.textContent = `${timeAgo(r.time)}　${r.path.replace(/^\/Users\/[^/]+/, "~")}`;
    pt.title = r.path;
    const rm = document.createElement("button");
    rm.className = "rm"; rm.title = __("從清單移除");
    rm.innerHTML = '<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7"/></svg>';
    rm.addEventListener("click", (e) => {
      e.stopPropagation();
      saveRecents(recents().filter((k) => k.path !== r.path));
      renderHome();
    });
    card.append(shot, nm, pt, rm);
    card.addEventListener("click", () => {
      // 開失敗卡片留著——可能只是外接碟沒接，不急著把入口丟掉
      openPath(r.path).catch((x) => { meta.textContent = __f("開不起來：{msg}", { msg: x.message ?? x }); });
    });
    grid.append(card);
  }
}

function showHome(): void { renderHome(); home.classList.add("on"); }
function closeHome(): void { home.classList.remove("on"); }

// 新專案先不關首頁：取消建立就回到首頁，建立成功 show() 會自己關
$<HTMLButtonElement>("#homeNew").addEventListener("click", () => openNewSheet());
$<HTMLButtonElement>("#homeOpen").addEventListener("click", () => $<HTMLButtonElement>("#open").click());
// 頂列回首頁：先把目前專案的縮圖刷成最新（也順便把它排到清單最上面），Esc 可回編輯
$<HTMLButtonElement>("#homeBtn").addEventListener("click", () => { rememberRecent(); showHome(); });
for (const a of home.querySelectorAll<HTMLAnchorElement>("[data-sample]")) {
  a.addEventListener("click", () => { void openSample(a.dataset.sample!); });
}

// ── 新專案 ────────────────────────────────────────────────────────────
// 桌面沒有「專案庫」，新專案就是一份還沒落地的檔案——⌘S 才決定它住哪。

const newSheet = $<HTMLDivElement>("#newsheet");
const presetSel = $<HTMLSelectElement>("#newpreset");
for (const p of CANVAS_PRESETS) {
  const o = document.createElement("option");
  o.value = p.key; o.textContent = p.label;
  presetSel.append(o);
}
presetSel.value = "4:5";   // IG 輪播的主力比例

function newSheetSize(): { w: number; h: number } {
  return canvasSize(presetSel.value, $<HTMLSelectElement>("#newflip").value === "1");
}

/** 比例預覽：真的照比例畫一個小方塊，數字與比例字串放旁邊。 */
function refreshRatioPreview(): void {
  const { w, h } = newSheetSize();
  const max = 46;
  const sw = $<HTMLDivElement>("#ratiosw");
  sw.style.width = `${w >= h ? max : (max * w) / h}px`;
  sw.style.height = `${w >= h ? (max * h) / w : max}px`;
  $<HTMLDivElement>("#ratiotxt").innerHTML =
    `${w} × ${h}<br>${simplifiedRatio(w, h)}`;
}
for (const id of ["#newpreset", "#newflip"]) {
  $<HTMLSelectElement>(id).addEventListener("change", refreshRatioPreview);
}
refreshRatioPreview();

function openNewSheet(): void {
  newSheet.classList.add("on");
  $<HTMLInputElement>("#newname").focus();
  $<HTMLInputElement>("#newname").select();
}
function closeNewSheet(): void { newSheet.classList.remove("on"); }

$<HTMLButtonElement>("#newproj").addEventListener("click", openNewSheet);
$<HTMLButtonElement>("#newcancel").addEventListener("click", closeNewSheet);
newSheet.addEventListener("click", (e) => { if (e.target === newSheet) closeNewSheet(); });
$<HTMLButtonElement>("#newok").addEventListener("click", async () => {
  await autosaveNow();   // 開新專案前 flush 手上的，理由同 openSample
  const { w, h } = newSheetSize();
  const p = newProject(
    $<HTMLInputElement>("#newname").value.trim() || __("未命名專案"),
    presetSel.value, $<HTMLSelectElement>("#newflip").value === "1",
    Number($<HTMLInputElement>("#newpages").value) || 1, newId(),
  );
  p.canvasWidth = w; p.pageHeight = h;
  origin = { kind: "sample" };   // 還沒落地——⌘S 會走「另存」
  closeNewSheet();
  show(p, undefined, undefined);
  meta.textContent = __("新專案：⌘S 存檔之後才能匯入素材");
});

/** 匯出輕量範本：一份沒有 assets 的 .alignproj，圖片位置全成空欄位框。
 *  這是「把版型分享出去」的路——AirDrop 給 iPad 打開就能填自己的照片。 */
async function exportTemplate(): Promise<void> {
  if (!current) return;
  if (!inApp) { meta.textContent = __("匯出範本要在 App 內用"); return; }
  const path = await saveDialog({
    defaultPath: inDir("export", __f("{name}_範本.alignproj", { name: current.name })),
    filters: [{ name: __("ALIGN 範本"), extensions: ["alignproj"] }],
  });
  if (typeof path !== "string") return;
  rememberDir("export", path);
  const json = JSON.stringify(encodeProject(stripToTemplate(current)), null, 2);
  await invoke("pack_template", { json, dest: path });
  meta.textContent = __f("已匯出範本　{file}", { file: baseName(path) });
}

// ── 匯出 ──────────────────────────────────────────────────────────────
let shots: ExportedPage[] = [];
const sheet = $<HTMLDivElement>("#sheet");

const SOUND_ICON = {
  on: '<svg width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7.5h2.6L10 4.6v10.8L6.6 12.5H4z"/><path d="M13 7.4a3.6 3.6 0 010 5.2"/><path d="M15.2 5.2a6.8 6.8 0 010 9.6"/></svg>',
  off: '<svg width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7.5h2.6L10 4.6v10.8L6.6 12.5H4z"/><path d="M13.4 8.2l3.4 3.6"/><path d="M16.8 8.2l-3.4 3.6"/></svg>',
};

type PreviewMode = "single" | "joined" | "cards";
let mode: PreviewMode = "single";
let cur = 0;
let previewTimer: ReturnType<typeof setInterval> | undefined;

// 匯出台的視窗（拖曳／縮放／點作品）——三種排法共用同一台，細節在 gallery.ts
const gallery = new Gallery($<HTMLDivElement>("#stage"), $<HTMLDivElement>("#shots"), {
  zoom: (k) => { $<HTMLButtonElement>("#zoomval").textContent = `${Math.round(k * 100)}%`; },
  // 點作品＝把它翻到「分開」看大張（分開模式已經是大張了，就不用再點）
  pick: (i) => {
    if (mode === "single" || !shots[i]) return;
    cur = i; mode = "single"; syncSheet(); resetView();
  },
});

/** 分開＝整張看到；連續／摺頁＝對齊高度、左右自己捲（這才是「像編輯頁一樣滑」）。 */
function resetView(): void {
  gallery.setLayout(mode === "single", mode === "cards" ? 74 : 52);   // 摺頁要留作品牌的位置
}

// 牆的顏色：白盒（純白）或暗房。記住選擇——這是看作品的習慣，不是每次都要重選的設定
const THEME_KEY = "align.gallery.theme";
function setGalleryTheme(t: "light" | "dark"): void {
  sheet.dataset.theme = t;
  localStorage.setItem(THEME_KEY, t);
}
setGalleryTheme(localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light");
$<HTMLButtonElement>("#themeBtn").addEventListener("click", () => {
  setGalleryTheme(sheet.dataset.theme === "dark" ? "light" : "dark");
});

$<HTMLButtonElement>("#zoomin").addEventListener("click", () => gallery.zoomBy(1.25));
$<HTMLButtonElement>("#zoomout").addEventListener("click", () => gallery.zoomBy(1 / 1.25));
$<HTMLButtonElement>("#zoomval").addEventListener("click", () => resetView());

window.addEventListener("resize", () => {
  if (sheet.classList.contains("on") && !gallery.touched) resetView();
});

/** 匯出台裡有哪些頁真的露在畫廊視窗內（依排法與 gallery 的平移縮放）。 */
function visibleShotIndexes(): number[] {
  if (!shots.length) return [];
  if (mode === "single") return shots[cur] ? [shots[cur].index] : [];
  // 連續／摺頁：內容層是「原始像素排版＋單一 translate/scale」，
  // 所以 offsetLeft/offsetWidth 不受 transform 影響，可靠地換算成螢幕區間
  const st = $<HTMLDivElement>("#stage");
  const figs = [...$<HTMLDivElement>("#shots").children] as HTMLElement[];
  const v = gallery.view;
  const out: number[] = [];
  figs.forEach((f, i) => {
    const left = f.offsetLeft * v.k + v.x;
    const right = (f.offsetLeft + f.offsetWidth) * v.k + v.x;
    if (right > 0 && left < st.clientWidth && shots[i]) out.push(shots[i].index);
  });
  return out;
}

/** 匯出台裡「有影片的頁」——匯出點擊時算一次，不必每拍全量重掃。 */
let videoPageSet = new Set<number>();

/** 影片頁在匯出台**要會動**——iPad 三種預覽都會播，成品該長什麼樣就看什麼樣。
 *  只重畫**露在視窗內**的影片頁，而且直接畫在展示畫布上（省一張全解析度離屏）。 */
function repaintVideoPages(): void {
  if (!current || !sheet.classList.contains("on")) return;
  const seen = new Set(visibleShotIndexes());
  for (const s of shots) {
    if (!videoPageSet.has(s.index) || !seen.has(s.index)) continue;
    if (current.paperKey && filterAssets) {
      // 紙張是整頁逐像素運算，只能走離屏路。
      // 2× 匯出時 shot 的 ctx 帶著縮放 transform，貼整張離屏圖前要歸零才不會貼成四倍
      const live = renderPageCanvas(current, s.index, previewOpts());
      const ctx = s.canvas.getContext("2d")!;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, s.canvas.width, s.canvas.height);
      ctx.drawImage(live, 0, 0);
      ctx.restore();
    } else {
      renderPage(s.canvas.getContext("2d")!, current, s.index, previewOpts());
    }
  }
}

function syncSheet(): void {
  const stage = $<HTMLDivElement>("#stage");
  stage.className = mode;
  const figs = [...$<HTMLDivElement>("#shots").children] as HTMLElement[];
  figs.forEach((f, i) => f.classList.toggle("cur", i === cur));
  const dots = $<HTMLDivElement>("#dots");
  dots.style.display = mode === "single" ? "flex" : "none";
  [...dots.children].forEach((d, i) => d.classList.toggle("on", i === cur));
  $<HTMLButtonElement>("#saveCur").style.display = mode === "single" ? "" : "none";
  for (const b of $<HTMLSpanElement>("#modes").querySelectorAll("button")) {
    b.classList.toggle("on", b.dataset.mode === mode);
  }
  const videoCount = videoPageSet.size;
  const tail = videoCount ? __f("　{n} 頁為影片", { n: videoCount }) : "";
  $<HTMLDivElement>("#hint").textContent =
    mode === "single" ? __f("第 {cur} ／ {total} 張・← → 翻頁{tail}", { cur: cur + 1, total: shots.length, tail })
    : mode === "joined" ? __f("頁貼著頁・檢查跨頁圖在接縫處對不對得齊{tail}", { tail })
    : __f("一頁一張卡・多圖貼文的樣子{tail}", { tail });
}

/** 依目前的 PNG 選項重拍全部頁面並鋪進畫廊（匯出台開著時切選項也走這裡）。 */
function buildShots(): void {
  if (!current) return;
  // 匯出走的是與編輯預覽同一支 renderPageCanvas，所以所見即所得
  shots = renderAllPages(current, exportOpts());
  // 透明匯出的檔名帶記號，落地才分得出哪張是疊層
  if (exportPng.alpha) for (const s of shots) s.name = s.name.replace(/\.png$/, `${__("_透明")}.png`);
  const c = shots[0].canvas;
  $<HTMLSpanElement>("#sheetTitle").textContent = current.name;
  $<HTMLSpanElement>("#sheetSub").textContent = __f("{n} 頁　{w} × {h}", { n: shots.length, w: c.width, h: c.height });
  const box = $<HTMLDivElement>("#shots");
  box.replaceChildren();
  for (const s of shots) {
    const fig = document.createElement("figure");
    if (pageHasVideo(current, s.index)) {
      fig.className = "video";
      const badge = document.createElement("span");
      badge.className = "vidbadge";
      badge.innerHTML = '<svg width="9" height="9" viewBox="0 0 10 10" fill="currentColor"><path d="M2 1l7 4-7 4z"/></svg>影片';
      fig.append(badge);
    }
    fig.append(s.canvas);
    const cap = document.createElement("figcaption");
    cap.textContent = String(s.index + 1);
    fig.append(cap);
    box.append(fig);
  }
  const dots = $<HTMLDivElement>("#dots");
  dots.replaceChildren(...shots.map((_, i) => {
    const d = document.createElement("i");
    d.onclick = () => { cur = i; syncSheet(); };
    return d;
  }));
  cur = Math.min(cur, shots.length - 1);
  videoPageSet = new Set(shots.filter((s) => pageHasVideo(current!, s.index)).map((s) => s.index));
  syncSheet();
}

$<HTMLButtonElement>("#export").addEventListener("click", () => {
  if (!current) return;
  cur = 0;
  buildShots();
  syncPngOpts();
  $<HTMLButtonElement>("#muteBtn").innerHTML = muted ? SOUND_ICON.off : SOUND_ICON.on;
  sheet.classList.add("on");
  requestAnimationFrame(resetView);        // 要等版面算完才量得到內容尺寸
  clearInterval(previewTimer);
  if (videoPageSet.size) {
    previewTimer = setInterval(repaintVideoPages, 1000 / 12);   // 匯出台只是看，12fps 夠了
  }
});

// ── PNG 選項三顆（透明背景／只留文字／倍率）：改了就地重拍，畫廊即時反映 ──
const alphaBtn = $<HTMLButtonElement>("#alphaBtn");
const textOnlyBtn = $<HTMLButtonElement>("#textOnlyBtn");
const scaleBtn = $<HTMLButtonElement>("#scaleBtn");
alphaBtn.textContent = __("透明");
textOnlyBtn.textContent = __("只留文字");

function syncPngOpts(): void {
  alphaBtn.classList.toggle("on", exportPng.alpha);
  textOnlyBtn.style.display = exportPng.alpha ? "" : "none";
  textOnlyBtn.classList.toggle("on", exportPng.textOnly);
  scaleBtn.textContent = exportPng.scale2x ? "2×" : "1×";
  scaleBtn.classList.toggle("on", exportPng.scale2x);
}

function togglePngOpt(mutate: () => void): void {
  mutate();
  localStorage.setItem(EXPORT_PNG_KEY, JSON.stringify(exportPng));
  syncPngOpts();
  if (sheet.classList.contains("on")) { buildShots(); requestAnimationFrame(resetView); }
}
alphaBtn.addEventListener("click", () => togglePngOpt(() => { exportPng.alpha = !exportPng.alpha; }));
textOnlyBtn.addEventListener("click", () => togglePngOpt(() => { exportPng.textOnly = !exportPng.textOnly; }));
scaleBtn.addEventListener("click", () => togglePngOpt(() => { exportPng.scale2x = !exportPng.scale2x; }));

for (const b of $<HTMLSpanElement>("#modes").querySelectorAll("button")) {
  b.addEventListener("click", () => {
    mode = (b.dataset.mode ?? "single") as PreviewMode;
    syncSheet();
    resetView();       // 換排法＝換一面牆，重新掛過
  });
}

// 匯出台開著時，鍵盤歸它管（別讓底下的編輯器快捷鍵一起吃）
window.addEventListener("keydown", (e) => {
  if (!sheet.classList.contains("on")) return;
  if (e.key === "Escape") { closeSheet(); return; }
  if (e.metaKey || e.ctrlKey) {
    if (e.key === "0") { e.preventDefault(); resetView(); }
    if (e.key === "=" || e.key === "+") { e.preventDefault(); gallery.zoomBy(1.25); }
    if (e.key === "-") { e.preventDefault(); gallery.zoomBy(1 / 1.25); }
    if (e.key === "1") { e.preventDefault(); gallery.zoomBy(1 / gallery.view.k); }
    return;
  }
  if (mode === "single" && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
    e.preventDefault();
    // 縮放不動——放大看某個細節，再用方向鍵逐頁比對同一塊，是桌面才有的看法
    cur = Math.min(Math.max(cur + (e.key === "ArrowRight" ? 1 : -1), 0), shots.length - 1);
    syncSheet();
  }
});

/**
 * 要存出去的畫布。預覽畫布上停著某一格影片，不能直接存——
 * 影片頁重畫一張海報圖版，同一份專案匯出兩次才會一模一樣。
 */
function stillCanvas(s: ExportedPage): HTMLCanvasElement {
  return current && pageHasVideo(current, s.index)
    ? renderPageCanvas(current, s.index, exportOpts()) : s.canvas;
}

async function pngBase64(s: ExportedPage): Promise<string> {
  const bytes = new Uint8Array(await (await toBlob(stillCanvas(s))).arrayBuffer());
  let bin = "";
  const CHUNK = 0x8000;   // 一次全展開會炸呼叫堆疊，分段餵 fromCharCode
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

async function saveOne(s: ExportedPage): Promise<void> {
  // 會動的頁存成 mp4：有出場動畫／輪播＝逐格烤（含頁上影片）；只有影片＝原本的合成路
  const motion = inApp && current && pageHasMotion(current, s.index);
  if (motion || (inApp && current && pageHasVideo(current, s.index))) {
    const path = await saveDialog({
      defaultPath: inDir("export", s.name.replace(/\.png$/, ".mp4")),
      filters: [{ name: __("影片"), extensions: ["mp4"] }],
    });
    if (typeof path !== "string") return;
    rememberDir("export", path);
    const title = $<HTMLSpanElement>("#sheetSub");
    const base = title.textContent ?? "";
    title.textContent = motion ? __f("{base}　烤動畫影格中…", { base }) : __f("{base}　合成影片中…", { base });
    try {
      await (motion ? exportAnimPage(s.index, path) : exportVideoPage(s.index, path));
      title.textContent = `${base}　✓ ${baseName(path)}`;
    } catch (x) { title.textContent = `${base}　✗ ${(x as Error).message ?? x}`; }
    return;
  }
  if (inApp) {
    const path = await saveDialog({ defaultPath: inDir("export", s.name), filters: [{ name: "PNG", extensions: ["png"] }] });
    if (path) { rememberDir("export", path); await invoke("save_png", { path, data: await pngBase64(s) }); }
    return;
  }
  const url = URL.createObjectURL(await toBlob(stillCanvas(s)));
  const a = document.createElement("a");
  a.href = url; a.download = s.name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$<HTMLButtonElement>("#saveCur").addEventListener("click", () => {
  if (shots[cur]) void saveOne(shots[cur]);
});

$<HTMLButtonElement>("#saveAll").addEventListener("click", async () => {
  if (inApp) {
    // 選一個資料夾、整批寫入——這才是桌面的語意，逐張跳存檔框是折磨
    const dir = await openDialog({ directory: true, defaultPath: lastDir("export") });
    if (typeof dir !== "string") return;
    rememberDirExact("export", dir);
    const title = $<HTMLSpanElement>("#sheetSub");
    const base = title.textContent ?? "";
    for (const s of shots) {
      const isMotion = current ? pageHasMotion(current, s.index) : false;
      const isVideo = current ? pageHasVideo(current, s.index) : false;
      title.textContent = (isMotion ? __f("{base}　烤動畫第 {n} 頁…", { base, n: s.index + 1 })
        : isVideo ? __f("{base}　合成影片第 {n} 頁…", { base, n: s.index + 1 })
        : __f("{base}　輸出第 {n} 頁…", { base, n: s.index + 1 }));
      if (isMotion) {
        await exportAnimPage(s.index, `${dir}/${s.name.replace(/\.png$/, ".mp4")}`);
      } else if (isVideo) {
        await exportVideoPage(s.index, `${dir}/${s.name.replace(/\.png$/, ".mp4")}`);
      } else {
        await invoke("save_png", { path: `${dir}/${s.name}`, data: await pngBase64(s) });
      }
    }
    title.textContent = __f("{base}　✓ 已存入 {dir}", { base, dir: baseName(dir) });
    return;
  }
  // 瀏覽器會對連續下載設限，逐張間隔一下
  for (const s of shots) { await saveOne(s); await new Promise((r) => setTimeout(r, 250)); }
});
let muted = false;
$<HTMLButtonElement>("#muteBtn").addEventListener("click", (e) => {
  muted = !muted;
  (e.currentTarget as HTMLButtonElement).innerHTML = muted ? SOUND_ICON.off : SOUND_ICON.on;
});

/** 一頁的**動畫**匯出：逐格烤影格（與預覽同一條渲染路）→ alignvideo 編碼 mp4。無聲。 */
async function exportAnimPage(index: number, dest: string): Promise<void> {
  if (!current) return;
  const dir = await invoke<string>("make_temp_dir");
  const fps = Number($<HTMLSelectElement>("#fps").value) || 30;
  const title = $<HTMLSpanElement>("#sheetSub");
  const base = title.textContent ?? "";
  const { count } = await buildAnimFrames(current, index, dir, { fps }, {
    saveJpg: (path, data) => invoke("save_png", { path, data }),
    videoUrl: videoUrl ?? null,
    renderOpts: renderOpts(),
    onProgress: (done, total) => {
      if (done % 15 === 0 || done === total) {
        title.textContent = __f("{base}　動畫影格 {done}/{total}…", { base, done, total });
      }
    },
  });
  const page = pageRect(current, index);
  const spec = { output: dest, pageWidth: page.w, pageHeight: page.h,
                 fps, mute: true, layers: [], frames: dir, frameCount: count };
  await invoke("save_text", { path: `${dir}/spec.json`, contents: JSON.stringify(spec) });
  await invoke("export_video", { spec: `${dir}/spec.json` });
}

/** 一頁的影片匯出：組規格→寫圖層 PNG→交給 alignvideo 合成 mp4。 */
async function exportVideoPage(index: number, dest: string): Promise<void> {
  if (!current) return;
  const dir = await invoke<string>("make_temp_dir");
  const assetDir = origin.kind === "alignproj" ? `${origin.root}/assets`
    : origin.kind === "json" ? `${origin.path.replace(/\/[^/]*$/, "")}/assets` : "";
  const spec = await buildPageSpec(current, index, dir, dest,
    { fps: Number($<HTMLSelectElement>("#fps").value) || 30, mute: muted }, {
      savePng: (path, data) => invoke("save_png", { path, data }),
      assetPath: (f) => `${assetDir}/${f}`,
      renderOpts: renderOpts(),
    });
  if (!spec) return;
  await invoke("save_text", { path: `${dir}/spec.json`, contents: JSON.stringify(spec) });
  await invoke("export_video", { spec: `${dir}/spec.json` });
}

function closeSheet(): void {
  sheet.classList.remove("on");
  clearInterval(previewTimer);
}
$<HTMLButtonElement>("#closeSheet").addEventListener("click", closeSheet);

// ── 新增／刪除元件 ────────────────────────────────────────────────────

function newId(): string { return crypto.randomUUID().toUpperCase(); }

function baseBlock(content: Block["content"], w: number, h: number,
                   at?: { x: number; y: number }): Block {
  const c = at ?? editor.centerPoint();
  const zs = current!.blocks.map((b) => b.zIndex);
  return {
    id: newId(),
    frame: { x: c.x - w / 2, y: c.y - h / 2, w, h },
    rotation: 0, zIndex: (zs.length ? Math.max(...zs) : 0) + 1,
    locked: false, opacity: 1, content,
  };
}

const IMG_EXT = ["jpg", "jpeg", "png", "webp"];
const VID_EXT = ["mp4", "mov", "m4v"];

function assetsDir(): string | null {
  if (!inApp) { meta.textContent = __("匯入素材要在 App 內用（瀏覽器只是開發預覽）"); return null; }
  if (origin.kind === "sample") { meta.textContent = __("先 ⌘S 另存專案，素材才有地方放"); return null; }
  return (origin.kind === "alignproj" ? origin.root : origin.path.replace(/\/[^/]*$/, "")) + "/assets";
}

function loadImg(url: string): Promise<HTMLImageElement> {
  return new Promise((ok, err) => {
    const img = new Image();
    // 媒體伺服器（127.0.0.1）跨源：CORS 乾淨載入，畫進 canvas 才不污染
    if (url.startsWith("http")) img.crossOrigin = "anonymous";
    img.onload = () => ok(img);
    img.onerror = () => err(new Error(__("影像載入失敗")));
    img.src = url;
  });
}

/**
 * 抓影片第一格當海報（iOS 慣例：`<影片名>.poster.jpg`），回 base64 JPEG。
 *
 * ⚠️ 播放器**必須掛進 DOM**：WKWebView 對 detached 的 `<video>` 不推進解碼，
 * `seeked` 永遠不會來（2026-08-07 修剪功能踩到，整條管線靜靜卡死；
 * 同一顆雷在影片池已經修過一次，見 videopool 的 hiddenHost）。
 * 逾時也一定要有——抓不到海報是小事，卡在「匯入中」不動是大事。
 */
function capturePoster(url: string): Promise<string> {
  return new Promise((ok, err) => {
    const v = document.createElement("video");
    v.muted = true; v.playsInline = true; v.preload = "auto";
    if (url.startsWith("http")) v.crossOrigin = "anonymous";   // toDataURL 需要乾淨的 canvas
    hiddenHost().append(v);
    const done = (fn: () => void): void => { clearTimeout(timer); v.remove(); fn(); };
    const timer = setTimeout(() => done(() => err(new Error(__("影片讀太久，抓不到海報")))), 15000);
    v.addEventListener("loadeddata", () => { v.currentTime = Math.min(0.1, (v.duration || 1) / 10); });
    v.addEventListener("seeked", () => {
      const c = document.createElement("canvas");
      c.width = v.videoWidth; c.height = v.videoHeight;
      c.getContext("2d")!.drawImage(v, 0, 0);
      const u = c.toDataURL("image/jpeg", 0.86);
      done(() => ok(u.slice(u.indexOf(",") + 1)));
    }, { once: true });
    v.addEventListener("error", () => done(() => err(new Error(__("影片解碼失敗")))));
    v.src = url;
  });
}

/** 讀影片長度（秒）。讀不到回 0＝當作沒事，不要因為量不到就擋住匯入。 */
function videoDuration(url: string): Promise<number> {
  return new Promise((ok) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.addEventListener("loadedmetadata", () => ok(isFinite(v.duration) ? v.duration : 0), { once: true });
    v.addEventListener("error", () => ok(0), { once: true });
    v.src = url;
  });
}

/** 狀態列回到常態文字。提示訊息消失後用。
 *  專案摘要（頁數/尺寸/block/build）是開發儀表，預設不顯示——資訊鈕開了才給；
 *  存檔／匯入那類**狀態訊息**不受開關影響，照常直接寫 meta。 */
function refreshMeta(): void {
  if (!current) return;
  if (!showInfo) { meta.textContent = ""; return; }
  const want = assetNames(current).size;
  meta.textContent = __f("{n} 頁 · {w}×{h} · {blocks} 個 block", { n: current.pageCount, w: current.canvasWidth, h: current.pageHeight, blocks: current.blocks.length })
    + (want ? __f("（素材 {have}/{want}）", { have: assets.variants.size, want }) : "")
    + `　build ${__BUILD_STAMP__}`;
}

/**
 * 從磁碟路徑匯入一個媒體檔：複製進專案 assets/、載進素材表、回新 block。
 * 「照片」按鈕與**拖放**共用這條——拖圖片／影片進畫布是 Mac 的直覺（Keynote 同款）。
 * 影片會在匯入時抓第一格存成海報，畫布與匯出畫的都是它（與 iOS 相同慣例）。
 */
async function importMediaFromPath(src: string, at?: { x: number; y: number }): Promise<Block | null> {
  const ext = src.split(".").pop()?.toLowerCase() ?? "";
  const isImg = IMG_EXT.includes(ext), isVid = VID_EXT.includes(ext);
  if (!isImg && !isVid) return null;   // 拖進來的其他檔案靜默略過
  const dir = assetsDir();
  if (!dir || !current) return null;
  const name = await invoke<string>("copy_asset", { src, destDir: dir });

  let img: HTMLImageElement;
  let assetKey: string;
  if (isImg) {
    assetKey = name;
    img = await loadImg(await localUrl(`${dir}/${name}`));
  } else {
    // 新專案的第一支影片：show() 當時沒有 assets/，videoUrl 還沒接——
    // 現在資料夾有了就把影片池接上，否則畫布只剩靜止海報直到重開
    if (!videoUrl) {
      const base = await mediaBaseOnce();
      videoUrl = (f) => `${base}/${encodeURIComponent(`${dir}/${f}`)}`;
      videos.attach(videoUrl);
      editor.setVideos(videos.frames);
    }
    // 長片軟提醒：Mac 不像 iPad 強制匯入就剪，但超過 30 秒回 iPad 會吃力，說一聲
    // （格式完全相容——30 秒只是 iPad 匯入 UI 的政策，見 trim.ts 檔頭）
    const secs = await videoDuration(videoUrl ? videoUrl(name) : await localUrl(`${dir}/${name}`));
    if (secs > 30) {
      meta.textContent = __f("這支 {secs} 秒——右鍵可以修剪（回 iPad 匯出會比較慢）", { secs: secs.toFixed(0) });
      setTimeout(() => { if (meta.textContent?.startsWith(__("這支"))) refreshMeta(); }, 5000);
    }
    const poster = await capturePoster(await localUrl(`${dir}/${name}`));
    await invoke("save_png", { path: `${dir}/${name}.poster.jpg`, data: poster });
    assetKey = `${name}.poster.jpg`;
    img = await loadImg(await localUrl(`${dir}/${assetKey}`));
  }
  assets.raw.set(assetKey, img);
  assets.variants.set(assetKey, img);
  const w = current.canvasWidth * 0.4;
  return baseBlock(
    { type: isImg ? "image" : "video", media: { assetFileName: name, cropRect: { x: 0, y: 0, w: 1, h: 1 } } },
    w, w * (img.naturalHeight / img.naturalWidth), at,
  );
}

/**
 * 修剪一個影片 block：開視窗選範圍 → alignvideo 切出新檔 → 換掉 block 的素材。
 *
 * **切出來的是新檔案，原檔留著**——iOS 的修剪也是「把選到的那段真的存進專案」，
 * 專案檔沒有修剪欄位。原檔不刪：使用者可能想重剪，而 assets/ 的清理是另一件事。
 */
async function trimBlock(b: Block): Promise<void> {
  if (b.content.type !== "video" || !current) return;
  const dir = assetsDir();
  const file = b.content.media.assetFileName;
  if (!dir || !file) return;
  const src = `${dir}/${file}`;
  const r = await openTrim(videoUrl ? videoUrl(file) : await localUrl(src), file);
  if (!r) return;
  meta.textContent = __("修剪中…");
  try {
    const out = `${dir}/trim-${Date.now()}.mov`;
    await invoke("trim_video", { src, dest: out, start: r.start, end: r.end });
    const name = baseName(out);
    // 海報要重抓——修剪後的第一格通常不是原本那一格
    const poster = await capturePoster(await localUrl(out));
    await invoke("save_png", { path: `${out}.poster.jpg`, data: poster });
    const key = `${name}.poster.jpg`;
    const img = await loadImg(await localUrl(`${dir}/${key}`));
    assets.raw.set(key, img);
    assets.variants.set(key, img);
    b.content.media.assetFileName = name;
    await ensureVariantFor(b);   // 有濾鏡的話，新海報也要生一份套好濾鏡的變體
    videos.attach(videoUrl ?? null);   // 讓影片池重新接上新檔
    editor.refresh(); scheduleThumbs();
    inspector.show(current, editor.getSelected());
    commit("trim");
    meta.textContent = __f("已修剪：{secs} 秒", { secs: (r.end - r.start).toFixed(1) });
  } catch (e) {
    meta.textContent = __f("修剪失敗：{msg}", { msg: (e as Error).message ?? e });
    return;
  }
  setTimeout(() => { if (meta.textContent?.startsWith(__("已修剪"))) refreshMeta(); }, 2600);
}

/** 加 3D 物件：選 .glb → 複製進 assets/ → 新 block。專案裡它永遠是活的物件，
 *  展示方式（慢轉圈／快轉煞停）與速率在右欄調；匯出時才逐格烤進影格。
 *  只收 .glb——.gltf 會外掛散檔（.bin／貼圖），copy_asset 只搬一個檔案會搬斷。 */
async function addModel(): Promise<Block | null> {
  const dir = assetsDir();
  if (!dir || !current) return null;
  const src = await openDialog({
    multiple: false,
    defaultPath: lastDir("media"),
    filters: [{ name: __("3D 物件（GLB）"), extensions: ["glb"] }],
  });
  if (typeof src !== "string") return null;
  rememberDir("media", src);
  const name = await invoke<string>("copy_asset", { src, destDir: dir });
  // 3D 靠媒體伺服器載檔——新專案的第一個媒體是 3D 的話，這裡把 URL 接上
  if (!videoUrl) {
    const base = await mediaBaseOnce();
    videoUrl = (f) => `${base}/${encodeURIComponent(`${dir}/${f}`)}`;
    videos.attach(videoUrl);
    editor.setVideos(videos.frames);
  }
  models.attach(videoUrl);
  editor.setModels(models);
  const w = current.canvasWidth * 0.45;
  return baseBlock({ type: "model", model: { assetFileName: name } }, w, w);
}

async function addPhoto(): Promise<Block | null> {
  const dir = assetsDir();
  if (!dir) return null;
  const src = await openDialog({
    multiple: false,
    defaultPath: lastDir("media"),
    filters: [{ name: __("影像或影片"), extensions: [...IMG_EXT, ...VID_EXT] }],
  });
  if (typeof src !== "string") return null;
  rememberDir("media", src);
  return importMediaFromPath(src);
}

// —— 拖放匯入（App 內限定；瀏覽器沒有檔案路徑可用）——
if (inApp) {
  getCurrentWebview().onDragDropEvent(async (ev) => {
    if (ev.payload.type !== "drop" || !current) return;
      if (sheet.classList.contains("on")) return;   // 匯出台是快照（shots/videoPageSet），拖放進來會靜默過期
    const dpr = window.devicePixelRatio || 1;
    const at = editor.projectPoint(ev.payload.position.x / dpr, ev.payload.position.y / dpr);
    let added: Block | null = null;
    for (const p of ev.payload.paths) {
      try {
        const b = await importMediaFromPath(p, { ...at });
        if (b) {
          current.blocks.push(b);
          added = b;
          at.x += 48; at.y += 48;   // 一次拖多張時錯開，別完全疊死
        }
      } catch (x) {
        meta.textContent = __f("匯入失敗：{msg}", { msg: (x as Error).message ?? x });
      }
    }
    if (added) {
      editor.refresh();
      editor.select(added.id);
      scheduleThumbs();
      commit("add");
    }
  });
}

async function addBlock(kind: string): Promise<void> {
  if (!current || !kind) return;
  const cw = current.canvasWidth;
  let b: Block | null = null;
  switch (kind) {
    case "text":
      // 預留字與 iOS 同款；黑字放白頁看得見，深色頁自己改——與 iOS 同預設
      b = baseBlock({ type: "text", text: { text: __("雙擊編輯文字"), alignment: "center",
        fontSize: Math.round(cw * 0.045), colorHex: "000000", fontWeightValue: 3 } }, 10, 10);
      break;
    case "rectangle": case "ellipse":
      b = baseBlock({ type: "shape", shape: { kind, colorHex: "3A3A3A" } }, cw * 0.3, cw * 0.3);
      break;
    case "line":
      b = baseBlock({ type: "shape", shape: { kind: "line", colorHex: "3A3A3A", lineWidth: 8 } }, cw * 0.4, 40);
      break;
    case "photo":
      b = await addPhoto();
      break;
    case "model":
      b = await addModel();
      break;
  }
  if (!b) return;
  current.blocks.push(b);
  autoFitText(measureCtx, current);   // 文字的貼字盒在這裡定型
  editor.refresh();
  editor.select(b.id);
  scheduleThumbs();
  commit("add");
}

// 五顆看得見的按鈕，不收進下拉——ALIGNCAM 5.6 的教訓：
// 工具藏在箭頭後面，對第一次打開的人等於不存在。
$<HTMLSpanElement>("#addbar").addEventListener("click", (e) => {
  // 點擊常落在 svg/path 上，要往上找到帶 data-kind 的按鈕
  const kind = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-kind]")?.dataset.kind;
  if (kind) addBlock(kind).catch((x) => { meta.textContent = __f("新增失敗：{msg}", { msg: x.message ?? x }); });
});

$<HTMLButtonElement>("#save").addEventListener("click", () => {
  saveProject().catch((x) => { meta.textContent = __f("存檔失敗：{msg}", { msg: x.message ?? x }); });
});
$<HTMLButtonElement>("#undoBtn").addEventListener("click", () => undo());
$<HTMLButtonElement>("#redoBtn").addEventListener("click", () => redo());
$<HTMLButtonElement>("#zoomfit").addEventListener("click", () => editor.fitAll());
editor.onZoom = (z) => {
  $<HTMLButtonElement>("#zoomfit").textContent = `${Math.round(z * 100)}%`;
  tourNotify("zoom");   // 導覽第 2 步「縮放一下試試」的訊號
};
// 平移到別頁時，圖層清單跟著換頁（不換的話會一直停在剛開面板的那一頁）
editor.onPageInView = () => {
  if (inspector.activePanel === "layers") inspector.show(current, editor.getSelected());
};

/** 對目前選取的整組套一個純函式，然後重畫＋記一步 undo。 */
function applyToGroup(fn: (blocks: Block[]) => void, tag: string): void {
  const blocks = editor.selectionBlocks();
  if (!current || blocks.length < 2) return;
  fn(blocks);
  editor.refresh();
  inspector.showGroup(current, blocks);
  scheduleThumbs();
  commit(tag);
}

/** 複製選取的元件（整組偏移 48，與拖放匯入的錯開量一致）。 */
function duplicateSelection(): void {
  const blocks = editor.selectionBlocks();
  if (!current || !blocks.length) return;
  const zs = current.blocks.map((k) => k.zIndex);
  let top = Math.max(...zs);
  const copies = blocks.map((b) => ({
    ...structuredClone(b), id: newId(), zIndex: ++top,
    frame: { ...b.frame, x: b.frame.x + 48, y: b.frame.y + 48 },
  }));
  current.blocks.push(...copies);
  editor.refresh();
  editor.selectMany(copies.map((c) => c.id));
  scheduleThumbs();
  commit("duplicate");
}

function deleteSelected(): void {
  const blocks = editor.selectionBlocks().filter((b) => !b.locked);
  if (!current || !blocks.length) return;
  const ids = new Set(blocks.map((b) => b.id));
  current.blocks = current.blocks.filter((k) => !ids.has(k.id));
  editor.select(null);
  editor.refresh();
  scheduleThumbs();
  commit("delete");
}

// ── 跨專案剪貼簿（2026-08-14）：⌘C／⌘V，素材連檔案一起過去 ──────────────
// 存 localStorage＝換專案、重開 App 都還在。純邏輯在 core/clipboard.ts，
// 這裡只做檔案搬運（copy_asset 重取檔名防碰撞）與素材表載入。
const CLIP_KEY = "align.blockClipboard";

/** 來源專案 assets/ 的絕對路徑——拷貝用，拿不到就安靜略過（純文字照樣可拷）。 */
function assetsRootSilent(): string | null {
  if (!inApp || origin.kind === "sample") return null;
  return (origin.kind === "alignproj" ? origin.root : origin.path.replace(/\/[^/]*$/, "")) + "/assets";
}

function copySelection(): void {
  const blocks = editor.selectionBlocks();
  if (!current || !blocks.length) return;
  localStorage.setItem(CLIP_KEY, JSON.stringify(buildClipboard(current, blocks, assetsRootSilent())));
  meta.textContent = __f("已拷貝 {n} 個元件——⌘V 貼上，開另一份專案貼也行", { n: blocks.length });
}

async function pasteClipboard(): Promise<void> {
  if (!current) return;
  let clip: BlockClipboard | null = null;
  try { clip = JSON.parse(localStorage.getItem(CLIP_KEY) ?? "null") as BlockClipboard | null; } catch { /* 壞值當空 */ }
  if (!clip?.blocks?.length) return;

  // 有媒體才需要 assets/（純文字連存檔位置都不用有）；拿不到時 assetsDir 已把原因寫在 meta
  const needsAssets = clip.blocks.some((b) =>
    (b.content.type === "image" || b.content.type === "video") && b.content.media.assetFileName);
  const dir = needsAssets ? assetsDir() : null;
  if (needsAssets && !dir) return;

  // 同一個來源只搬一次；影片海報跟著搬成 <新名>.poster.jpg（畫布與匯出畫的是它）
  const renamed = new Map<string, string>();
  let missing = 0;
  if (dir) {
    for (const b of clip.blocks) {
      if (b.content.type !== "image" && b.content.type !== "video") continue;
      const name = b.content.media.assetFileName;
      if (!name || renamed.has(name)) continue;
      try {
        const src = clip.assetSrc[name];
        if (!src) throw new Error("no-src");
        const newName = await invoke<string>("copy_asset", { src, destDir: dir });
        if (b.content.type === "video") {
          const ps = clip.assetSrc[`${name}.poster.jpg`];
          if (ps) await invoke("copy_asset_as", { src: ps, destDir: dir, name: `${newName}.poster.jpg` });
        }
        renamed.set(name, newName);
      } catch { missing++; }   // 來源檔搬不動＝畫佔位框，不擋整次貼上
    }
  }

  const copies = pasteBlocks(clip, current, pageIndexForX(current, editor.centerPoint().x), renamed, newId);
  current.blocks.push(...copies);

  if (dir) {
    // 新專案的第一支影片可能還沒接影片池（與 importMediaFromPath 同一個補接）
    if (!videoUrl && copies.some((b) => b.content.type === "video")) {
      const base = await mediaBaseOnce();
      videoUrl = (f) => `${base}/${encodeURIComponent(`${dir}/${f}`)}`;
      videos.attach(videoUrl);
      editor.setVideos(videos.frames);
    }
    // 搬進來的素材載進素材表（影片載海報）＋補濾鏡變體
    const isVid = new Set(copies.filter((b) => b.content.type === "video")
                                .map((b) => b.content.type === "video" ? b.content.media.assetFileName : ""));
    for (const newName of renamed.values()) {
      const assetKey = isVid.has(newName) ? `${newName}.poster.jpg` : newName;
      if (assets.raw.has(assetKey)) continue;
      try {
        const img = await loadImg(await localUrl(`${dir}/${assetKey}`));
        assets.raw.set(assetKey, img);
        assets.variants.set(assetKey, img);
      } catch { /* 載不進來＝佔位框 */ }
    }
    for (const nb of copies) {
      if ((nb.content.type === "image" || nb.content.type === "video") && nb.content.media.filterKey) {
        await ensureVariantFor(nb).catch(() => { /* 變體生失敗照樣有原圖 */ });
      }
    }
  }

  editor.refresh();
  editor.selectMany(copies.map((c) => c.id));
  scheduleThumbs();
  commit("paste");
  meta.textContent = missing
    ? __f("貼上了 {n} 個，{m} 個素材的來源檔找不到（顯示成佔位框）", { n: copies.length, m: missing })
    : __f("貼上了 {n} 個元件", { n: copies.length });
}

// ── 存檔 ──────────────────────────────────────────────────────────────
async function saveProject(): Promise<void> {
  if (!current) return;
  // 存檔 marker 對齊「寫進檔案的內容」——await 期間 committed 可能已前進，
  // 用當下的 committed 當 marker 會把沒寫進去的變更誤標成已存
  const wrote = snapshot();
  const json = JSON.stringify(encodeProject(current), null, 2);
  if (!inApp) {
    // 瀏覽器：下載 project.json（開發便利，不是產品路徑）
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url; a.download = "project.json"; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    savedState = wrote; updateDirty();
    return;
  }
  if (origin.kind === "json") {
    await invoke("save_text", { path: origin.path, contents: json });
  } else if (origin.kind === "alignproj") {
    // 寫回解包資料夾再重新打包成 .alignproj（首次覆寫會自動留 .bak）
    await invoke("save_text", { path: `${origin.root}/project.json`, contents: json });
    await invoke("pack_alignproj", { dir: origin.root, dest: origin.path });
  } else {
    // 範本／瀏覽器來源：另存新檔（專案檔跟「開專案」記同一個位置）
    const path = await saveDialog({ defaultPath: inDir("open", `${current.name}.json`), filters: [{ name: __("ALIGN 專案"), extensions: ["json"] }] });
    if (typeof path !== "string") return;
    rememberDir("open", path);
    await invoke("save_text", { path, contents: json });
    origin = { kind: "json", path };
    localStorage.removeItem(DRAFT_KEY);   // 落地了——草稿功成身退
  }
  savedState = wrote; updateDirty();
  rememberRecent();   // 存檔＝這份專案值得進「最近專案」（另存後 origin 已更新）
  meta.textContent = __f("已儲存　{time}", { time: new Date().toLocaleTimeString() });
}

// ── 齒輪：說明・回報・版本（快速回報 bug 的入口，2026-08-13）──────────
// 選單機直接借右鍵選單那套（buildMenu/openMenu），不另造輪子。
const REPO = "https://github.com/qwert2813434-ctrl/ALIGNED";
let appVersion = "";   // 開機抓一次（getVersion 是 async，選單組字串要同步拿）

function reportBugMail(): void {
  const subject = __f("ALIGNED Mac {version} 問題回報", { version: appVersion });
  const body = __("發生了什麼事：\n\n\n怎麼重現（做了哪幾步）：\n1. \n\n———\n")
    + __f("版本 {version}（build {build}）", { version: appVersion, build: __BUILD_STAMP__ });
  void invoke("open_url", { url: `mailto:alignediosapp@gmail.com`
    + `?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}` });
}

/** 導覽步驟表：說什麼／藍框框誰／怎麼算做到。目標挑「看得到、狀態還沒開」的，
 *  用 id 記（undo 會換掉整個 blocks 陣列，抓參照會斷）。
 *  排開那兩步是招牌：先把一段與圖重疊的文字開成長文框，再到圖上開排開，字當場繞著圖流。 */
function buildTour(): TourStep[] {
  const byId = (id?: string) => (id && current?.blocks.find((b) => b.id === id)) || null;
  const rectOf = (b: Block | null): TourRect | null => (b ? editor.screenRect(b) : null);
  const domRect = (sel: string): TourRect | null => {
    const r = document.querySelector(sel)?.getBoundingClientRect();
    return r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null;
  };
  /** 檢視器裡某一列開關的位置（選對元件後藍框跳到開關上） */
  const rowRect = (label: string): TourRect | null => {
    for (const l of document.querySelectorAll<HTMLLabelElement>("#inspector .row label")) {
      if (l.textContent === label) {
        const r = l.closest(".row")!.getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height };
      }
    }
    return null;
  };
  const overlap = (a: Block, b: Block) =>
    a.frame.x < b.frame.x + b.frame.w && a.frame.x + a.frame.w > b.frame.x &&
    a.frame.y < b.frame.y + b.frame.h && a.frame.y + a.frame.h > b.frame.y;
  const textOf = (b: Block | null) => (b?.content.type === "text" ? b.content.text : null);
  const wrapOn = (b: Block | null): boolean =>
    b?.content.type === "shape" ? b.content.shape.excludesText === true
    : b?.content.type === "image" || b?.content.type === "video" ? b.content.media.excludesText === true
    : false;
  /** 「畫布上的元件 → 選起來之後改框檢視器那顆開關」的雙態目標 */
  const blockThenRow = (id: string | undefined, label: string) => (): TourRect | null => {
    const b = byId(id);
    if (!b) return null;
    return editor.getSelected()?.id === id ? (rowRect(label) ?? rectOf(b)) : rectOf(b);
  };

  const blocks = current?.blocks ?? [];
  const texts = blocks.filter((b) => b.content.type === "text");
  const medias = blocks.filter((b) => ["image", "shape", "video"].includes(b.content.type));
  const inView = (b: Block) => { const v = editor.visibleRect(); return overlap(b, { frame: v } as Block); };
  const dragB = medias.find(inView) ?? medias[0];
  const textB = texts.find(inView) ?? texts[0];
  // 排開主角：挑「最長的文字 × 跟它疊最大的媒材」——長文才看得出繞流，小標籤教不了人。
  const cut = (a: Block, b: Block) =>
    Math.max(0, Math.min(a.frame.x + a.frame.w, b.frame.x + b.frame.w) - Math.max(a.frame.x, b.frame.x)) *
    Math.max(0, Math.min(a.frame.y + a.frame.h, b.frame.y + b.frame.h) - Math.max(a.frame.y, b.frame.y));
  let wrapT: Block | undefined, wrapM: Block | undefined;
  for (const t of texts) {
    const m = medias.filter((k) => cut(t, k) > 0).sort((a, b) => cut(t, b) - cut(t, a))[0];
    if (m && (textOf(t)?.text.length ?? 0) > (textOf(wrapT ?? null)?.text.length ?? -1)) { wrapT = t; wrapM = m; }
  }
  // 說明輪播的排開示範頁兩個開關本來就是開的——關回去，讓人親手開一次、看字當場重新流動。
  // 不走 commit：這是導覽佈景，不進 undo、不髒存檔旗標
  if (wrapT && wrapM && textOf(wrapT)?.isBodyFrame && wrapOn(wrapM)) {
    textOf(wrapT)!.isBodyFrame = false;
    if (wrapM.content.type === "shape") wrapM.content.shape.excludesText = false;
    else if (wrapM.content.type === "image" || wrapM.content.type === "video") wrapM.content.media.excludesText = false;
    editor.refresh(); scheduleThumbs();
  }

  return [
    { say: __("歡迎。照著藍框走——每一步做到了會自動前進，這幾頁隨你玩壞。") },
    { say: __("先動視角：在畫布上雙指捲動（或 ⌘＋滾輪）縮放一下；按住空白處拖曳＝平移。"),
      target: () => domRect("#canvas"), done: (t) => t === "zoom" },
    { say: __("搬東西：把藍框這個元件拖去別的位置——靠近別的元件會跳出吸附線，貼齊了有磁力。"),
      target: () => rectOf(byId(dragB?.id)), done: (t) => t === "drag" },
    { say: __("改字：雙擊藍框這段文字，改幾個字，點外面完成。"),
      target: () => rectOf(byId(textB?.id)), done: (t) => t === "textedit" },
    { say: __("加東西：從上排這排工具加一個新元件——按 T 加文字，或按矩形。"),
      target: () => domRect("#addbar"), done: (t) => t === "add" },
    { say: __("招牌來了。點選藍框這段文字，到右側把「長文框」打開——固定容器，這是排開的前提。"),
      target: blockThenRow(wrapT?.id, __("長文框")),
      done: () => textOf(byId(wrapT?.id))?.isBodyFrame === true },
    { say: __("再選旁邊被框住的圖，打開「排開文字」——長文會當場繞著它重新流動。開完拖拖看那張圖。"),
      target: blockThenRow(wrapM?.id, __("排開文字")),
      done: () => wrapOn(byId(wrapM?.id)) },
    { say: __("就這樣。⌘S 存檔、⌘Z 反悔；之後隨時從右上齒輪回到這份導覽。"),
      target: () => domRect("#gearBtn") },
  ];
}

$<HTMLButtonElement>("#gearBtn").addEventListener("click", (e) => {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  openMenu([
    { label: __("操作導覽（帶著做一次）"), run: () => {
      openSample("/samples/intro").then(() => startTour(buildTour())).catch(() => { /* 開不到樣本就不開導覽 */ });
    } },
    { label: __("線上說明"), run: () => { void invoke("open_url", { url: `${REPO}#readme` }); } },
    "-",
    { label: __("回報問題（Email）"), run: reportBugMail },
    { label: __("回報問題（GitHub Issues）"), run: () => { void invoke("open_url", { url: `${REPO}/issues/new` }); } },
    "-",
    { label: __("檢查更新"), key: `v${appVersion}`, run: () => {
      void checkUpdate(true).then((got) => {
        if (got === "latest") meta.textContent = __f("已是最新版（{version}）", { version: appVersion });
        if (got === "error") meta.textContent = __("連不上更新來源——檢查網路後再試");
      });
    } },
  ], { x: r.right - 210, y: r.bottom + 8 });
});

// 工具列的兩顆面板開關。面板釘在側欄上方，屬性照樣在下面——不用互相讓位。
function syncPanelButtons(): void {
  const a = inspector.activePanel;
  $<HTMLButtonElement>("#guidesBtn").classList.toggle("on", a === "guides");
  $<HTMLButtonElement>("#layersBtn").classList.toggle("on", a === "layers");
}
$<HTMLButtonElement>("#guidesBtn").addEventListener("click", () => {
  inspector.setPanel("guides"); syncPanelButtons();
});
$<HTMLButtonElement>("#layersBtn").addEventListener("click", () => {
  inspector.setPanel("layers"); syncPanelButtons();
});

// 專案資訊開關：上排的頁數/尺寸/build 與選取座標平常收起來，介面只留必要的
let showInfo = localStorage.getItem("align.showinfo") === "1";
function syncInfoBtn(): void {
  $<HTMLButtonElement>("#infoBtn").classList.toggle("on", showInfo);
  info.style.display = showInfo ? "" : "none";
}
$<HTMLButtonElement>("#infoBtn").addEventListener("click", () => {
  showInfo = !showInfo;
  localStorage.setItem("align.showinfo", showInfo ? "1" : "0");
  syncInfoBtn();
  refreshMeta();
});
syncInfoBtn();
// 在畫布上按到參考線＝側欄切到參考線面板，並標出手上是哪一條
editor.onGuidePicked = (axis, index) => { inspector.focusGuide(axis, index); syncPanelButtons(); };

// 桌面快捷鍵：⌘O 開啟、⌘S 存檔、⌘E 匯出、⌘Z 復原；方向鍵微移選取的元件（⇧＝10）
window.addEventListener("keydown", (e) => {
  if (sheet.classList.contains("on")) return;   // 匯出台開著就整組讓給它（⌘0／⌘± 意思不同）
  // 首頁開著：Esc＝先逛範本，⌘N／⌘O 照常，其餘快捷鍵不往編輯器漏
  if (home.classList.contains("on")) {
    if (e.key === "Escape") { closeHome(); return; }
    const k = e.metaKey || e.ctrlKey ? e.key : "";
    if (k !== "n" && k !== "o") return;
  }
  if (e.metaKey || e.ctrlKey) {
    if (e.key === "n") { e.preventDefault(); openNewSheet(); }
    if (e.key === "o") { e.preventDefault(); $<HTMLButtonElement>("#open").click(); }
    if (e.key === "e") { e.preventDefault(); $<HTMLButtonElement>("#export").click(); }
    if (e.key === "s") { e.preventDefault(); saveProject().catch((x) => { meta.textContent = __f("存檔失敗：{msg}", { msg: x.message ?? x }); }); }
    if (e.key === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    if (e.key === "d") { e.preventDefault(); duplicateSelection(); }
    if (e.key === "c" || e.key === "v") {
      // 正在輸入框裡＝讓給系統的文字複製貼上，只有畫布上的 ⌘C／⌘V 歸我們
      const ae = document.activeElement as HTMLElement | null;
      const typing = !!ae && (["INPUT", "TEXTAREA", "SELECT"].includes(ae.tagName) || ae.isContentEditable);
      if (!typing) {
        e.preventDefault();
        if (e.key === "c") copySelection();
        else pasteClipboard().catch((x) => { meta.textContent = __f("貼上失敗：{msg}", { msg: x.message ?? x }); });
      }
    }
    if (e.key === "l") {
      e.preventDefault();
      const sel = editor.selectionBlocks();
      if (sel.length) {
        const to = !sel[0].locked;
        for (const k of sel) k.locked = to;
        inspector.show(current, editor.getSelected());
        editor.refresh(); commit("lock");
      }
    }
    if (e.key === "0") { e.preventDefault(); editor.fitAll(); }
    if (e.key === "=" || e.key === "+") { e.preventDefault(); editor.setZoom(Math.min(editor.zoom * 1.25, 4)); }
    if (e.key === "-") { e.preventDefault(); editor.setZoom(Math.max(editor.zoom / 1.25, 0.02)); }
    // ⌘A＝選畫面正中那一頁的全部（跨頁全選在多頁專案裡幾乎都是誤觸）
    if (e.key === "a" && current) {
      e.preventDefault();
      const page = pageIndexForX(current, editor.centerPoint().x);
      editor.selectMany(current.blocks
        .filter((b) => !b.locked && pageIndexForX(current!, b.frame.x + b.frame.w / 2) === page)
        .map((b) => b.id));
    }
    return;
  }
  const ae = document.activeElement as HTMLElement | null;
  if (ae && (["INPUT", "TEXTAREA", "SELECT"].includes(ae.tagName) || ae.isContentEditable)) return;   // 正在輸入就別攔
  if (e.key === "Backspace" || e.key === "Delete") { e.preventDefault(); deleteSelected(); return; }
  const sel = editor.selectionBlocks().filter((b) => !b.locked);
  if (!sel.length) return;
  const step = e.shiftKey ? 10 : 1;
  const d: Record<string, [number, number]> = {
    ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step],
  };
  const move = d[e.key];
  if (!move) return;
  e.preventDefault();
  for (const b of sel) { b.frame.x += move[0]; b.frame.y += move[1]; }
  editor.refresh();
  if (sel.length === 1) inspector.show(current, sel[0]); else if (current) inspector.showGroup(current, sel);
  scheduleThumbs();
  commit("nudge");
});

// ?probe=zoom＝縮放效能探針：開檔安定後做 2.5 秒正弦縮放掃描，
// 回報重畫次數／平均重畫毫秒（EMA 峰值）／主執行緒最大卡頓。真環境量，不猜。
function zoomProbe(): void {
  const post = (o: Record<string, unknown>): void => {
    try { navigator.sendBeacon("http://localhost:5199/", JSON.stringify(o)); } catch { /* 收端沒開就算了 */ }
  };
  setTimeout(() => {
    const f0 = { paints: editor.frameStats.paints };
    const t0 = performance.now();
    let maxLag = 0, maxMs = 0;
    let expect = performance.now() + 50;
    const lagT = setInterval(() => {
      const now = performance.now();
      maxLag = Math.max(maxLag, now - expect);
      maxMs = Math.max(maxMs, editor.frameStats.ms);
      expect = now + 50;
    }, 50);
    const z0 = editor.zoom;
    const sweep = setInterval(() => {
      const t = (performance.now() - t0) / 2500;
      if (t >= 1) {
        clearInterval(sweep); clearInterval(lagT);
        editor.setZoom(z0);
        post({ probe: "zoom",
               paints: editor.frameStats.paints - f0.paints,
               paintAvgMs: Math.round(editor.frameStats.ms * 10) / 10,
               paintMaxEmaMs: Math.round(maxMs * 10) / 10,
               mainThreadMaxLagMs: Math.round(maxLag),
               pool: { ...videos.stats } });
      } else {
        editor.setZoom(z0 * (1 + 0.8 * Math.sin(t * Math.PI * 4)));
      }
    }, 16);
  }, 3000);
}

// ── 啟動 ──────────────────────────────────────────────────────────────
(async () => {
  // 字型必須先載完再畫——canvas 對還沒載入的字型會靜默回落系統字型，不報錯只是全錯。
  [, filterAssets] = await Promise.all([loadFonts(), loadFilterAssets()]);
  editor.setFilters(filterAssets);   // 沒餵的話畫布不會套整頁紙張（匯出卻會），所見即所不得

  const sample = $<HTMLSelectElement>("#sample");
  if (inApp) {
    appVersion = await getVersion().catch(() => "");   // 齒輪選單與回報信要用
    // 真實專案樣本含個人照片，不隨 App 打包（beforeBuildCommand 會剝掉）——
    // App 開場給範本，自己的專案走首頁／⌘O
    sample.querySelector('option[value="/samples/real"]')?.remove();
    sample.value = "/samples/intro";   // 開場墊底＝8 頁說明輪播（小高手調版，全功能自我示範）
    // 樣本切換器是開發用的；App 內首頁已提供範例入口，上排收掉這一組
    sample.style.display = "none";
    $<HTMLSpanElement>("#sampleGlyph").style.display = "none";
    // 字型目錄：系統字體（已裝在系統裡，登記即可用）＋匯入過的字型檔（要等載完）
    try {
      const [sys, user] = await Promise.all([
        invoke<DynamicFont[]>("list_system_fonts"),
        invoke<DynamicFont[]>("list_user_fonts"),
      ]);
      registerSystemFonts(sys);
      await Promise.all(user.map(async (f) => (f.path ? registerUserFont(f, await localUrl(f.path)) : false)));
    } catch { /* 字型枚舉失敗不擋開機——選單就只剩內建 */ }
  }
  // ?sample=… ＝載入指定樣本（驗證用；_probe 是帶真影片的探針專案）
  const q = new URLSearchParams(location.search);
  // ?diag=1 且 dev 模式＝黑盒子：每秒把主執行緒堵塞度與各儀表 POST 到本機 5199。
  // 用途：WebContent 被系統砍掉的循環，死前最後一秒的狀態螢幕上讀不到，這裡有。
  // 死法判讀：最後一筆是 pagehide/beforeunload＝JS 自己重載；無聲斷訊＝行程被外力砍。
  if (q.has("diag") && location.port === "5173") {
    const post = (o: Record<string, unknown>): void => {
      try {
        navigator.sendBeacon("http://localhost:5199/",
          JSON.stringify({ t: Math.round(performance.now()), ...o }));
      } catch { /* 收端沒開就算了 */ }
    };
    // 主執行緒堵塞度：100ms 節拍的實際誤差。誤差 50ms＝有 50ms 的長任務在佔道
    let expect = performance.now() + 100, maxLag = 0;
    setInterval(() => {
      const now = performance.now();
      maxLag = Math.max(maxLag, now - expect - 100 + 100);
      if (now - expect > maxLag) maxLag = now - expect;
      expect = now + 100;
    }, 100);
    post({ ev: "boot", url: location.href });
    addEventListener("error", (e) => post({ ev: "error", msg: String(e.message) }));
    addEventListener("unhandledrejection",
      (e) => post({ ev: "reject", msg: String((e as PromiseRejectionEvent).reason).slice(0, 200) }));
    addEventListener("pagehide", () => post({ ev: "pagehide" }));
    addEventListener("beforeunload", () => post({ ev: "beforeunload" }));
    setInterval(() => {
      const f = editor.frameStats;
      const vr = editor.visibleRect();
      post({
        ev: "tick", lag: Math.round(maxLag), pool: { ...videos.stats },
        paints: f.paints, ms: Math.round(f.ms * 10) / 10, raf: f.raf,
        vis: document.visibilityState, view: `${Math.round(vr.w)}x${Math.round(vr.h)}`,
      });
      maxLag = 0;
    }, 1000);
  }
  await openSample(q.get("sample") || sample.value);
  // 開場首頁：App 的正常入口。驗證旗標（?open/?export/?new/?sample/?diag）都跳過，
  // 免得截圖與診斷流程被首頁蓋住
  if ((inApp && !q.has("open") && !q.has("export") && !q.has("new") && !q.has("sample") && !q.has("diag"))
      || q.has("home")) {   // ?home=1＝瀏覽器也開首頁（版面驗證用）
    showHome();
  }
  if (inApp) void checkUpdate();   // 出新版時浮橫幅（離線安靜跳過）
  // 未落地就關掉的草稿：問一聲要不要接續。接續＝草稿留著（看一眼就關也不會丟）；
  // 捨棄或壞檔才清。落地（⌘S 另存成功）時 saveProject 會清。
  const draftRaw = inApp ? localStorage.getItem(DRAFT_KEY) : null;
  if (draftRaw && !q.has("open") && !q.has("export") && !q.has("new") && !q.has("diag")) {
    try {
      const d = JSON.parse(draftRaw) as { json: unknown; name?: string; when?: number };
      const when = d.when ? new Date(d.when).toLocaleString("zh-TW") : "";
      if (await ask(__f("「{name}」上次關掉時還沒存檔（{when}）。要接續編輯嗎？", { name: d.name ?? __("未命名專案"), when }),
          { title: __("未儲存的草稿"), okLabel: __("接續編輯"), cancelLabel: __("捨棄") })) {
        show(decodeProject(d.json));
        origin = { kind: "sample" };   // 還是未落地——⌘S 走「另存」
      } else {
        localStorage.removeItem(DRAFT_KEY);
      }
    } catch { localStorage.removeItem(DRAFT_KEY); }
  }
  // ?export=1／?new=1 ＝載入後直接開該面板（截圖驗證用，不牽動 App 的正常路徑）
  if (q.has("export")) {
    $<HTMLButtonElement>("#export").click();
    const m = q.get("export");
    if (m === "joined" || m === "cards" || m === "single") {
      $<HTMLSpanElement>("#modes").querySelector<HTMLButtonElement>(`[data-mode="${m}"]`)?.click();
    }
  }
  if (q.has("new")) openNewSheet();
  // ?tour=N＝直接開操作導覽、從第 N 步起（截圖驗證用，1-based）
  if (q.has("tour")) startTour(buildTour(), (parseInt(q.get("tour") ?? "1", 10) || 1) - 1);
  const pn = q.get("panel");
  if (pn === "guides" || pn === "layers") { inspector.setPanel(pn); syncPanelButtons(); }
  const th = q.get("theme");
  if (th === "dark" || th === "light") setGalleryTheme(th);
  // ?open=<絕對路徑>＝直接開該專案（真 WKWebView 環境的診斷入口，跟 ⌘O 同一條路）
  const op = q.get("open");
  if (op && inApp) await openPath(op);
  // ?probe=filter＝濾鏡管線探針（真 WKWebView 診斷）：對第一個圖片與影片 block 套 a1，
  // 回報「變體有沒有生出來」「影片濾鏡影格有沒有出現」——taint／CORS 這類殼層差異只有真環境測得到
  const proj = current as Project | null;   // TS 在這裡把 current 窄化成 never（老雷），繞開
  if (q.get("probe") === "zoom" && proj) zoomProbe();
  // ?probe=vf＝VideoFrame 載具評估：量四個關鍵成本（建格／轉移／工人讀回／主緒 putImageData）
  if (q.get("probe") === "vf" && proj) {
    const post = (o: Record<string, unknown>): void => {
      try { navigator.sendBeacon("http://localhost:5199/", JSON.stringify(o)); } catch { /* */ }
    };
    setTimeout(() => {
      void (async () => {
        const el = document.querySelector<HTMLVideoElement>("#videopool-host video");
        if (!el || !el.videoWidth) { post({ probe: "vf", error: "no playing video" }); return; }
        const out: Record<string, unknown> = { probe: "vf", hasVF: "VideoFrame" in window };
        try {
          // ① 建 VideoFrame 的同步成本
          const t0 = performance.now();
          const vf = new VideoFrame(el);
          out.newVFMs = Math.round((performance.now() - t0) * 10) / 10;
          out.fmt = vf.format;
          // ② 轉移給工人＋③ 工人 copyTo 讀回（工人回報自己量的）
          const w = new Worker(URL.createObjectURL(new Blob([`
            self.onmessage = async (e) => {
              const vf = e.data.vf;
              const t0 = performance.now();
              const size = vf.allocationSize({ format: "RGBA" });
              const buf = new ArrayBuffer(size);
              await vf.copyTo(buf, { format: "RGBA" });
              const copyMs = Math.round((performance.now() - t0) * 10) / 10;
              vf.close();
              self.postMessage({ copyMs, size });
            };`], { type: "text/javascript" })));
          const t1 = performance.now();
          w.postMessage({ vf }, [vf as unknown as Transferable]);
          out.postMs = Math.round((performance.now() - t1) * 10) / 10;
          const reply = await new Promise<Record<string, number>>((ok, err) => {
            w.onmessage = (ev) => ok(ev.data as Record<string, number>);
            w.onerror = (ev) => err(new Error(String(ev.message)));
            setTimeout(() => err(new Error("worker timeout")), 8000);
          });
          out.workerCopyMs = reply.copyMs;
          out.copySize = reply.size;
          w.terminate();
        } catch (x) { out.vfError = String(x); }
        // ④ 主緒 putImageData 512×288 的孤立成本
        const c = document.createElement("canvas");
        c.width = 512; c.height = 288;
        const cx = c.getContext("2d")!;
        const d = new ImageData(512, 288);
        const t2 = performance.now();
        cx.putImageData(d, 0, 0);
        out.putMs = Math.round((performance.now() - t2) * 10) / 10;
        // ⑤ 把那張 canvas 畫上另一張（顯示路徑）的成本
        const c2 = document.createElement("canvas");
        c2.width = 512; c2.height = 288;
        const t3 = performance.now();
        c2.getContext("2d")!.drawImage(c, 0, 0);
        out.drawMs = Math.round((performance.now() - t3) * 10) / 10;
        post(out);
      })();
    }, 5000);
  }
  // ?probe=filterlag＝濾鏡穩態負載探針：全部影片套 a1，量 3 秒
  // 主執行緒卡頓／池轉檔耗時／轉檔率——「開著濾鏡會卡」的基準線
  if (q.get("probe") === "filterlag" && proj) {
    const post = (o: Record<string, unknown>): void => {
      try { navigator.sendBeacon("http://localhost:5199/", JSON.stringify(o)); } catch { /* */ }
    };
    if (!q.has("nofilter")) {   // &nofilter=1＝同一套量測但不套濾鏡（分辨堵塞來源）
      for (const b of proj.blocks) {
        if (b.content.type === "video" && b.content.media.assetFileName) {
          b.content.media.filterKey = "a1";
          await ensureVariantFor(b);
        }
      }
    }
    editor.refresh();
    videos.attach(videoUrl ?? null);
    setTimeout(() => {
      const p0 = editor.frameStats.paints;
      const w0 = performance.now();
      let maxLag = 0, maxTick = 0, convSum = 0, ticks = 0;
      const lagEvents: number[] = [];   // 堵塞 >30ms 發生在窗內第幾毫秒（分暫態或常態）
      let lastConv = -1;
      let expect = performance.now() + 20;
      const t = setInterval(() => {
        const now = performance.now();
        const lag = now - expect;
        if (lag > 30) lagEvents.push(Math.round(now - w0));
        maxLag = Math.max(maxLag, lag);
        maxTick = Math.max(maxTick, videos.stats.tickMs);
        // stats.converts 每拍歸零：取樣間隔 20ms < 拍距 50ms，同值不重複累計
        if (videos.stats.converts !== lastConv) { convSum += videos.stats.converts; ticks++; lastConv = videos.stats.converts; }
        expect = now + 20;
      }, 20);
      setTimeout(() => {
        clearInterval(t);
        post({ probe: "filterlag",
               filteredFps: Math.round(convSum / 3),
               paintsPerSec: Math.round((editor.frameStats.paints - p0) / 3),
               maxTickMs: maxTick,
               mainThreadMaxLagMs: Math.round(maxLag),
               lagEventsAtMs: lagEvents.slice(0, 12),
               paintAvgMs: Math.round(editor.frameStats.ms * 10) / 10,
               pool: { ...videos.stats } });
      }, 3000);
    }, 2500);
  }
  if (q.get("probe") === "filter" && proj) {
    const post = (o: Record<string, unknown>): void => {
      try { navigator.sendBeacon("http://localhost:5199/", JSON.stringify(o)); } catch { /* 收端沒開就算了 */ }
    };
    const img = proj.blocks.find((b) => b.content.type === "image" && b.content.media.assetFileName);
    const vid = proj.blocks.find((b) => b.content.type === "video" && b.content.media.assetFileName);
    for (const b of [img, vid]) {
      if (!b || (b.content.type !== "image" && b.content.type !== "video")) continue;
      b.content.media.filterKey = "a1";
      try {
        await ensureVariantFor(b);
        const m = b.content.media;
        const file = b.content.type === "video" ? `${m.assetFileName}.poster.jpg` : m.assetFileName!;
        post({ probe: b.content.type, variant: assets.variants.has(`${file}|a1`) });
      } catch (x) {
        post({ probe: b.content.type, error: String(x) });
      }
    }
    editor.refresh();
    videos.attach(videoUrl ?? null);
    if (vid && vid.content.type === "video" && vid.content.media.assetFileName) {
      const f = vid.content.media.assetFileName;
      editor.focusPage(pageIndexForX(proj, vid.frame.x + vid.frame.w / 2));   // 影片要在視野內才會播
      setTimeout(() => {
        void (async () => {
          const els = [...hiddenHost().querySelectorAll("video")].map((v) => ({
            src: v.src, ready: v.readyState, err: v.error?.code ?? null,
            w: v.videoWidth, t: Math.round(v.currentTime * 10) / 10, paused: v.paused,
          }));
          // 同網址直接 fetch：不帶 Range＝簡單請求；帶 Range＝逼出 preflight——分清楚死在哪一層
          let plainFetch = "", rangeFetch = "";
          if (els[0]) {
            plainFetch = await fetch(els[0].src).then((r) => `${r.status}`, (e) => `ERR ${e}`);
            rangeFetch = await fetch(els[0].src, { headers: { Range: "bytes=0-99" } })
              .then((r) => `${r.status}`, (e) => `ERR ${e}`);
          }
          post({ probe: "videoFrame", filtered: videos.frames.has(`${f}|a1`),
                 plain: videos.frames.has(f), stats: { ...videos.stats }, els, plainFetch, rangeFetch });
        })();
      }, 4000);
    }
  }
  // ?diag=1＝把影片池儀表寫進狀態列（每秒更新），螢幕截圖就讀得到
  if (q.has("diag")) {
    let lastPaints = 0, lastRaf = 0;
    setInterval(() => {
      const s = videos.stats;
      const vr = editor.visibleRect();
      const f = editor.frameStats;
      meta.textContent = `診斷｜播放 ${s.playing}/${s.files}　轉 ${s.converts}格/${s.tickMs}ms`
        + `　重畫 ${f.paints - lastPaints}/s×${f.ms.toFixed(1)}ms`
        + `　rAF ${f.raf - lastRaf}/s　vis=${document.visibilityState}`
        + `　視野 ${Math.round(vr.w)}×${Math.round(vr.h)}`;
      lastPaints = f.paints; lastRaf = f.raf;
    }, 1000);
  }
})().catch((e) => { meta.textContent = __f(__("載入失敗：{msg}"), { msg: e.message }); });
