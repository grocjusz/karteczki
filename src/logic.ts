// Czysta logika bez zależności od okna aplikacji — łatwa do testowania.
import DOMPurify from 'dompurify';

export interface Note {
  id: string;
  title: string;
  html: string;
  color: string;
  archived: boolean;
  trashedAt: number | null;
  createdAt: number;
  updatedAt: number;
  /** Plik lub folder, przy którym karteczka pokazuje się sama. */
  attach?: string | null;
  /** Przypięta u góry listy. */
  pinned?: boolean;
  reminder?: Reminder | null;
}

export type Repeat = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly';

export interface Reminder {
  at: number;
  repeat: Repeat;
}

export type View = 'notes' | 'reminders' | 'archive' | 'trash';

export const COLORS: { id: string; name: string }[] = [
  { id: 'default', name: 'Bez koloru' },
  { id: 'red', name: 'Koralowy' },
  { id: 'orange', name: 'Brzoskwiniowy' },
  { id: 'yellow', name: 'Piaskowy' },
  { id: 'green', name: 'Miętowy' },
  { id: 'teal', name: 'Szałwiowy' },
  { id: 'blue', name: 'Mglisty' },
  { id: 'storm', name: 'Burzowy' },
  { id: 'purple', name: 'Zmierzchowy' },
  { id: 'pink', name: 'Kwiatowy' },
  { id: 'clay', name: 'Gliniany' },
  { id: 'chalk', name: 'Kredowy' },
];

export const REPEATS: { id: Repeat; name: string }[] = [
  { id: 'none', name: 'Nie powtarza się' },
  { id: 'daily', name: 'Codziennie' },
  { id: 'weekly', name: 'Co tydzień' },
  { id: 'monthly', name: 'Co miesiąc' },
  { id: 'yearly', name: 'Co rok' },
];

/** Termin numer n (0 = pierwszy), w czasie lokalnym — tak samo jak w rdzeniu aplikacji. */
export function nthOccurrence(r: Reminder, n: number): number | null {
  if (n === 0) return r.at;
  const d = new Date(r.at);
  const day = d.getDate();
  switch (r.repeat) {
    case 'none':
      return null;
    case 'daily':
      d.setDate(day + n);
      return d.getTime();
    case 'weekly':
      d.setDate(day + 7 * n);
      return d.getTime();
    case 'monthly':
    case 'yearly': {
      const months = r.repeat === 'monthly' ? n : 12 * n;
      const target = new Date(d.getFullYear(), d.getMonth() + months, 1, d.getHours(), d.getMinutes(), d.getSeconds());
      const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
      target.setDate(Math.min(day, last));
      return target.getTime();
    }
  }
}

/** Najbliższy przyszły termin albo null, gdy jednorazowe przypomnienie już minęło. */
export function nextOccurrence(r: Reminder, now = Date.now()): number | null {
  if (r.at > now) return r.at;
  if (r.repeat === 'none') return null;
  const step = { daily: 1, weekly: 7, monthly: 30, yearly: 365, none: 1 }[r.repeat] * 86_400_000;
  let n = Math.max(0, Math.floor((now - r.at) / step) - 1);
  let t = nthOccurrence(r, n);
  while (t !== null && t <= now) t = nthOccurrence(r, ++n);
  return t;
}

/** Termin do pokazania na karcie: najbliższy przyszły albo — dla minionego — ten, który minął. */
export function reminderShown(r: Reminder, now = Date.now()): { at: number; past: boolean } {
  const next = nextOccurrence(r, now);
  return next === null ? { at: r.at, past: true } : { at: next, past: false };
}

const DAY = 86_400_000;
function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** „Dziś, 20:00”, „Jutro, 08:00”, „pon., 20 paź, 08:00”, z rokiem, gdy inny niż bieżący. */
export function formatReminder(ms: number, now = Date.now()): string {
  const time = new Date(ms).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
  const days = Math.round((startOfDay(ms) - startOfDay(now)) / DAY);
  if (days === 0) return `Dziś, ${time}`;
  if (days === 1) return `Jutro, ${time}`;
  if (days === -1) return `Wczoraj, ${time}`;
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  const date = d.toLocaleDateString('pl-PL', { weekday: 'short', day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
  return `${date}, ${time}`;
}

/** Szybkie terminy jak w Keep: później dziś, jutro rano, w przyszły poniedziałek. */
export function quickReminders(now = Date.now()): { label: string; at: number }[] {
  const d = new Date(now);
  const at = (days: number, h: number) => {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, h, 0, 0, 0);
    return x.getTime();
  };
  const out: { label: string; at: number }[] = [];
  if (d.getHours() < 18) out.push({ label: 'Później dzisiaj', at: at(0, 20) });
  out.push({ label: 'Jutro', at: at(1, 8) });
  const toMonday = ((8 - d.getDay()) % 7) || 7;
  out.push({ label: 'W przyszłym tygodniu', at: at(toMonday, 8) });
  return out;
}

export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

export function emptyNote(color = 'default'): Note {
  return { id: newId(), title: '', html: '', color, archived: false, trashedAt: null, createdAt: 0, updatedAt: 0, attach: null, pinned: false, reminder: null };
}

/** Nazwa pliku lub folderu z pełnej ścieżki Windows. */
export function baseName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
}

const ALLOWED_TAGS = ['p', 'div', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'h1', 'h2', 'h3', 'ul', 'ol', 'li', 'a', 'img', 'blockquote', 'code', 'pre', 'span', 'hr'];
const ALLOWED_ATTR = ['href', 'data-img', 'data-checklist', 'data-checked'];

/** Treść notatki może pochodzić z OneDrive, więc zawsze przechodzi przez filtr HTML. */
export function sanitize(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:)/i,
    ALLOW_DATA_ATTR: false,
    // Wartości tych atrybutów to nazwy plików i znaczniki, nie adresy — nie sprawdzamy ich jak linków.
    ADD_URI_SAFE_ATTR: ['data-img', 'data-checklist', 'data-checked'],
  });
}

/** Adres obrazka zależy od systemu: na Windows własne protokoły działają przez http://<nazwa>.localhost. */
export function imageBase(userAgent = navigator.userAgent): string {
  return /Windows/i.test(userAgent) ? 'http://kimg.localhost/' : 'kimg://localhost/';
}

/** Przygotowuje zapisany HTML do wyświetlenia: filtr + adresy obrazków. */
export function renderHtml(html: string, base = imageBase()): string {
  const tpl = document.createElement('template');
  tpl.innerHTML = sanitize(html);
  tpl.content.querySelectorAll('img[data-img]').forEach(img => {
    img.setAttribute('src', base + encodeURIComponent(img.getAttribute('data-img') || ''));
    img.setAttribute('loading', 'lazy');
  });
  tpl.content.querySelectorAll('a[href]').forEach(a => a.setAttribute('rel', 'noopener'));
  return tpl.innerHTML;
}

/** Odwrotność renderHtml: przed zapisem usuwamy adresy obrazków, zostaje tylko nazwa pliku. */
export function serializeHtml(container: HTMLElement): string {
  const clone = container.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('img').forEach(img => {
    img.removeAttribute('src');
    img.removeAttribute('loading');
  });
  clone.querySelectorAll('a').forEach(a => a.removeAttribute('rel'));
  const html = sanitize(clone.innerHTML);
  return isBlank(html) ? '' : html;
}

export function isBlank(html: string): boolean {
  return !/<img/i.test(html) && html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim() === '';
}

const URL_RE = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/gi;

/** Zamienia zwykłe adresy stron w tekście na klikalne linki (poza istniejącymi linkami i kodem). */
export function linkify(root: HTMLElement): boolean {
  let changed = false;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: n => (n.parentElement?.closest('a,code,pre') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const node of nodes) {
    const text = node.data;
    URL_RE.lastIndex = 0;
    if (!URL_RE.test(text)) continue;
    URL_RE.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of text.matchAll(URL_RE)) {
      const i = m.index ?? 0;
      if (i > last) frag.append(text.slice(last, i));
      const a = document.createElement('a');
      a.href = m[0];
      a.textContent = m[0];
      frag.append(a);
      last = i + m[0].length;
    }
    if (last < text.length) frag.append(text.slice(last));
    node.replaceWith(frag);
    changed = true;
  }
  return changed;
}

export function plainText(html: string): string {
  return html
    .replace(/<\/(p|div|li|h[1-3])>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/** Wyszukiwanie bez rozróżniania wielkości liter i polskich znaków („zolw” znajdzie „żółw”). */
export function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l').replace(/Ł/g, 'l').toLowerCase();
}

export function matches(note: Note, query: string): boolean {
  const q = fold(query.trim());
  if (!q) return true;
  const hay = fold(note.title + '\n' + plainText(note.html));
  return q.split(/\s+/).every(word => hay.includes(word));
}

export function inView(note: Note, view: View): boolean {
  if (view === 'trash') return note.trashedAt !== null;
  if (note.trashedAt !== null) return false;
  if (view === 'reminders') return !!note.reminder;
  return view === 'archive' ? note.archived : !note.archived;
}

export function daysLeftInTrash(note: Note, now = Date.now(), days = 30): number {
  if (note.trashedAt === null) return days;
  return Math.max(0, Math.ceil((note.trashedAt + days * 86_400_000 - now) / 86_400_000));
}

/** Porównanie wersji „1.2.10” > „1.2.9”; prefiks „v” jest pomijany. */
export function isNewer(candidate: string, current: string): boolean {
  const parse = (v: string) => v.replace(/^v/i, '').split(/[.+-]/).slice(0, 3).map(x => parseInt(x, 10) || 0);
  const a = parse(candidate), b = parse(current);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

export function formatDate(ms: number): string {
  if (!ms) return '';
  return new Date(ms).toLocaleString('pl-PL', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}
