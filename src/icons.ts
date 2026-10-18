// Proste ikony liniowe rysowane na potrzeby Karteczek (kolor = kolor tekstu).
const P: Record<string, string> = {
  note: '<path d="M5 3h10l4 4v14H5z"/><path d="M15 3v4h4"/><path d="M8 12h8M8 16h6"/>',
  archive: '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v11h14V9"/><path d="M10 13h4"/>',
  unarchive: '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v11h14V9"/><path d="M12 18v-6M9.5 14.5 12 12l2.5 2.5"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/>',
  forever: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/><path d="m10 11 4 5M14 11l-4 5"/>',
  restore: '<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v5h5"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  settings: '<path d="M4 6h10M18 6h2M4 12h3M11 12h9M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  palette: '<path d="M12 3a9 9 0 1 0 0 18c1.2 0 1.8-.8 1.8-1.7 0-1.3-1.2-1.6-1.2-2.8 0-1 .8-1.5 1.8-1.5H17a4 4 0 0 0 4-4C21 6.6 17 3 12 3z"/><circle cx="7.5" cy="11" r="1.2"/><circle cx="10" cy="7" r="1.2"/><circle cx="15" cy="7.5" r="1.2"/>',
  desktop: '<path d="M9 3h6l-1 6 3 3H7l3-3z"/><path d="M12 12v9"/>',
  pinOn: '<path d="M9 3h6l-1 6 3 3H7l3-3z" fill="currentColor"/><path d="M12 12v9"/>',
  open: '<rect x="3" y="5" width="16" height="16" rx="2"/><path d="M13 3h8v8M21 3l-9 9"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<rect x="3.5" y="3.5" width="17" height="17" rx="3"/><path d="m8 12 3 3 5-6"/>',
  list: '<circle cx="5" cy="7" r="1"/><circle cx="5" cy="12" r="1"/><circle cx="5" cy="17" r="1"/><path d="M9 7h11M9 12h11M9 17h11"/>',
  olist: '<path d="M4 5h1.5v4M4 9h3M4 14h3l-3 4h3"/><path d="M10 7h10M10 12h10M10 17h10"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="9.5" r="1.8"/><path d="m4 18 5-5 4 4 3-3 4 4"/>',
  clip: '<path d="M20 11.5 12.4 19a5 5 0 0 1-7.1-7.1l8-8a3.3 3.3 0 0 1 4.7 4.7l-8 8a1.7 1.7 0 0 1-2.4-2.4l7.3-7.3"/>',
  grip: '<circle cx="9" cy="8" r="1" fill="currentColor"/><circle cx="15" cy="8" r="1" fill="currentColor"/><circle cx="9" cy="12" r="1" fill="currentColor"/><circle cx="15" cy="12" r="1" fill="currentColor"/><circle cx="9" cy="16" r="1" fill="currentColor"/><circle cx="15" cy="16" r="1" fill="currentColor"/>',
  folder: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"/>',
  file: '<path d="M6 3h8l5 5v13H6z"/><path d="M14 3v5h5"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
};

export function icon(name: keyof typeof P | string, size = 20): string {
  return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] ?? ''}</svg>`;
}
