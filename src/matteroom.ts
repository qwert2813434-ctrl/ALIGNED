// 去背編輯間 — 自動去背之後直接進來修的地方。
//
// 三層結構（原型階段與小高定案的重點）：
//   底層  自動遮罩   去背器給的，唯讀
//   中層  羽化／外擴  對底層的即時調整，隨時可以再拉
//   上層  筆畫       使用者的手動修正，獨立一張畫布
// 三層分開，所以「先手動修過、再回頭拉外擴」不會把修過的東西弄丟——
// 一體式（直接把調整燒進遮罩）就是先修先死，這類工具最常見的災難。
//
// 按「完成」才把三層烤成一張灰階 PNG 交回去；下次再進來就從那張當底層，
// 羽化與外擴歸零。可預期，而且檔案裡永遠只有一張遮罩。
//
// 快捷鍵照 Photoshop／Lightroom 既有慣例配，不自己發明：
//   B／E 筆與橡皮擦、X 互換、按住 ⌥ 暫時切另一支（Lightroom 遮色片筆刷）、
//   [ ] 大小、⇧[ ⇧] 硬度、空白鍵拖曳平移、⌘0 符合畫面、⌘1 100%、
//   ⌘Z／⌘⇧Z、⌘I 反轉、\ 切換粉紅覆蓋（PS 遮色片 rubylith 疊色就是這顆）。
// 觸控板（小高加的，沒有公認標準但與上面那套不衝突）：
//   雙指上下＝縮放、⌘＋雙指＝筆刷大小、⇧＋雙指＝筆刷硬度。
//
// 指標座標一律用 offsetX／offsetY 再套視圖矩陣的反矩陣，
// 不用 getBoundingClientRect 當原點（縮放時會漂）。

import { __, localizeTitles } from "./i18n";

export interface MatteEdit {
  /** 烤好的灰階遮罩 PNG（base64，不含 data: 前綴）。 */
  png: string;
  /** 反轉＝留背景。 */
  inverted: boolean;
  /** 使用者在編輯間選的材質，是 assets/ 裡的檔名。未設＝不填材質。 */
  fill?: string;
}

export interface MatteRoomOpts {
  /** 內建材質清單。label 只當 hover 提示，按鈕上顯示的是 url 那張縮圖。 */
  textures: { key: string; label: string; url: string }[];
  /** key → 專案 assets/ 裡的一張圖；key = null ＝開檔案框自己選。回 null＝取消。
   *  編輯間只負責顯示，複製檔案與寫進 assets/ 是殼層的事。 */
  resolve: (key: string | null) => Promise<{ name: string; img: HTMLImageElement } | null>;
  /** 這個 block 現在就已經填著的材質（＝從材質層按「修…」進來）。
   *  有值才不會一進來就把「不填」標成選中的，那是在騙人。 */
  initial?: { key: string; name: string; img: HTMLImageElement };
}

const BRUSH_MIN = 1, BRUSH_MAX = 500;
const toBrush = (t: number): number =>
  Math.max(1, Math.round(BRUSH_MIN * Math.pow(BRUSH_MAX / BRUSH_MIN, t / 1000)));
const toSlider = (b: number): number =>
  Math.round(1000 * Math.log(b / BRUSH_MIN) / Math.log(BRUSH_MAX / BRUSH_MIN));

function loadImg(url: string): Promise<HTMLImageElement> {
  return new Promise((ok, err) => {
    const i = new Image();
    if (url.startsWith("http")) i.crossOrigin = "anonymous";
    i.onload = () => ok(i);
    i.onerror = () => err(new Error("load"));
    i.src = url;
  });
}

/** 重用的暫存畫布——畫筆每動一下重畫一次，每幀 new 全尺寸畫布會頓。 */
function pad(store: Record<string, HTMLCanvasElement>, key: string, w: number, h: number): HTMLCanvasElement {
  let c = store[key];
  if (!c) c = store[key] = document.createElement("canvas");
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  else c.getContext("2d")!.clearRect(0, 0, w, h);
  const g = c.getContext("2d")!;
  g.globalCompositeOperation = "source-over"; g.globalAlpha = 1; g.filter = "none";
  return c;
}

const SVG = 'width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"';
const PLUS = `<svg ${SVG}><path d="M12 5v14M5 12h14"/></svg>`;
const SLASH = `<svg ${SVG}><path d="M5 19L19 5"/></svg>`;

const INF = 1e20;

/** 一維平方距離轉換（Felzenszwalb & Huttenlocher 的下包絡拋物線法，O(n)）。 */
function edt1d(f: Float32Array, n: number, d: Float32Array, v: Int32Array, z: Float32Array): void {
  let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
    k++; v[k] = q; z[k] = s; z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; d[q] = (q - v[k]) * (q - v[k]) + f[v[k]]; }
}

/** 二維平方距離場，就地改寫。a：0＝種子點，INF＝其他。 */
function edt2d(a: Float32Array, w: number, h: number): Float32Array {
  const m = Math.max(w, h);
  const f = new Float32Array(m), d = new Float32Array(m);
  const v = new Int32Array(m), z = new Float32Array(m + 1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = a[y * w + x];
    edt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) a[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) f[x] = a[o + x];
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) a[o + x] = d[x];
  }
  return a;
}

/** 把圖等比填滿 w×h（多的裁掉）。材質是正方形、照片不是，直接畫會變形。 */
function cover(g: CanvasRenderingContext2D, img: HTMLImageElement, w: number, h: number): void {
  const s = Math.max(w / img.naturalWidth, h / img.naturalHeight);
  const dw = img.naturalWidth * s, dh = img.naturalHeight * s;
  g.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

export async function openMatteRoom(
  photoURL: string,
  matteURL: string,
  inverted: boolean,
  opts: MatteRoomOpts,
): Promise<MatteEdit | null> {
  const [photo, base] = await Promise.all([loadImg(photoURL), loadImg(matteURL)]);

  return new Promise((resolve) => {
    const root = document.createElement("div");
    root.id = "mattesheet";
    root.innerHTML = `
      <div id="mattebar">
        <div class="grp"><span class="lab">${__("工具")}</span>
          <div class="row">
            <button id="mtBrush" class="chip">${__("筆")}<kbd>B</kbd></button>
            <button id="mtErase" class="chip">${__("橡皮擦")}<kbd>E</kbd></button>
          </div>
        </div>
        <div class="grp"><span class="lab">${__("筆刷大小")} <i id="mtSizeV"></i></span>
          <input type="range" id="mtSize" min="0" max="1000" step="1"></div>
        <div class="grp"><span class="lab">${__("筆刷硬度")} <i id="mtHardV"></i></span>
          <input type="range" id="mtHard" min="0" max="100" step="1" value="70"></div>
        <div class="sect">${__("自動遮罩微調")}</div>
        <div class="grp"><span class="lab">${__("邊緣羽化")} <i id="mtFeaV"></i></span>
          <input type="range" id="mtFea" min="0" max="24" step="0.5" value="0"></div>
        <div class="grp"><span class="lab">${__("外擴／內縮")} <i id="mtChoV"></i></span>
          <input type="range" id="mtCho" min="-30" max="30" step="1" value="0"></div>
        <div class="sect">${__("輸出")}</div>
        <div class="grp"><span class="lab">${__("保留哪一邊")}</span>
          <div class="row">
            <button id="mtKeep" class="chip">${__("主體")}</button>
            <button id="mtDrop" class="chip">${__("背景")}</button>
          </div>
        </div>
        <div class="grp"><span class="lab">${__("填材質")}</span>
          <div class="row" id="mtFill">
            ${opts.textures.map((t) =>
              `<button class="texsw" data-tex="${t.key}" title="${t.label}"
                       style="background-image:url('${t.url}')"></button>`).join("")}
            <button class="texsw plain dashed" data-tex="*" title="${__("自選…")}">${PLUS}</button>
            <button class="texsw plain" data-tex="" title="${__("不填")}">${SLASH}</button>
          </div>
        </div>
        <div class="grp"><span class="lab">${__("預覽")}</span>
          <div class="row">
            <button id="mtVPink" class="chip">${__("粉紅")}</button>
            <button id="mtVCut" class="chip">${__("去背")}</button>
            <button id="mtVFill" class="chip" disabled>${__("材質")}</button>
            <button id="mtVRaw" class="chip">${__("原圖")}</button>
          </div>
        </div>
        <div class="grp"><div class="row">
          <button id="mtUndo" class="chip">${__("還原")}</button>
          <button id="mtRedo" class="chip">${__("重做")}</button>
        </div></div>
        <div class="keys">
          <b>${__("快捷鍵")}</b>
          <div class="k"><span>${__("兩者互換")}</span><span><kbd>X</kbd></span></div>
          <div class="k"><span>${__("暫時切另一支")}</span><span><kbd>⌥</kbd></span></div>
          <div class="k"><span>${__("筆刷大小")}</span><span><kbd>[</kbd> <kbd>]</kbd></span></div>
          <div class="k"><span>${__("筆刷硬度")}</span><span><kbd>⇧[</kbd> <kbd>⇧]</kbd></span></div>
          <div class="k"><span>${__("平移")}</span><span>${__("空白鍵拖曳")}</span></div>
          <div class="k"><span>${__("符合畫面")}</span><span><kbd>⌘0</kbd></span></div>
          <div class="k"><span>${__("粉紅覆蓋")}</span><span><kbd>\\</kbd></span></div>
          <div class="k"><span>${__("反轉")}</span><span><kbd>⌘I</kbd></span></div>
          <div class="k"><span>${__("縮放")}</span><span>${__("雙指上下")}</span></div>
          <div class="k"><span>${__("筆刷大小")}</span><span><kbd>⌘</kbd>${__("雙指")}</span></div>
          <div class="k"><span>${__("筆刷硬度")}</span><span><kbd>⇧</kbd>${__("雙指")}</span></div>
        </div>
        <div class="acts">
          <button id="mtCancel">${__("取消")}</button>
          <button id="mtOk" class="primary">${__("完成")}</button>
        </div>
      </div>
      <div id="mattestage"><canvas id="mattecv"></canvas><div id="mattehud"></div></div>`;
    document.body.append(root);
    localizeTitles(root);

    const $ = <T extends HTMLElement>(id: string): T => root.querySelector<T>(`#${id}`)!;
    const cv = $<HTMLCanvasElement>("mattecv");
    const ctx = cv.getContext("2d")!;
    const scratch: Record<string, HTMLCanvasElement> = {};

    const W = base.naturalWidth, H = base.naturalHeight;
    const strokes = document.createElement("canvas");
    strokes.width = W; strokes.height = H;

    let tool: "brush" | "erase" = "erase";   // 進來最常做的是把多圈到的擦掉
    let viewMode: "pink" | "cut" | "raw" | "fill" = "pink";
    /** 選好的材質。選了就即時看得到成品，不必先關掉編輯間再回頭填。 */
    let fill: { key: string; name: string; img: HTMLImageElement } | null = opts.initial ?? null;
    let brush = 20, hard = 70, feather = 0, choke = 0, inv = inverted;
    let scale = 1, tx = 0, ty = 0;
    let pointer: { x: number; y: number } | null = null;
    let drawing = false, panning = false, spaceDown = false, altDown = false;
    let last = { x: 0, y: 0 };
    let brushSlider = toSlider(brush);
    const undo: HTMLCanvasElement[] = [], redo: HTMLCanvasElement[] = [];

    // ── 遮罩合成：底層 →（羽化／外擴）→ 疊筆畫 → 反轉 ──
    //
    // 羽化與外擴是**自己逐畫素算的，不走 ctx.filter**。canvas 的 filter 屬性在
    // WKWebView 各版支援不一，同一份程式在 Chrome 看得到、在 App 裡什麼都沒發生——
    // 這種靜靜失效最難查（2026-08-25 小高回報「拉了沒辦法預覽」就是這個）。
    //
    // 做法是先算一次**有號距離場**（每個畫素離遮罩邊界幾個畫素、外正內負），
    // 之後兩根拉桿就只是對這個場做一次線性映射。先模糊再挪門檻那種近似做法試過，
    // 大幅度時邊緣位移根本對不上標示的數字，而且羽化拉大會讓整片背景浮起一層灰。
    //
    // 距離場只跟底層遮罩有關，兩根拉桿怎麼拉都不重算；映射結果也有快取，
    // 所以畫筆每動一下不會重算（不然一邊畫一邊卡）。
    /** 遮罩邊界的有號距離場（外正內負，單位是畫素）。只跟底層遮罩有關，
     *  兩根拉桿怎麼拉都不用重算——所以拖起來是即時的。第一次用到才算。 */
    // 距離場算在**工作解析度**上（長邊最多 1800）。實測 1066×1600 要 55ms、
    // 但一張 3024×4032 的原圖要 331ms——第一次碰拉桿就卡三分之一秒是看得出來的。
    // 羽化外擴本來就是軟操作，降解析度算完再放大回去看不出差別。
    const kw = Math.min(1, 1800 / Math.max(W, H));
    const SW = Math.max(1, Math.round(W * kw)), SH = Math.max(1, Math.round(H * kw));
    let sdf: Float32Array | null = null;
    const distances = (): Float32Array => {
      if (sdf) return sdf;
      const n = SW * SH;
      const c = document.createElement("canvas");
      c.width = SW; c.height = SH;
      const g = c.getContext("2d", { willReadFrequently: true })!;
      g.drawImage(base, 0, 0, SW, SH);
      const px = g.getImageData(0, 0, SW, SH).data;
      const outside = new Float32Array(n), inside = new Float32Array(n);
      for (let i = 0, j = 0; i < n; i++, j += 4) {
        const on = (px[j] * 0.2126 + px[j + 1] * 0.7152 + px[j + 2] * 0.0722) >= 128;
        outside[i] = on ? 0 : INF;   // 種子＝主體，量出來的是「離主體多遠」
        inside[i] = on ? INF : 0;    // 種子＝背景，量出來的是「離背景多遠」
      }
      edt2d(outside, SW, SH); edt2d(inside, SW, SH);
      const out = new Float32Array(n);
      // 換算回原圖的畫素數：拉桿上寫幾 px 就要是原圖的幾 px
      for (let i = 0; i < n; i++) out[i] = (Math.sqrt(outside[i]) - Math.sqrt(inside[i])) / kw;
      sdf = out;
      return out;
    };

    const levels: { key: string; cv: HTMLCanvasElement | null } = { key: "", cv: null };
    const baseLevels = (): HTMLCanvasElement => {
      const key = `${feather}|${choke}`;
      if (levels.cv && levels.key === key) return levels.cv;
      const out = document.createElement("canvas");
      out.width = W; out.height = H;
      const g = out.getContext("2d", { willReadFrequently: true })!;
      if (feather === 0 && choke === 0) {
        g.drawImage(base, 0, 0, W, H);      // 兩根都歸零＝原封不動，連距離場都不用算
      } else {
        const d = distances(), n = SW * SH;
        const small = document.createElement("canvas");
        small.width = SW; small.height = SH;
        const sg = small.getContext("2d")!;
        const img = sg.createImageData(SW, SH), px = img.data;
        for (let i = 0, j = 0; i < n; i++, j += 4) {
          // 距離場的 0 就是原本的邊：門檻挪到 choke ＝邊往外推 choke 個畫素，
          // 除以 feather ＝把過渡帶攤成 feather 個畫素寬。單位是真的畫素，不是估的。
          const v = feather > 0 ? (choke - d[i]) / feather + 0.5 : (d[i] <= choke ? 1 : 0);
          const c = v <= 0 ? 0 : v >= 1 ? 255 : (v * 255) | 0;
          px[j] = px[j + 1] = px[j + 2] = c; px[j + 3] = 255;
        }
        sg.putImageData(img, 0, 0);
        g.imageSmoothingQuality = "high";
        g.drawImage(small, 0, 0, W, H);
      }
      levels.key = key; levels.cv = out;
      return out;
    };

    const composed = (): HTMLCanvasElement => {
      const out = pad(scratch, "mask", W, H);
      const g = out.getContext("2d")!;
      g.drawImage(baseLevels(), 0, 0);
      g.drawImage(strokes, 0, 0);   // 筆畫永遠蓋最上面，拉桿動了也還在
      return out;
    };

    /** 灰階 → alpha。逐畫素轉：桌面版跑在 WKWebView，canvas 的 SVG 濾鏡引用不保證每版都在。 */
    const alphaOf = (): HTMLCanvasElement => {
      const src = composed();
      const a = pad(scratch, "alpha", W, H);
      const g = a.getContext("2d", { willReadFrequently: true })!;
      g.drawImage(src, 0, 0);
      const d = g.getImageData(0, 0, W, H), px = d.data;
      for (let i = 0; i < px.length; i += 4) {
        const lum = (px[i] * 0.2126 + px[i + 1] * 0.7152 + px[i + 2] * 0.0722) | 0;
        px[i] = px[i + 1] = px[i + 2] = 255;
        px[i + 3] = inv ? 255 - lum : lum;
      }
      g.putImageData(d, 0, 0);
      return a;
    };

    const fit = (): void => {
      const w = cv.clientWidth, h = cv.clientHeight;
      if (!w) return;
      scale = Math.min(w / W, h / H) * 0.92;
      tx = (w - W * scale) / 2; ty = (h - H * scale) / 2;
      draw();
    };
    const zoomTo = (n: number, ax: number, ay: number): void => {
      n = Math.min(24, Math.max(0.03, n));
      tx = ax - (ax - tx) * (n / scale); ty = ay - (ay - ty) * (n / scale);
      scale = n; draw();
    };
    const toImage = (e: PointerEvent): { x: number; y: number } =>
      ({ x: (e.offsetX - tx) / scale, y: (e.offsetY - ty) / scale });

    function draw(): void {
      const w = cv.clientWidth, h = cv.clientHeight;
      if (cv.width !== w) cv.width = w;
      if (cv.height !== h) cv.height = h;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.save();
      ctx.setTransform(scale, 0, 0, scale, tx, ty);
      ctx.imageSmoothingQuality = "high";
      if (viewMode === "raw") {
        ctx.drawImage(photo, 0, 0, W, H);
      } else if (viewMode === "pink") {
        // 粉紅＝會被去掉的地方
        ctx.drawImage(photo, 0, 0, W, H);
        const pink = pad(scratch, "pink", W, H);
        const pg = pink.getContext("2d")!;
        pg.fillStyle = "#ff3d8b"; pg.fillRect(0, 0, W, H);
        pg.globalCompositeOperation = "destination-out";
        pg.drawImage(alphaOf(), 0, 0);
        ctx.globalAlpha = 0.62; ctx.drawImage(pink, 0, 0); ctx.globalAlpha = 1;
      } else if (viewMode === "fill" && fill) {
        // 成品預覽：完整的原圖在下面，材質用同一張遮罩挖出形狀疊上去。
        // 這就是按下完成之後畫布上會長的樣子，邊修邊看。
        ctx.drawImage(photo, 0, 0, W, H);
        const t = pad(scratch, "tex", W, H);
        const tg = t.getContext("2d")!;
        cover(tg, fill.img, W, H);
        tg.globalCompositeOperation = "destination-in";
        tg.drawImage(alphaOf(), 0, 0);
        ctx.drawImage(t, 0, 0);
      } else {
        const cut = pad(scratch, "cut", W, H);
        const cg = cut.getContext("2d")!;
        cg.drawImage(photo, 0, 0, W, H);
        cg.globalCompositeOperation = "destination-in";
        cg.drawImage(alphaOf(), 0, 0);
        ctx.drawImage(cut, 0, 0);
      }
      ctx.restore();

      // 筆刷游標畫在螢幕座標，推近拉遠都看得到真正蓋到多大；
      // 小於 4px 的圈看不見，補一個十字準心
      if (pointer && !panning) {
        const r = Math.max(1, brush * scale / 2);
        const erasing = (altDown ? (tool === "erase" ? "brush" : "erase") : tool) === "erase";
        const col = erasing ? "#ff5c93" : "#5cffa8";
        ctx.beginPath(); ctx.arc(pointer.x, pointer.y, r, 0, Math.PI * 2);
        ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.stroke();
        ctx.beginPath(); ctx.arc(pointer.x, pointer.y, r + 1.2, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(0,0,0,.55)"; ctx.lineWidth = .8; ctx.stroke();
        if (r < 4) {
          ctx.beginPath();
          ctx.moveTo(pointer.x - 7, pointer.y); ctx.lineTo(pointer.x - 3, pointer.y);
          ctx.moveTo(pointer.x + 3, pointer.y); ctx.lineTo(pointer.x + 7, pointer.y);
          ctx.moveTo(pointer.x, pointer.y - 7); ctx.lineTo(pointer.x, pointer.y - 3);
          ctx.moveTo(pointer.x, pointer.y + 3); ctx.lineTo(pointer.x, pointer.y + 7);
          ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.stroke();
        }
      }
      $("mattehud").textContent =
        `${Math.round(scale * 100)}%　${brush}px　${(altDown ? tool === "erase" : tool === "brush") ? __("筆") : __("橡皮擦")}`;
    }

    const snap = (): HTMLCanvasElement => {
      const c = document.createElement("canvas");
      c.width = W; c.height = H;
      c.getContext("2d")!.drawImage(strokes, 0, 0);
      return c;
    };
    const pushUndo = (): void => {
      undo.push(snap());
      if (undo.length > 30) undo.shift();
      redo.length = 0; syncBtns();
    };
    const restore = (from: HTMLCanvasElement[], to: HTMLCanvasElement[]): void => {
      const c = from.pop(); if (!c) return;
      to.push(snap());
      const g = strokes.getContext("2d")!;
      g.clearRect(0, 0, W, H); g.drawImage(c, 0, 0);
      syncBtns(); draw();
    };

    const paint = (a: { x: number; y: number }, b: { x: number; y: number }): void => {
      const g = strokes.getContext("2d")!;
      const eff = altDown ? (tool === "erase" ? "brush" : "erase") : tool;
      const col = eff === "erase" ? "0,0,0" : "255,255,255";
      const r = Math.max(0.5, brush / 2);
      const inner = Math.max(0, Math.min(0.999, hard / 100));
      const stamp = (x: number, y: number): void => {
        if (hard >= 100) { g.fillStyle = `rgba(${col},1)`; }
        else {
          const grd = g.createRadialGradient(x, y, r * inner, x, y, r);
          grd.addColorStop(0, `rgba(${col},1)`); grd.addColorStop(1, `rgba(${col},0)`);
          g.fillStyle = grd;
        }
        g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
      };
      const dx = b.x - a.x, dy = b.y - a.y;
      const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / Math.max(0.5, r * 0.35)));
      for (let i = 0; i <= steps; i++) stamp(a.x + dx * i / steps, a.y + dy * i / steps);
    };

    // ── UI 綁定 ──
    const press = (el: HTMLElement, on: boolean): void => { el.classList.toggle("on", on); };
    const syncTool = (): void => {
      press($("mtBrush"), tool === "brush"); press($("mtErase"), tool === "erase");
    };
    const syncView = (): void => {
      press($("mtVPink"), viewMode === "pink"); press($("mtVCut"), viewMode === "cut");
      press($("mtVRaw"), viewMode === "raw"); press($("mtVFill"), viewMode === "fill");
      ($("mtVFill") as HTMLButtonElement).disabled = !fill;
    };
    const syncFill = (): void => {
      $("mtFill").querySelectorAll<HTMLButtonElement>("button").forEach((n) => {
        press(n, (n.dataset.tex ?? "") === (fill ? fill.key : ""));
      });
    };
    const syncInv = (): void => { press($("mtKeep"), !inv); press($("mtDrop"), inv); };
    const syncBtns = (): void => {
      ($("mtUndo") as HTMLButtonElement).disabled = undo.length === 0;
      ($("mtRedo") as HTMLButtonElement).disabled = redo.length === 0;
    };
    const syncVals = (): void => {
      $("mtSizeV").textContent = `${brush} px`;
      $("mtHardV").textContent = `${hard}%`;
      $("mtFeaV").textContent = `${feather.toFixed(1)} px`;
      $("mtChoV").textContent = `${choke > 0 ? "+" : ""}${choke} px`;
      $<HTMLInputElement>("mtSize").value = String(toSlider(brush));
      $<HTMLInputElement>("mtHard").value = String(hard);
    };
    const setBrush = (v: number, fromWheel = false): void => {
      brush = Math.min(BRUSH_MAX, Math.max(BRUSH_MIN, Math.round(v)));
      if (!fromWheel) brushSlider = toSlider(brush);
      syncVals(); draw();
    };
    const setHard = (v: number): void => { hard = Math.min(100, Math.max(0, Math.round(v))); syncVals(); draw(); };

    $("mtBrush").onclick = () => { tool = "brush"; syncTool(); draw(); };
    $("mtErase").onclick = () => { tool = "erase"; syncTool(); draw(); };
    $("mtKeep").onclick = () => { inv = false; syncInv(); draw(); };
    $("mtDrop").onclick = () => { inv = true; syncInv(); draw(); };
    $("mtVPink").onclick = () => { viewMode = "pink"; syncView(); draw(); };
    $("mtVCut").onclick = () => { viewMode = "cut"; syncView(); draw(); };
    $("mtVRaw").onclick = () => { viewMode = "raw"; syncView(); draw(); };
    $("mtVFill").onclick = () => { if (fill) { viewMode = "fill"; syncView(); draw(); } };
    $("mtFill").querySelectorAll<HTMLButtonElement>("button").forEach((n) => {
      n.onclick = () => void (async () => {
        const k = n.dataset.tex ?? "";
        if (k === "") { fill = null; viewMode = "pink"; syncFill(); syncView(); draw(); return; }
        $("mtFill").querySelectorAll("button").forEach((x) => { (x as HTMLButtonElement).disabled = true; });
        try {
          const r = await opts.resolve(k === "*" ? null : k);
          if (r) {
            fill = { key: k, ...r }; viewMode = "fill";
            // 自選那顆也換成剛選的那張縮圖——選了什麼要看得見
            if (k === "*") { n.classList.remove("plain", "dashed"); n.classList.add("photo");
                             n.innerHTML = "";
                             n.style.backgroundImage = `url('${r.img.src}')`; }
          }
        } finally {
          $("mtFill").querySelectorAll("button").forEach((x) => { (x as HTMLButtonElement).disabled = false; });
          syncFill(); syncView(); draw();
        }
      })();
    });
    $("mtUndo").onclick = () => restore(undo, redo);
    $("mtRedo").onclick = () => restore(redo, undo);
    $<HTMLInputElement>("mtSize").oninput = (e) => {
      brushSlider = +(e.target as HTMLInputElement).value; setBrush(toBrush(brushSlider), true);
    };
    $<HTMLInputElement>("mtHard").oninput = (e) => setHard(+(e.target as HTMLInputElement).value);
    $<HTMLInputElement>("mtFea").oninput = (e) => { feather = +(e.target as HTMLInputElement).value; syncVals(); draw(); };
    $<HTMLInputElement>("mtCho").oninput = (e) => { choke = +(e.target as HTMLInputElement).value; syncVals(); draw(); };

    // ── 指標 ──
    cv.addEventListener("pointerdown", (e) => {
      cv.setPointerCapture(e.pointerId);
      if (e.button === 2 || spaceDown) { panning = true; last = { x: e.offsetX, y: e.offsetY }; return; }
      drawing = true; pushUndo();
      const p = toImage(e); last = p; paint(p, p); draw();
    });
    cv.addEventListener("pointermove", (e) => {
      pointer = { x: e.offsetX, y: e.offsetY };
      if (panning) { tx += e.offsetX - last.x; ty += e.offsetY - last.y; last = { x: e.offsetX, y: e.offsetY }; draw(); return; }
      if (drawing) { const p = toImage(e); paint(last, p); last = p; draw(); return; }
      draw();
    });
    const endStroke = (): void => { drawing = false; panning = false; };
    cv.addEventListener("pointerup", endStroke);
    cv.addEventListener("pointercancel", endStroke);
    cv.addEventListener("pointerleave", () => { pointer = null; endStroke(); draw(); });
    cv.addEventListener("contextmenu", (e) => e.preventDefault());
    cv.addEventListener("wheel", (e) => {
      e.preventDefault();
      // ⇧＋滾動在 macOS 會被轉成橫向捲動，量跑到 deltaX——兩軸都要看
      const d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      if (e.metaKey) { brushSlider = Math.min(1000, Math.max(0, brushSlider - d * 0.9)); setBrush(toBrush(brushSlider), true); return; }
      if (e.shiftKey) { setHard(hard - d * 0.35); return; }
      zoomTo(scale * Math.exp(-e.deltaY * 0.0022), e.offsetX, e.offsetY);
    }, { passive: false });

    const onKey = (e: KeyboardEvent): void => {
      const cmd = e.metaKey || e.ctrlKey;
      if (e.altKey && !altDown) { altDown = true; draw(); }
      if (e.code === "Space") { spaceDown = true; e.preventDefault(); return; }
      if (e.key === "Escape") { e.preventDefault(); close(null); return; }
      if (cmd && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? restore(redo, undo) : restore(undo, redo); return; }
      if (cmd && e.key.toLowerCase() === "i") { e.preventDefault(); inv = !inv; syncInv(); draw(); return; }
      if (cmd && e.key === "0") { e.preventDefault(); fit(); return; }
      if (cmd && e.key === "1") { e.preventDefault(); zoomTo(1, cv.clientWidth / 2, cv.clientHeight / 2); return; }
      if (cmd && e.key === "Enter") { e.preventDefault(); void finish(); return; }
      if (cmd) return;
      if (e.key === "[") { e.shiftKey ? setHard(hard - 5) : setBrush(brush - Math.max(1, brush * 0.15)); return; }
      if (e.key === "]") { e.shiftKey ? setHard(hard + 5) : setBrush(brush + Math.max(1, brush * 0.15)); return; }
      if (e.key === "{") { setHard(hard - 5); return; }
      if (e.key === "}") { setHard(hard + 5); return; }
      if (e.key === "b" || e.key === "B") { tool = "brush"; syncTool(); draw(); return; }
      if (e.key === "e" || e.key === "E") { tool = "erase"; syncTool(); draw(); return; }
      if (e.key === "x" || e.key === "X") { tool = tool === "erase" ? "brush" : "erase"; syncTool(); draw(); return; }
      if (e.key === "\\") { viewMode = viewMode === "pink" ? "cut" : "pink"; syncView(); draw(); }
    };
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.code === "Space") spaceDown = false;
      if (!e.altKey && altDown) { altDown = false; draw(); }
    };
    const onResize = (): void => draw();
    addEventListener("keydown", onKey, true);
    addEventListener("keyup", onKeyUp, true);
    addEventListener("resize", onResize);

    function close(result: MatteEdit | null): void {
      removeEventListener("keydown", onKey, true);
      removeEventListener("keyup", onKeyUp, true);
      removeEventListener("resize", onResize);
      root.remove();
      resolve(result);
    }

    /// 完成：把三層烤成一張灰階 PNG。反轉**不烤進去**——它是 block 的顯示設定，
    /// 烤進去的話下次進來會分不清「遮罩本來就這樣」還是「被反轉過」。
    async function finish(): Promise<void> {
      const out = document.createElement("canvas");
      out.width = W; out.height = H;
      out.getContext("2d")!.drawImage(composed(), 0, 0);
      close({ png: out.toDataURL("image/png").split(",")[1], inverted: inv,
              fill: fill?.name });
    }

    $("mtCancel").onclick = () => close(null);
    $("mtOk").onclick = () => void finish();

    syncTool(); syncFill(); syncView(); syncInv(); syncBtns(); syncVals();
    requestAnimationFrame(fit);
  });
}
