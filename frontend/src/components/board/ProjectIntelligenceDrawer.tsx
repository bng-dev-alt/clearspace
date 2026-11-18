'use client';

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  X,
  Sparkles,
  ShieldAlert,
  CalendarRange,
  ArrowRight,
  AlertOctagon,
  AlertTriangle,
  Circle,
  Send,
  AlignLeft,
  AlignRight,
  Maximize2,
} from 'lucide-react';
import type { Column } from '../../types/kanban';
import {
  computeProjectIntelligence,
  type IntelligenceActionId,
  type InsightSeverity,
} from '../../lib/projectIntelligence';
import { aiClient } from '../../services/ai/aiClient';
import AiModelSelector from '../ai/AiModelSelector';
import ProjectBriefPanel from '../intelligence/ProjectBriefPanel';
import KnowledgePanel from '../intelligence/KnowledgePanel';

interface ChatCitation {
  n: number;
  ref: string;
  label: string;
  cardId: string | null;
  meetingId: string | null;
}

interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
  /** Ověřené zdroje odpovědi: [n] v textu odkazuje na položku seznamu (server zahazuje neexistující). */
  citations?: ChatCitation[];
}

type PiMode = 'right' | 'left' | 'focused';

interface ProjectIntelligenceDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  columns: Column[];
  projectName: string;
  onGenerateTasks: () => void;
  onSprintPlanning: () => void;
  onRiskAnalysis: () => void;
  onOpenProjectManager?: () => void;
  onOpenDailyBrief?: () => void;
  onOpenCapacityPlanner?: () => void;
  onOpenVoiceCopilot?: () => void;
  /** Projekt (pro Brief a Znalosti z porad); bez něj drawer funguje jako dřív. */
  projectId?: string;
  /** Otevře kartu (zdroj tvrzení). */
  onOpenCard?: (cardId: string) => void;
}

const SEVERITY_ICON: Record<InsightSeverity, React.ComponentType<{ size?: number }>> = {
  danger: AlertOctagon,
  warning: AlertTriangle,
  neutral: Circle,
};

const ACTION_META: Record<
  IntelligenceActionId,
  { label: string; note: string; Icon: React.ComponentType<{ size?: number }> }
> = {
  blockers: { label: 'Projít blokátory', note: 'reaguje na: blokované úkoly', Icon: ShieldAlert },
  sprint: { label: 'Naplánovat sprint', note: 'rozvrhnout práci do iterace', Icon: CalendarRange },
  generate: { label: 'Vygenerovat úkoly', note: 'doplnit backlog z cíle', Icon: Sparkles },
};

export default function ProjectIntelligenceDrawer({
  isOpen,
  onClose,
  columns,
  projectName,
  onGenerateTasks,
  onSprintPlanning,
  onRiskAnalysis,
  onOpenProjectManager,
  onOpenDailyBrief,
  onOpenCapacityPlanner,
  onOpenVoiceCopilot,
  projectId,
  onOpenCard,
}: ProjectIntelligenceDrawerProps) {
  const [tab, setTab] = useState<'overview' | 'brief' | 'knowledge'>('overview');
  const drawerRef = useRef<HTMLDivElement>(null);

  // Pozice panelu (Left / Focused / Right) -- stejný systém i animace jako TaskDetailDrawer.
  // Vlastní preference, aby byla nezávislá na task detailu. Lazy init = správná pozice hned
  // při prvním renderu (žádný skok).
  const [mode, setMode] = useState<PiMode>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('project_intelligence_mode') as PiMode;
      if (saved && ['right', 'left', 'focused'].includes(saved)) return saved;
    }
    return 'right';
  });
  const handleModeChange = (newMode: PiMode) => {
    setMode(newMode);
    if (typeof window !== 'undefined') {
      localStorage.setItem('project_intelligence_mode', newMode);
    }
  };

  // Plynulé zavření: přehraj exit animaci, pak teprve odmountuj (stejně jako TaskDetailDrawer).
  const [isClosing, setIsClosing] = useState(false);
  const requestClose = useCallback(() => {
    setIsClosing(true);
    window.setTimeout(onClose, 230);
  }, [onClose]);

  // Deterministický "mozek" -- vše se počítá jen z dat boardu.
  const intel = useMemo(() => computeProjectIntelligence(columns), [columns]);

  // "Zeptej se AI" -- reálný chat s kontextem projektu (endpoint /api/ai/chat).
  const [chatMessages, setChatMessages] = useState<ChatMsg[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const chatLogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Po přírůstku zprávy sroluj konverzaci dolů.
    if (chatLogRef.current) {
      chatLogRef.current.scrollTop = chatLogRef.current.scrollHeight;
    }
  }, [chatMessages, chatLoading]);

  const sendChat = async (e?: React.SyntheticEvent) => {
    e?.preventDefault();
    const question = chatInput.trim();
    if (!question || chatLoading) return;

    const nextMessages: ChatMsg[] = [...chatMessages, { role: 'user', content: question }];
    setChatMessages(nextMessages);
    setChatInput('');
    setChatLoading(true);
    setChatError(null);

    try {
      const data = await aiClient.fetchAi('/api/ai/chat', 'Project Intelligence Chat', {
        messages: nextMessages,
      });
      const answer =
        data && typeof data.content === 'string' && data.content.trim()
          ? data.content.trim()
          : 'Nepodařilo se získat odpověď.';
      const citations: ChatCitation[] = Array.isArray(data?.citations) ? data.citations : [];
      setChatMessages((prev) => [...prev, { role: 'assistant', content: answer, citations }]);
    } catch (err) {
      setChatError((err as Error).message || 'Při volání AI došlo k chybě.');
    } finally {
      setChatLoading(false);
    }
  };

  // Karta jako zdroj tvrzení: panel se plynule zavře a otevře se detail karty.
  const openCardFromSource = useCallback(
    (cardId: string) => {
      if (!onOpenCard) return;
      setIsClosing(true);
      window.setTimeout(() => {
        onClose();
        onOpenCard(cardId);
      }, 230);
    },
    [onClose, onOpenCard]
  );

  // [n] v odpovědi chatu -> tlačítko se zdrojem (karta se otevře, porada vede na detail).
  const renderAnswer = (m: ChatMsg): React.ReactNode => {
    if (!m.citations || m.citations.length === 0) return m.content;
    return m.content.split(/(\[\d+\])/g).map((part, i) => {
      const hit = /^\[(\d+)\]$/.exec(part);
      const c = hit ? m.citations!.find((x) => x.n === Number(hit[1])) : undefined;
      if (!c) return <React.Fragment key={i}>{part}</React.Fragment>;
      return (
        <button
          key={i}
          type="button"
          className="cs-badge"
          title={c.label}
          data-testid="pi-chat-citation"
          onClick={() => {
            if (c.cardId) openCardFromSource(c.cardId);
            else if (c.meetingId && projectId) window.location.assign(`/projects/${projectId}/meetings/${c.meetingId}`);
          }}
        >
          {c.n}
        </button>
      );
    });
  };

  // Akce nejdřív plynule zavře panel, teprve pak otevře příslušný modal (aby se overlaye nepřekrývaly).
  const runAction = useCallback(
    (id: IntelligenceActionId) => {
      const handler =
        id === 'blockers' ? onRiskAnalysis : id === 'sprint' ? onSprintPlanning : onGenerateTasks;
      setIsClosing(true);
      window.setTimeout(() => {
        onClose();
        handler();
      }, 230);
    },
    [onClose, onRiskAnalysis, onSprintPlanning, onGenerateTasks]
  );

  // Klik na overlay nebo Escape -> plynulé zavření.
  useEffect(() => {
    function handleOutsideClick(event: MouseEvent) {
      if (isOpen && drawerRef.current && !drawerRef.current.contains(event.target as Node)) {
        const overlay = document.querySelector('.pi-drawer-overlay');
        if (overlay && event.target === overlay) requestClose();
      }
    }
    function handleEsc(event: KeyboardEvent) {
      if (isOpen && event.key === 'Escape') requestClose();
    }
    document.addEventListener('mousedown', handleOutsideClick);
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [isOpen, requestClose]);

  if (!isOpen) return null;

  const { health, insights, actions } = intel;

  return (
    <>
      <div
        className={`drawer-overlay pi-drawer-overlay ${mode === 'focused' ? 'mode-focused' : ''} ${isClosing ? 'closing' : ''}`}
        data-testid="pi-drawer-overlay"
      />

      <div
        className={`drawer-content mode-${mode} ${isClosing ? 'closing' : ''}`}
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label="Project Intelligence"
        data-testid="project-intelligence-drawer"
      >
        {/* Header s pozicovacím barem (Left / Focused / Right) */}
        <div className="drawer-header" style={{ justifyContent: 'space-between', gap: '0.75rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <span className="pi-brand">
              <Sparkles size={16} /> Project Intelligence
            </span>
            <AiModelSelector compact />
          </div>

          <div className="pi-mode-switch" data-testid="pi-mode-switcher">
            <button
              type="button"
              className={`pi-mode-btn ${mode === 'left' ? 'active' : ''}`}
              onClick={() => handleModeChange('left')}
              data-testid="pi-mode-btn-left"
            >
              <AlignLeft size={13} /> Left
            </button>
            <button
              type="button"
              className={`pi-mode-btn ${mode === 'focused' ? 'active' : ''}`}
              onClick={() => handleModeChange('focused')}
              data-testid="pi-mode-btn-focused"
            >
              <Maximize2 size={13} /> Focused
            </button>
            <button
              type="button"
              className={`pi-mode-btn ${mode === 'right' ? 'active' : ''}`}
              onClick={() => handleModeChange('right')}
              data-testid="pi-mode-btn-right"
            >
              <AlignRight size={13} /> Right
            </button>
            <button
              type="button"
              className="pi-mode-btn"
              disabled
              title="Fullscreen (připravuje se)"
              data-testid="pi-mode-btn-fullscreen"
            >
              Fullscreen
            </button>
          </div>

          <button
            type="button"
            onClick={requestClose}
            className="pi-icon-btn"
            aria-label="Zavřít panel"
            data-testid="pi-close-btn"
          >
            <X size={18} />
          </button>
        </div>

        <div className="drawer-scroll-area pi-scroll">
          {/* Sub -- klidná deklarace, žádná persona */}
          <p className="pi-sub">Přehled projektu „{projectName}“ · aktualizováno teď</p>

          {projectId && (
            <div role="tablist" aria-label="Sekce Project Intelligence" className="pi-mode-switch" data-testid="pi-tabs" style={{ marginBottom: '0.75rem' }}>
              {([['overview', 'Přehled'], ['brief', 'Brief'], ['knowledge', 'Znalosti']] as const).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={tab === id}
                  className={`pi-mode-btn ${tab === id ? 'active' : ''}`}
                  onClick={() => setTab(id)}
                  data-testid={`pi-tab-${id}`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}

          {projectId && tab === 'brief' && (
            <ProjectBriefPanel projectId={projectId} columns={columns} onOpenCard={onOpenCard ? openCardFromSource : undefined} />
          )}
          {projectId && tab === 'knowledge' && (
            <KnowledgePanel projectId={projectId} onOpenCard={onOpenCard ? openCardFromSource : undefined} />
          )}

          {(!projectId || tab === 'overview') && (<>
          {/* PULSE / zdraví */}
          <section className={`pi-pulse pi-level-${health.level}`} data-testid="pi-health">
            <div className="pi-pulse-line">
              <span className="pi-dot" aria-hidden="true" />
              <span className="pi-pulse-word">{health.label}</span>
              <span className="pi-score" data-testid="pi-health-score">
                {health.score} / 100
              </span>
            </div>
            <p className="pi-pulse-reason">{health.reason}</p>
            {health.breakdown.length > 0 && (
              <div className="pi-breakdown">
                {health.breakdown.map((b) => (
                  <div className="pi-bd-row" key={b.label}>
                    <span>{b.label}</span>
                    <span className="pi-bd-delta">{b.delta}</span>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* AI Project Manager v2 Launchers */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.85rem' }}>
            {onOpenProjectManager && (
              <button
                type="button"
                onClick={() => {
                  requestClose();
                  window.setTimeout(onOpenProjectManager, 230);
                }}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '0.5rem',
                  padding: '0.7rem 1rem',
                  backgroundColor: 'var(--purple-secondary)',
                  color: '#ffffff',
                  border: 'none',
                  borderRadius: '8px',
                  fontSize: '0.85rem',
                  fontWeight: 700,
                  cursor: 'pointer',
                  boxShadow: 'var(--shadow-md)',
                  transition: 'var(--spring-transition)',
                }}
                data-testid="open-ai-pm-btn"
              >
                <Sparkles size={16} />
                Spustit AI Project Manager (Optimalizace nástěnky)
              </button>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
              {onOpenDailyBrief && (
                <button
                  type="button"
                  onClick={() => {
                    requestClose();
                    window.setTimeout(onOpenDailyBrief, 230);
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '0.4rem',
                    padding: '0.55rem 0.75rem',
                    backgroundColor: 'var(--bg-column)',
                    color: 'var(--dark-navy)',
                    border: '1px solid var(--border-color)',
                    borderRadius: '6px',
                    fontSize: '0.78rem',
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                  data-testid="open-ai-daily-brief-btn"
                >
                  ☀️ Daily Brief
                </button>
              )}

              {onOpenCapacityPlanner && (
                <button
                  type="button"
                  onClick={() => {
                    requestClose();
                    window.setTimeout(onOpenCapacityPlanner, 230);
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '0.4rem',
                    padding: '0.55rem 0.75rem',
                    backgroundColor: 'var(--bg-column)',
                    color: 'var(--dark-navy)',
                    border: '1px solid var(--border-color)',
                    borderRadius: '6px',
                    fontSize: '0.78rem',
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                  data-testid="open-ai-capacity-planner-btn"
                >
                  ⚖️ Kapacity týmu
                </button>
              )}
            </div>

            {onOpenVoiceCopilot && (
              <button
                type="button"
                onClick={() => {
                  requestClose();
                  window.setTimeout(onOpenVoiceCopilot, 230);
                }}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '0.4rem',
                  padding: '0.55rem 0.75rem',
                  backgroundColor: 'rgba(117, 57, 145, 0.08)',
                  color: 'var(--purple-secondary)',
                  border: '1px solid var(--purple-secondary)',
                  borderRadius: '6px',
                  fontSize: '0.78rem',
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
                data-testid="open-ai-voice-copilot-btn"
              >
                🎙️ AI Voice Copilot (Hlasové příkazy cs-CZ)
              </button>
            )}
          </div>

          {/* INSIGHTS */}
          <section>
            <div className="pi-sec-label">
              Insights
              <span className="pi-tag">vypočteno z boardu</span>
            </div>
            {insights.length === 0 ? (
              <p className="pi-empty">Žádné otevřené signály — projekt je v klidu.</p>
            ) : (
              <ul className="pi-insight-list" data-testid="pi-insights">
                {insights.map((ins) => {
                  const Icon = SEVERITY_ICON[ins.severity];
                  return (
                    <li className={`pi-insight pi-sev-${ins.severity}`} key={ins.id}>
                      <span className="pi-insight-ico" aria-hidden="true">
                        <Icon size={17} />
                      </span>
                      <span className="pi-insight-body">
                        <span className="pi-insight-fact">{ins.fact}</span>
                        <span className="pi-insight-note">{ins.note}</span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* SUGGESTED ACTIONS */}
          <section>
            <div className="pi-sec-label">
              Doporučené akce
              <span className="pi-tag">řazeno dle relevance</span>
            </div>
            <div className="pi-action-list" data-testid="pi-actions">
              {actions.map((id) => {
                const meta = ACTION_META[id];
                return (
                  <button
                    type="button"
                    key={id}
                    className="pi-action"
                    onClick={() => runAction(id)}
                    data-testid={`pi-action-${id}`}
                  >
                    <span className="pi-action-ico" aria-hidden="true">
                      <meta.Icon size={18} />
                    </span>
                    <span className="pi-action-main">
                      <span className="pi-action-name">{meta.label}</span>
                      <span className="pi-action-note">→ {meta.note}</span>
                    </span>
                    <ArrowRight size={15} className="pi-action-arrow" aria-hidden="true" />
                  </button>
                );
              })}
            </div>
          </section>

          {/* ASK -- reálný chat s kontextem projektu, záměrně dole */}
          <section className="pi-ask">
            <div className="pi-sec-label">
              Zeptej se AI
              <span className="pi-tag">kontext tohoto projektu</span>
            </div>

            {chatMessages.length > 0 && (
              <div className="pi-chat-log" ref={chatLogRef} data-testid="pi-chat-log">
                {chatMessages.map((m, i) => (
                  <div key={i} className={`pi-chat-msg pi-chat-${m.role}`}>
                    {renderAnswer(m)}
                  </div>
                ))}
                {chatLoading && (
                  <div className="pi-chat-msg pi-chat-assistant pi-chat-loading">Přemýšlím…</div>
                )}
              </div>
            )}

            {chatError && <p className="pi-chat-error" data-testid="pi-chat-error">{chatError}</p>}

            <form className="pi-ask-form" onSubmit={sendChat}>
              <textarea
                className="pi-ask-input"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    sendChat(e);
                  }
                }}
                rows={3}
                placeholder="Zeptej se na projekt… (Enter odešle, Shift+Enter nový řádek)"
                data-testid="pi-ask-input"
              />
              <button
                type="submit"
                className="pi-ask-send"
                disabled={!chatInput.trim() || chatLoading}
                data-testid="pi-ask-send"
              >
                <Send size={15} />
                Odeslat
              </button>
            </form>
          </section>
          </>)}
        </div>
      </div>
    </>
  );
}
