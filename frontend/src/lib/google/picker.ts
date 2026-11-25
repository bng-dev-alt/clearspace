/**
 * Google Picker loader (client). The Picker is Google's own UI: the user browses, searches and sees recent files
 * of their Drive there, and every file they pick is granted to ClearSpace (drive.file). We receive only file ids.
 * The script is loaded from Google (or, in local tests only, from the loopback mock the server names).
 */
import type { PickerGrant } from '../../services/driveService';

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window { gapi?: any; google?: any }
}

const ALLOWED_SCRIPT = /^(https:\/\/apis\.google\.com\/js\/api\.js|http:\/\/(127\.0\.0\.1|localhost):\d{2,5}\/picker\/api\.js)$/;
let loading: Promise<void> | null = null;

function loadPicker(scriptUrl: string): Promise<void> {
  if (!ALLOWED_SCRIPT.test(scriptUrl)) return Promise.reject(new Error('picker script not allowed'));
  if (window.google?.picker) return Promise.resolve();
  if (!loading) {
    loading = new Promise<void>((resolve, reject) => {
      const s = document.createElement('script');
      s.src = scriptUrl;
      s.async = true;
      s.onload = () => window.gapi.load('picker', { callback: () => resolve(), onerror: () => reject(new Error('picker load failed')) });
      s.onerror = () => reject(new Error('picker script failed'));
      document.head.appendChild(s);
    }).catch((e) => { loading = null; throw e; });
  }
  return loading;
}

/**
 * Opens the Picker; resolves with the picked file ids, or null when the user cancels. `onlyFileIds` shows just
 * those files (a teammate's linked file): picking it grants THIS user's own drive.file access, if Google lets
 * them see it at all -- the Picker never shows files the user cannot open.
 */
export async function pickDriveFiles(grant: PickerGrant, onlyFileIds?: string[]): Promise<string[] | null> {
  await loadPicker(grant.scriptUrl);
  const gp = window.google.picker;
  return new Promise((resolve) => {
    const view = new gp.DocsView(gp.ViewId.DOCS)
      .setIncludeFolders(true)
      .setSelectFolderEnabled(true)
      .setMode(gp.DocsViewMode.LIST);   // drive.file grants no thumbnails before picking: list mode
    if (onlyFileIds?.length) view.setFileIds(onlyFileIds.join(','));
    const picker = new gp.PickerBuilder()
      .addView(view)
      .enableFeature(gp.Feature.MULTISELECT_ENABLED)
      .setMaxItems(20)
      .setOAuthToken(grant.accessToken)
      .setDeveloperKey(grant.developerKey)
      .setAppId(grant.appId)
      .setLocale('cs')
      .setTitle('Vyberte soubory z Google Disku')
      .setCallback((data: any) => {
        const action = data?.[gp.Response.ACTION];
        if (action === gp.Action.PICKED) {
          const docs: any[] = data[gp.Response.DOCUMENTS] ?? [];
          resolve(docs.map((d) => d[gp.Document.ID]).filter((id) => typeof id === 'string'));
        } else if (action === gp.Action.CANCEL) {
          resolve(null);
        }
      })
      .build();
    picker.setVisible(true);
  });
}
