// alignvideo — ALIGNED Mac 版的影片頁匯出器。
//
// 這支是 iOS `VideoPageExporter` 的移植：**同樣的兩段式管線、同樣的合成器**，
// 而且濾鏡與紙張直接編譯 App 真正的 `FilterEngine.swift`（只剝掉 UIKit），
// 所以輸出與 iPad 是同一套配方，不是重寫的近似品。
//
//   Pass 1（烤）：每支影片各自轉正、裁切、縮到它 block 的像素大小
//                 → 之後擺位就只是平移，不會溢出。
//   Pass 2（合成）：烤好的片段各佔一軌，短的循環補到最長那支的長度，
//                 自訂 compositor 逐格依 z 序把靜態圖層與影片影格疊起來。
//
// 時間長度＝這一頁最長的那支影片；短的循環填滿，所以每支都會一直動。
// 聲音只取最長那支（不混音），與 iOS 相同。
//
// 與 iOS 的兩處差異，都是因為那邊是 App、這邊是命令列工具：
//   1. 靜態圖層、遮罩、描邊改由 Mac 版的畫布（TypeScript）先渲染成 PNG 傳進來——
//      那條渲染路已經跟 iOS 逐像素比對過，重畫一次反而是新的漂移來源。
//   2. 紙張的纖維層走 `applyPaperCILive`（用 grainLayer 現算），
//      iOS 是在主執行緒先烤成 UIImage 再傳給 compositor；同一組數學。
//
// 用法：alignvideo <spec.json>；成功印 "ok"，失敗印錯誤訊息並回非 0。

import AVFoundation
import CoreImage
import Foundation

// ── 規格 ──────────────────────────────────────────────────────────────

struct LayerSpecJSON: Decodable {
    let type: String            // "still" | "video"
    let path: String
    // 以下只有 video 用得到；x/y 是**左上角**的頁內座標（與畫布同一套），
    // 工具內部才翻成 Core Image 的左下角原點。
    let x: Double?
    let y: Double?
    let w: Double?
    let h: Double?
    let crop: CropJSON?
    let filter: String?
    let mask: String?
    let stroke: String?
}

struct CropJSON: Decodable { let x: Double; let y: Double; let w: Double; let h: Double }

struct Spec: Decodable {
    let output: String
    let pageWidth: Double
    let pageHeight: Double
    let fps: Int
    let mute: Bool
    let paper: String?
    let layers: [LayerSpecJSON]
}

enum ToolError: Error, CustomStringConvertible {
    case badSpec(String), noVideo, trackLoad(String), exportFailed(String), imageLoad(String)
    var description: String {
        switch self {
        case .badSpec(let m): return "規格讀不懂：\(m)"
        case .noVideo: return "這一頁沒有影片，不需要走影片匯出"
        case .trackLoad(let m): return "讀取影片軌失敗：\(m)"
        case .exportFailed(let m): return "匯出失敗：\(m)"
        case .imageLoad(let m): return "圖層載入失敗：\(m)"
        }
    }
}

func loadCGImage(_ path: String) throws -> CGImage {
    guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
          let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
        throw ToolError.imageLoad(path)
    }
    return img
}

// ── Pass 1：烤（裁切＋轉正＋縮到 block 的像素大小）────────────────────────

func roundEven(_ v: Double) -> Double {
    let n = Int(v.rounded()); return Double(n - (n % 2))
}

/// (0,0,1,1) 是「未曾裁切」的哨兵值，要解成置中的 aspect-fill——照字面拉伸會變形。
func resolvedCrop(_ c: CropJSON?, display: CGSize, target: CGSize) -> CGRect {
    let valid = (c?.w ?? 0) > 0.001 && (c?.h ?? 0) > 0.001
    let uncropped = !valid || ((c?.w ?? 1) > 0.999 && (c?.h ?? 1) > 0.999)
    if uncropped {
        let scale = max(target.width / display.width, target.height / display.height)
        let w = target.width / (display.width * scale)
        let h = target.height / (display.height * scale)
        return CGRect(x: (1 - w) / 2, y: (1 - h) / 2, width: w, height: h)
    }
    return CGRect(x: c!.x, y: c!.y, width: c!.w, height: c!.h)
}

func bakeClip(sourceURL: URL, crop: CropJSON?, target: CGSize, fps: Int) async throws -> URL {
    let asset = AVURLAsset(url: sourceURL)
    guard let vTrack = try await asset.loadTracks(withMediaType: .video).first else {
        throw ToolError.trackLoad(sourceURL.lastPathComponent)
    }
    let duration = try await asset.load(.duration)
    let naturalSize = try await vTrack.load(.naturalSize)
    let pt = try await vTrack.load(.preferredTransform)

    let dispRect = CGRect(origin: .zero, size: naturalSize).applying(pt)
    let display = CGSize(width: abs(dispRect.width), height: abs(dispRect.height))
    let ptNorm = pt.concatenating(CGAffineTransform(translationX: -dispRect.minX, y: -dispRect.minY))

    let c = resolvedCrop(crop, display: display, target: target)
    let cropPx = CGRect(x: c.minX * display.width, y: c.minY * display.height,
                        width: c.width * display.width, height: c.height * display.height)
    let place = CGAffineTransform(translationX: -cropPx.minX, y: -cropPx.minY)
        .concatenating(CGAffineTransform(scaleX: target.width / cropPx.width,
                                         y: target.height / cropPx.height))

    let instruction = AVMutableVideoCompositionInstruction()
    instruction.timeRange = CMTimeRange(start: .zero, duration: duration)
    let li = AVMutableVideoCompositionLayerInstruction(assetTrack: vTrack)
    li.setTransform(ptNorm.concatenating(place), at: .zero)
    instruction.layerInstructions = [li]

    let vComp = AVMutableVideoComposition()
    vComp.renderSize = target
    vComp.frameDuration = CMTime(value: 1, timescale: CMTimeScale(fps))
    vComp.instructions = [instruction]

    guard let session = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetHighestQuality) else {
        throw ToolError.exportFailed("建立烤片 session 失敗")
    }
    let out = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".mov")
    session.outputURL = out
    session.outputFileType = .mov
    session.videoComposition = vComp
    await withCheckedContinuation { (k: CheckedContinuation<Void, Never>) in
        session.exportAsynchronously { k.resume() }
    }
    guard session.status == .completed else {
        throw ToolError.exportFailed("烤片：\(session.error?.localizedDescription ?? "未知")")
    }
    return out
}

// ── Pass 2：合成 ──────────────────────────────────────────────────────

func composePage(spec: Spec, baked: [(url: URL, layer: LayerSpecJSON)]) async throws -> Void {
    let pageSize = CGSize(width: spec.pageWidth, height: spec.pageHeight)

    // ⚠️ AVURLAsset 一定要留著：AVAssetTrack.asset 是 weak 反向參照，
    //    asset 被回收後 track 會變孤兒，insertTimeRange 會噴 -12780（iOS 端踩過）。
    struct Clip { let asset: AVURLAsset; let track: AVAssetTrack; let audio: AVAssetTrack?; let range: CMTimeRange }
    var clips: [URL: Clip] = [:]
    var masterDuration = CMTime.zero
    for (url, _) in baked where clips[url] == nil {
        let asset = AVURLAsset(url: url)
        guard let vt = try await asset.loadTracks(withMediaType: .video).first else {
            throw ToolError.trackLoad(url.lastPathComponent)
        }
        // ⚠️ 用**影片軌自己的** timeRange，不要用 asset.duration——後者可能比實際媒體長
        //    一點（烤片會留下尾巴），插超過媒體範圍又是 -12780。
        let range = try await vt.load(.timeRange)
        let at = try? await asset.loadTracks(withMediaType: .audio).first
        clips[url] = Clip(asset: asset, track: vt, audio: at, range: range)
        if range.duration > masterDuration { masterDuration = range.duration }
    }
    guard masterDuration > .zero else { throw ToolError.exportFailed("影片長度為零") }

    let composition = AVMutableComposition()
    var layers: [CompositeLayer] = []
    var sourceTrackIDs: [NSValue] = []
    var masterAudioAdded = false
    var bakedIndex = 0

    for spec0 in spec.layers {
        if spec0.type == "still" {
            layers.append(.still(try loadCGImage(spec0.path)))
            continue
        }
        let entry = baked[bakedIndex]; bakedIndex += 1
        guard let clip = clips[entry.url],
              let ct = composition.addMutableTrack(withMediaType: .video,
                                                   preferredTrackID: kCMPersistentTrackID_Invalid) else {
            throw ToolError.trackLoad(entry.url.lastPathComponent)
        }
        // 循環補到最長那支的長度；尾巴那段用「軌自己的範圍」的子區間，不會超出媒體
        let clipDur = clip.range.duration
        try ct.insertTimeRange(clip.range, of: clip.track, at: .zero)
        var t = clipDur
        while t < masterDuration {
            let remain = masterDuration - t
            if remain <= CMTime(value: 1, timescale: 600) { break }
            let insert = min(clipDur, remain)
            try ct.insertTimeRange(CMTimeRange(start: clip.range.start, duration: insert), of: clip.track, at: t)
            t = t + insert
        }
        // 左上角 → Core Image 的左下角原點
        let originY = spec.pageHeight - ((spec0.y ?? 0) + (spec0.h ?? 0))
        layers.append(.video(trackID: ct.trackID,
                             origin: CGPoint(x: spec0.x ?? 0, y: originY),
                             mask: spec0.mask.flatMap { try? loadCGImage($0) },
                             stroke: spec0.stroke.flatMap { try? loadCGImage($0) },
                             filterKey: spec0.filter))
        sourceTrackIDs.append(NSNumber(value: ct.trackID))

        // 聲音只取最長那支（不混音）。⚠️ 一定要夾限到 masterDuration——音軌幾乎不會
        // 跟自己的影片軌等長，沒夾限會讓整個 composition 比 videoComposition 的
        // instruction 還長，AVFoundation 直接判 -11841 整份失敗（iOS 端 5 支失敗 1 支的成因）。
        if !spec.mute, !masterAudioAdded, clip.range.duration == masterDuration, let atrack = clip.audio,
           let ca = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) {
            if let ar = try? await atrack.load(.timeRange) {
                let clamped = CMTimeRange(start: ar.start, duration: min(ar.duration, masterDuration))
                try? ca.insertTimeRange(clamped, of: atrack, at: .zero)
            }
            masterAudioAdded = true
        }
    }

    PageOverlayBox.shared.layers = layers
    PageOverlayBox.shared.pageSize = pageSize
    PageOverlayBox.shared.paperKey = spec.paper

    let vComp = AVMutableVideoComposition()
    vComp.customVideoCompositorClass = PageOverlayCompositor.self
    vComp.renderSize = pageSize
    vComp.frameDuration = CMTime(value: 1, timescale: CMTimeScale(spec.fps))
    let instruction = PageOverlayInstruction()
    instruction.timeRange = CMTimeRange(start: .zero, duration: masterDuration)
    instruction.requiredSourceTrackIDs = sourceTrackIDs
    vComp.instructions = [instruction]

    guard let session = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetHighestQuality) else {
        throw ToolError.exportFailed("建立合成 session 失敗")
    }
    let out = URL(fileURLWithPath: spec.output)
    try? FileManager.default.removeItem(at: out)
    session.outputURL = out
    session.outputFileType = .mp4          // Mac 端直接出 .mp4（iOS 是先 .mov 再交給分享）
    session.videoComposition = vComp
    await withCheckedContinuation { (k: CheckedContinuation<Void, Never>) in
        session.exportAsynchronously { k.resume() }
    }
    guard session.status == .completed else {
        throw ToolError.exportFailed(session.error?.localizedDescription ?? "未知")
    }
}

// ── 進入點 ────────────────────────────────────────────────────────────

/// 修剪：把來源的 [start, end) 這段切出來另存。
///
/// 配方與 iOS `VideoTrimView` 完全相同（HighestQuality ＋ .mov ＋ timeRange）——
/// 兩邊剪出來的東西必須是同一種東西，否則同一支片在 Mac 剪與在 iPad 剪，
/// 進專案後畫質／容器就不一樣了。**不用 Passthrough**：那個只能切在關鍵影格上，
/// 使用者拉到哪就該剪到哪。
func trimClip(source: URL, dest: URL, start: Double, end: Double) async throws {
    let asset = AVURLAsset(url: source)
    let total = try await asset.load(.duration).seconds
    let a = max(0, min(start, total))
    let b = max(a, min(end, total))
    guard b - a > 0.01 else { throw ToolError.badSpec("修剪範圍太短") }
    guard let session = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetHighestQuality) else {
        throw ToolError.exportFailed("建不出匯出工作階段")
    }
    try? FileManager.default.removeItem(at: dest)
    session.outputURL = dest
    session.outputFileType = .mov
    session.timeRange = CMTimeRange(start: CMTime(seconds: a, preferredTimescale: 600),
                                    duration: CMTime(seconds: b - a, preferredTimescale: 600))
    await session.export()
    guard session.status == .completed else {
        throw ToolError.exportFailed(session.error?.localizedDescription ?? "未知")
    }
}

@main
struct Tool {
    static func main() async {
        do {
            // 修剪模式：alignvideo trim <來源> <輸出> <起秒> <迄秒>
            if CommandLine.arguments.count == 6, CommandLine.arguments[1] == "trim" {
                let a = CommandLine.arguments
                guard let s = Double(a[4]), let e = Double(a[5]) else {
                    throw ToolError.badSpec("起迄秒數要是數字")
                }
                try await trimClip(source: URL(fileURLWithPath: a[2]),
                                   dest: URL(fileURLWithPath: a[3]), start: s, end: e)
                print("ok")
                return
            }
            guard CommandLine.arguments.count > 1 else { throw ToolError.badSpec("要給一個 spec.json 路徑") }
            let data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
            let spec = try JSONDecoder().decode(Spec.self, from: data)
            let videos = spec.layers.filter { $0.type == "video" }
            guard !videos.isEmpty else { throw ToolError.noVideo }

            var baked: [(url: URL, layer: LayerSpecJSON)] = []
            for v in videos {
                let target = CGSize(width: roundEven(v.w ?? 0), height: roundEven(v.h ?? 0))
                let url = try await bakeClip(sourceURL: URL(fileURLWithPath: v.path),
                                             crop: v.crop, target: target, fps: spec.fps)
                baked.append((url, v))
            }
            defer { for b in baked { try? FileManager.default.removeItem(at: b.url) } }
            try await composePage(spec: spec, baked: baked)
            print("ok")
        } catch {
            FileHandle.standardError.write("\(error)\n".data(using: .utf8)!)
            exit(1)
        }
    }
}
