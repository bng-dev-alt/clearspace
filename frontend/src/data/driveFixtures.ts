import type { DriveLink } from '../services/driveService';

/**
 * Czech DEMONSTRATION fixtures for the Drive UI (tests and local previews only). They are not connected files:
 * ids point at the local Google MOCK (scripts/google-mock.mjs), never at a real Drive, and no seed writes them.
 */
const base = { projectId: 'p1', providerState: 'ok' as const, metadataCheckedAt: '2026-11-25T08:00:00Z', linkedByName: 'Anna (ukázka)', createdAt: '2026-11-24T10:00:00Z', sizeBytes: null };
export const DRIVE_FIXTURES: DriveLink[] = [
  { ...base, id: 'fx-1', cardId: null, externalId: 'mockSheet_RozpocetQ1_01', name: 'Rozpočet projektu Q1', mimeType: 'application/vnd.google-apps.spreadsheet', webUrl: 'https://docs.google.com/spreadsheets/d/mockSheet_RozpocetQ1_01/edit', modifiedAt: '2026-11-20T09:30:00Z' },
  { ...base, id: 'fx-2', cardId: null, externalId: 'mockDoc_SmlouvaCorvane01', name: 'Smlouva o dílo – Corvane (koncept)', mimeType: 'application/vnd.google-apps.document', webUrl: 'https://docs.google.com/document/d/mockDoc_SmlouvaCorvane01/edit', modifiedAt: '2026-11-21T14:00:00Z' },
  { ...base, id: 'fx-3', cardId: null, externalId: 'mockXss_Soubor00000001', name: '<img src=x onerror=alert(1)>fdp.exe', mimeType: 'text/plain', webUrl: 'https://drive.google.com/file/d/mockXss_Soubor00000001/view', modifiedAt: null },
  { ...base, id: 'fx-4', cardId: 'c1', externalId: 'mockDoc_ZapisPorady1211', name: 'Zápis z porady 12. 11.', mimeType: 'application/vnd.google-apps.document', webUrl: 'https://docs.google.com/document/d/mockDoc_ZapisPorady1211/edit', modifiedAt: '2026-11-12T16:00:00Z' },
];
