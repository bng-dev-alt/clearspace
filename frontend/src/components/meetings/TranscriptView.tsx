'use client';

import React, { useEffect, useState } from 'react';
import { Button } from '../ui';
import type { Transcript } from '../../lib/intelligence/types';
import { fmtMs } from './labels';
import './meetings.css';

interface Props {
  transcript: Transcript;
  speakerNames: Record<string, string>;
  highlightId: string | null;
  onSaveSpeakers: (names: Record<string, string>) => Promise<void> | void;
}

/** Přepis (jen ke čtení) se jmény mluvčích zadanými člověkem; zvýrazňuje segment, na který odkazuje důkaz. */
export default function TranscriptView({ transcript, speakerNames, highlightId, onSaveSpeakers }: Props) {
  const [names, setNames] = useState<Record<string, string>>(speakerNames);
  const [saving, setSaving] = useState(false);
  const byId = new Map(transcript.speakers.map((s) => [s.id, s]));

  useEffect(() => {
    if (!highlightId) return;
    document.getElementById(`seg-${highlightId}`)?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  }, [highlightId]);

  const label = (id: string | null): string => {
    if (!id) return '';
    const sp = byId.get(id);
    return (speakerNames[id] ?? sp?.displayName ?? sp?.label ?? '').trim();
  };

  return (
    <section className="mi-card" aria-label="Přepis" data-testid="transcript">
      <h2>Přepis</h2>
      {transcript.speakers.length > 0 && (
        <details>
          <summary>Jména mluvčích</summary>
          <div className="mi-list">
            {transcript.speakers.map((s) => (
              <div key={s.id} className="mi-row">
                <label htmlFor={`sp-${s.id}`}>{s.label}</label>
                <input
                  id={`sp-${s.id}`}
                  value={names[s.id] ?? ''}
                  placeholder="Jméno"
                  maxLength={100}
                  onChange={(e) => setNames((n) => ({ ...n, [s.id]: e.target.value }))}
                />
              </div>
            ))}
            <Button
              size="sm"
              disabled={saving}
              onClick={async () => {
                setSaving(true);
                try {
                  await onSaveSpeakers(names);
                } finally {
                  setSaving(false);
                }
              }}
              data-testid="save-speakers"
            >
              Uložit jména
            </Button>
          </div>
        </details>
      )}
      <div role="list">
        {transcript.segments.map((seg) => (
          <div key={seg.id} id={`seg-${seg.id}`} role="listitem" className="mi-seg" data-highlight={highlightId === seg.id} data-testid={`segment-${seg.id}`}>
            {fmtMs(seg.startMs) ? <span className="mi-time">{fmtMs(seg.startMs)}</span> : null}
            {label(seg.speakerId) ? <span className="mi-speaker">{label(seg.speakerId)}:</span> : null}
            {seg.text}
          </div>
        ))}
      </div>
    </section>
  );
}
