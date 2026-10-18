// Cienka warstwa nad poleceniami rdzenia (Rust).
import { invoke } from '@tauri-apps/api/core';
import type { Note } from './logic';

export interface Info {
  dataDir: string;
  backupDir: string;
  version: string;
  defaultColor: string;
  attachSupported: boolean;
}

export interface SaveResult {
  note: Note;
  conflict: Note | null;
}

export const api = {
  info: () => invoke<Info>('get_info'),
  list: () => invoke<Note[]>('list_notes'),
  save: (note: Note, base: number) => invoke<SaveResult>('save_note', { note, baseUpdatedAt: base }),
  remove: (id: string) => invoke<void>('delete_note', { id }),
  saveImage: (bytes: Uint8Array, ext: string) => invoke<string>('save_image', bytes, { headers: { 'x-ext': ext } }),
  setDataDir: (path: string) => invoke<void>('set_data_dir', { path }),
  openBackupDir: () => invoke<void>('open_backup_dir'),
  openDataDir: () => invoke<void>('open_data_dir'),
  openSticky: (id: string) => invoke<void>('open_sticky', { id }),
  closeSticky: (id: string) => invoke<void>('close_sticky', { id }),
  stickyOnTop: (id: string) => invoke<boolean>('sticky_on_top', { id }),
  setStickyOnTop: (id: string, onTop: boolean) => invoke<void>('set_sticky_on_top', { id, onTop }),
  setDefaultColor: (color: string) => invoke<void>('set_default_color', { color }),
  dismissAttached: (id: string) => invoke<void>('dismiss_attached', { id }),
  showMain: (id?: string) => invoke<void>('show_main', { id: id ?? null }),
};

export function errorText(e: unknown): string {
  return typeof e === 'string' ? e : e instanceof Error ? e.message : JSON.stringify(e);
}
