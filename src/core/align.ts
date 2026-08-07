// ALIGN Core — 對齊引擎。iOS `Engines/AlignmentEngine.swift` 的逐條移植。
//
// 純矩形運算、零 UI 依賴。座標一律是「專案座標」（多頁連續的那個空間），
// 不是螢幕座標——**吸附閾值因此是絕對值，畫布縮放不會改變吸附手感**。
//
// 三種磁性強度的差別（使用者定案的取捨）：
//   strong — 全部候選：角/邊/中心、跨頁絕對、跨頁相對
//   weak   — 只有「起點（左上）」與中心；不比對遠端邊，完全不做跨頁相對
//   none   — 直接放行
// 頁面自身的三條線（左/中/右）**任何強度都給**：頁邊是固定參考線，
// 不屬於 weak 想砍掉的「其他物件的細節」。使用者參考線同理。

import type { Rect } from "./schema";

export type SnapStrength = "strong" | "weak" | "none";
export type Axis = "vertical" | "horizontal";

export interface GuideLine { axis: Axis; position: number; start: number; end: number }
export interface SpacingBadge { x: number; y: number; value: number }

export interface AlignmentResult {
  frame: Rect;
  guides: GuideLine[];
  snappedX: boolean;
  snappedY: boolean;
}

export const SNAP_THRESHOLD = 8;
export const SPACING_TOLERANCE = 3;

const minX = (r: Rect) => r.x;
const midX = (r: Rect) => r.x + r.w / 2;
const maxX = (r: Rect) => r.x + r.w;
const minY = (r: Rect) => r.y;
const midY = (r: Rect) => r.y + r.h / 2;
const maxY = (r: Rect) => r.y + r.h;

/** 一個軸向目標。guidePositions 可以有兩條——跨頁相對對齊會同時在兩頁畫線，
 *  視覺上表達「這兩個東西在各自頁面的同一位置」。 */
interface AxisTarget { value: number; guidePositions: number[] }

export function resolvePosition(
  dragging: Rect,
  others: Rect[],
  homePage: Rect,
  stage: Rect,
  strength: SnapStrength = "strong",
  guidesX: number[] = [],
  guidesY: number[] = [],
): AlignmentResult {
  if (strength === "none") {
    return { frame: dragging, guides: [], snappedX: false, snappedY: false };
  }

  const halfW = dragging.w / 2, halfH = dragging.h / 2;
  const cx = midX(dragging), cy = midY(dragging);
  const pageWidth = homePage.w;
  const pageOriginX = (x: number) => (pageWidth > 0 ? Math.floor(x / pageWidth) * pageWidth : 0);
  const draggedOrigin = pageOriginX(cx);

  // weak 只看「起點」與中心，不看遠端邊
  const xCandidates: [number, number][] = strength === "weak"
    ? [[-halfW, cx - halfW], [0, cx]]
    : [[-halfW, cx - halfW], [0, cx], [halfW, cx + halfW]];

  const xTargets: AxisTarget[] = [
    { value: midX(homePage), guidePositions: [midX(homePage)] },
    { value: minX(homePage), guidePositions: [minX(homePage)] },
    { value: maxX(homePage), guidePositions: [maxX(homePage)] },
  ];
  for (const gx of guidesX) {
    const abs = homePage.x + gx; // 垂直參考線存的是頁內座標，換算到本頁
    xTargets.push({ value: abs, guidePositions: [abs] });
  }
  for (const o of others) {
    xTargets.push({ value: minX(o), guidePositions: [minX(o)] });
    xTargets.push({ value: midX(o), guidePositions: [midX(o)] });
    if (strength !== "strong") continue;
    xTargets.push({ value: maxX(o), guidePositions: [maxX(o)] });

    // 跨頁相對：距各自頁邊同樣遠。給每頁重複的版面用（例如一致的邊界），
    // 絕對對齊做不到，因為兩者在不同頁、絕對 x 本來就不同。
    const otherOrigin = pageOriginX(midX(o));
    if (otherOrigin !== draggedOrigin) {
      for (const edge of [minX(o), midX(o), maxX(o)]) {
        const rel = draggedOrigin + (edge - otherOrigin);
        xTargets.push({ value: rel, guidePositions: [rel, edge] });
      }
    }
  }

  let bestX: { offset: number; target: AxisTarget; diff: number } | null = null;
  for (const [offset, value] of xCandidates) {
    for (const target of xTargets) {
      const diff = Math.abs(value - target.value);
      if (diff <= SNAP_THRESHOLD && (!bestX || diff < bestX.diff)) bestX = { offset, target, diff };
    }
  }

  const yCandidates: [number, number][] = strength === "weak"
    ? [[-halfH, cy - halfH], [0, cy]]
    : [[-halfH, cy - halfH], [0, cy], [halfH, cy + halfH]];

  // 水平參考線的值已經是絕對的（y 全頁共用），不必換算
  const yTargets = [midY(homePage), minY(homePage), maxY(homePage), ...guidesY];
  for (const o of others) {
    yTargets.push(minY(o), midY(o));
    if (strength === "strong") yTargets.push(maxY(o));
  }

  let bestY: { offset: number; target: number; diff: number } | null = null;
  for (const [offset, value] of yCandidates) {
    for (const target of yTargets) {
      const diff = Math.abs(value - target);
      if (diff <= SNAP_THRESHOLD && (!bestY || diff < bestY.diff)) bestY = { offset, target, diff };
    }
  }

  const guides: GuideLine[] = [];
  let finalCX = cx, finalCY = cy;
  if (bestX) {
    finalCX = bestX.target.value - bestX.offset;
    for (const position of bestX.target.guidePositions) {
      // 線橫跨整個 stage，跨頁對齊才看得見
      guides.push({ axis: "vertical", position, start: minY(stage), end: maxY(stage) });
    }
  }
  if (bestY) {
    finalCY = bestY.target - bestY.offset;
    guides.push({ axis: "horizontal", position: bestY.target, start: minX(stage), end: maxX(stage) });
  }

  return {
    frame: { x: finalCX - halfW, y: finalCY - halfH, w: dragging.w, h: dragging.h },
    guides,
    snappedX: bestX != null,
    snappedY: bestY != null,
  };
}

export interface EdgeSnapResult { value: number; snapped: boolean; guides: GuideLine[] }

/** 縮放時只有一條邊在動（對面錨定），所以不能走 resolvePosition。
 *  候選集刻意鏡射 resolvePosition，讓縮放的邊咬到跟拖曳一樣的參考線。 */
export function snapResizingEdge(
  movingEdge: number,
  axis: Axis,
  others: Rect[],
  homePage: Rect,
  stage: Rect,
  strength: SnapStrength,
  guideValues: number[] = [],
): EdgeSnapResult {
  if (strength === "none") return { value: movingEdge, snapped: false, guides: [] };

  const targets: number[] = [];
  if (axis === "vertical") {
    targets.push(minX(homePage), midX(homePage), maxX(homePage));
    for (const gx of guideValues) targets.push(homePage.x + gx);
    const pageWidth = homePage.w;
    for (const o of others) {
      targets.push(minX(o), midX(o));
      if (strength === "strong") targets.push(maxX(o));
      if (strength !== "strong" || pageWidth <= 0) continue;
      const otherOrigin = Math.floor(midX(o) / pageWidth) * pageWidth;
      if (otherOrigin !== homePage.x) {
        for (const edge of [minX(o), midX(o), maxX(o)]) targets.push(homePage.x + (edge - otherOrigin));
      }
    }
  } else {
    targets.push(minY(homePage), midY(homePage), maxY(homePage), ...guideValues);
    for (const o of others) {
      targets.push(minY(o), midY(o));
      if (strength === "strong") targets.push(maxY(o));
    }
  }

  let best: { value: number; diff: number } | null = null;
  for (const t of targets) {
    const diff = Math.abs(movingEdge - t);
    if (diff <= SNAP_THRESHOLD && (!best || diff < best.diff)) best = { value: t, diff };
  }
  if (!best) return { value: movingEdge, snapped: false, guides: [] };

  const guide: GuideLine = axis === "vertical"
    ? { axis, position: best.value, start: minY(stage), end: maxY(stage) }
    : { axis, position: best.value, start: minX(stage), end: maxX(stage) };
  return { value: best.value, snapped: true, guides: [guide] };
}

export interface GuideSnapResult { value: number; snapped: boolean; guides: GuideLine[] }

/**
 * 拖曳**參考線本身**時的吸附。
 *
 * 候選集刻意鏡射 resolvePosition／snapResizingEdge——線咬到的位置要跟元件咬到的
 * 一模一樣，「先用線對好位、之後每一頁照著複刻」才會準。
 *
 * 垂直線存的是**頁內座標**（每頁重複繪製），所以候選也全部換算成頁內座標：
 * 強度＝強時連**別頁**的元件邊也算進來——那正是「複刻上一頁版面」的用法
 * （上一頁那張圖的左緣在頁內 120，這一頁拖線就會咬到 120）。
 */
export function snapGuide(
  value: number,          // 垂直＝頁內 x；水平＝絕對 y
  axis: Axis,
  blocks: Rect[],         // 專案全部元件（絕對座標）
  page: Rect,             // 目前這一頁（絕對座標）
  stage: Rect,
  strength: SnapStrength,
  otherGuides: number[],
): GuideSnapResult {
  if (strength === "none") return { value, snapped: false, guides: [] };
  const targets: number[] = [...otherGuides];
  const onThisPage = (o: Rect): boolean => {
    const c = midX(o);
    return c >= page.x && c < page.x + page.w;
  };

  if (axis === "vertical") {
    targets.push(0, page.w / 2, page.w);
    for (const o of blocks) {
      if (strength !== "strong" && !onThisPage(o)) continue;
      // 換算成「那個元件所在頁的頁內座標」——強度＝強時別頁的邊才對得起來
      const origin = page.w > 0 ? Math.floor(midX(o) / page.w) * page.w : 0;
      targets.push(minX(o) - origin, midX(o) - origin, maxX(o) - origin);
    }
  } else {
    targets.push(page.y, page.y + page.h / 2, page.y + page.h);
    for (const o of blocks) {
      if (strength !== "strong" && !onThisPage(o)) continue;
      targets.push(minY(o), midY(o), maxY(o));
    }
  }

  let best: { value: number; diff: number } | null = null;
  for (const t of targets) {
    const diff = Math.abs(value - t);
    if (diff <= SNAP_THRESHOLD && (!best || diff < best.diff)) best = { value: t, diff };
  }
  if (!best) return { value, snapped: false, guides: [] };

  // 咬到什麼就把那條畫出來——不畫的話「為什麼停在這裡」沒有答案
  const guide: GuideLine = axis === "vertical"
    ? { axis, position: page.x + best.value, start: minY(stage), end: maxY(stage) }
    : { axis, position: best.value, start: minX(stage), end: maxX(stage) };
  return { value: best.value, snapped: true, guides: [guide] };
}

/** 等距徽章。**只在單頁內比對**——等距描述的是一頁的節奏，不跨頁。
 *  頁頂與頁底當虛擬邊界一起算。 */
export function equalSpacingBadges(frames: Rect[], page: Rect): SpacingBadge[] {
  const sorted = [...frames].sort((a, b) => a.y - b.y);
  const gaps: { span: number; x: number; y: number }[] = [];
  let prevBottom = minY(page), prevX = midX(page);

  for (const f of sorted) {
    if (minY(f) - prevBottom > 0.5) {
      gaps.push({ span: minY(f) - prevBottom, x: (prevX + midX(f)) / 2, y: (prevBottom + minY(f)) / 2 });
    }
    prevBottom = maxY(f);
    prevX = midX(f);
  }
  if (maxY(page) - prevBottom > 0.5) {
    gaps.push({ span: maxY(page) - prevBottom, x: prevX, y: (prevBottom + maxY(page)) / 2 });
  }

  const badges: SpacingBadge[] = [];
  for (let i = 0; i < gaps.length - 1; i++) {
    for (let j = i + 1; j < gaps.length; j++) {
      const g1 = gaps[i], g2 = gaps[j];
      if (Math.abs(g1.span - g2.span) <= SPACING_TOLERANCE && g1.span > 4) {
        badges.push({ x: g1.x, y: g1.y, value: Math.round(g1.span) });
        badges.push({ x: g2.x, y: g2.y, value: Math.round(g2.span) });
      }
    }
  }
  return badges;
}

/** 旋轉後的軸對齊外接框，與原 frame 同心。吸附一律拿這個當目標與被拖者——
 *  對到的才是看得見的邊，不是不可見的原始 frame（iOS 2026-08-01 修過同一個 bug）。 */
export function rotatedBounds(f: Rect, rotation: number): Rect {
  if (!rotation) return f;
  const r = (rotation * Math.PI) / 180;
  const c = Math.abs(Math.cos(r)), s = Math.abs(Math.sin(r));
  const w = f.w * c + f.h * s, h = f.w * s + f.h * c;
  return { x: midX(f) - w / 2, y: midY(f) - h / 2, w, h };
}
