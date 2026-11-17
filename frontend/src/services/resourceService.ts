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

/** Returns a user-facing reason when the file would be refused, otherwise null. */
export function validateResourceFile(file: { size: number; type: string }): string | null {
  if (file.size > MAX_RESOURCE_BYTES) return 'Soubor je větší než 10 MB.';
  if (!ALLOWED_RESOURCE_MIME.includes(file.type)) return 'Tento typ souboru není povolený (obrázky, PDF, text, CSV, JSON, Office).';
  return null;
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
      const invalid = validateResourceFile(file);
      if (invalid) throw new Error(invalid);
      const { error: uploadErr } = await supabase.storage
        .from(BUCKET)
        .upload(storagePath, file, { upsert: false, contentType: file.type });
      if (uploadErr) throw new Error(`Nahrání souboru selhalo: ${uploadErr.message}`);
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
          mime_type: file.type || 'application/octet-stream',
          size: file.size,
          uploaded_by: uploadedBy,
        })
        .select()
        .single();

      if (dbErr) {
        // metadata failed: do not leave an orphaned file behind
        await supabase.storage.from(BUCKET).remove([storagePath]);
        throw new Error(`Uložení metadat přílohy selhalo: ${dbErr.message}`);
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
          downloadUrl: urlByPath.get(row.storage_path),
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
