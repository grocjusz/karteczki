// Karteczka na pulpicie albo przy pliku — osobne, małe okno bez ramki.
// Okno bez ramki nie ma systemowego paska ani krawędzi, więc przesuwanie (za górny pasek)
// i zmianę rozmiaru (za brzegi i róg) obsługuje sama karteczka.
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { api, errorText } from './api';
import { NoteEditor } from './editor';
import { icon } from './icons';
import { baseName, type Note } from './logic';
import { colorPicker, h, toast } from './ui';

type ResizeDirection = Parameters<ReturnType<typeof getCurrentWindow>['startResizeDragging']>[0];

const EDGES: [string, ResizeDirection][] = [
  ['n', 'North'],
  ['s', 'South'],
  ['e', 'East'],
  ['w', 'West'],
  ['ne', 'NorthEast'],
  ['nw', 'NorthWest'],
  ['se', 'SouthEast'],
  ['sw', 'SouthWest'],
];

export async function startSticky(id: string): Promise<void> {
  document.body.classList.add('sticky-mode');
  const win = getCurrentWindow();
  let note: Note | undefined;
  try {
    note = (await api.list()).find(n => n.id === id);
  } catch (e) {
    toast('Nie udało się wczytać notatki: ' + errorText(e));
  }
  if (!note || note.trashedAt !== null) {
    await api.closeSticky(id);
    return;
  }

  const root = h('div', `sticky c-${note.color}`);
  const bar = h('div', 'sticky-bar');
  const btn = (ic: string, title: string) => {
    const b = h('button', 'icon-btn', icon(ic, 16));
    b.title = title;
    b.setAttribute('aria-label', title);
    b.addEventListener('mousedown', e => e.preventDefault());
    return b;
  };
  const colorBtn = btn('palette', 'Kolor');
  const grip = h('div', 'grip', icon('grip', 16));
  grip.title = 'Przytrzymaj i przeciągnij, aby przesunąć karteczkę';
  const clip = h('span', 'sticky-clip');
  const topBtn = btn('pin', 'Zawsze na wierzchu');
  const openBtn = btn('open', 'Otwórz w oknie Karteczek');
  const closeBtn = btn('close', 'Odepnij z pulpitu (notatka zostaje)');
  bar.append(colorBtn, grip, clip, topBtn, openBtn, closeBtn);

  // Przesuwanie: cały pasek oprócz przycisków.
  bar.addEventListener('mousedown', e => {
    if (e.button !== 0 || (e.target as Element).closest('button')) return;
    e.preventDefault();
    win.startDragging().catch(err => toast('Nie udało się przesunąć: ' + errorText(err)));
  });

  // Zmiana rozmiaru: niewidoczne brzegi i widoczny uchwyt w prawym dolnym rogu.
  const handles = EDGES.map(([cls, dir]) => {
    const el = h('div', `rs rs-${cls}`);
    el.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      win.startResizeDragging(dir).catch(err => toast('Nie udało się zmienić rozmiaru: ' + errorText(err)));
    });
    return el;
  });
  const corner = h('div', 'rs-corner');
  corner.title = 'Przeciągnij, aby zmienić rozmiar';
  corner.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    win.startResizeDragging('SouthEast').catch(err => toast('Nie udało się zmienić rozmiaru: ' + errorText(err)));
  });

  const editor = new NoteEditor(note, {
    compact: true,
    onConflict: (original, copy) => {
      // Nasza wersja jest teraz osobną notatką — pokazujemy ją na osobnej karteczce.
      void api.openSticky(copy.id);
      editor.load(original);
      toast('Notatka zmieniła się na innym komputerze. Twoja wersja jest na nowej karteczce.', undefined, 10000);
    },
  });
  root.append(bar, editor.el, corner, ...handles);
  document.body.append(root);

  let onTop = await api.stickyOnTop(id).catch(() => false);
  const showMode = () => {
    const attached = editor.note.attach ?? null;
    root.classList.toggle('attached', !!attached);
    topBtn.hidden = !!attached;
    topBtn.innerHTML = icon(onTop ? 'pinOn' : 'pin', 16);
    topBtn.classList.toggle('on', onTop);
    topBtn.title = onTop ? 'Na wierzchu — kliknij, aby wyłączyć' : 'Zawsze na wierzchu';
    clip.innerHTML = attached ? icon('clip', 14) : '';
    clip.title = attached ? 'Pokazuje się sama przy: ' + attached : '';
    closeBtn.title = attached
      ? `Schowaj (wróci, gdy znów otworzysz ${baseName(attached)})`
      : 'Odepnij z pulpitu (notatka zostaje)';
    document.title = editor.note.title || 'Karteczka';
  };
  showMode();

  topBtn.onclick = async () => {
    onTop = !onTop;
    showMode();
    await api.setStickyOnTop(id, onTop).catch(e => toast(errorText(e)));
  };
  colorBtn.onclick = () =>
    colorPicker(colorBtn, editor.note.color, c => {
      root.className = `sticky c-${c}`;
      editor.patch({ color: c });
      showMode();
    });
  openBtn.onclick = async () => {
    await editor.flush();
    await api.showMain(editor.note.id);
  };
  closeBtn.onclick = async () => {
    await editor.flush();
    await api.closeSticky(id);
  };

  const refresh = (n: Note) => {
    if (n.id !== editor.note.id) return;
    if (n.trashedAt !== null) {
      void editor.flush().then(() => api.closeSticky(id));
      return;
    }
    editor.applyExternal(n);
    if (!editor.dirty && n.updatedAt >= editor.base) {
      editor.note.color = n.color;
      editor.note.attach = n.attach ?? null;
    }
    root.className = `sticky c-${editor.note.color}`;
    showMode();
  };
  await listen<Note>('note-saved', ({ payload }) => refresh(payload));
  await listen('notes-external', async () => {
    const list = await api.list().catch(() => null);
    const n = list?.find(x => x.id === editor.note.id);
    if (n) refresh(n);
  });

  window.addEventListener('blur', () => void editor.flush());
  window.addEventListener('beforeunload', () => void editor.flush());
  if (!note.title && !note.html) editor.focus(true);
}
