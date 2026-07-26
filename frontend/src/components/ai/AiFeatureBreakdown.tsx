import React from 'react';
import { BarChart2 } from 'lucide-react';
import { FeatureStats } from '../../services/ai/aiAnalyticsService';
import { aiCostEstimator } from '../../services/ai/aiCostEstimator';
import { EmptyState } from '../ui';

interface AiFeatureBreakdownProps {
  breakdown: FeatureStats[];
}

export default function AiFeatureBreakdown({ breakdown }: AiFeatureBreakdownProps) {
  if (breakdown.length === 0) {
    return (
      <div style={{ border: '1px dashed var(--border-strong)', borderRadius: 'var(--radius-card)' }}>
        <EmptyState
          icon={<BarChart2 size={22} />}
          title="Zatím žádná data"
          description="Jakmile spustíte nějakou AI akci na boardu, tady se objeví rozpad podle jednotlivých funkcí."
        />
      </div>
    );
  }

  return (
    <div style={{ width: '100%', overflowX: 'auto', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-card)' }}>
      <table style={{
        width: '100%',
        borderCollapse: 'collapse',
        textAlign: 'left',
        fontSize: '0.8rem',
        fontFamily: 'var(--font-sans)',
      }}>
        <thead>
          <tr style={{ backgroundColor: 'var(--surface-2)', borderBottom: '1px solid var(--border-color)' }}>
            <th style={{ padding: '0.75rem 1rem', fontWeight: 700, color: 'var(--dark-navy)' }}>AI Funkce</th>
            <th style={{ padding: '0.75rem 1rem', fontWeight: 700, color: 'var(--dark-navy)' }}>Počet volání</th>
            <th style={{ padding: '0.75rem 1rem', fontWeight: 700, color: 'var(--dark-navy)' }}>Vstupní tokeny</th>
            <th style={{ padding: '0.75rem 1rem', fontWeight: 700, color: 'var(--dark-navy)' }}>Výstupní tokeny</th>
            <th style={{ padding: '0.75rem 1rem', fontWeight: 700, color: 'var(--dark-navy)' }}>Celkem tokenů</th>
            <th style={{ padding: '0.75rem 1rem', fontWeight: 700, color: 'var(--dark-navy)' }}>Prům. latence</th>
            <th style={{ padding: '0.75rem 1rem', fontWeight: 700, color: 'var(--dark-navy)', textAlign: 'right' }}>Celková cena</th>
          </tr>
        </thead>
        <tbody>
          {breakdown.map((item, idx) => (
            <tr
              key={idx}
              style={{
                borderBottom: idx === breakdown.length - 1 ? 'none' : '1px solid var(--border-color)',
                transition: 'background-color 0.2s',
              }}
              onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--surface-2)'}
              onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
            >
              <td style={{ padding: '0.75rem 1rem', fontWeight: 600, color: 'var(--dark-navy)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  <span style={{
                    width: '6px',
                    height: '6px',
                    borderRadius: '50%',
                    backgroundColor: item.featureName.includes('Project')
                      ? 'var(--accent)'
                      : item.featureName.includes('Tasks')
                        ? 'var(--warning)'
                        : '#8b7fc7'
                  }} />
                  {item.featureName}
                </div>
              </td>
              <td style={{ padding: '0.75rem 1rem', color: 'var(--dark-navy)' }}>{item.requestCount}x</td>
              <td style={{ padding: '0.75rem 1rem', color: 'var(--gray-text)' }}>{item.inputTokens.toLocaleString()}</td>
              <td style={{ padding: '0.75rem 1rem', color: 'var(--gray-text)' }}>{item.outputTokens.toLocaleString()}</td>
              <td style={{ padding: '0.75rem 1rem', color: 'var(--dark-navy)' }}>{item.totalTokens.toLocaleString()}</td>
              <td style={{ padding: '0.75rem 1rem', color: 'var(--gray-text)' }}>
                {(item.averageResponseTime / 1000).toFixed(2)} s
              </td>
              <td style={{ padding: '0.75rem 1rem', fontWeight: 700, color: 'var(--dark-navy)', textAlign: 'right' }}>
                {aiCostEstimator.formatCostCzk(item.estimatedCostCzk)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
