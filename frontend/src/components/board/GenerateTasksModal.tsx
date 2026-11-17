'use client';

import React, { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import { X, Sparkles, AlertTriangle, Check } from 'lucide-react';
import type { Card, Column } from '../../types/kanban';
import { aiClient } from '../../services/ai/aiClient';
import { aiHistoryService } from '../../services/ai/aiHistoryService';

interface GeneratedTask {
  title: string;
  description: string;
  priority: 'Low' | 'Medium' | 'High' | '';
  estimate: string;
  acceptanceCriteria: string[];
  checklist: string[];
  recommendedColumn: string;
}

interface GenerateTasksResponse {
  projectSummary: string;
  tasks: GeneratedTask[];
}

interface GenerateTasksModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectName: string;
  columns: Column[];
  existingTasks: Card[];
  onImportTasks: (
    tasksToAdd: {
      title: string;
      details: string;
      priority: 'Low' | 'Medium' | 'High' | '';
      checklist: string[];
      columnName: string;
    }[],
    cardIdsToDelete: string[]
  ) => void;
}

export default function GenerateTasksModal({
  isOpen,
  onClose,
  projectName: initialProjectName,
  columns,
  existingTasks,
  onImportTasks,
}: GenerateTasksModalProps) {
  const params = useParams();
  const projectId = params?.projectId as string;

  // Form input states
  const [projectName, setProjectName] = useState(initialProjectName);
  const [projectDescription, setProjectDescription] = useState('');
  const [taskCount, setTaskCount] = useState<number>(5);
  const [detailLevel, setDetailLevel] = useState<string>('Medium');
  const [technologies, setTechnologies] = useState('');

  // AI loading / response states
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [backlog, setBacklog] = useState<GenerateTasksResponse | null>(null);

  // Duplicate resolution state: maps task index -> 'skip' | 'replace' | 'create'
  const [duplicateDecisions, setDuplicateDecisions] = useState<Record<number, 'skip' | 'replace' | 'create'>>({});

  // Escape key listener to close modal
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  if (!isOpen) return null;

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!projectDescription.trim()) {
      setError('Popis projektu je povinný.');
      return;
    }

    setIsLoading(true);
    setError(null);
    setBacklog(null);
    setDuplicateDecisions({});

    try {
      const data = await aiClient.fetchAi('/api/ai/generate-backlog', 'Generate Tasks', {
        projectDescription,
        options: {
          taskCount,
          detailLevel,
          technologies,
        },
      });

      if (!data.parsed || !data.parsed.tasks) {
        throw new Error('AI vrátila neplatnou strukturu backlogu.');
      }

      setBacklog(data.parsed);

      // Inicializace rozhodnutí pro duplicitní úkoly
      const initialDecisions: Record<number, 'skip' | 'replace' | 'create'> = {};
      data.parsed.tasks.forEach((t: GeneratedTask, idx: number) => {
        const hasDuplicate = existingTasks.some(
          (existing) => existing.title.trim().toLowerCase() === t.title.trim().toLowerCase()
        );
        if (hasDuplicate) {
          initialDecisions[idx] = 'skip'; // Výchozí bezpečné chování pro duplicity
        }
      });
      setDuplicateDecisions(initialDecisions);
    } catch (err: unknown) {
      const error = err as Error;
      console.error(error);
      setError(error.message || 'Při generování úkolů došlo k neočekávané chybě.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleAccept = () => {
    if (!backlog) return;

    try {
      const snapshot = aiHistoryService.captureSnapshot(projectId, columns, null);

      const tasksToAdd: {
        title: string;
        details: string;
        priority: 'Low' | 'Medium' | 'High' | '';
        checklist: string[];
        columnName: string;
      }[] = [];

      const cardIdsToDelete: string[] = [];

      backlog.tasks.forEach((t, idx) => {
        const existing = existingTasks.find(
          (e) => e.title.trim().toLowerCase() === t.title.trim().toLowerCase()
        );

        const decision = duplicateDecisions[idx]; // 'skip' | 'replace' | 'create' or undefined (no duplicate)

        if (existing) {
          if (decision === 'skip') {
            return; // Přeskočit import
          }
          if (decision === 'replace') {
            cardIdsToDelete.push(existing.id);
          }
        }

        // Sestavení detailního popisu (popis + odhad + akceptační kritéria)
        let details = t.description || '';
        if (t.estimate) {
          details += `\n\n**Odhadovaný čas:** ${t.estimate}`;
        }
        if (t.acceptanceCriteria && t.acceptanceCriteria.length > 0) {
          details += `\n\n### Kritéria akceptace:\n` + t.acceptanceCriteria.map((c) => `- ${c}`).join('\n');
        }

        tasksToAdd.push({
          title: t.title,
          details,
          priority: t.priority,
          checklist: t.checklist || [],
          columnName: t.recommendedColumn || '',
        });
      });

      onImportTasks(tasksToAdd, cardIdsToDelete);

      const projName = snapshot.projectName || 'Tento projekt';
      aiHistoryService.saveHistoryRecord(
        'AI Generate Tasks',
        projName,
        `Vygenerováno a naimportováno ${tasksToAdd.length} úkolů do backlogu`,
        tasksToAdd.length,
        snapshot
      );
    } catch (e) {
      console.error('Failed to save AI History during Generate Tasks:', e);
    } finally {
      onClose();
    }
  };

  const handleDiscard = () => {
    setBacklog(null);
    setDuplicateDecisions({});
    setError(null);
  };

  return (
    <div className="modal-overlay" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div className="modal-content" style={{ width: '90%', maxWidth: '750px', maxHeight: '85vh', overflowY: 'auto', borderRadius: '12px', border: '1px solid var(--border-color)', boxShadow: '0 8px 32px rgba(3, 33, 71, 0.15)' }} data-testid="generate-modal">
        
        {/* Modal Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.85rem', marginBottom: '1rem' }}>
          <h2 style={{ fontSize: '1.15rem', fontWeight: 800, color: 'var(--dark-navy)', display: 'flex', alignItems: 'center', gap: '0.45rem', margin: 0 }}>
            <Sparkles size={18} style={{ color: 'var(--purple-secondary)' }} />
            AI Generate Tasks
          </h2>
          <button onClick={onClose} style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--gray-text)' }} data-testid="generate-modal-close">
            <X size={18} />
          </button>
        </div>

        {/* Error message */}
        {error && (
          <div style={{ padding: '0.75rem', backgroundColor: 'var(--danger-soft)', border: '1px solid var(--danger-soft)', borderRadius: '6px', marginBottom: '1rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }} data-testid="generate-error">
            <span style={{ fontSize: '0.75rem', color: 'var(--danger)', fontWeight: 600 }}>{error}</span>
            {backlog === null && !isLoading && (
              <button
                type="button"
                onClick={handleGenerate}
                style={{ alignSelf: 'flex-start', border: 'none', background: 'var(--danger)', color: '#ffffff', fontSize: '0.7rem', fontWeight: 600, padding: '0.25rem 0.6rem', borderRadius: '4px', cursor: 'pointer' }}
              >
                Zkusit znovu
              </button>
            )}
          </div>
        )}

        {/* Loading Spinner */}
        {isLoading && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '3rem 1rem' }} data-testid="generate-loading">
            <div className="ai-spinner" style={{ width: '32px', height: '32px', borderWidth: '3px', marginBottom: '1rem' }} />
            <span style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--purple-secondary)' }}>✨ AI právě navrhuje backlog...</span>
          </div>
        )}

        {/* Step 1: Input Setup Form */}
        {!isLoading && !backlog && (
          <form onSubmit={handleGenerate} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }} data-testid="generate-form">
            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 700, color: 'var(--dark-navy)', marginBottom: '0.25rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Název projektu</label>
              <input
                type="text"
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                style={{ width: '100%', padding: '0.55rem', border: '1px solid var(--border-color)', borderRadius: '6px', fontSize: '0.85rem' }}
                placeholder="Název projektu..."
                required
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 700, color: 'var(--dark-navy)', marginBottom: '0.25rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Popis projektu a cíle</label>
              <textarea
                value={projectDescription}
                onChange={(e) => setProjectDescription(e.target.value)}
                style={{ width: '100%', minHeight: '120px', padding: '0.55rem', border: '1px solid var(--border-color)', borderRadius: '6px', fontSize: '0.85rem', resize: 'vertical' }}
                placeholder="Popište stručně, co má projekt dělat, jaké jsou cíle a co je potřeba vytvořit..."
                required
              />
            </div>

            <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: '150px' }}>
                <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 700, color: 'var(--dark-navy)', marginBottom: '0.25rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Počet úkolů</label>
                <select
                  value={taskCount}
                  onChange={(e) => setTaskCount(Number(e.target.value))}
                  style={{ width: '100%', padding: '0.55rem', border: '1px solid var(--border-color)', borderRadius: '6px', fontSize: '0.85rem' }}
                >
                  <option value={3}>3 úkoly (Malý backlog)</option>
                  <option value={5}>5 úkolů (Střední backlog)</option>
                  <option value={8}>8 úkolů (Rozšířený backlog)</option>
                  <option value={10}>10 úkolů (Kompletní backlog)</option>
                </select>
              </div>

              <div style={{ flex: 1, minWidth: '150px' }}>
                <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 700, color: 'var(--dark-navy)', marginBottom: '0.25rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Úroveň detailu</label>
                <select
                  value={detailLevel}
                  onChange={(e) => setDetailLevel(e.target.value)}
                  style={{ width: '100%', padding: '0.55rem', border: '1px solid var(--border-color)', borderRadius: '6px', fontSize: '0.85rem' }}
                >
                  <option value="Low">Stručná zadání</option>
                  <option value="Medium">Standardní detail</option>
                  <option value="High">Velmi detailní s popisy</option>
                </select>
              </div>
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 700, color: 'var(--dark-navy)', marginBottom: '0.25rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Technologie (volitelné)</label>
              <input
                type="text"
                value={technologies}
                onChange={(e) => setTechnologies(e.target.value)}
                style={{ width: '100%', padding: '0.55rem', border: '1px solid var(--border-color)', borderRadius: '6px', fontSize: '0.85rem' }}
                placeholder="např. React, Next.js, Postgres..."
              />
            </div>

            <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end', marginTop: '0.5rem' }}>
              <button
                type="button"
                onClick={onClose}
                className="ai-discard-btn"
                style={{ border: '1px solid var(--border-color)', background: 'var(--surface)', color: 'var(--dark-navy)', fontSize: '0.8rem', fontWeight: 600, padding: '0.45rem 1rem', borderRadius: '6px', cursor: 'pointer' }}
              >
                Zrušit
              </button>
              <button
                type="submit"
                className="ai-improve-btn"
                style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', border: 'none', background: 'var(--purple-secondary)', color: '#ffffff', fontSize: '0.8rem', fontWeight: 700, padding: '0.45rem 1.1rem', borderRadius: '6px', cursor: 'pointer' }}
              >
                <Sparkles size={14} />
                Generovat úkoly
              </button>
            </div>
          </form>
        )}

        {/* Step 2: Backlog Preview panel */}
        {!isLoading && backlog && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }} data-testid="generate-preview">
            
            {/* Project Summary */}
            <div style={{ padding: '0.85rem', backgroundColor: 'var(--accent-soft)', border: '1px solid var(--accent-soft)', borderRadius: '8px' }}>
              <span style={{ fontSize: '0.7rem', fontWeight: 800, textTransform: 'uppercase', color: 'var(--blue-primary)', display: 'block', marginBottom: '0.25rem', letterSpacing: '0.05em' }}>Souhrn projektu</span>
              <p style={{ fontSize: '0.8rem', color: 'var(--dark-navy)', margin: 0, lineHeight: 1.4 }}>{backlog.projectSummary}</p>
              <span style={{ fontSize: '0.7rem', color: 'var(--gray-text)', display: 'block', marginTop: '0.5rem' }}>Celkem navrženo úkolů: <strong>{backlog.tasks.length}</strong></span>
            </div>

            {/* List of Tasks */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
              <span style={{ fontSize: '0.75rem', fontWeight: 800, textTransform: 'uppercase', color: 'var(--dark-navy)', letterSpacing: '0.05em' }}>Navržené úkoly</span>
              
              {backlog.tasks.map((t, idx) => {
                // Duplicate check
                const isDuplicate = existingTasks.some(
                  (existing) => existing.title.trim().toLowerCase() === t.title.trim().toLowerCase()
                );
                
                const decision = duplicateDecisions[idx];

                return (
                  <div
                    key={idx}
                    style={{
                      padding: '1rem',
                      border: isDuplicate ? '1px solid var(--danger-soft)' : '1px solid var(--border-color)',
                      backgroundColor: isDuplicate ? '#fffdfd' : 'var(--surface-2)',
                      borderRadius: '8px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '0.55rem'
                    }}
                    data-testid={`preview-task-item-${idx}`}
                  >
                    {/* Task Title & Estimate */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' }}>
                      <h4 style={{ fontSize: '0.85rem', fontWeight: 800, color: 'var(--dark-navy)', margin: 0 }}>
                        {idx + 1}. {t.title}
                      </h4>
                      <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                        {t.estimate && (
                          <span style={{ fontSize: '0.65rem', background: '#e0f2fe', color: '#0369a1', fontWeight: 700, padding: '0.15rem 0.4rem', borderRadius: '4px' }}>
                            {t.estimate}
                          </span>
                        )}
                        {t.priority && (
                          <span
                            style={{
                              fontSize: '0.65rem',
                              fontWeight: 700,
                              padding: '0.15rem 0.4rem',
                              borderRadius: '4px',
                              backgroundColor:
                                t.priority === 'High'
                                  ? 'var(--danger-soft)'
                                  : t.priority === 'Medium'
                                  ? 'var(--warning-soft)'
                                  : '#f0fdf4',
                              color:
                                t.priority === 'High'
                                  ? '#991b1b'
                                  : t.priority === 'Medium'
                                  ? '#92400e'
                                  : '#166534',
                            }}
                          >
                            {t.priority}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Task Description */}
                    <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: 0, lineHeight: 1.35 }}>{t.description}</p>

                    {/* Recommended Column */}
                    {t.recommendedColumn && (
                      <span style={{ fontSize: '0.7rem', color: 'var(--gray-text)' }}>
                        Doporučený sloupec: <strong style={{ color: 'var(--dark-navy)' }}>{t.recommendedColumn}</strong>
                      </span>
                    )}

                    {/* Acceptance Criteria */}
                    {t.acceptanceCriteria && t.acceptanceCriteria.length > 0 && (
                      <div style={{ marginTop: '0.2rem' }}>
                        <span style={{ fontSize: '0.65rem', fontWeight: 700, textTransform: 'uppercase', color: 'var(--gray-text)', display: 'block', marginBottom: '0.15rem' }}>Akceptační kritéria</span>
                        <ul style={{ margin: 0, paddingLeft: '1.1rem', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                          {t.acceptanceCriteria.map((c, cIdx) => (
                            <li key={cIdx}>{c}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* Checklist items */}
                    {t.checklist && t.checklist.length > 0 && (
                      <div style={{ marginTop: '0.2rem' }}>
                        <span style={{ fontSize: '0.65rem', fontWeight: 700, textTransform: 'uppercase', color: 'var(--gray-text)', display: 'block', marginBottom: '0.15rem' }}>Navržený checklist</span>
                        <ul style={{ margin: 0, paddingLeft: '1.1rem', fontSize: '0.75rem', color: 'var(--text-secondary)', listStyleType: 'square' }}>
                          {t.checklist.map((c, cIdx) => (
                            <li key={cIdx}>{c}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* Duplicate Warning & Resolution Option */}
                    {isDuplicate && (
                      <div style={{ marginTop: '0.5rem', padding: '0.65rem', backgroundColor: 'var(--warning-soft)', border: '1px dashed #fef3c7', borderRadius: '6px', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', color: 'var(--warning)', fontSize: '0.7rem', fontWeight: 700 }}>
                          <AlertTriangle size={14} />
                          ⚠️ Úkol s tímto názvem již na boardu existuje.
                        </div>
                        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginTop: '0.1rem' }}>
                          <label style={{ fontSize: '0.7rem', display: 'flex', alignItems: 'center', gap: '0.25rem', cursor: 'pointer', color: 'var(--text-secondary)' }}>
                            <input
                              type="radio"
                              name={`dup-decision-${idx}`}
                              checked={decision === 'skip'}
                              onChange={() => setDuplicateDecisions(prev => ({ ...prev, [idx]: 'skip' }))}
                              data-testid={`dup-skip-${idx}`}
                            />
                            Skip (Přeskočit)
                          </label>
                          <label style={{ fontSize: '0.7rem', display: 'flex', alignItems: 'center', gap: '0.25rem', cursor: 'pointer', color: 'var(--text-secondary)' }}>
                            <input
                              type="radio"
                              name={`dup-decision-${idx}`}
                              checked={decision === 'replace'}
                              onChange={() => setDuplicateDecisions(prev => ({ ...prev, [idx]: 'replace' }))}
                              data-testid={`dup-replace-${idx}`}
                            />
                            Replace (Nahradit)
                          </label>
                          <label style={{ fontSize: '0.7rem', display: 'flex', alignItems: 'center', gap: '0.25rem', cursor: 'pointer', color: 'var(--text-secondary)' }}>
                            <input
                              type="radio"
                              name={`dup-decision-${idx}`}
                              checked={decision === 'create'}
                              onChange={() => setDuplicateDecisions(prev => ({ ...prev, [idx]: 'create' }))}
                              data-testid={`dup-create-${idx}`}
                            />
                            Create Anyway (Vytvořit i tak)
                          </label>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Backlog Preview Actions */}
            <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end', borderTop: '1px solid var(--border-color)', paddingTop: '0.85rem', marginTop: '0.5rem' }}>
              <button
                type="button"
                onClick={handleDiscard}
                className="ai-discard-btn"
                style={{ border: '1px solid var(--border-color)', background: 'var(--surface)', color: 'var(--dark-navy)', fontSize: '0.8rem', fontWeight: 600, padding: '0.45rem 1.1rem', borderRadius: '6px', cursor: 'pointer' }}
                data-testid="generate-discard-btn"
              >
                Zahodit
              </button>
              <button
                type="button"
                onClick={handleAccept}
                className="ai-improve-btn"
                style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', border: 'none', background: 'var(--purple-secondary)', color: '#ffffff', fontSize: '0.8rem', fontWeight: 700, padding: '0.45rem 1.25rem', borderRadius: '6px', cursor: 'pointer' }}
                data-testid="generate-accept-btn"
              >
                <Check size={14} />
                Importovat backlog
              </button>
            </div>

          </div>
        )}

      </div>
    </div>
  );
}
