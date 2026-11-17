import React, { useState, useEffect } from 'react';
import { X, ShieldAlert, AlertTriangle, AlertCircle, Info, Check, ShieldCheck, HelpCircle, Activity } from 'lucide-react';
import { Column } from '../../types/kanban';
import { aiClient } from '../../services/ai/aiClient';

interface RiskAnalysisModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectName: string;
  columns: Column[];
}

interface RiskItem {
  name: string;
  severity: 'Low' | 'Medium' | 'High';
  explanation: string;
  recommendation: string;
}

interface RiskAnalysisData {
  executiveSummary: string;
  overallRiskScore: number;
  biggestRisks: RiskItem[];
  bottlenecks: string[];
  missingFeatures: string[];
  technicalDebt: string[];
  securityRisks: string[];
  performanceRisks: string[];
  mvpRecommendations: string[];
  topAiRecommendations: string[];
}

// `columns` zůstává v props kvůli stávajícím volajícím; analýzu dělá server nad načteným boardem.
export default function RiskAnalysisModal({ isOpen, onClose, projectName }: RiskAnalysisModalProps) {
  const [step, setStep] = useState<'loading' | 'error' | 'preview'>('loading');
  const [data, setData] = useState<RiskAnalysisData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runAnalysis = async () => {
    setStep('loading');
    setError(null);
    try {
      // Přes aiClient: přihlášení (Bearer), projekt a logování spotřeby řeší jedno místo.
      const result = await aiClient.fetchAi('/api/ai/risk-analysis', 'AI Risk Analysis', {});
      if (!result || !result.parsed) {
        throw new Error('AI vrátila neplatnou strukturu odpovědi.');
      }

      setData(result.parsed);
      setStep('preview');
    } catch (err: unknown) {
      console.error('Failed to run AI risk analysis:', err);
      const errMsg = err as Error;
      setError(errMsg.message || 'Došlo k neočekávané chybě.');
      setStep('error');
    }
  };

  useEffect(() => {
    if (isOpen) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      runAnalysis();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  // Get color and status text based on risk score
  const getRiskScoreDetails = (score: number) => {
    if (score < 30) return { color: 'var(--success)', label: 'Nízké riziko', bg: 'rgba(16, 185, 129, 0.08)' };
    if (score < 70) return { color: 'var(--warning)', label: 'Střední riziko', bg: 'rgba(245, 158, 11, 0.08)' };
    return { color: 'var(--danger)', label: 'Vysoké riziko', bg: 'rgba(239, 68, 68, 0.08)' };
  };

  const getSeverityColor = (severity: 'Low' | 'Medium' | 'High') => {
    switch (severity) {
      case 'High': return { text: 'var(--danger)', bg: 'var(--danger-soft)' };
      case 'Medium': return { text: 'var(--warning)', bg: 'var(--warning-soft)' };
      case 'Low': return { text: '#047857', bg: 'var(--success-soft)' };
    }
  };

  const scoreDetails = data ? getRiskScoreDetails(data.overallRiskScore) : { color: 'var(--gray-text)', label: 'Načítání...', bg: 'rgba(0,0,0,0.02)' };

  return (
    <div className="modal-overlay" onClick={onClose} style={{ zIndex: 1100 }}>
      <div
        className="modal-content"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: '960px',
          height: '90vh',
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          backgroundColor: 'var(--surface-2)',
          borderRadius: '16px',
          overflow: 'hidden',
          padding: 0
        }}
        role="dialog"
        aria-modal="true"
      >
        {/* Modal Header */}
        <div className="modal-header" style={{ padding: '1.25rem 2rem', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', backgroundColor: 'var(--surface)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <ShieldAlert size={22} style={{ color: 'var(--warning)' }} />
            <div>
              <h2 className="modal-title" style={{ fontSize: '1.15rem', fontWeight: 800, color: 'var(--dark-navy)', margin: 0 }}>
                AI Risk Analysis
              </h2>
              <span style={{ fontSize: '0.68rem', color: 'var(--gray-text)', fontWeight: 500 }}>
                Analýza projektu: {projectName}
              </span>
            </div>
          </div>
          <button
            type="button"
            className="modal-close-btn"
            onClick={onClose}
            aria-label="Zavřít"
            style={{ padding: '0.25rem', borderRadius: '50%' }}
          >
            <X size={20} />
          </button>
        </div>

        {/* Modal Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '2rem' }}>
          
          {step === 'loading' && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '5rem 0', gap: '1.5rem' }}>
              <div style={{
                width: '50px',
                height: '50px',
                border: '4px solid rgba(236, 173, 10, 0.1)',
                borderTopColor: 'var(--warning)',
                borderRadius: '50%',
                animation: 'spin 1s linear infinite',
              }} />
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--dark-navy)', marginBottom: '0.3rem' }}>
                  AI analyzuje rizika projektu...
                </div>
                <p style={{ fontSize: '0.8rem', color: 'var(--gray-text)', maxWidth: '350px', margin: '0 auto', lineHeight: '1.4' }}>
                  Kontroluji backlog, workflow úkolů, rozložení priorit a popisů z pohledu Tech Leada, Architekta a Product Managera.
                </p>
              </div>
              <style jsx global>{`
                @keyframes spin {
                  0% { transform: rotate(0deg); }
                  100% { transform: rotate(360deg); }
                }
              `}</style>
            </div>
          )}

          {step === 'error' && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '4rem 1rem', gap: '1.25rem' }}>
              <div style={{ backgroundColor: 'var(--danger-soft)', color: 'var(--danger)', padding: '0.75rem', borderRadius: '50%' }}>
                <AlertCircle size={32} />
              </div>
              <div style={{ textAlign: 'center' }}>
                <h3 style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--dark-navy)', marginBottom: '0.25rem' }}>
                  Analýza rizik se nezdařila
                </h3>
                <p style={{ fontSize: '0.8rem', color: 'var(--danger)', maxWidth: '400px', margin: '0 auto', lineHeight: '1.4' }}>
                  {error}
                </p>
              </div>
              <button
                type="button"
                className="btn btn-submit"
                onClick={runAnalysis}
                style={{ background: 'var(--warning)', color: '#ffffff', border: 'none', padding: '0.5rem 1.25rem', borderRadius: '6px', fontSize: '0.8rem', fontWeight: 700, cursor: 'pointer' }}
              >
                Zkusit znovu
              </button>
            </div>
          )}

          {step === 'preview' && data && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
              
              {/* Top Row: Executive Summary & Overall Risk Score */}
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)', gap: '1.5rem', alignItems: 'stretch' }}>
                
                {/* Executive Summary */}
                <div style={{
                  backgroundColor: 'var(--surface)',
                  border: '1px solid var(--border-color)',
                  borderRadius: '12px',
                  padding: '1.5rem',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.75rem',
                  boxShadow: '0 4px 6px -1px rgba(0,0,0,0.01)'
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.7rem', fontWeight: 700, color: 'var(--warning)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    <Info size={14} />
                    Executive Summary
                  </div>
                  <h3 style={{ fontSize: '1rem', fontWeight: 800, color: 'var(--dark-navy)', margin: 0 }}>
                    Celkové zhodnocení stavu projektu
                  </h3>
                  <div 
                    style={{ fontSize: '0.82rem', color: 'var(--gray-text)', lineHeight: '1.5', whiteSpace: 'pre-line' }}
                  >
                    {data.executiveSummary}
                  </div>
                </div>

                {/* Overall Risk Score Indicator */}
                <div style={{
                  backgroundColor: 'var(--surface)',
                  border: '1px solid var(--border-color)',
                  borderRadius: '12px',
                  padding: '1.5rem',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '1rem',
                  boxShadow: '0 4px 6px -1px rgba(0,0,0,0.01)',
                  textAlign: 'center'
                }}>
                  <div style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--gray-text)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Celkové skóre rizika
                  </div>
                  
                  {/* Circular Score Badge */}
                  <div style={{
                    width: '100px',
                    height: '100px',
                    borderRadius: '50%',
                    backgroundColor: scoreDetails.bg,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    border: `4px solid ${scoreDetails.color}`,
                    boxShadow: 'inset 0 2px 4px rgba(0,0,0,0.02)'
                  }}>
                    <span style={{ fontSize: '1.8rem', fontWeight: 800, color: scoreDetails.color }}>
                      {data.overallRiskScore}
                    </span>
                    <span style={{ fontSize: '0.62rem', color: 'var(--gray-text)', fontWeight: 600 }}>
                      / 100
                    </span>
                  </div>

                  <div>
                    <div style={{ fontSize: '0.9rem', fontWeight: 800, color: scoreDetails.color }}>
                      {scoreDetails.label}
                    </div>
                    <div style={{ fontSize: '0.68rem', color: 'var(--gray-text)', marginTop: '0.15rem' }}>
                      Tech Lead & Architect Review
                    </div>
                  </div>
                </div>
              </div>

              {/* Největší rizika (biggestRisks) */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                <h3 style={{ fontSize: '0.95rem', fontWeight: 800, color: 'var(--dark-navy)', margin: 0, display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  <AlertTriangle size={18} style={{ color: 'var(--warning)' }} />
                  Největší identifikovaná rizika ({data.biggestRisks.length})
                </h3>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                  {data.biggestRisks.map((risk, idx) => {
                    const badge = getSeverityColor(risk.severity);
                    return (
                      <div
                        key={idx}
                        style={{
                          backgroundColor: 'var(--surface)',
                          border: '1px solid var(--border-color)',
                          borderRadius: '10px',
                          padding: '1.25rem',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '0.75rem',
                          boxShadow: '0 4px 6px -1px rgba(0,0,0,0.01)'
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 700, color: 'var(--dark-navy)', fontSize: '0.88rem' }}>
                            <span style={{ color: 'var(--gray-text)', fontSize: '0.75rem' }}>#{idx + 1}</span>
                            <span>{risk.name}</span>
                          </div>
                          <span style={{
                            backgroundColor: badge.bg,
                            color: badge.text,
                            padding: '0.15rem 0.5rem',
                            borderRadius: '4px',
                            fontSize: '0.68rem',
                            fontWeight: 700
                          }}>
                            {risk.severity === 'High' ? 'Kritická' : risk.severity === 'Medium' ? 'Střední' : 'Nízká'} závažnost
                          </span>
                        </div>

                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.25rem', borderTop: '1px solid var(--border-color)', paddingTop: '0.75rem', fontSize: '0.78rem', lineHeight: '1.4' }}>
                          <div>
                            <div style={{ fontWeight: 700, color: 'var(--dark-navy)', marginBottom: '0.2rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                              <AlertCircle size={14} style={{ color: 'var(--danger)' }} />
                              Dopad a vysvětlení
                            </div>
                            <p style={{ color: 'var(--gray-text)', margin: 0 }}>{risk.explanation}</p>
                          </div>
                          <div>
                            <div style={{ fontWeight: 700, color: 'var(--dark-navy)', marginBottom: '0.2rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                              <ShieldCheck size={14} style={{ color: 'var(--success)' }} />
                              Doporučené řešení
                            </div>
                            <p style={{ color: 'var(--gray-text)', margin: 0 }}>{risk.recommendation}</p>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Risk Categories Grid */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(280px, 100%), 1fr))', gap: '1.5rem' }}>
                
                {/* Bottlenecks */}
                <div style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border-color)', borderRadius: '10px', padding: '1rem 1.25rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  <h4 style={{ fontSize: '0.82rem', fontWeight: 800, color: 'var(--dark-navy)', margin: 0, display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                    <Activity size={14} style={{ color: 'var(--warning)' }} />
                    Úzká hrdla (Bottlenecks)
                  </h4>
                  <ul style={{ margin: 0, paddingLeft: '1.1rem', fontSize: '0.76rem', color: 'var(--gray-text)', lineHeight: '1.4' }}>
                    {data.bottlenecks.map((item, idx) => <li key={idx} style={{ marginBottom: '0.2rem' }}>{item}</li>)}
                    {data.bottlenecks.length === 0 && <li>Nebyly detekovány zjevné bottlenecks.</li>}
                  </ul>
                </div>

                {/* Technical Debt */}
                <div style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border-color)', borderRadius: '10px', padding: '1rem 1.25rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  <h4 style={{ fontSize: '0.82rem', fontWeight: 800, color: 'var(--dark-navy)', margin: 0, display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                    <AlertTriangle size={14} style={{ color: 'var(--warning)' }} />
                    Technický dluh
                  </h4>
                  <ul style={{ margin: 0, paddingLeft: '1.1rem', fontSize: '0.76rem', color: 'var(--gray-text)', lineHeight: '1.4' }}>
                    {data.technicalDebt.map((item, idx) => <li key={idx} style={{ marginBottom: '0.2rem' }}>{item}</li>)}
                    {data.technicalDebt.length === 0 && <li>Žádný zjevný technický dluh.</li>}
                  </ul>
                </div>

                {/* Missing Features */}
                <div style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border-color)', borderRadius: '10px', padding: '1rem 1.25rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  <h4 style={{ fontSize: '0.82rem', fontWeight: 800, color: 'var(--dark-navy)', margin: 0, display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                    <HelpCircle size={14} style={{ color: '#3b82f6' }} />
                    Chybějící funkce
                  </h4>
                  <ul style={{ margin: 0, paddingLeft: '1.1rem', fontSize: '0.76rem', color: 'var(--gray-text)', lineHeight: '1.4' }}>
                    {data.missingFeatures.map((item, idx) => <li key={idx} style={{ marginBottom: '0.2rem' }}>{item}</li>)}
                    {data.missingFeatures.length === 0 && <li>Zadání neobsahuje chybějící prvky.</li>}
                  </ul>
                </div>

                {/* Security Risks */}
                <div style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border-color)', borderRadius: '10px', padding: '1rem 1.25rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  <h4 style={{ fontSize: '0.82rem', fontWeight: 800, color: 'var(--dark-navy)', margin: 0, display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                    <ShieldAlert size={14} style={{ color: 'var(--danger)' }} />
                    Bezpečnostní rizika
                  </h4>
                  <ul style={{ margin: 0, paddingLeft: '1.1rem', fontSize: '0.76rem', color: 'var(--gray-text)', lineHeight: '1.4' }}>
                    {data.securityRisks.map((item, idx) => <li key={idx} style={{ marginBottom: '0.2rem' }}>{item}</li>)}
                    {data.securityRisks.length === 0 && <li>Nebylo detekováno zvýšené bezpečnostní riziko.</li>}
                  </ul>
                </div>

                {/* Performance Risks */}
                <div style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border-color)', borderRadius: '10px', padding: '1rem 1.25rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  <h4 style={{ fontSize: '0.82rem', fontWeight: 800, color: 'var(--dark-navy)', margin: 0, display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                    <Activity size={14} style={{ color: 'var(--success)' }} />
                    Výkon & Škálovatelnost
                  </h4>
                  <ul style={{ margin: 0, paddingLeft: '1.1rem', fontSize: '0.76rem', color: 'var(--gray-text)', lineHeight: '1.4' }}>
                    {data.performanceRisks.map((item, idx) => <li key={idx} style={{ marginBottom: '0.2rem' }}>{item}</li>)}
                    {data.performanceRisks.length === 0 && <li>Výkonnostní rizika jsou minimální.</li>}
                  </ul>
                </div>

                {/* MVP Recommendations */}
                <div style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border-color)', borderRadius: '10px', padding: '1rem 1.25rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  <h4 style={{ fontSize: '0.82rem', fontWeight: 800, color: 'var(--dark-navy)', margin: 0, display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                    <Check size={14} style={{ color: 'var(--accent)' }} />
                    MVP Doporučení
                  </h4>
                  <ul style={{ margin: 0, paddingLeft: '1.1rem', fontSize: '0.76rem', color: 'var(--gray-text)', lineHeight: '1.4' }}>
                    {data.mvpRecommendations.map((item, idx) => <li key={idx} style={{ marginBottom: '0.2rem' }}>{item}</li>)}
                    {data.mvpRecommendations.length === 0 && <li>Žádná specifická doporučení pro rozsah MVP.</li>}
                  </ul>
                </div>

              </div>

              {/* Top 5 AI doporučení */}
              <div style={{
                backgroundColor: 'rgba(236, 173, 10, 0.03)',
                border: '1.5px solid rgba(236, 173, 10, 0.25)',
                borderRadius: '12px',
                padding: '1.5rem',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.75rem',
                boxShadow: '0 4px 12px rgba(236, 173, 10, 0.04)'
              }}>
                <h4 style={{ fontSize: '0.9rem', fontWeight: 800, color: 'var(--dark-navy)', margin: 0, display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  <Sparkles size={16} style={{ color: 'var(--warning)' }} />
                  Top 5 AI strategických doporučení pro úspěch
                </h4>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.25rem' }}>
                  {data.topAiRecommendations.slice(0, 5).map((rec, idx) => (
                    <div
                      key={idx}
                      style={{
                        display: 'flex',
                        gap: '0.6rem',
                        alignItems: 'flex-start',
                        fontSize: '0.8rem',
                        lineHeight: '1.4',
                        color: 'var(--dark-navy)',
                        padding: '0.5rem 0.75rem',
                        backgroundColor: 'var(--surface)',
                        border: '1px solid rgba(0,0,0,0.03)',
                        borderRadius: '6px'
                      }}
                    >
                      <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: '18px',
                        height: '18px',
                        borderRadius: '50%',
                        backgroundColor: 'rgba(236, 173, 10, 0.1)',
                        color: 'var(--warning)',
                        fontWeight: 800,
                        fontSize: '0.65rem',
                        flexShrink: 0,
                        marginTop: '1px'
                      }}>
                        {idx + 1}
                      </div>
                      <span>{rec}</span>
                    </div>
                  ))}
                </div>
              </div>

            </div>
          )}

        </div>

        {/* Modal Footer */}
        <div className="modal-footer" style={{ padding: '1rem 2rem', borderTop: '1px solid var(--border-color)', display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', backgroundColor: 'var(--surface)' }}>
          <button
            type="button"
            className="btn btn-cancel"
            onClick={onClose}
            disabled={step === 'loading'}
          >
            Zavřít
          </button>
        </div>

      </div>
    </div>
  );
}

// Sparkles local icon for Top 5 AI recommendations card
function Sparkles({ size, style }: { size?: number; style?: React.CSSProperties }) {
  return (
    <svg 
      xmlns="http://www.w3.org/2000/svg" 
      width={size || 16} 
      height={size || 16} 
      viewBox="0 0 24 24" 
      fill="none" 
      stroke="currentColor" 
      strokeWidth="2.5" 
      strokeLinecap="round" 
      strokeLinejoin="round" 
      style={style}
    >
      <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/>
      <path d="m5 3 1 2.5L8.5 6 6 7 5 9.5 4 7 1.5 6 4 5z"/>
      <path d="m19 17 1 2.5 2.5.5-2.5 1-1 2.5-1-2.5-2.5-1 2.5-1z"/>
    </svg>
  );
}
