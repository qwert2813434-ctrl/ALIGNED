// ALIGN Core — 字體商店（iOS FontStore 的桌面版）。
//
// 目錄在 aligned-app.github.io/fonts/catalog.json（加字免發版）；選集照搬
// 壹加壹 What'Sub、致謝寫在商店頁尾。下載的字檔存 IndexedDB——webview 私有、
// 重開還在、Mac／Windows 同一份程式，**不裝進系統**：不撞使用者自己裝的
// 同名字體、不污染別軟體的字體選單。專案照舊只存 PostScript 名，跟 iOS
// 同一套儲存模型，同一份 .alignproj 兩邊長一樣。
import { registerStoreFamily, unregisterStoreFamily, canRender } from "./fonts";

export interface StoreWeight { weight: number; ps: string; file: string; bytes: number }
export interface StoreFont {
  family: string; label: string; cat: string;
  license: string; bytes: number; preview: string; weights: StoreWeight[];
}
export interface StoreCatalog {
  version: number; baseURL: string; attribution: string; fonts: StoreFont[];
}

export const CATALOG_URL = "https://aligned-app.github.io/fonts/catalog.json";
/** 桌面版已內嵌的家族——商店隱藏，不給重複下載（iOS 端另有自己的名單）。 */
const BUNDLED = new Set(["Noto Serif TC", "Playfair Display", "Huninn", "Inter", "Archivo Black"]);

let catalog: StoreCatalog | null = null;
const installedMeta = new Map<string, StoreFont>();

export function getInstalled(): ReadonlySet<string> { return new Set(installedMeta.keys()); }
export function getCatalog(): StoreCatalog | null { return catalog; }
export function storefront(): StoreFont[] {
  return (catalog?.fonts ?? []).filter((f) => !BUNDLED.has(f.family));
}

export async function fetchCatalog(): Promise<StoreCatalog | null> {
  if (catalog) return catalog;
  try {
    catalog = (await (await fetch(CATALOG_URL)).json()) as StoreCatalog;
  } catch { /* 離線——回 null，UI 顯示重試 */ }
  return catalog;
}

// ── IndexedDB：files（"family/檔名" → ArrayBuffer）＋ meta（family → StoreFont） ──

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("align-fontstore", 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore("files");
      req.result.createObjectStore("meta");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idb<T>(store: string, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then((d) => new Promise<T>((resolve, reject) => {
    const req = run(d.transaction(store, mode).objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

// ── 註冊（iOS 端 appFont 的字階折疊，同一套規則） ──

function stepOf(w: number): number {
  return w < 250 ? 0 : w < 350 ? 1 : w < 550 ? 2 : w < 750 ? 3 : 4;
}

function familyKey(f: StoreFont): string {
  const sorted = [...f.weights].sort((a, b) => a.weight - b.weight);
  return (sorted.find((w) => w.weight === 400) ?? sorted[0]).ps;
}

/** 把一套已入庫的字型 add 進 document.fonts 並登記家族——量測鐵則：全 load 完才回。 */
async function activate(f: StoreFont): Promise<void> {
  for (const w of f.weights) {
    const buf = await idb<ArrayBuffer | undefined>("files", "readonly",
      (s) => s.get(`${f.family}/${w.file}`) as IDBRequest<ArrayBuffer | undefined>);
    if (!buf) throw new Error(`missing ${w.file}`);
    const face = new FontFace(w.ps, buf);
    await face.load();
    document.fonts.add(face);
  }
  let faces: string[] | null = null;
  if (f.weights.length > 1) {
    faces = Array.from({ length: 5 }, (_, i) => {
      const best = [...f.weights].sort((a, b) =>
        Math.abs(stepOf(a.weight) - i) - Math.abs(stepOf(b.weight) - i))[0];
      return best.ps;
    });
  }
  registerStoreFamily(familyKey(f), f.label, faces);
}

/** 開機還原：全部已裝家族重新 add＋登記。放進開機的 Promise.all，先於首次渲染。 */
export async function restoreStoreFonts(): Promise<void> {
  const metas = await idb<StoreFont[]>("meta", "readonly", (s) => s.getAll() as IDBRequest<StoreFont[]>).catch(() => []);
  for (const f of metas) {
    try {
      await activate(f);
      installedMeta.set(f.family, f);
    } catch { /* 檔案缺角的一套跳過，其餘照常 */ }
  }
}

export async function downloadStoreFont(f: StoreFont, onProgress?: (p: number) => void): Promise<void> {
  if (installedMeta.has(f.family) || !catalog) return;
  let got = 0;
  for (const w of f.weights) {
    const buf = await (await fetch(catalog.baseURL + w.file)).arrayBuffer();
    await idb("files", "readwrite", (s) => s.put(buf, `${f.family}/${w.file}`));
    got += w.bytes;
    onProgress?.(got / Math.max(f.bytes, 1));
  }
  await idb("meta", "readwrite", (s) => s.put(f, f.family));
  await activate(f);
  installedMeta.set(f.family, f);
}

export async function removeStoreFont(f: StoreFont): Promise<void> {
  for (const w of f.weights) {
    await idb("files", "readwrite", (s) => s.delete(`${f.family}/${w.file}`));
    for (const face of document.fonts) {
      if (face.family === w.ps) document.fonts.delete(face);
    }
  }
  await idb("meta", "readwrite", (s) => s.delete(f.family));
  unregisterStoreFamily(familyKey(f));
  installedMeta.delete(f.family);
}

// ── 缺字型守門員（版面穩定鐵則：不默默 fallback） ──

/** 專案 blocks 用到、目前渲染不出來的 PostScript 名。 */
export function unresolvedNames(blocks: { content: { type: string; text?: { fontName?: string } } }[]): string[] {
  const names = new Set<string>();
  for (const b of blocks) {
    const n = b.content.type === "text" ? b.content.text?.fontName : undefined;
    if (n) names.add(n);
  }
  return [...names].filter((n) => !canRender(n)).sort();
}

/** 缺的名字對回商店字型（對不回來的——被刪的匯入字——修不了，不擋路）。 */
export async function repairable(names: string[]): Promise<StoreFont[]> {
  if (!names.length) return [];
  await fetchCatalog();
  return (catalog?.fonts ?? []).filter(
    (f) => !installedMeta.has(f.family) && f.weights.some((w) => names.includes(w.ps)),
  );
}
