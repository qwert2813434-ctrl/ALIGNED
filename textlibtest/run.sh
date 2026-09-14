#!/bin/bash
# 文字庫的兩層驗證（2026-09-14）：
#  1. 對照：iOS 原檔 TextMemo.swift 與 TS 移植 src/core/textmemo.ts 跑同一批測資，逐案比對字數／句數／段數、
#     稿紙格子、清單名字與摘要、.md 編碼解碼、框寬、檔名——手機比指紋，差一個空白都算改過。
#  2. 互通：iOS 原檔 TextMemoLibrary＋TextMemoSync 編成「iPhone／iPad」，跟桌面版 src/textlib.ts
#     讀寫同一個暫存資料夾，走一遍新增、改、衝突副本、刪除與墓碑、防誤刪、收進文字庫、收斂。
# 用法：./textlibtest/run.sh（需要 ../ALIGN/ALIGN.swiftpm 在旁邊）
set -euo pipefail
cd "$(dirname "$0")/.."
IOS="../ALIGN/ALIGN.swiftpm/Sources"
SRCS=("$IOS/TextMemo.swift" "$IOS/TextMemoLibrary.swift" "$IOS/TextMemoSync.swift")
OUT="${TMPDIR:-/tmp}/aligncore-textlibtest"
mkdir -p "$OUT"

echo "→ 編譯 iOS 原檔"
swiftc -O -module-name TextLibRef textlibtest/ref/main.swift "${SRCS[@]}" -o "$OUT/swiftref"
swiftc -O -module-name TextLibSync textlibtest/synccli/main.swift "${SRCS[@]}" -o "$OUT/synccli"

echo "→ 字元判斷（全 Unicode）"
swiftc -O -module-name TextLibScalars textlibtest/scalars/main.swift -o "$OUT/scalars"
"$OUT/scalars" > "$OUT/scalars-swift.json"
npx esbuild textlibtest/scalars.ts --bundle --format=esm --platform=node --outfile="$OUT/scalars.mjs" --log-level=error
node "$OUT/scalars.mjs" > "$OUT/scalars-ts.json"
python3 textlibtest/scalars.py "$OUT/scalars-swift.json" "$OUT/scalars-ts.json"

echo "→ 對照"
python3 textlibtest/fixtures.py > "$OUT/fixtures.json"
"$OUT/swiftref" "$OUT/fixtures.json" > "$OUT/swift.json"
npx esbuild textlibtest/harness.ts --bundle --format=esm --platform=node --outfile="$OUT/harness.mjs" --log-level=error
node "$OUT/harness.mjs" "$OUT/fixtures.json" > "$OUT/ts.json"
python3 textlibtest/compare.py "$OUT/swift.json" "$OUT/ts.json"

echo "→ 互通"
npx esbuild textlibtest/interop.ts --bundle --format=esm --platform=node --outfile="$OUT/interop.mjs" --log-level=error
node "$OUT/interop.mjs" "$OUT/synccli"
