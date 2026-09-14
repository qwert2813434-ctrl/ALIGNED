import CoreGraphics
import Foundation

// 文字庫對照測試的 Swift 端：讀 fixtures.json，用 iOS 原檔（TextMemo／TextMemoLibrary／TextMemoSync）算一遍輸出 JSON。
// TS 端＝textlibtest/harness.ts，兩邊欄位一一對應。

let fx = try! JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) as! [String: Any]

func opt(_ v: Any?) -> Any { v ?? NSNull() }
func num(_ v: Any?) -> Double { (v as? NSNumber)?.doubleValue ?? 0 }
func memoJSON(_ m: TextMemo) -> [String: Any] {
    ["id": m.id, "title": m.title, "body": m.body, "created": m.created.timeIntervalSince1970,
     "updated": m.updated.timeIntervalSince1970, "cells": opt(m.cellsPerRow), "used": m.usedCount, "usedIn": m.usedIn]
}

let texts = (fx["texts"] as! [String]).map { s -> [String: Any] in
    let none = TextMemo(title: "", body: s), t = TextMemo(title: "T", body: s)
    let blank = TextMemo(title: " \n ", body: s), asTitle = TextMemo(title: s, body: "")
    return [
        "chars": TextMemoMetrics.characterCount(s),
        "sentences": TextMemoMetrics.sentenceCount(s),
        "paragraphs": TextMemoMetrics.paragraphCount(s),
        "cells": ManuscriptGrid.cells(s).map { ["t": $0.text, "u": $0.units] as [String: Any] },
        "titleNone": opt(none.displayTitle), "previewNone": none.preview,
        "titleT": opt(t.displayTitle), "previewT": t.preview,
        "titleBlank": opt(blank.displayTitle),
        "isBlank": none.isBlank, "asTitleBlank": asTitle.isBlank, "asTitle": opt(asTitle.displayTitle),
        "stem": TextMemoLibrary.fileStem(s),
    ]
}

let memos = (fx["memos"] as! [[String: Any]]).map { f -> [String: Any] in
    let m = TextMemo(id: f["id"] as! String, title: f["title"] as! String, body: f["body"] as! String,
                     created: Date(timeIntervalSince1970: num(f["created"])), updated: Date(timeIntervalSince1970: num(f["updated"])),
                     cellsPerRow: f["cells"] as? Int, usedCount: f["used"] as! Int, usedIn: f["usedIn"] as! [String])
    let enc = TextMemoFile.encode(m)
    return ["encoded": enc, "back": memoJSON(TextMemoFile.decode(enc, fileID: m.id)),
            "conflictTitle": TextMemoSyncPlanner.conflictCopy(of: m, marker: "衝突副本").title,
            "displayTitle": opt(m.displayTitle), "preview": m.preview]
}

let decodes = (fx["decodes"] as! [[String: Any]]).map { f -> [String: Any] in
    memoJSON(TextMemoFile.decode(f["text"] as! String, fileID: f["fileID"] as! String, now: Date(timeIntervalSince1970: num(f["now"]))))
}

let placements = (fx["placements"] as! [[String: Any]]).map { f -> [String: Any] in
    let r = TextMemoPlacement.fit(cellsPerRow: f["cells"] as! Int, fontSize: CGFloat(num(f["fontSize"])), available: CGFloat(num(f["available"])))
    return ["fontSize": Double(r.fontSize), "width": Double(r.width)]
}

let widths = (fx["widths"] as! [[String: Any]]).map { f -> Any in
    opt(TextMemoPlacement.cellsPerRow(width: CGFloat(num(f["width"])), fontSize: CGFloat(num(f["fontSize"]))))
}

let stems = (fx["stems"] as! [String]).map { TextMemoLibrary.fileStem($0) }

let out: [String: Any] = ["texts": texts, "memos": memos, "decodes": decodes, "placements": placements, "widths": widths, "stems": stems]
FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: out, options: [.sortedKeys]))
