import React from 'react';
import { Zap } from 'lucide-react';
import { VelocityPoint } from '../../lib/dashboardStats';
import { EmptyState } from '../ui';

interface VelocityChartProps {
  points: VelocityPoint[];
}

export default function VelocityChart({ points }: VelocityChartProps) {
  const total = points.reduce((sum, p) => sum + p.completed, 0);
  const maxCompleted = Math.max(...points.map((p) => p.completed), 4);
  const n = Math.max(points.length - 1, 1);

  return (
    <div className="cs-card" style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
        <span style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text)' }}>Velocity</span>
        <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>Dokončené úkoly za týden (posledních {points.length} týdnů)</span>
      </div>

      <div style={{ height: '140px', width: '100%', position: 'relative' }}>
        <svg style={{ width: '100%', height: '100%', overflow: 'visible' }}>
          <line x1="0" y1="0" x2="100%" y2="0" stroke="var(--border)" strokeWidth="1" strokeDasharray="3" />
          <line x1="0" y1="60" x2="100%" y2="60" stroke="var(--border)" strokeWidth="1" strokeDasharray="3" />
          <line x1="0" y1="120" x2="100%" y2="120" stroke="var(--border)" strokeWidth="1" />

          {points.map((point, idx) => {
            const xPercent = (idx / n) * 88 + 6;
            const barHeight = (point.completed / maxCompleted) * 100;
            const yPos = 120 - barHeight;
            return (
              <g key={idx}>
                <rect
                  x={`${xPercent - 2.5}%`}
                  y={yPos}
                  width="5%"
                  height={barHeight}
                  rx="4"
                  fill={point.completed > 0 ? 'var(--accent)' : 'var(--surface-3)'}
                />
                <text x={`${xPercent}%`} y="138" fontSize="9" fill="var(--text-secondary)" textAnchor="middle" fontWeight="600">
                  {point.weekLabel}
                </text>
                {point.completed > 0 && (
                  <text x={`${xPercent}%`} y={yPos - 6} fontSize="9" fill="var(--text)" textAnchor="middle" fontWeight="700">
                    {point.completed}
                  </text>
                )}
              </g>
            );
          })}
        </svg>

        {total === 0 && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
            <EmptyState icon={<Zap size={22} />} title="Zatím žádná dokončená práce" description="Jakmile přesunete kartu do sloupce Hotovo, objeví se tady." />
          </div>
        )}
      </div>
    </div>
  );
}
