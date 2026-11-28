export interface ModelPricing {
  inputRatePerMillionUsd: number;
  outputRatePerMillionUsd: number;
}

export const PROVIDER_PRICING: Record<string, Record<string, ModelPricing>> = {
  google: {
    'gemini-3.5-flash': {
      inputRatePerMillionUsd: 0.075,
      outputRatePerMillionUsd: 0.30,
    },
    'gemini-2.5-flash': {
      inputRatePerMillionUsd: 0.075,
      outputRatePerMillionUsd: 0.30,
    },
    'gemini-2.0-flash': {
      inputRatePerMillionUsd: 0.075,
      outputRatePerMillionUsd: 0.30,
    },
    'gemini-1.5-flash': {
      inputRatePerMillionUsd: 0.075,
      outputRatePerMillionUsd: 0.30,
    },
    'gemini-2.5-pro': {
      inputRatePerMillionUsd: 1.25,
      outputRatePerMillionUsd: 5.00,
    },
    'gemini-2.5-flash-lite': {
      inputRatePerMillionUsd: 0.0375,
      outputRatePerMillionUsd: 0.15,
    },
  },
  openrouter: {
    'free': {
      inputRatePerMillionUsd: 0.0,
      outputRatePerMillionUsd: 0.0,
    },
    'openrouter/free': {
      inputRatePerMillionUsd: 0.0,
      outputRatePerMillionUsd: 0.0,
    },
  },
};

export const DEFAULT_PRICING: ModelPricing = {
  inputRatePerMillionUsd: 0.15,
  outputRatePerMillionUsd: 0.60,
};

export const USD_TO_CZK_RATE = 23.5;

export const aiCostEstimator = {
  /**
   * Calculates the estimated cost of an AI request in USD.
   */
  calculateCostUsd(
    provider: string,
    model: string,
    inputTokens: number,
    outputTokens: number
  ): number {
    const providerLower = (provider || 'google').toLowerCase();
    const modelClean = (model || '').replace(/^models\//, '').toLowerCase();

    let pricing = DEFAULT_PRICING;

    const providerSettings = PROVIDER_PRICING[providerLower];
    if (providerSettings) {
      // Direct lookup or fallback matching
      const modelSettings = providerSettings[modelClean] || Object.keys(providerSettings).find(k => modelClean.includes(k) || k.includes(modelClean))
        ? providerSettings[modelClean] || providerSettings[Object.keys(providerSettings).find(k => modelClean.includes(k) || k.includes(modelClean))!]
        : null;

      if (modelSettings) {
        pricing = modelSettings;
      }
    }

    const inputCost = (inputTokens / 1_000_000) * pricing.inputRatePerMillionUsd;
    const outputCost = (outputTokens / 1_000_000) * pricing.outputRatePerMillionUsd;

    return inputCost + outputCost;
  },

  /**
   * Calculates the estimated cost of an AI request in CZK.
   */
  calculateCostCzk(
    provider: string,
    model: string,
    inputTokens: number,
    outputTokens: number
  ): number {
    const usd = this.calculateCostUsd(provider, model, inputTokens, outputTokens);
    return usd * USD_TO_CZK_RATE;
  },

  /**
   * Formats a cost number in CZK to a readable string (e.g. 0.12 CZK).
   */
  formatCostCzk(amount: number): string {
    // RUN 11: Czech number format (decimal comma, Kč)
    const fmt = (d: number) => amount.toLocaleString('cs-CZ', { minimumFractionDigits: d, maximumFractionDigits: d });
    if (amount === 0) return '0,00 Kč';
    if (amount < 0.01) return `${fmt(4)} Kč`;
    return `${fmt(2)} Kč`;
  },
};
