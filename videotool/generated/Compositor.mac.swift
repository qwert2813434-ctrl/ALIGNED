import AVFoundation
import CoreImage
import Foundation

enum CompositeLayer {
    case still(CGImage)
    case video(trackID: CMPersistentTrackID, origin: CGPoint, mask: CGImage?, stroke: CGImage?, filterKey: String?,
               shadow: CGImage?, shadowPad: CGFloat)
}

/// AVFoundation instantiates the compositor itself, so parameters ride on this
/// shared box (one page export runs at a time).
final class PageOverlayBox {
    static let shared = PageOverlayBox()
    var layers: [CompositeLayer] = []
    var pageSize: CGSize = .zero
    /// 整頁紙張 (Stage 3b) — both set by composePage before the session starts
    /// (fiber pre-rendered on the main actor); the compositor only reads them.
    var paperKey: String?
    /// 紙張套用範圍的灰階遮罩（白＝鋪紙）。nil＝整頁都鋪（原本行為）。
    var paperMask: CIImage?
    /// 濾鏡鏈在 **sRGB 工作空間**評估——九顆濾鏡的參數全是在 sRGB 下校準的
    /// （FilterEngine.ctx 同一設定）。CIContext 預設的線性空間會讓同一組
    /// CIToneCurve 參數跑出不同色調＝「輸出跟預覽對不上」（2026-08-05 Mac 端抓到）。
    let ciContext = CIContext(options: [.workingColorSpace: CGColorSpace(name: CGColorSpace.sRGB) as Any])
    /// 輸出寫 sRGB（畫布世界的空間）。DeviceRGB＝「這台機器的螢幕空間」，每台不一樣。
    let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
}

/// Custom instruction (the concrete mutable class's requiredSourceTrackIDs is
/// get-only) declaring which source tracks feed the compositor.
final class PageOverlayInstruction: NSObject, AVVideoCompositionInstructionProtocol {
    var timeRange: CMTimeRange = .zero
    var enablePostProcessing: Bool = false
    var containsTweening: Bool = false
    var requiredSourceTrackIDs: [NSValue]?
    var passthroughTrackID: CMPersistentTrackID = kCMPersistentTrackID_Invalid
}

/// Composites the page's layer stack per frame on the GPU (Core Image), driven
/// by AVAssetExportSession.
final class PageOverlayCompositor: NSObject, AVVideoCompositing {
    var sourcePixelBufferAttributes: [String: Any]? = [
        String(kCVPixelBufferPixelFormatTypeKey): [kCVPixelFormatType_32BGRA]
    ]
    var requiredPixelBufferAttributesForRenderContext: [String: Any] = [
        String(kCVPixelBufferPixelFormatTypeKey): [kCVPixelFormatType_32BGRA]
    ]

    func renderContextChanged(_ newRenderContext: AVVideoCompositionRenderContext) {}

    func startRequest(_ request: AVAsynchronousVideoCompositionRequest) {
        autoreleasepool {
            let box = PageOverlayBox.shared
            guard let dest = request.renderContext.newPixelBuffer() else {
                request.finish(with: NSError(domain: "ALIGN", code: -1))
                return
            }
            let pageRect = CGRect(origin: .zero, size: box.pageSize)
            // Accumulate bottom-to-top: each layer composited OVER the running result.
            var composite = CIImage(color: .clear).cropped(to: pageRect)
            for layer in box.layers {
                switch layer {
                case .still(let cg):
                    composite = CIImage(cgImage: cg).composited(over: composite)
                case .video(let trackID, let origin, let mask, let stroke, let filterKey, let shadow, let shadowPad):
                    if let pb = request.sourceFrame(byTrackID: trackID) {
                        // 陰影（2026-09-05）：烤好的影子（比框大一圈 pad）先墊下去，再疊影片——
                        // 影子在框外的部分不會被 mask 裁掉，跟畫布上一樣
                        if let shadow {
                            let sh = CIImage(cgImage: shadow).transformed(by: CGAffineTransform(
                                translationX: origin.x - shadowPad, y: origin.y - shadowPad))
                            composite = sh.composited(over: composite)
                        }
                        var frame = CIImage(cvPixelBuffer: pb)
                        // 濾鏡 (Stage 2) — same FilterEngine chain as the canvas
                        // preview's AVVideoComposition, applied in the clip's own
                        // pixel space BEFORE mask/stroke (the filter grades the
                        // footage; the mask then clips the graded result).
                        frame = FilterEngine.applyCI(filterKey, to: frame)
                        // 外觀 mask: keep the frame only inside the shape (opaque-
                        // inside mask image), then draw the stroke over it — all in
                        // the clip's local pixel space, before placing on the page.
                        if let mask = mask {
                            let extent = frame.extent
                            frame = frame.applyingFilter("CIBlendWithMask", parameters: [
                                kCIInputMaskImageKey: CIImage(cgImage: mask),
                                kCIInputBackgroundImageKey: CIImage(color: .clear).cropped(to: extent)
                            ])
                        }
                        if let stroke = stroke {
                            frame = CIImage(cgImage: stroke).composited(over: frame)
                        }
                        frame = frame.transformed(by: CGAffineTransform(translationX: origin.x, y: origin.y))
                        composite = frame.composited(over: composite)
                    }
                }
            }
            // 整頁紙張 (Stage 3b) — the very last step, above every layer,
            // matching PaperOverlay's position in the canvas/still stack. The
            // page is fully opaque by now (the first still segment always
            // draws the background), so the blend modes have real content to
            // bite — never blend paper against transparency.
            if let key = box.paperKey {
                let papered = FilterEngine.applyPaperCILive(key, to: composite)
                // 套用範圍：白＝紙、黑＝原畫面。沒遮罩＝整頁（原本行為）。
                if let mask = box.paperMask {
                    composite = papered.applyingFilter("CIBlendWithMask", parameters: [
                        kCIInputBackgroundImageKey: composite,
                        kCIInputMaskImageKey: mask,
                    ])
                } else {
                    composite = papered
                }
            }
            // 告訴編碼器 buffer 裡是什麼（709＝H.264 的預設語意、與 sRGB 同原色）——
            // 不標的話編碼器自己猜，偏色量隨機器而異
            CVBufferSetAttachment(dest, kCVImageBufferColorPrimariesKey,
                                  kCVImageBufferColorPrimaries_ITU_R_709_2, .shouldPropagate)
            CVBufferSetAttachment(dest, kCVImageBufferTransferFunctionKey,
                                  kCVImageBufferTransferFunction_ITU_R_709_2, .shouldPropagate)
            CVBufferSetAttachment(dest, kCVImageBufferYCbCrMatrixKey,
                                  kCVImageBufferYCbCrMatrix_ITU_R_709_2, .shouldPropagate)
            box.ciContext.render(composite, to: dest, bounds: pageRect, colorSpace: box.colorSpace)
            request.finish(withComposedVideoFrame: dest)
        }
    }
}
