#!/bin/bash
# 重新產生濾鏡資產（查找表／顆粒貼片／半調網屏表）與參考圖，並安裝到 public/。
#
# 產生器連結的是 App **真正的** FilterEngine.swift，只把 UIKit 那 30 行剝掉——
# 配方不是手抄的。iOS 端改配方後跑這支就會同步。
#
# 比對結果看 http://localhost:5173/filtertest.html
set -e
cd "$(dirname "$0")/.."
SRC="../ALIGN/ALIGN.swiftpm/Sources/Engines/FilterEngine.swift"
OUT="${TMPDIR:-/tmp}/aligncore-filters"
mkdir -p "$OUT"

echo "→ 從 App 原始檔產生 macOS 可編譯版本"
python3 - "$SRC" <<'PY'
import pathlib, re, sys
src = pathlib.Path(sys.argv[1]).read_text()
s = src.replace("import UIKit", "import CoreGraphics\nimport Foundation")
for pat, what in [
    (r"\n    /// 紙張纖維層快取.*?\n    private static var paperCache.*?\n", "paperCache"),
    (r"\n    /// softLight 用的纖維噪點層.*?\n    static func paperFiber.*?\n    \}\n", "paperFiber"),
    (r"\n    /// 套一顆濾鏡到 UIImage.*?\n    static func apply\(_ key: String\?, to image: UIImage\).*?\n    \}\n", "apply"),
]:
    before = s
    s = re.sub(pat, "\n", s, flags=re.S)
    assert s != before, f"{what} 沒被移除——原始檔結構變了，請重看 run.sh 的剝除規則"
assert "UIImage" not in s, "還有殘留的 UIImage"
s = s.replace("private static func grainLayer", "static func grainLayer")  # 參考器要直接取顆粒層
pathlib.Path("filtertest/FilterEngine.mac.swift").write_text(s)
PY

echo "→ 編譯並執行參考器"
swiftc -O filtertest/main.swift filtertest/FilterEngine.mac.swift -o "$OUT/filterref"
"$OUT/filterref" "$OUT"

echo "→ 安裝資產"
mkdir -p public/luts public/filterref
cp "$OUT"/lut_*.bin "$OUT"/curve_*.lut "$OUT"/grain*.png "$OUT"/dotscreen.bin public/luts/
cp "$OUT"/ref_*.png "$OUT"/_input.png public/filterref/
echo "  完成。比對頁：/filtertest.html"
