#!/bin/bash
# ALIGNED Mac 一鍵發版：簽名 → 公證 → staple → DMG → 簽名 → 公證 → staple → quarantine 驗收 → 蓋 release/
# 照抄 STB scripts/release-mac.sh（跑過六個版本的流程），差異只有：無 sidecar、DMG 檔名帶版本。
# 用法：scripts/release-mac.sh [ALIGNED.app 路徑]
set -euo pipefail
cd "$(dirname "$0")/.."

APP="${1:-src-tauri/target/release/bundle/macos/ALIGNED.app}"
ID="Developer ID Application: WEI-MING KAO (GHCWJ24V46)"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

[ -d "$APP" ] || { echo "❌ 找不到 ${APP}（先 npx tauri build --bundles app）"; exit 1; }
VER=$(defaults read "$(cd "$APP" && pwd)/Contents/Info.plist" CFBundleShortVersionString)
DMG="release/ALIGNED_${VER}_aarch64.dmg"
echo "▸ 發版 v${VER}（來源：${APP}）"

notarize() {
  xcrun notarytool submit "$1" --keychain-profile stb-notary --wait 2>&1 | tail -3 \
    | grep -q "Accepted" || { echo "❌ 公證失敗：${1}（xcrun notarytool log 查詳情）"; exit 1; }
}

echo "▸ 簽名（hardened runtime）"
ditto "$APP" "$WORK/ALIGNED.app"
# 巢狀的可執行檔要先自己簽（hardened runtime 下沒簽的內嵌 binary 會讓公證直接退件），
# 由內而外：alignvideo → .app。
codesign --force --options runtime --timestamp -s "$ID" "$WORK/ALIGNED.app/Contents/Resources/bin/alignvideo"
codesign --force --options runtime --timestamp -s "$ID" "$WORK/ALIGNED.app"

echo "▸ 公證 app（幾分鐘）"
ditto -c -k --keepParent "$WORK/ALIGNED.app" "$WORK/app.zip"
notarize "$WORK/app.zip"
xcrun stapler staple -q "$WORK/ALIGNED.app"

echo "▸ 打 DMG（手動 hdiutil，bundle_dmg.sh flaky）＋簽名"
mkdir "$WORK/root"
ditto "$WORK/ALIGNED.app" "$WORK/root/ALIGNED.app"
ln -s /Applications "$WORK/root/Applications"
hdiutil create -volname "ALIGNED" -srcfolder "$WORK/root" -ov -format UDZO "$WORK/out.dmg" -quiet
codesign --force --timestamp -s "$ID" "$WORK/out.dmg"

echo "▸ 公證 DMG（幾分鐘）"
notarize "$WORK/out.dmg"
xcrun stapler staple -q "$WORK/out.dmg"

echo "▸ quarantine 模擬驗收"
xattr -w com.apple.quarantine "0083;0;Safari;RELEASE-TEST" "$WORK/out.dmg"
spctl -a -t open --context context:primary-signature "$WORK/out.dmg" >/dev/null 2>&1 \
  || { echo "❌ DMG spctl 未過"; exit 1; }
hdiutil attach -nobrowse -readonly "$WORK/out.dmg" -mountpoint "$WORK/mnt" -quiet
ditto "$WORK/mnt/ALIGNED.app" "$WORK/qapp"
hdiutil detach "$WORK/mnt" -quiet
xattr -w com.apple.quarantine "0083;0;Safari;RELEASE-TEST" "$WORK/qapp"
spctl -a -t exec -vv "$WORK/qapp" 2>&1 | grep -q "Notarized Developer ID" \
  || { echo "❌ app spctl 未過"; exit 1; }

cp "$WORK/out.dmg" "$DMG"
echo "✅ v${VER} 全綠，已蓋 ${DMG}（SHA $(shasum -a 256 "$DMG" | cut -c1-8)…）"

# ── 發佈到 GitHub Releases（2026-08-10 起）───────────────────────────────
# 為什麼不再 git add DMG：每版 ~95MB 會永久留在 git 歷史（換之前 .git 已 556MB）。
# asset 用固定檔名，releases/latest/download/ 才會是永久網址，README 與
# aligned-latest.json 的 url 從此不用改版號。
# ⚠️ release/ 舊檔凍結兜底，勿刪——1.0.11 以前發出去的直連還指著它們。
ASSET="ALIGNED-macOS-arm64.dmg"
REPO="qwert2813434-ctrl/ALIGNED"
TOKEN=$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill | sed -n 's/^password=//p')
[ -n "${TOKEN}" ] || { echo "⚠️  拿不到 GitHub 憑證，Release 未建立（DMG 已蓋好，可稍後手動補）"; exit 0; }

api() { curl -sS -H "Authorization: Bearer ${TOKEN}" -H "Accept: application/vnd.github+json" "$@"; }

echo "▸ 建 GitHub Release v${VER}"
RELID=$(api -X POST "https://api.github.com/repos/${REPO}/releases" \
  -d "{\"tag_name\":\"v${VER}\",\"name\":\"ALIGNED ${VER}\",\"body\":\"See README for requirements. Apple Silicon + macOS 13+.\"}" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin).get("id",""))')
[ -n "${RELID}" ] || { echo "❌ Release 建立失敗（tag v${VER} 可能已存在）"; exit 1; }

echo "▸ 上傳 ${ASSET}（$(du -h "$DMG" | cut -f1)）"
# state 的鍵值間有無空格依端點而異（1.0.12 實測 uploads 端點回緊湊 JSON，帶空格的 grep 誤判成失敗）
api -X POST -H "Content-Type: application/octet-stream" --data-binary @"${DMG}" \
  "https://uploads.github.com/repos/${REPO}/releases/${RELID}/assets?name=${ASSET}" \
  | grep -Eq '"state": ?"uploaded"' || { echo "❌ asset 上傳失敗"; exit 1; }

# 抓回來比對，確認 CDN 上的檔案跟本機同一份（不是只看 HTTP 200）
echo "▸ 驗證永久網址"
URL="https://github.com/${REPO}/releases/latest/download/${ASSET}"
REMOTE=$(curl -sSL "${URL}" | shasum -a 256 | cut -d' ' -f1)
LOCAL=$(shasum -a 256 "${DMG}" | cut -d' ' -f1)
[ "${REMOTE}" = "${LOCAL}" ] || { echo "❌ 遠端 SHA 不符（remote ${REMOTE:0:8} vs local ${LOCAL:0:8}）"; exit 1; }

echo "✅ 已發佈 ${URL}"
echo "   還要手動做的只剩：改 37 - 工具間/上線/aligned-latest.json 的 version 與 notes（url 不用動）後 push"
