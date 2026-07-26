import { describe, it, expect, vi } from 'vitest';
import { aiService } from '../services/ai/aiService';

describe('Task Resources v2 - AI Context Unit Tests', () => {
  it('calls executeResourceAnalysis and returns structured document extraction result', async () => {
    const mockFilename = 'spec.pdf';
    const mockContent = 'Specifikace modulu pro přihlašování a dvoufázové ověření 2FA.';

    vi.spyOn(aiService, 'executeResourceAnalysis').mockResolvedValueOnce({
      model: 'gemini-test',
      content: JSON.stringify({
        summary: 'Specifikace 2FA autentizace.',
        extractedRequirements: ['Implementovat TOTP 2FA', 'Uložit secret kód v šifrované podobě'],
        generatedSubtasks: [
          { title: 'Vytvořit DB tabulku 2FA secretů', description: 'PostgreSQL tabulka pro TOTP', priority: 'High' },
          { title: 'Generování QR kódu v UI', description: 'Použít qrcode.react knihovnu', priority: 'Medium' },
        ],
        detectedRisks: ['Riziko ztráty obnovovacího klíče uživatelem'],
      }),
    });

    const response = await aiService.executeResourceAnalysis(mockFilename, mockContent);
    expect(response).toBeDefined();
    expect(response.content).toContain('TOTP 2FA');

    const parsed = JSON.parse(response.content);
    expect(parsed.summary).toBe('Specifikace 2FA autentizace.');
    expect(parsed.extractedRequirements).toHaveLength(2);
    expect(parsed.generatedSubtasks).toHaveLength(2);
    expect(parsed.detectedRisks).toHaveLength(1);
  });
});
