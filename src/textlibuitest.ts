// 文字庫面板自測（headless Chrome，textlibui.html）：記憶體檔案層＋真的面板，點按鈕、打字、模擬別台改檔，
// 驗畫面與存檔。?shot=list|grid|setup（&theme=dark）＝只擺好畫面給截圖，不跑測試。

import { attachedCanvas } from "./core/render";
import { characterCount, encodeMemo, newMemo, paragraphCount, sentenceCount, type TextMemo } from "./core/textmemo";
import { TextLibraryStore, memoryTextLibBackend, type TextLibPrefs } from "./textlib";
import { closeTextLibrary, isTextLibraryOpen, openTextLibrary, type TextLibraryHost } from "./textlibui";

const params = new URLSearchParams(location.search);
if (params.get("theme") === "dark") document.documentElement.dataset.theme = "dark";

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail: unknown = ""): void {
  results.push({ name, ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
  document.title = `#${results.length} ${name}`;
}
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000): Promise<boolean> {
  for (let i = 0; i < ms / 25 && !cond(); i++) await wait(25);
  return cond();
}
const $ = <T extends HTMLElement = HTMLElement>(sel: string): T | null => document.querySelector<T>(sel);
const all = (sel: string): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(sel)];
const click = (sel: string): void => $<HTMLButtonElement>(sel)!.click();
function typeInto(sel: string, value: string): void {
  const input = $<HTMLInputElement | HTMLTextAreaElement>(sel)!;
  input.focus();
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const measureCtx = attachedCanvas().getContext("2d")!;
const ICLOUD = "/Users/me/Library/Mobile Documents/com~apple~CloudDocs";

function memPrefs(): TextLibPrefs {
  const kv = new Map<string, string>();
  return { get: (k) => kv.get(k) ?? null, set: (k, v) => { if (v == null) kv.delete(k); else kv.set(k, v); } };
}

const SAMPLES = [
  { title: "秋天的第一篇", ago: 600, cells: 14, used: 1, usedIn: ["九月作品集"],
    body: "天氣轉涼的那一週，我把相機收進抽屜。\n不是不拍了，是想先把眼睛借給文字。\n\n今天在巷口看到一排晾著的白襯衫，風一吹，像一整列還沒排好的字。" },
  { title: "", ago: 3600, body: "想法：每張照片旁邊那句話，排成一樣的寬度。" },
  { title: "品牌短文草稿", ago: 86400, cells: 12, body: "好的版面不是塞滿，而是讓每個字都站在該站的位置。我們想做的，是讓人願意慢一點讀完。" },
];

async function seeded(loc: { aligned?: string | null; icloudRoot?: string | null } = { aligned: `${ICLOUD}/ALIGNED`, icloudRoot: ICLOUD }) {
  const backend = memoryTextLibBackend(loc);
  const store = new TextLibraryStore(backend, memPrefs(), "衝突副本");
  await store.resolveFolder();
  if (store.dir) {
    for (const s of SAMPLES) {
      const at = Date.now() - s.ago * 1000;
      await store.save({ ...newMemo(at, s.cells), title: s.title, body: s.body, usedCount: s.used ?? 0, usedIn: s.usedIn ?? [] }, null);
    }
  }
  return { backend, store };
}

const placed: { memo: TextMemo; cells: number }[] = [];
function hostFor(store: TextLibraryStore): TextLibraryHost {
  return {
    store, measureCtx, inApp: true,
    canPlace: () => true,
    place: (memo, cells) => { placed.push({ memo, cells }); },
    pickFolder: async () => "/Users/me/Documents/寫作",
    confirm: async () => true,
  };
}

async function run(): Promise<void> {
  const { backend, store } = await seeded();
  const host = hostFor(store);
  openTextLibrary(host);
  await until(() => all(".tl-row").length === 3 && $<HTMLInputElement>(".tl-name")?.value === "秋天的第一篇");
  const names = all(".tl-rname").map((e) => e.textContent);
  check("打開：清單三篇、新改的在前", names.length === 3 && names[0] === "秋天的第一篇", names);
  check("打開就選第一篇：標題與內文進編輯區",
        $<HTMLInputElement>(".tl-name")?.value === "秋天的第一篇" && !!$<HTMLTextAreaElement>(".tl-body")?.value.startsWith("天氣轉涼"));
  check("沒標題的一篇：清單拿第一行當名字", names.includes("想法：每張照片旁邊那句話，排成一樣的寬度。"), names);
  const s0 = SAMPLES[0].body;
  const meta0 = `字數 ${characterCount(s0)} · 句數 ${sentenceCount(s0)} · 已排進 1 次`;
  check("清單每篇列字數、句數、排進次數", $(".tl-row .tl-rmeta")?.textContent === meta0, $(".tl-row .tl-rmeta")?.textContent ?? "");
  check("底部寫出資料夾位置", $(".tl-where")?.textContent === "iCloud 雲碟 › ALIGNED › TextLibrary", $(".tl-where")?.textContent ?? "");

  typeInto(".tl-search", "品牌");
  check("搜尋：只剩符合的那篇", all(".tl-row").length === 1 && $(".tl-rname")?.textContent === "品牌短文草稿");
  typeInto(".tl-search", "");

  // 寫新的一篇
  click(".tl-new");
  check("寫新的一篇：編輯區清空、刪除鈕不能按", $<HTMLTextAreaElement>(".tl-body")?.value === "" && !!$<HTMLButtonElement>(".tl-del")?.disabled);
  const text1 = "Mac 上寫的第一段。\n第二段！";
  typeInto(".tl-body", text1);
  await until(() => store.memos.length === 4);
  check("打字停一下自動存：庫裡多一篇、排第一", store.memos.length === 4 && store.memos[0].body === text1, store.memos.map((m) => m.body.slice(0, 6)));
  check("字數／句數／段數跟著算",
        $(".tl-chars")?.textContent === `字數 ${characterCount(text1)}` && $(".tl-sents")?.textContent === `句數 ${sentenceCount(text1)}`
        && $(".tl-paras")?.textContent === `段數 ${paragraphCount(text1)}`, [$(".tl-chars")?.textContent, $(".tl-sents")?.textContent]);
  check("新存的那篇在清單亮著", $(".tl-row.on .tl-rname")?.textContent === "Mac 上寫的第一段。", $(".tl-row.on .tl-rname")?.textContent ?? "無");

  // 稿紙
  const city = "今天我們一起去探索這座城市";
  typeInto(".tl-body", city);
  click('.tl-seg button[data-mode="grid"]');
  for (let i = 0; i < 12; i++) click('.tl-step[data-step="-1"]');   // 14 → 按到底停在 4
  await wait(60);
  check("−：每排格數最少 4 格", $(".tl-cells")?.textContent === "每排 4 格", $(".tl-cells")?.textContent ?? "");
  click('.tl-step[data-step="1"]');
  click('.tl-step[data-step="1"]');
  await wait(60);
  const gridRows = all(".tl-mrow").map((r) => [...r.querySelectorAll("span")].map((g) => g.textContent).join(""));
  check("稿紙：排數跟「共 N 排」一樣", gridRows.length > 1 && $(".tl-rows")?.textContent === `共 ${gridRows.length} 排`, { gridRows, label: $(".tl-rows")?.textContent });
  check("稿紙：字一個不少、每排不超過 6 格", gridRows.join("") === city && gridRows.every((r) => [...r].length <= 6), gridRows);
  check("稿紙：保詞（探索、城市不拆到兩排）",
        !gridRows.some((r, i) => (r.endsWith("探") && gridRows[i + 1]?.startsWith("索")) || (r.endsWith("城") && gridRows[i + 1]?.startsWith("市"))), gridRows);
  check("排進畫面鈕寫著每排格數", $(".tl-place")?.textContent === "排進畫面 · 每排 6 格", $(".tl-place")?.textContent ?? "");
  await until(() => store.memos[0].cellsPerRow === 6);
  check("每排格數存進那一篇", store.memos[0].cellsPerRow === 6 && store.lastCellsPerRow === 6, store.memos[0].cellsPerRow);
  click('.tl-seg button[data-mode="write"]');

  // 鍵盤不漏到畫布
  let leaked = 0;
  const spy = () => { leaked++; };
  window.addEventListener("keydown", spy);
  $(".tl-body")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true }));
  window.removeEventListener("keydown", spy);
  check("面板開著：⌫、⌘Z 不會漏到後面的畫布", leaked === 0, `漏了 ${leaked} 次`);

  // 別台改了正在看的那篇
  const brand = store.memos.find((m) => m.title === "品牌短文草稿")!;
  all(".tl-row").find((r) => r.querySelector(".tl-rname")?.textContent === "品牌短文草稿")!.click();
  await until(() => $<HTMLInputElement>(".tl-name")?.value === "品牌短文草稿");
  await backend.write(store.dir!, brand.id, encodeMemo({ ...brand, body: "手機改過的品牌短文。", updated: Date.now() }));
  await store.refresh();
  await until(() => $<HTMLTextAreaElement>(".tl-body")?.value === "手機改過的品牌短文。");
  check("別台改了正在看的那篇（這邊沒動）：編輯區換成新的", $<HTMLTextAreaElement>(".tl-body")?.value === "手機改過的品牌短文。");

  // 兩邊同時改
  typeInto(".tl-body", "Mac 這邊也在改。");
  await backend.write(store.dir!, brand.id, encodeMemo({ ...brand, body: "手機又改了一次。", updated: Date.now() - 60_000 }));
  await until(() => store.memos.some((m) => m.title === "品牌短文草稿（衝突副本）"));
  check("兩邊同時改：Mac 的留在原篇、手機那份另存衝突副本、底部有說明",
        store.memo(brand.id)?.body === "Mac 這邊也在改。" && store.memos.some((m) => m.title === "品牌短文草稿（衝突副本）" && m.body === "手機又改了一次。")
        && ($(".tl-note")?.textContent ?? "").includes("衝突副本"), { note: $(".tl-note")?.textContent, titles: store.memos.map((m) => m.title) });

  // 刪除
  const count = store.memos.length;
  click(".tl-del");
  await until(() => store.memos.length === count - 1);
  check("刪除：清單少一篇、資料夾留墓碑", store.memos.length === count - 1 && [...backend.tombstones].some((t) => t.endsWith(brand.id)));
  check("刪完自動打開下一篇", !!$<HTMLInputElement>(".tl-name") && $(".tl-form")?.style.display !== "none");

  // 換位置、改回自動
  click(".tl-change");
  await until(() => store.dir === "/Users/me/Documents/寫作/TextLibrary");
  check("換位置：選的資料夾裡用 TextLibrary、清單換成那邊的（空）",
        store.dir === "/Users/me/Documents/寫作/TextLibrary" && $(".tl-where")?.textContent === "~ › Documents › 寫作 › TextLibrary" && $(".tl-listempty") != null,
        $(".tl-where")?.textContent ?? "");
  check("自己選過位置：出現「改回自動找」", $(".tl-auto")?.style.display !== "none");
  click(".tl-auto");
  await until(() => store.dir === `${ICLOUD}/ALIGNED/TextLibrary` && all(".tl-row").length > 0);
  check("改回自動：回到 iCloud 雲碟那批", store.dir === `${ICLOUD}/ALIGNED/TextLibrary` && all(".tl-row").length === store.memos.length);

  // 排進畫面
  click(".tl-place");
  await until(() => !isTextLibraryOpen());
  check("排進畫面：面板關掉、把那篇與每排格數交給畫布", placed.length === 1 && !isTextLibraryOpen() && placed[0].cells >= 4,
        placed.map((p) => ({ body: p.memo.body.slice(0, 8), cells: p.cells })));

  // Esc
  openTextLibrary(host);
  await until(() => isTextLibraryOpen() && all(".tl-row").length > 0);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await until(() => !isTextLibraryOpen());
  check("Esc 關面板", !isTextLibraryOpen());

  // 找不到 ALIGNED
  const miss = await seeded({ aligned: null, icloudRoot: ICLOUD });
  openTextLibrary(hostFor(miss.store));
  await until(() => !!$(".tl-setup"));
  check("找不到文字庫資料夾：出現「在 iCloud 雲碟建立」與「選資料夾」", all(".tl-setup-acts button").length === 2 && !!$<HTMLButtonElement>(".tl-new")?.disabled);
  click(".tl-setup-acts button.primary");
  await until(() => !!$(".tl-side"));
  check("按建立：iCloud 雲碟建好 ALIGNED／TextLibrary、換成清單",
        miss.store.dir === `${ICLOUD}/ALIGNED/TextLibrary` && !!$(".tl-side") && !$<HTMLButtonElement>(".tl-new")?.disabled, miss.store.dir ?? "null");
  await closeTextLibrary();

  const pass = results.filter((r) => r.ok).length;
  $("#out")!.innerHTML = results.map((r) =>
    `<div class="${r.ok ? "ok" : "bad"}">${r.ok ? "PASS" : "FAIL"}　${r.name}${r.ok || !r.detail ? "" : `　<span>${r.detail.replace(/</g, "&lt;")}</span>`}</div>`,
  ).join("") + `<div>${pass} / ${results.length} 通過</div>`;
  document.title = `${pass}/${results.length} ${pass === results.length ? "PASS" : "FAIL"}`;
}

async function shot(kind: string): Promise<void> {
  if (kind === "setup") {
    const miss = await seeded({ aligned: null, icloudRoot: ICLOUD });
    openTextLibrary({ ...hostFor(miss.store) });
    await until(() => !!$(".tl-setup"));
  } else {
    const { store } = await seeded();
    openTextLibrary(hostFor(store));
    await until(() => all(".tl-row").length === 3);
    if (kind === "grid") click('.tl-seg button[data-mode="grid"]');
  }
  await wait(200);
  document.title = "READY";
}

const shotKind = params.get("shot");
(shotKind ? shot(shotKind) : run()).catch((e) => {
  $("#out")!.innerHTML = `<div class="bad">執行中斷：${(e as Error).message}</div><pre>${(e as Error).stack ?? ""}</pre>`;
  document.title = "ERROR";
});
