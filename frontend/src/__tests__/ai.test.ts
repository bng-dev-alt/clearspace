import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { promptBuilder, formatCardContext } from '../services/ai/promptBuilder';
import { geminiProvider } from '../services/ai/geminiProvider';
import { aiService } from '../services/ai/aiService';
import { Card } from '../types/kanban';

// Define mock generateContent
const mockGenerateContent = vi.fn();

vi.mock('@google/genai', () => {
  class MockGoogleGenAI {
    models = {
      generateContent: mockGenerateContent,
    };
  }
  return {
    GoogleGenAI: MockGoogleGenAI,
  };
});

describe('AI Foundation Architecture Unit & Integration Tests', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('1. Prompt Builder Tests', () => {
    const mockCard: Card = {
      id: 'task-123',
      title: 'Tvorba dokumentace',
      details: 'Popiš novou architekturu',
      priority: 'High',
      checklist: [{ id: 'chk-1', text: 'Napsat text', completed: false }],
      comments: [{ id: 'c-1', authorName: 'Tester', content: 'Výborný nápad', createdAt: '2026-07-17T20:00:00Z' }],
      activities: [{ id: 'a-1', text: 'Vytvořeno', createdAt: '2026-07-17T19:00:00Z' }],
    };

    test('formatCardContext serializes all card fields', () => {
      const text = formatCardContext(mockCard);
      expect(text).toContain('Tvorba dokumentace');
      expect(text).toContain('Popiš novou architekturu');
      expect(text).toContain('High');
      expect(text).toContain('Napsat text');
      expect(text).toContain('Výborný nápad');
      expect(text).toContain('Vytvořeno');
    });

    test('buildChatPrompt injects formatted context and system role', () => {
      const messages = promptBuilder.buildChatPrompt([{ role: 'user', content: 'Ahoj' }], { card: mockCard });
      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe('system');
      expect(messages[0].content).toContain('Jste inteligentní AI Asistent');
      expect(messages[0].content).toContain('Tvorba dokumentace');
      expect(messages[1].role).toBe('user');
      expect(messages[1].content).toBe('Ahoj');
    });

    test('buildTaskGeneratePrompt shapes prompt for JSON returns', () => {
      const messages = promptBuilder.buildTaskGeneratePrompt('OAuth registrace');
      expect(messages[0].role).toBe('system');
      expect(messages[0].content).toContain('JSON');
      expect(messages[1].role).toBe('user');
      expect(messages[1].content).toContain('OAuth registrace');
    });
  });

  describe('2. Gemini Provider Mocked Tests', () => {
    test('generateCompletion throws when API key is missing', async () => {
      delete process.env.GEMINI_API_KEY;
      await expect(
        geminiProvider.generateCompletion([{ role: 'user', content: 'test' }], { model: 'gemini-3.5-flash' })
      ).rejects.toThrow('GEMINI_API_KEY_MISSING');
    });

    test('generateCompletion handles invalid API key', async () => {
      process.env.GEMINI_API_KEY = 'invalid-key';
      mockGenerateContent.mockRejectedValueOnce(new Error('API key not valid'));

      await expect(
        geminiProvider.generateCompletion([{ role: 'user', content: 'test' }], { model: 'gemini-3.5-flash' })
      ).rejects.toThrow('GEMINI_INVALID_API_KEY');
    });

    test('generateCompletion handles rate limit', async () => {
      process.env.GEMINI_API_KEY = 'valid-key';
      mockGenerateContent.mockRejectedValueOnce(new Error('Quota exceeded'));

      await expect(
        geminiProvider.generateCompletion([{ role: 'user', content: 'test' }], { model: 'gemini-3.5-flash' })
      ).rejects.toThrow('GEMINI_RATE_LIMIT');
    });

    test('generateCompletion parses valid response correctly', async () => {
      process.env.GEMINI_API_KEY = 'valid-key';
      mockGenerateContent.mockResolvedValueOnce({
        text: 'AI Odpověď',
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 15, totalTokenCount: 25 },
      });

      const res = await geminiProvider.generateCompletion([{ role: 'user', content: 'test' }], { model: 'gemini-3.5-flash' });
      expect(res.content).toBe('AI Odpověď');
      expect(res.model).toBe('gemini-3.5-flash');
      expect(res.usage?.totalTokens).toBe(25);
    });

    test('generateCompletion retries once on a transient timeout and succeeds', async () => {
      process.env.GEMINI_API_KEY = 'valid-key';
      mockGenerateContent
        .mockRejectedValueOnce(new Error('DEADLINE_EXCEEDED'))
        .mockResolvedValueOnce({
          text: 'Po retry OK',
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
        });

      const res = await geminiProvider.generateCompletion([{ role: 'user', content: 'test' }], { model: 'gemini-3.5-flash' });
      expect(res.content).toBe('Po retry OK');
      expect(mockGenerateContent).toHaveBeenCalledTimes(2);
    });

    test('generateCompletion gives up (GEMINI_TIMEOUT) after one retry on repeated timeout', async () => {
      process.env.GEMINI_API_KEY = 'valid-key';
      mockGenerateContent
        .mockRejectedValueOnce(new Error('DEADLINE_EXCEEDED'))
        .mockRejectedValueOnce(new Error('DEADLINE_EXCEEDED'));

      await expect(
        geminiProvider.generateCompletion([{ role: 'user', content: 'test' }], { model: 'gemini-3.5-flash' })
      ).rejects.toThrow('GEMINI_TIMEOUT');
      expect(mockGenerateContent).toHaveBeenCalledTimes(2);
    });

    test('generateCompletion retries on overloaded model (503/UNAVAILABLE) then succeeds', async () => {
      process.env.GEMINI_API_KEY = 'valid-key';
      mockGenerateContent
        .mockRejectedValueOnce(new Error('503 This model is currently experiencing high demand. status: UNAVAILABLE'))
        .mockResolvedValueOnce({
          text: 'OK po retry',
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
        });

      const res = await geminiProvider.generateCompletion([{ role: 'user', content: 'test' }], { model: 'gemini-3.5-flash' });
      expect(res.content).toBe('OK po retry');
      expect(mockGenerateContent).toHaveBeenCalledTimes(2);
    });

    test('generateCompletion maps repeated overload to GEMINI_OVERLOADED', async () => {
      process.env.GEMINI_API_KEY = 'valid-key';
      mockGenerateContent
        .mockRejectedValueOnce(new Error('503 UNAVAILABLE'))
        .mockRejectedValueOnce(new Error('503 UNAVAILABLE'));

      await expect(
        geminiProvider.generateCompletion([{ role: 'user', content: 'test' }], { model: 'gemini-3.5-flash' })
      ).rejects.toThrow('GEMINI_OVERLOADED');
      expect(mockGenerateContent).toHaveBeenCalledTimes(2);
    });
  });

  describe('3. AI Service Tests', () => {
    test('classifyError maps provider failures to safe, classified errors', () => {
      const c = (m: string) => aiService.classifyError(new Error(m));
      expect(c('GEMINI_API_KEY_MISSING').code).toBe('ai_unavailable');
      expect(c('GEMINI_INVALID_API_KEY').code).toBe('ai_unavailable');
      expect(c('GEMINI_RATE_LIMIT').code).toBe('rate_limited');
      expect(c('GEMINI_OVERLOADED').code).toBe('ai_overloaded');
      expect(c('GEMINI_OVERLOADED').message).toContain('přetížený');
      expect(c('GEMINI_TIMEOUT').code).toBe('ai_timeout');
      expect(c('GEMINI_NETWORK_ERROR').code).toBe('ai_unavailable');
    });

    test('classifyError never leaks raw provider text', () => {
      const e = aiService.classifyError(new Error('GEMINI_ERROR: key=AIzaSECRET project=internal-123'));
      expect(e.code).toBe('ai_failed');
      expect(e.message).not.toContain('AIza');
      expect(e.message).not.toContain('internal-123');
    });

    test('executeChat ignores client-supplied model / limits', async () => {
      process.env.GEMINI_API_KEY = 'valid-key';
      process.env.GEMINI_MODEL = 'gemini-server-model';
      mockGenerateContent.mockResolvedValueOnce({ text: 'ok', usageMetadata: {} });
      await aiService.executeChat({
        messages: [{ role: 'user', content: 'Ahoj' }],
        config: { model: 'gemini-most-expensive', maxTokens: 65000, temperature: 2 },
      });
      const call = mockGenerateContent.mock.calls[0][0];
      expect(call.model).toBe('gemini-server-model');
      expect(call.config.maxOutputTokens).toBe(2000);
    });
  });

  const realKey = process.env.GEMINI_API_KEY;
  if (realKey && realKey !== 'tvuj_api_klic_zde' && realKey !== '') {
    describe('6. Real Gemini Integration Test', () => {
      test('successfully calls real Gemini endpoint', async () => {
        const response = await aiService.executeChat({
          messages: [{ role: 'user', content: 'Ahoj, odpověz jedním slovem: Test' }],
        });
        expect(response.content).toBeDefined();
        console.log('Skutečná odpověď od Gemini:', response.content);
      });
    });
  }
});
