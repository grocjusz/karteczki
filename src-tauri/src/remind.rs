// Przypomnienia o notatkach — jak w Google Keep: jednorazowe albo powtarzane
// codziennie, co tydzień, co miesiąc lub co rok. Terminy liczymy w czasie lokalnym,
// więc zmiana czasu (letni/zimowy) nie przesuwa godziny przypomnienia.

use chrono::{DateTime, Days, Local, Months, TimeZone};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum Repeat {
    #[default]
    None,
    Daily,
    Weekly,
    Monthly,
    Yearly,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Reminder {
    /// Pierwszy termin (milisekundy od 1970-01-01 UTC).
    pub at: i64,
    #[serde(default)]
    pub repeat: Repeat,
}

fn local(ms: i64) -> Option<DateTime<Local>> {
    Local.timestamp_millis_opt(ms).earliest()
}

/// Termin numer `n` (0 = pierwszy).
pub fn nth(r: &Reminder, n: u64) -> Option<i64> {
    if n == 0 {
        return Some(r.at);
    }
    let base = local(r.at)?;
    let dt = match r.repeat {
        Repeat::None => return None,
        Repeat::Daily => base.checked_add_days(Days::new(n))?,
        Repeat::Weekly => base.checked_add_days(Days::new(n.checked_mul(7)?))?,
        Repeat::Monthly => base.checked_add_months(Months::new(u32::try_from(n).ok()?))?,
        Repeat::Yearly => base.checked_add_months(Months::new(u32::try_from(n.checked_mul(12)?).ok()?))?,
    };
    Some(dt.timestamp_millis())
}

/// Przybliżony numer terminu w chwili `now` — punkt startowy do dokładnego szukania.
fn estimate(r: &Reminder, now: i64) -> u64 {
    let day = 86_400_000i64;
    let diff = (now - r.at).max(0);
    let n = match r.repeat {
        Repeat::None => 0,
        Repeat::Daily => diff / day,
        Repeat::Weekly => diff / (7 * day),
        Repeat::Monthly => diff / (30 * day),
        Repeat::Yearly => diff / (365 * day),
    };
    (n.max(1) - 1) as u64
}

/// Ostatni termin, który już minął (≤ now), albo None, gdy pierwszy termin jest jeszcze przed nami.
pub fn last_due(r: &Reminder, now: i64) -> Option<i64> {
    if r.at > now {
        return None;
    }
    if r.repeat == Repeat::None {
        return Some(r.at);
    }
    let mut n = estimate(r, now);
    while n > 0 && nth(r, n).map_or(true, |t| t > now) {
        n -= 1;
    }
    while let Some(t) = nth(r, n + 1) {
        if t > now {
            break;
        }
        n += 1;
    }
    nth(r, n)
}

#[allow(dead_code)]
/// Najbliższy przyszły termin (> now), albo None, gdy jednorazowe przypomnienie już minęło.
pub fn next_after(r: &Reminder, now: i64) -> Option<i64> {
    if r.at > now {
        return Some(r.at);
    }
    if r.repeat == Repeat::None {
        return None;
    }
    let due = last_due(r, now)?;
    let mut n = estimate(r, due);
    while nth(r, n).map_or(false, |t| t <= due) {
        n += 1;
    }
    nth(r, n)
}

/// Czy przypomnienie trzeba teraz pokazać. `fired` — ostatni pokazany termin na tym komputerze.
/// Terminy starsze niż tydzień pomijamy (np. komputer był długo wyłączony).
pub fn should_fire(r: &Reminder, now: i64, fired: Option<i64>) -> Option<i64> {
    let due = last_due(r, now)?;
    if fired.is_some_and(|f| f >= due) {
        return None;
    }
    if now - due > 7 * 86_400_000 {
        return None;
    }
    Some(due)
}

/// Krótki tekst notatki do powiadomienia (bez znaczników HTML).
pub fn snippet(html: &str, max: usize) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for c in html.replace("</p>", " ").replace("</li>", " ").replace("<br>", " ").chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    let text = out
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if text.chars().count() > max {
        format!("{}…", text.chars().take(max).collect::<String>().trim_end())
    } else {
        text
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Datelike, Timelike};

    fn ms(y: i32, m: u32, d: u32, h: u32, min: u32) -> i64 {
        Local.with_ymd_and_hms(y, m, d, h, min, 0).earliest().unwrap().timestamp_millis()
    }

    #[test]
    fn one_time() {
        let r = Reminder { at: ms(2026, 10, 20, 9, 0), repeat: Repeat::None };
        assert_eq!(last_due(&r, ms(2026, 10, 19, 9, 0)), None);
        assert_eq!(next_after(&r, ms(2026, 10, 19, 9, 0)), Some(r.at));
        assert_eq!(last_due(&r, ms(2026, 10, 21, 9, 0)), Some(r.at));
        assert_eq!(next_after(&r, ms(2026, 10, 21, 9, 0)), None);
    }

    #[test]
    fn daily_keeps_local_hour_across_dst() {
        // W Polsce czas zimowy zaczyna się w ostatnią niedzielę października.
        let r = Reminder { at: ms(2026, 10, 20, 8, 30), repeat: Repeat::Daily };
        let next = next_after(&r, ms(2026, 11, 2, 12, 0)).unwrap();
        let dt = local(next).unwrap();
        assert_eq!((dt.month(), dt.day(), dt.hour(), dt.minute()), (11, 3, 8, 30));
        assert_eq!(last_due(&r, ms(2026, 11, 2, 12, 0)), Some(ms(2026, 11, 2, 8, 30)));
    }

    #[test]
    fn weekly_monthly_yearly() {
        let w = Reminder { at: ms(2026, 1, 5, 10, 0), repeat: Repeat::Weekly };
        assert_eq!(next_after(&w, ms(2026, 1, 13, 0, 0)), Some(ms(2026, 1, 19, 10, 0)));
        // 31 stycznia → luty skrócony do 28, ale marzec wraca na 31.
        let m = Reminder { at: ms(2026, 1, 31, 9, 0), repeat: Repeat::Monthly };
        assert_eq!(next_after(&m, ms(2026, 2, 1, 0, 0)), Some(ms(2026, 2, 28, 9, 0)));
        assert_eq!(next_after(&m, ms(2026, 3, 1, 0, 0)), Some(ms(2026, 3, 31, 9, 0)));
        let y = Reminder { at: ms(2020, 5, 10, 7, 0), repeat: Repeat::Yearly };
        assert_eq!(last_due(&y, ms(2026, 10, 18, 0, 0)), Some(ms(2026, 5, 10, 7, 0)));
        assert_eq!(next_after(&y, ms(2026, 10, 18, 0, 0)), Some(ms(2027, 5, 10, 7, 0)));
        // Bardzo stare codzienne przypomnienie — szybko i dokładnie.
        let d = Reminder { at: ms(2000, 1, 1, 6, 0), repeat: Repeat::Daily };
        assert_eq!(last_due(&d, ms(2026, 10, 18, 7, 0)), Some(ms(2026, 10, 18, 6, 0)));
    }

    #[test]
    fn firing_rules() {
        let r = Reminder { at: ms(2026, 10, 18, 9, 0), repeat: Repeat::Daily };
        let now = ms(2026, 10, 18, 9, 1);
        assert_eq!(should_fire(&r, now, None), Some(r.at));
        assert_eq!(should_fire(&r, now, Some(r.at)), None);
        assert_eq!(should_fire(&r, ms(2026, 10, 19, 9, 0), Some(r.at)), Some(ms(2026, 10, 19, 9, 0)));
        let old = Reminder { at: ms(2026, 9, 1, 9, 0), repeat: Repeat::None };
        assert_eq!(should_fire(&old, now, None), None);
        let json = r#"{"at":1,"repeat":"weekly"}"#;
        assert_eq!(serde_json::from_str::<Reminder>(json).unwrap().repeat, Repeat::Weekly);
        assert_eq!(serde_json::from_str::<Reminder>(r#"{"at":1}"#).unwrap().repeat, Repeat::None);
    }

    #[test]
    fn snippet_text() {
        assert_eq!(snippet("<p>Zadzwoń&nbsp;do</p><ul><li>Jana</li></ul>", 50), "Zadzwoń do Jana");
        assert_eq!(snippet("<p>abcdefghij</p>", 5), "abcde…");
    }
}
