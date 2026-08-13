// ALIGNED Mac 殼。檔案 IO 全在這層——core/ 維持平台無關。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

mod mediaserv;

#[derive(serde::Serialize)]
struct LoadedProject {
    json: String,
    /// 素材資料夾的絕對路徑（無素材＝None）。前端用 convertFileSrc 轉成可載的 URL。
    asset_dir: Option<String>,
    /// 專案根資料夾——存回 .alignproj 時要重新打包的那個資料夾。
    root_dir: String,
}

/// 開專案。兩種來源：
/// - `.alignproj`（AppleArchive/LZFSE 單檔）→ 呼叫系統的 `aa` 解到暫存資料夾。
///   這是 macOS 內建工具，也是「跨平台容器待定案」期間 Mac 端零成本的解法。
/// - `project.json` → 直接讀，素材抓同層的 assets/。
#[tauri::command]
fn load_project(path: String) -> Result<LoadedProject, String> {
    let p = PathBuf::from(&path);
    if p.extension().and_then(|e| e.to_str()) == Some("alignproj") {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_millis();
        // 暫存路徑要落在 assetProtocol 的 scope（$TEMP）內，webview 才載得到素材
        let dir = std::env::temp_dir().join(format!("aligned-mac-{stamp}"));
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let out = Command::new("aa")
            .args(["extract", "-i", &path, "-d"])
            .arg(&dir)
            .output()
            .map_err(|e| format!("呼叫 aa 失敗：{e}"))?;
        if !out.status.success() {
            return Err(format!("解包失敗：{}", String::from_utf8_lossy(&out.stderr)));
        }
        let json = fs::read_to_string(dir.join("project.json")).map_err(|e| e.to_string())?;
        let assets = dir.join("assets");
        if assets.exists() { mediaserv::register_root(&assets.to_string_lossy()); }
        Ok(LoadedProject {
            json,
            asset_dir: assets.exists().then(|| assets.to_string_lossy().into_owned()),
            root_dir: dir.to_string_lossy().into_owned(),
        })
    } else {
        let json = fs::read_to_string(&p).map_err(|e| e.to_string())?;
        let parent = p.parent().unwrap_or(&p).to_path_buf();
        let assets = parent.join("assets");
        if assets.exists() { mediaserv::register_root(&assets.to_string_lossy()); }
        Ok(LoadedProject {
            json,
            asset_dir: assets.exists().then(|| assets.to_string_lossy().into_owned()),
            root_dir: parent.to_string_lossy().into_owned(),
        })
    }
}

/// 影片預覽伺服器的 base URL（`http://127.0.0.1:<port>/<token>`）。
/// 前端把「素材絕對路徑」percent-encode 接在後面當影片 src。
#[tauri::command]
fn media_base() -> String {
    mediaserv::base()
}

/// 存一張 PNG。資料走 base64——invoke 的參數是 JSON，丟原始位元組陣列會慢到不能用。
#[tauri::command]
fn save_png(path: String, data: String) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| e.to_string())?;
    fs::write(&path, bytes).map_err(|e| e.to_string())
}

/// 存文字檔。寫暫存檔再 rename＝原子替換——存到一半斷掉不會留下壞檔
/// （iOS 端的地雷 12「mutation 必原子寫」，同一條紀律）。
#[tauri::command]
fn save_text(path: String, contents: String) -> Result<(), String> {
    let tmp = format!("{path}.tmp");
    fs::write(&tmp, contents).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// 把專案資料夾重新打包成 .alignproj（AppleArchive/LZFSE，與 iOS 同容器）。
/// 第一次覆寫前留一份 .bak——存檔把人家的檔弄壞是不可原諒的。
#[tauri::command]
fn pack_alignproj(dir: String, dest: String) -> Result<(), String> {
    let bak = format!("{dest}.bak");
    if PathBuf::from(&dest).exists() && !PathBuf::from(&bak).exists() {
        fs::copy(&dest, &bak).map_err(|e| e.to_string())?;
    }
    let tmp = format!("{dest}.tmp");
    let out = Command::new("aa")
        .args(["archive", "-d", &dir, "-o", &tmp, "-a", "lzfse"])
        .output()
        .map_err(|e| format!("呼叫 aa 失敗：{e}"))?;
    if !out.status.success() {
        return Err(format!("打包失敗：{}", String::from_utf8_lossy(&out.stderr)));
    }
    fs::rename(&tmp, &dest).map_err(|e| e.to_string())
}

/// 輕量範本：只有一份 project.json 的 .alignproj（沒有 assets/）。
/// 匯入端本來就把 assets/ 當選配，所以這種包在 iPad 上開得起來、圖是空欄位框。
#[tauri::command]
fn pack_template(json: String, dest: String) -> Result<(), String> {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_millis();
    let dir = std::env::temp_dir().join(format!("aligned-template-{stamp}"));
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::write(dir.join("project.json"), json).map_err(|e| e.to_string())?;
    let out = Command::new("aa")
        .args(["archive", "-d", dir.to_str().unwrap_or_default(), "-o", &dest, "-a", "lzfse"])
        .output()
        .map_err(|e| format!("呼叫 aa 失敗：{e}"))?;
    let _ = fs::remove_dir_all(&dir);
    if !out.status.success() {
        return Err(format!("打包失敗：{}", String::from_utf8_lossy(&out.stderr)));
    }
    Ok(())
}

/// 開一個全新的暫存資料夾（影片匯出要在裡面放圖層 PNG 與 spec.json）。
#[tauri::command]
fn make_temp_dir() -> Result<String, String> {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_millis();
    let dir = std::env::temp_dir().join(format!("aligned-export-{stamp}"));
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().to_string())
}

/// 找打包進 App 的 alignvideo。
/// 開發時（npm run dev / cargo run）二進位在 src-tauri/bin/，正式包在 Contents/Resources/bin/。
fn find_alignvideo(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let bundled = app.path().resolve("bin/alignvideo", tauri::path::BaseDirectory::Resource).ok();
    [
        bundled,
        std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.join("alignvideo"))),
        Some(PathBuf::from("bin/alignvideo")),
        Some(PathBuf::from("src-tauri/bin/alignvideo")),
    ].into_iter().flatten().find(|p| p.exists())
        .ok_or_else(|| "找不到 alignvideo（跑一次 videotool/build.sh）".to_string())
}

/// 跑 alignvideo 匯出影片頁。
#[tauri::command]
fn export_video(app: tauri::AppHandle, spec: String) -> Result<String, String> {
    let tool = find_alignvideo(&app)?;
    let out = Command::new(&tool).arg(&spec).output()
        .map_err(|e| format!("啟動 alignvideo 失敗：{e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// 修剪影片：呼叫打包進 App 的 alignvideo 切出 [start, end) 另存。
/// 與 export_video 共用找工具的邏輯，參數形狀不同所以分開一支。
#[tauri::command]
fn trim_video(app: tauri::AppHandle, src: String, dest: String, start: f64, end: f64) -> Result<(), String> {
    let tool = find_alignvideo(&app)?;
    let out = Command::new(&tool)
        .args(["trim", &src, &dest, &start.to_string(), &end.to_string()])
        .output()
        .map_err(|e| format!("啟動 alignvideo 失敗：{e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    mediaserv::register_root(
        PathBuf::from(&dest).parent().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default().as_str(),
    );
    Ok(())
}

/// 把使用者選的圖複製進專案 assets/，回新檔名。檔名用時間戳不用原名——
/// 原名可能撞名、可能含奇怪字元，而 schema 只在乎字串唯一。
#[tauri::command]
fn copy_asset(src: String, dest_dir: String) -> Result<String, String> {
    fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
    mediaserv::register_root(&dest_dir);   // 拖進來的影片也要走媒體伺服器
    let ext = PathBuf::from(&src)
        .extension().and_then(|e| e.to_str()).unwrap_or("jpg").to_lowercase();
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_millis();
    let name = format!("mac-{stamp}.{ext}");
    fs::copy(&src, format!("{dest_dir}/{name}")).map_err(|e| e.to_string())?;
    Ok(name)
}

// ── 字型 ──────────────────────────────────────────────────────────────
// WKWebView 沒有 queryLocalFonts，系統字型只能由殼層枚舉後餵給前端。
// 儲存模型與 iOS 相同：專案存 PostScript 名——同一套字型兩台都裝，專案就兩邊長一樣。

#[derive(serde::Serialize)]
struct FontEntry {
    label: String,
    ps: String,
    path: Option<String>,
}

/// 名稱表裡有中文名就用中文名（剪映同款做法），沒有就用第一個（通常是英文）。
fn font_label(families: &[(String, fontdb::Language)]) -> Option<String> {
    let first = families.first().map(|(n, _)| n.clone())?;
    Some(
        families
            .iter()
            .map(|(n, _)| n)
            .find(|n| n.chars().any(|c| ('\u{4E00}'..='\u{9FFF}').contains(&c)))
            .cloned()
            .unwrap_or(first),
    )
}

/// 這台電腦裝的字型，一個家族回一個代表面（Normal 樣式、字重最接近 400）。
/// 「.」開頭的是系統私有字型（.SF NS…），CSS 用不到，濾掉。
#[tauri::command]
fn list_system_fonts() -> Vec<FontEntry> {
    let mut db = fontdb::Database::new();
    db.load_system_fonts();
    let mut best: std::collections::HashMap<String, (u16, FontEntry)> = Default::default();
    for f in db.faces() {
        if f.style != fontdb::Style::Normal || f.post_script_name.starts_with('.') {
            continue;
        }
        let Some((family, _)) = f.families.first() else { continue };
        if family.starts_with('.') {
            continue;
        }
        let Some(label) = font_label(&f.families) else { continue };
        let d = (i32::from(f.weight.0) - 400).unsigned_abs() as u16;
        let entry = FontEntry { label, ps: f.post_script_name.clone(), path: None };
        match best.entry(family.clone()) {
            std::collections::hash_map::Entry::Occupied(mut e) if d < e.get().0 => {
                e.insert((d, entry));
            }
            std::collections::hash_map::Entry::Vacant(e) => {
                e.insert((d, entry));
            }
            _ => {}
        }
    }
    let mut out: Vec<FontEntry> = best.into_values().map(|(_, e)| e).collect();
    out.sort_by(|a, b| a.label.cmp(&b.label));
    out
}

fn user_fonts_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("UserFonts");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // 字型檔也從媒體伺服器出（FontFace 的 fetch 是強制 CORS，asset:// 在 WKWebView 過不了）
    mediaserv::register_root(&dir.to_string_lossy());
    Ok(dir)
}

/// 讀一個字型檔的名稱資訊（.ttc 取第一個面，iOS 端同款取法）。
fn describe_font(path: &PathBuf) -> Option<FontEntry> {
    let mut db = fontdb::Database::new();
    db.load_font_file(path).ok()?;
    let f = db.faces().next()?;
    Some(FontEntry {
        label: font_label(&f.families)?,
        ps: f.post_script_name.clone(),
        path: Some(path.to_string_lossy().into_owned()),
    })
}

/// 匯入過的字型檔（App 資料夾 UserFonts/，重開還在——iOS Documents/UserFonts 同款設計）。
#[tauri::command]
fn list_user_fonts(app: tauri::AppHandle) -> Result<Vec<FontEntry>, String> {
    let dir = user_fonts_dir(&app)?;
    let mut out = Vec::new();
    for e in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let p = e.map_err(|e| e.to_string())?.path();
        let ext = p.extension().and_then(|s| s.to_str()).unwrap_or("").to_lowercase();
        if !["ttf", "otf", "ttc"].contains(&ext.as_str()) {
            continue;
        }
        if let Some(f) = describe_font(&p) {
            out.push(f);
        }
    }
    out.sort_by(|a, b| a.label.cmp(&b.label));
    Ok(out)
}

#[tauri::command]
fn import_font(app: tauri::AppHandle, src: String) -> Result<FontEntry, String> {
    let srcp = PathBuf::from(&src);
    describe_font(&srcp).ok_or("讀不出字型資訊（檔案可能不是有效字型）")?;
    let dest = user_fonts_dir(&app)?.join(srcp.file_name().ok_or("路徑不對")?);
    fs::copy(&srcp, &dest).map_err(|e| e.to_string())?;
    describe_font(&dest).ok_or_else(|| "複製後讀取失敗".to_string())
}

/// 在使用者的預設瀏覽器開網址（更新橫幅／齒輪選單用）。
/// 只放行 http(s) 與 mailto（回報問題開信件草稿），不當萬用開檔器。
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://") && !url.starts_with("http://") && !url.starts_with("mailto:") {
        return Err("只開 http(s)/mailto 網址".into());
    }
    Command::new("open").arg(url).status().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod font_tests {
    #[test]
    fn 系統字型列得出來() {
        let fonts = super::list_system_fonts();
        assert!(fonts.len() > 50, "只列出 {} 套——枚舉壞了", fonts.len());
        assert!(fonts.iter().all(|f| !f.ps.starts_with('.') && !f.label.is_empty()));
        // PS 名不重複（前端拿它當唯一鍵）
        let mut ps: Vec<_> = fonts.iter().map(|f| &f.ps).collect();
        ps.sort();
        ps.dedup();
        assert_eq!(ps.len(), fonts.len());
    }

    #[test]
    fn 內嵌字型檔讀得出名稱() {
        let p = std::path::PathBuf::from(concat!(
            env!("CARGO_MANIFEST_DIR"), "/../public/fonts/Inter-Regular.otf"));
        let f = super::describe_font(&p).expect("讀不出 Inter");
        assert_eq!(f.ps, "Inter-Regular");
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![load_project, save_png, save_text, pack_alignproj,
            pack_template, copy_asset,
            make_temp_dir, export_video, media_base, trim_video,
            list_system_fonts, list_user_fonts, import_font, open_url])
        .run(tauri::generate_context!())
        .expect("tauri 啟動失敗");
}
