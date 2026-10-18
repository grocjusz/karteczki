# Karteczki

Szybkie notatki na Windows — w stylu Google Keep i Sticky Notes.

**[Pobierz najnowszą wersję](https://github.com/grocjusz/karteczki/releases/latest)** — plik `Karteczki_…_x64-setup.exe`.

## Instalacja

1. Pobierz instalator z linku powyżej i uruchom go.
2. Windows może pokazać okno „System Windows ochronił komputer” (aplikacja nie ma płatnego podpisu). Kliknij **Więcej informacji**, a potem **Uruchom mimo to**.
3. Karteczki pojawią się w menu Start. Przypnij je do paska zadań: prawy przycisk myszy → **Przypnij do paska zadań**.

Nowe wersje: Karteczki same sprawdzają, czy jest aktualizacja, i pokazują przycisk **Pobierz**. Nową wersję instaluje się na starą — notatki zostają.

## Co potrafią

- Notatki jako kolorowe karty, wyszukiwanie (bez względu na polskie znaki), archiwum i kosz (notatki z kosza znikają po 30 dniach).
- Formatowanie: pogrubienie, kursywa, podkreślenie, nagłówki, listy, **listy zadań do odhaczania**, klikalne linki (Ctrl+klik w edycji), obrazki (wklej, przeciągnij lub wybierz plik).
- **Przypinanie na pulpicie** — notatka jako mała karteczka; może być zawsze na wierzchu. Karteczkę przesuwasz za górny pasek, a rozmiar zmieniasz, ciągnąc za brzeg lub prawy dolny róg. Przypięte karteczki wracają po ponownym uruchomieniu komputera.
- **Przypinanie do pliku lub folderu** — przycisk ze spinaczem. Karteczka pokazuje się sama obok dokumentu (Word, Excel, PDF…) albo folderu w Eksploratorze, gdy go otworzysz, i chowa się, gdy przejdziesz do innego okna. Krzyżyk chowa ją do następnego otwarcia pliku.
- Kolor nowych notatek do wyboru w Ustawieniach.
- Praca w tle: krzyżyk tylko chowa okno, a karteczki dalej się pokazują. Okno wraca po kliknięciu ikony Karteczek. Całkowite zamknięcie: Ustawienia → **Zakończ Karteczki całkowicie**.
- Start razem z Windows, w tle (można wyłączyć w Ustawieniach).
- Jasny lub ciemny wygląd — tak jak w Windows.

### Jak Karteczki rozpoznają plik

Folder rozpoznają po jego ścieżce w oknie Eksploratora. Plik — po nazwie w tytule okna programu (np. „Umowa.docx - Word”). Jeśli dwa różne pliki mają tę samą nazwę, karteczka pokaże się przy obu.

## Gdzie są notatki

Domyślnie w folderze **OneDrive\Karteczki** (gdy OneDrive nie jest zainstalowany — w Dokumentach). Każda notatka to osobny plik, więc OneDrive przenosi je między komputerami, a Karteczki mogą być otwarte na dwóch komputerach jednocześnie. Gdy ta sama notatka zostanie zmieniona w tym samym czasie na dwóch komputerach, nic nie przepada — druga wersja pojawia się jako osobna notatka z dopiskiem „(konflikt zmian)”.

Raz dziennie Karteczki robią kopię zapasową wszystkich notatek na tym komputerze (zostaje 14 ostatnich dni). Folder kopii otworzysz w Ustawieniach.

## Skróty klawiszowe

| Skrót | Działanie |
|---|---|
| Ctrl+N | nowa notatka |
| Ctrl+F | szukaj |
| Esc | zamknij notatkę |
| Ctrl+B / I / U | pogrubienie / kursywa / podkreślenie |
| Ctrl+Shift+L | lista zadań |
| Ctrl+K | wstaw link |

## Dla programisty

Tauri 2 (rdzeń w Rust) + TypeScript i Vite. Instalator buduje GitHub Actions (`.github/workflows/build.yml`) po każdej zmianie w gałęzi `main`; nowe wydanie powstaje, gdy w `src-tauri/tauri.conf.json` (oraz `package.json` i `src-tauri/Cargo.toml`) zmieni się numer wersji.

```
npm ci
npm test                                         # testy interfejsu
cargo test --manifest-path src-tauri/Cargo.toml  # testy rdzenia
npm run tauri dev                                # uruchomienie w trybie deweloperskim
```
