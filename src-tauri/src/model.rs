//! 進階去背模型（BiRefNet lite fp16）。
//!
//! 為什麼是這個形狀：
//! * **引擎編進主程式、只下載模型檔**。下載下來的執行檔沒有簽章，在 macOS 上根本跑不起來；
//!   而 `ort` 是靜態連結的（`otool -L` 只剩系統函式庫），所以整包還是單一二進位、單一簽章。
//! * **模型是選配不是必需**。內建 Vision 永遠是預設，一裝就能用；這顆是升級。
//!   兩邊誰都不是全勝——實測小高那組三個人走路帶殘影的街拍，只有內建抓得到，
//!   BiRefNet 完全沒看到人；但頭髮邊緣 BiRefNet 大勝。
//! * **影像的解碼與縮放留在前端做**。前端本來就有解好的圖，交過來的是 1024×1024 的
//!   原始 RGB 位元組——Rust 這邊就不必背一整套影像格式支援（webp／heic 那些）。
//!
//! ⚠️ BiRefNet 吐的是 **logit 不是機率**（實測 −23…20），一定要過 sigmoid。
//! 用 min-max 正規化是錯的：一張根本沒有主體的圖會被硬拉出一個假主體。

use base64::Engine;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;
use tauri::{Emitter, Manager};

/// 模型輸入邊長。BiRefNet lite 是固定 1024 見方。
pub const SIZE: usize = 1024;

/// 下載來源與指紋。指紋是**必驗**的：半途斷線寫出來的殘檔一樣是個檔案，
/// 不驗就會拿一個壞模型去跑，錯得莫名其妙。
/// （HuggingFace 的 `x-linked-etag` 就是檔案的 SHA-256，這串是照著它對過的。）
pub const URL: &str =
    "https://huggingface.co/onnx-community/BiRefNet_lite-ONNX/resolve/main/onnx/model_fp16.onnx";
pub const SHA256: &str = "d39b897ceb16ae654c1731f3dba0cf9b368d9cae74b5a57459b455cc8bfec402";
pub const BYTES: u64 = 114_538_221;

fn model_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("models");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("birefnet_lite_fp16.onnx"))
}

/// CoreML 編好的模型放哪。與模型檔同一層，移除模型時一起清掉。
#[cfg(target_os = "macos")]
fn cache_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("models/coreml");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// 模型狀態：`"none"` ／ `"<位元組數>"`。前端只需要知道在不在、多大。
#[tauri::command]
pub fn model_status(app: tauri::AppHandle) -> Result<String, String> {
    let p = model_path(&app)?;
    Ok(match fs::metadata(&p) {
        Ok(m) if m.len() == BYTES => m.len().to_string(),
        _ => "none".into(),
    })
}

/// CoreML 編好的版本在不在。前端用它決定要不要先講「第一次要編譯，會等一下」。
/// 非 macOS 一律回 true（沒有這個編譯步驟，不必嚇人）。
#[tauri::command]
pub fn model_cached(#[allow(unused_variables)] app: tauri::AppHandle) -> bool {
    #[cfg(target_os = "macos")]
    {
        return cache_dir(&app)
            .ok()
            .and_then(|d| fs::read_dir(d).ok())
            .is_some_and(|mut it| it.next().is_some());
    }
    #[cfg(not(target_os = "macos"))]
    true
}

#[tauri::command]
pub fn model_remove(app: tauri::AppHandle) -> Result<(), String> {
    model_unload()?;   // Windows 上檔案還被開著會刪不掉
    let p = model_path(&app)?;
    if p.exists() {
        fs::remove_file(&p).map_err(|e| e.to_string())?;
    }
    // 編好的 CoreML 快取跟著走——留著只是佔空間，模型都沒了它也對不上
    #[cfg(target_os = "macos")]
    if let Ok(c) = cache_dir(&app) {
        let _ = fs::remove_dir_all(&c);
    }
    Ok(())
}

/// 下載模型。先寫 `.part` 再驗指紋才改名——中途斷線不會留下一個看起來很正常的壞模型。
/// 進度用事件推給前端（`matte-model-progress`，值是 0–100）。
#[tauri::command(async)]
pub fn model_download(app: tauri::AppHandle) -> Result<(), String> {
    let dest = model_path(&app)?;
    let part = dest.with_extension("part");

    let resp = ureq::get(URL).call().map_err(|e| format!("連不上下載來源：{e}"))?;
    let total = resp
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(BYTES);
    let mut body = resp.into_body().into_reader();

    let mut f = fs::File::create(&part).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 18];
    let mut done: u64 = 0;
    let mut last = 0i64;
    loop {
        let n = body.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        f.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        hasher.update(&buf[..n]);
        done += n as u64;
        let pct = (done * 100 / total.max(1)) as i64;
        if pct != last {
            last = pct;
            let _ = app.emit("matte-model-progress", pct);
        }
    }
    drop(f);

    let got = format!("{:x}", hasher.finalize());
    if got != SHA256 {
        let _ = fs::remove_file(&part);
        return Err("下載到的模型指紋不對，已丟掉".into());
    }
    fs::rename(&part, &dest).map_err(|e| e.to_string())?;
    Ok(())
}

/// 載好的 session 留著重用。每次重建要 1.3 秒，那是「按一次去背等幾秒」裡很大一塊。
/// 代價是常駐記憶體，所以「移除模型」與「切回內建」都會把它放掉（見 `model_unload`）。
static SESSION: std::sync::Mutex<Option<ort::session::Session>> = std::sync::Mutex::new(None);

/// 放掉常駐的 session。切回內建或移除模型時呼叫——不放的話那 100MB 會一直佔著。
#[tauri::command]
pub fn model_unload() -> Result<(), String> {
    *SESSION.lock().map_err(|e| e.to_string())? = None;
    Ok(())
}

/// 跑一次模型。`rgb` ＝ base64 的 1024×1024×3 原始位元組；回 base64 的 1024×1024 灰階。
#[tauri::command(async)]
pub fn model_matte(app: tauri::AppHandle, rgb: String) -> Result<String, String> {
    let p = model_path(&app)?;
    if !p.exists() {
        return Err("模型還沒下載".into());
    }
    let raw = base64::engine::general_purpose::STANDARD
        .decode(rgb)
        .map_err(|e| e.to_string())?;
    if raw.len() != SIZE * SIZE * 3 {
        return Err(format!("影像大小不對：{} 位元組", raw.len()));
    }

    let mut guard = SESSION.lock().map_err(|e| e.to_string())?;
    if guard.is_none() {
        let mut b = ort::session::Session::builder().map_err(|e| e.to_string())?;
        #[cfg(target_os = "macos")]
        {
            // ⚠️ **一定要給快取目錄**。不給的話 CoreML 每次建 session 都會把整顆模型
            // 重編一次給神經引擎——`ANECompilerService` 燒滿一整顆核心好幾分鐘，
            // 期間畫面完全沒有動靜，看起來就是「點了去背沒反應」（2026-08-30 實測）。
            // 給了之後只有第一次要編，之後每次開 App 直接讀編好的。
            // 目錄放在模型旁邊：移除模型時整包一起清（見 `model_remove`）。
            let cache = cache_dir(&app)?;
            b = b
                .with_execution_providers([
                    ort::ep::CoreML::default()
                        .with_model_cache_dir(cache.to_string_lossy())
                        .build(),
                ])
                .map_err(|e| e.to_string())?;
        }
        #[cfg(target_os = "windows")]
        {
            b = b
                .with_execution_providers([ort::ep::DirectML::default().build()])
                .map_err(|e| e.to_string())?;
        }
        *guard = Some(b.commit_from_file(&p).map_err(|e| e.to_string())?);
    }
    let sess = guard.as_mut().expect("剛剛才放進去");

    // ImageNet 正規化，通道優先（NCHW）
    const MEAN: [f32; 3] = [0.485, 0.456, 0.406];
    const STD: [f32; 3] = [0.229, 0.224, 0.225];
    let plane = SIZE * SIZE;
    let mut input = vec![0f32; 3 * plane];
    for i in 0..plane {
        for c in 0..3 {
            input[c * plane + i] = (raw[i * 3 + c] as f32 / 255.0 - MEAN[c]) / STD[c];
        }
    }
    let t = ort::value::Tensor::from_array(([1usize, 3, SIZE, SIZE], input))
        .map_err(|e| e.to_string())?;
    let outs = sess.run(ort::inputs![t]).map_err(|e| e.to_string())?;
    let last = outs.len() - 1;
    let (_, data) = outs[last]
        .try_extract_tensor::<f32>()
        .map_err(|e| e.to_string())?;

    let mut gray = vec![0u8; plane];
    for i in 0..plane {
        gray[i] = (1.0 / (1.0 + (-data[i]).exp()) * 255.0) as u8;
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(gray))
}
