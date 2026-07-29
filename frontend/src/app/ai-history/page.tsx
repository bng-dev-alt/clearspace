'use client';

import React, { useState, useEffect } from 'react';
import Navbar from '../../components/layout/Navbar';
import { EmptyState } from '../../components/ui';
import { aiHistoryService, AiHistoryRecord } from '../../services/ai/aiHistoryService';
import { kanbanService } from '../../services/kanbanService';
import { Clock, Sparkles, Folder, RotateCcw, AlertTriangle, Star, BarChart2, Eye, Download, Info, Check, Trash2, ShieldAlert } from 'lucide-react';
import { useAuth } from '../../hooks/useAuth';

export default function AiHistoryPage() {
  const { user, profile } = useAuth();
  const userRole = profile?.workspace_role || 'owner';
  const isAdminOrOwner = userRole === 'owner' || userRole === 'admin';
  const [history, setHistory] = useState<AiHistoryRecord[]>([]);
  const [selectedRecord, setSelectedRecord] = useState<AiHistoryRecord | null>(null);
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Obnovení stavu je destruktivní bulk-přepis boardu -- na sdíleném
  // projektu (Team Collaboration v1.3) ho smí spustit jen vlastník
  // projektu, ne kdokoliv, kdo na svém zařízení náhodou má lokální
  // AI History záznam pro cizí projekt (viz [[58_collaboration_analysis_and_plan]]).
  const [projectOwners, setProjectOwners] = useState<Record<string, string | undefined>>({});
  useEffect(() => {
    kanbanService.fetchProjects(user?.id).then((projects) => {
      const map: Record<string, string | undefined> = {};
      projects.forEach((p) => { map[p.id] = p.user_id; });
      setProjectOwners(map);
    }).catch(() => {});
  }, [user?.id]);

  const canRestore = (projectId: string) => {
    const ownerId = projectOwners[projectId];
    return !ownerId || ownerId === user?.id;
  };

  // Load history records
  const loadHistory = () => {
    const data = aiHistoryService.getHistory();
    setHistory(data);
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadHistory();
  }, []);

  const handleRestoreClick = (record: AiHistoryRecord) => {
    setSelectedRecord(record);
    setIsConfirmOpen(true);
  };

  const handleConfirmRestore = async () => {
    if (!selectedRecord) return;
    try {
      await aiHistoryService.restore(selectedRecord.id);
      setSuccessMessage(`Stav projektu "${selectedRecord.projectName}" byl úspěšně obnoven.`);
      setIsConfirmOpen(false);
      setSelectedRecord(null);
      loadHistory();
      
      // Auto-dismiss success message
      setTimeout(() => {
        setSuccessMessage(null);
      }, 5000);
    } catch (e: unknown) {
      const error = e as Error;
      alert(`Nepodařilo se provést obnovu: ${error.message}`);
    }
  };

  const handleToggleFavorite = (recordId: string) => {
    const updated = aiHistoryService.toggleFavorite(recordId);
    setHistory(updated);
  };

  const getIcon = (type: string) => {
    switch (type) {
      case 'AI Sprint Planner':
        return <Sparkles size={18} style={{ color: 'var(--accent)' }} />;
      case 'AI Generate Project':
        return <Folder size={18} style={{ color: 'var(--purple-secondary)' }} />;
      case 'AI Improve Task':
        return <BarChart2 size={18} style={{ color: 'var(--success)' }} />;
      case 'AI Generate Tasks':
        return <Sparkles size={18} style={{ color: 'var(--warning)' }} />;
      default:
        return <Clock size={18} style={{ color: 'var(--gray-text)' }} />;
    }
  };

  if (!isAdminOrOwner) {
    return (
      <div className="app-container" style={{ backgroundColor: 'var(--bg-page)' }}>
        <Navbar />
        <div style={{ textAlign: 'center', padding: '5rem 1.5rem', maxWidth: '500px', margin: '0 auto' }}>
          <ShieldAlert size={48} style={{ color: 'var(--purple-secondary)', marginBottom: '1rem' }} />
          <h2 style={{ fontSize: '1.3rem', fontWeight: 800, color: 'var(--dark-navy)' }}>Přístup vyhrazen pro Admina a Ownera</h2>
          <p style={{ fontSize: '0.85rem', color: 'var(--gray-text)', marginTop: '0.5rem' }}>
            Podstránka AI History je dostupná pouze pro administrátory a vlastníka workspace.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="app-container" style={{ backgroundColor: 'var(--bg-page)' }}>
      <Navbar />

      {/* Hero section (sjednocené s ostatními stránkami) */}
      <section className="app-hero">
        <div className="hero-content">
          <div className="hero-left">
            <span className="hero-team-label">SYSTÉMOVÉ LOGY</span>
            <h1 className="hero-title">AI History</h1>
            <p className="hero-desc">Plně vratná historie AI operací — obnovte stav boardu před danou změnou.</p>
          </div>
          <div className="hero-right" />
        </div>
      </section>

      {/* Main Container */}
      <main style={{ padding: '0.5rem 3rem 4rem 3rem', maxWidth: '1000px', margin: '0 auto', width: '100%' }}>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '1.5rem' }}>
          <button
            onClick={() => {
              if (confirm('Opravdu chcete smazat celou historii operací?')) {
                aiHistoryService.clearHistory();
                loadHistory();
              }
            }}
            disabled={history.length === 0}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.4rem',
              background: 'none',
              border: '1px solid var(--danger)',
              borderRadius: 'var(--radius)',
              padding: '0.45rem 0.85rem',
              fontSize: '0.78rem',
              fontWeight: 600,
              color: 'var(--danger)',
              cursor: history.length === 0 ? 'not-allowed' : 'pointer',
              opacity: history.length === 0 ? 0.5 : 1,
              transition: 'all 0.2s',
            }}
            onMouseEnter={(e) => { if (history.length > 0) e.currentTarget.style.backgroundColor = 'var(--danger-soft)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
            className="ai-cc-clear-logs"
          >
            <Trash2 size={14} />
            Vymazat historii
          </button>
        </div>

        {successMessage && (
          <div style={{
            backgroundColor: 'var(--success-soft)',
            color: 'var(--success)',
            padding: '1rem 1.5rem',
            borderRadius: 'var(--radius)',
            marginBottom: '2rem',
            fontSize: '0.82rem',
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            gap: '0.6rem',
            border: '1px solid var(--success)',
            boxShadow: 'var(--shadow-sm)'
          }}>
            <Check size={18} />
            {successMessage}
          </div>
        )}

        {history.length === 0 ? (
          <div style={{ border: '1px dashed var(--border-strong)', borderRadius: 'var(--radius-card)', padding: '2rem 0' }}>
            <EmptyState
              icon={<Clock size={22} />}
              title="Žádné AI operace"
              description="Historie je prázdná. Jakmile použijete jakoukoliv z AI funkcí k úpravě boardu, záznamy se objeví zde."
            />
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', position: 'relative' }}>
            
            {/* Vertical timeline line overlay */}
            <div style={{
              position: 'absolute',
              left: '23px',
              top: '1rem',
              bottom: '1rem',
              width: '2px',
              backgroundColor: 'var(--border-color)',
              zIndex: 0
            }} />

            {history.map((record) => (
              <div
                key={record.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '50px 1fr',
                  gap: '1.5rem',
                  marginBottom: '2rem',
                  position: 'relative',
                  zIndex: 1
                }}
              >
                {/* Timeline Icon Badge */}
                <div style={{
                  width: '48px',
                  height: '48px',
                  borderRadius: '50%',
                  backgroundColor: 'var(--surface)',
                  border: '2px solid var(--border-color)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  boxShadow: 'var(--shadow-sm)'
                }}>
                  {getIcon(record.operationType)}
                </div>

                {/* Timeline Card */}
                <div style={{
                  backgroundColor: 'var(--surface)',
                  border: '1px solid var(--border-color)',
                  borderRadius: 'var(--radius-card)',
                  padding: '1.5rem',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.75rem',
                  boxShadow: 'var(--shadow-sm)',
                  transition: 'var(--transition-base)',
                }}
                className="timeline-card"
                >
                  {/* Top Bar inside Card */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                      <span style={{ fontSize: '0.68rem', color: 'var(--gray-text)', fontWeight: 600 }}>
                        {new Date(record.timestamp).toLocaleString('cs-CZ')}
                      </span>
                      <h3 style={{ fontSize: '1rem', fontWeight: 800, color: 'var(--dark-navy)', margin: 0 }}>
                        {record.operationType}
                      </h3>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      {/* Favorite Button (Extensibility feature) */}
                      <button
                        type="button"
                        onClick={() => handleToggleFavorite(record.id)}
                        style={{
                          background: 'none',
                          border: 'none',
                          cursor: 'pointer',
                          color: record.isFavorite ? 'var(--warning)' : 'var(--gray-text)',
                          padding: '4px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          transition: 'color 0.2s'
                        }}
                        title={record.isFavorite ? 'Odebrat z oblíbených' : 'Označit jako oblíbenou verzi'}
                        data-testid={`fav-btn-${record.id}`}
                      >
                        <Star size={16} fill={record.isFavorite ? 'var(--warning)' : 'none'} />
                      </button>

                      {/* Restore Action Button -- jen vlastník projektu (bulk přepis boardu je destruktivní pro spolupracovníky) */}
                      <button
                        type="button"
                        onClick={() => canRestore(record.snapshotBefore.projectId) && handleRestoreClick(record)}
                        disabled={!canRestore(record.snapshotBefore.projectId)}
                        title={canRestore(record.snapshotBefore.projectId) ? undefined : 'Obnovit smí jen vlastník projektu -- přepsal by board ostatním spolupracovníkům.'}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.35rem',
                          background: canRestore(record.snapshotBefore.projectId) ? 'var(--purple-secondary)' : 'var(--border-color)',
                          color: canRestore(record.snapshotBefore.projectId) ? '#ffffff' : 'var(--gray-text)',
                          border: 'none',
                          borderRadius: 'var(--radius-button)',
                          padding: '0.4rem 0.85rem',
                          fontSize: '0.75rem',
                          fontWeight: 700,
                          cursor: canRestore(record.snapshotBefore.projectId) ? 'pointer' : 'not-allowed',
                          boxShadow: 'var(--shadow-sm)',
                          transition: 'var(--transition-base)',
                        }}
                        data-testid={`restore-btn-${record.id}`}
                        onMouseEnter={(e) => {
                          if (!canRestore(record.snapshotBefore.projectId)) return;
                          e.currentTarget.style.filter = 'brightness(1.1)';
                          e.currentTarget.style.transform = 'translateY(-1px)';
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.filter = 'none';
                          e.currentTarget.style.transform = 'translateY(0)';
                        }}
                      >
                        <RotateCcw size={13} />
                        Obnovit
                      </button>
                    </div>
                  </div>

                  {/* Summary / Description */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', borderTop: '1px solid var(--border-color)', paddingTop: '0.75rem', fontSize: '0.8rem', lineHeight: '1.4' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', color: 'var(--dark-navy)', fontWeight: 600 }}>
                      <Folder size={14} style={{ color: 'var(--blue-primary)' }} />
                      Projekt: {record.projectName}
                    </div>
                    <p style={{ color: 'var(--gray-text)', margin: 0 }}>
                      {record.description}
                    </p>
                  </div>

                  {/* Badges / Tech Metadata */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.68rem', color: 'var(--gray-text)', paddingTop: '0.25rem' }}>
                    <div style={{ display: 'flex', gap: '0.8rem' }}>
                      <span>Model: <code style={{ backgroundColor: 'rgba(0,0,0,0.04)', padding: '2px 4px', borderRadius: '4px' }}>{record.model}</code></span>
                      <span>Změny: <strong style={{ color: 'var(--dark-navy)' }}>{record.changesCount}</strong></span>
                    </div>

                    {/* Architecture / Future Extensibility elements */}
                    <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center' }}>
                      <span 
                        style={{ display: 'flex', alignItems: 'center', gap: '0.2rem', cursor: 'not-allowed', color: 'var(--border)' }} 
                        title="Budoucí funkce: Porovnání verzí"
                      >
                        <Eye size={12} />
                        Compare
                      </span>
                      <span 
                        style={{ display: 'flex', alignItems: 'center', gap: '0.2rem', cursor: 'not-allowed', color: 'var(--border)' }} 
                        title="Budoucí funkce: Zobrazení rozdílů"
                      >
                        <Info size={12} />
                        Diff
                      </span>
                      <span 
                        style={{ display: 'flex', alignItems: 'center', gap: '0.2rem', cursor: 'not-allowed', color: 'var(--border)' }} 
                        title="Budoucí funkce: Export historie"
                      >
                        <Download size={12} />
                        Export
                      </span>
                    </div>
                  </div>

                </div>
              </div>
            ))}

          </div>
        )}

      </main>

      {/* Confirmation Dialog Modal */}
      {isConfirmOpen && selectedRecord && (
        <div className="modal-overlay" onClick={() => setIsConfirmOpen(false)} style={{ zIndex: 1200 }}>
          <div
            className="modal-content"
            onClick={(e) => e.stopPropagation()}
            style={{ width: '100%', maxWidth: '460px', padding: '1.5rem' }}
            role="dialog"
            aria-modal="true"
          >
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '1rem', marginBottom: '1.25rem' }}>
              <div style={{ backgroundColor: 'var(--warning-soft)', color: 'var(--warning)', padding: '0.6rem', borderRadius: '50%', flexShrink: 0 }}>
                <AlertTriangle size={24} />
              </div>
              <div>
                <h3 style={{ fontSize: '1.05rem', fontWeight: 800, color: 'var(--dark-navy)', margin: '0 0 0.5rem 0' }}>
                  Potvrdit obnovení verze
                </h3>
                <p style={{ fontSize: '0.8rem', color: 'var(--gray-text)', lineHeight: '1.5', margin: 0 }}>
                  Opravdu chcete obnovit projekt do stavu před touto AI operací? 
                  <strong> Budou zrušeny všechny pozdější AI změny.</strong>
                </p>
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', borderTop: '1px solid var(--border-color)', paddingTop: '1rem' }}>
              <button
                type="button"
                className="btn btn-cancel"
                onClick={() => setIsConfirmOpen(false)}
              >
                Zrušit
              </button>
              <button
                type="button"
                className="btn btn-submit"
                style={{ backgroundColor: 'var(--purple-secondary)', color: '#ffffff' }}
                onClick={handleConfirmRestore}
                data-testid="confirm-restore-btn"
              >
                Ano, obnovit
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Local animation style definition */}
      <style jsx global>{`
        .timeline-card:hover {
          transform: translateY(-2px);
          box-shadow: var(--shadow-md) !important;
        }
      `}</style>
    </div>
  );
}
