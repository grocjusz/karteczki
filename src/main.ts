import './styles.css';
import { listen } from '@tauri-apps/api/event';
import { api, errorText, type Info } from './api';
import { NoteEditor } from './editor';
import { icon } from './icons';
import {
  baseName,
  COLORS,
  daysLeftInTrash,
  emptyNote,
  escapeHtml,
  formatDate,
  formatReminder,
  inView,
  isNewer,
  matches,
  newId,
  nextOccurrence,
  quickReminders,
  REPEATS,
  reminderShown,
  renderHtml,
  serializeHtml,
  type Note,
  type Reminder,
  type Repeat,
  type View,
} from './logic';
import { startSticky } from './sticky';
import { closePopovers, colorPicker, guardLinks, h, openLink, popover, toast } from './ui';

// ====================================================================
// Okno główne — układ i wygląd wzorowane na Google Keep
// ====================================================================

const REPO = 'grocjusz/karteczki';
const notes = new Map<string, Note>();
let view: View = 'notes';
let query = '';
let info: Info = { dataDir: '', backupDir: '', version: '0.0.0', defaultColor: 'default', attachSupported: false };
let editor: NoteEditor | null = null;
let closeEditor: (() => Promise<void>) | null = null;
let composerEditor: NoteEditor | null = null;
let closeComposer: (() => Promise<void>) | null = null;
let listMode = pref('widok', 'siatka') === 'lista';
const renderCache = new Map<string, { key: number; html: string }>();

function pref(key: string, def: string): string {
  try {
    return localStorage.getItem(key) ?? def;
  } catch {
    return def;
  }
}
function setPref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* brak pamięci przeglądarki — ustawienie obowiązuje do zamknięcia okna */
  }
}

const VIEWS: { id: View; label: string; ic: string; empty: string }[] = [
  { id: 'notes', label: 'Notatki', ic: 'note', empty: 'Tu pojawią się Twoje notatki' },
  { id: 'reminders', label: 'Przypomnienia', ic: 'bell', empty: 'Tu pojawią się notatki z przypomnieniami' },
  { id: 'archive', label: 'Archiwum', ic: 'archive', empty: 'Tu pojawią się zarchiwizowane notatki' },
  { id: 'trash', label: 'Kosz', ic: 'trash', empty: 'Kosz jest pusty' },
];

async function startMain(): Promise<void> {
  document.body.classList.add('main-mode');
  document.body.innerHTML = `
  <div class="app${pref('panel', 'rozwiniety') === 'zwiniety' ? ' collapsed' : ''}" id="app">
    <header class="top">
      <button class="icon-btn big" id="menuBtn" title="Menu główne" aria-label="Menu główne">${icon('menu', 24)}</button>
      <label class="search">
        <span class="search-ic">${icon('search', 22)}</span>
        <input id="q" type="search" placeholder="Szukaj" autocomplete="off" spellcheck="false">
        <button class="icon-btn" id="qClear" title="Wyczyść wyszukiwanie" aria-label="Wyczyść wyszukiwanie" hidden>${icon('close', 20)}</button>
      </label>
      <div class="top-actions">
        <button class="icon-btn big" id="refreshBtn" title="Odśwież" aria-label="Odśwież">${icon('refresh', 22)}</button>
        <button class="icon-btn big" id="layoutBtn"></button>
        <button class="icon-btn big" id="settingsBtn" title="Ustawienia" aria-label="Ustawienia">${icon('settings', 22)}</button>
      </div>
    </header>
    <div id="banner"></div>
    <div class="body">
      <aside class="side">
        ${VIEWS.map(v => `<button class="nav" data-view="${v.id}" title="${v.label}">${icon(v.ic, 22)}<span>${v.label}</span></button>`).join('')}
      </aside>
      <main class="content" id="content">
        <div class="composer" id="composer"></div>
        <div class="trash-info" id="trashInfo">Notatki w koszu są usuwane po 30 dniach.
          <button class="btn ghost link" id="emptyTrash">Opróżnij kosz</button></div>
        <div id="sections"></div>
        <div class="empty-state" id="empty"></div>
      </main>
    </div>
  </div>`;

  document.querySelectorAll<HTMLButtonElement>('.nav[data-view]').forEach(b => {
    b.onclick = () => setView(b.dataset.view as View);
  });
  $('menuBtn').onclick = () => {
    const collapsed = $('app').classList.toggle('collapsed');
    setPref('panel', collapsed ? 'zwiniety' : 'rozwiniety');
    requestAnimationFrame(() => layout());
  };
  $('settingsBtn').onclick = () => void openSettings();
  $('refreshBtn').onclick = () => void reload();
  $('emptyTrash').onclick = () => void emptyTrash();
  const layoutBtn = $('layoutBtn');
  const showLayoutBtn = () => {
    layoutBtn.innerHTML = icon(listMode ? 'grid' : 'rows', 22);
    layoutBtn.title = listMode ? 'Widok siatki' : 'Widok listy';
    layoutBtn.setAttribute('aria-label', layoutBtn.title);
  };
  showLayoutBtn();
  layoutBtn.onclick = () => {
    listMode = !listMode;
    setPref('widok', listMode ? 'lista' : 'siatka');
    showLayoutBtn();
    render();
  };

  const q = $('q') as HTMLInputElement;
  const clear = $('qClear');
  q.addEventListener('input', () => {
    query = q.value;
    clear.hidden = !q.value;
    render();
  });
  clear.onclick = () => {
    q.value = '';
    query = '';
    clear.hidden = true;
    render();
  };
  q.addEventListener('keydown', e => {
    if (e.key === 'Escape' && q.value) {
      e.stopPropagation();
      clear.click();
    }
  });

  document.addEventListener('keydown', e => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'n' && !e.shiftKey) {
      e.preventDefault();
      if (!editor) openComposer();
    } else if (mod && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      if (!editor) {
        q.focus();
        q.select();
      }
    } else if (e.key === 'Escape') {
      if (document.querySelector('.popover')) closePopovers();
      else if (closeEditor) void closeEditor();
      else if (document.querySelector('.backdrop')) document.querySelector('.backdrop')?.dispatchEvent(new Event('close'));
      else if (closeComposer) void closeComposer();
    }
  });

  collapseComposer();
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
  await listen('reminder-fired', () => render());
  await listen<string>('open-note', ({ payload }) => {
    const n = notes.get(payload);
    if (n)
      void (async () => {
        if (closeEditor) await closeEditor();
        openEditor(n);
      })();
  });

  // Co minutę odświeżamy opisy terminów („Dziś, 20:00” → przekreślone po czasie).
  setInterval(() => render(), 60_000);
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
  void closeComposer?.();
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

interface Section {
  label?: string;
  notes: Note[];
}

const byUpdated = (a: Note, b: Note) => b.updatedAt - a.updatedAt;

function sections(): Section[] {
  const all = [...notes.values()];
  if (query.trim()) {
    const found = all.filter(n => (view === 'trash' ? n.trashedAt !== null : n.trashedAt === null)).filter(n => matches(n, query));
    return [{ notes: found.sort(byUpdated) }];
  }
  if (view === 'trash') {
    return [{ notes: all.filter(n => n.trashedAt !== null).sort((a, b) => (b.trashedAt ?? 0) - (a.trashedAt ?? 0)) }];
  }
  const list = all.filter(n => inView(n, view));
  if (view === 'reminders') {
    const now = Date.now();
    const upcoming = list.filter(n => nextOccurrence(n.reminder!, now) !== null);
    const sent = list.filter(n => nextOccurrence(n.reminder!, now) === null);
    upcoming.sort((a, b) => nextOccurrence(a.reminder!, now)! - nextOccurrence(b.reminder!, now)!);
    sent.sort((a, b) => b.reminder!.at - a.reminder!.at);
    const out: Section[] = [];
    if (upcoming.length) out.push({ label: sent.length ? 'Nadchodzące' : undefined, notes: upcoming });
    if (sent.length) out.push({ label: 'Wysłane', notes: sent });
    return out;
  }
  const pinned = list.filter(n => n.pinned).sort(byUpdated);
  const others = list.filter(n => !n.pinned).sort(byUpdated);
  if (pinned.length) return [{ label: 'Przypięte', notes: pinned }, { label: others.length ? 'Pozostałe' : undefined, notes: others }];
  return [{ notes: others }];
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
  $('composer').hidden = !(view === 'notes' || view === 'reminders') || !!query.trim();
  $('trashInfo').hidden = view !== 'trash' || ![...notes.values()].some(n => n.trashedAt !== null);
  const secs = sections().filter(s => s.notes.length);
  const box = $('sections');
  box.replaceChildren(
    ...secs.map(s => {
      const sec = h('section', 'sec');
      const grid = h('div', 'grid' + (listMode ? ' list' : ''));
      grid.append(...s.notes.map(buildCard));
      if (s.label) sec.append(h('h2', 'section-label', escapeHtml(s.label)));
      sec.append(grid);
      return sec;
    }),
  );
  const empty = $('empty');
  if (secs.length) {
    empty.hidden = true;
  } else {
    const v = VIEWS.find(x => x.id === view)!;
    empty.hidden = false;
    empty.innerHTML = query.trim() ? `${icon('search', 120)}<p>Nie znaleziono pasujących notatek</p>` : `${icon(v.ic, 120)}<p>${v.empty}</p>`;
  }
  layout();
}

/** Układ „murowany” jak w Keep: karty o stałej szerokości, każda trafia do najkrótszej kolumny. */
function layout(): void {
  const content = $('content');
  const avail = content.clientWidth - 48;
  if (avail <= 0) return;
  const gap = 16;
  const colWidth = listMode ? Math.min(600, avail) : 240;
  const cols = listMode ? 1 : Math.max(1, Math.floor((avail + gap) / (colWidth + gap)));
  content.querySelectorAll<HTMLElement>('.grid').forEach(grid => {
    const cards = [...grid.querySelectorAll<HTMLElement>(':scope .card')];
    const columns = Array.from({ length: cols }, () => h('div', 'col'));
    columns.forEach(c => (c.style.width = colWidth + 'px'));
    grid.replaceChildren(...columns);
    const width = cols * colWidth + (cols - 1) * gap + 'px';
    grid.style.width = width;
    if (grid.parentElement?.classList.contains('sec')) grid.parentElement.style.width = width;
    columns[0].append(...cards);
    const heights = cards.map(c => c.offsetHeight);
    const totals = new Array(cols).fill(0);
    cards.forEach((c, i) => {
      let best = 0;
      for (let k = 1; k < cols; k++) if (totals[k] < totals[best] - 1) best = k;
      columns[best].append(c);
      totals[best] += heights[i] + gap;
    });
    grid.querySelectorAll('img').forEach(img => {
      if (!img.complete) img.addEventListener('load', () => render(), { once: true });
    });
  });
  // Pasek tworzenia notatki ma szerokość jak w Keep, ale nie szerszą niż siatka.
  $('composer').style.width = Math.min(600, avail) + 'px';
}

function buildCard(n: Note): HTMLElement {
  const card = h('article', `card c-${n.color}`);
  card.dataset.id = n.id;
  card.tabIndex = 0;
  const body = cardHtml(n);
  card.innerHTML =
    (n.title ? `<div class="card-title">${escapeHtml(n.title)}</div>` : '') +
    (body ? `<div class="card-body note-html">${body}</div>` : '') +
    (!n.title && !body ? '<div class="card-body empty">Pusta notatka</div>' : '');
  if (n.trashedAt === null) {
    const pin = h('button', 'icon-btn card-pin' + (n.pinned ? ' on' : ''), icon(n.pinned ? 'pinOn' : 'pin', 20));
    pin.title = n.pinned ? 'Odepnij od góry' : 'Przypnij u góry';
    pin.setAttribute('aria-label', pin.title);
    pin.onclick = e => {
      e.stopPropagation();
      void update(n, { pinned: !n.pinned });
    };
    card.prepend(pin);
  }
  const chips = h('div', 'chips');
  if (n.reminder) chips.append(reminderChip(n.reminder, b => remMenu(b, n.reminder ?? null, r => void update(n, { reminder: r })), () => void update(n, { reminder: null })));
  if (n.attach) chips.append(attachChip(n.attach, () => void update(n, { attach: null }, 'Odpięto od pliku')));
  if (chips.children.length) card.append(chips);
  if (n.trashedAt !== null) {
    const d = daysLeftInTrash(n);
    card.insertAdjacentHTML('beforeend', `<div class="card-meta">${d <= 1 ? 'Zostanie usunięta jutro' : `Zostanie usunięta za ${d} dni`}</div>`);
  } else if (n.archived && view !== 'archive') {
    card.insertAdjacentHTML('beforeend', '<div class="card-meta">W archiwum</div>');
  }

  if (n.trashedAt !== null) {
    const bar = h('div', 'actions');
    bar.append(
      iconButton('forever', 'Usuń na zawsze', () => void deleteForever(n)),
      iconButton('restore', 'Przywróć', () => void update(n, { trashedAt: null }, 'Przywrócono notatkę')),
    );
    card.append(bar);
  } else {
    card.append(
      actionBar({
        note: () => notes.get(n.id) ?? n,
        patch: (f, msg, undo) => void update(n, f, msg, undo),
        trash: () => void moveToTrash(n),
        desktop: () => void pinToDesktop(n),
      }),
    );
  }

  card.addEventListener('click', e => {
    const target = e.target as Element;
    if (target.closest('button, .chip')) return;
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
    openEditor(n);
  });
  card.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target === card) openEditor(n);
  });
  return card;
}

function iconButton(ic: string, title: string, run: (b: HTMLButtonElement) => void, size = 18): HTMLButtonElement {
  const b = h('button', 'icon-btn', icon(ic, size));
  b.title = title;
  b.setAttribute('aria-label', title);
  b.type = 'button';
  b.addEventListener('mousedown', e => e.preventDefault());
  b.onclick = e => {
    e.stopPropagation();
    run(b);
  };
  return b;
}

// ---------- pasek akcji (karta, okno notatki, pasek tworzenia) ----------

interface Target {
  note(): Note;
  patch(fields: Partial<Note>, message?: string, undo?: Partial<Note>): void;
  trash(): void;
  desktop(): void;
  editor?: NoteEditor;
}

function actionBar(t: Target): HTMLElement {
  const bar = h('div', 'actions');
  bar.append(
    iconButton('bell', 'Przypomnij mi', b => remMenu(b, t.note().reminder ?? null, r => t.patch({ reminder: r }))),
    iconButton('palette', 'Kolor tła', b => colorPicker(b, t.note().color, c => t.patch({ color: c }))),
  );
  if (t.editor) {
    const ed = t.editor;
    bar.append(iconButton('image', 'Dodaj obraz', () => ed.pickImage()));
  }
  const archived = t.note().archived;
  bar.append(
    iconButton(archived ? 'unarchive' : 'archive', archived ? 'Przywróć z archiwum' : 'Archiwizuj', () =>
      t.patch({ archived: !archived }, archived ? 'Przywrócono z archiwum' : 'Zarchiwizowano notatkę', { archived }),
    ),
    iconButton('desktop', 'Przypnij na pulpicie jako karteczkę', () => t.desktop()),
    iconButton('more', 'Więcej', b => moreMenu(b, t)),
  );
  return bar;
}

function moreMenu(anchor: HTMLElement, t: Target): void {
  const pop = popover(anchor, 'menu');
  const item = (label: string, run: () => void) => {
    const b = h('button', 'menu-item', `<span>${escapeHtml(label)}</span>`);
    b.onclick = () => {
      pop.remove();
      run();
    };
    pop.append(b);
  };
  item('Usuń notatkę', () => t.trash());
  item('Utwórz kopię', () => void copyNote(t.note()));
  if (t.editor) {
    const ed = t.editor;
    item(ed.note.html.includes('data-checklist') ? 'Ukryj pola wyboru' : 'Pokaż pola wyboru', () => {
      ed.focus(true);
      ed.toggleChecklist();
    });
  }
  if (info.attachSupported) item(t.note().attach ? 'Zmień przypięcie do pliku lub folderu…' : 'Przypnij do pliku lub folderu…', () => attachMenu(anchor, t.note().attach ?? null, path => t.patch({ attach: path }, path ? 'Karteczka pokaże się sama, gdy otworzysz: ' + baseName(path) : 'Odpięto od pliku')));
}

// ---------- przypomnienia ----------

function reminderChip(r: Reminder, edit: (b: HTMLElement) => void, remove: () => void): HTMLElement {
  const shown = reminderShown(r);
  const chip = h('span', 'chip rem' + (shown.past ? ' past' : ''));
  chip.innerHTML = `${icon(r.repeat === 'none' ? 'clock' : 'repeat', 16)}<span>${escapeHtml(formatReminder(shown.at))}</span>`;
  chip.title = r.repeat === 'none' ? 'Przypomnienie' : 'Przypomnienie: ' + REPEATS.find(x => x.id === r.repeat)!.name.toLowerCase();
  chip.onclick = e => {
    e.stopPropagation();
    edit(chip);
  };
  const x = iconButton('close', 'Usuń przypomnienie', () => remove(), 14);
  x.classList.add('chip-x');
  chip.append(x);
  return chip;
}

/** Menu przypomnienia jak w Keep: szybkie terminy albo własna data, godzina i powtarzanie. */
function remMenu(anchor: HTMLElement, current: Reminder | null, apply: (r: Reminder | null) => void): void {
  const pop = popover(anchor, 'rem-menu');
  const quick = () => {
    pop.replaceChildren(h('div', 'rem-head', 'Przypomnienie:'));
    for (const q of quickReminders()) {
      const d = new Date(q.at);
      const time = d.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
      const when = q.label === 'W przyszłym tygodniu' ? `${d.toLocaleDateString('pl-PL', { weekday: 'short' })}, ${time}` : time;
      const b = h('button', 'menu-item rem-q', `<span>${q.label}</span><span class="rem-when">${escapeHtml(when)}</span>`);
      b.onclick = () => {
        pop.remove();
        apply({ at: q.at, repeat: current?.repeat ?? 'none' });
      };
      pop.append(b);
    }
    const custom = h('button', 'menu-item', `${icon('clock', 18)}<span>Wybierz datę i godzinę</span>`);
    custom.onclick = () => form();
    pop.append(custom);
    if (current) {
      const del = h('button', 'menu-item', `${icon('bellOff', 18)}<span>Usuń przypomnienie</span>`);
      del.onclick = () => {
        pop.remove();
        apply(null);
      };
      pop.append(del);
    }
  };
  const form = () => {
    const start = current ? new Date(nextOccurrence(current) ?? current.at) : new Date(quickReminders().find(q => q.label === 'Jutro')!.at);
    const pad = (x: number) => String(x).padStart(2, '0');
    const dateVal = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`;
    const timeVal = `${pad(start.getHours())}:${pad(start.getMinutes())}`;
    pop.innerHTML = `
      <div class="rem-head row">${''}</div>
      <label class="field"><span>Data</span><input type="date" id="remDate" value="${dateVal}"></label>
      <label class="field"><span>Godzina</span><input type="time" id="remTime" value="${timeVal}"></label>
      <label class="field"><span>Powtarzanie</span><select id="remRepeat">${REPEATS.map(r => `<option value="${r.id}"${r.id === (current?.repeat ?? 'none') ? ' selected' : ''}>${r.name}</option>`).join('')}</select></label>
      <div class="rem-foot"><button class="btn ghost" id="remSave">Zapisz</button></div>`;
    const head = pop.querySelector('.rem-head')!;
    head.append(iconButton('back', 'Wróć', () => quick()), h('span', '', 'Wybierz datę i godzinę'));
    pop.querySelector<HTMLButtonElement>('#remSave')!.onclick = () => {
      const date = pop.querySelector<HTMLInputElement>('#remDate')!.value;
      const time = pop.querySelector<HTMLInputElement>('#remTime')!.value || '08:00';
      const repeat = pop.querySelector<HTMLSelectElement>('#remRepeat')!.value as Repeat;
      const [y, m, d] = date.split('-').map(Number);
      const [hh, mm] = time.split(':').map(Number);
      if (!y || !m || !d) {
        toast('Wybierz datę przypomnienia.');
        return;
      }
      const at = new Date(y, m - 1, d, hh, mm, 0, 0).getTime();
      if (repeat === 'none' && at <= Date.now()) {
        toast('Ten termin już minął — wybierz późniejszy.');
        return;
      }
      pop.remove();
      apply({ at, repeat });
    };
  };
  quick();
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
  await update(n, { trashedAt: Date.now() }, 'Notatka przeniesiona do kosza', { trashedAt: null });
}

async function copyNote(n: Note): Promise<void> {
  try {
    const res = await api.save({ ...n, id: newId(), createdAt: 0, updatedAt: 0, pinned: false, attach: null }, 0);
    notes.set(res.note.id, res.note);
    toast('Utworzono kopię notatki');
    render();
  } catch (e) {
    toast('Nie udało się utworzyć kopii: ' + errorText(e));
  }
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
  const ok = await ask(`Opróżnić kosz? Wszystkie notatki z kosza (${trashed.length}) zostaną usunięte na zawsze.`, {
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
    toast(errorText(e));
  }
}

// ---------- przypinanie do pliku lub folderu ----------

function attachChip(path: string, remove?: () => void): HTMLElement {
  const chip = h('span', 'chip', `${icon('clip', 16)}<span>${escapeHtml(baseName(path))}</span>`);
  chip.title = 'Pokazuje się sama przy: ' + path;
  if (remove) {
    const x = iconButton('close', 'Odepnij od pliku', () => remove(), 14);
    x.classList.add('chip-x');
    chip.append(x);
  }
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

// ---------- wspólne elementy edytora (okno notatki i pasek tworzenia) ----------

interface Shell {
  root: HTMLElement;
  repaint(): void;
}

/** Nagłówek z przypinką, „chipy” i pasek akcji wokół edytora — tak jak w Keep. */
function editorShell(ed: NoteEditor, root: HTMLElement, baseClass: string, opts: { close(): Promise<void>; afterArchiveOrTrash(): void }): Shell {
  const head = h('div', 'ed-head');
  ed.title.replaceWith(head);
  const pin = iconButton('pin', '', () => {
    ed.patch({ pinned: !ed.note.pinned });
    repaint();
  }, 22);
  head.append(ed.title, pin);
  const chips = h('div', 'chips ed-chips');
  const stamp = h('div', 'stamp');
  const foot = h('div', 'ed-foot');
  const done = h('button', 'btn ghost close-btn', 'Zamknij');
  done.onclick = () => void opts.close();
  const ensureSaved = async (): Promise<boolean> => {
    if (ed.base === 0 && ed.isEmpty) {
      toast('Najpierw coś napisz.');
      return false;
    }
    if (ed.base === 0) ed.markDirty();
    await ed.flush();
    return true;
  };
  const target: Target = {
    note: () => ed.note,
    editor: ed,
    patch: (fields, message, undo) => {
      ed.patch(fields);
      if ('archived' in fields) {
        const id = ed.note.id;
        void opts.close().then(() => {
          opts.afterArchiveOrTrash();
          const saved = notes.get(id);
          if (message) toast(message, saved && undo ? { label: 'Cofnij', run: () => void update(saved, undo) } : undefined);
        });
        return;
      }
      if (message && 'attach' in fields) toast(message);
      repaint();
    },
    trash: () => {
      if (ed.base === 0 && ed.isEmpty) return void opts.close();
      ed.patch({ trashedAt: Date.now() });
      const id = ed.note.id;
      void opts.close().then(async () => {
        await api.closeSticky(id).catch(() => undefined);
        const saved = notes.get(id);
        toast('Notatka przeniesiona do kosza', saved ? { label: 'Cofnij', run: () => void update(saved, { trashedAt: null }) } : undefined);
      });
    },
    desktop: async () => {
      if (!(await ensureSaved())) return;
      await pinToDesktop(ed.note);
      await opts.close();
    },
  };
  const fmt = iconButton('format', 'Formatowanie tekstu', b => b.classList.toggle('on', ed.toggleFormat()));
  const bar = actionBar(target);
  bar.insertBefore(fmt, bar.children[2] ?? null);
  foot.append(bar, done);
  // Kolejność jak w Keep: treść, „chipy”, data zmiany, (pasek formatowania), pasek akcji.
  ed.body.after(chips, stamp);
  root.append(ed.el, foot);
  function repaint(): void {
    root.className = `${baseClass} c-${ed.note.color}`;
    pin.innerHTML = icon(ed.note.pinned ? 'pinOn' : 'pin', 22);
    pin.title = ed.note.pinned ? 'Odepnij od góry' : 'Przypnij u góry';
    pin.classList.toggle('on', !!ed.note.pinned);
    chips.replaceChildren();
    if (ed.note.reminder)
      chips.append(
        reminderChip(ed.note.reminder, b => remMenu(b, ed.note.reminder ?? null, r => target.patch({ reminder: r })), () => target.patch({ reminder: null })),
      );
    if (ed.note.attach) chips.append(attachChip(ed.note.attach, () => target.patch({ attach: null }, 'Odpięto od pliku')));
    stamp.textContent = ed.note.updatedAt ? 'Zmieniono ' + formatDate(ed.note.updatedAt) : '';
  }
  repaint();
  return { root, repaint };
}

// ---------- pasek „Utwórz notatkę…” ----------

function collapseComposer(): void {
  const box = $('composer');
  composerEditor = null;
  closeComposer = null;
  box.className = 'composer';
  box.innerHTML = `<div class="composer-ph" tabindex="0">Utwórz notatkę…</div>`;
  box.append(
    iconButton('check', 'Nowa lista', () => openComposer({ list: true }), 22),
    iconButton('image', 'Nowa notatka z obrazem', () => openComposer({ image: true }), 22),
  );
  const ph = box.querySelector<HTMLElement>('.composer-ph')!;
  ph.onclick = () => openComposer();
  ph.onkeydown = e => {
    if (e.key === 'Enter') openComposer();
  };
}

function openComposer(opt: { list?: boolean; image?: boolean } = {}): void {
  if (composerEditor) {
    composerEditor.focus(false);
    return;
  }
  if (view !== 'notes' && view !== 'reminders') setView('notes');
  const box = $('composer');
  const n = emptyNote(info.defaultColor);
  if (view === 'reminders') n.reminder = { at: quickReminders()[0].at, repeat: 'none' };
  const ed = new NoteEditor(n, {
    formatHidden: true,
    placeholder: 'Utwórz notatkę…',
    onSaved: saved => {
      notes.set(saved.id, saved);
      shell.repaint();
      render();
    },
  });
  composerEditor = ed;
  box.replaceChildren();
  const shell = editorShell(ed, box, 'composer open', {
    close: () => close(),
    afterArchiveOrTrash: () => undefined,
  });
  let closing = false;
  async function close(): Promise<void> {
    if (closing) return;
    closing = true;
    document.removeEventListener('mousedown', outside, true);
    if (ed.base === 0 && !ed.isEmpty) ed.markDirty();
    await ed.flush();
    collapseComposer();
    render();
  }
  function outside(e: MouseEvent): void {
    const t = e.target as Element;
    if (box.contains(t) || t.closest('.popover, .backdrop, .toasts')) return;
    void close();
  }
  setTimeout(() => document.addEventListener('mousedown', outside, true));
  closeComposer = close;
  requestAnimationFrame(() => {
    if (opt.list) {
      ed.body.focus();
      ed.toggleChecklist();
    } else if (opt.image) {
      ed.body.focus();
      ed.pickImage();
    } else {
      ed.body.focus();
    }
  });
}

// ---------- okno notatki ----------

function openEditor(n: Note): void {
  if (editor) return;
  closePopovers();
  void closeComposer?.();
  const backdrop = h('div', 'backdrop');
  const modal = h('div', 'modal note-modal');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-label', 'Edycja notatki');
  const ed = new NoteEditor(n, {
    formatHidden: true,
    onSaved: saved => {
      notes.set(saved.id, saved);
      shell.repaint();
      render();
    },
    onConflict: () =>
      toast('Ta notatka zmieniła się w międzyczasie na innym komputerze. Twoje zmiany zapisały się jako osobna notatka „(konflikt zmian)”.', undefined, 10000),
  });
  editor = ed;
  const shell = editorShell(ed, modal, 'modal note-modal', { close: () => close(), afterArchiveOrTrash: () => undefined });
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
  requestAnimationFrame(() => ed.focus(true));
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
      <h3>Przypomnienia</h3>
      <p class="hint">O wyznaczonej godzinie Windows pokaże powiadomienie, a notatka wyskoczy jako karteczka na pulpicie. Przypomnienia działają, gdy Karteczki pracują w tle.</p>
    </section>
    <section>
      <h3>Praca w tle</h3>
      <p class="hint">Zamknięcie okna krzyżykiem tylko je chowa — Karteczki działają dalej, więc karteczki na pulpicie, przy plikach i przypomnienia nadal się pokazują. Okno otworzysz ponownie, klikając ikonę Karteczek na pasku zadań lub w menu Start.</p>
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
    const ok = await ask('Zamknąć Karteczki całkowicie? Karteczki na pulpicie, przy plikach i przypomnienia przestaną się pokazywać do następnego uruchomienia.', {
      title: 'Karteczki',
      kind: 'warning',
      okLabel: 'Zakończ',
      cancelLabel: 'Anuluj',
    });
    if (ok) {
      if (closeEditor) await closeEditor();
      if (closeComposer) await closeComposer();
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
    if (!manual && pref('pominieta-wersja', '') === latest) return;
    const exe = rel.assets?.find(a => /setup\.exe$/i.test(a.name)) ?? rel.assets?.find(a => /\.exe$/i.test(a.name));
    const url = exe?.browser_download_url ?? rel.html_url;
    const banner = $('banner');
    banner.innerHTML = `<div class="banner">${icon('refresh', 18)}<span>Jest nowa wersja Karteczek: <b>${escapeHtml(latest)}</b> (masz ${escapeHtml(info.version)}).</span>
      <button class="btn small" id="updGet">Pobierz</button><button class="btn small ghost" id="updLater">Później</button></div>`;
    $('updGet').onclick = () => {
      openLink(url);
      toast('Po pobraniu uruchom instalator. Karteczki zamkną się na czas aktualizacji, notatki zostają.', undefined, 10000);
    };
    $('updLater').onclick = () => {
      setPref('pominieta-wersja', latest);
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
