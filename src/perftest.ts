// 效能／匯出預覽驗證 harness（2026-09-05）：headless Chrome 跑 renderPageCanvas 本人，數字丟回 DOM。
// 題目＝小高第二批卡頓三條（大圖每幀縮、動畫 fps）＋第一批 #8（塗鴉有時不顯示在匯出預覽）。
import { renderPageCanvas, renderCounters } from "./core/render";
import { loadFilterAssets } from "./core/filters";
import type { Project, Block } from "./core/schema";
import type { BlockAnim } from "./core/anim";
const el = document.querySelector("#out")!;
el.textContent = "";
const out = (m: string): void => { el.textContent += m + "\n"; };
try {
  const FA = await loadFilterAssets();
  const im = (w: number, h: number, hue: number): HTMLCanvasElement => {
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const g = c.getContext("2d")!;
    const gr = g.createLinearGradient(0, 0, w, h);
    gr.addColorStop(0, `hsl(${hue},70%,40%)`); gr.addColorStop(1, `hsl(${hue + 60},70%,70%)`);
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 200; i++) { g.fillStyle = `hsl(${(hue + i * 7) % 360},60%,50%)`; g.fillRect((i * 97) % w, (i * 53) % h, 120, 80); }
    return c;
  };
  const images = new Map<string, CanvasImageSource>([["a.jpg", im(4000, 3000, 10)], ["b.jpg", im(4000, 3000, 120)], ["c.jpg", im(4000, 3000, 240)]]);
  const img = (id: string, file: string, x: number, y: number, anim?: BlockAnim): Block => ({
    id, frame: { x, y, w: 320, h: 240 }, rotation: 0, zIndex: 1, locked: false, opacity: 1,
    content: { type: "image", media: { assetFileName: file, cropRect: { x: 0, y: 0, w: 1, h: 1 } } }, anim,
  });
  const doodle = (id: string, y: number, extra: Record<string, unknown> = {}, anim?: BlockAnim): Block => ({
    id, frame: { x: 100, y, w: 800, h: 200 }, rotation: 0, zIndex: 5, locked: false, opacity: 1,
    content: { type: "doodle", doodle: { strokes: [{ pts: [0.1, 0.5, 0.9, 0.5], w: 0.08, color: "FF0000" }], ...extra } as never },
    anim,
  });
  const fade = (delay: number): BlockAnim => ({ kind: "fade", dur: 0.7, delay });
  const p: Project = {
    id: "perf", name: "perf", createdAt: "", updatedAt: "", canvasWidth: 1080, pageHeight: 1350, pageCount: 1,
    paperKey: "c4",
    blocks: [
      img("i1", "a.jpg", 40, 40, fade(0)), img("i2", "b.jpg", 380, 40, fade(0.2)), img("i3", "c.jpg", 720, 40, fade(0.4)),
      doodle("d1", 300),                                   // 靜態塗鴉
      doodle("d2", 600, { play: "travel" }),               // 巡線
      doodle("d3", 900, {}, { kind: "draw", dur: 1.5 }),   // 生長出場
    ],
  } as never as Project;
  const red = (c: HTMLCanvasElement, x: number, y: number): boolean => {
    const d = c.getContext("2d")!.getImageData(x, y, 1, 1).data; return d[0] > 180 && d[1] < 90 && d[2] < 90 && d[3] > 100;
  };
  const base = { images, mattes: images, filters: FA, placeholderForMissingMedia: false } as Record<string, unknown>;
  const anims = new Map<string, BlockAnim>(p.blocks.filter((b) => b.anim).map((b) => [b.id, b.anim!]));
  const ms = (f: () => void, n = 1): number => { const t0 = performance.now(); for (let i = 0; i < n; i++) f(); return (performance.now() - t0) / n; };
  // 時鐘校正：一段固定 CPU 工作，看 performance.now 走不走（headless 虛擬時間會讓它停）
  const cal = ms(() => { let s = 0; for (let i = 0; i < 3e7; i++) s += i % 7; if (s < 0) out("x"); });
  out(`clock: 3e7 loop = ${cal.toFixed(1)} ms（要 > 5 才是真時鐘）`);

  out("── 塗鴉 × 匯出預覽 ──");
  const y1 = 300 + 100, y2 = 600 + 100, y3 = 900 + 100, xm = 500;
  let c = renderPageCanvas(p, 0, base);
  out(`靜態匯出（time 無、無 anims）：靜態=${red(c, xm, y1)} 巡線=${red(c, xm, y2)} 生長=${red(c, xm, y3)}   ← 三個都該 true`);
  c = renderPageCanvas(p, 0, { ...base, transparent: true, onlyBlockIds: new Set(["i1"]) });
  out(`透明＋只留文字（onlyBlockIds 不含塗鴉）：靜態=${red(c, xm, y1)} 巡線=${red(c, xm, y2)} 生長=${red(c, xm, y3)}   ← 設計上 false`);
  c = renderPageCanvas(p, 0, { ...base, transparent: true });
  out(`透明、不只留文字：靜態=${red(c, xm, y1)} 巡線=${red(c, xm, y2)} 生長=${red(c, xm, y3)}   ← 該 true`);
  c = renderPageCanvas(p, 0, base);
  out(`再回靜態匯出（頁快取有沒有串味）：靜態=${red(c, xm, y1)} 巡線=${red(c, xm, y2)} 生長=${red(c, xm, y3)}   ← 該 true`);
  c = renderPageCanvas(p, 0, { ...base, anims, time: 0 });
  out(`動畫 t=0：靜態=${red(c, xm, y1)} 巡線=${red(c, xm, y2)} 生長=${red(c, xm, y3)}   ← 生長 false 正常（還沒長）`);
  c = renderPageCanvas(p, 0, { ...base, anims, time: 5 });
  out(`動畫 t=5：靜態=${red(c, xm, y1)} 巡線=${red(c, xm, y2)} 生長=${red(c, xm, y3)}   ← 三個都該 true`);
  c = renderPageCanvas(p, 0, { ...base, anims, time: 5, scale: 2 });
  out(`動畫 t=5 ×2：靜態=${red(c, xm * 2, y1 * 2)} 巡線=${red(c, xm * 2, y2 * 2)} 生長=${red(c, xm * 2, y3 * 2)}   ← 該 true`);

  out("── 卡頓 ──");
  renderCounters.reset();
  const t1 = ms(() => renderPageCanvas(p, 0, base), 5);
  out(`靜態頁（有巡線塗鴉＝整頁不能快取）：${t1.toFixed(1)} ms/幀  cutHit=${renderCounters.cutHit} cutMiss=${renderCounters.cutMiss} pageSkip=${renderCounters.pageSkip}`);
  const pStatic = { ...p, blocks: p.blocks.filter((b) => b.id !== "d2") } as Project;
  renderCounters.reset(); renderPageCanvas(pStatic, 0, base);
  const t2 = ms(() => renderPageCanvas(pStatic, 0, base), 10);
  out(`靜態頁（無巡線）第二次起：${t2.toFixed(1)} ms/幀  pageHit=${renderCounters.pageHit}`);
  for (const gpu of [false, true]) {
    renderCounters.reset();
    let n = 0;
    const tot = ms(() => { renderPageCanvas(p, 0, { ...base, anims, time: (n++ % 60) / 30, paperGPU: gpu }); }, 60);
    out(`動畫播放 60 幀（紙張 ${gpu ? "GPU" : "CPU"}）：${tot.toFixed(1)} ms/幀 ≈ ${(1000 / tot).toFixed(0)} fps  cutHit=${renderCounters.cutHit} cutMiss=${renderCounters.cutMiss} pageSkip=${renderCounters.pageSkip}`);
  }
  const pNoPaper = { ...p, paperKey: undefined } as Project;
  renderCounters.reset(); let n2 = 0;
  const t4 = ms(() => { renderPageCanvas(pNoPaper, 0, { ...base, anims, time: (n2++ % 60) / 30 }); }, 60);
  out(`動畫播放 60 幀（無紙張）：${t4.toFixed(1)} ms/幀 ≈ ${(1000 / t4).toFixed(0)} fps  cutHit=${renderCounters.cutHit} cutMiss=${renderCounters.cutMiss}`);
  renderCounters.reset();
  const zoomSteps = [1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9];
  const tz = ms(() => { for (const s of zoomSteps) renderPageCanvas(pStatic, 0, { ...base, scale: s }); }) / zoomSteps.length;
  out(`縮放 10 級（每級三張 12MP 重切）：${tz.toFixed(1)} ms/級  cutMiss=${renderCounters.cutMiss}`);
  renderCounters.reset();
  const tz2 = ms(() => { for (const s of zoomSteps) renderPageCanvas(pStatic, 0, { ...base, scale: s }); }) / zoomSteps.length;
  out(`同 10 級再走一次（切圖快取命中）：${tz2.toFixed(1)} ms/級  cutHit=${renderCounters.cutHit} cutMiss=${renderCounters.cutMiss}`);
  // 縮放的純切圖成本（無紙張）：12MP 來源（走 2560 替身）vs 5.9MP 來源（≤3000 不走替身）
  const pZoom = { ...pNoPaper, blocks: pNoPaper.blocks.filter((b) => b.content.type === "image") } as Project;
  const steps2 = [1, 1.13, 1.27, 1.41, 1.55, 1.69, 1.83, 1.97, 2.11, 2.25];
  renderCounters.reset();
  renderPageCanvas(pZoom, 0, { ...base, scale: 1 });   // 替身首烤不計
  const tzA = ms(() => { for (const s2 of steps2) renderPageCanvas(pZoom, 0, { ...base, scale: s2 }); }) / steps2.length;
  out(`縮放 10 級・無紙張・三張 12MP（走替身）：${tzA.toFixed(1)} ms/級  cutMiss=${renderCounters.cutMiss}`);
  const images2 = new Map<string, CanvasImageSource>([["a.jpg", im(2800, 2100, 10)], ["b.jpg", im(2800, 2100, 120)], ["c.jpg", im(2800, 2100, 240)]]);
  renderCounters.reset();
  const tzB = ms(() => { for (const s2 of steps2) renderPageCanvas(pZoom, 0, { ...base, images: images2, mattes: images2, scale: s2 }); }) / steps2.length;
  out(`縮放 10 級・無紙張・三張 5.9MP（不走替身）：${tzB.toFixed(1)} ms/級  cutMiss=${renderCounters.cutMiss}`);
  out(`done`);
} catch (e) { out("ERROR " + String(e) + "\n" + (e as Error).stack); }
