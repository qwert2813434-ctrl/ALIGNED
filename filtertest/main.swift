// 濾鏡參考器：用 App 真正的 FilterEngine 產生兩樣東西。
//
//  1. 三顆 Apple 私有濾鏡（Noir／Mono／Tonal）的 3D 查找表——這三個是唯一
//     沒有公開參數、TS 端算不出來的東西。其餘配方（matrix／curve／polynomial／
//     colorControls）都有精確數值，TS 直接算，不需要查表。
//  2. 九顆濾鏡套在測試圖上的參考輸出，給 TS 版做逐像素比對。
//
// 配方本身取自 App 原始檔（build.sh 會把 UIKit 那 30 行剝掉），不是手抄的。
import CoreImage
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let ctx = CIContext(options: [.workingColorSpace: CGColorSpace(name: CGColorSpace.sRGB) as Any])
let sRGB = CGColorSpace(name: CGColorSpace.sRGB)!
let outDir = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "."
let N = 32   // 查找表每軸取樣數

func writePNG(_ img: CIImage, _ path: String) {
    guard let cg = ctx.createCGImage(img, from: img.extent, format: .RGBA8, colorSpace: sRGB),
          let dest = CGImageDestinationCreateWithURL(
            URL(fileURLWithPath: path) as CFURL, UTType.png.identifier as CFString, 1, nil)
    else { fatalError("寫檔失敗 \(path)") }
    CGImageDestinationAddImage(dest, cg, nil)
    CGImageDestinationFinalize(dest)
}

// ── 1. 三顆私有濾鏡的 3D 查找表 ────────────────────────────────────
// 做法：組一張 N³ 像素的「單位立方體」圖（每個像素代表一組 RGB 輸入），
// 丟進濾鏡跑一次，讀回來就是完整映射。輸出都是灰階，所以每格只存一個位元組。
func buildLUT(_ chain: String) -> Data {
    var src = [UInt8](repeating: 255, count: N * N * N * 4)
    for b in 0..<N { for g in 0..<N { for r in 0..<N {
        let i = ((b * N + g) * N + r) * 4
        src[i]     = UInt8(r * 255 / (N - 1))
        src[i + 1] = UInt8(g * 255 / (N - 1))
        src[i + 2] = UInt8(b * 255 / (N - 1))
    }}}
    let img = CIImage(bitmapData: Data(src), bytesPerRow: N * 4,
                      size: CGSize(width: N, height: N * N),
                      format: .RGBA8, colorSpace: sRGB)
    // 兩種來源：App 自己的濾鏡代號（走真正的 FilterEngine 配方），
    // 或直接一顆 CI 濾鏡名（給 c1 的 Mono 前段用）。
    let out = chain.hasPrefix("CI") ? img.applyingFilter(chain) : FilterEngine.applyCI(chain, to: img)
    guard let cg = ctx.createCGImage(out, from: out.extent, format: .RGBA8, colorSpace: sRGB)
    else { fatalError("查找表渲染失敗 \(chain)") }

    var dst = [UInt8](repeating: 0, count: N * N * N * 4)
    let c = CGContext(data: &dst, width: N, height: N * N, bitsPerComponent: 8,
                      bytesPerRow: N * 4, space: sRGB,
                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    c.draw(cg, in: CGRect(x: 0, y: 0, width: N, height: N * N))

    var lut = Data(count: N * N * N * 3)   // RGB 三通道（b2 不是灰階）
    for i in 0..<(N * N * N) {
        lut[i * 3]     = dst[i * 4]
        lut[i * 3 + 1] = dst[i * 4 + 1]
        lut[i * 3 + 2] = dst[i * 4 + 2]
    }
    return lut
}

// ⚠️ 只有**逐像素**的濾鏡可以烤成查找表。含空間效果的（Bloom／半調網點／顆粒）
//    在單位立方體上跑出來的結果毫無意義，絕對不能用這條路。
//    a1/a2/a3/b2 全鏈都是逐像素；c1 只有前段的 Mono 是。
for (name, chain) in [("a1", "a1"), ("a2", "a2"), ("a3", "a3"), ("b2", "b2"),
                      ("mono", "CIPhotoEffectMono")] {
    let lut = buildLUT(chain)
    try! lut.write(to: URL(fileURLWithPath: "\(outDir)/lut_\(name).bin"))
    print("查找表 \(name)：\(lut.count) bytes")
}

// ── 1b. 色調曲線的 256 階查找表 ────────────────────────────────────
// CIToneCurve 的插值方式沒有公開規格（是某種 spline），與其在 TS 猜一條，
// 不如把它實際跑出來的映射直接導出。曲線是逐通道等同的，所以 1D 就精確。
let curves: [(String, [(Double, Double)])] = [
    ("faded",     [(0, 0.10), (0.25, 0.31), (0.5, 0.53), (0.75, 0.75), (1, 0.92)]),
    ("redFilter", [(0, 0.00), (0.25, 0.14), (0.5, 0.52), (0.75, 0.80), (1, 0.93)]),
    ("infrared",  [(0, 0.00), (0.30, 0.22), (0.6, 0.66), (0.8, 0.86), (1, 1.00)]),
    ("finePaper", [(0, 0.07), (0.25, 0.28), (0.5, 0.52), (0.75, 0.75), (1, 0.94)]),
]
for (name, pts) in curves {
    var ramp = [UInt8](repeating: 255, count: 256 * 4)
    for i in 0..<256 { ramp[i * 4] = UInt8(i); ramp[i * 4 + 1] = UInt8(i); ramp[i * 4 + 2] = UInt8(i) }
    let img = CIImage(bitmapData: Data(ramp), bytesPerRow: 256 * 4,
                      size: CGSize(width: 256, height: 1), format: .RGBA8, colorSpace: sRGB)
    var params: [String: Any] = [:]
    for (i, p) in pts.enumerated() { params["inputPoint\(i)"] = CIVector(x: p.0, y: p.1) }
    let out = img.applyingFilter("CIToneCurve", parameters: params)
    guard let cg = ctx.createCGImage(out, from: out.extent, format: .RGBA8, colorSpace: sRGB)
    else { fatalError("曲線渲染失敗 \(name)") }
    var dst = [UInt8](repeating: 0, count: 256 * 4)
    let c = CGContext(data: &dst, width: 256, height: 1, bitsPerComponent: 8, bytesPerRow: 256 * 4,
                      space: sRGB, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    c.draw(cg, in: CGRect(x: 0, y: 0, width: 256, height: 1))
    var lut = Data(count: 256)
    for i in 0..<256 { lut[i] = dst[i * 4] }
    try! lut.write(to: URL(fileURLWithPath: "\(outDir)/curve_\(name).lut"))
    print("曲線查找表 \(name)")
}

// ── 1c. 顆粒貼片 ──────────────────────────────────────────────────
// CIRandomGenerator 是 Apple 的固定偽隨機場，TS 端無法重現——但**它的重複單元
// 只有 256×256**（實測兩軸位移 256 誤差皆為 0）。所以整層顆粒（去飽和→強度→
// 偏移→模糊，全套）直接導出成一張 256 貼片，TS 端用 modulo 平鋪即可逐像素相同。
//
// 為什麼不導原始噪點讓 TS 自己算：CIRandomGenerator 連 alpha 都是隨機的，
// 存成 PNG 走預乘會失真，讀回來的根本不是原值（實測顆粒層平均 162 vs 真實 198）。
// 把整層烤好就沒有亮度權重／偏移／高斯核這三個猜測了。
//
// 從 768 的大場取中央 256——場是週期性的，這樣切出來相位與 (0,0) 一致，
// 而且模糊在貼片邊緣不會有接縫。
let grainSpecs: [(String, Double, Double)] = [
    ("b1", 0.35, 0.5), ("c1", 0.30, 0.6), ("c3", 0.55, 0.4), ("c4", 0.42, 1.4),
]
for (name, st, bl) in grainSpecs {
    let big = CGRect(x: 0, y: 0, width: 768, height: 768)
    let tile = CGRect(x: 256, y: 256, width: 256, height: 256)
    let layer = FilterEngine.grainLayer(CGFloat(st), blur: CGFloat(bl), ext: big)
    // ⚠️ 顆粒層的 **alpha 也是隨機的**（CIColorMatrix 只動 RGB 向量，alpha 穿過去），
    //    而 CISoftLightBlendMode 是 alpha 感知的。分成兩張存：一張是把 alpha 壓成 1
    //    的純 RGB，一張是把 alpha 搬進 RGB 的遮罩。混在一起存會被預乘吃掉。
    let rgb = layer.applyingFilter("CIColorMatrix", parameters: [
        "inputAVector": CIVector(x: 0, y: 0, z: 0, w: 0),
        "inputBiasVector": CIVector(x: 0, y: 0, z: 0, w: 1)])
    let alpha = layer.applyingFilter("CIColorMatrix", parameters: [
        "inputRVector": CIVector(x: 0, y: 0, z: 0, w: 1),
        "inputGVector": CIVector(x: 0, y: 0, z: 0, w: 1),
        "inputBVector": CIVector(x: 0, y: 0, z: 0, w: 1),
        "inputAVector": CIVector(x: 0, y: 0, z: 0, w: 0),
        "inputBiasVector": CIVector(x: 0, y: 0, z: 0, w: 1)])
    writePNG(rgb.cropped(to: tile), "\(outDir)/grain_\(name).png")
    writePNG(alpha.cropped(to: tile), "\(outDir)/grainA_\(name).png")
    print("顆粒貼片 \(name)（含 alpha）")
}


// ── 1e. 半調網屏表 ────────────────────────────────────────────────
// CIDotScreen 的網屏函數沒有公開規格（試著用 sin·sin 擬合，殘差 37/255＝完全不對）。
// 但實測它是「位置 mod 間距」與亮度的函數：**角度 −0.3 rad（不是 +0.3，CI 的 y 軸
// 朝上所以符號相反）、間距 5.0 px**，殘差降到 3/255。
// 所以烤一張 32×32×17 的表：兩軸是週期內的相對位置，第三軸是輸入亮度。才 17 KB。
do {
    let B = 32, LEVELS = 17, side = 256
    let ext = CGRect(x: 0, y: 0, width: side, height: side)
    let ang = -0.3, pitch = 5.0
    var table = Data(count: LEVELS * B * B)
    for lv in 0..<LEVELS {
        let g = CGFloat(lv) / CGFloat(LEVELS - 1)
        let flat = CIImage(color: CIColor(red: g, green: g, blue: g)).cropped(to: ext)
        let out = flat.applyingFilter("CIDotScreen", parameters: [
            "inputCenter": CIVector(x: ext.midX, y: ext.midY),
            "inputAngle": 0.3, "inputWidth": 5.0, "inputSharpness": 0.55]).cropped(to: ext)
        guard let cg = ctx.createCGImage(out, from: ext, format: .RGBA8, colorSpace: sRGB)
        else { fatalError("網屏渲染失敗") }
        var px = [UInt8](repeating: 0, count: side * side * 4)
        let c = CGContext(data: &px, width: side, height: side, bitsPerComponent: 8,
                          bytesPerRow: side * 4, space: sRGB,
                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        c.draw(cg, in: ext)
        var sum = [Double](repeating: 0, count: B * B), cnt = [Double](repeating: 0, count: B * B)
        for y in 0..<side { for x in 0..<side {
            // PNG 是上下顛倒的，換回 CI 座標再旋轉
            let dx = Double(x) - Double(side) / 2, dy = Double(side - 1 - y) - Double(side) / 2
            var rx = (dx * cos(ang) - dy * sin(ang)).truncatingRemainder(dividingBy: pitch)
            var ry = (dx * sin(ang) + dy * cos(ang)).truncatingRemainder(dividingBy: pitch)
            if rx < 0 { rx += pitch }; if ry < 0 { ry += pitch }
            let bx = min(Int(rx / pitch * Double(B)), B - 1), by = min(Int(ry / pitch * Double(B)), B - 1)
            sum[by * B + bx] += Double(px[(y * side + x) * 4]); cnt[by * B + bx] += 1
        }}
        for i in 0..<(B * B) {
            table[lv * B * B + i] = UInt8(cnt[i] > 0 ? min(255, max(0, sum[i] / cnt[i])) : 0)
        }
    }
    try! table.write(to: URL(fileURLWithPath: "\(outDir)/dotscreen.bin"))
    print("半調網屏表 \(table.count) bytes")
}

// ── 2. 九顆濾鏡的參考輸出 ──────────────────────────────────────────
// 測試圖：橫向色相掃描 × 縱向明度階，外加一塊高頻棋盤格
// （Bloom／半調網點／顆粒這些空間性效果，平坦色塊看不出差異）。
let W = 256, H = 256
var px = [UInt8](repeating: 255, count: W * H * 4)
func hsv(_ h: Double, _ s: Double, _ v: Double) -> (Double, Double, Double) {
    let i = Int(h * 6) % 6, f = h * 6 - Double(Int(h * 6))
    let p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s)
    switch i {
    case 0: return (v, t, p); case 1: return (q, v, p); case 2: return (p, v, t)
    case 3: return (p, q, v); case 4: return (t, p, v); default: return (v, p, q)
    }
}
for y in 0..<H { for x in 0..<W {
    let i = (y * W + x) * 4
    var (r, g, b) = hsv(Double(x) / Double(W), 0.85, Double(H - y) / Double(H))
    if x > 190 && y > 190 {                       // 高頻棋盤，測空間性效果
        let on = ((x / 2) + (y / 2)) % 2 == 0
        r = on ? 0.95 : 0.05; g = r; b = r
    }
    px[i] = UInt8(r * 255); px[i + 1] = UInt8(g * 255); px[i + 2] = UInt8(b * 255)
}}
let test = CIImage(bitmapData: Data(px), bytesPerRow: W * 4,
                   size: CGSize(width: W, height: H), format: .RGBA8, colorSpace: sRGB)
writePNG(test, "\(outDir)/_input.png")

for key in ["a1", "a2", "a3", "b1", "b2", "b5", "c1", "c3", "c4"] {
    writePNG(FilterEngine.applyCI(key, to: test), "\(outDir)/ref_\(key).png")
    print("參考圖 \(key)")
}
print("完成")
