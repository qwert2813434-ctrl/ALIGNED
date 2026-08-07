// 差分測試用：跑 Swift 原版 AlignmentEngine，把結果吐成 JSON。
// 同一批輸入也餵給 TS 移植版，逐案比對。
import Foundation
import CoreGraphics

// 兩邊共用的確定性亂數（LCG），確保產生完全相同的測資
var seed: UInt64 = 12345
func rnd() -> Double {
    seed = (seed &* 6364136223846793005 &+ 1442695040888963407)
    return Double((seed >> 11) & 0xFFFFFFFF) / Double(0xFFFFFFFF)
}
func rr(_ lo: Double, _ hi: Double) -> Double { lo + rnd() * (hi - lo) }

struct Out: Encodable {
    var x: Double; var y: Double; var w: Double; var h: Double
    var snappedX: Bool; var snappedY: Bool
    var guides: [[Double]]   // [axisCode, position, start, end]
    var badges: [[Double]]   // [x, y, value]
}

var results: [Out] = []
let strengths: [SnapStrength] = [.strong, .weak, .none]
let pageW = 1080.0, pageH = 1350.0

for i in 0..<400 {
    let pageCount = Int(rr(1, 4.99))
    let stage = CGRect(x: 0, y: 0, width: pageW * Double(pageCount), height: pageH)
    let homeIndex = Int(rr(0, Double(pageCount) - 0.01))
    let home = CGRect(x: Double(homeIndex) * pageW, y: 0, width: pageW, height: pageH)

    let dragging = CGRect(x: rr(-100, stage.width), y: rr(-100, pageH),
                          width: rr(20, 600), height: rr(20, 400))
    var others: [CGRect] = []
    for _ in 0..<Int(rr(0, 6.99)) {
        others.append(CGRect(x: rr(-50, stage.width), y: rr(-50, pageH),
                             width: rr(20, 500), height: rr(20, 350)))
    }
    var gx: [CGFloat] = [], gy: [CGFloat] = []
    for _ in 0..<Int(rr(0, 2.99)) { gx.append(rr(0, pageW)) }
    for _ in 0..<Int(rr(0, 2.99)) { gy.append(rr(0, pageH)) }

    let s = strengths[i % 3]
    let r = AlignmentEngine.resolvePosition(for: dragging, others: others, homePage: home,
                                            stageBounds: stage, strength: s,
                                            guidesX: gx, guidesY: gy)
    let badges = AlignmentEngine.equalSpacingBadges(frames: others, page: home)
    results.append(Out(
        x: r.frame.origin.x, y: r.frame.origin.y, w: r.frame.width, h: r.frame.height,
        snappedX: r.snappedX, snappedY: r.snappedY,
        guides: r.guides.map { [$0.axis == .vertical ? 0 : 1, $0.position, $0.start, $0.end] },
        badges: badges.map { [$0.midPoint.x, $0.midPoint.y, Double($0.value)] }
    ))
}

let enc = JSONEncoder()
enc.outputFormatting = [.sortedKeys]
FileHandle.standardOutput.write(try! enc.encode(results))
