# 比對 Swift 與 TS 兩份輸出：數字容許浮點誤差，其他逐字相同。
import json, math, sys

a = json.load(open(sys.argv[1]))
b = json.load(open(sys.argv[2]))
diffs = []
total = [0]

def cmp(x, y, path):
    total[0] += 1
    num = lambda v: isinstance(v, (int, float)) and not isinstance(v, bool)
    if num(x) and num(y):
        if not math.isclose(x, y, rel_tol=1e-9, abs_tol=1e-6):
            diffs.append((path, x, y))
        return
    if type(x) != type(y):
        diffs.append((path, x, y))
        return
    if isinstance(x, dict):
        for k in sorted(set(x) | set(y)):
            if k not in x or k not in y:
                diffs.append((f"{path}.{k}", x.get(k, "<缺>"), y.get(k, "<缺>")))
            else:
                cmp(x[k], y[k], f"{path}.{k}")
    elif isinstance(x, list):
        if len(x) != len(y):
            diffs.append((f"{path}[長度]", len(x), len(y)))
        for i, (p, q) in enumerate(zip(x, y)):
            cmp(p, q, f"{path}[{i}]")
    elif x != y:
        diffs.append((path, x, y))

cmp(a, b, "$")
if diffs:
    for path, x, y in diffs[:40]:
        print(f"❌ {path}\n   Swift: {x!r}\n   TS:    {y!r}")
    print(f"對照 FAIL：{len(diffs)} 處不同")
    sys.exit(1)
print(f"✅ 對照 PASS：{len(a['texts'])} 段文字、{len(a['memos'])} 篇編碼、{len(a['decodes'])} 份解碼、"
      f"{len(a['placements']) + len(a['widths'])} 組框寬、{len(a['stems'])} 個檔名，{total[0]} 個值逐一相同")
