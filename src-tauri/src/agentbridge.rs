//! ALIGNED App ↔ local MCP 的檔案式 IPC。
//!
//! MCP 與 Tauri 是兩個獨立行程。App 在系統暫存區建立一個 0700 session 目錄，
//! MCP 以原子 rename 投遞 request，前端透過 Tauri command 取走並回 response。
//! 不開網路埠，外部網站碰不到；session token 防止舊 request 混進新 App 行程。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

static SESSION: OnceLock<Session> = OnceLock::new();

struct Session {
    dir: PathBuf,
    token: String,
}

#[derive(Serialize, Deserialize)]
struct Discovery {
    version: u8,
    pid: u32,
    directory: String,
    token: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct AgentRequest {
    pub id: String,
    pub token: String,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

fn now_nanos() -> Result<u128, String> {
    SystemTime::now().duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos()).map_err(|e| e.to_string())
}

fn discovery_path() -> PathBuf {
    std::env::temp_dir().join("aligned-agent-bridge.json")
}

pub fn init() -> Result<(), String> {
    if SESSION.get().is_some() { return Ok(()); }
    let stamp = now_nanos()?;
    let pid = std::process::id();
    let token = format!("{pid:x}{stamp:x}");
    let dir = std::env::temp_dir().join(format!("aligned-agent-{pid}-{stamp}"));
    fs::create_dir_all(dir.join("requests")).map_err(|e| e.to_string())?;
    fs::create_dir_all(dir.join("responses")).map_err(|e| e.to_string())?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }

    let discovery = discovery_path();
    let body = serde_json::to_vec(&Discovery {
        version: 1, pid, directory: dir.to_string_lossy().into_owned(), token: token.clone(),
    }).map_err(|e| e.to_string())?;
    let temp = discovery.with_extension(format!("tmp-{pid}"));
    fs::write(&temp, body).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temp, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    }
    fs::rename(&temp, &discovery).map_err(|e| e.to_string())?;
    SESSION.set(Session { dir, token }).map_err(|_| "bridge 已初始化".to_string())
}

fn session() -> Result<&'static Session, String> {
    SESSION.get().ok_or_else(|| "agent bridge 尚未初始化".to_string())
}

#[tauri::command]
pub fn agent_bridge_take() -> Result<Option<AgentRequest>, String> {
    let s = session()?;
    let request_dir = s.dir.join("requests");
    let mut entries: Vec<PathBuf> = fs::read_dir(&request_dir).map_err(|e| e.to_string())?
        .filter_map(|e| e.ok().map(|x| x.path()))
        .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("json"))
        .collect();
    entries.sort();
    for path in entries {
        let raw = match fs::read_to_string(&path) { Ok(v) => v, Err(_) => continue };
        let _ = fs::remove_file(&path);
        let request: AgentRequest = match serde_json::from_str(&raw) { Ok(v) => v, Err(_) => continue };
        if request.token == s.token { return Ok(Some(request)); }
    }
    Ok(None)
}

#[tauri::command]
pub fn agent_bridge_respond(id: String, result: Option<Value>, error: Option<String>) -> Result<(), String> {
    let s = session()?;
    if !valid_id(&id) {
        return Err("response id 無效".into());
    }
    let path = s.dir.join("responses").join(format!("{id}.json"));
    let temp = s.dir.join("responses").join(format!("{id}.tmp"));
    fs::write(&temp, serde_json::to_vec(&serde_json::json!({ "result": result, "error": error }))
        .map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    fs::rename(temp, path).map_err(|e| e.to_string())
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

#[cfg(test)]
mod tests {
    #[test]
    fn response_id_guard_is_narrow() {
        assert!(super::valid_id("550e8400-e29b-41d4-a716-446655440000"));
        assert!(!super::valid_id("../project.json"));
        assert!(!super::valid_id(""));
    }
}
