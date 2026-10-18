import './styles.css';
import { listen } from '@tauri-apps/api/event';
import { api, errorText, type Info } from './api';
import { NoteEditor } from './editor';
import { icon } from './icons';
import {
  baseName,
  daysLeftInTrash,
  emptyNote,
  escapeHtml,
  formatDate,
  inView,
  isNewer,
  matches,
  renderHtml,
  serializeHtml,
  COLORS,
  type Note,
  type View,
} from './logic';
import { startSticky } from './sticky';
import { closePopovers, colorPicker, guardLinks, h, openLink, popover, toast } from './ui';


// ====================================================================
// Okno główne
// ====================================================================

const REPO = 'grocjusz/karteczki';
const notes = new Map<string, Note>();
let view: View = 'notes';
let query = '';
let info: Info = { dataDir: '', backupDir: '', version: '0.0.0', defaultColor: 'default', attachSupported: false };
let editor: NoteEditor | null = null;
let closeEditor: (() => Promise<void>) | null = null;
const renderCache = new Map<string, { key: number; html: string }>();

async function startMain(): Promise<void> {
  document.body.classList.add('main-mode');
  document.body.innerHTML = `
  <div class="app">
    <aside class="side">
      <div class="brand">${icon('note', 22)}<span>Karteczki</span></div>
      <nav>
        <button class="nav" data-view="notes">${icon('note')}<span>Notatki</span></button>
        <button class="nav" data-view="archive">${icon('archive')}<span>Archiwum</span></button>
        <button class="nav" data-view="trash">${icon('trash')}<span>Kosz</span></button>
      </nav>
      <div class="grow"></div>
      <button class="nav" id="settingsBtn">${icon('settings')}<span>Ustawienia</span></button>
    </aside>
    <main class="main">
      <header class="top">
        <label class="search">${icon('search')}
          <input id="q" type="search" placeholder="Szukaj (Ctrl+F)" autocomplete="off" spellcheck="false">
        </label>
      </header>
      <div id="banner"></div>
      <section class="content" id="content">
        <button class="composer" id="composer">${icon('plus')}<span>Utwórz notatkę…</span><kbd>Ctrl+N</kbd></button>
        <div class="trash-info" id="trashInfo">Notatki w koszu są usuwane na zawsze po 30 dniach.
          <button class="btn small ghost" id="emptyTrash">Opróżnij kosz</button></div>
        <div class="grid" id="grid"></div>
        <div class="empty-state" id="empty"></div>
      </section>
    </main>
  </div>`;

  document.querySelectorAll<HTMLButtonElement>('.nav[data-view]').forEach(b => {
    b.onclick = () => setView(b.dataset.view as View);
  });
  $('settingsBtn').onclick = () => void openSettings();
  $('composer').onclick = () => openEditor(emptyNote(info.defaultColor), true);
  $('emptyTrash').onclick = () => void emptyTrash();
  const q = $('q') as HTMLInputElement;
  q.addEventListener('input', () => {
    query = q.value;
    render();
  });
  q.addEventListener('keydown', e => {
    if (e.key === 'Escape' && q.value) {
      e.stopPropagation();
      q.value = '';
      query = '';
      render();
    }
  });

  document.addEventListener('keydown', e => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'n' && !e.shiftKey) {
      e.preventDefault();
      if (!editor) openEditor(emptyNote(info.defaultColor), true);
    } else if (mod && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      if (!editor) {
        q.focus();
        q.select();
      }
    } else if (e.key === 'Escape') {
      if (document.querySelector('.popover')) closePopovers();
      else if (closeEditor) void closeEditor();
      else document.querySelector('.backdrop')?.dispatchEvent(new Event('close'));
    }
  });

  new ResizeObserver(() => layout()).observe($('content'));

  try {
    info = await api.info();
  } catch (e) {
    toast('Błąd uruchomienia: ' + errorText(e));
  }
  await reload();
  setView('notes');

  await listen<Note>('note-saved', ({ payload }) => {
    notes.set(payload.id, payload);
    editor?.applyExternal(payload);
    render();
  });
  await listen<string>('note-deleted', ({ payload }) => {
    notes.delete(payload);
    render();
  });
  await listen('notes-external', () => scheduleReload());
  await listen<string>('open-note', ({ payload }) => {
    const n = notes.get(payload);
    if (n) void (async () => {
      if (closeEditor) await closeEditor();
      openEditor(n, false);
    })();
  });

  setTimeout(() => void checkUpdates(false), 4000);
  setInterval(() => void checkUpdates(false), 24 * 3600 * 1000);
}

function $(id: string): HTMLElement {
  return document.getElementById(id)!;
}

let reloadTimer = 0;
function scheduleReload(): void {
  clearTimeout(reloadTimer);
  reloadTimer = window.setTimeout(() => void reload(), 150);
}

async function reload(): Promise<void> {
  try {
    const list = await api.list();
    notes.clear();
    for (const n of list) notes.set(n.id, n);
    if (editor) {
      const fresh = notes.get(editor.note.id);
      if (fresh) editor.applyExternal(fresh);
    }
    render();
  } catch (e) {
    toast('Nie udało się wczytać notatek: ' + errorText(e));
  }
}

function setView(v: View): void {
  view = v;
  document.querySelectorAll<HTMLButtonElement>('.nav[data-view]').forEach(b => b.classList.toggle('on', b.dataset.view === v));
  render();
}

// ---------- siatka kart ----------

let renderQueued = false;
function render(): void {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderNow();
  });
}

function visibleNotes(): Note[] {
  const searching = query.trim() !== '';
  return [...notes.values()]
    .filter(n => (searching && view !== 'trash' ? n.trashedAt === null : inView(n, view)))
    .filter(n => matches(n, query))
    .sort((a, b) => (view === 'trash' ? (b.trashedAt ?? 0) - (a.trashedAt ?? 0) : b.updatedAt - a.updatedAt));
}

function cardHtml(n: Note): string {
  let cached = renderCache.get(n.id);
  if (!cached || cached.key !== n.updatedAt) {
    cached = { key: n.updatedAt, html: renderHtml(n.html) };
    renderCache.set(n.id, cached);
  }
  return cached.html;
}

function renderNow(): void {
  $('composer').hidden = view !== 'notes';
  $('trashInfo').hidden = view !== 'trash' || ![...notes.values()].some(n => n.trashedAt !== null);
  const list = visibleNotes();
  const grid = $('grid');
  const cards = list.map(n => buildCard(n));
  grid.replaceChildren(...cards);
  const empty = $('empty');
  if (list.length) {
    empty.hidden = true;
  } else {
    empty.hidden = false;
    empty.innerHTML = query.trim()
      ? `${icon('search', 64)}<p>Nic nie znaleziono</p>`
      : view === 'notes'
        ? `${icon('note', 64)}<p>Tu pojawią się Twoje notatki</p>`
        : view === 'archive'
          ? `${icon('archive', 64)}<p>Archiwum jest puste</p>`
          : `${icon('trash', 64)}<p>Kosz jest pusty</p>`;
  }
  layout();
}

function buildCard(n: Note): HTMLElement {
  const card = h('article', `card c-${n.color}`);
  card.dataset.id = n.id;
  card.tabIndex = 0;
  const body = cardHtml(n);
  card.innerHTML =
    (n.title ? `<h3 class="card-title">${escapeHtml(n.title)}</h3>` : '') +
    (body ? `<div class="card-body note-html">${body}</div>` : '') +
    (!n.title && !body ? '<div class="card-body muted">Pusta notatka</div>' : '');
  const meta: string[] = [];
  if (n.trashedAt !== null) {
    const d = daysLeftInTrash(n);
    meta.push(d <= 1 ? 'Zostanie usunięta jutro' : `Zostanie usunięta za ${d} dni`);
  } else if (n.archived && view !== 'archive') meta.push('W archiwum');
  if (meta.length) card.insertAdjacentHTML('beforeend', `<div class="card-meta">${meta.join(' · ')}</div>`);
  if (n.attach) card.append(attachChip(n.attach));

  const actions = h('div', 'card-actions');
  const add = (ic: string, title: string, run: (btn: HTMLButtonElement) => void) => {
    const b = h('button', 'icon-btn', icon(ic, 18));
    b.title = title;
    b.setAttribute('aria-label', title);
    b.onclick = e => {
      e.stopPropagation();
      run(b);
    };
    actions.append(b);
  };
  if (n.trashedAt !== null) {
    add('restore', 'Przywróć', () => void update(n, { trashedAt: null }, 'Przywrócono notatkę'));
    add('forever', 'Usuń na zawsze', () => void deleteForever(n));
  } else {
    add('palette', 'Kolor', b => colorPicker(b, n.color, c => void update(n, { color: c })));
    add('desktop', 'Przypnij na pulpicie', () => void pinToDesktop(n));
    add('clip', 'Przypnij do pliku lub folderu', b => attachMenu(b, n.attach ?? null, path => void update(n, { attach: path }, path ? 'Karteczka pokaże się sama, gdy otworzysz: ' + baseName(path) : 'Odpięto od pliku')));
    if (n.archived) add('unarchive', 'Przywróć z archiwum', () => void update(n, { archived: false }, 'Przywrócono z archiwum', { archived: true }));
    else add('archive', 'Archiwizuj', () => void update(n, { archived: true }, 'Zarchiwizowano notatkę', { archived: false }));
    add('trash', 'Przenieś do kosza', () => void moveToTrash(n));
  }
  card.append(actions);

  card.addEventListener('click', e => {
    const target = e.target as Element;
    const a = target.closest('a[href]');
    if (a) {
      e.preventDefault();
      openLink(a.getAttribute('href') ?? '');
      return;
    }
    const li = target.closest('ul[data-checklist] > li');
    if (li && n.trashedAt === null && e.clientX - li.getBoundingClientRect().left <= 26) {
      li.setAttribute('data-checked', li.getAttribute('data-checked') === 'true' ? 'false' : 'true');
      const bodyEl = card.querySelector<HTMLElement>('.card-body');
      if (bodyEl) void update(n, { html: serializeHtml(bodyEl) });
      return;
    }
    openEditor(n, false);
  });
  card.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target === card) openEditor(n, false);
  });
  return card;
}

/** Układ „murowany”: każda karta trafia do najkrótszej kolumny, kolejność od lewej do prawej. */
function layout(): void {
  const grid = $('grid');
  const cards = [...grid.querySelectorAll<HTMLElement>('.card')];
  const width = grid.clientWidth;
  if (!width) return;
  const colWidth = 250, gap = 14;
  const cols = Math.max(1, Math.floor((width + gap) / (colWidth + gap)));
  const columns = Array.from({ length: cols }, () => h('div', 'col'));
  grid.replaceChildren(...columns);
  grid.style.setProperty('--cols', String(cols));
  // Pomiar wysokości w kolumnie o docelowej szerokości.
  columns[0].append(...cards);
  const heights = cards.map(c => c.offsetHeight);
  const totals = new Array(cols).fill(0);
  cards.forEach((c, i) => {
    let best = 0;
    for (let k = 1; k < cols; k++) if (totals[k] < totals[best] - 1) best = k;
    columns[best].append(c);
    totals[best] += heights[i] + gap;
  });
  // Obrazki doładowują się później — wtedy przeliczamy układ jeszcze raz.
  grid.querySelectorAll('img').forEach(img => {
    if (!img.complete) img.addEventListener('load', () => render(), { once: true });
  });
}

// ---------- operacje na notatkach ----------

async function update(n: Note, fields: Partial<Note>, message?: string, undo?: Partial<Note>): Promise<void> {
  const current = notes.get(n.id) ?? n;
  try {
    const res = await api.save({ ...current, ...fields }, current.updatedAt);
    notes.set(res.note.id, res.note);
    if (res.conflict) {
      notes.set(res.conflict.id, res.conflict);
      toast('Ta notatka zmieniła się na innym komputerze. Twoja zmiana jest w osobnej notatce „(konflikt zmian)”.');
    } else if (message) {
      toast(message, undo ? { label: 'Cofnij', run: () => void update(res.note, undo) } : undefined);
    }
    render();
  } catch (e) {
    toast('Nie udało się zapisać: ' + errorText(e));
  }
}

async function moveToTrash(n: Note): Promise<void> {
  await api.closeSticky(n.id).catch(() => undefined);
  await update(n, { trashedAt: Date.now() }, 'Przeniesiono do kosza', { trashedAt: null });
}

async function deleteForever(n: Note): Promise<void> {
  const { ask } = await import('@tauri-apps/plugin-dialog');
  const ok = await ask('Usunąć tę notatkę na zawsze? Tego nie można cofnąć.', {
    title: 'Karteczki',
    kind: 'warning',
    okLabel: 'Usuń',
    cancelLabel: 'Anuluj',
  });
  if (!ok) return;
  try {
    await api.remove(n.id);
    notes.delete(n.id);
    render();
  } catch (e) {
    toast('Nie udało się usunąć: ' + errorText(e));
  }
}

async function emptyTrash(): Promise<void> {
  const trashed = [...notes.values()].filter(n => n.trashedAt !== null);
  if (!trashed.length) return;
  const { ask } = await import('@tauri-apps/plugin-dialog');
  const ok = await ask(`Usunąć na zawsze wszystkie notatki z kosza (${trashed.length})? Tego nie można cofnąć.`, {
    title: 'Karteczki',
    kind: 'warning',
    okLabel: 'Opróżnij kosz',
    cancelLabel: 'Anuluj',
  });
  if (!ok) return;
  for (const n of trashed) {
    try {
      await api.remove(n.id);
      notes.delete(n.id);
    } catch (e) {
      toast('Nie udało się usunąć: ' + errorText(e));
    }
  }
  render();
}

async function pinToDesktop(n: Note): Promise<void> {
  try {
    await api.openSticky(n.id);
  } catch (e) {
    toast('Nie udało się przypiąć: ' + errorText(e));
  }
}

// ---------- przypinanie do pliku lub folderu ----------

function attachChip(path: string): HTMLElement {
  const chip = h('div', 'chip', `${icon('clip', 14)}<span>${escapeHtml(baseName(path))}</span>`);
  chip.title = 'Pokazuje się sama przy: ' + path;
  return chip;
}

function attachMenu(anchor: HTMLElement, current: string | null, apply: (path: string | null) => void): void {
  const pop = popover(anchor, 'attach-menu');
  if (!info.attachSupported) {
    pop.append(h('p', 'hint', 'Ta funkcja działa w Windows.'));
    return;
  }
  pop.append(
    h(
      'p',
      'hint',
      current
        ? `Przypięta do: <b>${escapeHtml(baseName(current))}</b><br><span class="path">${escapeHtml(current)}</span>`
        : 'Karteczka pokaże się sama obok pliku lub folderu, gdy go otworzysz, i schowa, gdy przejdziesz do innego okna.',
    ),
  );
  const item = (ic: string, label: string, run: () => void) => {
    const b = h('button', 'menu-item', `${icon(ic, 18)}<span>${escapeHtml(label)}</span>`);
    b.onclick = () => {
      pop.remove();
      run();
    };
    pop.append(b);
  };
  const pick = async (directory: boolean) => {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const path = await open({
      directory,
      multiple: false,
      title: directory ? 'Wybierz folder, przy którym ma się pokazywać karteczka' : 'Wybierz plik, przy którym ma się pokazywać karteczka',
    });
    if (typeof path === 'string' && path) apply(path);
  };
  item('file', current ? 'Zmień na inny plik…' : 'Do pliku lub dokumentu…', () => void pick(false));
  item('folder', current ? 'Zmień na inny folder…' : 'Do folderu…', () => void pick(true));
  if (current) item('close', 'Odepnij', () => apply(null));
}

// ---------- edytor w oknie ----------

function openEditor(n: Note, isNew: boolean): void {
  if (editor) return;
  closePopovers();
  const backdrop = h('div', 'backdrop');
  const modal = h('div', `modal note-modal c-${n.color}`);
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-label', 'Edycja notatki');
  const ed = new NoteEditor(n, {
    onSaved: saved => {
      notes.set(saved.id, saved);
      render();
    },
    onConflict: () =>
      toast('Ta notatka zmieniła się w międzyczasie na innym komputerze. Twoje zmiany zapisały się jako osobna notatka „(konflikt zmian)”.', undefined, 10000),
  });
  editor = ed;

  const foot = h('div', 'modal-foot');
  const tools = h('div', 'modal-tools');
  const add = (ic: string, title: string, run: (b: HTMLButtonElement) => void) => {
    const b = h('button', 'icon-btn', icon(ic, 18));
    b.title = title;
    b.setAttribute('aria-label', title);
    b.addEventListener('mousedown', e => e.preventDefault());
    b.onclick = () => run(b);
    tools.append(b);
  };
  add('palette', 'Kolor', b =>
    colorPicker(b, ed.note.color, c => {
      modal.className = `modal note-modal c-${c}`;
      ed.patch({ color: c });
    }),
  );
  add('desktop', 'Przypnij na pulpicie', async () => {
    if (ed.base === 0 && ed.isEmpty) {
      toast('Najpierw coś napisz — pustej notatki nie da się przypiąć.');
      return;
    }
    if (ed.base === 0) ed.markDirty();
    await ed.flush();
    await pinToDesktop(ed.note);
    await close();
  });
  add('clip', 'Przypnij do pliku lub folderu', b =>
    attachMenu(b, ed.note.attach ?? null, path => {
      ed.patch({ attach: path });
      chipBox.replaceChildren(...(path ? [attachChip(path)] : []));
      if (path && ed.base === 0) ed.markDirty();
      toast(path ? 'Karteczka pokaże się sama, gdy otworzysz: ' + baseName(path) : 'Odpięto od pliku');
    }),
  );
  add(n.archived ? 'unarchive' : 'archive', n.archived ? 'Przywróć z archiwum' : 'Archiwizuj', async () => {
    if (ed.base === 0 && ed.isEmpty) return void close();
    const archived = !ed.note.archived;
    ed.patch({ archived });
    await close();
    toast(archived ? 'Zarchiwizowano notatkę' : 'Przywrócono z archiwum');
  });
  add('trash', 'Przenieś do kosza', async () => {
    if (ed.base === 0 && ed.isEmpty) return void close();
    ed.patch({ trashedAt: Date.now() });
    const id = ed.note.id;
    await close();
    await api.closeSticky(id).catch(() => undefined);
    const saved = notes.get(id);
    toast('Przeniesiono do kosza', saved ? { label: 'Cofnij', run: () => void update(saved, { trashedAt: null }) } : undefined);
  });
  const stamp = h('span', 'stamp', n.updatedAt ? 'Zmieniono ' + escapeHtml(formatDate(n.updatedAt)) : '');
  const done = h('button', 'btn ghost', 'Zamknij');
  done.onclick = () => void close();
  foot.append(tools, stamp, done);
  const chipBox = h('div', 'modal-chip');
  if (n.attach) chipBox.append(attachChip(n.attach));
  modal.append(ed.el, chipBox, foot);
  backdrop.append(modal);
  document.body.append(backdrop);
  backdrop.addEventListener('mousedown', e => {
    if (e.target === backdrop) void close();
  });

  let closing = false;
  async function close(): Promise<void> {
    if (closing) return;
    closing = true;
    if (ed.base === 0 && !ed.isEmpty) ed.markDirty();
    await ed.flush();
    backdrop.remove();
    editor = null;
    closeEditor = null;
    render();
  }
  closeEditor = close;
  requestAnimationFrame(() => ed.focus(!isNew));
}

// ---------- ustawienia ----------

async function openSettings(): Promise<void> {
  const { isEnabled, enable, disable } = await import('@tauri-apps/plugin-autostart');
  let auto = false;
  try {
    auto = await isEnabled();
  } catch {
    /* brak dostępu do rejestru — przełącznik pokaże „wyłączone” */
  }
  info = await api.info().catch(() => info);
  const backdrop = h('div', 'backdrop');
  const modal = h('div', 'modal settings');
  modal.innerHTML = `
    <h2>Ustawienia</h2>
    <section>
      <h3>Folder z notatkami</h3>
      <p class="path" id="dataDir">${escapeHtml(info.dataDir)}</p>
      <p class="hint">Jeśli folder jest w OneDrive, notatki są na każdym Twoim komputerze z Karteczkami. Każda notatka to osobny plik, więc możesz pracować na dwóch komputerach naraz.</p>
      <div class="row"><button class="btn" id="chooseDir">Zmień folder…</button><button class="btn ghost" id="openDir">Otwórz folder</button></div>
    </section>
    <section>
      <h3>Kolor nowych notatek</h3>
      <div class="palette-row" id="defColor"></div>
    </section>
    <section>
      <h3>Praca w tle</h3>
      <p class="hint">Zamknięcie okna krzyżykiem tylko je chowa — Karteczki działają dalej, więc karteczki na pulpicie i przy plikach nadal się pokazują. Okno otworzysz ponownie, klikając ikonę Karteczek na pasku zadań lub w menu Start.</p>
      <div class="row"><button class="btn ghost" id="quitApp">Zakończ Karteczki całkowicie</button></div>
    </section>
    <section>
      <label class="switch"><input type="checkbox" id="autostart" ${auto ? 'checked' : ''}><span>Uruchamiaj Karteczki razem z Windows</span></label>
    </section>
    <section id="attachSec">
      <h3>Karteczki przy plikach i folderach</h3>
      <p class="hint">Gdy karteczka nie pokazuje się przy folderze lub pliku, otwórz go, wróć tutaj i kliknij „Co widzą Karteczki”. Lista pokazuje ostatnio sprawdzone okna.</p>
      <div class="row"><button class="btn ghost" id="attachLogBtn">Co widzą Karteczki</button></div>
      <pre class="attach-log" id="attachLog" hidden></pre>
    </section>
    <section>
      <h3>Kopie zapasowe</h3>
      <p class="hint">Raz dziennie Karteczki zapisują kopię wszystkich notatek na tym komputerze. Przechowywane są kopie z ostatnich 14 dni.</p>
      <div class="row"><button class="btn ghost" id="openBackups">Otwórz folder kopii</button></div>
    </section>
    <section>
      <h3>Skróty klawiszowe</h3>
      <p class="hint"><kbd>Ctrl+N</kbd> nowa notatka · <kbd>Ctrl+F</kbd> szukaj · <kbd>Esc</kbd> zamknij · <kbd>Ctrl+B/I/U</kbd> formatowanie · <kbd>Ctrl+Shift+L</kbd> lista zadań · <kbd>Ctrl+K</kbd> link · <kbd>Ctrl+klik</kbd> otwiera link</p>
    </section>
    <section class="about">
      <span>Karteczki ${escapeHtml(info.version)}</span>
      <button class="btn ghost" id="checkUpd">Sprawdź aktualizacje</button>
    </section>
    <div class="modal-foot"><span class="grow"></span><button class="btn" id="closeSettings">Zamknij</button></div>`;
  backdrop.append(modal);
  document.body.append(backdrop);
  const close = () => backdrop.remove();
  backdrop.addEventListener('close', close);
  backdrop.addEventListener('mousedown', e => {
    if (e.target === backdrop) close();
  });
  modal.querySelector<HTMLButtonElement>('#closeSettings')!.onclick = close;
  const row = modal.querySelector<HTMLElement>('#defColor')!;
  const drawColors = () => {
    row.replaceChildren(
      ...COLORS.map(c => {
        const b = h('button', `swatch c-${c.id}${c.id === info.defaultColor ? ' on' : ''}`);
        b.title = c.name;
        b.setAttribute('aria-label', c.name);
        b.onclick = async () => {
          try {
            await api.setDefaultColor(c.id);
            info.defaultColor = c.id;
            drawColors();
          } catch (e) {
            toast('Nie udało się zapisać koloru: ' + errorText(e));
          }
        };
        return b;
      }),
    );
  };
  drawColors();
  modal.querySelector<HTMLButtonElement>('#openDir')!.onclick = () => api.openDataDir().catch(e => toast(errorText(e)));
  modal.querySelector<HTMLButtonElement>('#openBackups')!.onclick = () => api.openBackupDir().catch(e => toast(errorText(e)));
  modal.querySelector<HTMLElement>('#attachSec')!.hidden = !info.attachSupported;
  modal.querySelector<HTMLButtonElement>('#attachLogBtn')!.onclick = async () => {
    const pre = modal.querySelector<HTMLElement>('#attachLog')!;
    const lines = await api.attachLog().catch(() => [] as string[]);
    pre.hidden = false;
    pre.textContent = lines.length
      ? lines.join('\n')
      : 'Nic jeszcze nie sprawdzono. Okna są sprawdzane tylko wtedy, gdy co najmniej jedna notatka jest przypięta do pliku lub folderu.';
  };
  modal.querySelector<HTMLButtonElement>('#quitApp')!.onclick = async () => {
    const { ask } = await import('@tauri-apps/plugin-dialog');
    const ok = await ask('Zamknąć Karteczki całkowicie? Karteczki na pulpicie i przy plikach przestaną się pokazywać do następnego uruchomienia.', {
      title: 'Karteczki',
      kind: 'warning',
      okLabel: 'Zakończ',
      cancelLabel: 'Anuluj',
    });
    if (ok) {
      if (closeEditor) await closeEditor();
      await api.quit();
    }
  };
  modal.querySelector<HTMLButtonElement>('#checkUpd')!.onclick = () => void checkUpdates(true);
  modal.querySelector<HTMLInputElement>('#autostart')!.onchange = async ev => {
    const box = ev.target as HTMLInputElement;
    try {
      if (box.checked) await enable();
      else await disable();
    } catch (e) {
      box.checked = !box.checked;
      toast('Nie udało się zmienić ustawienia: ' + errorText(e));
    }
  };
  modal.querySelector<HTMLButtonElement>('#chooseDir')!.onclick = async () => {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const dir = await open({ directory: true, title: 'Wybierz folder na notatki', defaultPath: info.dataDir });
    if (typeof dir !== 'string' || !dir) return;
    try {
      await api.setDataDir(dir);
      info = await api.info();
      modal.querySelector('#dataDir')!.textContent = info.dataDir;
      await reload();
      toast('Folder zmieniony. Notatki z poprzedniego folderu zostały na miejscu.');
    } catch (e) {
      toast('Nie udało się użyć tego folderu: ' + errorText(e));
    }
  };
}

// ---------- aktualizacje ----------

async function checkUpdates(manual: boolean): Promise<void> {
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (r.status === 404) {
      if (manual) toast('Masz najnowszą wersję.');
      return;
    }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const rel = (await r.json()) as {
      tag_name: string;
      html_url: string;
      assets?: { name: string; browser_download_url: string }[];
    };
    const latest = rel.tag_name.replace(/^v/i, '');
    if (!isNewer(latest, info.version)) {
      if (manual) toast(`Masz najnowszą wersję (${info.version}).`);
      return;
    }
    let skipped = '';
    try {
      skipped = localStorage.getItem('pominieta-wersja') ?? '';
    } catch {
      /* brak pamięci przeglądarki — pokazujemy zawsze */
    }
    if (!manual && skipped === latest) return;
    const exe = rel.assets?.find(a => /setup\.exe$/i.test(a.name)) ?? rel.assets?.find(a => /\.exe$/i.test(a.name));
    const url = exe?.browser_download_url ?? rel.html_url;
    const banner = $('banner');
    banner.innerHTML = `<div class="banner">${icon('restore', 18)}<span>Jest nowa wersja Karteczek: <b>${escapeHtml(latest)}</b> (masz ${escapeHtml(info.version)}).</span>
      <button class="btn small" id="updGet">Pobierz</button><button class="btn small ghost" id="updLater">Później</button></div>`;
    $('updGet').onclick = () => {
      openLink(url);
      toast('Po pobraniu uruchom instalator. Karteczki zamkną się na czas aktualizacji, notatki zostają.', undefined, 10000);
    };
    $('updLater').onclick = () => {
      try {
        localStorage.setItem('pominieta-wersja', latest);
      } catch {
        /* pomijamy */
      }
      banner.innerHTML = '';
    };
  } catch (e) {
    if (manual) toast('Nie udało się sprawdzić aktualizacji: ' + errorText(e));
  }
}

// Start dopiero na końcu pliku, gdy wszystkie zmienne modułu są już utworzone.
guardLinks();
const stickyMatch = /^#sticky=([A-Za-z0-9_-]+)$/.exec(location.hash);
if (stickyMatch) void startSticky(stickyMatch[1]);
else void startMain();
