//! BitBob desktop: a small Windows wrapper around the sandboxed Docker stack. It checks the
//! machine, runs the repo's own PowerShell scripts (setup / start / stop / deploy / backup),
//! shows their output, and once BitBob answers it opens the normal web UI in a second window.
//!
//! Two windows on purpose: `main` is the launcher (local HTML, has IPC to these commands);
//! `bitbob` shows http://localhost:8787 and has **no** IPC capability, so nothing served by BitBob,
//! and nothing an agent writes into a page, can reach the commands below.

mod stack;

use stack::{Action, Settings, Status};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

struct AppState {
    settings: Mutex<Settings>,
    file: PathBuf,
    /// the running script, if any (one at a time)
    child: Mutex<Option<std::process::Child>>,
    run_seq: Mutex<u32>,
}

#[derive(Clone, serde::Serialize)]
struct LogLine {
    run: u32,
    line: String,
}
#[derive(Clone, serde::Serialize)]
struct Done {
    run: u32,
    code: i32,
}

#[tauri::command]
fn get_settings(state: State<AppState>) -> Settings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
fn set_settings(state: State<AppState>, settings: Settings) -> Result<Settings, String> {
    if !stack::valid_distro(&settings.distro) {
        return Err("Distro name: letters, digits, '-', '_' and '.' only".into());
    }
    if settings.port < 1024 {
        return Err("Port must be 1024 or higher".into());
    }
    let mut s = settings;
    if let Some(r) = &s.repo {
        if !stack::is_repo(r) {
            return Err(format!("{} does not contain scripts\\bitbob-wsl\\start.ps1 and docker-compose.yml", r.display()));
        }
    }
    if s.repo.is_none() {
        s.repo = stack::guess_repo(std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.to_path_buf())).as_deref());
    }
    s.save(&state.file)?;
    *state.settings.lock().unwrap() = s.clone();
    Ok(s)
}

/// Windows folder picker (from Rust, so the page needs no dialog permission).
#[tauri::command]
async fn pick_repo(app: AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = app.dialog().file().set_title("Choose the BitBob folder").blocking_pick_folder()?;
    let p = picked.into_path().ok()?;
    Some(p.display().to_string())
}

#[tauri::command]
async fn get_status(app: AppHandle) -> Status {
    let s = app.state::<AppState>().settings.lock().unwrap().clone();
    tauri::async_runtime::spawn_blocking(move || stack::status(&s)).await.unwrap_or_default()
}

#[tauri::command]
async fn run_action(app: AppHandle, action: Action, source: Option<String>) -> Result<u32, String> {
    let state = app.state::<AppState>();
    let s = state.settings.lock().unwrap().clone();
    let repo = s.repo.clone().ok_or("Choose the BitBob folder first")?;
    let (program, args) = stack::command_for(action, &repo, &s.distro, source.as_deref())?;
    let mut guard = state.child.lock().unwrap();
    if let Some(c) = guard.as_mut() {
        if c.try_wait().map(|x| x.is_none()).unwrap_or(false) {
            return Err("Another action is still running".into());
        }
    }
    let run = {
        let mut n = state.run_seq.lock().unwrap();
        *n += 1;
        *n
    };
    let mut child = stack::spawnable(&program, &args, &repo).spawn().map_err(|e| format!("{program}: {e}"))?;
    let _ = app.emit_to("main", "bitbob-log", LogLine { run, line: format!("> {} ({})", action.label(), program) });
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    for (stream, tag) in [(stdout.map(|s| Box::new(s) as Box<dyn std::io::Read + Send>), ""), (stderr.map(|s| Box::new(s) as Box<dyn std::io::Read + Send>), "! ")] {
        let Some(stream) = stream else { continue };
        let app2 = app.clone();
        std::thread::spawn(move || {
            let mut rd = BufReader::new(stream);
            let mut buf = Vec::new();
            loop {
                buf.clear();
                match rd.read_until(b'\n', &mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        let line = stack::decode(&buf).trim_end().to_string();
                        if !line.is_empty() {
                            let _ = app2.emit_to("main", "bitbob-log", LogLine { run, line: format!("{tag}{line}") });
                        }
                    }
                }
            }
        });
    }
    *guard = Some(child);
    drop(guard);
    let app3 = app.clone();
    std::thread::spawn(move || {
        let state = app3.state::<AppState>();
        let code = loop {
            let mut g = state.child.lock().unwrap();
            match g.as_mut().map(|c| c.try_wait()) {
                Some(Ok(Some(st))) => {
                    *g = None;
                    break st.code().unwrap_or(-1);
                }
                Some(Ok(None)) => {}
                _ => break -1,
            }
            drop(g);
            std::thread::sleep(std::time::Duration::from_millis(150));
        };
        let _ = app3.emit_to("main", "bitbob-done", Done { run, code });
    });
    Ok(run)
}

#[tauri::command]
fn cancel_action(state: State<AppState>) -> bool {
    let mut g = state.child.lock().unwrap();
    match g.as_mut() {
        Some(c) => {
            let _ = c.kill();
            *g = None;
            true
        }
        None => false,
    }
}

/// Show BitBob's own UI in its own (IPC-less) window. Async on purpose: a window must not be
/// created from a sync command (that runs on the main thread, and window creation on Windows
/// waits for that same thread, so the app freezes with a blank window).
#[tauri::command]
async fn open_gm(app: AppHandle) -> Result<(), String> {
    show_gm(&app)
}

/// Same from a tray/menu callback, which also runs on the main thread.
fn show_gm_later(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        if show_gm(&app).is_err() {
            show_launcher(app);
        }
    });
}

#[tauri::command]
fn show_launcher(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn show_gm(app: &AppHandle) -> Result<(), String> {
    let s = app.state::<AppState>().settings.lock().unwrap().clone();
    if let Some(w) = app.get_webview_window("bitbob") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        return Ok(());
    }
    let url: tauri::Url = s.bitbob_url().parse().map_err(|e| format!("{e}"))?;
    let w = WebviewWindowBuilder::new(app, "bitbob", WebviewUrl::External(url))
        .title("BitBob")
        .inner_size(1360.0, 900.0)
        .min_inner_size(720.0, 480.0)
        .build()
        .map_err(|e| e.to_string())?;
    let app2 = app.clone();
    w.on_window_event(move |e| {
        // closing the BitBob window just hides it (the stack keeps running); Quit is in the tray
        if let tauri::WindowEvent::CloseRequested { api, .. } = e {
            api.prevent_close();
            if let Some(w) = app2.get_webview_window("bitbob") {
                let _ = w.hide();
            }
        }
    });
    Ok(())
}

/// After the BitBob page loads, sign it in with APP_TOKEN from the repo's .env (only when the
/// page is the configured local origin; the token goes into that origin's localStorage, the
/// same place the web UI keeps it when you paste it).
fn sign_in_if_local(app: &AppHandle, webview: &tauri::Webview, url: &tauri::Url) {
    let s = app.state::<AppState>().settings.lock().unwrap().clone();
    if !s.auto_token || webview.label() != "bitbob" {
        return;
    }
    let local = url.scheme() == "http" && matches!(url.host_str(), Some("localhost") | Some("127.0.0.1")) && url.port_or_known_default() == Some(s.port);
    if !local {
        return;
    }
    let Some(repo) = s.repo else { return };
    let Some(token) = stack::app_token(&repo) else { return };
    let js = format!(
        "try{{var k='bitbob-token',v={};if(localStorage.getItem(k)!==v){{localStorage.setItem(k,v);location.reload();}}}}catch(e){{}}",
        serde_json::to_string(&token).unwrap_or_else(|_| "\"\"".into())
    );
    let _ = webview.eval(&js);
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let file = app.path().app_config_dir().map(|d| d.join("bitbob-desktop.json")).unwrap_or_else(|_| PathBuf::from("bitbob-desktop.json"));
            let mut settings = Settings::load(&file);
            if settings.repo.as_deref().map(stack::is_repo) != Some(true) {
                settings.repo = stack::guess_repo(std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.to_path_buf())).as_deref());
            }
            app.manage(AppState { settings: Mutex::new(settings), file, child: Mutex::new(None), run_seq: Mutex::new(0) });

            // tray: the app lives here; closing windows never stops the stack
            let open = MenuItem::with_id(app, "open", "Open BitBob", true, None::<&str>)?;
            let launcher = MenuItem::with_id(app, "launcher", "Launcher / status", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit (BitBob keeps running)", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &launcher, &PredefinedMenuItem::separator(app)?, &quit])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().cloned().expect("icon"))
                .tooltip("BitBob")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, ev| match ev.id().as_ref() {
                    "open" => show_gm_later(app),
                    "launcher" => show_launcher(app.clone()),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, ev| {
                    if let tauri::tray::TrayIconEvent::Click { button: tauri::tray::MouseButton::Left, .. } = ev {
                        show_gm_later(tray.app_handle());
                    }
                })
                .build(app)?;

            if let Some(w) = app.get_webview_window("main") {
                let app2 = app.handle().clone();
                w.on_window_event(move |e| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = e {
                        api.prevent_close();
                        if let Some(w) = app2.get_webview_window("main") {
                            let _ = w.hide();
                        }
                    }
                });
            }
            Ok(())
        })
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                sign_in_if_local(webview.app_handle(), webview, payload.url());
            }
        })
        .invoke_handler(tauri::generate_handler![get_settings, set_settings, pick_repo, get_status, run_action, cancel_action, open_gm, show_launcher])
        .build(tauri::generate_context!())
        .expect("error while building BitBob desktop")
        .run(|_app, event| {
            // keep running in the tray when every window is hidden/closed
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}
