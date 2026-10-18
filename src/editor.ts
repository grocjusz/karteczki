// Edytor jednej notatki — używany w oknie głównym i w karteczce na pulpicie.
// Zapis następuje samoczynnie 0,4 s po ostatniej zmianie.
import { api, errorText } from './api';
import { icon } from './icons';
import { isBlank, linkify, renderHtml, sanitize, serializeHtml, type Note } from './logic';
import { h, openLink, toast } from './ui';

export interface EditorOptions {
  compact?: boolean;
  /** Pasek formatowania schowany na start i włączany przyciskiem „Aa” (jak w Google Keep). */
  formatHidden?: boolean;
  placeholder?: string;
  /** Po każdym udanym zapisie (także kopii konfliktu). */
  onSaved?(note: Note): void;
  /** Ta notatka zmieniła się w międzyczasie gdzie indziej — nasza wersja jest teraz osobną notatką. */
  onConflict?(original: Note, copy: Note): void;
}

const IMAGE_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
};

export class NoteEditor {
  readonly el: HTMLElement;
  readonly title: HTMLInputElement;
  readonly body: HTMLElement;
  readonly toolbar: HTMLElement;
  note!: Note;
  /** updatedAt wersji, na której opierają się nasze zmiany (0 = jeszcze nie zapisana). */
  base = 0;
  dirty = false;
  private timer = 0;
  private chain: Promise<void> = Promise.resolve();
  private savedRange: Range | null = null;
  private linkBar: HTMLElement;

  constructor(note: Note, private opts: EditorOptions = {}) {
    this.el = h('div', 'editor' + (opts.compact ? ' compact' : ''));
    this.title = h('input', 'ed-title');
    this.title.placeholder = 'Tytuł';
    this.title.maxLength = 300;
    this.title.spellcheck = true;
    this.body = h('div', 'ed-body note-html');
    this.body.contentEditable = 'true';
    this.body.spellcheck = true;
    this.body.dataset.placeholder = opts.placeholder ?? 'Notatka…';
    this.toolbar = this.buildToolbar();
    if (opts.formatHidden) this.toolbar.hidden = true;
    this.linkBar = this.buildLinkBar();
    this.el.append(this.title, this.body, this.linkBar, this.toolbar);
    this.bind();
    this.load(note);
  }

  load(note: Note): void {
    this.note = { ...note };
    this.base = note.updatedAt;
    this.title.value = note.title;
    this.body.innerHTML = renderHtml(note.html);
    this.dirty = false;
    this.updateEmpty();
  }

  get isEmpty(): boolean {
    return !this.title.value.trim() && isBlank(serializeHtml(this.body));
  }

  focus(atEnd = true): void {
    if (!this.title.value && !this.opts.compact) {
      this.title.focus();
      return;
    }
    this.body.focus();
    if (atEnd) {
      const r = document.createRange();
      r.selectNodeContents(this.body);
      r.collapse(false);
      const sel = getSelection();
      sel?.removeAllRanges();
      sel?.addRange(r);
    }
  }

  /** Zmiana spoza edytora pola notatki (kolor, archiwum, kosz) — zapisze się razem z treścią. */
  patch(fields: Partial<Note>): void {
    Object.assign(this.note, fields);
    this.markDirty();
  }

  markDirty(): void {
    this.dirty = true;
    this.updateEmpty();
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.flush(), 400);
  }

  flush(): Promise<void> {
    clearTimeout(this.timer);
    if (this.dirty) this.chain = this.chain.then(() => this.save());
    return this.chain;
  }

  private async save(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    const title = this.title.value;
    const html = serializeHtml(this.body);
    // Nowa, pusta notatka nie tworzy pliku.
    if (this.base === 0 && !title.trim() && !html) return;
    const draft: Note = { ...this.note, title, html };
    try {
      const res = await api.save(draft, this.base);
      if (res.conflict) {
        this.note = { ...res.conflict };
        this.base = res.conflict.updatedAt;
        if (!this.dirty) this.title.value = res.conflict.title;
        this.opts.onSaved?.(res.note);
        this.opts.onSaved?.(res.conflict);
        this.opts.onConflict?.(res.note, res.conflict);
      } else {
        this.note = { ...res.note };
        this.base = res.note.updatedAt;
        this.opts.onSaved?.(res.note);
      }
    } catch (e) {
      this.dirty = true;
      toast('Nie udało się zapisać notatki: ' + errorText(e));
      clearTimeout(this.timer);
      this.timer = window.setTimeout(() => void this.flush(), 5000);
    }
  }

  /** Notatka zmieniła się w innym oknie lub na innym komputerze. */
  applyExternal(n: Note): void {
    if (n.id !== this.note.id || n.updatedAt <= this.base) return;
    if (this.dirty) return; // nasz zapis i tak wykryje konflikt i nic nie przepadnie
    this.note = { ...n };
    this.base = n.updatedAt;
    if (this.title.value !== n.title) this.title.value = n.title;
    if (serializeHtml(this.body) !== n.html) {
      const focused = document.activeElement === this.body;
      this.body.innerHTML = renderHtml(n.html);
      if (focused) this.focus(true);
    }
    this.updateEmpty();
  }

  // ---------- pasek narzędzi ----------

  private buildToolbar(): HTMLElement {
    const bar = h('div', 'ed-toolbar');
    const tools: [string, string, string, () => void][] = [
      ['B', 'Pogrubienie (Ctrl+B)', 'fmt b', () => this.exec('bold')],
      ['I', 'Kursywa (Ctrl+I)', 'fmt i', () => this.exec('italic')],
      ['U', 'Podkreślenie (Ctrl+U)', 'fmt u', () => this.exec('underline')],
      ['S', 'Przekreślenie', 'fmt s', () => this.exec('strikeThrough')],
      ['H', 'Nagłówek', 'fmt hd', () => this.toggleHeading()],
      [icon('check', 18), 'Lista zadań do odhaczania (Ctrl+Shift+L)', '', () => this.toggleChecklist()],
      [icon('list', 18), 'Lista punktowana', '', () => this.exec('insertUnorderedList')],
      [icon('olist', 18), 'Lista numerowana', '', () => this.exec('insertOrderedList')],
      [icon('link', 18), 'Link (Ctrl+K). Ctrl+klik otwiera link', '', () => this.showLinkBar()],
      [icon('image', 18), 'Obrazek (możesz też wkleić lub przeciągnąć)', '', () => this.pickImage()],
    ];
    // W oknie głównym obrazek jest na pasku akcji pod notatką.
    if (this.opts.formatHidden) tools.pop();
    const compactSkip = new Set(['S', 'H', 'Lista numerowana']);
    for (const [label, title, cls, run] of tools) {
      if (this.opts.compact && (compactSkip.has(label) || title === 'Lista numerowana')) continue;
      const b = h('button', 'tb ' + cls, label);
      b.title = title;
      b.setAttribute('aria-label', title);
      b.type = 'button';
      // Kliknięcie przycisku nie może zabrać zaznaczenia z treści.
      b.addEventListener('mousedown', e => e.preventDefault());
      b.addEventListener('click', run);
      bar.append(b);
    }
    return bar;
  }

  private buildLinkBar(): HTMLElement {
    const bar = h('div', 'ed-linkbar');
    const input = h('input');
    input.placeholder = 'Wklej adres strony, np. https://…';
    const ok = h('button', 'btn small', 'Dodaj link');
    const cancel = h('button', 'btn small ghost', 'Anuluj');
    const apply = () => {
      let url = input.value.trim();
      bar.classList.remove('on');
      if (!url) return;
      if (!/^(https?:|mailto:)/i.test(url)) url = (url.includes('@') && !url.includes('/') ? 'mailto:' : 'https://') + url;
      this.restoreRange();
      const sel = getSelection();
      if (sel && !sel.isCollapsed && this.body.contains(sel.anchorNode)) {
        document.execCommand('createLink', false, url);
      } else {
        const a = document.createElement('a');
        a.href = url;
        a.textContent = url;
        document.execCommand('insertHTML', false, a.outerHTML + '&nbsp;');
      }
      this.markDirty();
    };
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        apply();
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        bar.classList.remove('on');
        this.restoreRange();
      }
    });
    ok.onclick = apply;
    cancel.onclick = () => {
      bar.classList.remove('on');
      this.restoreRange();
    };
    bar.append(input, ok, cancel);
    return bar;
  }

  private showLinkBar(): void {
    this.saveRange();
    this.linkBar.classList.add('on');
    const input = this.linkBar.querySelector('input')!;
    const a = this.closest('a') as HTMLAnchorElement | null;
    input.value = a?.getAttribute('href') ?? '';
    input.focus();
    input.select();
  }

  private exec(cmd: string, value?: string): void {
    if (!this.body.contains(getSelection()?.anchorNode ?? null)) this.focus(true);
    document.execCommand(cmd, false, value);
    this.markDirty();
  }

  private closest(selector: string): Element | null {
    const sel = getSelection();
    let node = sel?.anchorNode ?? null;
    if (!node || !this.body.contains(node)) return null;
    // Po niektórych poleceniach kursor wskazuje na „pozycję w elemencie” — bierzemy element w tym miejscu.
    if (node.nodeType === Node.ELEMENT_NODE && node.childNodes.length) {
      const off = sel!.anchorOffset;
      node = node.childNodes[Math.min(off, node.childNodes.length - 1)] ?? node;
    }
    const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    const found = el?.closest(selector) ?? null;
    return found && this.body.contains(found) ? found : null;
  }

  private toggleHeading(): void {
    this.exec('formatBlock', this.closest('h1,h2,h3') ? '<p>' : '<h2>');
  }

  /** Pokazuje lub chowa pasek formatowania; zwraca, czy jest widoczny. */
  toggleFormat(): boolean {
    this.toolbar.hidden = !this.toolbar.hidden;
    return !this.toolbar.hidden;
  }

  toggleChecklist(): void {
    if (!this.body.contains(getSelection()?.anchorNode ?? null)) this.focus(true);
    const list = this.closest('ul[data-checklist]');
    if (list) {
      list.removeAttribute('data-checklist');
      list.querySelectorAll('li').forEach(li => li.removeAttribute('data-checked'));
    } else {
      if (!this.closest('ul') || this.closest('ol')) document.execCommand('insertUnorderedList');
      const ul = this.closest('ul');
      if (ul) {
        ul.setAttribute('data-checklist', '1');
        ul.querySelectorAll(':scope > li').forEach(li => {
          if (!li.hasAttribute('data-checked')) li.setAttribute('data-checked', 'false');
        });
      }
    }
    this.markDirty();
  }

  private saveRange(): void {
    const sel = getSelection();
    if (sel && sel.rangeCount && this.body.contains(sel.anchorNode)) this.savedRange = sel.getRangeAt(0).cloneRange();
  }

  private restoreRange(): void {
    this.body.focus();
    if (this.savedRange) {
      const sel = getSelection();
      sel?.removeAllRanges();
      sel?.addRange(this.savedRange);
    }
  }

  // ---------- obrazki ----------

  pickImage(): void {
    this.saveRange();
    const input = h('input');
    input.type = 'file';
    input.accept = Object.keys(IMAGE_EXT).join(',');
    input.multiple = true;
    input.onchange = () => {
      this.restoreRange();
      void this.insertImages([...(input.files ?? [])]);
    };
    input.click();
  }

  async insertImages(files: File[]): Promise<void> {
    for (const file of files) {
      const ext = IMAGE_EXT[file.type];
      if (!ext) {
        toast('Ten rodzaj pliku nie jest obsługiwany. Wstaw obrazek PNG, JPG, GIF, WEBP lub BMP.');
        continue;
      }
      if (file.size > 25 * 1024 * 1024) {
        toast('Obrazek jest za duży (limit 25 MB).');
        continue;
      }
      try {
        const name = await api.saveImage(new Uint8Array(await file.arrayBuffer()), ext);
        const html = renderHtml(`<img data-img="${name}">`);
        if (!this.body.contains(getSelection()?.anchorNode ?? null)) this.focus(true);
        document.execCommand('insertHTML', false, html + '<p><br></p>');
        this.markDirty();
      } catch (e) {
        toast('Nie udało się dodać obrazka: ' + errorText(e));
      }
    }
  }

  // ---------- zdarzenia ----------

  private bind(): void {
    this.title.addEventListener('input', () => this.markDirty());
    this.title.addEventListener('keydown', e => {
      if (e.key === 'Enter' || (e.key === 'ArrowDown' && this.title.selectionStart === this.title.value.length)) {
        e.preventDefault();
        this.body.focus();
      }
    });
    this.body.addEventListener('input', e => {
      const ie = e as InputEvent;
      if (ie.inputType === 'insertParagraph') {
        // Nowy punkt listy zadań zaczyna się nieodhaczony.
        const li = this.closest('ul[data-checklist] > li');
        if (li) li.setAttribute('data-checked', 'false');
      }
      this.markDirty();
    });
    this.body.addEventListener('keydown', e => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        this.showLinkBar();
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        this.toggleChecklist();
      } else if (e.key === ' ' || e.key === 'Enter') {
        // Adres wpisany ręcznie staje się linkiem po spacji lub Enterze.
        this.linkifyCurrentText();
      }
    });
    this.body.addEventListener('blur', () => {
      if (linkify(this.body)) this.markDirty();
      void this.flush();
    });
    this.title.addEventListener('blur', () => void this.flush());

    // Odhaczanie punktu: kliknięcie w kwadracik po lewej stronie.
    this.body.addEventListener('mousedown', e => {
      const li = (e.target as Element).closest?.('ul[data-checklist] > li');
      if (!li || !this.body.contains(li)) return;
      if (e.clientX - li.getBoundingClientRect().left > 26) return;
      e.preventDefault();
      li.setAttribute('data-checked', li.getAttribute('data-checked') === 'true' ? 'false' : 'true');
      this.markDirty();
    });

    this.body.addEventListener('click', e => {
      const a = (e.target as Element).closest?.('a[href]') as HTMLAnchorElement | null;
      if (a && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        openLink(a.getAttribute('href') ?? '');
      }
    });

    this.body.addEventListener('paste', e => {
      const data = e.clipboardData;
      if (!data) return;
      const files = [...data.files].filter(f => f.type.startsWith('image/'));
      if (files.length) {
        e.preventDefault();
        void this.insertImages(files);
        return;
      }
      const html = data.getData('text/html');
      e.preventDefault();
      if (html) {
        // Wklejka ze stron: tylko dozwolone formatowanie, bez obcych obrazków.
        const tpl = document.createElement('template');
        tpl.innerHTML = sanitize(html);
        tpl.content.querySelectorAll('img:not([data-img])').forEach(img => img.remove());
        document.execCommand('insertHTML', false, tpl.innerHTML);
      } else {
        document.execCommand('insertText', false, data.getData('text/plain'));
      }
      linkify(this.body);
      this.markDirty();
    });

    this.body.addEventListener('dragover', e => {
      if (e.dataTransfer?.types.includes('Files')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }
    });
    this.body.addEventListener('drop', e => {
      const files = [...(e.dataTransfer?.files ?? [])].filter(f => f.type.startsWith('image/'));
      if (!files.length) return;
      e.preventDefault();
      const pos = (document as Document & { caretRangeFromPoint?(x: number, y: number): Range | null }).caretRangeFromPoint?.(e.clientX, e.clientY);
      this.body.focus();
      if (pos) {
        const sel = getSelection();
        sel?.removeAllRanges();
        sel?.addRange(pos);
      }
      void this.insertImages(files);
    });
  }

  private linkifyCurrentText(): void {
    const sel = getSelection();
    const node = sel?.anchorNode;
    if (!node || node.nodeType !== Node.TEXT_NODE || !this.body.contains(node)) return;
    const text = (node as Text).data.slice(0, sel!.anchorOffset);
    const m = /https?:\/\/\S+$/i.exec(text);
    if (!m || node.parentElement?.closest('a')) return;
    const url = m[0].replace(/[.,;:!?)\]]+$/, '');
    const start = m.index;
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + url.length);
    const a = document.createElement('a');
    a.href = url;
    range.surroundContents(a);
    const after = document.createRange();
    after.setStartAfter(a);
    after.collapse(true);
    sel!.removeAllRanges();
    sel!.addRange(after);
  }

  private updateEmpty(): void {
    this.body.classList.toggle('empty', isBlank(this.body.innerHTML));
  }
}
