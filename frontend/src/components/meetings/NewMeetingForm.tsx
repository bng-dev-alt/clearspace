'use client';

import React, { useEffect, useState } from 'react';
import { Button } from '../ui';
import { meetingService, MeetingServiceError, parseAttendees } from '../../services/meetingService';
import { sourceFromFilename, type TranscriptSource } from '../../lib/intelligence/transcript';
import { ACCEPT_ATTR, MAX_AUDIO_BYTES } from '../../lib/stt/audio';
import './meetings.css';

const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Přepis zvuku je zapnutý jen příznakem (výchozí stav: vypnuto); server má vlastní příznak STT_ENABLED. */
export const AUDIO_ENABLED = process.env.NEXT_PUBLIC_ENABLE_MEETING_AUDIO === '1';
/** RUN 10: plánované / živé porady (UI). Server má vlastní vypínače (MEETING_LIVE_ENABLED, CALENDAR_WRITE_ENABLED) a pilot. */
export const LIVE_ENABLED = process.env.NEXT_PUBLIC_ENABLE_MEETING_LIVE === '1';

export const CONSENT_TEXT =
  'Potvrzuji, že mám právo tento záznam zpracovat a že všichni účastníci byli informováni o jeho zpracování (zvuk přepíše služba Soniox, text pak analyzuje Google Gemini). Je to moje prohlášení; samo o sobě nezaručuje splnění právních povinností (souhlasy, smlouvy o zpracování, oblast zpracování).';

/** Délka z metadat souboru (jen pro odhad rozpočtu; server ji nepovažuje za důvěryhodnou). Selhání = null. */
function readDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    if (typeof Audio === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) return resolve(null);
    const url = URL.createObjectURL(file);
    const a = new Audio();
    const done = (v: number | null) => {
      URL.revokeObjectURL(url);
      resolve(v);
    };
    const t = setTimeout(() => done(null), 3000);
    a.onloadedmetadata = () => {
      clearTimeout(t);
      done(Number.isFinite(a.duration) ? Math.round(a.duration * 1000) : null);
    };
    a.onerror = () => {
      clearTimeout(t);
      done(null);
    };
    a.src = url;
  });
}

interface Props {
  projectId: string;
  onCreated: (meetingId: string, warnings: string[]) => void;
}

/** Nová porada z textu: vložený přepis nebo soubor TXT / MD / SRT / VTT. Nic se neposílá do AI. */
export default function NewMeetingForm({ projectId, onCreated }: Props) {
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [source, setSource] = useState<TranscriptSource>('paste');
  const [fileName, setFileName] = useState<string | null>(null);
  const [language, setLanguage] = useState<'' | 'cs' | 'en'>('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'text' | 'audio' | 'plan'>('text');
  const localNow = () => { const d = new Date(Date.now() + 5 * 60_000); d.setSeconds(0, 0); return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); };
  const [startAt, setStartAt] = useState(localNow);
  const [durationMin, setDurationMin] = useState(60);
  const [conf, setConf] = useState('');
  const [guests, setGuests] = useState('');
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [consent, setConsent] = useState(false);
  // Volby zvuku jen pro účet, který na to má právo podle serveru (UX; oprávnění hlídá server u každé cesty).
  const [sttAllowed, setSttAllowed] = useState(false);
  useEffect(() => {
    if (!AUDIO_ENABLED) return;
    let alive = true;
    void meetingService.aiAccess().then((a) => { if (alive) setSttAllowed(a.stt); });
    return () => { alive = false; };
  }, []);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setError(null);
    const src = sourceFromFilename(f.name);
    if (!src) {
      setError('Nepodporovaný typ souboru. Nahrajte TXT, MD, SRT nebo VTT.');
      return;
    }
    if (f.size > MAX_FILE_BYTES) {
      setError('Soubor je příliš velký (max 2 MB).');
      return;
    }
    setText(await f.text());
    setSource(src);
    setFileName(f.name);
    if (!title.trim()) setTitle(f.name.replace(/\.[^.]+$/, ''));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === 'plan') {
        const { valid, invalid } = parseAttendees(guests);
        if (invalid.length) throw new MeetingServiceError('invalid', `Neplatné e-maily: ${invalid.join(', ')}`);
        const start = new Date(startAt);
        if (!Number.isFinite(start.getTime())) throw new MeetingServiceError('invalid', 'Zadejte začátek porady.');
        const r = await meetingService.createPlanned({
          projectId, title, occurredAt: start.toISOString(), endsAt: new Date(start.getTime() + Math.max(5, durationMin) * 60_000).toISOString(),
          conferenceUrl: conf.trim() || null, attendees: valid, languageHint: language || null,
        });
        onCreated(r.meetingId, []);
        return;
      }
      if (mode === 'audio') {
        if (!audioFile) throw new MeetingServiceError('empty', 'Vyberte zvukový soubor.');
        const r = await meetingService.createAudioMeeting({
          projectId,
          title,
          file: audioFile,
          consent,
          languageHint: language || null,
          clientDurationMs: await readDuration(audioFile),
        });
        onCreated(r.meetingId, []);
        return;
      }
      const r = await meetingService.createWithTranscript({
        projectId,
        title,
        text,
        source,
        languageHint: language || null,
      });
      onCreated(r.meetingId, r.warnings);
    } catch (err) {
      setError(err instanceof MeetingServiceError ? err.message : 'Poradu se nepodařilo vytvořit.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="mi-card" onSubmit={submit} data-testid="new-meeting-form" aria-label="Nová porada">
      <div className="mi-field">
        <label htmlFor="mi-title">Název porady</label>
        <input id="mi-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required />
      </div>
      {((AUDIO_ENABLED && sttAllowed) || LIVE_ENABLED) && (
        <div className="mi-row" role="group" aria-label="Zdroj porady">
          {LIVE_ENABLED && <Button type="button" size="sm" variant={mode === 'plan' ? 'primary' : 'ghost'} onClick={() => setMode('plan')} data-testid="mode-plan">Naplánovat / živě</Button>}
          <Button type="button" size="sm" variant={mode === 'text' ? 'primary' : 'ghost'} onClick={() => setMode('text')} data-testid="mode-text">Vložit přepis</Button>
          {AUDIO_ENABLED && sttAllowed && <Button type="button" size="sm" variant={mode === 'audio' ? 'primary' : 'ghost'} onClick={() => setMode('audio')} data-testid="mode-audio">Nahrát záznam</Button>}
        </div>
      )}
      {mode === 'plan' ? (
        <div className="mi-field" data-testid="plan-form">
          <div className="mi-row">
            <label htmlFor="mi-start">Začátek</label>
            <input id="mi-start" type="datetime-local" value={startAt} onChange={(e) => setStartAt(e.target.value)} required data-testid="plan-start" />
            <label htmlFor="mi-dur">Délka</label>
            <select id="mi-dur" value={durationMin} onChange={(e) => setDurationMin(Number(e.target.value))} data-testid="plan-duration">
              {[15, 30, 45, 60, 90, 120].map((m) => <option key={m} value={m}>{m} min</option>)}
            </select>
          </div>
          <label htmlFor="mi-conf">Odkaz na schůzku (volitelné – Zoom, Teams, jiný; Google Meet vytvoříte po uložení přes Google Kalendář)</label>
          <input id="mi-conf" type="url" placeholder="https://…" value={conf} onChange={(e) => setConf(e.target.value)} data-testid="plan-conference" />
          <label htmlFor="mi-guests">Pozvaní (e-maily, oddělené čárkou nebo řádkem; hosté nepotřebují účet v ClearSpace)</label>
          <textarea id="mi-guests" rows={2} value={guests} onChange={(e) => setGuests(e.target.value)} data-testid="plan-guests" placeholder="jana@firma.cz, host@klient.com" />
          <span className="mi-muted">Ad-hoc porada = nechte začátek „teď“ a po uložení rovnou spusťte přepis. Pozvánky se nikam neposílají, dokud to výslovně nezvolíte u události v Google Kalendáři.</span>
        </div>
      ) : mode === 'audio' ? (
        <div className="mi-field" data-testid="audio-form">
          <label htmlFor="mi-audio">Zvukový záznam (MP3, M4A, MP4, WAV, WebM, OGG, AAC, FLAC; max {Math.round(MAX_AUDIO_BYTES / 1048576)} MB)</label>
          <input
            id="mi-audio"
            type="file"
            accept={ACCEPT_ATTR}
            onChange={(e) => {
              setAudioFile(e.target.files?.[0] ?? null);
              setError(null);
            }}
            data-testid="audio-file"
          />
          <label>
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} data-testid="audio-consent" /> {CONSENT_TEXT}
          </label>
          <span className="mi-muted">Zvuk se uloží do soukromého úložiště a k přepisu se odešle až po vašem kliknutí na „Přepsat zvuk&ldquo;. Má termín uchování (výchozí 7 dní od nahrání). Smaže se při prvním otevření porad po termínu, nebo ručně kdykoli; aplikace nemá plánovač, takže bez návštěvy se sám nesmaže. Poskytovateli se neposílají jména členů ani název projektu.</span>
        </div>
      ) : (
      <div className="mi-field">
        <label htmlFor="mi-text">Přepis</label>
        <textarea
          id="mi-text"
          rows={10}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setSource('paste');
            setFileName(null);
          }}
          placeholder={'Petr: Dobrý den, začneme releasem.\nJana: Souhlasím.'}
        />
        <span className="mi-muted">Formát „Jméno: text&ldquo; (volitelně s časem [mm:ss]). {fileName ? `Soubor: ${fileName}` : ''}</span>
      </div>
      )}
      <div className="mi-row">
        {mode === 'text' && (
          <>
            <label htmlFor="mi-file">Nebo soubor (TXT, MD, SRT, VTT)</label>
            <input id="mi-file" type="file" accept=".txt,.md,.markdown,.srt,.vtt" onChange={onFile} data-testid="meeting-file" />
          </>
        )}
        <label htmlFor="mi-lang">Jazyk</label>
        <select id="mi-lang" value={language} onChange={(e) => setLanguage(e.target.value as '' | 'cs' | 'en')}>
          {/* RUN 11 (F-26): "" and "cs" behave the same (cs first, en second) – one Czech option, no duplicate */}
          <option value="">Čeština</option>
          <option value="en">Angličtina (English)</option>
        </select>
      </div>
      {error && (
        <p role="alert" className="mi-error" data-testid="meeting-error">
          {error}
        </p>
      )}
      <div className="mi-row">
        <Button type="submit" variant="primary" disabled={busy} data-testid="meeting-create">
          {busy ? (mode === 'audio' ? 'Nahrávám…' : 'Ukládám…') : mode === 'plan' ? 'Uložit poradu' : 'Vytvořit poradu'}
        </Button>
      </div>
    </form>
  );
}
