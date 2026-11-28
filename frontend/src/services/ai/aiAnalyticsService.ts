import { aiCostEstimator } from './aiCostEstimator';
import { supabase, hasSupabaseConfig } from '../../lib/supabase';

export interface AiRequestLog {
  id: string;
  timestamp: number;
  feature: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  responseTime: number;
  success: boolean;
  error?: string;
  requestPayload?: unknown;
  responsePayload?: unknown;
  estimatedCostCzk: number;
}

export interface FeatureStats {
  featureName: string;
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostCzk: number;
  averageResponseTime: number;
}

export interface AiStats {
  todayRequests: number;
  todayTokens: number;
  todayCostCzk: number;
  averageResponseTime: number;
  currentProvider: string;
  currentModel: string;
}

/**
 * Zdroj pravdy je serverový ledger `ai_requests` (RLS: každý vidí jen své řádky). Po `syncLedger()` čtou všechny
 * statistiky z něj; bez Supabase (demo) zůstává lokální záznam. Do prohlížeče se už neukládá žádný obsah promptů ani odpovědí.
 */
let ledgerCache: AiRequestLog[] | null = null;

interface LedgerRow {
  id: string;
  created_at: string;
  feature: string;
  status: string;
  model: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  error_code: string | null;
  duration_ms: number | null;
}

function mapLedgerRow(r: LedgerRow): AiRequestLog {
  const model = r.model ?? 'unknown';
  const input = r.prompt_tokens ?? 0;
  const output = r.completion_tokens ?? 0;
  return {
    id: r.id,
    timestamp: Date.parse(r.created_at),
    feature: r.feature,
    provider: 'google',
    model,
    inputTokens: input,
    outputTokens: output,
    totalTokens: r.total_tokens ?? input + output,
    responseTime: r.duration_ms ?? 0,
    success: r.status === 'succeeded',
    error: r.status === 'failed' ? (r.error_code ?? 'failed') : undefined,
    estimatedCostCzk: aiCostEstimator.calculateCostCzk('google', model, input, output),
  };
}

const STORAGE_KEY = 'ai_control_center_logs';

export const aiAnalyticsService = {
  /**
   * Logs a new AI request.
   */
  async logRequest(entry: Omit<AiRequestLog, 'id' | 'estimatedCostCzk'>): Promise<AiRequestLog> {
    const cost = aiCostEstimator.calculateCostCzk(
      entry.provider,
      entry.model,
      entry.inputTokens,
      entry.outputTokens
    );

    // Obsah požadavku a odpovědi se NIKDY neukládá (soukromí): zůstávají jen metadata.
    const log: AiRequestLog = {
      ...entry,
      requestPayload: undefined,
      responsePayload: undefined,
      id: `req_${Math.random().toString(36).substring(2, 11)}`,
      estimatedCostCzk: cost,
    };

    // S Supabase je zdrojem pravdy ledger na serveru: lokálně se nic neukládá, jen se obnoví zobrazení.
    if (hasSupabaseConfig) {
      if (typeof window !== 'undefined') window.dispatchEvent(new Event('ai_log_updated'));
      return log;
    }

    // In a real Supabase setup, this would be:
    // await supabase.from('ai_logs').insert(log);
    
    // For local MVP / Observability, store in localStorage
    if (typeof window !== 'undefined') {
      try {
        const existingLogs = this.getRawLogs();
        existingLogs.push(log);
        // Keep logs capped to a reasonable number (e.g. 500) to prevent localStorage quota exhaustion
        if (existingLogs.length > 500) {
          existingLogs.shift();
        }
        localStorage.setItem(STORAGE_KEY, JSON.stringify(existingLogs));
        
        // Dispatch custom event to notify listeners (e.g. the dashboard page) to re-render in real-time
        window.dispatchEvent(new Event('ai_log_updated'));
      } catch (err) {
        console.error('Failed to save AI log in localStorage:', err);
      }
    }

    return log;
  },

  /**
   * Helper to fetch raw logs from localStorage
   */
  getRawLogs(): AiRequestLog[] {
    if (ledgerCache) return ledgerCache;
    if (typeof window === 'undefined') return [];
    try {
      const data = localStorage.getItem(STORAGE_KEY);
      if (!data) return [];
      return JSON.parse(data);
    } catch {
      return [];
    }
  },

  /**
   * Načte posledních 30 dní z ledgeru `ai_requests` (jen vlastní řádky). Vrací false, když ledger není dostupný
   * (demo, offline, starší DB): pak se dál používá lokální záznam.
   */
  async syncLedger(days = 30): Promise<boolean> {
    if (!hasSupabaseConfig) return false;
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const { data, error } = await supabase
      .from('ai_requests')
      .select('id, created_at, feature, status, model, prompt_tokens, completion_tokens, total_tokens, error_code, duration_ms')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(500);
    if (error || !Array.isArray(data)) {
      ledgerCache = null;
      return false;
    }
    // Nedokončené rezervace nejsou dotaz; od nejstaršího po nejnovější (jako lokální záznam).
    ledgerCache = (data as LedgerRow[]).filter((r) => r.status !== 'reserved').map(mapLedgerRow).reverse();
    return true;
  },

  /** Je statistika právě z ledgeru? (pak ji nelze smazat z prohlížeče) */
  isLedgerBacked(): boolean {
    return ledgerCache !== null;
  },

  /**
   * Clears all stored AI logs.
   */
  async clearLogs(): Promise<void> {
    if (ledgerCache) return; // ledger je serverový záznam, z prohlížeče se nemaže
    if (typeof window !== 'undefined') {
      localStorage.removeItem(STORAGE_KEY);
      window.dispatchEvent(new Event('ai_log_updated'));
    }
  },

  /**
   * Gets the request history sorted by newest first.
   */
  async getHistory(): Promise<AiRequestLog[]> {
    const logs = this.getRawLogs();
    return [...logs].sort((a, b) => b.timestamp - a.timestamp);
  },

  /**
   * Gets stats for the dashboard.
   */
  async getStats(): Promise<AiStats> {
    const logs = this.getRawLogs();
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

    const todayLogs = logs.filter(log => log.timestamp >= startOfToday);

    const todayRequests = todayLogs.length;
    const todayTokens = todayLogs.reduce((sum, log) => sum + (log.totalTokens || 0), 0);
    const todayCostCzk = todayLogs.reduce((sum, log) => sum + (log.estimatedCostCzk || 0), 0);

    const averageResponseTime = todayRequests > 0
      ? todayLogs.reduce((sum, log) => sum + log.responseTime, 0) / todayRequests
      : logs.length > 0
        ? logs.reduce((sum, log) => sum + log.responseTime, 0) / logs.length
        : 0;

    // Determine current provider & model from the most recent request
    let currentProvider = 'google';
    let currentModel = 'gemini-3.5-flash';

    if (logs.length > 0) {
      const latest = logs[logs.length - 1];
      currentProvider = latest.provider;
      currentModel = latest.model;
    }

    return {
      todayRequests,
      todayTokens,
      todayCostCzk,
      averageResponseTime,
      currentProvider,
      currentModel,
    };
  },

  /**
   * Gets statistics broken down by feature name.
   */
  async getFeatureBreakdown(): Promise<FeatureStats[]> {
    const logs = this.getRawLogs();
    const featuresMap: Record<string, AiRequestLog[]> = {};

    logs.forEach(log => {
      const f = log.feature || 'Ostatní';
      if (!featuresMap[f]) {
        featuresMap[f] = [];
      }
      featuresMap[f].push(log);
    });

    return Object.keys(featuresMap).map(featureName => {
      const featureLogs = featuresMap[featureName];
      const requestCount = featureLogs.length;
      const inputTokens = featureLogs.reduce((sum, log) => sum + (log.inputTokens || 0), 0);
      const outputTokens = featureLogs.reduce((sum, log) => sum + (log.outputTokens || 0), 0);
      const totalTokens = featureLogs.reduce((sum, log) => sum + (log.totalTokens || 0), 0);
      const estimatedCostCzk = featureLogs.reduce((sum, log) => sum + (log.estimatedCostCzk || 0), 0);
      const averageResponseTime = featureLogs.reduce((sum, log) => sum + log.responseTime, 0) / requestCount;

      return {
        featureName,
        requestCount,
        inputTokens,
        outputTokens,
        totalTokens,
        estimatedCostCzk,
        averageResponseTime,
      };
    });
  },

  // RUN 11 (D3): the browser-only "monthly budget" (localStorage) was removed – limits come from the server (lib/ai/status.ts).
};
