import React from 'react';
import { Users } from 'lucide-react';
import { WorkloadEntry } from '../../lib/dashboardStats';
import { EmptyState } from '../ui';

interface TeamWorkloadWidgetProps {
  entries: WorkloadEntry[];
}

const LEVEL_LABEL: Record<WorkloadEntry['level'], string> = {
  overloaded: 'Přetížen(a)',
  balanced: 'V pohodě',
  light: 'Volná kapacita',
};

const LEVEL_COLOR: Record<WorkloadEntry['level'], string> = {
  overloaded: 'var(--danger)',
  balanced: 'var(--accent)',
  light: 'var(--text-muted)',
};

export default function TeamWorkloadWidget({ entries }: TeamWorkloadWidgetProps) {
  const maxCount = Math.max(...entries.map((e) => e.assignedCount), 1);

  return (
    <div className="cs-card" style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
        <span style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text)' }}>Vytížení týmu</span>
        <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>Otevřené úkoly na osobu (mimo Hotovo)</span>
      </div>

      {entries.length === 0 ? (
        <EmptyState icon={<Users size={22} />} title="Žádní členové" description="Projekt zatím nemá žádné přiřazené členy." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
          {entries.map((entry) => (
            <div key={entry.member.id} data-testid={`workload-row-${entry.member.id}`}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.3rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  <span
                    style={{
                      width: '20px',
                      height: '20px',
                      borderRadius: '50%',
                      backgroundColor: entry.member.avatarColor,
                      color: '#ffffff',
                      fontSize: '0.6rem',
                      fontWeight: 700,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    {entry.member.initials}
                  </span>
                  <span style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--text)' }}>{entry.member.fullName}</span>
                </div>
                <span style={{ fontSize: '0.68rem', fontWeight: 700, color: LEVEL_COLOR[entry.level] }}>
                  {LEVEL_LABEL[entry.level]}
                </span>
              </div>
              <div style={{ height: '8px', width: '100%', borderRadius: 'var(--radius-full)', backgroundColor: 'var(--surface-2)', overflow: 'hidden' }}>
                <div
                  style={{
                    height: '100%',
                    width: `${(entry.assignedCount / maxCount) * 100}%`,
                    backgroundColor: LEVEL_COLOR[entry.level],
                    transition: 'width 0.3s ease',
                  }}
                />
              </div>
              <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.25rem', fontSize: '0.68rem', color: 'var(--text-secondary)' }}>
                <span>{entry.assignedCount} úkolů</span>
                {entry.highPriorityCount > 0 && <span>{entry.highPriorityCount} vysoká priorita</span>}
                {entry.dueThisWeekCount > 0 && <span>{entry.dueThisWeekCount} termín tento týden</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
