'use client';

import React, { useState, useEffect } from 'react';
import { X, Sparkles, ShieldAlert, Check, RefreshCw, ArrowRight, FileDiff } from 'lucide-react';
import { Card, Column } from '../../types/kanban';
import { aiClient } from '../../services/ai/aiClient';
import { collaborationService } from '../../services/collaborationService';

export interface SuggestedChange {
  id: string;
  actionType: 'MOVE_TASK' | 'CHANGE_PRIORITY' | 'SPLIT_TASK' | 'MERGE_TASKS' | 'ARCHIVE_TASK';
  targetCardId: string;
  targetCardTitle: string;
  targetColumnId?: string;
  targetColumnName?: string;
  newPriority?: 'Low' | 'Medium' | 'High';
  reason: string;
  subtasksToCreate?: string[];
}

export interface AiProjectManagerAnalysis {
  summary: string;
  healthScore: number;
  confidenceScore: number;
  risks: string[];
  blockers: string[];
  suggestedChanges: SuggestedChange[];
}

interface AiProjectManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
  columns: Column[];
  projectId: string;
  projectName: string;
  onMoveCard: (cardId: string, sourceColumnId: string, destinationColumnId: string) => void;
  onUpdateCard: (columnId: string, cardId: string, updates: Partial<Card>) => void;
  onAddCard: (columnId: string, cardData: { title: string; details: string; priority?: 'Low' | 'Medium' | 'High' }) => void;
}

export default function AiProjectManagerModal({
  isOpen,
  onClose,
  columns,
  projectId,
  projectName,
  onMoveCard,
  onUpdateCard,
  onAddCard,
}: AiProjectManagerModalProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<AiProjectManagerAnalysis | null>(null);
  const [selectedChangeIds, setSelectedChangeIds] = useState<Set<string>>(new Set());

  const runAnalysis = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await aiClient.fetchAi('/api/ai/project-manager', 'AI Project Manager', {
        columns,
        context: { projectName },
      });

      if (response && response.parsed) {
        const parsed = response.parsed as AiProjectManagerAnalysis;
        setAnalysis(parsed);
        setSelectedChangeIds(new Set((parsed.suggestedChanges || []).map((c) => c.id)));
      } else {
        throw new Error('Nepodařilo se získat strukturovaná data z AI.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Při volání AI Project Manager došlo k chybě.');
    } finally {
      setIsLoading(false);
    }
  };

  // Analýza se spustí jednou při otevření. Závislost je záměrně jen `isOpen`:
  // doplnění `analysis`/`isLoading`/callbacku by efekt spouštělo dokola,
  // protože je sám mění. Stráž uvnitř hlídá, že se nespustí dvakrát.
  useEffect(() => {
    if (isOpen && !analysis && !isLoading) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      runAnalysis();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  if (!isOpen) return null;

  const toggleSelectChange = (id: string) => {
    setSelectedChangeIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (!analysis) return;
    if (selectedChangeIds.size === analysis.suggestedChanges.length) {
      setSelectedChangeIds(new Set());
    } else {
      setSelectedChangeIds(new Set(analysis.suggestedChanges.map((c) => c.id)));
    }
  };

  const handleApplySelected = async () => {
    if (!analysis) return;

    const changesToApply = analysis.suggestedChanges.filter((c) => selectedChangeIds.has(c.id));
    if (changesToApply.length === 0) {
      alert('Vyberte prosím alespoň jednu změnu k aplikování.');
      return;
    }

    // Apply each change safely
    for (const change of changesToApply) {
      // Find card & current column
      let currentColId = '';
      for (const col of columns) {
        if (col.cards.some((card) => card.id === change.targetCardId)) {
          currentColId = col.id;
          break;
        }
      }

      if (change.actionType === 'MOVE_TASK' && change.targetColumnId && currentColId) {
        onMoveCard(change.targetCardId, currentColId, change.targetColumnId);
      } else if (change.actionType === 'CHANGE_PRIORITY' && change.newPriority && currentColId) {
        onUpdateCard(currentColId, change.targetCardId, { priority: change.newPriority });
      } else if (change.actionType === 'ARCHIVE_TASK' && currentColId) {
        onUpdateCard(currentColId, change.targetCardId, { archived: true });
      } else if (change.actionType === 'SPLIT_TASK' && change.subtasksToCreate && currentColId) {
        const destCol = change.targetColumnId || currentColId;
        for (const subTitle of change.subtasksToCreate) {
          onAddCard(destCol, {
            title: subTitle,
            details: `Vytvořeno rozdělením úkolu "${change.targetCardTitle}" AI Project Managerem.`,
          });
        }
      }

      await collaborationService.logActivity({
        projectId,
        actorName: 'AI Project Manager',
        actionType: change.actionType.toLowerCase(),
        entityType: 'task',
        details: { change },
      });
    }

    alert(`Úspěšně aplikováno ${changesToApply.length} změn na nástěnku!`);
    onClose();
  };

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
      data-testid="ai-pm-modal"
    >
      <div
        style={{
          backgroundColor: 'var(--bg-page)',
          borderRadius: '14px',
          maxWidth: '850px',
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
            <Sparkles size={20} style={{ color: 'var(--purple-secondary)' }} />
            <div>
              <h2 style={{ fontSize: '1.1rem', fontWeight: 800, color: 'var(--dark-navy)', margin: 0 }}>
                AI Project Manager
              </h2>
              <p style={{ fontSize: '0.75rem', color: 'var(--gray-text)', margin: 0 }}>
                Inteligentní analýza a návrhy na optimalizaci nástěnky projektu
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

        {/* Body content */}
        <div style={{ padding: '1.5rem', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          {isLoading ? (
            <div style={{ textAlign: 'center', padding: '3rem 1rem' }}>
              <div className="ai-spinner" style={{ margin: '0 auto 1rem' }} />
              <p style={{ fontWeight: 700, color: 'var(--purple-secondary)', fontSize: '0.9rem' }}>
                ✨ AI Project Manager analyzuje stav nástěnky, priority a rizika...
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
                onClick={runAnalysis}
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
                <RefreshCw size={14} /> Zkusit znovu
              </button>
            </div>
          ) : analysis ? (
            <>
              {/* Project Health Overview */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                  gap: '1rem',
                  padding: '1rem',
                  backgroundColor: 'var(--surface-1)',
                  borderRadius: '10px',
                  border: '1px solid var(--border-color)',
                }}
              >
                <div>
                  <span style={{ fontSize: '0.7rem', color: 'var(--gray-text)', textTransform: 'uppercase', fontWeight: 700 }}>
                    Zdraví Projektu
                  </span>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem', marginTop: '0.2rem' }}>
                    <span style={{ fontSize: '1.6rem', fontWeight: 900, color: analysis.healthScore >= 70 ? '#107c41' : '#ecad0a' }}>
                      {analysis.healthScore} / 100
                    </span>
                  </div>
                </div>

                <div>
                  <span style={{ fontSize: '0.7rem', color: 'var(--gray-text)', textTransform: 'uppercase', fontWeight: 700 }}>
                    Jistota Analýzy (Confidence)
                  </span>
                  <div style={{ fontSize: '1.6rem', fontWeight: 900, color: 'var(--blue-primary)', marginTop: '0.2rem' }}>
                    {analysis.confidenceScore}%
                  </div>
                </div>

                <div style={{ gridColumn: 'span 2' }}>
                  <span style={{ fontSize: '0.7rem', color: 'var(--gray-text)', textTransform: 'uppercase', fontWeight: 700 }}>
                    Shrnutí stavu
                  </span>
                  <p style={{ fontSize: '0.8rem', color: 'var(--dark-navy)', margin: '0.2rem 0 0', lineHeight: '1.4' }}>
                    {analysis.summary}
                  </p>
                </div>
              </div>

              {/* Risks and Blockers */}
              {(analysis.risks.length > 0 || analysis.blockers.length > 0) && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  <h4 style={{ fontSize: '0.85rem', fontWeight: 800, color: 'var(--dark-navy)', margin: 0, display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                    <ShieldAlert size={15} style={{ color: '#ecad0a' }} /> Identifikovaná rizika a blokátory
                  </h4>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                    {analysis.risks.map((risk, idx) => (
                      <span key={idx} style={{ fontSize: '0.75rem', padding: '0.25rem 0.6rem', backgroundColor: 'rgba(236, 173, 10, 0.1)', color: '#ecad0a', borderRadius: '4px', fontWeight: 600 }}>
                        ⚠️ {risk}
                      </span>
                    ))}
                    {analysis.blockers.map((blocker, idx) => (
                      <span key={idx} style={{ fontSize: '0.75rem', padding: '0.25rem 0.6rem', backgroundColor: 'var(--danger-soft)', color: 'var(--danger)', borderRadius: '4px', fontWeight: 600 }}>
                        🛑 {blocker}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Review Mode: Suggested Changes diff */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <h4 style={{ fontSize: '0.85rem', fontWeight: 800, color: 'var(--dark-navy)', margin: 0, display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                    <FileDiff size={16} style={{ color: 'var(--purple-secondary)' }} /> Review Mode: Navrhované změny ({analysis.suggestedChanges.length})
                  </h4>
                  <button
                    type="button"
                    onClick={toggleSelectAll}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: 'var(--purple-secondary)',
                      fontSize: '0.75rem',
                      fontWeight: 700,
                      cursor: 'pointer',
                    }}
                  >
                    {selectedChangeIds.size === analysis.suggestedChanges.length ? 'Odznačit vše' : 'Označit vše'}
                  </button>
                </div>

                {analysis.suggestedChanges.length === 0 ? (
                  <p style={{ fontSize: '0.8rem', color: 'var(--gray-text)', fontStyle: 'italic' }}>
                    Žádné návrhy na úpravu. Nástěnka je v optimálním stavu!
                  </p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }} data-testid="suggested-changes-list">
                    {analysis.suggestedChanges.map((change) => {
                      const isSelected = selectedChangeIds.has(change.id);
                      return (
                        <div
                          key={change.id}
                          style={{
                            display: 'flex',
                            alignItems: 'flex-start',
                            gap: '0.75rem',
                            padding: '0.85rem 1rem',
                            backgroundColor: isSelected ? 'rgba(117, 57, 145, 0.04)' : 'var(--surface-1)',
                            border: `1px solid ${isSelected ? 'var(--purple-secondary)' : 'var(--border-color)'}`,
                            borderRadius: '8px',
                            transition: 'all 0.15s ease',
                          }}
                          onClick={() => toggleSelectChange(change.id)}
                        >
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => {}}
                            style={{ marginTop: '0.2rem', cursor: 'pointer' }}
                          />

                          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                              <span
                                style={{
                                  fontSize: '0.7rem',
                                  fontWeight: 800,
                                  padding: '0.15rem 0.45rem',
                                  borderRadius: '4px',
                                  backgroundColor:
                                    change.actionType === 'MOVE_TASK'
                                      ? 'rgba(32, 157, 215, 0.15)'
                                      : change.actionType === 'SPLIT_TASK'
                                      ? 'rgba(117, 57, 145, 0.15)'
                                      : 'rgba(236, 173, 10, 0.15)',
                                  color:
                                    change.actionType === 'MOVE_TASK'
                                      ? 'var(--blue-primary)'
                                      : change.actionType === 'SPLIT_TASK'
                                      ? 'var(--purple-secondary)'
                                      : '#ecad0a',
                                }}
                              >
                                {change.actionType}
                              </span>
                              <span style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--dark-navy)' }}>
                                {change.targetCardTitle}
                              </span>
                              {change.targetColumnName && (
                                <span style={{ fontSize: '0.75rem', color: 'var(--gray-text)', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                                  <ArrowRight size={12} /> {change.targetColumnName}
                                </span>
                              )}
                            </div>

                            <p style={{ fontSize: '0.75rem', color: 'var(--gray-text)', margin: 0 }}>
                              {change.reason}
                            </p>

                            {change.subtasksToCreate && change.subtasksToCreate.length > 0 && (
                              <div style={{ marginTop: '0.35rem', paddingLeft: '0.5rem', borderLeft: '2px solid var(--purple-secondary)' }}>
                                <span style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--purple-secondary)' }}>
                                  Podúkoly ke vytvoření:
                                </span>
                                <ul style={{ margin: '0.2rem 0 0', paddingLeft: '1rem', fontSize: '0.75rem', color: 'var(--dark-navy)' }}>
                                  {change.subtasksToCreate.map((st, idx) => (
                                    <li key={idx}>{st}</li>
                                  ))}
                                </ul>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          ) : null}
        </div>

        {/* Footer actions */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '1rem 1.5rem',
            borderTop: '1px solid var(--border-color)',
            backgroundColor: 'var(--surface-1)',
          }}
        >
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: '0.5rem 1rem',
              backgroundColor: 'transparent',
              border: '1px solid var(--border-color)',
              borderRadius: '6px',
              fontSize: '0.8rem',
              fontWeight: 600,
              cursor: 'pointer',
              color: 'var(--gray-text)',
            }}
          >
            Zavřít / Zamítnout
          </button>

          <button
            type="button"
            onClick={handleApplySelected}
            disabled={!analysis || selectedChangeIds.size === 0}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.4rem',
              padding: '0.55rem 1.25rem',
              backgroundColor: selectedChangeIds.size > 0 ? 'var(--purple-secondary)' : 'var(--bg-column)',
              color: selectedChangeIds.size > 0 ? '#fff' : 'var(--gray-text)',
              border: 'none',
              borderRadius: '6px',
              fontSize: '0.85rem',
              fontWeight: 700,
              cursor: selectedChangeIds.size > 0 ? 'pointer' : 'not-allowed',
            }}
            data-testid="apply-pm-changes-btn"
          >
            <Check size={16} /> Aplikovat vybrané ({selectedChangeIds.size})
          </button>
        </div>
      </div>
    </div>
  );
}
