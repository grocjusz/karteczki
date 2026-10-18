import { describe, expect, it } from 'vitest';
import {
  daysLeftInTrash,
  emptyNote,
  fold,
  inView,
  isBlank,
  isNewer,
  linkify,
  matches,
  renderHtml,
  sanitize,
  serializeHtml,
  type Note,
} from '../src/logic';

const note = (p: Partial<Note>): Note => ({ ...emptyNote(), ...p });

describe('filtr HTML', () => {
  it('usuwa skrypty, zdarzenia i niebezpieczne linki', () => {
    const out = sanitize('<p onclick="x()">a<script>alert(1)</script><img src=x onerror="alert(1)"><a href="javascript:alert(1)">b</a></p>');
    expect(out).not.toMatch(/script|onerror|onclick|javascript/i);
  });
  it('zostawia formatowanie, listę zadań i obrazki notatki', () => {
    const html = '<p><b>a</b> <i>b</i> <u>c</u></p><ul data-checklist="1"><li data-checked="true">x</li></ul><img data-img="abc.png"><a href="https://example.com">l</a>';
    expect(sanitize(html)).toBe(html);
  });
  it('nie przepuszcza stylów ani klas ze stron', () => {
    expect(sanitize('<span style="color:red" class="x">a</span>')).toBe('<span>a</span>');
  });
});

describe('obrazki', () => {
  it('renderHtml dodaje adres, serializeHtml go usuwa', () => {
    const shown = renderHtml('<p>a</p><img data-img="abc.png">', 'http://kimg.localhost/');
    expect(shown).toContain('src="http://kimg.localhost/abc.png"');
    const box = document.createElement('div');
    box.innerHTML = shown;
    expect(serializeHtml(box)).toBe('<p>a</p><img data-img="abc.png">');
  });
  it('pusta treść zapisuje się jako pusty tekst', () => {
    const box = document.createElement('div');
    box.innerHTML = '<p><br></p>';
    expect(serializeHtml(box)).toBe('');
    expect(isBlank('<img data-img="a.png">')).toBe(false);
  });
});

describe('linki', () => {
  it('zamienia adresy na linki, pomija istniejące linki i kropkę na końcu', () => {
    const box = document.createElement('div');
    box.innerHTML = '<p>Zobacz https://example.com/a?b=1. oraz <a href="https://x.pl">https://x.pl</a></p>';
    expect(linkify(box)).toBe(true);
    const links = box.querySelectorAll('a');
    expect(links.length).toBe(2);
    expect(links[0].getAttribute('href')).toBe('https://example.com/a?b=1');
    expect(linkify(box)).toBe(false);
  });
});

describe('wyszukiwanie', () => {
  it('ignoruje wielkość liter i polskie znaki', () => {
    expect(fold('Żółw ŁÓDŹ')).toBe('zolw lodz');
    const n = note({ title: 'Zakupy', html: '<ul><li>Masło</li><li>Jabłka</li></ul>' });
    expect(matches(n, 'maslo')).toBe(true);
    expect(matches(n, 'zakupy jablka')).toBe(true);
    expect(matches(n, 'chleb')).toBe(false);
    expect(matches(n, '  ')).toBe(true);
  });
});

describe('widoki i kosz', () => {
  it('przydziela notatki do widoków', () => {
    const active = note({});
    const archived = note({ archived: true });
    const trashed = note({ archived: true, trashedAt: 1 });
    expect([active, archived, trashed].map(n => inView(n, 'notes'))).toEqual([true, false, false]);
    expect([active, archived, trashed].map(n => inView(n, 'archive'))).toEqual([false, true, false]);
    expect([active, archived, trashed].map(n => inView(n, 'trash'))).toEqual([false, false, true]);
  });
  it('liczy dni do usunięcia z kosza', () => {
    const day = 86_400_000;
    expect(daysLeftInTrash(note({ trashedAt: 0 }), 0)).toBe(30);
    expect(daysLeftInTrash(note({ trashedAt: 0 }), 29.5 * day)).toBe(1);
    expect(daysLeftInTrash(note({ trashedAt: 0 }), 40 * day)).toBe(0);
  });
});

describe('wersje', () => {
  it('porównuje numery wersji', () => {
    expect(isNewer('v1.0.1', '1.0.0')).toBe(true);
    expect(isNewer('1.2.10', '1.2.9')).toBe(true);
    expect(isNewer('1.0.0', '1.0.0')).toBe(false);
    expect(isNewer('0.9.9', '1.0.0')).toBe(false);
  });
});
