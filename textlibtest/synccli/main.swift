import Foundation

// 文字庫互通測試用的「一台 iPhone／iPad」：iOS 原檔 TextMemoLibrary＋TextMemoSync 編成命令列。
//   synccli sync   <本機文字庫> <傳輸資料夾>
//   synccli save   <本機文字庫> <id> <標題> <內文> <修改時間 epoch 秒>
//   synccli delete <本機文字庫> <id>
//   synccli dump   <本機文字庫>

let args = CommandLine.arguments
func out(_ object: Any) {
    let data = try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .fragmentsAllowed])
    print(String(data: data, encoding: .utf8)!)
}
let library = TextMemoLibrary(root: URL(fileURLWithPath: args[2], isDirectory: true))

switch args[1] {
case "sync":
    let folder = URL(fileURLWithPath: args[3], isDirectory: true)
    let sync = TextMemoSync(library: library, conflictMarker: "衝突副本", accessFolder: { body in body(folder); return true })
    let r = sync.syncNow()
    out(["uploaded": r.uploaded, "pulled": r.pulled, "deletedLocal": r.deletedLocal, "deletedCloud": r.deletedCloud,
         "copies": r.copies, "held": r.heldBackDeletions, "error": r.error.map { $0 as Any } ?? NSNull(), "changed": r.changedAnything])
case "save":
    let date = Date(timeIntervalSince1970: Double(args[6])!)
    var memo = library.memo(id: args[3]) ?? TextMemo(id: args[3], created: date)
    memo.title = args[4]
    memo.body = args[5]
    memo.updated = date
    out(["saved": library.save(memo)])
case "delete":
    library.delete(id: args[3])
    out(["deleted": args[3]])
case "dump":
    out(library.memos.map { m -> [String: Any] in
        ["id": m.id, "title": m.title, "body": m.body, "used": m.usedCount, "usedIn": m.usedIn,
         "cells": m.cellsPerRow.map { $0 as Any } ?? NSNull(), "updated": m.updated.timeIntervalSince1970]
    })
default:
    fatalError("unknown command \(args[1])")
}
