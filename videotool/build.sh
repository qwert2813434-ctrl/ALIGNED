#!/bin/bash
# 編譯 alignvideo（影片頁匯出器）。
#
# 濾鏡／紙張與合成器都是從 App 的**真原始檔**取的，只做機械式的平台調整——
# iOS 端改了配方或合成順序，重跑這支就會同步，不會有手抄的近似品在旁邊漂移。
# 產物 src-tauri/bin/alignvideo，會被 Tauri 當 externalBin 打包進 .app。
set -e
cd "$(dirname "$0")/.."
APP="../ALIGN/ALIGN.swiftpm/Sources"
GEN="videotool/generated"
mkdir -p "$GEN" src-tauri/bin

echo "→ 取 App 的 FilterEngine（剝掉 UIKit）"
python3 - "$APP/Engines/FilterEngine.swift" <<'PY'
import pathlib, re, sys
s = pathlib.Path(sys.argv[1]).read_text()
s = s.replace("import UIKit", "import CoreGraphics\nimport Foundation")
for pat, what in [
    (r"\n    /// 紙張纖維層快取.*?\n    private static var paperCache.*?\n", "paperCache"),
    (r"\n    /// softLight 用的纖維噪點層.*?\n    static func paperFiber.*?\n    \}\n", "paperFiber"),
    # 手抄紙纖維（2026-08-16 加）：整段是 UIGraphicsImageRenderer 畫的 UIImage，
    # Mac 版在 main.swift 有純 CG 的 handmadeFiberCG（同配方同種子）
    (r"\n    /// 手抄紙纖維層.*?\n    static func handmadeFiber.*?\n        \}\n    \}\n", "handmadeFiber"),
    (r"\n    /// 套一顆濾鏡到 UIImage.*?\n    static func apply\(_ key: String\?, to image: UIImage\).*?\n    \}\n", "apply"),
    # 2026-08-31：appliedToColor（描邊吃紙色，2026-08-30 iOS 加的）用 UIColor——
    # 工具端用不到（compositor 不畫 SwiftUI 描邊色），整段剝掉
    (r"\n    /// 給「不能疊 blend view」的地方用.*?\n    func appliedToColor\(_ c: Color\) -> Color \{.*?\n    \}\n", "appliedToColor"),
]:
    before = s
    s = re.sub(pat, "\n", s, flags=re.S)
    assert s != before, f"{what} 沒被移除——App 端結構變了，回來看 build.sh"
# applyPaperCILive 的手抄紙分支：iOS 讀主緒 paperFiber（UIImage 快取），
# mac 改接 main.swift 的純 CG 版（同配方同種子）
s = s.replace("""            let fiber = paperFiber(paper, size: input.extent.size)
                .flatMap { $0.cgImage }.map { CIImage(cgImage: $0) }""",
"""            let fiber = handmadeFiberCG(paper, size: input.extent.size)""")
assert "handmadeFiberCG" in s, "手抄紙分支改寫沒生效——applyPaperCILive 結構變了"
assert "UIImage" not in s, "還有殘留的 UIImage"
pathlib.Path("videotool/generated/FilterEngine.mac.swift").write_text(s)
PY

echo "→ 取 App 的合成器（VideoPageExporter 裡 UIKit-free 的那一段）"
python3 - "$APP/VideoPageExporter.swift" <<'PY'
import pathlib, re, sys
src = pathlib.Path(sys.argv[1]).read_text()
start = src.index("enum CompositeLayer {")
s = src[start:]
assert "UIImage" not in s and "UIKit" not in s, "合成器那段混進了 UIKit，要重看切點"
# 紙張：iOS 在主執行緒先把纖維烤成 UIImage 再餵給 compositor；工具改成現算
# （applyPaperCILive 內部就是 grainLayer，同一組數學），所以 box 改存 key。
s = s.replace("""    var paper: PagePaper?
    var paperFiber: CIImage?""", """    var paperKey: String?""")
# 2026-08-26：iOS 端紙張加了套用範圍遮罩（papered＋CIBlendWithMask），錨點跟著改；
# 遮罩合成那段原樣保留，只把「烤好的 fiber」換成工具端現算的 Live 版。
s = s.replace("""            if let paper = box.paper {
                let papered = FilterEngine.applyPaperCI(paper, fiber: box.paperFiber,
                                                        to: composite, pageRect: pageRect)""",
"""            if let key = box.paperKey {
                let papered = FilterEngine.applyPaperCILive(key, to: composite)""")
assert "paperKey" in s and "applyPaperCILive" in s, "紙張改寫沒生效"

s = "import AVFoundation\nimport CoreImage\nimport Foundation\n\n" + s
pathlib.Path("videotool/generated/Compositor.mac.swift").write_text(s)
PY

echo "→ 編譯"
swiftc -O -parse-as-library \
  videotool/main.swift "$GEN/FilterEngine.mac.swift" "$GEN/Compositor.mac.swift" \
  -o src-tauri/bin/alignvideo

echo "✅ src-tauri/bin/alignvideo"
