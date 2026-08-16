// 剝掉不進包的樣本與探針頁——Mac 端由 tauri.conf.json 的 `rm -rf` 做同一件事，
// 這支是給 Windows（沒有 rm）的跨平台版。清單兩邊要一致。
import { rmSync } from 'node:fs'

for (const p of [
  'dist/samples/real', 'dist/samples/_probe', 'dist/samples/perf',
  'dist/filterref', 'dist/assetprobe.html', 'dist/videoprobe.html',
]) rmSync(p, { recursive: true, force: true })
