// TS 移植版跑同一批測資。LCG 與案例產生邏輯必須與 main.swift 逐字對應。
import { resolvePosition, equalSpacingBadges, type SnapStrength } from "../src/core/align";
import type { Rect } from "../src/core/schema";

// Swift 的 UInt64 溢位乘加 → BigInt 模 2^64
const M = (1n << 64n) - 1n;
let seed = 12345n;
function rnd(): number {
  seed = (seed * 6364136223846793005n + 1442695040888963407n) & M;
  return Number((seed >> 11n) & 0xFFFFFFFFn) / 0xFFFFFFFF;
}
const rr = (lo: number, hi: number) => lo + rnd() * (hi - lo);

const strengths: SnapStrength[] = ["strong", "weak", "none"];
const pageW = 1080, pageH = 1350;
const out: unknown[] = [];

for (let i = 0; i < 400; i++) {
  const pageCount = Math.trunc(rr(1, 4.99));
  const stage: Rect = { x: 0, y: 0, w: pageW * pageCount, h: pageH };
  const homeIndex = Math.trunc(rr(0, pageCount - 0.01));
  const home: Rect = { x: homeIndex * pageW, y: 0, w: pageW, h: pageH };

  const dragging: Rect = { x: rr(-100, stage.w), y: rr(-100, pageH), w: rr(20, 600), h: rr(20, 400) };
  const others: Rect[] = [];
  const n = Math.trunc(rr(0, 6.99));
  for (let k = 0; k < n; k++) {
    others.push({ x: rr(-50, stage.w), y: rr(-50, pageH), w: rr(20, 500), h: rr(20, 350) });
  }
  const gx: number[] = [], gy: number[] = [];
  const ngx = Math.trunc(rr(0, 2.99));
  for (let k = 0; k < ngx; k++) gx.push(rr(0, pageW));
  const ngy = Math.trunc(rr(0, 2.99));
  for (let k = 0; k < ngy; k++) gy.push(rr(0, pageH));

  const r = resolvePosition(dragging, others, home, stage, strengths[i % 3], gx, gy);
  const badges = equalSpacingBadges(others, home);
  out.push({
    x: r.frame.x, y: r.frame.y, w: r.frame.w, h: r.frame.h,
    snappedX: r.snappedX, snappedY: r.snappedY,
    guides: r.guides.map((g) => [g.axis === "vertical" ? 0 : 1, g.position, g.start, g.end]),
    badges: badges.map((b) => [b.x, b.y, b.value]),
  });
}
console.log(JSON.stringify(out));
