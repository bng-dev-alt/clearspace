import { Column } from '../../types/kanban';
import { kanbanService, Project } from '../kanbanService';

export interface ProjectSnapshot {
  projectId: string;
  projectName?: string;
  boardData: Column[] | null; // null if project didn't exist before the AI action
  projectsList: Project[] | null;
}

export interface AiHistoryRecord {
  id: string;
  timestamp: number;
  operationType: string; // 'AI Improve Task' | 'AI Generate Tasks' | 'AI Generate Project' | 'AI Sprint Planner'
  projectName: string;
  model: string;
  description: string;
  changesCount: number;
  snapshotBefore: ProjectSnapshot;
  // Extensibility properties:
  isFavorite?: boolean;
  notes?: string;
}

export const aiHistoryService = {
  // 1. Capture snapshot of project and board before action (Synchronous)
  captureSnapshot(
    projectId: string,
    boardData: Column[] | null,
    projectsList?: Project[] | null
  ): ProjectSnapshot {
    let projList = projectsList;
    if (!projList && typeof window !== 'undefined') {
      const stored = localStorage.getItem('kanban_projects');
      if (stored) {
        projList = JSON.parse(stored);
      }
    }

    let projectName = '';
    if (projList && projectId) {
      const found = projList.find((p) => p.id === projectId);
      if (found) {
        projectName = found.name;
      }
    }

    return {
      projectId: projectId || '',
      projectName,
      boardData: boardData ? JSON.parse(JSON.stringify(boardData)) : null, // deep copy
      projectsList: projList ? JSON.parse(JSON.stringify(projList)) : null, // deep copy
    };
  },

  // 2. Save a new history record (Synchronous)
  saveHistoryRecord(
    operationType: string,
    projectName: string,
    description: string,
    changesCount: number,
    snapshotBefore: ProjectSnapshot,
    model = 'gemini-3.5-flash'
  ): AiHistoryRecord {
    const record: AiHistoryRecord = {
      id: `history-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
      timestamp: Date.now(),
      operationType,
      projectName,
      model,
      description,
      changesCount,
      snapshotBefore,
    };

    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('ai_history');
      const history: AiHistoryRecord[] = stored ? JSON.parse(stored) : [];
      history.unshift(record);
      localStorage.setItem('ai_history', JSON.stringify(history));
    }

    return record;
  },

  // 3. Get all history records
  getHistory(): AiHistoryRecord[] {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('ai_history');
      return stored ? JSON.parse(stored) : [];
    }
    return [];
  },

  // 4. Restore snapshot -- jen jeden projekt, nikdy jiné projekty (viz kanbanService.restoreProjectSnapshot)
  async restore(recordId: string): Promise<void> {
    if (typeof window === 'undefined') return;

    const stored = localStorage.getItem('ai_history');
    if (!stored) throw new Error('Historie je prázdná.');

    const history: AiHistoryRecord[] = JSON.parse(stored);
    const record = history.find((r) => r.id === recordId);
    if (!record) throw new Error('Záznam historie nebyl nalezen.');
    const snapshot = record.snapshotBefore;

    // Pojistka: před přepsáním boardu uložit jeho AKTUÁLNÍ stav jako nový záznam,
    // aby se i samotná obnova dala vzít zpět.
    if (snapshot.boardData && snapshot.projectId) {
      const current = await kanbanService.fetchBoardData(snapshot.projectId);
      this.saveHistoryRecord(
        'Záloha před obnovou',
        snapshot.projectName || record.projectName,
        `Stav boardu těsně před obnovou záznamu "${record.description}"`,
        0,
        this.captureSnapshot(snapshot.projectId, current, null)
      );
    }

    await kanbanService.restoreProjectSnapshot(snapshot.projectId, snapshot.boardData);
    // Historie se NEmaže: záznamy zůstávají, takže jde postupovat i dál.
  },

  // 5. Toggle favorite status (for future extensions)
  toggleFavorite(recordId: string): AiHistoryRecord[] {
    if (typeof window === 'undefined') return [];
    const stored = localStorage.getItem('ai_history');
    if (!stored) return [];
    const history: AiHistoryRecord[] = JSON.parse(stored);
    const updated = history.map(r => r.id === recordId ? { ...r, isFavorite: !r.isFavorite } : r);
    localStorage.setItem('ai_history', JSON.stringify(updated));
    return updated;
  },

  // 6. Clear history
  clearHistory() {
    if (typeof window !== 'undefined') {
      localStorage.removeItem('ai_history');
    }
  }
};
export type { Column, Project };
