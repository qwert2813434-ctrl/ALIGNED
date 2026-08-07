// 濾鏡差分比對：TS 版 vs iOS FilterEngine 的真實輸出，逐像素量誤差。
//
// 參考圖由 `filtertest/main.swift` 產生——它連結的是 App 自己的 FilterEngine
// 原始檔（只剝掉 UIKit 那 30 行），所以配方不是手抄的。
import { FILTER_KEYS, applyFilter, loadFilterAssets } from "./core/filters";

const out = document.querySelector<HTMLDivElement>("#out")!;

function load(src: string): Promise<HTMLImageElement> {
  return new Promise((ok, err) => {
    const i = new Image();
    i.onload = () => ok(i); i.onerror = err; i.src = src;
  });
}

function toData(img: HTMLImageElement): ImageData {
  const c = document.createElement("canvas");
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const x = c.getContext("2d", { willReadFrequently: true })!;
  x.drawImage(img, 0, 0);
  return x.getImageData(0, 0, c.width, c.height);
}

function show(title: string, d: ImageData): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = d.width; c.height = d.height;
  c.title = title;
  c.getContext("2d")!.putImageData(d, 0, 0);
  return c;
}

(async () => {
  const assets = await loadFilterAssets();
  const input = toData(await load("/filterref/_input.png"));

  const rows: string[] = [];
  for (const key of FILTER_KEYS) {
    const mine = new ImageData(new Uint8ClampedArray(input.data), input.width, input.height);
    const t0 = performance.now();
    applyFilter(key, mine, assets);
    const ms = performance.now() - t0;

    const ref = toData(await load(`/filterref/ref_${key}.png`));
    let sum = 0, max = 0, n = 0;
    const diff = new ImageData(input.width, input.height);
    for (let i = 0; i < ref.data.length; i += 4) {
      let worst = 0;
      for (let c = 0; c < 3; c++) {
        const e = Math.abs(mine.data[i + c] - ref.data[i + c]);
        sum += e; n++; worst = Math.max(worst, e);
      }
      max = Math.max(max, worst);
      // 誤差放大 8 倍上色，肉眼才看得出集中在哪
      const v = Math.min(255, worst * 8);
      diff.data[i] = v; diff.data[i + 1] = v; diff.data[i + 2] = v; diff.data[i + 3] = 255;
    }
    const mean = sum / n;
    const cls = mean < 1 ? "ok" : mean < 6 ? "warn" : "bad";

    const box = document.createElement("div");
    box.className = "row " + cls;
    const label = document.createElement("div");
    label.className = "label";
    label.innerHTML = `<b>${key}</b>　平均誤差 ${mean.toFixed(2)}　最大 ${max}　<span>${ms.toFixed(0)}ms</span>`;
    box.append(label, show("我的", mine), show("參考", ref), show("差異×8", diff));
    out.append(box);
    rows.push(`${key}:${mean.toFixed(2)}`);
  }
  document.title = rows.join(" ");
})().catch((e) => { out.textContent = "失敗：" + e.message; });
