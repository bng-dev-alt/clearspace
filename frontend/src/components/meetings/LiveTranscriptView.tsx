'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';

export interface TranscriptGroup { speaker: string | null; startMs: number; text: string }

/**
 * RUN 11 (#16): the running transcript, readable from across the room. Presentation only – the same tokens the live panel already has.
 * "Celá obrazovka" uses the browser Fullscreen API on this element; where it is missing (iPhone/iPad Safari) the same view is shown as a
 * fixed full-window layer. Esc (browser) or the button leaves it. Speakers are told apart by a coloured marker (non-text colour, so the
 * text keeps the normal contrast in every style and theme), never by colour alone: the name stays written next to it.
 */
export default function LiveTranscriptView({ groups, partial, status, speakerLabel, fmt }: {
  groups: TranscriptGroup[];
  partial: string;
  /** Short state line shown in the full-screen header, e.g. "● Nahrává se · 12:34". */
  status: React.ReactNode;
  speakerLabel: (sp: string | null) => string;
  fmt: (ms: number) => string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const [native, setNative] = useState(false);   // document.fullscreenElement === this view
  const [fallback, setFallback] = useState(false); // fixed full-window layer (no Fullscreen API)
  const presenting = native || fallback;
  // stable colour per speaker = order of first appearance (the transcript only grows, so earlier speakers keep their colour)
  const colours = useMemo(() => {
    const m = new Map<string, number>();
    for (const g of groups) if (g.speaker && !m.has(g.speaker)) m.set(g.speaker, m.size % 6);
    return m;
  }, [groups]);
  const colourOf = (sp: string | null) => (sp ? colours.get(sp) : undefined);

  useEffect(() => {
    const sync = () => setNative(document.fullscreenElement === ref.current);
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);
  useEffect(() => {
    if (!fallback) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFallback(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [fallback]);
  // keep the newest words in view while presenting
  useEffect(() => { if (presenting) end.current?.scrollIntoView?.({ block: 'end' }); }, [presenting, groups.length, partial]);

  const toggle = async () => {
    if (presenting) {
      if (native && document.exitFullscreen) await document.exitFullscreen().catch(() => {});
      setFallback(false);
      return;
    }
    const el = ref.current;
    if (el?.requestFullscreen) {
      try { await el.requestFullscreen(); return; } catch { /* denied (e.g. iframe policy): fall back to the window layer */ }
    }
    setFallback(true);
  };

  return (
    <div ref={ref} className={`mi-live-transcript${presenting ? ' is-presenting' : ''}${fallback ? ' is-fallback' : ''}`}
      aria-label="Průběžný přepis" data-testid="live-transcript" data-presenting={presenting ? 'true' : 'false'}>
      <div className="mi-live-transcript-bar">
        {presenting && <span className="mi-live-transcript-status" data-testid="live-fullscreen-status">{status}</span>}
        <button type="button" className="cs-btn cs-btn--secondary cs-btn--sm" onClick={() => void toggle()} data-testid="live-fullscreen"
          aria-pressed={presenting}>
          {presenting ? <><Minimize2 size={14} aria-hidden="true" /> Ukončit celou obrazovku</> : <><Maximize2 size={14} aria-hidden="true" /> Celá obrazovka</>}
        </button>
      </div>
      <div className="mi-live-transcript-body">
        {groups.map((g, i) => (
          <p key={i} className="mi-seg" data-speaker-color={colourOf(g.speaker)}>
            <span className="mi-time">{fmt(g.startMs)}</span>{g.speaker && <span className="mi-speaker">{speakerLabel(g.speaker)}</span>}{g.text}
          </p>
        ))}
        {partial && <p className="mi-muted" data-testid="live-partial">{partial}</p>}
        <div ref={end} />
      </div>
    </div>
  );
}
