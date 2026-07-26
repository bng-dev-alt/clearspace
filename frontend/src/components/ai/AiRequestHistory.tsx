import React, { useState } from 'react';
import { AiRequestLog } from '../../services/ai/aiAnalyticsService';
import { aiCostEstimator } from '../../services/ai/aiCostEstimator';
import { ChevronDown, ChevronUp, CheckCircle2, XCircle, ListTree } from 'lucide-react';
import { EmptyState } from '../ui';

interface AiRequestHistoryProps {
  history: AiRequestLog[];
}

export default function AiRequestHistory({ history }: AiRequestHistoryProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const toggleRow = (id: string) => {
    setExpandedId(expandedId === id ? null : id);
  };

  const formatTime = (ts: number) => {
    return new Date(ts).toLocaleTimeString('cs-CZ', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  const formatDate = (ts: number) => {
    return new Date(ts).toLocaleDateString('cs-CZ', {
      day: 'numeric',
      month: 'numeric',
    });
  };

  const getCleanPayload = (payload: unknown) => {
    if (!payload) return 'Žádná data';
    try {
      return JSON.stringify(payload, null, 2);
    } catch {
      return String(payload);
    }
  };

  if (history.length === 0) {
    return (
      <div style={{ border: '1px dashed var(--border-strong)', borderRadius: 'var(--radius-card)' }}>
        <EmptyState
          icon={<ListTree size={22} />}
          title="Žádná historie dotazů"
          description="Jakmile proběhne první AI požadavek, jeho log a ladicí detaily se objeví tady."
        />
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', width: '100%' }}>
      <div style={{ overflowX: 'auto', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-card)' }}>
        <table style={{
          width: '100%',
          borderCollapse: 'collapse',
          textAlign: 'left',
          fontSize: '0.8rem',
          fontFamily: 'var(--font-sans)',
        }}>
          <thead>
            <tr style={{ backgroundColor: 'var(--surface-2)', borderBottom: '1px solid var(--border-color)' }}>
              <th style={{ width: '40px', padding: '0.75rem 1rem' }}></th>
              <th style={{ padding: '0.75rem 1rem', fontWeight: 700, color: 'var(--dark-navy)' }}>Čas</th>
              <th style={{ padding: '0.75rem 1rem', fontWeight: 700, color: 'var(--dark-navy)' }}>Funkce</th>
              <th style={{ padding: '0.75rem 1rem', fontWeight: 700, color: 'var(--dark-navy)' }}>Model</th>
              <th style={{ padding: '0.75rem 1rem', fontWeight: 700, color: 'var(--dark-navy)' }}>Status</th>
              <th style={{ padding: '0.75rem 1rem', fontWeight: 700, color: 'var(--dark-navy)' }}>Odezva</th>
              <th style={{ padding: '0.75rem 1rem', fontWeight: 700, color: 'var(--dark-navy)' }}>Tokeny (In/Out)</th>
              <th style={{ padding: '0.75rem 1rem', fontWeight: 700, color: 'var(--dark-navy)', textAlign: 'right' }}>Cena</th>
            </tr>
          </thead>
          <tbody>
            {history.map((log) => {
              const isExpanded = expandedId === log.id;
              return (
                <React.Fragment key={log.id}>
                  <tr
                    onClick={() => toggleRow(log.id)}
                    style={{
                      borderBottom: isExpanded ? 'none' : '1px solid var(--border-color)',
                      cursor: 'pointer',
                      transition: 'background-color 0.2s',
                      backgroundColor: isExpanded ? 'rgba(0, 0, 0, 0.01)' : 'transparent',
                    }}
                    onMouseEnter={(e) => {
                      if (!isExpanded) e.currentTarget.style.backgroundColor = 'rgba(0, 0, 0, 0.015)';
                    }}
                    onMouseLeave={(e) => {
                      if (!isExpanded) e.currentTarget.style.backgroundColor = 'transparent';
                    }}
                  >
                    <td style={{ padding: '0.75rem 1rem', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      {isExpanded ? <ChevronUp size={16} color="var(--gray-text)" /> : <ChevronDown size={16} color="var(--gray-text)" />}
                    </td>
                    <td style={{ padding: '0.75rem 1rem', color: 'var(--dark-navy)', whiteSpace: 'nowrap' }}>
                      <span style={{ fontWeight: 600 }}>{formatTime(log.timestamp)}</span>
                      <span style={{ fontSize: '0.7rem', color: 'var(--gray-text)', marginLeft: '0.4rem' }}>
                        {formatDate(log.timestamp)}
                      </span>
                    </td>
                    <td style={{ padding: '0.75rem 1rem', fontWeight: 600, color: 'var(--dark-navy)' }}>
                      {log.feature}
                    </td>
                    <td style={{ padding: '0.75rem 1rem', color: 'var(--gray-text)', fontSize: '0.75rem' }}>
                      {log.model.replace(/^models\//, '')}
                    </td>
                    <td style={{ padding: '0.75rem 1rem' }}>
                      {log.success ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', color: 'var(--success)', fontWeight: 600 }}>
                          <CheckCircle2 size={14} /> OK
                        </div>
                      ) : (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', color: 'var(--danger)', fontWeight: 600 }}>
                          <XCircle size={14} /> Chyba
                        </div>
                      )}
                    </td>
                    <td style={{ padding: '0.75rem 1rem', color: 'var(--dark-navy)' }}>
                      {(log.responseTime / 1000).toFixed(2)} s
                    </td>
                    <td style={{ padding: '0.75rem 1rem', color: 'var(--gray-text)' }}>
                      {log.success ? `${log.inputTokens} / ${log.outputTokens}` : '-'}
                    </td>
                    <td style={{ padding: '0.75rem 1rem', fontWeight: 700, color: 'var(--dark-navy)', textAlign: 'right' }}>
                      {aiCostEstimator.formatCostCzk(log.estimatedCostCzk)}
                    </td>
                  </tr>

                  {isExpanded && (
                    <tr style={{ backgroundColor: 'rgba(0, 0, 0, 0.015)', borderBottom: '1px solid var(--border-color)' }}>
                      <td colSpan={8} style={{ padding: '1rem 1.5rem' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                          
                          {/* Row: Overview metadata */}
                          <div style={{
                            display: 'grid',
                            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                            gap: '0.75rem',
                            backgroundColor: 'var(--surface)',
                            padding: '0.75rem',
                            borderRadius: '8px',
                            border: '1px solid var(--border-color)',
                          }}>
                            <div>
                              <div style={{ fontSize: '0.7rem', color: 'var(--gray-text)' }}>Model / Provider</div>
                              <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--dark-navy)' }}>
                                {log.model} ({log.provider})
                              </div>
                            </div>
                            <div>
                              <div style={{ fontSize: '0.7rem', color: 'var(--gray-text)' }}>Latence (Doba odezvy)</div>
                              <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--dark-navy)' }}>
                                {log.responseTime.toLocaleString()} ms ({(log.responseTime / 1000).toFixed(2)} s)
                              </div>
                            </div>
                            <div>
                              <div style={{ fontSize: '0.7rem', color: 'var(--gray-text)' }}>Tokeny (Prompt / Output)</div>
                              <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--dark-navy)' }}>
                                {log.inputTokens.toLocaleString()} / {log.outputTokens.toLocaleString()} (Celkem: {log.totalTokens.toLocaleString()})
                              </div>
                            </div>
                            <div>
                              <div style={{ fontSize: '0.7rem', color: 'var(--gray-text)' }}>Odhadovaná cena</div>
                              <div style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--dark-navy)' }}>
                                {aiCostEstimator.formatCostCzk(log.estimatedCostCzk)}
                              </div>
                            </div>
                          </div>

                          {/* Error block if failed */}
                          {!log.success && log.error && (
                            <div style={{
                              backgroundColor: 'var(--danger-soft)',
                              border: '1px solid var(--danger-soft)',
                              color: 'var(--danger)',
                              padding: '0.75rem',
                              borderRadius: '8px',
                              fontSize: '0.75rem',
                            }}>
                              <span style={{ fontWeight: 700 }}>Chyba: </span>
                              {log.error}
                            </div>
                          )}

                          {/* Columns for Request and Response */}
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(300px, 100%), 1fr))', gap: '1rem' }}>
                            <div>
                              <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--dark-navy)', marginBottom: '0.25rem' }}>
                                Vstupní parametry (Request)
                              </div>
                              <pre style={{
                                margin: 0,
                                padding: '0.75rem',
                                backgroundColor: 'var(--surface-2)',
                                border: '1px solid var(--border-color)',
                                borderRadius: '8px',
                                maxHeight: '250px',
                                overflowY: 'auto',
                                fontSize: '0.7rem',
                                color: '#374151',
                                fontFamily: 'monospace',
                                whiteSpace: 'pre-wrap',
                                wordBreak: 'break-all',
                              }}>
                                {getCleanPayload(log.requestPayload)}
                              </pre>
                            </div>

                            <div>
                              <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--dark-navy)', marginBottom: '0.25rem' }}>
                                Odpověď modelu (Response)
                              </div>
                              <pre style={{
                                margin: 0,
                                padding: '0.75rem',
                                backgroundColor: 'var(--surface-2)',
                                border: '1px solid var(--border-color)',
                                borderRadius: '8px',
                                maxHeight: '250px',
                                overflowY: 'auto',
                                fontSize: '0.7rem',
                                color: '#374151',
                                fontFamily: 'monospace',
                                whiteSpace: 'pre-wrap',
                                wordBreak: 'break-all',
                              }}>
                                {getCleanPayload(log.responsePayload)}
                              </pre>
                            </div>
                          </div>

                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
