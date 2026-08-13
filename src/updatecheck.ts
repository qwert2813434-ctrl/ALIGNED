import { __, __f } from "./i18n";
// 更新提醒（STB 同款機制，理由也相同：離線 App 沒人知道出新版了）。
// 開 App 時抓一份小 JSON 比版本，有新版才浮一條橫幅＋下載連結；不自動下載安裝
// （那要 Tauri updater＋簽章 manifest，工大很多）。
// 離線／抓不到／JSON 壞掉＝安靜跳過，絕不打擾——這是離線 App 的底線。
// 來源＝小高工具間（GitHub Pages 回 access-control-allow-origin: *，webview 直接 fetch 得到）。
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";

const FEED = "https://qwert2813434-ctrl.github.io/tools/aligned-latest.json";
const PAGE = "https://github.com/qwert2813434-ctrl/ALIGNED";
const SKIP_KEY = "align.skipVersion";   // 「略過此版」記在這，出下一版才再提醒

interface Feed { version?: string; url?: string; notes?: string }

/** 純數字比較（1.10.0 > 1.9.0），不引語意化版本套件。 */
export function isNewer(remote: string, local: string): boolean {
  const a = remote.split(".").map((n) => parseInt(n, 10) || 0);
  const b = local.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/** 開機自動檢查安靜跳過一切；`manual`（齒輪選單的「檢查更新」）要回結果給人看，
 *  且無視「略過此版」——人主動按了就是想知道。 */
export async function checkUpdate(manual = false): Promise<"update" | "latest" | "error"> {
  try {
    const [r, local] = await Promise.all([fetch(FEED, { cache: "no-store" }), getVersion()]);
    if (!r.ok) return "error";
    const d = (await r.json()) as Feed;
    if (!d.version || !isNewer(d.version, local)) return "latest";
    if (!manual && localStorage.getItem(SKIP_KEY) === d.version) return "update";
    banner(d.version, d.notes ?? "", d.url);
    return "update";
  } catch { return "error"; /* 離線或網路不通：開機路徑安靜跳過 */ }
}

function banner(version: string, notes: string, dmgUrl?: string): void {
  const el = document.createElement("div");
  el.className = "updbar";
  const txt = document.createElement("span");
  txt.className = "updtxt";
  const b = document.createElement("b");
  b.textContent = __f("有新版 {version}", { version });
  txt.append(b);
  if (notes) txt.append(`　${notes}`);
  const go = document.createElement("button");
  go.className = "updgo";
  go.textContent = __("前往下載");
  go.addEventListener("click", () => {
    void invoke("open_url", { url: dmgUrl ?? PAGE });
    el.remove();
  });
  const skip = document.createElement("button");
  skip.textContent = __("略過此版");
  skip.addEventListener("click", () => { localStorage.setItem(SKIP_KEY, version); el.remove(); });
  const x = document.createElement("button");
  x.textContent = "✕";
  x.title = __("關閉");
  x.addEventListener("click", () => el.remove());
  el.append(txt, go, skip, x);
  document.body.append(el);
}
