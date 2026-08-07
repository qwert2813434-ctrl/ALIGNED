// WKWebView 影片診斷（開發專用）。回報三件事：
// (1) asset:// 拿 <video> 有沒有資料（readyState/networkState/error）
// (2) play() 有沒有被擋（autoplay 政策）
// (3) currentTime 有沒有前進（真的在解碼）
import { convertFileSrc, isTauri } from "@tauri-apps/api/core";

const log = (m: string): void => {
  document.querySelector("#log")!.insertAdjacentHTML("beforeend", `<div>${m}</div>`);
};

const path = new URLSearchParams(location.search).get("path") ?? "";
const el = document.createElement("video");
el.muted = true; el.loop = true; el.playsInline = true; el.preload = "auto";
el.style.cssText = "width:320px;display:block;margin-top:12px";
document.body.append(el);

let playErr = "-";
const src = isTauri() ? convertFileSrc(path) : path;
log(`tauri=${isTauri()}　src=${src.slice(0, 90)}…`);
el.src = src;
el.play().then(() => { playErr = "ok"; }).catch((e) => { playErr = `${e.name}:${e.message}`.slice(0, 60); });

const t0 = performance.now();
let lastT = -1, advances = 0;
setInterval(() => {
  if (el.currentTime !== lastT) { lastT = el.currentTime; advances++; }
  const s = `rs=${el.readyState} ns=${el.networkState} err=${el.error ? `${el.error.code}:${(el.error.message ?? "").slice(0, 40)}` : "-"} `
    + `play=${playErr} t=${el.currentTime.toFixed(2)} adv=${advances} ${el.videoWidth}x${el.videoHeight} +${((performance.now() - t0) / 1000).toFixed(0)}s`;
  document.title = s;
  log(s);
}, 500);
