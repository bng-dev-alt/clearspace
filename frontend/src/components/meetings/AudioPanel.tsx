'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Button } from '../ui';
import { meetingService, MeetingServiceError, type Meeting, type SttState } from '../../services/meetingService';
import { estimateSttCostUsd } from '../../lib/stt/audio';
import './meetings.css';

export const STT_STATE_LABEL: Record<SttState, string> = {
  none: 'Zvuk nahrán, přepis nespuštěn',
  submitting: 'Odesílám k přepisu…',
  unknown: 'Ověřuji, zda přepis vznikl…',
  transcribing: 'Přepisuji…',
  completed: 'Přepis hotov',
  failed: 'Přepis selhal',
};

/** Srozumitelný důvod selhání podle TYPU chyby (text od poskytovatele se nikdy nezobrazuje ani neukládá). */
export const STT_ERROR_LABEL: Record<string, string> = {
  invalid_audio: 'Soubor není platný zvukový záznam.',
  invalid_audio_file: 'Poskytovatel přepisu soubor nepřijal jako zvuk.',
  empty_transcript: 'V záznamu nebyla rozpoznána žádná řeč.',
  transcript_too_long: 'Přepis je příliš dlouhý.',
  storage_unavailable: 'Soubor se nepodařilo zpřístupnit.',
  network_error: 'Spojení s poskytovatelem přepisu selhalo.',
  cancelled: 'Přepis byl zrušen.',
  transcription_not_found: 'Poskytovatel úlohu už nezná.',
  attach_failed: 'Přepis se nepodařilo zahájit.',
  internal_error: 'Služba přepisu hlásí chybu.',
  limit_exceeded: 'Služba přepisu je přetížená.',
  service_unavailable: 'Služba přepisu je dočasně nedostupná.',
};

const MAX_ATTEMPTS = 3;

interface Props {
  meeting: Meeting;
  projectId: string;
  /** Po změně stavu: stránka porady se znovu načte. */
  onChanged: (message?: string) => void | Promise<void>;
  /** Rozestupy dotazování na stav (ms): začíná se na `first`, násobí se 1,5× až do `max`. Testy dávají malé hodnoty. */
  pollMs?: { first: number; max: number };
}

/**
 * Zvuk porady: souhlas, stav přepisu, spuštění (vždy výslovně), zrušení, smazání zvuku. Žádný přepis neběží na pozadí:
 * dokud je stránka otevřená, jednou za pár sekund se zavolá krátký "sync" krok; zavřením stránky dotazování končí
 * a stav zůstává uložený v databázi (další otevření ho dokončí).
 */
export default function AudioPanel({ meeting, projectId, onChanged, pollMs = { first: 5000, max: 30000 } }: Props) {
  const a = meeting.audio;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stuck, setStuck] = useState(false);
  const [deferred, setDeferred] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const inFlight = a.sttState === 'submitting' || a.sttState === 'unknown' || a.sttState === 'transcribing';
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const sync = useCallback(
    async (cancel = false) => {
      try {
        const r = await meetingService.syncTranscription(projectId, meeting.id, cancel);
        if (!alive.current) return null;
        setStuck(r.stuck === true);
        setDeferred(r.abandonDeferred === true);
        if (r.state !== a.sttState || r.revision || r.audioPurged || r.cleanupPending !== a.cleanupPending) await onChanged();
        return r;
      } catch (e) {
        if (alive.current) setError(e instanceof MeetingServiceError ? e.message : 'Stav přepisu se nepodařilo zjistit.');
        return null;
      }
    },
    [projectId, meeting.id, a.sttState, a.cleanupPending, onChanged]
  );

  // Dotazování jen dokud je stránka otevřená a úloha běží; po dokončení se ještě jednou dokončí úklid / retence.
  // "Dnes" se bere při vykreslení stránky (useState-inicializátor je čistý pro React); stačí hrubá přesnost.
  const [now] = useState(() => Date.now());
  // Platí i pro selhané / zrušené porady: termín smazání zvuku a úklid u poskytovatele se na ně vztahují stejně.
  const due = !!a.path && !!a.deleteAfter && !a.deletedAt && Date.parse(a.deleteAfter) <= now;
  const needsSettle = !inFlight && (a.cleanupPending || due);

  // Smazání po termínu a úklid u poskytovatele: zvuk se maže PŘÍMO (Storage + databáze), nezávisle na přepisu a na serverových
  // routách; úklid u poskytovatele je navíc a nikdy nebrání smazání zvuku.
  const settle = useCallback(async () => {
    let changed = false;
    try {
      if (due) {
        await meetingService.deleteAudioFiles(projectId, meeting.id);
        changed = true;
      }
    } catch (e) {
      if (alive.current) setError(e instanceof MeetingServiceError ? e.message : 'Zvuk se nepodařilo smazat.');
    }
    if (a.cleanupPending) await meetingService.providerCleanupBestEffort(projectId, meeting.id);
    if (alive.current && changed) await onChanged();
  }, [due, a.cleanupPending, projectId, meeting.id, onChanged]);

  useEffect(() => {
    if (!inFlight && !needsSettle) return;
    let stop = false;
    let delay = pollMs.first;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (stop) return;
      if (inFlight) await sync();
      else await settle();
      if (stop) return;
      delay = Math.min(pollMs.max, Math.round(delay * 1.5));
      if (inFlight) timer = setTimeout(tick, delay);
    };
    timer = setTimeout(tick, needsSettle && !inFlight ? 0 : pollMs.first);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [inFlight, needsSettle, sync, settle, pollMs.first, pollMs.max]);

  async function act(fn: () => Promise<void>, message?: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
      await onChanged(message);
    } catch (e) {
      setError(e instanceof MeetingServiceError ? e.message : 'Akce se nezdařila.');
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  const canStart = !!a.path && !a.deletedAt && (a.sttState === 'none' || a.sttState === 'failed') && a.attempts < MAX_ATTEMPTS;
  const estMs = a.audioMs ?? null;

  return (
    <section className="mi-card" aria-label="Zvuk porady" data-testid="audio-panel">
      <div className="mi-row" style={{ justifyContent: 'space-between' }}>
        <h2>Zvuk</h2>
        <span data-testid="stt-state">
          <Badge variant={a.sttState === 'failed' ? 'danger' : a.sttState === 'completed' ? 'success' : 'default'}>
            {a.deletedAt && a.sttState === 'none' ? 'Zvuk smazán' : !a.path && a.sttState === 'none' ? 'Zvuk zatím nenahrán' : STT_STATE_LABEL[a.sttState]}
          </Badge>
        </span>
      </div>
      <p className="mi-muted" data-testid="audio-info">
        {a.consentAt ? `Prohlášení člena o informování účastníků zaznamenáno ${new Date(a.consentAt).toLocaleString('cs-CZ')} (není to právní doklad o souhlasu).` : 'Prohlášení o informování účastníků nebylo zaznamenáno.'}
        {a.bytes ? ` Soubor ${(a.bytes / 1048576).toFixed(1)} MB.` : ''}
        {a.path && a.deleteAfter && !a.deletedAt
          ? ` Termín smazání zvuku: ${new Date(a.deleteAfter).toLocaleDateString('cs-CZ')}. Aplikace nemá plánovač: zvuk se smaže při prvním otevření porad po tomto termínu, nebo ho můžete smazat hned.`
          : ''}
        {a.deletedAt ? ` Zvuk byl smazán ${new Date(a.deletedAt).toLocaleDateString('cs-CZ')}, přepis zůstává.` : ''}
      </p>
      {a.sttState === 'completed' && estMs !== null && (
        <p className="mi-muted" data-testid="stt-usage">
          Délka zvuku {(estMs / 60000).toFixed(1)} min · odhad ceny přepisu ${(a.costUsd ?? estimateSttCostUsd(estMs)).toFixed(4)} ({a.model ?? 'Soniox'}).
        </p>
      )}
      {a.sttState === 'failed' && (
        <p role="alert" className="mi-error" data-testid="stt-error">
          {STT_ERROR_LABEL[a.errorType ?? ''] ?? 'Přepis se nezdařil.'} {a.attempts >= MAX_ATTEMPTS ? 'Počet pokusů je vyčerpán: nahrajte zvuk znovu.' : `Pokus ${a.attempts} z ${MAX_ATTEMPTS}.`}
        </p>
      )}
      {a.sttState === 'unknown' && (
        <p role="status" className="mi-muted" data-testid="stt-unknown">
          Odpověď poskytovatele nepřišla, takže se neví, jestli přepis vznikl. Nic se neodesílá znovu automaticky (hrozila by dvojí platba): stav se
          ověřuje u poskytovatele. Když to nevyjde, přepis můžete ukončit; odhadovaná cena zůstane započtena do limitu.
        </p>
      )}
      {deferred && a.sttState === 'unknown' && (
        <p role="status" className="mi-muted" data-testid="stt-abandon-deferred">
          Odeslání ještě může probíhat, proto ho zatím nelze ukončit (jinak by hrozila druhá platba). Zkuste to za několik minut; odhad ceny zůstává započten.
        </p>
      )}
      {a.cleanupPending && (
        <p role="status" className="mi-muted" data-testid="stt-cleanup">Úklid dat u poskytovatele přepisu ještě neproběhl; zopakuje se při dalším otevření porady.</p>
      )}
      {stuck && inFlight && (
        <p role="status" className="mi-muted" data-testid="stt-stuck">Přepis trvá nezvykle dlouho. Můžete to zkontrolovat znovu, nebo přepis zrušit.</p>
      )}
      {error && <p role="alert" className="mi-error" data-testid="audio-error">{error}</p>}

      <div className="mi-row">
        {canStart && (
          <Button
            variant="primary"
            disabled={busy || !a.consentAt}
            onClick={() => act(async () => { await meetingService.startTranscription(projectId, meeting.id); }, 'Přepis zahájen.')}
            data-testid="stt-start"
          >
            {a.sttState === 'failed' ? `Zkusit znovu (pokus ${a.attempts + 1} z ${MAX_ATTEMPTS})` : 'Přepsat zvuk'}
          </Button>
        )}
        {inFlight && (
          <>
            <Button onClick={() => void sync()} disabled={busy} data-testid="stt-check">Zkontrolovat stav</Button>
            <Button variant="ghost" onClick={() => act(async () => { const r = await meetingService.syncTranscription(projectId, meeting.id, true); setDeferred(r.abandonDeferred === true); }, 'Požadavek na zrušení odeslán.')} disabled={busy} data-testid="stt-cancel">{a.sttState === 'unknown' ? 'Ukončit (cena zůstane započtena)' : 'Zrušit přepis'}</Button>
          </>
        )}
        {a.path && !a.deletedAt && !inFlight && (
          confirmDelete ? (
            <>
              <span>Smazat zvuk? Přepis zůstane.</span>
              <Button variant="danger" onClick={() => act(async () => { await meetingService.purgeAudio(projectId, meeting.id); setConfirmDelete(false); }, 'Zvuk smazán.')} disabled={busy} data-testid="audio-delete-confirm">Smazat zvuk</Button>
              <Button variant="ghost" onClick={() => setConfirmDelete(false)}>Zrušit</Button>
            </>
          ) : (
            <Button variant="ghost" onClick={() => setConfirmDelete(true)} data-testid="audio-delete">Smazat zvuk</Button>
          )
        )}
      </div>
      {canStart && <p className="mi-muted">Přepis odešle zvuk službě Soniox (cca 0,10 USD za hodinu záznamu). Spustí se jen po kliknutí.</p>}
    </section>
  );
}
