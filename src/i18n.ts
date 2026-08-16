import { en } from "./locales/en";
import { IS_MAC } from "./platform";

// i18n 骨架。照抄 STB app/src/i18n.ts（跑過多個版本的設計），差異：目前只有 en，
// 日文之後補一個 locales/ja.ts 進 DICTS 就好。
//
// key＝繁中原文（gettext 式）。這個選擇的重點在於：
// 函式叫 __／__f 不叫 t／tf（跟 STB 不同）：這個 codebase 拿 t 當區域變數名的地方
// 太多（render.ts 15 處、editor.ts 10 處…），import 一個 t 進來遲早被 shadow 掉，
// 而且會是「呼叫到區域變數」這種難查的錯。__ 目前零使用，撞不到。
//   繁中語系不查表，直接 return 傳進來的字串 —— 中文使用者走的是跟包 t() 之前
//   一模一樣的程式路徑，行為不可能改變。en 包缺譯時也回繁中原文，不會出現空字串。
//
// 🔴 不可以包 t() 的東西：
//   1. schema 值 —— 存進 project.json 的 key 與 value（FILTER_KEYS、FONT_CHOICES.value、
//      CANVAS_PRESETS.key…）。翻了＝既有專案讀不回來。
//   2. 量測參考字 —— render.ts / editor.ts 裡 measureText("字") 的那個「字」。
//      它是拿來取 fontBoundingBox 算行高的樣本字形，不是介面文字。
//      換成別的字＝所有既有專案的行高整批位移，而且不會報錯。

export type Locale = "zh" | "en";
const DICTS: Record<"en", Record<string, string>> = { en };
const LANG_ATTR: Record<Locale, string> = { zh: "zh-Hant", en: "en" };

function detect(): Locale {
  // QA 後門：?lang=en 強制語系（只讀不存，重載即回歸正常偵測）
  const q = new URLSearchParams(location.search).get("lang");
  if (q === "zh" || q === "en") return q;
  const saved = localStorage.getItem("alignedLang");
  if (saved === "zh" || saved === "en") return saved;
  return (navigator.language || "").toLowerCase().startsWith("zh") ? "zh" : "en";
}

const cur: Locale = detect();
// <html lang> 帶動字型堆疊（style.css 依 lang 選中西文字體）
document.documentElement.lang = LANG_ATTR[cur];

export function locale(): Locale { return cur; }

export function setLocale(l: Locale) {
  if (l === cur) return;
  localStorage.setItem("alignedLang", l);
  location.reload(); // 字串散在各渲染器，整頁重載最穩（App 自動存檔，無資料風險）
}

// ⌘⇧⌥ 是 Apple 鍵盤的字，Windows 鍵盤上沒有這幾顆。介面字樣照平台換，
// 按鍵判斷不動（那邊本來就同時吃 metaKey 與 ctrlKey）。長的組合先換，才不會被短的吃掉。
const KEYGLYPH: [RegExp, string][] = [
  [/⇧⌘/g, "Ctrl+Shift+"], [/⌥⌘/g, "Ctrl+Alt+"],
  [/⌘([＋−+])/g, "Ctrl$1"],   // 「⌘＋滾輪」不要變成「Ctrl++滾輪」
  [/⌘/g, "Ctrl+"], [/⇧/g, "Shift+"], [/⌥/g, "Alt+"],
];
/** 介面上的快捷鍵字樣。Mac 原樣返回＝這支在 Mac 上等於沒作用。 */
export function keys(s: string): string {
  return IS_MAC ? s : KEYGLYPH.reduce((t, [re, to]) => t.replace(re, to), s);
}

export function __(s: string): string {
  return keys(cur === "zh" ? s : DICTS[cur][s] ?? s);
}

// index.html 的按鈕提示都寫在 title="…" 屬性裡。與其去改 HTML，開機掃一次全部翻掉，
// 之後新加的按鈕也自動涵蓋。中文語系時 t() 原樣返回＝這個迴圈等於沒作用。
export function localizeTitles(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>("[title]").forEach((el) => { el.title = __(el.title); });
  if (IS_MAC) return;
  // 直接寫在標籤內文的鍵名（首頁的 .k 徽章、畫布提示條）走不到 title 那條，一起掃
  const w = document.createTreeWalker(root as Node, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode())
    if (n.nodeValue && /[⌘⇧⌥]/.test(n.nodeValue)) n.nodeValue = keys(n.nodeValue);
}

// 帶參數字串：__f("已選 {n} 個元件", { n: 3 })
// key 用 {占位符} 的原文，譯文可以重排語序。
export function __f(s: string, vars: Record<string, string | number>): string {
  let out = __(s);
  for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(String(v)); // 不用 replaceAll：tsconfig lib=ES2020
  return out;
}
