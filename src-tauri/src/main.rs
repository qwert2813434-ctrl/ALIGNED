// ALIGNED Mac 殼。檔案 IO 全在這層——core/ 維持平台無關。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Emitter;
use tauri::menu::{MenuBuilder, MenuItem, SubmenuBuilder};

mod mediaserv;
mod model;
mod agentbridge;
mod textlib;

/// 呼叫系統的 Apple Archive 工具。
/// Windows／Linux 沒有 `aa`，而 `.alignproj` 就是 AppleArchive/LZFSE 容器——
/// 跨平台容器還沒拍板（README「待小高定奪」①），這裡給明確訊息，不要靜默生出壞檔。
#[cfg(target_os = "macos")]
fn aa(args: &[&str]) -> Result<(), String> {
    let out = Command::new("aa").args(args).output()
        .map_err(|e| format!("呼叫 aa 失敗：{e}"))?;
    if out.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&out.stderr).into_owned()) }
}

#[cfg(not(target_os = "macos"))]
fn aa(_args: &[&str]) -> Result<(), String> {
    Err("這個平台還不支援 .alignproj（Apple Archive 容器）——請改用 project.json 專案資料夾".into())
}

/// 把資料夾裡每個檔的存取／修改時間刷成現在。
/// macOS 每天 03:35 跑 dirhelper，清掉系統暫存夾裡三天沒碰的檔（CLEAN_FILES_OLDER_THAN_DAYS=3）；
/// aa 解出來的素材帶著原本的舊時間，不刷的話專案開著過一夜，素材就從解包夾裡被清掉。
fn touch_tree(dir: &Path) {
    let now = SystemTime::now();
    let times = fs::FileTimes::new().set_accessed(now).set_modified(now);
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            touch_tree(&p);
        } else if let Ok(f) = fs::File::options().write(true).open(&p) {
            let _ = f.set_times(times);
        }
    }
}

/// 存回 .alignproj 前，把「上一版有、解包夾裡卻不見了」的檔補回來，回傳補了幾個。
/// 桌面版從不刪素材，解包夾少掉的檔只會是被系統清掉的（見 touch_tree）——
/// 2026-09-23《研究算圖對比集》03:36 存檔就這樣丟了 10 個 mp4／png，檔案從 110 MB 掉到 55.8 MB。
/// 只補缺的、不覆蓋現有的：先解到旁邊的暫存夾（-include-path 是前綴比對，會多解），再逐檔搬進來。
#[cfg(target_os = "macos")]
fn restore_missing(dir: &Path, archive: &str) -> Result<usize, String> {
    let out = Command::new("aa").args(["list", "-i", archive, "-list-format", "json"]).output()
        .map_err(|e| format!("呼叫 aa 失敗：{e}"))?;
    if !out.status.success() { return Err(String::from_utf8_lossy(&out.stderr).into_owned()); }
    let entries: Vec<serde_json::Value> = serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())?;
    let missing: Vec<String> = entries.iter()
        .filter(|e| e["TYP"] == "F")
        .filter_map(|e| e["PAT"].as_str())
        .filter(|p| !p.is_empty() && !p.contains('\n') && !dir.join(p).exists())
        .map(String::from)
        .collect();
    if missing.is_empty() { return Ok(0); }
    let stage = PathBuf::from(format!("{}.restore", dir.to_string_lossy()));
    let list = PathBuf::from(format!("{}.restore-list", dir.to_string_lossy()));
    let _ = fs::remove_dir_all(&stage);
    fs::create_dir_all(&stage).map_err(|e| e.to_string())?;
    fs::write(&list, missing.join("\n") + "\n").map_err(|e| e.to_string())?;
    let r = aa(&["extract", "-i", archive, "-d", &stage.to_string_lossy(),
                 "-include-path-list", &list.to_string_lossy()]);
    let mut n = 0;
    if r.is_ok() {
        for p in &missing {
            let (from, to) = (stage.join(p), dir.join(p));
            if let Some(parent) = to.parent() { let _ = fs::create_dir_all(parent); }
            if fs::rename(&from, &to).is_ok() || fs::copy(&from, &to).is_ok() { n += 1; }
        }
    }
    let _ = fs::remove_dir_all(&stage);
    let _ = fs::remove_file(&list);
    r.map(|_| n)
}

#[cfg(not(target_os = "macos"))]
fn restore_missing(_dir: &Path, _archive: &str) -> Result<usize, String> { Ok(0) }

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
        aa(&["extract", "-i", &path, "-d", &dir.to_string_lossy()])
            .map_err(|e| format!("解包失敗：{e}"))?;
        touch_tree(&dir);
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
    let src = PathBuf::from(&dir);
    let ours = src.file_name().and_then(|n| n.to_str())
        .is_some_and(|n| n.starts_with("aligned-export-"));
    let bak = format!("{dest}.bak");
    if PathBuf::from(&dest).exists() {
        if !PathBuf::from(&bak).exists() {
            fs::copy(&dest, &bak).map_err(|e| e.to_string())?;
        }
        // 存回原檔（不是另存匯出）：先把被系統清掉的素材從上一版補回來，見 restore_missing
        if !ours {
            if let Err(e) = restore_missing(&src, &dest) { eprintln!("存檔前補素材失敗：{e}"); }
            touch_tree(&src);
        }
    }
    let tmp = format!("{dest}.tmp");
    aa(&["archive", "-d", &dir, "-o", &tmp, "-a", "lzfse"])
        .map_err(|e| format!("打包失敗：{e}"))?;
    fs::rename(&tmp, &dest).map_err(|e| e.to_string())?;
    // 打包完把來源暫存夾收掉。「打包 .alignproj」每按一次就複製一整份素材（可以好幾 GB），
    // 不收就一直留在 /tmp。⚠️ 條件卡死在「系統暫存夾裡、而且是 aligned-export- 開頭」——
    // 另一個呼叫點傳進來的是**已開啟專案的 root**（aligned-mac-* 或使用者資料夾），
    // 兩者都不符合，絕不會被刪到。
    if ours && src.starts_with(std::env::temp_dir()) {
        let _ = fs::remove_dir_all(&src);
    }
    Ok(())
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
    let r = aa(&["archive", "-d", dir.to_str().unwrap_or_default(), "-o", &dest, "-a", "lzfse"]);
    let _ = fs::remove_dir_all(&dir);
    r.map_err(|e| format!("打包失敗：{e}"))
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
        .ok_or_else(|| if cfg!(target_os = "macos") {
            "找不到 alignvideo（跑一次 videotool/build.sh）".to_string()
        } else {
            // alignvideo 是 Swift＋CoreImage 從 iOS 原始檔抽出來的，只長在 Apple 平台。
            "這個平台還不支援影片頁與動畫匯出（合成器 alignvideo 僅有 macOS 版）".to_string()
        })
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

/// 找打包進 App 的 alignmatte（去背器）。找法與 alignvideo 相同。
/// Windows 端之後掛的是同名的 ONNX 版工具，CLI 介面一致，所以這裡不必分平台。
fn find_alignmatte(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let bundled = app.path().resolve("bin/alignmatte", tauri::path::BaseDirectory::Resource).ok();
    [
        bundled,
        std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.join("alignmatte"))),
        Some(PathBuf::from("bin/alignmatte")),
        Some(PathBuf::from("src-tauri/bin/alignmatte")),
    ].into_iter().flatten().find(|p| p.exists())
        .ok_or_else(|| if cfg!(target_os = "macos") {
            "找不到 alignmatte（跑一次 mattetool/build.sh）".to_string()
        } else {
            "這個平台的去背工具還沒掛上（Windows 版走 ONNX 外掛模型，尚未實作）".to_string()
        })
}

/// 去背：對 `src` 跑一次主體抽取，遮罩寫進 `dest_dir`，回
/// `<檔名> <覆蓋率> <fine|suspect>`——覆蓋率太大是「圈到整棟樓」那種誤判的訊號，
/// 由前端決定要不要提示換一種去背。抽不到主體回 Err("NO_SUBJECT")，
/// 前端據此給一張空遮罩讓使用者自己刷，而不是彈一個失敗。
// `(async)` 不是把它變成非同步函式，是叫 Tauri 拿去別的執行緒跑。
// 不加的話同步指令是在主執行緒上跑的，去背要好幾秒＝整個介面凍住
//（2026-08-25 小高回報「點去背有點卡」就是這個）。
#[tauri::command(async)]
fn make_matte(app: tauri::AppHandle, src: String, dest_dir: String, name: String) -> Result<String, String> {
    let tool = find_alignmatte(&app)?;
    fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
    let dest = PathBuf::from(&dest_dir).join(&name);
    let out = Command::new(&tool).arg(&src).arg(&dest).output()
        .map_err(|e| format!("啟動 alignmatte 失敗：{e}"))?;
    match out.status.code() {
        Some(0) => {}
        Some(2) => return Err("NO_SUBJECT".to_string()),
        _ => return Err(String::from_utf8_lossy(&out.stderr).trim().to_string()),
    }
    // stdout＝"ok <寬> <高> <來源> <覆蓋率%> <fine|suspect>"
    let line = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let f: Vec<&str> = line.split_whitespace().collect();
    let coverage = f.get(4).copied().unwrap_or("0");
    let verdict = f.get(5).copied().unwrap_or("fine");
    Ok(format!("{name} {coverage} {verdict}"))
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

/// 跨專案貼上用：把來源檔照**指定檔名**搬進 assets/。
/// 影片海報要配對成 `<新影片名>.poster.jpg`，copy_asset 的自動命名做不到。
#[tauri::command]
fn copy_asset_as(src: String, dest_dir: String, name: String) -> Result<(), String> {
    fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
    mediaserv::register_root(&dest_dir);
    fs::copy(&src, format!("{dest_dir}/{name}")).map_err(|e| e.to_string())?;
    Ok(())
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
    // Windows 走 rundll32 的協定處理器：不經 cmd 剖析，網址裡的 & 不會被切斷。
    #[cfg(target_os = "windows")]
    Command::new("rundll32").args(["url.dll,FileProtocolHandler", &url])
        .status().map_err(|e| e.to_string())?;
    #[cfg(not(target_os = "windows"))]
    Command::new("open").arg(&url).status().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(all(test, target_os = "macos"))]
mod save_tests {
    use std::fs;

    /// 重現 2026-09-23：開著的專案素材被系統清掉，存檔不能跟著丟。
    #[test]
    fn 存檔補回被清掉的素材() {
        let root = std::env::temp_dir().join(format!("aligned-savetest-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let src = root.join("src");
        fs::create_dir_all(src.join("assets")).unwrap();
        fs::write(src.join("project.json"), "{}").unwrap();
        fs::write(src.join("assets/影片 a.mp4"), "A").unwrap();
        fs::write(src.join("assets/b.png"), "B").unwrap();
        fs::write(src.join("assets/b.png.poster.jpg"), "P").unwrap();
        let dest = root.join("p.alignproj").to_string_lossy().into_owned();
        super::pack_alignproj(src.to_string_lossy().into(), dest.clone()).unwrap();

        // 開檔（解包）→ 系統清掉兩個 → 使用者新加一個、改了 project.json → 存檔
        let r = super::load_project(dest.clone()).unwrap();
        let open = std::path::PathBuf::from(&r.root_dir);
        fs::remove_file(open.join("assets/影片 a.mp4")).unwrap();
        fs::remove_file(open.join("assets/b.png")).unwrap();
        fs::write(open.join("assets/new.png"), "N").unwrap();
        fs::write(open.join("project.json"), "{\"v\":2}").unwrap();
        super::pack_alignproj(r.root_dir.clone(), dest.clone()).unwrap();

        let back = super::load_project(dest).unwrap();
        let d = std::path::PathBuf::from(&back.root_dir);
        assert_eq!(fs::read_to_string(d.join("assets/影片 a.mp4")).unwrap(), "A");
        assert_eq!(fs::read_to_string(d.join("assets/b.png")).unwrap(), "B");
        assert_eq!(fs::read_to_string(d.join("assets/b.png.poster.jpg")).unwrap(), "P");
        assert_eq!(fs::read_to_string(d.join("assets/new.png")).unwrap(), "N");
        assert_eq!(back.json, "{\"v\":2}");
        assert!(!std::path::PathBuf::from(format!("{}.restore", r.root_dir)).exists());
        // 解包出來的檔時間要是現在，系統才不會清
        let m = fs::metadata(d.join("assets/b.png")).unwrap().modified().unwrap();
        assert!(m.elapsed().unwrap().as_secs() < 60);
        for p in [&root, &open, &d] { let _ = fs::remove_dir_all(p); }
    }
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
        .setup(|app| {
            // MCP 是加值能力，暫存區不可寫等 bridge 問題不能阻止 ALIGNED 本體開機。
            if let Err(error) = agentbridge::init() { eprintln!("agent bridge 啟動失敗：{error}"); }

            // Native menu is the desktop command map, not decorative OS chrome.
            // Every custom id below is handled by the web editor through
            // `aligned-native-menu`; standard window/app items stay native.
            let item = |id: &str, text: &str, shortcut: Option<&str>| {
                MenuItem::with_id(app, id, text, true, shortcut)
            };
            let app_menu = SubmenuBuilder::new(app, "ALIGNED")
                .about(None).separator()
                .item(&item("app_settings", "偏好設定…", Some("CmdOrCtrl+,"))?)
                .separator().services().separator().hide().hide_others().separator().quit().build()?;
            let file_menu = SubmenuBuilder::new(app, "File")
                .item(&item("file_new", "新專案", Some("CmdOrCtrl+N"))?)
                .item(&item("file_open", "開啟…", Some("CmdOrCtrl+O"))?)
                .item(&item("file_home", "最近專案與資料夾", None)?)
                .separator()
                .item(&item("file_save", "存檔", Some("CmdOrCtrl+S"))?)
                .separator()
                .item(&item("file_export_png", "匯出 PNG／影片…", Some("CmdOrCtrl+E"))?)
                .item(&item("file_export_template", "匯出範本（不含素材）…", None)?)
                .item(&item("file_pack", "打包 .alignproj（含素材）…", None)?)
                .separator().close_window().build()?;
            let edit_menu = SubmenuBuilder::new(app, "Edit")
                .item(&item("edit_undo", "復原", Some("CmdOrCtrl+Z"))?)
                .item(&item("edit_redo", "重做", Some("CmdOrCtrl+Shift+Z"))?)
                .separator()
                .item(&item("edit_copy", "拷貝", Some("CmdOrCtrl+C"))?)
                .item(&item("edit_paste", "貼上", Some("CmdOrCtrl+V"))?)
                .item(&item("edit_duplicate", "複製一份", Some("CmdOrCtrl+D"))?)
                .item(&item("edit_delete", "刪除", None)?)
                .separator()
                .item(&item("edit_select_all", "選取本頁全部", Some("CmdOrCtrl+A"))?)
                .build()?;
            let view_menu = SubmenuBuilder::new(app, "View")
                .item(&item("view_zoom_in", "放大", Some("CmdOrCtrl+="))?)
                .item(&item("view_zoom_out", "縮小", Some("CmdOrCtrl+-"))?)
                .item(&item("view_fit", "顯示全部", Some("CmdOrCtrl+0"))?)
                .separator()
                .item(&item("view_guides", "顯示／隱藏參考線", Some("CmdOrCtrl+;"))?)
                .item(&item("view_guide_panel", "參考線面板", None)?)
                .item(&item("view_layers", "圖層面板", None)?)
                .item(&item("view_text_library", "文字庫", None)?)
                .item(&item("view_play", "播放／暫停版面", None)?)
                .separator().fullscreen().build()?;
            let ai_menu = SubmenuBuilder::new(app, "AI")
                .item(&item("ai_status", "AI 共編狀態", None)?)
                .item(&item("ai_guide", "開啟 MCP 共編指南", None)?)
                .build()?;
            let window_menu = SubmenuBuilder::new(app, "Window")
                .minimize().maximize().separator().close_window().build()?;
            app.set_menu(MenuBuilder::new(app)
                .items(&[&app_menu, &file_menu, &edit_menu, &view_menu, &ai_menu, &window_menu])
                .build()?)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            let id = event.id().0.clone();
            if id.starts_with("app_") || id.starts_with("file_") || id.starts_with("edit_")
                || id.starts_with("view_") || id.starts_with("ai_") {
                let _ = app.emit("aligned-native-menu", id);
            }
        })
        .invoke_handler(tauri::generate_handler![load_project, save_png, save_text, pack_alignproj,
            pack_template, copy_asset, copy_asset_as,
            make_temp_dir, export_video, make_matte, media_base, trim_video,
            list_system_fonts, list_user_fonts, import_font, open_url,
            agentbridge::agent_bridge_take, agentbridge::agent_bridge_respond,
            model::model_status, model::model_download, model::model_remove, model::model_matte,
            model::model_unload, model::model_cached,
            textlib::textlib_locate, textlib::textlib_list, textlib::textlib_read, textlib::textlib_write,
            textlib::textlib_delete, textlib::textlib_ensure_dir, textlib::textlib_download])
        .run(tauri::generate_context!())
        .expect("tauri 啟動失敗");
}
