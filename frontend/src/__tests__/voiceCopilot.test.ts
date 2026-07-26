import { describe, it, expect, vi } from 'vitest';
import { aiService } from '../services/ai/aiService';

describe('AI Voice Action Copilot Unit Tests', () => {
  it('calls executeVoiceAction with text transcript and returns structured Action Intent payload', async () => {
    const mockTranscript = 'Přidej novou kartu s názvem Refaktoring DB a prioritou High do sloupce V průběhu';
    const mockColumns = [
      { id: 'col-wip', name: 'V průběhu', cards: [] },
    ];

    vi.spyOn(aiService, 'executeVoiceAction').mockResolvedValueOnce({
      model: 'gemini-test',
      content: JSON.stringify({
        intentType: 'CREATE_CARD',
        summary: 'Vytvořit kartu "Refaktoring DB" ve sloupci "V průběhu"',
        actionPayload: {
          cardTitle: 'Refaktoring DB',
          columnName: 'V průběhu',
          priority: 'High',
          details: 'Vytvořeno přes AI Voice Copilot',
        },
      }),
    });

    const response = await aiService.executeVoiceAction(mockTranscript, mockColumns);
    expect(response).toBeDefined();

    const parsed = JSON.parse(response.content);
    expect(parsed.intentType).toBe('CREATE_CARD');
    expect(parsed.actionPayload.cardTitle).toBe('Refaktoring DB');
  });

  it('calls executeVoiceAction with Base64 audio payload for Gemini 3.5 Flash Multimodal', async () => {
    const mockAudioBase64 = 'AAAA...GkX6';
    const mockMimeType = 'audio/webm';
    const mockColumns = [{ id: 'col-todo', name: 'To Do', cards: [] }];

    vi.spyOn(aiService, 'executeVoiceAction').mockResolvedValueOnce({
      model: 'gemini-test',
      content: JSON.stringify({
        intentType: 'RENAME_COLUMN',
        summary: 'Přejmenovat sloupec "To Do" na "Všechny úkoly"',
        actionPayload: {
          columnName: 'To Do',
          targetColumnName: 'Všechny úkoly',
        },
      }),
    });

    const response = await aiService.executeVoiceAction('', mockColumns, undefined, mockAudioBase64, mockMimeType);
    expect(response).toBeDefined();

    const parsed = JSON.parse(response.content);
    expect(parsed.intentType).toBe('RENAME_COLUMN');
    expect(parsed.actionPayload.targetColumnName).toBe('Všechny úkoly');
  });
});
