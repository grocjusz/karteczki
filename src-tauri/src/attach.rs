#![cfg_attr(not(windows), allow(dead_code))]
// Karteczki przypięte do pliku lub folderu.
// Co chwilę sprawdzamy, które okno jest na pierwszym planie (Word, PDF, Eksplorator…).
// Gdy pokazuje przypięty plik lub folder, karteczka wyskakuje przy tym oknie,
// a gdy użytkownik przejdzie gdzie indziej — chowa się.

use serde::{Deserialize, Serialize};

/// Położenie karteczki względem prawego górnego rogu okna dokumentu.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Geom {
    /// Odległość lewej krawędzi karteczki od prawej krawędzi okna.
    pub right: i32,
    /// Odległość górnej krawędzi karteczki od górnej krawędzi okna.
    pub top: i32,
    pub w: u32,
    pub h: u32,
}

impl Default for Geom {
    fn default() -> Self {
        Geom { right: 324, top: 96, w: 300, h: 260 }
    }
}

/// Prostokąt okna: lewo, góra, prawo, dół.
pub type Rect = (i32, i32, i32, i32);

#[derive(Default, Clone, Debug, PartialEq)]
pub struct Target {
    pub hwnd: isize,
    pub title: String,
    pub class: String,
    /// Folder pokazany w oknie Eksploratora (jeśli to Eksplorator).
    pub folder: Option<String>,
    pub rect: Rect,
}

pub const EXPLORER_CLASS: &str = "CabinetWClass";

/// Ostatni człon ścieżki (działa dla ścieżek Windows także w testach na innym systemie).
pub fn last_segment(path: &str) -> &str {
    path.trim_end_matches(['\\', '/']).rsplit(['\\', '/']).next().unwrap_or(path)
}

fn norm(p: &str) -> String {
    p.trim().trim_end_matches(['\\', '/']).replace('/', "\\").to_lowercase()
}

/// Część tytułu okna przed nazwą programu, np. „Raport.docx - Word” → „raport.docx”.
/// Dla Eksploratora z kartami usuwa dopisek „i 2 inne karty”.
pub fn title_main(title: &str) -> String {
    let t = title.trim().trim_start_matches(['*', '●', ' ']);
    let main = match t.rfind(" - ").or_else(|| t.rfind(" — ")).or_else(|| t.rfind(" – ")) {
        Some(i) => &t[..i],
        None => t,
    };
    let mut main = main.trim().to_lowercase();
    for (sep, ends) in [(" i ", ["karta", "karty", "kart"]), (" and ", ["tab", "tabs", "tab"])] {
        if let Some(i) = main.rfind(sep) {
            if ends.iter().any(|e| main.ends_with(e)) && main[i + sep.len()..].starts_with(|c: char| c.is_ascii_digit()) {
                main.truncate(i);
            }
        }
    }
    main
}

/// Czy okno na pierwszym planie pokazuje przypięty plik lub folder.
pub fn matches(attach: &str, is_dir: bool, t: &Target) -> bool {
    let name = last_segment(attach).to_lowercase();
    if name.is_empty() {
        return false;
    }
    if is_dir {
        if t.class != EXPLORER_CLASS {
            return false;
        }
        return match &t.folder {
            Some(f) => norm(f) == norm(attach),
            None => title_main(&t.title) == name,
        };
    }
    if t.class == EXPLORER_CLASS {
        return false;
    }
    let title = t.title.trim().trim_start_matches(['*', '●', ' ']).to_lowercase();
    if title.contains(&name) {
        return true;
    }
    // Wiele programów pokazuje nazwę bez rozszerzenia: „Raport - Word”, „Raport [Tryb zgodności] - Word”.
    let stem = match name.rfind('.') {
        Some(i) if i > 0 => &name[..i],
        _ => name.as_str(),
    };
    if stem.chars().count() < 2 || !title.starts_with(stem) {
        return false;
    }
    match title[stem.len()..].chars().next() {
        None => true,
        Some(c) => matches!(c, ' ' | '.' | '[' | '(' | '-' | '–' | '—' | ':'),
    }
}

/// „file:///C:/Users/Jan/Moje%20dokumenty” → „C:\Users\Jan\Moje dokumenty”.
pub fn file_url_to_path(url: &str) -> Option<String> {
    let rest = url.strip_prefix("file:///").map(|r| (r, false)).or_else(|| url.strip_prefix("file://").map(|r| (r, true)))?;
    let (rest, unc) = rest;
    let bytes = rest.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(b) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    let path = String::from_utf8(out).ok()?.replace('/', "\\");
    Some(if unc { format!("\\\\{path}") } else { path })
}

/// Pozycja karteczki przy oknie dokumentu, tak żeby nie wychodziła poza to okno.
pub fn place(rect: Rect, g: Geom) -> (i32, i32) {
    let (l, t, r, b) = rect;
    let x = (r - g.right).min(r - g.w as i32).max(l);
    let y = (t + g.top).min(b - g.h as i32).max(t);
    (x, y)
}

#[cfg(windows)]
pub mod win {
    use super::{last_segment, title_main, Rect};
    use windows::core::{IUnknown, Interface};
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_APARTMENTTHREADED};
    use windows::Win32::System::Variant::{VARIANT, VT_I4};
    use windows::Win32::UI::Shell::{IShellWindows, IWebBrowser2, ShellWindows};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetClassNameW, GetForegroundWindow, GetWindowRect, GetWindowTextW, GetWindowThreadProcessId, ShowWindow,
        SW_SHOWNOACTIVATE,
    };

    pub fn init_com() {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        }
    }

    /// Okno na pierwszym planie i identyfikator procesu, do którego należy.
    pub fn foreground() -> Option<(isize, u32)> {
        unsafe {
            let h = GetForegroundWindow();
            if h.0.is_null() {
                return None;
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(h, Some(&mut pid as *mut u32));
            Some((h.0 as isize, pid))
        }
    }

    pub fn describe(hwnd: isize) -> (String, String, Rect) {
        unsafe {
            let h = HWND(hwnd as *mut core::ffi::c_void);
            let mut buf = [0u16; 512];
            let n = GetWindowTextW(h, &mut buf).max(0) as usize;
            let title = String::from_utf16_lossy(&buf[..n.min(buf.len())]);
            let mut cbuf = [0u16; 256];
            let n = GetClassNameW(h, &mut cbuf).max(0) as usize;
            let class = String::from_utf16_lossy(&cbuf[..n.min(cbuf.len())]);
            let mut r = RECT::default();
            let _ = GetWindowRect(h, &mut r);
            (title, class, (r.left, r.top, r.right, r.bottom))
        }
    }

    /// Folder otwarty w oknie Eksploratora (przy kilku kartach — ta, której nazwa jest w tytule).
    pub fn explorer_folder(hwnd: isize, title: &str) -> Option<String> {
        unsafe {
            let sw: IShellWindows = CoCreateInstance(&ShellWindows, None::<&IUnknown>, CLSCTX_ALL).ok()?;
            let count = sw.Count().ok()?;
            let mut found: Vec<String> = Vec::new();
            for i in 0..count {
                let mut v = VARIANT::default();
                (*v.Anonymous.Anonymous).vt = VT_I4;
                (*v.Anonymous.Anonymous).Anonymous.lVal = i;
                let Ok(disp) = sw.Item(&v) else { continue };
                let Ok(wb) = disp.cast::<IWebBrowser2>() else { continue };
                let Ok(h) = wb.HWND() else { continue };
                if h.0 != hwnd {
                    continue;
                }
                let Ok(url) = wb.LocationURL() else { continue };
                if let Some(p) = super::file_url_to_path(&url.to_string()) {
                    found.push(p);
                }
            }
            if found.len() <= 1 {
                return found.pop();
            }
            let main = title_main(title);
            found.iter().find(|p| last_segment(p).to_lowercase() == main).cloned().or_else(|| found.into_iter().next())
        }
    }

    /// Pokazuje okno bez zabierania fokusu oknu dokumentu.
    pub fn show_no_activate(hwnd: HWND) {
        unsafe {
            let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(title: &str, class: &str, folder: Option<&str>) -> Target {
        Target { hwnd: 1, title: title.into(), class: class.into(), folder: folder.map(Into::into), rect: (0, 0, 800, 600) }
    }

    #[test]
    fn file_in_office_and_pdf_titles() {
        let p = r"C:\Users\Jan\OneDrive\Klienci\Raport roczny.docx";
        assert!(matches(p, false, &t("Raport roczny.docx - Word", "OpusApp", None)));
        assert!(matches(p, false, &t("Raport roczny - Word", "OpusApp", None)));
        assert!(matches(p, false, &t("Raport roczny  [Tryb zgodności] - Word", "OpusApp", None)));
        assert!(!matches(p, false, &t("Raport - Word", "OpusApp", None)));
        assert!(!matches(p, false, &t("Raport roczny", EXPLORER_CLASS, None)));
        let pdf = r"D:\faktura-12.pdf";
        assert!(matches(pdf, false, &t("faktura-12.pdf - Adobe Acrobat Reader (64-bit)", "AcrobatSDIWindow", None)));
        assert!(matches(pdf, false, &t("*faktura-12.pdf – Notatnik", "Notepad", None)));
        assert!(!matches(pdf, false, &t("faktura-13.pdf - Adobe Acrobat Reader", "AcrobatSDIWindow", None)));
    }

    #[test]
    fn folder_in_explorer() {
        let d = r"C:\Users\Jan\Dokumenty\Klienci";
        assert!(matches(d, true, &t("Klienci - Eksplorator plików", EXPLORER_CLASS, Some(r"C:\Users\Jan\Dokumenty\Klienci\"))));
        assert!(!matches(d, true, &t("Klienci - Eksplorator plików", EXPLORER_CLASS, Some(r"D:\Inne\Klienci"))));
        // Bez odczytu ścieżki — porównanie z tytułem okna (także z kartami).
        assert!(matches(d, true, &t("Klienci i 2 inne karty - Eksplorator plików", EXPLORER_CLASS, None)));
        assert!(matches(d, true, &t("Klienci and 1 more tab - File Explorer", EXPLORER_CLASS, None)));
        assert!(!matches(d, true, &t("Klienci - Word", "OpusApp", None)));
    }

    #[test]
    fn urls_and_placement() {
        assert_eq!(file_url_to_path("file:///C:/Users/Jan/Moje%20dokumenty").as_deref(), Some(r"C:\Users\Jan\Moje dokumenty"));
        assert_eq!(file_url_to_path("file:///C:/Zażółć").as_deref(), Some(r"C:\Zażółć"));
        assert_eq!(file_url_to_path("file:///C:/Za%C5%BC%C3%B3%C5%82%C4%87").as_deref(), Some(r"C:\Zażółć"));
        assert_eq!(file_url_to_path("file://serwer/udzial/a").as_deref(), Some(r"\\serwer\udzial\a"));
        assert_eq!(file_url_to_path("::{20D04FE0}"), None);
        assert_eq!(last_segment(r"C:\a\b\"), "b");
        let g = Geom::default();
        assert_eq!(place((0, 0, 1000, 800), g), (676, 96));
        // Małe okno: karteczka zostaje w jego granicach.
        assert_eq!(place((100, 100, 300, 250), g), (100, 100));
    }
}
