// Przechowywanie notatek: jeden plik JSON na notatkę, obrazki w osobnym folderze.
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

fn default_color() -> String {
    "default".into()
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub html: String,
    #[serde(default = "default_color")]
    pub color: String,
    #[serde(default)]
    pub archived: bool,
    #[serde(default)]
    pub trashed_at: Option<i64>,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    pub note: Note,
    /// Zmiana zapisana równolegle na innym komputerze: Twoja wersja trafia do osobnej notatki.
    pub conflict: Option<Note>,
}

pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 80 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn valid_image_name(name: &str) -> bool {
    let mut parts = name.rsplitn(2, '.');
    let ext = parts.next().unwrap_or("");
    let stem = parts.next().unwrap_or("");
    valid_id(stem) && mime_for(ext).is_some()
}

fn mime_for(ext: &str) -> Option<&'static str> {
    match ext {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        _ => None,
    }
}

pub fn notes_dir(root: &Path) -> PathBuf {
    root.join("notes")
}

pub fn images_dir(root: &Path) -> PathBuf {
    root.join("images")
}

/// Zapis przez plik tymczasowy i zmianę nazwy: przerwanie zapisu nie zostawia uszkodzonej notatki.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("tmp");
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path)
}

fn read_note(path: &Path) -> Option<Note> {
    let mut stem = path.file_stem()?.to_string_lossy().to_string();
    let mut path = path.to_path_buf();
    if !valid_id(&stem) {
        // Np. kopia OneDrive „abc-Mój Laptop.json” — nadajemy jej bezpieczną nazwę, żeby nie zniknęła.
        let fixed: String = stem
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
            .take(80)
            .collect();
        let target = path.with_file_name(format!("{fixed}.json"));
        if fixed.is_empty() || target.exists() || fs::rename(&path, &target).is_err() {
            return None;
        }
        stem = fixed;
        path = target;
    }
    let bytes = fs::read(&path).ok()?;
    let mut note: Note = serde_json::from_slice(&bytes).ok()?;
    // Identyfikatorem jest nazwa pliku. Kopia konfliktu utworzona przez OneDrive
    // (np. „abc-DELL.json”) staje się więc osobną, widoczną notatką.
    note.id = stem;
    Some(note)
}

pub fn list(root: &Path) -> io::Result<Vec<Note>> {
    let dir = notes_dir(root);
    fs::create_dir_all(&dir)?;
    let mut notes: Vec<Note> = fs::read_dir(&dir)?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().map(|e| e == "json").unwrap_or(false))
        .filter_map(|p| read_note(&p))
        .collect();
    notes.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(notes)
}

pub fn save(root: &Path, mut note: Note, base_updated_at: i64) -> io::Result<SaveResult> {
    if !valid_id(&note.id) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "Nieprawidłowy identyfikator notatki"));
    }
    let path = notes_dir(root).join(format!("{}.json", note.id));
    let now = chrono::Utc::now().timestamp_millis();
    if note.created_at == 0 {
        note.created_at = now;
    }
    note.updated_at = now.max(note.updated_at);
    if base_updated_at > 0 {
        if let Some(disk) = read_note(&path) {
            if disk.updated_at > base_updated_at {
                // Ktoś zmienił tę notatkę na innym komputerze, zanim zapisaliśmy naszą wersję.
                // Nie nadpisujemy jej — nasza wersja staje się nową notatką.
                let mut copy = note.clone();
                let stem = note.id.split("-konflikt-").next().unwrap_or(&note.id);
                copy.id = format!("{stem}-konflikt-{now}");
                copy.title = if note.title.trim().is_empty() {
                    "Konflikt zmian".into()
                } else {
                    format!("{} (konflikt zmian)", note.title)
                };
                let copy_path = notes_dir(root).join(format!("{}.json", copy.id));
                write_atomic(&copy_path, &serde_json::to_vec_pretty(&copy)?)?;
                return Ok(SaveResult { note: disk, conflict: Some(copy) });
            }
        }
    }
    write_atomic(&path, &serde_json::to_vec_pretty(&note)?)?;
    Ok(SaveResult { note, conflict: None })
}

pub fn image_refs(html: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = html;
    while let Some(i) = rest.find("data-img=\"") {
        rest = &rest[i + 10..];
        if let Some(end) = rest.find('"') {
            out.push(rest[..end].to_string());
            rest = &rest[end..];
        } else {
            break;
        }
    }
    out
}

pub fn delete(root: &Path, id: &str) -> io::Result<()> {
    if !valid_id(id) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "Nieprawidłowy identyfikator notatki"));
    }
    let path = notes_dir(root).join(format!("{id}.json"));
    let removed: Vec<String> = read_note(&path).map(|n| image_refs(&n.html)).unwrap_or_default();
    if path.exists() {
        fs::remove_file(&path)?;
    }
    // Usuwamy obrazki, których nie używa już żadna inna notatka.
    let still_used: HashSet<String> = list(root)?.iter().flat_map(|n| image_refs(&n.html)).collect();
    for name in removed {
        if valid_image_name(&name) && !still_used.contains(&name) {
            let _ = fs::remove_file(images_dir(root).join(&name));
        }
    }
    Ok(())
}

pub fn save_image(root: &Path, bytes: &[u8], ext: &str) -> io::Result<String> {
    let ext = if ext == "jpeg" { "jpg" } else { ext };
    if mime_for(ext).is_none() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "Nieobsługiwany format obrazka"));
    }
    if bytes.len() > 25 * 1024 * 1024 {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "Obrazek jest większy niż 25 MB"));
    }
    let name = format!("{}.{ext}", uuid::Uuid::new_v4().simple());
    write_atomic(&images_dir(root).join(&name), bytes)?;
    Ok(name)
}

pub fn read_image(root: &Path, name: &str) -> Option<(Vec<u8>, &'static str)> {
    if !valid_image_name(name) {
        return None;
    }
    let ext = name.rsplit('.').next()?;
    let bytes = fs::read(images_dir(root).join(name)).ok()?;
    Some((bytes, mime_for(ext)?))
}

/// Trwale usuwa notatki, które leżą w koszu dłużej niż `days` dni.
pub fn purge_trash(root: &Path, now_ms: i64, days: i64) -> io::Result<usize> {
    let limit = now_ms - days * 86_400_000;
    let mut count = 0;
    for note in list(root)? {
        if matches!(note.trashed_at, Some(t) if t < limit) {
            delete(root, &note.id)?;
            count += 1;
        }
    }
    Ok(count)
}

/// Raz dziennie pakuje notatki i obrazki do pliku ZIP; zostawia `keep` najnowszych kopii.
pub fn daily_backup(root: &Path, backups: &Path, day: &str, keep: usize) -> io::Result<Option<PathBuf>> {
    fs::create_dir_all(backups)?;
    let target = backups.join(format!("karteczki-{day}.zip"));
    let mut created = None;
    if !target.exists() {
        let tmp = target.with_extension("tmp");
        {
            let file = fs::File::create(&tmp)?;
            let mut zip = zip::ZipWriter::new(file);
            let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
            for (folder, dir) in [("notes", notes_dir(root)), ("images", images_dir(root))] {
                let Ok(entries) = fs::read_dir(&dir) else { continue };
                for entry in entries.filter_map(|e| e.ok()) {
                    let path = entry.path();
                    if !path.is_file() || path.extension().map(|e| e == "tmp").unwrap_or(false) {
                        continue;
                    }
                    let name = format!("{folder}/{}", entry.file_name().to_string_lossy());
                    zip.start_file(name, options).map_err(io::Error::other)?;
                    zip.write_all(&fs::read(&path)?)?;
                }
            }
            zip.finish().map_err(io::Error::other)?;
        }
        fs::rename(&tmp, &target)?;
        created = Some(target);
    }
    let mut all: Vec<PathBuf> = fs::read_dir(backups)?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with("karteczki-") && n.ends_with(".zip"))
                .unwrap_or(false)
        })
        .collect();
    all.sort();
    while all.len() > keep {
        let _ = fs::remove_file(all.remove(0));
    }
    Ok(created)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let p = std::env::temp_dir().join(format!("karteczki-test-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn note(id: &str) -> Note {
        Note { id: id.into(), title: "T".into(), html: "<p>x</p>".into(), color: "default".into(), archived: false, trashed_at: None, created_at: 0, updated_at: 0 }
    }

    #[test]
    fn save_and_list() {
        let root = tmp();
        let saved = save(&root, note("a1"), 0).unwrap();
        assert!(saved.conflict.is_none());
        let all = list(&root).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, "a1");
        assert!(all[0].created_at > 0);
    }

    #[test]
    fn conflict_keeps_both_versions() {
        let root = tmp();
        let first = save(&root, note("a1"), 0).unwrap().note;
        // Inny komputer zapisał nowszą wersję.
        let mut other = first.clone();
        other.html = "<p>z innego komputera</p>".into();
        other.updated_at = first.updated_at + 10_000;
        write_atomic(&notes_dir(&root).join("a1.json"), &serde_json::to_vec(&other).unwrap()).unwrap();
        let mut mine = first.clone();
        mine.html = "<p>moja</p>".into();
        let r = save(&root, mine, first.updated_at).unwrap();
        assert!(r.conflict.is_some());
        assert_eq!(r.note.html, "<p>z innego komputera</p>");
        assert_eq!(list(&root).unwrap().len(), 2);
    }

    #[test]
    fn onedrive_copy_becomes_separate_note() {
        let root = tmp();
        save(&root, note("a1"), 0).unwrap();
        fs::copy(notes_dir(&root).join("a1.json"), notes_dir(&root).join("a1-DELL.json")).unwrap();
        let ids: Vec<String> = list(&root).unwrap().into_iter().map(|n| n.id).collect();
        assert!(ids.contains(&"a1".to_string()) && ids.contains(&"a1-DELL".to_string()));
    }

    #[test]
    fn rejects_bad_ids_and_paths() {
        let root = tmp();
        assert!(save(&root, note("../x"), 0).is_err());
        assert!(read_image(&root, "../secret.png").is_none());
        assert!(read_image(&root, "a.exe").is_none());
    }

    #[test]
    fn images_removed_with_last_note() {
        let root = tmp();
        let name = save_image(&root, b"\x89PNG", "png").unwrap();
        let mut n = note("a1");
        n.html = format!("<p><img data-img=\"{name}\"></p>");
        save(&root, n.clone(), 0).unwrap();
        let mut n2 = n.clone();
        n2.id = "a2".into();
        save(&root, n2, 0).unwrap();
        delete(&root, "a1").unwrap();
        assert!(read_image(&root, &name).is_some(), "obrazek nadal używany przez a2");
        delete(&root, "a2").unwrap();
        assert!(read_image(&root, &name).is_none());
    }

    #[test]
    fn trash_purged_after_30_days() {
        let root = tmp();
        let mut n = note("old");
        n.trashed_at = Some(1_000);
        save(&root, n, 0).unwrap();
        let mut fresh = note("fresh");
        fresh.trashed_at = Some(40 * 86_400_000);
        save(&root, fresh, 0).unwrap();
        assert_eq!(purge_trash(&root, 40 * 86_400_000, 30).unwrap(), 1);
        assert_eq!(list(&root).unwrap().len(), 1);
    }

    #[test]
    fn backup_once_per_day_keeps_14() {
        let root = tmp();
        let backups = root.join("kopie");
        save(&root, note("a1"), 0).unwrap();
        for d in 1..=16 {
            daily_backup(&root, &backups, &format!("2026-10-{d:02}"), 14).unwrap();
        }
        assert!(daily_backup(&root, &backups, "2026-10-16", 14).unwrap().is_none());
        assert_eq!(fs::read_dir(&backups).unwrap().count(), 14);
    }

    #[test]
    fn onedrive_copy_with_odd_name_stays_visible() {
        let root = tmp();
        fs::create_dir_all(notes_dir(&root)).unwrap();
        let json = serde_json::to_vec(&note("abc")).unwrap();
        fs::write(notes_dir(&root).join("abc-Mój Laptop.json"), json).unwrap();
        let all = list(&root).unwrap();
        assert_eq!(all.len(), 1);
        assert!(valid_id(&all[0].id));
        assert!(notes_dir(&root).join(format!("{}.json", all[0].id)).exists());
    }

    #[test]
    fn repeated_conflicts_keep_short_ids() {
        let root = tmp();
        let first = save(&root, note("abc-konflikt-1700000000000"), 0).unwrap().note;
        let mut other = first.clone();
        other.updated_at = first.updated_at + 10_000;
        write_atomic(&notes_dir(&root).join("abc-konflikt-1700000000000.json"), &serde_json::to_vec(&other).unwrap()).unwrap();
        let r = save(&root, first.clone(), first.updated_at).unwrap();
        let copy = r.conflict.unwrap();
        assert!(copy.id.starts_with("abc-konflikt-"));
        assert_eq!(copy.id.matches("konflikt").count(), 1);
    }
}
