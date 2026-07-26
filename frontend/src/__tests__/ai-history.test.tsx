import { describe, test, expect, vi, beforeEach } from 'vitest';
import { aiHistoryService } from '../services/ai/aiHistoryService';
import { kanbanService } from '../services/kanbanService';

// Mock the kanbanService
vi.mock('../services/kanbanService', () => {
  const mockProjects = [
    { id: 'proj-1', name: 'Projekt Jedna', created_at: '2026-07-18T10:00:00Z' }
  ];
  const mockBoardData = [
    {
      id: 'col-1',
      name: 'Sloupec 1',
      cards: [
        { id: 'card-1', title: 'Task 1', details: 'Details 1', priority: 'High' as const, archived: false }
      ]
    }
  ];

  return {
    kanbanService: {
      fetchProjects: vi.fn().mockResolvedValue(mockProjects),
      fetchProjectById: vi.fn().mockResolvedValue(mockProjects[0]),
      fetchBoardData: vi.fn().mockResolvedValue(mockBoardData),
      restoreProjectSnapshot: vi.fn().mockResolvedValue(undefined),
      deleteProject: vi.fn().mockResolvedValue(undefined)
    }
  };
});

describe('AI History & Restore Engine Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if (typeof window !== 'undefined') {
      localStorage.removeItem('ai_history');
      localStorage.removeItem('kanban_projects');
      localStorage.removeItem('kanban_board_proj-1');
    }
  });

  const mockProjList = [
    { id: 'proj-1', name: 'Projekt Jedna', created_at: '2026-07-18T10:00:00Z' }
  ];
  const mockBoardData = [
    {
      id: 'col-1',
      name: 'Sloupec 1',
      cards: [
        { id: 'card-1', title: 'Task 1', details: 'Details 1', priority: 'High' as const, archived: false }
      ]
    }
  ];

  test('captureSnapshot creates a deep copy of projects list and board data', () => {
    const snapshot = aiHistoryService.captureSnapshot('proj-1', mockBoardData, mockProjList);
    expect(snapshot.projectId).toBe('proj-1');
    expect(snapshot.projectName).toBe('Projekt Jedna');
    expect(snapshot.boardData).toBeDefined();
    expect(snapshot.boardData?.[0].name).toBe('Sloupec 1');
    expect(snapshot.projectsList?.[0].name).toBe('Projekt Jedna');
  });

  test('saveHistoryRecord stores history records correctly in localStorage', () => {
    const snapshot = aiHistoryService.captureSnapshot('proj-1', mockBoardData, mockProjList);
    const record = aiHistoryService.saveHistoryRecord(
      'AI Improve Task',
      'Projekt Jedna',
      'Zkušební popisek',
      1,
      snapshot,
      'gemini-3.5-flash'
    );

    expect(record.id).toBeDefined();
    expect(record.operationType).toBe('AI Improve Task');
    expect(record.changesCount).toBe(1);

    const historyList = aiHistoryService.getHistory();
    expect(historyList.length).toBe(1);
    expect(historyList[0].id).toBe(record.id);
  });

  test('restore calls restoreProjectSnapshot and truncates subsequent history', async () => {
    const snapshot1 = aiHistoryService.captureSnapshot('proj-1', mockBoardData, mockProjList);
    const record1 = aiHistoryService.saveHistoryRecord(
      'AI Improve Task',
      'Projekt Jedna',
      'Změna 1',
      1,
      snapshot1
    );

    const snapshot2 = aiHistoryService.captureSnapshot('proj-1', mockBoardData, mockProjList);
    aiHistoryService.saveHistoryRecord(
      'AI Generate Tasks',
      'Projekt Jedna',
      'Změna 2',
      5,
      snapshot2
    );

    // Timeline descending: [record2, record1]
    expect(aiHistoryService.getHistory().length).toBe(2);

    // Restore to record1: should rollback to state before record1 and remove record1 & record2 from timeline
    await aiHistoryService.restore(record1.id);

    expect(kanbanService.restoreProjectSnapshot).toHaveBeenCalledWith(
      snapshot1.projectId,
      snapshot1.boardData,
      snapshot1.projectsList
    );

    // History list should now be completely empty (since record1 was the oldest and both were truncated)
    expect(aiHistoryService.getHistory().length).toBe(0);
  });

  test('toggleFavorite toggles the isFavorite property of a history record', () => {
    const snapshot = aiHistoryService.captureSnapshot('proj-1', mockBoardData, mockProjList);
    const record = aiHistoryService.saveHistoryRecord(
      'AI Sprint Planner',
      'Projekt Jedna',
      'Změna 1',
      2,
      snapshot
    );

    expect(record.isFavorite).toBeUndefined();

    const updated = aiHistoryService.toggleFavorite(record.id);
    expect(updated[0].isFavorite).toBe(true);

    const updated2 = aiHistoryService.toggleFavorite(record.id);
    expect(updated2[0].isFavorite).toBe(false);
  });
});
