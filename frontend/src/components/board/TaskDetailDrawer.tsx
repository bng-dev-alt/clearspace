'use client';

import { TaskConversation } from '../hub/CommunicationList';
import { DialogFocus } from '../ui/useDialogFocus';
import { useConfirm } from '../ui/useConfirm';
import { hubService } from '../../services/hubService';
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { X, Trash2, Archive, CheckSquare, MessageSquare, Sparkles, Clock, AlignLeft, AlignRight, Maximize2 } from 'lucide-react';
import MultiAssigneeSelect from './MultiAssigneeSelect';
import TaskResourcesSection from './TaskResourcesSection';
import DriveLinksPanel from '../drive/DriveLinksPanel';
import GmailLinksPanel from '../gmail/GmailLinksPanel';
import CalendarLinksPanel from '../calendar/CalendarLinksPanel';
import type { Card, Column, TeamMember } from '../../types/kanban';
import { useAuth } from '../../hooks/useAuth';
import { aiClient } from '../../services/ai/aiClient';
import { aiHistoryService } from '../../services/ai/aiHistoryService';
import TaskComments from '../collab/TaskComments';
import type { Mentionable } from '../../lib/collab/mentions';
import { kanbanService } from '../../services/kanbanService';
import { hasSupabaseConfig } from '../../lib/supabase';
import { describeActivity, formatRelativeTime } from '../../lib/collab/activityText';

export type TaskDetailMode = 'right' | 'left' | 'focused' | 'fullscreen' | 'split' | 'detached';

interface TaskDetailDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  card: Card | null;
  columnId: string;
  columns: Column[];
  availableTags: string[];
  teamMembers: TeamMember[];
  /** `base` = the field values the edit started from (concurrent-edit detection, RUN 01). */
  onUpdateCard: (columnId: string, cardId: string, updates: Partial<Card>, base?: Partial<Card>) => void;
  onMoveCard: (cardId: string, sourceColumnId: string, destinationColumnId: string) => void;
  onDeleteCard: (columnId: string, cardId: string) => void;
  onAddChecklistItem: (columnId: string, cardId: string, text: string) => void;
  onToggleChecklistItem: (columnId: string, cardId: string, itemId: string) => void;
  onUpdateChecklistItemText: (columnId: string, cardId: string, itemId: string, text: string, expectedText?: string) => void;
  onDeleteChecklistItem: (columnId: string, cardId: string, itemId: string) => void;
  onAddComment: (columnId: string, cardId: string, authorName: string, content: string, mentions?: string[]) => void;
  onAddActivity: (columnId: string, cardId: string, text: string) => void;
  // Collaboration (RUN 01)
  readOnly?: boolean;
  currentUserId?: string;
  canModerate?: boolean;
  mentionables?: Mentionable[];
  onEditComment?: (cardId: string, commentId: string, content: string, mentions: string[]) => Promise<boolean>;
  onDeleteComment?: (cardId: string, commentId: string) => Promise<boolean>;
  /** A colleague changed these fields of THIS task concurrently; the drawer shows their version. */
  conflictText?: string | null;
  onResolveConflict?: (choice: 'theirs' | 'mine') => void;
  /** A collaboration notice (e.g. a refused concurrent edit) shown while the drawer covers the page. */
  notice?: string | null;
  onDismissNotice?: () => void;
  /** RUN 07: show the linked Slack / Telegram thread of this task (hub switched on). */
  showChatConversation?: boolean;
}

export default function TaskDetailDrawer({
  showChatConversation = false,
  isOpen,
  onClose,
  card,
  columnId,
  columns,
  availableTags,
  teamMembers,
  onUpdateCard,
  onMoveCard,
  onDeleteCard,
  onAddChecklistItem,
  onToggleChecklistItem,
  onUpdateChecklistItemText,
  onDeleteChecklistItem,
  onAddComment,
  onAddActivity,
  readOnly = false,
  currentUserId,
  canModerate = false,
  mentionables = [],
  onEditComment,
  onDeleteComment,
  conflictText = null,
  onResolveConflict,
  notice = null,
  onDismissNotice,
}: TaskDetailDrawerProps) {
  const [ask, confirmDialog] = useConfirm();
  // RUN 07B: provenance of comments synced with a chat thread (only when the hub is on)
  const [chatInfo, setChatInfo] = useState<Awaited<ReturnType<typeof hubService.commentSources>> | null>(null);
  const commentCount = card?.comments?.length ?? 0;
  useEffect(() => {
    if (!showChatConversation || !card?.id) return;
    let active = true;
    hubService.commentSources(card.id).then((r) => { if (active) setChatInfo(r); }).catch(() => undefined);
    return () => { active = false; };
  }, [showChatConversation, card?.id, commentCount]);

  const { profile } = useAuth();
  const params = useParams();
  const projectId = params?.projectId as string;
  const drawerRef = useRef<HTMLDivElement>(null);

  // View mode switcher state.
  // Čteme preferenci hned při inicializaci (lazy initializer), NE až v efektu po
  // prvním renderu. Jinak se panel nejdřív vykreslí jako 'right' a teprve pak
  // přeskočí na uloženou pozici (viditelný skok zprava u Left/Focused). Drawer se
  // mountuje čerstvě při každém otevření (key na kartě), takže běží jen na klientu.
  const [mode, setMode] = useState<TaskDetailMode>(() => {
    if (typeof window !== 'undefined') {
      const savedMode = localStorage.getItem('task_detail_mode') as TaskDetailMode;
      if (savedMode && ['right', 'left', 'focused'].includes(savedMode)) {
        return savedMode;
      }
    }
    return 'right';
  });

  // Plynulé zavření: nejdřív přehraj exit animaci, pak teprve odmountuj (onClose).
  const [isClosing, setIsClosing] = useState(false);
  // The pending close must die with this drawer: otherwise a task reopened within the animation window
  // (or a drawer already closed by the page's Escape handler) was closed again by the stale timer.
  const closeTimer = useRef<number | null>(null);
  useEffect(() => () => { if (closeTimer.current !== null) window.clearTimeout(closeTimer.current); }, []);
  const requestClose = useCallback(() => {
    if (closeTimer.current !== null) return;
    setIsClosing(true);
    closeTimer.current = window.setTimeout(() => { closeTimer.current = null; onClose(); }, 230);
  }, [onClose]);

  const handleModeChange = (newMode: TaskDetailMode) => {
    setMode(newMode);
    if (typeof window !== 'undefined') {
      localStorage.setItem('task_detail_mode', newMode);
    }
  };

  // States for inline editing
  const [title, setTitle] = useState(card?.title || '');
  const [details, setDetails] = useState(card?.details || '');
  const [tag, setTag] = useState(card?.tag || '');
  const [priority, setPriority] = useState<'Low' | 'Medium' | 'High' | ''>(card?.priority || '');
  const [assignees, setAssignees] = useState<TeamMember[]>(card?.assignees || (card?.assignee ? [
    (teamMembers || []).find(m => m.fullName === card.assignee?.name) || {
      id: 'member-fallback',
      fullName: card.assignee.name,
      initials: card.assignee.initials,
      avatarColor: card.assignee.color,
      createdAt: new Date().toISOString()
    }
  ] : []));
  const [dueDate, setDueDate] = useState(card?.dueDate || '');

  // Synchronize local assignees state when card changes
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (card) {
      setAssignees(card.assignees || (card.assignee ? [
        (teamMembers || []).find(m => m.fullName === card.assignee?.name) || {
          id: 'member-fallback',
          fullName: card.assignee.name,
          initials: card.assignee.initials,
          avatarColor: card.assignee.color,
          createdAt: new Date().toISOString()
        }
      ] : []));
    }
  }, [card, teamMembers]);
  /* eslint-enable react-hooks/set-state-in-effect */
  
  // Checklist states
  const [newChecklistText, setNewChecklistText] = useState('');
  
  // Text fields being edited: their value when editing began (null = not focused). A colleague's
  // change arriving meanwhile is shown in unfocused fields and detected as a conflict on save.
  const titleBase = useRef<string | null>(null);
  const checklistBase = useRef<Record<string, string>>({});
  const detailsBase = useRef<string | null>(null);
  const remoteTitle = card?.title ?? '';
  const remoteDetails = card?.details ?? '';
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => { if (titleBase.current === null) setTitle(remoteTitle); }, [remoteTitle]);
  useEffect(() => { if (detailsBase.current === null) setDetails(remoteDetails); }, [remoteDetails]);
  useEffect(() => { setTag(card?.tag || ''); setPriority(card?.priority || ''); setDueDate(card?.dueDate || ''); }, [card?.tag, card?.priority, card?.dueDate]);
  // A conflict means our edit was NOT saved: show the server's values again (unless still being edited).
  useEffect(() => {
    if (!conflictText) return;
    if (titleBase.current === null) setTitle(remoteTitle);
    if (detailsBase.current === null) setDetails(remoteDetails);
  }, [conflictText, remoteTitle, remoteDetails]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Activity collapse state
  const [isActivityCollapsed, setIsActivityCollapsed] = useState(true);
  // Trusted task history (RUN 01B): events recorded by the database; re-read whenever the task changes.
  const [history, setHistory] = useState<Awaited<ReturnType<typeof kanbanService.fetchCardHistory>> | null>(null);
  const historyCardId = card?.id;
  const historyStamp = `${card?.version ?? ''}:${card?.childRev ?? ''}:${card?.comments?.length ?? 0}`;
  useEffect(() => {
    if (!hasSupabaseConfig || !historyCardId || isActivityCollapsed) return;
    let active = true;
    kanbanService.fetchCardHistory(historyCardId).then((rows) => { if (active) setHistory(rows); });
    return () => { active = false; };
  }, [historyCardId, historyStamp, isActivityCollapsed]);

  // AI Assistant states
  const [isAiLoading, setIsAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiPreview, setAiPreview] = useState<{
    details: string;
    acceptanceCriteria: string;
    risks: string;
    missingInfo: string;
    checklist: string[];
  } | null>(null);

  const handleImproveTask = async () => {
    if (!card) return;
    setIsAiLoading(true);
    setAiError(null);
    setAiPreview(null);

    try {
      const data = await aiClient.fetchAi('/api/ai/improve', 'Improve Task', {
        card,
      });

      if (!data.parsed) {
        throw new Error('AI vrátila neplatnou strukturu.');
      }

      setAiPreview({
        details: data.parsed.details || '',
        acceptanceCriteria: data.parsed.acceptanceCriteria || '',
        risks: data.parsed.risks || '',
        missingInfo: data.parsed.missingInfo || '',
        checklist: data.parsed.checklist || [],
      });
      
      onAddActivity(columnId, card.id, 'AI improved task');
    } catch (err: unknown) {
      const error = err as Error;
      console.error(error);
      setAiError(error.message || 'Při volání AI došlo k neočekávané chybě.');
    } finally {
      setIsAiLoading(false);
    }
  };

  const handleAcceptAiSuggestion = () => {
    if (!card || !aiPreview) return;

    try {
      const snapshot = aiHistoryService.captureSnapshot(projectId, columns, null);

      let updatedDetails = aiPreview.details;
      if (aiPreview.acceptanceCriteria) {
        updatedDetails += `\n\n### Kritéria akceptace\n${aiPreview.acceptanceCriteria}`;
      }
      if (aiPreview.risks) {
        updatedDetails += `\n\n### Možná rizika\n${aiPreview.risks}`;
      }
      if (aiPreview.missingInfo) {
        updatedDetails += `\n\n### Chybějící informace k dojasnění\n${aiPreview.missingInfo}`;
      }

      onUpdateCard(columnId, card.id, {
        details: updatedDetails.trim(),
      });

      setDetails(updatedDetails.trim());

      if (aiPreview.checklist && aiPreview.checklist.length > 0) {
        aiPreview.checklist.forEach((itemText) => {
          onAddChecklistItem(columnId, card.id, itemText);
        });
      }

      onAddActivity(columnId, card.id, 'Accepted AI suggestion');

      const projName = snapshot.projectName || 'Tento projekt';
      aiHistoryService.saveHistoryRecord(
        'AI Improve Task',
        projName,
        `Vylepšen popis a akceptační kritéria úkolu "${card.title}"`,
        1,
        snapshot
      );
    } catch (e) {
      console.error('Failed to save AI History during Improve Task:', e);
    } finally {
      setAiPreview(null);
    }
  };

  const handleDiscardAiSuggestion = () => {
    if (!card) return;
    onAddActivity(columnId, card.id, 'Discarded AI suggestion');
    setAiPreview(null);
  };

  // Click outside (na overlay) nebo Escape -> plynulé zavření
  useEffect(() => {
    function handleOutsideClick(event: MouseEvent) {
      if (isOpen && drawerRef.current && !drawerRef.current.contains(event.target as Node)) {
        const overlay = document.querySelector('.drawer-overlay');
        if (overlay && event.target === overlay) {
          requestClose();
        }
      }
    }
    function handleEsc(event: KeyboardEvent) {
      if (isOpen && event.key === 'Escape') requestClose();
    }
    document.addEventListener('mousedown', handleOutsideClick);
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [isOpen, requestClose]);

  if (!isOpen || !card) return null;

  // Inline edit change savers
  const handleTitleBlur = () => {
    const base = titleBase.current ?? card.title;
    titleBase.current = null;
    if (title.trim() && title.trim() !== card.title) {
      onUpdateCard(columnId, card.id, { title: title.trim() }, { title: base });
    } else {
      setTitle(card.title); // Reset on empty title
    }
  };

  const handleDetailsBlur = () => {
    const base = detailsBase.current ?? card.details;
    detailsBase.current = null;
    if (details.trim() !== card.details) {
      onUpdateCard(columnId, card.id, { details: details.trim() }, { details: base });
    }
  };

  const handleTagChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    setTag(val);
    onUpdateCard(columnId, card.id, { tag: val ? val : undefined });
  };

  const handlePriorityChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value as 'Low' | 'Medium' | 'High' | '';
    setPriority(val);
    onUpdateCard(columnId, card.id, { priority: val ? val : undefined });
  };

  const handleAssigneesChange = (newAssignees: TeamMember[]) => {
    setAssignees(newAssignees);
    onUpdateCard(columnId, card.id, { assignees: newAssignees });
  };

  const handleDueDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setDueDate(val);
    onUpdateCard(columnId, card.id, { dueDate: val ? val : undefined });
  };

  const handleClearDueDate = () => {
    setDueDate('');
    onUpdateCard(columnId, card.id, { dueDate: undefined });
  };

  const handleStatusChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const destinationColId = e.target.value;
    if (destinationColId !== columnId) {
      onMoveCard(card.id, columnId, destinationColId);
    }
  };

  // Checklist actions
  const handleAddChecklistItem = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newChecklistText.trim()) return;
    onAddChecklistItem(columnId, card.id, newChecklistText.trim());
    setNewChecklistText('');
  };

  const handleChecklistTextBlur = (itemId: string, currentText: string, newText: string) => {
    const base = checklistBase.current[itemId] ?? currentText;
    delete checklistBase.current[itemId];
    if (newText.trim() && newText.trim() !== base) {
      onUpdateChecklistItemText(columnId, card.id, itemId, newText.trim(), base);
    }
  };

  const handleDeleteCard = async () => {
    // RUN 11: "delete" here ARCHIVES the card (useKanbanBoard.deleteCard sets archived=true) – the dialog says exactly that
    if (!(await ask({ title: 'Archivovat úkol?', message: `Úkol „${card.title}“ zmizí z boardu a přesune se do archivu (filtr Archivované). Checklist, komentáře a přílohy zůstávají uložené.`, confirmLabel: 'Archivovat' }))) return;
    onDeleteCard(columnId, card.id);
    requestClose();
  };

  // Calculate checklist progress
  const checklistItems = card.checklist || [];
  const completedChecklistCount = checklistItems.filter((i) => i.completed).length;
  const totalChecklistCount = checklistItems.length;
  const checklistProgressPercent = totalChecklistCount > 0 
    ? Math.round((completedChecklistCount / totalChecklistCount) * 100) 
    : 0;

  return (
    <>
      {confirmDialog}
      {/* Semi-transparent backdrop overlay */}
      <div
        className={`drawer-overlay ${mode === 'focused' ? 'mode-focused' : ''} ${isClosing ? 'closing' : ''}`}
        data-testid="drawer-overlay"
      />

      {/* Main Task Detail container content */}
      <div
        className={`drawer-content mode-${mode} ${isClosing ? 'closing' : ''}`}
        ref={drawerRef}
        role="dialog" 
        aria-modal="true" 
        data-testid="task-detail-drawer"
      >
        <DialogFocus />
        {/* Drawer Header */}
        <div className="drawer-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div className="drawer-header-left">
            <span style={{ fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--blue-primary)', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
              <CheckSquare size={14} /> Detail úkolu
            </span>
          </div>
          
          {/* View Mode Switcher -- layout v CSS (dřív inline), aby na něj dosáhly
              breakpointy; na mobilu je drawer vždy fullscreen, takže se skrývá. */}
          <div className="drawer-mode-switch" data-testid="mode-switcher" role="group" aria-label="Umístění detailu úkolu">
            <button
              type="button"
              onClick={() => handleModeChange('left')}
              style={{
                border: 'none',
                outline: 'none',
                background: mode === 'left' ? 'var(--surface)' : 'none',
                fontSize: '0.72rem',
                fontWeight: 600,
                color: mode === 'left' ? 'var(--dark-navy)' : 'var(--gray-text)',
                padding: '0.35rem 0.65rem',
                borderRadius: '6px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '0.3rem',
                boxShadow: mode === 'left' ? '0 1px 3px rgba(0, 0, 0, 0.08)' : 'none',
                transition: 'all 0.2s ease',
              }}
              data-testid="mode-btn-left"
              aria-pressed={mode === 'left'}
            >
              <AlignLeft size={13} />
              Vlevo
            </button>

            <button
              type="button"
              onClick={() => handleModeChange('focused')}
              style={{
                border: 'none',
                outline: 'none',
                background: mode === 'focused' ? 'var(--surface)' : 'none',
                fontSize: '0.72rem',
                fontWeight: 600,
                color: mode === 'focused' ? 'var(--dark-navy)' : 'var(--gray-text)',
                padding: '0.35rem 0.65rem',
                borderRadius: '6px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '0.3rem',
                boxShadow: mode === 'focused' ? '0 1px 3px rgba(0, 0, 0, 0.08)' : 'none',
                transition: 'all 0.2s ease',
              }}
              data-testid="mode-btn-focused"
              aria-pressed={mode === 'focused'}
            >
              <Maximize2 size={13} />
              Soustředěně
            </button>

            <button
              type="button"
              onClick={() => handleModeChange('right')}
              style={{
                border: 'none',
                outline: 'none',
                background: mode === 'right' ? 'var(--surface)' : 'none',
                fontSize: '0.72rem',
                fontWeight: 600,
                color: mode === 'right' ? 'var(--dark-navy)' : 'var(--gray-text)',
                padding: '0.35rem 0.65rem',
                borderRadius: '6px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '0.3rem',
                boxShadow: mode === 'right' ? '0 1px 3px rgba(0, 0, 0, 0.08)' : 'none',
                transition: 'all 0.2s ease',
              }}
              data-testid="mode-btn-right"
              aria-pressed={mode === 'right'}
            >
              <AlignRight size={13} />
              Vpravo
            </button>

          </div>

          <div className="drawer-header-right">
            <button
              type="button"
              onClick={handleDeleteCard}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--gray-text)',
                cursor: 'pointer',
                padding: '6px',
                borderRadius: '6px',
                transition: 'var(--spring-transition)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--danger)')}
              onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--gray-text)')}
              title="Archivovat úkol"
              aria-label="Archivovat úkol"
              data-testid="drawer-delete-btn"
            >
              <Archive size={18} />
            </button>
            <button
              type="button"
              onClick={requestClose}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--gray-text)',
                cursor: 'pointer',
                padding: '6px',
                borderRadius: '6px',
                transition: 'var(--spring-transition)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--dark-navy)')}
              onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--gray-text)')}
              aria-label="Zavřít panel"
              data-testid="drawer-close-btn"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Scrollable workspace area */}
        <fieldset disabled={readOnly} className="drawer-scroll-area" style={{ border: 0, margin: 0, minWidth: 0 }} data-readonly={readOnly ? 'true' : 'false'}>
          {notice && onDismissNotice && (
            <div className="collab-notice collab-notice--warning" style={{ margin: 0 }} role="alert" data-testid="collab-notice">
              <span>{notice}</span>
              <div className="collab-notice-actions">
                <button type="button" className="cs-btn cs-btn--secondary cs-btn--sm" onClick={onDismissNotice} data-testid="collab-notice-dismiss">Rozumím</button>
              </div>
            </div>
          )}
          {conflictText && onResolveConflict && (
            <div className="collab-notice collab-notice--warning" style={{ margin: 0 }} role="alert" data-testid="conflict-notice">
              <span>{conflictText}</span>
              <div className="collab-notice-actions">
                <button type="button" className="cs-btn cs-btn--secondary cs-btn--sm" onClick={() => onResolveConflict('theirs')} data-testid="conflict-keep-theirs">Ponechat jejich verzi</button>
                <button type="button" className="cs-btn cs-btn--primary cs-btn--sm" onClick={() => onResolveConflict('mine')} data-testid="conflict-use-mine">Přepsat mou verzí</button>
              </div>
            </div>
          )}
          {readOnly && (
            <p className="collab-notice" style={{ margin: 0 }} data-testid="drawer-readonly-note">
              Máte roli Čtenář: úkol můžete číst, ale ne upravovat.
            </p>
          )}

          {/* Title Area */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
            <input
              type="text"
              className="drawer-title-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onFocus={() => { titleBase.current = card.title; }}
              onBlur={handleTitleBlur}
              placeholder="Zadejte název úkolu"
              data-testid="drawer-title-input"
            />
          </div>

          {/* Properties Field Grid (Linear/Notion style) */}
          <div className="drawer-meta-grid">
            <span className="drawer-meta-label">Stav</span>
            <div className="drawer-meta-value">
              <select 
                className="drawer-select" 
                value={columnId} 
                onChange={handleStatusChange}
                data-testid="drawer-status-select"
                aria-label="Stav (sloupec)"
              >
                {columns.map((col) => (
                  <option key={col.id} value={col.id}>{col.name}</option>
                ))}
              </select>
            </div>

            <span className="drawer-meta-label">Priorita</span>
            <div className="drawer-meta-value">
              <select 
                className="drawer-select" 
                value={priority} 
                onChange={handlePriorityChange}
                data-testid="drawer-priority-select"
                aria-label="Priorita"
              >
                <option value="">Žádná</option>
                <option value="Low">Nízká</option>
                <option value="Medium">Střední</option>
                <option value="High">Vysoká</option>
              </select>
            </div>

            <span className="drawer-meta-label">Přiřazeno</span>
            <div className="drawer-meta-value" style={{ width: '100%' }}>
              <MultiAssigneeSelect
                selected={assignees}
                teamMembers={teamMembers}
                onChange={handleAssigneesChange}
                placeholder="Přiřadit členy..."
              />
              {/* Hidden select for test backward compatibility */}
              <select
                data-testid="drawer-assignee-select"
                value={assignees.length > 0 ? assignees[0].fullName : ''}
                onChange={() => {}}
                style={{ display: 'none' }}
              >
                <option value="">Nepřiřazeno</option>
                {assignees.map((member) => (
                  <option key={member.id} value={member.fullName}>{member.fullName}</option>
                ))}
              </select>
            </div>

            <span className="drawer-meta-label">Termín splnění</span>
            <div className="drawer-meta-value" style={{ gap: '0.5rem' }}>
              <input
                type="date"
                className="drawer-date-input"
                aria-label="Termín splnění"
                value={dueDate}
                onChange={handleDueDateChange}
                data-testid="drawer-duedate-input"
              />
              {dueDate && (
                <button
                  type="button"
                  onClick={handleClearDueDate}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--gray-text)',
                    fontSize: '0.75rem',
                    fontWeight: 600,
                    cursor: 'pointer',
                    textDecoration: 'underline',
                  }}
                  className="drawer-duedate-clear"
              data-testid="drawer-duedate-clear"
                >
                  Vymazat
                </button>
              )}
            </div>

            <span className="drawer-meta-label">Štítek</span>
            <div className="drawer-meta-value">
              <select 
                className="drawer-select" 
                value={tag} 
                onChange={handleTagChange}
                data-testid="drawer-tag-select"
                aria-label="Štítek"
              >
                <option value="">Žádný</option>
                {availableTags.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="drawer-divider" />

          {/* Description Section */}
          <div>
            <h3 className="drawer-section-title">Popis</h3>
            <textarea
              className="drawer-desc-textarea"
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              onFocus={() => { detailsBase.current = card.details; }}
              onBlur={handleDetailsBlur}
              placeholder="Napište podrobnosti nebo popis úkolu..."
              data-testid="drawer-desc-input"
            />
          </div>

          <div className="drawer-divider" />

          {/* Checklist Section */}
          <div>
            <h3 className="drawer-section-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              Checklist 
              {totalChecklistCount > 0 && (
                <span style={{ fontSize: '0.7rem', color: 'var(--gray-text)', textTransform: 'none', fontWeight: 500 }} data-testid="checklist-progress-text">
                  {completedChecklistCount} / {totalChecklistCount} splněno
                </span>
              )}
            </h3>

            {/* Checklist progress bar */}
            {totalChecklistCount > 0 && (
              <div className="drawer-checklist-bar-container">
                <div className="drawer-checklist-bar-bg">
                  <div 
                    className="drawer-checklist-bar-fill" 
                    style={{ width: `${checklistProgressPercent}%` }}
                    data-testid="checklist-progress-bar"
                  />
                </div>
                <span style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--gray-text)' }}>
                  {checklistProgressPercent}%
                </span>
              </div>
            )}

            {/* Checklist items */}
            <div className="drawer-checklist-items" data-testid="checklist-items">
              {checklistItems.map((item) => (
                <div key={item.id} className="checklist-item-row" data-testid={`checklist-item-${item.id}`}>
                  <input
                    type="checkbox"
                    className="checklist-checkbox"
                    checked={item.completed}
                    onChange={() => onToggleChecklistItem(columnId, card.id, item.id)}
                    data-testid={`checklist-checkbox-${item.id}`}
                  />
                  <input
                    type="text"
                    className={`checklist-text-input ${item.completed ? 'completed' : ''}`}
                    defaultValue={item.text}
                    onFocus={() => { checklistBase.current[item.id] = item.text; }}
                    onBlur={(e) => handleChecklistTextBlur(item.id, item.text, e.target.value)}
                    data-testid={`checklist-input-${item.id}`}
                  />
                  <button
                    type="button"
                    className="checklist-delete-btn"
                    onClick={() => onDeleteChecklistItem(columnId, card.id, item.id)}
                    data-testid={`checklist-delete-${item.id}`}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>

            {/* Add checklist item */}
            <form onSubmit={handleAddChecklistItem} className="checklist-add-row">
              <input
                type="text"
                className="checklist-add-input"
                placeholder="Přidat položku checklistu..."
                value={newChecklistText}
                onChange={(e) => setNewChecklistText(e.target.value)}
                data-testid="checklist-add-input"
              />
              <button
                type="submit"
                style={{
                  padding: '0.4rem 0.75rem',
                  backgroundColor: 'var(--bg-column)',
                  border: '1px solid var(--border-color)',
                  borderRadius: '6px',
                  fontSize: '0.8rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                  color: 'var(--dark-navy)',
                  transition: 'var(--spring-transition)',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--border-color)')}
                onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'var(--bg-column)')}
                className="checklist-add-submit"
              data-testid="checklist-add-submit"
              >
                Přidat
              </button>
            </form>
          </div>

          <div className="drawer-divider" />

          {/* Resources Section (Task Resources v1 & v2 AI Context) */}
          {card && (
            <TaskResourcesSection
              taskId={card.id}
              cardTitle={card.title}
              uploadedBy={profile?.display_name || 'Uživatel'}
              onAddSubtaskToChecklist={(text) => onAddChecklistItem(columnId, card.id, text)}
            />
          )}

          {card && projectId && hasSupabaseConfig && (
            <>
              <div className="drawer-divider" />
              <DriveLinksPanel projectId={projectId} cardId={card.id} canEdit={!readOnly} returnTo={`/projects/${projectId}`} />
              <GmailLinksPanel projectId={projectId} cardId={card.id} canEdit={!readOnly} returnTo={`/projects/${projectId}`} />
              <CalendarLinksPanel projectId={projectId} cardId={card.id} canEdit={!readOnly} returnTo={`/projects/${projectId}`} />
            </>
          )}

          <div className="drawer-divider" />

          {/* Comments Section */}
          <div>
            <h3 className="drawer-section-title" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              <MessageSquare size={14} /> Komentáře
            </h3>
            
            <TaskComments
              comments={card.comments || []}
              mentionables={mentionables}
              currentUserId={currentUserId}
              canModerate={canModerate}
              readOnly={readOnly}
              onAdd={(content, mentions) => {
                const author = profile?.display_name || profile?.email || 'Uživatel';
                onAddComment(columnId, card.id, author, content, mentions);
              }}
              onEdit={onEditComment ? (commentId, content, mentions) => onEditComment(card.id, commentId, content, mentions) : undefined}
              onDelete={onDeleteComment ? (commentId) => onDeleteComment(card.id, commentId) : undefined}
              chatSources={chatInfo?.sources}
              chatNotice={chatInfo && chatInfo.linked.length ? `Komentáře k tomuto úkolu se posílají i do propojeného vlákna (${chatInfo.linked.map((p) => (p === 'slack' ? 'Slack' : 'Telegram')).join(', ')}).` : null}
            />
            {showChatConversation && <TaskConversation cardId={card.id} names={new Map((mentionables ?? []).map((m) => [m.profileId, m.name]))} />}
          </div>

          <div className="drawer-divider" />

          {/* Activity Section */}
          <div>
            <button
              type="button"
              onClick={() => setIsActivityCollapsed(!isActivityCollapsed)}
              style={{
                width: '100%',
                background: 'none',
                border: 'none',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                cursor: 'pointer',
                padding: '0.25rem 0',
                outline: 'none',
              }}
              className="drawer-activity-toggle"
              data-testid="drawer-activity-toggle"
            >
              <h3 className="drawer-section-title" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', margin: 0 }}>
                <Clock size={14} /> Historie aktivit
              </h3>
              <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--gray-text)' }}>
                {isActivityCollapsed ? 'Zobrazit' : 'Skrýt'}
              </span>
            </button>

            {!isActivityCollapsed && (
              <div 
                className="drawer-activity-timeline" 
                style={{ marginTop: '0.85rem' }}
                data-testid="activity-timeline"
              >
                {hasSupabaseConfig && (history === null ? (
                  <p style={{ fontSize: '0.75rem', color: 'var(--gray-text)', paddingLeft: '0.5rem' }}>Načítání…</p>
                ) : history.map((h) => (
                  <div key={h.id} className="activity-item" data-testid={`task-history-${h.id}`} data-action={h.actionType}>
                    <span className="activity-text"><strong>{h.actorName}</strong> {describeActivity({ id: h.id, projectId: '', actorName: h.actorName, actionType: h.actionType, entityType: '', details: h.details, createdAt: h.createdAt }).text}</span>
                    <span className="activity-time" title={new Date(h.createdAt).toLocaleString('cs-CZ')}>{formatRelativeTime(h.createdAt)}</span>
                  </div>
                )))}
                {(card.activities || []).length > 0 && hasSupabaseConfig && (
                  <p style={{ fontSize: '0.7rem', color: 'var(--gray-text)', margin: '0.6rem 0 0.2rem 0.5rem' }}>Starší záznamy (zapsané aplikací před ověřenou historií):</p>
                )}
                {(!hasSupabaseConfig && (card.activities || []).length === 0) || (hasSupabaseConfig && history !== null && history.length === 0 && (card.activities || []).length === 0) ? (
                  <p style={{ fontSize: '0.75rem', color: 'var(--gray-text)', fontStyle: 'italic', paddingLeft: '0.5rem' }}>
                    Žádná aktivita nebyla zaznamenána.
                  </p>
                ) : (
                  [...(card.activities || [])]
                    .reverse() // Display newest first in UI for history timeline comfort
                    .map((act) => (
                      <div key={act.id} className="activity-item" data-legacy={hasSupabaseConfig ? 'true' : undefined}>
                        <span className="activity-text">{act.text}</span>
                        <span className="activity-time">
                          {new Date(act.createdAt).toLocaleString('cs-CZ', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                        </span>
                      </div>
                    ))
                )}
              </div>
            )}
          </div>

          <div className="drawer-divider" />

          {/* AI Assistant Section */}
          <div className="drawer-ai-section" data-testid="drawer-ai-section">
            <div className="ai-header-group">
              <span style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--purple-secondary)', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                <Sparkles size={16} /> AI Asistent
              </span>
              <span style={{ fontSize: '0.7rem', color: 'var(--gray-text)' }}>
                Automatická analýza a optimalizace zadání.
              </span>
            </div>

            {isAiLoading && (
              <div className="ai-loading-container" data-testid="ai-loading" style={{ marginTop: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem', backgroundColor: 'var(--surface-2)', border: '1px dashed var(--border-color)', borderRadius: '6px' }}>
                <div className="ai-spinner" />
                <span className="ai-loading-text" style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--purple-secondary)' }}>✨ AI právě analyzuje úkol...</span>
              </div>
            )}

            {aiError && !isAiLoading && (
              <div className="ai-error-container" data-testid="ai-error" style={{ marginTop: '0.75rem', padding: '0.75rem', backgroundColor: 'var(--danger-soft)', border: '1px solid var(--danger-soft)', borderRadius: '6px', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                <span className="ai-error-text" style={{ fontSize: '0.75rem', color: 'var(--danger)', fontWeight: 500 }}>{aiError}</span>
                <button
                  type="button"
                  className="ai-retry-btn"
                  onClick={handleImproveTask}
                  style={{ alignSelf: 'flex-start', border: 'none', background: 'var(--danger)', color: '#ffffff', fontSize: '0.7rem', fontWeight: 600, padding: '0.25rem 0.6rem', borderRadius: '4px', cursor: 'pointer' }}
                >
                  Zkusit znovu
                </button>
              </div>
            )}

            {!isAiLoading && !aiError && !aiPreview && (
              <div style={{ marginTop: '0.55rem' }}>
                <button
                  type="button"
                  className="ai-improve-btn"
                  onClick={handleImproveTask}
                  data-testid="ai-improve-btn"
                  style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', border: 'none', background: 'var(--purple-secondary)', color: '#ffffff', fontSize: '0.75rem', fontWeight: 700, padding: '0.45rem 0.95rem', borderRadius: '6px', cursor: 'pointer', transition: 'all 0.2s ease-in-out' }}
                >
                  <Sparkles size={14} />
                  Vylepšit úkol
                </button>
              </div>
            )}

            {!isAiLoading && aiPreview && (
              <div className="ai-preview-panel" data-testid="ai-preview" style={{ marginTop: '0.75rem', padding: '0.85rem', backgroundColor: 'var(--surface-2)', border: '1px solid var(--border-color)', borderRadius: '8px', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                <div className="ai-preview-header" style={{ fontSize: '0.8rem', fontWeight: 800, color: 'var(--dark-navy)', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.35rem' }}>
                  Návrh AI vylepšení
                </div>

                {aiPreview.details && (
                  <div className="ai-preview-section">
                    <span className="ai-preview-label" style={{ fontSize: '0.65rem', fontWeight: 700, textTransform: 'uppercase', color: 'var(--gray-text)', letterSpacing: '0.05em' }}>Vylepšený popis</span>
                    <p className="ai-preview-value" style={{ fontSize: '0.75rem', color: 'var(--dark-navy)', margin: '0.15rem 0 0 0', lineHeight: 1.35 }}>{aiPreview.details}</p>
                  </div>
                )}

                {aiPreview.acceptanceCriteria && (
                  <div className="ai-preview-section">
                    <span className="ai-preview-label" style={{ fontSize: '0.65rem', fontWeight: 700, textTransform: 'uppercase', color: 'var(--gray-text)', letterSpacing: '0.05em' }}>Kritéria akceptace</span>
                    <p className="ai-preview-value" style={{ fontSize: '0.75rem', color: 'var(--dark-navy)', margin: '0.15rem 0 0 0', lineHeight: 1.35, whiteSpace: 'pre-wrap' }}>{aiPreview.acceptanceCriteria}</p>
                  </div>
                )}

                {aiPreview.risks && (
                  <div className="ai-preview-section">
                    <span className="ai-preview-label" style={{ fontSize: '0.65rem', fontWeight: 700, textTransform: 'uppercase', color: 'var(--gray-text)', letterSpacing: '0.05em' }}>Možná rizika</span>
                    <p className="ai-preview-value" style={{ fontSize: '0.75rem', color: 'var(--dark-navy)', margin: '0.15rem 0 0 0', lineHeight: 1.35 }}>{aiPreview.risks}</p>
                  </div>
                )}

                {aiPreview.missingInfo && (
                  <div className="ai-preview-section">
                    <span className="ai-preview-label" style={{ fontSize: '0.65rem', fontWeight: 700, textTransform: 'uppercase', color: 'var(--gray-text)', letterSpacing: '0.05em' }}>Chybějící informace</span>
                    <p className="ai-preview-value" style={{ fontSize: '0.75rem', color: 'var(--dark-navy)', margin: '0.15rem 0 0 0', lineHeight: 1.35 }}>{aiPreview.missingInfo}</p>
                  </div>
                )}

                {aiPreview.checklist && aiPreview.checklist.length > 0 && (
                  <div className="ai-preview-section">
                    <span className="ai-preview-label" style={{ fontSize: '0.65rem', fontWeight: 700, textTransform: 'uppercase', color: 'var(--gray-text)', letterSpacing: '0.05em' }}>Navržený checklist</span>
                    <ul className="ai-preview-list" style={{ margin: '0.2rem 0 0 0', paddingLeft: '1.1rem', fontSize: '0.75rem', color: 'var(--dark-navy)' }}>
                      {aiPreview.checklist.map((item, idx) => (
                        <li key={idx} className="ai-preview-list-item" style={{ marginBottom: '0.15rem' }}>{item}</li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="ai-preview-actions" style={{ display: 'flex', gap: '0.5rem', marginTop: '0.25rem' }}>
                  <button
                    type="button"
                    className="ai-accept-btn"
                    onClick={handleAcceptAiSuggestion}
                    data-testid="ai-accept-btn"
                    style={{ border: 'none', background: 'var(--purple-secondary)', color: '#ffffff', fontSize: '0.75rem', fontWeight: 700, padding: '0.35rem 0.75rem', borderRadius: '4px', cursor: 'pointer' }}
                  >
                    Přijmout návrh
                  </button>
                  <button
                    type="button"
                    className="ai-discard-btn"
                    onClick={handleDiscardAiSuggestion}
                    data-testid="ai-discard-btn"
                    style={{ border: '1px solid var(--border-color)', background: 'var(--surface)', color: 'var(--dark-navy)', fontSize: '0.75rem', fontWeight: 600, padding: '0.35rem 0.75rem', borderRadius: '4px', cursor: 'pointer' }}
                  >
                    Zahodit
                  </button>
                </div>
              </div>
            )}
          </div>

        </fieldset>
      </div>
    </>
  );
}
