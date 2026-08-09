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
import { buildPageSpec, pageHasVideo } from "./videoexport";
import { autoFitText, renderPage, renderPageCanvas } from "./core/render";
import { Inspector } from "./inspector";
import { PageStrip, type PageAction } from "./pagestrip";
import { pageIndexForX, pageRect } from "./core/geometry";
import { addPage, deletePage, duplicatePage, retargetToPage, stripToTemplate, swapAdjacentPages } from "./core/pages";
import { alignGroup, applyLayerOrder, distributeGroup, type GroupAlign, type GroupAxis } from "./core/group";
import { CANVAS_PRESETS, canvasSize, changeCanvasRatio, newProject, simplifiedRatio } from "./core/canvas";
import { VideoPool, hiddenHost } from "./videopool";
import { Gallery } from "./gallery";
import { openTrim } from "./trim";
import { checkUpdate } from "./updatecheck";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";

declare const __BUILD_STAMP__: string;

const $ = <T extends HTMLElement>(s: string) => document.querySelector<T>(s)!;
const title = $<HTMLSpanElement>("#title");
const meta = $<HTMLSpanElement>("#meta");
const info = $<HTMLSpanElement>("#info");
const inApp = isTauri();

const editor = new Editor($<HTMLCanvasElement>("#canvas"));

editor.onSelectionChange = (blocks: Block[]) => {
  if (blocks.length > 1 && current) {
    inspector.showGroup(current, blocks);
    info.textContent = `已選 ${blocks.length} 個元件`;
  }
};
editor.onSelect = (b: Block | null) => {
  // 多選時交給 onSelectionChange，這裡只處理「剛好一個」與「零個」
  if (b == null && editor.selectionBlocks().length > 1) return;
  inspector.show(current, b);
  if (!b) { info.textContent = ""; return; }
  const kind = { text: "文字", textFlow: "續流文字", image: "圖片", video: "影片", shape: "形狀" }[b.content.type];
  const f = b.frame;
  info.textContent = `${kind}　${Math.round(f.x)}, ${Math.round(f.y)}　${Math.round(f.w)}×${Math.round(f.h)}`
    + (b.rotation ? `　${Math.round(b.rotation)}°` : "");
};
editor.onCommit = () => {
  inspector.show(current, editor.getSelected());   // 拖完刷新位置數值
  scheduleThumbs();
  commit("drag");
};
editor.onFillSlot = (b) => {
  pickMediaForBlock(b).catch((x) => { meta.textContent = `填圖失敗：${x.message ?? x}`; });
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

type Origin =
  | { kind: "sample" }
  | { kind: "json"; path: string }
  | { kind: "alignproj"; path: string; root: string };

let current: Project | null = null;
let assets: LoadedAssets | undefined;
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
}
const measureCtx = document.createElement("canvas").getContext("2d")!;   // 貼字盒重算用

const strip = new PageStrip($<HTMLDivElement>("#strip"), {
  pick: (i) => editor.focusPage(i),
  add: () => {
    if (!current || !addPage(current)) { meta.textContent = `頁數上限 20 頁`; return; }
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
  if (!m.assetFileName || !assets) return;
  const file = b.content.type === "video" ? `${m.assetFileName}.poster.jpg` : m.assetFileName;
  const key = file + (m.filterKey ? `|${m.filterKey}` : "");
  if (assets.variants.has(key)) return;
  const img = assets.raw.get(file);
  if (!img) return;
  assets.variants.set(key, m.filterKey ? filteredCanvas(img, m.filterKey, filterAssets) : img);
}

/** 空欄位填圖／既有媒體換檔。裁切與拉直重置（屬於舊圖，iOS 同款）；
 *  遮罩／描邊／濾鏡／排開設定保留。選了影片會自動抓海報並轉型。 */
async function pickMediaForBlock(b: Block): Promise<void> {
  if (b.content.type !== "image" && b.content.type !== "video") return;
  const dir = assetsDir();
  if (!dir || !current) return;
  const src = await openDialog({
    multiple: false,
    filters: [{ name: "影像或影片", extensions: [...IMG_EXT, ...VID_EXT] }],
  });
  if (typeof src !== "string") return;
  const ext = src.split(".").pop()?.toLowerCase() ?? "";
  const isVid = VID_EXT.includes(ext);
  const name = await invoke<string>("copy_asset", { src, destDir: dir });
  if (!assets) assets = { variants: new Map(), raw: new Map() };
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
  fillMedia: (b) => { pickMediaForBlock(b).catch((x) => { meta.textContent = `填圖失敗：${x.message ?? x}`; }); },
  // 匯入字型檔（剪映語彙的「自訂」）：存進 App 資料夾 UserFonts/，重開還在。
  // 專案照舊只存 PostScript 名——iPad 也匯同一套字型，專案就兩邊長一樣。
  importFont: async () => {
    if (!inApp) { meta.textContent = "匯入字型要在 App 內用（瀏覽器只是開發預覽）"; return null; }
    const src = await openDialog({
      multiple: false,
      filters: [{ name: "字型檔", extensions: ["ttf", "otf", "ttc"] }],
    });
    if (typeof src !== "string") return null;
    try {
      const f = await invoke<DynamicFont>("import_font", { src });
      // 匯入檔走 url()，必須 await 載完才能量測（字型鐵則）
      if (!f.path || !(await registerUserFont(f, await localUrl(f.path)))) {
        meta.textContent = "這個字型檔讀不進來";
        return null;
      }
      meta.textContent = `已匯入字型：${f.label}`;
      return { label: f.label, value: f.ps };
    } catch (x) {
      meta.textContent = `匯入字型失敗：${(x as Error).message ?? x}`;
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
    currentPage: () => {
      if (!current) return 0;
      // 有選取就跟著選取那一頁——正在調的元件在哪，清單就該在哪
      const sel = editor.getSelected();
      const x = sel ? sel.frame.x + sel.frame.w / 2 : editor.centerPoint().x;
      return pageIndexForX(current, x);
    },
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
      return assets?.variants.get(file + (m.filterKey ? `|${m.filterKey}` : ""));
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
  current = p; assets = a; videoUrl = videoSrc;
  closeHome();   // 有專案上台，首頁退場
  title.textContent = p.name;
  refreshMeta();   // 素材數比對的是不重複素材，拿 block 數當分母會誤報載不齊
  editor.load(p, a?.variants);
  // undo／dirty 基準在 load **之後**取——load 會跑 autoFitText 重算貼字盒，
  // 先取基準的話使用者一動就被誤標「未存變更」
  undoStack = []; redoStack = [];
  committed = snapshot(); savedState = committed;
  updateDirty();
  inspector.show(p, null);
  strip.render(p, renderOpts());
  videos.attach(videoSrc ?? null);   // 換專案＝舊播放器全收掉，再照新來源接
  editor.setVideos(videoSrc ? videos.frames : undefined);
}

function renderOpts() {
  return { images: assets?.variants, filters: filterAssets, placeholderForMissingMedia: true };
}

/**
 * 匯出台的**預覽**用：跟匯出同一條渲染路，但多餵即時影格，所以影片會動。
 * 存檔不能用這個——同一份專案匯出兩次必須一模一樣，抓「當下那一格」
 * 會讓 PNG 隨手速改變（VideoPool 開頭那條取捨）。
 */
function previewOpts() {
  return { ...renderOpts(), videos: videos.frames };
}

// 縮圖走全解析度渲染，改一個值重畫七頁沒必要——收斂到停手後 300ms 才更新
let thumbTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleThumbs(): void {
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(() => { if (current) strip.render(current, renderOpts()); }, 300);
}

async function openSample(base: string): Promise<void> {
  const p = decodeProject(await (await fetch(`${base}/project.json`)).json());
  origin = { kind: "sample" };
  const url = (f: string) => `${base}/assets/${encodeURIComponent(f)}`;
  show(p, await loadAssets(p, url, filterAssets), url);
}

async function openNative(): Promise<void> {
  const path = await openDialog({
    multiple: false,
    filters: [{ name: "ALIGN 專案", extensions: ["alignproj", "json"] }],
  });
  if (typeof path !== "string") return;
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
    meta.textContent = `開啟失敗：${e.message ?? e}`;
  });
});

$<HTMLSelectElement>("#sample").addEventListener("change", (e) => {
  openSample((e.target as HTMLSelectElement).value);
});

$<HTMLButtonElement>("#exporttpl").addEventListener("click", () => {
  exportTemplate().catch((x) => { meta.textContent = `匯出範本失敗：${x.message ?? x}`; });
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
    { label: "複製這一頁（含內容）", run: () => doPageAct("duplicate", i) },
    { label: "在後面插入空白頁", run: () => insertBlankAfter(i) },
    "-",
    { label: "往前一頁", run: () => doPageAct("left", i) },
    { label: "往後一頁", run: () => doPageAct("right", i) },
    "-",
    { label: "刪除這一頁", run: () => doPageAct("delete", i) },
  ];
}

function insertBlankAfter(i: number): void {
  if (!current || !addPage(current)) { meta.textContent = "頁數上限 20 頁"; return; }
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
    const many = sel.length > 1 ? ` ${sel.length} 個` : "";
    items.push({ label: "複製一份", key: "⌘D", run: () => duplicateSelection() });
    if (others.length) {
      items.push({ label: `複製到${many ? "其他頁" : "第…頁"}`,
                   sub: others.map((i) => ({ label: `第 ${i + 1} 頁`, run: () => toPage(sel, i, true) })) });
      items.push({ label: "移到第…頁",
                   sub: others.map((i) => ({ label: `第 ${i + 1} 頁`, run: () => toPage(sel, i, false) })) });
    }
    items.push("-");
    items.push({ label: b.locked ? "解除鎖定" : "鎖定", key: "⌘L", run: () => {
      for (const k of sel) k.locked = !b.locked;
      inspector.show(current, editor.getSelected());
      editor.refresh(); commit("lock");
    } });
    items.push({ label: "移到最前", run: () => inspectorReorder("front") });
    items.push({ label: "移到最後", run: () => inspectorReorder("back") });
    if (b.content.type === "video" && b.content.media.assetFileName && inApp) {
      items.push("-");
      items.push({ label: "修剪影片…", run: () => void trimBlock(b) });
    }
    if (sel.length > 1) {
      items.push("-");
      items.push({ label: "水平置中對齊", run: () => applyToGroup((bs) => alignGroup(bs, "hCenter"), "align") });
      items.push({ label: "垂直置中對齊", run: () => applyToGroup((bs) => alignGroup(bs, "vCenter"), "align") });
    }
    items.push("-");
    items.push({ label: `刪除${many}`, key: "⌫", run: () => deleteSelected() });
  } else {
    items.push({ label: "在這裡加文字", run: () => addBlock("text") });
    items.push({ label: "在這裡加矩形", run: () => addBlock("rectangle") });
    items.push("-");
    items.push({ label: `第 ${here + 1} 頁`, sub: pageMenu(here) });
    items.push("-");
    items.push({ label: "整台縮到剛好", key: "⌘0", run: () => editor.fitAll() });
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
  meta.textContent = on ? "搬照片模式：拖曳＝在框內移動照片，Esc 離開" : "";
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
  if (d < 3600_000) return `${Math.max(1, Math.round(d / 60000))} 分鐘前`;
  if (d < 86400_000) return `${Math.round(d / 3600_000)} 小時前`;
  if (d < 7 * 86400_000) return `${Math.round(d / 86400_000)} 天前`;
  return new Date(t).toLocaleDateString("zh-TW");
}

function renderHome(): void {
  const grid = $<HTMLDivElement>("#recentgrid");
  grid.replaceChildren();
  const list = recents();
  if (!list.length) {
    const p = document.createElement("div");
    p.className = "empty";
    p.textContent = "還沒有最近專案。開一份新的，或打開 iPad AirDrop 過來的 .alignproj。";
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
    rm.className = "rm"; rm.title = "從清單移除";
    rm.innerHTML = '<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7"/></svg>';
    rm.addEventListener("click", (e) => {
      e.stopPropagation();
      saveRecents(recents().filter((k) => k.path !== r.path));
      renderHome();
    });
    card.append(shot, nm, pt, rm);
    card.addEventListener("click", () => {
      // 開失敗卡片留著——可能只是外接碟沒接，不急著把入口丟掉
      openPath(r.path).catch((x) => { meta.textContent = `開不起來：${x.message ?? x}`; });
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
$<HTMLButtonElement>("#newok").addEventListener("click", () => {
  const { w, h } = newSheetSize();
  const p = newProject(
    $<HTMLInputElement>("#newname").value.trim() || "未命名專案",
    presetSel.value, $<HTMLSelectElement>("#newflip").value === "1",
    Number($<HTMLInputElement>("#newpages").value) || 1, newId(),
  );
  p.canvasWidth = w; p.pageHeight = h;
  origin = { kind: "sample" };   // 還沒落地——⌘S 會走「另存」
  closeNewSheet();
  show(p, undefined, undefined);
  meta.textContent = "新專案：⌘S 存檔之後才能匯入素材";
});

/** 匯出輕量範本：一份沒有 assets 的 .alignproj，圖片位置全成空欄位框。
 *  這是「把版型分享出去」的路——AirDrop 給 iPad 打開就能填自己的照片。 */
async function exportTemplate(): Promise<void> {
  if (!current) return;
  if (!inApp) { meta.textContent = "匯出範本要在 App 內用"; return; }
  const path = await saveDialog({
    defaultPath: `${current.name}_範本.alignproj`,
    filters: [{ name: "ALIGN 範本", extensions: ["alignproj"] }],
  });
  if (typeof path !== "string") return;
  const json = JSON.stringify(encodeProject(stripToTemplate(current)), null, 2);
  await invoke("pack_template", { json, dest: path });
  meta.textContent = `已匯出範本　${path.split("/").pop()}`;
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
      // 紙張是整頁逐像素運算，只能走離屏路
      const live = renderPageCanvas(current, s.index, previewOpts());
      const ctx = s.canvas.getContext("2d")!;
      ctx.clearRect(0, 0, s.canvas.width, s.canvas.height);
      ctx.drawImage(live, 0, 0);
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
  const tail = videoCount ? `　${videoCount} 頁為影片` : "";
  $<HTMLDivElement>("#hint").textContent =
    mode === "single" ? `第 ${cur + 1} ／ ${shots.length} 張・← → 翻頁${tail}`
    : mode === "joined" ? `頁貼著頁・檢查跨頁圖在接縫處對不對得齊${tail}`
    : `一頁一張卡・多圖貼文的樣子${tail}`;
}

$<HTMLButtonElement>("#export").addEventListener("click", () => {
  if (!current) return;
  // 匯出走的是與編輯預覽同一支 renderPageCanvas，所以所見即所得
  shots = renderAllPages(current, renderOpts());
  const c = shots[0].canvas;
  $<HTMLSpanElement>("#sheetTitle").textContent = current.name;
  $<HTMLSpanElement>("#sheetSub").textContent = `${shots.length} 頁　${c.width} × ${c.height}`;
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
  cur = 0;
  videoPageSet = new Set(shots.filter((s) => pageHasVideo(current!, s.index)).map((s) => s.index));
  $<HTMLButtonElement>("#muteBtn").innerHTML = muted ? SOUND_ICON.off : SOUND_ICON.on;
  syncSheet();
  sheet.classList.add("on");
  requestAnimationFrame(resetView);        // 要等版面算完才量得到內容尺寸
  clearInterval(previewTimer);
  if (videoPageSet.size) {
    previewTimer = setInterval(repaintVideoPages, 1000 / 12);   // 匯出台只是看，12fps 夠了
  }
});

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
    ? renderPageCanvas(current, s.index, renderOpts()) : s.canvas;
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
  if (inApp && current && pageHasVideo(current, s.index)) {
    const path = await saveDialog({
      defaultPath: s.name.replace(/\.png$/, ".mp4"),
      filters: [{ name: "影片", extensions: ["mp4"] }],
    });
    if (typeof path !== "string") return;
    const title = $<HTMLSpanElement>("#sheetSub");
    const base = title.textContent ?? "";
    title.textContent = `${base}　合成影片中…`;
    try { await exportVideoPage(s.index, path); title.textContent = `${base}　✓ ${path.split("/").pop()}`; }
    catch (x) { title.textContent = `${base}　✗ ${(x as Error).message ?? x}`; }
    return;
  }
  if (inApp) {
    const path = await saveDialog({ defaultPath: s.name, filters: [{ name: "PNG", extensions: ["png"] }] });
    if (path) await invoke("save_png", { path, data: await pngBase64(s) });
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
    const dir = await openDialog({ directory: true });
    if (typeof dir !== "string") return;
    const title = $<HTMLSpanElement>("#sheetSub");
    const base = title.textContent ?? "";
    for (const s of shots) {
      const isVideo = current ? pageHasVideo(current, s.index) : false;
      title.textContent = `${base}　${isVideo ? "合成影片" : "輸出"}第 ${s.index + 1} 頁…`;
      if (isVideo) {
        await exportVideoPage(s.index, `${dir}/${s.name.replace(/\.png$/, ".mp4")}`);
      } else {
        await invoke("save_png", { path: `${dir}/${s.name}`, data: await pngBase64(s) });
      }
    }
    title.textContent = `${base}　✓ 已存入 ${dir.split("/").pop()}`;
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
  if (!inApp) { meta.textContent = "匯入素材要在 App 內用（瀏覽器只是開發預覽）"; return null; }
  if (origin.kind === "sample") { meta.textContent = "先 ⌘S 另存專案，素材才有地方放"; return null; }
  return (origin.kind === "alignproj" ? origin.root : origin.path.replace(/\/[^/]*$/, "")) + "/assets";
}

function loadImg(url: string): Promise<HTMLImageElement> {
  return new Promise((ok, err) => {
    const img = new Image();
    // 媒體伺服器（127.0.0.1）跨源：CORS 乾淨載入，畫進 canvas 才不污染
    if (url.startsWith("http")) img.crossOrigin = "anonymous";
    img.onload = () => ok(img);
    img.onerror = () => err(new Error("影像載入失敗"));
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
    const timer = setTimeout(() => done(() => err(new Error("影片讀太久，抓不到海報"))), 15000);
    v.addEventListener("loadeddata", () => { v.currentTime = Math.min(0.1, (v.duration || 1) / 10); });
    v.addEventListener("seeked", () => {
      const c = document.createElement("canvas");
      c.width = v.videoWidth; c.height = v.videoHeight;
      c.getContext("2d")!.drawImage(v, 0, 0);
      const u = c.toDataURL("image/jpeg", 0.86);
      done(() => ok(u.slice(u.indexOf(",") + 1)));
    }, { once: true });
    v.addEventListener("error", () => done(() => err(new Error("影片解碼失敗"))));
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
  meta.textContent = `${current.pageCount} 頁 · ${current.canvasWidth}×${current.pageHeight} · ${current.blocks.length} 個 block`
    + (want ? `（素材 ${assets?.variants.size ?? 0}/${want}）` : "")
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
  if (!assets) assets = { variants: new Map(), raw: new Map() };

  let img: HTMLImageElement;
  let assetKey: string;
  if (isImg) {
    assetKey = name;
    img = await loadImg(await localUrl(`${dir}/${name}`));
  } else {
    // 長片軟提醒：Mac 不像 iPad 強制匯入就剪，但超過 30 秒回 iPad 會吃力，說一聲
    // （格式完全相容——30 秒只是 iPad 匯入 UI 的政策，見 trim.ts 檔頭）
    const secs = await videoDuration(videoUrl ? videoUrl(name) : await localUrl(`${dir}/${name}`));
    if (secs > 30) {
      meta.textContent = `這支 ${secs.toFixed(0)} 秒——右鍵可以修剪（回 iPad 匯出會比較慢）`;
      setTimeout(() => { if (meta.textContent?.startsWith("這支")) refreshMeta(); }, 5000);
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
  meta.textContent = "修剪中…";
  try {
    const out = `${dir}/trim-${Date.now()}.mov`;
    await invoke("trim_video", { src, dest: out, start: r.start, end: r.end });
    const name = out.split("/").pop()!;
    // 海報要重抓——修剪後的第一格通常不是原本那一格
    const poster = await capturePoster(await localUrl(out));
    await invoke("save_png", { path: `${out}.poster.jpg`, data: poster });
    const key = `${name}.poster.jpg`;
    const img = await loadImg(await localUrl(`${dir}/${key}`));
    assets ??= { variants: new Map(), raw: new Map() };
    assets.raw.set(key, img);
    assets.variants.set(key, img);
    b.content.media.assetFileName = name;
    await ensureVariantFor(b);   // 有濾鏡的話，新海報也要生一份套好濾鏡的變體
    videos.attach(videoUrl ?? null);   // 讓影片池重新接上新檔
    editor.refresh(); scheduleThumbs();
    inspector.show(current, editor.getSelected());
    commit("trim");
    meta.textContent = `已修剪：${(r.end - r.start).toFixed(1)} 秒`;
  } catch (e) {
    meta.textContent = `修剪失敗：${(e as Error).message ?? e}`;
    return;
  }
  setTimeout(() => { if (meta.textContent?.startsWith("已修剪")) refreshMeta(); }, 2600);
}

async function addPhoto(): Promise<Block | null> {
  const dir = assetsDir();
  if (!dir) return null;
  const src = await openDialog({
    multiple: false,
    filters: [{ name: "影像或影片", extensions: [...IMG_EXT, ...VID_EXT] }],
  });
  if (typeof src !== "string") return null;
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
        meta.textContent = `匯入失敗：${(x as Error).message ?? x}`;
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
      b = baseBlock({ type: "text", text: { text: "雙擊編輯文字", alignment: "center",
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
  if (kind) addBlock(kind).catch((x) => { meta.textContent = `新增失敗：${x.message ?? x}`; });
});

$<HTMLButtonElement>("#save").addEventListener("click", () => {
  saveProject().catch((x) => { meta.textContent = `存檔失敗：${x.message ?? x}`; });
});
$<HTMLButtonElement>("#undoBtn").addEventListener("click", () => undo());
$<HTMLButtonElement>("#redoBtn").addEventListener("click", () => redo());
$<HTMLButtonElement>("#zoomfit").addEventListener("click", () => editor.fitAll());
editor.onZoom = (z) => { $<HTMLButtonElement>("#zoomfit").textContent = `${Math.round(z * 100)}%`; };
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

// ── 存檔 ──────────────────────────────────────────────────────────────
async function saveProject(): Promise<void> {
  if (!current) return;
  const json = JSON.stringify(encodeProject(current), null, 2);
  if (!inApp) {
    // 瀏覽器：下載 project.json（開發便利，不是產品路徑）
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url; a.download = "project.json"; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    savedState = committed; updateDirty();
    return;
  }
  if (origin.kind === "json") {
    await invoke("save_text", { path: origin.path, contents: json });
  } else if (origin.kind === "alignproj") {
    // 寫回解包資料夾再重新打包成 .alignproj（首次覆寫會自動留 .bak）
    await invoke("save_text", { path: `${origin.root}/project.json`, contents: json });
    await invoke("pack_alignproj", { dir: origin.root, dest: origin.path });
  } else {
    // 範本／瀏覽器來源：另存新檔
    const path = await saveDialog({ defaultPath: `${current.name}.json`, filters: [{ name: "ALIGN 專案", extensions: ["json"] }] });
    if (typeof path !== "string") return;
    await invoke("save_text", { path, contents: json });
    origin = { kind: "json", path };
  }
  savedState = committed; updateDirty();
  rememberRecent();   // 存檔＝這份專案值得進「最近專案」（另存後 origin 已更新）
  meta.textContent = `已儲存　${new Date().toLocaleTimeString()}`;
}

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
    if (e.key === "s") { e.preventDefault(); saveProject().catch((x) => { meta.textContent = `存檔失敗：${x.message ?? x}`; }); }
    if (e.key === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    if (e.key === "d") { e.preventDefault(); duplicateSelection(); }
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
  // ?export=1／?new=1 ＝載入後直接開該面板（截圖驗證用，不牽動 App 的正常路徑）
  if (q.has("export")) {
    $<HTMLButtonElement>("#export").click();
    const m = q.get("export");
    if (m === "joined" || m === "cards" || m === "single") {
      $<HTMLSpanElement>("#modes").querySelector<HTMLButtonElement>(`[data-mode="${m}"]`)?.click();
    }
  }
  if (q.has("new")) openNewSheet();
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
        post({ probe: b.content.type, variant: assets?.variants.has(`${file}|a1`) ?? false });
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
})().catch((e) => { meta.textContent = `載入失敗：${e.message}`; });
