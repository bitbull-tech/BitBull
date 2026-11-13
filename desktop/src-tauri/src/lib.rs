//! BitBull desktop: a small wrapper around the sandboxed Docker stack, for Windows and macOS. It
//! checks the machine, runs the repo's own scripts (setup / start / stop / deploy / backup:
//! PowerShell in scripts/bitbull-wsl on Windows, bash in scripts/bitbull-mac on a Mac), shows their
//! output, and once BitBull answers it opens the normal web UI in a second window. On a Mac it is
//! also the link helper BitBull's page talks to (helper.rs); on Windows that is link-helper.ps1.
//!
//! Two windows on purpose: `main` is the launcher (local HTML, has IPC to these commands);
//! `bitbull` shows http://localhost:8787 and has **no** IPC capability, so nothing served by BitBull,
//! and nothing an agent writes into a page, can reach the commands below.

mod helper;
mod stack;

use stack::{Action, Platform, Settings, Status};
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

/// The app identifier was io.bitbob.desktop until the BitBob -> BitBull rename (7 Nov 2026),
/// which moves the config folder. Copy the old settings (repo path, distro, port, checkboxes) the
/// first time the new folder has none, so the launcher doesn't come up asking where the repo is.
/// The repo path inside may still name the old folder; the usual repo check then guesses again.
fn carry_over_legacy_settings(file: &std::path::Path) {
    if file.exists() {
        return;
    }
    let Some(legacy) = file
        .parent()
        .and_then(|d| d.parent())
        .map(|root| root.join("io.bitbob.desktop").join("bitbob-desktop.json"))
    else {
        return;
    };
    if legacy.is_file() {
        if let Some(dir) = file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::copy(&legacy, file);
    }
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
            let scripts = if cfg!(target_os = "macos") { "scripts/bitbull-mac/start.sh" } else { "scripts\\bitbull-wsl\\start.ps1" };
            return Err(format!("{} does not contain {scripts} and docker-compose.yml", r.display()));
        }
    }
    if s.repo.is_none() {
        s.repo = stack::guess_repo(std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.to_path_buf())).as_deref());
    }
    s.save(&state.file)?;
    *state.settings.lock().unwrap() = s.clone();
    Ok(s)
}

/// Folder picker (from Rust, so the page needs no dialog permission).
#[tauri::command]
async fn pick_repo(app: AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = app.dialog().file().set_title("Choose the BitBull folder").blocking_pick_folder()?;
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
    start_action(&app, action, source.as_deref())
}

/// Start one of the repo's scripts and stream its output to the launcher window. One at a time.
/// Split out of the command above so the tray can use it too.
fn start_action(app: &AppHandle, action: Action, source: Option<&str>) -> Result<u32, String> {
    let app = app.clone();
    let state = app.state::<AppState>();
    let s = state.settings.lock().unwrap().clone();
    let repo = s.repo.clone().ok_or("Choose the BitBull folder first")?;
    let (program, args) = stack::command_for(Platform::current(), action, &repo, &s.distro, s.port, source)?;
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
    let _ = app.emit_to("main", "bitbull-log", LogLine { run, line: format!("> {} ({})", action.label(), program) });
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
                            let _ = app2.emit_to("main", "bitbull-log", LogLine { run, line: format!("{tag}{line}") });
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
        let _ = app3.emit_to("main", "bitbull-done", Done { run, code });
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

/// Tray "Stop BitBull and quit": shut the containers and the distro down, then close the app.
/// The counterpart to plain Quit, which leaves the stack running. Everything here happens off the
/// main thread: `blocking_show` must never block it, and the stop script takes a while.
fn stop_and_quit(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
        let confirmed = app
            .dialog()
            .message(
                "This stops the BitBull containers and shuts BitBull's Linux VM (the distro on Windows) down, \
                 then closes this app. Anything running inside BitBull is interrupted.\n\n\
                 To close the app and leave BitBull running, use Quit instead.",
            )
            .title("Stop BitBull and quit?")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom("Stop and quit".into(), "Cancel".into()))
            .blocking_show();
        if !confirmed {
            return;
        }
        // the launcher shows the script's output, so put it in front before the stop starts
        show_launcher(app.clone());
        if let Err(e) = start_action(&app, Action::Stop, None) {
            let _ = app.emit_to("main", "bitbull-log", LogLine { run: 0, line: format!("! {e}") });
            return;
        }
        if let Some(t) = app.tray_by_id(TRAY_ID) {
            let _ = t.set_tooltip(Some("BitBull: stopping…"));
        }
        // let the stop script finish before this process goes away (it is what brings the stack
        // down), but never hang here: after 2 minutes stop waiting and end it
        let state = app.state::<AppState>();
        let mut finished = false;
        for _ in 0..600 {
            if state.child.lock().map(|c| c.is_none()).unwrap_or(true) {
                finished = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
        if !finished {
            if let Ok(mut g) = state.child.lock() {
                if let Some(c) = g.as_mut() {
                    let _ = c.kill();
                }
                *g = None;
            }
        }
        quit_app(&app);
    });
}

const TRAY_ID: &str = "bitbull-tray";

/// Leave for good: take the tray icon down first, then exit, both on the main thread. Exiting from
/// a worker thread (the stop path) can leave Windows showing a dead icon until it is hovered.
fn quit_app(app: &AppHandle) {
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(t) = app2.remove_tray_by_id(TRAY_ID) {
            let _ = t.set_visible(false);
            drop(t);
        }
        app2.exit(0);
    });
}

/// Show BitBull's own UI in its own (IPC-less) window. Async on purpose: a window must not be
/// created from a sync command (that runs on the main thread, and window creation on Windows
/// waits for that same thread, so the app freezes with a blank window).
#[tauri::command]
async fn open_bitbull(app: AppHandle) -> Result<(), String> {
    show_bitbull(&app)
}

/// Same from a tray/menu callback, which also runs on the main thread.
fn show_bitbull_later(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        if show_bitbull(&app).is_err() {
            show_launcher(app);
        }
    });
}

/// Start the app again from its (possibly just replaced) files: the last step of an update that
/// brought a newer app. BitBull itself is not touched.
#[tauri::command]
fn restart_app(app: AppHandle) {
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(t) = app2.remove_tray_by_id(TRAY_ID) {
            let _ = t.set_visible(false);
            drop(t);
        }
        app2.restart();
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

/// Hand a web link to the default browser. Only http(s), and the URL is one argument to a fixed
/// program, never part of a command line.
fn open_in_browser(url: &tauri::Url) {
    if !matches!(url.scheme(), "http" | "https") {
        return;
    }
    let (program, args): (&str, Vec<&str>) = if cfg!(target_os = "macos") {
        ("/usr/bin/open", vec![url.as_str()])
    } else if cfg!(windows) {
        ("rundll32.exe", vec!["url.dll,FileProtocolHandler", url.as_str()])
    } else {
        ("xdg-open", vec![url.as_str()])
    };
    let _ = std::process::Command::new(program).args(args).spawn();
}

/// Pages that belong in the BitBull window: BitBull itself on this computer, and the browser's own
/// internal addresses (blob:, data:, about:) that downloads and previews use.
fn stays_in_window(url: &tauri::Url) -> bool {
    match url.scheme() {
        "http" | "https" => matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")),
        _ => true,
    }
}

/// `dir/name`, or `dir/name (2).ext`, `(3)`… when that is taken, so a download never replaces a file.
fn free_path(dir: &std::path::Path, name: &std::path::Path) -> PathBuf {
    let stem = name.file_stem().and_then(|s| s.to_str()).filter(|s| !s.is_empty()).unwrap_or("bitbull-download").to_string();
    let ext = name.extension().and_then(|s| s.to_str()).map(|e| format!(".{e}")).unwrap_or_default();
    let mut p = dir.join(format!("{stem}{ext}"));
    let mut n = 2;
    while p.exists() && n < 1000 {
        p = dir.join(format!("{stem} ({n}){ext}"));
        n += 1;
    }
    p
}

fn show_bitbull(app: &AppHandle) -> Result<(), String> {
    let s = app.state::<AppState>().settings.lock().unwrap().clone();
    if let Some(w) = app.get_webview_window("bitbull") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        return Ok(());
    }
    let url: tauri::Url = s.bitbull_url().parse().map_err(|e| format!("{e}"))?;
    let w = WebviewWindowBuilder::new(app, "bitbull", WebviewUrl::External(url))
        .title("BitBull")
        .inner_size(1360.0, 900.0)
        .min_inner_size(720.0, 480.0)
        // tells the page that holding the shortcut works from anywhere (Settings → Voice says so)
        .initialization_script("window.__BITBULL_DESKTOP={globalPtt:true};")
        // A link that opens a new tab (the guide, GitHub, a provider's page) goes to the default
        // browser: this window only ever shows BitBull itself. Without this a Mac ignores the click.
        .on_new_window(|url, _features| {
            open_in_browser(&url);
            tauri::webview::NewWindowResponse::Deny
        })
        // The same for a link that would replace BitBull in this window: anywhere that isn't
        // BitBull itself (this computer) opens in the browser and the window stays where it is.
        .on_navigation(|url| {
            if stays_in_window(url) {
                return true;
            }
            open_in_browser(url);
            false
        })
        // Files BitBull hands over (an exported chat, a reply's files, the activity log) are saved
        // to the Downloads folder under their own name, never over a file already there.
        .on_download({
            let app = app.clone();
            move |_webview, event| {
                if let tauri::webview::DownloadEvent::Requested { destination, .. } = event {
                    if let Ok(dir) = app.path().download_dir() {
                        let name = destination.file_name().map(|n| n.to_os_string()).unwrap_or_else(|| "bitbull-download".into());
                        *destination = free_path(&dir, std::path::Path::new(&name));
                    }
                }
                true
            }
        })
        .build()
        .map_err(|e| e.to_string())?;
    let app2 = app.clone();
    w.on_window_event(move |e| {
        // closing the BitBull window just hides it (the stack keeps running); Quit is in the tray
        if let tauri::WindowEvent::CloseRequested { api, .. } = e {
            api.prevent_close();
            if let Some(w) = app2.get_webview_window("bitbull") {
                let _ = w.hide();
            }
        }
    });
    Ok(())
}

/// After the BitBull page loads, sign it in with APP_TOKEN from the repo's .env (only when the
/// page is the configured local origin; the token goes into that origin's localStorage, the
/// same place the web UI keeps it when you paste it).
fn sign_in_if_local(app: &AppHandle, webview: &tauri::Webview, url: &tauri::Url) {
    let s = app.state::<AppState>().settings.lock().unwrap().clone();
    if !s.auto_token || webview.label() != "bitbull" {
        return;
    }
    let local = url.scheme() == "http" && matches!(url.host_str(), Some("localhost") | Some("127.0.0.1")) && url.port_or_known_default() == Some(s.port);
    if !local {
        return;
    }
    let Some(repo) = s.repo else { return };
    let Some(token) = stack::app_token(&repo) else { return };
    let js = format!(
        "try{{var k='bitbull-token',v={};if(localStorage.getItem(k)!==v){{localStorage.setItem(k,v);location.reload();}}}}catch(e){{}}",
        serde_json::to_string(&token).unwrap_or_else(|_| "\"\"".into())
    );
    let _ = webview.eval(&js);
}

/// The link helper's view of the app: the settings, native dialogs, the Keychain, Finder.
struct AppHost(AppHandle);

impl helper::Host for AppHost {
    fn repo(&self) -> Option<PathBuf> {
        self.0.state::<AppState>().settings.lock().unwrap().repo.clone()
    }
    fn port(&self) -> u16 {
        self.0.state::<AppState>().settings.lock().unwrap().port
    }
    fn profile(&self) -> String {
        self.0.state::<AppState>().settings.lock().unwrap().distro.clone()
    }
    fn confirm(&self, title: &str, text: &str, ok: &str, cancel: &str) -> bool {
        use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
        self.bring_forward();
        self.0
            .dialog()
            .message(text)
            .title(title)
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(ok.into(), cancel.into()))
            .blocking_show()
    }
    fn pick_folder(&self, title: &str) -> Option<PathBuf> {
        use tauri_plugin_dialog::DialogExt;
        self.bring_forward();
        self.0.dialog().file().set_title(title).blocking_pick_folder()?.into_path().ok()
    }
    fn vault_key(&self) -> Result<String, String> {
        helper::keychain_vault_key()
    }
    fn open_in_finder(&self, p: &std::path::Path) -> Result<(), String> {
        // a file is revealed (its folder opens with it selected); a folder opens
        let mut cmd = std::process::Command::new("/usr/bin/open");
        if p.is_file() {
            cmd.arg("-R");
        }
        let st = cmd.arg(p).status().map_err(|e| e.to_string())?;
        if st.success() { Ok(()) } else { Err(format!("open {} failed", p.display())) }
    }
}

impl AppHost {
    /// The request comes from a browser window; the dialog should not open behind it.
    fn bring_forward(&self) {
        #[cfg(target_os = "macos")]
        let _ = self.0.show();
    }
}

/// Voice push-to-talk: hold Ctrl+Shift+Space (Cmd+Shift+Space on a Mac) anywhere on the computer
/// and BitBull listens; let go and what you said is sent. The BitBull window has no IPC, so the key
/// state goes in as a DOM event with a fixed payload ("down" / "up"), nothing else.
fn register_push_to_talk(app: &AppHandle) {
    use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
    let mods = if cfg!(target_os = "macos") { Modifiers::SUPER | Modifiers::SHIFT } else { Modifiers::CONTROL | Modifiers::SHIFT };
    let ptt = Shortcut::new(Some(mods), Code::Space);
    let plugin = tauri_plugin_global_shortcut::Builder::new()
        .with_handler(move |app, shortcut, event| {
            if shortcut != &ptt {
                return;
            }
            let state = if event.state() == ShortcutState::Pressed { "down" } else { "up" };
            if let Some(w) = app.get_webview_window("bitbull") {
                let _ = w.eval(&format!("window.dispatchEvent(new CustomEvent('bitbull:ptt',{{detail:'{state}'}}))"));
            }
        })
        .build();
    if app.plugin(plugin).is_err() {
        return;
    }
    // another app may own the combination already: voice still works from the mic button
    if let Err(e) = app.global_shortcut().register(ptt) {
        eprintln!("push-to-talk shortcut not available: {e}");
    }
}

/// Windows: keep the link helper (scripts/bitbull-wsl/link-helper.ps1: folder picker, Open in
/// Explorer, vault key) running while this app runs. It is checked every 10 s and started, hidden,
/// when nothing answers on its port; start.ps1 still starts it too, for when the app isn't open.
#[cfg(windows)]
fn keep_link_helper(app: AppHandle) {
    use std::net::{SocketAddr, TcpStream};
    use std::os::windows::process::CommandExt;
    use std::time::Duration;
    std::thread::spawn(move || {
        let addr: SocketAddr = "127.0.0.1:8790".parse().unwrap();
        loop {
            let s = app.state::<AppState>().settings.lock().unwrap().clone();
            let answering = TcpStream::connect_timeout(&addr, Duration::from_millis(500)).is_ok();
            let mut started = false;
            if !answering {
                if let Some(repo) = s.repo.as_deref().filter(|r| stack::is_repo(r)) {
                    let script = repo.join("scripts").join("bitbull-wsl").join("link-helper.ps1");
                    let distro = if stack::valid_distro(&s.distro) { s.distro.clone() } else { "bitbull".into() };
                    if script.is_file() {
                        let r = std::process::Command::new("powershell.exe")
                            .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-STA", "-WindowStyle", "Hidden", "-File"])
                            .arg(&script)
                            .arg("-Distro")
                            .arg(&distro)
                            .current_dir(repo)
                            .stdin(std::process::Stdio::null())
                            .stdout(std::process::Stdio::null())
                            .stderr(std::process::Stdio::null())
                            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW; its dialogs still show
                            .spawn();
                        started = r.is_ok();
                    }
                }
            }
            // a helper takes a few seconds to start listening: don't start a second one meanwhile
            std::thread::sleep(Duration::from_secs(if started { 20 } else { 10 }));
        }
    });
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            register_push_to_talk(app.handle());
            let file = app.path().app_config_dir().map(|d| d.join("bitbull-desktop.json")).unwrap_or_else(|_| PathBuf::from("bitbull-desktop.json"));
            carry_over_legacy_settings(&file);
            let mut settings = Settings::load(&file);
            if settings.repo.as_deref().map(stack::is_repo) != Some(true) {
                settings.repo = stack::guess_repo(std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.to_path_buf())).as_deref());
            }
            app.manage(AppState { settings: Mutex::new(settings), file, child: Mutex::new(None), run_seq: Mutex::new(0) });
            // On a Mac the app is the link helper (folder links, Open in Finder, the vault key);
            // on Windows that is link-helper.ps1, started by start.ps1.
            if Platform::current() == Platform::Mac {
                helper::serve(std::sync::Arc::new(AppHost(app.handle().clone())));
            }
            // On Windows this app keeps link-helper.ps1 running, so linking folders from BitBull's
            // page works without starting anything by hand.
            #[cfg(windows)]
            keep_link_helper(app.handle().clone());

            // tray: the app lives here; closing windows never stops the stack
            let open = MenuItem::with_id(app, "open", "Open BitBull", true, None::<&str>)?;
            let launcher = MenuItem::with_id(app, "launcher", "Launcher / status", true, None::<&str>)?;
            let stop = MenuItem::with_id(app, "stop", "Stop BitBull and quit", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit (BitBull keeps running)", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &launcher, &PredefinedMenuItem::separator(app)?, &stop, &quit])?;
            TrayIconBuilder::with_id(TRAY_ID)
                .icon(app.default_window_icon().cloned().expect("icon"))
                .tooltip("BitBull")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, ev| match ev.id().as_ref() {
                    "open" => show_bitbull_later(app),
                    "launcher" => show_launcher(app.clone()),
                    "stop" => stop_and_quit(app),
                    "quit" => quit_app(app),
                    _ => {}
                })
                .on_tray_icon_event(|tray, ev| {
                    if let tauri::tray::TrayIconEvent::Click { button: tauri::tray::MouseButton::Left, .. } = ev {
                        show_bitbull_later(tray.app_handle());
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
        .invoke_handler(tauri::generate_handler![get_settings, set_settings, pick_repo, get_status, run_action, cancel_action, open_bitbull, show_launcher, restart_app])
        .build(tauri::generate_context!())
        .expect("error while building BitBull desktop")
        .run(|app, event| match event {
            // Windows: keep running in the tray when every window is closed. On a Mac windows are
            // only ever hidden, so a request to exit there is the user choosing Quit (⌘Q, or Quit
            // on the Dock icon), or the system or an update asking the app to close: honour it,
            // or the app can't be closed and its icon is stuck in the Dock. BitBull keeps running.
            tauri::RunEvent::ExitRequested { api, code, .. } => {
                if code.is_none() && !cfg!(target_os = "macos") {
                    api.prevent_exit();
                }
            }
            // Mac: clicking the Dock icon when no window is showing brings BitBull back
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { has_visible_windows: false, .. } => show_bitbull_later(app),
            _ => {
                let _ = app;
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_bitbull_itself_stays_in_the_window() {
        let u = |s: &str| s.parse::<tauri::Url>().unwrap();
        assert!(stays_in_window(&u("http://localhost:8787/")));
        assert!(stays_in_window(&u("http://127.0.0.1:8787/help/system-map.html")));
        assert!(stays_in_window(&u("blob:http://localhost:8787/1b2c")));
        assert!(stays_in_window(&u("about:blank")));
        // everything else goes to the browser, including look-alike hosts
        assert!(!stays_in_window(&u("https://app.heyditto.ai/device?code=ABCD")));
        assert!(!stays_in_window(&u("https://www.bitbull.tech/ditto")));
        assert!(!stays_in_window(&u("http://localhost.evil.example/")));
        assert!(!stays_in_window(&u("https://saygm.com")));
    }

    #[test]
    fn a_download_never_replaces_a_file() {
        let dir = std::env::temp_dir().join(format!("bitbull-desktop-dl-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let name = std::path::Path::new("chat.md");
        assert_eq!(free_path(&dir, name), dir.join("chat.md"));
        std::fs::write(dir.join("chat.md"), "").unwrap();
        assert_eq!(free_path(&dir, name), dir.join("chat (2).md"));
        std::fs::write(dir.join("chat (2).md"), "").unwrap();
        assert_eq!(free_path(&dir, name), dir.join("chat (3).md"));
        assert_eq!(free_path(&dir, std::path::Path::new("notes")), dir.join("notes"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
