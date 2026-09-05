import CoreImage
import SwiftUI
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
    case riso = "c5"        // 孔版印刷（唯一帶參數的濾鏡，見 RisoParams）

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
        case .riso: return "孔版"
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
    // 手抄紙系（2026-08-16）：C 系的纖維是均勻噪點，這兩張是**有結構的絮**，
    // 走另一條生成路（handmadeFiber）並且用 normal 合成，不能用 softLight——
    // softLight 的變化量正比於 b×(1−b)，在紙這種亮底幾乎歸零，絮會完全看不見。
    case handmade = "h1"        // 手抄紙：淡灰綠 × 細絮
    case handmadeCoarse = "h2"  // 粗手抄紙：同紙色 × 絮重

    var id: String { rawValue }

    /// 手抄紙系＝整頁畫出來的結構性纖維，而非均勻噪點。
    var isHandmade: Bool { self == .handmade || self == .handmadeCoarse }

    /// 手抄紙配方（細纖維、粗絮、雜點根數）。配方在 2160 寬畫布上寫成，
    /// **根數固定不隨頁面縮放**，只有長度／線寬按 頁寬/2160 換算——
    /// 1x 與 2x 匯出因此紙感一致。與 align-core/src/core/paper.ts 的 HANDMADE 同值。
    var handmadeRecipe: (fine: Int, coarse: Int, specks: Int) {
        self == .handmadeCoarse ? (3200, 380, 11000) : (900, 40, 2500)
    }

    /// 面板顯示名 — 與區塊濾鏡共用已翻譯的 key。
    var displayName: String {
        switch self {
        case .newsprint: return "報紙"
        case .grain: return "顆粒"
        case .finePaper: return "高級紙"
        case .handmade: return "手抄紙"
        case .handmadeCoarse: return "粗手抄紙"
        }
    }

    /// multiply 紙色層（樣本間配方的 constColor 值），nil = 無。
    var tint: (r: CGFloat, g: CGFloat, b: CGFloat)? {
        switch self {
        case .newsprint: return (0.91, 0.88, 0.78)
        case .grain: return nil
        case .finePaper: return (0.96, 0.93, 0.87)
        case .handmade, .handmadeCoarse: return (0.863, 0.867, 0.784)   // DCDDC8
        }
    }

    /// screen 白抬黑量（高級紙霧面曲線「黑位抬到 0.07」的覆蓋層等價）。
    var lift: CGFloat { self == .finePaper ? 0.07 : (isHandmade ? 0.05 : 0) }

    /// 把「紙色 multiply ＋ 抬黑 screen」直接算進一個顏色裡（**不含纖維噪點**）。
    ///

    /// softLight 纖維噪點層的（強度, 模糊）— 與樣本間 C 系同參數。
    var fiber: (strength: CGFloat, blur: CGFloat) {
        switch self {
        case .newsprint: return (0.30, 0.6)
        case .grain: return (0.55, 0.4)
        case .finePaper: return (0.42, 1.4)
        case .handmade, .handmadeCoarse: return (0, 0)   // 不用噪點鏈，見 isHandmade
        }
    }
}

enum FilterEngine {
    /// 與樣本間渲染器同一個工作色彩空間，確保配方數值一比一。
    private static let ctx = CIContext(options: [
        .workingColorSpace: CGColorSpace(name: CGColorSpace.sRGB) as Any
    ])

    private static let paperLock = NSLock()





    /// CIImage 級入口 (Stage 2) — 影片管線共用同一套配方：canvas 即時預覽的
    /// AVVideoComposition handler 與 mp4 匯出的逐格 compositor 都走這裡。
    /// 一律裁回輸入 extent（Bloom 會把 extent 撐大，不裁回去合成座標就歪）。
    /// 純函式、無共享狀態 — 兩個呼叫端都在背景執行緒，執行緒安全。
    static func applyCI(_ key: String?, to input: CIImage) -> CIImage {
        let (base, adj) = splitSig(key)
        var img = input
        if let adj { img = adjustCI(adj, input: img) }   // 調整先於濾鏡（同 apply）
        if let base, base.hasPrefix("c5") {
            return risoCI(RisoParams.parse(base), input: img).cropped(to: input.extent)
        }
        guard let base, let filter = MediaFilter(rawValue: base) else { return img.cropped(to: input.extent) }
        return render(filter, input: img, ext: input.extent).cropped(to: input.extent)
    }

    // MARK: - 調整（2026-09-05，「不透明度」工具擴成「調整」）
    // 五支拉桿存 −1…1，套在濾鏡之前。數學與 Mac filters.ts applyAdjust 同一套：
    //   色溫 t：R×(1+0.18t)、B×(1−0.18t)（＋暖 −冷）／曝光 e：×2^(2e／2.2)／亮度 b：＋0.25b
    //   對比 c：(v−0.5)×(c≥0 ? 1+c : 1+0.6c)＋0.5／飽和 s：lum＋(v−lum)×(1+s)
    // 這裡烤成 32³ CIColorCube（GPU、影片逐格也不痛），鍵＝sig 快取；工作色彩空間 sRGB（ctx 同）
    // 所以是 gamma 空間的數值運算，跟 Mac 的 8 位元查表對得上。
    struct Adjust: Equatable {
        var e = 0.0, b = 0.0, c = 0.0, s = 0.0, t = 0.0
        /// 兩位小數＝鍵 canonical（拖桿一格一鍵），夾 −1…1
        static func clampRound(_ v: Double) -> Double {
            let n = (v * 100).rounded() / 100
            return n.isFinite ? max(-1, min(1, n)) : 0
        }
        var isNeutral: Bool { e == 0 && b == 0 && c == 0 && s == 0 && t == 0 }
        /// "~e,b,c,s,t"——掛在濾鏡代號後面（沒濾鏡也可以只有尾巴）
        var sig: String { "~" + [e, b, c, s, t].map { String(format: "%g", $0) }.joined(separator: ",") }
        static func parse(_ tail: Substring) -> Adjust? {
            let v = tail.split(separator: ",", omittingEmptySubsequences: false).map { clampRound(Double($0) ?? 0) }
            var a = Adjust()
            if v.count > 0 { a.e = v[0] }; if v.count > 1 { a.b = v[1] }; if v.count > 2 { a.c = v[2] }
            if v.count > 3 { a.s = v[3] }; if v.count > 4 { a.t = v[4] }
            return a.isNeutral ? nil : a
        }
    }

    /// 濾鏡身份字串拆成「濾鏡代號（c5 含參數）」＋「調整」。沒有 `~`＝原樣；空字串當 nil。
    static func splitSig(_ key: String?) -> (base: String?, adj: Adjust?) {
        guard let key, !key.isEmpty else { return (nil, nil) }
        guard let i = key.firstIndex(of: "~") else { return (key, nil) }
        let base = String(key[..<i])
        return (base.isEmpty ? nil : base, Adjust.parse(key[key.index(after: i)...]))
    }

    /// 這個身份字串會不會真的改變畫面（有濾鏡代號、或有調整）——各快取入口的守門條件。
    static func isRenderable(_ key: String?) -> Bool {
        let (base, adj) = splitSig(key)
        if adj != nil { return true }
        guard let base else { return false }
        return base.hasPrefix("c5") || MediaFilter(rawValue: base) != nil
    }

    private static var cubeCache: [String: Data] = [:]
    private static let cubeLock = NSLock()   // 主緒與影片 compositor 背景緒都會進來（同 paperLock 教訓）

    static func adjustCI(_ a: Adjust, input: CIImage) -> CIImage {
        let dim = 32
        let key = a.sig
        cubeLock.lock(); var data = cubeCache[key]; cubeLock.unlock()
        if data == nil {
            let ev = pow(2.0, (2 * a.e) / 2.2), br = 0.25 * a.b
            let cf = a.c >= 0 ? 1 + a.c : 1 + 0.6 * a.c
            let gr = 1 + 0.18 * a.t, gb = 1 - 0.18 * a.t, sf = 1 + a.s
            @inline(__always) func tone(_ v: Double, _ gain: Double) -> Double {
                let x = (v * gain * ev + br - 0.5) * cf + 0.5
                return max(0, min(1, x))
            }
            var buf = [Float](repeating: 0, count: dim * dim * dim * 4)
            var i = 0
            for bz in 0..<dim { for gy in 0..<dim { for rx in 0..<dim {   // 藍最慢、紅最快（CIColorCube 佈局）
                var r = tone(Double(rx) / Double(dim - 1), gr)
                var g = tone(Double(gy) / Double(dim - 1), 1)
                var b = tone(Double(bz) / Double(dim - 1), gb)
                if a.s != 0 {
                    let l = 0.2126 * r + 0.7152 * g + 0.0722 * b
                    r = max(0, min(1, l + (r - l) * sf)); g = max(0, min(1, l + (g - l) * sf)); b = max(0, min(1, l + (b - l) * sf))
                }
                buf[i] = Float(r); buf[i + 1] = Float(g); buf[i + 2] = Float(b); buf[i + 3] = 1
                i += 4
            } } }
            let d = buf.withUnsafeBufferPointer { Data(buffer: $0) }
            cubeLock.lock()
            if cubeCache.count > 64 { cubeCache.removeAll() }   // 拖一輪滑桿幾十組，別無上限長
            cubeCache[key] = d
            cubeLock.unlock()
            data = d
        }
        return input.applyingFilter("CIColorCube", parameters: [
            "inputCubeDimension": dim, "inputCubeData": data!,
        ])
    }

    /// 即時預覽版紙張（canvas 影片的 AVVideoComposition handler，背景緒）—
    /// 纖維就地用 CI 噪點鏈生成（純 CI、無快取＝緒安全）。噪點是均勻場，
    /// 與頁面版的視覺無差；濾鏡與紙張同一個 handler 內先濾後紙。
    static func applyPaperCILive(_ key: String?, to input: CIImage) -> CIImage {
        guard let key, let paper = PagePaper(rawValue: key) else { return input }
        if paper.isHandmade {
            // 結構性纖維沒辦法即時用 CI 噪點鏈長出來，改讀主緒預先生成的整頁層
            let fiber = handmadeFiberCG(paper, size: input.extent.size)
            return applyPaperCI(paper, fiber: fiber, to: input, pageRect: input.extent)
        }
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
            // 手抄紙的絮要直接疊（softLight 在亮底幾乎沒作用，絮會消失）
            out = fiber.applyingFilter(paper.isHandmade ? "CISourceOverCompositing" : "CISoftLightBlendMode",
                                       parameters: [kCIInputBackgroundImageKey: out])
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
        case .riso:
            // 正常不會走到（apply/applyCI 在 enum 之前就攔了 c5 好帶參數）；
            // 走到＝有人拿裸 enum 呼叫，用定案預設渲染。
            return risoCI(RisoParams.defaults, input: input)
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

// MARK: - c5 孔版印刷（Risograph，2026-08-31）
//
// 正本＝工具間 filter-lab.html（小高的濾鏡研究基地），Mac 端＝align-core filters.ts
// applyRiso——三處同一套數學。與其他濾鏡不同：帶參數、CPU 逐像素（不是 CI 鏈），
// 顆粒用**確定性雜湊**（JS 位元同構，見 hash1u——兩平台同相位，不是 CIRandomGenerator）。
//
// 空間正規化：pitch／reg 單位＝「長邊 900px 時的 px」（工具間預覽基準）。
// 實際間距＝pitch×長邊/900——不同解析度、預覽與匯出，網點相對大小都一樣。
// ⚠️ 這一段必須 UIKit-free：videotool/build.sh 會把本檔剝去 UIKit 後編進 alignvideo。

extension FilterEngine {
    struct RisoParams {
        var inks: [String]
        var paper: String
        var pitch: Double
        var hard: Double
        var reg: Double
        var dens: Double
        var grain: Double

        /// 定案「藍＋暖棕」（2026-08-31 小高在工具間定案）。
        static let defaults = RisoParams(inks: ["236996", "966946"], paper: "DDD7C9",
                                         pitch: 4, hard: 0.45, reg: 2.25, dens: 0.9, grain: 7)
        /// 三組定案油墨（工具間一鍵配方同款）。
        static let presets: [(name: String, inks: [String])] = [
            ("藍＋暖棕", ["236996", "966946"]),
            ("綠＋暖棕", ["3c7846", "a06e46"]),
            ("單墨・黑", ["282622"]),
        ]

        /// canonical 序列化＝快取鍵成分（Mac filterSig 同格式）。
        var sig: String {
            let n = { (v: Double) -> String in
                v == v.rounded() ? String(Int(v)) : String(v)
            }
            return "c5:\(inks.joined(separator: ","));\(paper);\(n(pitch));\(n(hard));\(n(reg));\(n(dens));\(n(grain))"
        }

        /// 從身份字串解回（"c5"＝預設；壞段落逐項回預設，不炸）。
        static func parse(_ key: String) -> RisoParams {
            guard let i = key.firstIndex(of: ":") else { return defaults }
            let seg = key[key.index(after: i)...].split(separator: ";", omittingEmptySubsequences: false)
            guard seg.count >= 7 else { return defaults }
            let num = { (v: Substring, fb: Double) -> Double in Double(v) ?? fb }
            let inks = seg[0].split(separator: ",").map(String.init).filter { !$0.isEmpty }
            return RisoParams(
                inks: inks.isEmpty ? defaults.inks : Array(inks.prefix(3)),
                paper: seg[1].isEmpty ? defaults.paper : String(seg[1]),
                pitch: num(seg[2], defaults.pitch), hard: num(seg[3], defaults.hard),
                reg: num(seg[4], defaults.reg), dens: num(seg[5], defaults.dens),
                grain: num(seg[6], defaults.grain))
        }
    }

    // 確定性雜湊——**與 JS 位元同構**（Mac/工具間同一把）：乘法走 float64、ToUint32
    // 截斷語意照抄，兩平台的顆粒與網點相位完全一致。⚠️ 移位一律無號（帶號位移的
    // 符號延伸會讓 bit31 自我抵消、輸出永遠 < 0.5——工具間審查實踩）。
    @inline(__always) static func jsUint32(_ v: Double) -> UInt32 {
        let t = v < 0 ? -(-v).rounded(.down) : v.rounded(.down)
        let m = t.truncatingRemainder(dividingBy: 4294967296)
        return UInt32(m < 0 ? m + 4294967296 : m)
    }
    @inline(__always) static func hash1u(_ i: Int32, _ seed: Int32) -> Double {
        var s = jsUint32(Double(i) * 374761393 + Double(seed) * 668265263)
        s ^= s >> 13
        s = s &* 1274126177          // Math.imul＝真 32 位乘法
        s ^= s >> 16
        return Double(s) / 4294967295
    }
    @inline(__always) static func hash2u(_ x: Int32, _ y: Int32, _ seed: Int32) -> Double {
        let xi = Int32(truncatingIfNeeded: Int64(x) * 73856093)
        let yi = Int32(truncatingIfNeeded: Int64(y) * 19349663)
        return hash1u(xi ^ yi, seed)
    }

    static func hexRGB(_ hx: String) -> (Double, Double, Double) {
        var v: UInt64 = 0
        Scanner(string: String(hx.replacingOccurrences(of: "#", with: "").prefix(6)))
            .scanHexInt64(&v)
        return (Double((v >> 16) & 255), Double((v >> 8) & 255), Double(v & 255))
    }

    /// 孔版本體（CIImage 進出；中間走 CPU RGBA8 緩衝）。分色（log 空間最小平方）→
    /// 各墨 45°/15°/75° AM 過網＋套印偏移 → multiply 疊印回紙色 → 確定性顆粒。
    /// 單趟逐像素、不配置整張浮點平面（與 Mac applyRiso 同構）。
    static func risoCI(_ p: RisoParams, input: CIImage) -> CIImage {
        // 過網解析度帽 2560 長邊（Mac 端變體同帽）：網點是 900 基準的相對尺度，
        // 2560 上解析度綽綽有餘；48MP 原圖直烤＝秒級（debug 十秒級）＝小高 iPad 匯出卡死的主因之一。
        // 縮小算完再放大回原 extent，下游拿到的尺寸不變。
        let long0 = max(input.extent.width, input.extent.height)
        if long0 > 2560 {
            let s0 = 2560 / long0
            // clampedToExtent＝邊緣像素往外複製：縮小取樣到邊界不會混進透明，
            // integral 縮框保證放大後蓋滿原 extent——**不能用 composited(over:) 補縫**，
            // 那會把半透明來源的 alpha 變 a(2−a)、原圖色滲進濾鏡結果（查核實抓）。
            let smallRect = CGRect(x: input.extent.origin.x * s0, y: input.extent.origin.y * s0,
                                   width: input.extent.width * s0,
                                   height: input.extent.height * s0).integral
            let shrunk = input.clampedToExtent()
                .transformed(by: CGAffineTransform(scaleX: s0, y: s0))
                .cropped(to: smallRect)
            let small = risoCI(p, input: shrunk)
            return small.transformed(by: CGAffineTransform(scaleX: 1 / s0, y: 1 / s0))
                .cropped(to: input.extent)
        }
        let ext = input.extent.integral
        let w = Int(ext.width), h = Int(ext.height)
        guard w > 0, h > 0, let cg = ctx.createCGImage(input, from: ext) else { return input }
        let bytesPerRow = w * 4
        var buf = [UInt8](repeating: 0, count: bytesPerRow * h)
        let ok: Bool = buf.withUnsafeMutableBytes { raw in
            guard let g = CGContext(data: raw.baseAddress, width: w, height: h,
                                    bitsPerComponent: 8, bytesPerRow: bytesPerRow,
                                    space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
            g.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
            return true
        }
        guard ok else { return input }

        risoKernel(&buf, w: w, h: h, p: p)

        let data = Data(buf)
        guard let provider = CGDataProvider(data: data as CFData),
              let outCG = CGImage(width: w, height: h, bitsPerComponent: 8, bitsPerPixel: 32,
                                  bytesPerRow: bytesPerRow,
                                  space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                  bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
                                  provider: provider, decode: nil, shouldInterpolate: true,
                                  intent: .defaultIntent) else { return input }
        // 位置擺回原 extent（CI 的 y 軸朝上，這裡整張重建、座標原樣）
        return CIImage(cgImage: outCG).transformed(by: CGAffineTransform(
            translationX: ext.origin.x, y: ext.origin.y))
    }

    /// CPU 核心（與 Mac filters.ts applyRiso 逐行同構——改一邊必改另一邊）。
    private static func risoKernel(_ buf: inout [UInt8], w: Int, h: Int, p: RisoParams) {
        // 🔴 紙色任何一個通道是 0（純黑、純紅、檸檬黃…色盤上點得到）會讓 log(x/0)＝∞
        // 灌進分色矩陣，整張照片變成一塊噪點。油墨那邊本來就有 max(c,1)，紙色漏了。
        // 夾到 1 在畫面上與 0 無異，預設紙色逐位不受影響。（Mac filters.ts 同修）
        let paper0 = hexRGB(p.paper)
        let paper = (Swift.max(paper0.0, 1), Swift.max(paper0.1, 1), Swift.max(paper0.2, 1))
        let inkHexes = p.inks.isEmpty ? RisoParams.defaults.inks : p.inks
        let inks = inkHexes.prefix(3).map(hexRGB)
        let N = inks.count
        let k5 = Double(max(w, h)) / 900
        let pitch = Swift.max(p.pitch * k5, 0.8)
        let soft = Swift.max((0.55 - p.hard * 0.5) * 0.5, 0.02)

        // 分色矩陣 M＝(AᵀA)⁻¹Aᵀ
        let A = inks.map { c in [log(Swift.max(c.0, 1) / paper.0),
                                 log(Swift.max(c.1, 1) / paper.1),
                                 log(Swift.max(c.2, 1) / paper.2)] }
        var AtA = [[Double]](repeating: [Double](repeating: 0, count: N), count: N)
        for i in 0..<N { for j in 0..<N {
            AtA[i][j] = A[i][0] * A[j][0] + A[i][1] * A[j][1] + A[i][2] * A[j][2]
        } }
        var aug = (0..<N).map { i in AtA[i] + (0..<N).map { j in i == j ? 1.0 : 0.0 } }
        for i in 0..<N {
            var piv = i
            for r in (i + 1)..<N where abs(aug[r][i]) > abs(aug[piv][i]) { piv = r }
            aug.swapAt(i, piv)
            let pv = aug[i][i] == 0 ? 1e-9 : aug[i][i]
            for c in 0..<(2 * N) { aug[i][c] /= pv }
            for r in 0..<N where r != i {
                let f = aug[r][i]
                for c in 0..<(2 * N) { aug[r][c] -= f * aug[i][c] }
            }
        }
        var M = [[Double]](repeating: [0, 0, 0], count: N)
        for n in 0..<N { for q in 0..<3 {
            var acc = 0.0
            for j in 0..<N { acc += aug[n][N + j] * A[j][q] }
            M[n][q] = acc
        } }

        struct Base { let ca, sa, ox, oy: Double }
        let angles: [Double] = [45, 15, 75]
        let bases = (0..<N).map { n -> Base in
            let rad = angles[n % 3] * .pi / 180
            return Base(ca: cos(rad), sa: sin(rad),
                        ox: p.reg * k5 * cos(Double(n) * 2.1), oy: p.reg * k5 * sin(Double(n) * 2.1))
        }
        let inkF = inks.map { (1 - $0.0 / 255, 1 - $0.1 / 255, 1 - $0.2 / 255) }
        let clamp = { (v: Double) -> UInt8 in UInt8(Swift.max(0, Swift.min(255, v.rounded()))) }

        for y in 0..<h {
            for x in 0..<w {
                let i = (y * w + x) * 4
                // premultipliedLast 緩衝：半透明像素要先除回 straight 再算、寫回再乘回去
                //（貼圖 PNG／軟邊來源不處理的話會與 Mac 分歧、還寫出 RGB>alpha 的非法 premult）
                let a = buf[i + 3]
                if a == 0 { continue }                    // 全透明：原樣（RGB 已是 0）
                let unp = a == 255 ? 1.0 : 255.0 / Double(a)
                let b0 = log(Swift.max(Swift.min(Double(buf[i]) * unp, 255), 1) / paper.0)
                let b1 = log(Swift.max(Swift.min(Double(buf[i + 1]) * unp, 255), 1) / paper.1)
                let b2 = log(Swift.max(Swift.min(Double(buf[i + 2]) * unp, 255), 1) / paper.2)
                var r = paper.0, g = paper.1, bl = paper.2
                for n in 0..<N {
                    var dn = M[n][0] * b0 + M[n][1] * b1 + M[n][2] * b2
                    dn = dn < 0 ? 0 : dn > 1 ? 1 : dn
                    if p.dens != 1 { dn = Swift.min(1, dn * p.dens) }
                    let bb = bases[n]
                    let px = Double(x) + bb.ox, py = Double(y) + bb.oy
                    let u = (px * bb.ca + py * bb.sa) / pitch
                    let v = (-px * bb.sa + py * bb.ca) / pitch
                    let fu = u - u.rounded(.down) - 0.5, fv = v - v.rounded(.down) - 0.5
                    let rr = (fu * fu + fv * fv).squareRoot()
                    let R = dn.squareRoot() * 0.72
                    let t = (R - rr) / soft
                    let cov = t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t)
                    if cov > 0 {
                        r *= 1 - cov * inkF[n].0
                        g *= 1 - cov * inkF[n].1
                        bl *= 1 - cov * inkF[n].2
                    }
                }
                var gr = 0.0
                if p.grain != 0 {
                    gr = (hash2u(Int32(Double(x) / k5), Int32(Double(y) / k5), 55) - 0.5) * p.grain
                }
                let rep = a == 255 ? 1.0 : Double(a) / 255.0   // 寫回 premult
                buf[i] = clamp((r + gr) * rep); buf[i + 1] = clamp((g + gr) * rep)
                buf[i + 2] = clamp((bl + gr) * rep)
            }
        }
    }
}
