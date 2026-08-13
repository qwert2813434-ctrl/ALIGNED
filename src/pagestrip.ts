import { __ } from "./i18n";
// 頁面膠捲——獨立元件（與畫布、屬性檢視器同一條「三塊可分離」的約束）。
// 縮圖走 renderPageCanvas＝與匯出、編輯預覽同一條渲染路，看到什麼就是什麼。
//
// 頁面操作全部收進**右鍵選單**：換順序用拖的（拖比按箭頭快，而且看得到落點），
// 其餘（複製整頁／插空白頁／刪除）不常用，不值得在膠捲上長期佔一排按鈕。
import type { Project } from "./core/schema";
import { renderPageCanvas, type RenderOptions } from "./core/render";

export type PageAction = "left" | "right" | "duplicate" | "delete";

export interface PageStripHooks {
  pick: (index: number) => void;
  act: (action: PageAction, index: number) => void;
  add: () => void;
  /** 把第 from 頁搬到第 to 頁（拖曳縮圖）。 */
  move: (from: number, to: number) => void;
  /** 右鍵：頁面操作選單交給殼層畫（與畫布右鍵是同一個選單元件）。 */
  menu: (index: number, at: { x: number; y: number }) => void;
}

/** 單色線性 icon（絕不用 emoji 當 icon）。 */
const ICON = {
  add: '<path d="M9 4.2v9.6"/><path d="M4.2 9h9.6"/>',
};

function iconButton(kind: keyof typeof ICON, title: string, fn: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.title = title;
  b.innerHTML = `<svg width="15" height="15" viewBox="0 0 18 18" fill="none" stroke="currentColor"
    stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ICON[kind]}</svg>`;
  b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
  return b;
}

export class PageStrip {
  constructor(private el: HTMLElement, private hooks: PageStripHooks) {}

  /**
   * 拖著縮圖換頁序。用指標事件不用 HTML5 drag——後者在 WKWebView 裡的拖曳影像
   * 與放置點都不受控，而且我們要的落點提示是「插在哪兩張之間」，不是「放到誰身上」。
   *
   * 手感：**長按或拖一下，卡片會浮起來跟著游標走**（原位留一張淡的），
   * 這樣才知道手上真的抓著東西——只把原卡變淡、看不到被抓的那張，會像卡住。
   */
  private makeDraggable(fig: HTMLElement, canvas: HTMLCanvasElement, index: number, count: number): void {
    canvas.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const startX = e.clientX, startY = e.clientY;
      let moved = false;
      let ghost: HTMLElement | null = null;
      let target = index;
      const figs = () => [...this.el.querySelectorAll<HTMLElement>("figure")]
        .filter((f) => !f.classList.contains("addpage"));

      const lift = (ev: { clientX: number; clientY: number }): void => {
        moved = true;
        fig.classList.add("dragging");
        try { canvas.setPointerCapture(e.pointerId); } catch { /* 合成事件沒有真的指標 */ }
        const r = canvas.getBoundingClientRect();
        ghost = document.createElement("div");
        ghost.className = "pageghost";
        const c2 = document.createElement("canvas");
        c2.width = canvas.width; c2.height = canvas.height;
        c2.style.width = `${r.width}px`; c2.style.height = `${r.height}px`;
        c2.getContext("2d")!.drawImage(canvas, 0, 0);
        ghost.append(c2);
        ghost.style.width = `${r.width}px`;
        document.body.append(ghost);
        ghost.dataset.dx = String(r.left - ev.clientX);
        ghost.dataset.dy = String(r.top - ev.clientY);
        follow(ev);
      };
      const follow = (ev: { clientX: number; clientY: number }): void => {
        if (!ghost) return;
        ghost.style.left = `${ev.clientX + Number(ghost.dataset.dx)}px`;
        ghost.style.top = `${ev.clientY + Number(ghost.dataset.dy)}px`;
      };
      // 長按也算拿起來——沒移動也想先看到「抓住了」
      const hold = setTimeout(() => { if (!moved) lift({ clientX: startX, clientY: startY }); }, 240);

      const onMove = (ev: PointerEvent) => {
        if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
        if (!moved) lift(ev); else follow(ev);
        // 落點＝指標最靠近哪一個縮圖的中心
        const boxes = figs().map((f) => f.getBoundingClientRect());
        target = boxes.findIndex((b, i) => ev.clientX < b.left + b.width / 2 || i === boxes.length - 1);
        if (target < 0) target = count - 1;
        figs().forEach((f, i) => {
          f.classList.toggle("dropleft", moved && i === target && target !== index);
        });
      };
      const onUp = () => {
        clearTimeout(hold);
        canvas.removeEventListener("pointermove", onMove);
        canvas.removeEventListener("pointerup", onUp);
        ghost?.remove();
        fig.classList.remove("dragging");
        for (const f of figs()) f.classList.remove("dropleft");
        if (moved && target !== index) this.hooks.move(index, target);
      };
      canvas.addEventListener("pointermove", onMove);
      canvas.addEventListener("pointerup", onUp);
    });
  }

  render(project: Project, opts: RenderOptions): void {
    this.el.replaceChildren();
    for (let i = 0; i < project.pageCount; i++) {
      const fig = document.createElement("figure");
      const c = renderPageCanvas(project, i, opts);
      c.addEventListener("click", () => this.hooks.pick(i));
      c.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.hooks.menu(i, { x: e.clientX, y: e.clientY });
      });
      this.makeDraggable(fig, c, i, project.pageCount);

      const cap = document.createElement("figcaption");
      cap.textContent = String(i + 1);
      fig.append(c, cap);
      this.el.append(fig);
    }
    const add = document.createElement("figure");
    add.className = "addpage";
    const btn = iconButton("add", __("新增一頁"), () => this.hooks.add());
    btn.className = "addtile";
    add.append(btn);
    this.el.append(add);
  }
}
