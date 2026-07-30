'use client';

import React, { useState } from 'react';
import { Sun, CheckCircle, Target, AlertCircle, RefreshCw, Sparkles } from 'lucide-react';
import { Column } from '../../types/kanban';
import { aiClient } from '../../services/ai/aiClient';
import { Button } from '../ui';

export interface DailyBriefData {
  greeting: string;
  executiveSummary: string;
  completedYesterday: string[];
  topPrioritiesToday: string[];
  capacityAlerts: string[];
  recommendedActions: string[];
}

interface ExecutiveSummaryCardProps {
  columns: Column[];
  projectName: string;
}

/**
 * Stejná AI (denní přehled) jako AiDailyBriefModal, ale vykreslená přímo
 * na dashboardu, ne v modalu na kliknutí. Negeneruje se ale automaticky
 * při každém vstupu na dashboard -- to by byl AI request při každé
 * návštěvě stránky. Místo toho: první tlačítko "Vygenerovat", výsledek
 * zůstává v paměti komponenty, "Aktualizovat" pro nové shrnutí.
 */
export default function ExecutiveSummaryCard({ columns, projectName }: ExecutiveSummaryCardProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [brief, setBrief] = useState<DailyBriefData | null>(null);

  const fetchBrief = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await aiClient.fetchAi('/api/ai/daily-brief', 'AI Daily Brief', {
        columns,
        context: { projectName },
      });
      if (response && response.parsed) {
        setBrief(response.parsed as DailyBriefData);
      } else {
        throw new Error('Nepodařilo se načíst strukturální data denního přehledu.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Chyba při generování denního přehledu.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="cs-card" style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.85rem' }} data-testid="executive-summary-card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          <Sparkles size={16} style={{ color: 'var(--accent)' }} />
          <span style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text)' }}>AI Executive Summary</span>
        </div>
        {brief && (
          <Button type="button" variant="secondary" size="sm" onClick={fetchBrief} disabled={isLoading} data-testid="refresh-executive-summary-btn">
            <RefreshCw size={12} />
            Aktualizovat
          </Button>
        )}
      </div>

      {!brief && !isLoading && !error && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.6rem', padding: '1rem 0' }}>
          <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', textAlign: 'center' }}>
            Nechte AI shrnout stav projektu do pár vět -- priority, kapacita, doporučené kroky.
          </span>
          <Button type="button" variant="primary" size="sm" onClick={fetchBrief} data-testid="generate-executive-summary-btn">
            <Sparkles size={13} />
            Vygenerovat shrnutí
          </Button>
        </div>
      )}

      {isLoading && (
        <div style={{ padding: '1rem 0', textAlign: 'center', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
          Generuji shrnutí...
        </div>
      )}

      {error && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <span style={{ fontSize: '0.78rem', color: 'var(--danger)' }}>{error}</span>
          <Button type="button" variant="secondary" size="sm" onClick={fetchBrief} data-testid="retry-executive-summary-btn">
            Zkusit znovu
          </Button>
        </div>
      )}

      {brief && !isLoading && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}>
            <Sun size={15} style={{ color: 'var(--warning)', flexShrink: 0, marginTop: '0.1rem' }} />
            <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text)', lineHeight: 1.5 }}>{brief.executiveSummary}</p>
          </div>

          {brief.topPrioritiesToday.length > 0 && (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', marginBottom: '0.35rem' }}>
                <Target size={13} style={{ color: 'var(--accent)' }} />
                <span style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--text)' }}>Priority</span>
              </div>
              <ul style={{ margin: 0, paddingLeft: '1.2rem', display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                {brief.topPrioritiesToday.map((item, i) => (
                  <li key={i} style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{item}</li>
                ))}
              </ul>
            </div>
          )}

          {brief.capacityAlerts.length > 0 && (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', marginBottom: '0.35rem' }}>
                <AlertCircle size={13} style={{ color: 'var(--danger)' }} />
                <span style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--text)' }}>Upozornění na kapacitu</span>
              </div>
              <ul style={{ margin: 0, paddingLeft: '1.2rem', display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                {brief.capacityAlerts.map((item, i) => (
                  <li key={i} style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{item}</li>
                ))}
              </ul>
            </div>
          )}

          {brief.recommendedActions.length > 0 && (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', marginBottom: '0.35rem' }}>
                <CheckCircle size={13} style={{ color: 'var(--success)' }} />
                <span style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--text)' }}>Doporučené kroky</span>
              </div>
              <ul style={{ margin: 0, paddingLeft: '1.2rem', display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                {brief.recommendedActions.map((item, i) => (
                  <li key={i} style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{item}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
