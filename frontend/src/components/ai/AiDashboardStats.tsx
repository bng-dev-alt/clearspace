import React from 'react';
import { aiCostEstimator } from '../../services/ai/aiCostEstimator';
import { AiStats } from '../../services/ai/aiAnalyticsService';
import { Activity, Cpu, Coins, Clock } from 'lucide-react';
import { MetricCard } from '../ui';

interface AiDashboardStatsProps {
  stats: AiStats;
}

export default function AiDashboardStats({ stats }: AiDashboardStatsProps) {
  const cards = [
    {
      title: 'Požadavky dnes',
      value: stats.todayRequests,
      icon: <Activity size={20} />,
      desc: 'Úspěšně zpracované požadavky',
    },
    {
      title: 'Spotřebované tokeny dnes',
      value: stats.todayTokens.toLocaleString('cs-CZ'),
      icon: <Cpu size={20} />,
      desc: 'Vstup + výstup podle serverového záznamu',
    },
    {
      title: 'Odhadované náklady dnes',
      value: aiCostEstimator.formatCostCzk(stats.todayCostCzk),
      icon: <Coins size={20} />,
      desc: 'Odhad z tokenů a ceníku (ne faktura)',
    },
    {
      title: 'Průměrná doba odezvy',
      value: stats.averageResponseTime > 0
        ? `${(stats.averageResponseTime / 1000).toLocaleString('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} s`
        : '—',
      icon: <Clock size={20} />,
      desc: 'Průměrná doba odpovědi AI'
    },
  ];

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem', width: '100%' }}>
      {cards.map((card, idx) => (
        <MetricCard
          key={idx}
          icon={card.icon}
          label={card.title}
          value={card.value}
          trend={card.desc}
          hideTrail
        />
      ))}
    </div>
  );
}
