import { useState, useCallback, useEffect, useRef } from 'react';
import { Column, Card, Assignee, ChecklistItem, Comment, ActivityLog, TeamMember, ColumnRole, ProjectRole, ProjectRosterEntry } from '../types/kanban';
import { kanbanService } from '../services/kanbanService';
import { collaborationService } from '../services/collaborationService';
import { detectConflicts, pickBase, isNewer, type EditableField } from '../lib/collab/conflicts';
import type { SyncStatus, ChangeSignal } from './useRealtimeBoard';
import { emitLinksChanged } from '../services/driveService';
import { workspaceService, ownerMemberFromProfile } from '../services/workspaceService';
import { persistenceStatus } from '../services/persistence';
import { toPrimaryAssignee, legacyAssigneeToMember, resolveBoardAssignees } from '../utils/assignees';
import { INITIAL_COLUMNS } from '../data/dummyData';
import { useAuth } from './useAuth';
import { useRealtimeBoard } from './useRealtimeBoard';
import { hasSupabaseConfig } from '../lib/supabase';
import { aiClient } from '../services/ai/aiClient';

export function useKanbanBoard(projectId?: string) {
  const { user, profile } = useAuth();
  const userId = user?.id || 'guest';
  const activeProjectId = projectId === 'project-default' || !projectId
    ? `project-default-${userId}`
    : projectId;

  // AI endpointy dostanou id projektu, ve kterém uživatel pracuje (server ověří
  // členství a načte kontext sám). Používá se rozlišené id, ne 'project-default'.
  useEffect(() => {
    aiClient.setActiveProject(activeProjectId);
    return () => aiClient.setActiveProject(null);
  }, [activeProjectId]);

  // Inicializujeme sloupce s projektovými ID, aby se předešlo hydration shiftům
  const getInitialColumns = (): Column[] => {
    // Supabase mode: never show (or let the user act on) demo/local columns before the DATABASE board has
    // loaded. Their ids ('column-1') are not the project-scoped ids stored in the DB, so a card added in that
    // window was refused by RLS (403) and the optimistic card vanished. Verified against the hosted project.
    if (hasSupabaseConfig) return [];
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem(`kanban_board_${activeProjectId}`);
      if (stored) return JSON.parse(stored);
    }
    const isDefault = activeProjectId.startsWith('project-default');
    return INITIAL_COLUMNS.map((col) => ({
      id: isDefault ? col.id : `${activeProjectId}-${col.id}`,
      name: col.name,
      cards: isDefault
        ? col.cards.map((card) => ({
            ...card,
            id: card.id,
          }))
        : [], // Nový board nesmí obsahovat žádné karty
    }));
  };

  const [columns, setColumns] = useState<Column[]>(getInitialColumns);
  // workspaceMembers = všichni členové workspace (identita).
  // teamMembers = členové aktuálního projektu (podmnožina, odvozeno z memberIds).
  const [workspaceMembers, setWorkspaceMembers] = useState<TeamMember[]>([]);
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  // Collaboration (RUN 01): the caller's role decides what the UI offers; the database enforces it.
  const [myRole, setMyRole] = useState<ProjectRole | null>(hasSupabaseConfig ? null : 'owner');
  const [roster, setRoster] = useState<ProjectRosterEntry[]>([]);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('off');
  const [accessRevoked, setAccessRevoked] = useState(false);
  const [conflict, setConflict] = useState<CardConflict | null>(null);
  const [realtimeKey, setRealtimeKey] = useState<string | null>(null);
  // Short Czech notice for a refused/conflicting collaborative edit (RUN 01B).
  const [notice, setNotice] = useState<string | null>(null);
  const dismissNotice = useCallback(() => setNotice(null), []);
  // Latest board for async callbacks (realtime merges, write results) without stale closures.
  const columnsRef = useRef<Column[]>([]);
  useEffect(() => { columnsRef.current = columns; }, [columns]);
  // Server positions of the columns (seeded from each load, which is ordered by position): lets a
  // colleague's reorder be applied live.
  const positionsRef = useRef(new Map<string, number>());
  // Cards with a write in flight: a refetch must not paint an older server copy over the optimistic one.
  const pendingWrites = useRef(new Map<string, number>());

  // Transparentní hlášení selhání zápisů do databáze (Release 21)
  useEffect(() => persistenceStatus.subscribe(setSyncError), []);

  const [prevProjectId, setPrevProjectId] = useState(activeProjectId);
  if (activeProjectId !== prevProjectId) {
    setPrevProjectId(activeProjectId);
    setColumns(getInitialColumns());
    setTeamMembers([]);
    setRoster([]);
    setMyRole(hasSupabaseConfig ? null : 'owner');
    setAccessRevoked(false);
    setConflict(null);
  }

  // Načíst data z databáze při startu projektu (a znovu po výpadku realtime spojení)
  const loadSeq = useRef(0);
  const reloadBoard = useCallback(async (opts: { silent?: boolean } = {}) => {
    const seq = ++loadSeq.current;
    const isCurrent = () => seq === loadSeq.current;
    if (!opts.silent) setIsLoading(true);
    try {
      const ownerIdArg = userId === 'guest' ? undefined : userId;
      const [board, projectData, wsMembers, role, rosterRows] = await Promise.all([
        kanbanService.fetchBoardData(activeProjectId),
        kanbanService.fetchProjectById(activeProjectId),
        workspaceService.fetchMembers(ownerIdArg),
        hasSupabaseConfig && userId !== 'guest'
          ? collaborationService.fetchMyRole(activeProjectId).catch(() => null)
          : Promise.resolve<ProjectRole | null>('owner'),
        hasSupabaseConfig ? collaborationService.fetchRoster(activeProjectId).catch(() => []) : Promise.resolve([]),
      ]);
      const key = hasSupabaseConfig && role ? await kanbanService.fetchRealtimeKey(activeProjectId).catch(() => null) : null;

      // Release 23: přihlášený účet je členem svého workspace (owner).
      let workspace = wsMembers;
      if (profile) {
        const owner = ownerMemberFromProfile(profile);
        if (!workspace.some((m) => m.id === owner.id)) {
          workspace = await workspaceService.ensureMembers(ownerIdArg, [owner]);
        }
      }

      // Určení členství projektu + jednorázová migrace z R21 (team_members -> member_ids)
      let memberIds = projectData?.memberIds;
      const isProjectOwner = !hasSupabaseConfig || !projectData?.user_id || projectData.user_id === userId;

      if (!memberIds && isProjectOwner) {
        if (projectData?.teamMembers && projectData.teamMembers.length > 0) {
          // Starší projekt: převezmi jeho členy do workspace a odvoď member_ids
          workspace = await workspaceService.ensureMembers(
            userId === 'guest' ? undefined : userId,
            projectData.teamMembers
          );
          memberIds = projectData.teamMembers.map((m) => m.id);
        } else if (hasSupabaseConfig) {
          // RUN 01 (least privilege): a new project is shared with nobody until its owner adds
          // people. It used to grant every linked collaborator of the workspace access silently.
          memberIds = workspace.filter((m) => m.profileId && m.profileId === userId).map((m) => m.id);
        } else {
          // Demo: jeden lokální uživatel, všichni (fiktivní) členové workspace
          memberIds = workspace.map((m) => m.id);
        }
        // Perzistuj migraci (fire-and-forget, chyby hlásí persistenceStatus)
        kanbanService.setProjectMembers(activeProjectId, memberIds).catch(() => {});
      }

      // Supabase: the roster (project_members + identities of the OWNER's workspace) is authoritative --
      // an invited collaborator's own workspace does not contain the project's people.
      const projectMembers = hasSupabaseConfig && rosterRows.length > 0
        ? rosterRows.map((r) => r.member)
        : workspace.filter((m) => (memberIds ?? []).includes(m.id));

      if (isCurrent()) {
        setWorkspaceMembers(workspace);
        setTeamMembers(projectMembers);
        setRoster(rosterRows);
        setMyRole(role);
        setRealtimeKey(key);
        setAccessRevoked(hasSupabaseConfig && userId !== 'guest' && role === null && projectData === null);
        // Řešitele karet resolvujeme proti členům projektu -> úkol patří
        // jen členům projektu; identita (jméno/barva) je vždy aktuální.
        setColumns(resolveBoardAssignees(board, projectMembers));
        positionsRef.current = new Map(board.map((col, index) => [col.id, index]));
        setError(null);
      }
    } catch (err: unknown) {
      if (isCurrent()) {
        setError(err instanceof Error ? err.message : 'Nepodařilo se načíst data z databáze.');
      }
    } finally {
      if (isCurrent() && !opts.silent) {
        setIsLoading(false);
      }
    }
  }, [activeProjectId, userId, profile]);

  useEffect(() => {
    // Initial load of this project; reloadBoard sets state only after its awaits resolve.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reloadBoard();
    return () => {
      loadSeq.current += 1; // results of a superseded load are dropped
    };
  }, [reloadBoard]);

  // Project activity (timeline) is written by the DATABASE from the trusted operations themselves
  // (RUN 01, migration 20261124001000) -- the client no longer logs events of its own.

  const teamMembersRef = useRef<TeamMember[]>([]);
  useEffect(() => { teamMembersRef.current = teamMembers; }, [teamMembers]);

  /** Replace one card with the authoritative server copy (after a failed write or a realtime signal). */
  const applyServerCard = useCallback((cardId: string, fetched: { card: Card; columnId: string } | null, force = false) => {
    setColumns((prev) => {
      const without = prev.map((col) => ({ ...col, cards: col.cards.filter((c) => c.id !== cardId) }));
      if (!fetched) {
        return prev.some((col) => col.cards.some((c) => c.id === cardId)) ? without : prev;
      }
      const local = prev.flatMap((col) => col.cards).find((c) => c.id === cardId);
      if (!force && !isNewer(local, fetched.card)) return prev;
      if (!prev.some((col) => col.id === fetched.columnId)) return without; // column not loaded (yet)
      const [resolved] = resolveBoardAssignees([{ id: fetched.columnId, name: '', cards: [fetched.card] }], teamMembersRef.current)[0].cards;
      const sameColumn = prev.find((col) => col.cards.some((c) => c.id === cardId))?.id === fetched.columnId;
      return prev.map((col) => {
        if (col.id !== fetched.columnId) return { ...col, cards: col.cards.filter((c) => c.id !== cardId) };
        if (sameColumn) return { ...col, cards: col.cards.map((c) => (c.id === cardId ? resolved : c)) };
        return { ...col, cards: [...col.cards.filter((c) => c.id !== cardId), resolved] };
      });
    });
  }, []);

  const reconcileCard = useCallback(async (cardId: string) => {
    if (!hasSupabaseConfig) return;
    applyServerCard(cardId, await kanbanService.fetchCard(cardId), true);
  }, [applyServerCard]);

  const addCard = useCallback((
    columnId: string,
    title: string,
    details: string,
    tag?: string,
    priority?: 'Low' | 'Medium' | 'High',
    assignee?: Assignee,
    dueDate?: string,
    assignees?: TeamMember[]
  ): Card => {
    const finalAssignees = assignees || (assignee ? [
      teamMembers.find(m => m.fullName === assignee.name) || legacyAssigneeToMember(assignee)
    ] : []);

    const finalAssignee = assignee || toPrimaryAssignee(finalAssignees);

    const newCard: Card = {
      id: `card-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      title,
      details,
      tag,
      priority,
      assignee: finalAssignee,
      assignees: finalAssignees,
      dueDate,
      archived: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Position from the current state (an updater-assigned variable is not set yet when it is read below).
    const finalPosition = columns.find((col) => col.id === columnId)?.cards.length ?? 0;
    setColumns((prev) =>
      prev.map((col) => (col.id === columnId ? { ...col, cards: [...col.cards, newCard] } : col))
    );

    // Asynchronní uložení do databáze (s kontextem projektu); failed optimistic insert is rolled back
    pendingWrites.current.set(newCard.id, (pendingWrites.current.get(newCard.id) ?? 0) + 1);
    Promise.resolve(kanbanService.createCard(columnId, newCard, finalPosition, activeProjectId)).then((ok) => {
      const left = (pendingWrites.current.get(newCard.id) ?? 1) - 1;
      if (left <= 0) pendingWrites.current.delete(newCard.id); else pendingWrites.current.set(newCard.id, left);
      if (ok === false) void reconcileCard(newCard.id);
    });
    return newCard;
  }, [activeProjectId, teamMembers, columns, reconcileCard]);

  const addActivity = useCallback((columnId: string, cardId: string, text: string) => {
    if (hasSupabaseConfig) return; // trusted server-side history only
    const newActivity: ActivityLog = {
      id: `act-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      text,
      createdAt: new Date().toISOString(),
    };

    setColumns((prev) =>
      prev.map((col) => {
        if (col.id === columnId) {
          return {
            ...col,
            cards: col.cards.map((c) => {
              if (c.id === cardId) {
                return {
                  ...c,
                  activities: [...(c.activities || []), newActivity],
                };
              }
              return c;
            }),
          };
        }
        return col;
      })
    );

    // Supabase: the database records trusted task history itself (RUN 01B); nothing is written from here.
    kanbanService.addActivity(cardId, newActivity);
  }, []);

  /** Write `finalCard` with a version check; on a stale version merge field by field (see lib/collab/conflicts). */
  const persistCardEdit = useCallback((
    firstColumnId: string,
    firstCard: Card,
    updates: Partial<Card>,
    firstBase: Partial<Card>,
    firstVersion: number | undefined
  ): Promise<void> => {
   const attemptWrite = async (columnId: string, finalCard: Card, base: Partial<Card>, expectedVersion: number | undefined, attempt: number): Promise<void> => {
    pendingWrites.current.set(finalCard.id, (pendingWrites.current.get(finalCard.id) ?? 0) + 1);
    const result = (await kanbanService.updateCard(columnId, finalCard, activeProjectId, expectedVersion)) ?? { status: 'ok' as const };
    const left = (pendingWrites.current.get(finalCard.id) ?? 1) - 1;
    if (left <= 0) pendingWrites.current.delete(finalCard.id); else pendingWrites.current.set(finalCard.id, left);

    if (result.status === 'ok') {
      if (result.version !== undefined) {
        setColumns((prev) => prev.map((col) => ({
          ...col,
          cards: col.cards.map((c) => (c.id === finalCard.id && (c.version ?? 0) < result.version! ? { ...c, version: result.version } : c)),
        })));
      }
      return;
    }
    if (result.status === 'error') {
      void reconcileCard(finalCard.id); // optimistic change failed -> show the authoritative state
      return;
    }
    // Conflict: somebody saved in between.
    const theirs = result.current;
    if (!theirs || !result.columnId) { void reconcileCard(finalCard.id); return; }
    const fields = detectConflicts(base, updates, theirs);
    if (fields.length === 0 && attempt < 2) {
      // They changed other fields only: keep theirs, re-apply mine on top, retry with their version.
      const rebased: Card = { ...theirs, ...updates };
      setColumns((prev) => prev.map((col) => ({ ...col, cards: col.cards.map((c) => (c.id === theirs.id ? { ...rebased, assignee: toPrimaryAssignee(rebased.assignees ?? []) } : c)) })));
      await attemptWrite(result.columnId, { ...rebased, assignee: toPrimaryAssignee(rebased.assignees ?? []) }, pickBase(theirs, updates), theirs.version, attempt + 1);
      return;
    }
    applyServerCard(theirs.id, { card: theirs, columnId: result.columnId }, true);
    setConflict({ cardId: theirs.id, columnId: result.columnId, fields, mine: updates, theirs });
   };
   return attemptWrite(firstColumnId, firstCard, firstBase, firstVersion, 0);
  }, [activeProjectId, applyServerCard, reconcileCard]);

  const editCard = useCallback((
    columnId: string,
    cardId: string,
    updates: Partial<Card>,
    baseSnapshot?: Partial<Card>
  ) => {
    // Persisted values come from the CURRENT state, not from inside the setColumns updater (React runs an
    // updater lazily; a variable assigned there is still null when checked, so the DB write was skipped --
    // reproduced on the hosted project for the drag&drop move, same pattern here).
    const originalCard: Card | null = columns.find((col) => col.id === columnId)?.cards.find((c) => c.id === cardId) ?? null;
    if (!originalCard) return;
    const syncedUpdates = { ...updates };
    if (updates.assignees !== undefined) {
      syncedUpdates.assignee = toPrimaryAssignee(updates.assignees);
    } else if (updates.assignee !== undefined) {
      syncedUpdates.assignees = updates.assignee
        ? [legacyAssigneeToMember(updates.assignee)]
        : [];
    }

    // The editor started from `baseSnapshot` (e.g. the drawer field when focused). If a colleague's
    // change already arrived in the meantime and touches the same field, do not overwrite it blindly.
    const base = baseSnapshot ?? pickBase(originalCard, syncedUpdates);
    const early = hasSupabaseConfig ? detectConflicts(base, syncedUpdates, originalCard) : [];
    if (early.length > 0) {
      setConflict({ cardId, columnId, fields: early, mine: syncedUpdates, theirs: originalCard });
      return;
    }
    const finalCard: Card = { ...originalCard, ...syncedUpdates };

    setColumns((prev) =>
      prev.map((col) =>
        col.id === columnId
          ? { ...col, cards: col.cards.map((c) => (c.id === cardId ? { ...c, ...syncedUpdates } : c)) }
          : col
      )
    );

    void persistCardEdit(columnId, finalCard, syncedUpdates, pickBase(originalCard, syncedUpdates), originalCard.version);

    // Per-card history (task_activities, shown in the task drawer)
    if (updates.title !== undefined && originalCard.title !== updates.title) {
      addActivity(columnId, cardId, `Název změněn na: ${updates.title}`);
    }
    if (updates.priority !== undefined && originalCard.priority !== updates.priority) {
      addActivity(columnId, cardId, `Priorita změněna na: ${updates.priority || 'Žádná'}`);
    }
    if (updates.dueDate !== undefined && originalCard.dueDate !== updates.dueDate) {
      addActivity(columnId, cardId, updates.dueDate ? `Termín změněn na: ${updates.dueDate}` : 'Termín splnění byl odstraněn');
    }
    if (updates.details !== undefined && originalCard.details !== updates.details) {
      addActivity(columnId, cardId, 'Popis úkolu byl aktualizován');
    }
    if (updates.tag !== undefined && originalCard.tag !== updates.tag) {
      addActivity(columnId, cardId, `Štítek změněn na: ${updates.tag || 'Žádný'}`);
    }
    if (updates.assignees !== undefined) {
      const origNames = (originalCard.assignees || []).map(a => a.fullName).join(', ') || 'Nepřiřazeno';
      const newNames = updates.assignees.map(a => a.fullName).join(', ') || 'Nepřiřazeno';
      if (origNames !== newNames) {
        addActivity(columnId, cardId, `Přiřazení změněno na: ${newNames}`);
      }
    } else if (updates.assignee !== undefined && originalCard.assignee?.name !== updates.assignee?.name) {
      addActivity(columnId, cardId, `Řešitel změněn na: ${updates.assignee?.name || 'Nepřiřazeno'}`);
    }
  }, [addActivity, columns, persistCardEdit]);

  /** Conflict dialog: keep the colleague's version (already shown) or write mine over it. */
  const resolveConflict = useCallback((choice: 'theirs' | 'mine') => {
    const c = conflict;
    setConflict(null);
    if (!c || choice === 'theirs') return;
    const current = columnsRef.current.flatMap((col) => col.cards.map((card) => ({ card, columnId: col.id }))).find((x) => x.card.id === c.cardId);
    if (!current) return;
    const forced: Card = { ...current.card, ...c.mine };
    setColumns((prev) => prev.map((col) => ({ ...col, cards: col.cards.map((card) => (card.id === c.cardId ? forced : card)) })));
    void persistCardEdit(current.columnId, forced, c.mine, pickBase(current.card, c.mine), current.card.version);
  }, [conflict, persistCardEdit]);

  const addChecklistItem = useCallback((columnId: string, cardId: string, text: string) => {
    const newItem: ChecklistItem = {
      id: `check-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      text,
      completed: false,
    };

    setColumns((prev) =>
      prev.map((col) => {
        if (col.id === columnId) {
          return {
            ...col,
            cards: col.cards.map((c) => {
              if (c.id === cardId) {
                return {
                  ...c,
                  checklist: [...(c.checklist || []), newItem],
                };
              }
              return c;
            }),
          };
        }
        return col;
      })
    );

    kanbanService.addChecklistItem(cardId, newItem);
    addActivity(columnId, cardId, `Přidána položka checklistu: ${text}`);
  }, [addActivity]);

  const patchChecklist = useCallback((cardId: string, fn: (items: ChecklistItem[]) => ChecklistItem[]) => {
    setColumns((prev) => prev.map((col) => ({
      ...col,
      cards: col.cards.map((c) => (c.id === cardId ? { ...c, checklist: fn(c.checklist || []) } : c)),
    })));
  }, []);

  const toggleChecklistItem = useCallback((columnId: string, cardId: string, itemId: string) => {
    const current = columns.find((col) => col.id === columnId)?.cards.find((c) => c.id === cardId)?.checklist?.find((i) => i.id === itemId);
    if (!current) return;
    const completed = !current.completed;
    patchChecklist(cardId, (items) => items.map((item) => (item.id === itemId ? { ...item, completed } : item)));
    // field-level: only `completed` is written, a concurrent rename of the same item is kept
    void Promise.resolve(kanbanService.updateChecklistItem({ id: itemId }, { completed })).then((r) => {
      if (r?.status === 'gone') {
        patchChecklist(cardId, (items) => items.filter((i) => i.id !== itemId));
        setNotice('Položku checklistu mezitím někdo smazal.');
      } else if (r?.status === 'error') void reconcileCard(cardId);
    });
    const statusText = completed ? 'splněna' : 'označena jako nesplněná';
    addActivity(columnId, cardId, `Položka checklistu "${current.text}" byla ${statusText}`);
  }, [addActivity, columns, patchChecklist, reconcileCard]);

  const updateChecklistItemText = useCallback((columnId: string, cardId: string, itemId: string, text: string, expectedText?: string) => {
    const found = columns.find((col) => col.id === columnId)?.cards.find((c) => c.id === cardId)?.checklist?.find((i) => i.id === itemId);
    if (!found) return;
    // base = the text when editing began (a colleague's rename that arrived meanwhile must not be overwritten)
    const current = { ...found, text: expectedText ?? found.text };
    patchChecklist(cardId, (items) => items.map((item) => (item.id === itemId ? { ...item, text } : item)));
    // only if nobody renamed it meanwhile; otherwise keep theirs and say so
    void Promise.resolve(kanbanService.updateChecklistItem({ id: itemId }, { text, expectedText: current.text })).then((r) => {
      if (r?.status === 'conflict' && r.current) {
        const theirs = r.current;
        patchChecklist(cardId, (items) => items.map((i) => (i.id === itemId ? { ...i, text: theirs.text, completed: theirs.completed } : i)));
        setNotice(`Položku checklistu mezitím přejmenoval kolega na „${theirs.text}“. Vaše úprava „${text}“ nebyla uložena.`);
      } else if (r?.status === 'gone') {
        patchChecklist(cardId, (items) => items.filter((i) => i.id !== itemId));
        setNotice('Položku checklistu mezitím někdo smazal. Vaše úprava nebyla uložena.');
      } else if (r?.status === 'error') void reconcileCard(cardId);
    });
  }, [columns, patchChecklist, reconcileCard]);

  const deleteChecklistItem = useCallback((columnId: string, cardId: string, itemId: string) => {
    const deletedItemText = columns.find((col) => col.id === columnId)?.cards.find((c) => c.id === cardId)?.checklist?.find((i) => i.id === itemId)?.text ?? '';

    setColumns((prev) =>
      prev.map((col) =>
        col.id === columnId
          ? { ...col, cards: col.cards.map((c) => (c.id === cardId ? { ...c, checklist: (c.checklist || []).filter((item) => item.id !== itemId) } : c)) }
          : col
      )
    );

    kanbanService.deleteChecklistItem(itemId);
    if (deletedItemText) {
      addActivity(columnId, cardId, `Odstraněna položka checklistu: ${deletedItemText}`);
    }
  }, [addActivity, columns]);

  const patchComments = useCallback((cardId: string, fn: (comments: Comment[]) => Comment[]) => {
    setColumns((prev) => prev.map((col) => ({
      ...col,
      cards: col.cards.map((c) => (c.id === cardId ? { ...c, comments: fn(c.comments || []) } : c)),
    })));
  }, []);

  /** New comment; `mentions` = profile ids of mentioned project members. Author/time are set by the server. */
  const addComment = useCallback((columnId: string, cardId: string, authorName: string, content: string, mentions: string[] = []) => {
    const newComment: Comment = {
      id: `comment-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      authorName,
      authorId: user?.id,
      content,
      mentions,
      createdAt: new Date().toISOString(),
    };
    patchComments(cardId, (list) => [...list, newComment]);
    Promise.resolve(kanbanService.addComment(cardId, newComment)).then((saved) => {
      if (saved) patchComments(cardId, (list) => list.map((c) => (c.id === saved.id ? saved : c)));
      else if (saved === null) patchComments(cardId, (list) => list.filter((c) => c.id !== newComment.id)); // refused -> roll back
    });
    if (!hasSupabaseConfig) addActivity(columnId, cardId, `Přidán komentář od: ${authorName}`);
  }, [addActivity, patchComments, user?.id]);

  const editComment = useCallback(async (cardId: string, commentId: string, content: string, mentions: string[] = []) => {
    if (!hasSupabaseConfig) {
      patchComments(cardId, (list) => list.map((c) => (c.id === commentId ? { ...c, content, mentions, updatedAt: new Date().toISOString() } : c)));
      return true;
    }
    const saved = await kanbanService.editComment(commentId, content, mentions);
    if (saved) patchComments(cardId, (list) => list.map((c) => (c.id === commentId ? saved : c)));
    return Boolean(saved);
  }, [patchComments]);

  const deleteComment = useCallback(async (cardId: string, commentId: string) => {
    const ok = await kanbanService.deleteComment(commentId);
    if (ok) patchComments(cardId, (list) => list.filter((c) => c.id !== commentId));
    return ok;
  }, [patchComments]);

  const deleteCard = useCallback((columnId: string, cardId: string) => {
    // Optimistická aktualizace - označení jako archivovaný
    setColumns((prev) =>
      prev.map((col) => {
        if (col.id === columnId) {
          return {
            ...col,
            cards: col.cards.map((c) => (c.id === cardId ? { ...c, archived: true } : c)),
          };
        }
        return col;
      })
    );

    // Asynchronní archivace v databázi/lokálně
    kanbanService.archiveCard(cardId, true);
    addActivity(columnId, cardId, 'Úkol byl archivován');
  }, [addActivity]);

  const moveCard = useCallback((cardId: string, sourceColumnId: string, destinationColumnId: string) => {
    if (sourceColumnId === destinationColumnId) return;

    const sourceCol = columns.find((c) => c.id === sourceColumnId);
    const destCol = columns.find((c) => c.id === destinationColumnId);

    // Everything the persistence call needs is derived from the CURRENT state here, not from inside the
    // setColumns updater: React runs an updater lazily (during render), so a variable assigned there was
    // still null when `if (targetCard)` ran and the move was silently NOT written to the database
    // (found on the hosted project: the drop moved the card on screen, the row stayed in its column).
    const targetCard: Card | undefined = sourceCol?.cards.find((card) => card.id === cardId);
    if (!targetCard) return;
    const finalPosition = destCol ? destCol.cards.length : 0;

    // Optimistická aktualizace lokálního stavu
    setColumns((prev) =>
      prev.map((col) => {
        if (col.id === sourceColumnId) return { ...col, cards: col.cards.filter((card) => card.id !== cardId) };
        if (col.id === destinationColumnId) return { ...col, cards: [...col.cards, targetCard] };
        return col;
      })
    );

    // Asynchronní přesun v databázi; failed move -> back to the server's truth
    pendingWrites.current.set(cardId, (pendingWrites.current.get(cardId) ?? 0) + 1);
    Promise.resolve(kanbanService.moveCard(cardId, sourceColumnId, destinationColumnId, finalPosition, activeProjectId)).then((ok) => {
      const left = (pendingWrites.current.get(cardId) ?? 1) - 1;
      if (left <= 0) pendingWrites.current.delete(cardId); else pendingWrites.current.set(cardId, left);
      if (ok === false) void reconcileCard(cardId);
    });
  }, [activeProjectId, columns, reconcileCard]);

  const renameColumn = useCallback((columnId: string, newName: string, expectedName?: string) => {
    const before = expectedName ?? columnsRef.current.find((c) => c.id === columnId)?.name;
    setColumns((prev) => prev.map((col) => (col.id === columnId ? { ...col, name: newName } : col)));
    void Promise.resolve(kanbanService.updateColumnName(columnId, newName, activeProjectId, before)).then((r) => {
      if (r?.status === 'conflict') {
        setColumns((prev) => prev.map((col) => (col.id === columnId ? { ...col, name: r.current ?? col.name } : col)));
        setNotice(`Sloupec mezitím přejmenoval kolega na „${r.current}“. Vaše změna „${newName}“ nebyla uložena.`);
      } else if (r?.status === 'error') {
        void reloadBoard({ silent: true });
      }
    });
  }, [activeProjectId, reloadBoard]);

  const setColumnRole = useCallback((columnId: string, role: ColumnRole | null) => {
    setColumns((prev) => prev.map((col) => (col.id === columnId ? { ...col, role } : col)));
    kanbanService.updateColumnRole(columnId, role, activeProjectId);
  }, [activeProjectId]);

  const addColumn = useCallback(async (name: string) => {
    const position = columns.length;
    try {
      const newCol = await kanbanService.createColumn(activeProjectId, name, position);
      setColumns((prev) => (prev.some((c) => c.id === newCol.id) ? prev : [...prev, newCol]));
    } catch (err) {
      // Selhání je uživateli nahlášeno přes persistenceStatus (syncError)
      console.error('Failed to add column:', err);
    }
  }, [activeProjectId, columns.length]);

  const deleteColumn = useCallback(async (columnId: string, transferColumnId?: string) => {
    const colToDelete = columns.find((c) => c.id === columnId);
    if (!colToDelete) return;

    if (transferColumnId && colToDelete.cards.length > 0) {
      const destCol = columns.find((c) => c.id === transferColumnId);
      if (destCol) {
        for (const card of colToDelete.cards) {
          await kanbanService.moveCard(card.id, columnId, transferColumnId, destCol.cards.length, activeProjectId);
        }
      }
    }

    try {
      await kanbanService.deleteColumn(activeProjectId, columnId);
    } catch (err) {
      console.error('Failed to delete column:', err);
      return;
    }

    setColumns((prev) => {
      let updated = prev.filter((col) => col.id !== columnId);
      if (transferColumnId && colToDelete.cards.length > 0) {
        updated = updated.map((col) => {
          if (col.id === transferColumnId) {
            return {
              ...col,
              cards: [...col.cards, ...colToDelete.cards],
            };
          }
          return col;
        });
      }
      return updated;
    });
  }, [activeProjectId, columns]);

  const moveColumn = useCallback(async (columnId: string, direction: 'left' | 'right') => {
    const index = columns.findIndex((c) => c.id === columnId);
    if (index === -1) return;

    if (direction === 'left' && index === 0) return;
    if (direction === 'right' && index === columns.length - 1) return;

    const newIndex = direction === 'left' ? index - 1 : index + 1;
    const updated = [...columns];
    const [moved] = updated.splice(index, 1);
    updated.splice(newIndex, 0, moved);

    setColumns(updated);
    const r = await kanbanService.reorderColumns(activeProjectId, updated);
    if (r === 'conflict') setNotice('Sloupce se mezitím změnily. Board jsme načetli znovu, upravte pořadí prosím ještě jednou.');
    if (r !== 'ok') void reloadBoard({ silent: true });
  }, [activeProjectId, columns, reloadBoard]);

  const reorderColumns = useCallback(async (newOrder: Column[]) => {
    setColumns(newOrder);
    const r = await kanbanService.reorderColumns(activeProjectId, newOrder);
    if (r === 'conflict') setNotice('Sloupce se mezitím změnily. Board jsme načetli znovu, upravte pořadí prosím ještě jednou.');
    if (r !== 'ok') void reloadBoard({ silent: true });
  }, [activeProjectId, reloadBoard]);

  // Statistiky
  const totalTasks = columns.reduce((acc, col) => acc + col.cards.length, 0);

  const inProgressCol = columns.find((c) => c.name === 'V průběhu' || c.id.endsWith('column-3'));
  const inProgressCount = inProgressCol ? inProgressCol.cards.length : 0;

  const completedCol = columns.find((c) => c.name === 'Hotovo' || c.id.endsWith('column-5'));
  const completedCount = completedCol ? completedCol.cards.length : 0;

  const blockedCount = columns.reduce(
    (acc, col) => acc + col.cards.filter((card) => card.tag === 'Blokováno').length,
    0
  );

  // Filtrování a řazení
  const getProcessedColumns = useCallback((
    searchQuery: string,
    filters: {
      tag?: string;
      priority?: string;
      assignee?: string;
      status?: string;
      dueDateFilter?: string;
      hasChecklist?: string;
      hasComments?: string;
      archivedFilter?: string;
    },
    sortBy: string
  ) => {
    const {
      tag = '',
      priority = '',
      assignee = '',
      status = '',
      dueDateFilter = '',
      hasChecklist = '',
      hasComments = '',
      archivedFilter = 'active',
    } = filters;

    // Filter columns by status first if filter status is set
    const filteredColumns = columns.filter((col) => !status || col.id === status);

    return filteredColumns.map((col) => {
      let processedCards = col.cards.filter((card) => {
        // 1. Search Query (Global Search across Title, Description, Checklist, and Comments)
        const q = searchQuery.trim().toLowerCase();
        const matchesSearch =
          !q ||
          card.title.toLowerCase().includes(q) ||
          card.details.toLowerCase().includes(q) ||
          (card.checklist || []).some((item) => item.text.toLowerCase().includes(q)) ||
          (card.comments || []).some((comment) => comment.content.toLowerCase().includes(q));

        // 2. Tag Filter
        const matchesTag = !tag || card.tag === tag;

        // 3. Priority Filter
        const matchesPriority = !priority || card.priority === priority;

        // 4. Assignee Filter
        let matchesAssignee = true;
        if (assignee) {
          if (assignee === 'unassigned') {
            matchesAssignee = !card.assignee && (!card.assignees || card.assignees.length === 0);
          } else {
            matchesAssignee = card.assignees && card.assignees.length > 0
              ? card.assignees.some((a) => a.fullName === assignee)
              : card.assignee?.name === assignee;
          }
        }

        // 5. Due Date Filter
        let matchesDueDate = true;
        if (dueDateFilter) {
          if (dueDateFilter === 'none') {
            matchesDueDate = !card.dueDate;
          } else if (card.dueDate) {
            const cardDate = new Date(card.dueDate);
            cardDate.setHours(0, 0, 0, 0);
            const today = new Date();
            today.setHours(0, 0, 0, 0);

            if (dueDateFilter === 'today') {
              matchesDueDate = cardDate.getTime() === today.getTime();
            } else if (dueDateFilter === 'week') {
              const nextWeek = new Date(today);
              nextWeek.setDate(today.getDate() + 7);
              matchesDueDate = cardDate.getTime() >= today.getTime() && cardDate.getTime() <= nextWeek.getTime();
            } else if (dueDateFilter === 'overdue') {
              matchesDueDate = cardDate.getTime() < today.getTime();
            }
          } else {
            matchesDueDate = false;
          }
        }

        // 6. Has Checklist Filter
        let matchesChecklist = true;
        if (hasChecklist === 'yes') {
          matchesChecklist = (card.checklist || []).length > 0;
        } else if (hasChecklist === 'no') {
          matchesChecklist = (card.checklist || []).length === 0;
        }

        // 7. Has Comments Filter
        let matchesComments = true;
        if (hasComments === 'yes') {
          matchesComments = (card.comments || []).length > 0;
        } else if (hasComments === 'no') {
          matchesComments = (card.comments || []).length === 0;
        }

        // 8. Archived Filter
        let matchesArchived = true;
        if (archivedFilter === 'active') {
          matchesArchived = !card.archived;
        } else if (archivedFilter === 'archived') {
          matchesArchived = !!card.archived;
        }

        return (
          matchesSearch &&
          matchesTag &&
          matchesPriority &&
          matchesAssignee &&
          matchesDueDate &&
          matchesChecklist &&
          matchesComments &&
          matchesArchived
        );
      });

      // Sorting
      if (sortBy === 'dueDate') {
        processedCards = [...processedCards].sort((a, b) => {
          if (!a.dueDate) return 1;
          if (!b.dueDate) return -1;
          return new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime();
        });
      } else if (sortBy === 'priority') {
        const priorityWeight = { High: 3, Medium: 2, Low: 1 };
        processedCards = [...processedCards].sort((a, b) => {
          const wA = a.priority ? priorityWeight[a.priority] : 0;
          const wB = b.priority ? priorityWeight[b.priority] : 0;
          return wB - wA;
        });
      } else if (sortBy === 'created') {
        processedCards = [...processedCards].sort((a, b) => {
          const tA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
          const tB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
          return tA - tB;
        });
      } else if (sortBy === 'updated') {
        processedCards = [...processedCards].sort((a, b) => {
          const tA = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
          const tB = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
          return tB - tA; // Newest edits first
        });
      } else if (sortBy === 'alphabetical') {
        processedCards = [...processedCards].sort((a, b) => a.title.localeCompare(b.title, 'cs-CZ'));
      }

      return { ...col, cards: processedCards };
    });
  }, [columns]);

  const wsOwnerId = userId === 'guest' ? undefined : userId;

  // --- Workspace members (identita) ---

  const addWorkspaceMember = useCallback(async (memberData: Omit<TeamMember, 'id' | 'createdAt'>) => {
    const newMember = await workspaceService.addMember(wsOwnerId, memberData);
    setWorkspaceMembers((prev) => [...prev, newMember]);
    return newMember;
  }, [wsOwnerId]);

  const editWorkspaceMember = useCallback(async (updatedMember: TeamMember) => {
    const res = await workspaceService.updateMember(wsOwnerId, updatedMember);
    setWorkspaceMembers((prev) => prev.map((m) => (m.id === res.id ? res : m)));
    // Promítni novou identitu do členů projektu i do řešitelů karet
    setTeamMembers((prev) => prev.map((m) => (m.id === res.id ? res : m)));
    setColumns((prevCols) =>
      prevCols.map((col) => ({
        ...col,
        cards: col.cards.map((card) => {
          if (card.assignees && card.assignees.some((m) => m.id === res.id)) {
            const updated = card.assignees.map((m) => (m.id === res.id ? res : m));
            return { ...card, assignees: updated, assignee: toPrimaryAssignee(updated) };
          }
          return card;
        }),
      }))
    );
    return res;
  }, [wsOwnerId]);

  const deleteWorkspaceMember = useCallback(async (memberId: string) => {
    await workspaceService.removeMember(wsOwnerId, memberId);
    setWorkspaceMembers((prev) => prev.filter((m) => m.id !== memberId));

    // Odebrání z workspace znamená odebrání i ze členství projektu (a tím z karet)
    setTeamMembers((prevMembers) => {
      const next = prevMembers.filter((m) => m.id !== memberId);
      if (next.length !== prevMembers.length) {
        kanbanService.setProjectMembers(activeProjectId, next.map((m) => m.id)).catch(() => {});
      }
      return next;
    });
    setColumns((prevCols) =>
      prevCols.map((col) => ({
        ...col,
        cards: col.cards.map((card) => {
          if (card.assignees && card.assignees.some((m) => m.id === memberId)) {
            const updated = card.assignees.filter((m) => m.id !== memberId);
            return { ...card, assignees: updated, assignee: toPrimaryAssignee(updated) };
          }
          return card;
        }),
      }))
    );
  }, [wsOwnerId, activeProjectId]);

  // --- Členství projektu (výběr z workspace) ---

  const setProjectMembers = useCallback(async (memberIds: string[]) => {
    const nextMembers = workspaceMembers.filter((m) => memberIds.includes(m.id));

    setTeamMembers(nextMembers);
    // Karty resolvuj proti nové množině členů projektu (odebraní zmizí z úkolů)
    setColumns((prevCols) => resolveBoardAssignees(prevCols, nextMembers));
    await kanbanService.setProjectMembers(activeProjectId, memberIds).catch((err) => {
      console.error('Failed to save project members:', err);
    });
  }, [activeProjectId, workspaceMembers]);

  // --- Realtime sync (RUN 01B: server broadcasts on the private, keyed project topic) ---
  // A signal names an entity; the card is re-read from the database under RLS and merged only if it is newer
  // than what we show (version / child_rev): echoes, duplicates and out-of-order deliveries are harmless.
  const positionsRefLocal = positionsRef;
  const onCardSignal = useCallback((id: string, removed: boolean, v?: number, r?: number) => {
    if (removed) {
      // deleted, or moved to another project (whose data this board must not show)
      setColumns((prev) => prev.some((col) => col.cards.some((c) => c.id === id))
        ? prev.map((col) => ({ ...col, cards: col.cards.filter((c) => c.id !== id) }))
        : prev);
      return;
    }
    const local = columnsRef.current.flatMap((col) => col.cards).find((c) => c.id === id);
    if (local && v !== undefined && !isNewer(local, { version: v, childRev: r })) return;
    if (pendingWrites.current.has(id)) return; // our own write is in flight; its result reconciles
    void kanbanService.fetchCard(id).then((fetched) => {
      if (pendingWrites.current.has(id)) return;
      applyServerCard(id, fetched);
    });
  }, [applyServerCard]);

  const onColumnSignal = useCallback((sig: Extract<ChangeSignal, { t: 'column' }>) => {
    if (sig.op === 'removed') {
      setColumns((prev) => prev.filter((col) => col.id !== sig.id));
      return;
    }
    positionsRefLocal.current.set(sig.id, sig.position);
    setColumns((prev) => {
      const exists = prev.some((col) => col.id === sig.id);
      const next = exists
        ? prev.map((col) => (col.id === sig.id ? { ...col, name: sig.name, role: (sig.role as ColumnRole | null | undefined) ?? col.role } : col))
        : [...prev, { id: sig.id, name: sig.name, role: (sig.role as ColumnRole | null | undefined) ?? null, cards: [] }];
      const pos = positionsRefLocal.current;
      return next.every((col) => pos.has(col.id)) ? [...next].sort((a, b) => pos.get(a.id)! - pos.get(b.id)!) : next;
    });
  }, [positionsRefLocal]);

  const onMembershipChange = useCallback(() => {
    if (!hasSupabaseConfig) return;
    void Promise.all([
      collaborationService.fetchMyRole(activeProjectId).catch(() => null),
      collaborationService.fetchRoster(activeProjectId).catch(() => null),
      kanbanService.fetchRealtimeKey(activeProjectId).catch(() => null),
    ]).then(([role, rows, key]) => {
      setMyRole(role);
      if (role === null) {
        // removed from the project: stop showing its data at once and leave the channel
        setAccessRevoked(true);
        setRealtimeKey(null);
        setColumns([]);
        setRoster([]);
        setTeamMembers([]);
        return;
      }
      setRealtimeKey(key); // a departure rotates the key: rejoin on the new topic
      if (rows) {
        setRoster(rows);
        setTeamMembers(rows.map((r) => r.member));
      }
    });
  }, [activeProjectId]);

  const onSignal = useCallback((sig: ChangeSignal) => {
    if (sig.t === 'card') onCardSignal(sig.id, sig.op === 'removed', sig.op === 'upsert' ? sig.v : undefined, sig.op === 'upsert' ? sig.r : undefined);
    else if (sig.t === 'column') onColumnSignal(sig);
    else if (sig.t === 'membership') onMembershipChange();
    else if (sig.t === 'links') emitLinksChanged(activeProjectId, sig.card);
  }, [onCardSignal, onColumnSignal, onMembershipChange, activeProjectId]);

  const onResync = useCallback(() => { void reloadBoard({ silent: true }); emitLinksChanged(activeProjectId, null); }, [reloadBoard, activeProjectId]);

  // Presence identity: the name/colour teammates know from the roster.
  const meMember = user?.id ? roster.find((r) => r.member.profileId === user.id)?.member : undefined;
  const meName = meMember?.fullName || profile?.display_name || user?.email?.split('@')[0] || 'Uživatel';
  const activeUsers = useRealtimeBoard({
    projectId: activeProjectId,
    realtimeKey,
    enabled: hasSupabaseConfig && Boolean(activeProjectId) && userId !== 'guest' && !accessRevoked && Boolean(myRole),
    presence: user?.id ? { userId: user.id, name: meName, initials: meMember?.initials || meName.slice(0, 2).toUpperCase(), color: meMember?.avatarColor || '#209dd7' } : null,
    onSignal,
    onResync,
    onStatus: setSyncStatus,
  });

  const canEdit = myRole === 'owner' || myRole === 'admin' || myRole === 'member';
  const canManage = myRole === 'owner' || myRole === 'admin';

  return {
    columns,
    workspaceMembers,
    teamMembers,
    isLoading,
    error,
    syncError,
    addCard,
    editCard,
    deleteCard,
    moveCard,
    renameColumn,
    setColumnRole,
    addColumn,
    deleteColumn,
    moveColumn,
    reorderColumns,
    addChecklistItem,
    toggleChecklistItem,
    updateChecklistItemText,
    deleteChecklistItem,
    addComment,
    editComment,
    deleteComment,
    addActivity,
    totalTasks,
    inProgressCount,
    completedCount,
    blockedCount,
    getProcessedColumns,
    addWorkspaceMember,
    editWorkspaceMember,
    deleteWorkspaceMember,
    setProjectMembers,
    // collaboration (RUN 01)
    myRole,
    canEdit,
    canManage,
    roster,
    syncStatus,
    accessRevoked,
    conflict,
    resolveConflict,
    reloadBoard,
    activeUsers,
    notice,
    dismissNotice,
  };
}

export interface CardConflict {
  cardId: string;
  columnId: string;
  fields: EditableField[];
  mine: Partial<Card>;
  theirs: Card;
}
