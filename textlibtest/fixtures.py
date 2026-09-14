# 文字庫對照測試的測資：Swift 原檔與 TS 移植各跑一次、逐案比對（textlibtest/run.sh）。
# 特殊字元一律用 chr() 組，別直接打進原始碼——看不見的字元改壞了也看不出來。
import json

ZWJ, WJ, LS, PS, NEL = chr(0x200D), chr(0x2060), chr(0x2028), chr(0x2029), chr(0x85)
IDSP, NBSP, VT, FF, ZWSP, DEL = chr(0x3000), chr(0xA0), chr(0x0B), chr(0x0C), chr(0x200B), chr(0x7F)
ACUTE = chr(0x301)
FAMILY = chr(0x1F468) + ZWJ + chr(0x1F469) + ZWJ + chr(0x1F467)

texts = [
    "今天天氣很好。我們去散步！好嗎？",
    "第一段\n\n第二段。還有",
    "……",
    "Hello world. It's 3.5 now!",
    "好。」他說。",
    "",
    "   \n\t",
    "a\r\nb\r\n\r\nc。",
    FAMILY + " 家人。e" + ACUTE + " café!",
    "１２３．ＡＢＣ",
    "第一行" + LS + "第二行" + PS + "第三行",
    "U.S.A. is big.",
    "End.",
    "…?!",
    IDSP + "全形空白" + IDSP + "。",
    "Tab\there",
    "x" + NEL + "y",
    "數字 42 和 ½",
    "探" + WJ + "索ab。\n",
    "ｱｲｳ half-width ｶﾅ",
    NBSP + "nbsp" + NBSP,
    "天氣轉涼的那一週，我把相機收進抽屜。\n不是不拍了，是想先把眼睛借給文字。\n\n今天在巷口看到一排晾著的白襯衫，風一吹，像一整列還沒排好的字。",
    "a" * 50 + "\n" + "b" * 50 + "\n" + "中" * 30,
    "line1\n  line2  \n\n\tline3",
    "Hello\nworld",
    VT + "v" + FF + "f",
    "Hi.\nOK",
    "3.14159 is pi",
    "中文。English sentence. 3.5!",
    "「」『』",
    "雙擊編輯文字",
    ZWSP + "零寬" + ZWSP,
]

memos = [
    {"id": "20270115-080000-abcd", "title": "秋天\n的筆記", "body": "---\n第一行\n\n最後一行\n",
     "created": 1800000000, "updated": 1800000600, "cells": 14, "used": 2, "usedIn": ["A｜B", "九月"]},
    {"id": "x", "title": "", "body": "", "created": 1800000000.7, "updated": 1800000000.2, "cells": None, "used": 0, "usedIn": []},
    {"id": "y", "title": "  spaced  ", "body": "b", "created": 0, "updated": 86400, "cells": 99, "used": 0, "usedIn": ["a\r\nb", " c "]},
    {"id": "z", "title": "line" + LS + "sep" + NEL + "x\r\ny", "body": "\r\nbody\r\n", "created": 1757829264, "updated": 1757829310,
     "cells": 4, "used": 7, "usedIn": ["ALIGNED 1.1.1 Update EN（4頁）"]},
    {"id": "w", "title": "", "body": "\n\n  第一行有字  \n第二行", "created": 1757829264, "updated": 1757829264, "cells": None, "used": 1, "usedIn": []},
]

decodes = [
    {"fileID": "raw", "text": "自己丟進來的純文字\n第二行", "now": 1800000000},
    {"fileID": "crlf", "text": "---\r\ntitle: CRLF\r\ncreated: 2026-09-14T05:54:24Z\r\nupdated: 2026-09-14T05:55:10Z\r\ncells: 12\r\n---\r\n內文\r\n第二行", "now": 1},
    {"fileID": "tz", "text": "---\ntitle: 時區\ncreated: 2026-09-14T13:54:24+08:00\nupdated: 2026-09-14T05:54:24.500Z\n---\nx", "now": 2},
    {"fileID": "bad", "text": "---\ntitle:\ncells: 0\nused: -3\nusedIn: ｜｜a｜\nnoColon\n key with space : value : more \n---", "now": 3},
    {"fileID": "cells", "text": "---\ncells: 150\nused: +2\n---\n", "now": 4},
    {"fileID": "cells2", "text": "---\ncells: 14.0\nused: 2x\n---\nbody", "now": 5},
    {"fileID": "fence", "text": " --- \nkey: v\n---\n", "now": 6},
    {"fileID": "unclosed", "text": "---\ntitle: never closed\nbody", "now": 7},
    {"fileID": "empty", "text": "", "now": 8},
    {"fileID": "dup", "text": "---\ntitle: a\ntitle: b\n---\n---\nbody with fence", "now": 9},
    {"fileID": "ios", "text": "---\nid: 20260914-055424-8e3e\ntitle: 移動物件文案\ncreated: 2026-09-14T05:54:24Z\nupdated: 2026-09-14T05:55:10Z\nused: 1\nusedIn: 某專案（4頁）\n---\n內文", "now": 10},
]

placements = [
    {"cells": 14, "fontSize": 32.4, "available": 928.8},
    {"cells": 40, "fontSize": 32.4, "available": 928.8},
    {"cells": 1, "fontSize": 32.4, "available": 100},
    {"cells": 0, "fontSize": 10, "available": 1000},
    {"cells": -5, "fontSize": 10, "available": 1000},
    {"cells": 12, "fontSize": 32.4, "available": 1e12},
]

widths = [{"width": w, "fontSize": f} for (w, f) in [
    (456.84, 32.4), (928.8, 32.4), (100, 32.4), (1300, 32.4), (0, 32.4), (100, 0),
    (32.4 * 4.1, 32.4), (32.4 * 40.1, 32.4), (32.4 * 40.6, 32.4), (32.4 * 3.6, 32.4), (32.4 * 4.6, 32.4), (-50, 32.4),
]]

stems = ["20260914-055424-8e3e", "a/b\\c:d", ".hidden", "  spaced  ", "", "...", "x" + ZWJ + "y", "tab\tname",
         "中文 標題（草稿）", " .lead", "..x..", ZWSP, "a" + DEL + "b", IDSP + "全形" + IDSP]

print(json.dumps({"texts": texts, "memos": memos, "decodes": decodes, "placements": placements,
                  "widths": widths, "stems": stems}, ensure_ascii=True))
