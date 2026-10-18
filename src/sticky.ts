// Karteczka przypięta na pulpicie — osobne, małe okno bez ramki.
import { listen } from '@tauri-apps/api/event';
import { api, errorText } from './api';
import { NoteEditor } from './editor';
import { icon } from './icons';
import type { Note } from './logic';
import { colorPicker, h, toast } from './ui';

export async function startSticky(id: string): Promise<void> {
  document.body.classList.add('sticky-mode');
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
  bar.setAttribute('data-tauri-drag-region', '');
  const grip = h('div', 'grip');
  grip.setAttribute('data-tauri-drag-region', '');
  const btn = (ic: string, title: string) => {
    const b = h('button', 'icon-btn', icon(ic, 16));
    b.title = title;
    b.setAttribute('aria-label', title);
    b.addEventListener('mousedown', e => e.preventDefault());
    return b;
  };
  const colorBtn = btn('palette', 'Kolor');
  const topBtn = btn('desktop', 'Zawsze na wierzchu');
  const openBtn = btn('open', 'Otwórz w oknie Karteczek');
  const closeBtn = btn('close', 'Odepnij z pulpitu (notatka zostaje)');
  bar.append(colorBtn, grip, topBtn, openBtn, closeBtn);

  const editor = new NoteEditor(note, {
    compact: true,
    onConflict: (original, copy) => {
      // Nasza wersja jest teraz osobną notatką — pokazujemy ją na osobnej karteczce.
      void api.openSticky(copy.id);
      editor.load(original);
      toast('Notatka zmieniła się na innym komputerze. Twoja wersja jest na nowej karteczce.', undefined, 10000);
    },
  });
  root.append(bar, editor.el);
  document.body.append(root);
  document.title = note.title || 'Karteczka';

  let onTop = await api.stickyOnTop(id).catch(() => false);
  const showTop = () => {
    topBtn.innerHTML = icon(onTop ? 'pinOn' : 'desktop', 16);
    topBtn.classList.toggle('on', onTop);
    topBtn.title = onTop ? 'Na wierzchu — kliknij, aby wyłączyć' : 'Zawsze na wierzchu';
  };
  showTop();

  topBtn.onclick = async () => {
    onTop = !onTop;
    showTop();
    await api.setStickyOnTop(id, onTop).catch(e => toast(errorText(e)));
  };
  colorBtn.onclick = () =>
    colorPicker(colorBtn, editor.note.color, c => {
      root.className = `sticky c-${c}`;
      editor.patch({ color: c });
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
    root.className = `sticky c-${editor.note.color}`;
    document.title = editor.note.title || 'Karteczka';
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
