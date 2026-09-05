import { __, __f } from "./i18n";
import { BRUSHES, BRUSH_ORDER, DOODLE_TAIL, DOODLE_TRAVEL_DUR, DOODLE_WOBBLE_AMP, doodleGrowDur, softSnapshot, type BrushKind, type DoodleBlock, type DoodleWobble } from "./core/doodle";
import { additiveClick } from "./platform";
// 屬性檢視器——獨立元件（企劃約束：畫布／頁面膠捲／屬性檢視器三塊必須可分離，
// 摺疊機與手機版面靠這個）。
//
// 這層只做「顯示值＋回寫值」：直接改共享的 block 物件，改完呼叫 hooks 讓殼層
// 重畫／重算貼字盒。**改自己的值時不重建面板**——重建會把正在打字的輸入框炸掉。
import type { Block, MediaBlock, ModelBlock, Project, ShapeBlock, TextAlign, TextBlock } from "./core/schema";
import { FONT_CHOICES, WEIGHT_LABELS, fontCatalog } from "./core/fonts";
import { FILTER_KEYS, FILTER_LABELS , risoOf, RISO_PRESETS } from "./core/filters";
import { TORN_DEFAULTS, tornLocalSide } from "./core/tornedge";
import { alignToPage } from "./core/group";
import { pageRect } from "./core/geometry";
import type { GroupAlign, GroupAxis } from "./core/group";
import { paperScope, snugTextWidth , attachedCanvas } from "./core/render";
import { ANIM_DUR, ANIM_DUR_MAX, ANIM_HOLD, ANIM_HOLD_MAX, ANIM_STAGE2_DUR, ANIM_STAGE2_SCALE, ANIM_STAGGER, ANIM_STAGGER_MAX, CAROUSEL_INTERVAL, MODEL_SECS_PER_TURN, MODEL_SPIN_DUR, MODEL_TURNS, defaultDur, type AnimDir, type AnimKind, type Stage2 } from "./core/anim";
import { GUIDE_PRESETS, MODULAR_COMBOS, defaultParams, generateGuides, replaceBatch } from "./core/guidegen";
import type { GuideGenParams, GuidePreset } from "./core/guidegen";
import { QUICK, QUICK_PAPERS } from "./palette";
import { openColorPop } from "./colorpop";

/** 產生器每個專案「上次生成的那批」——重生成時只換這批，手動線不動。
 *  存記憶體就好：關掉 App 後舊批就當手動線看待，頂多多按一次刪除。 */
const GEN_BATCH = new Map<string, { x: number[]; y: number[] }>();
const GEN_STORE = "align.guidegen";

/** 塗鴉「套用全部」三顆的 icon（15px 線性，與晶片列同語彙）。 */
const APPLY_ICON = {
  color: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3.2s-4.6 5.2-4.6 8.3a4.6 4.6 0 009.2 0C14.6 8.4 10 3.2 10 3.2z"/></svg>',
  width: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-linecap="round"><path d="M3.5 6h13" stroke-width="1"/><path d="M3.5 10h13" stroke-width="2"/><path d="M3.5 14.5h13" stroke-width="3.2"/></svg>',
  brush: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 15.5c.4-2.6 1-4 2-5l7.6-7.6 2.5 2.5L8 13c-1 1-2.4 1.6-4.5 2.5z"/><path d="M11.6 4.4l2.5 2.5"/></svg>',
};

/** 參考線預設的縮圖：generateGuides 的結果縮進 52×52 的框裡畫成 SVG，頁面比例照畫布。
 *  線對到半格（1px 不糊）、貼邊的往內收半格才看得到。 */
function guideThumb(preset: GuidePreset, p: GuideGenParams, W: number, H: number): SVGSVGElement {
  const NS = "http://www.w3.org/2000/svg";
  const s = Math.min(52 / W, 52 / H);
  const w = Math.max(8, Math.round(W * s)), h = Math.max(8, Math.round(H * s));
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("width", String(w)); svg.setAttribute("height", String(h));
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  const pg = document.createElementNS(NS, "rect");
  pg.setAttribute("class", "pg");
  pg.setAttribute("x", "0.5"); pg.setAttribute("y", "0.5");
  pg.setAttribute("width", String(w - 1)); pg.setAttribute("height", String(h - 1));
  svg.append(pg);
  const snap = (v: number, max: number): number => Math.min(max - 0.5, Math.max(0.5, Math.round(v * s) + 0.5));
  const line = (x1: number, y1: number, x2: number, y2: number): void => {
    const l = document.createElementNS(NS, "line");
    l.setAttribute("x1", String(x1)); l.setAttribute("y1", String(y1));
    l.setAttribute("x2", String(x2)); l.setAttribute("y2", String(y2));
    svg.append(l);
  };
  const g = generateGuides(preset, p, W, H);
  for (const x of g.x) line(snap(x, w), 0, snap(x, w), h);
  for (const y of g.y) line(0, snap(y, h), w, snap(y, h));
  return svg;
}

/** 貼字寬要量字——共用一個量測 ctx（字型都在 document 層，量得到匯入字型）。 */
let MEASURE: CanvasRenderingContext2D | null = null;
const measureCtx = (): CanvasRenderingContext2D =>
  (MEASURE ??= attachedCanvas().getContext("2d")!);
import { CANVAS_PRESETS, canvasSize, simplifiedRatio } from "./core/canvas";
import { CHIP, chipIcon } from "./icons";

/** 圖層列的類型圖示（單色線性 SVG，絕不用 emoji 當 icon）。 */
const svg = (d: string): string =>
  `<svg width="13" height="13" viewBox="0 0 18 18" fill="none" stroke="currentColor"
    stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const LAYER_ICON: Record<Block["content"]["type"], string> = {
  text: svg('<path d="M4 5.4V4h10v1.4"/><path d="M9 4v10"/><path d="M7 14h4"/>'),
  textFlow: svg('<path d="M3.4 4.6h11"/><path d="M3.4 8h11"/><path d="M3.4 11.4h7.6"/><path d="M3.4 14.8h5"/>'),
  image: svg('<rect x="2.8" y="4" width="12.4" height="10" rx="1.6"/><circle cx="6.6" cy="7.6" r="1.1"/><path d="M3.2 12.4l3.4-2.6 3 2.2 2.2-1.6 3.2 2.2"/>'),
  video: svg('<rect x="2.8" y="4" width="12.4" height="10" rx="1.6"/><path d="M7.6 6.9l4 2.1-4 2.1z"/>'),
  model: svg('<path d="M9 2.6l5.6 3.2v6.4L9 15.4 3.4 12.2V5.8z"/><path d="M3.4 5.8L9 9l5.6-3.2"/><path d="M9 9v6.4"/>'),
  shape: svg('<rect x="3.2" y="3.2" width="8" height="8" rx="1.2"/><circle cx="11.4" cy="11.4" r="3.4"/>'),
  doodle: svg('<path d="M3 13.5c2.2-5 3.6-7.4 5-7.4 1.6 0 .4 5.6 2 5.6 1.2 0 2.2-3.2 5-6.2"/>'),
};
const LOCK_ON = svg('<rect x="4" y="8" width="10" height="6.4" rx="1.4"/><path d="M6.4 8V6.2a2.6 2.6 0 015.2 0V8"/>');
const LOCK_OFF = svg('<rect x="4" y="8" width="10" height="6.4" rx="1.4"/><path d="M6.4 8V6.2a2.6 2.6 0 015-1.1"/>');

/** 動作鈕 icon（2026-08-25 蘋果式定案）：icon＋文字、icon 當輔助不取代字；
 *  名詞參數列不加 icon；同一顆 icon 全 App 只代表一件事（垃圾桶＝刪、勾＝完成…）。
 *  樣本間＝01 - 研究/樣本間/介面/檢視器icon化.html（含四語寬度壓力測試）。 */
const ACT = {
  eraser: svg('<path d="M7.3 15 3.2 10.9a1.35 1.35 0 0 1 0-1.9L9.7 2.5a1.35 1.35 0 0 1 1.9 0l3.9 3.9a1.35 1.35 0 0 1 0 1.9L8.6 15H7.3Z"/><path d="M5.6 8.5l5 5"/>'),
  done: svg('<path d="M3.2 9.6 7 13.6 14.8 5"/>'),
  // 新塗鴉＝塗鴉線＋實心徽章加號（第二輪 D 定案：實心塊在 13px 的對比最強）
  newDoodle: svg('<path d="M2.6 12.2c2-4 3.2-6 4.4-6 1.4 0 .6 4.4 2 4.4.9 0 1.7-2 3.4-4.2"/><circle cx="13" cy="12.6" r="4" fill="currentColor" stroke="none"/><path d="M13 10.6v4 M11 12.6h4" stroke="var(--card)" stroke-width="1.5"/>'),
  pen: svg('<path d="M10.6 3.6l3.8 3.8-7.6 7.6-4.6 1 1-4.6z"/><path d="M9.2 5l3.8 3.8"/>'),
  applyAll: svg('<rect x="2.8" y="2.8" width="12.4" height="12.4" rx="2"/><path d="M5.6 9.3 7.9 11.6 12.4 6.4"/>'),
  trash: svg('<path d="M3.2 5h11.6 M7 5V3.8a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1V5 M4.6 5l.8 9a1.1 1.1 0 0 0 1.1 1h5a1.1 1.1 0 0 0 1.1-1l.8-9"/>'),
  eye: svg('<path d="M2.4 9s2.4-4.2 6.6-4.2S15.6 9 15.6 9s-2.4 4.2-6.6 4.2S2.4 9 2.4 9Z"/><circle cx="9" cy="9" r="1.9"/>'),
  eyeOff: svg('<path d="M2.4 9s2.4-4.2 6.6-4.2S15.6 9 15.6 9s-2.4 4.2-6.6 4.2S2.4 9 2.4 9Z"/><path d="M3.6 14.4 14.4 3.6"/>'),
  vline: svg('<path d="M9 2.6v12.8"/><path d="M4 5.5v7 M14 5.5v7" stroke-dasharray="1.6 2.2"/>'),
  hline: svg('<path d="M2.6 9h12.8"/><path d="M5.5 4h7 M5.5 14h7" stroke-dasharray="1.6 2.2"/>'),
  copy: svg('<rect x="2.8" y="2.8" width="9" height="9" rx="1.4"/><path d="M6.2 12.6v1a1.6 1.6 0 0 0 1.6 1.6h5.8a1.6 1.6 0 0 0 1.6-1.6V7.8a1.6 1.6 0 0 0-1.6-1.6h-1"/>'),
  front: svg('<rect x="6.4" y="2.6" width="9" height="9" rx="1.4"/><rect x="2.6" y="6.4" width="9" height="9" rx="1.4" stroke-dasharray="2 2.4"/>'),
  back: svg('<rect x="2.6" y="6.4" width="9" height="9" rx="1.4"/><rect x="6.4" y="2.6" width="9" height="9" rx="1.4" stroke-dasharray="2 2.4"/>'),
  fit: svg('<path d="M3 4h12"/><path d="M3 14h12"/><path d="M9 6.4v5.2 M7 8.4 9 6.4l2 2 M7 9.6l2 2 2-2"/>'),
};

/** 對齊按鈕圖示（2026-08-14 icon 化）：頁面／群組對齊＝基準線＋方塊，
 *  文字對齊＝橫杠（行的形狀）。單色線性，titles 照樣講人話。 */
const ALIGN_ICON: Record<GroupAlign, string> = {
  left:    svg('<path d="M3.5 3v12"/><rect x="6" y="6.2" width="8" height="5.6" rx="1"/>'),
  hCenter: svg('<path d="M9 3v12"/><rect x="5" y="6.2" width="8" height="5.6" rx="1"/>'),
  right:   svg('<path d="M14.5 3v12"/><rect x="4" y="6.2" width="8" height="5.6" rx="1"/>'),
  top:     svg('<path d="M3 3.5h12"/><rect x="6.2" y="6" width="5.6" height="8" rx="1"/>'),
  vCenter: svg('<path d="M3 9h12"/><rect x="6.2" y="5" width="5.6" height="8" rx="1"/>'),
  bottom:  svg('<path d="M3 14.5h12"/><rect x="6.2" y="4" width="5.6" height="8" rx="1"/>'),
};
const TEXT_ALIGN_ICON: Record<TextAlign, string> = {
  leading:  svg('<path d="M3 4.5h12"/><path d="M3 9h7"/><path d="M3 13.5h10"/>'),
  center:   svg('<path d="M3 4.5h12"/><path d="M5.5 9h7"/><path d="M4 13.5h10"/>'),
  trailing: svg('<path d="M3 4.5h12"/><path d="M8 9h7"/><path d="M5 13.5h10"/>'),
};

/** 圖層列要顯示的名字。文字用內容前幾個字——那才是他認得出來的東西。 */
function layerName(b: Block): string {
  const c = b.content;
  if (c.type === "text" || c.type === "textFlow") {
    const t = c.text.text.replace(/\s+/g, " ").trim();
    return t ? (t.length > 14 ? `${t.slice(0, 14)}…` : t) : __("（空白文字）");
  }
  if (c.type === "shape") {
    return { rectangle: __("矩形"), ellipse: __("圓形"), line: __("線條") }[c.shape.kind] ?? __("形狀");
  }
  if (c.type === "model") return __("3D 物件");
  if (c.type === "doodle") return __f("塗鴉（{n} 筆）", { n: c.doodle.strokes.length });
  return c.media.assetFileName ? (c.type === "video" ? __("影片") : __("圖片")) : __("空欄位");
}

export interface InspectorHooks {
  /** 值改完。retext＝文字內容或樣式有動，殼層要重算貼字盒。 */
  onChange: (opts?: { retext?: boolean }) => void;
  /** 濾鏡換了——殼層要確保「素材×濾鏡」的變體已生成。 */
  ensureVariant: (block: Block, preview?: boolean) => Promise<void>;
  reorder: (block: Block, dir: "front" | "back") => void;
  /** 播放出場動畫。給 block＝只播那一個（面板即時回饋）；不給＝整個版面。 */
  playAnim?: (block?: Block) => void;
  /** 開筆刷偏好設定視窗（齒輪選單同一扇；塗鴉面板的齒輪鈕）。 */
  openBrushPrefs?: () => void;
  /** 一鍵把整頁的出場順序排開（寫進專案），排完自動播一次。 */
  sequenceAll?: (from?: Block) => void;
  /** 一鍵把整頁的出場動畫清掉（陸續出現的反操作）。 */
  clearAnims?: (from?: Block) => void;
  remove: (block: Block) => void;
  /** 空欄位填圖／既有媒體換檔（開選檔框、複製進 assets、必要時轉型 image↔video）。 */
  fillMedia: (block: Block) => void;
  /** 多圖輪播：開選檔框（可多選）把圖加進這個框的輪播清單。 */
  addCarousel?: (block: Block) => void;
  /** 去背：跑一次主體抽取，遮罩寫進 assets/ 並掛上 matteFileName。
   *  回訊息字串給面板顯示（覆蓋率可疑、抽不到⋯），null＝沒事。 */
  makeMatte?: (block: Block) => Promise<string | null>;
  /** 打開去背編輯間（橡皮擦／粉紅預覽／羽化外擴）。 */
  editMatte?: (block: Block) => Promise<void>;
  /** 去背模型：內建（Vision）／BiRefNet（選配，要下載）。
   *  選單寫模型名稱不寫「進階」（2026-08-25 小高定案）。 */
  matteModel?: {
    get: () => string;
    installed: () => boolean;
    /** 選 BiRefNet 但還沒裝＝先下載；下載失敗就留在內建。 */
    choose: (key: string) => Promise<void>;
    remove: () => Promise<void>;
  };
  /** 內建材質清單。label 只當 hover 提示，按鈕上顯示的是 url 那張縮圖。 */
  matteTextures?: () => { key: string; label: string; url: string }[];
  /** 把材質填進去背出來的形狀裡。key = null ＝自己選一張圖。 */
  fillTexture?: (block: Block, key: string | null) => Promise<void>;
  /** 填顏色——與填材質同一條路，素材是一張純色圖。 */
  fillColor?: (block: Block, hexNoHash: string) => Promise<void>;
  /** 匯入字型檔（開選檔框→存 UserFonts→註冊）。回匯入結果，null＝取消或失敗。 */
  importFont?: () => Promise<{ label: string; value: string } | null>;
  /** 塗鴉模式（editor.doodle 的代理）。 */
  doodle?: {
    active: () => boolean;
    pen: () => { brush: BrushKind; color: string; width: number; eraser: boolean } | null;
    setPen: (p: { brush?: BrushKind; color?: string; width?: number; eraser?: boolean }) => void;
    begin: (b?: Block) => void;
    end: () => void;
    newLayer: () => void;
  };
  /** 改整份專案的畫布形狀（頁內位置與尺寸都不動）。 */
  changeRatio: (w: number, h: number) => void;
  guides: {
    hidden: () => boolean;
    toggleHidden: () => void;
    /** 產生器預覽（虛線畫在整個版面）；null＝清掉。 */
    preview?: (g: { x: number[]; y: number[] } | null) => void;   // 可選：自測的假 hooks 沒有
    add: (axis: "x" | "y") => void;
    remove: (axis: "x" | "y", index: number) => void;
    /** 鎖住＝畫布上滑鼠碰不到參考線（線還在、吸附照舊）。 */
    locked: () => boolean;
    toggleLocked: () => void;
    /** 記憶欄 1–9（跨專案共用，存 localStorage）。slot 一律 1-based。 */
    presets: {
      filled: () => boolean[];
      apply: (slot: number) => void;
      save: (slot: number) => void;
      clear: (slot: number) => void;
    };
  };
  layers: {
    /** 圖層清單只列「現在看的那一頁」——跨頁全部列出來就變成一長條沒人看得懂。 */
    currentPage: () => number;
    select: (id: string, additive: boolean) => void;
    /** 依清單順序（第一筆＝最上層）重排 zIndex。 */
    reorder: (idsTopFirst: string[]) => void;
    toggleLock: (id: string) => void;
    /** 這個 block 畫在畫布上的那張圖（含濾鏡）——圖層列的小縮圖直接用它。 */
    thumb: (b: Block) => CanvasImageSource | undefined;
  };
  group: {
    align: (edge: GroupAlign) => void;
    distribute: (axis: GroupAxis) => void;
    duplicate: () => void;
    remove: () => void;
  };
}

/** 側欄上方可以釘一塊面板（工具列的 icon 開關）。屬性照樣在下面，不用互相讓位。 */
export type SidePanel = "none" | "guides" | "layers";

export class Inspector {
  private project: Project | null = null;
  private block: Block | null = null;
  private panel: SidePanel = "none";
  /** 剛在畫布上碰到的那一條參考線——面板裡標出來，才知道手上是哪一條。 */
  private hotGuide: { axis: "x" | "y"; index: number } | null = null;
  /** 填顏色的收斂 timer。掛實例不掛閉包：閉包版在面板重建後還會開火，抓著舊的
   *  block 搶選取、甚至把已 undo 的物件塞回專案（timer 裡那份複本沒人作廢）。 */
  private fillSettle: number | undefined;

  constructor(private el: HTMLElement, private hooks: InspectorHooks) {}

  /** 工具列的 icon 開關。回傳目前狀態，讓殼層去點亮按鈕。 */
  setPanel(p: SidePanel): SidePanel {
    this.panel = this.panel === p ? "none" : p;
    // 面板換掉／收起＝版面上的產生器預覽跟著清（只有參考線面板開著才畫）
    if (this.panel !== "guides") this.hooks.guides.preview?.(null);
    this.rebuild();
    this.el.scrollTop = 0;   // 換面板＝換內容，從頭看
    return this.panel;
  }
  get activePanel(): SidePanel { return this.panel; }

  /** 在畫布上按到參考線：把面板切過去並標出那一條。 */
  focusGuide(axis: "x" | "y", index: number): void {
    this.hotGuide = { axis, index };
    this.panel = "guides";
    this.rebuild();
    this.el.querySelector(".row.hot")?.scrollIntoView({ block: "nearest" });
  }

  /** 換類型／換遮罩之類的結構變化後整面重建（值變化不重建——會炸掉正在打字的輸入框）。
   *  重建前後保留捲動位置——不保留的話，捲到下面點一下參數整欄彈回頂端（2026-08-19 小高回饋）。 */
  private rebuild(): void {
    const top = this.el.scrollTop;
    this.show(this.project, this.block);
    this.el.scrollTop = top;
  }

  show(project: Project | null, block: Block | null): void {
    // 換選取／重建＝上一輪填顏色的收斂 timer 作廢——它抓的是舊 block，開火只會出事
    window.clearTimeout(this.fillSettle);
    this.project = project;
    this.block = block;
    // .pin 是自己的捲動容器（max-height 46vh）——重畫會整個換新，捲動位置要
    // 自己帶過去，不然參考線的數字調一格、emit 觸發重畫，整欄就彈回頂端，
    // 連續按上下鍵變成不可能（2026-08-25 小高回報）。
    const pinTop = this.el.querySelector<HTMLDivElement>(".pin")?.scrollTop ?? 0;
    this.el.replaceChildren();
    if (project && this.panel !== "none") {
      const pin = document.createElement("div");
      pin.className = "pin";
      this.el.append(pin);
      if (pinTop) requestAnimationFrame(() => { pin.scrollTop = pinTop; });
      const host = this.el;
      this.el = pin;
      if (this.panel === "guides") this.guidesPanel(project); else this.layersPanel(project);
      this.el = host;
    }
    if (!project || !block) {
      // 塗鴉模式還沒落第一筆：先給筆刷面板，讓他挑好再畫
      if (project && this.hooks.doodle?.active()) { this.doodlePanel(null, null); return; }
      // 空狀態不放教學文字（2026-08-16 使用者：版面說明文字全拿掉；教學歸操作導覽）
      if (project) this.projectPanel(project);
      return;
    }
    this.common(block);
    switch (block.content.type) {
      case "text": case "textFlow": this.text(block.content.text); break;
      case "shape": this.shape(block.content.shape); break;
      case "image": case "video": this.media(block, block.content.media); break;
      case "model": this.model3d(block, block.content.model); break;
      case "doodle": this.doodlePanel(block, block.content.doodle); break;
    }
  }

  /**
   * 塗鴉（2026-08-23 小高規格）：筆刷／顏色／筆寬＝**下一筆**的設定（同一張可以多色多筆刷），
   * 「整張套用」才改既有筆畫。動作＝巡線（前面長、後面消失，循環）；筆刷感＝線本身在動
   * （沸騰／飄／疊線）。生長出場在「出場方式」裡選「生長」。橡皮擦＝整筆擦。
   */
  private doodlePanel(b: Block | null, d: DoodleBlock | null): void {
    const dk = this.hooks.doodle;
    const s = this.section(__("塗鴉"));
    const active = !!dk?.active();
    const pen = dk?.pen() ?? { brush: "pen" as BrushKind, color: "1A1A1A", width: 12, eraser: false };

    // 模式列：繼續畫／完成、橡皮擦、新塗鴉。蘋果式（2026-08-25）：不放「模式」
    // 左標籤——按鈕自己會說話，省下的 52px 剛好讓三顆 icon＋文字收在一行。
    const modeRow = document.createElement("div"); modeRow.className = "row";
    s.append(modeRow);
    const seg = document.createElement("div"); seg.className = "seg";
    if (!active) {
      seg.append(this.actBtn(ACT.pen, b ? __("繼續畫") : __("開始畫"), () => { dk?.begin(b ?? undefined); this.rebuild(); }));
    } else {
      const er = this.actBtn(ACT.eraser, __("橡皮擦"), () => { dk?.setPen({ eraser: !pen.eraser }); this.rebuild(); });
      if (pen.eraser) er.classList.add("on");
      seg.append(er);
      seg.append(this.actBtn(ACT.newDoodle, __("新塗鴉"), () => { dk?.newLayer(); this.rebuild(); }));
      seg.append(this.actBtn(ACT.done, __("完成"), () => { dk?.end(); this.rebuild(); }));
    }
    modeRow.append(seg);

    // 套用邏輯（2026-08-25 小高回饋重定）：
    // ・選取既有塗鴉（非作畫中）＝改了**立即全套用**——跟文字面板「選了就改」同直覺。
    // ・作畫中＝設定只管下一筆（多色多筆刷規格），每個參數列尾各給一顆「套用全部」，
    //   顏色/粗細/筆刷可以分開套，不再整包綁死。
    const short = b ? Math.min(b.frame.w, b.frame.h) : 1;
    const live = !active && !!b && !!d && d.strokes.length > 0;
    const applyEach = (fn: (st: DoodleBlock["strokes"][number]) => void): void => {
      if (!d) return;
      for (const st of d.strokes) fn(st);
      this.emit();
    };
    const brushRow = this.row(s, __("筆刷"));
    brushRow.append(this.select(
      BRUSH_ORDER.map((k) => [k, __(BRUSHES[k].name) + (k === "soft" ? "（New）" : "")] as [string, string]),
      pen.brush, (v) => {
        dk?.setPen({ brush: v as BrushKind, eraser: false });
        if (live) applyEach((st) => { st.brush = v as BrushKind; stampSp(st); });
      },
    ));
    // 換到軟鉛筆＝蓋當下偏好快照；換走＝清掉（sp 只對軟鉛筆有意義）
    const stampSp = (st: DoodleBlock["strokes"][number]): void => {
      st.sp = st.brush === "soft" ? softSnapshot() : undefined;
    };
    if (this.hooks.openBrushPrefs) {
      const gear = document.createElement("button");
      gear.className = "act";
      gear.title = __("筆刷偏好設定");
      gear.innerHTML = '<svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="2.6"/><path d="M10 3.2v2M10 14.8v2M3.2 10h2M14.8 10h2M5.2 5.2l1.4 1.4M13.4 13.4l1.4 1.4M14.8 5.2l-1.4 1.4M6.6 13.4l-1.4 1.4"/></svg>';
      gear.addEventListener("click", () => this.hooks.openBrushPrefs?.());
      brushRow.append(gear);
    }

    const colorRow = this.row(s, __("顏色"));
    colorRow.append(this.swatches(pen.color, (v) => {
      dk?.setPen({ color: v, eraser: false });
      if (live) applyEach((st) => { st.color = v; });
    }));
    const setWidth = (v: number): void => {
      dk?.setPen({ width: v, eraser: false });
      if (live) applyEach((st) => { st.w = v / short; });
    };
    this.row(s, __("筆寬")).append(this.numSlider(pen.width, { min: 1, max: 200, step: 1 }, setWidth, setWidth));
    // 「套用全部」集中成一列三顆 icon（2026-09-05 小高：顏色列被它擠到色票一排只剩兩顆）。
    // 點下去才現抓目前的筆（setPen 不重畫面板，抓建面板時的 pen 會是舊值）。
    if (active && d && d.strokes.length) {
      const ap = (icon: string, title: string,
                  fn: (p: NonNullable<ReturnType<NonNullable<typeof dk>["pen"]>>) => void): HTMLButtonElement => {
        const btn = this.iconBtn(icon, title, () => { const p = dk?.pen(); if (p) fn(p); });
        btn.classList.add("wide");
        return btn;
      };
      this.row(s, __("套用全部")).append(
        ap(APPLY_ICON.color, __("目前顏色套到全部筆畫"), (p) => applyEach((st) => { st.color = p.color; })),
        ap(APPLY_ICON.width, __("目前筆寬套到全部筆畫"), (p) => applyEach((st) => { st.w = p.width / short; })),
        ap(APPLY_ICON.brush, __("目前筆刷套到全部筆畫"), (p) => applyEach((st) => { st.brush = p.brush; stampSp(st); })),
      );
    }
    if (!b || !d) return;

    const play = (): void => this.hooks.playAnim?.();
    // 動作：生長＝出場「生長」的捷徑（同一個欄位），移動＝巡線
    const motion = b.anim?.kind === "draw" ? "grow" : d.play ?? "";
    this.row(s, __("動作")).append(this.select(
      [["", __("靜止")], ["grow", __("生長")], ["travel", __("移動")]],
      motion, (v) => {
        if (v === "grow") {
          d.play = undefined;
          b.anim = { ...(b.anim ?? {}), kind: "draw", dur: doodleGrowDur(d, b.frame.w, b.frame.h) };
        } else {
          if (b.anim?.kind === "draw") b.anim = undefined;
          d.play = (v || undefined) as DoodleBlock["play"];
        }
        this.rebuild(); this.emit(); play();
      },
    ));
    if (motion === "grow" && b.anim) {
      this.row(s, __("秒數")).append(
        this.num(b.anim.dur ?? ANIM_DUR, { min: 0.2, max: ANIM_DUR_MAX, step: 0.1 },
                 (v) => { b.anim = { ...b.anim!, dur: v }; this.emit(); play(); }),
      );
    }
    if (motion) {
      // 順序＝一筆接一筆（照畫的順序）；同時＝每一筆各自同時動
      this.row(s, __("筆畫")).append(this.select(
        [["", __("照順序")], ["sync", __("同時")]], d.sync ? "sync" : "",
        (v) => { d.sync = v ? true : undefined; this.emit(); play(); },
      ));
    }
    if (d.play === "travel") {
      this.row(s, __("一圈秒數")).append(this.num(d.travelDur ?? DOODLE_TRAVEL_DUR, { min: 0.3, max: 30, step: 0.1 },
        (v) => { d.travelDur = v; this.emit(); play(); }));
      this.row(s, __("尾巴長度")).append(this.num(Math.round((d.tail ?? DOODLE_TAIL) * 100), { min: 5, max: 100, step: 5 },
        (v) => { d.tail = v / 100; this.emit(); play(); }));
    }
    this.row(s, __("筆刷感")).append(this.select(
      [["", __("無")], ["boil", __("沸騰")], ["sketch", __("疊線")]],
      d.wobble ?? "", (v) => { d.wobble = (v || undefined) as DoodleWobble; this.rebuild(); this.emit(); play(); },
    ));
    if (d.wobble) {
      this.row(s, __("幅度")).append(this.num(Math.round((d.wobbleAmp ?? DOODLE_WOBBLE_AMP) * 1000), { min: 1, max: 60, step: 1 },
        (v) => { d.wobbleAmp = v / 1000; this.emit(); play(); }));
    }
    // 縮放拉桿（2026-08-26 小高：「塗鴉是物件了，要有拉桿縮放」，iPad 同款）。
    // 倍率相對「拉桿起手」那一刻（±1 → 1/3×…3×），繞中心等比；放手歸中、
    // 基準重抓——往大往小永遠有行程，不會拉到底卡住。筆畫座標是 frame 正規化的，
    // 縮 frame 就是縮整張塗鴉。
    {
      let base: { x: number; y: number; w: number; h: number } | null = null;
      const slider = this.range(0, -1, 1, 0.01, (t) => {
        base ??= { ...b.frame };
        const f = Math.max(0.05, Math.pow(3, t));
        b.frame = { x: base.x + base.w * (1 - f) / 2, y: base.y + base.h * (1 - f) / 2,
                    w: base.w * f, h: base.h * f };
        this.emit();
      });
      slider.addEventListener("change", () => { slider.value = "0"; base = null; });
      this.row(s, __("縮放")).append(slider);
    }
  }

  /** 3D 物件：展示方式與速率。它在專案裡永遠是活的物件，匯出那一刻才烤成影格。
   *  ②快轉煞停的圈數 0.5 步進（半圈也行）、終點停在「角度」那一面（2026-08-16 定案）。 */
  private model3d(b: Block, m: ModelBlock): void {
    const s = this.section(__("3D 物件"));
    const play = (): void => this.hooks.playAnim?.(b);
    this.row(s, __("展示方式")).append(this.select(
      [["", __("靜止")], ["spin", __("慢慢轉圈")], ["spinStop", __("快轉煞停")]],
      m.mode ?? "",
      (v) => { m.mode = (v || undefined) as ModelBlock["mode"]; this.rebuild(); this.emit(); play(); },
    ));
    if (m.mode === "spin") {
      this.row(s, __("秒／圈")).append(
        this.num(m.secsPerTurn ?? MODEL_SECS_PER_TURN, { min: 0.5, max: 60, step: 0.5 },
                 (v) => { m.secsPerTurn = v; this.emit(); play(); }),
      );
    }
    if (m.mode === "spinStop") {
      this.row(s, __("圈數")).append(
        this.num(m.turns ?? MODEL_TURNS, { min: 0.5, max: 10, step: 0.5 },
                 (v) => { m.turns = v; this.emit(); play(); }),
      );
      this.row(s, __("秒數")).append(
        this.num(m.dur ?? MODEL_SPIN_DUR, { min: 0.3, max: 10, step: 0.1 },
                 (v) => { m.dur = v; this.emit(); play(); }),
      );
    }
    this.row(s, __("角度")).append(
      this.num(m.yaw ?? 0, { min: -360, max: 360, step: 5 },
               (v) => { m.yaw = v || undefined; this.emit(); }),
    );
  }

  /** 多選：顯示整組操作（對齊的基準是**這幾個東西自己的外框**，不是頁面）。 */
  showGroup(project: Project, blocks: Block[]): void {
    this.project = project;
    this.block = null;
    this.el.replaceChildren();
    const s = this.section(__f("已選 {n} 個元件", { n: blocks.length }));

    const pairs: [string, [GroupAlign, string][]][] = [
      [__("水平對齊"), [["left", __("左")], ["hCenter", __("中")], ["right", __("右")]]],
      [__("垂直對齊"), [["top", __("上")], ["vCenter", __("中")], ["bottom", __("下")]]],
    ];
    for (const [label, opts] of pairs) {
      const row = this.row(s, label);
      const seg = document.createElement("div");
      seg.className = "seg";
      for (const [edge, text] of opts) {
        seg.append(this.iconBtn(ALIGN_ICON[edge], text, () => this.hooks.group.align(edge)));
      }
      row.append(seg);
    }

    const dist = this.row(s, __("等距分布"));
    const dseg = document.createElement("div");
    dseg.className = "seg";
    const canDistribute = blocks.length >= 3;
    for (const [axis, text] of [["horizontal", __("水平")], ["vertical", __("垂直")]] as [GroupAxis, string][]) {
      const b = this.btn(text, () => this.hooks.group.distribute(axis));
      b.disabled = !canDistribute;      // 兩個之間沒有東西可以分
      b.title = canDistribute ? "" : __("等距分布至少要選三個");
      dseg.append(b);
    }
    dist.append(dseg);

    // 對齊到頁面：整組平移（彼此對齊在上面兩排；這排是「這一坨放到頁面哪裡」）
    this.pageAlignRow(s, () => blocks);

    const acts = this.row(s, "");
    acts.append(this.actBtn(ACT.copy, __("複製一份"), () => this.hooks.group.duplicate()));
    const danger = this.actBtn(ACT.trash, __f("刪除 {n} 個（⌫）", { n: blocks.length }), () => this.hooks.group.remove());
    danger.classList.add("danger");
    acts.append(danger);

    // ── 文字批次調整（2026-08-14）：選取裡的文字一起改 ──
    // 值一致就顯示、不一致顯示「混合」；設定＝**絕對值**套到選取裡每一個文字
    // （桌面慣例，Figma 同款）。要保留彼此的大小差異就用畫布上群組右下角
    // 那顆等比縮放手把，這裡是「把它們改成一樣」的入口。
    const texts: TextBlock[] = [];
    for (const b of blocks) {
      if (b.content.type === "text" || b.content.type === "textFlow") texts.push(b.content.text);
    }
    if (texts.length) {
      const ts = this.section(__f("文字（{n} 個一起改）", { n: texts.length }));
      const same = <T>(get: (t: TextBlock) => T): T | undefined => {
        const v0 = get(texts[0]);
        return texts.every((t) => get(t) === v0) ? v0 : undefined;
      };
      const applyAll = (fn: (t: TextBlock) => void): void => {
        for (const t of texts) fn(t);
        this.emit(true);
      };
      const mixedSelect = (options: [string, string][], value: string | undefined,
                           set: (v: string) => void): HTMLSelectElement => {
        const sel = this.select(
          value == null ? [["__mixed__", __("（混合）")], ...options] : options,
          value ?? "__mixed__", set);
        if (value == null) sel.options[0].disabled = true;
        return sel;
      };

      const curFont = same((t) => t.fontName ?? "");
      this.row(ts, __("字型")).append(this.fontSelect(curFont ?? "",
        (v) => applyAll((t) => { t.fontName = v || undefined; }), { mixed: curFont == null }));

      const curW = same((t) => t.fontWeightValue ?? 3);
      this.row(ts, __("字重")).append(mixedSelect(
        WEIGHT_LABELS.map((l, i) => [String(i), l] as [string, string]),
        curW == null ? undefined : String(curW),
        (v) => applyAll((t) => { t.fontWeightValue = Number(v); })));

      const curSize = same((t) => t.fontSize ?? 49);
      this.row(ts, __("字級")).append(this.num(curSize ?? 49,
        { min: 8, max: 500, step: 1, mixed: curSize == null },
        (v) => applyAll((t) => { t.fontSize = v; })));

      const curKern = same((t) => t.kerningEm ?? 0);
      this.row(ts, __("字距 em")).append(this.num(curKern ?? 0,
        { min: -0.05, max: 1.5, step: 0.01, mixed: curKern == null },
        (v) => applyAll((t) => { t.kerningEm = v; })));

      const curLh = same((t) => t.lineHeightMultiple ?? 1);
      this.row(ts, __("行高 ×")).append(this.num(curLh ?? 1,
        { min: 0.7, max: 2, step: 0.05, mixed: curLh == null },
        (v) => applyAll((t) => { t.lineHeightMultiple = v; })));

      const alignRow = this.row(ts, __("對齊"));
      const alignBox = document.createElement("div");
      alignBox.className = "seg";
      const curAlign = same((t) => t.alignment);
      const aligns: [TextAlign, string][] = [["leading", __("左")], ["center", __("中")], ["trailing", __("右")]];
      for (const [val, label] of aligns) {
        const abtn = this.iconBtn(TEXT_ALIGN_ICON[val], label, () => {
          applyAll((t) => { t.alignment = val; });
          for (const el of alignBox.children) el.classList.toggle("on", el === abtn);
        });
        abtn.classList.toggle("on", curAlign === val);
        alignBox.append(abtn);
      }
      alignRow.append(alignBox);

      this.row(ts, __("顏色")).append(this.swatches(
        same((t) => t.colorHex ?? "000000") ?? texts[0].colorHex ?? "000000",
        (hexNoHash) => applyAll((t) => {
          t.colorHex = hexNoHash;
          t.inkColor = undefined;   // 渲染以 run 屬性優先，改色要把它清掉才吃 colorHex
        })));

      // 貼字寬（絕對對齊 2026-08-14）：把選取裡殘留的手動寬度一次收乾淨
      const snugAll = this.actBtn(ACT.fit, __("貼字寬（全部）"), () => {
        const p = this.project;
        if (!p) return;
        let n = 0;
        for (const b of blocks) if (snugTextWidth(measureCtx(), b, p.canvasWidth, p.pageHeight)) n++;
        if (n) this.emit(true);
      });
      snugAll.title = __("把每個文字的框收到剛好包住字——斷行與字的位置都不會變");
      this.row(ts, __("框寬")).append(snugAll);
    }
    // 操作提示文字拿掉了（2026-08-16 使用者定案）——快捷鍵語彙留給 title 提示與導覽
  }

  // ── 各區段 ──────────────────────────────────────────────────────────

  /** 沒選元件時給專案級的設定：紙張是**全專案單一**（逐頁不同紙會在頁縫露餡），
   *  頁面背景則是逐頁一格。 */
  private projectPanel(p: Project): void {
    const s = this.section(__("專案"));
    const cur = simplifiedRatio(p.canvasWidth, p.pageHeight);
    const known = CANVAS_PRESETS.flatMap((k) => [
      { key: k.key, flip: false, ...canvasSize(k.key, false) },
      { key: k.key, flip: true, ...canvasSize(k.key, true) },
    ]);
    const match = known.find((k) => k.w === p.canvasWidth && k.h === p.pageHeight);
    const opts: [string, string][] = known
      .filter((k, i) => known.findIndex((j) => j.w === k.w && j.h === k.h) === i)   // 1:1 翻了還是 1:1
      .map((k) => [`${k.w}x${k.h}`,
                   `${simplifiedRatio(k.w, k.h)}　${k.w}×${k.h}`]);
    if (!match) opts.unshift([`${p.canvasWidth}x${p.pageHeight}`, __f("{cur}　{w}×{h}（目前）", { cur, w: p.canvasWidth, h: p.pageHeight })]);
    this.row(s, __("畫布比例")).append(this.select(
      opts, `${p.canvasWidth}x${p.pageHeight}`,
      (v) => {
        const [w, h] = v.split("x").map(Number);
        if (w !== p.canvasWidth || h !== p.pageHeight) this.hooks.changeRatio(w, h);
      },
    ));
    this.row(s, __("紙張")).append(this.select(
      [["", __("無")], ["c1", __("報紙")], ["c3", __("底片顆粒")], ["c4", __("高級紙")],
       ["h1", __("手抄紙")], ["h2", __("粗手抄紙")]],
      p.paperKey ?? "",
      (v) => { p.paperKey = v || undefined; this.rebuild(); this.emit(); },
    ));
    // 紙張要不要吃到哪一類——三個勾選（2026-08-16 使用者定案）。
    // 全勾＝整頁一次套完（快路）；取消任一個就改走分層渲染。
    if (p.paperKey) {
      const sc = paperScope(p);
      const scopeRow = this.row(s, __("套用到"));
      const box = (label: string, on: boolean, set: (v: boolean) => void): void => {
        const w = document.createElement("label");
        w.className = "chk";
        w.append(this.check(on, (v) => { set(v); this.emit(); }), document.createTextNode(label));
        scopeRow.append(w);
      };
      box(__("物件"), sc.objects, (v) => { p.paperOnObjects = v; });
      box(__("背景"), sc.background, (v) => { p.paperOnBackground = v; });
      box(__("文字"), sc.text, (v) => { p.paperOnText = v; });
    }
    // 一鍵一對：套用（陸續出現）↔ 移除（整頁動畫清掉）——2026-08-16 使用者定案
    const a = this.section(__("出場動畫"));
    this.row(a, "").append(
      this.btn(__("陸續出現"), () => { this.hooks.sequenceAll?.(); this.rebuild(); this.emit(); }),
      this.btn(__("移除動畫"), () => { this.hooks.clearAnims?.(); this.rebuild(); this.emit(); }),
    );
    this.row(a, __("間隔")).append(
      this.num(p.animStagger ?? ANIM_STAGGER, { min: 0, max: ANIM_STAGGER_MAX, step: 0.05 },
               (v) => { p.animStagger = v; this.emit(); }),
    );
    this.holdRow(a);
    const i = this.hooks.layers.currentPage();
    const bgSec = this.section(__("頁面背景"));
    this.row(bgSec, __f("第 {n} 頁", { n: i + 1 })).append(
      // 紙色六顆＋自訂（2026-09-05）：以前只有一顆原生選色器，點開是 WebKit 的螢光色格
      this.swatches(p.pageBackgroundHex?.[String(i)] ?? "FFFFFF", (hexNoHash) => {
        p.pageBackgroundHex = { ...(p.pageBackgroundHex ?? {}), [String(i)]: hexNoHash };
        this.emit();
      }, QUICK_PAPERS),
    );
    // 一鍵把這一頁的底色刷到全部頁——輪播通常整本同一個底色，一頁一頁點是折磨
    this.row(bgSec, "").append(this.btn(__("全部頁套用"), () => {
      const hex = p.pageBackgroundHex?.[String(i)] ?? "FFFFFF";
      const all: Record<string, string> = {};
      for (let k = 0; k < p.pageCount; k++) all[String(k)] = hex;
      p.pageBackgroundHex = all;
      this.emit();
    }));
  }

  // ── 釘住的面板 ──────────────────────────────────────────────────────

  /** 參考線面板。**隱藏**只是不畫（線還在、吸附照舊）；**鎖定**是滑鼠碰不到。 */
  private guidesPanel(p: Project): void {
    const gs = this.section(__("參考線"));
    const row = this.row(gs, __("狀態"));
    const hidden = this.hooks.guides.hidden();
    const eye = this.actBtn(hidden ? ACT.eyeOff : ACT.eye, hidden ? __("已隱藏") : __("顯示中"),
                            () => { this.hooks.guides.toggleHidden(); this.rebuild(); });
    eye.classList.toggle("on", !hidden);
    const locked = this.hooks.guides.locked();
    const lock = this.actBtn(locked ? LOCK_ON : LOCK_OFF, locked ? __("已鎖定") : __("可拖曳"),
                             () => { this.hooks.guides.toggleLocked(); this.rebuild(); });
    lock.classList.toggle("on", locked);
    row.append(eye, lock);
    this.row(gs, __("新增")).append(
      this.actBtn(ACT.vline, __("垂直線"), () => this.hooks.guides.add("x")),
      this.actBtn(ACT.hline, __("水平線"), () => this.hooks.guides.add("y")),
    );
    if ((p.guidesX?.length ?? 0) + (p.guidesY?.length ?? 0) > 0) {
      this.row(gs, __("清除")).append(this.actBtn(ACT.trash, __("刪除全部參考線"), () => {
        p.guidesX = [];
        p.guidesY = [];
        GEN_BATCH.delete(p.id);
        this.hotGuide = null;
        this.rebuild();
        this.emit();
      }));
    }
    // 記憶欄 1–9：點＝套用、⌥點＝存目前、⇧點＝清空；鍵盤 ⌥1–9 套用、⇧⌥1–9 存
    const seg = document.createElement("div");
    seg.className = "seg";
    const filled = this.hooks.guides.presets.filled();
    for (let i = 1; i <= 9; i++) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = String(i);
      b.classList.toggle("on", !!filled[i - 1]);
      b.title = __("點＝套用；⌥點＝存入目前參考線；⇧點＝清空");
      b.addEventListener("click", (e) => {
        if (e.altKey) this.hooks.guides.presets.save(i);
        else if (e.shiftKey) this.hooks.guides.presets.clear(i);
        else this.hooks.guides.presets.apply(i);
        this.rebuild();
      });
      seg.append(b);
    }
    this.row(gs, __("記憶欄")).append(seg);
    // 三種點法藏在滑過提示裡沒人看得到（2026-08-18 小高回饋）——直接寫在欄位底下
    const slotHint = document.createElement("div");
    slotHint.className = "hint pinhint";
    slotHint.textContent = __("點＝套用｜⌥點＝存入目前參考線｜⇧點＝清空\n鍵盤：⌥1–9 套用、⇧⌥1–9 存入");
    gs.append(slotHint);
    this.guideGenerator(gs, p);
    const list: [string, "x" | "y", number[]][] = [
      [__("垂直"), "x", p.guidesX ?? []], [__("水平"), "y", p.guidesY ?? []],
    ];
    for (const [label, axis, arr] of list) {
      arr.forEach((v, i) => {
        const r = this.row(gs, `${label} ${i + 1}`);
        if (this.hotGuide?.axis === axis && this.hotGuide.index === i) r.classList.add("hot");
        r.append(
          this.num(v, { step: 1 }, (nv) => {
            if (axis === "x") (p.guidesX ??= [])[i] = nv; else (p.guidesY ??= [])[i] = nv;
            this.emit();
          }),
          // 列表列的刪除＝垃圾桶單獨站（規則裡唯一 icon 不帶字的例外）
          this.iconBtn(ACT.trash, __("刪除"), () => this.hooks.guides.remove(axis, i)),
        );
      });
    }
    const hint = document.createElement("div");
    hint.className = "hint pinhint";
    hint.textContent = (p.guidesX?.length || p.guidesY?.length)
      ? (this.hooks.guides.locked() ? __("已鎖定：畫布上碰不到，改數值或解鎖") : __("畫布上可直接拖；拖出頁面外＝丟掉"))
      : __("還沒有參考線。加一條，或從畫布上拖出來");
    this.el.append(hint);
  }

  /** 參考線產生器（優化項目 #13）：一鍵長出預設參考線。
   *  鐵則：全部從 canvasWidth/pageHeight 現算、不寫死座標——換畫布比例重按就對。
   *  「生成」＝換掉上次生成的那批；手動加的、拖過的（值變了）都不收走。 */
  private guideGenerator(gs: HTMLElement, p: Project): void {
    const W = p.canvasWidth, H = p.pageHeight;
    type Stored = { preset?: GuidePreset; over?: Partial<GuideGenParams> };
    const load = (): Stored => {
      try { return JSON.parse(localStorage.getItem(GEN_STORE) ?? "{}"); } catch { return {}; }
    };
    const st = load();
    const preset: GuidePreset = st.preset ?? "igsafe";
    // 只存「動過的」欄位——邊距/溝寬這些預設值要跟著畫布比例走，存死就違反鐵則
    const over = st.over ?? {};
    const params: GuideGenParams = { ...defaultParams(W, H), ...over };
    const save = (patch: Partial<Stored>): void => {
      localStorage.setItem(GEN_STORE, JSON.stringify({ preset, over, ...patch }));
    };
    const curParams = (): GuideGenParams => ({ ...defaultParams(W, H), ...over });
    // 拉桿拖動中只更新版面預覽與縮圖（不重建面板——重建會把正在拖的拉桿拆掉）；放手才重建
    const setOver = (k: keyof GuideGenParams, v: number | string, live = false): void => {
      (over as Record<string, number | string>)[k] = v;
      save({ over });
      if (live) { showPreview(preset); refreshThumb(); return; }
      this.rebuild();
    };

    const labels: Record<GuidePreset, string> = {
      igsafe: __("IG 安全區"), margins: __("邊界框"), columns: __("欄格"),
      modular: __("模組網格"), baseline: __("基線網格"), thirds: __("三分法"), golden: __("黃金分割"),
    };
    // 產生器改成看得到的選單（2026-09-05 小高：「選預設時看得到預設」）：每顆縮圖＝那個預設
    // 在**目前畫布比例**下真的長出來的線——同一支 generateGuides、同一組參數，不是示意圖。
    // 選中的那顆吃使用者調過的參數（改欄數縮圖跟著變），其他顆用出廠值。
    const cur = document.createElement("span");
    cur.textContent = labels[preset];
    this.row(gs, __("產生器")).append(cur);
    // 版面預覽（2026-09-05 小高：「不能只在縮圖上，要在整個版面上預覽」）：選中那組一直以虛線
    // 畫在畫布上，滑過別顆＝暫時換成那組，移開回來；拉桿拖動時預覽跟著動。按「生成」才落成真線。
    const gen = (k: GuidePreset): { x: number[]; y: number[] } =>
      generateGuides(k, k === preset ? curParams() : defaultParams(W, H), W, H);
    const showPreview = (k: GuidePreset): void => this.hooks.guides.preview?.(gen(k));
    let selThumb: SVGSVGElement | null = null;
    const refreshThumb = (): void => {
      if (!selThumb) return;
      const fresh = guideThumb(preset, curParams(), W, H);
      selThumb.replaceWith(fresh); selThumb = fresh;
    };
    const grid = document.createElement("div");
    grid.className = "gpgrid";
    for (const k of GUIDE_PRESETS) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "gp" + (k === preset ? " on" : "");
      b.title = labels[k];
      const tag = document.createElement("span");
      tag.textContent = labels[k];
      const th = guideThumb(k, k === preset ? params : defaultParams(W, H), W, H);
      if (k === preset) selThumb = th;
      b.append(th, tag);
      b.addEventListener("click", () => { save({ preset: k }); this.rebuild(); });
      b.addEventListener("mouseenter", () => showPreview(k));
      b.addEventListener("mouseleave", () => showPreview(preset));
      grid.append(b);
    }
    gs.append(grid);
    showPreview(preset);

    const numRow = (label: string, key: keyof GuideGenParams, opts: { min: number; max: number; step: number }): void => {
      this.row(gs, label).append(this.numSlider(params[key] as number, opts,
        (v) => setOver(key, v, true), (v) => setOver(key, v)));
    };
    // 欄數是主拉桿（2026-09-05 小高：「一個總拉桿一次調多個欄位」）：拉欄數時溝寬等比跟著
    //（溝寬÷欄寬不變），鎖比例的模組格列數本來就自動算——拉一下就是整組等比縮放。
    const colsRow = (): void => {
      const base = { cols: params.cols, gutter: params.gutter };
      const applyCols = (v: number, live: boolean): void => {
        (over as Record<string, number | string>).gutter = Math.round(base.gutter * base.cols / Math.max(v, 1));
        setOver("cols", v, live);
      };
      const r = this.row(gs, __("欄數"));
      r.title = __("溝寬會等比跟著；要單獨調溝寬用下一列");
      r.append(this.numSlider(params.cols, { min: 1, max: 12, step: 1 }, (v) => applyCols(v, true), (v) => applyCols(v, false)));
    };
    if (preset === "igsafe" && H / W < 1.6) {
      this.row(gs, __("格狀預覽")).append(this.select(
        [["3:4", __("3:4（現行）")], ["1:1", __("1:1（舊版）")]], params.gridPreview,
        (v) => setOver("gridPreview", v),
      ));
    }
    if (preset === "margins" || preset === "columns" || preset === "modular" || preset === "baseline") {
      numRow(__("邊距"), "margin", { min: 0, max: Math.round(W / 3), step: 1 });
    }
    if (preset === "columns" || preset === "modular") {
      colsRow();
      numRow(__("溝寬"), "gutter", { min: 0, max: Math.round(W / 4), step: 1 });
    }
    if (preset === "modular") {
      this.row(gs, __("組合")).append(this.select(
        [["", __("自訂")], ["letterbox", "Letterbox"], ["contact", __("接觸印樣")], ["editorial", __("雜誌主從")]],
        "", (v) => {
          const combo = MODULAR_COMBOS[v];
          if (!combo) return;
          Object.assign(over, combo);
          // 分鏡組合預設要說明帶（字幕/編號的家）；自訂不動使用者的值
          if (over.captionH == null) over.captionH = Math.round(W * 0.05);
          save({ over });
          this.rebuild();
        },
      ));
      const ratios: [string, string][] = [["0", __("自由")], ["1", "1:1"], [String(16 / 9), "16:9"], ["2.35", "2.35:1"]];
      const curRatio = ratios.some(([v]) => Number(v) === params.cellRatio) ? String(params.cellRatio) : "0";
      this.row(gs, __("格比例")).append(this.select(ratios, curRatio, (v) => setOver("cellRatio", Number(v))));
      numRow(params.cellRatio > 0 ? __("最多列數") : __("列數"), "rows", { min: 1, max: 12, step: 1 });
      numRow(__("說明帶高"), "captionH", { min: 0, max: Math.round(H / 4), step: 1 });
    }
    if (preset === "baseline") {
      numRow(__("行距"), "step", { min: 8, max: Math.round(H / 4), step: 1 });
    }

    const act = this.row(gs, __("生成"));
    act.append(this.btn(__("生成"), () => {
      const out = generateGuides(preset, params, W, H);
      const prev = GEN_BATCH.get(p.id) ?? { x: [], y: [] };
      p.guidesX = replaceBatch(p.guidesX ?? [], prev.x, out.x);
      p.guidesY = replaceBatch(p.guidesY ?? [], prev.y, out.y);
      GEN_BATCH.set(p.id, out);
      this.rebuild();
      this.emit();
    }));
    if (GEN_BATCH.get(p.id)?.x.length || GEN_BATCH.get(p.id)?.y.length) {
      act.append(this.btn(__("收走生成的"), () => {
        const prev = GEN_BATCH.get(p.id) ?? { x: [], y: [] };
        p.guidesX = replaceBatch(p.guidesX ?? [], prev.x, []);
        p.guidesY = replaceBatch(p.guidesY ?? [], prev.y, []);
        GEN_BATCH.delete(p.id);
        this.rebuild();
        this.emit();
      }));
    }
  }

  /** 圖層清單：由上而下＝由前而後（跟畫面的疊法一致，不是 zIndex 由小到大）。 */
  private layersPanel(p: Project): void {
    const page = this.hooks.layers.currentPage();
    const half = p.canvasWidth / 2;
    const onPage = p.blocks
      .filter((b) => Math.floor((b.frame.x + b.frame.w / 2) / p.canvasWidth) === page)
      .sort((a, b) => b.zIndex - a.zIndex);
    this.section(__f("圖層　第 {n} 頁", { n: page + 1 }));
    void half;
    const box = document.createElement("div");
    box.className = "layers";
    this.el.append(box);
    for (const b of onPage) {
      const row = document.createElement("div");
      row.className = "lay";
      row.dataset.id = b.id;
      if (b.id === this.block?.id) row.classList.add("on");
      if (b.locked) row.classList.add("locked");
      const ic = this.layerThumb(b);
      const name = document.createElement("span");
      name.className = "nm";
      name.textContent = layerName(b);
      const lk = document.createElement("button");
      lk.className = "lk";
      lk.title = b.locked ? __("解除鎖定") : __("鎖定");
      lk.innerHTML = b.locked ? LOCK_ON : LOCK_OFF;
      lk.addEventListener("click", (e) => {
        e.stopPropagation();
        this.hooks.layers.toggleLock(b.id);
        this.rebuild();
      });
      row.append(ic, name, lk);
      row.addEventListener("click", (e) => this.hooks.layers.select(b.id, additiveClick(e)));
      this.makeLayerDraggable(box, row);
      box.append(row);
    }
    const hint = document.createElement("div");
    hint.className = "hint pinhint";
    hint.textContent = onPage.length ? __("上＝最前面，拖曳換前後") : __("這一頁還沒有元件");
    this.el.append(hint);
  }

  /**
   * 圖層列左邊那顆小縮圖。媒體畫真圖（依 cropRect 取那一塊，看到的就是畫布上的那一塊）、
   * 形狀畫自己的顏色、文字留字形圖示——iPad 端只有媒體有縮圖，這裡順手把形狀也補上。
   */
  private layerThumb(b: Block): HTMLElement {
    const box = document.createElement("span");
    box.className = "ico";
    const c = b.content;
    if (c.type === "image" || c.type === "video") {
      const src = this.hooks.layers.thumb(b);
      if (src) {
        const dpr = window.devicePixelRatio || 1;
        const cv = document.createElement("canvas");
        cv.width = cv.height = Math.round(24 * dpr);
        cv.style.width = cv.style.height = "24px";
        const x = cv.getContext("2d")!;
        const sw = (src as HTMLImageElement).naturalWidth || (src as HTMLCanvasElement).width;
        const sh = (src as HTMLImageElement).naturalHeight || (src as HTMLCanvasElement).height;
        const r = c.media.cropRect;
        // (0,0,1,1) 是「沒裁過」的哨兵值，攤開成置中滿版；裁過的就照裁切區
        const virgin = r.x === 0 && r.y === 0 && r.w === 1 && r.h === 1;
        let cx = r.x * sw, cy = r.y * sh, cw = r.w * sw, ch = r.h * sh;
        if (virgin) { const k = Math.min(sw, sh); cx = (sw - k) / 2; cy = (sh - k) / 2; cw = ch = k; }
        else { const k = Math.min(cw, ch); cx += (cw - k) / 2; cy += (ch - k) / 2; cw = ch = k; }
        x.drawImage(src, cx, cy, cw, ch, 0, 0, cv.width, cv.height);
        box.append(cv);
        box.classList.add("shot");
        return box;
      }
    }
    if (c.type === "shape" && c.shape.kind !== "line") {
      const sw = document.createElement("span");
      sw.className = "swatch";
      sw.style.background = `#${c.shape.colorHex ?? "888888"}`;
      if (c.shape.kind === "ellipse") sw.style.borderRadius = "50%";
      box.append(sw);
      return box;
    }
    box.innerHTML = LAYER_ICON[c.type];
    return box;
  }

  /** 拖曳換前後。與頁面膠捲同一套做法：指標事件自己來，落點提示是「插在哪兩列之間」。 */
  private makeLayerDraggable(box: HTMLElement, row: HTMLElement): void {
    row.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
      const startY = e.clientY;
      let moved = false;
      let target = [...box.children].indexOf(row);
      const from = target;
      const onMove = (ev: PointerEvent) => {
        if (!moved && Math.abs(ev.clientY - startY) < 5) return;
        if (!moved) {
          moved = true; row.classList.add("dragging");
          try { row.setPointerCapture(e.pointerId); } catch { /* 合成事件沒有真的指標 */ }
        }
        const rows = [...box.children] as HTMLElement[];
        const boxes = rows.map((r) => r.getBoundingClientRect());
        target = boxes.findIndex((b, i) => ev.clientY < b.top + b.height / 2 || i === boxes.length - 1);
        if (target < 0) target = rows.length - 1;
        rows.forEach((r, i) => r.classList.toggle("droptop", moved && i === target && i !== from));
      };
      const onUp = () => {
        row.removeEventListener("pointermove", onMove);
        row.removeEventListener("pointerup", onUp);
        row.classList.remove("dragging");
        for (const r of [...box.children]) r.classList.remove("droptop");
        if (!moved || target === from) return;
        const ids = ([...box.children] as HTMLElement[]).map((r) => r.dataset.id!);
        ids.splice(target, 0, ids.splice(from, 1)[0]);
        this.hooks.layers.reorder(ids);
      };
      row.addEventListener("pointermove", onMove);
      row.addEventListener("pointerup", onUp);
    });
  }

  /** 「對齊頁面」六顆（左中右／上中下）。對齊是主功能：單選＝快速對齊、
   *  多選＝**整組當一個單位**平移到頁邊／頁中（相對位置不變）。 */
  private pageAlignRow(parent: HTMLElement, blocks: () => Block[]): void {
    const p = this.project;
    if (!p) return;
    const row = this.row(parent, __("對齊頁面"));
    const mk = (opts: [GroupAlign, string][]): HTMLDivElement => {
      const seg = document.createElement("div");
      seg.className = "seg";
      for (const [edge, label] of opts) {
        seg.append(this.iconBtn(ALIGN_ICON[edge], label, () => {
          alignToPage(blocks(), edge, p.canvasWidth, p.pageHeight);
          this.emit();
          if (this.block) this.rebuild();   // 單選面板有位置數值，對齊完要刷新
        }));
      }
      return seg;
    };
    row.append(
      mk([["left", __("貼左頁邊")], ["hCenter", __("頁面水平置中")], ["right", __("貼右頁邊")]]),
      mk([["top", __("貼頁頂")], ["vCenter", __("頁面垂直置中")], ["bottom", __("貼頁底")]]),
    );
  }

  private common(b: Block): void {
    const s = this.section(__("位置與圖層"));
    const pos = this.row(s, __("位置"));
    pos.append(
      this.num(b.frame.x, { step: 1 }, (v) => { b.frame.x = v; this.emit(); }),
      this.num(b.frame.y, { step: 1 }, (v) => { b.frame.y = v; this.emit(); }),
    );
    this.pageAlignRow(s, () => [b]);
    const size = this.row(s, __("尺寸"));
    const editable = b.content.type === "shape" || b.content.type === "image" || b.content.type === "video";
    // 文字的框是貼字盒（由內容決定），這裡不給改——改字級/欄寬才是正路
    size.append(
      this.num(Math.round(b.frame.w), { step: 1, disabled: !editable }, (v) => { b.frame.w = v; this.emit(); }),
      this.num(Math.round(b.frame.h), { step: 1, disabled: !editable }, (v) => { b.frame.h = v; this.emit(); }),
    );
    if (editable) {
      // 縮放拉桿（2026-09-05 小高：「尺寸跟旋轉最需要拉桿」）：以拖動起點的尺寸為 100%，
      // 等比、以中心為錨（跟角把手同語意）；放手重建＝下一次再從 100% 起
      const w0 = b.frame.w, h0 = b.frame.h, cx = b.frame.x + w0 / 2, cy = b.frame.y + h0 / 2;
      const scaleTo = (pct: number): void => {
        const w = Math.max(1, w0 * pct / 100), h = Math.max(1, h0 * pct / 100);
        b.frame.w = w; b.frame.h = h; b.frame.x = cx - w / 2; b.frame.y = cy - h / 2;
        this.emit();
      };
      this.row(s, __("縮放")).append(this.numSlider(100, { min: 10, max: 400, step: 1 },
        scaleTo, (v) => { scaleTo(v); this.rebuild(); }));
    }
    this.row(s, __("旋轉")).append(
      this.numSlider(b.rotation, { min: -180, max: 180, step: 1 },
        (v) => { b.rotation = v; this.emit(); }, (v) => { b.rotation = v; this.emit(); }),
    );
    this.row(s, __("不透明")).append(
      this.range(b.opacity, 0, 1, 0.05, (v) => { b.opacity = v; this.emit(); }),
    );
    this.row(s, __("鎖定")).append(this.check(b.locked, (on) => {
      // 鎖定的元件點不到、拖不動、不長手把、群組對齊也略過（引擎本來就吃這個欄位）
      b.locked = on;
      this.rebuild();
      this.emit();
    }));
    this.animRow(s, b);
    // 三顆都做成純 icon：帶文字的版本中文剛好塞不下、英文更長，換行之後排成三行很醜
    //（小高 2026-09-01 回報）。圖示與選取浮動晶片**共用同一組**（src/icons.ts），
    // 同一個動作在畫布上跟面板裡長一樣；人話留在 title／aria-label。
    const layer = this.row(s, __("圖層"));
    const danger = this.iconBtn(chipIcon(CHIP.del, 15), __("刪除元件"), () => this.hooks.remove(b));
    danger.classList.add("danger", "wide");
    const wide = (btn: HTMLButtonElement): HTMLButtonElement => {
      btn.classList.add("wide");
      return btn;
    };
    layer.append(
      wide(this.iconBtn(chipIcon(CHIP.front, 15), __("移到最前"), () => this.hooks.reorder(b, "front"))),
      wide(this.iconBtn(chipIcon(CHIP.back, 15), __("移到最後"), () => this.hooks.reorder(b, "back"))),
      danger,
    );
  }

  /**
   * 出場方式。文字與物件是兩套語彙：
   * 文字的 in 點固定在「文字開頭」、方向朝尾端，所以沒有方向可選；
   * 物件的 in 點方向可自訂上下左右。
   */
  private animRow(s: HTMLElement, b: Block): void {
    const isText = b.content.type === "text" || b.content.type === "textFlow";
    const isDoodle = b.content.type === "doodle";
    const kinds: [string, string][] = isText
      ? [["", __("無")], ["typewriter", __("打字")], ["textPhrase", __("逐句")],
         ["textSlide", __("位移")], ["textFlicker", __("隨機閃現")]]
      : [["", __("無")], ...(isDoodle ? [["draw", __("生長")] as [string, string]] : []),
         ["slide", __("位移")], ["fade", __("淡入")],
         ["scale", __("縮放")], ["maskWipe", __("遮罩")]];
    const play = (): void => this.hooks.playAnim?.(b);

    this.row(s, __("出場方式")).append(this.select(kinds, b.anim?.kind ?? "", (v) => {
      if (!v) {
        b.anim = undefined;
        this.rebuild(); this.emit();
        // 必須重啟整台播放——不重啟的話，時間軸還抱著改之前的快照在循環
        // （2026-08-16 實案：3D 物件的出場調回「無」還一直播）
        this.hooks.playAnim?.();
        return;
      }
      const kind = v as AnimKind;
      // **換效果就重算秒數**——沿用前一個效果的值會出事：長文選過「打字」算出 30 秒，
      // 再換「位移」就變成慢動作 30 秒。手調過的值在換效果時一併重置，這是可預期的。
      const txt = b.content.type === "text" || b.content.type === "textFlow" ? b.content.text.text : "";
      const dur = kind === "draw" && b.content.type === "doodle"
        ? doodleGrowDur(b.content.doodle, b.frame.w, b.frame.h) : defaultDur(kind, txt);
      b.anim = { ...(b.anim ?? {}), kind, dur };
      this.rebuild();
      this.emit();
      play();                      // 選了就立刻在畫布上播一次——不用匯出才知道長怎樣
    }));
    if (!b.anim) return;

    // 方向只對「會動的物件效果」有意義（淡入、縮放沒有方向）；
    // 兩段式是純縮放語彙，第一段不跑 kind 的效果，方向也就沒意義
    if (!isText && (b.anim.kind === "slide" || b.anim.kind === "maskWipe") && !b.anim.stage2) {
      this.row(s, __("方向")).append(this.select(
        [["left", __("從左")], ["right", __("從右")], ["up", __("從上")], ["down", __("從下")]],
        b.anim.dir ?? "left",
        (v) => { b.anim = { ...b.anim!, dir: v as AnimDir }; this.emit(); play(); },
      ));
    }
    // 兩段式是物件的語彙（文字沒有「放大／滿版」這回事）。
    // 模型：入場到版面位置（第一個位置）→ 接著放大到第二個位置並停在那裡。
    if (!isText) {
      this.row(s, __("兩段式")).append(this.select(
        [["", __("無")], ["scale", __("接著放大")], ["fullscreen", __("接著滿版")]],
        b.anim.stage2 ?? "",
        (v) => {
          const { stage2: _s2, dur2: _d2, scale2: _sc, ...rest } = b.anim!;
          b.anim = v ? { ...rest, stage2: v as Stage2 } : rest;
          this.rebuild(); this.emit(); play();
        },
      ));
      if (b.anim.stage2 === "scale") {
        this.row(s, __("第二段大小")).append(
          this.num(Math.round((b.anim.scale2 ?? ANIM_STAGE2_SCALE) * 100), { min: 50, max: 400, step: 5 },
                   (v) => { b.anim = { ...b.anim!, scale2: v / 100 }; this.emit(); play(); }),
        );
      }
      if (b.anim.stage2) {
        this.row(s, __("第二段秒數")).append(
          this.num(b.anim.dur2 ?? ANIM_STAGE2_DUR, { min: 0.1, max: ANIM_DUR_MAX, step: 0.1 },
                   (v) => { b.anim = { ...b.anim!, dur2: v }; this.emit(); play(); }),
        );
      }
    }
    this.row(s, __("秒數")).append(
      this.num(b.anim.dur ?? ANIM_DUR, { min: 0.1, max: ANIM_DUR_MAX, step: 0.1 },
               (v) => { b.anim = { ...b.anim!, dur: v }; this.emit(); play(); }),
    );
    this.row(s, __("延遲")).append(
      this.num(b.anim.delay ?? 0, { min: 0, max: 60, step: 0.1 },
               (v) => { b.anim = { ...b.anim!, delay: v }; this.emit(); play(); }),
    );
    // 停留就擺在秒數旁邊——調節奏時兩個數字要一起看。
    // 值本身是**整頁共用**（停留是頁面跑完的那段靜止，不是單一元件的屬性），
    // 所以這裡寫的是專案設定，專案面板那列是同一個值。
    this.holdRow(s, play);
  }

  private text(t: TextBlock): void {
    const s = this.section(__("文字"));
    const ta = document.createElement("textarea");
    ta.rows = 3;
    ta.value = t.text;
    ta.addEventListener("input", () => { t.text = ta.value; this.emit(true); });
    this.row(s, __("內容")).append(ta);

    this.row(s, __("字型")).append(this.fontSelect(t.fontName ?? "",
      (v) => { t.fontName = v || undefined; this.emit(true); }, { allowImport: true }));
    this.row(s, __("字重")).append(this.select(
      WEIGHT_LABELS.map((l, i) => [String(i), l]),
      String(t.fontWeightValue ?? 3),
      (v) => { t.fontWeightValue = Number(v); this.emit(true); },
    ));
    this.row(s, __("字級")).append(
      this.numSlider(t.fontSize ?? 49, { min: 8, max: 500, step: 1 }, (v) => { t.fontSize = v; this.emit(true); }, (v) => { t.fontSize = v; this.emit(true); }),
    );
    // 字距用 em 制（新模型優先）；行高倍數 <1 可壓緊，這是 iOS 舊點制做不到的
    this.row(s, __("字距 em")).append(
      this.numSlider(t.kerningEm ?? 0, { min: -0.05, max: 1.5, step: 0.01 }, (v) => { t.kerningEm = v; this.emit(true); }, (v) => { t.kerningEm = v; this.emit(true); }),
    );
    this.row(s, __("行高 ×")).append(
      this.numSlider(t.lineHeightMultiple ?? 1, { min: 0.7, max: 2, step: 0.05 }, (v) => { t.lineHeightMultiple = v; this.emit(true); }, (v) => { t.lineHeightMultiple = v; this.emit(true); }),
    );

    const seg = this.row(s, __("對齊"));
    const alignBox = document.createElement("div");
    alignBox.className = "seg";
    const aligns: [TextAlign, string][] = [["leading", __("左")], ["center", __("中")], ["trailing", __("右")]];
    for (const [val, label] of aligns) {
      const btn = this.iconBtn(TEXT_ALIGN_ICON[val], label, () => {
        t.alignment = val;
        for (const el of alignBox.children) el.classList.toggle("on", el === btn);
        this.emit(true);
      });
      btn.classList.toggle("on", t.alignment === val);
      alignBox.append(btn);
    }
    seg.append(alignBox);

    if (!t.vertical) {
      this.row(s, __("段落間距")).append(
        this.numSlider(t.paragraphSpacingEm ?? 0, { min: 0, max: 3, step: 0.1 }, (v) => {
          t.paragraphSpacingEm = v > 0 ? v : undefined;
          this.emit(true);
        }, (v) => {
          t.paragraphSpacingEm = v > 0 ? v : undefined;
          this.emit(true);
        }),
      );
    }

    // 貼字寬（絕對對齊 2026-08-14）：ClaudeForge 或舊檔會殘留過寬的手動寬度，
    // 框的「空氣」全從這來——吸附咬的是框，框鬆了什麼都對不準。一鍵收乾淨。
    if (!t.vertical && t.manualWidth != null) {
      const sb = this.actBtn(ACT.fit, __("貼字寬"), () => {
        const p = this.project, b = this.block;
        if (p && b && snugTextWidth(measureCtx(), b, p.canvasWidth, p.pageHeight)) {
          this.rebuild();
          this.emit(true);
        }
      });
      sb.title = __("把框收到剛好包住字——斷行與字的位置都不會變");
      this.row(s, __("框寬")).append(sb);
    }

    this.row(s, __("直排")).append(this.check(t.vertical === true, (on) => {
      // additive 慣例：false 存成 undefined，舊檔 byte 不變
      t.vertical = on ? true : undefined;
      this.rebuild();
      this.emit(true);
    }));
    if (t.vertical) {
      // 直排預設由右到左（中文的閱讀順序）；打開＝改成由左到右
      this.row(s, __("欄序左起")).append(this.check(t.verticalLeftToRight === true, (on) => {
        t.verticalLeftToRight = on ? true : undefined;
        this.emit(true);
      }));
    }
    this.row(s, __("顏色")).append(this.swatches(t.colorHex ?? "000000", (hex) => {
      t.colorHex = hex;
      t.inkColor = undefined;   // 渲染以 run 屬性優先，改色要把它清掉才吃 colorHex
      this.emit(true);
    }));

    // ── 長文框：固定容器（會裁切、吃文繞圖），與貼字盒是兩種語意 ──
    const bs = this.section(__("長文框"));
    this.row(bs, __("長文框")).append(this.check(t.isBodyFrame === true, (on) => {
      if (on) {
        // 打開＝這個框從此由使用者定尺寸。先用目前的貼字盒當起點，
        // 太扁的話給一個能放進幾行的高度，不然打開的瞬間只看得到一行。
        t.isBodyFrame = true;
        const b = this.block!;
        t.manualWidth = Math.round(b.frame.w);
        t.manualHeight = Math.round(Math.max(b.frame.h, (t.fontSize ?? 49) * 4));
        b.frame.w = t.manualWidth;
        b.frame.h = t.manualHeight;
      } else {
        t.isBodyFrame = undefined;
        t.manualHeight = undefined;   // 關掉＝交還給貼字盒重算
      }
      this.rebuild();
      this.emit(true);
    }));
    if (t.isBodyFrame) {
      const box = this.row(bs, __("框大小"));
      const sync = (which: "w" | "h", v: number) => {
        const b = this.block!;
        if (which === "w") { t.manualWidth = v; b.frame.w = v; }
        else { t.manualHeight = v; b.frame.h = v; }
        this.emit(true);
      };
      box.append(
        this.num(Math.round(this.block!.frame.w), { min: 20, step: 1 }, (v) => sync("w", v)),
        this.num(Math.round(this.block!.frame.h), { min: 20, step: 1 }, (v) => sync("h", v)),
      );
      this.row(bs, __("框內對齊")).append(this.select(
        [["top", __("上")], ["middle", __("中")], ["bottom", __("下")]],
        t.verticalAlignment ?? "top",
        (v) => { t.verticalAlignment = v as TextBlock["verticalAlignment"]; this.emit(true); },
      ));
    }

    // ── 渲染層特效：只是畫上去，不影響量測與貼字盒 ──
    const fx = this.section(__("特效"));
    this.row(fx, __("陰影")).append(this.select(
      [["", __("無")], ["soft", __("柔和")], ["strong", __("明顯")]],
      t.shadowStyle ?? "",
      (v) => { t.shadowStyle = v || undefined; this.rebuild(); this.emit(); },
    ));
    if (t.shadowStyle) {
      this.row(fx, __("陰影色")).append(this.colorChip(t.shadowColorHex ?? "000000", (hex) => {
        t.shadowColorHex = hex; this.emit();
      }));
    }
    const bgOn = this.row(fx, __("底色"));
    bgOn.append(this.check(t.backgroundColorHex != null, (on) => {
      t.backgroundColorHex = on ? (t.backgroundColorHex ?? "FFE066") : undefined;
      this.rebuild();
      this.emit();
    }));
    if (t.backgroundColorHex != null) {
      bgOn.append(this.colorChip(t.backgroundColorHex, (hex) => { t.backgroundColorHex = hex; this.emit(); }));
    }
  }

  private shape(sh: ShapeBlock): void {
    const s = this.section(__("形狀"));
    this.row(s, __("類型")).append(this.select(
      [["rectangle", __("矩形")], ["ellipse", __("圓形")], ["line", __("線條")]],
      sh.kind,
      (v) => { sh.kind = v as ShapeBlock["kind"]; this.rebuild(); this.emit(); },
    ));
    this.row(s, __("顏色")).append(this.swatches(sh.colorHex, (hex) => { sh.colorHex = hex; this.emit(); }));
    if (sh.kind === "rectangle") {
      this.row(s, __("圓角")).append(
        // 數值＋拉桿（2026-09-05 小高：「拉圓角要看得到數值，不然每次拉的不一樣大」）
        this.numSlider(sh.cornerRadius ?? 0, { min: 0, max: 200, step: 1 },
          (v) => { sh.cornerRadius = v; this.emit(); }, (v) => { sh.cornerRadius = v; this.emit(); }),
      );
    }
    if (sh.kind === "line") {
      // 下限 0.25、一格 0.25——與 iOS 端 2026-08-01 的髮絲線修正同規格
      this.row(s, __("粗細")).append(
        this.numSlider(sh.lineWidth ?? 8, { min: 0.25, max: 60, step: 0.25 }, (v) => { sh.lineWidth = v; this.emit(); }, (v) => { sh.lineWidth = v; this.emit(); }),
      );
    }
    this.wrapControls(s, () => sh);
  }

  private media(b: Block, m: MediaBlock): void {
    const s = this.section(b.content.type === "video" ? __("影片") : __("圖片"));
    const pick = this.btn(m.assetFileName ? __("更換圖片／影片…") : __("選擇圖片／影片…"),
                          () => this.hooks.fillMedia(b));
    this.row(s, __("素材")).append(pick);
    // 多圖輪播：加圖的按鈕就長在選檔旁邊（使用者定案：新增圖片時旁邊有一顆），
    // 有圖之後才出現間隔／切換方式——沒開輪播的人不用看到這些
    if (b.content.type === "image" && m.assetFileName && this.hooks.addCarousel) {
      const n = m.carouselAssets?.length ?? 0;
      const carouselRow = this.row(s, __("輪播"));
      carouselRow.append(this.btn(__("加輪播圖…"), () => this.hooks.addCarousel!(b)));
      if (n) {
        carouselRow.append(this.btn(__("清空"), () => {
          m.carouselAssets = undefined;
          m.carouselInterval = undefined;
          m.carouselMode = undefined;
          m.carouselDir = undefined;
          this.rebuild(); this.emit();
        }));
        this.row(s, __("輪播間隔")).append(
          this.num(m.carouselInterval ?? CAROUSEL_INTERVAL, { min: 0.2, max: 10, step: 0.1 },
                   (v) => { m.carouselInterval = v; this.emit(); this.hooks.playAnim?.(b); }),
        );
        this.row(s, __("切換方式")).append(this.select(
          [["cut", __("直切")], ["maskWipe", __("連續遮罩")]],
          m.carouselMode ?? "cut",
          (v) => {
            m.carouselMode = v as MediaBlock["carouselMode"];
            this.rebuild(); this.emit(); this.hooks.playAnim?.(b);
          },
        ));
        // 遮罩帶同方向位移，所以要給方向（與入場 maskWipe 同語彙）
        if (m.carouselMode === "maskWipe") {
          this.row(s, __("方向")).append(this.select(
            [["left", __("從左")], ["right", __("從右")], ["up", __("從上")], ["down", __("從下")]],
            m.carouselDir ?? "left",
            (v) => { m.carouselDir = v as MediaBlock["carouselDir"]; this.emit(); this.hooks.playAnim?.(b); },
          ));
        }
      }
    }
    this.row(s, __("濾鏡")).append(this.select(
      [["", __("無")], ...FILTER_KEYS.map((k) => [k, FILTER_LABELS[k]] as [string, string])],
      m.filterKey ?? "",
      (v) => {
        m.filterKey = v || undefined;
        // 變體要先生成再重畫，否則會閃一格佔位框
        this.hooks.ensureVariant(b).then(() => { this.rebuild(); this.emit(); });
      },
    ));
    if (m.filterKey === "c5") this.risoRows(s, b, m);
    // 去背——與「遮罩」是兩件事：遮罩是幾何形狀，去背是照片內容的主體輪廓。
    // 兩者可以並存（先被形狀裁、再被去背裁），所以分成兩列不合併。
    if (this.hooks.makeMatte && m.assetFileName) {
      if (this.hooks.matteModel) {
        const mm = this.hooks.matteModel;
        const mrow = this.row(s, __("模型"));
        mrow.append(this.select(
          [["vision", __("內建")],
           ["birefnet", mm.installed() ? "BiRefNet" : __("BiRefNet（下載 109 MB）")]],
          mm.get(),
          (v) => { void mm.choose(v).finally(() => this.rebuild()); },
        ));
        if (mm.installed()) {
          mrow.append(this.btn(__("移除模型"), () => { void mm.remove().finally(() => this.rebuild()); }));
        }
      }
      const row = this.row(s, __("去背"));
      { const nt = document.createElement("i"); nt.className = "new-tag"; nt.textContent = "New"; row.append(nt); }
      const run = this.btn(m.matteFileName ? __("重跑") : __("去背"), () => void (async () => {
        row.querySelectorAll("button").forEach((n) => { (n as HTMLButtonElement).disabled = true; });
        // finally 一定要有：中途爆掉而沒解鎖的話，整列鈕就永遠是灰的，
        // 使用者看到的是「按了沒反應」——比一個錯誤訊息難查得多。
        try {
          const msg = await this.hooks.makeMatte!(b);
          if (msg) this.hooks.onChange(); // 訊息由殼層的狀態列顯示（面板沒有訊息位）
        } finally {
          this.rebuild();
        }
      })());
      row.append(run);
      if (m.matteFileName && this.hooks.editMatte) {
        row.append(this.btn(__("修…"), () => { void this.hooks.editMatte!(b); }));
      }
      if (m.matteFileName) {
        row.append(this.btn(__("移除"), () => {
          m.matteFileName = undefined; m.matteInverted = undefined;
          this.rebuild(); this.emit();
        }));
      }
      // 填材質＝參考圖那個效果：疊一層材質、用同一張遮罩挖出主體，
      // 底下那張變回完整的照片。手動要四步，這一列一次做完。
      if (m.matteFileName && this.hooks.fillTexture && this.hooks.matteTextures) {
        const fillRow = this.row(s, __("填材質"));
        const grid = document.createElement("div");
        grid.className = "swgrid";                 // 一排放不下就換行，別溢出面板
        fillRow.append(grid);
        const fill = (key: string | null) => {
          fillRow.querySelectorAll("button").forEach((n) => { (n as HTMLButtonElement).disabled = true; });
          void this.hooks.fillTexture!(b, key).finally(() => this.rebuild());
        };
        // 按鈕框本身就是那塊材質——名字只留在 hover 的 title，一排小方塊比一排字好認
        const swatch = (title: string, url: string | null, run: () => void): HTMLButtonElement => {
          const n = document.createElement("button");
          n.className = url ? "texsw" : "texsw plain dashed";
          n.title = title;
          if (url) n.style.backgroundImage = `url('${url}')`;
          else n.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" '
            + 'stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
          n.onclick = run;
          return n;
        };
        for (const t of this.hooks.matteTextures()) {
          grid.append(swatch(t.label, t.url, () => fill(t.key)));
        }
        grid.append(swatch(__("自選…"), null, () => fill(null)));
      }
      // 填顏色：跟填材質同一件事，素材是純色。色票與 iPad 那排同一組
      //（同一顆 App 裡不該有兩套色票），最後一顆是系統選色器＝任何顏色。
      if (m.matteFileName && this.hooks.fillColor) {
        const colorRow = this.row(s, __("填顏色"));
        const cgrid = document.createElement("div");
        cgrid.className = "swgrid";                // 六顆色票＋自訂＝一排放不下，要換行
        colorRow.append(cgrid);
        const run = (hex: string) => {
          colorRow.querySelectorAll("button").forEach((n) => { (n as HTMLButtonElement).disabled = true; });
          void this.hooks.fillColor!(b, hex).finally(() => this.rebuild());
        };
        for (const hex of QUICK) {
          const n = document.createElement("button");
          n.className = "texsw";
          n.title = `#${hex}`;
          n.style.background = `#${hex}`;
          n.onclick = () => run(hex);
          cgrid.append(n);
        }
        // 選色器拖動中會逐格發 input——不收斂的話每一格都生一個色檔＋一步 undo。
        // 停 0.4 秒才落一次，與 iPad 端 settleFillColor 同一套收斂邏輯。
        // 開火前驗 b 還在不在專案裡：系統選色器活得比面板久，400ms 內 undo／換選取
        // 的話，這顆 timer 沒資格再動專案。
        // 自訂顏色做成跟「自選…」同一顆的樣子（虛線＋加號），原生選色器透明疊在上面。
        // 原本是一顆 34×22 的裸 input 排在六顆 36px 色票後面——那一排寬度直接超出
        // 252px 的面板，這顆被推到看不見也點不到的地方（2026-09-01 小高回報）。
        const pick = document.createElement("label");
        pick.className = "texsw plain dashed swpick";
        pick.title = __("自訂顏色…");
        pick.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" '
          + 'stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
        pick.append(this.color("FFFFFF", (hex) => {
          window.clearTimeout(this.fillSettle);
          this.fillSettle = window.setTimeout(() => {
            if (!this.project?.blocks.some((k) => k.id === b.id)) return;
            run(hex);
          }, 400);
        }));
        cgrid.append(pick);
      }
      if (m.matteFileName) {
        this.row(s, __("保留哪一邊")).append(this.select(
          [["", __("主體")], ["1", __("背景")]],
          m.matteInverted ? "1" : "",
          (v) => { m.matteInverted = v ? true : undefined; this.emit(); },
        ));
      }
    }
    this.row(s, __("遮罩")).append(this.select(
      [["", __("無")], ["rectangle", __("圓角矩形")], ["ellipse", __("橢圓")]],
      m.maskShape ?? "",
      (v) => {
        m.maskShape = (v || undefined) as MediaBlock["maskShape"];
        if (v !== "rectangle") m.maskCornerRadius = undefined;
        this.rebuild();
        this.emit();
      },
    ));
    if (m.maskShape === "rectangle") {
      // 存的是「短邊一半」的分數
      this.row(s, __("圓角")).append(
        // 0–100（％短邊）顯示數值；存的仍是 0…1 分數
        this.numSlider(Math.round((m.maskCornerRadius ?? 0) * 100), { min: 0, max: 100, step: 1 },
          (v) => { m.maskCornerRadius = v / 100; this.emit(); }, (v) => { m.maskCornerRadius = v / 100; this.emit(); }),
      );
    }
    // 外框要「寬＋色」同時存在才會渲染——單獨動任一個都自動補上另一個的預設，
    // 不然使用者調了外框寬、畫面毫無反應（色票顯示白色但其實沒存過，2026-08-08 實案）
    this.row(s, __("外框色")).append(this.colorChip(m.strokeHex ?? "FFFFFF", (hex) => {
      m.strokeHex = hex;
      if (!m.strokeWidth) { m.strokeWidth = 0.01; this.rebuild(); }
      this.emit();
    }));
    this.row(s, __("外框寬")).append(
      // 短邊的分數制——所以跨畫布尺寸會等比（與圖形線的點數制不同，是 iOS 的原始設計）
      this.numSlider(m.strokeWidth ?? 0, { min: 0, max: 0.15, step: 0.005 }, (v) => {
        m.strokeWidth = v > 0 ? v : undefined;
        if (v > 0 && !m.strokeHex) m.strokeHex = "FFFFFF";
        this.emit();
      }, (v) => {
        m.strokeWidth = v > 0 ? v : undefined;
        if (v > 0 && !m.strokeHex) m.strokeHex = "FFFFFF";
        this.emit();
      }),
    );
    this.stickerRows(s, m);
    this.tornRows(s, b, m);
    if (m.assetFileName) {
      // 拉直：轉的是**內容**不是 block（與 iOS 裁切畫面的那個角度同一個欄位）
      this.row(s, __("拉直")).append(
        this.numSlider(m.rotationDegrees ?? 0, { min: -45, max: 45, step: 0.5 }, (v) => {
          m.rotationDegrees = v !== 0 ? v : undefined;
          this.emit();
        }, (v) => {
          m.rotationDegrees = v !== 0 ? v : undefined;
          this.emit();
        }),
      );
      // 裁切比例：改的是 block 的框（照片不動、裁切區跟著），與八點裁切同一套語意
      this.row(s, __("裁切比例")).append(this.select(
        [["", __("自由")], ["1:1", "1:1"], ["4:5", "4:5"], ["3:4", "3:4"], ["16:9", "16:9"], ["9:16", "9:16"]],
        "",
        (v) => {
          if (!v) return;
          const [rw, rh] = v.split(":").map(Number);
          this.applyCropRatio(b, m, rw / rh);
        },
      ));
    }
    this.wrapControls(s, () => m);
  }

  /**
   * 把媒體框改成指定比例：**短邊不動、長邊收進去**（只會裁不會放大，
   * 不然會露出素材以外的空白），並且以框的中心為錨——照片本身不移動。
   */
  private applyCropRatio(b: Block, m: MediaBlock, ratio: number): void {
    const f = b.frame;
    const cur = f.w / f.h;
    const w = cur > ratio ? f.h * ratio : f.w;
    const h = cur > ratio ? f.h : f.w / ratio;
    const c = m.cropRect;
    const uncropped = !(c.w > 0.001 && c.h > 0.001) || (c.w > 0.999 && c.h > 0.999);
    if (!uncropped) {
      // 已經裁過的：裁切區照同一個比例收（框收多少、裁切區收多少）
      const kw = w / f.w, kh = h / f.h;
      m.cropRect = {
        x: c.x + (c.w * (1 - kw)) / 2, y: c.y + (c.h * (1 - kh)) / 2,
        w: c.w * kw, h: c.h * kh,
      };
    }
    b.frame = { x: f.x + (f.w - w) / 2, y: f.y + (f.h - h) / 2, w, h };
    this.rebuild();
    this.emit();
  }


  /** 排開文字（文繞圖）。只對**長文框**有效果——標題文字的框是貼字盒，
   *  被洞擠開只會把尾巴推出框外，所以 iOS 端當初就把範圍限死在長文框。 */
  private wrapControls(
    parent: HTMLElement,
    get: () => { excludesText?: boolean; textWrapMode?: string },
  ): void {
    const o = get();
    this.row(parent, __("排開文字")).append(this.check(o.excludesText === true, (on) => {
      o.excludesText = on ? true : undefined;
      this.rebuild();
      this.emit(true);
    }));
    if (o.excludesText) {
      this.row(parent, __("排開方式")).append(this.select(
        [["side", __("單側")], ["around", __("兩側")], ["push", __("上下")]],
        o.textWrapMode ?? "side",     // 與 iOS TextWrapMode.init 相同：未設＝單側
        (v) => { o.textWrapMode = v; this.emit(true); },
      ));
      // 排開只咬得住長文框。這一頁沒有的話就直說——不講的話開了沒反應，
      // 會被當成「功能沒做」。
      const p = this.project;
      const page = this.hooks.layers.currentPage();
      const hasBody = !!p && p.blocks.some((k) =>
        (k.content.type === "text" || k.content.type === "textFlow")
        && k.content.text.isBodyFrame === true
        && Math.floor((k.frame.x + k.frame.w / 2) / p.canvasWidth) === page);
      if (!hasBody) {
        const warn = document.createElement("div");
        warn.className = "hint pinhint warn";
        warn.textContent = __("這一頁沒有長文框，排開不會有反應——選那段文字，把「長文框」打開");
        parent.append(warn);
      }
    }
  }

  // ── DOM 小工具 ──────────────────────────────────────────────────────

  private emit(retext = false): void { this.hooks.onChange(retext ? { retext: true } : undefined); }

  private section(titleText: string): HTMLElement {
    const h = document.createElement("h3");
    h.textContent = titleText;
    this.el.append(h);
    return this.el;
  }


  /** 這一頁有沒有「會播的內容」（影片／輪播／3D 展示／塗鴉巡線）。
   *  有＝停留自動跟著播放長度（core/anim effectiveHold），停留鈕換成說明章
   *  （2026-08-26 使用者定：只有純出場動畫的頁才需要手動停留）。 */
  private pagePlayback(): { auto: boolean; video: boolean } {
    const proj = this.project;
    if (!proj) return { auto: false, video: false };
    const page = pageRect(proj, this.hooks.layers.currentPage());
    let auto = false, video = false;
    for (const b of proj.blocks) {
      if (!(b.frame.x < page.x + page.w && page.x < b.frame.x + b.frame.w
            && b.frame.y < page.y + page.h && page.y < b.frame.y + b.frame.h)) continue;
      const c = b.content;
      if (c.type === "video" && c.media.assetFileName) { auto = true; video = true; }
      else if (c.type === "image" && c.media.carouselAssets?.length) auto = true;
      else if (c.type === "model" && c.model.mode) auto = true;
      else if (c.type === "doodle" && c.doodle.play === "travel") auto = true;
    }
    return { auto, video };
  }

  /** 停留列：手動秒數，或（頁上有會播的內容時）「隨影片播完」章。 */
  private holdRow(parent: HTMLElement, onChange?: () => void): void {
    const row = this.row(parent, __("停留"));
    const pb = this.pagePlayback();
    if (pb.auto) {
      const tag = document.createElement("span");
      tag.className = "holdauto";
      tag.textContent = pb.video ? __("隨影片播完") : __("隨循環播完");
      tag.title = __("這一頁有會播的內容——停留自動跟著最長的播放長度，影片不會被腰斬。");
      row.append(tag);
      return;
    }
    const proj = this.project;
    if (!proj) return;
    row.append(this.num(proj.animHold ?? ANIM_HOLD, { min: 0, max: ANIM_HOLD_MAX, step: 0.5 },
                        (v) => { proj.animHold = v; this.emit(); onChange?.(); }));
  }

  /** c5 孔版參數列（2026-08-31）。調參數＝先低清即烤（快、不卡拖曳）再防抖全清重烤，
   *  兩段都走 ensureVariant——鍵是 filterSig，參數變了鍵就變，不會拿到舊圖。 */
  private risoRows(s: HTMLElement, b: Block, m: MediaBlock): void {
    const p = risoOf(m);
    const live = () => { void this.hooks.ensureVariant(b, true).then(() => this.emit()); };
    const commit = () => { void this.hooks.ensureVariant(b).then(() => this.emit()); };
    // 三組定案配方（工具間同款一鍵）：整組參數回定案值
    const pr = this.row(s, __("配方"));
    for (const ps of RISO_PRESETS) {
      pr.append(this.btn(ps.name, () => {
        m.risoInks = [...ps.inks];
        m.risoPaper = undefined; m.risoPitch = undefined; m.risoHard = undefined;
        m.risoReg = undefined; m.risoDens = undefined; m.risoGrain = undefined;
        this.rebuild(); commit();
      }));
    }
    // ⚠️ 每個 handler 都要**當場**重讀 risoOf(m)，不能用外面那份 p：
    // p 是建面板那一刻的快照，改完第一支墨之後它就過期了，
    // 接著改第二支會拿舊陣列覆寫回去＝第一支的新顏色被吃掉（面板顯示新的、圖是舊的）。
    p.inks.forEach((ink, i) => {
      const r = this.row(s, i === 0 ? __("油墨") : "");
      const ic = this.colorChip(ink, (hex) => {
        const inks = [...risoOf(m).inks]; inks[i] = hex;
        m.risoInks = inks; live();
      }, commit);   // 選定＝全清重烤
      r.append(ic);
      if (p.inks.length > 1) {
        r.append(this.btn("×", () => {
          m.risoInks = risoOf(m).inks.filter((_, j) => j !== i);
          this.rebuild(); commit();
        }));
      }
    });
    if (p.inks.length < 3) {
      this.row(s, "").append(this.btn(__("＋加一支油墨"), () => {
        m.risoInks = [...risoOf(m).inks, "404040"];
        this.rebuild(); commit();
      }));
    }
    const pc = this.colorChip(p.paper, (hex) => { m.risoPaper = hex; live(); }, commit);
    this.row(s, __("紙色")).append(pc);
    const slider = (label: string, val: number, min: number, max: number, st: number,
                    set: (v: number) => void): void => {
      const el = this.range(val, min, max, st, (v) => { set(v); live(); });
      el.addEventListener("change", commit);     // 放手＝全解析度重烤
      this.row(s, label).append(el);
    };
    slider(__("網點間距"), p.pitch, 2, 12, 0.5, (v) => { m.risoPitch = v; });
    slider(__("網點硬度"), p.hard, 0, 1, 0.05, (v) => { m.risoHard = v; });
    slider(__("套印偏移"), p.reg, 0, 4, 0.25, (v) => { m.risoReg = v; });
    slider(__("油墨濃度"), p.dens, 0.5, 1.8, 0.05, (v) => { m.risoDens = v; });
    // 上限從 24 拉到 60（2026-09-01）：顆粒是 `(hash−0.5)×grain`，也就是 **±grain/2**，
    // 24 檔滿格只有 ±12/255（實測平均差 6、最大差 12），疊在網點上根本看不出來——
    // 小高：「顆粒拉桿拉了沒什麼反應，那能幹嘛？」。**預設 7 不動**，只是把上面那段
    // 沒作用的路加長到真的看得見（±30/255）。c5 還沒發過版，改範圍不影響任何既有專案。
    slider(__("紙張顆粒"), p.grain, 0, 60, 1, (v) => { m.risoGrain = v; });
  }

  /** 貼紙邊（2026-08-28 分支收回主線）＝輪廓往外擴一圈實色，讓去背圖／貼圖像模切貼紙。
   *  與「外框」是兩件事：外框描的是**框**（矩形／橢圓），這條描的是**輪廓**。
   *  iOS 端 1.2.0 起已出貨（MaskPanel.stickerSection），欄位、預設值、滑桿範圍都照那邊。
   *  數字欄在這個級距沒用：num 顯示是兩位小數，0.012 會被印成 0.01，所以全用滑桿。 */
  private stickerRows(s: HTMLElement, m: MediaBlock): void {
    if (!m.assetFileName) return;
    const edgeRow = this.row(s, __("貼紙邊"));
    if (!(m.matteEdgeWidth ?? 0)) {
      edgeRow.append(this.btn(__("加上"), () => {
        m.matteEdgeWidth = 0.02;
        m.matteEdgeHex ??= "FFFFFF";
        m.matteEdgeBevel ??= 0.6;   // 2026-08-28 小高看樣張定案（邊 0.02＋白＋立體感 0.6）
        this.rebuild(); this.emit();
      }));
      return;
    }
    edgeRow.append(this.range(m.matteEdgeWidth ?? 0.02, 0.004, 0.06, 0.002, (v) => {
      m.matteEdgeWidth = v; this.emit();
    }));
    edgeRow.append(this.colorChip(m.matteEdgeHex ?? "FFFFFF", (hexv) => {
      m.matteEdgeHex = hexv; this.emit();
    }));
    edgeRow.append(this.btn(__("移除"), () => {
      m.matteEdgeWidth = undefined;
      m.matteEdgeHex = undefined;
      m.matteEdgeBevel = undefined;
      this.rebuild(); this.emit();
    }));
    // 斜面浮雕：沿輪廓內側一白一灰。貼紙很扁，是「調得很小」的那種浮雕
    this.row(s, __("立體感")).append(
      this.range(m.matteEdgeBevel ?? 0, 0, 1, 0.05, (v) => {
        m.matteEdgeBevel = v > 0 ? v : undefined; this.emit();
      }),
    );
  }

  /** 撕紙邊（2026-08-31，工具間濾鏡工坊同款邊緣系統）。只動 block 欄位不動變體——
   *  邊是渲染時從快取畫布蓋上去的，blockSig 吃整塊 JSON、切圖快取自動重烤。 */
  private tornRows(s: HTMLElement, _b: Block, m: MediaBlock): void {
    this.row(s, __("撕紙邊")).append(this.select(
      [["", __("無")], ["riso", __("孔版粗邊")], ["torn", __("撕毛邊")],
       ["tear", __("真撕紙")], ["feather", __("羽化")]],
      m.tornStyle ?? "",
      (v) => {
        if (!v) {
          m.tornStyle = undefined; m.tornSides = undefined; m.tornAmt = undefined;
          m.tornDeform = undefined; m.tornRough = undefined; m.tornSeed = undefined;
        } else {
          m.tornStyle = v;   // 其他欄位 absent＝預設（見 tornedge.ts TORN_DEFAULTS）
        }
        this.rebuild(); this.emit();
      },
    ));
    if (!m.tornStyle) return;
    const sides = m.tornSides ?? TORN_DEFAULTS.sides;
    // 上右下左＝「畫布方向」（2026-09-05 小高定案）：物件轉了 90°，點「下」還是撕畫面上的下邊。
    // 檔案裡存的仍是物件自己的邊——只在這裡換算，舊專案渲染一個 px 不動。
    const rot = this.block?.rotation ?? 0;
    const sr = this.row(s, __("邊"));
    ([[__("上"), 0], [__("右"), 1], [__("下"), 2], [__("左"), 3]] as [string, number][])
      .forEach(([name, canvasIdx]) => {
        const bit = 1 << tornLocalSide(canvasIdx, rot);
        const lbl = document.createElement("label");
        lbl.append(this.check((sides & bit) !== 0, (on) => {
          m.tornSides = on ? (m.tornSides ?? TORN_DEFAULTS.sides) | bit
                           : (m.tornSides ?? TORN_DEFAULTS.sides) & ~bit;
          this.emit();
        }), name);
        sr.append(lbl);
      });
    const slider = (label: string, val: number, min: number, max: number, st: number,
                    set: (v: number) => void): void => {
      this.row(s, label).append(this.range(val, min, max, st, (v) => { set(v); this.emit(); }));
    };
    slider(__("咬深"), m.tornAmt ?? TORN_DEFAULTS.amt, 0.01, 0.15, 0.005, (v) => { m.tornAmt = v; });
    // 羽化＝均勻漸淡，`tornedge.ts` 那條分支完全沒吃 deform／rough／seed。
    // 擺出來只會讓人以為壞了，還每動一下就全尺寸重烤＋記一筆 undo，所以直接不顯示。
    if (m.tornStyle === "feather") return;
    slider(__("變形隨機"), m.tornDeform ?? TORN_DEFAULTS.deform, 0, 1, 0.05, (v) => { m.tornDeform = v; });
    slider(__("深淺隨機"), m.tornRough ?? TORN_DEFAULTS.rough, 0, 1, 0.05, (v) => { m.tornRough = v; });
    this.row(s, "").append(this.btn(__("換一個邊"), () => {
      m.tornSeed = ((m.tornSeed ?? TORN_DEFAULTS.seed) + 1) % 9999;
      this.emit();
    }));
  }

  private row(parent: HTMLElement, label: string): HTMLDivElement {
    const r = document.createElement("div");
    r.className = "row";
    const l = document.createElement("label");
    l.textContent = label;
    r.append(l);
    parent.append(r);
    return r;
  }

  /** 數字欄＋拉桿一組（2026-09-05 小高：「填空按上下鍵太死板，要拉桿」）。
   *  拉桿拖動＝live（呼叫端決定要不要落 undo、不重建面板）；放手或欄位改值＝commit。 */
  private numSlider(value: number, opts: { min: number; max: number; step: number },
                    live: (v: number) => void, commit: (v: number) => void): HTMLSpanElement {
    const wrap = document.createElement("span");
    wrap.className = "ns";
    const r = document.createElement("input");
    r.type = "range"; r.min = String(opts.min); r.max = String(opts.max); r.step = String(opts.step);
    r.value = String(value);
    const n = document.createElement("input");
    n.type = "number"; n.min = r.min; n.max = r.max; n.step = r.step;
    n.value = String(Math.round(value * 100) / 100);
    r.addEventListener("input", () => { n.value = r.value; live(Number(r.value)); });
    r.addEventListener("change", () => commit(Number(r.value)));
    n.addEventListener("change", () => {
      const v = Number(n.value);
      if (!Number.isFinite(v)) return;
      const c = Math.min(opts.max, Math.max(opts.min, v));
      n.value = String(c); r.value = String(c); commit(c);
    });
    wrap.append(r, n);
    return wrap;
  }

  private num(value: number, opts: { min?: number; max?: number; step?: number; disabled?: boolean; mixed?: boolean },
              set: (v: number) => void): HTMLInputElement {
    const i = document.createElement("input");
    i.type = "number";
    if (opts.min != null) i.min = String(opts.min);
    if (opts.max != null) i.max = String(opts.max);
    i.step = String(opts.step ?? 1);
    // mixed＝多選時值不一致：欄位留空、顯示破折號，打了值才套用到全部
    if (opts.mixed) i.placeholder = "—";
    else i.value = String(Math.round(value * 100) / 100);
    i.disabled = !!opts.disabled;
    i.addEventListener("change", () => {
      let v = Number(i.value);
      if (!Number.isFinite(v)) return;
      // 手打的值也要守 min/max——外框寬存的是「短邊比例」，使用者打 1（以為是 1px）
      // 曾直接存成 100% 短邊的毒值（2026-08-08 實案）
      if (opts.min != null && v < opts.min) v = opts.min;
      if (opts.max != null && v > opts.max) v = opts.max;
      i.value = String(v);
      set(v);
    });
    return i;
  }

  private range(value: number, min: number, max: number, stepV: number, set: (v: number) => void): HTMLInputElement {
    const i = document.createElement("input");
    i.type = "range";
    i.min = String(min); i.max = String(max); i.step = String(stepV);
    i.value = String(value);
    i.addEventListener("input", () => set(Number(i.value)));
    return i;
  }

  /** 顏色鈕：一顆顯示目前色的小方塊，點開是我們自己的選色面板（colorpop.ts）——
   *  色票／深淺／標準色／灰階／任何顏色。取代直接露 WebKit 的原生色格（2026-09-05 小高：
   *  「跳出來的預設色票一大群……希望裡面是標準色和我們配色的深淺」）。
   *  done＝選定後要做的收尾（孔版的 commit 全清重烤）。 */
  private colorChip(cur: string, set: (hexNoHash: string) => void, done?: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cchip";
    b.title = `#${cur}`;
    b.style.background = `#${cur}`;
    b.addEventListener("click", () => openColorPop(b, cur, {
      live: (hex) => { b.style.background = `#${hex}`; set(hex); },
      pick: (hex) => { b.style.background = `#${hex}`; b.title = `#${hex}`; cur = hex; set(hex); done?.(); },
    }));
    return b;
  }

  /** 色票列（2026-09-05 小高定案「傳統色」）：共用色票＋自訂（原生選色器透明疊在虛線那顆上）。
   *  取代以前直接露一顆 <input type=color>——那顆點開是 WebKit 的螢光色格，跟 App 的色沒關係。
   *  `cur` 對得上就亮那顆；自訂那顆帶目前色，點開就從目前色出發。 */
  private swatches(cur: string, set: (hexNoHash: string) => void, list: readonly string[] = QUICK): HTMLDivElement {
    const grid = document.createElement("div");
    grid.className = "swgrid";
    const curU = cur.toUpperCase();
    const mark = (on: HTMLElement | null): void => {
      grid.querySelectorAll(".swsm").forEach((k) => k.classList.toggle("on", k === on));
    };
    for (const hex of list) {
      const n = document.createElement("button");
      n.type = "button";
      n.className = "texsw swsm" + (hex === curU ? " on" : "");
      n.title = `#${hex}`;
      n.style.background = `#${hex}`;
      n.onclick = () => { set(hex); mark(n); };
      grid.append(n);
    }
    const pick = document.createElement("button");
    pick.type = "button";
    pick.className = "texsw swsm plain dashed";
    pick.title = __("自訂顏色…");
    pick.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" '
      + 'stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
    pick.addEventListener("click", () => openColorPop(pick, cur, {
      live: (hex) => { set(hex); mark(null); },
      pick: (hex) => { cur = hex; set(hex); mark(null); },
    }));
    grid.append(pick);
    return grid;
  }

  private color(hexNoHash: string, set: (hexNoHash: string) => void): HTMLInputElement {
    const i = document.createElement("input");
    i.type = "color";
    i.value = `#${hexNoHash.slice(0, 6).padEnd(6, "0")}`;
    i.addEventListener("input", () => set(i.value.slice(1).toUpperCase()));
    return i;
  }

  /** 字型選單：介面字體／自訂（匯入檔）／系統字體 三組（剪映同款分法），
   *  最底下一列「匯入字型檔…」當動作項。正在用的字型三組都找不到時
   *  （別台電腦做的專案）補一個「未安裝」項，選單才不會靜靜跳回黑體。
   *  多選批次改也走這顆（mixed＝各用各的字型時顯示「（混合）」；
   *  匯入動作項只在單選給——匯完要重建面板，群組面板沒有這條路）。 */
  private fontSelect(cur: string, apply: (v: string) => void,
                     o: { mixed?: boolean; allowImport?: boolean } = {}): HTMLSelectElement {
    const sel = document.createElement("select");
    const group = (label: string, items: { label: string; value: string }[]): void => {
      if (!items.length) return;
      const g = document.createElement("optgroup");
      g.label = label;
      for (const f of items) {
        const opt = document.createElement("option");
        opt.value = f.value; opt.textContent = f.label;
        g.append(opt);
      }
      sel.append(g);
    };
    group(__("介面字體"), FONT_CHOICES);
    group(__("字體商店"), fontCatalog.store);
    group(__("自訂"), fontCatalog.custom);
    group(__("系統字體"), fontCatalog.system);
    if (!o.mixed && cur && ![...sel.options].some((x) => x.value === cur)) {
      const opt = document.createElement("option");
      opt.value = cur; opt.textContent = __f("{cur}（未安裝）", { cur });
      sel.append(opt);
    }
    if (o.allowImport && this.hooks.importFont) {
      const imp = document.createElement("option");
      imp.value = "__import__"; imp.textContent = __("＋ 匯入字型檔…");
      sel.append(imp);
    }
    if (o.mixed) {
      const m = document.createElement("option");
      m.value = "__mixed__"; m.textContent = __("（混合）"); m.disabled = true;
      sel.prepend(m);
      sel.value = "__mixed__";
    } else {
      sel.value = cur;
    }
    sel.addEventListener("change", () => {
      if (sel.value === "__import__") {
        sel.value = o.mixed ? "__mixed__" : cur;   // 先跳回原值——取消匯入時選單不能停在動作項上
        void this.hooks.importFont?.().then((f) => {
          if (!f) return;
          apply(f.value);
          this.show(this.project, this.block);   // 重建面板：新字型進選單並選中
        });
        return;
      }
      apply(sel.value);
    });
    return sel;
  }

  private select(options: [string, string][], value: string, set: (v: string) => void): HTMLSelectElement {
    const sel = document.createElement("select");
    for (const [v, label] of options) {
      const o = document.createElement("option");
      o.value = v; o.textContent = label;
      sel.append(o);
    }
    sel.value = value;
    sel.addEventListener("change", () => set(sel.value));
    return sel;
  }

  private check(on: boolean, set: (on: boolean) => void): HTMLInputElement {
    const i = document.createElement("input");
    i.type = "checkbox";
    i.checked = on;
    i.addEventListener("change", () => set(i.checked));
    return i;
  }

  private btn(label: string, fn: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.addEventListener("click", fn);
    return b;
  }

  /** icon＋文字動作鈕（蘋果式）：icon 在前當輔助、文字保底；縮字不砍字。 */
  private actBtn(icon: string, label: string, fn: () => void): HTMLButtonElement {
    const b = this.btn(label, fn);
    b.insertAdjacentHTML("afterbegin", icon);
    b.classList.add("act");
    return b;
  }

  /** icon 按鈕：圖示進 innerHTML、人話進 title/aria-label（滑過仍查得到意思）。 */
  private iconBtn(icon: string, label: string, fn: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "icon";
    b.innerHTML = icon;
    b.title = label;
    b.setAttribute("aria-label", label);
    b.addEventListener("click", fn);
    return b;
  }
}
