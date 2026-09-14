# 比對全 Unicode 逐字判斷。私用區（U+E000–F8FF、第 15–16 平面）兩邊字庫各自定義，不算。
import json, sys

a = json.load(open(sys.argv[1])); b = json.load(open(sys.argv[2]))
private = lambda v: 0xE000 <= v <= 0xF8FF or v >= 0xF0000
def expand(ranges):
    out = set()
    for s, e in ranges: out.update(v for v in range(s, e + 1) if not private(v))
    return out
bad = 0
for k in sorted(set(a) | set(b)):
    A, B = expand(a.get(k, [])), expand(b.get(k, []))
    if A != B:
        bad += 1
        show = lambda xs: ", ".join(f"U+{x:04X}" for x in sorted(xs)[:20])
        print(f"❌ {k}：只有 Swift {show(A - B) or '-'}；只有 TS {show(B - A) or '-'}")
if bad: sys.exit(1)
print(f"✅ 字元判斷 PASS：{len(a)} 種判斷 × 全 Unicode（私用區除外）逐字相同")
