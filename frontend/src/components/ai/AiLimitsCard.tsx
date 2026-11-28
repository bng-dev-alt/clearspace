import React from 'react';
import type { AiStatus } from '../../lib/ai/status';

const TIER_TEXT: Record<NonNullable<AiStatus['tier']>, string> = {
  owner: 'Vlastník (bez aplikačního denního limitu)',
  demo: 'Prezentační účet (pevné denní limity)',
  dev: 'Lokální vývoj',
};
const n = (v: number) => v.toLocaleString('cs-CZ');

/**
 * RUN 11 (D3): the account's AI limits exactly as the server enforces them (from /api/intelligence/access → lib/ai/status.ts),
 * replacing the old browser-only "monthly budget 300 CZK". When the value cannot be read, it says so – it never shows a default.
 */
export default function AiLimitsCard({ status, todayTokens, ledgerBacked }: { status: AiStatus | null | undefined; todayTokens: number; ledgerBacked: boolean }) {
  return (
    <section className="cs-card cs-card--pad ai-limits-card" aria-labelledby="ai-limits-title" data-testid="ai-limits">
      <h2 id="ai-limits-title" className="ai-limits-title">Limity vašeho účtu</h2>
      {status === undefined ? (
        <p className="mi-muted" role="status">Načítání…</p>
      ) : status === null ? (
        <p className="mi-muted" data-testid="ai-limits-unknown">Limity teď nelze zjistit (ukázkový režim nebo server neodpověděl). Platí, co vynucuje server; při vyčerpání se akce odmítne s vysvětlením.</p>
      ) : !status.available ? (
        <p data-testid="ai-limits-unavailable">AI funkce nejsou pro tento účet na tomto serveru zapnuté. Ostatní funkce ClearSpace fungují bez omezení.</p>
      ) : (
        <dl className="ai-limits-list">
          <div><dt>Účet</dt><dd data-testid="ai-limits-tier">{status.tier ? TIER_TEXT[status.tier] : '—'}</dd></div>
          <div><dt>Denní limit tokenů</dt><dd data-testid="ai-limits-daily">
            {status.dailyTokens === null ? 'bez aplikačního limitu' : <>{n(status.dailyTokens)}{ledgerBacked && <span className="mi-muted"> · dnes podle záznamu {n(todayTokens)}</span>}</>}
          </dd></div>
          <div><dt>Požadavků za minutu</dt><dd data-testid="ai-limits-rate">{status.perMinute === null ? '—' : n(status.perMinute)}</dd></div>
          <div><dt>Přepis porad</dt><dd data-testid="ai-limits-stt">
            {status.sttMinutesPerDay === 0 ? 'pro tento účet vypnutý' : status.sttMinutesPerDay === null ? 'bez aplikačního denního limitu' : `${n(status.sttMinutesPerDay)} min denně`}
          </dd></div>
        </dl>
      )}
      <p className="ai-limits-note">Limity se počítají po dnech v UTC a zahrnují i rezervace probíhajících požadavků, proto se dnešní číslo může od limitu lišit dřív, než ho dosáhnete.</p>
    </section>
  );
}
