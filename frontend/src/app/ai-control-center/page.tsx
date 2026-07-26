'use client';

import React, { useState, useEffect } from 'react';
import Navbar from '../../components/layout/Navbar';
import AiDashboardStats from '../../components/ai/AiDashboardStats';
import AiBudgetWidget from '../../components/ai/AiBudgetWidget';
import AiCharts from '../../components/ai/AiCharts';
import AiFeatureBreakdown from '../../components/ai/AiFeatureBreakdown';
import AiRequestHistory from '../../components/ai/AiRequestHistory';
import { aiAnalyticsService, AiStats, FeatureStats, AiRequestLog } from '../../services/ai/aiAnalyticsService';
import { Trash2, Cpu, ShieldAlert } from 'lucide-react';
import { useAuth } from '../../hooks/useAuth';

export default function AiControlCenterPage() {
  const { profile } = useAuth();
  const userRole = profile?.workspace_role || 'owner';
  const isAdminOrOwner = userRole === 'owner' || userRole === 'admin';
  const [stats, setStats] = useState<AiStats>({
    todayRequests: 0,
    todayTokens: 0,
    todayCostCzk: 0,
    averageResponseTime: 0,
    currentProvider: 'google',
    currentModel: 'gemini-3.5-flash',
  });

  const [featureBreakdown, setFeatureBreakdown] = useState<FeatureStats[]>([]);
  const [history, setHistory] = useState<AiRequestLog[]>([]);
  const [budgetLimit, setBudgetLimit] = useState(300);
  const [monthlyUsage, setMonthlyUsage] = useState(0);

  const loadData = async () => {
    const s = await aiAnalyticsService.getStats();
    const fb = await aiAnalyticsService.getFeatureBreakdown();
    const hist = await aiAnalyticsService.getHistory();
    const limit = aiAnalyticsService.getBudgetLimit();
    const usage = aiAnalyticsService.getMonthlyUsage();

    setStats(s);
    setFeatureBreakdown(fb);
    setHistory(hist);
    setBudgetLimit(limit);
    setMonthlyUsage(usage);
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadData();

    // Listen for custom events to refresh the UI in real-time
    window.addEventListener('ai_log_updated', loadData);
    return () => {
      window.removeEventListener('ai_log_updated', loadData);
    };
  }, []);

  const handleClearLogs = async () => {
    if (window.confirm('Opravdu chcete vymazat celou historii a statistiky AI dotazů?')) {
      await aiAnalyticsService.clearLogs();
      await loadData();
    }
  };

  const handleBudgetChange = (newLimit: number) => {
    aiAnalyticsService.setBudgetLimit(newLimit);
    setBudgetLimit(newLimit);
  };

  if (!isAdminOrOwner) {
    return (
      <div className="app-container" style={{ backgroundColor: 'var(--bg-page)' }}>
        <Navbar />
        <div style={{ textAlign: 'center', padding: '5rem 1.5rem', maxWidth: '500px', margin: '0 auto' }}>
          <ShieldAlert size={48} style={{ color: 'var(--purple-secondary)', marginBottom: '1rem' }} />
          <h2 style={{ fontSize: '1.3rem', fontWeight: 800, color: 'var(--dark-navy)' }}>Přístup vyhrazen pro Admina a Ownera</h2>
          <p style={{ fontSize: '0.85rem', color: 'var(--gray-text)', marginTop: '0.5rem' }}>
            Podstránka AI Studio je dostupná pouze pro administrátory a vlastníka workspace.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="app-container" style={{ backgroundColor: 'var(--bg-page)' }}>
      <Navbar />

      {/* Hero sekce ve stejném stylu jako ostatní stránky */}
      <section className="app-hero">
        <div className="hero-content">
          <div className="hero-left">
            <span className="hero-team-label">AI WORKSPACE</span>
            <h1 className="hero-title">AI Studio</h1>
            <p className="hero-desc">Sledování spotřeby tokenů, nákladů, latencí a ladění AI požadavků v reálném čase.</p>
          </div>
          <div className="hero-right" />
        </div>
      </section>

      <main style={{
        maxWidth: '1200px',
        margin: '0 auto',
        padding: '0.5rem 1.5rem 3rem 1.5rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '2rem',
        fontFamily: 'var(--font-sans)',
        width: '100%',
      }}>

        {/* Model + akce */}
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '1rem',
        }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.4rem',
            backgroundColor: 'var(--accent-soft)',
            color: 'var(--accent)',
            padding: '0.4rem 0.75rem',
            borderRadius: 'var(--radius-full)',
            fontSize: '0.75rem',
            fontWeight: 700,
          }}>
            <Cpu size={14} />
            <span>Aktivní model: {stats.currentModel.replace(/^models\//, '')}</span>
          </div>

          <button
            onClick={handleClearLogs}
            disabled={history.length === 0}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.4rem',
              backgroundColor: 'transparent',
              border: '1px solid var(--danger)',
              color: 'var(--danger)',
              padding: '0.4rem 0.75rem',
              borderRadius: 'var(--radius-button)',
              fontSize: '0.75rem',
              fontWeight: 600,
              cursor: history.length === 0 ? 'not-allowed' : 'pointer',
              opacity: history.length === 0 ? 0.5 : 1,
              transition: 'all 0.2s',
            }}
            onMouseEnter={(e) => {
              if (history.length > 0) {
                e.currentTarget.style.backgroundColor = 'var(--danger-soft)';
              }
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = 'transparent';
            }}
            className="ai-cc-clear-logs"
          >
            <Trash2 size={14} />
            Vymazat logy
          </button>
        </div>

        {/* 1. Stats Row */}
        <AiDashboardStats stats={stats} />

        {/* 2. Charts and Budget row */}
        {/* Layout v CSS (dřív inline), aby se dal na mobilu složit do jednoho
            sloupce -- na 375px mřížka přetékala ven z obrazovky. */}
        <div className="ai-cc-charts-grid">
          <div style={{ gridColumn: 'span 1' }}>
            <AiCharts logs={history} featureBreakdown={featureBreakdown} />
          </div>
          <div style={{ gridColumn: 'span 1' }}>
            <AiBudgetWidget
              monthlyUsage={monthlyUsage}
              budgetLimit={budgetLimit}
              onBudgetChange={handleBudgetChange}
            />
          </div>
        </div>

        {/* 3. Feature Breakdown Section */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <h2 style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--dark-navy)', margin: 0 }}>
            Spotřeba a cena podle AI modulů
          </h2>
          <AiFeatureBreakdown breakdown={featureBreakdown} />
        </div>

        {/* 4. History Log Section */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <h2 style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--dark-navy)', margin: 0 }}>
            Historie požadavků a ladění (Request Logs)
          </h2>
          <AiRequestHistory history={history} />
        </div>

      </main>
    </div>
  );
}
