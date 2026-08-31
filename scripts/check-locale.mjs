// 掃出所有 __("…") 的字面量，比對 src/locales/en.ts 少了哪幾條。
//
// 為什麼需要這支：`__()` 查不到 key 就**原樣回傳繁中**，不報錯、不是空字串，
// 所以編譯、selftest、跑 App 都看不出來——只有把語系切成英文才會發現整片中文。
// 2026-08-31 的 c5 孔版＋撕紙邊整組 17 條就是這樣漏掉的（發版審查才抓到）。
// 用法：node scripts/check-locale.mjs   （發版前跑一次；有缺就非零離開）
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// ⚠️ 用 fileURLToPath 不能用 .pathname——這個專案的路徑有空格與中文，
// .pathname 給的是 %20／百分號編碼，fs 一定 ENOENT。
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const files = [];
const walk = (d) => {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) { if (n !== "locales") walk(p); }
    else if (n.endsWith(".ts")) files.push(p);
  }
};
walk(join(ROOT, "src"));

const keys = new Set();
// __("…") 與 __f("…", …)：只收單行純字面量（樣板字串／變數本來就不該當 key）
const RE = /\b__f?\(\s*"((?:[^"\\]|\\.)*)"/g;
for (const f of files) {
  if (f.endsWith("selftest.ts") || f.endsWith("cachetest.ts")) continue;   // 測試不出貨
  const src = readFileSync(f, "utf8");
  for (const m of src.matchAll(RE)) keys.add(m[1].replace(/\\"/g, '"'));
}

const en = readFileSync(join(ROOT, "src/locales/en.ts"), "utf8");
const have = new Set([...en.matchAll(/^\s*"((?:[^"\\]|\\.)*)"\s*:/gm)].map((m) => m[1].replace(/\\"/g, '"')));

// 全 ASCII 的 key（"OK"、"×"…）翻不翻都一樣，不算缺
const missing = [...keys].filter((k) => !have.has(k) && /[^\x00-\x7F]/.test(k)).sort();
if (!missing.length) {
  console.log(`✅ en.ts 覆蓋完整（掃到 ${keys.size} 條 key）`);
  process.exit(0);
}
console.log(`❌ en.ts 缺 ${missing.length} 條：`);
for (const k of missing) console.log(`  "${k}": "",`);
process.exit(1);
