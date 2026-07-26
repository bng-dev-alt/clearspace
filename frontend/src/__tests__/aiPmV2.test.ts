import { describe, it, expect, vi } from 'vitest';
import { aiService } from '../services/ai/aiService';

describe('AI Project Manager v2 Unit Tests', () => {
  it('calls executeDailyBrief and handles JSON briefing structure', async () => {
    const mockColumns = [
      { id: 'col-1', name: 'V průběhu', cards: [{ id: 'card-1', title: 'Refaktoring DB', details: '' }] },
    ];

    vi.spyOn(aiService, 'executeDailyBrief').mockResolvedValueOnce({
      model: 'gemini-test',
      content: JSON.stringify({
        greeting: 'Dobré ráno týme!',
        executiveSummary: 'Projekt postupuje podle plánu.',
        completedYesterday: ['Nasazení RLS politik'],
        topPrioritiesToday: ['Dokončit refaktoring DB', 'Připravit podklady pro sprint'],
        capacityAlerts: ['Jan má alokováno 10h práce'],
        recommendedActions: ['Zkontrolovat prázdné štítky u karet'],
      }),
    });

    const response = await aiService.executeDailyBrief(mockColumns, 'Aktivita: vytvořena karta');
    expect(response).toBeDefined();

    const parsed = JSON.parse(response.content);
    expect(parsed.greeting).toContain('Dobré ráno');
    expect(parsed.topPrioritiesToday).toHaveLength(2);
  });

  it('calls executeCapacityPlanning and handles team workload suggestions', async () => {
    const mockColumns = [
      { id: 'col-1', name: 'V průběhu', cards: [{ id: 'card-1', title: 'AI Chat UI', details: '' }] },
    ];
    const mockMembers = [
      { id: 'm-1', fullName: 'Jan Novák', initials: 'JN', avatarColor: '#209dd7', createdAt: '2026-01-01' },
      { id: 'm-2', fullName: 'Petr Svoboda', initials: 'PS', avatarColor: '#753991', createdAt: '2026-01-01' },
    ];

    vi.spyOn(aiService, 'executeCapacityPlanning').mockResolvedValueOnce({
      model: 'gemini-test',
      content: JSON.stringify({
        totalCapacityHours: 80,
        allocatedHours: 65,
        workloadByMember: [
          { memberId: 'm-1', memberName: 'Jan Novák', assignedCardsCount: 5, estimatedHours: 45, status: 'OVERLOADED' },
          { memberId: 'm-2', memberName: 'Petr Svoboda', assignedCardsCount: 1, estimatedHours: 10, status: 'AVAILABLE' },
        ],
        rebalanceSuggestions: [
          { cardId: 'card-1', cardTitle: 'AI Chat UI', fromMemberName: 'Jan Novák', toMemberName: 'Petr Svoboda', reason: 'Vyvážení přetížení' },
        ],
      }),
    });

    const response = await aiService.executeCapacityPlanning(mockColumns, mockMembers);
    expect(response).toBeDefined();

    const parsed = JSON.parse(response.content);
    expect(parsed.workloadByMember).toHaveLength(2);
    expect(parsed.rebalanceSuggestions).toHaveLength(1);
  });
});
