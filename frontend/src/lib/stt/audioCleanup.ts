import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Mazání zvuku BEZ poskytovatele přepisu: jen Supabase Storage a databáze pod identitou uživatele (RLS). Používá ho server (úklid po
 * termínu) i prohlížeč (ruční smazání, smazání porady/projektu), takže smazání NEZÁVISÍ na příznacích přepisu (STT_ENABLED,
 * klíč poskytovatele, serverové tajemství) ani na tom, jestli je cesta /api/ai otevřená. Co vyžaduje klíč poskytovatele (smazání
 * dat u Soniox), je jiný, nezávisle opakovatelný úklid (`stt_jobs.cleanup_state`).
 */
export const AUDIO_BUCKET = 'meeting-audio';
const IN_FLIGHT = ['submitting', 'unknown', 'transcribing'];

export class AudioCleanupError extends Error {
  constructor(public readonly code: 'in_flight' | 'storage' | 'database', message: string) {
    super(message);
  }
}

export interface AudioMeetingRow {
  id: string;
  project_id: string;
  audio_path: string | null;
  audio_deleted_at: string | null;
  stt_state: string;
}

/** Smaže objekty po dávkách; vrátí jen to, jestli to všechno vyšlo. Nikdy nehlásí úspěch při chybě. */
export async function removeAudioObjects(db: SupabaseClient, paths: string[]): Promise<boolean> {
  const unique = [...new Set(paths)];
  for (let i = 0; i < unique.length; i += 100) {
    const rm = await db.storage.from(AUDIO_BUCKET).remove(unique.slice(i, i + 100));
    if (rm.error) return false;
  }
  return true;
}

/**
 * Smaže zvuk jedné porady (zaregistrovaný soubor i soubory ve složce porady, které se nikdy nepřipojily) a TEPRVE POTOM označí řádek.
 * Databáze označení odmítne, dokud soubor ve Storage existuje, takže "smazáno" nikdy nelže.
 */
export async function deleteMeetingAudio(db: SupabaseClient, m: AudioMeetingRow): Promise<void> {
  if (IN_FLIGHT.includes(m.stt_state)) throw new AudioCleanupError('in_flight', 'Zvuk nelze smazat, dokud přepis běží.');
  const prefix = `${m.project_id}/${m.id}`;
  const names = new Set<string>();
  if (m.audio_path) names.add(m.audio_path);
  const listed = await db.storage.from(AUDIO_BUCKET).list(prefix);
  for (const o of (listed.data ?? []) as { name: string }[]) names.add(`${prefix}/${o.name}`);
  if (names.size > 0 && !(await removeAudioObjects(db, [...names]))) {
    throw new AudioCleanupError('storage', 'Soubor se nepodařilo smazat. Zkuste to prosím znovu.');
  }
  if (m.audio_path && !m.audio_deleted_at) {
    const { error } = await db.rpc('mark_audio_deleted', { p_meeting: m.id });
    if (error) {
      console.error('[audio] mark_audio_deleted failed', error.code);
      throw new AudioCleanupError('database', 'Soubor se nepodařilo smazat. Zkuste to prosím znovu.');
    }
  }
}

export interface AudioSweepResult {
  audioPurged: number;
  orphansRemoved: number;
  unattachedRemoved: number;
}

const GRACE_HOURS = 24;

/**
 * Projektový úklid bez plánovače (běží, když člen otevře seznam porad nebo poradu):
 *  - zvuk po termínu (`audio_delete_after`; i u selhaných, zrušených a nikdy nepřepsaných porad),
 *  - soubory smazaných porad (fronta `meeting_audio_orphans`),
 *  - nahrané, ale nikdy nepřipojené soubory starší než 24 h (nemají žádný termín v `meetings`).
 * Jedna selhaná položka nezastaví ostatní.
 */
export async function sweepProjectAudio(db: SupabaseClient, projectId: string): Promise<AudioSweepResult> {
  const out: AudioSweepResult = { audioPurged: 0, orphansRemoved: 0, unattachedRemoved: 0 };
  const due = await db
    .from('meetings')
    .select('id, project_id, audio_path, audio_deleted_at, stt_state')
    .eq('project_id', projectId)
    .eq('source_kind', 'audio')
    .not('audio_path', 'is', null)
    .lte('audio_delete_after', new Date().toISOString())
    .not('stt_state', 'in', '(submitting,unknown,transcribing)')
    .limit(20);
  for (const m of (due.data ?? []) as AudioMeetingRow[]) {
    try {
      await deleteMeetingAudio(db, m);
      out.audioPurged += 1;
    } catch (e) {
      if (!(e instanceof AudioCleanupError)) throw e;
    }
  }
  const orphans = await db.from('meeting_audio_orphans').select('path').eq('project_id', projectId).limit(50);
  for (const o of (orphans.data ?? []) as { path: string }[]) {
    if (await removeAudioObjects(db, [o.path])) {
      await db.from('meeting_audio_orphans').delete().eq('path', o.path);
      out.orphansRemoved += 1;
    }
  }
  const stray = await db.rpc('list_project_audio', { p_project: projectId, p_unattached_only: true, p_older_than_hours: GRACE_HOURS });
  const strayPaths = (Array.isArray(stray.data) ? (stray.data as { path: string }[]) : []).map((r) => r.path);
  if (strayPaths.length > 0 && (await removeAudioObjects(db, strayPaths))) out.unattachedRemoved = strayPaths.length;
  return out;
}

/**
 * Před smazáním PROJEKTU: odstraní všechny zvukové soubory projektu ze Storage (po smazání projektu už k nim nemá nikdo přístup)
 * a označí poradám smazání. Selže-li Storage, vyhodí chybu a projekt se NEMÁ mazat. Vrací počet smazaných souborů.
 */
export async function deleteProjectAudio(db: SupabaseClient, projectId: string): Promise<number> {
  const all = await db.rpc('list_project_audio', { p_project: projectId, p_unattached_only: false, p_older_than_hours: 0 });
  if (all.error) throw new AudioCleanupError('database', 'Zvuk projektu se nepodařilo zjistit; projekt nebyl smazán.');
  const paths = (Array.isArray(all.data) ? (all.data as { path: string }[]) : []).map((r) => r.path);
  if (paths.length > 0 && !(await removeAudioObjects(db, paths))) {
    throw new AudioCleanupError('storage', 'Zvuk projektu se nepodařilo smazat; projekt nebyl smazán. Zkuste to prosím znovu.');
  }
  const meetings = await db.from('meetings').select('id').eq('project_id', projectId).not('audio_path', 'is', null).limit(500);
  for (const m of (Array.isArray(meetings.data) ? (meetings.data as { id: string }[]) : [])) await db.rpc('mark_audio_deleted', { p_meeting: m.id }); // best effort: objekty už neexistují
  return paths.length;
}
