import { providerFactory } from './providerFactory';
import { promptBuilder } from './promptBuilder';
import { AiRequest, AiResponse, AiModelConfig, AiContext, AiMessage } from './types';
import { Card, Column, TeamMember } from '../../types/kanban';
import { AiProviderError, AiErrorCode } from '../../lib/ai/errors';
import { improveTaskSchema, backlogGenerateSchema, projectGenerateSchema, sprintPlanningSchema, projectRiskAnalysisSchema, aiProjectManagerSchema, aiResourceAnalysisSchema, aiDailyBriefSchema, aiCapacityPlanningSchema, aiVoiceActionSchema } from './schemas';

// Jednoduché lokální logování AI requestů na serveru
function logAiRequest(
  action: string,
  model: string,
  startTime: number,
  success: boolean,
  extra: Record<string, unknown>
) {
  const duration = Date.now() - startTime;
  // Serverové observability logování jen mimo produkci (čisté produkční logy).
  if (process.env.NODE_ENV !== 'production') {
    console.log(
      `[AI SERVICE LOG] ${new Date().toISOString()} | Action: ${action} | Model: ${model} | Duration: ${duration}ms | Success: ${success}`,
      JSON.stringify(extra)
    );
  }
}

export const aiService = {
  // Převede chybu providera na klasifikovanou chybu s BEZPEČNÝM textem pro klienta.
  // Surová zpráva providera (může obsahovat detaily konfigurace) se nikdy nevrací.
  classifyError(err: Error): AiProviderError {
    const msg = err.message || '';
    const map: Array<[string, AiErrorCode, string]> = [
      ['GEMINI_API_KEY_MISSING', 'ai_unavailable', 'AI služba není na serveru nakonfigurována.'],
      ['GEMINI_INVALID_API_KEY', 'ai_unavailable', 'AI služba je dočasně nedostupná (konfigurace serveru).'],
      ['GEMINI_RATE_LIMIT', 'rate_limited', 'Byl překročen limit dotazů pro Gemini. Zkuste to prosím za chvíli.'],
      ['GEMINI_OVERLOADED', 'ai_overloaded', 'Model Gemini je momentálně přetížený (vysoká poptávka). Zkuste to prosím za chvíli znovu.'],
      ['GEMINI_TIMEOUT', 'ai_timeout', 'Požadavek na Gemini vypršel (timeout). Zkuste to prosím znovu.'],
      ['GEMINI_NETWORK_ERROR', 'ai_unavailable', 'Chyba síťového připojení k Gemini. Zkuste to prosím znovu.'],
    ];
    for (const [needle, code, text] of map) {
      if (msg.includes(needle)) return new AiProviderError(code, text);
    }
    return new AiProviderError('ai_failed', 'Služba AI selhala. Zkuste to prosím znovu.');
  },

  // Společná obálka pro vykonání požadavků přes zvoleného providera s logováním a ošetřením chyb
  async _execute(
    actionName: string,
    messages: AiMessage[],
    config: AiModelConfig
  ): Promise<AiResponse> {
    const startTime = Date.now();
    try {
      const provider = providerFactory.getProvider();
      const response = await provider.generateCompletion(messages, config);
      logAiRequest(actionName, config.model, startTime, true, {
        promptTokens: response.usage?.promptTokens ?? 0,
        completionTokens: response.usage?.completionTokens ?? 0,
      });
      return response;
    } catch (err: unknown) {
      const error = err as Error;
      logAiRequest(actionName, config.model, startTime, false, { error: error.message });
      throw this.classifyError(error);
    }
  },

  // 1. AI Chat
  async executeChat(req: AiRequest): Promise<AiResponse> {
    // Model, teplota i strop tokenů určuje server -- `req.config` od klienta se ignoruje.
    const config: AiModelConfig = {
      model: process.env.GEMINI_MODEL || 'gemini-3.5-flash',
      temperature: 0.7,
      maxTokens: 2000,
    };
    const messages = promptBuilder.buildChatPrompt(req.messages, req.context);
    return this._execute('chat', messages, config);
  },

  // 2. AI Task Generation (Tvorba nového úkolu)
  async executeTaskGenerate(topic: string, context?: AiContext): Promise<AiResponse> {
    const config: AiModelConfig = {
      model: process.env.GEMINI_MODEL || 'gemini-3.5-flash',
      temperature: 0.3,
    };
    const messages = promptBuilder.buildTaskGeneratePrompt(topic, context);
    return this._execute('task_generate', messages, config);
  },

  // 3. AI Improve Task (Vylepšení zadání)
  async executeTaskImprove(card: Card, context?: AiContext): Promise<AiResponse> {
    const config: AiModelConfig = {
      model: process.env.GEMINI_MODEL || 'gemini-3.5-flash',
      temperature: 0.3,
      responseSchema: improveTaskSchema,
    };
    const messages = promptBuilder.buildTaskImprovePrompt(card, context);
    return this._execute('task_improve', messages, config);
  },

  // 4. AI Split Task (Rozdělení úkolu)
  async executeTaskSplit(card: Card, context?: AiContext): Promise<AiResponse> {
    const config: AiModelConfig = {
      model: process.env.GEMINI_MODEL || 'gemini-3.5-flash',
      temperature: 0.2,
    };
    const messages = promptBuilder.buildTaskSplitPrompt(card, context);
    return this._execute('task_split', messages, config);
  },

  // 5. AI Sprint Planning (Plánování sprintů)
  async executeSprintPlanning(cards: Card[], context?: AiContext): Promise<AiResponse> {
    const config: AiModelConfig = {
      model: process.env.GEMINI_MODEL || 'gemini-3.5-flash',
      temperature: 0.5,
      maxTokens: 4000,
      responseSchema: sprintPlanningSchema,
      // Nejtěžší strukturovaná generace -> delší timeout (+ provider dělá 1 retry).
      timeoutMs: 55000,
    };
    const messages = promptBuilder.buildSprintPlanningPrompt(cards, context);
    return this._execute('sprint_planning', messages, config);
  },

  // 6. AI Search (Vyhledávání)
  async executeSearch(query: string, cards: Card[]): Promise<AiResponse> {
    const config: AiModelConfig = {
      model: process.env.GEMINI_MODEL || 'gemini-3.5-flash',
      temperature: 0.1,
    };
    const messages = promptBuilder.buildSearchPrompt(query, cards);
    return this._execute('search', messages, config);
  },

  // 7. AI Summary (Shrnutí úkolu)
  async executeSummary(card: Card): Promise<AiResponse> {
    const config: AiModelConfig = {
      model: process.env.GEMINI_MODEL || 'gemini-3.5-flash',
      temperature: 0.3,
    };
    const messages = promptBuilder.buildSummaryPrompt(card);
    return this._execute('summary', messages, config);
  },

  // 8. AI Backlog Generation (Generování backlogu)
  async executeBacklogGenerate(
    projectName: string,
    projectDescription: string,
    columns: Column[],
    existingTasks: Card[],
    options?: { taskCount?: number; detailLevel?: string; technologies?: string }
  ): Promise<AiResponse> {
    const config: AiModelConfig = {
      model: process.env.GEMINI_MODEL || 'gemini-3.5-flash',
      temperature: 0.3,
      maxTokens: 4000,
      responseSchema: backlogGenerateSchema,
    };
    const messages = promptBuilder.buildBacklogGeneratePrompt(
      projectName,
      projectDescription,
      columns,
      existingTasks,
      options
    );
    return this._execute('backlog_generate', messages, config);
  },

  // 9. AI Project Generation (Generování celého projektu)
  async executeProjectGenerate(
    projectName?: string,
    projectDescription?: string,
    projectType?: string,
    technologies?: string,
    detailLevel?: string,
    taskCount?: number
  ): Promise<AiResponse> {
    const config: AiModelConfig = {
      model: process.env.GEMINI_MODEL || 'gemini-3.5-flash',
      temperature: 0.3,
      maxTokens: 4000,
      responseSchema: projectGenerateSchema,
    };
    const messages = promptBuilder.buildProjectGeneratePrompt(
      projectName,
      projectDescription,
      projectType,
      technologies,
      detailLevel,
      taskCount
    );
    return this._execute('project_generate', messages, config);
  },

  // 10. AI Risk Analysis
  async executeRiskAnalysis(
    projectName: string,
    columns: Column[],
    context?: AiContext
  ): Promise<AiResponse> {
    const config: AiModelConfig = {
      model: process.env.GEMINI_MODEL || 'gemini-3.5-flash',
      temperature: 0.3,
      maxTokens: 4000,
      responseSchema: projectRiskAnalysisSchema,
    };
    const messages = promptBuilder.buildRiskAnalysisPrompt(projectName, columns, context);
    return this._execute('risk_analysis', messages, config);
  },

  // 11. AI Project Manager (Suggested Board Changes & Health Analysis)
  async executeProjectManager(
    columns: Column[],
    context?: AiContext
  ): Promise<AiResponse> {
    const config: AiModelConfig = {
      model: process.env.GEMINI_MODEL || 'gemini-3.5-flash',
      temperature: 0.3,
      maxTokens: 4000,
      responseSchema: aiProjectManagerSchema,
    };
    const messages = promptBuilder.buildProjectManagerPrompt(columns, context);
    return this._execute('project_manager', messages, config);
  },

  // 12. AI Resource Analysis (Document Ingestion & Context Extraction)
  async executeResourceAnalysis(
    filename: string,
    fileContentText: string,
    context?: AiContext
  ): Promise<AiResponse> {
    const config: AiModelConfig = {
      model: process.env.GEMINI_MODEL || 'gemini-3.5-flash',
      temperature: 0.2,
      maxTokens: 4000,
      responseSchema: aiResourceAnalysisSchema,
    };
    const messages = promptBuilder.buildResourceAnalysisPrompt(filename, fileContentText, context);
    return this._execute('resource_analysis', messages, config);
  },

  // 13. AI Daily Brief (Executive Briefing)
  async executeDailyBrief(
    columns: Column[],
    activityLogsText: string,
    context?: AiContext
  ): Promise<AiResponse> {
    const config: AiModelConfig = {
      model: process.env.GEMINI_MODEL || 'gemini-3.5-flash',
      temperature: 0.3,
      maxTokens: 3000,
      responseSchema: aiDailyBriefSchema,
    };
    const messages = promptBuilder.buildDailyBriefPrompt(columns, activityLogsText, context);
    return this._execute('daily_brief', messages, config);
  },

  // 14. AI Capacity Planning & Workload Re-balancing
  async executeCapacityPlanning(
    columns: Column[],
    members: TeamMember[],
    context?: AiContext
  ): Promise<AiResponse> {
    const config: AiModelConfig = {
      model: process.env.GEMINI_MODEL || 'gemini-3.5-flash',
      temperature: 0.3,
      maxTokens: 4000,
      responseSchema: aiCapacityPlanningSchema,
    };
    const messages = promptBuilder.buildCapacityPlanningPrompt(columns, members, context);
    return this._execute('capacity_planning', messages, config);
  },

  // 15. AI Voice Action Parsing (Multimodal Audio & Text)
  async executeVoiceAction(
    userTranscript: string,
    columns: Column[],
    context?: AiContext,
    audioBase64?: string,
    mimeType?: string
  ): Promise<AiResponse> {
    const config: AiModelConfig = {
      model: process.env.GEMINI_MODEL || 'gemini-3.5-flash',
      temperature: 0.2,
      maxTokens: 2000,
      responseSchema: aiVoiceActionSchema,
    };
    const messages = promptBuilder.buildVoiceActionPrompt(userTranscript, columns, context, audioBase64, mimeType);
    return this._execute('voice_action', messages, config);
  },
};
