// 全 Unicode 逐字的 TS 端：直接拿 core/textmemo.ts 的 charRules 判斷，輸出成立的區段（Swift 端＝scalars/main.swift）。
import { charRules } from "../src/core/textmemo";

const flags: Record<string, [number, number][]> = {};
for (const k of Object.keys(charRules)) flags[k] = [];
for (let v = 0; v <= 0x10ffff; v++) {
  if (v >= 0xd800 && v <= 0xdfff) continue;
  const s = String.fromCodePoint(v);
  for (const [k, rule] of Object.entries(charRules)) {
    if (!rule(s)) continue;
    const last = flags[k].at(-1);
    if (last && last[1] === v - 1) last[1] = v; else flags[k].push([v, v]);
  }
}
process.stdout.write(JSON.stringify(flags));
