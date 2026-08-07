// 排開示範的渲染樣張（截圖用）。走的是和匯出同一條路：decode → autoFitText → renderPageCanvas。
import { decodeProject } from "./core/schema";
import { renderPageCanvas, autoFitText } from "./core/render";
import { loadFonts } from "./core/fonts";
import { loadFilterAssets } from "./core/filters";

const BASE = "/samples/wrap";

(async () => {
  const [, filters] = await Promise.all([loadFonts(), loadFilterAssets()]);
  const p = decodeProject(await (await fetch(`${BASE}/project.json`)).json());

  const images = new Map<string, CanvasImageSource>();
  await Promise.all(p.blocks.flatMap((b) => {
    if (b.content.type !== "image") return [];
    const file = b.content.media.assetFileName;
    if (!file || images.has(file)) return [];
    return [new Promise<void>((done) => {
      const img = new Image();
      img.onload = () => { images.set(file, img); done(); };
      img.onerror = () => done();
      img.src = `${BASE}/assets/${file}`;
    })];
  }));

  // 貼字盒重算——範本的 frame 是估值，不重算框就不貼字
  const probe = document.createElement("canvas").getContext("2d")!;
  autoFitText(probe, p);

  const grid = document.querySelector("#grid")!;
  for (let i = 0; i < p.pageCount; i++) {
    const fig = document.createElement("figure");
    fig.append(renderPageCanvas(p, i, { images, filters }));
    grid.append(fig);
  }
  document.title = "ready";
})();
