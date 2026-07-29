import { useState, useCallback, useEffect } from 'react';
import { Column, Card, Assignee, ChecklistItem, Comment, ActivityLog, TeamMember } from '../types/kanban';
import { kanbanService } from '../services/kanbanService';
import { collaborationService } from '../services/collaborationService';
import { workspaceService, ownerMemberFromProfile } from '../services/workspaceService';
import { persistenceStatus } from '../services/persistence';
import { toPrimaryAssignee, legacyAssigneeToMember, resolveBoardAssignees } from '../utils/assignees';
import { INITIAL_COLUMNS } from '../data/dummyData';
import { useAuth } from './useAuth';
import { useRealtimeBoard } from './useRealtimeBoard';
import { hasSupabaseConfig } from '../lib/supabase';

export function useKanbanBoard(projectId?: string) {
  const { user, profile } = useAuth();
  const userId = user?.id || 'guest';
  const activeProjectId = projectId === 'project-default' || !projectId
    ? `project-default-${userId}`
    : projectId;

  // Inicializujeme sloupce s projektovými ID, aby se předešlo hydration shiftům
  const getInitialColumns = (): Column[] => {
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

  // Transparentní hlášení selhání zápisů do databáze (Release 21)
  useEffect(() => persistenceStatus.subscribe(setSyncError), []);

  const [prevProjectId, setPrevProjectId] = useState(activeProjectId);
  if (activeProjectId !== prevProjectId) {
    setPrevProjectId(activeProjectId);
    setColumns(getInitialColumns());
    setTeamMembers([]);
  }

  // Načíst data z databáze při startu projektu
  useEffect(() => {
    let active = true;
    async function loadData() {
      setIsLoading(true);
      try {
        const ownerIdArg = userId === 'guest' ? undefined : userId;
        const [board, projectData, wsMembers] = await Promise.all([
          kanbanService.fetchBoardData(activeProjectId),
          kanbanService.fetchProjectById(activeProjectId),
          workspaceService.fetchMembers(ownerIdArg),
        ]);

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

        if (!memberIds) {
          if (projectData?.teamMembers && projectData.teamMembers.length > 0) {
            // Starší projekt: převezmi jeho členy do workspace a odvoď member_ids
            workspace = await workspaceService.ensureMembers(
              userId === 'guest' ? undefined : userId,
              projectData.teamMembers
            );
            memberIds = projectData.teamMembers.map((m) => m.id);
          } else {
            // Nový/výchozí projekt bez členství: všichni členové workspace
            memberIds = workspace.map((m) => m.id);
          }
          // Perzistuj migraci (fire-and-forget, chyby hlásí persistenceStatus)
          kanbanService.setProjectMembers(activeProjectId, memberIds).catch(() => {});
        }

        const projectMembers = workspace.filter((m) => memberIds!.includes(m.id));

        if (active) {
          setWorkspaceMembers(workspace);
          setTeamMembers(projectMembers);
          // Řešitele karet resolvujeme proti členům projektu -> úkol patří
          // jen členům projektu; identita (jméno/barva) je vždy aktuální.
          setColumns(resolveBoardAssignees(board, projectMembers));
          setError(null);
        }
      } catch (err: unknown) {
        if (active) {
          setError(err instanceof Error ? err.message : 'Nepodařilo se načíst data z databáze.');
        }
      } finally {
        if (active) {
          setIsLoading(false);
        }
      }
    }
    loadData();
    return () => {
      active = false;
    };
  }, [activeProjectId, userId, profile]);

  // Zápis do projektového activity feedu (Team Collaboration v1.3, Fáze 5).
  // Fire-and-forget: chyba se nesmí propsat uživateli ani zpomalit hlavní
  // operaci -- collaborationService.logActivity() už sama chybu jen logguje.
  const logProjectActivity = useCallback((
    actionType: string,
    entityType: 'task' | 'column' | 'project' | 'member',
    details?: Record<string, unknown>,
    cardId?: string
  ) => {
    collaborationService.logActivity({
      projectId: activeProjectId,
      cardId,
      actorName: profile?.display_name || user?.email || 'Uživatel',
      actionType,
      entityType,
      details,
    }).catch(() => {});
  }, [activeProjectId, profile?.display_name, user?.email]);

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

    // Optimistická aktualizace lokálního stavu
    let finalPosition = 0;
    setColumns((prev) =>
      prev.map((col) => {
        if (col.id === columnId) {
          finalPosition = col.cards.length;
          return { ...col, cards: [...col.cards, newCard] };
        }
        return col;
      })
    );

    // Asynchronní uložení do databáze (s kontextem projektu)
    kanbanService.createCard(columnId, newCard, finalPosition, activeProjectId);
    logProjectActivity('card_created', 'task', { title }, newCard.id);
    return newCard;
  }, [activeProjectId, teamMembers, logProjectActivity]);

  const addActivity = useCallback((columnId: string, cardId: string, text: string) => {
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

    kanbanService.addActivity(cardId, newActivity);
  }, []);

  const editCard = useCallback((
    columnId: string,
    cardId: string,
    updates: Partial<Card>
  ) => {
    let finalCard: Card | null = null;
    let originalCard: Card | null = null;

    setColumns((prev) =>
      prev.map((col) => {
        if (col.id === columnId) {
          return {
            ...col,
            cards: col.cards.map((c) => {
              if (c.id === cardId) {
                originalCard = c;
                const syncedUpdates = { ...updates };
                if (updates.assignees !== undefined) {
                  syncedUpdates.assignee = toPrimaryAssignee(updates.assignees);
                } else if (updates.assignee !== undefined) {
                  syncedUpdates.assignees = updates.assignee
                    ? [legacyAssigneeToMember(updates.assignee)]
                    : [];
                }
                finalCard = { ...c, ...syncedUpdates };
                return finalCard;
              }
              return c;
            }),
          };
        }
        return col;
      })
    );

    if (finalCard) {
      kanbanService.updateCard(columnId, finalCard, activeProjectId);

      // Log activities dynamically
      if (updates.title !== undefined && originalCard && (originalCard as Card).title !== updates.title) {
        addActivity(columnId, cardId, `Název změněn na: ${updates.title}`);
      }
      if (updates.priority !== undefined && originalCard && (originalCard as Card).priority !== updates.priority) {
        addActivity(columnId, cardId, `Priorita změněna na: ${updates.priority || 'Žádná'}`);
      }
      if (updates.dueDate !== undefined && originalCard && (originalCard as Card).dueDate !== updates.dueDate) {
        if (updates.dueDate) {
          addActivity(columnId, cardId, `Termín změněn na: ${updates.dueDate}`);
        } else {
          addActivity(columnId, cardId, 'Termín splnění byl odstraněn');
        }
      }
      if (updates.details !== undefined && originalCard && (originalCard as Card).details !== updates.details) {
        addActivity(columnId, cardId, 'Popis úkolu byl aktualizován');
      }
      if (updates.tag !== undefined && originalCard && (originalCard as Card).tag !== updates.tag) {
        addActivity(columnId, cardId, `Štítek změněn na: ${updates.tag || 'Žádný'}`);
      }
      if (updates.assignees !== undefined && originalCard) {
        const origNames = ((originalCard as Card).assignees || []).map(a => a.fullName).join(', ') || 'Nepřiřazeno';
        const newNames = updates.assignees.map(a => a.fullName).join(', ') || 'Nepřiřazeno';
        if (origNames !== newNames) {
          addActivity(columnId, cardId, `Přiřazení změněno na: ${newNames}`);
        }
      } else if (updates.assignee !== undefined && originalCard && (originalCard as Card).assignee?.name !== updates.assignee?.name) {
        addActivity(columnId, cardId, `Řešitel změněn na: ${updates.assignee?.name || 'Nepřiřazeno'}`);
      }
    }
  }, [activeProjectId, addActivity]);

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

  const toggleChecklistItem = useCallback((columnId: string, cardId: string, itemId: string) => {
    let itemToUpdate: ChecklistItem | null = null;

    setColumns((prev) =>
      prev.map((col) => {
        if (col.id === columnId) {
          return {
            ...col,
            cards: col.cards.map((c) => {
              if (c.id === cardId) {
                const updatedChecklist = (c.checklist || []).map((item) => {
                  if (item.id === itemId) {
                    itemToUpdate = { ...item, completed: !item.completed };
                    return itemToUpdate;
                  }
                  return item;
                });
                return { ...c, checklist: updatedChecklist };
              }
              return c;
            }),
          };
        }
        return col;
      })
    );

    if (itemToUpdate) {
      kanbanService.updateChecklistItem(itemToUpdate);
      const statusText = (itemToUpdate as ChecklistItem).completed ? 'splněna' : 'označena jako nesplněná';
      addActivity(columnId, cardId, `Položka checklistu "${(itemToUpdate as ChecklistItem).text}" byla ${statusText}`);
    }
  }, [addActivity]);

  const updateChecklistItemText = useCallback((columnId: string, cardId: string, itemId: string, text: string) => {
    let itemToUpdate: ChecklistItem | null = null;

    setColumns((prev) =>
      prev.map((col) => {
        if (col.id === columnId) {
          return {
            ...col,
            cards: col.cards.map((c) => {
              if (c.id === cardId) {
                const updatedChecklist = (c.checklist || []).map((item) => {
                  if (item.id === itemId) {
                    itemToUpdate = { ...item, text };
                    return itemToUpdate;
                  }
                  return item;
                });
                return { ...c, checklist: updatedChecklist };
              }
              return c;
            }),
          };
        }
        return col;
      })
    );

    if (itemToUpdate) {
      kanbanService.updateChecklistItem(itemToUpdate);
    }
  }, []);

  const deleteChecklistItem = useCallback((columnId: string, cardId: string, itemId: string) => {
    let deletedItemText = '';

    setColumns((prev) =>
      prev.map((col) => {
        if (col.id === columnId) {
          return {
            ...col,
            cards: col.cards.map((c) => {
              if (c.id === cardId) {
                const found = (c.checklist || []).find((i) => i.id === itemId);
                if (found) deletedItemText = found.text;
                return {
                  ...c,
                  checklist: (c.checklist || []).filter((item) => item.id !== itemId),
                };
              }
              return c;
            }),
          };
        }
        return col;
      })
    );

    kanbanService.deleteChecklistItem(itemId);
    if (deletedItemText) {
      addActivity(columnId, cardId, `Odstraněna položka checklistu: ${deletedItemText}`);
    }
  }, [addActivity]);

  const addComment = useCallback((columnId: string, cardId: string, authorName: string, content: string) => {
    const newComment: Comment = {
      id: `comment-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      authorName,
      content,
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
                  comments: [...(c.comments || []), newComment],
                };
              }
              return c;
            }),
          };
        }
        return col;
      })
    );

    kanbanService.addComment(cardId, newComment);
    addActivity(columnId, cardId, `Přidán komentář od: ${authorName}`);
  }, [addActivity]);

  const deleteCard = useCallback((columnId: string, cardId: string) => {
    const cardTitle = columns.find((col) => col.id === columnId)?.cards.find((c) => c.id === cardId)?.title;

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
    logProjectActivity('card_archived', 'task', { title: cardTitle }, cardId);
  }, [addActivity, columns, logProjectActivity]);

  const moveCard = useCallback((cardId: string, sourceColumnId: string, destinationColumnId: string) => {
    if (sourceColumnId === destinationColumnId) return;

    const sourceColName = columns.find((c) => c.id === sourceColumnId)?.name;
    const destColName = columns.find((c) => c.id === destinationColumnId)?.name;

    let targetCard: Card | null = null;
    let finalPosition = 0;

    // Optimistická aktualizace lokálního stavu
    setColumns((prev) => {
      const sourceCol = prev.find((col) => col.id === sourceColumnId);
      const cardToMove = sourceCol?.cards.find((card) => card.id === cardId);
      if (!cardToMove) return prev;

      targetCard = cardToMove;

      return prev.map((col) => {
        if (col.id === sourceColumnId) {
          return { ...col, cards: col.cards.filter((card) => card.id !== cardId) };
        }
        if (col.id === destinationColumnId) {
          finalPosition = col.cards.length;
          return { ...col, cards: [...col.cards, cardToMove] };
        }
        return col;
      });
    });

    // Asynchronní přesun v databázi
    if (targetCard) {
      kanbanService.moveCard(cardId, sourceColumnId, destinationColumnId, finalPosition, activeProjectId);
      logProjectActivity('card_moved', 'task', {
        title: (targetCard as Card).title,
        from: sourceColName,
        to: destColName,
      }, cardId);
    }
  }, [activeProjectId, columns, logProjectActivity]);

  const renameColumn = useCallback((columnId: string, newName: string) => {
    // Optimistická aktualizace lokálního stavu
    setColumns((prev) =>
      prev.map((col) => (col.id === columnId ? { ...col, name: newName } : col))
    );

    // Asynchronní uložení do databáze
    kanbanService.updateColumnName(columnId, newName, activeProjectId);
  }, [activeProjectId]);

  const addColumn = useCallback(async (name: string) => {
    const position = columns.length;
    try {
      const newCol = await kanbanService.createColumn(activeProjectId, name, position);
      setColumns((prev) => [...prev, newCol]);
      logProjectActivity('column_created', 'column', { name });
    } catch (err) {
      // Selhání je uživateli nahlášeno přes persistenceStatus (syncError)
      console.error('Failed to add column:', err);
    }
  }, [activeProjectId, columns.length, logProjectActivity]);

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
    logProjectActivity('column_deleted', 'column', { name: colToDelete.name });
  }, [activeProjectId, columns, logProjectActivity]);

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
    await kanbanService.reorderColumns(activeProjectId, updated).catch((err) => {
      console.error('Failed to reorder columns:', err);
    });
  }, [activeProjectId, columns]);

  const reorderColumns = useCallback(async (newOrder: Column[]) => {
    setColumns(newOrder);
    await kanbanService.reorderColumns(activeProjectId, newOrder).catch((err) => {
      console.error('Failed to reorder columns:', err);
    });
  }, [activeProjectId]);

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
    const prevIds = teamMembers.map((m) => m.id);
    const nextMembers = workspaceMembers.filter((m) => memberIds.includes(m.id));
    const added = nextMembers.filter((m) => !prevIds.includes(m.id));
    const removed = teamMembers.filter((m) => !memberIds.includes(m.id));

    setTeamMembers(nextMembers);
    // Karty resolvuj proti nové množině členů projektu (odebraní zmizí z úkolů)
    setColumns((prevCols) => resolveBoardAssignees(prevCols, nextMembers));
    await kanbanService.setProjectMembers(activeProjectId, memberIds).catch((err) => {
      console.error('Failed to save project members:', err);
    });
    added.forEach((m) => logProjectActivity('member_added', 'member', { name: m.fullName }));
    removed.forEach((m) => logProjectActivity('member_removed', 'member', { name: m.fullName }));
  }, [activeProjectId, workspaceMembers, teamMembers, logProjectActivity]);

  // --- Realtime sync (Team Collaboration v1.3, Fáze 6) ---
  // Cílené immutable aktualizace do Column[] -- ne plný refetch. Merge je
  // idempotentní (nahrazení podle id), takže echo vlastní optimistické
  // změny je neškodné (přepíše stejnými daty).
  //
  // Známé omezení: realtime payload z holé `cards` řady neobsahuje
  // checklist/komentáře/aktivity/řešitele (ty žijí v join tabulkách bez
  // odběru) -- update proto slučuje jen základní pole a zachovává, co má
  // klient už lokálně načtené. Nová karta od někoho jiného se tedy objeví
  // bez řešitelů, dokud se stránka znovu nenačte.
  const onRealtimeCardChange = useCallback((
    event: 'INSERT' | 'UPDATE' | 'DELETE',
    newRow: { id: string; column_id: string; title: string; details: string | null; tag: string | null; priority: 'Low' | 'Medium' | 'High' | null; due_date: string | null; position: number; archived: boolean; created_at: string; updated_at: string } | null,
    oldRow: { id: string } | null
  ) => {
    if (event === 'DELETE') {
      const deletedId = oldRow?.id;
      if (!deletedId) return;
      setColumns((prev) => prev.map((col) => ({ ...col, cards: col.cards.filter((c) => c.id !== deletedId) })));
      return;
    }
    if (!newRow) return;

    setColumns((prev) => {
      // Karta už existuje lokálně -> jen sloučit základní pole (echo vlastní
      // změny nebo update od kolegy), případně přesunout do jiného sloupce.
      const existingColIndex = prev.findIndex((col) => col.cards.some((c) => c.id === newRow.id));
      if (existingColIndex !== -1) {
        const existingCard = prev[existingColIndex].cards.find((c) => c.id === newRow.id)!;
        const merged: Card = {
          ...existingCard,
          title: newRow.title,
          details: newRow.details || '',
          tag: newRow.tag || undefined,
          priority: newRow.priority || undefined,
          dueDate: newRow.due_date || undefined,
          archived: newRow.archived,
          updatedAt: newRow.updated_at,
        };
        if (prev[existingColIndex].id === newRow.column_id) {
          return prev.map((col, i) => (i === existingColIndex ? { ...col, cards: col.cards.map((c) => (c.id === newRow.id ? merged : c)) } : col));
        }
        // Přesunuto do jiného sloupce (kolega přetáhl kartu)
        return prev.map((col) => {
          if (col.id === prev[existingColIndex].id) {
            return { ...col, cards: col.cards.filter((c) => c.id !== newRow.id) };
          }
          if (col.id === newRow.column_id) {
            return { ...col, cards: [...col.cards, merged] };
          }
          return col;
        });
      }

      // Nová karta od někoho jiného -- vlož do cílového sloupce, pokud existuje.
      if (!prev.some((col) => col.id === newRow.column_id)) return prev;
      const newCard: Card = {
        id: newRow.id,
        title: newRow.title,
        details: newRow.details || '',
        tag: newRow.tag || undefined,
        priority: newRow.priority || undefined,
        dueDate: newRow.due_date || undefined,
        archived: newRow.archived,
        createdAt: newRow.created_at,
        updatedAt: newRow.updated_at,
        assignees: [],
      };
      return prev.map((col) => (col.id === newRow.column_id ? { ...col, cards: [...col.cards, newCard] } : col));
    });
  }, []);

  const onRealtimeColumnChange = useCallback((
    event: 'INSERT' | 'UPDATE' | 'DELETE',
    newRow: { id: string; name: string; project_id: string; position: number } | null,
    oldRow: { id: string } | null
  ) => {
    if (event === 'DELETE') {
      const deletedId = oldRow?.id;
      if (!deletedId) return;
      setColumns((prev) => prev.filter((col) => col.id !== deletedId));
      return;
    }
    if (!newRow) return;

    setColumns((prev) => {
      const exists = prev.some((col) => col.id === newRow.id);
      if (exists) {
        return prev.map((col) => (col.id === newRow.id ? { ...col, name: newRow.name } : col));
      }
      // Nový sloupec od někoho jiného
      return [...prev, { id: newRow.id, name: newRow.name, cards: [] }];
    });
  }, []);

  useRealtimeBoard({
    projectId: activeProjectId,
    enabled: hasSupabaseConfig && Boolean(activeProjectId),
    onCardChange: onRealtimeCardChange,
    onColumnChange: onRealtimeColumnChange,
    onActivityInsert: () => {}, // ActivityFeedDrawer se odebírá samostatně, jen když je otevřený
  });

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
    addColumn,
    deleteColumn,
    moveColumn,
    reorderColumns,
    addChecklistItem,
    toggleChecklistItem,
    updateChecklistItemText,
    deleteChecklistItem,
    addComment,
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
  };
}
