import { aiService } from '../../services/ai/aiService';
import { AiMessage } from '../../services/ai/types';
import { Card, Column, TeamMember } from '../../types/kanban';
import { AiFeature } from './gateway';
import { AiGatewayError } from './errors';
import { int, isRecord, list, oneOf, optStr, record, str } from './validate';
import { linkCitations } from '../intelligence/citations';
import { isDoneColumn } from '../projectIntelligence';

/**
 * Definice 11 AI featur. Vstup od klienta je NEDŮVĚRYHODNÝ: validuje se a
 * ořezává. Board projektu klient neposílá -- načítá ho server (gateway.loadBoard).
 */

const PRIORITIES = ['Low', 'Medium', 'High'] as const;
const AUDIO_MIME = ['audio/webm', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/x-m4a', 'audio/aac'] as const;

const noEmptyBoard = (board: Column[]) => {
  if (board.length === 0) {
    throw new AiGatewayError('bad_request', 'Projekt nemá žádné sloupce.');
  }
};

/** Karta poslaná klientem (rozpracovaný úkol v draweru) -> očištěná karta. */
function sanitizeCard(v: unknown): Card {
  const c = record(v, 'card');
  const checklist = list(c.checklist, 'checklist', 100).map((i) => {
    const r = record(i, 'checklist');
    return { id: str(r.id ?? 'x', 'id', 100), text: str(r.text ?? '', 'text', 500), completed: r.completed === true };
  });
  const comments = list(c.comments, 'comments', 100).map((i) => {
    const r = record(i, 'comments');
    return {
      id: str(r.id ?? 'x', 'id', 100),
      authorName: str(r.authorName ?? '', 'authorName', 200),
      content: str(r.content ?? '', 'content', 4000),
      createdAt: str(r.createdAt ?? '', 'createdAt', 40),
    };
  });
  return {
    id: str(c.id ?? 'card', 'id', 200),
    title: str(c.title, 'title', 300, { min: 1 }),
    details: typeof c.details === 'string' ? str(c.details, 'details', 8000) : '',
    tag: optStr(c.tag, 'tag', 100),
    priority: oneOf(c.priority, 'priority', PRIORITIES),
    dueDate: optStr(c.dueDate, 'dueDate', 40),
    checklist,
    comments,
    assignees: list(c.assignees, 'assignees', 20).map((a) => sanitizeMember(a)),
  };
}

function sanitizeMember(v: unknown): TeamMember {
  const m = record(v, 'member');
  return {
    id: str(m.id ?? 'member', 'id', 200),
    fullName: str(m.fullName ?? '', 'fullName', 200),
    initials: str(m.initials ?? '', 'initials', 10),
    avatarColor: str(m.avatarColor ?? '#888888', 'avatarColor', 20),
    createdAt: str(m.createdAt ?? '', 'createdAt', 40),
    // e-mail členů se do promptu nikdy neposílá
  };
}

function feature<I>(f: AiFeature<I>): AiFeature<I> {
  return f;
}

export const aiFeatures = {
  chat: feature<{ messages: AiMessage[] }>({
    name: 'chat',
    needsProject: true,
    structured: false,
    contextPurpose: 'chat',
    maxOutputTokens: 2000,
    parse: (b) => {
      const raw = list(b.messages, 'messages', 40);
      if (raw.length === 0) throw new AiGatewayError('bad_request', 'Chybí zprávy konverzace.');
      const messages: AiMessage[] = raw.map((m) => {
        const r = record(m, 'message');
        // Role `system` ani příloha (inlineData) od klienta nikdy -- chat není obecná proxy.
        const role = oneOf(r.role, 'role', ['user', 'assistant'] as const);
        if (!role) throw new AiGatewayError('bad_request', 'Neplatná role zprávy.');
        return { role, content: str(r.content, 'content', 8000, { min: 1 }) };
      });
      if (messages[messages.length - 1].role !== 'user') {
        throw new AiGatewayError('bad_request', 'Poslední zpráva musí být od uživatele.');
      }
      return { messages };
    },
    run: ({ input, board, project, context }) =>
      aiService.executeChat({
        messages: input.messages,
        context: { project: project ?? undefined, columns: board, renderedContext: context?.rendered },
      }),
    // Citace [card:ID] z odpovědi se ověří proti zdrojům kontextu a převedou na [1], [2]... (falešné se zahodí).
    finalize: async ({ response, context }) => linkCitations(response.content, context?.sources ?? []),
  }),

  improve: feature<{ card: Card }>({
    name: 'improve',
    needsProject: true,
    structured: true,
    contextPurpose: 'improve',
    maxOutputTokens: 4000,
    parse: (b) => ({ card: sanitizeCard(b.card) }),
    contextFocus: (input) => ({ cardId: input.card.id }),
    run: ({ input, board, project, context }) =>
      aiService.executeTaskImprove(input.card, { project: project ?? undefined, columns: board, renderedContext: context?.rendered }),
  }),

  generateBacklog: feature<{
    projectDescription: string;
    options: { taskCount?: number; detailLevel?: string; technologies?: string };
  }>({
    name: 'generate_backlog',
    needsProject: true,
    structured: true,
    maxOutputTokens: 4000,
    parse: (b) => {
      const o = isRecord(b.options) ? b.options : {};
      return {
        projectDescription: str(b.projectDescription, 'projectDescription', 4000, { min: 1 }),
        options: {
          taskCount: int(o.taskCount, 'taskCount', 1, 20),
          detailLevel: optStr(o.detailLevel, 'detailLevel', 50),
          technologies: optStr(o.technologies, 'technologies', 500),
        },
      };
    },
    run: ({ input, board, project }) => {
      noEmptyBoard(board);
      const existing = board.flatMap((c) => c.cards).filter((k) => !k.archived);
      return aiService.executeBacklogGenerate(
        project?.name ?? '',
        input.projectDescription,
        board,
        existing,
        input.options
      );
    },
  }),

  generateProject: feature<{
    projectName?: string;
    projectDescription: string;
    projectType?: string;
    technologies?: string;
    detailLevel?: string;
    taskCount?: number;
  }>({
    name: 'generate_project',
    needsProject: false, // vzniká nový projekt, žádný kontext projektu neexistuje
    structured: true,
    maxOutputTokens: 4000,
    parse: (b) => ({
      projectName: optStr(b.projectName, 'projectName', 200),
      projectDescription: str(b.projectDescription, 'projectDescription', 4000, { min: 1 }),
      projectType: optStr(b.projectType, 'projectType', 200),
      technologies: optStr(b.technologies, 'technologies', 500),
      detailLevel: optStr(b.detailLevel, 'detailLevel', 50),
      taskCount: int(b.taskCount, 'taskCount', 1, 30),
    }),
    run: ({ input }) =>
      aiService.executeProjectGenerate(
        input.projectName,
        input.projectDescription,
        input.projectType,
        input.technologies,
        input.detailLevel,
        input.taskCount
      ),
  }),

  generateSprint: feature<{ metadata: Record<string, number> }>({
    name: 'generate_sprint',
    needsProject: true,
    structured: true,
    maxOutputTokens: 4000,
    parse: (b) => {
      const meta = isRecord(b.context) && isRecord(b.context.metadata) ? b.context.metadata : {};
      const metadata: Record<string, number> = {};
      const len = int(meta.requestedLength, 'requestedLength', 1, 60);
      const cap = int(meta.requestedCapacity, 'requestedCapacity', 1, 1000);
      if (len !== undefined) metadata.requestedLength = len;
      if (cap !== undefined) metadata.requestedCapacity = cap;
      return { metadata };
    },
    run: ({ input, board, project }) => {
      // Plánuje se jen otevřená práce: ne archivované a ne karty ve sloupcích „Hotovo".
      const cards = board
        .filter((c) => !isDoneColumn(c))
        .flatMap((c) => c.cards)
        .filter((k) => !k.archived);
      if (cards.length === 0) throw new AiGatewayError('bad_request', 'V projektu nejsou žádné otevřené úkoly k naplánování.');
      return aiService.executeSprintPlanning(cards, { project: project ?? undefined, metadata: input.metadata });
    },
  }),

  riskAnalysis: feature<Record<string, never>>({
    name: 'risk_analysis',
    needsProject: true,
    structured: true,
    contextPurpose: 'risk',
    maxOutputTokens: 4000,
    parse: () => ({}),
    run: ({ board, project, context }) => {
      noEmptyBoard(board);
      return aiService.executeRiskAnalysis(project?.name ?? '', board, { project: project ?? undefined, columns: board, renderedContext: context?.rendered });
    },
  }),

  projectManager: feature<Record<string, never>>({
    name: 'project_manager',
    needsProject: true,
    structured: true,
    contextPurpose: 'pm',
    maxOutputTokens: 4000,
    parse: () => ({}),
    // Bez aktivních úkolů není co analyzovat: deterministická odpověď, žádný poplatek za model.
    precompute: ({ board, context }) => {
      noEmptyBoard(board);
      if (!context || context.facts.counts.active > 0) return null;
      return {
        summary: 'Projekt nemá žádné aktivní úkoly, není co analyzovat.',
        healthScore: context.facts.health.score,
        confidenceScore: 100,
        risks: [],
        blockers: [],
        suggestedChanges: [],
      };
    },
    run: ({ board, project, context }) => {
      noEmptyBoard(board);
      return aiService.executeProjectManager(board, { project: project ?? undefined, renderedContext: context?.rendered });
    },
    // Skóre zdraví je jedna věc napříč aplikací (vzorec z faktů); model ho nevrací a nemůže ho přepsat.
    postprocess: ({ parsed, context }) => ({
      ...(typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}),
      healthScore: context?.facts.health.score ?? 0,
    }),
  }),

  dailyBrief: feature<{ activityLogsText: string }>({
    name: 'daily_brief',
    needsProject: true,
    structured: true,
    contextPurpose: 'daily',
    maxOutputTokens: 3000,
    // `activityLogsText` se přijímá kvůli kompatibilitě, ale s kontextem z engine se nepoužije (aktivitu čte server z DB).
    parse: (b) => ({ activityLogsText: typeof b.activityLogsText === 'string' ? str(b.activityLogsText, 'activityLogsText', 8000) : '' }),
    precompute: ({ board, context }) => {
      noEmptyBoard(board);
      if (!context || context.facts.counts.total > 0 || context.sources.some((s) => s.kind === 'activity')) return null;
      return {
        greeting: 'Dobré ráno!',
        executiveSummary: 'Projekt zatím neobsahuje žádné úkoly ani aktivitu.',
        completedYesterday: [],
        topPrioritiesToday: [],
        capacityAlerts: [],
        recommendedActions: ['Přidejte první úkoly na nástěnku.'],
      };
    },
    run: ({ input, board, project, context }) => {
      noEmptyBoard(board);
      return aiService.executeDailyBrief(board, input.activityLogsText, { project: project ?? undefined, renderedContext: context?.rendered });
    },
  }),

  capacityPlanning: feature<{ members: TeamMember[] }>({
    name: 'capacity_planning',
    needsProject: true,
    structured: true,
    contextPurpose: 'capacity',
    maxOutputTokens: 4000,
    parse: (b) => ({ members: list(b.members, 'members', 50).map(sanitizeMember) }),
    // Bez členů týmu není mezi kým přerozdělovat: prázdný plán bez volání modelu.
    precompute: ({ input, board }) => {
      noEmptyBoard(board);
      return input.members.length === 0 ? { totalCapacityHours: 0, allocatedHours: 0, workloadByMember: [], rebalanceSuggestions: [] } : null;
    },
    run: ({ input, board, project, context }) => {
      noEmptyBoard(board);
      return aiService.executeCapacityPlanning(board, input.members, { project: project ?? undefined, renderedContext: context?.rendered });
    },
  }),

  analyzeResource: feature<{ filename: string; fileContentText: string }>({
    name: 'analyze_resource',
    needsProject: true,
    structured: true,
    maxOutputTokens: 4000,
    parse: (b) => ({
      filename: str(b.filename, 'filename', 300, { min: 1 }),
      fileContentText: str(b.fileContentText, 'fileContentText', 60_000, { min: 1 }),
    }),
    run: ({ input, project }) =>
      aiService.executeResourceAnalysis(input.filename, input.fileContentText, { project: project ?? undefined }),
  }),

  voiceAction: feature<{ transcript: string; audioBase64?: string; mimeType?: string }>({
    name: 'voice_action',
    needsProject: true,
    structured: true,
    maxBodyBytes: 3 * 1024 * 1024, // krátká hlasová nahrávka v base64
    maxOutputTokens: 2000,
    parse: (b) => {
      const transcript = typeof b.transcript === 'string' ? str(b.transcript, 'transcript', 2000) : '';
      const audioBase64 = optStr(b.audioBase64, 'audioBase64', 2_800_000);
      const mimeType = oneOf(b.mimeType, 'mimeType', AUDIO_MIME);
      if (!transcript && !audioBase64) throw new AiGatewayError('bad_request', 'Chybí přepis ani audio nahrávka.');
      if (audioBase64 && !mimeType) throw new AiGatewayError('bad_request', 'U audia chybí platný mimeType.');
      if (audioBase64 && !/^[A-Za-z0-9+/=]+$/.test(audioBase64)) throw new AiGatewayError('bad_request', 'Audio není platné base64.');
      return { transcript, audioBase64, mimeType };
    },
    run: ({ input, board, project }) =>
      aiService.executeVoiceAction(input.transcript, board, { project: project ?? undefined }, input.audioBase64, input.mimeType),
  }),
};
