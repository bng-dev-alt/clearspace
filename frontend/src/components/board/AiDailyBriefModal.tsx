'use client';

import React, { useState, useEffect } from 'react';
import { X, Sun, CheckCircle, Target, AlertCircle, RefreshCw } from 'lucide-react';
import { Column } from '../../types/kanban';
import { aiClient } from '../../services/ai/aiClient';

export interface DailyBriefData {
  greeting: string;
  executiveSummary: string;
  completedYesterday: string[];
  topPrioritiesToday: string[];
  capacityAlerts: string[];
  recommendedActions: string[];
}

interface AiDailyBriefModalProps {
  isOpen: boolean;
  onClose: () => void;
  columns: Column[];
  projectName: string;
}

export default function AiDailyBriefModal({ isOpen, onClose, columns: _columns, projectName }: AiDailyBriefModalProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [brief, setBrief] = useState<DailyBriefData | null>(null);

  const fetchDailyBrief = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await aiClient.fetchAi('/api/ai/daily-brief', 'AI Daily Brief', {
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

  // Analýza se spustí jednou při otevření. Závislost je záměrně jen `isOpen`:
  // doplnění `brief`/`isLoading`/callbacku by efekt spouštělo dokola,
  // protože je sám mění. Stráž uvnitř hlídá, že se nespustí dvakrát.
  useEffect(() => {
    if (isOpen && !brief && !isLoading) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      fetchDailyBrief();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(3, 33, 71, 0.65)',
        backdropFilter: 'blur(4px)',
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1.5rem',
      }}
      onClick={onClose}
      data-testid="ai-daily-brief-modal"
    >
      <div
        style={{
          backgroundColor: 'var(--bg-page)',
          borderRadius: '14px',
          maxWidth: '800px',
          width: '100%',
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: 'var(--shadow-xl)',
          border: '1px solid var(--border-color)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '1rem 1.5rem',
            borderBottom: '1px solid var(--border-color)',
            backgroundColor: 'var(--surface-1)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <Sun size={22} style={{ color: '#ecad0a' }} />
            <div>
              <h2 style={{ fontSize: '1.1rem', fontWeight: 800, color: 'var(--dark-navy)', margin: 0 }}>
                Daily Brief – {projectName}
              </h2>
              <p style={{ fontSize: '0.75rem', color: 'var(--gray-text)', margin: 0 }}>
                Ranní manažerský přehled a klíčové priority pro dnešní den
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--gray-text)' }}
          >
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div style={{ padding: '1.5rem', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          {isLoading ? (
            <div style={{ textAlign: 'center', padding: '3rem 1rem' }}>
              <div className="ai-spinner" style={{ margin: '0 auto 1rem' }} />
              <p style={{ fontWeight: 700, color: 'var(--purple-secondary)', fontSize: '0.9rem' }}>
                ✨ AI sestavuje ranní přehled projektu...
              </p>
            </div>
          ) : error ? (
            <div
              style={{
                padding: '1rem',
                backgroundColor: 'var(--danger-soft)',
                borderRadius: '8px',
                color: 'var(--danger)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <span style={{ fontSize: '0.85rem' }}>{error}</span>
              <button
                type="button"
                onClick={fetchDailyBrief}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.35rem',
                  padding: '0.35rem 0.75rem',
                  backgroundColor: 'var(--danger)',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  fontWeight: 600,
                }}
              >
                <RefreshCw size={14} /> Obnovit
              </button>
            </div>
          ) : brief ? (
            <>
              {/* Greeting & Executive Summary */}
              <div
                style={{
                  padding: '1.25rem',
                  backgroundColor: 'var(--surface-1)',
                  borderRadius: '10px',
                  border: '1px solid var(--border-color)',
                }}
              >
                <span style={{ fontSize: '0.95rem', fontWeight: 800, color: 'var(--purple-secondary)' }}>
                  {brief.greeting}
                </span>
                <p style={{ fontSize: '0.85rem', color: 'var(--dark-navy)', marginTop: '0.5rem', marginBottom: 0, lineHeight: '1.4' }}>
                  {brief.executiveSummary}
                </p>
              </div>

              {/* Top Priorities Today */}
              {brief.topPrioritiesToday.length > 0 && (
                <div>
                  <h4 style={{ fontSize: '0.85rem', fontWeight: 800, color: 'var(--dark-navy)', margin: '0 0 0.5rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                    <Target size={16} style={{ color: 'var(--purple-secondary)' }} /> Top priority pro dnešní den
                  </h4>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                    {brief.topPrioritiesToday.map((prio, idx) => (
                      <div
                        key={idx}
                        style={{
                          padding: '0.55rem 0.85rem',
                          backgroundColor: 'rgba(117, 57, 145, 0.05)',
                          border: '1px solid rgba(117, 57, 145, 0.2)',
                          borderRadius: '6px',
                          fontSize: '0.8rem',
                          fontWeight: 700,
                          color: 'var(--dark-navy)',
                        }}
                      >
                        {idx + 1}. {prio}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Completed Recently & Capacity Alerts */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1rem' }}>
                {brief.completedYesterday.length > 0 && (
                  <div>
                    <h4 style={{ fontSize: '0.85rem', fontWeight: 800, color: 'var(--dark-navy)', margin: '0 0 0.5rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                      <CheckCircle size={16} style={{ color: '#107c41' }} /> Nedávno dokončeno
                    </h4>
                    <ul style={{ margin: 0, paddingLeft: '1.2rem', fontSize: '0.78rem', color: 'var(--dark-navy)' }}>
                      {brief.completedYesterday.map((item, idx) => (
                        <li key={idx} style={{ marginBottom: '0.25rem' }}>{item}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {brief.capacityAlerts.length > 0 && (
                  <div>
                    <h4 style={{ fontSize: '0.85rem', fontWeight: 800, color: 'var(--dark-navy)', margin: '0 0 0.5rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                      <AlertCircle size={16} style={{ color: '#ecad0a' }} /> Kapacitní a termínová varování
                    </h4>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                      {brief.capacityAlerts.map((alert, idx) => (
                        <span key={idx} style={{ fontSize: '0.75rem', padding: '0.35rem 0.6rem', backgroundColor: 'rgba(236, 173, 10, 0.1)', color: '#ecad0a', borderRadius: '4px', fontWeight: 600 }}>
                          ⚠️ {alert}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Recommended Actions */}
              {brief.recommendedActions.length > 0 && (
                <div>
                  <h4 style={{ fontSize: '0.85rem', fontWeight: 800, color: 'var(--dark-navy)', margin: '0 0 0.5rem' }}>
                    Doporučené akce pro dnešek
                  </h4>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                    {brief.recommendedActions.map((act, idx) => (
                      <div key={idx} style={{ padding: '0.45rem 0.75rem', backgroundColor: 'var(--surface-1)', borderRadius: '6px', border: '1px solid var(--border-color)', fontSize: '0.8rem', color: 'var(--dark-navy)' }}>
                        👉 {act}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : null}
        </div>

        {/* Footer */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            padding: '0.85rem 1.5rem',
            borderTop: '1px solid var(--border-color)',
            backgroundColor: 'var(--surface-1)',
          }}
        >
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: '0.5rem 1.2rem',
              backgroundColor: 'var(--purple-secondary)',
              color: 'var(--text-on-accent)',
              border: 'none',
              borderRadius: '6px',
              fontSize: '0.85rem',
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            Rozumím, pokračovat
          </button>
        </div>
      </div>
    </div>
  );
}
