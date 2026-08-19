// 直排三 bug 修復的渲染樣張（截圖驗證用）：
//   ① 直排標題設欄高 → 框貼墨跡（autoFitText 錨右緣）
//   ② 直排長文框 → 整欄制＋裁切，字不出框
// 紅線＝block frame。字都在框內、框貼字＝通過。
import type { Project, Block } from "./core/schema";
import { renderPageCanvas, autoFitText } from "./core/render";
import { loadFonts } from "./core/fonts";

const mkText = (id: string, x: number, y: number, w: number, h: number,
                text: string, extra: Record<string, unknown>): Block => ({
  id, frame: { x, y, w, h }, rotation: 0, zIndex: 1, locked: false, opacity: 1,
  content: { type: "text", text: {
    text, alignment: "leading", fontSize: 40, vertical: true, ...extra,
  } } as Block["content"],
});

const project: Project = {
  id: "VERT-TEST", name: "vert", createdAt: "", updatedAt: "",
  canvasWidth: 1080, pageHeight: 1350, pageCount: 1,
  blocks: [
    // ① 直排標題：欄高 300 → 應折成多欄，框收到貼墨跡
    mkText("t1", 90, 120, 200, 300, "直排標題欄高測試字串", { manualHeight: 300 }),
    // ② 直排長文框 500×420：欄高=框高 420，文字多到爆框 → 整欄制＋裁切
    mkText("t2", 420, 120, 500, 420,
      "直排長文框固定容器測試：整欄放不下就不排，裁切保底，吸附咬的框就是眼睛看到的範圍，" +
      "文字再多也不越界。第二段繼續塞字讓欄數超過容器寬度看看會不會溢出框外。",
      { isBodyFrame: true, manualHeight: 420 }),
    // ③ 對照組：直排標題「未設欄高」→ 預設頁高 60% 欄高，行為不應改變
    mkText("t3", 90, 700, 200, 500, "對照組未設欄高", {}),
  ],
};

(async () => {
  await loadFonts();
  const probe = document.createElement("canvas").getContext("2d")!;
  autoFitText(probe, project);
  const canvas = renderPageCanvas(project, 0, { images: new Map(), filters: null as never });
  // 疊 frame 紅線
  const ctx = canvas.getContext("2d")!;
  ctx.strokeStyle = "#e0322b"; ctx.lineWidth = 2;
  for (const b of project.blocks) ctx.strokeRect(b.frame.x, b.frame.y, b.frame.w, b.frame.h);
  document.body.append(canvas);
  document.title = "ready " + project.blocks.map(b =>
    `${b.id}:${Math.round(b.frame.w)}x${Math.round(b.frame.h)}`).join(" ");
})();
