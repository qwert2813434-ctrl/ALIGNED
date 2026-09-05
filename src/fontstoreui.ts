import { uiDark } from "./platform";
// 字體商店的桌面 UI：齒輪選單「字體商店」開的置中面板。
// 每套字用預先渲好的樣張圖（未下載前這台機器沒有這套字，只能用圖），
// 亮暗跟系統主題走；點下載即裝進字型選單、已裝可移除。
import { __ } from "./i18n";
import {
  type StoreFont, fetchCatalog, getCatalog, getInstalled, storefront,
  downloadStoreFont, removeStoreFont, installedRev,
} from "./core/fontstore";

const CATS: [string, string][] = [
  ["tc", "繁中完整"], ["jp", "日系展示"], ["latin", "歐文"], ["kr", "韓文"],
];

let overlay: HTMLDivElement | null = null;

export function openFontStore(onChanged: () => void): void {
  if (overlay) return;
  overlay = document.createElement("div");
  overlay.id = "fontstore";
  overlay.innerHTML = `<div class="fs-panel">
    <div class="fs-head">
      <span class="fs-title">${__("字體商店")}</span>
      <button class="fs-close" aria-label="${__("關閉")}">✕</button>
    </div>
    <div class="fs-body">${__("讀取字體清單中…")}</div>
    <div class="fs-foot"></div>
  </div>`;
  injectStyle();
  document.body.append(overlay);
  overlay.addEventListener("pointerdown", (e) => { if (e.target === overlay) close(); });
  overlay.querySelector(".fs-close")!.addEventListener("click", close);
  void render(onChanged);
}

function close(): void { overlay?.remove(); overlay = null; }

async function render(onChanged: () => void): Promise<void> {
  await fetchCatalog();
  if (!overlay) return;
  const body = overlay.querySelector<HTMLDivElement>(".fs-body")!;
  const cat = getCatalog();
  if (!cat) {
    body.innerHTML = "";
    const retry = document.createElement("button");
    retry.className = "fs-retry";
    retry.textContent = __("讀不到字體清單——檢查網路後點一下重試");
    retry.addEventListener("click", () => { body.textContent = __("讀取字體清單中…"); void render(onChanged); });
    body.append(retry);
    return;
  }
  const dark = uiDark();   // 手動外觀（齒輪選單）優先，沒設才是系統
  const installed = getInstalled();
  body.innerHTML = "";
  for (const [key, title] of CATS) {
    const fonts = storefront().filter((f) => f.cat === key);
    if (!fonts.length) continue;
    const h = document.createElement("div");
    h.className = "fs-cat";
    h.textContent = `${__(title)}　${fonts.length}`;
    body.append(h);
    for (const f of fonts) body.append(row(f, cat.baseURL, dark, installed.has(f.family), onChanged));
  }
  overlay.querySelector<HTMLDivElement>(".fs-foot")!.textContent =
    `${cat.attribution}${__("。全部為開放授權可商業使用；下載的字體只進 ALIGNED，不裝進系統。")}`;
}

function row(f: StoreFont, base: string, dark: boolean, isInstalled: boolean, onChanged: () => void): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "fs-row";
  const img = document.createElement("img");
  img.src = `${base}${f.preview}${dark ? "_dark" : "_light"}.png`;
  img.alt = f.label;
  const info = document.createElement("div");
  info.className = "fs-info";
  info.innerHTML = `<span class="fs-label"></span><span class="fs-size">${(f.bytes / 1048576).toFixed(1)} MB</span>`;
  info.querySelector(".fs-label")!.textContent = f.label;
  const act = document.createElement("button");
  act.className = "fs-act";
  const setState = (state: "get" | "busy" | "done" | "update"): void => {
    act.dataset.state = state;
    act.textContent = state === "get" ? __("下載") : state === "busy" ? "…"
      : state === "update" ? __("更新") : __("已安裝");
  };
  // 有新版（catalog rev 比安裝紀錄新）＝「更新」；點了強制重抓（第一批 #6）
  const hasUpdate = isInstalled && (f.rev ?? 0) > installedRev(f.family);
  setState(hasUpdate ? "update" : isInstalled ? "done" : "get");
  act.addEventListener("click", () => {
    if (act.dataset.state === "busy") return;
    if (act.dataset.state === "done") {
      void removeStoreFont(f).then(() => { setState("get"); onChanged(); });
      return;
    }
    const force = act.dataset.state === "update";
    setState("busy");
    downloadStoreFont(f, (p) => { act.textContent = `${Math.round(p * 100)}%`; }, force)
      .then(() => { setState("done"); onChanged(); })
      .catch(() => setState(force ? "update" : "get"));
  });
  el.append(img, info, act);
  return el;
}

function injectStyle(): void {
  if (document.getElementById("fs-style")) return;
  const s = document.createElement("style");
  s.id = "fs-style";
  s.textContent = `
  #fontstore { position: fixed; inset: 0; z-index: 60;
    background: color-mix(in srgb, var(--ink) 18%, transparent);
    display: flex; align-items: center; justify-content: center; }
  #fontstore .fs-panel { width: min(560px, 92vw); max-height: 82vh; display: flex;
    flex-direction: column; background: var(--card); color: var(--ink);
    border: 1px solid var(--line); border-radius: 14px; overflow: hidden; }
  #fontstore .fs-head { display: flex; align-items: center; padding: 14px 18px 10px; }
  #fontstore .fs-title { font-size: 14px; font-weight: 600; flex: 1; }
  #fontstore .fs-close { border: none; background: transparent; color: var(--ink2);
    font-size: 14px; cursor: pointer; padding: 4px 6px; }
  #fontstore .fs-body { overflow-y: auto; padding: 0 18px 8px; font-size: 13px; color: var(--ink2); }
  #fontstore .fs-cat { font-size: 12px; font-weight: 600; letter-spacing: .12em;
    color: var(--ink2); margin: 16px 0 6px; }
  #fontstore .fs-row { display: flex; flex-direction: column; gap: 6px;
    padding: 10px 0; border-top: 1px solid var(--line); }
  #fontstore .fs-row img { height: 26px; width: auto; max-width: 100%;
    object-fit: contain; object-position: left; align-self: flex-start; }
  #fontstore .fs-info { display: flex; align-items: baseline; gap: 8px; }
  #fontstore .fs-label { font-size: 13px; font-weight: 600; color: var(--ink); }
  #fontstore .fs-size { font-size: 11px; color: var(--ink2); flex: 1; }
  #fontstore .fs-act { border: 1px solid var(--line); background: transparent;
    color: var(--ink); font-size: 12px; border-radius: 8px; padding: 3px 12px;
    cursor: pointer; align-self: flex-end; margin-top: -22px; }
  #fontstore .fs-act:hover { background: color-mix(in srgb, var(--ink) 9%, transparent); }
  #fontstore .fs-act[data-state="done"] { color: var(--ink2); }
  #fontstore .fs-retry { border: 1px solid var(--line); background: transparent;
    color: var(--ink); font-size: 13px; border-radius: 8px; padding: 8px 14px;
    cursor: pointer; margin: 18px 0; }
  #fontstore .fs-foot { padding: 10px 18px 14px; font-size: 11px; color: var(--ink2);
    border-top: 1px solid var(--line); }`;
  document.head.append(s);
}
