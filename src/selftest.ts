// 瀏覽器內自測：用**真的指標事件**驅動 Editor，驗證整條鏈
// （指標座標 → 專案座標 → 吸附 → 寫回 frame）。
//
// 為什麼不用單元測試就好：指標座標換算的雷全部在瀏覽器裡（offsetX 語意、
// devicePixelRatio、view 變換），純函式測試完全碰不到。這頁跑 headless Chrome 也能過。

import { Editor } from "./editor";
import type { Block, MediaBlock, Project, Rect, TextBlock } from "./core/schema";
import { renderAllPages } from "./core/export";
import { autoFitText, maskAndStrokeCanvases, renderCounters, renderPageCanvas, renderStage, snugTextWidth, textPrintLines } from "./core/render";
import { doodleCounters, drawDoodle, drawDoodleUncached, type DoodleBlock } from "./core/doodle";
import { applyRiso, filterSig, parseRisoSig, RISO_DEFAULTS } from "./core/filters";
import { tornCanvases, tornOf, tornCanvasSides, tornLocalSide } from "./core/tornedge";
import { decodeProject, encodeProject, moveBlocks, reconcileOrder } from "./core/schema";
import { Inspector } from "./inspector";
import { PageStrip } from "./pagestrip";
import { addPage, deletePage, duplicatePage, retargetToPage, stripToTemplate, swapAdjacentPages } from "./core/pages";
import { alignGroup, alignToPage, applyLayerOrder, distributeGroup } from "./core/group";
import { buildClipboard, pasteBlocks } from "./core/clipboard";
import { defaultParams, generateGuides, replaceBatch } from "./core/guidegen";
import { canvasSize, changeCanvasRatio, newProject, simplifiedRatio } from "./core/canvas";
import { buildPageSpec, pageHasVideo } from "./videoexport";
import { videoCullBounds } from "./videopool";
import { rotatedBounds } from "./core/align";
import { nextRange } from "./trim";
import { isNewer } from "./updatecheck";
import { intersects } from "./core/geometry";
import { Gallery } from "./gallery";

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
  document.title = `#${results.length} ${name}`;   // 卡住時，標題就是最後跑完的案例
}
const near = (a: number, b: number, eps = 0.01) => Math.abs(a - b) < eps;

// 撕紙邊「畫布方向↔物件邊」換算（2026-09-05）：兩端同一張表，釘死 45°、負角取餘
{
  const t = (deg: number, c: number, l: number): void =>
    check(`撕紙邊換算 ${deg}°：畫布${"上右下左"[c]}＝物件${"上右下左"[l]}`, tornLocalSide(c, deg) === l, `得到 ${tornLocalSide(c, deg)}`);
  t(0, 0, 0); t(90, 1, 0); t(180, 0, 2); t(-90, 2, 3); t(270, 2, 3); t(45, 1, 0); t(44, 1, 1); t(135, 0, 2); t(360, 3, 3);
  check("撕紙邊換算：位元遮罩轉回畫布（−90°，物件下＝畫布右）", tornCanvasSides(4, -90) === 2, `得到 ${tornCanvasSides(4, -90)}`);
}

function block(id: string, frame: Rect, rotation = 0): Block {
  return {
    id, frame, rotation, zIndex: 1, locked: false, opacity: 1,
    content: { type: "shape", shape: { kind: "rectangle", colorHex: "888888" } },
  };
}

/** 群組外框（旋轉後外接框的聯集）——群組手把就長在它的右下角。 */
function groupBoxOf(blocks: Block[]): Rect {
  const rs = blocks.map((b) => rotatedBounds(b.frame, b.rotation));
  const x = Math.min(...rs.map((r) => r.x)), y = Math.min(...rs.map((r) => r.y));
  return {
    x, y,
    w: Math.max(...rs.map((r) => r.x + r.w)) - x,
    h: Math.max(...rs.map((r) => r.y + r.h)) - y,
  };
}

function project(blocks: Block[]): Project {
  return {
    id: "test", name: "自測", createdAt: "", updatedAt: "",
    canvasWidth: 1080, pageHeight: 1350, pageCount: 2, blocks,
  };
}

const canvas = document.querySelector<HTMLCanvasElement>("#canvas")!;
const editor = new Editor(canvas);

/** 專案座標 → 視窗 client 座標。測試自己算輸入位置用 rect 是可以的
 *  （這頁沒有 CSS zoom，而且我們是在「產生」事件而非在受測程式碼裡解析事件）。 */
function clientOf(x: number, y: number): { clientX: number; clientY: number } {
  const r = canvas.getBoundingClientRect();
  const v = (editor as unknown as { view: { scale: number; tx: number; ty: number } }).view;
  return { clientX: r.left + v.tx + x * v.scale, clientY: r.top + v.ty + y * v.scale };
}

function pointer(type: string, x: number, y: number): void {
  const { clientX, clientY } = clientOf(x, y);
  canvas.dispatchEvent(new PointerEvent(type, {
    pointerId: 1, isPrimary: true, bubbles: true, cancelable: true, clientX, clientY,
  }));
}

function dragFrom(p: Project, id: string, to: { x: number; y: number }): Rect {
  const b = p.blocks.find((k) => k.id === id)!;
  const start = { x: b.frame.x + b.frame.w / 2, y: b.frame.y + b.frame.h / 2 };
  pointer("pointerdown", start.x, start.y);
  pointer("pointermove", to.x, to.y);
  const out = { ...p.blocks.find((k) => k.id === id)!.frame };
  pointer("pointerup", to.x, to.y);
  return out;
}

async function run(): Promise<void> {
  // ── 1. 指標座標換算：點在哪就選到哪 ──────────────────────────────
  {
    const p = project([block("a", { x: 100, y: 100, w: 200, h: 120 }),
                       block("b", { x: 600, y: 700, w: 200, h: 120 })]);
    editor.load(p);
    // 用容器裝：直接用 let 的話 TS 看不到回呼會賦值，會把它窄化成 never
    const sel: { picked: Block | null } = { picked: null };
    editor.onSelect = (b) => { sel.picked = b; };
    const tap = (x: number, y: number) => { pointer("pointerdown", x, y); pointer("pointerup", x, y); };

    tap(700, 760);   // 落在 b 的正中央
    check("指標座標換算：點 b 的中心選到 b", sel.picked?.id === "b", `選到 ${sel.picked?.id ?? "無"}`);

    tap(450, 450);   // 空白處
    check("點空白處取消選取", sel.picked === null, `選到 ${sel.picked?.id ?? "無"}`);

    // 邊界精度：貼著 a 的左緣兩側各點一次。
    // ⚠️ 這個案例是刻意設計來抓「絕對座標偏移」的——其他案例量的都是位移差，
    // 固定偏移會在相減時抵銷、根本測不出來（實測過：注入 7px 偏移仍全過）。
    tap(97, 160);
    const outside = sel.picked;
    tap(103, 160);
    check("邊界精度：左緣外側落空、內側命中",
          outside === null && sel.picked?.id === "a",
          `外側=${outside?.id ?? "無"}　內側=${sel.picked?.id ?? "無"}`);
  }

  // ── 2. 拖曳位移量正確（無吸附干擾）────────────────────────────────
  {
    const p = project([block("a", { x: 100, y: 100, w: 200, h: 120 })]);
    editor.load(p);
    editor.snapStrength = "none";
    const f = dragFrom(p, "a", { x: 640, y: 500 });
    // 從中心 (200,160) 拖到 (640,500)＝位移 (440,340)
    check("拖曳位移量精確", near(f.x, 540) && near(f.y, 440), `得到 x=${f.x.toFixed(2)} y=${f.y.toFixed(2)}，應為 540, 440`);
  }

  // ── 3. 吸附：左緣對左緣 ────────────────────────────────────────
  {
    const target = block("t", { x: 600, y: 200, w: 200, h: 120 });
    const p = project([block("a", { x: 100, y: 800, w: 160, h: 100 }), target]);
    editor.load(p);
    editor.snapStrength = "strong";
    // 把 a 拖到左緣距 t 左緣 5（在 8 的閾值內），y 遠離避免干擾
    const f = dragFrom(p, "a", { x: 605 + 80, y: 1000 + 50 });
    check("吸附：左緣咬住另一物件左緣", near(f.x, 600), `x=${f.x.toFixed(2)}，應為 600`);
  }

  // ── 4. 超出閾值就不該吸 ────────────────────────────────────────
  {
    const p = project([block("a", { x: 100, y: 800, w: 160, h: 100 }),
                       block("t", { x: 600, y: 200, w: 200, h: 120 })]);
    editor.load(p);
    editor.snapStrength = "strong";
    const f = dragFrom(p, "a", { x: 620 + 80, y: 1000 + 50 });   // 差 20 > 閾值 8
    check("超出閾值不吸附", near(f.x, 620), `x=${f.x.toFixed(2)}，應為 620`);
  }

  // ── 5. 旋轉：吸的是看得見的外接框，不是躺平的原始 frame ──────────
  //    這正是 iOS 端 2026-08-01 才修好的那個坑。
  {
    const rot = block("a", { x: 100, y: 800, w: 400, h: 80 }, 90);
    // 轉 90° 後外接框是 80×400，左緣＝中心x−40
    const p = project([rot, block("t", { x: 600, y: 200, w: 200, h: 120 })]);
    editor.load(p);
    editor.snapStrength = "strong";
    // 目標：讓外接框左緣落在 t 的左緣 600 附近（差 4）→ 中心 x 應為 600+40=640，先放 644
    const f = dragFrom(p, "a", { x: 644, y: 1000 });
    const boxLeft = f.x + f.w / 2 - 40;   // 外接框左緣
    check("旋轉後吸的是外接框的邊", near(boxLeft, 600),
          `外接框左緣=${boxLeft.toFixed(2)}，應為 600（frame.x=${f.x.toFixed(2)}）`);
  }

  // ── 6. 磁性關閉時完全自由 ──────────────────────────────────────
  {
    const p = project([block("a", { x: 100, y: 800, w: 160, h: 100 }),
                       block("t", { x: 600, y: 200, w: 200, h: 120 })]);
    editor.load(p);
    editor.snapStrength = "none";
    const f = dragFrom(p, "a", { x: 603 + 80, y: 1000 + 50 });
    check("磁性關閉時不吸附", near(f.x, 603), `x=${f.x.toFixed(2)}，應為 603`);
  }

  // ── 7. 貼字盒：載入後框要縮到貼著字，不能停在存檔裡的估值 ──────────
  //    範本的 frame 是 TemplateForge 寫的估值（橫排 +25%、直排 +10%），
  //    iOS 端載入後由 resizeToFitText 重算。少了這步框就會鬆一圈。
  {
    const p = project([]);
    p.blocks.push({
      id: "t", frame: { x: 100, y: 100, w: 900, h: 400 },   // 刻意給一個過大的框
      rotation: 0, zIndex: 1, locked: false, opacity: 1,
      content: { type: "text", text: { text: "對齊", alignment: "leading", fontSize: 100, colorHex: "000000" } },
    });
    editor.load(p);   // load 內部會跑 autoFitText
    const f = p.blocks[0].frame;
    // 兩個字 100pt，寬度應該在 200 上下、高度貼著字身（遠小於原本的 400）
    check("貼字盒：載入後框縮到貼著字",
          f.w < 300 && f.w > 120 && f.h < 160 && f.h > 60,
          `${f.w.toFixed(1)}×${f.h.toFixed(1)}（原本 900×400）`);

    // 真正的驗收：框的高度要等於墨跡高度，不是 ascent/descent 線
    const ctx = (editor as unknown as { ctx: CanvasRenderingContext2D }).ctx;
    ctx.save();
    ctx.font = `100px "PingFang TC"`;
    const m = ctx.measureText("對齊");
    ctx.restore();
    const inkH = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
    check("貼字盒高度＝墨跡高度（不是排版高度）",
          Math.abs(f.h - inkH) < inkH * 0.12,
          `框高 ${f.h.toFixed(1)}　墨跡高 ${inkH.toFixed(1)}`);
  }

  // ── 8. 直排的貼字盒也要貼合 ────────────────────────────────────
  {
    const p = project([]);
    p.blocks.push({
      id: "v", frame: { x: 200, y: 100, w: 400, h: 900 },   // 刻意給過大的框
      rotation: 0, zIndex: 1, locked: false, opacity: 1,
      content: { type: "text", text: { text: "對齊工具", alignment: "center", fontSize: 100,
                                        colorHex: "000000", vertical: true } },
    });
    const rightBefore = 200 + 400;
    editor.load(p);
    const f = p.blocks[0].frame;
    // 單欄四個字：寬度應該貼著一個字身（遠小於 400），高度約四個字高
    check("直排貼字盒：寬度貼著單欄字身",
          f.w < 180 && f.w > 60, `寬 ${f.w.toFixed(1)}（原本 400）`);
    check("直排貼字盒：高度貼著四個字",
          f.h < 480 && f.h > 300, `高 ${f.h.toFixed(1)}（原本 900）`);
    // 直排由右往左讀，收框要固定右緣，字才不會整段往左跳
    check("直排收框固定右緣（字留在原地）",
          Math.abs((f.x + f.w) - rightBefore) < 0.01,
          `右緣 ${(f.x + f.w).toFixed(2)}，應為 ${rightBefore}`);

    // 收框**不可以**改變欄數。拿被收過的 frame 高度回去當切欄約束就會循環相依，
    // 四個字裂成兩欄——2026-08-01 實際踩過，第 1 頁「作品名稱」當場裂開。
    // 單欄的寬度約等於一個字身；裂成兩欄寬度會翻倍，所以用寬度就抓得到。
    check("收框不改變欄數（單欄仍是單欄）",
          f.w < 180, `寬 ${f.w.toFixed(1)}，裂成兩欄的話會超過 180`);
  }

  // ── 9. 匯出：原尺寸、內容不空、頁數正確 ────────────────────────
  {
    const p = project([block("bg", { x: 0, y: 0, w: 1080, h: 1350 })]);
    p.pageBackgroundHex = { "0": "FFFFFF", "1": "FFFFFF" };
    const pages = renderAllPages(p);
    check("匯出：頁數與專案一致", pages.length === 2, `${pages.length} 頁`);
    const c = pages[0].canvas;
    check("匯出：原尺寸輸出（scale 1，畫布尺寸即像素）",
          c.width === 1080 && c.height === 1350, `${c.width}×${c.height}`);
    // 第一頁有個滿版灰塊，抽樣中心點確認真的畫了東西
    const d = c.getContext("2d")!.getImageData(540, 675, 1, 1).data;
    check("匯出：內容有畫進去（不是空白頁）",
          d[0] === 0x88 && d[1] === 0x88 && d[2] === 0x88,
          `中心像素 ${d[0]},${d[1]},${d[2]}`);
    // 檔名補零，檔案總管才會照頁序排
    check("匯出：檔名帶頁碼", pages[0].name.includes("_1.png"), pages[0].name);
  }

  // ── 10. 存檔往返：編碼回 iOS 形狀、再解碼要與原模型一致 ─────────────
  //     編碼錯了會**靜默弄壞使用者的專案檔**，這組測試是存檔功能的安全網。
  {
    const raw = await (await fetch("/samples/credits/project.json")).json();
    const p1 = decodeProject(raw);
    const enc = JSON.parse(JSON.stringify(encodeProject(p1))) as Record<string, never>;

    const b0 = (enc.blocks as Record<string, never>[])[0];
    check("編碼：frame 回到 [[x,y],[w,h]] 形狀",
          Array.isArray(b0.frame) && Array.isArray((b0.frame as unknown[])[0]),
          JSON.stringify(b0.frame).slice(0, 40));
    const c0 = b0.content as Record<string, { _0?: unknown }>;
    const kind = Object.keys(c0)[0];
    check("編碼：enum 包回 {type:{_0:…}}", !!c0[kind]?._0, kind);
    check("編碼：updatedAt 無毫秒（iOS ISO8601 解不了毫秒）",
          /T\d\d:\d\d:\d\dZ$/.test(enc.updatedAt as string), enc.updatedAt as string);

    // 文字顏色必須烤進 runs——只有 colorHex 的話 iOS 深色模式會變白字
    const textBlockEnc = (enc.blocks as Record<string, never>[])
      .map((b) => (b.content as Record<string, { _0: Record<string, unknown> }>).text?._0)
      .find(Boolean);
    const runs = textBlockEnc?.text as unknown[] | undefined;
    const runAttr = runs?.find((r) => typeof r === "object") as Record<string, unknown> | undefined;
    check("編碼：顏色烤進 AttributedString runs", !!runAttr?.["SwiftUI.ForegroundColor"],
          JSON.stringify(runAttr ?? {}).slice(0, 60));

    const p2 = decodeProject(enc);
    // updatedAt 是刻意換新的；fullText 是刻意重建的 runs——其餘必須逐欄位一致。
    // 比內容不比鍵序（原檔 sortedKeys、編碼是 spread 序），先遞迴排序鍵。
    const canon = (x: unknown): unknown =>
      Array.isArray(x) ? x.map(canon)
      : (x && typeof x === "object")
        ? Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, canon((x as Record<string, unknown>)[k])]))
        : x;
    const strip = (x: unknown) => JSON.stringify(canon(x), (k, v) =>
      (k === "updatedAt" || k === "fullText") ? 0 : (v as unknown));
    check("存檔往返：再解碼與原模型逐欄位一致", strip(p2) === strip(p1),
          strip(p2) === strip(p1) ? `${p1.blocks.length} blocks` : "有欄位在往返中變質");
  }

  // ── 11. 長文框／排開／空欄位（2026-08-04 補齊的三塊引擎）──────────────
  {
    const p = project([]);
    // 長文框：固定容器，超出必裁
    p.blocks.push({
      id: "body", frame: { x: 100, y: 100, w: 420, h: 150 },
      rotation: 0, zIndex: 1, locked: false, opacity: 1,
      content: { type: "text", text: { text: "測".repeat(200), alignment: "leading",
        fontSize: 40, colorHex: "000000", isBodyFrame: true, manualWidth: 420, manualHeight: 150 } },
    });
    // 排開：黃色矩形在長文框右半，side 模式擋右邊
    p.blocks.push({
      id: "hole", frame: { x: 400, y: 420, w: 140, h: 140 },
      rotation: 0, zIndex: 2, locked: false, opacity: 1,
      content: { type: "shape", shape: { kind: "rectangle", colorHex: "F5C518", excludesText: true } },
    });
    p.blocks.push({
      id: "body2", frame: { x: 100, y: 400, w: 500, h: 200 },
      rotation: 0, zIndex: 1, locked: false, opacity: 1,
      content: { type: "text", text: { text: "字".repeat(300), alignment: "leading",
        fontSize: 34, colorHex: "000000", isBodyFrame: true, manualWidth: 500, manualHeight: 200 } },
    });
    // 空欄位框
    p.blocks.push({
      id: "slot", frame: { x: 700, y: 120, w: 260, h: 200 },
      rotation: 0, zIndex: 1, locked: false, opacity: 1,
      content: { type: "image", media: { assetFileName: "", cropRect: { x: 0, y: 0, w: 1, h: 1 } } },
    });
    const page = renderAllPages(p)[0].canvas;
    const px = (x: number, y: number) => page.getContext("2d")!.getImageData(x, y, 1, 1).data;
    const dark = (d: Uint8ClampedArray) => d[0] < 120 && d[1] < 120 && d[2] < 120;

    // 框內上緣有字、框下緣以下必須是乾淨的白（被裁掉）
    let inkInside = false;
    for (let x = 110; x < 500; x += 8) if (dark(px(x, 128))) { inkInside = true; break; }
    let leakBelow = false;
    for (let y = 258; y < 380; y += 6) for (let x = 105; x < 515; x += 12) {
      if (dark(px(x, y))) { leakBelow = true; break; }
    }
    check("長文框：字在框內、超出被裁", inkInside && !leakBelow,
          `框內有字=${inkInside} 框外滲漏=${leakBelow}`);

    // 排開（side・圖靠右→字留左）：洞的左緣−margin 到右框緣，整個帶不得有墨
    // 洞帶＝y 420−18…560+18；被擋區＝x 400−18…600
    let bleed = false;
    for (let y = 430; y < 560; y += 8) for (let x = 386; x < 396; x += 3) {
      if (dark(px(x, y))) { bleed = true; break; }
    }
    let textLeft = false;
    for (let y = 430; y < 560; y += 8) for (let x = 110; x < 300; x += 8) {
      if (dark(px(x, y))) { textLeft = true; break; }
    }
    check("排開文字：洞邊不滲墨、字繞在留側", !bleed && textLeft,
          `滲墨=${bleed} 左側有字=${textLeft}`);

    // 空欄位框：範本欄位要畫出來（虛線／填色＝框內有非白像素），匯出也一樣
    let slotInk = 0;
    for (let y = 130; y < 310; y += 6) for (let x = 710; x < 950; x += 8) {
      const d = px(x, y);
      if (d[0] < 250 || d[1] < 250 || d[2] < 250) slotInk++;
    }
    check("空欄位框：佔位樣式有畫（含匯出）", slotInk > 30, `非白取樣點 ${slotInk}`);
  }

  // 撕紙邊 × 去背：撕的是**背後那張紙**，不是圖片外框。
  // 外框那圈在去背之後本來就沒有東西，撕它等於什麼都不會發生（2026-09-01 小高實測）。
  {
    const solid = (): HTMLCanvasElement => {
      const c = document.createElement("canvas");
      c.width = c.height = 800;
      const x = c.getContext("2d")!;
      x.fillStyle = "#ff0000"; x.fillRect(0, 0, 800, 800);
      return c;
    };
    const matte = (): HTMLCanvasElement => {      // 中央一小塊＝主體，其餘透明
      const c = document.createElement("canvas");
      c.width = c.height = 800;
      const x = c.getContext("2d")!;
      x.clearRect(0, 0, 800, 800);
      x.fillStyle = "#fff"; x.fillRect(300, 300, 200, 200);
      return c;
    };
    const images = new Map<string, CanvasImageSource>([
      ["s.png", solid()], ["matte:cut.png", matte()],
    ]);
    const p = project([]);
    p.pageCount = 1;
    p.blocks.push({
      id: "cut", frame: { x: 100, y: 100, w: 400, h: 400 }, rotation: 0, zIndex: 0,
      locked: false, opacity: 1,
      content: { type: "image", media: {
        assetFileName: "s.png", cropRect: { x: 0, y: 0, w: 1, h: 1 },
        matteFileName: "cut.png", tornStyle: "tear",
      } },
    });
    const cv = renderAllPages(p, { images, mattes: images })[0].canvas;
    const at = (x: number, y: number): number[] =>
      [...cv.getContext("2d")!.getImageData(x, y, 1, 1).data];
    const subject = at(300, 300);                 // 主體：紅
    const between = at(140, 300);                 // 主體與外框之間：應該是撕出來的紙
    const corner = at(104, 104);                  // 角落：被撕掉，露出頁面白底
    const isPaper = (d: number[]) => d[3] > 200 && d[0] > 225 && d[2] > 200 && d[0] - d[2] > 6;
    check("撕紙邊 × 去背：撕的是背後那張紙（不是外框，也不是什麼都不做）",
          subject[0] > 200 && subject[1] < 80
          && isPaper(between)
          && !(corner[0] - corner[2] > 6),
          `主體=${subject.slice(0, 3)} 紙=${between.slice(0, 3)} 角落=${corner.slice(0, 3)}`);
  }

  // 內文框裡有一個「不可斷單位」比整個框還寬（超長網址／長英數字串）。
  // 2026-09-01 回歸：斷行改成單位化之後，這種單位塞不進任何一段 → i 不前進 →
  // yTop 一路加到框底 → **它以後的字整段消失**。硬斷之後兩段都要看得見。
  {
    const long = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".repeat(4);   // 144 個字元不可斷
    const p = project([{
      id: "long", frame: { x: 100, y: 100, w: 400, h: 400 },
      rotation: 0, zIndex: 1, locked: false, opacity: 1,
      content: { type: "text", text: { text: `${long}\n後面這段一定要看得見`,
        alignment: "leading", fontSize: 30, colorHex: "000000",
        isBodyFrame: true, manualWidth: 400, manualHeight: 400 } },
    }]);
    p.pageCount = 1;
    const cv = renderAllPages(p)[0].canvas;
    const g = cv.getContext("2d")!;
    const rowHasInk = (y: number): boolean => {
      const d = g.getImageData(102, y, 396, 1).data;
      for (let i = 0; i < d.length; i += 4) if (d[i] < 120 && d[i + 1] < 120 && d[i + 2] < 120) return true;
      return false;
    };
    let firstInk = -1, lastInk = -1;
    for (let y = 102; y < 498; y++) if (rowHasInk(y)) { if (firstInk < 0) firstInk = y; lastInk = y; }
    check("內文框：超長不可斷字串會硬斷，後面的段落不會整段消失",
          firstInk > 0 && lastInk - firstInk > 90,
          `墨跡 y ${firstInk}…${lastInk}（只有一行＝後面被吃掉了）`);
  }

  // ── 12. 四點縮放手把（2026-08-04）────────────────────────────────────
  //    鐵則：**錨在看得見的對角**。旋轉後如果拿沒轉過的 frame 當錨，
  //    元件會邊拉邊漂——iOS 端 8/1 修過同一個坑，這裡一次測到。
  {
    const media = (id: string, frame: Rect, rotation = 0): Block => ({
      id, frame, rotation, zIndex: 1, locked: false, opacity: 1,
      content: { type: "image", media: { assetFileName: "x.jpg", cropRect: { x: 0, y: 0, w: 1, h: 1 } } },
    });
    /** 測試自己算的旋轉角座標——不從 editor 借，借了就變成自己驗自己。 */
    const cornerAt = (f: Rect, rot: number, nx: number, ny: number) => {
      const r = (rot * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
      const dx = (nx - 0.5) * f.w, dy = (ny - 0.5) * f.h;
      return { x: f.x + f.w / 2 + dx * c - dy * s, y: f.y + f.h / 2 + dx * s + dy * c };
    };
    const dragHandle = (p: Project, id: string, from: { x: number; y: number }, to: { x: number; y: number }): Rect => {
      editor.load(p); editor.snapStrength = "none"; editor.select(id);
      pointer("pointerdown", from.x, from.y);
      pointer("pointermove", to.x, to.y);
      const out = { ...p.blocks.find((b) => b.id === id)!.frame };
      pointer("pointerup", to.x, to.y);
      return out;
    };

    // (a) 未旋轉：拉右下角＝左上角釘住、比例不變、尺寸走投影解
    {
      const p = project([media("m", { x: 200, y: 200, w: 400, h: 300 })]);
      const f = dragHandle(p, "m", { x: 600, y: 500 }, { x: 800, y: 800 });
      // 投影：u=(600,600)、d=(400,300) → k=(600·400+600·300)/(400²+300²)=1.68
      check("手把：對角釘住＋等比鎖（照片）",
            near(f.x, 200) && near(f.y, 200) && near(f.w, 672, 0.5) && near(f.h, 504, 0.5),
            `${f.x.toFixed(1)},${f.y.toFixed(1)} ${f.w.toFixed(1)}×${f.h.toFixed(1)}（應為 200,200 672×504）`);
    }

    // (b) 旋轉 30°：手把長在轉過的角上，拉完對角的**視覺位置**不能動
    {
      const f0: Rect = { x: 300, y: 300, w: 400, h: 200 };
      const p = project([media("m", f0, 30)]);
      const grab = cornerAt(f0, 30, 1, 1);
      const anchor0 = cornerAt(f0, 30, 0, 0);
      const f1 = dragHandle(p, "m", grab, { x: grab.x + 140, y: grab.y + 80 });
      const anchor1 = cornerAt(f1, 30, 0, 0);
      check("手把：旋轉後對角的視覺位置不動（且真的長大了）",
            f1.w > f0.w + 20 && near(anchor1.x, anchor0.x, 0.5) && near(anchor1.y, anchor0.y, 0.5),
            `錨 ${anchor0.x.toFixed(1)},${anchor0.y.toFixed(1)} → ${anchor1.x.toFixed(1)},${anchor1.y.toFixed(1)}　寬 ${f0.w}→${f1.w.toFixed(1)}`);
    }

    // (c) 形狀自由拉：兩軸各自跟手（只有照片／影片鎖比例）
    {
      const p = project([block("s", { x: 100, y: 100, w: 200, h: 200 })]);
      const f = dragHandle(p, "s", { x: 300, y: 300 }, { x: 500, y: 350 });
      check("手把：形狀自由拉、不鎖比例", near(f.w, 400) && near(f.h, 250),
            `${f.w.toFixed(1)}×${f.h.toFixed(1)}，應為 400×250`);
    }

    // (d) 反向拉過頭收斂到最小尺寸（canvasWidth 的 5%＝54），不會翻面成負值
    {
      const p = project([media("m", { x: 200, y: 200, w: 400, h: 300 })]);
      const f = dragHandle(p, "m", { x: 600, y: 500 }, { x: 120, y: 120 });
      check("手把：拉過頭收斂到最小尺寸", near(f.w, 54, 0.5) && f.h > 0 && near(f.x, 200) && near(f.y, 200),
            `${f.w.toFixed(1)}×${f.h.toFixed(1)} @ ${f.x.toFixed(1)},${f.y.toFixed(1)}`);
    }

    // (e) 文字手把長在框外——抓在字身**中央**仍是整塊移動，不會被手把吃掉
    //    （2026-08-14 起文字有自己的手把了：角＝字級、右緣＝欄寬，見 18b 案例；
    //    這裡守住的是反面：手把只住在框外緣，塊身的拖曳語意不變。）
    {
      const p = project([]);
      p.blocks.push({
        id: "t", frame: { x: 200, y: 200, w: 300, h: 120 }, rotation: 0, zIndex: 1, locked: false, opacity: 1,
        content: { type: "text", text: { text: "對齊", alignment: "leading", fontSize: 100, colorHex: "000000" } },
      });
      editor.load(p); editor.snapStrength = "none"; editor.select("t");
      const f0 = { ...p.blocks[0].frame };          // load 內已重算成貼字盒
      const c = { x: f0.x + f0.w / 2, y: f0.y + f0.h / 2 };
      pointer("pointerdown", c.x, c.y);
      pointer("pointermove", c.x + 200, c.y + 200);
      const f1 = { ...p.blocks[0].frame };
      pointer("pointerup", c.x + 200, c.y + 200);
      check("文字抓中央＝整塊移動（手把只住在框外緣，字級不被誤改）",
            near(f1.w, f0.w) && near(f1.h, f0.h) && near(f1.x, f0.x + 200) && near(f1.y, f0.y + 200),
            `${f0.w.toFixed(1)}×${f0.h.toFixed(1)} → ${f1.w.toFixed(1)}×${f1.h.toFixed(1)}　x ${f0.x.toFixed(1)}→${f1.x.toFixed(1)}`);
    }
  }

  // ── 13. 影片：編輯畫布畫即時影格、匯出畫海報 ─────────────────────────
  //    匯出若跟著畫即時影格，同一份專案匯出兩次就會不一樣——決定性優先。
  {
    const solid = (color: string): HTMLCanvasElement => {
      const c = document.createElement("canvas");
      c.width = 40; c.height = 40;
      const x = c.getContext("2d")!;
      x.fillStyle = color; x.fillRect(0, 0, 40, 40);
      return c;
    };
    const p = project([]);
    p.blocks.push({
      id: "v", frame: { x: 100, y: 100, w: 200, h: 200 }, rotation: 0, zIndex: 1, locked: false, opacity: 1,
      content: { type: "video", media: { assetFileName: "clip.mov", cropRect: { x: 0, y: 0, w: 1, h: 1 } } },
    });
    const images = new Map<string, CanvasImageSource>([["clip.mov.poster.jpg", solid("#ff0000")]]);
    const videos = new Map<string, CanvasImageSource>([["clip.mov", solid("#0000ff")]]);
    const at = (c: HTMLCanvasElement) => c.getContext("2d")!.getImageData(200, 200, 1, 1).data;
    const live = at(renderAllPages(p, { images, videos })[0].canvas);
    const still = at(renderAllPages(p, { images })[0].canvas);
    check("影片：有即時影格畫影格、匯出仍是海報",
          live[2] > 200 && live[0] < 60 && still[0] > 200 && still[2] < 60,
          `即時=rgb(${live[0]},${live[1]},${live[2]})　海報=rgb(${still[0]},${still[1]},${still[2]})`);
  }

  // ── 14. 八點裁切的「邊」＝真裁切（2026-08-04）──────────────────────────
  //    這一組的真正驗收不是數字，是**畫面**：裁右邊時，左邊看到的每一個像素
  //    都必須跟裁之前一模一樣。frame 與 cropRect 只要有一邊算錯，照片就會滑動或縮放。
  {
    /** 直條紋素材：任何位移或縮放都會在逐像素比對裡露餡。 */
    const stripes = (): HTMLCanvasElement => {
      const c = document.createElement("canvas");
      c.width = 800; c.height = 600;
      const x = c.getContext("2d")!;
      for (let i = 0; i < 16; i++) {
        x.fillStyle = `hsl(${i * 22} 80% ${i % 2 ? 42 : 68}%)`;
        x.fillRect(i * 50, 0, 50, 600);
      }
      x.fillStyle = "#000"; x.fillRect(0, 280, 800, 40);
      return c;
    };
    const images = new Map<string, CanvasImageSource>([["pic.png", stripes()]]);
    const mkProject = (rotation = 0): Project => {
      const p = project([]);
      p.blocks.push({
        id: "img", frame: { x: 100, y: 100, w: 400, h: 400 }, rotation, zIndex: 1, locked: false, opacity: 1,
        content: { type: "image", media: { assetFileName: "pic.png", cropRect: { x: 0, y: 0, w: 1, h: 1 } } },
      });
      return p;
    };
    const pixels = (p: Project, x: number, y: number, w: number, h: number) =>
      renderAllPages(p, { images })[0].canvas.getContext("2d")!.getImageData(x, y, w, h).data;

    // (a) 拉右邊往內＝裁掉右邊，左半邊的畫面逐像素不變
    {
      const p = mkProject();
      editor.load(p, images); editor.snapStrength = "none"; editor.select("img");
      const before = pixels(p, 100, 100, 290, 400);
      pointer("pointerdown", 500, 300);          // 右邊中點
      pointer("pointermove", 400, 300);          // 往內 100
      const f = { ...p.blocks[0].frame };
      const c = { ...(p.blocks[0].content as { media: { cropRect: Rect } }).media.cropRect };
      pointer("pointerup", 400, 300);
      const after = pixels(p, 100, 100, 290, 400);
      let worst = 0;
      for (let i = 0; i < before.length; i++) worst = Math.max(worst, Math.abs(before[i] - after[i]));
      check("裁切：拉右邊，錨定側的畫面逐像素不動",
            worst === 0 && near(f.x, 100) && near(f.w, 300) && near(c.x, 0.125, 0.001) && near(c.w, 0.5625, 0.001),
            `最大像素差=${worst}　frame ${f.x.toFixed(0)}/${f.w.toFixed(0)}　crop x=${c.x.toFixed(3)} w=${c.w.toFixed(3)}`);
    }

    // (b) 往外拉：露出藏起來的部分，到素材邊緣就停（不會拉出白邊）
    {
      const p = mkProject();
      editor.load(p, images); editor.snapStrength = "none"; editor.select("img");
      pointer("pointerdown", 100, 300);          // 左邊中點
      pointer("pointermove", -900, 300);         // 往外拉一大段
      const f = { ...p.blocks[0].frame };
      const c = { ...(p.blocks[0].content as { media: { cropRect: Rect } }).media.cropRect };
      pointer("pointerup", -900, 300);
      // aspect-fill 後 crop=(0.125,0,0.75,1)；左邊最多還能露 0.125 → 寬 400×(0.875/0.75)
      check("裁切：往外拉露出藏起來的部分、到素材邊緣就停",
            near(f.w, 466.67, 0.1) && near(c.x, 0, 0.001) && near(c.w, 0.875, 0.001),
            `寬=${f.w.toFixed(2)}（上限 466.67）　crop x=${c.x.toFixed(3)} w=${c.w.toFixed(3)}`);
    }

    // (c2) 螢幕上太小的元件不長手把——不然抓取範圍會把整塊吃掉，變成拖不動
    {
      const p = project([block("tiny", { x: 300, y: 300, w: 60, h: 60 })]);
      editor.load(p); editor.snapStrength = "none"; editor.select("tiny");
      const f = dragFrom(p, "tiny", { x: 500, y: 400 });   // 從中心拖走
      check("小元件不長手把（拖得動、不是被縮放）",
            near(f.w, 60) && near(f.h, 60) && near(f.x, 470) && near(f.y, 370),
            `${f.w.toFixed(0)}×${f.h.toFixed(0)} @ ${f.x.toFixed(0)},${f.y.toFixed(0)}（應為 60×60 @ 470,370）`);
    }

    // (e) 極細描邊不准消失（2026-08-30 迴歸）
    //     描邊寬度存的是短邊的比例，面板最小刻度 1 ＝ 0.12%。短邊 400 的框上是 0.48 畫素，
    //     畫得出來但只有三成多的不透明度，匯出的圖上等於沒有。地板訂在一個頁面畫素。
    {
      const white = (): HTMLCanvasElement => {
        const c = document.createElement("canvas");
        c.width = 200; c.height = 200;
        const x = c.getContext("2d")!;
        x.fillStyle = "#ffffff"; x.fillRect(0, 0, 200, 200);
        return c;
      };
      const images = new Map<string, CanvasImageSource>([["w.png", white()]]);
      const p = project([]);
      p.blocks.push({
        id: "thin", frame: { x: 100, y: 100, w: 400, h: 400 }, rotation: 0, zIndex: 1,
        locked: false, opacity: 1,
        content: { type: "image", media: {
          assetFileName: "w.png", cropRect: { x: 0, y: 0, w: 1, h: 1 },
          strokeHex: "000000", strokeWidth: 0.0012,   // 面板刻度 1（黑線壓在白圖上才看得出來）
        } },
      });
      const c = renderAllPages(p, { images })[0].canvas;
      const d = c.getContext("2d")!.getImageData(100, 250, 1, 1).data;
      // 未修時這裡約 165（0.48 畫素的鬼影），修好是實心黑
      check("描邊：面板刻度 1 也畫得滿一個畫素",
            d[0] < 12 && d[1] < 12 && d[2] < 12,
            `最外側畫素 R=${d[0]}（應接近 0）`);
    }

    // (e2) 匯出那條路同一個下限（2026-08-31 迴歸）
    //     影片匯出的描邊不走 drawFrameStroke，走 maskAndStrokeCanvases 烤圖——
    //     漏了下限的話，畫布上 1px 的實線在 mp4 裡是 0.48px 的半透明淡線＝預覽與匯出不一致。
    {
      const m: MediaBlock = {
        assetFileName: "", cropRect: { x: 0, y: 0, w: 1, h: 1 },
        strokeHex: "000000", strokeWidth: 0.0012,   // 面板刻度 1
      };
      const { stroke } = maskAndStrokeCanvases(m, 600, 400);
      const a = stroke ? stroke.getContext("2d")!.getImageData(300, 0, 1, 1).data[3] : 0;
      // 未修時上緣畫素 alpha 約 122（36% 淡線），修好是實心
      check("描邊：匯出烤圖同守 1px 下限", a >= 200, `邊緣 alpha=${a}（應 ≥ 200）`);
    }

    // (d) 填材質層拉邊裁切，遮罩不能變形（2026-08-30 迴歸）
    //     那層的素材是**正方形材質**、遮罩是 3:2 照片的，兩張比例不同卻共用一個
    //     cropRect。裁切前 (0,0,1,1) 是哨兵值，兩張各自 aspect-fill 所以是對的；
    //     一裁下去，若把材質算出來的矩形寫進 cropRect，遮罩就被非等比拉伸＝人形變形。
    //     修法：有遮罩時 cropRect 的座標系是**遮罩**的（editor.cropGeometryOf）。
    {
      const tex = (): HTMLCanvasElement => {           // 正方形材質，純紅好認
        const c = document.createElement("canvas");
        c.width = 800; c.height = 800;
        const x = c.getContext("2d")!;
        x.fillStyle = "#ff0000"; x.fillRect(0, 0, 800, 800);
        return c;
      };
      const matte = (): HTMLCanvasElement => {         // 3:2 遮罩，中央一個正方形的洞
        const c = document.createElement("canvas");
        c.width = 900; c.height = 600;
        const x = c.getContext("2d")!;
        x.clearRect(0, 0, 900, 600);
        x.fillStyle = "#fff"; x.fillRect(300, 150, 300, 300);
        return c;
      };
      const images = new Map<string, CanvasImageSource>([
        ["tex.png", tex()], ["matte:cut.png", matte()],
      ]);
      const mk = (): Project => {
        const p = project([]);
        p.blocks.push({
          id: "fill", frame: { x: 100, y: 100, w: 400, h: 400 }, rotation: 0, zIndex: 1,
          locked: false, opacity: 1,
          content: { type: "image", media: {
            assetFileName: "tex.png", cropRect: { x: 0, y: 0, w: 1, h: 1 },
            matteFileName: "cut.png",
          } },
        });
        return p;
      };
      /** 畫出來那塊紅色的外接框——比例 1 才代表遮罩沒被拉扁。 */
      const redBox = (p: Project): { w: number; h: number } => {
        const c = renderAllPages(p, { images, mattes: images })[0].canvas;
        const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
        let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
        for (let y = 0; y < c.height; y++) {
          for (let x = 0; x < c.width; x++) {
            const i = (y * c.width + x) * 4;
            if (d[i] > 200 && d[i + 1] < 80 && d[i + 2] < 80) {
              if (x < x0) x0 = x; if (x > x1) x1 = x;
              if (y < y0) y0 = y; if (y > y1) y1 = y;
            }
          }
        }
        return { w: x1 - x0 + 1, h: y1 - y0 + 1 };
      };

      const p0 = mk();
      const b0 = redBox(p0);
      const p = mk();
      editor.load(p, images); editor.snapStrength = "none"; editor.select("fill");
      pointer("pointerdown", 500, 300);          // 右邊中點
      pointer("pointermove", 400, 300);          // 往內 100
      const c = { ...(p.blocks[0].content as { media: { cropRect: Rect } }).media.cropRect };
      pointer("pointerup", 400, 300);
      const b1 = redBox(p);
      // 遮罩的 aspect-fill：3:2 進 1:1＝(0.1667,0,0.6667,1)，再乘 300/400
      // （用素材算的話會是 (0,0,1,1) 乘 0.75＝x:0 w:0.75，遮罩就被壓成 2:3）
      check("填材質：裁切後遮罩不變形（cropRect 以遮罩為座標系）",
            near(c.x, 0.1667, 0.002) && near(c.w, 0.5, 0.002)
            && near(b0.w / b0.h, 1, 0.03) && near(b1.w / b1.h, 1, 0.03),
            `crop x=${c.x.toFixed(4)} w=${c.w.toFixed(4)}（應 0.1667/0.5）　`
            + `裁前 ${b0.w}×${b0.h}　裁後 ${b1.w}×${b1.h}（都該是正方形）`);
    }

    // (c) 旋轉過的媒體不給邊手把（錨定邊的算式假設軸對齊）——拉邊＝整塊移動
    {
      const p = mkProject(20);
      editor.load(p, images); editor.snapStrength = "none"; editor.select("img");
      const f0 = { ...p.blocks[0].frame };
      pointer("pointerdown", 300, 300);          // 塊的中心（旋轉後邊中點不在軸上）
      pointer("pointermove", 420, 300);
      const f1 = { ...p.blocks[0].frame };
      const c1 = { ...(p.blocks[0].content as { media: { cropRect: Rect } }).media.cropRect };
      pointer("pointerup", 420, 300);
      check("裁切：旋轉過的媒體不裁切（拉了是移動，cropRect 不動）",
            near(f1.w, f0.w) && near(f1.h, f0.h) && near(f1.x, f0.x + 120)
            && c1.x === 0 && c1.w === 1,
            `${f0.w}×${f0.h} → ${f1.w.toFixed(0)}×${f1.h.toFixed(0)}　crop=${c1.x},${c1.w}`);
    }
  }

  // ── 15. 與 iPad 對齊的渲染缺口（2026-08-04）──────────────────────────
  //    這一組全是「開 iPad 檔會畫錯」的類型：少畫一個效果不會報錯，只會安靜地不一樣。
  {
    const textBlock = (extra: Partial<TextBlock>): Project => {
      const p = project([]);
      p.blocks.push({
        id: "t", frame: { x: 200, y: 200, w: 400, h: 160 }, rotation: 0, zIndex: 1, locked: false, opacity: 1,
        content: { type: "text", text: { text: "對齊", alignment: "leading", fontSize: 120, colorHex: "000000", ...extra } },
      });
      autoFitText(document.createElement("canvas").getContext("2d")!, p);
      return p;
    };
    const px = (c: HTMLCanvasElement, x: number, y: number) => c.getContext("2d")!.getImageData(x, y, 1, 1).data;

    // (a) 文字陰影：字的正下方要出現灰帶；沒設陰影的同一點必須是純白
    {
      const plain = renderAllPages(textBlock({}))[0].canvas;
      const soft = renderAllPages(textBlock({ shadowStyle: "soft" }))[0].canvas;
      const f = textBlock({}).blocks[0].frame;
      const y = Math.round(f.y + f.h + 4), x0 = Math.round(f.x + 20);
      let inkPlain = 0, inkSoft = 0;
      for (let x = x0; x < x0 + 160; x += 4) {
        if (px(plain, x, y)[0] < 250) inkPlain++;
        if (px(soft, x, y)[0] < 250) inkSoft++;
      }
      check("文字陰影：soft 會在字下方畫出陰影（沒設的不會）",
            inkSoft > 5 && inkPlain === 0, `有陰影取樣=${inkSoft}　無陰影取樣=${inkPlain}`);
    }

    // (b) 陰影不影響貼字盒——它是渲染層效果，量測與 frame 不能動
    {
      const a = textBlock({}).blocks[0].frame;
      const b = textBlock({ shadowStyle: "strong" }).blocks[0].frame;
      check("文字陰影：不影響貼字盒（量測不變）",
            near(a.w, b.w) && near(a.h, b.h), `${a.w.toFixed(1)}×${a.h.toFixed(1)} vs ${b.w.toFixed(1)}×${b.h.toFixed(1)}`);
    }

    // (c) 文字底色：iOS 是往外撐 0.25em 的圓角矩形——框外 0.15em 處要有底色
    {
      const p = textBlock({ backgroundColorHex: "FFCC00" });
      const c = renderAllPages(p)[0].canvas;
      const f = p.blocks[0].frame;
      const out = px(c, Math.round(f.x + f.w / 2), Math.round(f.y - 0.15 * 120));
      check("文字底色：圓角矩形往外撐 0.25em（框外也要有色）",
            out[0] > 200 && out[1] > 150 && out[2] < 100, `框外取樣 rgb(${out[0]},${out[1]},${out[2]})`);
    }

    // (d) 圖片拉直：繞裁切區中心轉——中心的內容不變，離中心的內容換掉
    {
      const marker = (): HTMLCanvasElement => {
        const c = document.createElement("canvas");
        c.width = 400; c.height = 400;
        const x = c.getContext("2d")!;
        x.fillStyle = "#ffffff"; x.fillRect(0, 0, 400, 400);
        x.fillStyle = "#1050ff"; x.fillRect(0, 0, 400, 120);      // 上緣一條藍帶
        x.fillStyle = "#e02020"; x.fillRect(180, 180, 40, 40);    // 正中央紅點
        return c;
      };
      const images = new Map<string, CanvasImageSource>([["m.png", marker()]]);
      // 用真實情況的 cropRect（裁切畫面出來的都會小於整張），轉了才不會露出空角
      const mk = (deg?: number): Project => {
        const p = project([]);
        p.blocks.push({
          id: "m", frame: { x: 200, y: 200, w: 400, h: 400 }, rotation: 0, zIndex: 1, locked: false, opacity: 1,
          content: { type: "image", media: { assetFileName: "m.png", cropRect: { x: 0.2, y: 0.2, w: 0.6, h: 0.6 }, rotationDegrees: deg } },
        });
        return p;
      };
      const flat = renderAllPages(mk(), { images })[0].canvas;
      const tilt = renderAllPages(mk(30), { images })[0].canvas;
      const isRed = (d: Uint8ClampedArray) => d[0] > 150 && d[2] < 90;
      const isBlue = (d: Uint8ClampedArray) => d[2] > 150 && d[0] < 110;
      // 中心＝紅點，繞中心轉所以兩邊都該是紅的
      const same = isRed(px(flat, 400, 400)) && isRed(px(tilt, 400, 400));
      // 上緣的藍帶：沒轉時左右對稱都藍，轉了就會一邊翹起來——這是「真的轉了」的簽名
      const lf = isBlue(px(flat, 240, 230)), rf = isBlue(px(flat, 560, 230));
      const lt = isBlue(px(tilt, 240, 230)), rt = isBlue(px(tilt, 560, 230));
      check("圖片拉直：繞裁切中心轉（中心不動、上緣帶跟著傾斜）",
            same && lf && rf && lt !== rt,
            `中心紅=${same}　沒轉左右=${lf}/${rf}　轉後左右=${lt}/${rt}`);
    }

    // (e) 使用者參考線：編輯畫布看得到、匯出看不到
    {
      const p = project([]);
      p.guidesX = [300]; p.guidesY = [500];
      const c = document.createElement("canvas");
      c.width = 2160; c.height = 1350;
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, c.width, c.height);
      renderStage(ctx, p);
      const onV = px(c, 300, 700), onH = px(c, 900, 500);
      // 1px 的線會跨兩欄各半，取樣點是半透明混白——所以驗「偏藍」而不是硬門檻
      const blue = (d: Uint8ClampedArray) => d[2] > 180 && d[2] - d[0] > 40;
      const exported = renderAllPages(p)[0].canvas;
      check("使用者參考線：編輯畫布畫得出來、匯出不畫",
            blue(onV) && blue(onH) && px(exported, 300, 700)[2] > 250,
            `垂直=${blue(onV)} 水平=${blue(onH)} 匯出乾淨=${px(exported, 300, 700)[2] > 250}`);
    }
  }

  // ── 16. 檢視器的新開關真的接到模型（2026-08-04）────────────────────────
  //    引擎做好但沒有開關＝使用者用不到。這組驗的是「按下去有沒有寫進 block」。
  {
    const host = document.createElement("div");
    document.body.append(host);
    const changes = { count: 0 };
    const inspector = new Inspector(host, {
      onChange: () => { changes.count++; },
      ensureVariant: async () => {},
      reorder: () => {}, remove: () => {}, fillMedia: () => {},
      changeRatio: () => {},
      guides: { hidden: () => false, toggleHidden: () => {}, add: () => {}, remove: () => {},
                locked: () => false, toggleLocked: () => {},
                presets: { filled: () => [], apply: () => {}, save: () => {}, clear: () => {} } },
      layers: { currentPage: () => 0, select: () => {}, reorder: () => {}, toggleLock: () => {},
                thumb: () => undefined },
      group: { align: () => {}, distribute: () => {}, duplicate: () => {}, remove: () => {} },
    });
    /** 依標籤找那一列的控制項（跟使用者看到的是同一個 DOM）。 */
    const control = <T extends HTMLElement>(label: string, tag: string): T | null => {
      for (const row of host.querySelectorAll(".row")) {
        if (row.querySelector("label")?.textContent === label) return row.querySelector<T>(tag);
      }
      return null;
    };

    // (a) 長文框開關：打開＝寫 isBodyFrame＋把框轉成使用者定尺寸
    {
      const p = project([]);
      p.blocks.push({
        id: "t", frame: { x: 100, y: 100, w: 300, h: 60 }, rotation: 0, zIndex: 1, locked: false, opacity: 1,
        content: { type: "text", text: { text: "長文", alignment: "leading", fontSize: 40, colorHex: "000000" } },
      });
      inspector.show(p, p.blocks[0]);
      const box = control<HTMLInputElement>("長文框", "input[type=checkbox]");
      box!.checked = true;
      box!.dispatchEvent(new Event("change"));
      const t = (p.blocks[0].content as { text: TextBlock }).text;
      check("檢視器：長文框開關寫得進模型（框轉成固定容器）",
            t.isBodyFrame === true && t.manualWidth === 300 && (t.manualHeight ?? 0) >= 160
            && p.blocks[0].frame.h === t.manualHeight,
            `isBodyFrame=${t.isBodyFrame} 框=${t.manualWidth}×${t.manualHeight}`);

      // 打開後才會出現的「框內對齊」
      const va = control<HTMLSelectElement>("框內對齊", "select");
      va!.value = "middle";
      va!.dispatchEvent(new Event("change"));
      check("檢視器：長文框的框內對齊", t.verticalAlignment === "middle", `verticalAlignment=${t.verticalAlignment}`);
    }

    // (b) 排開文字：開關＋三種模式都要寫得進去
    {
      const p = project([block("s", { x: 100, y: 100, w: 200, h: 200 })]);
      inspector.show(p, p.blocks[0]);
      const box = control<HTMLInputElement>("排開文字", "input[type=checkbox]");
      box!.checked = true;
      box!.dispatchEvent(new Event("change"));
      const sh = (p.blocks[0].content as { shape: { excludesText?: boolean; textWrapMode?: string } }).shape;
      const mode = control<HTMLSelectElement>("排開方式", "select");
      mode!.value = "around";
      mode!.dispatchEvent(new Event("change"));
      check("檢視器：排開文字開關＋模式寫得進模型",
            sh.excludesText === true && sh.textWrapMode === "around" && mode!.querySelectorAll("option").length === 3,
            `excludesText=${sh.excludesText} mode=${sh.textWrapMode}`);
    }

    // (c) 陰影與底色
    {
      const p = project([]);
      p.blocks.push({
        id: "t", frame: { x: 100, y: 100, w: 300, h: 60 }, rotation: 0, zIndex: 1, locked: false, opacity: 1,
        content: { type: "text", text: { text: "字", alignment: "leading", fontSize: 40, colorHex: "000000" } },
      });
      inspector.show(p, p.blocks[0]);
      const sel = control<HTMLSelectElement>("陰影", "select");
      sel!.value = "soft";
      sel!.dispatchEvent(new Event("change"));
      const t = (p.blocks[0].content as { text: TextBlock }).text;
      const bg = control<HTMLInputElement>("底色", "input[type=checkbox]");
      bg!.checked = true;
      bg!.dispatchEvent(new Event("change"));
      check("檢視器：陰影與文字底色寫得進模型",
            t.shadowStyle === "soft" && typeof t.backgroundColorHex === "string",
            `shadowStyle=${t.shadowStyle} backgroundColorHex=${t.backgroundColorHex}`);
    }

    // (d) 沒選元件時給專案級設定（紙張／頁面背景），不是只有一句提示
    {
      const p = project([]);
      inspector.show(p, null);
      const paper = control<HTMLSelectElement>("紙張", "select");
      paper!.value = "c4";
      paper!.dispatchEvent(new Event("change"));
      const page1 = control<HTMLInputElement>("第 1 頁", "input[type=color]");
      page1!.value = "#112233";
      page1!.dispatchEvent(new Event("input"));
      check("檢視器：沒選元件時給紙張與逐頁背景",
            p.paperKey === "c4" && p.pageBackgroundHex?.["0"] === "112233",
            `paperKey=${p.paperKey} 第1頁=${p.pageBackgroundHex?.["0"]}`);
    }

    // (e) 多選文字批次調整（2026-08-14）：字級混合顯示留空、設定＝套到全部；
    //     顏色與對齊也一起改，形狀成員不受影響
    {
      const p = project([block("s", { x: 700, y: 700, w: 100, h: 100 })]);
      const mkText = (id: string, size: number, color: string): Block => ({
        id, frame: { x: 100, y: 100, w: 300, h: 60 }, rotation: 0, zIndex: 2, locked: false, opacity: 1,
        content: { type: "text", text: { text: id, alignment: "leading", fontSize: size,
                                         colorHex: color, inkColor: "rgb(0,0,0)" } },
      });
      p.blocks.push(mkText("t1", 30, "000000"), mkText("t2", 60, "FF0000"));
      inspector.showGroup(p, p.blocks);
      const t1 = (p.blocks[1].content as { text: TextBlock }).text;
      const t2 = (p.blocks[2].content as { text: TextBlock }).text;

      const size = control<HTMLInputElement>("字級", "input[type=number]");
      const mixedShown = size!.value === "" && size!.placeholder === "—";
      size!.value = "44";
      size!.dispatchEvent(new Event("change"));
      check("多選文字：字級混合＝欄位留空，打 44 套到兩個",
            mixedShown && t1.fontSize === 44 && t2.fontSize === 44,
            `混合顯示=${mixedShown} t1=${t1.fontSize} t2=${t2.fontSize}`);

      const col = control<HTMLInputElement>("顏色", "input[type=color]");
      col!.value = "#3355aa";
      col!.dispatchEvent(new Event("input"));
      check("多選文字：顏色套到全部並清掉 run 色（inkColor）",
            t1.colorHex === "3355AA" && t2.colorHex === "3355AA"
            && t1.inkColor === undefined && t2.inkColor === undefined,
            `t1=${t1.colorHex}/${t1.inkColor} t2=${t2.colorHex}/${t2.inkColor}`);

      // 對齊按鈕列：找「文字區段」裡的「中」——群組水平對齊也有一顆「中」，
      // 用 label=對齊 那一列來鎖定範圍（按鈕已 icon 化，認 title 不認字面）
      const alignRow = [...host.querySelectorAll(".row")]
        .find((r) => r.querySelector("label")?.textContent === "對齊");
      const centerBtn = [...(alignRow?.querySelectorAll("button") ?? [])]
        .find((b) => b.title === "中");
      centerBtn!.click();
      const shape = p.blocks[0];
      check("多選文字：對齊套到全部、形狀成員不受影響",
            t1.alignment === "center" && t2.alignment === "center"
            && shape.content.type === "shape" && near(shape.frame.x, 700),
            `t1=${t1.alignment} t2=${t2.alignment}`);

      const weight = control<HTMLSelectElement>("字重", "select");
      const font = control<HTMLSelectElement>("字型", "select");
      check("多選文字：字重一致直接顯示、字型欄位存在",
            weight!.value === "3" && !!font,
            `字重=${weight!.value}`);

      // 多選面板也要有「對齊頁面」六顆（左中右＋上中下），
      // 且全部 icon 化：有 SVG 圖示、title 講人話（不是文字按鈕也不是 emoji）
      const pageRow = [...host.querySelectorAll(".row")]
        .find((r) => r.querySelector("label")?.textContent === "對齊頁面");
      const pageBtns = [...(pageRow?.querySelectorAll("button") ?? [])];
      check("多選面板「對齊頁面」六顆、全 icon 化（SVG＋title）",
            pageBtns.length === 6 && pageBtns.every((b) => !!b.querySelector("svg") && !!b.title),
            `${pageBtns.length} 顆`);
    }

    // (f) 對齊頁面：單選對到**自己那一頁**、多選整組平移（相對不變）、鎖定不動
    {
      const solo = block("s", { x: 1080 + 200, y: 200, w: 200, h: 100 });   // 第 2 頁
      alignToPage([solo], "hCenter", 1080, 1350);
      alignToPage([solo], "bottom", 1080, 1350);
      const soloOK = near(solo.frame.x, 1080 + 440) && near(solo.frame.y, 1250);

      const ga = block("a", { x: 100, y: 100, w: 200, h: 100 });
      const gb = block("b", { x: 400, y: 300, w: 100, h: 100 });
      alignToPage([ga, gb], "hCenter", 1080, 1350);   // 外框寬 400 → box.x 340、dx=240
      const groupOK = near(ga.frame.x, 340) && near(gb.frame.x, 640) && near(ga.frame.y, 100);

      const lk = block("lk", { x: 50, y: 50, w: 10, h: 10 }); lk.locked = true;
      const mv = block("mv", { x: 0, y: 0, w: 100, h: 100 });
      alignToPage([lk, mv], "right", 1080, 1350);
      const lockOK = near(lk.frame.x, 50) && near(mv.frame.x, 980);
      check("對齊頁面：單選對自己那頁、整組平移相對不變、鎖定不動也不算外框",
            soloOK && groupOK && lockOK,
            `solo=(${solo.frame.x},${solo.frame.y}) a.x=${ga.frame.x} b.x=${gb.frame.x} lk=${lk.frame.x} mv=${mv.frame.x}`);
    }
    host.remove();
  }

  // ── 17. 頁面操作（2026-08-04）──────────────────────────────────────────
  //    頁不是容器、是共享座標的一段，所有操作都是「平移 x ＋ 背景重新編號」。
  //    貫穿規則：**block 屬於它中心所在的那一頁**（跨頁 bleed 的也只算一頁）。
  {
    const pages = (): Project => {
      const p = project([block("p0", { x: 100, y: 100, w: 200, h: 200 }),      // 第 1 頁
                         block("p1", { x: 1180, y: 100, w: 200, h: 200 })]);   // 第 2 頁
      p.pageBackgroundHex = { "0": "111111", "1": "222222" };
      return p;
    };

    // (a) 新增頁：繼承前一頁背景（一整串同色頁不必逐頁重挑）
    {
      const p = pages();
      addPage(p);
      check("頁面：新增一頁並繼承前一頁背景",
            p.pageCount === 3 && p.pageBackgroundHex?.["2"] === "222222",
            `頁數=${p.pageCount} 第3頁背景=${p.pageBackgroundHex?.["2"]}`);
    }

    // (b) 刪頁：該頁的 block 一起刪、後面的往前挪、背景重新編號
    {
      const p = pages();
      deletePage(p, 0);
      const left = p.blocks[0];
      check("頁面：刪第 1 頁＝內容刪掉、後面往前挪一格",
            p.pageCount === 1 && p.blocks.length === 1 && left.id === "p1" && near(left.frame.x, 100)
            && p.pageBackgroundHex?.["0"] === "222222" && p.pageBackgroundHex?.["1"] === undefined,
            `剩 ${p.blocks.length} 個 block（${left?.id} x=${left?.frame.x}）背景=${JSON.stringify(p.pageBackgroundHex)}`);
    }

    // (c) 最後一頁刪不掉
    {
      const p = project([block("a", { x: 100, y: 100, w: 100, h: 100 })]);
      p.pageCount = 1;
      check("頁面：最後一頁刪不掉", deletePage(p, 0) === false && p.pageCount === 1, `頁數=${p.pageCount}`);
    }

    // (d) 換頁：block 與背景一起換（背景綁在頁槽上，不跟著 block 走）
    {
      const p = pages();
      swapAdjacentPages(p, 0, 1);
      const a = p.blocks.find((b) => b.id === "p0")!, b = p.blocks.find((k) => k.id === "p1")!;
      check("頁面：相鄰換位，背景跟著換槽",
            near(a.frame.x, 1180) && near(b.frame.x, 100)
            && p.pageBackgroundHex?.["0"] === "222222" && p.pageBackgroundHex?.["1"] === "111111",
            `p0.x=${a.frame.x} p1.x=${b.frame.x} 背景=${JSON.stringify(p.pageBackgroundHex)}`);
    }

    // (e) 複製頁：內容整份複製到右邊、後面的頁往後推、新的 id
    {
      const p = pages();
      let n = 0;
      duplicatePage(p, 0, () => `copy-${n++}`);
      const copy = p.blocks.find((b) => b.id === "copy-0")!;
      const pushed = p.blocks.find((b) => b.id === "p1")!;
      check("頁面：複製一頁（內容在右邊、後面往後推、背景跟著複製）",
            p.pageCount === 3 && copy && near(copy.frame.x, 1180) && near(pushed.frame.x, 2260)
            && p.pageBackgroundHex?.["1"] === "111111" && p.pageBackgroundHex?.["2"] === "222222",
            `頁數=${p.pageCount} 複製品 x=${copy?.frame.x} 被推的 x=${pushed?.frame.x} 背景=${JSON.stringify(p.pageBackgroundHex)}`);
    }
  }

  // ── 18. 多選與群組（2026-08-04）────────────────────────────────────────
  {
    // (a) 對齊的基準是**選取集合自己的外框**，不是頁面
    {
      const bs = [block("a", { x: 100, y: 100, w: 200, h: 100 }),
                  block("b", { x: 400, y: 300, w: 100, h: 100 }),
                  block("c", { x: 250, y: 500, w: 300, h: 100 })];
      alignGroup(bs, "left");
      check("群組：靠左對齊到集合外框的左緣",
            bs.every((b) => near(b.frame.x, 100)), bs.map((b) => b.frame.x).join("/"));
      alignGroup(bs, "vCenter");
      const mid = bs.map((b) => b.frame.y + b.frame.h / 2);
      check("群組：垂直置中對齊到集合外框的中線",
            mid.every((m) => near(m, mid[0], 0.001)), mid.map((m) => m.toFixed(1)).join("/"));
    }

    // (b) 鎖定的不動
    {
      const bs = [block("a", { x: 100, y: 100, w: 100, h: 100 }),
                  block("b", { x: 500, y: 100, w: 100, h: 100 })];
      bs[1].locked = true;
      alignGroup(bs, "left");
      check("群組：鎖定的元件不被對齊移動",
            near(bs[0].frame.x, 100) && near(bs[1].frame.x, 500), `${bs[0].frame.x}/${bs[1].frame.x}`);
    }

    // (c) 等距分布：間隙相等、兩端不動、少於三個不動作
    {
      const bs = [block("a", { x: 0, y: 0, w: 100, h: 50 }),
                  block("b", { x: 150, y: 0, w: 50, h: 50 }),
                  block("c", { x: 600, y: 0, w: 100, h: 50 })];
      distributeGroup(bs, "horizontal");
      const gap1 = bs[1].frame.x - (bs[0].frame.x + bs[0].frame.w);
      const gap2 = bs[2].frame.x - (bs[1].frame.x + bs[1].frame.w);
      check("群組：等距分布（間隙相等、兩端不動）",
            near(gap1, gap2, 0.001) && near(bs[0].frame.x, 0) && near(bs[2].frame.x, 600),
            `間隙 ${gap1.toFixed(1)} / ${gap2.toFixed(1)}`);

      const two = [block("a", { x: 0, y: 0, w: 100, h: 50 }), block("b", { x: 400, y: 0, w: 100, h: 50 })];
      distributeGroup(two, "horizontal");
      check("群組：兩個不做分布（沒有東西可以分）", near(two[1].frame.x, 400), `x=${two[1].frame.x}`);
    }

    // (d) 框選：空白處拖曳選出範圍內的元件
    {
      const p = project([block("a", { x: 100, y: 100, w: 100, h: 100 }),
                         block("b", { x: 300, y: 100, w: 100, h: 100 }),
                         block("far", { x: 900, y: 900, w: 100, h: 100 })]);
      editor.load(p);
      editor.snapStrength = "none";
      pointer("pointerdown", 50, 50);      // 空白處起手
      pointer("pointermove", 450, 260);    // 框住 a 與 b
      pointer("pointerup", 450, 260);
      const ids = editor.selectionBlocks().map((b) => b.id).sort().join(",");
      check("多選：空白處拖曳＝框選", ids === "a,b", `選到 ${ids || "無"}`);
    }

    // (e) 整組拖曳：相對位置一格都不能變
    {
      const p = project([block("a", { x: 100, y: 100, w: 100, h: 100 }),
                         block("b", { x: 300, y: 160, w: 100, h: 100 })]);
      editor.load(p);
      editor.snapStrength = "none";
      editor.selectMany(["a", "b"]);
      const before = { dx: 300 - 100, dy: 160 - 100 };
      pointer("pointerdown", 150, 150);    // 抓在 a 上
      pointer("pointermove", 350, 450);    // 位移 (200, 300)
      const a = p.blocks.find((k) => k.id === "a")!.frame, b = p.blocks.find((k) => k.id === "b")!.frame;
      pointer("pointerup", 350, 450);
      check("多選：整組拖曳（位移一致、相對位置不變）",
            near(a.x, 300) && near(a.y, 400) && near(b.x - a.x, before.dx) && near(b.y - a.y, before.dy),
            `a=(${a.x},${a.y}) b=(${b.x},${b.y})`);
    }

    // (f) ⇧ 點＝加選
    {
      const p = project([block("a", { x: 100, y: 100, w: 100, h: 100 }),
                         block("b", { x: 400, y: 100, w: 100, h: 100 })]);
      editor.load(p);
      const tapAt = (x: number, y: number, shift: boolean) => {
        const r = canvas.getBoundingClientRect();
        const v = (editor as unknown as { view: { scale: number; tx: number; ty: number } }).view;
        const ev = (type: string) => canvas.dispatchEvent(new PointerEvent(type, {
          pointerId: 1, isPrimary: true, bubbles: true, cancelable: true, shiftKey: shift,
          clientX: r.left + v.tx + x * v.scale, clientY: r.top + v.ty + y * v.scale,
        }));
        ev("pointerdown"); ev("pointerup");
      };
      tapAt(150, 150, false);
      tapAt(450, 150, true);
      check("多選：⇧ 點加選", editor.selectionBlocks().length === 2,
            `選了 ${editor.selectionBlocks().length} 個`);
      tapAt(450, 150, true);   // 再點一次＝減選
      check("多選：⇧ 再點一次＝減選", editor.selectionBlocks().length === 1,
            `選了 ${editor.selectionBlocks().length} 個`);
    }

    // (g) 群組等比縮放（2026-08-06）：右下角手把，左上角釘死、整組同一倍率
    {
      const p = project([block("a", { x: 100, y: 100, w: 200, h: 100 }),
                         block("b", { x: 400, y: 300, w: 100, h: 100 })]);
      // 外框＝(100,100)–(500,400)，寬 400 高 300
      editor.load(p);
      editor.snapStrength = "none";
      editor.selectMany(["a", "b"]);
      pointer("pointerdown", 500, 400);    // 抓右下角手把
      pointer("pointermove", 900, 700);    // 對角線上正好兩倍
      const a = p.blocks.find((k) => k.id === "a")!.frame;
      const b = p.blocks.find((k) => k.id === "b")!.frame;
      pointer("pointerup", 900, 700);
      check("群組縮放：左上角不動、整組同一倍率（尺寸與相對位置都乘 2）",
            near(a.x, 100) && near(a.y, 100) && near(a.w, 400) && near(a.h, 200)
            && near(b.x, 700) && near(b.y, 500) && near(b.w, 200) && near(b.h, 200),
            `a=(${a.x},${a.y},${a.w}×${a.h}) b=(${b.x},${b.y},${b.w}×${b.h})`);
    }

    // (h) 群組縮放：字級要跟著長大——只縮框不縮字是最容易漏的那半
    {
      const p = project([block("box", { x: 100, y: 100, w: 200, h: 200 })]);
      p.blocks.push({
        id: "t", frame: { x: 100, y: 400, w: 200, h: 100 }, rotation: 0, zIndex: 2,
        locked: false, opacity: 1,
        content: { type: "text", text: { text: "字", alignment: "leading", fontSize: 50,
                                         manualWidth: 200, kerning: 4, colorHex: "000000" } },
      });
      editor.load(p);   // ⚠️ load 會 autoFitText，文字框高度不是上面寫的那個——手把要照實際外框抓
      editor.snapStrength = "none";
      editor.selectMany(["box", "t"]);
      const box = groupBoxOf(p.blocks);
      const t = p.blocks.find((k) => k.id === "t")!;
      const h0 = t.frame.h;
      pointer("pointerdown", box.x + box.w, box.y + box.h);
      pointer("pointermove", box.x + box.w * 2, box.y + box.h * 2);   // 對角線上正好兩倍
      const txt = t.content.type === "text" ? t.content.text : null;
      pointer("pointerup", box.x + box.w * 2, box.y + box.h * 2);
      check("群組縮放：文字的字級／手動寬／點制字距一起乘倍率",
            !!txt && near(txt.fontSize ?? 0, 100) && near(txt.manualWidth ?? 0, 400)
            && near(txt.kerning ?? 0, 8) && near(t.frame.h, h0 * 2, 0.5),
            `fontSize=${txt?.fontSize} manualWidth=${txt?.manualWidth} kerning=${txt?.kerning} h=${t.frame.h.toFixed(1)}（起手 ${h0.toFixed(1)}）`);
    }

    // (i) 群組縮放：鎖住的成員原地不動（與群組對齊同一條紀律）
    {
      const p = project([block("a", { x: 100, y: 100, w: 200, h: 200 }),
                         block("lock", { x: 400, y: 400, w: 100, h: 100 })]);
      p.blocks[1].locked = true;
      editor.load(p);
      editor.snapStrength = "none";
      editor.selectMany(["a", "lock"]);
      pointer("pointerdown", 500, 500);
      pointer("pointermove", 900, 900);
      const a = p.blocks.find((k) => k.id === "a")!.frame;
      const lk = p.blocks.find((k) => k.id === "lock")!.frame;
      pointer("pointerup", 900, 900);
      check("群組縮放：鎖住的成員不動，其餘照縮",
            near(lk.x, 400) && near(lk.y, 400) && near(lk.w, 100) && near(a.w, 400),
            `鎖住的=(${lk.x},${lk.y},${lk.w}) a 寬=${a.w}`);
    }

    // (j) 群組縮放：外框用**旋轉後**的外接框——轉過的成員在框外就對不準
    {
      const p = project([block("a", { x: 100, y: 100, w: 200, h: 200 }),
                         block("r", { x: 300, y: 300, w: 200, h: 100 }, 90)]);
      // r 轉 90° 後外接框＝(350,250,100,200)，所以群組外框右下角是 (450,450) 不是 (500,400)
      editor.load(p);
      editor.snapStrength = "none";
      editor.selectMany(["a", "r"]);
      pointer("pointerdown", 500, 400);    // 用「未旋轉聯集」的角去抓——應該抓不到
      pointer("pointermove", 800, 700);
      const missed = p.blocks.find((k) => k.id === "a")!.frame.w;
      pointer("pointerup", 800, 700);
      editor.selectMany(["a", "r"]);       // 剛剛那下抓到空白＝變成框選，選取被清掉了
      pointer("pointerdown", 450, 450);    // 用「旋轉後聯集」的角＝真正的手把
      pointer("pointermove", 800, 800);
      const a = p.blocks.find((k) => k.id === "a")!.frame;
      pointer("pointerup", 800, 800);
      check("群組縮放：手把長在旋轉後外接框的角上（轉過的成員也含進去）",
            near(missed, 200) && a.w > 200, `誤抓後寬=${missed} 真抓後寬=${a.w.toFixed(1)}`);
    }
  }

  // ── 18b. 文字手把（2026-08-14）：字級／欄寬／長文框框高 ─────────────────
  {
    const v = (editor as unknown as { view: { scale: number } }).view;
    const tap = (x: number, y: number) => { pointer("pointerdown", x, y); pointer("pointerup", x, y); };
    const textOf = (b: Block): TextBlock | null => b.content.type === "text" ? b.content.text : null;

    // (a) 右下角＝字級縮放：沿對角線拉到兩倍，字級 50→100、框照貼字盒重排
    {
      const p = project([{
        id: "t", frame: { x: 100, y: 100, w: 300, h: 60 }, rotation: 0, zIndex: 1,
        locked: false, opacity: 1,
        content: { type: "text", text: { text: "字級縮放測試", alignment: "leading", fontSize: 50, colorHex: "000000" } },
      }]);
      editor.load(p);   // load 會 autoFitText——手把位置要照重排後的框抓
      editor.snapStrength = "none";
      const b = p.blocks[0];
      tap(b.frame.x + 10, b.frame.y + b.frame.h / 2);
      const f = { ...b.frame };
      const off = 7 / v.scale;
      pointer("pointerdown", f.x + f.w + off, f.y + f.h + off);
      pointer("pointermove", f.x + f.w * 2 + off, f.y + f.h * 2 + off);   // 對角線上正好兩倍
      const t = textOf(b);
      pointer("pointerup", f.x + f.w * 2 + off, f.y + f.h * 2 + off);
      check("文字手把：右下角沿對角線拉兩倍＝字級 50→100、框跟著長",
            !!t && near(t.fontSize ?? 0, 100, 0.5) && b.frame.w > f.w * 1.8,
            `fontSize=${t?.fontSize?.toFixed(1)} 框寬 ${f.w.toFixed(0)}→${b.frame.w.toFixed(0)}`);
    }

    // (b) 右緣＝欄寬：往左收字往下摺；往右拉停在「單行自然寬」（貼住最後一個字）
    {
      const p = project([{
        id: "t", frame: { x: 100, y: 100, w: 400, h: 60 }, rotation: 0, zIndex: 1,
        locked: false, opacity: 1,
        content: { type: "text", text: { text: "換行寬度測試換行寬度測試換行寬度測試",
                                         alignment: "leading", fontSize: 40, manualWidth: 400, colorHex: "000000" } },
      }]);
      editor.load(p);
      editor.snapStrength = "none";
      const b = p.blocks[0];
      tap(b.frame.x + 10, b.frame.y + 5);
      const f = { ...b.frame };
      const off = 7 / v.scale;
      pointer("pointerdown", f.x + f.w + off, f.y + f.h / 2);
      pointer("pointermove", f.x + f.w - 200 + off, f.y + f.h / 2);   // 往左收 200
      const t = textOf(b)!;
      pointer("pointerup", f.x + f.w - 200 + off, f.y + f.h / 2);
      check("文字手把：右緣往左收 200＝欄寬 400→200、多摺幾行框變高",
            near(t.manualWidth ?? 0, 200, 1) && near(b.frame.w, 200, 1) && b.frame.h > f.h * 1.5,
            `manualWidth=${t.manualWidth} 框=${b.frame.w.toFixed(0)}×${b.frame.h.toFixed(0)}（起手 ${f.w.toFixed(0)}×${f.h.toFixed(0)}）`);

      const f2 = { ...b.frame };
      pointer("pointerdown", f2.x + f2.w + off, f2.y + f2.h / 2);
      pointer("pointermove", f2.x + f2.w + 2000 + off, f2.y + f2.h / 2);   // 拉爆
      pointer("pointerup", f2.x + f2.w + 2000 + off, f2.y + f2.h / 2);
      // 18 個字 × 40px ≈ 720＝單行自然寬；再拉只會多空白，手把要停在那
      check("文字手把：欄寬上限＝單行自然寬（拉爆不會出現右側空白帶）",
            (t.manualWidth ?? 0) < 900 && near(b.frame.w, t.manualWidth ?? 0, 1),
            `manualWidth=${t.manualWidth}（拉了 +2000）`);
    }

    // (c) 長文框＝固定容器：下緣手把改框高，可以比內容矮，但有不會縮沒的地板
    {
      const p = project([{
        id: "t", frame: { x: 100, y: 100, w: 300, h: 200 }, rotation: 0, zIndex: 1,
        locked: false, opacity: 1,
        content: { type: "text", text: { text: "長文框高度測試", alignment: "leading", fontSize: 40,
                                         isBodyFrame: true, manualWidth: 300, manualHeight: 200, colorHex: "000000" } },
      }]);
      editor.load(p);   // 長文框是固定容器，autoFitText 會跳過＝框保持 300×200
      editor.snapStrength = "none";
      const b = p.blocks[0];
      tap(150, 150);
      const off = 7 / v.scale;
      pointer("pointerdown", 250, 300 + off);
      pointer("pointermove", 250, 450 + off);   // 往下 150
      const t = textOf(b)!;
      pointer("pointerup", 250, 450 + off);
      const grew = near(t.manualHeight ?? 0, 350, 1) && near(b.frame.h, 350, 1);
      pointer("pointerdown", 250, b.frame.y + b.frame.h + off);
      pointer("pointermove", 250, 110);          // 往上拉到快沒有
      pointer("pointerup", 250, 110);
      const floor = Math.round(1080 * 0.06);     // 地板＝6% 頁寬
      check("長文框手把：下緣 +150＝框高 200→350；縮到底停在地板不縮沒",
            grew && near(t.manualHeight ?? 0, floor, 1) && near(b.frame.h, floor, 1),
            `拉大後=${grew ? "350 ✓" : "錯"}　縮到底=${t.manualHeight}（地板 ${floor}）`);
    }
  }

  // ── 18c. 匯出選項的渲染核心（2026-08-14，優化項目 #11）───────────────────
  //    scale＝真解析度重畫；transparent＝底色留透明；onlyBlockIds＝只畫指定層
  {
    const p = project([block("s", { x: 0, y: 0, w: 540, h: 1350 })]);   // 左半頁一塊 888888 矩形
    const px = (c: HTMLCanvasElement, x: number, y: number) =>
      [...c.getContext("2d")!.getImageData(x, y, 1, 1).data];

    const two = renderPageCanvas(p, 0, { scale: 2 });
    check("匯出倍率：2×＝畫布兩倍像素、內容跟著放大",
          two.width === 2160 && two.height === 2700
          && px(two, 500, 500)[0] === 136 && px(two, 1500, 500)[0] === 255,
          `${two.width}×${two.height} 左=${px(two, 500, 500)[0]} 右=${px(two, 1500, 500)[0]}`);

    const alpha = renderPageCanvas(p, 0, { transparent: true, onlyBlockIds: new Set<string>() });
    const a = px(alpha, 500, 500);
    check("透明匯出：跳過底色＋排除全部圖層＝整張全透明",
          alpha.width === 1080 && a[3] === 0, `alpha=${a[3]}`);

    const only = renderPageCanvas(p, 0, { transparent: true });
    check("透明匯出：保留的圖層照畫、底色留透明",
          px(only, 300, 300)[3] === 255 && px(only, 900, 300)[3] === 0,
          `塊上=${px(only, 300, 300)[3]} 空處=${px(only, 900, 300)[3]}`);
  }

  // ── 18d. 跨專案剪貼簿的純邏輯（2026-08-14）───────────────────────────────
  {
    const src = project([]);
    src.id = "proj-A";
    src.blocks.push(
      { id: "t", frame: { x: 100, y: 200, w: 300, h: 60 }, rotation: 0, zIndex: 1, locked: false, opacity: 1,
        content: { type: "text", text: { text: "字", alignment: "leading", fontSize: 40 } } },
      { id: "v", frame: { x: 1080 + 300, y: 400, w: 400, h: 300 }, rotation: 0, zIndex: 2, locked: true, opacity: 1,
        content: { type: "video", media: { assetFileName: "clip.mp4", cropRect: { x: 0, y: 0, w: 1, h: 1 } } } },
    );
    const clip = buildClipboard(src, src.blocks, "/tmp/A/assets");
    check("剪貼簿：素材記絕對路徑、影片連海報一起記",
          clip.assetSrc["clip.mp4"] === "/tmp/A/assets/clip.mp4"
          && clip.assetSrc["clip.mp4.poster.jpg"] === "/tmp/A/assets/clip.mp4.poster.jpg"
          && clip.canvasWidth === 1080 && clip.projectId === "proj-A",
          JSON.stringify(clip.assetSrc));

    // 貼到另一份專案的第 1 頁：跨頁選取整組平移、素材換新名、鎖定解開、zIndex 疊上去
    const dst = project([block("old", { x: 0, y: 0, w: 100, h: 100 })]);
    dst.id = "proj-B";
    dst.blocks[0].zIndex = 7;
    let n = 0;
    const out = pasteBlocks(clip, dst, 0, new Map([["clip.mp4", "mac-9.mp4"]]), () => `new-${++n}`);
    const vv = out[1];
    check("剪貼簿：貼到別的專案＝落在正看的那頁、頁距照舊、素材換名、鎖定解開",
          near(out[0].frame.x, 100) && near(vv.frame.x, 1080 + 300)   // basePage=0 → dx=0
          && vv.content.type === "video" && vv.content.media.assetFileName === "mac-9.mp4"
          && !vv.locked && out[0].zIndex === 8 && vv.zIndex === 9 && out[0].id === "new-1",
          `x=${out[0].frame.x},${vv.frame.x} asset=${vv.content.type === "video" ? vv.content.media.assetFileName : "?"}`);

    // 貼回同一份專案的同一頁＝偏移 48；搬失敗（不在 renamed 表）＝舊名留著畫佔位框
    const back = pasteBlocks(clip, src, 0, new Map(), () => `b-${++n}`);
    check("剪貼簿：貼回同專案同頁＝偏移 48、搬失敗的素材留舊名",
          near(back[0].frame.x, 148) && near(back[0].frame.y, 248)
          && back[1].content.type === "video" && back[1].content.media.assetFileName === "clip.mp4",
          `x=${back[0].frame.x} y=${back[0].frame.y}`);

    // 貼到第 2 頁（viewPage=1）＝整組往右一頁
    const p2 = pasteBlocks(clip, dst, 1, new Map(), () => `c-${++n}`);
    check("剪貼簿：貼到正在看的第 2 頁＝整組平移一頁",
          near(p2[0].frame.x, 1080 + 100) && near(p2[1].frame.x, 2160 + 300),
          `x=${p2[0].frame.x},${p2[1].frame.x}`);
  }

  // ── 18e. 絕對對齊（2026-08-14）：框＝墨跡、貼字寬一鍵、吸附咬印刷線 ────────
  //    驗收標準用「像素真相」：透明渲染後掃 alpha 得到墨跡外接框，
  //    量使用者看到的那層，不量自己的計數器。
  {
    /** 透明渲染後的墨跡外接框（含 x1/y1 那一列/欄）。 */
    const inkOf = (p: Project): { x0: number; y0: number; x1: number; y1: number } => {
      const c = renderPageCanvas(p, 0, { transparent: true });
      const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
      let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
      for (let y = 0; y < c.height; y++) {
        for (let x = 0; x < c.width; x++) {
          if (d[(y * c.width + x) * 4 + 3] > 16) {
            if (x < x0) x0 = x; if (x > x1) x1 = x;
            if (y < y0) y0 = y; if (y > y1) y1 = y;
          }
        }
      }
      return { x0, y0, x1, y1 };
    };
    const textBlk = (id: string, over: Partial<TextBlock>, frame: Rect): Block => ({
      id, frame, rotation: 0, zIndex: 1, locked: false, opacity: 1,
      content: { type: "text", text: { text: "字", alignment: "leading", fontSize: 100, colorHex: "000000", ...over } },
    });
    const ectx = (editor as unknown as { ctx: CanvasRenderingContext2D }).ctx;
    const tOf = (b: Block): TextBlock => (b.content as { text: TextBlock }).text;

    // (a) 單行框高不虛胖：框的四邊＝墨跡的四邊（不再有 1.3em 保底的肚子）
    {
      const p = project([textBlk("t", { text: "ALIGN", fontSize: 120 }, { x: 100, y: 300, w: 900, h: 400 })]);
      editor.load(p);
      const f = p.blocks[0].frame;
      const ink = inkOf(p);
      // 垂直要嚴（這次修的就是它）；水平的框寬語意＝advance width（iOS 同款），
      // 與墨跡差的是字型 side bearing，給寬一點的容差
      check("絕對對齊：單行框底＝墨跡底（去 1.3em 虛胖）",
            Math.abs(ink.y1 + 1 - (f.y + f.h)) <= 2 && Math.abs(ink.y0 - f.y) <= 2
            && Math.abs(ink.x0 - f.x) <= 10 && Math.abs(ink.x1 + 1 - (f.x + f.w)) <= 10,
            `框 y ${f.y.toFixed(1)}–${(f.y + f.h).toFixed(1)}　墨跡 y ${ink.y0}–${ink.y1 + 1}`);
    }

    // (b) 貼字寬：殘留的 manualWidth（無軟換行）＝整個交還自動貼字盒，字一動不動
    {
      const p = project([textBlk("t", { text: "美濃 MEINONG", alignment: "center", manualWidth: 900 },
                                 { x: 90, y: 300, w: 900, h: 200 })]);
      editor.load(p);
      const b = p.blocks[0], t = tOf(b);
      const before = inkOf(p);
      const cxBefore = b.frame.x + b.frame.w / 2;
      const changed = snugTextWidth(ectx, b, p.canvasWidth, p.pageHeight);
      const after = inkOf(p);
      check("貼字寬：無軟換行＝清掉 manualWidth、框收到貼字身",
            changed && t.manualWidth === undefined && b.frame.w < 780
            && Math.abs(b.frame.x - after.x0) <= 8 && Math.abs(b.frame.x + b.frame.w - (after.x1 + 1)) <= 8,
            `manualWidth=${t.manualWidth} 框寬 900→${b.frame.w.toFixed(1)}`);
      check("貼字寬：字一動不動（定律：不破壞使用者文字）",
            Math.abs(before.x0 - after.x0) <= 1 && Math.abs(before.y0 - after.y0) <= 1
            && Math.abs(before.x1 - after.x1) <= 1 && Math.abs(before.y1 - after.y1) <= 1
            && Math.abs((b.frame.x + b.frame.w / 2) - cxBefore) <= 1,
            `墨跡 (${before.x0},${before.y0})→(${after.x0},${after.y0})　中心 ${cxBefore.toFixed(1)}→${(b.frame.x + b.frame.w / 2).toFixed(1)}`);
    }

    // (c) 貼字寬：有軟換行＝manualWidth 收到最寬行、斷行一個都不能變
    {
      const p = project([textBlk("t", { text: "Snug width keeps every soft break intact",
                                        fontSize: 60, manualWidth: 500 },
                                 { x: 100, y: 200, w: 500, h: 400 })]);
      editor.load(p);
      const b = p.blocks[0], t = tOf(b);
      const before = inkOf(p);
      const linesBefore = before.y1 - before.y0;   // 墨跡高＝斷行數的代理
      snugTextWidth(ectx, b, p.canvasWidth, p.pageHeight);
      const after = inkOf(p);
      check("貼字寬：有軟換行＝收緊 manualWidth 但斷行不變",
            t.manualWidth != null && t.manualWidth <= 500
            && Math.abs((after.y1 - after.y0) - linesBefore) <= 1
            && Math.abs(before.x0 - after.x0) <= 1 && Math.abs(before.y0 - after.y0) <= 1
            && near(b.frame.w, t.manualWidth ?? 0, 1),
            `manualWidth=500→${t.manualWidth} 墨跡高 ${linesBefore}→${after.y1 - after.y0}`);
    }

    // (d) 印刷線：大寫線與基線要對到像素真相
    {
      const p = project([textBlk("t", { text: "ALIGN", fontSize: 120 }, { x: 100, y: 300, w: 900, h: 400 })]);
      editor.load(p);
      const b = p.blocks[0];
      const ink = inkOf(p);
      const pl = textPrintLines(ectx, tOf(b), b.frame, p.canvasWidth, p.pageHeight)!;
      // 全大寫沒有降部：基線＝墨跡底；大寫線＝墨跡頂（與框頂重合就不給，允許 undefined）
      // 容差 3：WebKit 的 metrics vs 光柵化差 2.7px、Chrome 2 以內（引擎差，兩邊都要能跑）
      check("印刷線：全大寫的基線＝墨跡底",
            Math.abs(pl.base - (ink.y1 + 1)) <= 3, `base=${pl.base.toFixed(1)} 墨跡底=${ink.y1 + 1}`);

      const g = project([textBlk("g", { text: "Align gap", fontSize: 120 }, { x: 100, y: 300, w: 900, h: 400 })]);
      editor.load(g);
      const ig = inkOf(g);
      const plg = textPrintLines(ectx, tOf(g.blocks[0]), g.blocks[0].frame, g.canvasWidth, g.pageHeight)!;
      check("印刷線：有降部時基線在墨跡底之上（g/p 垂下去）",
            (ig.y1 + 1) - plg.base >= 8 && plg.cap != null && plg.cap > g.blocks[0].frame.y + 1,
            `base=${plg.base.toFixed(1)} 墨跡底=${ig.y1 + 1} cap=${plg.cap?.toFixed(1)}`);

      const cjk = project([textBlk("c", { text: "對齊" }, { x: 100, y: 300, w: 900, h: 400 })]);
      editor.load(cjk);
      const plc = textPrintLines(ectx, tOf(cjk.blocks[0]), cjk.blocks[0].frame, cjk.canvasWidth, cjk.pageHeight)!;
      check("印刷線：純中文不給大寫線（那是拉丁字的概念）", plc.cap == null, `cap=${plc.cap}`);
    }

    // (e) 拖曳咬基線：把一段文字拖到另一段附近，基線對基線咬合
    {
      // a 全用平底字母（G/O 這類圓弧會在基線下方多 1-2px 墨跡，
      // 框底與基線兩條線太近會搶咬——真實世界兩條都給是對的，測試要站遠一點）
      const p = project([
        textBlk("a", { text: "LINEAL", fontSize: 100 }, { x: 60, y: 200, w: 500, h: 130 }),
        textBlk("b", { text: "Design", fontSize: 77 }, { x: 600, y: 700, w: 400, h: 110 }),
      ]);
      editor.load(p);
      editor.snapStrength = "strong";
      const [a, b] = p.blocks;
      const baseA = textPrintLines(ectx, tOf(a), a.frame, p.canvasWidth, p.pageHeight)!.base;
      const relB = textPrintLines(ectx, tOf(b), b.frame, p.canvasWidth, p.pageHeight)!.base - b.frame.y;
      // 目標：b 的基線在 a 的基線上方 3px（閾值 8 內）——放開後要正好咬到 0
      const wantY = baseA - relB - 3;
      dragFrom(p, "b", { x: b.frame.x + b.frame.w / 2, y: wantY + b.frame.h / 2 });
      const baseB = textPrintLines(ectx, tOf(b), b.frame, p.canvasWidth, p.pageHeight)!.base;
      check("吸附：拖文字時基線咬基線（絕對對齊的手感）",
            Math.abs(baseB - baseA) <= 0.5,
            `baseA=${baseA.toFixed(1)} baseB=${baseB.toFixed(1)}（放手前差 3px）`);
    }

    // (f) 檢視器的「貼字寬」按鈕真的接到模型
    {
      const host = document.createElement("div");
      document.body.append(host);
      const insp = new Inspector(host, {
        onChange: () => {}, ensureVariant: async () => {},
        reorder: () => {}, remove: () => {}, fillMedia: () => {}, changeRatio: () => {},
        guides: { hidden: () => false, toggleHidden: () => {}, add: () => {}, remove: () => {},
                  locked: () => false, toggleLocked: () => {},
                presets: { filled: () => [], apply: () => {}, save: () => {}, clear: () => {} } },
        layers: { currentPage: () => 0, select: () => {}, reorder: () => {}, toggleLock: () => {},
                  thumb: () => undefined },
        group: { align: () => {}, distribute: () => {}, duplicate: () => {}, remove: () => {} },
      });
      const p = project([textBlk("t", { text: "MEINONG", manualWidth: 900 }, { x: 100, y: 100, w: 900, h: 160 })]);
      editor.load(p);
      insp.show(p, p.blocks[0]);
      const btn = [...host.querySelectorAll("button")].find((x) => x.textContent === "貼字寬");
      btn?.click();
      const t = tOf(p.blocks[0]);
      check("檢視器：貼字寬按鈕＝清掉殘留的 manualWidth、框收緊",
            !!btn && t.manualWidth === undefined && p.blocks[0].frame.w < 700,
            `按鈕${btn ? "在" : "不在"} manualWidth=${t.manualWidth} 框寬=${p.blocks[0].frame.w.toFixed(1)}`);
      host.remove();
    }
  }

  // ── 18f. 參考線產生器（2026-08-14，優化項目 #13）──────────────────────────
  //    鐵則：全部隨畫布比例現算、不寫死座標。生成到現有 guidesX/guidesY。
  {
    // (a) 隨比例生成：三分法在 4:5 與 1:1 畫布給的線不一樣
    {
      const a = generateGuides("thirds", defaultParams(1080, 1350), 1080, 1350);
      const b = generateGuides("thirds", defaultParams(1080, 1080), 1080, 1080);
      check("產生器：三分法隨畫布比例現算",
            a.y.join() === "450,900" && b.y.join() === "360,720" && a.x.join() === "360,720",
            `4:5 y=${a.y} 1:1 y=${b.y}`);
    }

    // (b) IG 安全區（主用）：3:4 預覽比 4:5 貼文「高」＝裁左右（直線）＋底部遮擋帶；
    //     1:1 畫布在 3:4 預覽下也是裁左右
    {
      const p45 = generateGuides("igsafe", defaultParams(1080, 1350), 1080, 1350);
      const cropW = 1350 * 3 / 4, leftF = (1080 - cropW) / 2;
      const left = Math.round(leftF), right = Math.round(leftF + cropW);
      const p11 = generateGuides("igsafe", defaultParams(1080, 1080), 1080, 1080);
      check("產生器：IG 安全區＝3:4 預覽的裁切框（裁左右）＋遮擋帶",
            p45.x.includes(left) && p45.x.includes(right)
            && p45.y.length === 1 && p45.y[0] === Math.round(1350 * 0.82)
            && p11.x.length === 2 && p11.y[0] === Math.round(1080 * 0.82),
            `4:5 x=${p45.x} y=${p45.y}　1:1 x=${p11.x}`);
    }

    // (c) 模組網格・接觸印樣（2 欄 16:9 格＋說明帶）：格高＝欄寬/(16/9)、整組置中
    {
      const d = { ...defaultParams(1080, 1350), cols: 2, rows: 3, cellRatio: 16 / 9,
                  captionH: 54 };
      const g = generateGuides("modular", d, 1080, 1350);
      const colW = (1080 - 2 * d.margin - d.gutter) / 2;
      const cellH = colW / (16 / 9);
      // 每列 3 條線（格頂/格底/帶底）；第一列格底 − 格頂 ＝ cellH
      const rowsDrawn = g.y.length / 3;
      const cellDrawn = g.y[1] - g.y[0];
      check("產生器：接觸印樣＝格高照 16:9 現算、每列含說明帶",
            rowsDrawn >= 2 && Math.abs(cellDrawn - cellH) <= 1.5
            && Math.abs((g.y[2] - g.y[1]) - d.captionH) <= 1.5,
            `列=${rowsDrawn} 格高=${cellDrawn}（應 ${cellH.toFixed(1)}）`);
    }

    // (d) 重生成＝只換上次那批：手動線與拖過的線都不收走
    {
      const gen1 = [100, 500, 900];
      let cur = [333, ...gen1];           // 333＝手動加的
      cur[2] = 520;                        // 使用者把 500 拖成 520＝值變了不收走
      const gen2 = [120, 480];
      cur = replaceBatch(cur, gen1, gen2);
      check("產生器：重生成只換上次那批（手動的、拖過的都留）",
            cur.includes(333) && cur.includes(520) && !cur.includes(100) && !cur.includes(900)
            && cur.includes(120) && cur.includes(480),
            `結果=${cur}`);
    }

    // (e) 檢視器端到端：參考線面板的「生成」按鈕真的寫進 project
    {
      const host = document.createElement("div");
      document.body.append(host);
      const insp = new Inspector(host, {
        onChange: () => {}, ensureVariant: async () => {},
        reorder: () => {}, remove: () => {}, fillMedia: () => {}, changeRatio: () => {},
        guides: { hidden: () => false, toggleHidden: () => {}, add: () => {}, remove: () => {},
                  locked: () => false, toggleLocked: () => {},
                presets: { filled: () => [], apply: () => {}, save: () => {}, clear: () => {} } },
        layers: { currentPage: () => 0, select: () => {}, reorder: () => {}, toggleLock: () => {},
                  thumb: () => undefined },
        group: { align: () => {}, distribute: () => {}, duplicate: () => {}, remove: () => {} },
      });
      const p = project([]);
      insp.show(p, null);
      insp.setPanel("guides");
      const gen = [...host.querySelectorAll("button")].find((x) => x.textContent === "生成");
      gen?.click();
      check("檢視器：參考線產生器寫得進 guidesX/guidesY",
            !!gen && ((p.guidesX?.length ?? 0) + (p.guidesY?.length ?? 0)) > 0,
            `按鈕${gen ? "在" : "不在"} x=${p.guidesX?.length ?? 0} y=${p.guidesY?.length ?? 0}`);
      host.remove();
    }
  }

  // ── 19. 畫布尺寸與新專案（2026-08-04）──────────────────────────────────
  {
    // (a) 短邊固定 1080、長邊照比例——翻轉的 9:16 是 1920×1080 不是 1080×608
    {
      const a = canvasSize("4:5"), b = canvasSize("9:16", true), c = canvasSize("1.91:1");
      check("畫布：短邊固定 1080、長邊照比例（含翻轉）",
            a.w === 1080 && a.h === 1350 && b.w === 1920 && b.h === 1080 && c.h === 1080 && c.w === 2063,
            `4:5=${a.w}×${a.h}　翻9:16=${b.w}×${b.h}　1.91:1=${c.w}×${c.h}`);
      check("畫布：比例字串化簡", simplifiedRatio(1080, 1350) === "4:5", simplifiedRatio(1080, 1350));
    }

    // (b) 改比例：頁內位置與尺寸都不動，只有絕對 x 跟著新頁寬走（＝還在同一頁）
    {
      const p = project([block("p0", { x: 100, y: 200, w: 300, h: 300 }),
                         block("p1", { x: 1080 + 150, y: 400, w: 200, h: 200 })]);
      changeCanvasRatio(p, 1920, 1080);
      const a = p.blocks[0].frame, b = p.blocks[1].frame;
      check("畫布：改比例後頁內位置不變、內容留在原來那一頁",
            near(a.x, 100) && near(a.w, 300) && near(b.x, 1920 + 150) && near(b.w, 200)
            && p.canvasWidth === 1920 && p.pageHeight === 1080,
            `第1頁 x=${a.x}　第2頁 x=${b.x}（應為 2070）`);
    }

    // (c) 新專案：空白、頁數夾限在 1…20
    {
      const p = newProject("測試", "1:1", false, 30, "id-1");
      check("畫布：新專案（空白、頁數夾限 20）",
            p.blocks.length === 0 && p.canvasWidth === 1080 && p.pageHeight === 1080 && p.pageCount === 20,
            `${p.canvasWidth}×${p.pageHeight} ${p.pageCount} 頁`);
      check("畫布：新專案的時間戳沒有毫秒（iOS 的 ISO8601 解不了）",
            !/\.\d+Z$/.test(p.createdAt), p.createdAt);
    }
  }

  // ── 20. 鎖定／拉直／裁切比例的開關（2026-08-04）─────────────────────────
  {
    const host = document.createElement("div");
    document.body.append(host);
    const inspector = new Inspector(host, {
      onChange: () => {}, ensureVariant: async () => {},
      reorder: () => {}, remove: () => {}, fillMedia: () => {}, changeRatio: () => {},
      guides: { hidden: () => false, toggleHidden: () => {}, add: () => {}, remove: () => {},
                locked: () => false, toggleLocked: () => {},
                presets: { filled: () => [], apply: () => {}, save: () => {}, clear: () => {} } },
      layers: { currentPage: () => 0, select: () => {}, reorder: () => {}, toggleLock: () => {},
                thumb: () => undefined },
      group: { align: () => {}, distribute: () => {}, duplicate: () => {}, remove: () => {} },
    });
    const control = <T extends HTMLElement>(label: string, tag: string): T | null => {
      for (const row of host.querySelectorAll(".row")) {
        if (row.querySelector("label")?.textContent === label) return row.querySelector<T>(tag);
      }
      return null;
    };
    const mediaProject = (): Project => {
      const p = project([]);
      p.blocks.push({
        id: "m", frame: { x: 100, y: 100, w: 400, h: 200 }, rotation: 0, zIndex: 1, locked: false, opacity: 1,
        content: { type: "image", media: { assetFileName: "x.jpg", cropRect: { x: 0, y: 0, w: 1, h: 1 } } },
      });
      return p;
    };

    // (a) 鎖定：引擎本來就吃 locked，缺的只是開關——鎖了就選不到也拖不動
    {
      const p = mediaProject();
      inspector.show(p, p.blocks[0]);
      const lock = control<HTMLInputElement>("鎖定", "input[type=checkbox]");
      lock!.checked = true;
      lock!.dispatchEvent(new Event("change"));
      check("檢視器：鎖定開關寫得進模型", p.blocks[0].locked === true, `locked=${p.blocks[0].locked}`);

      editor.load(p);
      editor.snapStrength = "none";
      const before = { ...p.blocks[0].frame };
      dragFrom(p, "m", { x: 800, y: 800 });
      check("鎖定：拖不動（引擎的 hit 直接略過）",
            near(p.blocks[0].frame.x, before.x) && near(p.blocks[0].frame.y, before.y),
            `${p.blocks[0].frame.x},${p.blocks[0].frame.y}`);
    }

    // (b) 拉直滑桿寫進 rotationDegrees（那是內容的角度，不是 block 的 rotation）
    {
      const p = mediaProject();
      inspector.show(p, p.blocks[0]);
      const st = control<HTMLInputElement>("拉直", "input[type=number]");
      st!.value = "12";
      st!.dispatchEvent(new Event("change"));
      const m = (p.blocks[0].content as { media: { rotationDegrees?: number } }).media;
      check("檢視器：拉直寫進 rotationDegrees（block.rotation 不動）",
            m.rotationDegrees === 12 && p.blocks[0].rotation === 0,
            `rotationDegrees=${m.rotationDegrees} block.rotation=${p.blocks[0].rotation}`);
    }

    // (c) 裁切比例：短邊不動、長邊收進去，且**以中心為錨**
    {
      const p = mediaProject();
      inspector.show(p, p.blocks[0]);
      const sel = control<HTMLSelectElement>("裁切比例", "select");
      sel!.value = "1:1";
      sel!.dispatchEvent(new Event("change"));
      const f = p.blocks[0].frame;
      check("檢視器：裁切比例（短邊不動、中心不動）",
            near(f.w, 200) && near(f.h, 200) && near(f.x + f.w / 2, 300) && near(f.y + f.h / 2, 200),
            `${f.w}×${f.h} @ 中心 ${f.x + f.w / 2},${f.y + f.h / 2}`);
    }
    host.remove();
  }

  // ── 21. 輕量範本：拔掉素材、保留版型（2026-08-04）───────────────────────
  {
    const p = project([]);
    p.paperKey = "c4";
    p.blocks.push({
      id: "v", frame: { x: 100, y: 100, w: 300, h: 300 }, rotation: 8, zIndex: 1, locked: false, opacity: 0.9,
      content: { type: "video", media: {
        assetFileName: "clip.mov", cropRect: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 },
        rotationDegrees: 6, maskShape: "ellipse", strokeHex: "FF0000", strokeWidth: 0.02,
        filterKey: "a1", excludesText: true, textWrapMode: "around",
      } },
    });
    p.blocks.push({
      id: "t", frame: { x: 100, y: 500, w: 300, h: 80 }, rotation: 0, zIndex: 2, locked: false, opacity: 1,
      content: { type: "text", text: { text: "標題", alignment: "leading", fontSize: 60, colorHex: "000000" } },
    });
    const tpl = stripToTemplate(p);
    const m = (tpl.blocks[0].content as { type: string; media: {
      assetFileName: string; cropRect: Rect; rotationDegrees?: number; maskShape?: string;
      strokeHex?: string; filterKey?: string; excludesText?: boolean; textWrapMode?: string } });
    const origMedia = (p.blocks[0].content as { media: { assetFileName: string } }).media;
    check("輕量範本：素材拔掉、外觀全留、影片轉成空欄位圖框",
          m.type === "image" && m.media.assetFileName === "" && m.media.rotationDegrees === undefined
          && m.media.cropRect.w === 1 && m.media.maskShape === "ellipse" && m.media.strokeHex === "FF0000"
          && m.media.filterKey === "a1" && m.media.excludesText === true && m.media.textWrapMode === "around"
          && tpl.blocks[0].rotation === 8 && tpl.paperKey === "c4" && tpl.blocks.length === 2,
          `type=${m.type} asset="${m.media.assetFileName}" 遮罩=${m.media.maskShape} 濾鏡=${m.media.filterKey}`);
    check("輕量範本：不動到原本那份專案", origMedia.assetFileName === "clip.mov", origMedia.assetFileName);
  }

  // ── 22. 影片頁匯出的圖層堆疊（2026-08-04）──────────────────────────────
  //    工具端（alignvideo）已單獨驗過；這裡驗的是**這一頁怎麼被拆成層**：
  //    順序、頁內座標、遮罩／外框有沒有烤出來、裁切有沒有原樣帶過去。
  {
    const p = project([]);
    p.paperKey = "c3";
    p.blocks.push(block("bg", { x: 0, y: 0, w: 1080, h: 1350 }));                    // z1 底
    p.blocks.push({
      id: "vid", frame: { x: 141, y: 200, w: 601, h: 401 }, rotation: 0, zIndex: 2,
      locked: false, opacity: 1,
      content: { type: "video", media: {
        assetFileName: "clip.mov", cropRect: { x: 0.1, y: 0.2, w: 0.6, h: 0.6 },
        maskShape: "ellipse", strokeHex: "FFFFFF", strokeWidth: 0.02, filterKey: "b2",
      } },
    });
    const top = block("caption", { x: 100, y: 1000, w: 400, h: 80 });
    top.zIndex = 3;
    p.blocks.push(top);
    // 第 2 頁放一個純圖框，確認 pageHasVideo 不會誤判
    p.blocks.push(block("other", { x: 1200, y: 100, w: 200, h: 200 }));

    check("影片匯出：認得出哪一頁有影片",
          pageHasVideo(p, 0) === true && pageHasVideo(p, 1) === false,
          `第1頁=${pageHasVideo(p, 0)} 第2頁=${pageHasVideo(p, 1)}`);

    const saved: string[] = [];
    const spec = await buildPageSpec(p, 0, "/tmp/x", "/tmp/out.mp4", { fps: 24, mute: true }, {
      savePng: async (path) => { saved.push(path.split("/").pop()!); },
      assetPath: (f) => `/assets/${f}`,
      renderOpts: {},
    });
    const kinds = spec!.layers.map((l) => l.type).join(">");
    const v = spec!.layers[1];
    check("影片匯出：層序＝底圖→影片→上層，且影片帶頁內座標與偶數尺寸",
          kinds === "still>video>still" && v.path === "/assets/clip.mov"
          && v.x === 141 && v.y === 200 && v.w === 600 && v.h === 400,
          `${kinds}　rect=${v.x},${v.y} ${v.w}×${v.h}（w 要收成偶數 600）`);
    check("影片匯出：遮罩與外框都烤成 PNG、裁切原樣帶過去",
          !!v.mask && !!v.stroke && v.crop?.w === 0.6 && v.filter === "b2"
          && spec!.fps === 24 && spec!.mute === true && spec!.paper === "c3"
          && saved.length === 4,
          `mask=${!!v.mask} stroke=${!!v.stroke} crop.w=${v.crop?.w} 寫了 ${saved.length} 張 PNG`);
  }

  // ── 23. 桌面操作語彙（2026-08-04）──────────────────────────────────────
  //    Mac 該有的效率動作。每一條都用真的指標／鍵盤事件驅動。
  {
    const mediaProj = (crop = { x: 0.2, y: 0.2, w: 0.5, h: 0.5 }): Project => {
      const p = project([]);
      p.blocks.push({
        id: "m", frame: { x: 200, y: 200, w: 400, h: 400 }, rotation: 0, zIndex: 1, locked: false, opacity: 1,
        content: { type: "image", media: { assetFileName: "x.jpg", cropRect: crop } },
      });
      return p;
    };
    const ev = (type: string, x: number, y: number, init: PointerEventInit = {}) => {
      const r = canvas.getBoundingClientRect();
      const v = (editor as unknown as { view: { scale: number; tx: number; ty: number } }).view;
      canvas.dispatchEvent(new PointerEvent(type, {
        pointerId: 1, isPrimary: true, bubbles: true, cancelable: true, ...init,
        clientX: r.left + v.tx + x * v.scale, clientY: r.top + v.ty + y * v.scale,
      }));
    };

    // (a) 雙擊裁切過的照片＝搬照片：框不動、cropRect 反向走
    {
      const p = mediaProj();
      editor.load(p); editor.snapStrength = "none";
      canvas.dispatchEvent(new MouseEvent("dblclick", (() => {
        const r = canvas.getBoundingClientRect();
        const v = (editor as unknown as { view: { scale: number; tx: number; ty: number } }).view;
        return { bubbles: true, clientX: r.left + v.tx + 400 * v.scale, clientY: r.top + v.ty + 400 * v.scale };
      })()));
      ev("pointerdown", 400, 400);
      ev("pointermove", 480, 400);        // 往右拖 80
      const m = (p.blocks[0].content as { media: { cropRect: Rect } }).media.cropRect;
      const f = { ...p.blocks[0].frame };
      ev("pointerup", 480, 400);
      // 位移換算：80 × (0.5 / 400) = 0.1，往右拖＝裁切區往左走
      check("搬照片：框不動、裁切區反向移動且夾在邊界內",
            near(f.x, 200) && near(f.w, 400) && near(m.x, 0.1, 0.001) && near(m.w, 0.5, 0.001),
            `frame.x=${f.x} crop.x=${m.x.toFixed(3)}（應為 0.100）`);
    }

    // (b) 按住 R 拉角＝旋轉（⇧ 卡 15°）
    {
      const p = mediaProj();
      editor.load(p); editor.snapStrength = "none"; editor.select("m");
      window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyR" }));
      // ⚠️ 落點要挑「原始角度不是 15 的倍數」的，否則卡不卡格都會過——這個案例
      //    第一版就踩到（從 45° 轉到 90°，差 45 本來就是 15 的倍數，測了等於沒測）。
      ev("pointerdown", 600, 600);                       // 右下角手把（相對中心 45°）
      ev("pointermove", 500, 650, { shiftKey: true });   // 原始差角約 23.2°
      const rot = p.blocks[0].rotation;
      ev("pointerup", 500, 650);
      window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyR" }));
      check("按住 R 拉角＝旋轉，⇧ 卡在 15° 的格上",
            rot !== 0 && Math.abs(rot % 15) < 0.001, `rotation=${rot}（原始差角約 23.2°）`);
    }

    // (c) ⇧ 拖曳＝鎖住一軸
    {
      const p = project([block("a", { x: 100, y: 100, w: 100, h: 100 })]);
      editor.load(p); editor.snapStrength = "none";
      ev("pointerdown", 150, 150);
      ev("pointermove", 400, 190, { shiftKey: true });   // x 走 250、y 只走 40
      const f = { ...p.blocks[0].frame };
      ev("pointerup", 400, 190);
      check("⇧ 拖曳鎖住位移大的那一軸", near(f.x, 350) && near(f.y, 100),
            `(${f.x.toFixed(1)}, ${f.y.toFixed(1)})　y 應維持 100`);
    }

    // (d) ⌥ 拖曳＝原地留一份、拖走複製品
    {
      const p = project([block("a", { x: 100, y: 100, w: 100, h: 100 })]);
      editor.load(p); editor.snapStrength = "none";
      editor.onDuplicateForDrag = () => {
        const copy = { ...structuredClone(p.blocks[0]), id: "copy", zIndex: 9 };
        p.blocks.push(copy);
        return [copy];
      };
      ev("pointerdown", 150, 150, { altKey: true });
      ev("pointermove", 450, 150);
      ev("pointerup", 450, 150);
      const orig = p.blocks.find((b) => b.id === "a")!.frame;
      const copy = p.blocks.find((b) => b.id === "copy")!.frame;
      editor.onDuplicateForDrag = undefined;
      check("⌥ 拖曳＝複製：原件留在原地、複製品被拖走",
            near(orig.x, 100) && near(copy.x, 400) && p.blocks.length === 2,
            `原件 x=${orig.x}　複製品 x=${copy.x}`);
    }

    // (e) 參考線：畫布上拖得動，拖出頁面外＝丟掉
    {
      const p = project([]);
      p.guidesX = [300];
      editor.load(p);
      ev("pointerdown", 300, 600);
      ev("pointermove", 420, 600);
      ev("pointerup", 420, 600);
      const moved = p.guidesX?.[0];
      ev("pointerdown", 420, 600);
      ev("pointermove", 420, -200);        // 拖到頁面上方外
      ev("pointerup", 420, -200);
      check("參考線：拖得動，拖出頁外就丟掉",
            moved === 420 && (p.guidesX?.length ?? 0) === 0,
            `拖到 ${moved}　剩 ${p.guidesX?.length ?? 0} 條`);
    }

    // (f) 線壓在元件上：拖的是線、不是元件（線只有 5px 寬，元件先命中就永遠抓不到）
    {
      const p = project([block("img", { x: 200, y: 400, w: 600, h: 600 })]);
      p.guidesX = [500];                    // 這條線正好穿過那張圖
      editor.load(p);
      editor.select("img");                 // 而且圖是選起來的（最容易誤抓的情況）
      ev("pointerdown", 500, 700);          // 點在線上、同時也在圖上
      ev("pointermove", 620, 700);
      ev("pointerup", 620, 700);
      const img = p.blocks[0].frame;
      check("線壓在元件上：拖到的是線，元件一動也不動",
            p.guidesX?.[0] === 620 && img.x === 200,
            `線 ${p.guidesX?.[0]}（應 620）　圖 x=${img.x}（應 200）`);
    }

    // (g) 但鎖住之後就換元件接手——鎖定是「線讓開」的那條退路
    {
      const p = project([block("img", { x: 200, y: 400, w: 600, h: 600 })]);
      p.guidesX = [500];
      p.guidesLocked = true;
      editor.load(p);
      ev("pointerdown", 500, 700);
      ev("pointermove", 620, 700);
      ev("pointerup", 620, 700);
      const img = p.blocks[0].frame;
      check("鎖住參考線之後，同一個位置拖到的是元件",
            p.guidesX?.[0] === 500 && near(img.x, 320),
            `線 ${p.guidesX?.[0]}（應 500）　圖 x=${img.x}（應 320）`);
    }

    // (h) 線自己也要吸附：拖到元件左緣附近就咬住（先對位、之後每頁複刻）
    {
      const p = project([block("img", { x: 300, y: 200, w: 400, h: 400 })]);
      p.guidesX = [80];
      editor.load(p);
      editor.snapStrength = "strong";
      ev("pointerdown", 80, 900);
      ev("pointermove", 305, 900);      // 差 5，在 8 的門檻內
      ev("pointerup", 305, 900);
      check("拖參考線會咬住元件的邊（不是停在放手的地方）",
            p.guidesX?.[0] === 300, `落在 ${p.guidesX?.[0]}（元件左緣 300）`);
    }

    // (i) 複刻上一頁：第 2 頁拖線，咬得到第 1 頁那張圖的頁內位置
    {
      const p = project([block("img", { x: 300, y: 200, w: 400, h: 400 })]);   // 第 1 頁，頁內 300
      p.pageCount = 2;
      p.guidesX = [80];
      editor.load(p);
      editor.snapStrength = "strong";
      const x2 = 1080 + 306;            // 在第 2 頁、對應頁內 306
      ev("pointerdown", 80, 900);
      ev("pointermove", x2, 900);
      ev("pointerup", x2, 900);
      check("在第 2 頁拖線，咬得到第 1 頁元件的頁內位置（版面複刻）",
            p.guidesX?.[0] === 300, `落在頁內 ${p.guidesX?.[0]}（第 1 頁那張圖的頁內左緣 300）`);
    }

    // (j) 吸附關掉就真的不咬
    {
      const p = project([block("img", { x: 300, y: 200, w: 400, h: 400 })]);
      p.guidesX = [80];
      editor.load(p);
      editor.snapStrength = "none";
      ev("pointerdown", 80, 900);
      ev("pointermove", 305, 900);
      ev("pointerup", 305, 900);
      check("吸附關掉時，參考線停在放手的地方",
            p.guidesX?.[0] === 305, `落在 ${p.guidesX?.[0]}（應 305）`);
      editor.snapStrength = "strong";
    }

    // (k) 按到參考線要吼一聲——殼層靠這個把側欄切到參考線面板
    {
      const p = project([]);
      p.guidesX = [300];
      editor.load(p);
      let picked: string | null = null;
      editor.onGuidePicked = (axis, i) => { picked = `${axis}${i}`; };
      ev("pointerdown", 300, 600);
      ev("pointerup", 300, 600);
      editor.onGuidePicked = undefined;
      check("按到參考線會通知殼層（側欄才切得過去）", picked === "x0", `收到 ${picked ?? "沒收到"}`);
    }

    // (i) 鎖定後畫布上碰不到——線還在、數值還能改，只是滑鼠拖不動它
    {
      const p = project([]);
      p.guidesX = [300];
      p.guidesLocked = true;
      editor.load(p);
      ev("pointerdown", 300, 600);
      ev("pointermove", 460, 600);
      ev("pointerup", 460, 600);
      check("參考線鎖定：畫布上拖不動，線也還在",
            p.guidesX?.[0] === 300 && p.guidesX?.length === 1,
            `位置 ${p.guidesX?.[0]}　剩 ${p.guidesX?.length} 條`);
    }

  }

  // 圖層列的縮圖：媒體畫真圖、形狀畫色塊、文字留字形圖示（比照 iPad 再多補形狀）
  {
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;left:0;top:0;width:252px;visibility:hidden";
    document.body.append(host);
    const swatch = document.createElement("canvas");
    swatch.width = swatch.height = 12;
    const p = project([
      { id: "img", frame: { x: 100, y: 100, w: 300, h: 300 }, rotation: 0, zIndex: 3,
        locked: false, opacity: 1,
        content: { type: "image", media: { assetFileName: "a.jpg", cropRect: { x: 0, y: 0, w: 1, h: 1 } } } },
      { id: "sh", frame: { x: 120, y: 120, w: 300, h: 300 }, rotation: 0, zIndex: 2,
        locked: false, opacity: 1,
        content: { type: "shape", shape: { kind: "ellipse", colorHex: "F5C518" } } },
      { id: "tx", frame: { x: 140, y: 140, w: 300, h: 120 }, rotation: 0, zIndex: 1,
        locked: false, opacity: 1, content: { type: "text", text: { text: "標題", alignment: "leading" } } },
    ]);
    p.pageCount = 1;
    const insp = new Inspector(host, {
      onChange: () => {}, ensureVariant: async () => {},
      reorder: () => {}, remove: () => {}, fillMedia: () => {}, changeRatio: () => {},
      guides: { hidden: () => false, toggleHidden: () => {}, add: () => {}, remove: () => {},
                locked: () => false, toggleLocked: () => {},
                presets: { filled: () => [], apply: () => {}, save: () => {}, clear: () => {} } },
      layers: { currentPage: () => 0, select: () => {}, reorder: () => {}, toggleLock: () => {},
                thumb: (b) => (b.id === "img" ? swatch : undefined) },
      group: { align: () => {}, distribute: () => {}, duplicate: () => {}, remove: () => {} },
    });
    insp.show(p, null);
    insp.setPanel("layers");
    const rows = [...host.querySelectorAll<HTMLElement>(".lay")];
    const kind = rows.map((r) => {
      const ic = r.querySelector(".ico")!;
      return ic.querySelector("canvas") ? "縮圖" : ic.querySelector(".swatch") ? "色塊" : "圖示";
    });
    check("圖層列：媒體畫真縮圖、形狀畫色塊、文字用字形圖示",
          kind.join(",") === "縮圖,色塊,圖示", kind.join(","));
    host.remove();
  }

  // 排開只咬得住長文框——這一頁沒有長文框就要講出來（不然開了沒反應，會以為沒做）
  {
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;left:0;top:0;width:252px;visibility:hidden";
    document.body.append(host);
    const img: Block = {
      id: "img", frame: { x: 100, y: 100, w: 300, h: 300 }, rotation: 0, zIndex: 2,
      locked: false, opacity: 1,
      content: { type: "image", media: { assetFileName: "a.jpg", cropRect: { x: 0, y: 0, w: 1, h: 1 }, excludesText: true } },
    };
    const body: Block = {
      id: "t", frame: { x: 100, y: 600, w: 800, h: 400 }, rotation: 0, zIndex: 1,
      locked: false, opacity: 1, content: { type: "text", text: { text: "內文", alignment: "leading", isBodyFrame: true } },
    };
    const hooks = {
      onChange: () => {}, ensureVariant: async () => {},
      reorder: () => {}, remove: () => {}, fillMedia: () => {}, changeRatio: () => {},
      guides: { hidden: () => false, toggleHidden: () => {}, add: () => {}, remove: () => {},
                locked: () => false, toggleLocked: () => {},
                presets: { filled: () => [], apply: () => {}, save: () => {}, clear: () => {} } },
      layers: { currentPage: () => 0, select: () => {}, reorder: () => {}, toggleLock: () => {},
                thumb: () => undefined },
      group: { align: () => {}, distribute: () => {}, duplicate: () => {}, remove: () => {} },
    };
    const warn = (blocks: Block[]): boolean => {
      const pp = project(blocks);
      pp.pageCount = 1;
      const insp = new Inspector(host, hooks);
      insp.show(pp, blocks[0]);
      return !!host.querySelector(".hint.warn");
    };
    const alone = warn([img]);
    const withBody = warn([img, body]);
    check("排開：這一頁沒有長文框就出聲，有了就閉嘴",
          alone && !withBody, `只有圖＝${alone ? "有提醒" : "沒提醒"}　配長文框＝${withBody ? "有提醒" : "沒提醒"}`);
    host.remove();
  }

  // 跨頁複製／搬移：頁內位置不動，只換所屬那一格
  {
    const p = project([block("a", { x: 200 + 1080, y: 300, w: 400, h: 400 })]);   // 第 2 頁
    p.pageCount = 4;
    let n = 0;
    const made = retargetToPage(p, [p.blocks[0]], 3, true, () => `new${++n}`);
    p.blocks.push(...made);
    const src = p.blocks.find((b) => b.id === "a")!;
    const copy = p.blocks.find((b) => b.id === "new1")!;
    const inPage = (b: typeof src) => b.frame.x - Math.floor((b.frame.x + b.frame.w / 2) / 1080) * 1080;
    check("跨頁複製：原件不動、複製品落在新頁的同一個位置",
          src.frame.x === 200 + 1080 && copy.frame.x === 200 + 3 * 1080 && inPage(copy) === inPage(src),
          `原件 x=${src.frame.x}（第2頁）　複製品 x=${copy.frame.x}（第4頁，頁內都是 ${inPage(copy)}）`);

    retargetToPage(p, [src], 0, false, () => "unused");
    check("跨頁搬移：不留原件，位置同樣是頁內不動",
          p.blocks.filter((b) => b.id === "a").length === 1 && src.frame.x === 200,
          `x=${src.frame.x}`);
  }

  // 頁面膠捲：長按／拖曳會浮起一張跟著游標的卡，放開回報新順序
  {
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;left:0;top:0;width:600px;visibility:hidden;display:flex";
    document.body.append(host);
    let moved: string | null = null;
    const strip = new PageStrip(host, {
      pick: () => {}, act: () => {}, add: () => {}, menu: () => {},
      move: (from, to) => { moved = `${from}→${to}`; },
    });
    const p = project([]);
    p.pageCount = 3;
    strip.render(p, {});
    const cvs = [...host.querySelectorAll<HTMLCanvasElement>("figure canvas")];
    const boxes = cvs.map((c) => c.getBoundingClientRect());
    const fire = (el: HTMLElement, type: string, x: number) => el.dispatchEvent(new PointerEvent(type, {
      pointerId: 5, isPrimary: true, bubbles: true, cancelable: true,
      clientX: x, clientY: boxes[0].top + 10,
    }));
    fire(cvs[0], "pointerdown", boxes[0].left + 10);
    fire(cvs[0], "pointermove", boxes[2].left + boxes[2].width - 2);
    const lifted = document.querySelectorAll(".pageghost").length;
    fire(cvs[0], "pointerup", boxes[2].left + boxes[2].width - 2);
    const cleaned = document.querySelectorAll(".pageghost").length;
    check("膠捲：拖曳時卡片浮起跟著游標，放開後收乾淨並回報新順序",
          lifted === 1 && cleaned === 0 && moved === "0→2",
          `浮起 ${lifted} 張　放開後剩 ${cleaned} 張　回報 ${moved ?? "無"}`);
    host.remove();
  }

  // 圖層清單：上＝最前面；拖曳回報「由前而後」的 id 順序，再由 applyLayerOrder 落成 zIndex
  {
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;left:0;top:0;width:252px;visibility:hidden";
    document.body.append(host);
    let got: string[] | null = null;
    const p = project([
      block("bottom", { x: 100, y: 100, w: 200, h: 200 }),
      block("middle", { x: 120, y: 120, w: 200, h: 200 }),
      block("top", { x: 140, y: 140, w: 200, h: 200 }),
    ]);
    p.pageCount = 1;
    p.blocks[0].zIndex = 1; p.blocks[1].zIndex = 2; p.blocks[2].zIndex = 3;
    const insp = new Inspector(host, {
      onChange: () => {}, ensureVariant: async () => {},
      reorder: () => {}, remove: () => {}, fillMedia: () => {}, changeRatio: () => {},
      guides: { hidden: () => false, toggleHidden: () => {}, add: () => {}, remove: () => {},
                locked: () => false, toggleLocked: () => {},
                presets: { filled: () => [], apply: () => {}, save: () => {}, clear: () => {} } },
      layers: { currentPage: () => 0, select: () => {}, toggleLock: () => {},
                thumb: () => undefined, reorder: (ids) => { got = ids; } },
      group: { align: () => {}, distribute: () => {}, duplicate: () => {}, remove: () => {} },
    });
    insp.show(p, null);
    insp.setPanel("layers");
    const rows = () => [...host.querySelectorAll<HTMLElement>(".lay")];
    const order = rows().map((r) => r.dataset.id);
    check("圖層清單：由上而下＝由前而後（zIndex 大的在上）",
          order.join(",") === "top,middle,bottom", order.join(","));

    // 把最上面那層拖到最下面
    const rs = rows();
    const last = rs[rs.length - 1].getBoundingClientRect();
    const dispatch = (el: HTMLElement, type: string, y: number): void => {
      el.dispatchEvent(new PointerEvent(type, {
        pointerId: 7, isPrimary: true, bubbles: true, cancelable: true,
        clientX: 20, clientY: y,
      }));
    };
    const y0 = rs[0].getBoundingClientRect().top + 2;
    dispatch(rs[0], "pointerdown", y0);
    dispatch(rs[0], "pointermove", last.bottom + 4);
    dispatch(rs[0], "pointerup", last.bottom + 4);
    const reported = got as string[] | null;
    check("圖層清單：拖到最下面＝回報新的前後順序",
          reported?.join(",") === "middle,bottom,top", reported?.join(",") ?? "沒回報");

    if (reported) applyLayerOrder(p, reported);
    const z = (id: string) => p.blocks.find((b) => b.id === id)!.zIndex;
    // 2026-09-01 起順序的真相＝**陣列排列**（與 iOS 同一套），zIndex 只是沿陣列遞增的鏡子
    check("圖層順序落成陣列排列（清單第一筆＝陣列最後一個）",
          p.blocks.map((b) => b.id).join(",") === "top,bottom,middle"
          && z("top") === 0 && z("bottom") === 1 && z("middle") === 2,
          `陣列=${p.blocks.map((b) => b.id).join(",")}　z top=${z("top")} bottom=${z("bottom")} middle=${z("middle")}`);
    host.remove();
  }

  // 開舊檔的順序和解：Mac 歷來只改 zIndex、iOS 只搬陣列，同一份專案兩種真相。
  // 和解規則＝z 有重複（iOS 參與過，新 block 一律 z=0）就信陣列；z 全相異就信 z。
  {
    const mk = (ids: string[], zs: number[]): Project => {
      const q = project(ids.map((id) => block(id, { x: 0, y: 0, w: 10, h: 10 })));
      q.blocks.forEach((b, i) => { b.zIndex = zs[i]; });
      return q;
    };
    // ① iPad 排的：底圖搬到陣列最前面（最底層），但它的 z 還是當初的舊值
    const ipad = mk(["bg", "a", "b"], [7, 0, 0]);
    const k1 = reconcileOrder(ipad);
    check("順序和解：z 有重複＝信陣列（iPad 排的順序不被 z 蓋掉）",
          k1 === "array" && ipad.blocks.map((b) => b.id).join(",") === "bg,a,b"
          && ipad.blocks.map((b) => b.zIndex).join(",") === "0,1,2",
          `${k1}　${ipad.blocks.map((b) => `${b.id}:${b.zIndex}`).join(" ")}`);
    // ② Mac 排的：移到最後寫 min−1，陣列位置沒動
    const mac = mk(["a", "b", "bg", "c"], [1, 2, 0, 4]);
    const k2 = reconcileOrder(mac);
    check("順序和解：z 全相異＝信 z（舊 Mac 專案版面不被改掉）",
          k2 === "zindex" && mac.blocks.map((b) => b.id).join(",") === "bg,a,b,c"
          && mac.blocks.map((b) => b.zIndex).join(",") === "0,1,2,3",
          `${k2}　${mac.blocks.map((b) => `${b.id}:${b.zIndex}`).join(" ")}`);
    // ③ 本來就一致的檔案一個字都不動
    const ok = mk(["a", "b", "c"], [0, 1, 2]);
    check("順序和解：本來就一致就不動", reconcileOrder(ok) === "none"
          && ok.blocks.map((b) => b.id).join(",") === "a,b,c", ok.blocks.map((b) => b.id).join(","));
    // ④ 移到最前／最後＝搬陣列，不是改 z
    const mv = mk(["a", "b", "c"], [0, 1, 2]);
    moveBlocks(mv, new Set(["a"]), "front");
    const front = mv.blocks.map((b) => b.id).join(",");
    moveBlocks(mv, new Set(["c"]), "back");
    check("移到最前／最後＝搬陣列元素且 z 重新遞增",
          front === "b,c,a" && mv.blocks.map((b) => b.id).join(",") === "c,b,a"
          && mv.blocks.map((b) => b.zIndex).join(",") === "0,1,2",
          `最前後=${front}　最後後=${mv.blocks.map((b) => `${b.id}:${b.zIndex}`).join(" ")}`);
  }

  // 影片池的可見性判定必須跟渲染裁切同一個形狀（旋轉 AABB）——
  // 不一致的話，轉過的影片會「渲染器照畫、影片池卻停止解碼」＝畫面上凍結
  {
    const b = { frame: { x: 40, y: 575, w: 1000, h: 200 }, rotation: 90 };
    // 轉 90° 後實體是 440,175 起的 200×1000 直條——這塊視野碰得到它、碰不到未旋轉 frame
    const view = { x: 420, y: 950, w: 650, h: 400 };
    const plainHit = intersects(b.frame, view);
    const cullHit = intersects(videoCullBounds(b), view);
    check("影片可見性用旋轉 AABB（轉 90° 的影片在視野內不會被誤暫停）",
          !plainHit && cullHit,
          `未旋轉 frame 相交=${plainHit}（應 false）　旋轉 AABB 相交=${cullHit}（應 true）`);
  }

  // 預覽吃即時影格、存檔吃海報圖——這是「同一份專案匯出兩次要一模一樣」的地基。
  // 兩張色塊當替身：海報＝紅、即時影格＝綠，看畫出來是哪一個顏色就知道走了哪條路。
  {
    const swatch = (hex: string): HTMLCanvasElement => {
      const c = document.createElement("canvas");
      c.width = c.height = 8;
      const x = c.getContext("2d")!;
      x.fillStyle = hex; x.fillRect(0, 0, 8, 8);
      return c;
    };
    const p = project([{
      id: "V", frame: { x: 100, y: 100, w: 400, h: 400 }, rotation: 0, zIndex: 1,
      locked: false, opacity: 1,
      content: { type: "video", media: { assetFileName: "clip.mov", cropRect: { x: 0, y: 0, w: 1, h: 1 } } },
    }]);
    p.pageCount = 1;
    const images = new Map<string, CanvasImageSource>([["clip.mov.poster.jpg", swatch("#FF0000")]]);
    const live = new Map<string, CanvasImageSource>([["clip.mov", swatch("#00FF00")]]);
    const at = (c: HTMLCanvasElement) => c.getContext("2d")!.getImageData(300, 300, 1, 1).data;
    const still = at(renderPageCanvas(p, 0, { images }));
    const moving = at(renderPageCanvas(p, 0, { images, videos: live }));
    check("匯出走海報圖、預覽走即時影格（同一支渲染路，只差有沒有餵 videos）",
          still[0] > 200 && still[1] < 60 && moving[1] > 200 && moving[0] < 60,
          `不餵 videos＝rgb(${still[0]},${still[1]},${still[2]})　餵了＝rgb(${moving[0]},${moving[1]},${moving[2]})`);
  }

  // ── 匯出台的視窗 ──────────────────────────────────────────────────
  // 蓋一台假的匯出台（3 頁 × 400×500）在 800×600 的窗裡，用真的指標事件驅動。
  {
    const stage = document.createElement("div");
    stage.style.cssText = "position:fixed;left:0;top:0;width:800px;height:600px;overflow:hidden;visibility:hidden";
    const shots = document.createElement("div");
    shots.style.cssText = "position:absolute;left:0;top:0;transform-origin:0 0;display:flex;align-items:flex-start";
    for (let i = 0; i < 3; i++) {
      const f = document.createElement("figure");
      f.style.cssText = "margin:0;flex:none";
      const c = document.createElement("canvas");
      c.width = 400; c.height = 500;
      c.style.cssText = "display:block;width:400px;height:500px";
      f.append(c);
      shots.append(f);
    }
    stage.append(shots);
    document.body.append(stage);

    let picked = -1;
    const g = new Gallery(stage, shots, { pick: (i) => { picked = i; } });
    const gev = (type: string, x: number, y: number, init: Partial<PointerEventInit> = {}): void => {
      stage.dispatchEvent(new PointerEvent(type, {
        pointerId: 9, isPrimary: true, bubbles: true, cancelable: true, clientX: x, clientY: y, ...init,
      }));
    };
    /** 螢幕點 → 內容點。錨定縮放要成立，這個值在縮放前後必須一樣。 */
    const contentX = (sx: number) => (sx - g.view.x) / g.view.k;

    g.setLayout(true);      // 分開：整個看到
    // kw=(800-112)/1200=.5733、kh=(600-104)/500=.992 → 取小；寬度剛好佔滿可用區→置中在 padX
    check("匯出台：分開＝整張看到，兩邊都收進來",
          near(g.view.k, 0.5733, 0.002) && near(g.view.x, 56, 0.6),
          `k=${g.view.k.toFixed(4)} x=${g.view.x.toFixed(1)}`);

    g.setLayout(false);     // 連續：只對高度，左右自己捲
    check("匯出台：連續＝對齊高度、左緣起跑",
          near(g.view.k, 0.992, 0.002) && near(g.view.x, 56, 0.01),
          `k=${g.view.k.toFixed(4)} x=${g.view.x.toFixed(1)}`);

    const before = contentX(300);
    g.zoomAt(2, 300, 200);
    check("匯出台：縮放以游標為錨，錨點下的畫面不動",
          near(contentX(300), before, 0.01) && near(g.view.k, 2, 0.001),
          `錨前 ${before.toFixed(2)} → 錨後 ${contentX(300).toFixed(2)}`);

    g.zoomAt(99, 400, 300);
    check("匯出台：縮放有上限", near(g.view.k, 6, 0.001), `k=${g.view.k}`);

    // 平移：兩指捲（沒有 ctrlKey）＝移動，不是縮放
    g.setLayout(false);
    const x0 = g.view.x, k0 = g.view.k;
    stage.dispatchEvent(new WheelEvent("wheel", { deltaX: 120, deltaY: 0, bubbles: true, cancelable: true }));
    check("匯出台：兩指捲是平移不是縮放",
          near(g.view.x, x0 - 120, 0.01) && near(g.view.k, k0, 0.0001),
          `x ${x0.toFixed(0)} → ${g.view.x.toFixed(0)}`);

    // 點作品＝翻到那一張；但「拖畫面拖到一半放開」不能算點
    picked = -1;
    const target = shots.children[1].firstChild as HTMLCanvasElement;
    gev("pointerdown", 300, 300);
    gev("pointerup", 300, 300);
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    const clickPicked = picked;

    picked = -1;
    gev("pointerdown", 300, 300);
    gev("pointermove", 460, 300);
    gev("pointerup", 460, 300);
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    check("匯出台：點作品會翻頁，但拖過畫面就不算點",
          clickPicked === 1 && picked === -1,
          `點到 ${clickPicked}　拖完 ${picked}`);

    stage.remove();
  }

  // ── 24. 影片修剪的範圍計算（2026-08-07）────────────────────────────────
  // 邊界條件用眼睛看不出對錯：夾住最短長度、整段平移不出界且長度不變。
  {
    const dur = 10;
    // (a) 拖進點：不能越過「出點減最短長度」
    {
      const r = nextRange("in", 9.5, { in: 0, out: 6, at: 0 }, dur);
      check("修剪：拖進點被最短長度擋住（不會穿過出點）",
            near(r.start, 5) && near(r.end, 6), `${r.start}–${r.end}`);
      const r2 = nextRange("in", -3, { in: 2, out: 6, at: 2 }, dur);
      check("修剪：拖進點不會跑到 0 之前", near(r2.start, 0) && near(r2.end, 6), `${r2.start}–${r2.end}`);
    }

    // (b) 拖出點：不能越過「進點加最短長度」，也不能超過片長
    {
      const r = nextRange("out", 2.2, { in: 4, out: 8, at: 8 }, dur);
      check("修剪：拖出點被最短長度擋住", near(r.start, 4) && near(r.end, 5), `${r.start}–${r.end}`);
      const r2 = nextRange("out", 99, { in: 4, out: 8, at: 8 }, dur);
      check("修剪：拖出點不會超過片長", near(r2.end, dur), `${r2.start}–${r2.end}`);
    }

    // (c) 拖中段：長度不變，撞到兩端就停（這條最容易寫成「長度被壓縮」）
    {
      const r = nextRange("win", 5, { in: 2, out: 5, at: 3 }, dur);
      check("修剪：拖中段整段平移（長度不變）",
            near(r.start, 4) && near(r.end - r.start, 3), `${r.start}–${r.end}`);
      const l = nextRange("win", -50, { in: 2, out: 5, at: 3 }, dur);
      check("修剪：中段撞到頭就停，長度仍不變",
            near(l.start, 0) && near(l.end - l.start, 3), `${l.start}–${l.end}`);
      const rr = nextRange("win", 99, { in: 2, out: 5, at: 3 }, dur);
      check("修剪：中段撞到尾就停，長度仍不變",
            near(rr.end, dur) && near(rr.end - rr.start, 3), `${rr.start}–${rr.end}`);
    }
  }

  // ── 更新檢查的版本比較（純數字逐段比，1.10.0 必須大於 1.9.0）──────────
  {
    check("版本比較：1.0.7 > 1.0.6", isNewer("1.0.7", "1.0.6"));
    check("版本比較：1.10.0 > 1.9.0（不是字串比）", isNewer("1.10.0", "1.9.0"));
    check("版本比較：同版不算新", !isNewer("1.0.7", "1.0.7"));
    check("版本比較：舊版不算新", !isNewer("1.0.6", "1.0.7"));
    check("版本比較：2.0 > 1.9.9（段數不齊補零）", isNewer("2.0", "1.9.9"));
  }

  // ── 塗鴉（2026-08-23）：真指標事件畫兩筆→一個 block、框包住筆畫；橡皮擦整筆擦；Esc 離開 ──
  {
    const p = project([]);
    editor.load(p);
    editor.snapStrength = "none";
    const strokes: string[] = [];
    editor.onDoodleStroke = (b) => strokes.push(b.id);
    editor.beginDoodle();
    check("塗鴉：進模式", !!editor.doodle);
    const draw = (pts: [number, number][]) => {
      pointer("pointerdown", pts[0][0], pts[0][1]);
      for (const [x, y] of pts.slice(1)) pointer("pointermove", x, y);
      pointer("pointerup", pts[pts.length - 1][0], pts[pts.length - 1][1]);
    };
    draw([[200, 200], [300, 260], [400, 200], [500, 300]]);
    const d1 = p.blocks.find((b) => b.content.type === "doodle");
    check("塗鴉：第一筆落下自動生成 block", !!d1 && strokes.length === 1, `blocks=${p.blocks.length}`);
    draw([[220, 600], [600, 620]]);
    const d2 = p.blocks.filter((b) => b.content.type === "doodle");
    const dd = d2[0]?.content.type === "doodle" ? d2[0].content.doodle : null;
    check("塗鴉：第二筆進同一個 block（不另開）", d2.length === 1 && dd?.strokes.length === 2,
          `blocks=${d2.length} strokes=${dd?.strokes.length}`);
    const f = d2[0].frame;
    check("塗鴉：框包住兩筆（含留白）", f.x < 200 && f.y < 200 && f.x + f.w > 600 && f.y + f.h > 620,
          `frame=${Math.round(f.x)},${Math.round(f.y)} ${Math.round(f.w)}×${Math.round(f.h)}`);
    // 點座標正規化後還原要回到原位（±1）
    const sx = f.x + dd!.strokes[1].pts[0] * f.w, sy = f.y + dd!.strokes[1].pts[1] * f.h;
    check("塗鴉：正規化座標可還原", near(sx, 220, 1) && near(sy, 600, 1), `${sx.toFixed(1)},${sy.toFixed(1)}`);
    // round-trip 存檔
    const rt = decodeProject(JSON.parse(JSON.stringify(encodeProject(p))));
    const rb = rt.blocks[0];
    check("塗鴉：存檔 round-trip 保留筆畫", rb.content.type === "doodle" && rb.content.doodle.strokes.length === 2);
    // 橡皮擦：碰第二筆（直線中段）
    editor.doodle!.eraser = true;
    pointer("pointerdown", 400, 610); pointer("pointerup", 400, 610);
    check("塗鴉：橡皮擦整筆擦掉", dd!.strokes.length === 1 && strokes.length === 3, `strokes=${dd!.strokes.length}`);
    // 擦到最後一筆＝block 消失（點起筆處——streamline 平滑會挪動中段的點，起點是錨定的）
    pointer("pointerdown", 200, 200); pointer("pointerup", 200, 200);
    check("塗鴉：擦光＝block 移除", p.blocks.length === 0, `blocks=${p.blocks.length}`);
    editor.doodle!.eraser = false;
    draw([[100, 100], [150, 150]]);
    editor.newDoodleLayer();
    draw([[800, 100], [850, 150]]);
    check("塗鴉：另起新塗鴉＝第二個 block", p.blocks.filter((b) => b.content.type === "doodle").length === 2);
    editor.endDoodle();
    check("塗鴉：離開模式", !editor.doodle);
    // 離開後點擊＝回到正常選取
    pointer("pointerdown", 125, 125); pointer("pointerup", 125, 125);
    check("塗鴉：離開後點塗鴉＝選取（不畫）", editor.getSelected()?.content.type === "doodle" && p.blocks.length === 2);
    editor.onDoodleStroke = undefined;
  }

  // ── 塗鴉點陣快取 ──
  {
    const dood: DoodleBlock = { strokes: [
      { pts: [0.1,0.2, 0.5,0.4, 0.9,0.3, 0.7,0.8], w: 0.06, color: "222222", brush: "pencil" },
      { pts: [0.2,0.7, 0.6,0.6, 0.85,0.75], w: 0.05, color: "224488", brush: "pencil" },
    ] };
    const mk = () => { const c = document.createElement("canvas"); c.width = 128; c.height = 128; return c; };
    // 128×128 剛好落在級距 base 上→烤圖尺寸＝顯示尺寸，可做畫素級比對
    const a = mk(), b = mk(), u = mk();
    doodleCounters.reset();
    drawDoodle(a.getContext("2d")!, dood, 128, 128);
    const miss1 = doodleCounters.miss;
    drawDoodle(b.getContext("2d")!, dood, 128, 128);
    check("塗鴉快取：第一次烤、第二次命中", miss1 === 1 && doodleCounters.hit === 1, `miss=${miss1} hit=${doodleCounters.hit}`);
    drawDoodleUncached(u.getContext("2d")!, dood, 128, 128);
    const pa = a.getContext("2d")!.getImageData(0,0,128,128).data, pu = u.getContext("2d")!.getImageData(0,0,128,128).data;
    let diff = 0; for (let i = 0; i < pa.length; i++) if (Math.abs(pa[i]-pu[i]) > 1) diff++;
    check("塗鴉快取：快取與直畫畫素一致", diff === 0, `不同分量 ${diff}`);
    doodleCounters.reset();
    drawDoodle(mk().getContext("2d")!, { ...dood, wobble: "boil" }, 128, 128, 0.5);
    const g = mk().getContext("2d")!; g.globalAlpha = 0.5;
    drawDoodle(g, dood, 128, 128);
    check("塗鴉快取：會動的與半透明的不進快取", doodleCounters.hit + doodleCounters.miss === 0, `hit+miss=${doodleCounters.hit + doodleCounters.miss}`);
  }

  // ── c5 孔版濾鏡＋撕紙邊（2026-08-31）──────────────────────────────────
  {
    // 身份字串：非 c5 逐位不變（既有鍵零變動）；c5＝代號＋參數；參數變了鍵就變
    const plain: MediaBlock = { assetFileName: "a.jpg", cropRect: { x: 0, y: 0, w: 1, h: 1 }, filterKey: "a1" };
    check("filterSig：非 c5＝代號本身", filterSig(plain) === "a1", String(filterSig(plain)));
    const c5: MediaBlock = { assetFileName: "a.jpg", cropRect: { x: 0, y: 0, w: 1, h: 1 }, filterKey: "c5" };
    const sigA = filterSig(c5)!;
    check("filterSig：c5 預設參數進鍵", sigA.startsWith("c5:") && sigA.includes("236996"), sigA);
    const c5b = { ...c5, risoPitch: 8 };
    check("filterSig：參數變了鍵就變", filterSig(c5b) !== sigA, String(filterSig(c5b)));
    const rt = parseRisoSig(sigA);
    check("filterSig：round-trip 解回同參數",
          rt.inks.join() === RISO_DEFAULTS.inks.join() && rt.pitch === RISO_DEFAULTS.pitch
          && rt.hard === RISO_DEFAULTS.hard && rt.grain === RISO_DEFAULTS.grain,
          JSON.stringify(rt));
    // 孔版本體：確定性（同輸入同輸出）＋真的有網點（輸出不等於輸入）＋純紙色輸入近紙色輸出
    const mkImg = (fill: [number, number, number]) => {
      const d = new Uint8ClampedArray(64 * 64 * 4);
      for (let i = 0; i < d.length; i += 4) { d[i] = fill[0]; d[i + 1] = fill[1]; d[i + 2] = fill[2]; d[i + 3] = 255; }
      return d;
    };
    const i1 = mkImg([60, 90, 120]), i2 = mkImg([60, 90, 120]);
    applyRiso(i1, 64, 64, RISO_DEFAULTS); applyRiso(i2, 64, 64, RISO_DEFAULTS);
    let same = true, changed = false;
    for (let i = 0; i < i1.length; i++) { if (i1[i] !== i2[i]) { same = false; break; } }
    const orig = mkImg([60, 90, 120]);
    for (let i = 0; i < i1.length; i++) { if (Math.abs(i1[i] - orig[i]) > 8) { changed = true; break; } }
    check("c5：同輸入同輸出（確定性，iOS 對齊的前提）", same);
    check("c5：深色輸入真的被過網（輸出≠輸入）", changed);
    const ip = mkImg([221, 215, 201]);
    applyRiso(ip, 64, 64, { ...RISO_DEFAULTS, grain: 0 });
    let paperOk = true;
    for (let i = 0; i < ip.length; i += 4) {
      if (Math.abs(ip[i] - 221) > 30 || Math.abs(ip[i + 1] - 215) > 30) { paperOk = false; break; }
    }
    check("c5：紙色輸入≈紙色輸出（分色不倒灌）", paperOk);
    // 撕紙邊：absent＝關（舊專案零變動）；tear 烤圖確定性＋真的有裁（角落 alpha 0）
    const bare: MediaBlock = { assetFileName: "a.jpg", cropRect: { x: 0, y: 0, w: 1, h: 1 } };
    check("撕紙邊：欄位 absent＝關", tornOf(bare) === null);
    const tm: MediaBlock = { assetFileName: "a.jpg", cropRect: { x: 0, y: 0, w: 1, h: 1 }, tornStyle: "tear" };
    const tp = tornOf(tm)!;
    check("撕紙邊：預設參數補齊", tp.amt === 0.055 && tp.sides === 15 && tp.core === "F5F1E6", JSON.stringify(tp));
    // ⚠️ 烤圖尺寸是**正規化**的（長寬比 bucket＋短邊 1024，見 tornBakeSize），
    // 不等於傳進去的顯示尺寸——取樣一律用畫布自己的寬高，別寫死 300×200。
    const t1 = tornCanvases(tp, 300, 200), t2 = tornCanvases({ ...tp }, 300, 200);
    const TW = t1.mask.width, TH = t1.mask.height;
    const alphaAt = (cv: HTMLCanvasElement, x: number, y: number): number =>
      cv.getContext("2d")!.getImageData(x, y, 1, 1).data[3];
    const d1 = t1.mask.getContext("2d")!.getImageData(0, 0, TW, TH).data;
    const d2 = t2.mask.getContext("2d")!.getImageData(0, 0, TW, TH).data;
    let tsame = true;
    for (let i = 3; i < d1.length; i += 4) { if (d1[i] !== d2[i]) { tsame = false; break; } }
    check("撕紙邊：同參數同遮罩（快取與確定性）", tsame);
    check("撕紙邊：烤圖尺寸正規化（不含顯示尺寸，縮放不重烤）",
          t1.mask.width === tornCanvases(tp, 600, 400).mask.width && TW === 1536 && TH === 1024,
          `${TW}×${TH}`);
    check("撕紙邊：角落真的被撕掉（alpha 0）、中心完好（alpha 255）",
          d1[3] === 0 && alphaAt(t1.mask, TW >> 1, TH >> 1) === 255,
          `corner=${d1[3]} center=${alphaAt(t1.mask, TW >> 1, TH >> 1)}`);
    // 只開右邊：左上角完好
    const tR = tornCanvases(tornOf({ ...tm, tornSides: 2 })!, 300, 200);
    check("撕紙邊：單邊 bitmask（只撕右）",
          alphaAt(tR.mask, 0, 0) === 255 && alphaAt(tR.mask, tR.mask.width - 1, 0) === 0,
          `左上=${alphaAt(tR.mask, 0, 0)} 右上=${alphaAt(tR.mask, tR.mask.width - 1, 0)}`);
    // 純影片頁匯出：撕紙邊烤進 mask＋stroke（alignvideo 零改動的那條）
    const { mask: vm, stroke: vs } = maskAndStrokeCanvases(tm, 300, 200);
    check("撕紙邊：影片匯出 mask/stroke 有烤出來", !!vm && !!vs);
    const vg = vm!.getContext("2d")!;
    check("撕紙邊：影片 mask 角落也是撕掉的",
          vg.getImageData(0, 0, 1, 1).data[3] === 0
          && vg.getImageData(vm!.width >> 1, vm!.height >> 1, 1, 1).data[3] === 255);
    // 存檔 round-trip：riso/torn 欄位原樣穿透
    const proj = project([]);
    proj.blocks.push({ id: "x", frame: { x: 0, y: 0, w: 100, h: 100 }, rotation: 0, zIndex: 1, locked: false, opacity: 1,
      content: { type: "image", media: { ...c5, risoInks: ["112233"], risoPitch: 6.5, tornStyle: "tear", tornSides: 5, tornAmt: 0.08 } } });
    const rp = decodeProject(JSON.parse(JSON.stringify(encodeProject(proj))));
    const rm = rp.blocks[0].content.type === "image" ? rp.blocks[0].content.media : null;
    check("c5＋撕紙邊：存檔 round-trip 欄位原樣",
          rm?.filterKey === "c5" && rm?.risoInks?.[0] === "112233" && rm?.risoPitch === 6.5
          && rm?.tornStyle === "tear" && rm?.tornSides === 5 && rm?.tornAmt === 0.08,
          JSON.stringify({ f: rm?.filterKey, i: rm?.risoInks, p: rm?.risoPitch, t: rm?.tornStyle }));
  }

  // ── 貼紙邊（matteEdge*，2026-09-03 從 feat/sticker-edge-0828 收回主線）────
  // 剪影替身＝貼滿框的圓形 alpha canvas（貼圖庫 PNG 那型，沒有遮罩）。
  // 邊往輪廓外擴＝**框外**要長出實色畫素——這是它跟「外框描邊」的本質差異。
  {
    const disc = document.createElement("canvas");
    disc.width = disc.height = 64;
    const dg = disc.getContext("2d")!;
    dg.fillStyle = "#0000FF";
    dg.beginPath(); dg.arc(32, 32, 32, 0, Math.PI * 2); dg.fill();
    const p = project([{
      id: "S", frame: { x: 300, y: 300, w: 400, h: 400 }, rotation: 0, zIndex: 1,
      locked: false, opacity: 1,
      content: { type: "image", media: { assetFileName: "s.png", cropRect: { x: 0, y: 0, w: 1, h: 1 },
        matteEdgeWidth: 0.05, matteEdgeHex: "FF0000", matteEdgeBevel: 0.6 } },
    }]);
    p.pageCount = 1;
    const images = new Map<string, CanvasImageSource>([["s.png", disc]]);
    const c = renderPageCanvas(p, 0, { transparent: true, images });
    const g = c.getContext("2d")!;
    // 圓最右點在框右緣 (700, 500)，邊寬 0.05×400＝20px 往外——掃框外那一條該有紅
    const band = g.getImageData(702, 500, 16, 1).data;
    let edgePx = 0;
    for (let i = 0; i < band.length; i += 4) if (band[i + 3] > 200 && band[i] > 180 && band[i + 2] < 80) edgePx++;
    // 圓心是圖自己的藍（邊不能蓋到圖上）；框外遠處（邊再往外 60px）仍是透明
    const mid = g.getImageData(500, 500, 1, 1).data;
    const far = g.getImageData(780, 500, 1, 1).data;
    check("貼紙邊：輪廓外長出實色邊、圖不被蓋、更外面仍透明",
          edgePx >= 10 && mid[2] > 180 && mid[0] < 80 && far[3] === 0,
          `邊帶紅畫素=${edgePx}/16　圓心=rgb(${mid[0]},${mid[1]},${mid[2]})　遠處α=${far[3]}`);
    // 同一份再渲一次＝快取命中，不重烤（膨脹＋浮雕是最貴的一項）
    const missBefore = renderCounters.edgeMiss;
    renderPageCanvas(p, 0, { transparent: true, images });
    check("貼紙邊：同內容重渲走快取（edgeMiss 不動）",
          renderCounters.edgeMiss === missBefore && renderCounters.edgeHit > 0,
          `miss=${renderCounters.edgeMiss}（前=${missBefore}）　hit=${renderCounters.edgeHit}`);
    // 存檔 round-trip：三欄位原樣穿透（iOS 1.2.0 起已出貨在寫，這裡是追平驗收）
    const rp2 = decodeProject(JSON.parse(JSON.stringify(encodeProject(p))));
    const em = rp2.blocks[0].content.type === "image" ? rp2.blocks[0].content.media : null;
    check("貼紙邊：存檔 round-trip 欄位原樣",
          em?.matteEdgeWidth === 0.05 && em?.matteEdgeHex === "FF0000" && em?.matteEdgeBevel === 0.6,
          JSON.stringify({ w: em?.matteEdgeWidth, x: em?.matteEdgeHex, b: em?.matteEdgeBevel }));
  }

  const pass = results.filter((r) => r.ok).length;
  const out = document.querySelector<HTMLDivElement>("#out")!;
  out.innerHTML = results.map((r) =>
    `<div class="${r.ok ? "ok" : "bad"}">${r.ok ? "PASS" : "FAIL"}　${r.name}${r.detail ? `　<span>${r.detail}</span>` : ""}</div>`
  ).join("") + `<div class="sum ${pass === results.length ? "ok" : "bad"}">${pass} / ${results.length} 通過</div>`;
  document.title = `${pass}/${results.length} ${pass === results.length ? "PASS" : "FAIL"}`;
}

// 有案例丟例外時，把它印在頁面上——沉默的測試頁比失敗的測試頁更糟
run().catch((e) => {
  const out = document.querySelector<HTMLDivElement>("#out")!;
  document.body.dataset.crashCtx = `done=${results.length} fails=${results.filter((r) => !r.ok).length}`
    + ` lastFails=${results.filter((r) => !r.ok).slice(-4).map((r) => r.name).join("；")}`;
  out.innerHTML += `<div class="bad">執行中斷：${(e as Error).message}</div>`
    + `<pre style="white-space:pre-wrap;font-size:12px;opacity:.7">${(e as Error).stack ?? ""}</pre>`;
  document.title = "ERROR";
});
