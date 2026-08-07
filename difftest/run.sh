#!/bin/bash
# 差分測試：拿 iOS 的 Swift 原版與 TS 移植版跑同一批測資，逐案比對。
#
# 「看起來對」不算移植成功——引擎類的東西一定要這樣驗。用法：
#   ./difftest/run.sh
#
# 兩邊的 LCG 亂數與案例產生邏輯必須逐字對應（main.swift 與 harness.ts），
# 改其中一邊記得改另一邊，否則測的是兩批不同的資料、全綠也沒有意義。
set -e
cd "$(dirname "$0")/.."
SRC="../ALIGN/ALIGN.swiftpm/Sources/Engines/AlignmentEngine.swift"
OUT="${TMPDIR:-/tmp}/aligncore-difftest"
mkdir -p "$OUT"

echo "→ 編譯並執行 Swift 原版"
swiftc -O difftest/main.swift "$SRC" -o "$OUT/swiftref"
"$OUT/swiftref" > "$OUT/swift.json"

echo "→ 打包並執行 TS 移植版"
npx esbuild difftest/harness.ts --bundle --format=esm --platform=node \
  --outfile="$OUT/ts.mjs" --log-level=error
node "$OUT/ts.mjs" > "$OUT/ts.json"

echo "→ 比對"
python3 - "$OUT" <<'PY'
import json, sys
d = sys.argv[1]
a = json.load(open(f"{d}/swift.json")); b = json.load(open(f"{d}/ts.json"))
assert len(a) == len(b), f"案例數不同：{len(a)} vs {len(b)}"
EPS = 1e-6
def same(x, y):
    if any(abs(x[k] - y[k]) > EPS for k in "xywh"): return False
    if x["snappedX"] != y["snappedX"] or x["snappedY"] != y["snappedY"]: return False
    for key in ("guides", "badges"):
        if len(x[key]) != len(y[key]): return False
        if any(abs(p - q) > EPS for g, h in zip(x[key], y[key]) for p, q in zip(g, h)): return False
    return True
bad = [i for i, (x, y) in enumerate(zip(a, b)) if not same(x, y)]
sx = sum(1 for r in a if r["snappedX"]); sy = sum(1 for r in a if r["snappedY"])
print(f"  {len(a)} 筆案例 · X 吸附 {sx} · Y 吸附 {sy} · "
      f"參考線 {sum(len(r['guides']) for r in a)} 條 · 等距徽章 {sum(len(r['badges']) for r in a)} 個")
if bad:
    print(f"  ❌ 不一致 {len(bad)} 筆，前幾筆索引：{bad[:10]}"); sys.exit(1)
print("  ✅ 與 Swift 原版逐案相同")
PY
