// 遮罩修邊——導引濾波（guided filter）。
//
// 為什麼要自己寫：系統的 `CIGuidedFilter` 在這個題目上幾乎沒作用，半徑 8～45、
// epsilon 1e-6～1e-2 九組參數掃出來的輪廓一模一樣（2026-08-25 實測），
// 顯然它沒把原圖的邊當一回事。這支是照原論文寫的，逐行對得上，實測能把
// Vision 那條鈍掉的輪廓吸回鼻樑、下巴、衣領。
//
// 快速版（fast guided filter）：在縮小的工作解析度上算 a、b，算完把結果放大回去。
// 最後那刀門檻是硬邊，所以決定品質的是「場在哪裡穿過 0.5」——工作解析度
// 2000 px 換算是畫面寬度的 0.05%，比 Vision 原生的 0.48% 細十倍，夠用。
//
// 箱型模糊用前綴和（積分圖）做，複雜度與半徑無關，半徑再大也不會變慢。

import CoreGraphics
import CoreImage
import Foundation

enum Refine {
    /// 工作解析度上限。再大只是多花時間，最後都要被門檻切成硬邊。
    static let workingWidth: CGFloat = 2000

    /// 前綴和箱型模糊。`r` 是半徑（畫素），邊界用「有效樣本數」正規化，
    /// 所以四個角不會變暗——那是箱型模糊最常見的實作 bug。
    static func box(_ src: [Float], _ w: Int, _ h: Int, _ r: Int) -> [Float] {
        var out = [Float](repeating: 0, count: w * h)
        var rowSum = [Float](repeating: 0, count: (w + 1) * h)
        for y in 0..<h {
            var acc: Float = 0
            let base = y * (w + 1), s = y * w
            for x in 0..<w { acc += src[s + x]; rowSum[base + x + 1] = acc }
        }
        // 橫向
        var horiz = [Float](repeating: 0, count: w * h)
        for y in 0..<h {
            let base = y * (w + 1), s = y * w
            for x in 0..<w {
                let l = max(0, x - r), rr = min(w, x + r + 1)
                horiz[s + x] = (rowSum[base + rr] - rowSum[base + l]) / Float(rr - l)
            }
        }
        // 縱向
        var colSum = [Float](repeating: 0, count: w * (h + 1))
        for x in 0..<w {
            var acc: Float = 0
            let base = x * (h + 1)
            for y in 0..<h { acc += horiz[y * w + x]; colSum[base + y + 1] = acc }
        }
        for x in 0..<w {
            let base = x * (h + 1)
            for y in 0..<h {
                let t = max(0, y - r), b = min(h, y + r + 1)
                out[y * w + x] = (colSum[base + b] - colSum[base + t]) / Float(b - t)
            }
        }
        return out
    }

    /// 導引濾波本體。`guide` 是原圖亮度、`src` 是要修的遮罩，兩者同尺寸、值域 0…1。
    static func guided(guide I: [Float], src p: [Float], w: Int, h: Int,
                       radius r: Int, epsilon eps: Float) -> [Float] {
        let n = w * h
        var Ip = [Float](repeating: 0, count: n)
        var II = [Float](repeating: 0, count: n)
        for i in 0..<n { Ip[i] = I[i] * p[i]; II[i] = I[i] * I[i] }

        let meanI = box(I, w, h, r), meanP = box(p, w, h, r)
        let meanIp = box(Ip, w, h, r), meanII = box(II, w, h, r)

        var a = [Float](repeating: 0, count: n)
        var b = [Float](repeating: 0, count: n)
        for i in 0..<n {
            let cov = meanIp[i] - meanI[i] * meanP[i]
            let vari = meanII[i] - meanI[i] * meanI[i]
            a[i] = cov / (vari + eps)
            b[i] = meanP[i] - a[i] * meanI[i]
        }
        let meanA = box(a, w, h, r), meanB = box(b, w, h, r)

        var q = [Float](repeating: 0, count: n)
        for i in 0..<n { q[i] = meanA[i] * I[i] + meanB[i] }
        return q
    }

    /// CIImage → 單通道 Float（先轉灰階再取一個通道）。
    static func gray(_ image: CIImage, _ ctx: CIContext, _ w: Int, _ h: Int) -> [Float] {
        let scale = CGFloat(w) / image.extent.width
        let small = image
            .transformed(by: CGAffineTransform(scaleX: scale, y: scale))
            .cropped(to: CGRect(x: 0, y: 0, width: CGFloat(w), height: CGFloat(h)))
        let mono = CIFilter(name: "CIColorMatrix")!
        mono.setValue(small, forKey: kCIInputImageKey)
        let lum = CIVector(x: 0.2126, y: 0.7152, z: 0.0722, w: 0)
        mono.setValue(CIVector(x: 0.2126, y: 0.2126, z: 0.2126, w: 0), forKey: "inputRVector")
        mono.setValue(CIVector(x: 0.7152, y: 0.7152, z: 0.7152, w: 0), forKey: "inputGVector")
        mono.setValue(CIVector(x: 0.0722, y: 0.0722, z: 0.0722, w: 0), forKey: "inputBVector")
        mono.setValue(CIVector(x: 0, y: 0, z: 0, w: 1), forKey: "inputAVector")
        _ = lum
        var px = [UInt8](repeating: 0, count: w * h * 4)
        ctx.render(mono.outputImage ?? small, toBitmap: &px, rowBytes: w * 4,
                   bounds: CGRect(x: 0, y: 0, width: CGFloat(w), height: CGFloat(h)),
                   format: .RGBA8, colorSpace: CGColorSpaceCreateDeviceRGB())
        var out = [Float](repeating: 0, count: w * h)
        for i in 0..<(w * h) { out[i] = Float(px[i * 4]) / 255 }
        return out
    }

    /// Float 陣列 → CIImage（灰階）。
    static func image(_ buf: [Float], _ w: Int, _ h: Int) -> CIImage? {
        var bytes = [UInt8](repeating: 0, count: w * h)
        for i in 0..<(w * h) { bytes[i] = UInt8(max(0, min(255, buf[i] * 255))) }
        guard let provider = CGDataProvider(data: Data(bytes) as CFData),
              let cg = CGImage(width: w, height: h, bitsPerComponent: 8, bitsPerPixel: 8,
                               bytesPerRow: w, space: CGColorSpaceCreateDeviceGray(),
                               bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.none.rawValue),
                               provider: provider, decode: nil, shouldInterpolate: true,
                               intent: .defaultIntent)
        else { return nil }
        return CIImage(cgImage: cg)
    }

    /// 對外入口：把遮罩吸附到原圖的邊上，回傳修好的遮罩（與原圖同尺寸、值域 0…1 的灰階）。
    /// 失敗回 nil，呼叫端就照原樣用未修的遮罩。
    static func snap(mask: CIImage, to photo: CIImage, ctx: CIContext) -> CIImage? {
        let full = photo.extent
        let w = Int(min(workingWidth, full.width))
        let h = max(1, Int((full.height / full.width) * CGFloat(w)))
        guard w > 8, h > 8 else { return nil }

        let I = gray(photo, ctx, w, h)
        let p = gray(mask, ctx, w, h)
        // 半徑取工作寬度的 0.3%、epsilon 1e-4——這組是對著小高的街拍調出來的。
        // 半徑是最敏感的一個數：拉到 1.5% 邊界會整條往外飄、離開頭皮好幾十畫素
        // （2026-08-25 實測），因為導引濾波的視窗一大就把頭髮與背景平均在一起了。
        let q = guided(guide: I, src: p, w: w, h: h, radius: max(3, w * 3 / 1000), epsilon: 1e-4)

        guard let small = image(q, w, h) else { return nil }
        // 放大要用 Lanczos，不能用仿射變換——後者在這裡等於最近鄰，
        // 門檻切下去會是一圈階梯狀的鋸齒。
        let scale = CIFilter(name: "CILanczosScaleTransform")!
        scale.setValue(small, forKey: kCIInputImageKey)
        scale.setValue(full.width / CGFloat(w), forKey: kCIInputScaleKey)
        scale.setValue(1.0, forKey: kCIInputAspectRatioKey)
        let up = scale.outputImage ?? small.transformed(
            by: CGAffineTransform(scaleX: full.width / CGFloat(w), y: full.height / CGFloat(h)))
        return up.cropped(to: full)
    }
}
