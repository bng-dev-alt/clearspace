import { Card, Column } from '../../types/kanban';
import { Project } from '../kanbanService';

export interface AiModelConfig {
  model: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
  responseSchema?: Record<string, unknown>;
  /** Timeout na jeden pokus (ms). Default 45s; těžké generace (sprint) si dají víc. */
  timeoutMs?: number;
}

export interface AiProvider {
  generateCompletion(
    messages: AiMessage[],
    config: AiModelConfig
  ): Promise<AiResponse>;
}

export interface AiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  inlineData?: {
    mimeType: string;
    data: string;
  };
}

export interface AiContext {
  /** Hotový, rámovaný kontext z Project Context Engine (fakta + DATA blok). Má přednost před `columns`. */
  renderedContext?: string;
  card?: Card;
  project?: Project;
  columns?: Column[];
  metadata?: Record<string, unknown>;
}

export interface AiRequest {
  messages: AiMessage[];
  config?: AiModelConfig;
  context?: AiContext;
}

export interface AiResponse {
  content: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  model: string;
}
