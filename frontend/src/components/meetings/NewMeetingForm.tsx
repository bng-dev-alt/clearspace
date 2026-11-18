'use client';

import React, { useState } from 'react';
import { Button } from '../ui';
import { meetingService, MeetingServiceError } from '../../services/meetingService';
import { sourceFromFilename, type TranscriptSource } from '../../lib/intelligence/transcript';
import { ACCEPT_ATTR, MAX_AUDIO_BYTES } from '../../lib/stt/audio';
import './meetings.css';

const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Přepis zvuku je zapnutý jen příznakem (výchozí stav: vypnuto); server má vlastní příznak STT_ENABLED. */
export const AUDIO_ENABLED = process.env.NEXT_PUBLIC_ENABLE_MEETING_AUDIO === '1';

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
  const [mode, setMode] = useState<'text' | 'audio'>('text');
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [consent, setConsent] = useState(false);

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
      {AUDIO_ENABLED && (
        <div className="mi-row" role="group" aria-label="Zdroj porady">
          <Button type="button" size="sm" variant={mode === 'text' ? 'primary' : 'ghost'} onClick={() => setMode('text')} data-testid="mode-text">Text</Button>
          <Button type="button" size="sm" variant={mode === 'audio' ? 'primary' : 'ghost'} onClick={() => setMode('audio')} data-testid="mode-audio">Zvuk</Button>
        </div>
      )}
      {mode === 'audio' ? (
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
          <option value="">Čeština (výchozí)</option>
          <option value="cs">Čeština</option>
          <option value="en">English</option>
        </select>
      </div>
      {error && (
        <p role="alert" className="mi-error" data-testid="meeting-error">
          {error}
        </p>
      )}
      <div className="mi-row">
        <Button type="submit" variant="primary" disabled={busy} data-testid="meeting-create">
          {busy ? (mode === 'audio' ? 'Nahrávám…' : 'Ukládám…') : 'Vytvořit poradu'}
        </Button>
      </div>
    </form>
  );
}
