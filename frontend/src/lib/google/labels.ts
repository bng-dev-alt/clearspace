/** Czech texts and file-type labels for Google Drive resources. Client-safe (no secrets, no Node APIs). */
export type AccessState = 'ok' | 'trashed' | 'no_access' | 'auth' | 'rate_limited' | 'unavailable' | 'unsupported' | 'too_large' | 'not_connected' | 'revoked';

export const ACCESS_TEXT: Record<AccessState, string> = {
  ok: 'Dostupný',
  trashed: 'Soubor je v koši Google Disku.',
  no_access: 'Přístup k souboru není dostupný: soubor byl smazán, nebo k němu váš účet Google nemá oprávnění.',
  auth: 'Přihlášení ke Google vypršelo. Zkuste to prosím znovu.',
  rate_limited: 'Příliš mnoho požadavků na Google Disk. Zkuste to prosím za několik minut.',
  unavailable: 'Google Disk je dočasně nedostupný. Zkuste to prosím později.',
  unsupported: 'Náhled textu je dostupný jen pro Dokumenty, Tabulky, Prezentace Google a textové soubory.',
  too_large: 'Soubor je pro náhled příliš velký. Otevřete ho na Disku.',
  not_connected: 'Pro ověření přístupu připojte svůj účet Google.',
  revoked: 'Přístup k účtu Google vypršel nebo byl zrušen. Připojte účet prosím znovu.',
};

const KINDS: [RegExp, string][] = [
  [/^application\/vnd\.google-apps\.document$/, 'Dokument Google'],
  [/^application\/vnd\.google-apps\.spreadsheet$/, 'Tabulka Google'],
  [/^application\/vnd\.google-apps\.presentation$/, 'Prezentace Google'],
  [/^application\/vnd\.google-apps\.folder$/, 'Složka'],
  [/^application\/vnd\.google-apps\.form$/, 'Formulář Google'],
  [/^application\/pdf$/, 'PDF'],
  [/^image\//, 'Obrázek'],
  [/^video\//, 'Video'],
  [/^audio\//, 'Zvuk'],
  [/^text\/csv$/, 'CSV'],
  [/^text\//, 'Text'],
  [/wordprocessingml|msword/, 'Dokument Word'],
  [/spreadsheetml|ms-excel/, 'Sešit Excel'],
  [/presentationml|ms-powerpoint/, 'Prezentace PowerPoint'],
  [/zip|compressed/, 'Archiv'],
];

export function fileKind(mimeType: string): string {
  return KINDS.find(([re]) => re.test(mimeType))?.[1] ?? 'Soubor';
}

export type FileIconKind = 'doc' | 'sheet' | 'slides' | 'folder' | 'pdf' | 'image' | 'file';
export function fileIconKind(mimeType: string): FileIconKind {
  if (/google-apps\.document|wordprocessingml|msword|^text\//.test(mimeType)) return 'doc';
  if (/google-apps\.spreadsheet|spreadsheetml|ms-excel|csv/.test(mimeType)) return 'sheet';
  if (/google-apps\.presentation|presentationml|ms-powerpoint/.test(mimeType)) return 'slides';
  if (/google-apps\.folder/.test(mimeType)) return 'folder';
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType.startsWith('image/')) return 'image';
  return 'file';
}

/** Only Google's own https hosts are ever opened from a link row (defence in depth; the database enforces it too). */
export function safeDriveUrl(url: string): string | null {
  return /^https:\/\/(drive|docs)\.google\.com\/[A-Za-z0-9/_?=&.%-]*$/.test(url) ? url : null;
}
