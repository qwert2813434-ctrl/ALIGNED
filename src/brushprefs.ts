// 筆刷偏好設定視窗（2026-08-26，藍圖＝樣本間 ALIGNED偏好設定-Mac.html）。
// 三欄：筆刷清單｜調整｜試畫畫布。P1 只開放軟鉛筆的參數（未定預設：現有五支
// 維持現狀零風險，mock 已示範開放版，要開隨時有藍圖）；參數跟使用者走
// （localStorage；紙張與紋路搬進專案檔是 P3 檔案欄位定稿的事）。
// 鐵則：試畫畫布不跟主題（匯出成品不受外殼配色影響）——紙色固定 #FBF8F0。
import { __ } from "./i18n";
import {
  BRUSHES, BRUSH_ORDER, SOFT_DEFAULTS, drawDoodle, getSoftPrefs, setSoftPrefs,
  speedPress, type DoodleBlock, type SoftPrefs,
} from "./core/doodle";

const LS = "alignedSoftPrefs";

/** 開機讀回偏好（main.ts boot 呼叫一次）。壞 JSON＝回預設，不炸。 */
export function initSoftPrefs(): void {
  try {
    const j = localStorage.getItem(LS);
    if (j) setSoftPrefs(JSON.parse(j) as Partial<SoftPrefs>);
  } catch { /* 回預設 */ }
}

function persist(p: SoftPrefs): void {
  setSoftPrefs(p);
  try { localStorage.setItem(LS, JSON.stringify(p)); } catch { /* 私隱模式等：只影響下次開機 */ }
}

// ── 畫布幾何（與 mock 同）────────────────────────────────────────────
const CW = 520, CH = 432;
const DPR = Math.min(2, window.devicePixelRatio || 1);

interface PStroke { pts: { x: number; y: number }[]; w: number; color: string; press: number[] }

/** 預覽筆畫 → 正式渲染器吃的 DoodleBlock（frame＝整張畫布，紋理化就鎖在畫布上）。 */
function toBlock(strokes: PStroke[], brush: string): DoodleBlock {
  const short = Math.min(CW, CH);
  return { strokes: strokes.map((s) => ({
    pts: s.pts.flatMap((p) => [p.x / CW, p.y / CH]),
    w: s.w / short, color: s.color, brush, press: s.press,
  })) };
}

function sampleStroke(w: number, x0: number, y0: number, len: number, amp: number,
                      pressFn: (u: number) => number, color: string): PStroke {
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i <= 90; i++) {
    const u = i / 90;
    pts.push({ x: x0 + u * len, y: y0 + Math.sin(u * Math.PI * 1.7) * amp });
  }
  return { pts, w, color, press: pts.map((_, i) => pressFn(i / (pts.length - 1))) };
}

/** 測試線：開發驗筆刷的同一組線做成按鈕（樣本間定案；清空＝全空白）。 */
const DEMOS: Record<string, (color: string) => PStroke[]> = {
  ramp: (c) => [sampleStroke(10, 40, 75, 440, 24, (u) => 0.18 + 1.1 * u, c)],
  fade: (c) => [sampleStroke(10, 40, 165, 440, 24, (u) => 1.3 - 1.1 * u, c)],
  sketch: (c) => [sampleStroke(6, 40, 250, 300, 10, (u) => 0.3 + 0.2 * Math.sin(u * 8), c)],
  hatch: (c) => {
    const out: PStroke[] = [];
    for (let k = 0; k < 7; k++) {
      const x0 = 368 + k * 17;
      const pts = Array.from({ length: 14 }, (_, i) => ({ x: x0 + 30 * (i / 13), y: 405 - 60 * (i / 13) }));
      out.push({ pts, w: 7, color: c, press: pts.map((_, i) => 0.95 - 0.55 * (i / 13)) });
    }
    return out;
  },
  loops: (c) => {
    const pts: { x: number; y: number }[] = [];
    for (let i = 0; i <= 300; i++) {
      const t = i / 300, ang = t * 6.2832 * 3, r = 1 - 0.68 * t;
      pts.push({ x: 260 + Math.cos(ang) * 95 * r, y: 300 + Math.sin(ang) * 80 * r });
    }
    return [{ pts, w: 8, color: c, press: pts.map((_, i) => 0.5 + 0.42 * Math.sin((i / 300) * Math.PI * 6 + 1)) }];
  },
};

const SWATCHES = ["1A1A1A", "D23B2A", "2F7CF6", "F5C518", "2EC4B6", "FF4D84"];

/** 拉桿定義（只開軟鉛筆；標籤／範圍照 mock，預設＝SOFT_DEFAULTS）。 */
interface Ctl { key: keyof SoftPrefs; label: string; min: number; max: number; step: number; grp: string;
  fmt?: (v: number) => string }
const pctf = (v: number): string => `${Math.round(v * 100)}%`;
const CTLS: Ctl[] = [
  { key: "spd", label: "速度影響（無筆壓時）", min: 0, max: 1, step: 0.05, grp: "basic", fmt: pctf },
  { key: "gain", label: "基礎黑度", min: 0.5, max: 4, step: 0.05, grp: "press", fmt: pctf },   // 8/26 小高頂到 250%＝擴
  { key: "tip", label: "收筆", min: 0, max: 2.5, step: 0.1, grp: "press", fmt: (v) => v.toFixed(1) },
  { key: "tooth", label: "紋路強度", min: 0, max: 1.5, step: 0.05, grp: "grain", fmt: pctf },
  { key: "gscale", label: "紋路比例", min: 0.1, max: 3, step: 0.05, grp: "grain", fmt: pctf },   // 8/26 頂到 145%＝擴
  { key: "ts", label: "紋路粗細", min: 0.1, max: 1, step: 0.05, grp: "grain", fmt: (v) => v.toFixed(2) },
  { key: "aspect", label: "紋路拉伸", min: 0.35, max: 2.8, step: 0.05, grp: "grain", fmt: pctf },
  { key: "goo", label: "黏性（霧感融合）", min: 0, max: 1.5, step: 0.02, grp: "adv", fmt: pctf },
  { key: "scExp", label: "散布成長（放大時收斂）", min: 0, max: 1, step: 0.05, grp: "adv", fmt: pctf },
  { key: "scatter", label: "散布", min: 0, max: 2, step: 0.05, grp: "adv", fmt: pctf },
  { key: "grain", label: "顆粒", min: 0.2, max: 2, step: 0.05, grp: "adv", fmt: pctf },
];
const PAPERS = ["紙張：細紋", "紙張：粗紋・水彩紙", "紙張：織紋・帆布", "紙張：纖維・和紙", "紙張：平滑・影印紙", "紙張：無紋"];
const GMODES = ["紋路行為：移動（跟著筆跑）", "紋路行為：紋理化（鎖畫布）"];

let overlay: HTMLDivElement | null = null;

export function openBrushPrefs(onChanged?: () => void): void {
  if (overlay) return;
  injectStyle();
  overlay = document.createElement("div");
  overlay.id = "brushprefs";
  overlay.innerHTML = `<div class="bp-panel">
    <div class="bp-head">
      <span class="bp-title">${__("筆刷偏好設定")}</span>
      <button class="bp-close" aria-label="${__("關閉")}">✕</button>
    </div>
    <div class="bp-app">
      <aside class="bp-side"><div class="bp-sect">${__("筆刷")}</div><div class="bp-list"></div></aside>
      <main class="bp-cfg"></main>
      <section class="bp-cv">
        <canvas class="bp-canvas"></canvas>
        <div class="bp-hint">${__("滑鼠、觸控板直接畫——用速度模擬筆壓。測試線按了就蓋上去，可以連按疊加。")}</div>
        <div class="bp-tests"></div>
      </section>
    </div>
  </div>`;
  document.body.append(overlay);
  overlay.addEventListener("pointerdown", (e) => { if (e.target === overlay) close(); });
  overlay.querySelector(".bp-close")!.addEventListener("click", close);

  // ── 狀態 ──
  let cur = "soft";
  let color = SWATCHES[0];
  let penW = 10;
  let strokes: PStroke[] = [...DEMOS.ramp(color), ...DEMOS.fade(color), ...DEMOS.sketch(color)];
  let live: PStroke | null = null;

  const canvas = overlay.querySelector<HTMLCanvasElement>(".bp-canvas")!;
  canvas.width = CW * DPR; canvas.height = CH * DPR;
  canvas.style.width = `${CW}px`; canvas.style.height = `${CH}px`;
  const g = canvas.getContext("2d")!;
  // 背景快取：已完成筆畫烤一張，畫中只 blit＋畫進行那一筆（樣本間 iPad 實踩的底線）
  const bg = document.createElement("canvas");
  bg.width = CW * DPR; bg.height = CH * DPR;
  const bgg = bg.getContext("2d")!;

  const paintInto = (ctx: CanvasRenderingContext2D, list: PStroke[]): void => {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    drawDoodle(ctx, toBlock(list, cur), CW, CH);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  };
  const bake = (): void => {
    bgg.setTransform(1, 0, 0, 1, 0, 0);
    bgg.fillStyle = "#FBF8F0";
    bgg.fillRect(0, 0, bg.width, bg.height);
    paintInto(bgg, strokes);
    paint();
  };
  const paint = (): void => {
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(bg, 0, 0);
    if (live && live.pts.length > 1) paintInto(g, [live]);
  };

  // ── 手繪（速度模擬筆壓；spd 偏好與 editor 同一條路）──
  const finishPress = (pts: { x: number; y: number }[]): number[] => {
    const press = speedPress(pts, penW);
    const k = getSoftPrefs().spd;
    return cur === "soft" && k < 1 ? press.map((v) => 1 + (v - 1) * k) : press;
  };
  let raf = 0;
  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    live = { pts: [{ x: e.offsetX, y: e.offsetY }], w: penW, color, press: [] };
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!live) return;
    live.pts.push({ x: e.offsetX, y: e.offsetY });
    live.press = finishPress(live.pts);
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; paint(); });
  });
  const up = (): void => {
    if (!live) return;
    if (live.pts.length > 1) { live.press = finishPress(live.pts); strokes.push(live); }
    live = null;
    bake();
  };
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);

  // ── 測試線列 ──
  const tests = overlay.querySelector<HTMLDivElement>(".bp-tests")!;
  const tbtn = (label: string, fn: () => void, cls = ""): void => {
    const b = document.createElement("button");
    b.className = `bp-act ${cls}`; b.type = "button"; b.textContent = label;
    b.addEventListener("click", fn);
    tests.append(b);
  };
  for (const [key, label] of [["ramp", "漸強"], ["fade", "漸弱"], ["sketch", "速寫"], ["hatch", "排線"], ["loops", "畫圈"]] as const) {
    tbtn(__(label), () => { strokes.push(...DEMOS[key](color)); bake(); });
  }
  tbtn(__("清空"), () => { strokes = []; bake(); }, "bp-clr");

  // ── 左：筆刷清單（軟鉛筆＋現有五支；縮圖走正式渲染器）──
  const listEl = overlay.querySelector<HTMLDivElement>(".bp-list")!;
  const order = ["soft", ...BRUSH_ORDER.filter((k) => k !== "soft")];
  const thumbs: (() => void)[] = [];
  for (const id of order) {
    const row = document.createElement("button");
    row.className = "bp-row"; row.type = "button";
    row.innerHTML = `<span class="bp-bn">${__(BRUSHES[id]?.name ?? id)}${
      id === "soft" ? '<i class="bp-new">New</i>' : ""}</span>`;
    const tc = document.createElement("canvas");
    const TW = 172, TH = 40;
    tc.width = TW * DPR; tc.height = TH * DPR;
    tc.style.width = `${TW}px`; tc.style.height = `${TH}px`;
    row.append(tc);
    const drawThumb = (): void => {
      const tg = tc.getContext("2d")!;
      tg.setTransform(1, 0, 0, 1, 0, 0);
      tg.clearRect(0, 0, tc.width, tc.height);
      tg.setTransform(DPR, 0, 0, DPR, 0, 0);
      const st = sampleStroke(8, 12, TH / 2, TW - 24, 8, (u) => 0.35 + 0.85 * Math.sin(u * Math.PI), "1A1A1A");
      const short = Math.min(TW, TH);
      tg.save();
      drawDoodle(tg, { strokes: [{ pts: st.pts.flatMap((p) => [p.x / TW, p.y / TH]),
        w: st.w / short, color: inkHex(), brush: id, press: st.press }] }, TW, TH);
      tg.restore();
    };
    thumbs.push(drawThumb);
    drawThumb();
    row.addEventListener("click", () => {
      cur = id;
      for (const r of Array.from(listEl.querySelectorAll(".bp-row"))) r.classList.toggle("on", r === row);
      buildCfg(); bake();
    });
    if (id === cur) row.classList.add("on");
    listEl.append(row);
  }

  // ── 中：調整 ──
  const cfg = overlay.querySelector<HTMLElement>(".bp-cfg")!;
  const buildCfg = (): void => {
    cfg.innerHTML = "";
    const h = document.createElement("div");
    h.className = "bp-bt";
    h.textContent = __(BRUSHES[cur]?.name ?? cur);
    cfg.append(h);

    // 顏色（試畫用）
    const sw = document.createElement("div"); sw.className = "bp-swatches";
    for (const c of SWATCHES) {
      const d = document.createElement("button");
      d.className = "bp-sw"; d.type = "button"; d.style.background = `#${c}`;
      if (c === color) d.classList.add("on");
      d.addEventListener("click", () => {
        color = c;
        for (const x of Array.from(sw.children)) x.classList.toggle("on", x === d);
      });
      sw.append(d);
    }
    cfg.append(sw);

    // 筆寬（試畫用，不是偏好）
    cfg.append(slider(__("筆寬（試畫）"), penW, 2, 40, 1, (v) => String(v), (v) => { penW = v; }));

    if (cur !== "soft") {
      const n = document.createElement("p");
      n.className = "bp-note";
      n.textContent = __("這支筆刷的參數未開放——維持現狀零風險。要開放隨時有藍圖（樣本間 mock 已示範）。");
      cfg.append(n);
      return;
    }

    const p = getSoftPrefs();
    const apply = (): void => { persist(p); bake(); onChanged?.(); };
    const sect = (label: string): void => {
      const el = document.createElement("div");
      el.className = "bp-sect"; el.textContent = label;
      cfg.append(el);
    };
    const grp = (name: string): void => {
      for (const c of CTLS.filter((x) => x.grp === name)) {
        cfg.append(slider(__(c.label), p[c.key], c.min, c.max, c.step,
                          c.fmt ?? ((v) => v.toFixed(2)), (v) => { p[c.key] = v; apply(); }));
      }
    };
    sect(__("基本")); grp("basic");
    sect(__("筆壓")); grp("press");
    sect(__("紙張與紋路"));
    cfg.append(select(PAPERS.map((x) => __(x)), p.paper, (v) => { p.paper = v; apply(); }));
    cfg.append(select(GMODES.map((x) => __(x)), p.gmode, (v) => { p.gmode = v; apply(); }));
    grp("grain");
    sect(__("進階")); grp("adv");

    const foot = document.createElement("div"); foot.className = "bp-foot";
    const info = document.createElement("span");
    info.textContent = __("參數只影響之後畫的筆畫——畫過的已烤進筆畫，不會回頭變。預設＝8/26 實機定的那組。");
    const reset = document.createElement("button");
    reset.className = "bp-act"; reset.type = "button"; reset.textContent = __("恢復預設");
    reset.addEventListener("click", () => {
      persist({ ...SOFT_DEFAULTS });
      buildCfg(); bake(); onChanged?.();
    });
    foot.append(info, reset);
    cfg.append(foot);
  };
  buildCfg();
  bake();
}

function inkHex(): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue("--ink").trim();
  return v.startsWith("#") ? v.slice(1) : "1A1A1A";
}

function slider(label: string, value: number, min: number, max: number, step: number,
                fmt: (v: number) => string, set: (v: number) => void): HTMLDivElement {
  const wrap = document.createElement("div");
  wrap.className = "bp-ctl";
  const lab = document.createElement("label");
  const name = document.createElement("span"); name.textContent = label;
  const out = document.createElement("output"); out.textContent = fmt(value);
  lab.append(name, out);
  const r = document.createElement("input");
  r.type = "range"; r.min = String(min); r.max = String(max); r.step = String(step); r.value = String(value);
  r.addEventListener("input", () => {
    const v = Number(r.value);
    out.textContent = fmt(v);
    set(v);
  });
  wrap.append(lab, r);
  return wrap;
}

function select(options: string[], value: number, set: (v: number) => void): HTMLSelectElement {
  const el = document.createElement("select");
  el.className = "bp-select";
  options.forEach((label, i) => {
    const o = document.createElement("option");
    o.value = String(i); o.textContent = label;
    el.append(o);
  });
  el.value = String(value);
  el.addEventListener("change", () => set(Number(el.value)));
  return el;
}

function close(): void { overlay?.remove(); overlay = null; }

function injectStyle(): void {
  if (document.getElementById("bp-style")) return;
  const s = document.createElement("style");
  s.id = "bp-style";
  s.textContent = `
  #brushprefs { position: fixed; inset: 0; z-index: 60;
    background: color-mix(in srgb, var(--ink) 18%, transparent);
    display: flex; align-items: center; justify-content: center; }
  #brushprefs .bp-panel { width: min(1060px, 94vw); max-height: 88vh; display: flex;
    flex-direction: column; background: var(--card); color: var(--ink);
    border: 1px solid var(--line); border-radius: 14px; overflow: hidden; }
  #brushprefs .bp-head { display: flex; align-items: center; padding: 12px 16px 10px;
    border-bottom: 1px solid var(--line); }
  #brushprefs .bp-title { font-size: 14px; font-weight: 600; flex: 1; }
  #brushprefs .bp-close { border: none; background: transparent; color: var(--ink2);
    font-size: 14px; cursor: pointer; padding: 4px 6px; }
  #brushprefs .bp-app { display: grid; grid-template-columns: 208px minmax(240px, 1fr) 552px;
    min-height: 0; flex: 1; }
  #brushprefs .bp-side { border-right: 1px solid var(--line); padding: 12px 8px;
    overflow-y: auto; scrollbar-width: thin; }
  #brushprefs .bp-sect { font-size: 11px; letter-spacing: .18em; color: var(--ink2);
    font-weight: 600; margin: 14px 0 8px 4px; }
  #brushprefs .bp-side .bp-sect { margin-top: 0; }
  #brushprefs .bp-row { display: block; width: 100%; text-align: left; background: none;
    border: none; border-radius: 10px; padding: 8px 9px; cursor: pointer; font: inherit;
    color: var(--ink); margin-bottom: 2px; }
  #brushprefs .bp-row:hover { background: color-mix(in srgb, var(--ink) 6%, transparent); }
  #brushprefs .bp-row.on { background: rgba(47,124,246,.13); }
  #brushprefs .bp-row.on .bp-bn { color: #2F7CF6; }
  #brushprefs .bp-bn { display: block; font-size: 13px; font-weight: 600; margin-bottom: 4px; }
  #brushprefs .bp-new { font-style: normal; font-size: 9px; font-weight: 700; color: #2F7CF6;
    border: 1px solid rgba(47,124,246,.4); border-radius: 4px; padding: 0 4px; margin-left: 6px;
    vertical-align: 1px; }
  #brushprefs .bp-cfg { padding: 14px 18px 18px; overflow-y: auto; scrollbar-width: thin; }
  #brushprefs .bp-bt { font-size: 15px; font-weight: 600; margin-bottom: 10px; }
  #brushprefs .bp-note { font-size: 12px; color: var(--ink2); line-height: 1.7;
    background: color-mix(in srgb, var(--ink) 6%, transparent); border-radius: 8px;
    padding: 10px 12px; }
  #brushprefs .bp-swatches { display: flex; gap: 8px; margin: 2px 0 12px; }
  #brushprefs .bp-sw { width: 22px; height: 22px; border-radius: 50%;
    border: 1px solid var(--line); cursor: pointer; padding: 0; }
  #brushprefs .bp-sw.on { box-shadow: 0 0 0 2.5px #2F7CF6; }
  #brushprefs .bp-ctl { margin-bottom: 11px; }
  #brushprefs .bp-ctl label { display: flex; justify-content: space-between;
    font-size: 12px; color: var(--ink2); margin-bottom: 3px; }
  #brushprefs .bp-ctl output { font-variant-numeric: tabular-nums; color: var(--ink);
    font-weight: 600; }
  #brushprefs .bp-ctl input[type=range] { width: 100%; accent-color: #2F7CF6; display: block; }
  #brushprefs .bp-select { width: 100%; font: inherit; font-size: 12.5px; padding: 6px 9px;
    border: 1px solid var(--line); border-radius: 8px; background: var(--card);
    color: var(--ink); margin-bottom: 10px; }
  #brushprefs .bp-foot { display: flex; justify-content: space-between; align-items: center;
    gap: 12px; border-top: 1px solid var(--line); margin-top: 14px; padding-top: 12px;
    font-size: 11.5px; color: var(--ink2); line-height: 1.6; }
  #brushprefs .bp-cv { border-left: 1px solid var(--line); padding: 16px;
    display: flex; flex-direction: column; gap: 8px; overflow-y: auto; }
  #brushprefs .bp-canvas { border-radius: 10px; background: #FBF8F0; cursor: crosshair;
    touch-action: none; border: 1px solid var(--line); align-self: center; }
  #brushprefs .bp-hint { font-size: 11px; color: var(--ink2); line-height: 1.7; }
  #brushprefs .bp-tests { display: flex; gap: 8px; flex-wrap: wrap; }
  #brushprefs .bp-tests .bp-clr { margin-left: auto; }
  #brushprefs .bp-act { white-space: nowrap; font: inherit; font-size: 12px; padding: 5px 13px;
    border-radius: 999px; border: 1px solid var(--line); background: var(--card);
    color: var(--ink); cursor: pointer; }
  #brushprefs .bp-act:hover { background: color-mix(in srgb, var(--ink) 8%, transparent); }`;
  document.head.append(s);
}
