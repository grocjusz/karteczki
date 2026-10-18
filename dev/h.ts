import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
mockWindows('main');
let dir = 'C:\\Users\\Patryk\\AppData\\Local\\pl.grocjusz.karteczki\\kopie', custom = false;
mockIPC((cmd, a: any) => {
  if (cmd === 'get_info') return { dataDir: 'C:\\Users\\Patryk\\OneDrive\\Karteczki', backupDir: dir, backupCustom: custom, version: '1.4.0', defaultColor: 'default', attachSupported: true };
  if (cmd === 'list_notes') return [];
  if (cmd === 'plugin:dialog|open') return 'E:\\Kopie Karteczek';
  if (cmd === 'set_backup_dir') { custom = !!a.path; dir = a.path ?? 'C:\\Users\\Patryk\\AppData\\Local\\pl.grocjusz.karteczki\\kopie'; return dir; }
  if (cmd === 'backup_now') return dir + '\\karteczki-DOM-2026-10-18.zip';
  if (cmd === 'plugin:autostart|is_enabled') return true;
  return null;
}, { shouldMockEvents: true });
await import('../src/main');
