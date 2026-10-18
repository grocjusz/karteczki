// Karteczki — rdzeń aplikacji.
// Każda notatka to osobny plik JSON w folderze danych (domyślnie OneDrive\Karteczki),
// dzięki czemu OneDrive synchronizuje pojedyncze notatki, a dwa komputery mogą pracować jednocześnie.
// Obrazki leżą w podfolderze `images`, a stan przypiętych karteczek (pozycja, „na wierzchu”)
// jest zapisywany lokalnie, bo układ pulpitu różni się między komputerami.

mod store;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use store::{Note, SaveResult};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_opener::OpenerExt;

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct Settings {
    data_dir: Option<String>,
    #[serde(default)]
    first_run_done: bool,
}

#[derive(Serialize, Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
struct Sticky {
    x: i32,
    y: i32,
    w: u32,
    h: u32,
    on_top: bool,
}

struct AppState {
    settings: Mutex<Settings>,
    stickies: Mutex<HashMap<String, Sticky>>,
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
    exiting: AtomicBool,
    last_sticky_write: Mutex<Instant>,
}

fn config_dir(app: &AppHandle) -> PathBuf {
    let dir = app.path().app_config_dir().unwrap_or_else(|_| std::env::temp_dir().join("Karteczki"));
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn backup_dir(app: &AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_local_data_dir()
        .unwrap_or_else(|_| config_dir(app))
        .join("kopie");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn default_data_dir() -> PathBuf {
    for var in ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"] {
        if let Ok(v) = std::env::var(var) {
            if !v.trim().is_empty() && PathBuf::from(&v).is_dir() {
                return PathBuf::from(v).join("Karteczki");
            }
        }
    }
    dirs::document_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(std::env::temp_dir)
        .join("Karteczki")
}

fn data_dir(state: &AppState) -> PathBuf {
    let s = state.settings.lock().unwrap();
    s.data_dir.as_ref().map(PathBuf::from).unwrap_or_else(default_data_dir)
}

fn load_json<T: for<'de> Deserialize<'de> + Default>(path: &PathBuf) -> T {
    std::fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn save_json<T: Serialize>(path: &PathBuf, value: &T) {
    if let Ok(bytes) = serde_json::to_vec_pretty(value) {
        let _ = store::write_atomic(path, &bytes);
    }
}

fn save_settings(app: &AppHandle, state: &AppState) {
    let s = state.settings.lock().unwrap().clone();
    save_json(&config_dir(app).join("settings.json"), &s);
}

fn save_stickies(app: &AppHandle, state: &AppState) {
    let s = state.stickies.lock().unwrap().clone();
    save_json(&config_dir(app).join("karteczki-na-pulpicie.json"), &s);
}

// ---------- polecenia dla interfejsu ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Info {
    data_dir: String,
    backup_dir: String,
    version: String,
}

#[tauri::command]
fn get_info(app: AppHandle, state: State<AppState>) -> Info {
    Info {
        data_dir: data_dir(&state).to_string_lossy().into(),
        backup_dir: backup_dir(&app).to_string_lossy().into(),
        version: app.package_info().version.to_string(),
    }
}

#[tauri::command]
fn list_notes(state: State<AppState>) -> Result<Vec<Note>, String> {
    store::list(&data_dir(&state)).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_note(app: AppHandle, state: State<AppState>, note: Note, base_updated_at: i64) -> Result<SaveResult, String> {
    let result = store::save(&data_dir(&state), note, base_updated_at).map_err(|e| e.to_string())?;
    let _ = app.emit("note-saved", &result.note);
    if let Some(c) = &result.conflict {
        let _ = app.emit("note-saved", c);
    }
    Ok(result)
}

#[tauri::command]
fn delete_note(app: AppHandle, state: State<AppState>, id: String) -> Result<(), String> {
    store::delete(&data_dir(&state), &id).map_err(|e| e.to_string())?;
    close_sticky_window(&app, &id);
    let _ = app.emit("note-deleted", &id);
    Ok(())
}

#[tauri::command]
fn save_image(state: State<AppState>, request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let ext = request
        .headers()
        .get("x-ext")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("png")
        .to_lowercase();
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Oczekiwano danych obrazka".into());
    };
    store::save_image(&data_dir(&state), bytes, &ext).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_data_dir(app: AppHandle, state: State<AppState>, path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    std::fs::create_dir_all(p.join("notes")).map_err(|e| e.to_string())?;
    state.settings.lock().unwrap().data_dir = Some(path);
    save_settings(&app, &state);
    start_watcher(&app);
    let _ = app.emit("notes-external", ());
    Ok(())
}

#[tauri::command]
fn open_backup_dir(app: AppHandle) -> Result<(), String> {
    app.opener()
        .open_path(backup_dir(&app).to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn open_data_dir(app: AppHandle, state: State<AppState>) -> Result<(), String> {
    app.opener()
        .open_path(data_dir(&state).to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}

fn sticky_label(id: &str) -> String {
    format!("note-{id}")
}

fn open_sticky_window(app: &AppHandle, id: &str) -> Result<(), String> {
    if !store::valid_id(id) {
        return Err("Nieprawidłowy identyfikator".into());
    }
    let label = sticky_label(id);
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    let state = app.state::<AppState>();
    let saved = state.stickies.lock().unwrap().get(id).copied();
    let on_top = saved.map(|s| s.on_top).unwrap_or(false);
    let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(format!("index.html#sticky={id}").into()))
        .title("Karteczka")
        .inner_size(300.0, 300.0)
        .min_inner_size(180.0, 140.0)
        .decorations(false)
        .always_on_top(on_top)
        .skip_taskbar(true)
        .disable_drag_drop_handler()
        .build()
        .map_err(|e| e.to_string())?;
    if let Some(s) = saved {
        let _ = window.set_size(PhysicalSize::new(s.w, s.h));
        let _ = window.set_position(PhysicalPosition::new(s.x, s.y));
    } else {
        let pos = window.outer_position().unwrap_or_default();
        let size = window.inner_size().unwrap_or(PhysicalSize::new(300, 300));
        state.stickies.lock().unwrap().insert(
            id.to_string(),
            Sticky { x: pos.x, y: pos.y, w: size.width, h: size.height, on_top },
        );
        save_stickies(app, &state);
    }
    Ok(())
}

fn close_sticky_window(app: &AppHandle, id: &str) {
    let state = app.state::<AppState>();
    state.stickies.lock().unwrap().remove(id);
    save_stickies(app, &state);
    if let Some(w) = app.get_webview_window(&sticky_label(id)) {
        let _ = w.destroy();
    }
}

#[tauri::command]
fn open_sticky(app: AppHandle, id: String) -> Result<(), String> {
    open_sticky_window(&app, &id)
}

#[tauri::command]
fn close_sticky(app: AppHandle, id: String) {
    close_sticky_window(&app, &id);
}

#[tauri::command]
fn sticky_on_top(app: AppHandle, state: State<AppState>, id: String) -> bool {
    let _ = &app;
    state.stickies.lock().unwrap().get(&id).map(|s| s.on_top).unwrap_or(false)
}

#[tauri::command]
fn set_sticky_on_top(app: AppHandle, state: State<AppState>, id: String, on_top: bool) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(&sticky_label(&id)) {
        w.set_always_on_top(on_top).map_err(|e| e.to_string())?;
    }
    if let Some(s) = state.stickies.lock().unwrap().get_mut(&id) {
        s.on_top = on_top;
    }
    save_stickies(&app, &state);
    Ok(())
}

#[tauri::command]
fn show_main(app: AppHandle, id: Option<String>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
    if let Some(id) = id {
        let _ = app.emit_to("main", "open-note", id);
    }
}

#[tauri::command]
fn is_sticky_open(app: AppHandle, id: String) -> bool {
    app.get_webview_window(&sticky_label(&id)).is_some()
}

// ---------- obserwacja folderu, kopie, kosz ----------

fn start_watcher(app: &AppHandle) {
    use notify::{RecursiveMode, Watcher};
    let state = app.state::<AppState>();
    let dir = data_dir(&state).join("notes");
    let _ = std::fs::create_dir_all(&dir);
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            if ev.paths.iter().any(|p| p.extension().map(|e| e == "json").unwrap_or(false)) {
                let _ = tx.send(());
            }
        }
    });
    let Ok(mut watcher) = watcher else { return };
    if watcher.watch(&dir, RecursiveMode::NonRecursive).is_err() {
        return;
    }
    *state.watcher.lock().unwrap() = Some(watcher);
    let handle = app.clone();
    std::thread::spawn(move || {
        // Zbieramy serię zdarzeń (zapis, zmiana nazwy, synchronizacja) w jedno odświeżenie.
        while rx.recv().is_ok() {
            while rx.recv_timeout(Duration::from_millis(400)).is_ok() {}
            let _ = handle.emit("notes-external", ());
        }
    });
}

fn housekeeping(app: &AppHandle) {
    let state = app.state::<AppState>();
    let dir = data_dir(&state);
    let _ = store::purge_trash(&dir, chrono::Utc::now().timestamp_millis(), 30);
    let _ = store::daily_backup(&dir, &backup_dir(app), &chrono::Local::now().format("%Y-%m-%d").to_string(), 14);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--autostart"])))
        .register_uri_scheme_protocol("kimg", |ctx, request| {
            let state = ctx.app_handle().state::<AppState>();
            let name = request.uri().path().trim_start_matches('/').to_string();
            match store::read_image(&data_dir(&state), &name) {
                Some((bytes, mime)) => tauri::http::Response::builder()
                    .header("Content-Type", mime)
                    .header("Cache-Control", "max-age=31536000, immutable")
                    .body(bytes)
                    .unwrap(),
                None => tauri::http::Response::builder().status(404).body(Vec::new()).unwrap(),
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let settings: Settings = load_json(&config_dir(&handle).join("settings.json"));
            let stickies: HashMap<String, Sticky> = load_json(&config_dir(&handle).join("karteczki-na-pulpicie.json"));
            app.manage(AppState {
                settings: Mutex::new(settings),
                stickies: Mutex::new(stickies),
                watcher: Mutex::new(None),
                exiting: AtomicBool::new(false),
                last_sticky_write: Mutex::new(Instant::now()),
            });
            let state = handle.state::<AppState>();
            let _ = std::fs::create_dir_all(data_dir(&state).join("notes"));
            let _ = std::fs::create_dir_all(data_dir(&state).join("images"));

            // Przy pierwszym uruchomieniu włączamy start z Windowsem (można wyłączyć w ustawieniach).
            let first = !state.settings.lock().unwrap().first_run_done;
            if first {
                let _ = handle.autolaunch().enable();
                state.settings.lock().unwrap().first_run_done = true;
                save_settings(&handle, &state);
            }

            if std::env::args().any(|a| a == "--autostart") {
                if let Some(w) = handle.get_webview_window("main") {
                    let _ = w.minimize();
                }
            }

            let ids: Vec<String> = state.stickies.lock().unwrap().keys().cloned().collect();
            let existing = store::list(&data_dir(&state)).unwrap_or_default();
            for id in ids {
                let alive = existing.iter().any(|n| n.id == id && n.trashed_at.is_none());
                if alive {
                    let _ = open_sticky_window(&handle, &id);
                } else {
                    state.stickies.lock().unwrap().remove(&id);
                }
            }
            save_stickies(&handle, &state);

            start_watcher(&handle);
            let h = handle.clone();
            std::thread::spawn(move || loop {
                housekeeping(&h);
                std::thread::sleep(Duration::from_secs(6 * 3600));
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            let app = window.app_handle();
            let state = app.state::<AppState>();
            let label = window.label().to_string();
            if label == "main" {
                if let WindowEvent::CloseRequested { .. } = event {
                    // Zamknięcie głównego okna kończy aplikację; przypięte karteczki wrócą przy następnym starcie.
                    state.exiting.store(true, Ordering::SeqCst);
                    save_stickies(app, &state);
                    app.exit(0);
                }
                return;
            }
            let Some(id) = label.strip_prefix("note-").map(str::to_string) else { return };
            match event {
                WindowEvent::Moved(pos) => {
                    // Okno zminimalizowane w Windows ma pozycję (-32000, -32000) — nie zapisujemy jej.
                    if pos.x <= -10000 || pos.y <= -10000 {
                        return;
                    }
                    if let Some(s) = state.stickies.lock().unwrap().get_mut(&id) {
                        s.x = pos.x;
                        s.y = pos.y;
                    }
                }
                WindowEvent::Resized(size) => {
                    if size.width > 0 && size.height > 0 {
                        if let Some(s) = state.stickies.lock().unwrap().get_mut(&id) {
                            s.w = size.width;
                            s.h = size.height;
                        }
                    }
                }
                WindowEvent::Focused(false) => {
                    save_stickies(app, &state);
                    return;
                }
                _ => return,
            }
            let mut last = state.last_sticky_write.lock().unwrap();
            if last.elapsed() > Duration::from_millis(500) {
                *last = Instant::now();
                drop(last);
                save_stickies(app, &state);
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_info,
            list_notes,
            save_note,
            delete_note,
            save_image,
            set_data_dir,
            open_backup_dir,
            open_data_dir,
            open_sticky,
            close_sticky,
            sticky_on_top,
            set_sticky_on_top,
            show_main,
            is_sticky_open
        ])
        .build(tauri::generate_context!())
        .expect("nie udało się uruchomić Karteczek")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                let state = app.state::<AppState>();
                save_stickies(app, &state);
            }
        });
}
