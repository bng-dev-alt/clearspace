'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import dynamic from 'next/dynamic';
import { useParams, useRouter } from 'next/navigation';
import Navbar from '../../../components/layout/Navbar';
import HeroSection from '../../../components/layout/HeroSection';
import Toolbar from '../../../components/toolbar/Toolbar';
import StatsRow from '../../../components/toolbar/StatsRow';
import BoardPanel from '../../../components/board/BoardPanel';
import Column from '../../../components/board/Column';
import CalendarView from '../../../components/board/CalendarView';
import AddCardModal from '../../../components/AddCardModal';
import TaskDetailDrawer from '../../../components/board/TaskDetailDrawer';

// Zřídka otevírané AI modaly -- lazy load (menší initial bundle boardu)
const GenerateTasksModal = dynamic(() => import('../../../components/board/GenerateTasksModal'), { ssr: false });
const GenerateSprintModal = dynamic(() => import('../../../components/board/GenerateSprintModal'), { ssr: false });
const RiskAnalysisModal = dynamic(() => import('../../../components/board/RiskAnalysisModal'), { ssr: false });
const ProjectIntelligenceDrawer = dynamic(() => import('../../../components/board/ProjectIntelligenceDrawer'), { ssr: false });
const AiProjectManagerModal = dynamic(() => import('../../../components/board/AiProjectManagerModal'), { ssr: false });
const AiDailyBriefModal = dynamic(() => import('../../../components/board/AiDailyBriefModal'), { ssr: false });
const AiCapacityPlannerModal = dynamic(() => import('../../../components/board/AiCapacityPlannerModal'), { ssr: false });
const GlobalSearchModal = dynamic(() => import('../../../components/search/GlobalSearchModal'), { ssr: false });
const ActivityFeedDrawer = dynamic(() => import('../../../components/activity/ActivityFeedDrawer'), { ssr: false });
const AiVoiceCopilotBar = dynamic(() => import('../../../components/ai/AiVoiceCopilotBar'), { ssr: false });

import { useKanbanBoard } from '../../../hooks/useKanbanBoard';
import { useDragAndDrop } from '../../../hooks/useDragAndDrop';
import { useColumnRename } from '../../../hooks/useColumnRename';
import { DEFAULT_TAGS } from '../../../constants/tags';
import { Card, Assignee, Column as ColumnType, TeamMember } from '../../../types/kanban';
import { kanbanService, Project } from '../../../services/kanbanService';
import { computeProjectIntelligence } from '../../../lib/projectIntelligence';
import ProjectMembersModal from '../../../components/board/ProjectMembersModal';
import { Plus, X, LayoutGrid, CalendarDays } from 'lucide-react';

export default function ProjectBoardPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params?.projectId as string;

  const [isHydrated, setIsHydrated] = useState(false);

  // Filtry, řazení, vyhledávání
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTag, setSelectedTag] = useState('');
  const [selectedPriority, setSelectedPriority] = useState('');
  const [selectedAssignee, setSelectedAssignee] = useState('');
  const [selectedStatus, setSelectedStatus] = useState('');
  const [selectedDueDateFilter, setSelectedDueDateFilter] = useState('');
  const [selectedHasChecklist, setSelectedHasChecklist] = useState('');
  const [selectedHasComments, setSelectedHasComments] = useState('');
  const [selectedArchivedFilter, setSelectedArchivedFilter] = useState('active');
  const [sortBy, setSortBy] = useState('');

  // Dynamický seznam štítků
  const [tags, setTags] = useState<string[]>(DEFAULT_TAGS);

  // Board hooky s kontextem projektu
  const {
    columns,
    workspaceMembers,
    teamMembers,
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
    setProjectMembers,
  } = useKanbanBoard(projectId);

  const {
    draggingCardId,
    draggedOverColumnId,
    handleDragStart,
    handleDragEnd,
    handleDragOverColumn,
    handleDrop,
  } = useDragAndDrop(moveCard);

  const {
    editingColumnId,
    editNameText,
    setEditNameText,
    handleStartEdit,
    handleSave,
    handleKeyDown,
  } = useColumnRename(renameColumn);

  // Modály
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [targetColumnId, setTargetColumnId] = useState<string | null>(null);

  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [selectedCard, setSelectedCard] = useState<Card | null>(null);
  const [selectedCardColumnId, setSelectedCardColumnId] = useState<string | null>(null);

  const [project, setProject] = useState<Project | null>(null);
  const [isGenerateModalOpen, setIsGenerateModalOpen] = useState(false);
  const [isSprintPlannerOpen, setIsSprintPlannerOpen] = useState(false);
  const [isRiskAnalysisOpen, setIsRiskAnalysisOpen] = useState(false);
  const [isIntelligenceOpen, setIsIntelligenceOpen] = useState(false);
  const [isAiPmOpen, setIsAiPmOpen] = useState(false);
  const [isDailyBriefOpen, setIsDailyBriefOpen] = useState(false);
  const [isCapacityPlannerOpen, setIsCapacityPlannerOpen] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isActivityFeedOpen, setIsActivityFeedOpen] = useState(false);
  const [isVoiceCopilotOpen, setIsVoiceCopilotOpen] = useState(false);

  // Global Keyboard shortcut listeners (Cmd+K for search, Cmd+Shift+V for Voice Copilot)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setIsSearchOpen((prev) => !prev);
      } else if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'v') {
        e.preventDefault();
        setIsVoiceCopilotOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Ambientní zdraví projektu pro pulse chip v toolbaru a "chytré" dlaždice (deterministické).
  const intelHealth = useMemo(() => computeProjectIntelligence(columns).health, [columns]);

  // Klávesová zkratka ⌘I / Ctrl+I otevře Project Intelligence.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'i' || e.key === 'I')) {
        e.preventDefault();
        setIsIntelligenceOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const [isHeroHidden, setIsHeroHidden] = useState(false);
  // Výběr členů projektu (řádek avatarů). Správa identit workspace je na /team.
  const [isProjectMembersModalOpen, setIsProjectMembersModalOpen] = useState(false);

  // Přepínač zobrazení projektu: kanban board vs kalendář (per-projekt)
  const [viewMode, setViewMode] = useState<'board' | 'calendar'>('board');
  const [calendarMonth, setCalendarMonth] = useState(() => new Date());

  const changeViewMode = useCallback((mode: 'board' | 'calendar') => {
    setViewMode(mode);
    if (typeof window !== 'undefined') {
      localStorage.setItem('board_view_mode', mode);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      setIsHydrated(true);
    }, 0);
    if (typeof window !== 'undefined') {
      // Na mobilu je hero výchozí sbalené -- jinak board začíná až pod ohybem.
      // Jakmile si uživatel jednou zvolí, jeho volba má přednost na všech
      // šířkách (proto se testuje na null, ne na 'false').
      const stored = localStorage.getItem('hide_hero_section');
      const hidden =
        stored === null ? window.matchMedia('(max-width: 767px)').matches : stored === 'true';
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIsHeroHidden(hidden);
      const storedView = localStorage.getItem('board_view_mode');
      if (storedView === 'calendar' || storedView === 'board') {
        setViewMode(storedView);
      }
    }
    return () => clearTimeout(timer);
  }, []);

  // Column management states
  const [isAddColumnModalOpen, setIsAddColumnModalOpen] = useState(false);
  const [newColName, setNewColName] = useState('');
  const [columnToDelete, setColumnToDelete] = useState<ColumnType | null>(null);
  const [transferColumnId, setTransferColumnId] = useState<string>('');

  // Column drag and drop
  const handleColumnDragStart = (e: React.DragEvent, colId: string) => {
    e.dataTransfer.setData('text/column-id', colId);
  };

  const handleColumnDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('text/column-id')) {
      e.preventDefault();
    }
  };

  const handleColumnDrop = async (e: React.DragEvent, targetColId: string) => {
    e.preventDefault();
    const sourceColId = e.dataTransfer.getData('text/column-id');
    if (!sourceColId || sourceColId === targetColId) return;

    const sourceIndex = columns.findIndex((c) => c.id === sourceColId);
    const targetIndex = columns.findIndex((c) => c.id === targetColId);
    if (sourceIndex === -1 || targetIndex === -1) return;

    const updated = [...columns];
    const [moved] = updated.splice(sourceIndex, 1);
    updated.splice(targetIndex, 0, moved);

    await reorderColumns(updated);
  };

  // Add Column Submit
  const handleAddColumnSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newColName.trim()) return;
    await addColumn(newColName.trim());
    setNewColName('');
    setIsAddColumnModalOpen(false);
  };

  // Initiate Delete Column
  const handleInitiateDeleteColumn = (colId: string) => {
    const col = columns.find((c) => c.id === colId);
    if (!col) return;

    if (col.cards.length > 0) {
      setColumnToDelete(col);
      const otherCols = columns.filter((c) => c.id !== colId);
      if (otherCols.length > 0) {
        setTransferColumnId(otherCols[0].id);
      } else {
        setTransferColumnId('');
      }
    } else {
      deleteColumn(colId);
    }
  };

  // Confirm Delete Column
  const handleConfirmDeleteColumn = async () => {
    if (!columnToDelete) return;
    await deleteColumn(columnToDelete.id, transferColumnId || undefined);
    setColumnToDelete(null);
    setTransferColumnId('');
  };

  const handleImportGeneratedTasks = useCallback(
    (
      tasksToAdd: {
        title: string;
        details: string;
        priority: 'Low' | 'Medium' | 'High' | '';
        checklist: string[];
        columnName: string;
      }[],
      cardIdsToDelete: string[]
    ) => {
      // 1. Smazat staré úkoly při nahrazení (Replace)
      cardIdsToDelete.forEach((cardId) => {
        const col = columns.find((c) => c.cards.some((card) => card.id === cardId));
        if (col) {
          deleteCard(col.id, cardId);
        }
      });

      // 2. Vytvořit nové úkoly
      tasksToAdd.forEach((task) => {
        let col = columns.find(
          (c) => c.name.trim().toLowerCase() === task.columnName.trim().toLowerCase()
        );
        if (!col && columns.length > 0) {
          col = columns[0];
        }

        if (col) {
          const newCard = addCard(
            col.id,
            task.title,
            task.details,
            undefined, // tag
            task.priority || undefined, // priority
            undefined, // assignee
            undefined // dueDate
          );

          if (task.checklist && task.checklist.length > 0 && newCard) {
            task.checklist.forEach((itemText) => {
              addChecklistItem(col!.id, newCard.id, itemText);
            });
          }

          if (newCard) {
            addActivity(col.id, newCard.id, 'Generated by AI');
          }
        }
      });
    },
    [columns, addCard, deleteCard, addChecklistItem, addActivity]
  );



  useEffect(() => {
    async function loadProjectDetails() {
      if (!projectId) return;
      try {
        const data = await kanbanService.fetchProjectById(projectId);
        setProject(data);
        // Save to localStorage as last opened project
        if (typeof window !== 'undefined') {
          localStorage.setItem('last_opened_project_id', projectId);
        }
      } catch (err) {
        console.error('Failed to load project details:', err);
      }
    }
    loadProjectDetails();
  }, [projectId]);

  const handleOpenAddModal = (columnId: string) => {
    setTargetColumnId(columnId);
    setIsModalOpen(true);
  };

  const handleOpenGeneralAddModal = useCallback(() => {
    const toDoCol = columns[0]?.id || `${projectId}-column-1`;
    setTargetColumnId(toDoCol);
    setIsModalOpen(true);
  }, [columns, projectId]);

  const handleAddCardSubmit = (
    title: string,
    details: string,
    tag?: string,
    priority?: 'Low' | 'Medium' | 'High',
    assignee?: Assignee,
    dueDate?: string,
    assignees?: TeamMember[]
  ) => {
    if (!targetColumnId) return;
    addCard(targetColumnId, title, details, tag, priority, assignee, dueDate, assignees);
    setTargetColumnId(null);
  };

  const handleOpenDrawer = (columnId: string, card: Card) => {
    setSelectedCardColumnId(columnId);
    setSelectedCard(card);
    setIsDrawerOpen(true);
  };

  const handleCloseDrawer = useCallback(() => {
    setIsDrawerOpen(false);
    setSelectedCard(null);
    setSelectedCardColumnId(null);
  }, []);

  const handleMoveCard = (cardId: string, sourceColId: string, destColId: string) => {
    moveCard(cardId, sourceColId, destColId);
    setSelectedCardColumnId(destColId);
  };

  const getSelectedCardFromColumns = () => {
    if (!selectedCard || !selectedCardColumnId) return null;
    const col = columns.find((c) => c.id === selectedCardColumnId);
    return col?.cards.find((c) => c.id === selectedCard.id) || null;
  };


  const getTargetColumnName = () => {
    const col = columns.find((c) => c.id === targetColumnId);
    return col ? col.name : '';
  };

  useEffect(() => {
    const handleGlobalShortcuts = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isTyping = 
        target.tagName === 'INPUT' || 
        target.tagName === 'TEXTAREA' || 
        target.isContentEditable ||
        target.tagName === 'SELECT';

      // Ctrl/Cmd + Enter -> Blur active element to save changes
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
        return;
      }

      if (isTyping) {
        if (e.key === 'Escape') {
          if (document.activeElement instanceof HTMLElement) {
            document.activeElement.blur();
          }
          handleCloseDrawer();
          setIsModalOpen(false);
        }
        return;
      }

      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        handleOpenGeneralAddModal();
      } else if (e.key === '/') {
        e.preventDefault();
        const searchInput = document.querySelector('[data-testid="search-input"]') as HTMLInputElement;
        if (searchInput) {
          searchInput.focus();
          searchInput.select();
        }
      } else if (e.key === 'Escape') {
        handleCloseDrawer();
        setIsModalOpen(false);
      }
    };

    window.addEventListener('keydown', handleGlobalShortcuts);
    return () => window.removeEventListener('keydown', handleGlobalShortcuts);
  }, [columns, handleCloseDrawer, handleOpenGeneralAddModal]);

  const processedColumns = getProcessedColumns(
    searchQuery,
    {
      tag: selectedTag,
      priority: selectedPriority,
      assignee: selectedAssignee,
      status: selectedStatus,
      dueDateFilter: selectedDueDateFilter,
      hasChecklist: selectedHasChecklist,
      hasComments: selectedHasComments,
      archivedFilter: selectedArchivedFilter,
    },
    sortBy
  );

  return (
    <div className="app-container" data-hydrated={isHydrated ? 'true' : 'false'}>
      {/* Board akce se na mobilu objeví v hamburger menu (na desktopu zůstávají v toolbaru). */}
      <Navbar
        boardActions={{
          onOpenIntelligence: () => setIsIntelligenceOpen(true),
          onNewTask: handleOpenGeneralAddModal,
          onOpenSearch: () => setIsSearchOpen(true),
          viewMode,
          onViewModeChange: changeViewMode,
        }}
      />
      <HeroSection
        totalTasks={totalTasks}
        onClose={() => {
          setIsHeroHidden(true);
          localStorage.setItem('hide_hero_section', 'true');
        }}
        isCollapsed={isHeroHidden}
      />

      <Toolbar
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        selectedTag={selectedTag}
        onSelectTag={setSelectedTag}
        selectedPriority={selectedPriority}
        onSelectPriority={setSelectedPriority}
        selectedAssignee={selectedAssignee}
        onSelectAssignee={setSelectedAssignee}
        selectedStatus={selectedStatus}
        onSelectStatus={setSelectedStatus}
        selectedDueDateFilter={selectedDueDateFilter}
        onSelectDueDateFilter={setSelectedDueDateFilter}
        selectedHasChecklist={selectedHasChecklist}
        onSelectHasChecklist={setSelectedHasChecklist}
        selectedHasComments={selectedHasComments}
        onSelectHasComments={setSelectedHasComments}
        selectedArchivedFilter={selectedArchivedFilter}
        onSelectArchivedFilter={setSelectedArchivedFilter}
        sortBy={sortBy}
        onSortChange={setSortBy}
        tags={tags}
        columns={columns}
        onAddTag={(newTag) => setTags((prev) => [...prev, newTag])}
        onDeleteTag={(tagToDelete) => {
          setTags((prev) => prev.filter((t) => t !== tagToDelete));
          if (selectedTag === tagToDelete) {
            setSelectedTag('');
          }
         }}
        onNewTask={handleOpenGeneralAddModal}
        onOpenIntelligence={() => setIsIntelligenceOpen(true)}
        intelHealth={intelHealth}
        isHeroHidden={isHeroHidden}
        onToggleHero={() => {
          const newVal = !isHeroHidden;
          setIsHeroHidden(newVal);
          localStorage.setItem('hide_hero_section', String(newVal));
        }}
        teamMembers={teamMembers}
        onManageTeam={() => setIsProjectMembersModalOpen(true)}
        onOpenActivityFeed={() => setIsActivityFeedOpen(true)}
      />

      {(error || syncError) && (
        <div style={{ margin: '0 3rem 1rem 3rem', padding: '0.75rem 1.25rem', backgroundColor: 'var(--danger-soft)', color: 'var(--danger)', borderRadius: '6px', fontSize: '0.8rem', fontWeight: 600 }}>
          {error || syncError}
        </div>
      )}

      <StatsRow
        totalTasks={totalTasks}
        inProgressCount={inProgressCount}
        completedCount={completedCount}
        blockedCount={blockedCount}
        onOpenIntelligence={() => setIsIntelligenceOpen(true)}
      />

      <div className="board-view-switch-row">
        <div className="view-switch" role="group" aria-label="Přepínač zobrazení">
          <button
            type="button"
            className={`view-switch-btn ${viewMode === 'board' ? 'active' : ''}`}
            onClick={() => changeViewMode('board')}
            aria-pressed={viewMode === 'board'}
            data-testid="view-switch-board"
          >
            <LayoutGrid size={14} />
            Board
          </button>
          <button
            type="button"
            className={`view-switch-btn ${viewMode === 'calendar' ? 'active' : ''}`}
            onClick={() => changeViewMode('calendar')}
            aria-pressed={viewMode === 'calendar'}
            data-testid="view-switch-calendar"
          >
            <CalendarDays size={14} />
            Kalendář
          </button>
        </div>
      </div>

      {viewMode === 'calendar' ? (
        <CalendarView
          columns={processedColumns}
          month={calendarMonth}
          onPrevMonth={() => setCalendarMonth((d) => new Date(d.getFullYear(), d.getMonth() - 1, 1))}
          onNextMonth={() => setCalendarMonth((d) => new Date(d.getFullYear(), d.getMonth() + 1, 1))}
          onToday={() => setCalendarMonth(new Date())}
          onCardClick={handleOpenDrawer}
        />
      ) : (
      <BoardPanel
        projectName={project?.name || 'Načítání projektu...'}
      >
        {processedColumns.map((col, index) => (
          <Column
            key={col.id}
            column={col}
            draggedOverColumnId={draggedOverColumnId}
            draggingCardId={draggingCardId}
            editingColumnId={editingColumnId}
            editNameText={editNameText}
            onEditNameTextChange={setEditNameText}
            onStartEditColumn={handleStartEdit}
            onSaveColumnName={handleSave}
            onKeyDownColumnName={handleKeyDown}
            onOpenAddModal={handleOpenAddModal}
            onOpenEditModal={handleOpenDrawer}
            onDeleteCard={deleteCard}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDragOverColumn={handleDragOverColumn}
            onDrop={handleDrop}
            onDeleteColumn={handleInitiateDeleteColumn}
            onMoveColumn={moveColumn}
            isFirst={index === 0}
            isLast={index === processedColumns.length - 1}
            onColumnDragStart={handleColumnDragStart}
            onColumnDragOver={handleColumnDragOver}
            onColumnDrop={handleColumnDrop}
          />
        ))}

        <div
          onClick={() => setIsAddColumnModalOpen(true)}
          style={{
            minWidth: '280px',
            width: '280px',
            height: '100px',
            backgroundColor: 'var(--surface)',
            border: '2px dashed var(--border-color)',
            borderRadius: '10px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            color: 'var(--gray-text)',
            fontSize: '0.85rem',
            fontWeight: 700,
            gap: '0.5rem',
            transition: 'all 0.2s',
            flexShrink: 0,
            marginTop: '0.5rem'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = 'var(--purple-secondary)';
            e.currentTarget.style.color = 'var(--purple-secondary)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = 'var(--border-color)';
            e.currentTarget.style.color = 'var(--gray-text)';
          }}
          data-testid="add-column-board-btn"
        >
          <Plus size={16} />
          Přidat sloupec
        </div>
      </BoardPanel>
      )}

      {isModalOpen && (
        <AddCardModal
          isOpen={isModalOpen}
          onClose={() => setIsModalOpen(false)}
          onSubmit={handleAddCardSubmit}
          columnName={getTargetColumnName()}
          availableTags={tags}
          teamMembers={teamMembers}
        />
      )}

      {isDrawerOpen && selectedCard && selectedCardColumnId && (
        <TaskDetailDrawer
          key={selectedCard.id}
          isOpen={isDrawerOpen}
          onClose={handleCloseDrawer}
          card={getSelectedCardFromColumns()}
          columnId={selectedCardColumnId}
          columns={columns}
          availableTags={tags}
          teamMembers={teamMembers}
          onUpdateCard={editCard}
          onMoveCard={handleMoveCard}
          onDeleteCard={deleteCard}
          onAddChecklistItem={addChecklistItem}
          onToggleChecklistItem={toggleChecklistItem}
          onUpdateChecklistItemText={updateChecklistItemText}
          onDeleteChecklistItem={deleteChecklistItem}
          onAddComment={addComment}
          onAddActivity={addActivity}
        />
      )}

      {isGenerateModalOpen && (
        <GenerateTasksModal
          isOpen={isGenerateModalOpen}
          onClose={() => setIsGenerateModalOpen(false)}
          projectName={project?.name || 'Můj Kanban Projekt'}
          columns={columns}
          existingTasks={columns.flatMap((c) => c.cards)}
          onImportTasks={handleImportGeneratedTasks}
        />
      )}

      {isSprintPlannerOpen && (
        <GenerateSprintModal
          isOpen={isSprintPlannerOpen}
          onClose={() => setIsSprintPlannerOpen(false)}
          projectName={project?.name || 'Můj Kanban Projekt'}
          existingTasks={columns.flatMap((c) => c.cards)}
        />
      )}

      {isAddColumnModalOpen && (
        <div className="modal-overlay" onClick={() => setIsAddColumnModalOpen(false)}>
          <div
            className="modal-content"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            data-testid="add-column-modal"
          >
            <div className="modal-header">
              <h2 className="modal-title">Přidat sloupec</h2>
              <button
                type="button"
                className="modal-close-btn"
                onClick={() => setIsAddColumnModalOpen(false)}
                aria-label="Zavřít okno"
              >
                <X size={20} />
              </button>
            </div>
            <form onSubmit={handleAddColumnSubmit}>
              <div className="modal-body">
                <div className="form-group">
                  <label htmlFor="new-column-name" className="form-label">
                    Název sloupce *
                  </label>
                  <input
                    id="new-column-name"
                    type="text"
                    className="form-input"
                    placeholder="Zadejte název nového sloupce"
                    value={newColName}
                    onChange={(e) => setNewColName(e.target.value)}
                    autoFocus
                    required
                    data-testid="new-column-name-input"
                  />
                </div>
              </div>
              <div className="modal-footer">
                <button
                  type="button"
                  className="btn btn-cancel"
                  onClick={() => setIsAddColumnModalOpen(false)}
                >
                  Zrušit
                </button>
                <button type="submit" className="btn btn-submit" data-testid="new-column-submit-btn">
                  Vytvořit
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {columnToDelete && (
        <div className="modal-overlay" onClick={() => setColumnToDelete(null)}>
          <div
            className="modal-content"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            data-testid="delete-column-transfer-modal"
          >
            <div className="modal-header">
              <h2 className="modal-title" style={{ color: 'var(--danger)' }}>Odstranit sloupec a převést úkoly</h2>
              <button
                type="button"
                className="modal-close-btn"
                onClick={() => setColumnToDelete(null)}
                aria-label="Zavřít okno"
              >
                <X size={20} />
              </button>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: '0.85rem', color: 'var(--dark-navy)', fontWeight: 600, marginBottom: '0.75rem' }}>
                Sloupec <span style={{ color: 'var(--purple-secondary)', fontWeight: 700 }}>{columnToDelete.name}</span> obsahuje <span style={{ fontWeight: 700 }}>{columnToDelete.cards.length}</span> úkolů.
              </p>
              <p style={{ fontSize: '0.75rem', color: 'var(--gray-text)', lineHeight: '1.4', marginBottom: '1.25rem' }}>
                Před odstraněním sloupce musíte jeho úkoly převést do jiného sloupce. Vyberte prosím cílový sloupec:
              </p>
              
              <div className="form-group">
                <label htmlFor="transfer-column-select" className="form-label">
                  Převést do sloupce:
                </label>
                <select
                  id="transfer-column-select"
                  className="form-input"
                  value={transferColumnId}
                  onChange={(e) => setTransferColumnId(e.target.value)}
                  style={{ backgroundColor: 'var(--surface)', color: 'var(--dark-navy)' }}
                  data-testid="transfer-column-select"
                >
                  {columns
                    .filter((col) => col.id !== columnToDelete.id)
                    .map((col) => (
                      <option key={col.id} value={col.id}>
                        {col.name}
                      </option>
                    ))}
                </select>
              </div>
            </div>
            <div className="modal-footer">
              <button
                type="button"
                className="btn btn-cancel"
                onClick={() => setColumnToDelete(null)}
              >
                Zrušit
              </button>
              <button
                type="button"
                className="btn btn-submit"
                style={{ backgroundColor: 'var(--danger)' }}
                onClick={handleConfirmDeleteColumn}
                data-testid="confirm-delete-column-transfer-btn"
              >
                Převést & Smazat
              </button>
            </div>
          </div>
        </div>
      )}

      {isRiskAnalysisOpen && (
        <RiskAnalysisModal
          isOpen={isRiskAnalysisOpen}
          onClose={() => setIsRiskAnalysisOpen(false)}
          projectName={project?.name || 'Tento projekt'}
          columns={columns}
        />
      )}

      {isIntelligenceOpen && (
        <ProjectIntelligenceDrawer
          isOpen={isIntelligenceOpen}
          onClose={() => setIsIntelligenceOpen(false)}
          columns={columns}
          projectName={project?.name || 'Tento projekt'}
          onGenerateTasks={() => setIsGenerateModalOpen(true)}
          onSprintPlanning={() => setIsSprintPlannerOpen(true)}
          onRiskAnalysis={() => setIsRiskAnalysisOpen(true)}
          onOpenProjectManager={() => setIsAiPmOpen(true)}
          onOpenDailyBrief={() => setIsDailyBriefOpen(true)}
          onOpenCapacityPlanner={() => setIsCapacityPlannerOpen(true)}
          onOpenVoiceCopilot={() => setIsVoiceCopilotOpen(true)}
        />
      )}

      {isAiPmOpen && (
        <AiProjectManagerModal
          isOpen={isAiPmOpen}
          onClose={() => setIsAiPmOpen(false)}
          columns={columns}
          projectId={projectId}
          projectName={project?.name || 'Tento projekt'}
          onMoveCard={moveCard}
          onUpdateCard={editCard}
          onAddCard={(colId, cardData) => addCard(colId, cardData.title, cardData.details, cardData.priority)}
        />
      )}

      {isDailyBriefOpen && (
        <AiDailyBriefModal
          isOpen={isDailyBriefOpen}
          onClose={() => setIsDailyBriefOpen(false)}
          columns={columns}
          projectName={project?.name || 'Tento projekt'}
        />
      )}

      {isCapacityPlannerOpen && (
        <AiCapacityPlannerModal
          isOpen={isCapacityPlannerOpen}
          onClose={() => setIsCapacityPlannerOpen(false)}
          columns={columns}
          members={teamMembers}
          projectId={projectId}
          projectName={project?.name || 'Tento projekt'}
          onUpdateCard={editCard}
        />
      )}

      {isProjectMembersModalOpen && (
        <ProjectMembersModal
          isOpen={isProjectMembersModalOpen}
          onClose={() => setIsProjectMembersModalOpen(false)}
          workspaceMembers={workspaceMembers}
          projectMemberIds={teamMembers.map((m) => m.id)}
          onChangeMembers={setProjectMembers}
          onManageWorkspace={() => router.push('/team')}
        />
      )}

      {isActivityFeedOpen && (
        <ActivityFeedDrawer
          isOpen={isActivityFeedOpen}
          onClose={() => setIsActivityFeedOpen(false)}
          projectId={projectId}
        />
      )}

      {isSearchOpen && (
        <GlobalSearchModal
          isOpen={isSearchOpen}
          onClose={() => setIsSearchOpen(false)}
          columns={columns}
          onSelectCard={(colId, card) => handleOpenDrawer(colId, card)}
        />
      )}

      {isVoiceCopilotOpen && (
        <AiVoiceCopilotBar
          isOpen={isVoiceCopilotOpen}
          onClose={() => setIsVoiceCopilotOpen(false)}
          columns={columns}
          members={teamMembers}
          projectName={project?.name || 'Tento projekt'}
          onAddCard={(colId, cardData) => addCard(colId, cardData.title, cardData.details, cardData.priority)}
          onMoveCard={moveCard}
          onUpdateCard={editCard}
          onAddChecklistItem={addChecklistItem}
          onRenameColumn={renameColumn}
        />
      )}
    </div>
  );
}
