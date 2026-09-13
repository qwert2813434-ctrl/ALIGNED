import { renderPageCanvas, renderCounters } from "./core/render";
import { loadFilterAssets } from "./core/filters";
import { doodleCounters, drawDoodle } from "./core/doodle";
import type { Project } from "./core/schema";
const FA = await loadFilterAssets();
const log: string[] = []; let bad = 0;
const ck = (n: string, ok: boolean, i = ""): void => { if (!ok) bad++; log.push(`${ok ? "PASS" : "FAIL"}　${n}　${i}`); };
const im = (w: number, h: number, hue: number): HTMLCanvasElement => {
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const g = c.getContext("2d")!; g.fillStyle = `hsl(${hue},80%,50%)`; g.fillRect(0, 0, w, h); return c; };
const images = new Map<string, CanvasImageSource>([["a.jpg", im(4000, 3000, 10)]]);
const mk = (extra: Record<string, unknown> = {}, media: Record<string, unknown> = {}): Project => ({
  id: "P", name: "p", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  canvasWidth: 1080, pageHeight: 1350, pageCount: 1, paperKey: "c4",
  blocks: [{ id: "b1", locked: false, opacity: 1, rotation: 0, zIndex: 1,
    frame: { x: 60, y: 100, w: 700, h: 500 },
    content: { type: "image", media: { assetFileName: "a.jpg", cropRect: { x: 0, y: 0, w: 1, h: 1 }, ...media } },
    ...extra }] } as never as Project);
const o = { images, filters: FA } as unknown as Record<string, unknown>;
const px = (c: HTMLCanvasElement, x: number, y: number): string =>
  Array.from(c.getContext("2d")!.getImageData(x, y, 1, 1).data).join();
renderCounters.reset();
const c1 = renderPageCanvas(mk(), 0, o); const m1 = renderCounters.pageMiss;
renderCounters.reset(); const c2 = renderPageCanvas(mk(), 0, o);
ck("第一次重烤、第二次命中", m1 === 1 && renderCounters.pageHit === 1, `miss1=${m1} hit2=${renderCounters.pageHit}`);
ck("對外拿到的是複製品，不是快取本尊（膠捲會塞進 DOM）", c1 !== c2);
ck("複製品畫面一致", px(c1, 200, 250) === px(c2, 200, 250), `${px(c1, 200, 250)} vs ${px(c2, 200, 250)}`);
const moved = mk(); moved.blocks[0].frame = { x: 300, y: 100, w: 700, h: 500 } as never;
renderCounters.reset(); const c3 = renderPageCanvas(moved, 0, o);
ck("搬動一塊＝失效重烤", renderCounters.pageMiss === 1, `miss=${renderCounters.pageMiss}`);
ck("重烤畫面真的不同", px(c1, 200, 250) !== px(c3, 200, 250));
renderCounters.reset();
renderPageCanvas(mk(), 0, { images: new Map([["a.jpg", im(4000, 3000, 200)]]), filters: FA } as never);
ck("換素材（JSON 沒變）也要失效", renderCounters.pageMiss === 1, `miss=${renderCounters.pageMiss}`);
renderCounters.reset();
renderPageCanvas(mk(), 0, { ...o, time: 1.5 } as never); renderPageCanvas(mk(), 0, { ...o, time: 2.7 } as never);
ck("播放中但頁上沒有會動的東西＝照樣快取", renderCounters.pageHit >= 1 && renderCounters.pageSkip === 0, `hit=${renderCounters.pageHit} skip=${renderCounters.pageSkip}`);
renderCounters.reset();
const anims = new Map([["b1", { kind: "fade", dur: 1 }]]);
renderPageCanvas(mk(), 0, { ...o, time: 1, anims } as never); renderPageCanvas(mk(), 0, { ...o, time: 2, anims } as never);
ck("真的在跑動畫的頁＝不可存", renderCounters.pageSkip === 2 && renderCounters.pageHit === 0, `skip=${renderCounters.pageSkip}`);
renderCounters.reset();
const vid = im(1920, 1080, 300);
renderPageCanvas(mk({}, { assetFileName: "v.mp4" }), 0, { images, videos: new Map([["v.mp4", vid]]), filters: FA } as never);
renderPageCanvas(mk({}, { assetFileName: "v.mp4" }), 0, { images, videos: new Map([["v.mp4", vid]]), filters: FA } as never);
ck("有影片即時影格＝不可存", renderCounters.pageSkip === 2, `skip=${renderCounters.pageSkip}`);

// 靜態塗鴉：互動時先給便宜輪廓，完整鉛筆在背景烤；匯出仍同步拿完整畫質。
const doodle = {
  strokes: Array.from({ length: 24 }, (_, row) => ({
    pts: Array.from({ length: 70 }, (_, i) => {
      const p = Math.floor(i / 2), x = 0.05 + (p / 34) * 0.9;
      return i % 2 === 0 ? x : 0.12 + row * 0.03 + Math.sin(p * 0.55 + row) * 0.01;
    }),
    w: 0.012, color: "243B68", brush: "pencil", press: Array(35).fill(0.82),
  })),
};
const doodleProject = mk({
  id: "static-doodle", frame: { x: 80, y: 120, w: 820, h: 760 },
  content: { type: "doodle", doodle },
}) as Project;
const sum = (c: HTMLCanvasElement): number => {
  const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
  let s = 0; for (let i = 0; i < d.length; i += 97) s = (s + d[i] + d[i + 3]) >>> 0;
  return s;
};
const ready = new Promise<boolean>((resolve) => {
  const timer = window.setTimeout(() => resolve(false), 5000);
  window.addEventListener("aligned:doodle-cache-ready", () => {
    window.clearTimeout(timer); resolve(true);
  }, { once: true });
});
doodleCounters.reset();
const outline = renderPageCanvas(doodleProject, 0, { ...o, deferStaticDoodles: true, doodlePriority: 0 } as never);
ck("互動畫面冷開不等待完整鉛筆", doodleCounters.miss === 1 && sum(outline) > 0,
  `miss=${doodleCounters.miss} checksum=${sum(outline)}`);
const backgroundReady = await ready;
const finalDeferred = renderPageCanvas(doodleProject, 0, { ...o, deferStaticDoodles: true, doodlePriority: 0 } as never);
const finalExport = renderPageCanvas(doodleProject, 0, { ...o, deferStaticDoodles: false } as never);
ck("背景完整塗鴉會完成並取代輪廓", backgroundReady && sum(finalDeferred) !== sum(outline),
  `ready=${backgroundReady} preview=${sum(outline)} final=${sum(finalDeferred)}`);
ck("互動完成圖與匯出完整圖一致", sum(finalDeferred) === sum(finalExport),
  `${sum(finalDeferred)} vs ${sum(finalExport)}`);

// 同一內容只留夠大的版本；縮小畫面不能再烤一遍、也不能製造尺寸快取風暴。
const oneMore = { strokes: [{ pts: [0.05, 0.15, 0.4, 0.8, 0.95, 0.2], w: 0.025,
  color: "A12C4A", brush: "pencil", press: [0.7, 0.9, 0.75] }] };
const large = document.createElement("canvas"); large.width = 1600; large.height = 1200;
const lg = large.getContext("2d")!; lg.scale(2, 2);
doodleCounters.reset(); drawDoodle(lg, oneMore, 800, 600);
const afterLarge = { hit: doodleCounters.hit, miss: doodleCounters.miss };
const small = document.createElement("canvas"); small.width = 400; small.height = 300;
drawDoodle(small.getContext("2d")!, oneMore, 400, 300);
ck("同內容大圖可直接供較小畫面使用", afterLarge.miss === 1 && doodleCounters.miss === 1 && doodleCounters.hit === afterLarge.hit + 1,
  `miss=${doodleCounters.miss} hit=${doodleCounters.hit}`);

const thumbOnly = { strokes: [{ pts: [0.1, 0.1, 0.9, 0.9], w: 0.02,
  color: "23846A", brush: "pencil", press: [0.8, 0.8] }] };
const thumb = document.createElement("canvas"); thumb.width = 160; thumb.height = 120;
const cachedBeforeThumb = doodleCounters.cached;
drawDoodle(thumb.getContext("2d")!, thumbOnly, 800, 600, undefined, undefined, true, 1);
await new Promise((resolve) => window.setTimeout(resolve, 80));
ck("頁條只畫辨識輪廓、不排完整鉛筆搶目前頁快取", doodleCounters.cached === cachedBeforeThumb,
  `cached=${doodleCounters.cached}`);
document.getElementById("out")!.textContent = log.join("\n") + `\n\n${log.length - bad} / ${log.length} 通過`;
