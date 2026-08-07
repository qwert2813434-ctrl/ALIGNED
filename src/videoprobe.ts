// 影片預覽的端對端探針：跑**真的** VideoPool + 真的 Editor，
// 隔一段時間各取一次畫面，證明畫布上的影片真的在動（不是停在海報那一格）。
// 單元測試驗得到「有影格就畫影格」，驗不到「影格會自己往前跑」——那要真的解碼器。
import { decodeProject } from "./core/schema";
import { loadFonts } from "./core/fonts";
import { loadFilterAssets, type FilterAssets } from "./core/filters";
import { Editor } from "./editor";
import { VideoPool } from "./videopool";

const BASE = "/samples/_probe";
const canvas = document.querySelector<HTMLCanvasElement>("#canvas")!;
const out = document.querySelector<HTMLDivElement>("#out")!;

/** 影片 block 中心那塊的平均色——播放中每一格都不一樣（testsrc2 是動態圖樣）。 */
function sample(): string {
  const ctx = canvas.getContext("2d")!;
  const d = ctx.getImageData(Math.round(canvas.width * 0.5), Math.round(canvas.height * 0.5), 24, 24).data;
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
  const n = d.length / 4;
  return `${Math.round(r / n)},${Math.round(g / n)},${Math.round(b / n)}`;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let filters!: FilterAssets;
  [, filters] = await Promise.all([loadFonts(), loadFilterAssets()]);
  const project = decodeProject(await (await fetch(`${BASE}/project.json`)).json());

  const editor = new Editor(canvas);
  editor.load(project);
  const pool = new VideoPool(() => project, () => filters, () => editor.refresh(),
    () => [editor.visibleRect()]);   // 探針＝編輯情境：視野內才解碼
  editor.setVideos(pool.frames);
  pool.attach((f) => `${BASE}/assets/${encodeURIComponent(f)}`);

  // 環境診斷：分得出「我們的程式沒接上」與「這個瀏覽器根本不解碼」
  const probe = document.createElement("video");
  probe.muted = true; probe.loop = true; probe.playsInline = true;
  probe.src = `${BASE}/assets/probe.mp4`;
  probe.play().catch(() => {});

  await wait(1200);
  const a = sample();
  await wait(1200);
  const b = sample();
  const playing = a !== b && pool.frames.size > 0;
  const env = `canvas=${canvas.width}×${canvas.height}　probe.readyState=${probe.readyState}`
    + `　videoWidth=${probe.videoWidth}　t=${probe.currentTime.toFixed(2)}　err=${probe.error?.code ?? "-"}`;
  out.textContent = `frames=${pool.frames.size}　t1=${a}　t2=${b}　${playing ? "PLAYING" : "STATIC"}　${env}`;
  document.title = playing ? "PLAYING" : "STATIC";
})().catch((e) => { out.textContent = `失敗：${e.message}`; document.title = "ERROR"; });
