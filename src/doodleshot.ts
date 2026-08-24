// 塗鴉功能樣張（2026-08-23，截圖驗證用）：
//   列 1 三種筆刷（鋼筆／麥克筆／鉛筆）
//   列 2 生長出場 25／50／75／100%
//   列 3 巡線（移動）四個時刻
//   列 4 筆刷感 沸騰／飄／疊線（同一時刻）＋ round-trip 驗證
// 每格＝一頁專案縮成 270×338，排成 4×4 網格。
import type { Project, Block } from "./core/schema";
import { decodeProject, encodeProject } from "./core/schema";
import { renderPageCanvas } from "./core/render";
import { packStrokes, speedPress, type BrushKind, type DoodleBlock } from "./core/doodle";

// 一筆「手繪心形」＋一筆波浪＋一個點——用參數曲線模擬手畫
function heart(cx: number, cy: number, r: number): { x: number; y: number }[] {
  const out = [];
  for (let i = 0; i <= 80; i++) {
    const t = (i / 80) * Math.PI * 2;
    out.push({ x: cx + r * 16 * Math.pow(Math.sin(t), 3) / 16,
               y: cy - r * (13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) / 16 });
  }
  return out;
}
function wave(x0: number, y0: number, w: number): { x: number; y: number }[] {
  const out = [];
  for (let i = 0; i <= 60; i++) out.push({ x: x0 + (i / 60) * w, y: y0 + Math.sin(i / 4) * 40 });
  return out;
}
function mk(brush: BrushKind, extra: Partial<DoodleBlock> = {}, anim?: Block["anim"]): Project {
  const packed = packStrokes([
    { pts: heart(540, 520, 300), w: 14, color: "1A1A1A", brush },
    { pts: wave(180, 980, 720), w: 14, color: "D23B2A", brush },
    { pts: [{ x: 900, y: 300 }], w: 28, color: "2F7CF6", brush },
  ], 24);
  const b: Block = {
    id: "d1", frame: packed.frame, rotation: 0, zIndex: 1, locked: false, opacity: 1,
    content: { type: "doodle", doodle: { strokes: packed.strokes, ...extra } }, anim,
  };
  return { id: "DOODLE", name: "doodle", createdAt: "", updatedAt: "",
    canvasWidth: 1080, pageHeight: 1350, pageCount: 1, blocks: [b], pageBackgroundHex: { "0": "F4F1EA" } };
}

// 筆壓測試：一條快慢交替的線（spacing 疏＝畫得快）
function speedy(): { x: number; y: number }[] {
  const out = [{ x: 100, y: 700 }];
  let x = 100;
  for (let i = 0; i < 120 && x < 950; i++) {
    const fast = Math.sin(i / 12) > 0;
    x += fast ? 22 : 4;
    out.push({ x, y: 700 + Math.sin(i / 6) * 90 });
  }
  return out;
}
function mkPress(brush: BrushKind): Project {
  const pts = speedy();
  const packed = packStrokes([{ pts, w: 16, color: "1A1A1A", brush, press: speedPress(pts, 16) }], 26);
  const b: Block = { id: "d1", frame: packed.frame, rotation: 0, zIndex: 1, locked: false, opacity: 1,
    content: { type: "doodle", doodle: { strokes: packed.strokes } } };
  return { id: "P", name: "p", createdAt: "", updatedAt: "", canvasWidth: 1080, pageHeight: 1350, pageCount: 1,
    blocks: [b], pageBackgroundHex: { "0": "F4F1EA" } };
}

function loops(): { x: number; y: number }[] {
  const out = [];
  for (let i = 0; i <= 200; i++) {
    const t = (i / 200) * Math.PI * 4;
    out.push({ x: 540 + Math.sin(t) * 330, y: 620 + Math.sin(t * 0.5) * 380 * Math.cos(t) * 0.8 });
  }
  return out;
}
function mkLoops(brush: BrushKind, w: number): Project {
  const pts = loops();
  const packed = packStrokes([{ pts, w, color: "1A1A1A", brush, press: speedPress(pts, w) }], w * 2);
  const b: Block = { id: "d1", frame: packed.frame, rotation: 0, zIndex: 1, locked: false, opacity: 1,
    content: { type: "doodle", doodle: { strokes: packed.strokes } } };
  return { id: "L", name: "l", createdAt: "", updatedAt: "", canvasWidth: 1080, pageHeight: 1350, pageCount: 1,
    blocks: [b], pageBackgroundHex: { "0": "F4F1EA" } };
}

const grid: { p: Project; time?: number; label: string }[] = [
  { p: mkLoops("pen", 40), label: "鋼筆最粗 ∞ 交叉" },
  { p: mkLoops("ink", 26), label: "墨筆 ∞ 交叉" },
  { p: mkLoops("marker", 30), label: "麥克筆 ∞ 交叉" },
  { p: mkPress("pen"), label: "筆壓 鋼筆（快細慢粗）" },
  { p: mkPress("pencil"), label: "筆壓 鉛筆" },
  { p: mkPress("ink"), label: "筆壓 墨筆" },
  ...(["pen", "marker", "pencil", "chalk", "ink"] as BrushKind[]).map((b) => ({ p: mk(b), label: b })),
  { p: mk("pen", { sync: true }, { kind: "draw", dur: 4 }), time: 2, label: "生長 50% 同時" },
  { p: mk("pen", { sync: true, play: "travel", travelDur: 4, tail: 0.3 }), time: 1, label: "移動 同時 t=1" },
  { p: mk("pen", {}, { kind: "draw", dur: 4 }), time: 2, label: "生長 50%" },
  ...[0.25, 0.75].map((r) => ({ p: mk("pen", { play: "travel", travelDur: 4, tail: 0.3 }), time: r * 4, label: `移動 t=${r * 4}` })),
  { p: mk("pen", { wobble: "boil", wobbleAmp: 0.012 }), time: 1.3, label: "沸騰" },
  { p: mk("pen", { wobble: "sketch", wobbleAmp: 0.012 }), time: 1.3, label: "疊線" },
];

// round-trip：encode → JSON → decode → 再渲一格，要跟原本一樣
const rt = decodeProject(JSON.parse(JSON.stringify(encodeProject(mk("marker")))));
grid.push({ p: rt, label: "round-trip 麥克筆" });

const W = 270, H = 338, COLS = 4;
const sheet = document.createElement("canvas");
sheet.width = W * COLS; sheet.height = H * Math.ceil(grid.length / COLS);
const g = sheet.getContext("2d")!;
g.fillStyle = "#ddd"; g.fillRect(0, 0, sheet.width, sheet.height);
grid.forEach((cell, i) => {
  const anims = new Map<string, NonNullable<Block["anim"]>>();
  for (const b of cell.p.blocks) if (b.anim) anims.set(b.id, b.anim);
  const c = renderPageCanvas(cell.p, 0, { time: cell.time, anims, scale: 0.25 });
  const x = (i % COLS) * W, y = Math.floor(i / COLS) * H;
  g.drawImage(c, x, y, W, H);
  g.fillStyle = "#000"; g.font = "14px sans-serif"; g.fillText(cell.label, x + 8, y + 20);
});
document.body.append(sheet);
// 放大看移動 t=3 的那顆點
if (location.search.includes("zoom")) {
  const z = renderPageCanvas(mk("pen", { play: "travel", travelDur: 4, tail: 0.3 }), 0, { time: 3 });
  const zc = document.createElement("canvas"); zc.width = 400; zc.height = 300;
  zc.getContext("2d")!.drawImage(z, 750, 150, 400, 300, 0, 0, 400, 300);
  document.body.replaceChildren(zc);
}
document.title = "DONE";
