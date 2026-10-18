// Bez okna konsoli w wersji wydanej na Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    karteczki_lib::run()
}
