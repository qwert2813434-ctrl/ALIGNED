// 全 App 共用的色票（2026-09-05 小高定案「傳統色」，樣本間 `01 - 研究/樣本間/色票/`）。
// 鐵則：這裡只管「可以點的那幾顆」——既有專案存的是 hex，一個 px 不動；改這裡只影響之後點的。
// iOS 端同一組在 `ALIGN.swiftpm/Sources/AppPalette.swift`，改一邊要改兩邊（同一顆 App 不該有兩套色票）。

/** 墨・紙・紺・蘇芳・黃檗・青磁・胡桃・鳩羽 */
export const PALETTE = ["1A1A1A", "FFFFFF", "2F4A6D", "8E3A3F", "C9B458", "6F9E92", "6E5643", "7A6A8A"] as const;
/** 頁面背景的紙色：純白（IG 貼文要純白的人多，留）・胡粉・米白・牛皮・鼠・墨 */
export const PAPERS = ["FFFFFF", "F4F1EA", "EDEAE0", "D8C4A0", "A9A8A3", "1C1B1A"] as const;
