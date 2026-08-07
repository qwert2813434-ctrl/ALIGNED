import CoreImage
import CoreGraphics
import Foundation

/// 濾鏡系統 Stage 1 — 九顆定案配方（2026-07-30 濾鏡樣本間兩輪迭代定案）。
///
/// 配方參數與《01 - 研究/濾鏡樣本間/定案配方渲染器.swift》完全一致 — 樣本間
/// 是 Armin 視覺定案的證據，這裡只是同一套 Core Image 鏈搬進 App，所見即所得。
/// 設計鐵則（樣本間定案）：
/// - 全系列無暗角 — 暗角造成邊際，跨頁拼接會露餡。
/// - B1 紅色濾鏡＝R2 落點，單一強度不做滑桿。
/// - CIToneCurve 五個控制點必須給滿，少一點整張渲染成黑（已踩過的雷）。
enum MediaFilter: String, CaseIterable, Identifiable {
    case noir = "a1"        // 銀鹽硬調
    case mono = "a2"        // 經典中性
    case faded = "a3"       // 褪色霧面
    case redFilter = "b1"   // 紅色濾鏡（擋藍光：藍越深越黑、膚色越亮）
    case xpro = "b2"        // 正片負沖
    case infrared = "b5"    // 仿紅外線
    case newsprint = "c1"   // 報紙
    case grain = "c3"       // 底片顆粒
    case finePaper = "c4"   // 高級紙

    var id: String { rawValue }

    /// 面板顯示名 — Localizable.xcstrings 的 key（四語已補）。
    var displayName: String {
        switch self {
        case .noir: return "銀鹽"
        case .mono: return "中性"
        case .faded: return "褪色"
        case .redFilter: return "紅濾鏡"
        case .xpro: return "負沖"
        case .infrared: return "紅外"
        case .newsprint: return "報紙"
        case .grain: return "顆粒"
        case .finePaper: return "高級紙"
        }
    }
}

/// 整頁紙張覆蓋 (Stage 3, 2026-07-30) — 疊在整頁內容之上的材質層，代號沿用
/// 樣本間 C 系。與區塊濾鏡的差別：紙張不動內容的像素結構（報紙的「內容半調
/// 網點」是區塊濾鏡 C1 的事，頁面版只給紙感）。全專案單一設定 — 紙張的本質
/// 是跨頁無縫，逐頁不同紙反而在接縫露餡（與無暗角同一條鐵則）。
enum PagePaper: String, CaseIterable, Identifiable {
    case newsprint = "c1"   // 報紙：泛黃紙色 × 纖維
    case grain = "c3"       // 底片顆粒
    case finePaper = "c4"   // 高級紙：象牙紙色 × 霧面抬黑 × 粗纖維

    var id: String { rawValue }

    /// 面板顯示名 — 與區塊濾鏡共用已翻譯的 key。
    var displayName: String {
        switch self {
        case .newsprint: return "報紙"
        case .grain: return "顆粒"
        case .finePaper: return "高級紙"
        }
    }

    /// multiply 紙色層（樣本間配方的 constColor 值），nil = 無。
    var tint: (r: CGFloat, g: CGFloat, b: CGFloat)? {
        switch self {
        case .newsprint: return (0.91, 0.88, 0.78)
        case .grain: return nil
        case .finePaper: return (0.96, 0.93, 0.87)
        }
    }

    /// screen 白抬黑量（高級紙霧面曲線「黑位抬到 0.07」的覆蓋層等價）。
    var lift: CGFloat { self == .finePaper ? 0.07 : 0 }

    /// softLight 纖維噪點層的（強度, 模糊）— 與樣本間 C 系同參數。
    var fiber: (strength: CGFloat, blur: CGFloat) {
        switch self {
        case .newsprint: return (0.30, 0.6)
        case .grain: return (0.55, 0.4)
        case .finePaper: return (0.42, 1.4)
        }
    }
}

enum FilterEngine {
    /// 與樣本間渲染器同一個工作色彩空間，確保配方數值一比一。
    private static let ctx = CIContext(options: [
        .workingColorSpace: CGColorSpace(name: CGColorSpace.sRGB) as Any
    ])





    /// CIImage 級入口 (Stage 2) — 影片管線共用同一套配方：canvas 即時預覽的
    /// AVVideoComposition handler 與 mp4 匯出的逐格 compositor 都走這裡。
    /// 一律裁回輸入 extent（Bloom 會把 extent 撐大，不裁回去合成座標就歪）。
    /// 純函式、無共享狀態 — 兩個呼叫端都在背景執行緒，執行緒安全。
    static func applyCI(_ key: String?, to input: CIImage) -> CIImage {
        guard let key, let filter = MediaFilter(rawValue: key) else { return input }
        return render(filter, input: input, ext: input.extent).cropped(to: input.extent)
    }

    /// 即時預覽版紙張（canvas 影片的 AVVideoComposition handler，背景緒）—
    /// 纖維就地用 CI 噪點鏈生成（純 CI、無快取＝緒安全）。噪點是均勻場，
    /// 與頁面版的視覺無差；濾鏡與紙張同一個 handler 內先濾後紙。
    static func applyPaperCILive(_ key: String?, to input: CIImage) -> CIImage {
        guard let key, let paper = PagePaper(rawValue: key) else { return input }
        let f = paper.fiber
        return applyPaperCI(paper, fiber: grainLayer(f.strength, blur: f.blur, ext: input.extent),
                            to: input, pageRect: input.extent)
    }

    /// 紙張的 CI 版 (Stage 3b, mp4 逐格合成) — 與 PaperOverlay 的 SwiftUI
    /// 三層同數學：multiply 紙色 → screen 抬黑 → softLight 纖維。fiber 由
    /// 呼叫端在匯出開始前於主緒先生成（paperFiber 的快取是主緒限定），
    /// compositor 在背景逐格只讀不寫。
    static func applyPaperCI(_ paper: PagePaper, fiber: CIImage?, to page: CIImage, pageRect: CGRect) -> CIImage {
        var out = page
        if let t = paper.tint {
            out = CIImage(color: CIColor(red: t.r, green: t.g, blue: t.b)).cropped(to: pageRect)
                .applyingFilter("CIMultiplyBlendMode", parameters: [kCIInputBackgroundImageKey: out])
        }
        if paper.lift > 0 {
            out = CIImage(color: CIColor(red: paper.lift, green: paper.lift, blue: paper.lift)).cropped(to: pageRect)
                .applyingFilter("CIScreenBlendMode", parameters: [kCIInputBackgroundImageKey: out])
        }
        if let fiber {
            out = fiber.applyingFilter("CISoftLightBlendMode", parameters: [kCIInputBackgroundImageKey: out])
        }
        return out.cropped(to: pageRect)
    }

    private static func render(_ filter: MediaFilter, input: CIImage, ext: CGRect) -> CIImage {
        switch filter {
        case .noir:
            return input.applyingFilter("CIPhotoEffectNoir")
        case .mono:
            return input.applyingFilter("CIPhotoEffectMono")
        case .faded:
            return curve(input.applyingFilter("CIPhotoEffectTonal"),
                         [(0, 0.10), (0.25, 0.31), (0.5, 0.53), (0.75, 0.75), (1, 0.92)])
        case .redFilter:
            var m = matrix(input, [1.60, 0.18, -0.80])
            m = curve(m, [(0, 0.0), (0.25, 0.14), (0.5, 0.52), (0.75, 0.80), (1, 0.93)])
            m = m.applyingFilter("CIBloom", parameters: ["inputRadius": 6.0, "inputIntensity": 0.15])
            return blend("CISoftLightBlendMode", top: grainLayer(0.35, blur: 0.5, ext: ext), back: m)
        case .xpro:
            let x = input.applyingFilter("CIColorPolynomial", parameters: [
                "inputRedCoefficients": CIVector(x: 0.04, y: 0.80, z: 0.30, w: 0),
                "inputGreenCoefficients": CIVector(x: 0.0, y: 1.10, z: -0.08, w: 0),
                "inputBlueCoefficients": CIVector(x: 0.14, y: 0.62, z: 0.16, w: 0)])
            return x.applyingFilter("CIColorControls",
                                    parameters: ["inputSaturation": 1.28, "inputContrast": 1.08])
        case .infrared:
            var m = matrix(input, [0.2, 1.5, -0.7])
            m = curve(m, [(0, 0.0), (0.3, 0.22), (0.6, 0.66), (0.8, 0.86), (1, 1.0)])
            return m.applyingFilter("CIBloom", parameters: ["inputRadius": 6.0, "inputIntensity": 0.4])
        case .newsprint:
            var n = input.applyingFilter("CIPhotoEffectMono")
            n = n.applyingFilter("CIDotScreen", parameters: [
                "inputWidth": 5.0, "inputSharpness": 0.55,
                "inputCenter": CIVector(x: ext.width / 2, y: ext.height / 2), "inputAngle": 0.3])
            n = blend("CIMultiplyBlendMode",
                      top: constColor(CIColor(red: 0.91, green: 0.88, blue: 0.78), ext), back: n)
            return blend("CISoftLightBlendMode", top: grainLayer(0.30, blur: 0.6, ext: ext), back: n)
        case .grain:
            return blend("CISoftLightBlendMode", top: grainLayer(0.55, blur: 0.4, ext: ext), back: input)
        case .finePaper:
            var f = curve(input, [(0, 0.07), (0.25, 0.28), (0.5, 0.52), (0.75, 0.75), (1, 0.94)])
            f = blend("CIMultiplyBlendMode",
                      top: constColor(CIColor(red: 0.96, green: 0.93, blue: 0.87), ext), back: f)
            return blend("CISoftLightBlendMode", top: grainLayer(0.42, blur: 1.4, ext: ext), back: f)
        }
    }

    // MARK: - 配方積木（與樣本間渲染器同名同參數）

    private static func matrix(_ img: CIImage, _ w: [CGFloat]) -> CIImage {
        let f = CIFilter(name: "CIColorMatrix")!
        f.setValue(img, forKey: kCIInputImageKey)
        for key in ["inputRVector", "inputGVector", "inputBVector"] {
            f.setValue(CIVector(x: w[0], y: w[1], z: w[2], w: 0), forKey: key)
        }
        return f.outputImage!
    }

    private static func curve(_ img: CIImage, _ pts: [(CGFloat, CGFloat)]) -> CIImage {
        precondition(pts.count == 5, "CIToneCurve needs all 5 points — fewer renders black")
        let f = CIFilter(name: "CIToneCurve")!
        f.setValue(img, forKey: kCIInputImageKey)
        for (i, p) in pts.enumerated() {
            f.setValue(CIVector(x: p.0, y: p.1), forKey: "inputPoint\(i)")
        }
        return f.outputImage!
    }

    private static func blend(_ name: String, top: CIImage, back: CIImage) -> CIImage {
        let f = CIFilter(name: name)!
        f.setValue(top, forKey: kCIInputImageKey)
        f.setValue(back, forKey: kCIInputBackgroundImageKey)
        return f.outputImage!
    }

    private static func constColor(_ c: CIColor, _ ext: CGRect) -> CIImage {
        let f = CIFilter(name: "CIConstantColorGenerator")!
        f.setValue(c, forKey: "inputColor")
        return f.outputImage!.cropped(to: ext)
    }

    /// 均勻噪點 → 置中灰顆粒（strength＝繞 0.5 的振幅）。CIRandomGenerator 的
    /// 噪點場是固定的（同一張圖每次渲染結果一致），快取才不會閃。
    private static func grainLayer(_ strength: CGFloat, blur: CGFloat, ext: CGRect) -> CIImage {
        var n = CIFilter(name: "CIRandomGenerator")!.outputImage!
        n = n.applyingFilter("CIColorControls", parameters: ["inputSaturation": 0])
        n = matrix(n, [strength, 0, 0])
        n = n.applyingFilter("CIColorMatrix", parameters: [
            "inputBiasVector": CIVector(x: 0.5 - strength / 2, y: 0.5 - strength / 2,
                                        z: 0.5 - strength / 2, w: 0)])
        if blur > 0 { n = n.applyingFilter("CIGaussianBlur", parameters: ["inputRadius": blur]) }
        return n.cropped(to: ext)
    }
}
