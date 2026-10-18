// Drobne elementy interfejsu wspólne dla okna głównego i karteczek.
import { openUrl } from '@tauri-apps/plugin-opener';
import { COLORS, escapeHtml } from './logic';

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', html = ''): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (html) el.innerHTML = html;
  return el;
}

let toastBox: HTMLElement | null = null;

export function toast(message: string, action?: { label: string; run: () => void }, ms = 6000): void {
  if (!toastBox) {
    toastBox = h('div', 'toasts');
    toastBox.setAttribute('role', 'status');
    document.body.append(toastBox);
  }
  const t = h('div', 'toast', `<span>${escapeHtml(message)}</span>`);
  if (action) {
    const b = h('button', 'toast-btn', escapeHtml(action.label));
    b.onclick = () => {
      action.run();
      t.remove();
    };
    t.append(b);
  }
  toastBox.append(t);
  setTimeout(() => t.remove(), ms);
}

/** Paleta kolorów pokazywana przy przycisku. */
export function colorPicker(anchor: HTMLElement, current: string, pick: (color: string) => void): void {
  closePopovers();
  const pop = h('div', 'popover palette');
  for (const c of COLORS) {
    const b = h('button', `swatch c-${c.id}${c.id === current ? ' on' : ''}`);
    b.title = c.name;
    b.setAttribute('aria-label', c.name);
    b.onclick = e => {
      e.stopPropagation();
      pop.remove();
      pick(c.id);
    };
    pop.append(b);
  }
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth, hgt = pop.offsetHeight;
  const left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), innerWidth - w - 8);
  const top = r.bottom + hgt + 8 > innerHeight ? r.top - hgt - 6 : r.bottom + 6;
  pop.style.left = left + 'px';
  pop.style.top = Math.max(8, top) + 'px';
  setTimeout(() => document.addEventListener('mousedown', outside, true));
  function outside(e: MouseEvent) {
    if (!pop.contains(e.target as Node)) {
      pop.remove();
      document.removeEventListener('mousedown', outside, true);
    }
  }
}

/** Pusty dymek przy przycisku; zamyka się po kliknięciu obok. */
export function popover(anchor: HTMLElement, cls: string): HTMLElement {
  closePopovers();
  const pop = h('div', 'popover ' + cls);
  document.body.append(pop);
  const place = () => {
    const r = anchor.getBoundingClientRect();
    const w = pop.offsetWidth, hgt = pop.offsetHeight;
    pop.style.left = Math.min(Math.max(8, r.left), innerWidth - w - 8) + 'px';
    pop.style.top = Math.max(8, r.bottom + hgt + 8 > innerHeight ? r.top - hgt - 6 : r.bottom + 6) + 'px';
  };
  requestAnimationFrame(place);
  // Gdy zawartość dymka się zmienia (np. wybór daty), dymek przesuwa się, żeby zmieścić się w oknie.
  new ResizeObserver(() => place()).observe(pop);
  setTimeout(() => document.addEventListener('mousedown', outside, true));
  function outside(e: MouseEvent) {
    if (!pop.isConnected) return document.removeEventListener('mousedown', outside, true);
    if (!pop.contains(e.target as Node)) {
      pop.remove();
      document.removeEventListener('mousedown', outside, true);
    }
  }
  return pop;
}

export function closePopovers(): void {
  document.querySelectorAll('.popover').forEach(p => p.remove());
}

/** Linki nigdy nie otwierają się w oknie aplikacji — tylko w przeglądarce. */
export function guardLinks(): void {
  document.addEventListener(
    'click',
    e => {
      if ((e.target as Element)?.closest?.('a[href]')) e.preventDefault();
    },
    true,
  );
  document.addEventListener('auxclick', e => {
    if ((e.target as Element)?.closest?.('a[href]')) e.preventDefault();
  });
  // Upuszczenie pliku poza edytorem nie może podmienić strony.
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => e.preventDefault());
}

export function openLink(href: string): void {
  if (/^(https?:|mailto:)/i.test(href)) openUrl(href).catch(err => toast('Nie udało się otworzyć linku: ' + err));
}
