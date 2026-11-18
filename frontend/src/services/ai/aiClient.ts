import { parseAiHttpError } from '../../lib/ai/clientErrors';
import { aiAnalyticsService } from './aiAnalyticsService';
import { supabase, hasSupabaseConfig } from '../../lib/supabase';

// Projekt, ve kterém uživatel právě pracuje. Nastavuje ho stránka projektu;
// server z něj načte kontext (nevěří boardu poslanému z prohlížeče) a ověří členství.
let activeProjectId: string | null = null;

export const aiClient = {
  setActiveProject(projectId: string | null) {
    activeProjectId = projectId;
  },

  /**
   * Helper to perform fetch calls to `/api/ai/*` routes and automatically log usage.
   */
  async fetchAi(
    endpoint: string,
    feature: string,
    body: Record<string, unknown>
  ): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const startTime = Date.now();
    let success = false;
    let errorMsg = '';
    let responseData: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any

    try {
      // AI běží jen pro přihlášené uživatele Supabase (server ověřuje JWT).
      // Demo režim identitu nemá, proto se do sítě vůbec nevolá.
      if (!hasSupabaseConfig) {
        throw new Error('AI funkce vyžadují přihlášení přes Supabase a v demo režimu nejsou dostupné.');
      }
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData.session?.access_token;
      if (!accessToken) {
        throw new Error('Pro použití AI se musíte přihlásit.');
      }

      // Model, limity ani kontext projektu nevolí klient -- určuje je server.
      const finalBody = activeProjectId && body.projectId === undefined
        ? { ...body, projectId: activeProjectId }
        : body;

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(finalBody),
      });

      const responseTime = Date.now() - startTime;

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const parsedErr = parseAiHttpError(response.status, errorData, `Request failed with status ${response.status}`);
        errorMsg = parsedErr.message;
        
        // Log the failure
        const modelName = typeof body.model === 'string' ? body.model : 'gemini-3.5-flash';
        await aiAnalyticsService.logRequest({
          timestamp: Date.now(),
          feature,
          provider: 'google',
          model: modelName,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          responseTime,
          success: false,
          error: errorMsg,
          requestPayload: body,
          responsePayload: { error: errorMsg },
        });

        throw Object.assign(new Error(errorMsg), { code: parsedErr.code });
      }

      responseData = await response.json();
      success = true;

      // Extract metadata from the successful response
      const model = (responseData && typeof responseData === 'object' && 'model' in responseData && typeof responseData.model === 'string')
        ? responseData.model
        : 'gemini-3.5-flash';

      const provider = (responseData && typeof responseData === 'object' && 'provider' in responseData && typeof responseData.provider === 'string')
        ? responseData.provider
        : 'google';

      const usage = responseData && typeof responseData === 'object' && 'usage' in responseData && responseData.usage && typeof responseData.usage === 'object'
        ? responseData.usage as Record<string, number>
        : {};

      const inputTokens = usage.promptTokens ?? 0;
      const outputTokens = usage.completionTokens ?? 0;
      const totalTokens = usage.totalTokens ?? (inputTokens + outputTokens);

      await aiAnalyticsService.logRequest({
        timestamp: Date.now(),
        feature,
        provider,
        model,
        inputTokens,
        outputTokens,
        totalTokens,
        responseTime,
        success: true,
        requestPayload: body,
        responsePayload: responseData,
      });

      return responseData;
    } catch (err: unknown) {
      if (!success) {
        const responseTime = Date.now() - startTime;
        const error = err as Error;
        errorMsg = error.message || 'Při volání AI došlo k neznámé chybě.';

        const modelName = typeof body.model === 'string' ? body.model : 'gemini-3.5-flash';
        await aiAnalyticsService.logRequest({
          timestamp: Date.now(),
          feature,
          provider: 'google',
          model: modelName,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          responseTime,
          success: false,
          error: errorMsg,
          requestPayload: body,
          responsePayload: { error: errorMsg },
        });
      }
      throw err;
    }
  },
};
