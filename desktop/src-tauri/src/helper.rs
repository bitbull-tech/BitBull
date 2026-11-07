//! The link helper on a Mac: what scripts/bitbull-wsl/link-helper.ps1 is on Windows, built into the
//! app instead of a separate script (macOS has no PowerShell, and a native app gets native dialogs
//! and the Keychain). BitBull's page talks to it on http://localhost:8790 exactly as on Windows:
//!
//!   GET  /status     linked folders (from scripts/bitbull-mac/link.sh list)
//!   GET  /vault-key  the vault key, from the login Keychain, after you press Unlock in a dialog
//!   POST /link       a folder picker opens here; nothing is linked unless you choose one
//!   POST /refresh    copy a linked folder again {name}
//!   POST /unlink     remove a link {name}, after you press Remove in a dialog
//!   POST /open       show a folder of BitBull's data in Finder {path}
//!
//! Who can reach it: programs on this Mac only (it listens on loopback). The agent can't: its
//! container has no route here (the egress proxy refuses local addresses). Other web pages can't:
//! requests must carry BitBull's own Origin. Another program on this Mac could fake that header,
//! so every action that hands something out or changes something needs you in a dialog: picking
//! the folder, pressing Remove, pressing Unlock. The page never sends a path to link.
//!
//! Everything except the dialogs, the Keychain and starting the listeners is plain code that
//! compiles and is tested on any OS.

use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const PORT: u16 = 8790;
const MAX_HEADERS: usize = 16 * 1024;
const MAX_BODY: usize = 64 * 1024;

#[derive(Debug, PartialEq)]
pub struct Request {
    pub method: String,
    pub path: String,
    pub origin: Option<String>,
    pub body: Vec<u8>,
}

/// BitBull's page on this machine: the live port, the test stack's (8788), and the configured one.
pub fn allowed_origins(port: u16) -> Vec<String> {
    let mut ports = vec![8787u16, 8788];
    if !ports.contains(&port) {
        ports.push(port);
    }
    ports.iter().flat_map(|p| [format!("http://localhost:{p}"), format!("http://127.0.0.1:{p}")]).collect()
}

/// Read one HTTP/1.1 request: request line, headers, and a Content-Length body. Anything larger
/// than a helper request has any reason to be is refused rather than buffered.
pub fn read_request(r: &mut impl Read) -> Result<Request, String> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let head_end = loop {
        if let Some(i) = find(&buf, b"\r\n\r\n") {
            break i;
        }
        if buf.len() > MAX_HEADERS {
            return Err("headers too large".into());
        }
        let n = r.read(&mut chunk).map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("connection closed".into());
        }
        buf.extend_from_slice(&chunk[..n]);
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let mut lines = head.split("\r\n");
    let mut first = lines.next().unwrap_or("").split(' ');
    let method = first.next().unwrap_or("").to_string();
    let target = first.next().unwrap_or("").to_string();
    let path = target.split('?').next().unwrap_or("").to_string();
    let mut origin = None;
    let mut len = 0usize;
    for l in lines {
        let Some((k, v)) = l.split_once(':') else { continue };
        match k.trim().to_ascii_lowercase().as_str() {
            "origin" => origin = Some(v.trim().to_string()),
            "content-length" => len = v.trim().parse().map_err(|_| "bad content-length")?,
            _ => {}
        }
    }
    if len > MAX_BODY {
        return Err("body too large".into());
    }
    let mut body = buf[head_end + 4..].to_vec();
    while body.len() < len {
        let n = r.read(&mut chunk).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    body.truncate(len);
    Ok(Request { method, path, origin, body })
}

fn find(h: &[u8], n: &[u8]) -> Option<usize> {
    h.windows(n.len()).position(|w| w == n)
}

/// The response, with CORS headers only for BitBull's own origin (and Chrome's private-network flag).
pub fn response(status: u16, origin: Option<&str>, allowed: &[String], body: Option<&Value>) -> Vec<u8> {
    let reason = match status {
        200 => "OK",
        204 => "No Content",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        _ => "Error",
    };
    let mut out = format!("HTTP/1.1 {status} {reason}\r\nConnection: close\r\nCache-Control: no-store\r\n");
    if let Some(o) = origin.filter(|o| allowed.iter().any(|a| a == o)) {
        out.push_str(&format!(
            "Access-Control-Allow-Origin: {o}\r\nVary: Origin\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: content-type\r\nAccess-Control-Allow-Private-Network: true\r\n"
        ));
    }
    let text = body.map(|b| b.to_string()).unwrap_or_default();
    if status != 204 {
        out.push_str("Content-Type: application/json\r\n");
    }
    out.push_str(&format!("Content-Length: {}\r\n\r\n", text.len()));
    let mut bytes = out.into_bytes();
    bytes.extend_from_slice(text.as_bytes());
    bytes
}

/// A link name as link.sh makes them.
pub fn valid_name(n: &str) -> bool {
    !n.is_empty() && n.len() <= 40 && !n.starts_with('-') && n.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// `link.sh list` -> the shape BitBull's page expects. Every Mac link is a copy, so it is reported
/// as "filtered" (the page offers Refresh for those).
pub fn parse_list(out: &str) -> Vec<Value> {
    out.lines()
        .filter_map(|l| {
            let mut it = l.splitn(4, '\t');
            let (name, state, _mode, path) = (it.next()?, it.next()?, it.next()?, it.next()?);
            if !valid_name(name) {
                return None;
            }
            let state = if state == "mounted" { "mounted" } else { "missing" };
            Some(json!({ "name": name, "state": state, "mode": "filtered", "path": path }))
        })
        .collect()
}

/// The paths link.sh listed as secret (indented lines), for the dialog.
pub fn found_list(out: &str) -> String {
    out.lines().filter(|l| l.starts_with("  ") && !l.starts_with("   ")).take(12).map(str::trim).collect::<Vec<_>>().join("\n")
}

pub fn link_name(out: &str) -> Option<String> {
    out.lines().find_map(|l| l.strip_prefix("BITBULL-LINK-NAME: ")).map(str::trim).filter(|n| valid_name(n)).map(String::from)
}

fn last_lines(out: &str, n: usize) -> String {
    let v: Vec<&str> = out.lines().filter(|l| !l.trim().is_empty()).collect();
    v[v.len().saturating_sub(n)..].join(" ")
}

/// BitBull's data folder on this Mac (scripts/bitbull-mac/common.sh).
pub fn data_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|h| Path::new(&h).join("Library/Application Support/BitBull/data"))
}

/// A folder the page may open in Finder: an existing directory inside BitBull's data folder,
/// after resolving links and `..`, so nothing outside it can be named.
pub fn openable(requested: &str, data: &Path) -> Option<PathBuf> {
    if requested.is_empty() || requested.len() > 1024 || requested.contains('\0') {
        return None;
    }
    let root = data.canonicalize().ok()?;
    let p = Path::new(requested).canonicalize().ok()?;
    (p.starts_with(&root) && p.is_dir()).then_some(p)
}

/// What the helper needs from the app: where the scripts are, and the dialogs. A trait so the
/// routing can be tested without windows.
pub trait Host: Send + Sync {
    fn repo(&self) -> Option<PathBuf>;
    fn port(&self) -> u16;
    fn profile(&self) -> String;
    /// OK/Cancel with custom labels; true = OK
    fn confirm(&self, title: &str, text: &str, ok: &str, cancel: &str) -> bool;
    fn pick_folder(&self, title: &str) -> Option<PathBuf>;
    fn vault_key(&self) -> Result<String, String>;
    fn open_in_finder(&self, p: &Path) -> Result<(), String>;
}

/// Run link.sh with argv (never a command string); returns (exit code, stdout+stderr).
pub fn link_sh(host: &dyn Host, args: &[&str]) -> Result<(i32, String), String> {
    let repo = host.repo().ok_or("Choose the BitBull folder in the launcher first")?;
    let script = repo.join("scripts").join("bitbull-mac").join("link.sh");
    if !script.is_file() {
        return Err(format!("{} not found", script.display()));
    }
    let out = std::process::Command::new("/bin/bash")
        .arg(&script)
        .args(args)
        .env("PATH", crate::stack::MAC_PATH)
        .env("BITBULL_PROFILE", host.profile())
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|e| e.to_string())?;
    let mut text = String::from_utf8_lossy(&out.stdout).to_string();
    text.push_str(&String::from_utf8_lossy(&out.stderr));
    Ok((out.status.code().unwrap_or(-1), text))
}

fn fail(msg: impl Into<String>) -> Value {
    json!({ "ok": false, "message": msg.into() })
}
fn cancelled(msg: &str) -> Value {
    json!({ "ok": false, "cancelled": true, "message": msg })
}

fn do_link(host: &dyn Host) -> Result<Value, String> {
    let Some(folder) = host.pick_folder("BitBull: choose a folder for the agent to READ (it gets a read-only copy). Cancel to link nothing.") else {
        return Ok(cancelled("No folder chosen."));
    };
    let path = folder.to_str().ok_or("That folder's name can't be passed on")?.to_string();
    let (mut code, mut out) = link_sh(host, &["add", &path])?;
    if code == 4 {
        let found = found_list(&out);
        let ok = host.confirm(
            "BitBull: link this folder?",
            &format!("This is BitBull's own repo. It can be linked as a read-only COPY that leaves out its .env, data folder and anything else that looks secret:\n\n{found}\n\nThe agent never sees those files. Press Refresh in BitBull (Settings › Folders) to update the copy."),
            "Link a copy without them",
            "Cancel",
        );
        if !ok {
            return Ok(cancelled("Not linked."));
        }
        (code, out) = link_sh(host, &["add", &path, "--hide"])?;
    } else if code == 3 {
        let found = found_list(&out);
        let hide = host.confirm(
            "BitBull: link this folder?",
            &format!("This folder holds files that look like keys, passwords or wallets (or couldn't be checked):\n\n{found}\n\nRecommended: link a read-only COPY without these files. The agent never sees them."),
            "Link a copy without them",
            "More choices…",
        );
        if hide {
            (code, out) = link_sh(host, &["add", &path, "--hide"])?;
        } else if host.confirm(
            "BitBull: copy the keys too?",
            "Link everything, including the files listed before? The agent could read them and send them to its model.",
            "Link everything",
            "Cancel",
        ) {
            (code, out) = link_sh(host, &["add", &path, "--allow-secrets"])?;
        } else {
            return Ok(cancelled("Not linked."));
        }
    }
    if code != 0 {
        return Ok(fail(last_lines(&out, 3)));
    }
    Ok(json!({ "ok": true, "name": link_name(&out), "path": path, "message": format!("Linked {path}") }))
}

fn body_field(req: &Request, key: &str) -> String {
    serde_json::from_slice::<Value>(&req.body).ok().and_then(|v| v.get(key).and_then(|x| x.as_str()).map(String::from)).unwrap_or_default()
}

/// One request in, one (status, body) out.
pub fn route(host: &dyn Host, req: &Request) -> (u16, Value) {
    let allowed = allowed_origins(host.port());
    if let Some(o) = &req.origin {
        if !allowed.contains(o) {
            return (403, fail("origin not allowed"));
        }
    }
    if req.method == "OPTIONS" {
        return (204, Value::Null);
    }
    let r = (|| -> Result<(u16, Value), String> {
        match (req.method.as_str(), req.path.as_str()) {
            ("GET", "/status") => {
                let (_, out) = link_sh(host, &["list"])?;
                Ok((200, json!({ "ok": true, "links": parse_list(&out) })))
            }
            ("GET", "/vault-key") => {
                if req.origin.is_none() {
                    return Ok((403, fail("BitBull's page only")));
                }
                let ok = host.confirm(
                    "BitBull: unlock the vault?",
                    "BitBull wants the vault key to unlock your stored keys.\n\nOnly press Unlock if you just clicked Unlock in BitBull. This key decrypts every stored key, so nothing else should ever ask for it.",
                    "Unlock",
                    "Cancel",
                );
                if !ok {
                    return Ok((200, cancelled("Not unlocked.")));
                }
                Ok((200, json!({ "ok": true, "key": host.vault_key()? })))
            }
            (m, _) if m != "POST" || req.origin.is_none() => Ok((405, fail("POST from BitBull's page only"))),
            (_, "/link") => Ok((200, do_link(host)?)),
            (_, "/refresh") => {
                let name = body_field(req, "name");
                if !valid_name(&name) {
                    return Ok((200, fail("bad name")));
                }
                let (code, out) = link_sh(host, &["refresh", &name])?;
                Ok((200, if code == 0 { json!({ "ok": true, "message": format!("Refreshed {name}") }) } else { fail(last_lines(&out, 2)) }))
            }
            (_, "/unlink") => {
                let name = body_field(req, "name");
                if !valid_name(&name) {
                    return Ok((200, fail("bad name")));
                }
                // asked here, on this Mac: the Origin check stops web pages, not other programs
                if !host.confirm(
                    "BitBull: remove link?",
                    &format!("Remove the BitBull link '{name}'? BitBull can no longer read it. Your folder isn't touched."),
                    "Remove",
                    "Cancel",
                ) {
                    return Ok((200, cancelled("Not removed.")));
                }
                let (code, out) = link_sh(host, &["remove", &name])?;
                Ok((200, if code == 0 { json!({ "ok": true, "message": format!("Removed {name}") }) } else { fail(last_lines(&out, 2)) }))
            }
            (_, "/open") => {
                let data = data_dir().ok_or("no home folder")?;
                let Some(p) = openable(&body_field(req, "path"), &data) else {
                    return Ok((200, fail("That path can't be opened from here (only folders under BitBull's data folder).")));
                };
                host.open_in_finder(&p)?;
                Ok((200, json!({ "ok": true, "message": format!("Opened {}", p.display()) })))
            }
            _ => Ok((404, fail("not found"))),
        }
    })();
    r.unwrap_or_else(|e| (500, fail(e)))
}

fn handle(host: &dyn Host, mut s: TcpStream) {
    let _ = s.set_read_timeout(Some(Duration::from_secs(10)));
    let req = match read_request(&mut s) {
        Ok(r) => r,
        Err(_) => return,
    };
    let (status, body) = route(host, &req);
    let allowed = allowed_origins(host.port());
    let body = (status != 204).then_some(&body);
    let _ = s.write_all(&response(status, req.origin.as_deref(), &allowed, body));
}

/// Listen on both loopback addresses (browsers resolve localhost to either), one thread per
/// connection so a dialog waiting for you doesn't stall /status. If the port is taken (another
/// copy of the app), this one simply doesn't serve.
pub fn serve(host: std::sync::Arc<dyn Host>) {
    for addr in [format!("127.0.0.1:{PORT}"), format!("[::1]:{PORT}")] {
        let Ok(l) = TcpListener::bind(&addr) else { continue };
        let host = host.clone();
        std::thread::spawn(move || {
            for s in l.incoming().flatten() {
                let host = host.clone();
                std::thread::spawn(move || handle(&*host, s));
            }
        });
    }
}

/// 32 random bytes as hex, made once and kept in the login Keychain for this user. The item
/// belongs to this app, so another program asking for it gets the system's own prompt.
#[cfg(target_os = "macos")]
pub fn keychain_vault_key() -> Result<String, String> {
    use security_framework::passwords::{get_generic_password, set_generic_password};
    const SERVICE: &str = "io.bitbull.vault";
    const ACCOUNT: &str = "vault-key";
    if let Ok(v) = get_generic_password(SERVICE, ACCOUNT) {
        let k = String::from_utf8_lossy(&v).trim().to_string();
        if k.len() == 64 && k.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Ok(k.to_ascii_lowercase());
        }
        return Err("the vault key in the Keychain is damaged".into());
    }
    let mut raw = [0u8; 32];
    std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut raw)).map_err(|e| e.to_string())?;
    let k: String = raw.iter().map(|b| format!("{b:02x}")).collect();
    set_generic_password(SERVICE, ACCOUNT, k.as_bytes()).map_err(|e| format!("could not save the vault key in the Keychain: {e}"))?;
    Ok(k)
}

#[cfg(not(target_os = "macos"))]
pub fn keychain_vault_key() -> Result<String, String> {
    Err("the built-in link helper only runs on macOS".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct Fake {
        repo: Option<PathBuf>,
        answers: Mutex<Vec<bool>>,
        asked: Mutex<Vec<String>>,
    }
    impl Host for Fake {
        fn repo(&self) -> Option<PathBuf> {
            self.repo.clone()
        }
        fn port(&self) -> u16 {
            8787
        }
        fn profile(&self) -> String {
            "bitbull".into()
        }
        fn confirm(&self, title: &str, _: &str, _: &str, _: &str) -> bool {
            self.asked.lock().unwrap().push(title.into());
            self.answers.lock().unwrap().pop().unwrap_or(false)
        }
        fn pick_folder(&self, _: &str) -> Option<PathBuf> {
            None
        }
        fn vault_key(&self) -> Result<String, String> {
            Ok("ab".repeat(32))
        }
        fn open_in_finder(&self, _: &Path) -> Result<(), String> {
            Ok(())
        }
    }
    fn fake(answers: Vec<bool>) -> Fake {
        Fake { repo: None, answers: Mutex::new(answers), asked: Mutex::new(vec![]) }
    }
    fn req(method: &str, path: &str, origin: Option<&str>, body: &str) -> Request {
        Request { method: method.into(), path: path.into(), origin: origin.map(String::from), body: body.as_bytes().to_vec() }
    }

    #[test]
    fn parses_a_request_with_body() {
        let raw = b"POST /unlink?x=1 HTTP/1.1\r\nHost: localhost:8790\r\nOrigin: http://localhost:8787\r\nContent-Length: 15\r\n\r\n{\"name\":\"docs\"}";
        let r = read_request(&mut &raw[..]).unwrap();
        assert_eq!(r.method, "POST");
        assert_eq!(r.path, "/unlink");
        assert_eq!(r.origin.as_deref(), Some("http://localhost:8787"));
        assert_eq!(r.body, b"{\"name\":\"docs\"}");
        let big = format!("POST / HTTP/1.1\r\nContent-Length: {}\r\n\r\n", MAX_BODY + 1);
        assert!(read_request(&mut big.as_bytes()).is_err());
    }

    #[test]
    fn origins_and_methods() {
        let h = fake(vec![]);
        assert_eq!(route(&h, &req("GET", "/status", Some("https://evil.example"), "")).0, 403);
        assert_eq!(route(&h, &req("OPTIONS", "/link", Some("http://localhost:8787"), "")).0, 204);
        // no Origin: a local tool may read /status, but nothing that hands out or changes anything
        assert_eq!(route(&h, &req("GET", "/vault-key", None, "")).0, 403);
        assert_eq!(route(&h, &req("POST", "/link", None, "")).0, 405);
        assert_eq!(route(&h, &req("GET", "/link", Some("http://127.0.0.1:8787"), "")).0, 405);
        assert_eq!(route(&h, &req("POST", "/nope", Some("http://127.0.0.1:8788"), "")).0, 404);
    }

    #[test]
    fn vault_key_needs_a_yes() {
        let h = fake(vec![false]);
        let (code, body) = route(&h, &req("GET", "/vault-key", Some("http://localhost:8787"), ""));
        assert_eq!(code, 200);
        assert_eq!(body["ok"], false);
        assert!(body.get("key").is_none());
        let h = fake(vec![true]);
        let (_, body) = route(&h, &req("GET", "/vault-key", Some("http://localhost:8787"), ""));
        assert_eq!(body["key"].as_str().unwrap().len(), 64);
    }

    #[test]
    fn unlink_asks_and_names_are_checked() {
        let h = fake(vec![false]);
        let (_, body) = route(&h, &req("POST", "/unlink", Some("http://localhost:8787"), r#"{"name":"docs"}"#));
        assert_eq!(body["cancelled"], true);
        assert_eq!(h.asked.lock().unwrap().len(), 1);
        let h = fake(vec![true]);
        let (_, body) = route(&h, &req("POST", "/unlink", Some("http://localhost:8787"), r#"{"name":"../x"}"#));
        assert_eq!(body["message"], "bad name");
        assert!(h.asked.lock().unwrap().is_empty());
        let (_, body) = route(&h, &req("POST", "/link", Some("http://localhost:8787"), ""));
        assert_eq!(body["cancelled"], true); // no folder picked
    }

    #[test]
    fn link_sh_output() {
        let out = "==> Checking /x\nThese look like keys:\n  .env\n  .ssh/id_rsa\n... and more\n";
        assert_eq!(found_list(out), ".env\n.ssh/id_rsa");
        assert_eq!(link_name("x\nBITBULL-LINK-NAME: docs-2\n").as_deref(), Some("docs-2"));
        assert_eq!(link_name("BITBULL-LINK-NAME: ../etc\n"), None);
        let l = parse_list("docs\tmounted\tall\t/Users/t/Docs\nbad name\tmounted\tall\t/x\nrepo\tmissing\tfiltered\t/Users/t/My Repo\n");
        assert_eq!(l.len(), 2);
        assert_eq!(l[0]["mode"], "filtered");
        assert_eq!(l[1]["path"], "/Users/t/My Repo");
    }

    #[test]
    fn only_folders_inside_the_data_folder_open() {
        let base = std::env::temp_dir().join(format!("bitbull-helper-open-{}", std::process::id()));
        let data = base.join("data");
        std::fs::create_dir_all(data.join("workspace")).unwrap();
        std::fs::write(data.join("file.txt"), "x").unwrap();
        std::fs::create_dir_all(base.join("outside")).unwrap();
        assert!(openable(data.join("workspace").to_str().unwrap(), &data).is_some());
        assert!(openable(&format!("{}/workspace/../../outside", data.display()), &data).is_none());
        assert!(openable(data.join("file.txt").to_str().unwrap(), &data).is_none());
        assert!(openable(base.join("outside").to_str().unwrap(), &data).is_none());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(base.join("outside"), data.join("sneaky")).unwrap();
            assert!(openable(data.join("sneaky").to_str().unwrap(), &data).is_none());
        }
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn responses_carry_cors_only_for_bitbull() {
        let allowed = allowed_origins(8787);
        let ok = String::from_utf8(response(200, Some("http://localhost:8787"), &allowed, Some(&json!({"ok": true})))).unwrap();
        assert!(ok.contains("Access-Control-Allow-Origin: http://localhost:8787"));
        assert!(ok.ends_with("{\"ok\":true}"));
        let no = String::from_utf8(response(403, Some("https://evil.example"), &allowed, Some(&json!({})))).unwrap();
        assert!(!no.contains("Access-Control-Allow-Origin"));
    }
}
