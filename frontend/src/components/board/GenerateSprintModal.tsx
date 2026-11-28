'use client';

import React, { useState } from 'react';
import { DialogFocus } from '../ui/useDialogFocus';
import { useRouter } from 'next/navigation';
import { X, Sparkles, AlertTriangle, Check, Calendar, Users, Info, ChevronRight } from 'lucide-react';
import type { Card } from '../../types/kanban';
import { aiClient } from '../../services/ai/aiClient';
import { kanbanService } from '../../services/kanbanService';
import { useAuth } from '../../hooks/useAuth';
import { aiHistoryService } from '../../services/ai/aiHistoryService';

interface SelectedTask {
  id: string;
  title: string;
  priority: 'High' | 'Medium' | 'Low';
  storyPoints: number;
  estimatedTime: string;
  reason: string;
}

interface OutOfScopeTask {
  id: string;
  title: string;
  reason: string;
}

interface SprintPlan {
  sprintGoal: string;
  sprintSummary: string;
  recommendedSprintLength: string;
  sprintCapacity: string;
  selectedTasks: SelectedTask[];
  dependencies: string[];
  risks: string[];
  outOfScope: OutOfScopeTask[];
}

interface GenerateSprintModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectName: string;
  existingTasks: Card[];
}

export default function GenerateSprintModal({
  isOpen,
  onClose,
  projectName: _projectName,
  existingTasks,
}: GenerateSprintModalProps) {
  const router = useRouter();
  const { user } = useAuth();

  const [step, setStep] = useState<'config' | 'loading' | 'preview'>('config');
  const [sprintLength, setSprintLength] = useState('2 weeks');
  const [teamCapacity, setTeamCapacity] = useState('20');
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<SprintPlan | null>(null);

  if (!isOpen) return null;

  const handleGeneratePlan = async () => {
    setStep('loading');
    setError(null);

    // Otevřené úkoly (bez archivovaných a hotových) vybírá server z boardu projektu.
    try {
      const data = await aiClient.fetchAi('/api/ai/generate-sprint', 'Sprint Planning', {
        context: {
          metadata: {
            requestedLength: sprintLength,
            requestedCapacity: teamCapacity,
          }
        }
      });

      if (!data.parsed || !data.parsed.sprintGoal) {
        throw new Error('AI vrátila neplatný návrh sprintu.');
      }

      setPlan(data.parsed);
      setStep('preview');
    } catch (err: unknown) {
      const error = err as Error;
      setError(error.message || 'Nepodařilo se naplánovat sprint.');
      setStep('config');
    }
  };

  const handleCreateSprint = async () => {
    if (!plan || !user) return;
    setStep('loading');

    try {
      // 1. Capture snapshot before sprint board creation synchronously
      const snapshot = aiHistoryService.captureSnapshot('', null, null);

      // 2. Create a new Sprint project/board
      const sprintTitle = `Sprint: ${plan.sprintGoal.substring(0, 30)}${plan.sprintGoal.length > 30 ? '...' : ''}`;
      const newProject = await kanbanService.createProject(sprintTitle, user.id);

      // Associate the created project ID with the snapshot for future revert (deletion)
      snapshot.projectId = newProject.id;
      snapshot.projectName = newProject.name;

      // 3. Fetch the newly seeded columns for the sprint project
      const sprintColumns = await kanbanService.fetchBoardData(newProject.id);
      
      // Default to target the first column (e.g. Backlog or Todo)
      const targetColumn = sprintColumns[0] || { id: `${newProject.id}-column-0` };

      // 4. Copy selected cards to the sprint board
      let totalTasksCopied = 0;
      for (let i = 0; i < plan.selectedTasks.length; i++) {
        const selectedTask = plan.selectedTasks[i];
        
        // Find original card details
        const originalCard = existingTasks.find(c => c.id === selectedTask.id);
        if (originalCard) {
          // Prepend Story Points to title and append reason/estimate to details
          const title = `[${selectedTask.storyPoints} Story Pointy] ${originalCard.title}`;
          const details = `${originalCard.details || ''}\n\n---\n**AI odhad sprintu:** ${selectedTask.estimatedTime} (${selectedTask.storyPoints} Story Pointy)\n**Důvod výběru:** ${selectedTask.reason}`;

          const newCard: Card = {
            id: `card-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
            title,
            details,
            tag: originalCard.tag,
            priority: selectedTask.priority,
            dueDate: originalCard.dueDate,
            checklist: originalCard.checklist ? originalCard.checklist.map(item => ({
              id: `item-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
              text: item.text,
              completed: item.completed
            })) : [],
            comments: [],
            activities: [{
              id: `act-${Date.now()}`,
              text: 'Vytvořeno automatickým AI plánovačem sprintů',
              createdAt: new Date().toISOString()
            }],
            archived: false,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          };

          await kanbanService.createCard(targetColumn.id, newCard, i, newProject.id);
          totalTasksCopied++;
        }
      }

      // 5. Uložit záznam do historie
      aiHistoryService.saveHistoryRecord(
        'AI Sprint Planner',
        newProject.name,
        `Vytvořen sprint board s cílem "${plan.sprintGoal}" a naimportováno ${totalTasksCopied} úkolů`,
        totalTasksCopied,
        snapshot
      );

      // 6. Redirect to the new Sprint Board
      onClose();
      router.push(`/projects/${newProject.id}`);
    } catch (err: unknown) {
      const error = err as Error;
      setError(error.message || 'Nepodařilo se vytvořit sprint board.');
      setStep('preview');
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: step === 'preview' ? '850px' : '480px',
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          transition: 'max-width 0.3s ease',
          overflow: 'hidden',
        }}
        role="dialog"
        aria-modal="true"
      >
        <DialogFocus />
        {/* Modal Header */}
        <div className="modal-header" style={{ padding: '1rem 1.5rem', borderBottom: '1px solid var(--border-color)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Sparkles size={20} style={{ color: 'var(--accent)' }} />
            <h2 className="modal-title" style={{ margin: 0 }}>AI Sprint Planner</h2>
          </div>
          <button type="button" className="modal-close-btn" onClick={onClose} aria-label="Zavřít">
            <X size={20} />
          </button>
        </div>

        {/* Modal Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '1.5rem' }}>
          {error && (
            <div style={{
              backgroundColor: 'var(--danger-soft)',
              color: 'var(--danger)',
              padding: '0.75rem 1rem',
              borderRadius: '8px',
              fontSize: '0.8rem',
              fontWeight: 600,
              marginBottom: '1rem',
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem'
            }}>
              <AlertTriangle size={16} />
              {error}
            </div>
          )}

          {step === 'config' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
              <p style={{ fontSize: '0.82rem', color: 'var(--gray-text)', lineHeight: '1.4' }}>
                AI Sprint Planner zanalyzuje stávající backlog projektu (celkem {existingTasks.filter(t => !t.archived).length} aktivních úkolů). Navrhne optimální cíl sprintu, určí priority, závislosti a navrhne vybrané úkoly k zařazení do sprintu.
              </p>

              <div className="form-group">
                <label className="form-label">Délka sprintu</label>
                <select
                  className="form-input"
                  value={sprintLength}
                  onChange={(e) => setSprintLength(e.target.value)}
                  style={{ backgroundColor: 'var(--surface)', color: 'var(--dark-navy)' }}
                >
                  <option value="1 week">1 týden</option>
                  <option value="2 weeks">2 týdny (Doporučeno)</option>
                  <option value="3 weeks">3 týdny</option>
                  <option value="4 weeks">4 týdny</option>
                </select>
              </div>

              <div className="form-group">
                <label className="form-label">Kapacita týmu (odhadovaná)</label>
                <select
                  className="form-input"
                  value={teamCapacity}
                  onChange={(e) => setTeamCapacity(e.target.value)}
                  style={{ backgroundColor: 'var(--surface)', color: 'var(--dark-navy)' }}
                >
                  <option value="10">10 Story Pointů (Malý tým)</option>
                  <option value="20">20 Story Pointů (Střední tým)</option>
                  <option value="30">30 Story Pointů (Větší tým)</option>
                  <option value="40">40 Story Pointů (Vysoká rychlost)</option>
                </select>
              </div>

              <div style={{
                backgroundColor: 'var(--accent-soft)',
                border: '1px solid var(--accent-soft)',
                borderRadius: '8px',
                padding: '0.75rem',
                display: 'flex',
                gap: '0.5rem',
                fontSize: '0.75rem',
                color: '#0369a1',
              }}>
                <Info size={16} style={{ flexShrink: 0 }} />
                <span>Navržený sprint se vytvoří jako nový board (projekt) a stávající backlog zůstane beze změny.</span>
              </div>

              <button
                type="button"
                className="btn btn-submit"
                onClick={handleGeneratePlan}
                style={{
                  background: 'var(--accent)',
                  color: '#ffffff',
                  fontWeight: 700,
                  fontSize: '0.85rem',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '0.5rem',
                  padding: '0.6rem',
                  borderRadius: '8px',
                  border: 'none',
                  cursor: 'pointer',
                  marginTop: '0.5rem'
                }}
              >
                <Sparkles size={16} />
                Navrhnout Sprint
              </button>
            </div>
          )}

          {step === 'loading' && (
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '3rem 1rem',
              gap: '1.25rem'
            }}>
              <div style={{
                width: '45px',
                height: '45px',
                border: '4px solid var(--accent-soft)',
                borderTopColor: 'var(--accent)',
                borderRadius: '50%',
                animation: 'spin 1s linear infinite',
              }} />
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--dark-navy)', marginBottom: '0.25rem' }}>
                  AI analyzuje backlog úkolů...
                </div>
                <div style={{ fontSize: '0.72rem', color: 'var(--gray-text)' }}>
                  Sestavuji cíl sprintu, odhady náročnosti a závislosti
                </div>
              </div>

              <style jsx global>{`
                @keyframes spin {
                  0% { transform: rotate(0deg); }
                  100% { transform: rotate(360deg); }
                }
              `}</style>
            </div>
          )}

          {step === 'preview' && plan && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
              
              {/* Sprint Goal Header Card */}
              <div style={{
                backgroundColor: 'var(--accent-soft)',
                border: '1px solid var(--accent-soft)',
                borderRadius: '12px',
                padding: '1.25rem',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.5rem',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.72rem', color: 'var(--accent)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Cíl sprintu
                </div>
                <h3 style={{ fontSize: '1.2rem', fontWeight: 800, color: 'var(--dark-navy)', margin: 0, lineHeight: '1.3' }}>
                  {plan.sprintGoal}
                </h3>
                <p style={{ fontSize: '0.8rem', color: 'var(--gray-text)', margin: 0, lineHeight: '1.4' }}>
                  {plan.sprintSummary}
                </p>
              </div>

              {/* Sprint Params Row */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                <div style={{
                  border: '1px solid var(--border-color)',
                  borderRadius: '10px',
                  padding: '0.75rem 1rem',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.75rem',
                  backgroundColor: 'var(--surface)'
                }}>
                  <Calendar size={18} style={{ color: 'var(--warning)' }} />
                  <div>
                    <div style={{ fontSize: '0.68rem', color: 'var(--gray-text)' }}>Doporučená délka sprintu</div>
                    <div style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--dark-navy)' }}>{plan.recommendedSprintLength}</div>
                  </div>
                </div>

                <div style={{
                  border: '1px solid var(--border-color)',
                  borderRadius: '10px',
                  padding: '0.75rem 1rem',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.75rem',
                  backgroundColor: 'var(--surface)'
                }}>
                  <Users size={18} style={{ color: 'var(--accent)' }} />
                  <div>
                    <div style={{ fontSize: '0.68rem', color: 'var(--gray-text)' }}>Kapacita sprintu</div>
                    <div style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--dark-navy)' }}>{plan.sprintCapacity}</div>
                  </div>
                </div>
              </div>

              {/* Selected Tasks List */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                <h4 style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--dark-navy)', margin: 0 }}>
                  Vybrané úkoly do sprintu ({plan.selectedTasks.length})
                </h4>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  {plan.selectedTasks.map((task, idx) => (
                    <div
                      key={task.id}
                      style={{
                        border: '1px solid var(--border-color)',
                        borderRadius: '8px',
                        padding: '0.75rem 1rem',
                        backgroundColor: 'var(--surface)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '0.4rem',
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 700, color: 'var(--dark-navy)', fontSize: '0.82rem' }}>
                          <span style={{ color: 'var(--gray-text)', fontSize: '0.72rem' }}>#{idx + 1}</span>
                          <span>{task.title}</span>
                        </div>
                        {/* Badges */}
                        <div style={{ display: 'flex', gap: '0.4rem', flexShrink: 0 }}>
                          <span style={{
                            backgroundColor: 'var(--accent-soft)',
                            color: 'var(--accent)',
                            padding: '0.15rem 0.4rem',
                            borderRadius: '4px',
                            fontSize: '0.68rem',
                            fontWeight: 700
                          }}>
                            {task.storyPoints} Story Pointy
                          </span>
                          <span style={{
                            backgroundColor: 'rgba(0, 0, 0, 0.04)',
                            color: 'var(--dark-navy)',
                            padding: '0.15rem 0.4rem',
                            borderRadius: '4px',
                            fontSize: '0.68rem',
                            fontWeight: 700
                          }}>
                            {task.estimatedTime}
                          </span>
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: '0.25rem', fontSize: '0.72rem', color: 'var(--gray-text)', lineHeight: '1.3' }}>
                        <ChevronRight size={14} style={{ color: 'var(--accent)', flexShrink: 0, marginTop: '1px' }} />
                        <span><strong>Zdůvodnění:</strong> {task.reason}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Dependencies & Risks */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  <h4 style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--dark-navy)', margin: 0 }}>
                    Závislosti
                  </h4>
                  <ul style={{ margin: 0, paddingLeft: '1.1rem', fontSize: '0.75rem', color: 'var(--gray-text)', lineHeight: '1.4' }}>
                    {plan.dependencies.map((dep, idx) => <li key={idx}>{dep}</li>)}
                    {plan.dependencies.length === 0 && <li>Žádné kritické závislosti</li>}
                  </ul>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  <h4 style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--dark-navy)', margin: 0 }}>
                    Rizika
                  </h4>
                  <ul style={{ margin: 0, paddingLeft: '1.1rem', fontSize: '0.75rem', color: 'var(--gray-text)', lineHeight: '1.4' }}>
                    {plan.risks.map((risk, idx) => <li key={idx} style={{ color: 'var(--danger)' }}>{risk}</li>)}
                    {plan.risks.length === 0 && <li>Nebylo detekováno žádné zvýšené riziko</li>}
                  </ul>
                </div>
              </div>

              {/* Out of Scope Tasks */}
              {plan.outOfScope && plan.outOfScope.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', borderTop: '1px solid var(--border-color)', paddingTop: '1rem' }}>
                  <h4 style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--gray-text)', margin: 0 }}>
                    Mimo rozsah sprintu
                  </h4>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                    {plan.outOfScope.map((task) => (
                      <div key={task.id} style={{ display: 'flex', flexDirection: 'column', padding: '0.5rem 0.75rem', backgroundColor: 'rgba(0, 0, 0, 0.01)', borderRadius: '6px', fontSize: '0.72rem' }}>
                        <div style={{ fontWeight: 600, color: 'var(--dark-navy)' }}>{task.title}</div>
                        <div style={{ color: 'var(--gray-text)' }}>Důvod: {task.reason}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="modal-footer" style={{ padding: '1rem 1.5rem', borderTop: '1px solid var(--border-color)', display: 'flex', justifyContent: 'flex-end', gap: '0.75rem' }}>
          <button
            type="button"
            className="btn btn-cancel"
            onClick={onClose}
            disabled={step === 'loading'}
          >
            Zrušit
          </button>
          
          {step === 'preview' && (
            <button
              type="button"
              className="btn btn-submit"
              onClick={handleCreateSprint}
              style={{
                background: 'var(--accent)',
                color: '#ffffff',
                fontWeight: 700,
                fontSize: '0.82rem',
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
                border: 'none',
                cursor: 'pointer'
              }}
            >
              <Check size={16} />
              Vytvořit Sprint Board
            </button>
          )}
        </div>

      </div>
    </div>
  );
}
