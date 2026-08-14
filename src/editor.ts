// Mac 殼的互動畫布。DOM／指標事件都收在這一層，`core/` 保持平台無關。
//
// ⚠️ 指標座標鐵則（STB 1.4.1 整天實證換來的）：
// **絕不用 `getBoundingClientRect()` 當原點。** 整頁 CSS zoom 下它有兩個獨立的雷——
// 語意分裂（舊 WebKit 回版面 px、標準化後回視覺 px，macOS 與 iPadOS 同代不同行為，
// 且 iOS 依編譯 SDK 判定，升 Xcode 重編就可能靜默翻面）與捲動污染。
// `offsetX/offsetY` 取自**真事件**是唯一兩種語意下都乾淨、也不受捲動影響的量。
// rect 只配拿來量尺寸。

import type { Block, MediaBlock, Project, Rect, TextBlock } from "./core/schema";
import { hex, resolvedFontSize, resolvedKerning } from "./core/schema";
import { aspectFillCrop, pageIndexForX, pageRect, stageBounds } from "./core/geometry";
import { cssFont } from "./core/fonts";
import { autoFitText, naturalSize, naturalTextSize, renderStage, textPrintLines } from "./core/render";
import type { FilterAssets } from "./core/filters";
import { resolvePosition, rotatedBounds, equalSpacingBadges, snapGuide, snapResizingEdge, type GuideLine, type SnapStrength, type SpacingBadge } from "./core/align";

interface View { scale: number; tx: number; ty: number }

// ── 八點裁切的手把 ────────────────────────────────────────────────────
// iOS 定案（2026-07-05 上線）的兩種角色，逐條照搬：
//   **角＝等比縮放**——對角錨定、不動 cropRect，同一塊畫面只是變大變小。
//   **邊＝真裁切**——拉哪邊裁哪邊，**照片本身不動**（frame 與 cropRect 同步收放，
//   所以錨定側看到的畫面一模一樣）；往外拉可以把藏起來的部分露回來，到圖的邊緣為止。
// 邊的手把只給未旋轉的媒體（錨定邊的算式假設軸對齊）。
// 文字另有一套（2026-08-14 補上，iOS 語意逐條照搬）：右下角＝字級縮放
// （textScaleHandle）、右緣＝欄寬（widthHandle）、下緣＝框高（heightHandle，
// 長文框限定）——文字的框是貼字盒，所以「調大小」調的是字級與換行寬，不是框。

type Corner = "tl" | "tr" | "bl" | "br";
type Edge = "left" | "right" | "top" | "bottom";
/** "group" ＝多選時群組外框右下角那顆（整組等比縮放，iOS updateGroupScale 的移植）。 */
type HandleKey = Corner | Edge | "group";
interface Handle { key: HandleKey; x: number; y: number; bar?: "v" | "h" }
/** 群組縮放起手時記下的文字排版數值（要跟著倍率一起長大的那些）。 */
interface GroupTextStart {
  fontSize?: number; manualWidth?: number; manualHeight?: number;
  kerning?: number; lineSpacing?: number;
}
const EDGES: Edge[] = ["left", "right", "top", "bottom"];
const isEdge = (k: HandleKey): k is Edge => (EDGES as string[]).includes(k);
/** 角的本地正規化座標：x=1 在右、y=1 在下。 */
const CORNER_XY: Record<Corner, { x: number; y: number }> = {
  tl: { x: 0, y: 0 }, tr: { x: 1, y: 0 }, bl: { x: 0, y: 1 }, br: { x: 1, y: 1 },
};
const CORNERS = Object.keys(CORNER_XY) as Corner[];

/** block 本地正規化點 (nx,ny) 的專案座標——**旋轉後的真實位置**（手把要長在看得見的角上）。 */
function cornerPoint(f: Rect, rotation: number, nx: number, ny: number): { x: number; y: number } {
  const cx = f.x + f.w / 2, cy = f.y + f.h / 2;
  const dx = (nx - 0.5) * f.w, dy = (ny - 0.5) * f.h;
  if (!rotation) return { x: cx + dx, y: cy + dy };
  const r = (rotation * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c };
}

/** 拉框能改尺寸的型別。文字排除（見上）、鎖定的不給。 */
function resizable(b: Block): boolean {
  return !b.locked && (b.content.type === "image" || b.content.type === "video" || b.content.type === "shape");
}

/** 等比鎖定＝照片與影片（iOS：角是 aspect-locked，拉了不變形）。形狀自由拉。 */
function aspectLocked(b: Block): boolean {
  return b.content.type === "image" || b.content.type === "video";
}

/** 可以裁切的：未旋轉、有素材的媒體（iOS `content.isMedia && rotation == 0`）。 */
function cropable(b: Block): boolean {
  return !b.locked && !b.rotation
    && (b.content.type === "image" || b.content.type === "video")
    && !!b.content.media.assetFileName;
}

/** 線條的「墨」＝置中的細桿，不是整個 frame——吸附要咬看得見的邊
 *  （與 iOS 端 2026-08-03 同日同修；文繞圖的洞早就這樣算）。其他型別原樣回傳。 */
function inkFrame(b: Block, f: Rect): Rect {
  if (b.content.type !== "shape" || b.content.shape.kind !== "line") return f;
  const t = Math.max(0.25, Math.min(b.content.shape.lineWidth ?? Math.max(2, f.h * 0.5), f.h));
  return { x: f.x, y: f.y + f.h / 2 - t / 2, w: f.w, h: t };
}

export class Editor {
  private ctx: CanvasRenderingContext2D;
  private view: View = { scale: 0.3, tx: 40, ty: 40 };
  private project: Project | null = null;
  private selected: string | null = null;      // 主選取（最後點到的那個）
  /** 多選集合。單選時就是這一個 id；空集合＝沒選。 */
  private multi = new Set<string>();
  private marquee: { from: { x: number; y: number }; to: { x: number; y: number } } | null = null;
  private spaceHeld = false;
  private guides: GuideLine[] = [];
  private badges: SpacingBadge[] = [];
  private drag: {
    id: string; startFrame: Rect; from: { x: number; y: number };
    /** 整組拖曳時每個成員的起始 frame（單選時就是一個）。 */
    group: { id: string; start: Rect }[];
  } | null = null;
  private sizing: {
    id: string; key: HandleKey; startFrame: Rect;
    anchor: { x: number; y: number };          // 角：對角的專案座標
    from: { x: number; y: number };            // 邊：邊手把起手的指標位置（累計位移用）
    crop?: Rect;                               // 邊：起手的 cropRect
  } | null = null;
  /** 文字手把拖曳：br＝字級縮放、right＝欄寬、bottom＝框高（長文框限定）。 */
  private textSizing: {
    id: string; key: "br" | "right" | "bottom";
    startFrame: Rect; startFontSize: number;
    from: { x: number; y: number };
  } | null = null;
  /** 群組等比縮放（多選右下角那顆手把）。左上固定，整組連字級一起放大縮小。 */
  private groupSizing: {
    box: Rect;                                  // 起手的群組外框
    frames: Map<string, Rect>;                  // 成員起手 frame（鎖住的不收進來）
    /** 文字成員的起手排版數值——字要跟著框長大，不然框變了字還是原尺寸。 */
    texts: Map<string, GroupTextStart>;
  } | null = null;
  private pan: { x: number; y: number; tx: number; ty: number } | null = null;
  /** 內容平移模式：雙擊裁切過的照片＝在框內搬動照片本身（裁切的用意就在這）。 */
  private content: { id: string; startCrop: Rect; from: { x: number; y: number } } | null = null;
  private contentId: string | null = null;
  /** 按住 R＝拉角變成旋轉（Mac 的效率語意，滑鼠不用切工具）。 */
  private rKey = false;
  private rotating: { id: string; start: number; from: { x: number; y: number } } | null = null;
  /** 參考線：可以在畫布上直接拖，拖出頁面外就是丟掉（Photoshop 的語意）。 */
  private guideDrag: { axis: "x" | "y"; index: number } | null = null;
  /** 參考線的顯示開關（只是看不看得到，不會刪掉）。 */
  guidesHidden = false;
  private dirty = true;
  private images?: Map<string, CanvasImageSource>;
  private videos?: Map<string, CanvasImageSource>;
  /** 紙張要用的顆粒貼片。沒給＝畫布不套紙張（匯出仍會套）——所以殼層一定要餵。 */
  private filters?: FilterAssets;
  private editing: { id: string; el: HTMLDivElement; orig: string } | null = null;
  snapStrength: SnapStrength = "strong";
  onSelect?: (b: Block | null) => void;
  /** 縮放倍率變了（工具列的百分比顯示用）。 */
  onZoom?: (scale: number) => void;
  /** 畫面中央落在哪一頁變了（圖層清單跟著換）。 */
  onPageInView?: (index: number) => void;
  private pageInView = -1;
  /** 一次拖曳結束後呼叫——殼層用來刷新檢視器數值與頁面縮圖。 */
  onCommit?: () => void;
  /** 行內文字編輯結束後呼叫（殼層做 undo 提交與縮圖更新）。 */
  onTextEdited?: () => void;
  /** 雙擊空欄位框（範本欄位）＝請殼層開選檔填圖。 */
  onFillSlot?: (b: Block) => void;
  /** 選取集合變了（多選用；單選時陣列長度 1）。 */
  onSelectionChange?: (blocks: Block[]) => void;
  /** 進出「搬照片」模式（殼層用來顯示提示）。 */
  onContentMode?: (on: boolean) => void;
  /** ⌥ 拖曳：請殼層複製目前選取並回傳複製品（複製要記 undo，那是殼層的事）。 */
  onDuplicateForDrag?: () => Block[];
  /** 右鍵：請殼層開選單（座標是 client）。 */
  onContextMenu?: (b: Block | null, at: { x: number; y: number }) => void;
  /** 參考線被拖動或丟掉了（殼層記 undo、刷新面板）。 */
  onGuidesChanged?: () => void;
  /** 在畫布上按到某條參考線——殼層把側欄切到參考線面板。 */
  onGuidePicked?: (axis: "x" | "y", index: number) => void;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
    this.darkQuery.addEventListener("change", () => { this.dirty = true; });
    this.startWatchdog();
    canvas.addEventListener("pointerdown", this.down);
    canvas.addEventListener("pointermove", this.move);
    canvas.addEventListener("pointerup", this.up);
    canvas.addEventListener("pointercancel", this.up);
    canvas.addEventListener("dblclick", this.dbl);
    canvas.addEventListener("wheel", this.wheel, { passive: false });
    canvas.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const p = this.at(e as unknown as PointerEvent);
      const b = this.hit(p);
      if (b && !this.multi.has(b.id)) { this.multi = new Set([b.id]); this.selected = b.id; this.emitSelection(); }
      this.dirty = true;
      this.onContextMenu?.(b, { x: e.clientX, y: e.clientY });
    });
    canvas.addEventListener("pointermove", (e) => {
      if (this.drag || this.sizing || this.textSizing || this.pan || this.marquee || this.content || this.rotating) return;
      const p = this.at(e);
      const hk = this.hitHandle(p);
      // 游標就是說明書：手把上顯示縮放/裁切/旋轉，物件上顯示可搬動
      const g = this.hitGuide(p);
      canvas.style.cursor = this.contentId ? "grab"
        : g ? (g.axis === "x" ? "ew-resize" : "ns-resize")
        : hk ? (this.rKey ? "crosshair" : isEdge(hk) ? (hk === "left" || hk === "right" ? "ew-resize" : "ns-resize") : "nwse-resize")
        : this.hit(p) ? "move" : this.spaceHeld ? "grab" : "default";
    });
    // 空白處拖曳＝框選（Keynote 的語意），平移改成按住空白鍵或中鍵——
    // 觸控板兩指捲動本來就能平移，所以主要語意讓給框選才對。
    window.addEventListener("keydown", (e) => {
      if (e.code === "Space") this.spaceHeld = true;
      if (e.code === "KeyR" && !e.metaKey && !e.ctrlKey) { this.rKey = true; this.dirty = true; }
      if (e.key === "Escape" && this.contentId) this.exitContentMode();
    });
    window.addEventListener("keyup", (e) => {
      if (e.code === "Space") this.spaceHeld = false;
      if (e.code === "KeyR") { this.rKey = false; this.dirty = true; }
    });
    window.addEventListener("blur", () => { this.spaceHeld = false; this.rKey = false; });
    new ResizeObserver(() => { this.resize(); }).observe(canvas);
    this.resize();
    requestAnimationFrame(this.frame);
  }

  load(p: Project, images?: Map<string, CanvasImageSource>): void {
    this.project = p;
    this.images = images;
    this.selected = null;
    this.multi.clear();       // 換專案沒清＝上一份的 id 會殘留（自測抓到）
    this.guides = []; this.badges = [];
    // 存檔裡的文字 frame 可能只是估值（範本尤其明顯），iOS 端載入後也會重算。
    // 不做這步，選取框就會鬆一圈、吸附也會對到不存在的邊。
    autoFitText(this.ctx, p);
    this.fitAll();
  }

  /** 整台 stage 收進畫面，留一點邊。 */
  fitAll(): void {
    if (!this.project) return;
    const stage = stageBounds(this.project);
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    this.view.scale = Math.min(w / (stage.w + 80), h / (stage.h + 80));
    this.view.tx = (w - stage.w * this.view.scale) / 2;
    this.view.ty = (h - stage.h * this.view.scale) / 2;
    this.dirty = true;
    this.onZoom?.(this.view.scale);
  }

  get zoom(): number { return this.view.scale }
  setZoom(scale: number): void {
    const w = this.canvas.clientWidth / 2, h = this.canvas.clientHeight / 2;
    const cx = (w - this.view.tx) / this.view.scale, cy = (h - this.view.ty) / this.view.scale;
    this.view.scale = scale;
    this.view.tx = w - cx * scale;
    this.view.ty = h - cy * scale;
    this.dirty = true;
    this.onZoom?.(scale);
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    // 尺寸用 clientWidth 會有整數四捨五入誤差，rect 才是精確的——rect 只配拿來量尺寸
    const r = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.dirty = true;
  }

  /** 目前視野（專案座標）。渲染裁切與影片池共用同一份——兩邊看到的「可見」必須一致。 */
  visibleRect(): Rect {
    return {
      x: -this.view.tx / this.view.scale,
      y: -this.view.ty / this.view.scale,
      w: this.canvas.clientWidth / this.view.scale,
      h: this.canvas.clientHeight / this.view.scale,
    };
  }

  /** 指標事件 → 專案座標。offsetX/offsetY 已經是畫布本地的 CSS px。 */
  private at(e: PointerEvent): { x: number; y: number } {
    return { x: (e.offsetX - this.view.tx) / this.view.scale,
             y: (e.offsetY - this.view.ty) / this.view.scale };
  }

  /** 最上層命中的 block。用**真正的旋轉矩形**判定而不是外接框，
   *  否則轉 45° 的元件角落一大片空白也會被點到。 */
  private hit(p: { x: number; y: number }): Block | null {
    const blocks = this.project?.blocks ?? [];
    const order = [...blocks].sort((a, b) => a.zIndex - b.zIndex);
    for (let i = order.length - 1; i >= 0; i--) {
      const b = order[i];
      if (b.locked) continue;
      const f = b.frame;
      const r = (-b.rotation * Math.PI) / 180;
      const dx = p.x - (f.x + f.w / 2), dy = p.y - (f.y + f.h / 2);
      const lx = dx * Math.cos(r) - dy * Math.sin(r) + f.w / 2;
      const ly = dx * Math.sin(r) + dy * Math.cos(r) + f.h / 2;
      if (lx >= 0 && lx <= f.w && ly >= 0 && ly <= f.h) return b;
    }
    return null;
  }

  /**
   * 選取中 block 的手把：四個角（圓點＝縮放），媒體再加四個邊（長條＝裁切）。
   *
   * **螢幕上太小就不給手把**：抓取範圍是固定的螢幕尺寸，小元件（或縮很遠時）
   * 會被手把整個吃掉，變成連拖都拖不動。角要 28px、邊再多要 56px 才長出來。
   */
  /**
   * 多選的外框＝各成員**旋轉後**外接框的聯集。
   *
   * 用旋轉後的框（不是原始 frame）是刻意的：群組裡有轉過的元件時，原始 frame 的聯集
   * 會小於眼睛看到的範圍，手把就長在框裡面。iOS 的群組**拖曳**2026-08-01 已經改成
   * 這樣，但它的群組**縮放**還停在舊寫法——這裡直接照修好的那版做。
   */
  private groupBox(): Rect | null {
    const blocks = this.selectionBlocks();
    if (blocks.length < 2) return null;
    let box: Rect | null = null;
    for (const b of blocks) {
      const r = rotatedBounds(b.frame, b.rotation);
      if (!box) { box = { ...r }; continue; }
      const x = Math.min(box.x, r.x), y = Math.min(box.y, r.y);
      box = { x, y, w: Math.max(box.x + box.w, r.x + r.w) - x, h: Math.max(box.y + box.h, r.y + r.h) - y };
    }
    return box && box.w > 0 && box.h > 0 ? box : null;
  }

  private handlePoints(): Handle[] {
    // 多選＝只給一顆：群組外框右下角，拉了整組等比放大縮小（iOS 同款，左上固定）
    if (this.multi.size > 1 && !this.editing) {
      const box = this.groupBox();
      if (!box || Math.min(box.w, box.h) * this.view.scale < 28) return [];
      return [{ key: "group", x: box.x + box.w, y: box.y + box.h }];
    }
    const b = this.getSelected();
    if (!b || this.editing || this.multi.size > 1) return [];
    // 文字手把（iOS 語意）：手把長在框外一點點（iOS 同款 +7），一行字再細
    // 也不會手把疊手把；也因此**不設**「螢幕上太小就藏」的門檻——文字列天生矮。
    if (b.content.type === "text" && !b.locked) {
      const t = b.content.text, f = b.frame;
      const off = 7 / this.view.scale;
      const ox = 1 + off / Math.max(f.w, 1), oy = 1 + off / Math.max(f.h, 1);
      const out: Handle[] = [{ key: "br", ...cornerPoint(f, b.rotation, ox, oy) }];
      if (!t.vertical) out.push({ key: "right", ...cornerPoint(f, b.rotation, ox, 0.5), bar: "v" });
      if (t.isBodyFrame) out.push({ key: "bottom", ...cornerPoint(f, b.rotation, 0.5, oy), bar: "h" });
      return out;
    }
    if (!resizable(b)) return [];
    const onScreen = Math.min(b.frame.w, b.frame.h) * this.view.scale;
    if (onScreen < 28) return [];
    const out: Handle[] = CORNERS.map((k) => ({
      key: k as HandleKey, ...cornerPoint(b.frame, b.rotation, CORNER_XY[k].x, CORNER_XY[k].y),
    }));
    if (!cropable(b) || onScreen < 56) return out;
    const f = b.frame;
    out.push(
      { key: "left",   x: f.x,           y: f.y + f.h / 2, bar: "v" },
      { key: "right",  x: f.x + f.w,     y: f.y + f.h / 2, bar: "v" },
      { key: "top",    x: f.x + f.w / 2, y: f.y,           bar: "h" },
      { key: "bottom", x: f.x + f.w / 2, y: f.y + f.h,     bar: "h" },
    );
    return out;
  }

  /** 命中哪一條參考線（抓取範圍固定 5 螢幕 px）。回 null＝沒碰到。 */
  private hitGuide(p: { x: number; y: number }): { axis: "x" | "y"; index: number } | null {
    const proj = this.project;
    if (!proj || this.guidesHidden || proj.guidesLocked) return null;
    const tol = 5 / this.view.scale;
    const page = pageIndexForX(proj, p.x);
    const gx = proj.guidesX ?? [], gy = proj.guidesY ?? [];
    for (let i = 0; i < gx.length; i++) {
      if (Math.abs(p.x - (page * proj.canvasWidth + gx[i])) <= tol) return { axis: "x", index: i };
    }
    for (let i = 0; i < gy.length; i++) {
      if (Math.abs(p.y - gy[i]) <= tol) return { axis: "y", index: i };
    }
    return null;
  }

  /** 命中哪個手把。抓取半徑固定在螢幕上（11px），縮小時才不會抓不到。
   *  角先問——小圖時角與邊的抓取範圍會重疊，縮放優先於裁切。 */
  private hitHandle(p: { x: number; y: number }): HandleKey | null {
    const r = 11 / this.view.scale;
    const near = (h: Handle) => Math.abs(p.x - h.x) <= r && Math.abs(p.y - h.y) <= r;
    const all = this.handlePoints();
    return all.find((h) => !h.bar && near(h))?.key ?? all.find((h) => h.bar && near(h))?.key ?? null;
  }

  /** 素材的原始像素尺寸（裁切要用來算 aspect-fill）。查不到＝素材還沒載進來。 */
  private naturalOf(m: MediaBlock): { w: number; h: number } | null {
    const suffix = m.filterKey ? `|${m.filterKey}` : "";
    const img = this.images?.get(m.assetFileName + suffix)
      ?? this.images?.get(`${m.assetFileName}.poster.jpg${suffix}`);
    if (!img) return null;
    const s = naturalSize(img);
    return s.w && s.h ? s : null;
  }

  /**
   * 開始裁切。還沒裁過的先把 aspect-fill 區域**實體化**進 cropRect——
   * (0,0,1,1) 是「未曾裁切」的哨兵值不是字面值，不先攤開就沒有「藏起來的部分」
   * 可以往外拉回來，而且下筆的瞬間畫面會從置中裁切跳成整張拉伸。
   * （iOS 只對圖片實體化，那是因為它的 image(for:) 對 .mov 回 nil；影片一起做才對稱。）
   */
  private beginCrop(b: Block, edge: Edge, at: { x: number; y: number }): void {
    if (b.content.type !== "image" && b.content.type !== "video") return;
    const m = b.content.media;
    const c = m.cropRect;
    const uncropped = !(c.w > 0.001 && c.h > 0.001) || (c.w > 0.999 && c.h > 0.999);
    if (uncropped) {
      const n = this.naturalOf(m);
      if (n) m.cropRect = aspectFillCrop(n.w, n.h, b.frame.w, b.frame.h);
    }
    this.sizing = {
      id: b.id, key: edge, startFrame: { ...b.frame },
      anchor: { x: 0, y: 0 }, from: at, crop: { ...m.cropRect },
    };
  }

  /**
   * 拉邊＝真裁切：對邊錨定，frame 與 cropRect 同步收放，**照片本身不動**。
   * 往外拉可以露出藏起來的部分，上限是 cropRect 撞到素材邊緣（maxW／maxH）。
   */
  private cropTo(at: { x: number; y: number }): void {
    const p = this.project;
    const s = this.sizing;
    if (!p || !s || !s.crop) return;
    const idx = p.blocks.findIndex((k) => k.id === s.id);
    const b = idx >= 0 ? p.blocks[idx] : null;
    if (!b || (b.content.type !== "image" && b.content.type !== "video")) return;
    const m = b.content.media;
    const f0 = s.startFrame, c0 = s.crop;
    const min = p.canvasWidth * 0.05;   // iOS 同值

    this.guides = [];
    const others = this.snapTargets(p, (_, i) => i === idx);
    const home = pageRect(p, pageIndexForX(p, f0.x + f0.w / 2));
    const stage = stageBounds(p);
    /** 正在動的那條邊照樣吃磁性——裁切的邊也要能咬到鄰居與頁邊。 */
    const snap = (v: number, axis: "vertical" | "horizontal"): number => {
      if (this.snapStrength === "none") return v;
      const r = snapResizingEdge(v, axis, others, home, stage, this.snapStrength,
                                 axis === "vertical" ? (p.guidesX ?? []) : (p.guidesY ?? []));
      if (r.snapped) this.guides = r.guides;
      return r.value;
    };
    const clamp = (v: number, max: number) => Math.min(Math.max(v, min), Math.max(max, min));
    const dx = at.x - s.from.x, dy = at.y - s.from.y;

    switch (s.key as Edge) {
      case "right": {
        const maxW = c0.w > 0 ? (f0.w * (1 - c0.x)) / c0.w : f0.w;
        const w = clamp(snap(f0.x + f0.w + dx, "vertical") - f0.x, maxW);
        m.cropRect = { x: c0.x, y: c0.y, w: c0.w * (w / f0.w), h: c0.h };
        b.frame = { x: f0.x, y: f0.y, w, h: f0.h };
        break;
      }
      case "left": {
        const maxW = c0.w > 0 ? (f0.w * (c0.x + c0.w)) / c0.w : f0.w;
        const w = clamp(f0.x + f0.w - snap(f0.x + dx, "vertical"), maxW);
        const cw = c0.w * (w / f0.w);
        m.cropRect = { x: c0.x + c0.w - cw, y: c0.y, w: cw, h: c0.h };
        b.frame = { x: f0.x + f0.w - w, y: f0.y, w, h: f0.h };
        break;
      }
      case "bottom": {
        const maxH = c0.h > 0 ? (f0.h * (1 - c0.y)) / c0.h : f0.h;
        const h = clamp(snap(f0.y + f0.h + dy, "horizontal") - f0.y, maxH);
        m.cropRect = { x: c0.x, y: c0.y, w: c0.w, h: c0.h * (h / f0.h) };
        b.frame = { x: f0.x, y: f0.y, w: f0.w, h };
        break;
      }
      case "top": {
        const maxH = c0.h > 0 ? (f0.h * (c0.y + c0.h)) / c0.h : f0.h;
        const h = clamp(f0.y + f0.h - snap(f0.y + dy, "horizontal"), maxH);
        const ch = c0.h * (h / f0.h);
        m.cropRect = { x: c0.x, y: c0.y + c0.h - ch, w: c0.w, h: ch };
        b.frame = { x: f0.x, y: f0.y + f0.h - h, w: f0.w, h };
        break;
      }
    }
    this.dirty = true;
  }

  /**
   * 拉角：**對角錨定**（拉右下角→左上角釘住）。照片／影片等比、形狀自由。
   * 旋轉過的元件也能拉——把指標換算回 block 的未旋轉座標系算尺寸，
   * 再從錨點反推 frame（照 iOS 那條「錨在看得見的角上」的補償路徑）。
   */
  private resizeTo(at: { x: number; y: number }): void {
    const p = this.project;
    const s = this.sizing;
    if (!p || !s) return;
    const idx = p.blocks.findIndex((k) => k.id === s.id);
    if (idx < 0) return;
    const b = p.blocks[idx];
    const f0 = s.startFrame;
    const n = CORNER_XY[s.key as Corner];
    const sx = n.x === 1 ? 1 : -1, sy = n.y === 1 ? 1 : -1;

    const r = (-b.rotation * Math.PI) / 180, c = Math.cos(r), sn = Math.sin(r);
    const vx = at.x - s.anchor.x, vy = at.y - s.anchor.y;
    const ux = vx * c - vy * sn, uy = vx * sn + vy * c;

    const minSize = p.canvasWidth * 0.05;   // iOS 同值
    const lock = aspectLocked(b) && f0.w > 0 && f0.h > 0;
    const aspect = f0.h / f0.w;
    let w: number, h: number;
    if (lock) {
      // 投影到原對角線＝最貼近指標的等比解。iOS 只吃橫向位移（手指），
      // 桌面是滑鼠，往哪個方向拖都得跟手，所以改用投影。
      const dx = sx * f0.w, dy = sy * f0.h;
      const k = (ux * dx + uy * dy) / (dx * dx + dy * dy);
      w = Math.max(f0.w * k, minSize);
      h = w * aspect;
    } else {
      w = Math.max(sx * ux, minSize);
      h = Math.max(sy * uy, minSize);
    }

    // 吸附只在未旋轉時給：旋轉後「正在動的邊」不是軸對齊的，咬軸對齊的參考線沒意義
    this.guides = [];
    if (!b.rotation && this.snapStrength !== "none") {
      const others = this.snapTargets(p, (_, i) => i === idx);
      const home = pageRect(p, pageIndexForX(p, s.anchor.x + (sx * w) / 2));
      const stage = stageBounds(p);
      const edgeX = s.anchor.x + sx * w, edgeY = s.anchor.y + sy * h;
      const ex = snapResizingEdge(edgeX, "vertical", others, home, stage, this.snapStrength, p.guidesX ?? []);
      const ey = snapResizingEdge(edgeY, "horizontal", others, home, stage, this.snapStrength, p.guidesY ?? []);
      if (lock) {
        // 等比鎖死＝兩條邊不能各吸各的（照顧一軸一定會動到另一軸），讓它們比距離、近的贏
        const dxs = ex.snapped ? Math.abs(ex.value - edgeX) : Infinity;
        const dys = ey.snapped ? Math.abs(ey.value - edgeY) : Infinity;
        if (ex.snapped && dxs <= dys) {
          w = Math.max(sx * (ex.value - s.anchor.x), minSize); h = w * aspect; this.guides = ex.guides;
        } else if (ey.snapped) {
          h = Math.max(sy * (ey.value - s.anchor.y), minSize); w = h / aspect; this.guides = ey.guides;
        }
      } else {
        if (ex.snapped) w = Math.max(sx * (ex.value - s.anchor.x), minSize);
        if (ey.snapped) h = Math.max(sy * (ey.value - s.anchor.y), minSize);
        this.guides = [...ex.guides, ...ey.guides];
      }
    }

    // 錨點反推：錨那一角在畫面上不能動，所以中心要跟著新尺寸走
    const rr = (b.rotation * Math.PI) / 180, cc = Math.cos(rr), ss = Math.sin(rr);
    const ax = (0.5 - n.x) * w, ay = (0.5 - n.y) * h;   // 錨角相對中心的本地向量
    b.frame = {
      x: s.anchor.x - (ax * cc - ay * ss) - w / 2,
      y: s.anchor.y - (ax * ss + ay * cc) - h / 2,
      w, h,
    };
    this.dirty = true;
  }

  /**
   * 文字手把拖曳（iOS EditorViewModel+Text 的移植）：
   *   br＝字級縮放——位移投影到起手框的對角線算倍率（iOS scaledFont 同式），
   *      字級夾 8–500；重排走 autoFitText＝檢視器「字級」欄位同一條路，
   *      沒有新的幾何數學（長文框在裡面被跳過＝容器不動、字在框內重排）。
   *   right＝欄寬 manualWidth——夾在 8% 頁寬與「單行自然寬」之間：再拉寬
   *      只會多出空白、破壞外緣吸附，所以手把停在最後一個字上（iOS 同款上限，
   *      文字夠長就能跨頁）。左緣釘住，右緣跟著指標。
   *   bottom＝框高 manualHeight——長文框限定；容器可以比內容矮（限制文字
   *      範圍就是長文框的用途），只留一個不會整個縮沒的小地板。
   * 只有拖曳中的這一個 block 被改動，鬆手走 onCommit → 快照 undo。
   */
  private textResizeTo(at: { x: number; y: number }): void {
    const p = this.project, s = this.textSizing;
    if (!p || !s) return;
    const b = p.blocks.find((k) => k.id === s.id);
    if (!b || b.content.type !== "text") return;
    const t = b.content.text;
    const f0 = s.startFrame;
    // 位移轉回未旋轉的本地座標（iOS localDelta 同款）——旋轉過的文字照樣能拉
    const r = (-b.rotation * Math.PI) / 180, c = Math.cos(r), sn = Math.sin(r);
    const vx = at.x - s.from.x, vy = at.y - s.from.y;
    const dx = vx * c - vy * sn, dy = vx * sn + vy * c;

    this.guides = [];
    const snapEdge = (v: number, axis: "vertical" | "horizontal"): number => {
      if (b.rotation || this.snapStrength === "none") return v;
      const others = this.snapTargets(p, (k) => k.id === b.id);
      const home = pageRect(p, pageIndexForX(p, f0.x + f0.w / 2));
      const rr = snapResizingEdge(v, axis, others, home, stageBounds(p), this.snapStrength,
                                  axis === "vertical" ? (p.guidesX ?? []) : (p.guidesY ?? []));
      if (rr.snapped) this.guides = rr.guides;
      return rr.value;
    };

    if (s.key === "br") {
      const diag = Math.max(Math.hypot(f0.w, f0.h), 1);
      const ratio = Math.max((diag + (dx * f0.w + dy * f0.h) / diag) / diag, 0.1);
      t.fontSize = Math.min(Math.max(s.startFontSize * ratio, 8), 500);
      autoFitText(this.ctx, p);
    } else if (s.key === "right") {
      const w = snapEdge(f0.x + f0.w + dx, "vertical") - f0.x;
      const minW = p.canvasWidth * 0.08;
      const nat = naturalTextSize(this.ctx, { ...t, manualWidth: undefined }, p.canvasWidth, p.pageHeight);
      t.manualWidth = Math.round(Math.min(Math.max(w, minW), Math.max(nat.w, minW)));
      if (t.isBodyFrame) b.frame = { ...b.frame, w: t.manualWidth };
      else autoFitText(this.ctx, p);
    } else {
      const h = snapEdge(f0.y + f0.h + dy, "horizontal") - f0.y;
      t.manualHeight = Math.round(Math.max(h, p.canvasWidth * 0.06));
      b.frame = { ...b.frame, h: t.manualHeight };
    }
    this.dirty = true;
  }

  /** 起手：記下外框與每個成員的 frame／排版數值。鎖住的成員不收＝縮放時原地不動。 */
  private beginGroupScale(): void {
    const box = this.groupBox();
    if (!box) return;
    const frames = new Map<string, Rect>();
    const texts = new Map<string, GroupTextStart>();
    for (const b of this.selectionBlocks()) {
      if (b.locked) continue;
      frames.set(b.id, { ...b.frame });
      if (b.content.type === "text") {
        const t = b.content.text;
        texts.set(b.id, {
          fontSize: t.fontSize, manualWidth: t.manualWidth, manualHeight: t.manualHeight,
          kerning: t.kerning, lineSpacing: t.lineSpacing,
        });
      }
    }
    if (!frames.size) return;   // 整組都鎖住＝沒東西可縮
    this.groupSizing = { box, frames, texts };
    this.dirty = true;
  }

  /**
   * 整組等比縮放：外框左上角固定，右下角跟著指標。
   * 文字的字級、手動寬高、點制字距／行距都乘同一個倍率——**框變大字沒變大**
   * 是最容易漏掉的那半（em 制的字距與行高不用動，它們吃已經縮過的 fontSize）。
   */
  private groupResizeTo(at: { x: number; y: number }): void {
    const p = this.project, s = this.groupSizing;
    if (!p || !s) return;
    const box = s.box;
    const minBox = p.canvasWidth * 0.05;   // iOS 同值
    const aspect = box.h / box.w;

    // 投影到起手對角線＝最貼近指標的等比解（與單選等比角同一手法；
    // iOS 只吃橫向位移是因為那是手指，滑鼠得往哪拖都跟手）
    const k = ((at.x - box.x) * box.w + (at.y - box.y) * box.h) / (box.w * box.w + box.h * box.h);
    let w = Math.max(box.w * k, minBox);

    // 吸附：等比鎖死＝右緣與下緣不能各吸各的，讓它們比距離、近的贏（同單選）
    this.guides = [];
    if (this.snapStrength !== "none") {
      const others = this.snapTargets(p, (b) => this.multi.has(b.id));
      const home = pageRect(p, pageIndexForX(p, box.x + w / 2));
      const stage = stageBounds(p);
      const edgeX = box.x + w, edgeY = box.y + w * aspect;
      const ex = snapResizingEdge(edgeX, "vertical", others, home, stage, this.snapStrength, p.guidesX ?? []);
      const ey = snapResizingEdge(edgeY, "horizontal", others, home, stage, this.snapStrength, p.guidesY ?? []);
      const dxs = ex.snapped ? Math.abs(ex.value - edgeX) : Infinity;
      const dys = ey.snapped && aspect > 0 ? Math.abs(ey.value - edgeY) : Infinity;
      if (ex.snapped && dxs <= dys) {
        w = Math.max(ex.value - box.x, minBox); this.guides = ex.guides;
      } else if (dys < Infinity) {
        w = Math.max((ey.value - box.y) / aspect, minBox); this.guides = ey.guides;
      }
    }

    const f = w / box.w;
    const defaultSize = p.canvasWidth * 0.045;   // TextBlock.fontSize 未設時的值
    for (const b of p.blocks) {
      const start = s.frames.get(b.id);
      if (!start) continue;
      b.frame = {
        x: box.x + (start.x - box.x) * f,
        y: box.y + (start.y - box.y) * f,
        w: start.w * f,
        h: start.h * f,
      };
      const t0 = s.texts.get(b.id);
      if (t0 && b.content.type === "text") {
        const t = b.content.text;
        t.fontSize = (t0.fontSize ?? defaultSize) * f;
        if (t0.manualWidth != null) t.manualWidth = t0.manualWidth * f;
        if (t0.manualHeight != null) t.manualHeight = t0.manualHeight * f;
        if (t0.kerning != null) t.kerning = t0.kerning * f;
        if (t0.lineSpacing != null) t.lineSpacing = t0.lineSpacing * f;
      }
    }
    this.dirty = true;
  }

  private down = (e: PointerEvent): void => {
    if (!this.project) return;
    this.canvas.setPointerCapture(e.pointerId);
    const p = this.at(e);
    // 手把優先於命中——角落一定同時落在 block 上，先問手把才拉得動
    const hk = this.hitHandle(p);
    if (hk === "group") { this.beginGroupScale(); return; }
    if (hk) {
      const sel = this.getSelected()!;
      if (this.rKey) {
        // 按住 R 拉角＝繞中心旋轉（⇧ 卡 15°）。Mac 上滑鼠不必先切工具，這是桌面該有的效率
        this.rotating = { id: sel.id, start: sel.rotation, from: p };
        this.dirty = true;
        return;
      }
      // 文字的手把是自己的一套語意（字級／欄寬／框高），不進媒體的裁切與等比路徑
      if (sel.content.type === "text" && (hk === "br" || hk === "right" || hk === "bottom")) {
        this.textSizing = {
          id: sel.id, key: hk, startFrame: { ...sel.frame },
          startFontSize: resolvedFontSize(sel.content.text, this.project.canvasWidth),
          from: p,
        };
        this.dirty = true;
        return;
      }
      if (isEdge(hk)) {
        this.beginCrop(sel, hk, p);
      } else {
        const n = CORNER_XY[hk];
        this.sizing = {
          id: sel.id, key: hk, startFrame: { ...sel.frame }, from: p,
          anchor: cornerPoint(sel.frame, sel.rotation, 1 - n.x, 1 - n.y),
        };
      }
      this.dirty = true;
      return;
    }
    // 內容平移模式：拖在那個 block 上＝搬照片；點到別處＝離開這個模式
    if (this.contentId) {
      const target = this.project.blocks.find((k) => k.id === this.contentId);
      if (target && this.hit(p)?.id === this.contentId) {
        const startCrop = this.materializeCrop(target);
        if (startCrop) { this.content = { id: target.id, startCrop, from: p }; this.dirty = true; return; }
      }
      this.exitContentMode();
    }
    // 參考線優先於元件（手把除外，上面已經先走完）：線只有 5px 寬、元件是一大片，
    // 元件先命中的話「線壓在圖上就永遠抓不到」。不想被抓走就用參考線面板的鎖定。
    const g = this.hitGuide(p);
    if (g && !this.spaceHeld && e.button !== 1) {
      this.guideDrag = g;
      this.onGuidePicked?.(g.axis, g.index);
      this.dirty = true;
      return;
    }
    const b = this.hit(p);
    const additive = e.shiftKey || e.metaKey;
    if (b) {
      if (additive) {
        // ⇧／⌘ 點＝加減選。減掉主選取時把主選取讓給集合裡剩下的任一個
        if (this.multi.has(b.id)) this.multi.delete(b.id); else this.multi.add(b.id);
        this.selected = this.multi.has(b.id) ? b.id
          : (this.multi.size ? [...this.multi][this.multi.size - 1] : null);
      } else if (!this.multi.has(b.id)) {
        this.multi = new Set([b.id]);
        this.selected = b.id;
      } else {
        this.selected = b.id;   // 點在已選取的成員上＝維持整組（接著可以整組拖）
      }
      this.emitSelection();
      if (e.altKey && this.onDuplicateForDrag) {
        // ⌥ 拖曳＝原地留一份、拖走複製品（桌面共通語意）
        const copies = this.onDuplicateForDrag();
        if (copies.length) {
          this.multi = new Set(copies.map((k) => k.id));
          this.selected = copies[0].id;
          this.emitSelection();
          const anchor = copies.find((k) => k.id !== b.id) ?? copies[0];
          this.drag = { id: anchor.id, startFrame: { ...anchor.frame }, from: p,
                        group: copies.map((k) => ({ id: k.id, start: { ...k.frame } })) };
          this.dirty = true;
          return;
        }
      }
      if (this.multi.size) {
        this.drag = { id: b.id, startFrame: { ...b.frame }, from: p,
                      group: [...this.multi].map((id) => {
                        const k = this.project!.blocks.find((x) => x.id === id)!;
                        return { id, start: { ...k.frame } };
                      }) };
      }
    } else if (this.spaceHeld || e.button === 1) {
      this.pan = { x: e.offsetX, y: e.offsetY, tx: this.view.tx, ty: this.view.ty };
    } else {
      if (!additive) { this.multi.clear(); this.selected = null; this.emitSelection(); }
      this.marquee = { from: p, to: p };
    }
    this.dirty = true;
  };

  /** 框選：與**旋轉後外接框**相交就算選到（看得見的範圍才是使用者以為的範圍）。 */
  private applyMarquee(): void {
    const p = this.project;
    const m = this.marquee;
    if (!p || !m) return;
    const r = {
      x: Math.min(m.from.x, m.to.x), y: Math.min(m.from.y, m.to.y),
      w: Math.abs(m.to.x - m.from.x), h: Math.abs(m.to.y - m.from.y),
    };
    this.multi = new Set(p.blocks.filter((b) => {
      if (b.locked) return false;
      const k = rotatedBounds(inkFrame(b, b.frame), b.rotation);
      return r.x < k.x + k.w && k.x < r.x + r.w && r.y < k.y + k.h && k.y < r.y + r.h;
    }).map((b) => b.id));
    this.selected = this.multi.size === 1 ? [...this.multi][0] : (this.multi.size ? this.selected : null);
    if (this.selected && !this.multi.has(this.selected)) this.selected = [...this.multi][0] ?? null;
  }

  /** 通知殼層目前選了哪些（單選也走這條，陣列長度 1）。 */
  private emitSelection(): void {
    const blocks = this.selectionBlocks();
    this.onSelect?.(blocks.length === 1 ? blocks[0] : null);
    this.onSelectionChange?.(blocks);
  }

  /** 目前選取的所有 block（依 zIndex）。 */
  selectionBlocks(): Block[] {
    const p = this.project;
    if (!p) return [];
    return p.blocks.filter((b) => this.multi.has(b.id)).sort((a, b) => a.zIndex - b.zIndex);
  }

  private move = (e: PointerEvent): void => {
    if (this.guideDrag) {
      const p = this.project;
      if (p) {
        const at = this.at(e);
        const { axis, index } = this.guideDrag;
        const page = pageRect(p, pageIndexForX(p, at.x));
        const stage = stageBounds(p);
        // 文字的印刷線也給（水平線咬基線＝先用線對好基線，再讓每頁照著複刻）
        const frames = p.blocks.map((b) => rotatedBounds(b.frame, b.rotation));
        if (axis === "y" && this.snapStrength === "strong") {
          for (const b of p.blocks) {
            if (b.rotation || (b.content.type !== "text" && b.content.type !== "textFlow")) continue;
            const pl = textPrintLines(this.ctx, b.content.text, b.frame, p.canvasWidth, p.pageHeight);
            if (!pl) continue;
            frames.push({ x: b.frame.x, y: pl.base, w: b.frame.w, h: 0 });
            if (pl.cap != null) frames.push({ x: b.frame.x, y: pl.cap, w: b.frame.w, h: 0 });
          }
        }
        // 線自己也要吸附：先用線對好位，之後每一頁才能照著複刻
        const arr = axis === "x" ? (p.guidesX ??= []) : (p.guidesY ??= []);
        const others = arr.filter((_, i) => i !== index);
        const raw = axis === "x" ? at.x - page.x : at.y;
        const r = snapGuide(raw, axis === "x" ? "vertical" : "horizontal",
                            frames, page, stage, this.snapStrength, others);
        arr[index] = r.snapped ? r.value : Math.round(raw);
        this.guides = r.guides;
        this.dirty = true;
      }
      return;
    }
    if (this.content) { this.panContent(this.at(e)); return; }
    if (this.rotating) { this.rotateTo(this.at(e), e.shiftKey); return; }
    if (this.groupSizing) { this.groupResizeTo(this.at(e)); return; }
    if (this.textSizing) { this.textResizeTo(this.at(e)); return; }
    if (this.sizing) {
      const at = this.at(e);
      if (isEdge(this.sizing.key)) this.cropTo(at); else this.resizeTo(at);
      return;
    }
    if (this.marquee) {
      this.marquee.to = this.at(e);
      this.applyMarquee();
      this.dirty = true;
      return;
    }
    if (this.pan) {
      this.view.tx = this.pan.tx + (e.offsetX - this.pan.x);
      this.view.ty = this.pan.ty + (e.offsetY - this.pan.y);
      if (this.editing) this.syncOverlay();
      this.dirty = true;
      return;
    }
    const p = this.project;
    if (!this.drag || !p) return;
    const idx = p.blocks.findIndex((b) => b.id === this.drag!.id);
    if (idx < 0) return;

    const at = this.at(e);
    let mx = at.x - this.drag.from.x, my = at.y - this.drag.from.y;
    // ⇧ 拖曳＝鎖住位移大的那一軸（水平或垂直直線移動）
    if (e.shiftKey) { if (Math.abs(mx) > Math.abs(my)) my = 0; else mx = 0; }
    const moving: Rect = {
      x: this.drag.startFrame.x + mx,
      y: this.drag.startFrame.y + my,
      w: this.drag.startFrame.w, h: this.drag.startFrame.h,
    };

    // 被拖的自己也要換成旋轉外接框再比對——iOS 端 2026-08-01 才修好的同一個坑：
    // 只對「別人」做外接框，自己還用未旋轉的 frame，旋轉過的元件就永遠對不上。
    const box = rotatedBounds(inkFrame(p.blocks[idx], moving), p.blocks[idx].rotation);
    const others = this.snapTargets(p, (b) => this.multi.has(b.id));
    const home = pageRect(p, pageIndexForX(p, moving.x + moving.w / 2));
    // 拖的是單一文字→自己的印刷線也當候選：基線咬基線才是「絕對對齊」的手感
    const extraY: number[] = [];
    const dragged = p.blocks[idx];
    if (this.snapStrength === "strong" && !dragged.rotation && this.drag.group.length <= 1
        && (dragged.content.type === "text" || dragged.content.type === "textFlow")) {
      const pl = textPrintLines(this.ctx, dragged.content.text, moving, p.canvasWidth, p.pageHeight);
      if (pl) {
        const cy = moving.y + moving.h / 2;
        extraY.push(pl.base - cy);
        if (pl.cap != null) extraY.push(pl.cap - cy);
      }
    }
    const res = resolvePosition(box, others, home, stageBounds(p), this.snapStrength,
                                p.guidesX ?? [], p.guidesY ?? [], extraY);

    // 外接框與 frame 同心、尺寸不變，所以外接框被吸走多少 frame 就走多少
    moving.x += res.frame.x - box.x;
    moving.y += res.frame.y - box.y;
    // 整組拖曳：**吸附只算被拖的那一個**，位移原封不動套到其他成員——
    // 這樣整組的相對關係一定不變（拿整組外框去吸，成員之間會被拉扯變形）
    const dx = moving.x - this.drag.startFrame.x, dy = moving.y - this.drag.startFrame.y;
    for (const g of this.drag.group) {
      const k = p.blocks.find((x) => x.id === g.id);
      if (k) k.frame = { ...k.frame, x: g.start.x + dx, y: g.start.y + dy };
    }
    p.blocks[idx].frame = moving;
    this.guides = res.guides;

    this.badges = this.snapStrength === "strong"
      ? equalSpacingBadges(
          p.blocks.filter((b) => pageIndexForX(p, b.frame.x + b.frame.w / 2) === pageIndexForX(p, moving.x + moving.w / 2))
                  .map((b) => rotatedBounds(inkFrame(b, b.frame), b.rotation)),
          home)
      : [];
    this.dirty = true;
  };

  /** 吸附目標。看得見的外框（inkFrame＋旋轉外接框）之外，文字再加「印刷線」——
   *  大寫線與基線的零高假框（絕對對齊 2026-08-14）。框頂是最高墨跡（i 點、重音、
   *  括號），人眼對的卻是這兩條線。weak 的哲學是只看起點與中心，印刷線屬於細節，
   *  只在 strong 給。 */
  private snapTargets(p: Project, exclude: (b: Block, i: number) => boolean): Rect[] {
    const out: Rect[] = [];
    for (let i = 0; i < p.blocks.length; i++) {
      const b = p.blocks[i];
      if (exclude(b, i)) continue;
      const f = rotatedBounds(inkFrame(b, b.frame), b.rotation);
      out.push(f);
      if (this.snapStrength !== "strong" || b.rotation) continue;
      if (b.content.type !== "text" && b.content.type !== "textFlow") continue;
      const pl = textPrintLines(this.ctx, b.content.text, b.frame, p.canvasWidth, p.pageHeight);
      if (!pl) continue;
      out.push({ x: f.x, y: pl.base, w: f.w, h: 0 });
      if (pl.cap != null) out.push({ x: f.x, y: pl.cap, w: f.w, h: 0 });
    }
    return out;
  }

  private up = (e: PointerEvent): void => {
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    // 參考線拖到頁面外＝丟掉（Photoshop 的語意，不用再開面板刪）
    if (this.guideDrag && this.project) {
      const p = this.project;
      const at = this.at(e);
      const outside = this.guideDrag.axis === "x"
        ? at.y < -40 || at.y > p.pageHeight + 40
        : at.x < -40 || at.x > p.canvasWidth * p.pageCount + 40;
      if (outside) {
        if (this.guideDrag.axis === "x") p.guidesX?.splice(this.guideDrag.index, 1);
        else p.guidesY?.splice(this.guideDrag.index, 1);
      }
      this.onGuidesChanged?.();
    }
    const dragged = this.drag != null || this.sizing != null || this.content != null
                    || this.rotating != null || this.guideDrag != null || this.groupSizing != null
                    || this.textSizing != null;
    const marqueed = this.marquee != null;
    this.groupSizing = null; this.textSizing = null;
    this.drag = null; this.sizing = null; this.pan = null; this.marquee = null;
    this.content = null; this.rotating = null; this.guideDrag = null;
    if (marqueed) this.emitSelection();
    this.guides = []; this.badges = [];
    this.dirty = true;
    if (dragged) this.onCommit?.();
  };

  // ── 行內文字編輯 ────────────────────────────────────────────────────
  // 桌面的正路：雙擊文字、直接在畫布上打字。做法＝疊一層 contenteditable，
  // 字型／字距／行高／縮放全部跟畫布同步，編輯期間畫布跳過該 block（skipBlockId）。

  private dbl = (e: MouseEvent): void => {
    if (!this.project) return;
    const pos = { x: (e.offsetX - this.view.tx) / this.view.scale,
                  y: (e.offsetY - this.view.ty) / this.view.scale };
    const b = this.hit(pos);
    if (!b) return;
    if (b.content.type === "text" || b.content.type === "textFlow") { this.startEdit(b); return; }
    if (b.content.type === "image" || b.content.type === "video") {
      // 空欄位框＝範本的填圖欄位，雙擊直接選檔（iOS 的「點欄位挑照片」對應到桌面）
      if (!b.content.media.assetFileName) { this.onFillSlot?.(b); return; }
      // 有素材的：雙擊進「搬照片」模式——框不動，動的是框裡的畫面
      this.contentId = b.id;
      this.select(b.id);
      this.onContentMode?.(true);
      this.dirty = true;
    }
  };

  private editText(b: Block): TextBlock | null {
    return b.content.type === "text" || b.content.type === "textFlow" ? b.content.text : null;
  }

  startEdit(b: Block): void {
    this.endEdit(true);
    const t = this.editText(b);
    if (!t) return;
    const el = document.createElement("div");
    el.className = "textedit";
    // plaintext-only：貼上時不帶 HTML；Enter＝換行＝模型裡的 \n
    (el as HTMLElement & { contentEditable: string }).contentEditable = "plaintext-only";
    el.textContent = t.text;
    this.canvas.parentElement!.append(el);
    this.editing = { id: b.id, el, orig: t.text };
    this.syncOverlay();
    el.focus();
    document.getSelection()?.selectAllChildren(el);

    el.addEventListener("input", () => {
      // contenteditable 的 innerText 會帶一個尾端換行，要剪掉才不會多一空行
      t.text = el.innerText.replace(/\u00A0/g, " ").replace(/\n$/, "");
      if (this.project) autoFitText(this.ctx, this.project);   // 貼字盒跟著長，錨點修正在裡面
      this.syncOverlay();
      this.dirty = true;
    });
    el.addEventListener("blur", () => this.endEdit(true));
    el.addEventListener("keydown", (ke) => {
      ke.stopPropagation();   // 別讓 ⌘Z／方向鍵打到殼層——編輯中那是游標的事
      if (ke.key === "Escape") { ke.preventDefault(); this.endEdit(false); }
      if (ke.key === "Enter" && (ke.metaKey || ke.ctrlKey)) { ke.preventDefault(); this.endEdit(true); }
    });
    this.dirty = true;
  }

  /** commitChange=false（Esc）＝還原原文。 */
  endEdit(commitChange: boolean): void {
    const ed = this.editing;
    if (!ed) return;
    this.editing = null;
    const b = this.project?.blocks.find((k) => k.id === ed.id);
    const t = b ? this.editText(b) : null;
    if (t && !commitChange) {
      t.text = ed.orig;
      if (this.project) autoFitText(this.ctx, this.project);
    }
    ed.el.remove();
    this.dirty = true;
    this.onTextEdited?.();
  }

  /** 把編輯層的位置／字型跟畫布渲染對齊。視野一動就要重呼叫。 */
  private syncOverlay(): void {
    const ed = this.editing;
    const p = this.project;
    if (!ed || !p) return;
    const b = p.blocks.find((k) => k.id === ed.id);
    const t = b ? this.editText(b) : null;
    if (!b || !t) return;
    const v = this.view, f = b.frame;
    const size = resolvedFontSize(t, p.canvasWidth) * v.scale;
    const kern = resolvedKerning(t, p.canvasWidth) * v.scale;
    const el = ed.el;

    el.style.font = cssFont(t, size);
    el.style.letterSpacing = `${kern}px`;
    el.style.color = t.inkColor ?? hex(t.colorHex);

    // 量測第一行的墨頂空帶：DOM 排版框從 ascent 起算、畫布貼字盒從墨跡起算，
    // 不把這段補回去，編輯層會比畫布低一截（同 TextInkInset 的道理）。
    this.ctx.save();
    this.ctx.font = cssFont(t, size);
    const m = this.ctx.measureText(t.text.split("\n")[0] || "字");
    const lineH = (m.fontBoundingBoxAscent + m.fontBoundingBoxDescent) * (t.lineHeightMultiple ?? 1)
      + (t.lineSpacing ?? 0) * v.scale;
    const inkTop = m.fontBoundingBoxAscent - m.actualBoundingBoxAscent;
    this.ctx.restore();

    const sx = f.x * v.scale + v.tx, sy = f.y * v.scale + v.ty;
    el.style.lineHeight = `${lineH}px`;
    if (t.vertical) {
      // 直排交給瀏覽器的直書排版當編輯體驗——與畫布的欄排有细微差，收筆時就會對回去
      el.style.writingMode = "vertical-rl";
      el.style.whiteSpace = "pre";
      el.style.left = `${sx}px`; el.style.top = `${sy}px`;
      el.style.width = `${f.w * v.scale}px`;
      el.style.height = `${f.h * v.scale}px`;
      el.style.textAlign = "start";
    } else {
      el.style.writingMode = "";
      el.style.whiteSpace = t.manualWidth != null ? "pre-wrap" : "pre";
      el.style.left = `${sx}px`;
      el.style.top = `${sy - inkTop}px`;
      el.style.width = `${Math.max(f.w * v.scale, 8)}px`;
      el.style.height = "auto";
      el.style.textAlign = t.alignment === "center" ? "center" : t.alignment === "trailing" ? "right" : "left";
    }
    if (b.rotation) {
      el.style.transform = `rotate(${b.rotation}deg)`;
      el.style.transformOrigin = "center";
    } else {
      el.style.transform = "";
    }
  }

  /** 拉角旋轉：角相對中心的角度差就是轉角；⇧ 卡在 15° 的格上。 */
  private rotateTo(at: { x: number; y: number }, snap15: boolean): void {
    const p = this.project, r = this.rotating;
    if (!p || !r) return;
    const b = p.blocks.find((k) => k.id === r.id);
    if (!b) return;
    const cx = b.frame.x + b.frame.w / 2, cy = b.frame.y + b.frame.h / 2;
    const a0 = Math.atan2(r.from.y - cy, r.from.x - cx);
    const a1 = Math.atan2(at.y - cy, at.x - cx);
    let deg = r.start + ((a1 - a0) * 180) / Math.PI;
    if (snap15) deg = Math.round(deg / 15) * 15;
    b.rotation = Math.round(deg * 10) / 10;
    this.dirty = true;
  }

  /** 離開內容平移模式。 */
  exitContentMode(): void {
    if (!this.contentId) return;
    this.contentId = null;
    this.onContentMode?.(false);
    this.dirty = true;
  }

  /**
   * 在框內搬照片：frame 一動不動，動的是 cropRect。
   * 位移換算：畫面上移動 dx，等於裁切區往反方向走 dx × crop.w / frame.w
   * （因為框寬 frame.w 顯示的是 crop.w 這麼多的原圖）。夾在 0…1 內，不會拖出空白。
   */
  private panContent(at: { x: number; y: number }): void {
    const p = this.project, c = this.content;
    if (!p || !c) return;
    const b = p.blocks.find((k) => k.id === c.id);
    if (!b || (b.content.type !== "image" && b.content.type !== "video")) return;
    const m = b.content.media;
    const s0 = c.startCrop;
    const dx = (at.x - c.from.x) * (s0.w / b.frame.w);
    const dy = (at.y - c.from.y) * (s0.h / b.frame.h);
    m.cropRect = {
      x: Math.min(Math.max(s0.x - dx, 0), Math.max(0, 1 - s0.w)),
      y: Math.min(Math.max(s0.y - dy, 0), Math.max(0, 1 - s0.h)),
      w: s0.w, h: s0.h,
    };
    this.dirty = true;
  }

  /** 進入內容平移模式時，把哨兵值 (0,0,1,1) 攤成真的 aspect-fill 區域才有得搬。 */
  private materializeCrop(b: Block): Rect | null {
    if (b.content.type !== "image" && b.content.type !== "video") return null;
    const m = b.content.media;
    const c = m.cropRect;
    const uncropped = !(c.w > 0.001 && c.h > 0.001) || (c.w > 0.999 && c.h > 0.999);
    if (uncropped) {
      const n = this.naturalOf(m);
      if (!n) return null;
      m.cropRect = aspectFillCrop(n.w, n.h, b.frame.w, b.frame.h);
    }
    return { ...m.cropRect };
  }

  /** 程式化選取（新增元件後選中它；刪除後清空）。 */
  select(id: string | null): void {
    this.selected = id;
    this.multi = id ? new Set([id]) : new Set();
    this.emitSelection();
    this.dirty = true;
  }

  /** 程式化多選（框選以外的入口，例如全選）。 */
  selectMany(ids: string[]): void {
    this.multi = new Set(ids);
    this.selected = ids.length === 1 ? ids[0] : (ids.length ? this.selected : null);
    if (this.selected && !this.multi.has(this.selected)) this.selected = ids[0] ?? null;
    this.emitSelection();
    this.dirty = true;
  }

  /** client 座標 → 專案座標（拖放匯入用）。App 殼沒有整頁縮放與捲動，
   *  rect 當原點在此安全；若未來出現 CSS zoom，回去看座標鐵則再改。 */
  projectPoint(clientX: number, clientY: number): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: (clientX - r.left - this.view.tx) / this.view.scale,
             y: (clientY - r.top - this.view.ty) / this.view.scale };
  }

  /** 畫布視野中心的專案座標——新元件放這裡。 */
  centerPoint(): { x: number; y: number } {
    return { x: (this.canvas.clientWidth / 2 - this.view.tx) / this.view.scale,
             y: (this.canvas.clientHeight / 2 - this.view.ty) / this.view.scale };
  }

  /** 在畫面中央加一條參考線。垂直的存頁內座標、水平的存絕對座標（與 iOS 同）。 */
  addGuide(axis: "x" | "y"): void {
    const p = this.project;
    if (!p) return;
    const c = this.centerPoint();
    if (axis === "x") {
      const page = pageIndexForX(p, c.x);
      (p.guidesX ??= []).push(Math.round(c.x - page * p.canvasWidth));
    } else {
      (p.guidesY ??= []).push(Math.round(Math.min(Math.max(c.y, 0), p.pageHeight)));
    }
    this.guidesHidden = false;
    this.onGuidesChanged?.();
    this.dirty = true;
  }

  /** 目前選取的 block（沒有＝null）。屬性檢視器用。 */
  /** 一個 block 目前在螢幕上的位置（CSS px）——操作導覽的藍框要框它。 */
  screenRect(b: Block): { x: number; y: number; w: number; h: number } {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: r.left + this.view.tx + b.frame.x * this.view.scale,
      y: r.top + this.view.ty + b.frame.y * this.view.scale,
      w: b.frame.w * this.view.scale,
      h: b.frame.h * this.view.scale,
    };
  }

  getSelected(): Block | null {
    return this.project?.blocks.find((b) => b.id === this.selected) ?? null;
  }

  /** 外部（檢視器／快捷鍵）改了專案資料後叫這個重畫。 */
  refresh(): void { this.dirty = true; }

  /** 紙張／濾鏡的貼片資產（殼層載入後餵一次）。 */
  setFilters(f: FilterAssets): void {
    this.filters = f;
    this.dirty = true;
  }

  /** 影片的即時影格來源（殼層維護 `<video>`／濾鏡暫存畫布）。只影響編輯畫布。 */
  setVideos(v?: Map<string, CanvasImageSource>): void {
    this.videos = v;
    this.dirty = true;
  }

  /** 復原／重做用：換一份專案資料但**保留視野與選取**（load 會重置視野，這裡不會）。 */
  swapProject(p: Project): void {
    this.project = p;
    for (const id of [...this.multi]) if (!p.blocks.some((b) => b.id === id)) this.multi.delete(id);
    if (this.selected && !p.blocks.some((b) => b.id === this.selected)) this.selected = null;
    this.dirty = true;
  }

  /** 視野置中到第 i 頁——頁面膠捲點擊用。 */
  focusPage(i: number): void {
    if (!this.project) return;
    const page = pageRect(this.project, i);
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    const scale = Math.min(w / (page.w + 120), h / (page.h + 120));
    this.view.scale = scale;
    this.view.tx = w / 2 - (page.x + page.w / 2) * scale;
    this.view.ty = h / 2 - (page.y + page.h / 2) * scale;
    this.dirty = true;
    this.onZoom?.(scale);
  }

  // Mac 觸控板：兩指捲動＝平移、捏合（會帶 ctrlKey）＝縮放。這是 macOS 的標準語意。
  private wheel = (e: WheelEvent): void => {
    e.preventDefault();
    if (e.ctrlKey) {
      const k = Math.exp(-e.deltaY * 0.01);
      const next = Math.min(Math.max(this.view.scale * k, 0.02), 4);
      const px = (e.offsetX - this.view.tx) / this.view.scale;
      const py = (e.offsetY - this.view.ty) / this.view.scale;
      this.view.scale = next;
      this.view.tx = e.offsetX - px * next;   // 縮放以指標為錨
      this.view.ty = e.offsetY - py * next;
      this.onZoom?.(next);
    } else {
      this.view.tx -= e.deltaX;
      this.view.ty -= e.deltaY;
    }
    if (this.editing) this.syncOverlay();
    this.dirty = true;
  };

  /** 深淺色查詢建一次就好——每格 matchMedia() 是純浪費（WKWebView 上還不便宜）。 */
  private darkQuery = matchMedia("(prefers-color-scheme: dark)");
  /** 桌面底色＋頁面陰影的快取。shadowBlur 在 WKWebView 出了名的貴，而這層只跟
   *  view 變換有關——影片播放時 view 沒動，就不該每格重畫一次整台的陰影。 */
  private backdrop?: { key: string; canvas: HTMLCanvasElement };

  /** 診斷儀表（?diag=1）：重畫耗時 EMA 與次數；raf＝心跳數（沒 dirty 也算）。 */
  readonly frameStats = { ms: 0, paints: 0, raf: 0 };

  /** rAF 上一次跳動的時刻——看門狗用它判斷 rAF 是不是被節流了。 */
  private lastBeat = 0;
  /** 上一次「真正畫了」的時刻——看門狗用它補拍慢心跳（25Hz 那種半死不活）。 */
  private lastPaintAt = 0;

  private frame = (): void => {
    requestAnimationFrame(this.frame);
    this.frameStats.raf++;
    this.lastBeat = performance.now();
    this.paint();
  };

  /**
   * rAF 看門狗。Tauri 的 WKWebView 會把 rAF 節流到 **1Hz**（視窗在最前景、
   * document.visibilityState=visible 也一樣，2026-08-05 真機量到），
   * 而且就算沒死也可能只跑 **~25Hz**（2026-08-09 縮放探針量到：2.5 秒只畫 64 張、
   * 單張才 0.6ms——卡的是拍率不是成本）。setInterval 完全正常——
   * 所以畫面更新不能把命押在 rAF 上。
   * 規則：有髒、且距**上一次真正畫**超過 25ms 就補拍——rAF 健康 60fps 時
   * 這裡永遠輪不到（上次畫永遠很新），rAF 慢或死時自動補到 ~60fps。
   */
  private startWatchdog(): void {
    setInterval(() => {
      const now = performance.now();
      if (this.dirty && now - this.lastPaintAt > 15) { this.paint(); return; }
      if (now - this.lastBeat > 90) this.paint();
    }, 8);
  }

  private paint = (): void => {
    if (!this.dirty || !this.project) return;
    this.dirty = false;
    this.lastPaintAt = performance.now();
    const ft0 = performance.now();

    // 畫面中央換頁了就吼一聲（圖層清單跟著換）——只在真的變了才發，不是每格
    const inView = pageIndexForX(this.project, this.centerPoint().x);
    if (inView !== this.pageInView) { this.pageInView = inView; this.onPageInView?.(inView); }

    const dpr = window.devicePixelRatio || 1;
    const ctx = this.ctx;
    const stage = stageBounds(this.project);
    const dark = this.darkQuery.matches;

    // 工作區底色：白頁面放在白底上看不到邊界——鋪一層中性「桌面」色，
    // 頁面用陰影浮起來（Figma／Keynote 同語彙）。跟著系統深淺色走。
    // 這一層（底色＋陰影）只跟 view 變換有關，快取起來：影片播放時 view 沒動，
    // 每格只剩一次 drawImage。
    const key = `${this.view.scale},${this.view.tx},${this.view.ty},${this.canvas.width},${this.canvas.height},${stage.w},${stage.h},${dark},${dpr}`;
    if (this.backdrop?.key !== key) {
      const c = this.backdrop?.canvas ?? document.createElement("canvas");
      c.width = this.canvas.width; c.height = this.canvas.height;
      const bx = c.getContext("2d")!;
      bx.setTransform(dpr, 0, 0, dpr, 0, 0);
      bx.fillStyle = dark ? "#232428" : "#e7e8ec";
      bx.fillRect(0, 0, c.width, c.height);
      bx.translate(this.view.tx, this.view.ty);
      bx.scale(this.view.scale, this.view.scale);
      bx.save();
      bx.shadowColor = "rgba(0,0,0,0.30)";
      bx.shadowBlur = 26 * this.view.scale;
      bx.shadowOffsetY = 8 * this.view.scale;
      bx.fillStyle = "#ffffff";   // 只是墊陰影的底，頁面自己的背景色會蓋上來
      bx.fillRect(stage.x, stage.y, stage.w, stage.h);
      bx.restore();
      this.backdrop = { key, canvas: c };
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.backdrop.canvas, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.translate(this.view.tx, this.view.ty);
    ctx.scale(this.view.scale, this.view.scale);

    const m = this.marquee;
    renderStage(ctx, this.project,
      { placeholderForMissingMedia: true, images: this.images, videos: this.videos,
        filters: this.filters, skipBlockId: this.editing?.id,
        viewRect: this.visibleRect() }, {
      hideProjectGuides: this.guidesHidden,
      // 多選時多畫一圈群組外框——手把長在它的右下角，沒有框就看不出那顆在管什麼
      selection: [
        ...this.selectionBlocks().map((b) => rotatedBounds(b.frame, b.rotation)),
        ...(this.multi.size > 1 && !this.editing ? [this.groupBox()].filter((r): r is Rect => !!r) : []),
      ],
      marquee: m ? {
        x: Math.min(m.from.x, m.to.x), y: Math.min(m.from.y, m.to.y),
        w: Math.abs(m.to.x - m.from.x), h: Math.abs(m.to.y - m.from.y),
      } : undefined,
      handles: this.handlePoints(),
      guides: this.guides,
      badges: this.badges,
    });
    const ms = performance.now() - ft0;
    this.frameStats.ms = this.frameStats.ms * 0.8 + ms * 0.2;
    this.frameStats.paints++;
  };
}
