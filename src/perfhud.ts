// 效能數據面板——畫面角落一小塊即時數字，可開關。
//
// 為什麼要：小高回報「卡」的時候，如果沒有這塊，兩邊都只能猜。有了它他可以直接
// 念數字，就知道是「重算太多」還是「本來就多塊」還是「根本沒在重畫」。
// 2026-08-28 在貼紙邊那條分支上先寫過一版，2026-08-30 收回主線並補上整頁那一列。
//
// 讀什麼數字（都是實際除錯用得上的，不是好看用的）：
//   幀率／繪製   —— 感受那層。最差值單獨列，平均值會把偶發的頓藏起來
//   這幀         —— 畫了幾塊圖、其中幾塊有去背，才知道數字大是「東西多」還是「單塊貴」
//   切圖         —— 命中＝整張重用；重算＝那塊做了四道全尺寸合成
//   整頁         —— **開紙張時最關鍵的一列**。重算＝整頁重畫＋整頁讀回 CPU＋逐畫素
//                   套紙，一次就是幾十毫秒。平移縮放時該是全命中；一直重算就是
//                   鑰匙被什麼弄髒了，或者快取被別的變體擠掉了
//
// 面板自己不能是負擔：一秒才更新一次文字，計數器全是整數 ++。
import { renderCounters } from "./core/render";
import { doodleCounters } from "./core/doodle";

interface FrameSource {
  frameStats: { ms: number; paints: number; raf: number; maxMs: number };
}

const KEY = "alignedPerfHud";

let host: HTMLDivElement | null = null;
let timer: number | null = null;

function el(): HTMLDivElement {
  if (host) return host;
  const d = document.createElement("div");
  d.id = "perfhud";
  d.style.cssText = [
    "position:fixed", "top:52px", "left:12px", "z-index:9999",
    "font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace",
    "color:#e8e8ea", "background:rgba(20,20,22,.82)",
    "border:1px solid rgba(255,255,255,.12)", "border-radius:8px",
    "padding:7px 9px", "min-width:200px", "white-space:pre",
    "pointer-events:none", "user-select:none",
    "backdrop-filter:blur(8px)", "-webkit-backdrop-filter:blur(8px)",
  ].join(";");
  document.body.append(d);
  host = d;
  return d;
}

function line(label: string, value: string, warn = false): string {
  return `${label.padEnd(5, "　")}${warn ? `⚠ ${value}` : value}\n`;
}

/** 開／關。回傳現在是不是開著。 */
export function togglePerfHud(src: FrameSource): boolean {
  const on = !isPerfHudOn();
  localStorage.setItem(KEY, on ? "1" : "0");
  applyPerfHud(src);
  return on;
}

export function isPerfHudOn(): boolean {
  // ?perf=1 也算開著——診斷／截圖驗證時不必先進選單點一次
  if (new URLSearchParams(location.search).get("perf") === "1") return true;
  return localStorage.getItem(KEY) === "1";
}

/** 照現在的設定套用（開 App 時呼叫一次）。 */
export function applyPerfHud(src: FrameSource): void {
  if (timer !== null) { clearInterval(timer); timer = null; }
  if (!isPerfHudOn()) { host?.remove(); host = null; return; }

  const d = el();
  let lastPaints = src.frameStats.paints;
  let lastAt = performance.now();
  // 這一秒內的累計——計數器每幀被歸零，所以要在 rAF 上收集，不能等一秒才讀
  const sum = { media: 0, matte: 0, video: 0, edge: 0, cutHit: 0, cutMiss: 0,
                pageHit: 0, pageMiss: 0, pageSkip: 0,
                edgeHit: 0, edgeMiss: 0,
                doodleHit: 0, doodleMiss: 0, frames: 0 };
  const collect = (): void => {
    if (!isPerfHudOn()) return;
    sum.media += renderCounters.media; sum.matte += renderCounters.matte;
    sum.video += renderCounters.video; sum.edge += renderCounters.edge;
    sum.cutHit += renderCounters.cutHit; sum.cutMiss += renderCounters.cutMiss;
    sum.edgeHit += renderCounters.edgeHit; sum.edgeMiss += renderCounters.edgeMiss;
    sum.pageHit += renderCounters.pageHit; sum.pageMiss += renderCounters.pageMiss;
    sum.pageSkip += renderCounters.pageSkip;
    sum.doodleHit += doodleCounters.hit; sum.doodleMiss += doodleCounters.miss;
    // 只有真的畫了東西的那一幀才算一幀——靜止時 rAF 照跑，算進去會把平均稀釋掉
    if (renderCounters.media > 0
        || renderCounters.pageHit + renderCounters.pageMiss + renderCounters.pageSkip > 0) sum.frames++;
    // 讀完就歸零：計數器只被消費一次，畫布沒重畫的那幾幀就不會被重複加
    renderCounters.reset();
    doodleCounters.reset();
    requestAnimationFrame(collect);
  };
  requestAnimationFrame(collect);

  timer = window.setInterval(() => {
    const now = performance.now();
    const painted = src.frameStats.paints - lastPaints;
    const secs = (now - lastAt) / 1000;
    const fps = secs > 0 ? painted / secs : 0;
    const worst = src.frameStats.maxMs;
    src.frameStats.maxMs = 0;
    lastPaints = src.frameStats.paints; lastAt = now;

    const n = Math.max(1, sum.frames);
    const per = (v: number): string => (v / n).toFixed(1);
    const idle = painted === 0;

    let t = "";
    t += line("幀率", idle ? "靜止（沒在重畫）" : `${fps.toFixed(0)} fps`, !idle && fps < 45);
    t += line("繪製", `${src.frameStats.ms.toFixed(1)} ms（最差 ${worst.toFixed(0)}）`,
              src.frameStats.ms > 12);
    t += line("這幀", `圖 ${per(sum.media)}・去背 ${per(sum.matte)}`);
    if (sum.video) t += line("影片", `${per(sum.video)} 塊即時影格`);
    t += line("切圖", `命中 ${sum.cutHit}・重算 ${sum.cutMiss}`, sum.cutMiss > sum.frames);
    // 貼紙邊：重算＝膨脹＋浮雕整套重跑，是最貴的一項；數字一直跳＝快取被擠掉了
    if (sum.edge) t += line("貼紙邊", `命中 ${sum.edgeHit}・重算 ${sum.edgeMiss}`, sum.edgeMiss > sum.frames);
    t += line("塗鴉", `命中 ${sum.doodleHit}・重算 ${sum.doodleMiss}`, sum.doodleMiss > sum.frames);
    t += line("整頁", `命中 ${sum.pageHit}・重算 ${sum.pageMiss}・不可存 ${sum.pageSkip}`,
              sum.pageMiss + sum.pageSkip > sum.frames);
    t += line("快取", `切圖 ${renderCounters.cutCached}・整頁 ${renderCounters.pageCached}・貼紙邊 ${renderCounters.edgeCached}・塗鴉 ${doodleCounters.cached}`);
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    if (mem) t += line("JS 堆", `${(mem.usedJSHeapSize / 1048576).toFixed(0)} MB`);
    d.textContent = t.trimEnd();

    sum.media = sum.matte = sum.video = sum.edge = 0;
    sum.cutHit = sum.cutMiss = sum.pageHit = sum.pageMiss = sum.pageSkip = 0;
    sum.edgeHit = sum.edgeMiss = 0;
    sum.doodleHit = sum.doodleMiss = sum.frames = 0;
  }, 1000);
}
