// 文字庫（2026-09-14）：iPhone／iPad 把文字庫同步到 iCloud 雲碟「ALIGNED/TextLibrary」（一篇一個 .md），
// 桌面版直接讀寫那個資料夾——Mac 的 iCloud 雲碟本來就是本機資料夾、系統在背景上傳下載，
// 不必像手機另存一份本機副本（手機要：iOS 讀 iCloud 慢，App 也碰不到整個雲碟）。
//
// 這層只做檔案 IO：找資料夾、列、讀、原子寫、刪除並留墓碑。格式與規則在前端
// core/textmemo.ts、textlib.ts；同步規則正本是 iOS TextMemoSync.swift 檔頭：
// - 刪除＝刪 <id>.md，並在 .deleted/<id> 留一個空檔（墓碑），手機看到墓碑才刪自己那份；
// - 寫回一篇時順手拿掉它的墓碑（別台刪了、這邊後來又改過＝改的贏，同 iOS）。

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

const DELETED_DIR: &str = ".deleted";

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Located {
    /// iCloud 雲碟根目錄（沒登入 iCloud／沒裝 iCloud for Windows＝None）。
    icloud_root: Option<String>,
    /// 根目錄下的 ALIGNED 資料夾（手機選傳輸資料夾時建的；不存在＝None）。
    aligned: Option<String>,
}

#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    name: String,
    modified_ms: f64,
    size: u64,
}

#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    exists: bool,
    files: Vec<Entry>,
    /// 還沒下載的 iCloud 佔位檔（舊版 macOS 的 `.名字.md.icloud`）→ 名字。
    placeholders: Vec<String>,
}

fn icloud_root() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    let root = std::env::var_os("HOME")
        .map(|h| PathBuf::from(h).join("Library/Mobile Documents/com~apple~CloudDocs"));
    #[cfg(target_os = "windows")]
    let root = std::env::var_os("USERPROFILE").map(|h| PathBuf::from(h).join("iCloudDrive"));
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let root: Option<PathBuf> = None;
    root.filter(|p| p.is_dir())
}

/// 檔名（不含 .md）能不能用：擋路徑分隔、控制字元與隱藏檔，別讓前端傳進來的 id 寫到資料夾外。
/// 前端另外照 iOS 的 fileStem 規則過濾一次（core/textmemo.ts），這裡是保險。
fn stem_ok(stem: &str) -> bool {
    !stem.is_empty()
        && !stem.starts_with('.')
        && !stem.chars().any(|c| c == '/' || c == '\\' || c == ':' || c.is_control())
}

fn md_path(dir: &Path, stem: &str) -> Result<PathBuf, String> {
    if stem_ok(stem) {
        Ok(dir.join(format!("{stem}.md")))
    } else {
        Err(format!("檔名不能用：{stem}"))
    }
}

pub fn list_dir(dir: &Path) -> Result<Listing, String> {
    let entries = match fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == ErrorKind::NotFound => {
            return Ok(Listing { exists: false, files: vec![], placeholders: vec![] })
        }
        Err(e) => return Err(e.to_string()),
    };
    let mut files = Vec::new();
    let mut placeholders = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(stem) = name.strip_prefix('.').and_then(|n| n.strip_suffix(".md.icloud")) {
            placeholders.push(stem.to_string());
            continue;
        }
        let is_md = Path::new(&name).extension().is_some_and(|e| e.eq_ignore_ascii_case("md"));
        if name.starts_with('.') || !is_md {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let modified_ms = meta.modified().ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs_f64() * 1000.0)
            .unwrap_or(0.0);
        files.push(Entry { name, modified_ms, size: meta.len() });
    }
    Ok(Listing { exists: true, files, placeholders })
}

/// 檔案不在＝None（別台剛刪掉）；其他讀不到的情況報錯。
pub fn read_memo(dir: &Path, stem: &str) -> Result<Option<String>, String> {
    let bytes = match fs::read(md_path(dir, stem)?) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    String::from_utf8(bytes).map(Some).map_err(|_| "不是 UTF-8 文字檔".to_string())
}

/// 寫暫存檔再 rename＝原子替換。暫存檔點開頭、副檔名不是 .md：手機列檔不會把它當成一篇。
pub fn write_memo(dir: &Path, stem: &str, contents: &str) -> Result<(), String> {
    let path = md_path(dir, stem)?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!(".{stem}.md.{}.tmp", std::process::id()));
    fs::write(&tmp, contents).map_err(|e| e.to_string())?;
    if let Err(e) = fs::rename(&tmp, &path) {
        let _ = fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    let tombs = dir.join(DELETED_DIR);
    let _ = fs::remove_file(tombs.join(stem));
    let _ = fs::remove_file(tombs.join(format!(".{stem}.icloud")));
    Ok(())
}

/// 刪一篇並留墓碑（檔案本來就不在也照留——別台可能還有那一篇）。
pub fn delete_memo(dir: &Path, stem: &str) -> Result<(), String> {
    let path = md_path(dir, stem)?;
    match fs::remove_file(&path) {
        Ok(()) => {}
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        Err(e) => return Err(e.to_string()),
    }
    let tombs = dir.join(DELETED_DIR);
    fs::create_dir_all(&tombs).map_err(|e| e.to_string())?;
    fs::write(tombs.join(stem), b"").map_err(|e| e.to_string())
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    // iCloud 還沒下載的檔，第一次讀會等系統抓下來——放到阻塞執行緒，別卡住其他指令
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn textlib_locate() -> Result<Located, String> {
    blocking(|| {
        let root = icloud_root();
        let aligned = root.as_ref().map(|r| r.join("ALIGNED")).filter(|p| p.is_dir());
        Ok(Located {
            icloud_root: root.map(|p| p.to_string_lossy().into_owned()),
            aligned: aligned.map(|p| p.to_string_lossy().into_owned()),
        })
    }).await
}

#[tauri::command]
pub async fn textlib_list(dir: String) -> Result<Listing, String> {
    blocking(move || list_dir(Path::new(&dir))).await
}

#[tauri::command]
pub async fn textlib_read(dir: String, stem: String) -> Result<Option<String>, String> {
    blocking(move || read_memo(Path::new(&dir), &stem)).await
}

#[tauri::command]
pub async fn textlib_write(dir: String, stem: String, contents: String) -> Result<(), String> {
    blocking(move || write_memo(Path::new(&dir), &stem, &contents)).await
}

#[tauri::command]
pub async fn textlib_delete(dir: String, stem: String) -> Result<(), String> {
    blocking(move || delete_memo(Path::new(&dir), &stem)).await
}

#[tauri::command]
pub async fn textlib_ensure_dir(dir: String) -> Result<(), String> {
    blocking(move || fs::create_dir_all(&dir).map_err(|e| e.to_string())).await
}

/// 舊版 macOS 的 iCloud 佔位檔：請系統下載（新版 macOS 讀檔時自己會抓，用不到這支）。
#[tauri::command]
pub async fn textlib_download(dir: String, stem: String) -> Result<(), String> {
    blocking(move || {
        let path = md_path(Path::new(&dir), &stem)?;
        #[cfg(target_os = "macos")]
        let _ = std::process::Command::new("/usr/bin/brctl").arg("download").arg(&path).status();
        let _ = path;
        Ok(())
    }).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("textlib-{tag}-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn 沒有資料夾就是空的不是錯() {
        let d = temp_dir("missing").join("TextLibrary");
        let l = list_dir(&d).unwrap();
        assert!(!l.exists && l.files.is_empty());
    }

    #[test]
    fn 寫讀列刪與墓碑() {
        let d = temp_dir("rw").join("TextLibrary");
        write_memo(&d, "20260914-055424-8e3e", "---\ntitle: 中文\n---\n內文").unwrap();
        write_memo(&d, "My Note（草稿）", "純文字").unwrap();
        fs::write(d.join("README.txt"), "不是一篇").unwrap();
        fs::write(d.join(".hidden.md"), "隱藏檔不列").unwrap();
        fs::write(d.join(".遠端.md.icloud"), "").unwrap();
        fs::write(d.join("大寫副檔名.MD"), "也算").unwrap();
        let mut names: Vec<_> = list_dir(&d).unwrap().files.into_iter().map(|e| e.name).collect();
        names.sort();
        assert_eq!(names, vec!["20260914-055424-8e3e.md", "My Note（草稿）.md", "大寫副檔名.MD"]);
        assert_eq!(list_dir(&d).unwrap().placeholders, vec!["遠端"]);
        assert_eq!(read_memo(&d, "My Note（草稿）").unwrap().as_deref(), Some("純文字"));
        assert_eq!(read_memo(&d, "不存在").unwrap(), None);
        // 暫存檔不留
        assert!(fs::read_dir(&d).unwrap().flatten().all(|e| !e.file_name().to_string_lossy().ends_with(".tmp")));

        delete_memo(&d, "My Note（草稿）").unwrap();
        assert!(!d.join("My Note（草稿）.md").exists());
        assert!(d.join(".deleted").join("My Note（草稿）").exists(), "刪除要留墓碑");
        // 同一篇又寫回來（改的贏）：墓碑拿掉
        write_memo(&d, "My Note（草稿）", "又回來").unwrap();
        assert!(!d.join(".deleted").join("My Note（草稿）").exists());
        // 刪一篇本來就不在的也留墓碑、不報錯
        delete_memo(&d, "不存在").unwrap();
        assert!(d.join(".deleted").join("不存在").exists());
    }

    #[test]
    fn 檔名擋路徑與隱藏檔() {
        let d = temp_dir("stem");
        for bad in ["../outside", "a/b", "a\\b", "a:b", ".hidden", "", "tab\tname"] {
            assert!(write_memo(&d, bad, "x").is_err(), "{bad:?} 應該被擋");
            assert!(read_memo(&d, bad).is_err());
            assert!(delete_memo(&d, bad).is_err());
        }
        assert!(!d.parent().unwrap().join("outside.md").exists());
    }

    #[test]
    fn 非_utf8_讀不出來() {
        let d = temp_dir("utf8");
        fs::write(d.join("壞.md"), [0xffu8, 0xfe, 0x00]).unwrap();
        assert!(read_memo(&d, "壞").is_err());
    }
}
