import Foundation

// 全 Unicode 逐字：Foundation CharacterSet 與 Swift Character 的判斷，各輸出成立的區段（TS 端＝textlibtest/scalars.ts）。
var flags: [String: [[Int]]] = [:]
let names = ["whitespaces", "whitespacesAndNewlines", "newlines", "controlCharacters",
             "characterIsWhitespace", "characterIsNewline", "characterIsLetterOrNumber"]
for n in names { flags[n] = [] }
func add(_ k: String, _ v: Int) {
    if let last = flags[k]!.last, last[1] == v - 1 { flags[k]![flags[k]!.count - 1][1] = v } else { flags[k]!.append([v, v]) }
}
for v in 0...0x10FFFF {
    guard let s = Unicode.Scalar(v) else { continue }
    let c = Character(s)
    if CharacterSet.whitespaces.contains(s) { add("whitespaces", v) }
    if CharacterSet.whitespacesAndNewlines.contains(s) { add("whitespacesAndNewlines", v) }
    if CharacterSet.newlines.contains(s) { add("newlines", v) }
    if CharacterSet.controlCharacters.contains(s) { add("controlCharacters", v) }
    if c.isWhitespace { add("characterIsWhitespace", v) }
    if c.isNewline { add("characterIsNewline", v) }
    if c.isLetter || c.isNumber { add("characterIsLetterOrNumber", v) }
}
FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: flags, options: [.sortedKeys]))
