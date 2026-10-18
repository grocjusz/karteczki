// Karteczki — rdzeń aplikacji.
// Każda notatka to osobny plik JSON w folderze danych (domyślnie OneDrive\Karteczki),
// dzięki czemu OneDrive synchronizuje pojedyncze notatki, a dwa komputery mogą pracować jednocześnie.
// Obrazki leżą w podfolderze `images`, a stan karteczek na pulpicie (pozycja, „na wierzchu”)
// jest zapisywany lokalnie, bo układ pulpitu różni się między komputerami.

mod attach;
mod store;

use attach::Geom;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use store::{Note, SaveResult};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_opener::OpenerExt;

const COLORS: [&str; 9] = ["default", "red", "orange", "yellow", "green", "teal", "blue", "purple", "pink"];

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct Settings {
    data_dir: Option<String>,
    #[serde(default)]
    first_run_done: bool,
    /// Kolor, w którym startuje każda nowa notatka.
    #[serde(default)]
    default_color: Option<String>,
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
    /// Karteczki przypięte na pulpicie.
    stickies: Mutex<HashMap<String, Sticky>>,
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
    last_sticky_write: Mutex<Instant>,
    /// Notatki przypięte do pliku lub folderu: id → (ścieżka, czy folder).
    attached: Mutex<HashMap<String, (String, bool)>>,
    /// Położenie i rozmiar karteczek przy plikach.
    attach_geom: Mutex<HashMap<String, Geom>>,
    /// Karteczki przy plikach widoczne teraz: id → prostokąt okna dokumentu.
    attach_shown: Mutex<HashMap<String, attach::Rect>>,
    /// Karteczki zamknięte krzyżykiem: id → okno, przy którym je zamknięto (wrócą przy kolejnym otwarciu).
    attach_dismissed: Mutex<HashMap<String, isize>>,
    current_target: Mutex<isize>,
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

fn load_json<T: for<'de> Deserialize<'de> + Default>(path: &Path) -> T {
    std::fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn save_json<T: Serialize>(path: &Path, value: &T) {
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
    let g = state.attach_geom.lock().unwrap().clone();
    save_json(&config_dir(app).join("karteczki-przy-plikach.json"), &g);
}

// ---------- polecenia dla interfejsu ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Info {
    data_dir: String,
    backup_dir: String,
    version: String,
    default_color: String,
    /// Czy ten system potrafi pokazywać karteczki przy plikach (tylko Windows).
    attach_supported: bool,
}

#[tauri::command]
fn get_info(app: AppHandle, state: State<AppState>) -> Info {
    Info {
        data_dir: data_dir(&state).to_string_lossy().into(),
        backup_dir: backup_dir(&app).to_string_lossy().into(),
        version: app.package_info().version.to_string(),
        default_color: state.settings.lock().unwrap().default_color.clone().unwrap_or_else(|| "default".into()),
        attach_supported: cfg!(windows),
    }
}

#[tauri::command]
fn set_default_color(app: AppHandle, state: State<AppState>, color: String) -> Result<(), String> {
    if !COLORS.contains(&color.as_str()) {
        return Err("Nieznany kolor".into());
    }
    state.settings.lock().unwrap().default_color = Some(color);
    save_settings(&app, &state);
    Ok(())
}

#[tauri::command]
fn list_notes(state: State<AppState>) -> Result<Vec<Note>, String> {
    store::list(&data_dir(&state)).map_err(|e| e.to_string())
}

// Polecenia, które tworzą, pokazują lub zamykają okna, są asynchroniczne: w Windows
// tworzenie okna w zwykłym (synchronicznym) poleceniu zawiesza aplikację.
#[tauri::command]
async fn save_note(app: AppHandle, note: Note, base_updated_at: i64) -> Result<SaveResult, String> {
    let state = app.state::<AppState>();
    let result = store::save(&data_dir(&state), note, base_updated_at).map_err(|e| e.to_string())?;
    let _ = app.emit("note-saved", &result.note);
    if let Some(c) = &result.conflict {
        let _ = app.emit("note-saved", c);
    }
    refresh_attachments(&app);
    Ok(result)
}

#[tauri::command]
async fn delete_note(app: AppHandle, id: String) -> Result<(), String> {
    let state = app.state::<AppState>();
    store::delete(&data_dir(&state), &id).map_err(|e| e.to_string())?;
    close_sticky_window(&app, &id);
    let _ = app.emit("note-deleted", &id);
    refresh_attachments(&app);
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
async fn set_data_dir(app: AppHandle, path: String) -> Result<(), String> {
    let state = app.state::<AppState>();
    let p = PathBuf::from(&path);
    std::fs::create_dir_all(p.join("notes")).map_err(|e| e.to_string())?;
    state.settings.lock().unwrap().data_dir = Some(path);
    save_settings(&app, &state);
    start_watcher(&app);
    refresh_attachments(&app);
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

/// Okno karteczki bez ramki. Przesuwanie i zmianę rozmiaru obsługuje sama karteczka.
fn build_sticky(app: &AppHandle, id: &str, visible: bool, on_top: bool, w: u32, h: u32) -> Result<WebviewWindow, String> {
    WebviewWindowBuilder::new(app, sticky_label(id), WebviewUrl::App(format!("index.html#sticky={id}").into()))
        .title("Karteczka")
        .inner_size(w as f64, h as f64)
        .min_inner_size(180.0, 140.0)
        .resizable(true)
        .decorations(false)
        .always_on_top(on_top)
        .skip_taskbar(true)
        .visible(visible)
        .focused(visible)
        .disable_drag_drop_handler()
        .build()
        .map_err(|e| e.to_string())
}

fn open_sticky_window(app: &AppHandle, id: &str) -> Result<(), String> {
    if !store::valid_id(id) {
        return Err("Nieprawidłowy identyfikator".into());
    }
    let state = app.state::<AppState>();
    if state.attached.lock().unwrap().contains_key(id) {
        return Err("Ta notatka jest przypięta do pliku lub folderu i pokazuje się sama przy nim. Odepnij ją, aby przypiąć ją na pulpicie.".into());
    }
    let label = sticky_label(id);
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    let saved = state.stickies.lock().unwrap().get(id).copied();
    let on_top = saved.map(|s| s.on_top).unwrap_or(false);
    let window = build_sticky(app, id, true, on_top, 300, 300)?;
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
    state.attach_shown.lock().unwrap().remove(id);
    save_stickies(app, &state);
    if let Some(w) = app.get_webview_window(&sticky_label(id)) {
        let _ = w.destroy();
    }
}

#[tauri::command]
async fn open_sticky(app: AppHandle, id: String) -> Result<(), String> {
    open_sticky_window(&app, &id)
}

#[tauri::command]
async fn close_sticky(app: AppHandle, id: String) {
    let is_attached = app.state::<AppState>().attached.lock().unwrap().contains_key(&id);
    if is_attached {
        dismiss(&app, &id);
    } else {
        close_sticky_window(&app, &id);
    }
}

#[tauri::command]
fn sticky_on_top(state: State<AppState>, id: String) -> bool {
    state.stickies.lock().unwrap().get(&id).map(|s| s.on_top).unwrap_or(false)
}

#[tauri::command]
async fn set_sticky_on_top(app: AppHandle, id: String, on_top: bool) -> Result<(), String> {
    let state = app.state::<AppState>();
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
async fn show_main(app: AppHandle, id: Option<String>) {
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

/// Krzyżyk na karteczce przy pliku: chowa ją do czasu, aż plik zostanie otwarty ponownie.
#[tauri::command]
async fn dismiss_attached(app: AppHandle, id: String) {
    dismiss(&app, &id);
}

fn dismiss(app: &AppHandle, id: &str) {
    let state = app.state::<AppState>();
    let id = id.to_string();
    let target = *state.current_target.lock().unwrap();
    state.attach_dismissed.lock().unwrap().insert(id.clone(), target);
    state.attach_shown.lock().unwrap().remove(&id);
    if let Some(w) = app.get_webview_window(&sticky_label(&id)) {
        let _ = w.hide();
    }
}

// ---------- karteczki przy plikach i folderach ----------

/// Odświeża listę notatek przypiętych do plików (po zapisie, usunięciu i zmianach z OneDrive).
fn refresh_attachments(app: &AppHandle) {
    let state = app.state::<AppState>();
    let mut fresh: HashMap<String, (String, bool)> = HashMap::new();
    for n in store::list(&data_dir(&state)).unwrap_or_default() {
        let Some(path) = n.attach.filter(|p| !p.trim().is_empty()) else { continue };
        if n.trashed_at.is_some() || n.archived {
            continue;
        }
        let is_dir = Path::new(&path).is_dir();
        fresh.insert(n.id, (path, is_dir));
    }
    let old = std::mem::replace(&mut *state.attached.lock().unwrap(), fresh.clone());
    // Odpięte — zamykamy ich ukryte okna.
    for id in old.keys().filter(|id| !fresh.contains_key(*id)) {
        state.attach_shown.lock().unwrap().remove(id);
        if !state.stickies.lock().unwrap().contains_key(id) {
            if let Some(w) = app.get_webview_window(&sticky_label(id)) {
                let _ = w.destroy();
            }
        }
    }
    // Nowo przypięte do pliku — zdejmujemy je z pulpitu.
    for id in fresh.keys() {
        let on_desktop = state.stickies.lock().unwrap().contains_key(id);
        if on_desktop {
            close_sticky_window(app, id);
        }
    }
}

#[cfg(windows)]
fn show_attached(app: &AppHandle, id: &str, rect: attach::Rect) {
    let state = app.state::<AppState>();
    let stored = state.attach_geom.lock().unwrap().get(id).copied();
    let window = match app.get_webview_window(&sticky_label(id)) {
        Some(w) => w,
        None => match build_sticky(app, id, false, true, 300, 260) {
            Ok(w) => w,
            Err(_) => return,
        },
    };
    // Domyślny rozmiar w pikselach ekranu zależy od skalowania Windows (np. 150%).
    let geom = stored.unwrap_or_else(|| {
        let s = window.scale_factor().unwrap_or(1.0);
        let d = Geom::default();
        Geom { right: (d.right as f64 * s) as i32, top: (d.top as f64 * s) as i32, w: (d.w as f64 * s) as u32, h: (d.h as f64 * s) as u32 }
    });
    state.attach_shown.lock().unwrap().insert(id.to_string(), rect);
    let (x, y) = attach::place(rect, geom);
    let _ = window.set_size(PhysicalSize::new(geom.w, geom.h));
    let _ = window.set_position(PhysicalPosition::new(x, y));
    let _ = window.set_always_on_top(true);
    if let Ok(hwnd) = window.hwnd() {
        attach::win::show_no_activate(hwnd);
    } else {
        let _ = window.show();
    }
}

#[cfg(windows)]
fn spawn_attach_loop(app: AppHandle) {
    std::thread::spawn(move || {
        attach::win::init_com();
        let my_pid = std::process::id();
        let mut last = attach::Target::default();
        loop {
            std::thread::sleep(Duration::from_millis(350));
            let state = app.state::<AppState>();
            let attached = state.attached.lock().unwrap().clone();
            if attached.is_empty() {
                continue;
            }
            let Some((hwnd, pid)) = attach::win::foreground() else { continue };
            // Kliknięcie w karteczkę lub okno Karteczek niczego nie zmienia.
            if pid == my_pid {
                continue;
            }
            let (title, class, rect) = attach::win::describe(hwnd);
            if hwnd != last.hwnd || title != last.title {
                let folder = if class == attach::EXPLORER_CLASS { attach::win::explorer_folder(hwnd, &title) } else { None };
                last = attach::Target { hwnd, title, class, folder, rect };
            } else {
                last.rect = rect;
            }
            *state.current_target.lock().unwrap() = hwnd;
            state.attach_dismissed.lock().unwrap().retain(|_, h| *h == hwnd);
            let dismissed = state.attach_dismissed.lock().unwrap().clone();
            for (id, (path, is_dir)) in &attached {
                let want = !dismissed.contains_key(id) && attach::matches(path, *is_dir, &last);
                let shown = state.attach_shown.lock().unwrap().get(id).copied();
                match (want, shown) {
                    (true, None) => show_attached(&app, id, last.rect),
                    // Okno dokumentu przesunięte — karteczka idzie za nim.
                    (true, Some(r)) if r != last.rect => show_attached(&app, id, last.rect),
                    (false, Some(_)) => {
                        state.attach_shown.lock().unwrap().remove(id);
                        if let Some(w) = app.get_webview_window(&sticky_label(id)) {
                            let _ = w.hide();
                        }
                    }
                    _ => {}
                }
            }
        }
    });
}

#[cfg(not(windows))]
fn spawn_attach_loop(_app: AppHandle) {}

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
            refresh_attachments(&handle);
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

fn persist_soon(app: &AppHandle, state: &AppState) {
    let mut last = state.last_sticky_write.lock().unwrap();
    if last.elapsed() > Duration::from_millis(500) {
        *last = Instant::now();
        drop(last);
        save_stickies(app, state);
    }
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
            let geom: HashMap<String, Geom> = load_json(&config_dir(&handle).join("karteczki-przy-plikach.json"));
            app.manage(AppState {
                settings: Mutex::new(settings),
                stickies: Mutex::new(stickies),
                watcher: Mutex::new(None),
                last_sticky_write: Mutex::new(Instant::now()),
                attached: Mutex::new(HashMap::new()),
                attach_geom: Mutex::new(geom),
                attach_shown: Mutex::new(HashMap::new()),
                attach_dismissed: Mutex::new(HashMap::new()),
                current_target: Mutex::new(0),
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

            refresh_attachments(&handle);
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
            spawn_attach_loop(handle.clone());
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
                    // Zamknięcie głównego okna kończy aplikację; karteczki z pulpitu wrócą przy następnym starcie.
                    save_stickies(app, &state);
                    app.exit(0);
                }
                return;
            }
            let Some(id) = label.strip_prefix("note-").map(str::to_string) else { return };
            let attached_rect = state.attach_shown.lock().unwrap().get(&id).copied();
            match event {
                WindowEvent::Moved(pos) => {
                    // Okno zminimalizowane w Windows ma pozycję (-32000, -32000) — nie zapisujemy jej.
                    if pos.x <= -10000 || pos.y <= -10000 {
                        return;
                    }
                    if let Some(s) = state.stickies.lock().unwrap().get_mut(&id) {
                        s.x = pos.x;
                        s.y = pos.y;
                    } else if let Some((_, t, r, _)) = attached_rect {
                        let mut g = state.attach_geom.lock().unwrap();
                        let e = g.entry(id).or_default();
                        e.right = r - pos.x;
                        e.top = pos.y - t;
                    }
                }
                WindowEvent::Resized(size) => {
                    if size.width == 0 || size.height == 0 {
                        return;
                    }
                    if let Some(s) = state.stickies.lock().unwrap().get_mut(&id) {
                        s.w = size.width;
                        s.h = size.height;
                    } else if attached_rect.is_some() {
                        let mut g = state.attach_geom.lock().unwrap();
                        let e = g.entry(id).or_default();
                        e.w = size.width;
                        e.h = size.height;
                    }
                }
                WindowEvent::Focused(false) => {
                    save_stickies(app, &state);
                    return;
                }
                _ => return,
            }
            persist_soon(app, &state);
        })
        .invoke_handler(tauri::generate_handler![
            get_info,
            set_default_color,
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
            is_sticky_open,
            dismiss_attached
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
