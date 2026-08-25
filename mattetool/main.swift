// alignmatte — ALIGNED 的去背遮罩產生器（Mac 端）。
//
// 這支只做一件事：吃一張照片，吐一張**灰階遮罩 PNG**（白＝主體、黑＝背景），
// 尺寸與轉正後的原圖 1:1。刻意不吐「去好背的人」，因為遮罩才是通用素材——
// 留人、留背景（反轉）、人形當窗口填另一張圖，三種模式都是同一張遮罩在畫布端
// 換個合成方式而已，多存一份切好的圖只會多一份會漂移的資產。
//
// Mac 走 Vision（系統內建、離線、免下載模型）：
//   1. VNGenerateForegroundInstanceMaskRequest — 主體抽取，就是照片 App 長按
//      把人提起來的那顆。人、動物、物件都吃。
//   2. 抽不到主體時退到 VNGeneratePersonSegmentationRequest（.accurate）——
//      逆光、糊掉、人很小的街拍，前者常常整張放棄，後者仍給得出人形。
//
// Windows 端是另一支同名工具（ONNX 外掛模型），**CLI 介面與輸出格式完全相同**，
// 畫布端因此不需要知道自己跑在哪個平台。
//
// 修邊（2026-08-25）：Vision 的遮罩不論餵多大的圖，過渡帶都固定是畫面寬度的
// 0.48%——細節量是模型定的，不是輸入解析度定的，所以直接用會是一坨鈍掉的輪廓
// （鼻樑、下巴、手指縫全部被抹平）。解法是拿**原圖自己的邊**當導引做一次導引
// 濾波（CIGuidedFilter，系統內建），把那條軟邊吸附回真實邊界，再重新切一次門檻。
// 成本是幾毫秒的算術，沒有多載任何模型。`--raw` 可以關掉，用來 A/B 對照。
//
// 覆蓋率健檢（2026-08-25）：Vision 的「主體」是它認為最顯著的東西，不是人。
// 小高的建築街拍實測，四張裡它把**整棟樓**圈起來當主體（覆蓋率 41–57%），
// 而人像正確的那幾張只有 2–6%。所以遮罩太大是一個可用的誤判訊號。
//
// 但它只是訊號不是判決——大特寫的臉本來就可能佔半張畫面（實測那張兩人合照
// 正確答案就是 27.8%）。所以這裡**不擋**，只在 stdout 多回一個 suspect 標記，
// 讓上層決定要不要改用另一顆去背器重跑、或提示使用者換一種。
// 樣本數只有 14 張、合法大主體只有一張，門檻先放 35%，之後有更多資料再調。
//
// 用法：alignmatte <輸入圖> <輸出遮罩.png> [--raw] [--max-coverage <0–100>]
// 回傳：0＝成功／2＝找不到主體／1＝其他錯誤。
// 成功時 stdout＝"ok <寬> <高> <來源> <覆蓋率%> <fine|suspect>"

import CoreImage
import Foundation
import Vision

func fail(_ msg: String, _ code: Int32) -> Never {
    FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
    exit(code)
}

var args = CommandLine.arguments
let refineEdges = !args.contains("--raw")
args.removeAll { $0 == "--raw" }
var maxCoverage = 35.0
if let i = args.firstIndex(of: "--max-coverage"), i + 1 < args.count {
    maxCoverage = Double(args[i + 1]) ?? maxCoverage
    args.removeSubrange(i...(i + 1))
}
guard args.count == 3 else { fail("用法：alignmatte <輸入圖> <輸出遮罩.png> [--raw]", 1) }
let inURL = URL(fileURLWithPath: args[1])
let outURL = URL(fileURLWithPath: args[2])

guard var image = CIImage(contentsOf: inURL) else { fail("讀不到圖：\(args[1])", 1) }
// EXIF 轉正——手機直拍的照片沒轉正的話遮罩會躺著，跟畫布上看到的對不起來。
if let o = image.properties[kCGImagePropertyOrientation as String] as? UInt32,
   let orientation = CGImagePropertyOrientation(rawValue: o) {
    image = image.oriented(orientation)
}
let extent = image.extent
guard extent.width >= 1, extent.height >= 1 else { fail("圖是空的", 1) }

let handler = VNImageRequestHandler(ciImage: image, options: [:])

/// 遮罩畫素緩衝 → 灰階（R=G=B=遮罩、A 全滿）PNG。
/// 存成 RGBA8 而不是單通道，是因為 CIContext 的 PNG 輸出只有 RGBA 系列保證
/// 每個系統版本都在；灰階資訊照樣是無損的，畫布端讀亮度即可。
/// 遮罩佔畫面的百分比，健檢與回報都用它。
var coveragePercent = 0.0

func writeMask(_ buffer: CVPixelBuffer, source: String) -> Never {
    // workingColorSpace 關掉（NSNull）——遮罩是純數值不是顏色。開著的話 Core Image
    // 會先把它當 sRGB 轉進線性空間，門檻那把刀就切在錯的地方（實測整張切成全黑）。
    let ctx = CIContext(options: [.workingColorSpace: NSNull()])

    var mask = CIImage(cvPixelBuffer: buffer)
    // 遮罩有時比原圖小一兩個像素（Vision 內部縮放），拉回原圖尺寸再存，
    // 畫布端就能無條件把遮罩與圖當同一個座標系用。
    if mask.extent.size != extent.size {
        mask = mask.transformed(by: CGAffineTransform(scaleX: extent.width / mask.extent.width,
                                                      y: extent.height / mask.extent.height))
    }
    mask = mask.transformed(by: CGAffineTransform(translationX: extent.minX - mask.extent.minX,
                                                  y: extent.minY - mask.extent.minY))
    // 單通道遮罩的值只落在紅通道，直接存 RGBA 會變成一張紅色的圖。
    // 用「白疊黑、紅通道當混合遮罩」把它攤成正規灰階——比 CIColorMatrix
    // 可靠，因為不必假設 Vision 的緩衝把值放進哪幾個通道。
    guard let blend = CIFilter(name: "CIBlendWithRedMask") else { fail("CIBlendWithRedMask 建不起來", 1) }
    blend.setValue(CIImage(color: .white).cropped(to: extent), forKey: kCIInputImageKey)
    blend.setValue(CIImage(color: .black).cropped(to: extent), forKey: kCIInputBackgroundImageKey)
    blend.setValue(mask, forKey: kCIInputMaskImageKey)
    guard var out = blend.outputImage else { fail("遮罩轉檔失敗", 1) }

    // 修邊——見檔頭與 Refine.swift。導引濾波把軟邊吸回真實邊界，
    // 再用陡峭的曲線切成硬邊（貼紙感靠硬邊，糊邊看起來就是合成失敗）。
    if refineEdges, let snapped = Refine.snap(mask: out, to: image, ctx: ctx) {
        let t = CIFilter(name: "CIToneCurve")!
        t.setValue(snapped, forKey: kCIInputImageKey)
        // 切點 0.42 偏低＝寧可外擴一點點；±0.06 的過渡帶留一格抗鋸齒。
        // 註：這裡不用 CIColorMatrix 做同樣的線性拉伸——biasVector 只要帶負值，
        // 整張就會被切成全黑（2026-08-25 實測），CIToneCurve 沒這個毛病。
        let pv: CGFloat = 0.42, d: CGFloat = 0.06
        t.setValue(CIVector(x: 0, y: 0), forKey: "inputPoint0")
        t.setValue(CIVector(x: pv - d, y: 0), forKey: "inputPoint1")
        t.setValue(CIVector(x: pv, y: 0.5), forKey: "inputPoint2")
        t.setValue(CIVector(x: pv + d, y: 1), forKey: "inputPoint3")
        t.setValue(CIVector(x: 1, y: 1), forKey: "inputPoint4")
        if let hard = t.outputImage { out = hard.cropped(to: extent) }
    }

    // 守門：人物分割在「根本沒有人」的圖上（純標題卡、風景）不會失敗，
    // 它會回一張幾乎全黑的遮罩然後說成功。全黑或全白都等於沒抽到——
    // 與其讓畫布端拿到一張沒用的遮罩，不如在這裡就當找不到主體。
    guard let avgFilter = CIFilter(name: "CIAreaAverage") else { fail("CIAreaAverage 建不起來", 1) }
    avgFilter.setValue(out.cropped(to: extent), forKey: kCIInputImageKey)
    avgFilter.setValue(CIVector(cgRect: extent), forKey: kCIInputExtentKey)
    if let avgImage = avgFilter.outputImage {
        var px = [UInt8](repeating: 0, count: 4)
        ctx.render(avgImage, toBitmap: &px, rowBytes: 4, bounds: CGRect(x: 0, y: 0, width: 1, height: 1),
                   format: .RGBA8, colorSpace: CGColorSpaceCreateDeviceRGB())
        coveragePercent = Double(px[0]) / 255.0 * 100
        if coveragePercent < 0.3 || coveragePercent > 99 {
            fail("這張圖找不到可以抽出來的主體（遮罩覆蓋率 \(Int(coveragePercent))%）", 2)
        }
    }

    do {
        try ctx.writePNGRepresentation(of: out.cropped(to: extent), to: outURL,
                                       format: .RGBA8, colorSpace: CGColorSpaceCreateDeviceRGB())
    } catch { fail("寫檔失敗：\(error.localizedDescription)", 1) }
    let verdict = coveragePercent > maxCoverage ? "suspect" : "fine"
    print("ok \(Int(extent.width)) \(Int(extent.height)) \(source) "
          + String(format: "%.1f", coveragePercent) + " \(verdict)")
    exit(0)
}

// ① 主體抽取
let subject = VNGenerateForegroundInstanceMaskRequest()
if (try? handler.perform([subject])) != nil,
   let obs = subject.results?.first,
   !obs.allInstances.isEmpty,
   let buffer = try? obs.generateScaledMaskForImage(forInstances: obs.allInstances, from: handler) {
    writeMask(buffer, source: "subject")
}

// ② 退而求其次：人物分割
let person = VNGeneratePersonSegmentationRequest()
person.qualityLevel = .accurate
person.outputPixelFormat = kCVPixelFormatType_OneComponent8
if (try? handler.perform([person])) != nil,
   let buffer = person.results?.first?.pixelBuffer {
    writeMask(buffer, source: "person")
}

fail("這張圖找不到可以抽出來的主體", 2)
