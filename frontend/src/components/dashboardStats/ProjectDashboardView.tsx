'use client';

import React, { useEffect, useState } from 'react';
import { Layers, CheckCircle2, HeartPulse } from 'lucide-react';
import type { Column, ProjectActivityLog, TeamMember } from '../../types/kanban';
import { collaborationService } from '../../services/collaborationService';
import { computeProjectIntelligence } from '../../lib/projectIntelligence';
import { computeCompletionStats, computeTeamWorkload, computeVelocity, computeBurndown } from '../../lib/dashboardStats';
import { MetricCard } from '../ui';
import TeamWorkloadWidget from './TeamWorkloadWidget';
import VelocityChart from './VelocityChart';
import BurndownChart from './BurndownChart';
import ExecutiveSummaryCard from './ExecutiveSummaryCard';

interface ProjectDashboardViewProps {
  projectId: string;
  projectName: string;
  columns: Column[];
  teamMembers: TeamMember[];
}

// Dost velký limit na to, aby velocity/burndown pokryly týdny zpět, ne
// jen posledních 50 záznamů (výchozí limit fetchActivities pro drawer).
const ACTIVITY_FETCH_LIMIT = 500;

export default function ProjectDashboardView({ projectId, projectName, columns, teamMembers }: ProjectDashboardViewProps) {
  const [activityLogs, setActivityLogs] = useState<ProjectActivityLog[]>([]);

  useEffect(() => {
    let active = true;
    if (!projectId) return;
    collaborationService
      .fetchActivities(projectId, ACTIVITY_FETCH_LIMIT)
      .then((rows) => {
        if (active) setActivityLogs(rows);
      })
      .catch(() => {
        if (active) setActivityLogs([]);
      });
    return () => {
      active = false;
    };
  }, [projectId]);

  const completion = computeCompletionStats(columns);
  const health = computeProjectIntelligence(columns).health;
  const workload = computeTeamWorkload(columns, teamMembers);
  const velocity = computeVelocity(activityLogs, 6);
  const burndown = computeBurndown(columns, activityLogs, 14);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', padding: '0 3rem 3rem 3rem' }} data-testid="project-dashboard-view">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(220px, 100%), 1fr))', gap: '1rem' }}>
        <MetricCard
          icon={<Layers size={18} />}
          label="Celkem úkolů"
          value={completion.total}
          hideTrail
          testId="dashboard-metric-total"
        />
        <MetricCard
          icon={<CheckCircle2 size={18} />}
          label="Dokončeno"
          value={`${completion.rate}%`}
          trend={`${completion.done} / ${completion.total}`}
          hideTrail
          testId="dashboard-metric-completion"
        />
        <MetricCard
          icon={<HeartPulse size={18} />}
          label="Zdraví projektu"
          value={health.label}
          danger={health.level === 'risk'}
          trend={health.reason}
          hideTrail
          testId="dashboard-metric-health"
        />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))', gap: '1rem' }}>
        <VelocityChart points={velocity} />
        <BurndownChart points={burndown} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))', gap: '1rem', alignItems: 'start' }}>
        <TeamWorkloadWidget entries={workload} />
        <ExecutiveSummaryCard columns={columns} projectName={projectName} />
      </div>
    </div>
  );
}
