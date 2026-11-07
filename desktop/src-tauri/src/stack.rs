//! Everything the desktop app does that is not window/tray plumbing: find the repo, check the
//! machine (WSL, the `bitbull` distro, Docker, the stack), run the existing PowerShell scripts, read
//! logs. No Tauri types in here, so it compiles and is tested on any OS; the process-running
//! parts only do anything useful on Windows.
//!
//! Rules carried over from the scripts: child processes get argv arrays, never a command
//! string built from data; the only values that come from outside (repo path, distro name)
//! are validated before use; the app never reads or holds a model key. The one secret it
//! touches is `APP_TOKEN` from the repo's `.env`, read on demand to sign the webview in and
//! never written anywhere else.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

/// Saved in the app's config dir as `bitbull-desktop.json`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Settings {
    /// The BitBull checkout on this PC (where `scripts/bitbull-wsl/*.ps1` live).
    pub repo: Option<PathBuf>,
    /// WSL distro that runs the stack (`setup.ps1 -Distro`).
    pub distro: String,
    /// Port of the live stack on 127.0.0.1.
    pub port: u16,
    /// Sign the BitBull page in with `APP_TOKEN` from `<repo>\.env` instead of pasting it.
    pub auto_token: bool,
    /// Open the BitBull page as soon as the stack answers, instead of staying on the launcher.
    pub open_when_ready: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { repo: None, distro: "bitbull".into(), port: 8787, auto_token: true, open_when_ready: true }
    }
}

impl Settings {
    pub fn load(file: &Path) -> Settings {
        std::fs::read_to_string(file)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }
    pub fn save(&self, file: &Path) -> Result<(), String> {
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        std::fs::write(file, serde_json::to_string_pretty(self).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
    }
    pub fn bitbull_url(&self) -> String {
        format!("http://localhost:{}/", self.port)
    }
}

/// A distro name as `wsl -d` accepts it; also used in `--cd` paths, so keep it to plain characters.
pub fn valid_distro(name: &str) -> bool {
    !name.is_empty() && name.len() <= 40 && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

/// Does this folder look like the BitBull repo?
pub fn is_repo(dir: &Path) -> bool {
    dir.join("scripts").join("bitbull-wsl").join("start.ps1").is_file() && dir.join("docker-compose.yml").is_file()
}

/// Where the repo probably is: next to the exe (portable layout), then the usual places.
pub fn guess_repo(exe_dir: Option<&Path>) -> Option<PathBuf> {
    let mut cands: Vec<PathBuf> = Vec::new();
    if let Some(d) = exe_dir {
        // desktop/src-tauri/target/release/bitbull-desktop.exe -> repo root
        let mut p = d.to_path_buf();
        for _ in 0..5 {
            cands.push(p.clone());
            match p.parent() {
                Some(x) => p = x.to_path_buf(),
                None => break,
            }
        }
    }
    for drive in ["D:", "C:", "E:"] {
        cands.push(PathBuf::from(format!("{drive}\\github\\BitBull")));
    }
    if let Some(home) = std::env::var_os("USERPROFILE") {
        cands.push(Path::new(&home).join("github").join("BitBull"));
        cands.push(Path::new(&home).join("BitBull"));
    }
    cands.into_iter().find(|c| is_repo(c))
}

/// The `APP_TOKEN=` line of `<repo>/.env`, if any. Quotes stripped, CRLF tolerated.
pub fn app_token(repo: &Path) -> Option<String> {
    let text = std::fs::read_to_string(repo.join(".env")).ok()?;
    parse_env_value(&text, "APP_TOKEN")
}

pub fn parse_env_value(text: &str, key: &str) -> Option<String> {
    for raw in text.lines() {
        let line = raw.trim();
        if line.starts_with('#') {
            continue;
        }
        let Some((k, v)) = line.split_once('=') else { continue };
        if k.trim() != key {
            continue;
        }
        let v = v.trim().trim_matches('"').trim_matches('\'').trim();
        return if v.is_empty() { None } else { Some(v.to_string()) };
    }
    None
}

// ---------- the machine ----------

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Check {
    pub ok: bool,
    pub detail: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Status {
    pub repo: Option<String>,
    pub repo_ok: bool,
    pub env_ok: bool,
    pub wsl: Check,
    pub distro: Check,
    pub docker: Check,
    pub containers: Check,
    /// BitBull answered /api/health on the configured port
    pub healthy: bool,
    pub url: String,
    /// commit the running containers were built from (deploy.ps1 records it; the image has no .git)
    pub built: Option<String>,
    /// HEAD of the checkout this launcher points at, to compare against `built`
    pub checkout: Option<String>,
}

/// One pass over everything the launcher shows. Each probe is short (a few seconds at most)
/// and independent, so one failing never hides the others.
pub fn status(s: &Settings) -> Status {
    let mut st = Status { url: s.bitbull_url(), ..Default::default() };
    if let Some(repo) = &s.repo {
        st.repo = Some(repo.display().to_string());
        st.repo_ok = is_repo(repo);
        st.env_ok = repo.join(".env").is_file();
    }
    let (ok, body) = health_body(s.port);
    st.healthy = ok;
    st.built = body.as_deref().and_then(build_commit);
    st.checkout = s.repo.as_deref().and_then(head_commit);
    if !cfg!(windows) {
        let na = Check { ok: false, detail: "only checked on Windows".into() };
        st.wsl = na.clone();
        st.distro = na.clone();
        st.docker = na.clone();
        st.containers = na;
        return st;
    }
    st.wsl = match run_capture("wsl.exe", &["--status"], Duration::from_secs(8)) {
        Ok((0, out)) => Check { ok: true, detail: first_line(&out, "installed") },
        Ok((_, out)) => Check { ok: false, detail: first_line(&out, "wsl --status failed") },
        Err(e) => Check { ok: false, detail: format!("WSL not found ({e})") },
    };
    if st.wsl.ok {
        st.distro = match run_capture("wsl.exe", &["-l", "-q"], Duration::from_secs(8)) {
            Ok((_, out)) => {
                let names = parse_distro_list(&out);
                if names.iter().any(|n| n == &s.distro) {
                    Check { ok: true, detail: format!("distro '{}' exists", s.distro) }
                } else {
                    Check { ok: false, detail: format!("no '{}' distro yet (installed: {})", s.distro, if names.is_empty() { "none".into() } else { names.join(", ") }) }
                }
            }
            Err(e) => Check { ok: false, detail: e },
        };
    }
    if st.distro.ok {
        st.docker = match run_capture("wsl.exe", &["-d", &s.distro, "--exec", "docker", "--version"], Duration::from_secs(20)) {
            Ok((0, out)) => Check { ok: true, detail: first_line(&out, "docker present") },
            Ok((_, out)) => Check { ok: false, detail: first_line(&out, "docker not answering in the distro (is it running?)") },
            Err(e) => Check { ok: false, detail: e },
        };
    }
    if st.docker.ok {
        st.containers = match run_capture(
            "wsl.exe",
            &["-d", &s.distro, "--cd", "~/BitBull", "--exec", "docker", "compose", "ps", "-a", "--format", "{{.Name}} {{.State}}"],
            Duration::from_secs(20),
        ) {
            Ok((0, out)) => summarise_compose_ps(&out),
            Ok((_, out)) => Check { ok: false, detail: first_line(&out, "compose ps failed (not deployed yet?)") },
            Err(e) => Check { ok: false, detail: e },
        };
    }
    st
}

/// The `commit` (and dirty flag) out of /api/health's JSON, without pulling in a JSON parser
/// for one field. Returns e.g. "a1b2c3d on main" or "a1b2c3d on main (uncommitted)".
pub fn build_commit(body: &str) -> Option<String> {
    let field = |k: &str| -> Option<String> {
        let at = body.find(&format!("\"{k}\""))?;
        let rest = &body[at + k.len() + 2..];
        let start = rest.find('"')? + 1;
        let end = rest[start..].find('"')? + start;
        let v = &rest[start..end];
        if v.is_empty() || v.len() > 80 { None } else { Some(v.to_string()) }
    };
    let commit = field("commit")?;
    let branch = field("branch").unwrap_or_default();
    let dirty = body.contains("\"dirty\":true");
    let mut out = commit;
    if !branch.is_empty() { out = format!("{out} on {branch}"); }
    if dirty { out.push_str(" (uncommitted)"); }
    Some(out)
}

/// Short HEAD of the checkout, so the launcher can say whether a deploy is still current.
pub fn head_commit(repo: &Path) -> Option<String> {
    let dir = repo.to_str()?;
    let (code, out) = run_capture("git", &["-C", dir, "rev-parse", "--short", "HEAD"], Duration::from_secs(4)).ok()?;
    if code != 0 { return None }
    let sha = out.trim().lines().next()?.trim().to_string();
    if sha.is_empty() || sha.len() > 40 { None } else { Some(sha) }
}

/// GET /api/health on the local port, keeping the body. Plain std TCP so there is no HTTP client
/// to keep current.
pub fn health_body(port: u16) -> (bool, Option<String>) {
    use std::io::{Read, Write};
    use std::net::TcpStream;
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut s) = TcpStream::connect_timeout(&addr, Duration::from_millis(800)) else { return (false, None) };
    let _ = s.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = s.set_write_timeout(Some(Duration::from_secs(2)));
    if s.write_all(format!("GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n").as_bytes()).is_err() {
        return (false, None);
    }
    let mut buf = Vec::new();
    let _ = s.read_to_end(&mut buf);
    let text = String::from_utf8_lossy(&buf);
    let ok = text.starts_with("HTTP/1.1 200") || text.starts_with("HTTP/1.0 200");
    let body = text.split("\r\n\r\n").nth(1).map(|b| b.to_string());
    (ok, if ok { body } else { None })
}

pub fn parse_distro_list(out: &str) -> Vec<String> {
    out.lines().map(|l| l.trim().trim_matches('\0').to_string()).filter(|l| !l.is_empty()).collect()
}

pub fn summarise_compose_ps(out: &str) -> Check {
    let rows: Vec<(&str, &str)> = out
        .lines()
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            Some((it.next()?, it.next().unwrap_or("?")))
        })
        .collect();
    if rows.is_empty() {
        return Check { ok: false, detail: "no containers yet (run Deploy)".into() };
    }
    let running = rows.iter().filter(|(_, st)| *st == "running").count();
    let detail = rows.iter().map(|(n, st)| format!("{n}: {st}")).collect::<Vec<_>>().join(", ");
    Check { ok: running == rows.len(), detail }
}

fn first_line(out: &str, fallback: &str) -> String {
    out.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or(fallback).chars().take(160).collect()
}

// ---------- running things ----------

/// The scripts the app may run, each with a fixed argument shape. Nothing else is callable.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum Action {
    /// setup.ps1 (first run; creates the distro from the user's existing Ubuntu)
    Setup,
    /// start.ps1 (distro + link helper; waits for health)
    Start,
    /// start.ps1 -Stop
    Stop,
    /// deploy.ps1 (copy code in, rebuild containers)
    Deploy,
    /// backup.ps1
    Backup,
    /// start.ps1 -InstallAtLogin
    InstallAtLogin,
    /// `docker compose logs --tail 300` inside the distro
    Logs,
}

impl Action {
    pub fn label(self) -> &'static str {
        match self {
            Action::Setup => "Set up the bitbull distro",
            Action::Start => "Start BitBull",
            Action::Stop => "Stop BitBull",
            Action::Deploy => "Deploy (copy code in and rebuild)",
            Action::Backup => "Back up BitBull data",
            Action::InstallAtLogin => "Start BitBull at login",
            Action::Logs => "Container logs",
        }
    }
}

/// The program and argv for an action. `source` is only used by Setup (the Ubuntu distro to
/// export from) and is validated like a distro name.
pub fn command_for(action: Action, repo: &Path, distro: &str, source: Option<&str>) -> Result<(String, Vec<String>), String> {
    if !valid_distro(distro) {
        return Err("invalid distro name".into());
    }
    if !is_repo(repo) {
        return Err(format!("{} is not the BitBull repo", repo.display()));
    }
    let script = |name: &str| repo.join("scripts").join("bitbull-wsl").join(format!("{name}.ps1")).display().to_string();
    let ps = |file: String, extra: &[&str]| {
        let mut a = vec!["-NoProfile".to_string(), "-NonInteractive".into(), "-ExecutionPolicy".into(), "Bypass".into(), "-File".into(), file, "-Distro".into(), distro.to_string()];
        a.extend(extra.iter().map(|s| s.to_string()));
        ("powershell.exe".to_string(), a)
    };
    Ok(match action {
        Action::Setup => {
            // No source distro: setup.ps1 downloads and verifies Canonical's WSL image instead,
            // which is the normal path now (docs/CLIENTS.md 5.2). Only pass -Source when the user
            // explicitly names a distro to build the base from.
            match source.map(str::trim).filter(|s| !s.is_empty()) {
                None => ps(script("setup"), &[]),
                Some(src) if valid_distro(src) => ps(script("setup"), &["-Source", src]),
                Some(_) => return Err("invalid source distro name".into()),
            }
        }
        Action::Start => ps(script("start"), &[]),
        Action::Stop => ps(script("start"), &["-Stop"]),
        Action::Deploy => ps(script("deploy"), &[]),
        Action::Backup => ps(script("backup"), &[]),
        Action::InstallAtLogin => ps(script("start"), &["-InstallAtLogin"]),
        Action::Logs => (
            "wsl.exe".to_string(),
            ["-d", distro, "--cd", "~/BitBull", "--exec", "docker", "compose", "logs", "--tail", "300", "--no-color"].iter().map(|s| s.to_string()).collect(),
        ),
    })
}

/// Build the std Command for an action: argv array, no shell, no console window.
pub fn spawnable(program: &str, args: &[String], repo: &Path) -> Command {
    let mut c = Command::new(program);
    c.args(args).current_dir(repo).env("WSL_UTF8", "1").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    c
}

/// Run a short probe and capture its output (both streams), with a timeout.
pub fn run_capture(program: &str, args: &[&str], timeout: Duration) -> Result<(i32, String), String> {
    let mut c = Command::new(program);
    c.args(args).env("WSL_UTF8", "1").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    let mut child = c.spawn().map_err(|e| format!("{program}: {e}"))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let reader = std::thread::spawn(move || {
        use std::io::Read;
        let mut s = String::new();
        if let Some(mut o) = stdout {
            let mut b = Vec::new();
            let _ = o.read_to_end(&mut b);
            s.push_str(&decode(&b));
        }
        if let Some(mut e) = stderr {
            let mut b = Vec::new();
            let _ = e.read_to_end(&mut b);
            s.push_str(&decode(&b));
        }
        s
    });
    let start = std::time::Instant::now();
    let code = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st.code().unwrap_or(-1),
            Ok(None) if start.elapsed() > timeout => {
                let _ = child.kill();
                return Err(format!("{program} {} timed out", args.first().copied().unwrap_or("")));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(e) => return Err(e.to_string()),
        }
    };
    let out = reader.join().unwrap_or_default();
    Ok((code, out))
}

/// wsl.exe answers in UTF-16LE unless WSL_UTF8=1 took effect; PowerShell in the console code
/// page. Accept both: a UTF-16 stream has a NUL in every other byte.
pub fn decode(b: &[u8]) -> String {
    if b.len() >= 4 && b.iter().skip(1).step_by(2).take(16).all(|&x| x == 0) {
        let u: Vec<u16> = b.chunks(2).map(|c| u16::from_le_bytes([c[0], *c.get(1).unwrap_or(&0)])).collect();
        String::from_utf16_lossy(&u)
    } else {
        String::from_utf8_lossy(b).into_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_parsing() {
        let t = "# comment\nPORT=8787\r\nAPP_TOKEN=\"abc-def\"\r\nSAYGM_API_KEY=sk-x\n";
        assert_eq!(parse_env_value(t, "APP_TOKEN").as_deref(), Some("abc-def"));
        assert_eq!(parse_env_value(t, "PORT").as_deref(), Some("8787"));
        assert_eq!(parse_env_value("APP_TOKEN=\n", "APP_TOKEN"), None);
        assert_eq!(parse_env_value("#APP_TOKEN=x\n", "APP_TOKEN"), None);
    }

    #[test]
    fn distro_names() {
        assert!(valid_distro("bitbull"));
        assert!(valid_distro("Ubuntu-24.04"));
        assert!(!valid_distro(""));
        assert!(!valid_distro("bitbull; rm -rf /"));
        assert!(!valid_distro("a b"));
    }

    #[test]
    fn utf16_and_utf8_output() {
        let utf16: Vec<u8> = "bitbull\r\nUbuntu\r\n".encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
        assert_eq!(parse_distro_list(&decode(&utf16)), vec!["bitbull", "Ubuntu"]);
        assert_eq!(parse_distro_list(&decode(b"bitbull\nUbuntu\n")), vec!["bitbull", "Ubuntu"]);
    }

    #[test]
    fn compose_summary() {
        let c = summarise_compose_ps("bitbull-agent running\nbitbull-egress running\nbitbull-gateway exited\n");
        assert!(!c.ok);
        assert!(c.detail.contains("bitbull-gateway: exited"));
        assert!(summarise_compose_ps("bitbull-agent running\n").ok);
        assert!(!summarise_compose_ps("").ok);
    }

    #[test]
    fn commands_are_argv_arrays_from_fixed_shapes() {
        let dir = std::env::temp_dir().join(format!("bitbull-desktop-test-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("scripts/bitbull-wsl")).unwrap();
        std::fs::write(dir.join("scripts/bitbull-wsl/start.ps1"), "").unwrap();
        std::fs::write(dir.join("docker-compose.yml"), "").unwrap();
        assert!(is_repo(&dir));
        let (p, a) = command_for(Action::Stop, &dir, "bitbull", None).unwrap();
        assert_eq!(p, "powershell.exe");
        assert_eq!(&a[..5], &["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"]);
        assert!(a[5].ends_with("start.ps1"));
        assert_eq!(&a[6..], &["-Distro", "bitbull", "-Stop"]);
        assert!(command_for(Action::Setup, &dir, "bitbull", Some("Ubuntu && calc")).is_err());
        assert!(command_for(Action::Start, &dir, "bitbull$(x)", None).is_err());
        let (p, a) = command_for(Action::Logs, &dir, "bitbull", None).unwrap();
        assert_eq!(p, "wsl.exe");
        assert_eq!(a[1], "bitbull");
        assert!(command_for(Action::Start, &dir.join("nope"), "bitbull", None).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn settings_roundtrip() {
        let f = std::env::temp_dir().join(format!("bitbull-desktop-settings-{}.json", std::process::id()));
        let s = Settings { repo: Some(PathBuf::from("D:\\github\\BitBull")), ..Default::default() };
        s.save(&f).unwrap();
        assert_eq!(Settings::load(&f), s);
        std::fs::remove_file(&f).unwrap();
        assert_eq!(Settings::load(&f), Settings::default());
    }
}
