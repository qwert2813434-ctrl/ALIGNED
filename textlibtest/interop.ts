// 文字庫互通測試：一台「iPhone」、一台「iPad」（iOS 原檔 TextMemoLibrary＋TextMemoSync 編的命令列）、
// 一台「Mac」（桌面版 textlib.ts；檔案層換成跟 Rust textlib.rs 同規則的 node 版）讀寫同一個暫存「iCloud 資料夾」。
// 用法：node interop.mjs <synccli>（textlibtest/run.sh 編好再呼叫）

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newMemo, type TextMemo } from "../src/core/textmemo";
import { TextLibraryStore, type TextLibPrefs } from "../src/textlib";
import { nodeTextLibBackend } from "./nodebackend";

type DeviceMemo = { id: string; title: string; body: string; used: number; usedIn: string[]; cells: number | null; updated: number };
type Report = { uploaded: number; pulled: number; deletedLocal: number; deletedCloud: number; copies: number; held: number; error: string | null; changed: boolean };

const SYNCCLI = process.argv[2];
const root = mkdtempSync(join(tmpdir(), "textlib-interop-"));
const folder = join(root, "ALIGNED");
const cloud = join(folder, "TextLibrary");
const phone = join(root, "iphone");
const pad = join(root, "ipad");
mkdirSync(folder);

let passed = 0, failed = 0;
function check(ok: boolean, name: string, detail: unknown = ""): void {
  if (ok) passed++; else failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `　${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
}
const ios = <T>(...args: string[]): T => JSON.parse(execFileSync(SYNCCLI, args, { encoding: "utf8" })) as T;
const sync = (device: string) => ios<Report>("sync", device, folder);
const dump = (device: string) => ios<DeviceMemo[]>("dump", device);
const find = (device: string, id: string) => dump(device).find((m) => m.id === id);
const deviceSave = (device: string, id: string, title: string, body: string, updatedMs: number) =>
  ios("save", device, id, title, body, String(updatedMs / 1000));
const ids = (xs: { id: string }[]) => xs.map((x) => x.id).sort().join(",");

const kv = new Map<string, string>();
const prefs: TextLibPrefs = { get: (k) => kv.get(k) ?? null, set: (k, v) => { if (v == null) kv.delete(k); else kv.set(k, v); } };
let clock = 1_900_000_000_000;
const tick = (seconds: number) => (clock += seconds * 1000);
const mac = new TextLibraryStore(nodeTextLibBackend({ aligned: folder, icloudRoot: root }), prefs, "衝突副本", () => clock);

async function main(): Promise<void> {
  await mac.resolveFolder();
  check(mac.dir === cloud, "Mac 自動找到 iCloud 雲碟裡的 ALIGNED／TextLibrary", mac.dir ?? "null");
  await mac.refresh();
  check(mac.memos.length === 0 && mac.folder.kind === "ready" && !mac.folder.exists, "TextLibrary 還沒建：清單空的、不報錯", mac.folder);

  // 1 iPhone 寫 → Mac 讀
  deviceSave(phone, "a", "手機寫的", "第一篇。", tick(1));
  let r = sync(phone);
  check(r.uploaded === 1 && !r.error, "iPhone 寫一篇、同步上雲端", r);
  await mac.refresh();
  check(mac.memo("a")?.title === "手機寫的" && mac.memo("a")?.body === "第一篇。", "Mac 讀得到 iPhone 寫的", mac.memo("a") ?? "沒有");

  // 2 Mac 改 → iPhone 跟上
  let res = await mac.save({ ...mac.memo("a")!, body: "Mac 改過。", updated: tick(60) }, mac.raw("a"));
  check(res?.kept === "draft" && !res.copy, "Mac 改那篇：直接寫回、沒有副本", res ?? "null");
  r = sync(phone);
  check(r.pulled === 1 && find(phone, "a")?.body === "Mac 改過。", "iPhone 跟上 Mac 改的", r);

  // 3 Mac 新寫一篇（每排 12 格）→ iPhone、iPad
  const b: TextMemo = { ...newMemo(tick(60), 12), title: "電腦寫的", body: "第二篇" };
  await mac.save(b, null);
  r = sync(phone);
  const pb = find(phone, b.id);
  check(pb?.title === "電腦寫的" && pb.cells === 12, "Mac 新寫一篇 → iPhone 收到（每排格數也在）", pb ?? r);
  sync(pad);
  check(ids(dump(pad)) === ["a", b.id].sort().join(","), "iPad 也收到兩篇", dump(pad));

  // 4 iPhone 改 → Mac 重新整理就看到
  deviceSave(phone, b.id, "電腦寫的", "手機又改", tick(30));
  sync(phone);
  check((await mac.refresh()) && mac.memo(b.id)?.body === "手機又改", "iPhone 改的 → Mac 重新整理就看到", mac.memo(b.id) ?? "沒有");

  // 5 Mac 排進畫面 → 紀錄傳到 iPhone
  tick(60);
  await mac.markUsed(b.id, "九月作品集");
  r = sync(phone);
  const pb5 = find(phone, b.id);
  check(pb5?.used === 1 && pb5.usedIn[0] === "九月作品集" && pb5.body === "手機又改", "Mac 排進畫面的次數與專案名傳到 iPhone、內文不變", pb5 ?? r);

  // 6a Mac 開著編輯、手機先改而且比較新：原篇留手機的，Mac 的存副本
  let base = mac.raw(b.id);
  let draft = mac.memo(b.id)!;
  deviceSave(phone, b.id, "電腦寫的", "手機的版本", clock + 100_000);
  sync(phone);
  res = await mac.save({ ...draft, body: "Mac 的版本", updated: clock + 50_000 }, base);
  check(res?.kept === "disk" && res.memo.body === "手機的版本" && res.copy?.body === "Mac 的版本" && res.copy.title === "電腦寫的（衝突副本）",
        "Mac 編輯中手機先改（手機新）：原篇留手機的、Mac 的存衝突副本", res ?? "null");
  sync(phone);
  let list = dump(phone);
  check(list.find((m) => m.id === b.id)?.body === "手機的版本" && list.some((m) => m.body === "Mac 的版本" && m.title.endsWith("（衝突副本）")),
        "iPhone 看到原篇＋衝突副本", list.map((m) => `${m.title}:${m.body}`));

  // 6b 反過來：Mac 比較新
  tick(600);
  base = mac.raw(b.id);
  draft = mac.memo(b.id)!;
  deviceSave(phone, b.id, "電腦寫的", "手機舊一點", clock - 300_000);
  sync(phone);
  res = await mac.save({ ...draft, body: "Mac 新一點", updated: clock }, base);
  check(res?.kept === "draft" && res.copy?.body === "手機舊一點", "Mac 編輯中手機也改（Mac 新）：原篇留 Mac 的、手機那份存副本", res ?? "null");
  sync(phone);
  list = dump(phone);
  check(list.find((m) => m.id === b.id)?.body === "Mac 新一點" && list.some((m) => m.body === "手機舊一點"), "iPhone 跟上、兩份都在", list.map((m) => m.body));

  // 7 Mac 刪 → 墓碑 → iPhone、iPad 跟著刪
  await mac.delete("a");
  check(existsSync(join(cloud, ".deleted", "a")) && !existsSync(join(cloud, "a.md")), "Mac 刪除：檔案不見、留墓碑");
  r = sync(phone);
  check(r.deletedLocal === 1 && !find(phone, "a"), "iPhone 跟著刪", r);
  sync(pad);
  check(!find(pad, "a"), "iPad 也跟著刪", dump(pad).map((m) => m.id));

  // 8 Mac 刪、iPhone 同時在改：改的贏
  const c: TextMemo = { ...newMemo(tick(60)), body: "要被刪的那篇" };
  await mac.save(c, null);
  sync(phone);
  deviceSave(phone, c.id, "", "手機在改", tick(10));
  await mac.delete(c.id);
  r = sync(phone);
  await mac.refresh();
  check(mac.memo(c.id)?.body === "手機在改" && !existsSync(join(cloud, ".deleted", c.id)), "Mac 刪、iPhone 同時在改：改的贏，回到 Mac", r);

  // 9 兩邊各改同一篇（iPhone 比較新）：iPhone 同步時出衝突副本，Mac 也看得到兩份
  const d: TextMemo = { ...newMemo(tick(60)), title: "兩邊都改", body: "原文" };
  await mac.save(d, null);
  sync(phone);
  deviceSave(phone, d.id, "兩邊都改", "手機版", clock + 200_000);
  await mac.save({ ...mac.memo(d.id)!, body: "電腦版", updated: clock + 100_000 }, mac.raw(d.id));
  r = sync(phone);
  await mac.refresh();
  const bodies = mac.memos.filter((m) => m.title.startsWith("兩邊都改")).map((m) => m.body).sort();
  check(r.copies === 1 && bodies.join("|") === ["手機版", "電腦版"].sort().join("|") && mac.memo(d.id)?.body === "手機版",
        "兩邊各改同一篇：新的留原篇、舊的變衝突副本，Mac 也看得到", { r, bodies });

  // 10 Mac 一次刪 5 篇（有墓碑）：iPhone 照刪，不被「一次消失太多」擋下
  const batch: TextMemo[] = [];
  for (let i = 0; i < 6; i++) {
    const m: TextMemo = { ...newMemo(tick(1)), body: `批次第 ${i + 1} 篇` };
    await mac.save(m, null);
    batch.push(m);
  }
  sync(phone);
  for (const m of batch.slice(0, 5)) await mac.delete(m.id);
  r = sync(phone);
  check(r.deletedLocal === 5 && r.held === 0, "Mac 一次刪 5 篇（有墓碑）→ iPhone 照刪、不被防誤刪擋下", r);

  // 11 電腦上直接丟一個沒有檔頭的 .md（Obsidian）
  writeFileSync(join(cloud, "Obsidian 筆記.md"), "沒有檔頭的筆記\n第二行");
  await mac.refresh();
  const ob = mac.memo("Obsidian 筆記");
  check(ob?.title === "" && ob.body === "沒有檔頭的筆記\n第二行", "資料夾裡直接丟進來的 .md：Mac 清單讀得到", ob ?? "沒有");
  sync(phone);
  check(!!find(phone, "Obsidian 筆記"), "iPhone 也收到那篇");
  await mac.save({ ...ob!, title: "補上標題", updated: tick(60) }, mac.raw("Obsidian 筆記"));
  r = sync(phone);
  check(r.copies === 0 && find(phone, "Obsidian 筆記")?.title === "補上標題", "Mac 補標題（寫出檔頭）→ iPhone 跟上、不出副本", r);

  // 12 收進文字庫
  tick(60);
  const col = await mac.collect([{ text: "封面大標" }, { text: "雙擊編輯文字" }, { text: "  手機版  " }, { text: "封面大標" },
                                 { text: "長文框內文", cellsPerRow: 14 }], "十月提案");
  check(col.added.length === 2 && col.existing === 2, "收進文字庫：佔位字不收、已經有的不重複", { added: col.added.map((m) => m.body), existing: col.existing });
  sync(phone);
  const pc = dump(phone).find((m) => m.body === "長文框內文");
  check(pc?.used === 1 && pc.usedIn[0] === "十月提案" && pc.cells === 14, "收進來的那篇帶專案名與每排格數到 iPhone", pc ?? "沒有");

  // 13 整篇清空＝刪除
  const e = mac.memo(batch[5].id)!;
  await mac.save({ ...e, title: "", body: "  \n ", updated: tick(60) }, mac.raw(e.id));
  check(!mac.memo(e.id) && existsSync(join(cloud, ".deleted", e.id)), "Mac 把一篇的字全刪掉＝刪除（留墓碑）");
  sync(phone);
  check(!find(phone, e.id), "iPhone 跟著刪");

  // 14 收斂
  sync(phone);
  const again = sync(phone);
  check(!again.changed, "iPhone 再同步一次什麼都不動", again);
  sync(pad);
  sync(pad);
  await mac.refresh();
  check(!(await mac.refresh()), "Mac 再重新整理也沒有變化");
  check(ids(dump(pad)) === ids(dump(phone)) && ids(dump(phone)) === ids(mac.memos), "iPhone、iPad、Mac 三邊篇目一致",
        { phone: dump(phone).length, pad: dump(pad).length, mac: mac.memos.length });

  console.log(failed === 0 ? `INTEROP PASS ${passed}` : `INTEROP FAIL ${failed}/${passed + failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
