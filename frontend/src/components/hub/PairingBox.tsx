'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Check, Copy, ExternalLink } from 'lucide-react';

/**
 * RUN 08 UX: one pairing pattern for every Slack / Telegram link (project destinations, chat identities, personal notifications):
 * numbered steps, the EXACT command with one-click copy + visible confirmation, a button that opens the right app, a live countdown of the
 * code's validity, and an expired state. While active it calls `onTick` every 3 s so the caller can detect the link automatically.
 */
export function CopyButton({ text, label = 'Kopírovat', testId }: { text: string; label?: string; testId?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); } catch {
      const ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } finally { ta.remove(); }
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2500);
  };
  return (
    <button type="button" className={`cs-btn cs-btn--sm ${copied ? 'cs-btn--primary' : 'cs-btn--secondary'}`} onClick={() => void copy()} data-testid={testId} aria-live="polite">
      {copied ? <><Check size={14} aria-hidden="true" /> Zkopírováno</> : <><Copy size={14} aria-hidden="true" /> {label}</>}
    </button>
  );
}

export function useCountdown(until: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!until) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [until]);
  return until ? Math.max(0, Math.ceil((until - now) / 1000)) : 0;
}
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

export interface PairingInfo {
  title: string;
  steps: string[];
  command?: string | null;          // exact text to paste in the chat
  openUrl?: string | null;          // opens the provider app (Telegram deep link, Slack)
  openLabel?: string;
  until: number;                    // ms epoch the code expires
  waitingText: string;              // shown while we wait for the chat side
}

export default function PairingBox({ info, onTick, onRenew, onClose, testId = 'pairing-box' }: {
  info: PairingInfo; onTick?: () => void | Promise<void>; onRenew?: () => void; onClose?: () => void; testId?: string;
}) {
  const left = useCountdown(info.until);
  const expired = left <= 0;
  const tick = useRef(onTick);
  useEffect(() => { tick.current = onTick; }, [onTick]);
  useEffect(() => {
    if (expired || !tick.current) return;
    const t = setInterval(() => { void tick.current?.(); }, 3000);
    return () => clearInterval(t);
  }, [expired]);
  return (
    <div className={`hub-code${expired ? ' is-expired' : ''}`} data-testid={testId} role="group" aria-label={info.title}>
      <p><strong>{info.title}</strong></p>
      <ol className="hub-steps">{info.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
      {info.command && (
        <div className="hub-command">
          <code data-testid={`${testId}-command`}>{info.command}</code>
          {!expired && <CopyButton text={info.command} label="Kopírovat příkaz" testId={`${testId}-copy`} />}
        </div>
      )}
      <div className="hub-actions">
        {info.openUrl && !expired && (
          <a className="cs-btn cs-btn--primary cs-btn--sm" href={info.openUrl} target="_blank" rel="noopener noreferrer" data-testid={`${testId}-open`}>
            <ExternalLink size={14} aria-hidden="true" /> {info.openLabel ?? 'Otevřít'}
          </a>
        )}
        {onClose && <button type="button" className="cs-btn cs-btn--ghost cs-btn--sm" onClick={onClose} data-testid={`${testId}-close`}>Zavřít</button>}
      </div>
      {expired ? (
        <p className="drive-message is-error" data-testid={`${testId}-expired`}>Kód vypršel.{' '}
          {onRenew && <button type="button" className="cs-btn cs-btn--secondary cs-btn--sm" onClick={onRenew} data-testid={`${testId}-renew`}>Vytvořit nový kód</button>}</p>
      ) : (
        <p className="hub-muted" aria-live="polite" data-testid={`${testId}-status`}>
          <span className="hub-spinner" aria-hidden="true" /> {info.waitingText} · platí ještě <strong data-testid={`${testId}-countdown`}>{mmss(left)}</strong>
        </p>
      )}
    </div>
  );
}
