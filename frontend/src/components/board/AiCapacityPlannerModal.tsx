'use client';

import React, { useState, useEffect } from 'react';
import { X, Users, Scale, Check, ArrowRight, RefreshCw } from 'lucide-react';
import { Card, Column, TeamMember } from '../../types/kanban';
import { aiClient } from '../../services/ai/aiClient';
import { collaborationService } from '../../services/collaborationService';

export interface WorkloadMember {
  memberId: string;
  memberName: string;
  assignedCardsCount: number;
  estimatedHours: number;
  status: 'OVERLOADED' | 'BALANCED' | 'AVAILABLE';
}

export interface RebalanceSuggestion {
  cardId: string;
  cardTitle: string;
  fromMemberName: string;
  toMemberName: string;
  reason: string;
}

export interface CapacityPlanningData {
  totalCapacityHours: number;
  allocatedHours: number;
  workloadByMember: WorkloadMember[];
  rebalanceSuggestions: RebalanceSuggestion[];
}

interface AiCapacityPlannerModalProps {
  isOpen: boolean;
  onClose: () => void;
  columns: Column[];
  members: TeamMember[];
  projectId: string;
  projectName: string;
  onUpdateCard: (columnId: string, cardId: string, updates: Partial<Card>) => void;
}

export default function AiCapacityPlannerModal({
  isOpen,
  onClose,
  columns,
  members,
  projectId,
  projectName,
  onUpdateCard,
}: AiCapacityPlannerModalProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<CapacityPlanningData | null>(null);
  const [selectedSuggestionIds, setSelectedSuggestionIds] = useState<Set<string>>(new Set());

  const runCapacityAnalysis = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await aiClient.fetchAi('/api/ai/capacity-planning', 'AI Capacity Planning', {
        columns,
        members,
        context: { projectName },
      });

      if (response && response.parsed) {
        const parsed = response.parsed as CapacityPlanningData;
        setData(parsed);
        setSelectedSuggestionIds(new Set((parsed.rebalanceSuggestions || []).map((s) => s.cardId)));
      } else {
        throw new Error('Nepodařilo se získat strukturovaná kapacitní data z AI.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Chyba při kapacitním plánování.');
    } finally {
      setIsLoading(false);
    }
  };

  // Analýza se spustí jednou při otevření. Závislost je záměrně jen `isOpen`:
  // doplnění `data`/`isLoading`/callbacku by efekt spouštělo dokola,
  // protože je sám mění. Stráž uvnitř hlídá, že se nespustí dvakrát.
  useEffect(() => {
    if (isOpen && !data && !isLoading) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      runCapacityAnalysis();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  if (!isOpen) return null;

  const toggleSelectSuggestion = (cardId: string) => {
    setSelectedSuggestionIds((prev) => {
      const next = new Set(prev);
      if (next.has(cardId)) next.delete(cardId);
      else next.add(cardId);
      return next;
    });
  };

  const handleApplyRebalance = async () => {
    if (!data) return;

    const toApply = data.rebalanceSuggestions.filter((s) => selectedSuggestionIds.has(s.cardId));
    if (toApply.length === 0) {
      alert('Vyberte prosím alespoň jedno přerozdělení.');
      return;
    }

    for (const sug of toApply) {
      // Find target member object
      const targetMember = members.find((m) => m.fullName.toLowerCase() === sug.toMemberName.toLowerCase());

      let currentColId = '';
      for (const col of columns) {
        if (col.cards.some((c) => c.id === sug.cardId)) {
          currentColId = col.id;
          break;
        }
      }

      if (currentColId) {
        const updatedAssignees = targetMember
          ? [targetMember]
          : [{ id: 'm-new', fullName: sug.toMemberName, initials: sug.toMemberName.substring(0, 2).toUpperCase(), avatarColor: '#209dd7', createdAt: new Date().toISOString() }];

        onUpdateCard(currentColId, sug.cardId, {
          assignees: updatedAssignees,
          assignee: { name: sug.toMemberName, initials: sug.toMemberName.substring(0, 2).toUpperCase(), color: '#209dd7' },
        });

        await collaborationService.logActivity({
          projectId,
          actorName: 'AI Capacity Planner',
          actionType: 'reassign_task',
          entityType: 'task',
          details: { sug },
        });
      }
    }

    alert(`Úspěšně přerozděleno ${toApply.length} karet pro vyvážení kapacit!`);
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
      data-testid="ai-capacity-planner-modal"
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
            <Scale size={20} style={{ color: 'var(--purple-secondary)' }} />
            <div>
              <h2 style={{ fontSize: '1.1rem', fontWeight: 800, color: 'var(--dark-navy)', margin: 0 }}>
                Kapacitní plánování & Vyvážení týmu
              </h2>
              <p style={{ fontSize: '0.75rem', color: 'var(--gray-text)', margin: 0 }}>
                Analýza vytížení členů a inteligentní přerozdělení karet
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
                ✨ AI počítá kapacity a analyzuje vytížení členů týmu...
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
                onClick={runCapacityAnalysis}
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
          ) : data ? (
            <>
              {/* Member Workload Overview */}
              <div>
                <h4 style={{ fontSize: '0.85rem', fontWeight: 800, color: 'var(--dark-navy)', margin: '0 0 0.6rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  <Users size={16} /> Vytížení jednotlivých členů
                </h4>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0.75rem' }}>
                  {data.workloadByMember.map((m) => (
                    <div
                      key={m.memberId}
                      style={{
                        padding: '0.85rem 1rem',
                        backgroundColor: 'var(--surface-1)',
                        border: '1px solid var(--border-color)',
                        borderRadius: '8px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '0.35rem',
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontWeight: 700, fontSize: '0.85rem', color: 'var(--dark-navy)' }}>
                          {m.memberName}
                        </span>
                        <span
                          style={{
                            fontSize: '0.65rem',
                            fontWeight: 800,
                            padding: '0.15rem 0.45rem',
                            borderRadius: '4px',
                            backgroundColor:
                              m.status === 'OVERLOADED'
                                ? 'var(--danger-soft)'
                                : m.status === 'AVAILABLE'
                                ? 'rgba(32, 157, 215, 0.15)'
                                : 'rgba(16, 124, 65, 0.15)',
                            color:
                              m.status === 'OVERLOADED'
                                ? 'var(--danger)'
                                : m.status === 'AVAILABLE'
                                ? 'var(--blue-primary)'
                                : '#107c41',
                          }}
                        >
                          {m.status}
                        </span>
                      </div>
                      <span style={{ fontSize: '0.75rem', color: 'var(--gray-text)' }}>
                        {m.assignedCardsCount} karet ({m.estimatedHours} hod odhad)
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Rebalance Suggestions */}
              <div>
                <h4 style={{ fontSize: '0.85rem', fontWeight: 800, color: 'var(--dark-navy)', margin: '0 0 0.6rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  <Scale size={16} style={{ color: 'var(--purple-secondary)' }} /> Doporučené přerozdělení kapacit ({data.rebalanceSuggestions.length})
                </h4>

                {data.rebalanceSuggestions.length === 0 ? (
                  <p style={{ fontSize: '0.8rem', color: 'var(--gray-text)', fontStyle: 'italic' }}>
                    Kapacity týmu jsou optimálně vyvážené!
                  </p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    {data.rebalanceSuggestions.map((sug) => {
                      const isSelected = selectedSuggestionIds.has(sug.cardId);
                      return (
                        <div
                          key={sug.cardId}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.75rem',
                            padding: '0.75rem 1rem',
                            backgroundColor: isSelected ? 'rgba(117, 57, 145, 0.04)' : 'var(--surface-1)',
                            border: `1px solid ${isSelected ? 'var(--purple-secondary)' : 'var(--border-color)'}`,
                            borderRadius: '8px',
                            cursor: 'pointer',
                          }}
                          onClick={() => toggleSelectSuggestion(sug.cardId)}
                        >
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => {}}
                            style={{ cursor: 'pointer' }}
                          />
                          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                              <span style={{ fontWeight: 700, fontSize: '0.85rem', color: 'var(--dark-navy)' }}>
                                {sug.cardTitle}
                              </span>
                              <span style={{ fontSize: '0.75rem', color: 'var(--gray-text)', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                                {sug.fromMemberName} <ArrowRight size={12} /> {sug.toMemberName}
                              </span>
                            </div>
                            <span style={{ fontSize: '0.75rem', color: 'var(--gray-text)' }}>{sug.reason}</span>
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

        {/* Footer */}
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
            Zavřít
          </button>

          <button
            type="button"
            onClick={handleApplyRebalance}
            disabled={!data || selectedSuggestionIds.size === 0}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.4rem',
              padding: '0.55rem 1.25rem',
              backgroundColor: selectedSuggestionIds.size > 0 ? 'var(--purple-secondary)' : 'var(--bg-column)',
              color: selectedSuggestionIds.size > 0 ? '#fff' : 'var(--gray-text)',
              border: 'none',
              borderRadius: '6px',
              fontSize: '0.85rem',
              fontWeight: 700,
              cursor: selectedSuggestionIds.size > 0 ? 'pointer' : 'not-allowed',
            }}
            data-testid="apply-capacity-rebalance-btn"
          >
            <Check size={16} /> Aplikovat přerozdělení ({selectedSuggestionIds.size})
          </button>
        </div>
      </div>
    </div>
  );
}
