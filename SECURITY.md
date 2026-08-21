# Security Policy / 安全回報

## Supported versions

| Version | Supported |
|---|---|
| Mac / Windows 1.1.x (latest release) | ✅ |
| iOS 1.1.x (App Store) | ✅ |
| Anything older | ❌ — please update |

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

- Email: **alignediosapp@gmail.com** (subject: `[ALIGNED security]`)
- Or use GitHub's private report: **Security → Report a vulnerability** on this repo.

You'll get a reply within 7 days. Once fixed, the release notes will credit you unless you ask otherwise.

## Scope

ALIGNED is a local desktop/mobile app. It makes no network requests except:
- the update check (`aligned-latest.json` on GitHub Pages, read-only), and
- opening external links you click.

Project files (`.alignproj` / `project.json`) are plain data; the app never executes anything from them. If you find a way to make it do so, that's exactly what we'd like to hear about.

---

## 安全回報（繁體中文）

安全問題請**不要**開公開 issue。

- 來信 **alignediosapp@gmail.com**（標題加 `[ALIGNED security]`），或
- 用本 repo 的 **Security → Report a vulnerability** 私下回報。

七天內回覆；修好後會在 Release 說明裡致謝（除非你不希望）。

ALIGNED 是本機 App，除了唯讀的更新檢查與你自己點的外部連結之外不連網；專案檔是純資料，App 不會執行裡面任何東西。
