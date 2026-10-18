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
}

export type View = 'notes' | 'archive' | 'trash';

export const COLORS: { id: string; name: string }[] = [
  { id: 'default', name: 'Domyślny' },
  { id: 'red', name: 'Czerwony' },
  { id: 'orange', name: 'Pomarańczowy' },
  { id: 'yellow', name: 'Żółty' },
  { id: 'green', name: 'Zielony' },
  { id: 'teal', name: 'Turkusowy' },
  { id: 'blue', name: 'Niebieski' },
  { id: 'purple', name: 'Fioletowy' },
  { id: 'pink', name: 'Różowy' },
];

export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

export function emptyNote(color = 'default'): Note {
  return { id: newId(), title: '', html: '', color, archived: false, trashedAt: null, createdAt: 0, updatedAt: 0, attach: null };
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
