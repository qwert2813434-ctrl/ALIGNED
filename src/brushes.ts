// 筆刷總覽頁（2026-08-23 小高：「把現階段能生成的所有筆刷列出來在一個 HTML 讓我看」）。
// 用 App 本人的 drawDoodle 畫，每種筆刷一張卡。
import { BRUSHES, BRUSH_ORDER, drawDoodle, packStrokes } from "./core/doodle";

// 一組像手寫的筆畫：簽名式曲線、S 形、圓、點
function scribble(): { x: number; y: number }[] {
  const out = [];
  for (let i = 0; i <= 140; i++) {
    const u = i / 140;
    out.push({ x: 60 + u * 560 + Math.sin(u * 9) * 14, y: 110 + Math.sin(u * 12.5) * 34 + Math.sin(u * 2.3) * 18 });
  }
  return out;
}
function curve(): { x: number; y: number }[] {
  const out = [];
  for (let i = 0; i <= 90; i++) { const u = i / 90; out.push({ x: 60 + u * 560, y: 230 + Math.sin(u * Math.PI * 1.5) * 40 }); }
  return out;
}
function circle(): { x: number; y: number }[] {
  const out = [];
  for (let i = 0; i <= 70; i++) { const a = (i / 70) * Math.PI * 2.08 - 1.2; out.push({ x: 720 + Math.cos(a) * 85, y: 170 + Math.sin(a) * 85 }); }
  return out;
}

const W = 900, H = 320;
const grid = document.querySelector("#grid")!;
for (const key of BRUSH_ORDER) {
  const packed = packStrokes([
    { pts: scribble(), w: 14, color: "1A1A1A", brush: key },
    { pts: curve(), w: 14, color: "D23B2A", brush: key },
    { pts: circle(), w: 14, color: "2F7CF6", brush: key },
    { pts: [{ x: 840, y: 290 }], w: 24, color: "1A1A1A", brush: key },
  ], 30);
  const card = document.createElement("div");
  card.className = "card";
  card.innerHTML = `<h2>${BRUSHES[key].name}<span>${key}</span></h2>`;
  const c = document.createElement("canvas");
  c.width = W * 2; c.height = H * 2;
  const g = c.getContext("2d")!;
  g.scale(2, 2);
  g.fillStyle = "#f7f4ee"; g.fillRect(0, 0, W, H);
  g.translate(packed.frame.x, packed.frame.y);
  // 一張卡炸掉不准拖垮整頁——錯誤直接印在卡上（總覽頁的用途就是抓這種）
  try {
    drawDoodle(g, { strokes: packed.strokes }, packed.frame.w, packed.frame.h);
  } catch (x) {
    const err = document.createElement("p");
    err.style.color = "#c0392b";
    err.textContent = `渲染炸了：${(x as Error).stack ?? x}`;
    card.append(err);
  }
  card.append(c);
  grid.append(card);
}
document.title = "DONE";
