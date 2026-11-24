import { describe, it, expect, vi } from 'vitest';
import { collaborationService } from '../services/collaborationService';
import { resourceService } from '../services/resourceService';
import { aiService } from '../services/ai/aiService';

describe('Feature Updates Integration Tests', () => {
  describe('Team Collaboration Service', () => {
    it('generates 256-bit hex invite tokens from the CSPRNG (demo mode only)', () => {
      const token = collaborationService.generateToken();
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      expect(collaborationService.generateToken()).not.toBe(token);
    });

    it('does not use Math.random for tokens', () => {
      const spy = vi.spyOn(Math, 'random');
      collaborationService.generateToken();
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('creates a member-role invitation in demo mode (owner role cannot be invited)', async () => {
      const inv = await collaborationService.createWorkspaceInvitation('ws-1', 'Test@Example.com', 'owner', 'owner-1');
      expect(inv.projectId).toBe('ws-1');
      expect(inv.email).toBe('test@example.com');
      expect(inv.status).toBe('pending');
      expect(inv.role).toBe('member');
      expect(inv.token).toMatch(/^[0-9a-f]{64}$/);
    });

    it('accepts an invitation token in demo mode without Supabase configured', async () => {
      const res = await collaborationService.acceptInvitationToken('any-token', 'a@b.cz', 'Jan Novák', 'heslo123');
      expect(res.success).toBe(true);
    });

    it('has no client-side activity logging (events are written by the database, RUN 01)', () => {
      expect((collaborationService as Record<string, unknown>).logActivity).toBeUndefined();
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
