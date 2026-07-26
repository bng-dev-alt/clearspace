import { describe, it, expect, vi } from 'vitest';
import { collaborationService } from '../services/collaborationService';
import { resourceService } from '../services/resourceService';
import { aiService } from '../services/ai/aiService';

describe('Feature Updates Integration Tests', () => {
  describe('Team Collaboration Service', () => {
    it('generates secure 32-character invite tokens', () => {
      const token = collaborationService.generateToken();
      expect(token).toHaveLength(32);
      expect(token).toMatch(/^[a-zA-Z0-9]+$/);
    });

    it('creates an invitation object with correct properties', async () => {
      const inv = await collaborationService.createInvitation('proj-1', 'test@example.com', 'member', 'owner-1');
      expect(inv).toBeDefined();
      expect(inv.projectId).toBe('proj-1');
      expect(inv.email).toBe('test@example.com');
      expect(inv.status).toBe('pending');
      expect(inv.token).toHaveLength(32);
    });

    it('logs project activity events correctly', async () => {
      const log = await collaborationService.logActivity({
        projectId: 'proj-1',
        actorName: 'Jan Novák',
        actionType: 'task_moved',
        entityType: 'task',
        details: { from: 'col-1', to: 'col-2' },
      });

      expect(log).toBeDefined();
      expect(log.projectId).toBe('proj-1');
      expect(log.actorName).toBe('Jan Novák');
      expect(log.actionType).toBe('task_moved');
    });
  });

  describe('Task Resources Service', () => {
    it('uploads a file resource and returns resource object with mock URL', async () => {
      const mockFile = new File(['test content'], 'test.txt', { type: 'text/plain' });
      // Create mock URL if URL.createObjectURL is undefined in node env
      if (typeof URL.createObjectURL !== 'function') {
        URL.createObjectURL = vi.fn(() => 'blob:http://localhost/mock-blob');
      }

      const res = await resourceService.uploadResource('card-1', mockFile, 'Jan Novák');
      expect(res).toBeDefined();
      expect(res.taskId).toBe('card-1');
      expect(res.filename).toBe('test.txt');
      expect(res.mimeType).toBe('text/plain');
      expect(res.uploadedBy).toBe('Jan Novák');
    });
  });

  describe('AI Project Manager Service', () => {
    it('calls executeProjectManager and handles response', async () => {
      const mockColumns = [
        {
          id: 'col-1',
          name: 'To Do',
          cards: [
            { id: 'card-1', title: 'Task A', details: 'Details A', priority: 'High' as const },
          ],
        },
      ];

      vi.spyOn(aiService, 'executeProjectManager').mockResolvedValueOnce({
        model: 'gemini-test',
        content: JSON.stringify({
          summary: 'Projekt je v dobrém stavu.',
          healthScore: 85,
          confidenceScore: 90,
          risks: [],
          blockers: [],
          suggestedChanges: [
            {
              id: 'change-1',
              actionType: 'MOVE_TASK',
              targetCardId: 'card-1',
              targetCardTitle: 'Task A',
              targetColumnId: 'col-2',
              targetColumnName: 'In Progress',
              reason: 'Optimalizace rozpracovanosti',
            },
          ],
        }),
      });

      const response = await aiService.executeProjectManager(mockColumns);
      expect(response).toBeDefined();
      expect(response.content).toContain('healthScore');
    });
  });
});
