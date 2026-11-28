'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';

async function writeClipboard(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    const ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { return document.execCommand('copy'); } catch { return false; } finally { ta.remove(); }
  }
}

/**
 * One-click copy for commands, codes, links and messages (RUN 08 pattern, shared since RUN 11). Visible + announced confirmation;
 * if the browser refuses the clipboard it says so instead of pretending it worked.
 */
export default function CopyButton({ text, label = 'Kopírovat', ariaLabel, testId, size = 'sm' }: {
  text: string; label?: string; ariaLabel?: string; testId?: string; size?: 'sm' | 'md';
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const copy = async () => {
    setState((await writeClipboard(text)) ? 'copied' : 'failed');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 2500);
  };
  return (
    <>
      <button type="button" className={`cs-btn ${size === 'sm' ? 'cs-btn--sm ' : ''}${state === 'copied' ? 'cs-btn--primary' : 'cs-btn--secondary'}`}
        onClick={() => void copy()} data-testid={testId} aria-label={state === 'idle' ? ariaLabel : undefined}>
        {state === 'copied' ? <><Check size={14} aria-hidden="true" /> Zkopírováno</> : <><Copy size={14} aria-hidden="true" /> {label}</>}
      </button>
      <span className="cs-sr-only" role="status" aria-live="polite">
        {state === 'copied' ? 'Zkopírováno do schránky' : state === 'failed' ? 'Kopírování se nezdařilo – označte text a zkopírujte ho ručně' : ''}
      </span>
      {state === 'failed' && <span className="cs-status cs-status--error" data-testid={testId ? `${testId}-failed` : undefined}>Prohlížeč kopírování nepovolil – označte text ručně.</span>}
    </>
  );
}
