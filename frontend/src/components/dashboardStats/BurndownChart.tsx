import React from 'react';
import { TrendingDown } from 'lucide-react';
import { BurndownPoint } from '../../lib/dashboardStats';
import { EmptyState } from '../ui';

interface BurndownChartProps {
  points: BurndownPoint[];
}

export default function BurndownChart({ points }: BurndownChartProps) {
  const maxRemaining = Math.max(...points.map((p) => p.remaining), 4);
  const n = Math.max(points.length - 1, 1);
  const hasAnyData = points.some((p) => p.remaining > 0);

  const pointAt = (idx: number) => {
    const x = (idx / n) * 88 + 6;
    const y = 120 - (points[idx].remaining / maxRemaining) * 110;
    return { x, y };
  };

  // Zobrazit jen každý druhý popisek data, aby se na 14 dnech nepřekrývaly.
  const labelStep = points.length > 10 ? 2 : 1;

  return (
    <div className="cs-card" style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
        <span style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text)' }}>Burndown</span>
        <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>Otevřené úkoly za posledních {points.length} dní</span>
      </div>

      <div style={{ height: '140px', width: '100%', position: 'relative' }}>
        <svg style={{ width: '100%', height: '100%', overflow: 'visible' }}>
          <line x1="0" y1="10" x2="100%" y2="10" stroke="var(--border)" strokeWidth="1" strokeDasharray="3" />
          <line x1="0" y1="65" x2="100%" y2="65" stroke="var(--border)" strokeWidth="1" strokeDasharray="3" />
          <line x1="0" y1="120" x2="100%" y2="120" stroke="var(--border)" strokeWidth="1" />

          {points.slice(1).map((_, i) => {
            const idx = i + 1;
            const from = pointAt(idx - 1);
            const to = pointAt(idx);
            return (
              <line
                key={idx}
                x1={`${from.x}%`}
                y1={from.y}
                x2={`${to.x}%`}
                y2={to.y}
                stroke="var(--accent)"
                strokeWidth="1.75"
                strokeLinecap="round"
              />
            );
          })}

          {points.map((point, idx) => {
            const { x, y } = pointAt(idx);
            return (
              <g key={idx}>
                <circle cx={`${x}%`} cy={y} r="2.5" fill="var(--accent)" />
                {idx % labelStep === 0 && (
                  <text x={`${x}%`} y="138" fontSize="9" fill="var(--text-secondary)" textAnchor="middle" fontWeight="600">
                    {point.dateLabel}
                  </text>
                )}
              </g>
            );
          })}
        </svg>

        {!hasAnyData && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
            <EmptyState icon={<TrendingDown size={22} />} title="Žádné otevřené úkoly" description="Board je prázdný nebo je vše hotovo." />
          </div>
        )}
      </div>
    </div>
  );
}
