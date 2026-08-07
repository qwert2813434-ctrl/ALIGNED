// 匯出台的視窗：一台可拖曳、可縮放的窗，三種排法（分開／連續／摺頁）共用。
//
// 頁面在內容層裡以**原始匯出像素**排版，縮放只做一次 transform——
// 所以 100% 就真的是 1 像素對 1 像素，不是「大概那麼大」。
// 拆成獨立元件是為了測得到：指標 → 內容座標的換算是這裡唯一會出錯的地方，
// 而它只在瀏覽器裡才錯得出來（跟 Editor 同一個理由）。

export interface View { k: number; x: number; y: number }

export interface GalleryHooks {
  /** 縮放變了（更新百分比顯示） */
  zoom?: (k: number) => void;
  /** 點了第 index 張作品——拖畫面拖到一半放開不算點 */
  pick?: (index: number) => void;
}

const MIN_K = 0.04, MAX_K = 6;

export class Gallery {
  readonly view: View = { k: 1, x: 0, y: 0 };
  /** 使用者自己調過縮放／平移——視窗變大時就別擅自把他的視角重設掉 */
  touched = false;
  private fitBoth = true;
  private padX = 56;
  private padY = 52;
  private moved = false;

  constructor(
    private stage: HTMLElement,
    private shots: HTMLElement,
    private hooks: GalleryHooks = {},
  ) {
    stage.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    stage.addEventListener("pointerdown", (e) => this.onDown(e));
    // 雙擊：全覽 ↔ 100%（以游標為錨），跟 Preview 一樣的手感
    stage.addEventListener("dblclick", (e) => {
      const p = this.at(e);
      if (this.view.k < 0.98) this.zoomAt(1, p.x, p.y); else this.reset();
    });
    stage.addEventListener("click", (e) => {
      if (this.moved || !this.hooks.pick) return;
      const fig = (e.target as HTMLElement).closest("figure");
      if (!fig?.parentElement) return;
      this.hooks.pick([...fig.parentElement.children].indexOf(fig));
    });
  }

  private at(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.stage.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /** 換排法＝換一面牆。fitBoth＝整張看到（分開）；否則對齊高度、左右自己捲。 */
  setLayout(fitBoth: boolean, padY = 52): void {
    this.fitBoth = fitBoth;
    this.padY = padY;
    this.reset();
  }

  /** 回到起手式。上限鎖 100%——小專案不該被放大到糊掉。 */
  reset(): void {
    const cw = this.shots.offsetWidth, ch = this.shots.offsetHeight;  // offsetWidth 不受 transform 影響
    const pw = this.stage.clientWidth, ph = this.stage.clientHeight;
    if (!cw || !ch || !pw || !ph) return;
    const kw = (pw - this.padX * 2) / cw, kh = (ph - this.padY * 2) / ch;
    const k = Math.min(this.fitBoth ? Math.min(kw, kh) : kh, 1);
    const shown = cw * k;
    this.view.k = k;
    this.view.x = shown <= pw - this.padX * 2 ? (pw - shown) / 2 : this.padX;
    this.view.y = (ph - ch * k) / 2;
    this.touched = false;
    this.apply();
  }

  apply(): void {
    const v = this.view;
    this.shots.style.transform = `translate(${Math.round(v.x)}px, ${Math.round(v.y)}px) scale(${v.k})`;
    // 徽章與作品牌是說明、不是作品：反向縮放，讓它們的字級一直是同一個大小
    const inv = `scale(${1 / v.k})`;
    for (const el of this.shots.querySelectorAll<HTMLElement>(".vidbadge")) el.style.transform = inv;
    for (const el of this.shots.querySelectorAll<HTMLElement>("figcaption")) {
      el.style.transform = `translateX(-50%) ${inv}`;
    }
    this.hooks.zoom?.(v.k);
  }

  /** 以某一點為錨縮放——游標下的那一塊畫面不動，這是縮放唯一該有的感覺。 */
  zoomAt(k: number, px: number, py: number): void {
    const kn = Math.min(Math.max(k, MIN_K), MAX_K);
    this.view.x = px - (px - this.view.x) * (kn / this.view.k);
    this.view.y = py - (py - this.view.y) * (kn / this.view.k);
    this.view.k = kn;
    this.touched = true;
    this.apply();
  }

  /** 從畫面中心縮放（給按鈕與快捷鍵用——沒有游標位置可以當錨） */
  zoomBy(mul: number): void {
    this.zoomAt(this.view.k * mul, this.stage.clientWidth / 2, this.stage.clientHeight / 2);
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const p = this.at(e);
    // 觸控板：兩指捲＝平移、撐開＝縮放（撐開在 WebKit 是帶 ctrlKey 的 wheel）
    if (e.ctrlKey || e.metaKey) this.zoomAt(this.view.k * Math.exp(-e.deltaY * 0.0035), p.x, p.y);
    else { this.view.x -= e.deltaX; this.view.y -= e.deltaY; this.touched = true; this.apply(); }
  }

  private onDown(e: PointerEvent): void {
    if (e.button !== 0 && e.button !== 1) return;
    const sx = e.clientX, sy = e.clientY, vx = this.view.x, vy = this.view.y;
    this.moved = false;
    try { this.stage.setPointerCapture(e.pointerId); } catch { /* 合成事件沒有真的指標 */ }
    const mv = (ev: PointerEvent) => {
      if (!this.moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;   // 先過門檻，單擊還是單擊
      if (!this.moved) { this.moved = true; this.stage.classList.add("grabbing"); }
      this.view.x = vx + (ev.clientX - sx);
      this.view.y = vy + (ev.clientY - sy);
      this.touched = true;
      this.apply();
    };
    const up = (): void => {
      this.stage.removeEventListener("pointermove", mv);
      this.stage.removeEventListener("pointerup", up);
      this.stage.classList.remove("grabbing");
    };
    this.stage.addEventListener("pointermove", mv);
    this.stage.addEventListener("pointerup", up);
  }
}
