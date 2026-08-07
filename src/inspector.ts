// 屬性檢視器——獨立元件（企劃約束：畫布／頁面膠捲／屬性檢視器三塊必須可分離，
// 摺疊機與手機版面靠這個）。
//
// 這層只做「顯示值＋回寫值」：直接改共享的 block 物件，改完呼叫 hooks 讓殼層
// 重畫／重算貼字盒。**改自己的值時不重建面板**——重建會把正在打字的輸入框炸掉。
import type { Block, MediaBlock, Project, ShapeBlock, TextAlign, TextBlock } from "./core/schema";
import { FONT_CHOICES, WEIGHT_LABELS, fontCatalog } from "./core/fonts";
import { FILTER_KEYS, FILTER_LABELS } from "./core/filters";
import type { GroupAlign, GroupAxis } from "./core/group";
import { CANVAS_PRESETS, canvasSize, simplifiedRatio } from "./core/canvas";

/** 圖層列的類型圖示（單色線性 SVG，絕不用 emoji 當 icon）。 */
const svg = (d: string): string =>
  `<svg width="13" height="13" viewBox="0 0 18 18" fill="none" stroke="currentColor"
    stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const LAYER_ICON: Record<Block["content"]["type"], string> = {
  text: svg('<path d="M4 5.4V4h10v1.4"/><path d="M9 4v10"/><path d="M7 14h4"/>'),
  textFlow: svg('<path d="M3.4 4.6h11"/><path d="M3.4 8h11"/><path d="M3.4 11.4h7.6"/><path d="M3.4 14.8h5"/>'),
  image: svg('<rect x="2.8" y="4" width="12.4" height="10" rx="1.6"/><circle cx="6.6" cy="7.6" r="1.1"/><path d="M3.2 12.4l3.4-2.6 3 2.2 2.2-1.6 3.2 2.2"/>'),
  video: svg('<rect x="2.8" y="4" width="12.4" height="10" rx="1.6"/><path d="M7.6 6.9l4 2.1-4 2.1z"/>'),
  shape: svg('<rect x="3.2" y="3.2" width="8" height="8" rx="1.2"/><circle cx="11.4" cy="11.4" r="3.4"/>'),
};
const LOCK_ON = svg('<rect x="4" y="8" width="10" height="6.4" rx="1.4"/><path d="M6.4 8V6.2a2.6 2.6 0 015.2 0V8"/>');
const LOCK_OFF = svg('<rect x="4" y="8" width="10" height="6.4" rx="1.4"/><path d="M6.4 8V6.2a2.6 2.6 0 015-1.1"/>');

/** 圖層列要顯示的名字。文字用內容前幾個字——那才是他認得出來的東西。 */
function layerName(b: Block): string {
  const c = b.content;
  if (c.type === "text" || c.type === "textFlow") {
    const t = c.text.text.replace(/\s+/g, " ").trim();
    return t ? (t.length > 14 ? `${t.slice(0, 14)}…` : t) : "（空白文字）";
  }
  if (c.type === "shape") {
    return { rectangle: "矩形", ellipse: "圓形", line: "線條" }[c.shape.kind] ?? "形狀";
  }
  return c.media.assetFileName ? (c.type === "video" ? "影片" : "圖片") : "空欄位";
}

export interface InspectorHooks {
  /** 值改完。retext＝文字內容或樣式有動，殼層要重算貼字盒。 */
  onChange: (opts?: { retext?: boolean }) => void;
  /** 濾鏡換了——殼層要確保「素材×濾鏡」的變體已生成。 */
  ensureVariant: (block: Block) => Promise<void>;
  reorder: (block: Block, dir: "front" | "back") => void;
  remove: (block: Block) => void;
  /** 空欄位填圖／既有媒體換檔（開選檔框、複製進 assets、必要時轉型 image↔video）。 */
  fillMedia: (block: Block) => void;
  /** 匯入字型檔（開選檔框→存 UserFonts→註冊）。回匯入結果，null＝取消或失敗。 */
  importFont?: () => Promise<{ label: string; value: string } | null>;
  /** 多選時的整組操作。 */
  /** 改整份專案的畫布形狀（頁內位置與尺寸都不動）。 */
  changeRatio: (w: number, h: number) => void;
  guides: {
    hidden: () => boolean;
    toggleHidden: () => void;
    add: (axis: "x" | "y") => void;
    remove: (axis: "x" | "y", index: number) => void;
    /** 鎖住＝畫布上滑鼠碰不到參考線（線還在、吸附照舊）。 */
    locked: () => boolean;
    toggleLocked: () => void;
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

  constructor(private el: HTMLElement, private hooks: InspectorHooks) {}

  /** 工具列的 icon 開關。回傳目前狀態，讓殼層去點亮按鈕。 */
  setPanel(p: SidePanel): SidePanel {
    this.panel = this.panel === p ? "none" : p;
    this.rebuild();
    return this.panel;
  }
  get activePanel(): SidePanel { return this.panel; }

  /** 在畫布上按到參考線：把面板切過去並標出那一條。 */
  focusGuide(axis: "x" | "y", index: number): void {
    this.hotGuide = { axis, index };
    this.panel = "guides";
    this.rebuild();
  }

  /** 換類型／換遮罩之類的結構變化後整面重建（值變化不重建——會炸掉正在打字的輸入框）。 */
  private rebuild(): void { this.show(this.project, this.block); }

  show(project: Project | null, block: Block | null): void {
    this.project = project;
    this.block = block;
    this.el.replaceChildren();
    if (project && this.panel !== "none") {
      const pin = document.createElement("div");
      pin.className = "pin";
      this.el.append(pin);
      const host = this.el;
      this.el = pin;
      if (this.panel === "guides") this.guidesPanel(project); else this.layersPanel(project);
      this.el = host;
    }
    if (!project || !block) {
      if (project) this.projectPanel(project);
      const hint = document.createElement("div");
      hint.className = "hint";
      hint.textContent = "點選畫布上的元件來調整；\n拖曳＝移動並吸附、方向鍵＝微移";
      this.el.append(hint);
      return;
    }
    this.common(block);
    switch (block.content.type) {
      case "text": case "textFlow": this.text(block.content.text); break;
      case "shape": this.shape(block.content.shape); break;
      case "image": case "video": this.media(block, block.content.media); break;
    }
  }

  /** 多選：顯示整組操作（對齊的基準是**這幾個東西自己的外框**，不是頁面）。 */
  showGroup(project: Project, blocks: Block[]): void {
    this.project = project;
    this.block = null;
    this.el.replaceChildren();
    const s = this.section(`已選 ${blocks.length} 個元件`);

    const pairs: [string, [GroupAlign, string][]][] = [
      ["水平對齊", [["left", "左"], ["hCenter", "中"], ["right", "右"]]],
      ["垂直對齊", [["top", "上"], ["vCenter", "中"], ["bottom", "下"]]],
    ];
    for (const [label, opts] of pairs) {
      const row = this.row(s, label);
      const seg = document.createElement("div");
      seg.className = "seg";
      for (const [edge, text] of opts) seg.append(this.btn(text, () => this.hooks.group.align(edge)));
      row.append(seg);
    }

    const dist = this.row(s, "等距分布");
    const dseg = document.createElement("div");
    dseg.className = "seg";
    const canDistribute = blocks.length >= 3;
    for (const [axis, text] of [["horizontal", "水平"], ["vertical", "垂直"]] as [GroupAxis, string][]) {
      const b = this.btn(text, () => this.hooks.group.distribute(axis));
      b.disabled = !canDistribute;      // 兩個之間沒有東西可以分
      b.title = canDistribute ? "" : "等距分布至少要選三個";
      dseg.append(b);
    }
    dist.append(dseg);

    const acts = this.row(s, "");
    acts.append(this.btn("複製一份", () => this.hooks.group.duplicate()));
    const danger = this.btn(`刪除 ${blocks.length} 個（⌫）`, () => this.hooks.group.remove());
    danger.className = "danger";
    acts.append(danger);

    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = "⇧／⌘ 點＝加減選、空白處拖曳＝框選；\n拖曳任一個＝整組移動（相對位置不變）";
    this.el.append(hint);
  }

  // ── 各區段 ──────────────────────────────────────────────────────────

  /** 沒選元件時給專案級的設定：紙張是**全專案單一**（逐頁不同紙會在頁縫露餡），
   *  頁面背景則是逐頁一格。 */
  private projectPanel(p: Project): void {
    const s = this.section("專案");
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
    if (!match) opts.unshift([`${p.canvasWidth}x${p.pageHeight}`, `${cur}　${p.canvasWidth}×${p.pageHeight}（目前）`]);
    this.row(s, "畫布比例").append(this.select(
      opts, `${p.canvasWidth}x${p.pageHeight}`,
      (v) => {
        const [w, h] = v.split("x").map(Number);
        if (w !== p.canvasWidth || h !== p.pageHeight) this.hooks.changeRatio(w, h);
      },
    ));
    this.row(s, "紙張").append(this.select(
      [["", "無"], ["c1", "報紙"], ["c3", "底片顆粒"], ["c4", "高級紙"]],
      p.paperKey ?? "",
      (v) => { p.paperKey = v || undefined; this.emit(); },
    ));
    const i = this.hooks.layers.currentPage();
    this.row(this.section("頁面背景"), `第 ${i + 1} 頁`).append(
      this.color(p.pageBackgroundHex?.[String(i)] ?? "FFFFFF", (hexNoHash) => {
        p.pageBackgroundHex = { ...(p.pageBackgroundHex ?? {}), [String(i)]: hexNoHash };
        this.emit();
      }),
    );
  }

  // ── 釘住的面板 ──────────────────────────────────────────────────────

  /** 參考線面板。**隱藏**只是不畫（線還在、吸附照舊）；**鎖定**是滑鼠碰不到。 */
  private guidesPanel(p: Project): void {
    const gs = this.section("參考線");
    const row = this.row(gs, "狀態");
    const eye = this.btn(this.hooks.guides.hidden() ? "已隱藏" : "顯示中",
                         () => { this.hooks.guides.toggleHidden(); this.rebuild(); });
    eye.classList.toggle("on", !this.hooks.guides.hidden());
    const lock = this.btn(this.hooks.guides.locked() ? "已鎖定" : "可拖曳",
                          () => { this.hooks.guides.toggleLocked(); this.rebuild(); });
    lock.classList.toggle("on", this.hooks.guides.locked());
    row.append(eye, lock);
    this.row(gs, "新增").append(
      this.btn("垂直線", () => this.hooks.guides.add("x")),
      this.btn("水平線", () => this.hooks.guides.add("y")),
    );
    const list: [string, "x" | "y", number[]][] = [
      ["垂直", "x", p.guidesX ?? []], ["水平", "y", p.guidesY ?? []],
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
          this.btn("刪除", () => this.hooks.guides.remove(axis, i)),
        );
      });
    }
    const hint = document.createElement("div");
    hint.className = "hint pinhint";
    hint.textContent = (p.guidesX?.length || p.guidesY?.length)
      ? (this.hooks.guides.locked() ? "已鎖定：畫布上碰不到，改數值或解鎖" : "畫布上可直接拖；拖出頁面外＝丟掉")
      : "還沒有參考線。加一條，或從畫布上拖出來";
    this.el.append(hint);
  }

  /** 圖層清單：由上而下＝由前而後（跟畫面的疊法一致，不是 zIndex 由小到大）。 */
  private layersPanel(p: Project): void {
    const page = this.hooks.layers.currentPage();
    const half = p.canvasWidth / 2;
    const onPage = p.blocks
      .filter((b) => Math.floor((b.frame.x + b.frame.w / 2) / p.canvasWidth) === page)
      .sort((a, b) => b.zIndex - a.zIndex);
    this.section(`圖層　第 ${page + 1} 頁`);
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
      lk.title = b.locked ? "解除鎖定" : "鎖定";
      lk.innerHTML = b.locked ? LOCK_ON : LOCK_OFF;
      lk.addEventListener("click", (e) => {
        e.stopPropagation();
        this.hooks.layers.toggleLock(b.id);
        this.rebuild();
      });
      row.append(ic, name, lk);
      row.addEventListener("click", (e) => this.hooks.layers.select(b.id, e.shiftKey || e.metaKey));
      this.makeLayerDraggable(box, row);
      box.append(row);
    }
    const hint = document.createElement("div");
    hint.className = "hint pinhint";
    hint.textContent = onPage.length ? "上＝最前面，拖曳換前後" : "這一頁還沒有元件";
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

  private common(b: Block): void {
    const s = this.section("位置與圖層");
    const pos = this.row(s, "位置");
    pos.append(
      this.num(b.frame.x, { step: 1 }, (v) => { b.frame.x = v; this.emit(); }),
      this.num(b.frame.y, { step: 1 }, (v) => { b.frame.y = v; this.emit(); }),
    );
    const size = this.row(s, "尺寸");
    const editable = b.content.type === "shape" || b.content.type === "image" || b.content.type === "video";
    // 文字的框是貼字盒（由內容決定），這裡不給改——改字級/欄寬才是正路
    size.append(
      this.num(Math.round(b.frame.w), { step: 1, disabled: !editable }, (v) => { b.frame.w = v; this.emit(); }),
      this.num(Math.round(b.frame.h), { step: 1, disabled: !editable }, (v) => { b.frame.h = v; this.emit(); }),
    );
    this.row(s, "旋轉").append(
      this.num(b.rotation, { min: -180, max: 180, step: 1 }, (v) => { b.rotation = v; this.emit(); }),
    );
    this.row(s, "不透明").append(
      this.range(b.opacity, 0, 1, 0.05, (v) => { b.opacity = v; this.emit(); }),
    );
    this.row(s, "鎖定").append(this.check(b.locked, (on) => {
      // 鎖定的元件點不到、拖不動、不長手把、群組對齊也略過（引擎本來就吃這個欄位）
      b.locked = on;
      this.rebuild();
      this.emit();
    }));
    const layer = this.row(s, "圖層");
    layer.append(
      this.btn("移到最前", () => this.hooks.reorder(b, "front")),
      this.btn("移到最後", () => this.hooks.reorder(b, "back")),
    );
    const danger = this.btn("刪除元件（⌫）", () => this.hooks.remove(b));
    danger.className = "danger";
    this.row(s, "").append(danger);
  }

  private text(t: TextBlock): void {
    const s = this.section("文字");
    const ta = document.createElement("textarea");
    ta.rows = 3;
    ta.value = t.text;
    ta.addEventListener("input", () => { t.text = ta.value; this.emit(true); });
    this.row(s, "內容").append(ta);

    this.row(s, "字型").append(this.fontSelect(t));
    this.row(s, "字重").append(this.select(
      WEIGHT_LABELS.map((l, i) => [String(i), l]),
      String(t.fontWeightValue ?? 3),
      (v) => { t.fontWeightValue = Number(v); this.emit(true); },
    ));
    this.row(s, "字級").append(
      this.num(t.fontSize ?? 49, { min: 8, max: 500, step: 1 }, (v) => { t.fontSize = v; this.emit(true); }),
    );
    // 字距用 em 制（新模型優先）；行高倍數 <1 可壓緊，這是 iOS 舊點制做不到的
    this.row(s, "字距 em").append(
      this.num(t.kerningEm ?? 0, { min: -0.05, max: 1.5, step: 0.01 }, (v) => { t.kerningEm = v; this.emit(true); }),
    );
    this.row(s, "行高 ×").append(
      this.num(t.lineHeightMultiple ?? 1, { min: 0.7, max: 2, step: 0.05 }, (v) => { t.lineHeightMultiple = v; this.emit(true); }),
    );

    const seg = this.row(s, "對齊");
    const alignBox = document.createElement("div");
    alignBox.className = "seg";
    const aligns: [TextAlign, string][] = [["leading", "左"], ["center", "中"], ["trailing", "右"]];
    for (const [val, label] of aligns) {
      const btn = this.btn(label, () => {
        t.alignment = val;
        for (const el of alignBox.children) el.classList.toggle("on", el === btn);
        this.emit(true);
      });
      btn.classList.toggle("on", t.alignment === val);
      alignBox.append(btn);
    }
    seg.append(alignBox);

    if (!t.vertical) {
      this.row(s, "段落間距").append(
        this.num(t.paragraphSpacingEm ?? 0, { min: 0, max: 3, step: 0.1 }, (v) => {
          t.paragraphSpacingEm = v > 0 ? v : undefined;
          this.emit(true);
        }),
      );
    }

    this.row(s, "直排").append(this.check(t.vertical === true, (on) => {
      // additive 慣例：false 存成 undefined，舊檔 byte 不變
      t.vertical = on ? true : undefined;
      this.rebuild();
      this.emit(true);
    }));
    if (t.vertical) {
      // 直排預設由右到左（中文的閱讀順序）；打開＝改成由左到右
      this.row(s, "欄序左起").append(this.check(t.verticalLeftToRight === true, (on) => {
        t.verticalLeftToRight = on ? true : undefined;
        this.emit(true);
      }));
    }
    this.row(s, "顏色").append(this.color(t.colorHex ?? "000000", (hex) => {
      t.colorHex = hex;
      t.inkColor = undefined;   // 渲染以 run 屬性優先，改色要把它清掉才吃 colorHex
      this.emit(true);
    }));

    // ── 長文框：固定容器（會裁切、吃文繞圖），與貼字盒是兩種語意 ──
    const bs = this.section("長文框");
    this.row(bs, "長文框").append(this.check(t.isBodyFrame === true, (on) => {
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
      const box = this.row(bs, "框大小");
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
      this.row(bs, "框內對齊").append(this.select(
        [["top", "上"], ["middle", "中"], ["bottom", "下"]],
        t.verticalAlignment ?? "top",
        (v) => { t.verticalAlignment = v as TextBlock["verticalAlignment"]; this.emit(true); },
      ));
    }

    // ── 渲染層特效：只是畫上去，不影響量測與貼字盒 ──
    const fx = this.section("特效");
    this.row(fx, "陰影").append(this.select(
      [["", "無"], ["soft", "柔和"], ["strong", "明顯"]],
      t.shadowStyle ?? "",
      (v) => { t.shadowStyle = v || undefined; this.rebuild(); this.emit(); },
    ));
    if (t.shadowStyle) {
      this.row(fx, "陰影色").append(this.color(t.shadowColorHex ?? "000000", (hex) => {
        t.shadowColorHex = hex; this.emit();
      }));
    }
    const bgOn = this.row(fx, "底色");
    bgOn.append(this.check(t.backgroundColorHex != null, (on) => {
      t.backgroundColorHex = on ? (t.backgroundColorHex ?? "FFE066") : undefined;
      this.rebuild();
      this.emit();
    }));
    if (t.backgroundColorHex != null) {
      bgOn.append(this.color(t.backgroundColorHex, (hex) => { t.backgroundColorHex = hex; this.emit(); }));
    }
  }

  private shape(sh: ShapeBlock): void {
    const s = this.section("形狀");
    this.row(s, "類型").append(this.select(
      [["rectangle", "矩形"], ["ellipse", "圓形"], ["line", "線條"]],
      sh.kind,
      (v) => { sh.kind = v as ShapeBlock["kind"]; this.rebuild(); this.emit(); },
    ));
    this.row(s, "顏色").append(this.color(sh.colorHex, (hex) => { sh.colorHex = hex; this.emit(); }));
    if (sh.kind === "rectangle") {
      this.row(s, "圓角").append(
        this.num(sh.cornerRadius ?? 0, { min: 0, max: 200, step: 1 }, (v) => { sh.cornerRadius = v; this.emit(); }),
      );
    }
    if (sh.kind === "line") {
      // 下限 0.25、一格 0.25——與 iOS 端 2026-08-01 的髮絲線修正同規格
      this.row(s, "粗細").append(
        this.num(sh.lineWidth ?? 8, { min: 0.25, max: 60, step: 0.25 }, (v) => { sh.lineWidth = v; this.emit(); }),
      );
    }
    this.wrapControls(s, () => sh);
  }

  private media(b: Block, m: MediaBlock): void {
    const s = this.section(b.content.type === "video" ? "影片" : "圖片");
    const pick = this.btn(m.assetFileName ? "更換圖片／影片…" : "選擇圖片／影片…",
                          () => this.hooks.fillMedia(b));
    this.row(s, "").append(pick);
    this.row(s, "濾鏡").append(this.select(
      [["", "無"], ...FILTER_KEYS.map((k) => [k, FILTER_LABELS[k]] as [string, string])],
      m.filterKey ?? "",
      (v) => {
        m.filterKey = v || undefined;
        // 變體要先生成再重畫，否則會閃一格佔位框
        this.hooks.ensureVariant(b).then(() => this.emit());
      },
    ));
    this.row(s, "遮罩").append(this.select(
      [["", "無"], ["rectangle", "圓角矩形"], ["ellipse", "橢圓"]],
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
      this.row(s, "圓角").append(
        this.range(m.maskCornerRadius ?? 0, 0, 1, 0.01, (v) => { m.maskCornerRadius = v; this.emit(); }),
      );
    }
    // 外框要「寬＋色」同時存在才會渲染——單獨動任一個都自動補上另一個的預設，
    // 不然使用者調了外框寬、畫面毫無反應（色票顯示白色但其實沒存過，2026-08-08 實案）
    this.row(s, "外框色").append(this.color(m.strokeHex ?? "FFFFFF", (hex) => {
      m.strokeHex = hex;
      if (!m.strokeWidth) { m.strokeWidth = 0.01; this.rebuild(); }
      this.emit();
    }));
    this.row(s, "外框寬").append(
      // 短邊的分數制——所以跨畫布尺寸會等比（與圖形線的點數制不同，是 iOS 的原始設計）
      this.num(m.strokeWidth ?? 0, { min: 0, max: 0.15, step: 0.005 }, (v) => {
        m.strokeWidth = v > 0 ? v : undefined;
        if (v > 0 && !m.strokeHex) m.strokeHex = "FFFFFF";
        this.emit();
      }),
    );
    if (m.assetFileName) {
      // 拉直：轉的是**內容**不是 block（與 iOS 裁切畫面的那個角度同一個欄位）
      this.row(s, "拉直").append(
        this.num(m.rotationDegrees ?? 0, { min: -45, max: 45, step: 0.5 }, (v) => {
          m.rotationDegrees = v !== 0 ? v : undefined;
          this.emit();
        }),
      );
      // 裁切比例：改的是 block 的框（照片不動、裁切區跟著），與八點裁切同一套語意
      this.row(s, "裁切比例").append(this.select(
        [["", "自由"], ["1:1", "1:1"], ["4:5", "4:5"], ["3:4", "3:4"], ["16:9", "16:9"], ["9:16", "9:16"]],
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
    this.row(parent, "排開文字").append(this.check(o.excludesText === true, (on) => {
      o.excludesText = on ? true : undefined;
      this.rebuild();
      this.emit(true);
    }));
    if (o.excludesText) {
      this.row(parent, "排開方式").append(this.select(
        [["side", "單側"], ["around", "兩側"], ["push", "上下"]],
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
        warn.textContent = "這一頁沒有長文框，排開不會有反應——選那段文字，把「長文框」打開";
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

  private row(parent: HTMLElement, label: string): HTMLDivElement {
    const r = document.createElement("div");
    r.className = "row";
    const l = document.createElement("label");
    l.textContent = label;
    r.append(l);
    parent.append(r);
    return r;
  }

  private num(value: number, opts: { min?: number; max?: number; step?: number; disabled?: boolean },
              set: (v: number) => void): HTMLInputElement {
    const i = document.createElement("input");
    i.type = "number";
    if (opts.min != null) i.min = String(opts.min);
    if (opts.max != null) i.max = String(opts.max);
    i.step = String(opts.step ?? 1);
    i.value = String(Math.round(value * 100) / 100);
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

  private color(hexNoHash: string, set: (hexNoHash: string) => void): HTMLInputElement {
    const i = document.createElement("input");
    i.type = "color";
    i.value = `#${hexNoHash.slice(0, 6).padEnd(6, "0")}`;
    i.addEventListener("input", () => set(i.value.slice(1).toUpperCase()));
    return i;
  }

  /** 字型選單：介面字體／自訂（匯入檔）／系統字體 三組（剪映同款分法），
   *  最底下一列「匯入字型檔…」當動作項。正在用的字型三組都找不到時
   *  （別台電腦做的專案）補一個「未安裝」項，選單才不會靜靜跳回黑體。 */
  private fontSelect(t: TextBlock): HTMLSelectElement {
    const sel = document.createElement("select");
    const group = (label: string, items: { label: string; value: string }[]): void => {
      if (!items.length) return;
      const g = document.createElement("optgroup");
      g.label = label;
      for (const f of items) {
        const o = document.createElement("option");
        o.value = f.value; o.textContent = f.label;
        g.append(o);
      }
      sel.append(g);
    };
    group("介面字體", FONT_CHOICES);
    group("自訂", fontCatalog.custom);
    group("系統字體", fontCatalog.system);
    const cur = t.fontName ?? "";
    if (cur && ![...sel.options].some((o) => o.value === cur)) {
      const o = document.createElement("option");
      o.value = cur; o.textContent = `${cur}（未安裝）`;
      sel.append(o);
    }
    if (this.hooks.importFont) {
      const imp = document.createElement("option");
      imp.value = "__import__"; imp.textContent = "＋ 匯入字型檔…";
      sel.append(imp);
    }
    sel.value = cur;
    sel.addEventListener("change", () => {
      if (sel.value === "__import__") {
        sel.value = t.fontName ?? "";   // 先跳回原值——取消匯入時選單不能停在動作項上
        void this.hooks.importFont?.().then((f) => {
          if (!f) return;
          t.fontName = f.value || undefined;
          this.emit(true);
          this.show(this.project, this.block);   // 重建面板：新字型進選單並選中
        });
        return;
      }
      t.fontName = sel.value || undefined;
      this.emit(true);
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
}
