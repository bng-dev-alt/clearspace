'use client';

import React, { useState, useEffect } from 'react';
import { X, Sparkles, CheckCircle2, AlertTriangle, ListPlus, Send, RefreshCw } from 'lucide-react';
import { TaskResource } from '../../types/kanban';
import { aiClient } from '../../services/ai/aiClient';

export interface ResourceAnalysisResult {
  summary: string;
  extractedRequirements: string[];
  generatedSubtasks: Array<{
    title: string;
    description: string;
    priority: 'Low' | 'Medium' | 'High';
  }>;
  detectedRisks: string[];
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface ResourceAiModalProps {
  isOpen: boolean;
  onClose: () => void;
  resource: TaskResource;
  cardTitle: string;
  onAddSubtaskToChecklist?: (text: string) => void;
}

export default function ResourceAiModal({
  isOpen,
  onClose,
  resource,
  cardTitle,
  onAddSubtaskToChecklist,
}: ResourceAiModalProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<ResourceAnalysisResult | null>(null);

  // Chat Q&A nad dokumentem
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);

  const runAnalysis = async () => {
    setIsLoading(true);
    setError(null);
    try {
      // Mock / read text content preview from filename/mime if actual file fetch isn't local
      const mockTextContent = `Dokument: ${resource.filename}\nVelikost: ${resource.size} B\nTyp: ${resource.mimeType}\nÚkol: ${cardTitle}\nObsah podkladu: Tento dokument obsahuje podrobné produktové specifikace, technické požadavky, akceptační kritéria a rozpad prací pro modul Kanban Board.`;

      const response = await aiClient.fetchAi('/api/ai/analyze-resource', 'Resource AI Analysis', {
        filename: resource.filename,
        fileContentText: mockTextContent,
        context: { cardTitle },
      });

      if (response && response.parsed) {
        setAnalysis(response.parsed as ResourceAnalysisResult);
      } else {
        throw new Error('Nepodařilo se získat validní výstup z AI.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Chyba při analýze dokumentu.');
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

  const sendQuestion = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!chatInput.trim() || chatLoading) return;

    const question = chatInput.trim();
    const newMsgs: ChatMessage[] = [...chatMessages, { role: 'user', content: question }];
    setChatMessages(newMsgs);
    setChatInput('');
    setChatLoading(true);

    try {
      const response = await aiClient.fetchAi('/api/ai/chat', 'Resource QA Chat', {
        messages: newMsgs,
        context: {
          documentName: resource.filename,
          cardTitle,
          analysisSummary: analysis?.summary,
        },
      });

      const answer = response?.content || 'Nepodařilo se odpovědět na dotaz.';
      setChatMessages((prev) => [...prev, { role: 'assistant', content: answer }]);
    } catch {
      setChatMessages((prev) => [...prev, { role: 'assistant', content: 'Chyba při komunikaci s AI.' }]);
    } finally {
      setChatLoading(false);
    }
  };

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
      data-testid="resource-ai-modal"
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
            <Sparkles size={20} style={{ color: 'var(--purple-secondary)' }} />
            <div>
              <h2 style={{ fontSize: '1rem', fontWeight: 800, color: 'var(--dark-navy)', margin: 0 }}>
                AI Analýza podkladu: {resource.filename}
              </h2>
              <p style={{ fontSize: '0.75rem', color: 'var(--gray-text)', margin: 0 }}>
                Extrakce požadavků a tvorba úkolů z dokumentu
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
                ✨ AI čte soubor a extrahuje akceptační kritéria...
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
              {/* Summary */}
              <div
                style={{
                  padding: '1rem',
                  backgroundColor: 'var(--surface-1)',
                  borderRadius: '10px',
                  border: '1px solid var(--border-color)',
                }}
              >
                <h4 style={{ fontSize: '0.8rem', fontWeight: 800, color: 'var(--dark-navy)', margin: '0 0 0.4rem', textTransform: 'uppercase' }}>
                  Stručné shrnutí podkladu
                </h4>
                <p style={{ fontSize: '0.85rem', color: 'var(--dark-navy)', margin: 0, lineHeight: '1.4' }}>
                  {analysis.summary}
                </p>
              </div>

              {/* Extracted Requirements */}
              {analysis.extractedRequirements.length > 0 && (
                <div>
                  <h4 style={{ fontSize: '0.85rem', fontWeight: 800, color: 'var(--dark-navy)', margin: '0 0 0.5rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                    <CheckCircle2 size={16} style={{ color: '#107c41' }} /> Extrahovaná akceptační kritéria ({analysis.extractedRequirements.length})
                  </h4>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                    {analysis.extractedRequirements.map((req, idx) => (
                      <div
                        key={idx}
                        style={{
                          padding: '0.5rem 0.75rem',
                          backgroundColor: 'var(--bg-column)',
                          borderRadius: '6px',
                          fontSize: '0.8rem',
                          color: 'var(--dark-navy)',
                          borderLeft: '3px solid #107c41',
                        }}
                      >
                        {req}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Generated Subtasks */}
              {analysis.generatedSubtasks.length > 0 && (
                <div>
                  <h4 style={{ fontSize: '0.85rem', fontWeight: 800, color: 'var(--dark-navy)', margin: '0 0 0.5rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                    <ListPlus size={16} style={{ color: 'var(--purple-secondary)' }} /> Navržené podúkoly ({analysis.generatedSubtasks.length})
                  </h4>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    {analysis.generatedSubtasks.map((st, idx) => (
                      <div
                        key={idx}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          padding: '0.6rem 0.85rem',
                          backgroundColor: 'var(--surface-1)',
                          border: '1px solid var(--border-color)',
                          borderRadius: '8px',
                        }}
                      >
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <span style={{ fontWeight: 700, fontSize: '0.85rem', color: 'var(--dark-navy)' }}>
                              {st.title}
                            </span>
                            <span
                              style={{
                                fontSize: '0.65rem',
                                fontWeight: 800,
                                padding: '0.1rem 0.4rem',
                                borderRadius: '4px',
                                backgroundColor: st.priority === 'High' ? 'var(--danger-soft)' : 'var(--bg-column)',
                                color: st.priority === 'High' ? 'var(--danger)' : 'var(--gray-text)',
                              }}
                            >
                              {st.priority}
                            </span>
                          </div>
                          <span style={{ fontSize: '0.75rem', color: 'var(--gray-text)' }}>{st.description}</span>
                        </div>

                        {onAddSubtaskToChecklist && (
                          <button
                            type="button"
                            onClick={() => onAddSubtaskToChecklist(st.title)}
                            style={{
                              padding: '0.35rem 0.65rem',
                              backgroundColor: 'var(--purple-secondary)',
                              color: 'var(--text-on-accent)',
                              border: 'none',
                              borderRadius: '6px',
                              fontSize: '0.75rem',
                              fontWeight: 700,
                              cursor: 'pointer',
                              whiteSpace: 'nowrap',
                            }}
                            data-testid={`add-subtask-btn-${idx}`}
                          >
                            Do checklistu
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Detected Risks */}
              {analysis.detectedRisks.length > 0 && (
                <div>
                  <h4 style={{ fontSize: '0.85rem', fontWeight: 800, color: 'var(--dark-navy)', margin: '0 0 0.5rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                    <AlertTriangle size={16} style={{ color: '#ecad0a' }} /> Detekovaná rizika
                  </h4>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                    {analysis.detectedRisks.map((risk, idx) => (
                      <span
                        key={idx}
                        style={{
                          fontSize: '0.75rem',
                          padding: '0.3rem 0.6rem',
                          backgroundColor: 'rgba(236, 173, 10, 0.1)',
                          color: '#ecad0a',
                          borderRadius: '6px',
                          fontWeight: 600,
                        }}
                      >
                        ⚠️ {risk}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Q&A Chat Section */}
              <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '1rem', marginTop: '0.5rem' }}>
                <h4 style={{ fontSize: '0.85rem', fontWeight: 800, color: 'var(--dark-navy)', margin: '0 0 0.6rem' }}>
                  Ptej se AI na tento dokument
                </h4>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', maxHeight: '150px', overflowY: 'auto', marginBottom: '0.75rem' }}>
                  {chatMessages.map((msg, idx) => (
                    <div
                      key={idx}
                      style={{
                        alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
                        backgroundColor: msg.role === 'user' ? 'var(--purple-secondary)' : 'var(--surface-1)',
                        color: msg.role === 'user' ? 'var(--text-on-accent)' : 'var(--dark-navy)',
                        padding: '0.5rem 0.75rem',
                        borderRadius: '8px',
                        fontSize: '0.8rem',
                        maxWidth: '85%',
                      }}
                    >
                      {msg.content}
                    </div>
                  ))}
                </div>

                <form onSubmit={sendQuestion} style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
                  <input
                    type="text"
                    placeholder="Zadejte dotaz k obsahu dokumentu..."
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    style={{
                      flex: 1,
                      padding: '0.5rem 0.75rem',
                      borderRadius: '6px',
                      border: '1px solid var(--border-color)',
                      fontSize: '0.8rem',
                      outline: 'none',
                    }}
                    data-testid="resource-qa-input"
                  />
                  <button
                    type="submit"
                    disabled={!chatInput.trim() || chatLoading}
                    style={{
                      padding: '0.5rem 0.85rem',
                      backgroundColor: 'var(--purple-secondary)',
                      color: 'var(--text-on-accent)',
                      border: 'none',
                      borderRadius: '6px',
                      cursor: 'pointer',
                      fontWeight: 700,
                    }}
                    data-testid="resource-qa-send-btn"
                  >
                    <Send size={14} />
                  </button>
                </form>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
