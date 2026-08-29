import { renderPageCanvas, renderCounters } from "./core/render";
import { loadFilterAssets } from "./core/filters";
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
document.getElementById("out")!.textContent = log.join("\n") + `\n\n${log.length - bad} / ${log.length} 通過`;
