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
