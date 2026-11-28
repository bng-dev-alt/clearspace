import { describe, it, expect, beforeEach, vi } from 'vitest';
import { aiCostEstimator } from '../services/ai/aiCostEstimator';
import { aiAnalyticsService } from '../services/ai/aiAnalyticsService';

// Mock localStorage for Vitest
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => {
      store[key] = value.toString();
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
  };
})();

if (typeof window === 'undefined') {
  global.window = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  } as unknown as Window & typeof globalThis;
  global.localStorage = localStorageMock as unknown as Storage;
}

describe('AI Cost Estimator Tests', () => {
  it('calculates cost in USD correctly for gemini-3.5-flash', () => {
    const cost = aiCostEstimator.calculateCostUsd('google', 'gemini-3.5-flash', 10000, 20000);
    // (10,000 / 1,000,000) * 0.075 + (20,000 / 1,000,000) * 0.30
    // = 0.01 * 0.075 + 0.02 * 0.30 = 0.00075 + 0.006 = 0.00675 USD
    expect(cost).toBeCloseTo(0.00675, 6);
  });

  it('calculates cost in CZK correctly using current exchange rate', () => {
    const costCzk = aiCostEstimator.calculateCostCzk('google', 'gemini-3.5-flash', 10000, 20000);
    const expectedUsd = 0.00675;
    expect(costCzk).toBeCloseTo(expectedUsd * 23.5, 4);
  });

  it('formats CZK cost amounts properly', () => {
    // RUN 11: Czech format (decimal comma, Kč); the space before Kč may be a no-break space
    const n = (s: string) => s.replace(/\s/g, ' ');
    expect(n(aiCostEstimator.formatCostCzk(0))).toBe('0,00 Kč');
    expect(n(aiCostEstimator.formatCostCzk(0.1234))).toBe('0,12 Kč');
    expect(n(aiCostEstimator.formatCostCzk(0.0002))).toBe('0,0002 Kč');
    expect(n(aiCostEstimator.formatCostCzk(150.5))).toBe('150,50 Kč');
  });

  it('falls back to default pricing for unrecognized models', () => {
    const costUsd = aiCostEstimator.calculateCostUsd('some-provider', 'mystery-model', 10000, 20000);
    // (10,000 / 1M) * 0.15 + (20,000 / 1M) * 0.60 = 0.0015 + 0.012 = 0.0135 USD
    expect(costUsd).toBeCloseTo(0.0135, 6);
  });
});

describe('AI Analytics Service Tests', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('saves and retrieves request logs correctly', async () => {
    const log1 = await aiAnalyticsService.logRequest({
      timestamp: Date.now(),
      feature: 'Improve Task',
      provider: 'google',
      model: 'gemini-3.5-flash',
      inputTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
      responseTime: 1200,
      success: true,
    });

    const history = await aiAnalyticsService.getHistory();
    expect(history.length).toBe(1);
    expect(history[0].id).toBe(log1.id);
    expect(history[0].feature).toBe('Improve Task');
    expect(history[0].estimatedCostCzk).toBeGreaterThan(0);
  });

  it('calculates dashboard stats correctly', async () => {
    const now = Date.now();
    await aiAnalyticsService.logRequest({
      timestamp: now,
      feature: 'Generate Tasks',
      provider: 'google',
      model: 'gemini-3.5-flash',
      inputTokens: 2000,
      outputTokens: 1000,
      totalTokens: 3000,
      responseTime: 1500,
      success: true,
    });

    const stats = await aiAnalyticsService.getStats();
    expect(stats.todayRequests).toBe(1);
    expect(stats.todayTokens).toBe(3000);
    expect(stats.currentModel).toBe('gemini-3.5-flash');
  });

  it('computes feature breakdown dynamically', async () => {
    await aiAnalyticsService.logRequest({
      timestamp: Date.now(),
      feature: 'Improve Task',
      provider: 'google',
      model: 'gemini-3.5-flash',
      inputTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
      responseTime: 1000,
      success: true,
    });

    await aiAnalyticsService.logRequest({
      timestamp: Date.now(),
      feature: 'Improve Task',
      provider: 'google',
      model: 'gemini-3.5-flash',
      inputTokens: 2000,
      outputTokens: 1000,
      totalTokens: 3000,
      responseTime: 2000,
      success: true,
    });

    await aiAnalyticsService.logRequest({
      timestamp: Date.now(),
      feature: 'Generate Project',
      provider: 'google',
      model: 'gemini-3.5-flash',
      inputTokens: 5000,
      outputTokens: 3000,
      totalTokens: 8000,
      responseTime: 4000,
      success: true,
    });

    const breakdown = await aiAnalyticsService.getFeatureBreakdown();
    expect(breakdown.length).toBe(2);

    const improveTask = breakdown.find(f => f.featureName === 'Improve Task');
    expect(improveTask).toBeDefined();
    expect(improveTask!.requestCount).toBe(2);
    expect(improveTask!.totalTokens).toBe(4500);
    expect(improveTask!.averageResponseTime).toBe(1500);

    const generateProject = breakdown.find(f => f.featureName === 'Generate Project');
    expect(generateProject).toBeDefined();
    expect(generateProject!.requestCount).toBe(1);
    expect(generateProject!.totalTokens).toBe(8000);
  });

});
