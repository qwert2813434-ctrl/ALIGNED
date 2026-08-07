use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

static ROOTS: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());
static BASE: OnceLock<String> = OnceLock::new();

/// 允許服務的目錄（canonical）。load_project／copy_asset 時登記。
pub fn register_root(dir: &str) {
    if let Ok(p) = PathBuf::from(dir).canonicalize() {
        let mut roots = ROOTS.lock().unwrap();
        if !roots.contains(&p) { roots.push(p); }
    }
}

/// 回 `http://127.0.0.1:<port>/<token>`。第一次呼叫才起伺服器。
pub fn base() -> String {
    BASE.get_or_init(|| {
        let token = fs_token();
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind 127.0.0.1 失敗");
        let port = listener.local_addr().unwrap().port();
        let t = token.clone();
        std::thread::spawn(move || {
            for conn in listener.incoming().flatten() {
                let t = t.clone();
                std::thread::spawn(move || { let _ = serve(conn, &t); });
            }
        });
        format!("http://127.0.0.1:{port}/{token}")
    }).clone()
}

fn fs_token() -> String {
    let mut b = [0u8; 16];
    std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut b)).expect("urandom");
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v); i += 3; continue;
            }
        }
        out.push(bytes[i]); i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn deny(mut s: TcpStream, code: &str) -> std::io::Result<()> {
    s.write_all(format!("HTTP/1.1 {code}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n").as_bytes())
}

fn serve(stream: TcpStream, token: &str) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("").to_string();
    // 讀完標頭，只留 Range
    let mut range: Option<String> = None;
    loop {
        let mut h = String::new();
        if reader.read_line(&mut h)? == 0 || h == "\r\n" || h == "\n" { break; }
        if let Some(v) = h.to_ascii_lowercase().strip_prefix("range:") {
            range = Some(v.trim().to_string());
        }
    }
    if method != "GET" && method != "HEAD" { return deny(stream, "405 Method Not Allowed"); }
    let Some(rest) = target.strip_prefix(&format!("/{token}/")) else {
        return deny(stream, "403 Forbidden");
    };
    let path = percent_decode(rest);
    let Ok(canon) = PathBuf::from(&path).canonicalize() else {
        return deny(stream, "404 Not Found");
    };
    if !ROOTS.lock().unwrap().iter().any(|r| canon.starts_with(r)) {
        return deny(stream, "403 Forbidden");
    }
    let mut file = std::fs::File::open(&canon)?;
    let len = file.metadata()?.len();
    let mime = match canon.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("mov") => "video/quicktime",
        Some("mp4") | Some("m4v") => "video/mp4",
        _ => "application/octet-stream",
    };

    // Range 只認單段 bytes=a-b／a-／-n；沒有或看不懂就回整檔（合法退路）
    let span = range.as_deref().and_then(|r| parse_range(r, len));
    let (status, start, end) = match span {
        Some((a, b)) if a <= b && a < len => ("206 Partial Content", a, b.min(len - 1)),
        Some(_) => {
            let mut s = stream;
            return s.write_all(format!(
                "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{len}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
            ).as_bytes());
        }
        None => ("200 OK", 0, len.saturating_sub(1)),
    };
    let nbytes = if len == 0 { 0 } else { end - start + 1 };

    let mut head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {mime}\r\nAccept-Ranges: bytes\r\nContent-Length: {nbytes}\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n"
    );
    if status.starts_with("206") {
        head.push_str(&format!("Content-Range: bytes {start}-{end}/{len}\r\n"));
    }
    head.push_str("\r\n");
    let mut s = stream;
    s.write_all(head.as_bytes())?;
    if method == "HEAD" || nbytes == 0 { return Ok(()); }

    file.seek(SeekFrom::Start(start))?;
    let mut left = nbytes;
    let mut buf = vec![0u8; 256 * 1024];
    while left > 0 {
        let want = left.min(buf.len() as u64) as usize;
        let n = file.read(&mut buf[..want])?;
        if n == 0 { break; }
        s.write_all(&buf[..n])?;
        left -= n as u64;
    }
    Ok(())
}

/// `bytes=a-b`／`bytes=a-`／`bytes=-n` → (start, end)。多段不支援（回 None＝整檔）。
fn parse_range(r: &str, len: u64) -> Option<(u64, u64)> {
    let spec = r.strip_prefix("bytes=")?.trim();
    if spec.contains(',') || len == 0 { return None; }
    let (a, b) = spec.split_once('-')?;
    match (a.trim(), b.trim()) {
        ("", n) => {
            let n: u64 = n.parse().ok()?;
            if n == 0 { return None; }
            Some((len.saturating_sub(n), len - 1))
        }
        (a, "") => Some((a.parse().ok()?, len - 1)),
        (a, b) => Some((a.parse().ok()?, b.parse().ok()?)),
    }
}
