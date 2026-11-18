import { GoogleGenAI } from '@google/genai';
import { serverModel } from './model';
import { AiMessage, AiModelConfig, AiResponse, AiProvider } from './types';

let aiInstance: GoogleGenAI | null = null;

function getAiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.trim() === '') {
    throw new Error('GEMINI_API_KEY_MISSING');
  }
  if (!aiInstance) {
    aiInstance = new GoogleGenAI({ apiKey });
  }
  return aiInstance;
}

export const geminiProvider: AiProvider = {
  async generateCompletion(
    messages: AiMessage[],
    config: AiModelConfig
  ): Promise<AiResponse> {
    const model = config.model || serverModel();
    const temperature = config.temperature ?? 0.4; // Nízká teplota pro stabilnější generování JSON
    const maxTokens = config.maxTokens ?? 4000;

    // Extrahujeme systémový prompt z pole zpráv (pokud existuje)
    const systemMessage = messages.find((m) => m.role === 'system');
    const systemInstruction = systemMessage ? systemMessage.content : (config.systemPrompt || undefined);

    // Ostatní konverzační zprávy
    const filteredMessages = messages.filter((m) => m.role !== 'system');
    
    // Namapujeme zprávy pro Gemini SDK (assistant -> model)
    const contents = filteredMessages.map((msg) => {
      const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];
      if (msg.content) parts.push({ text: msg.content });
      if (msg.inlineData) parts.push({ inlineData: msg.inlineData });
      return {
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: parts.length > 0 ? parts : [{ text: '' }],
      };
    });

    // Sestavíme konfiguraci pro generování
    const genConfig: {
      temperature: number;
      maxOutputTokens: number;
      systemInstruction?: string;
      responseMimeType?: string;
      responseSchema?: unknown;
      thinkingConfig?: { thinkingBudget: number };
    } = {
      temperature,
      maxOutputTokens: maxTokens,
      thinkingConfig: { thinkingBudget: 0 },
    };

    if (systemInstruction) {
      genConfig.systemInstruction = systemInstruction;
    }

    if (config.responseSchema) {
      genConfig.responseMimeType = 'application/json';
      genConfig.responseSchema = config.responseSchema;
    }

    // Per-request pojistka vypršení (default 45s; sprint apod. si nastaví víc).
    const timeoutMs = config.timeoutMs ?? 45000;

    // Jeden pokus = generateContent v závodě s timeoutem (čerstvý timer na pokus).
    const attempt = async () => {
      const aiClient = getAiClient();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('GEMINI_TIMEOUT')), timeoutMs);
      });
      try {
        return await Promise.race([
          aiClient.models.generateContent({ model, contents, config: genConfig }),
          timeoutPromise,
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    // Přechodné chyby (timeout, API deadline, přetížený model 503/UNAVAILABLE)
    // se často zhojí samy -> stojí za jeden automatický retry.
    const isTransient = (e: unknown) => {
      const m = (e as Error)?.message || '';
      return (
        m === 'GEMINI_TIMEOUT' ||
        m.includes('DEADLINE_EXCEEDED') ||
        m.includes('504') ||
        m.includes('UNAVAILABLE') ||
        m.includes('503') ||
        m.includes('overloaded') ||
        m.includes('high demand')
      );
    };

    try {
      // -> jeden automatický retry na přechodnou chybu.
      let response;
      try {
        response = await attempt();
      } catch (firstErr) {
        if (isTransient(firstErr)) {
          response = await attempt();
        } else {
          throw firstErr;
        }
      }

      if (!response || !response.text) {
        throw new Error('GEMINI_EMPTY_RESPONSE');
      }

      // Zachytíme metadata o tokenech pro budoucí AI Analytics
      const usage = response.usageMetadata
        ? {
            promptTokens: response.usageMetadata.promptTokenCount,
            completionTokens: response.usageMetadata.candidatesTokenCount,
            totalTokens: response.usageMetadata.totalTokenCount,
          }
        : undefined;

      return {
        content: response.text,
        usage,
        model,
      };
    } catch (err: unknown) {
      const error = err as Error;
      const errMsg = error.message || '';

      if (errMsg === 'GEMINI_API_KEY_MISSING') {
        throw error;
      }
      if (errMsg === 'GEMINI_TIMEOUT') {
        throw error;
      }
      
      if (
        errMsg.includes('API key not valid') ||
        errMsg.includes('API_KEY_INVALID') ||
        errMsg.includes('UNAUTHENTICATED') ||
        errMsg.includes('401')
      ) {
        throw new Error('GEMINI_INVALID_API_KEY');
      }

      if (
        errMsg.includes('Quota exceeded') ||
        errMsg.includes('429') ||
        errMsg.includes('RESOURCE_EXHAUSTED')
      ) {
        throw new Error('GEMINI_RATE_LIMIT');
      }

      if (
        errMsg.includes('DEADLINE_EXCEEDED') ||
        errMsg.includes('504')
      ) {
        throw new Error('GEMINI_TIMEOUT');
      }

      if (
        errMsg.includes('UNAVAILABLE') ||
        errMsg.includes('503') ||
        errMsg.includes('overloaded') ||
        errMsg.includes('high demand')
      ) {
        throw new Error('GEMINI_OVERLOADED');
      }

      if (
        err instanceof TypeError ||
        errMsg.includes('fetch failed') ||
        errMsg.includes('network')
      ) {
        throw new Error('GEMINI_NETWORK_ERROR');
      }

      throw new Error(`GEMINI_ERROR: ${errMsg}`);
    }
  },
};
