'use client';

import React, { useState } from 'react';
import { Button } from '../ui';
import { meetingService, MeetingServiceError } from '../../services/meetingService';
import { sourceFromFilename, type TranscriptSource } from '../../lib/intelligence/transcript';
import './meetings.css';

const MAX_FILE_BYTES = 2 * 1024 * 1024;

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
      <div className="mi-row">
        <label htmlFor="mi-file">Nebo soubor (TXT, MD, SRT, VTT)</label>
        <input id="mi-file" type="file" accept=".txt,.md,.markdown,.srt,.vtt" onChange={onFile} data-testid="meeting-file" />
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
          {busy ? 'Ukládám…' : 'Vytvořit poradu'}
        </Button>
      </div>
    </form>
  );
}
