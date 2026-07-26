import React from 'react';
import { PieChart } from 'lucide-react';
import { AiRequestLog, FeatureStats } from '../../services/ai/aiAnalyticsService';
import { EmptyState } from '../ui';

interface AiChartsProps {
  logs: AiRequestLog[];
  featureBreakdown: FeatureStats[];
}

// Tlumená kategoriální paleta (Design Bible: muted colors). Funguje v Dark i Light.
const DIST_COLORS = ['var(--accent)', 'var(--warning)', '#8b7fc7', 'var(--text-muted)'];

const CARD_STYLE: React.CSSProperties = {
  padding: '1.25rem',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.85rem',
};

export default function AiCharts({ logs, featureBreakdown }: AiChartsProps) {
  // 1. Prepare data for the last 7 days (including today)
  const last7Days = Array.from({ length: 7 }).map((_, idx) => {
    const d = new Date();
    d.setDate(d.getDate() - (6 - idx));
    return {
      dateStr: d.toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric' }),
      dateKey: d.toDateString(),
      requests: 0,
      tokens: 0,
      cost: 0,
    };
  });

  logs.forEach(log => {
    const logDateKey = new Date(log.timestamp).toDateString();
    const dayBucket = last7Days.find(day => day.dateKey === logDateKey);
    if (dayBucket) {
      dayBucket.requests += 1;
      dayBucket.tokens += log.totalTokens || 0;
      dayBucket.cost += log.estimatedCostCzk || 0;
    }
  });

  // Scale for Daily Requests
  const maxRequests = Math.max(...last7Days.map(d => d.requests), 4);
  const totalRequests = last7Days.reduce((sum, d) => sum + d.requests, 0);
  const maxCost = Math.max(...last7Days.map(d => d.cost), 0.01);

  // Souvislá spojnice nákladů (Etapa 7: "dej sparklinu stejnou péči jako
  // typografii" -- rozptýlené tečky teď spojuje jedna linka přes celý
  // týden, ne jen izolované body u dnů s nenulovým nákladem).
  //
  // Segmenty <line>, ne <polyline points="...">: polyline potřebuje čistá
  // čísla, takže by graf musel dostat viewBox. Ten by ale s
  // preserveAspectRatio="none" nerovnoměrně natáhl X/Y osu vůči
  // skutečnému (širokému) poměru stran karty -- přesně to předtím
  // roztahovalo rx na sloupcích do kapslí a text do nečitelné změti.
  // <line> podporuje procenta v x1/x2 stejně jako zbytek grafu (viz
  // mřížka níž), takže žádný viewBox není potřeba.
  const costLinePoint = (idx: number) => {
    const x = (idx / 6) * 88 + 6;
    const y = 120 - Math.min((last7Days[idx].cost / maxCost) * 90, 90);
    return { x, y };
  };

  // 2. Prepare feature distribution stacked bar
  const totalFeatureRequests = featureBreakdown.reduce((sum, f) => sum + f.requestCount, 0);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))', gap: '1rem', width: '100%' }}>

      {/* Chart 1: Daily Requests & Cost */}
      <div className="cs-card" style={CARD_STYLE}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
          <span style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text)' }}>Denní aktivita</span>
          <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>Počet požadavků za posledních 7 dní</span>
        </div>

        <div style={{ height: '140px', width: '100%', position: 'relative', marginTop: '0.5rem' }}>
          <svg style={{ width: '100%', height: '100%', overflow: 'visible' }}>
            {/* Grid lines */}
            <line x1="0" y1="0" x2="100%" y2="0" stroke="var(--border)" strokeWidth="1" strokeDasharray="3" />
            <line x1="0" y1="60" x2="100%" y2="60" stroke="var(--border)" strokeWidth="1" strokeDasharray="3" />
            <line x1="0" y1="120" x2="100%" y2="120" stroke="var(--border)" strokeWidth="1" />

            {/* Spojnice nákladů -- souvislá linka přes celý týden, tečky
                jen zvýrazňují dny se skutečným nákladem (emphasized endpoint). */}
            {totalRequests > 0 && last7Days.slice(1).map((_, i) => {
              const idx = i + 1;
              const from = costLinePoint(idx - 1);
              const to = costLinePoint(idx);
              return (
                <line
                  key={idx}
                  x1={`${from.x}%`}
                  y1={from.y}
                  x2={`${to.x}%`}
                  y2={to.y}
                  stroke="var(--warning)"
                  strokeWidth="1.25"
                  strokeOpacity="0.55"
                  strokeLinecap="round"
                />
              );
            })}

            {/* Render Bars */}
            {last7Days.map((day, idx) => {
              const xPercent = (idx / 6) * 88 + 6; // range from 6% to 94%
              const barHeight = (day.requests / maxRequests) * 100; // max height 100px
              const yPos = 120 - barHeight;
              const costY = 120 - Math.min((day.cost / maxCost) * 90, 90);

              return (
                <g key={idx}>
                  {/* Background tracking hover area */}
                  <rect
                    x={`${xPercent - 4}%`}
                    y="0"
                    width="8%"
                    height="120"
                    fill="transparent"
                    style={{ cursor: 'pointer' }}
                  />
                  {/* Request bar */}
                  <rect
                    x={`${xPercent - 2.5}%`}
                    y={yPos}
                    width="5%"
                    height={barHeight}
                    rx="4"
                    fill={day.requests > 0 ? 'var(--accent)' : 'var(--surface-3)'}
                    style={{ transition: 'all 0.3s ease' }}
                  />
                  {/* Cost Indicator Dot */}
                  {day.cost > 0 && (
                    <circle
                      cx={`${xPercent}%`}
                      cy={costY}
                      r="3"
                      fill="var(--warning)"
                    />
                  )}
                  {/* Date text */}
                  <text
                    x={`${xPercent}%`}
                    y="138"
                    fontSize="9"
                    fill="var(--text-secondary)"
                    textAnchor="middle"
                    fontWeight="600"
                  >
                    {day.dateStr}
                  </text>
                  {/* Request value label on top of bar */}
                  {day.requests > 0 && (
                    <text
                      x={`${xPercent}%`}
                      y={yPos - 6}
                      fontSize="9"
                      fill="var(--text)"
                      textAnchor="middle"
                      fontWeight="700"
                    >
                      {day.requests}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>

          {/* Prázdný stav: bez jediného požadavku za celý týden zůstávaly
              sloupce jen tichým řádkem šedých duchů bez vysvětlení. */}
          {totalRequests === 0 && (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                pointerEvents: 'none',
              }}
            >
              <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: 600 }}>
                Zatím žádná aktivita v tomto týdnu
              </span>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: '1rem', fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
            <span style={{ width: '8px', height: '8px', borderRadius: '2px', backgroundColor: 'var(--accent)' }} />
            <span>AI Požadavky</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
            <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: 'var(--warning)' }} />
            <span>Náklady (CZK)</span>
          </div>
        </div>
      </div>

      {/* Chart 2: Feature Distribution */}
      <div className="cs-card" style={CARD_STYLE}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
          <span style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text)' }}>Distribuce AI funkcí</span>
          <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>Poměr a celková spotřeba podle modulů</span>
        </div>

        {totalFeatureRequests === 0 ? (
          <div style={{ minHeight: '140px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <EmptyState
              icon={<PieChart size={22} />}
              title="Zatím žádná data"
              description="Jakmile použijete některou z AI funkcí, uvidíte tu poměr spotřeby mezi moduly."
            />
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem', justifyContent: 'center', height: '100%' }}>
            {/* Render a stacked distribution bar */}
            <div style={{
              height: '16px',
              width: '100%',
              display: 'flex',
              borderRadius: 'var(--radius-full)',
              overflow: 'hidden',
              backgroundColor: 'var(--surface-2)',
            }}>
              {featureBreakdown.map((item, idx) => {
                const percentage = (item.requestCount / totalFeatureRequests) * 100;
                const color = DIST_COLORS[idx % DIST_COLORS.length];
                return (
                  <div
                    key={idx}
                    style={{
                      width: `${percentage}%`,
                      backgroundColor: color,
                      height: '100%',
                      transition: 'width 0.3s ease',
                    }}
                    title={`${item.featureName}: ${item.requestCount} requestů (${percentage.toFixed(1)}%)`}
                  />
                );
              })}
            </div>

            {/* List breakdown with colors */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', marginTop: '0.25rem' }}>
              {featureBreakdown.map((item, idx) => {
                const percentage = (item.requestCount / totalFeatureRequests) * 100;
                const color = DIST_COLORS[idx % DIST_COLORS.length];
                return (
                  <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.72rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: 'var(--text)' }}>
                      <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: color }} />
                      <span>{item.featureName}</span>
                    </div>
                    <div style={{ display: 'flex', gap: '0.5rem', color: 'var(--text-secondary)', fontWeight: 600 }}>
                      <span>{item.requestCount}x</span>
                      <span>({percentage.toFixed(0)}%)</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

    </div>
  );
}
