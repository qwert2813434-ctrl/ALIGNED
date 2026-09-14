// 文字庫（2026-09-14）——iOS `TextMemo.swift` 的逐行移植：一篇一個 .md 的格式、字數／句數／段數、
// 稿紙格子、排進畫面的框寬、收進文字庫。平台無關、不碰檔案（檔案在殼層 textlib.ts／Rust textlib.rs）。
//
// 為什麼要逐字對齊 iOS：手機、平板、電腦讀寫的是同一批檔案（iCloud 雲碟「ALIGNED/TextLibrary」），
// iOS 同步靠「整篇寫成檔案的文字」比指紋——這裡寫出來的格式差一個空白，手機就會以為那篇被改過。
// 字元怎麼算照 Swift 的 Character／CharacterSet 定義（各函式註解），`textlibtest/run.sh` 拿同一批測資
// 讓 Swift 原檔與這支各跑一次逐案比對。

import type { Project, Rect, TextBlock } from "./schema";
import { pageRect } from "./geometry";

export interface TextMemo {
  /** 檔名（不含 .md）。讀檔一律以檔名為準，改標題不改檔名。 */
  id: string;
  title: string;
  body: string;
  /** epoch 毫秒；檔案裡只存到秒。 */
  created: number;
  updated: number;
  /** 稿紙每排幾格；undefined＝這篇沒設過。 */
  cellsPerRow?: number;
  /** 排進畫面的總次數。 */
  usedCount: number;
  /** 排進過的專案名，最近的在前，最多 5 個。 */
  usedIn: string[];
}

// ── Swift 字元語意 ─────────────────────────────────────────────────────
// Character＝字素（grapheme）；isWhitespace／isNewline／isLetter／isNumber 看第一個 scalar。
// CharacterSet 的 trim 則是逐 scalar。兩種別混用，不然 CRLF、組合字、emoji 家族會算錯。

type Segmenter = { segment(s: string): Iterable<{ segment: string }> };
const segmenter: Segmenter | null =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new (Intl as unknown as { Segmenter: new (l?: string, o?: object) => Segmenter }).Segmenter(undefined, { granularity: "grapheme" })
    : null;

/** 字串 → Swift 的 Character 陣列。 */
export function graphemes(s: string): string[] {
  if (!s) return [];
  return segmenter ? Array.from(segmenter.segment(s), (x) => x.segment) : Array.from(s);
}

const WORD_JOINER = String.fromCodePoint(0x2060);
const RE_WHITE_SPACE = /^\p{White_Space}/u;
const RE_LETTER_OR_NUMBER = /^[\p{Alphabetic}\p{N}]/u;
const RE_ZS = /^\p{Zs}$/u;
const RE_Z = /^\p{Z}$/u;
const RE_CONTROL = /^[\p{Cc}\p{Cf}]$/u;
/** CharacterSet.newlines：U+000A…000D、U+0085、U+2028、U+2029 */
const RE_NEWLINE_SCALAR = new RegExp("[\\n\\x0B\\x0C\\r\\x85" + String.fromCodePoint(0x2028, 0x2029) + "]");

const cp0 = (c: string): number => c.codePointAt(0) ?? 0;
/** Character.isNewline */
const isNewlineChar = (c: string): boolean => {
  const v = cp0(c);
  return (v >= 0x0a && v <= 0x0d) || v === 0x85 || v === 0x2028 || v === 0x2029;
};
/** Character.isWhitespace（Unicode White_Space，含換行） */
const isWhitespaceChar = (c: string): boolean => RE_WHITE_SPACE.test(c);

/** CharacterSet.whitespaces：Zs＋tab＋U+200B（零寬空白；Foundation 算空白，全 Unicode 逐字比對過） */
const inWhitespaces = (s: string): boolean => {
  const v = cp0(s);
  return v === 0x09 || v === 0x200b || RE_ZS.test(s);
};
/** CharacterSet.whitespacesAndNewlines：Z*＋tab＋U+000A…000D＋U+0085＋U+200B */
const inWhitespacesAndNewlines = (s: string): boolean => {
  const v = cp0(s);
  return (v >= 0x09 && v <= 0x0d) || v === 0x85 || v === 0x200b || RE_Z.test(s);
};

/** 字元判斷一覽——給 textlibtest 拿去跟 Swift 全 Unicode 逐字比對，程式裡照用上面那幾支。 */
export const charRules = {
  whitespaces: inWhitespaces,
  whitespacesAndNewlines: inWhitespacesAndNewlines,
  newlines: (s: string): boolean => RE_NEWLINE_SCALAR.test(s),
  controlCharacters: (s: string): boolean => RE_CONTROL.test(s),
  characterIsWhitespace: (c: string): boolean => isWhitespaceChar(c),
  characterIsNewline: (c: string): boolean => isNewlineChar(c),
  characterIsLetterOrNumber: (c: string): boolean => RE_LETTER_OR_NUMBER.test(c),
};

/** trimmingCharacters(in:)——逐 scalar 從兩端剝。 */
function trimScalars(s: string, drop: (scalar: string) => boolean): string {
  const cps = Array.from(s);
  let a = 0, b = cps.length;
  while (a < b && drop(cps[a])) a++;
  while (b > a && drop(cps[b - 1])) b--;
  return a === 0 && b === cps.length ? s : cps.slice(a, b).join("");
}
export const trimWS = (s: string): string => trimScalars(s, inWhitespacesAndNewlines);

/** split(whereSeparator: \.isNewline)——空的段落不留。 */
function splitLines(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (const c of graphemes(s)) {
    if (isNewlineChar(c)) { if (cur) out.push(cur); cur = ""; } else cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

// ── 一篇 ──────────────────────────────────────────────────────────────

/** 建立時間（UTC）＋4 碼亂數：照時間排得起來，兩台同時新增也不撞名。 */
export function makeMemoID(dateMs = Date.now()): string {
  const d = new Date(dateMs);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${String(d.getUTCFullYear()).padStart(4, "0")}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`
    + `-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
    + `-${crypto.randomUUID().slice(0, 4).toLowerCase()}`;
}

export function newMemo(now = Date.now(), cellsPerRow?: number): TextMemo {
  return { id: makeMemoID(now), title: "", body: "", created: now, updated: now, cellsPerRow, usedCount: 0, usedIn: [] };
}

export function isBlankMemo(m: Pick<TextMemo, "title" | "body">): boolean {
  return trimWS(m.title) === "" && trimWS(m.body) === "";
}

function contentLines(body: string): string[] {
  return splitLines(body).map((l) => trimScalars(l, inWhitespaces)).filter((l) => l !== "");
}

/** 清單上的名字：有標題用標題，否則內文第一個有字的行；都沒有＝null（畫面寫「未命名」）。 */
export function displayTitle(m: Pick<TextMemo, "title" | "body">): string | null {
  const t = trimWS(m.title);
  return t !== "" ? t : contentLines(m.body)[0] ?? null;
}

/** 清單第二行的摘要：有標題＝內文開頭；沒標題（名字已經是第一行）＝第一行之後。
 *  行與行接起來時兩邊都是英數才補空白——中文句子之間不插空白。 */
export function memoPreview(m: Pick<TextMemo, "title" | "body">): string {
  const lines = contentLines(m.body);
  let out = "";
  for (const line of trimWS(m.title) !== "" ? lines : lines.slice(1)) {
    if (out) {
      const last = Array.from(out).at(-1)!;
      if (cp0(last) < 0x2e80 && cp0(line) < 0x2e80) out += " ";
    }
    out += line;
    if (graphemes(out).length >= 80) break;
  }
  return graphemes(out).slice(0, 80).join("");
}

// ── 字數／句數／段數 ──────────────────────────────────────────────────

/** 不含空白與換行；標點算（稿紙上標點也佔一格）。 */
export function characterCount(s: string): number {
  let n = 0;
  for (const c of graphemes(s)) if (!isWhitespaceChar(c)) n++;
  return n;
}

/** 有字的行數。 */
export function paragraphCount(s: string): number {
  return splitLines(s).filter((l) => graphemes(l).some((c) => !isWhitespaceChar(c))).length;
}

const TERMINATORS = new Set(["。", "！", "？", "!", "?", "…", "．"]);

/** 。！？!?… 與換行收句；英文句點要後面是空白或結尾才算（3.5 不斷句）。
 *  一句至少要有一個字或數字——連續的刪節號、單獨的引號不另算一句。 */
export function sentenceCount(s: string): number {
  const cs = graphemes(s);
  let count = 0;
  let hasContent = false;
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i];
    const next = cs[i + 1];
    const ends = isNewlineChar(c) || TERMINATORS.has(c)
      || (c === "." && (next === undefined || isWhitespaceChar(next)));
    if (ends) {
      if (hasContent) count++;
      hasContent = false;
    } else if (RE_LETTER_OR_NUMBER.test(c)) {
      hasContent = true;
    }
  }
  return count + (hasContent ? 1 : 0);
}

// ── 稿紙 ──────────────────────────────────────────────────────────────

export interface ManuscriptCell {
  text: string;
  /** 佔幾格：全形 1、半形 0.5（英數兩個併一格）。 */
  units: number;
}

export function cellUnits(c: string): number {
  const cps = Array.from(c);
  if (cps.length !== 1) return 1;
  const v = cp0(cps[0]);
  return v < 0x80 || (v >= 0xff61 && v <= 0xff9f) ? 0.5 : 1;
}

/** 一排字 → 格子。保詞用的 word joiner（U+2060，零寬）與換行不佔格。 */
export function manuscriptCells(line: string): ManuscriptCell[] {
  const out: ManuscriptCell[] = [];
  for (const c of graphemes(line)) {
    if (isNewlineChar(c)) continue;
    const visible = c.split(WORD_JOINER).join("");
    if (!visible) continue;
    out.push({ text: visible, units: cellUnits(graphemes(visible)[0]) });
  }
  return out;
}

// ── 排進畫面 ──────────────────────────────────────────────────────────

/** 框寬＝每排 n 格 × 字級，多留 0.1 字寬（免得剛好 n 字被擠到下一行）。 */
export const PLACEMENT_SLACK = 0.1;

/** 放不下就縮字級，讓 n 格剛好塞滿可用寬。稿紙預覽也用同一個寬度斷排。 */
export function placementFit(cellsPerRow: number, fontSize: number, available: number): { fontSize: number; width: number } {
  const n = Math.max(cellsPerRow, 1) + PLACEMENT_SLACK;
  if (fontSize * n <= available) return { fontSize, width: fontSize * n };
  return { fontSize: available / n, width: available };
}

/** 反推（收進文字庫用）：長文框的寬換回每排幾格——跟 placementFit 互逆；不在 4…40＝undefined。 */
export function cellsPerRowFor(width: number, fontSize: number): number | undefined {
  if (!(width > 0) || !(fontSize > 0)) return undefined;
  const x = width / fontSize - PLACEMENT_SLACK;
  const n = Math.sign(x) * Math.round(Math.abs(x));   // Swift .rounded()：一半往離零的方向
  return n >= 4 && n <= 40 ? n : undefined;
}

/** 稿紙斷排用的畫布寬（iOS TextMemoRows 同值）；長文字級＝畫布寬 × 0.030。 */
export const MEMO_CANVAS_WIDTH = 1080;
export const memoFontSize = (canvasWidth: number): number => canvasWidth * 0.030;

/** 一篇排成新的長文框（iOS addLongFormTextBlock 同一組數字）：當頁左上內縮、頁寬減兩邊邊距；
 *  帶每排格數＝框寬跟著格數（放不下縮字級）。 */
export function memoTextBlock(p: Project, pageIndex: number, text: string, cellsPerRow?: number): { frame: Rect; text: TextBlock } {
  const page = pageRect(p, pageIndex);
  const margin = p.canvasWidth * 0.07;
  let width = page.w - margin * 2;
  const height = page.h - margin * 3.2;
  let fontSize = memoFontSize(p.canvasWidth);
  if (cellsPerRow != null) ({ fontSize, width } = placementFit(cellsPerRow, fontSize, width));
  return {
    frame: { x: page.x + margin, y: page.y + margin * 1.6, w: width, h: height },
    text: {
      text, alignment: "leading", isBodyFrame: true, fontSize,
      manualWidth: width, manualHeight: height, lineHeightMultiple: 1.35, paragraphSpacingEm: 0.6,
    },
  };
}

/** 稿紙斷排用的文字設定：跟排進畫面的長文框同字級、同行距，框寬＝每排 n 格。 */
export function manuscriptTextBlock(text: string, cellsPerRow: number): { text: TextBlock; width: number } {
  const fontSize = memoFontSize(MEMO_CANVAS_WIDTH);
  const width = placementFit(cellsPerRow, fontSize, Number.POSITIVE_INFINITY).width;
  return {
    text: { text, alignment: "leading", isBodyFrame: true, fontSize, manualWidth: width, lineHeightMultiple: 1.35, paragraphSpacingEm: 0.6 },
    width,
  };
}

/** 排進畫面：記次數與專案名（最近在前、最多 5 個、同名不重複）。不動修改時間——排進去不算改寫。 */
export function markMemoUsed(m: TextMemo, projectName: string): TextMemo {
  const name = trimWS(projectName);
  const usedIn = name ? [name, ...m.usedIn.filter((n) => n !== name)].slice(0, 5) : m.usedIn;
  return { ...m, usedCount: m.usedCount + 1, usedIn };
}

// ── 收進文字庫 ────────────────────────────────────────────────────────

/** 各語言的新文字框佔位字（iOS 五語＋桌面版繁中／英文）：換過介面語言的舊框也認得。 */
export const PLACEHOLDER_VARIANTS = new Set([
  "雙擊編輯文字", "双击编辑文字", "Double-tap to edit", "ダブルタップで編集", "두 번 탭하여 편집",
  "Double-click to edit text",
]);

/** 有真的字才收（佔位字、空白不收）。只看開頭 41 個字——佔位字很短，超過 40 個字一定不是。 */
export function canCollectText(text: string): boolean {
  const head = graphemes(text.slice(0, 1000)).slice(0, 41);
  if (!head.some((c) => !isWhitespaceChar(c))) return false;
  if (head.length > 40) return true;
  return !PLACEHOLDER_VARIANTS.has(trimWS(head.join("")));
}

/** 長文框的每排格數（橫排長文框才有；其他文字框＝undefined）。 */
export function collectCells(t: TextBlock, frameW: number, canvasWidth: number): number | undefined {
  if (t.isBodyFrame !== true || t.vertical === true) return undefined;
  return cellsPerRowFor(t.manualWidth ?? frameW, t.fontSize ?? canvasWidth * 0.045);
}

/** 一框一篇；庫裡（或這批前面）已有同樣內容就不重複收。記來源專案（算排進過一次）。 */
export function planCollect(
  sources: { text: string; cellsPerRow?: number }[],
  libraryBodies: string[],
  projectName: string,
  now: number,
  makeID: () => string = () => makeMemoID(now),
): { added: TextMemo[]; existing: number } {
  const seen = new Set(libraryBodies.map(trimWS));
  const name = trimWS(projectName);
  const added: TextMemo[] = [];
  let existing = 0;
  for (const s of sources) {
    if (!canCollectText(s.text)) continue;
    const body = trimWS(s.text);
    if (seen.has(body)) { existing++; continue; }
    seen.add(body);
    added.push({ id: makeID(), title: "", body, created: now, updated: now, cellsPerRow: s.cellsPerRow,
                 usedCount: 1, usedIn: name ? [name] : [] });
  }
  return { added, existing };
}

// ── 衝突副本、排序、檔名 ──────────────────────────────────────────────

/** 衝突副本：新的 id、標題後面標「衝突副本」，排進紀錄歸零（那是原篇的）。 */
export function conflictCopy(m: TextMemo, marker: string, newID = makeMemoID()): TextMemo {
  const name = displayTitle(m) ?? "";
  return { ...m, id: newID, title: name ? `${name}（${marker}）` : marker, usedCount: 0, usedIn: [] };
}

export function newestFirst(a: TextMemo, b: TextMemo): number {
  if (a.updated !== b.updated) return b.updated - a.updated;
  return a.id > b.id ? -1 : a.id < b.id ? 1 : 0;
}

/** id → 檔名（不含 .md）：拿掉路徑符號、控制字元與開頭的點（隱藏檔）。存不回同一個檔名的檔
 *  （開頭是點之類）iOS 同步不收，桌面版也不列，兩邊看到的才會是同一批。 */
export function fileStem(id: string): string {
  const kept = Array.from(id).filter((c) => c !== "/" && c !== "\\" && c !== ":" && !RE_CONTROL.test(c)).join("");
  const cs = graphemes(trimScalars(kept, inWhitespaces));
  let i = 0;
  while (i < cs.length && cs[i] === ".") i++;
  return cs.slice(i).join("") || "memo";
}

// ── 檔案 ──────────────────────────────────────────────────────────────

/** ISO8601DateFormatter [.withInternetDateTime]：UTC、到秒。 */
function isoString(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:Z|([+-])(\d{2}):(\d{2}))$/;
function isoParse(s: string | undefined): number | undefined {
  const m = s == null ? null : ISO_RE.exec(s);
  if (!m) return undefined;
  const [y, mo, d, h, mi, se] = m.slice(1, 7).map(Number);
  const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (mo < 1 || mo > 12 || d < 1 || d > days || h > 23 || mi > 59 || se > 59) return undefined;
  let ms = Date.UTC(y, mo - 1, d, h, mi, se);
  if (m[7]) ms -= (m[7] === "+" ? 1 : -1) * (Number(m[8]) * 3600 + Number(m[9]) * 60) * 1000;
  return ms;
}

/** Swift Int(String)：可帶正負號、只收 ASCII 數字、不收空白。 */
function intField(s: string | undefined): number | undefined {
  if (s == null || !/^[+-]?[0-9]+$/.test(s)) return undefined;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : undefined;
}

/** 欄位值收成一行：components(separatedBy: .newlines).joined(" ")，再剝兩端空白。 */
function oneLine(s: string): string {
  return trimScalars(s.split(RE_NEWLINE_SCALAR).join(" "), inWhitespaces);
}

export function encodeMemo(m: TextMemo): string {
  const head = ["---", `id: ${m.id}`, `title: ${oneLine(m.title)}`,
                `created: ${isoString(m.created)}`, `updated: ${isoString(m.updated)}`];
  if (m.cellsPerRow != null) head.push(`cells: ${m.cellsPerRow}`);
  if (m.usedCount > 0) head.push(`used: ${m.usedCount}`);
  if (m.usedIn.length) head.push("usedIn: " + m.usedIn.map((n) => oneLine(n).split("｜").join("|")).join("｜"));
  head.push("---");
  return head.join("\n") + "\n" + m.body;
}

/** `fileID`＝檔名（不含 .md）。沒有檔頭的檔案（自己丟進來的 .md）整份當內文、時間用 `now`
 *  （讀檔端傳檔案修改時間——每次讀都一樣，iOS 那邊的指紋才穩）。 */
export function decodeMemo(text: string, fileID: string, now: number): TextMemo {
  const lines = text.split("\n");
  const isFence = (s: string) => trimWS(s) === "---";
  let end = -1;
  if (lines.length && isFence(lines[0])) {
    for (let i = 1; i < lines.length; i++) if (isFence(lines[i])) { end = i; break; }
  }
  if (end < 0) return { id: fileID, title: "", body: text, created: now, updated: now, usedCount: 0, usedIn: [] };
  const fields = new Map<string, string>();
  for (const line of lines.slice(1, end)) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    fields.set(trimScalars(line.slice(0, colon), inWhitespaces), trimWS(line.slice(colon + 1)));
  }
  const created = isoParse(fields.get("created")) ?? now;
  const cells = intField(fields.get("cells"));
  return {
    id: fileID,
    title: fields.get("title") ?? "",
    body: lines.slice(end + 1).join("\n"),
    created,
    updated: isoParse(fields.get("updated")) ?? created,
    cellsPerRow: cells == null ? undefined : Math.min(Math.max(cells, 1), 99),
    usedCount: intField(fields.get("used")) ?? 0,
    usedIn: (fields.get("usedIn") ?? "").split("｜").filter((n) => n !== ""),
  };
}
