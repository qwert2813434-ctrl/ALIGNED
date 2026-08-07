// 影片修剪視窗——底片條＋進出點把手＋播頭，照 iOS VideoTrimView 的語彙
// （取消／加入、拖中段整段平移、最短 1 秒）。
//
// 與 iPad 的兩處刻意不同（2026-08-07 小高拍板）：
// 1. **選配，不強制**：Mac 匯入照收整支，想剪再從右鍵開。桌面有硬碟空間，
//    而且這裡是拿來做分鏡展示的，匯入就逼人剪 30 秒是妨礙。
// 2. **不設上限**：iPad 硬卡 30 秒（輪播要短、匯出要便宜），Mac 不卡。
//    只在匯入超過 30 秒時軟提醒一句——**格式上完全相容**（查證過：30 秒只存在於
//    iOS 匯入 UI 的 maxDuration，載入／存檔／預覽／匯出全都沒有時長假設），
//    長片回 iPad 會正常開，只是專案檔大、iPad 匯出慢。
//
// 真正的裁切交給打包進 App 的 alignvideo（AVFoundation，與 iOS 同一組
// HighestQuality／.mov／timeRange 參數）——這裡只負責選範圍。

const THUMBS = 12;          // 底片條抓幾格（夠看出內容變化，又不會讓 seek 太久）
const MIN_DURATION = 1;     // 最短選取（與 iOS 同值）

export interface TrimResult { start: number; end: number }

/**
 * 拖曳後的新範圍。抽成純函式是為了測得到——三種拖曳的邊界條件
 * （夾住最短長度、整段平移不出界且長度不變）用眼睛看不出對錯。
 *
 * @param kind  in＝拖進點、out＝拖出點、win＝拖中段整段平移
 * @param t     指標當下對應的時間
 * @param start 這次拖曳「起手時」的範圍與指標時間
 */
export function nextRange(
  kind: "in" | "out" | "win",
  t: number,
  start: { in: number; out: number; at: number },
  dur: number,
): TrimResult {
  const min = MIN_DURATION;
  if (kind === "in") {
    return { start: Math.max(0, Math.min(t, start.out - min)), end: start.out };
  }
  if (kind === "out") {
    return { start: start.in, end: Math.min(dur, Math.max(t, start.in + min)) };
  }
  const len = start.out - start.in;
  const s = Math.max(0, Math.min(dur - len, start.in + (t - start.at)));
  return { start: s, end: s + len };
}

const fmt = (s: number): string => {
  const m = Math.floor(s / 60), r = s - m * 60;
  return `${m}:${r.toFixed(1).padStart(4, "0")}`;
};

/** 抓 n 格縮圖鋪成底片條。逐格 seek——影片解碼在 WKWebView 上不能同時跑太多。 */
async function filmstrip(video: HTMLVideoElement, into: HTMLElement, n: number): Promise<void> {
  const dur = video.duration;
  if (!isFinite(dur) || dur <= 0) return;
  const h = 46, w = Math.round(h * (video.videoWidth / video.videoHeight || 1.5));
  for (let i = 0; i < n; i++) {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    await new Promise<void>((done) => {
      const on = (): void => { video.removeEventListener("seeked", on); done(); };
      video.addEventListener("seeked", on);
      video.currentTime = Math.min(dur - 0.01, (dur * (i + 0.5)) / n);
    });
    c.getContext("2d")!.drawImage(video, 0, 0, w, h);
    into.append(c);
  }
}

/**
 * 開修剪視窗。回選好的範圍，取消回 null。
 * `url` 要是能播的來源（App 內走媒體伺服器，瀏覽器走一般網址）。
 */
export function openTrim(url: string, name: string): Promise<TrimResult | null> {
  return new Promise((resolve) => {
    const root = document.createElement("div");
    root.id = "trimsheet";
    root.innerHTML = `
      <div id="trimcard">
        <h2>修剪影片<span id="trimname"></span></h2>
        <video id="trimvid" muted playsinline></video>
        <div id="trimbar">
          <div id="trimstrip"></div>
          <div id="trimdim" class="left"></div><div id="trimdim2" class="right"></div>
          <div id="trimwin"></div>
          <div id="trimin" class="grip"></div><div id="trimout" class="grip"></div>
          <div id="trimhead"></div>
        </div>
        <div id="trimmeta">
          <button id="trimplay" class="icon" title="播放／暫停"></button>
          <span id="trimtimes"></span>
          <span class="spacer"></span>
          <span id="trimwarn"></span>
        </div>
        <div class="acts">
          <button id="trimcancel">取消</button>
          <button id="trimreset">整支</button>
          <button id="trimok" class="primary">完成</button>
        </div>
      </div>`;
    document.body.append(root);
    const $ = <T extends HTMLElement>(id: string): T => root.querySelector<T>(`#${id}`)!;
    const vid = $<HTMLVideoElement>("trimvid");
    const bar = $("trimbar"), win = $("trimwin"), head = $("trimhead");
    const dimL = $("trimdim"), dimR = $("trimdim2");
    const gIn = $("trimin"), gOut = $("trimout");
    $("trimname").textContent = name;

    let dur = 0, inT = 0, outT = 0, playing = false;
    const PLAY = '<svg width="13" height="13" viewBox="0 0 18 18" fill="currentColor"><path d="M5.5 3.6l9 5.4-9 5.4z"/></svg>';
    const PAUSE = '<svg width="13" height="13" viewBox="0 0 18 18" fill="currentColor"><rect x="4.6" y="3.6" width="3.2" height="10.8" rx="1"/><rect x="10.2" y="3.6" width="3.2" height="10.8" rx="1"/></svg>';

    const pct = (t: number): number => (dur > 0 ? (t / dur) * 100 : 0);
    const paint = (): void => {
      win.style.left = `${pct(inT)}%`;
      win.style.width = `${pct(outT - inT)}%`;
      // 把手夾在條內：拉到兩端時整根還看得見（不然圓角會裁掉一半）
      const grip = (t: number): string => `clamp(7px, ${pct(t)}%, calc(100% - 7px))`;
      gIn.style.left = grip(inT);
      gOut.style.left = grip(outT);
      dimL.style.width = `${pct(inT)}%`;
      dimR.style.left = `${pct(outT)}%`;
      dimR.style.width = `${100 - pct(outT)}%`;
      head.style.left = `${pct(vid.currentTime)}%`;
      const sel = outT - inT;
      $("trimtimes").textContent = `${fmt(inT)} – ${fmt(outT)}　選取 ${sel.toFixed(1)} 秒（原長 ${dur.toFixed(1)} 秒）`;
      // 軟提醒：超過 30 秒回 iPad 會很吃力（不是錯誤，只是誠實告知）
      $("trimwarn").textContent = sel > 30 ? "超過 30 秒——回 iPad 匯出會比較慢、專案檔也大" : "";
    };

    const timeAt = (clientX: number): number => {
      const r = bar.getBoundingClientRect();
      return Math.max(0, Math.min(dur, ((clientX - r.left) / r.width) * dur));
    };

    // 三種拖曳：進點、出點、中段（整段平移，保持長度）
    const grab = (el: HTMLElement, kind: "in" | "out" | "win"): void => {
      el.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        el.setPointerCapture(e.pointerId);
        const s0 = { in: inT, out: outT, at: timeAt(e.clientX) };
        const onMove = (ev: PointerEvent): void => {
          const r = nextRange(kind, timeAt(ev.clientX), s0, dur);
          inT = r.start; outT = r.end;
          if (vid.currentTime < inT || vid.currentTime > outT) vid.currentTime = inT;
          paint();
        };
        const onUp = (): void => {
          el.removeEventListener("pointermove", onMove);
          el.removeEventListener("pointerup", onUp);
        };
        el.addEventListener("pointermove", onMove);
        el.addEventListener("pointerup", onUp);
      });
    };
    grab(gIn, "in"); grab(gOut, "out"); grab(win, "win");
    // 點底片條空白處＝把播頭移過去（在選取範圍內才有意義）
    bar.addEventListener("pointerdown", (e) => {
      if (e.target !== bar && e.target !== $("trimstrip")) return;
      vid.currentTime = Math.max(inT, Math.min(outT, timeAt(e.clientX)));
      paint();
    });

    const setPlay = (on: boolean): void => {
      playing = on;
      $("trimplay").innerHTML = on ? PAUSE : PLAY;
      if (on) vid.play().catch(() => setPlay(false)); else vid.pause();
    };
    $("trimplay").addEventListener("click", () => setPlay(!playing));
    vid.addEventListener("timeupdate", () => {
      if (vid.currentTime > outT || vid.currentTime < inT - 0.05) vid.currentTime = inT;   // 只在選取範圍內循環
      paint();
    });

    const close = (r: TrimResult | null): void => {
      setPlay(false);
      vid.removeAttribute("src"); vid.load();
      root.remove();
      document.removeEventListener("keydown", onKey, true);
      resolve(r);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") { e.stopPropagation(); close(null); }
      if (e.key === "Enter") { e.stopPropagation(); close({ start: inT, end: outT }); }
      if (e.key === " ") { e.preventDefault(); e.stopPropagation(); setPlay(!playing); }
    };
    document.addEventListener("keydown", onKey, true);
    $("trimcancel").addEventListener("click", () => close(null));
    $("trimok").addEventListener("click", () => close({ start: inT, end: outT }));
    $("trimreset").addEventListener("click", () => { inT = 0; outT = dur; vid.currentTime = 0; paint(); });
    root.addEventListener("pointerdown", (e) => { if (e.target === root) close(null); });

    vid.addEventListener("loadedmetadata", () => {
      dur = vid.duration;
      inT = 0; outT = dur;
      paint();
      setPlay(false);
      void filmstrip(vid, $("trimstrip"), THUMBS).then(() => { vid.currentTime = 0; paint(); });
    }, { once: true });
    vid.src = url;
  });
}
