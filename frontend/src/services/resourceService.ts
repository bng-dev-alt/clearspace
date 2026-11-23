import { supabase, hasSupabaseConfig } from '../lib/supabase';
import { TaskResource } from '../types/kanban';

const BUCKET = 'task-resources';
/** Must match the bucket in migration 20261117000400 (Storage enforces it too; this only gives a clear error early). */
export const MAX_RESOURCE_BYTES = 10 * 1024 * 1024;
export const ALLOWED_RESOURCE_MIME = [
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'application/pdf',
  'text/plain', 'text/csv', 'text/markdown', 'application/json',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
];
/** Signed links are short-lived; they are re-created every time the list is loaded. */
const SIGNED_URL_TTL_SECONDS = 60 * 60;

export type ResourceErrorKind =
  | 'too_large' | 'type_not_allowed' | 'empty'      // refused by validation (nothing was sent)
  | 'not_saved' | 'permission' | 'auth'             // refused by the server's access rules
  | 'unavailable' | 'network' | 'metadata' | 'unknown';

/** A user-safe upload failure: `message` is always our own Czech text (never a raw server message, path or key). */
export class ResourceUploadError extends Error {
  constructor(public kind: ResourceErrorKind, message: string) {
    super(message);
    this.name = 'ResourceUploadError';
  }
}

const MESSAGES: Record<ResourceErrorKind, string> = {
  too_large: 'Soubor je větší než 10 MB.',
  type_not_allowed: 'Tento typ souboru není povolený (obrázky, PDF, text, CSV, Markdown, JSON, Office).',
  empty: 'Soubor je prázdný.',
  not_saved: 'Úkol ještě není uložený na serveru. Počkejte chvíli, případně obnovte stránku, a zkuste to znovu.',
  permission: 'K tomuto úkolu nemáte oprávnění nahrávat soubory.',
  auth: 'Platnost přihlášení vypršela. Přihlaste se prosím znovu.',
  unavailable: 'Úložiště souborů je dočasně nedostupné. Zkuste to prosím později.',
  network: 'Nepodařilo se spojit se serverem. Zkontrolujte připojení a zkuste to znovu.',
  metadata: 'Soubor se nahrál, ale nepodařilo se ho připojit k úkolu. Zkuste to prosím znovu.',
  unknown: 'Nahrávání souboru selhalo. Zkuste to prosím znovu.',
};
export const resourceErrorMessage = (kind: ResourceErrorKind) => MESSAGES[kind];

/** Browsers (Safari/Firefox, drag and drop) often report an EMPTY type for .md/.csv; fall back to the extension, never to anything outside the allow-list. */
const EXT_MIME: Record<string, string> = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  txt: 'text/plain', csv: 'text/csv', md: 'text/markdown', markdown: 'text/markdown', json: 'application/json',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
export function effectiveMime(file: { name?: string; type: string }): string {
  if (file.type) return file.type;
  const ext = (file.name ?? '').includes('.') ? (file.name ?? '').split('.').pop()!.toLowerCase() : '';
  return EXT_MIME[ext] ?? '';
}

/** The kind of refusal when the file would be refused before any request, otherwise null. */
export function checkResourceFile(file: { name?: string; size: number; type: string }): ResourceErrorKind | null {
  if (file.size === 0) return 'empty';
  if (file.size > MAX_RESOURCE_BYTES) return 'too_large';
  if (!ALLOWED_RESOURCE_MIME.includes(effectiveMime(file))) return 'type_not_allowed';
  return null;
}

/** Returns a user-facing reason when the file would be refused, otherwise null. */
export function validateResourceFile(file: { name?: string; size: number; type: string }): string | null {
  const kind = checkResourceFile(file);
  return kind ? MESSAGES[kind] : null;
}

/** Maps a Storage / PostgREST error to a kind. Storage reports the real reason in the body's `statusCode` (the HTTP status may be a generic 400). */
export function classifyUploadError(err: { message?: string; status?: number | string; statusCode?: number | string; code?: string } | null | undefined): ResourceErrorKind {
  const code = Number(err?.statusCode ?? err?.status);
  const msg = (err?.message ?? '').toLowerCase();
  if (code === 413 || /maximum allowed size|payload too large|too large/.test(msg)) return 'too_large';
  if (code === 415 || /mime type|invalid mime/.test(msg)) return 'type_not_allowed';
  if (/jwt expired|invalid jwt|invalid token/.test(msg) || code === 401) return 'auth';
  if (code === 403 || err?.code === '42501' || /row-level security|unauthorized|not allowed/.test(msg)) return 'permission';
  if (code === 404 || /bucket not found/.test(msg) || code >= 500) return 'unavailable';
  if (/failed to fetch|network|load failed|fetch failed/.test(msg) || (err as { name?: string } | null)?.name === 'StorageUnknownError') return 'network';
  return 'unknown';
}

/** Extension of the storage object: lowercase alphanumerics only, so a crafted file name cannot shape the path. */
export function safeExtension(filename: string): string {
  const ext = filename.includes('.') ? filename.split('.').pop() ?? '' : '';
  const clean = ext.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
  return clean || 'bin';
}

export const resourceService = {
  /**
   * Upload a resource file for a task
   */
  async uploadResource(taskId: string, file: File, uploadedBy: string): Promise<TaskResource> {
    const id = `res-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const storagePath = `tasks/${taskId}/${id}.${safeExtension(file.name)}`;

    let downloadUrl: string | undefined;

    if (hasSupabaseConfig && supabase) {
      // 1. Upload to the PRIVATE bucket. Files are immutable (unique name, no upsert), and a refused upload
      //    (size / type / membership) must fail loudly instead of pretending the file was saved.
      const refused = checkResourceFile(file);
      if (refused) throw new ResourceUploadError(refused, MESSAGES[refused]);
      const { error: uploadErr } = await supabase.storage
        .from(BUCKET)
        .upload(storagePath, file, { upsert: false, contentType: effectiveMime(file) });
      if (uploadErr) {
        let kind = classifyUploadError(uploadErr as never);
        // An access refusal on a card the database does not know yet is a different problem from a missing membership.
        if (kind === 'permission') {
          const { data: card, error: cardErr } = await supabase.from('cards').select('id').eq('id', taskId).maybeSingle();
          if (!card && !cardErr) kind = 'not_saved';
        }
        console.warn('[resource-upload] refused:', kind, (uploadErr as { statusCode?: string }).statusCode ?? (uploadErr as { status?: number }).status);
        throw new ResourceUploadError(kind, MESSAGES[kind]);
      }
      const { data: signed } = await supabase.storage.from(BUCKET).createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);
      downloadUrl = signed?.signedUrl;

      // 2. Insert metadata into DB
      const { data, error: dbErr } = await supabase
        .from('task_resources')
        .insert({
          id,
          task_id: taskId,
          storage_path: storagePath,
          filename: file.name,
          mime_type: effectiveMime(file) || 'application/octet-stream',
          size: file.size,
          uploaded_by: uploadedBy,
        })
        .select()
        .single();

      if (dbErr) {
        // metadata failed: do not leave an orphaned file behind
        await supabase.storage.from(BUCKET).remove([storagePath]);
        const kind = classifyUploadError(dbErr as never) === 'permission' ? 'permission' : 'metadata';
        console.warn('[resource-upload] metadata refused:', kind, dbErr.code);
        throw new ResourceUploadError(kind, MESSAGES[kind]);
      }
      if (data) {
        return {
          id: data.id,
          taskId: data.task_id,
          storagePath: data.storage_path,
          filename: data.filename,
          mimeType: data.mime_type,
          size: data.size,
          uploadedBy: data.uploaded_by,
          createdAt: data.created_at,
          downloadUrl: downloadUrl || URL.createObjectURL(file),
        };
      }
    }

    // Mock fallback for client-side testing without active Supabase backend
    return {
      id,
      taskId,
      storagePath,
      filename: file.name,
      mimeType: file.type || 'application/octet-stream',
      size: file.size,
      uploadedBy,
      createdAt: new Date().toISOString(),
      downloadUrl: URL.createObjectURL(file),
    };
  },

  /**
   * Fetch resources for a task
   */
  async fetchTaskResources(taskId: string): Promise<TaskResource[]> {
    if (hasSupabaseConfig && supabase) {
      const { data, error } = await supabase
        .from('task_resources')
        .select('*')
        .eq('task_id', taskId)
        .order('created_at', { ascending: false });

      if (error) {
        console.warn('Failed to fetch task resources:', error);
        return [];
      }

      const rows = data || [];
      const { data: signed } = rows.length
        ? await supabase.storage.from(BUCKET).createSignedUrls(rows.map((r) => r.storage_path), SIGNED_URL_TTL_SECONDS)
        : { data: [] as { path: string | null; signedUrl: string }[] };
      const urlByPath = new Map((signed ?? []).map((u) => [u.path, u.signedUrl]));

      return rows.map((row) => {
        return {
          id: row.id,
          taskId: row.task_id,
          storagePath: row.storage_path,
          filename: row.filename,
          mimeType: row.mime_type,
          size: row.size,
          uploadedBy: row.uploaded_by,
          createdAt: row.created_at,
          downloadUrl: urlByPath.get(row.storage_path) ?? undefined,
        };
      });
    }

    return [];
  },

  /**
   * Delete a task resource
   */
  async deleteResource(resourceId: string, storagePath: string): Promise<boolean> {
    if (hasSupabaseConfig && supabase) {
      // 1. Delete from Storage
      await supabase.storage.from(BUCKET).remove([storagePath]);

      // 2. Delete from DB
      const { error } = await supabase
        .from('task_resources')
        .delete()
        .eq('id', resourceId);

      return !error;
    }
    return true;
  },
};
