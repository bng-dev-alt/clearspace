import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, test, expect, beforeEach, vi } from 'vitest';
import TaskDetailDrawer from '../components/board/TaskDetailDrawer';
import { Card } from '../types/kanban';

// Mock auth hook
vi.mock('../hooks/useAuth', () => ({
  useAuth: () => ({
    profile: { display_name: 'Testovací Uživatel', email: 'test@example.com' },
  }),
}));

// Mock next/navigation params
vi.mock('next/navigation', () => ({
  useParams: () => ({ projectId: 'proj-123' }),
}));

const mockColumns = [
  { id: 'col-1', name: 'Nápady', cards: [] },
  { id: 'col-2', name: 'Naplánováno', cards: [] },
];

const mockCard: Card = {
  id: 'card-123',
  title: 'Testovací Task',
  details: 'Tohle je popis úkolu',
  priority: 'Medium',
  assignee: { name: 'Alex Rivera', initials: 'AR', color: '#209dd7' },
  dueDate: '2026-07-20',
  checklist: [],
  comments: [],
  activities: [],
};

describe('TaskDetailDrawer Presentation Modes Unit Tests', () => {
  const onUpdateCard = vi.fn();
  const onMoveCard = vi.fn();
  const onDeleteCard = vi.fn();
  const onAddChecklistItem = vi.fn();
  const onToggleChecklistItem = vi.fn();
  const onUpdateChecklistItemText = vi.fn();
  const onDeleteChecklistItem = vi.fn();
  const onAddComment = vi.fn();
  const onAddActivity = vi.fn();
  const onClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    if (typeof window !== 'undefined') {
      localStorage.removeItem('task_detail_mode');
    }
  });

  test('defaults to Right Panel mode if no preference is saved', () => {
    render(
      <TaskDetailDrawer
        isOpen={true}
        onClose={onClose}
        card={mockCard}
        columnId="col-1"
        teamMembers={[]}
        columns={mockColumns}
        availableTags={['Feature']}
        onUpdateCard={onUpdateCard}
        onMoveCard={onMoveCard}
        onDeleteCard={onDeleteCard}
        onAddChecklistItem={onAddChecklistItem}
        onToggleChecklistItem={onToggleChecklistItem}
        onUpdateChecklistItemText={onUpdateChecklistItemText}
        onDeleteChecklistItem={onDeleteChecklistItem}
        onAddComment={onAddComment}
        onAddActivity={onAddActivity}
      />
    );

    const drawer = screen.getByTestId('task-detail-drawer');
    expect(drawer).toHaveClass('mode-right');
    expect(drawer).not.toHaveClass('mode-left');
    expect(drawer).not.toHaveClass('mode-focused');
  });

  test('restores user view preference from localStorage', () => {
    localStorage.setItem('task_detail_mode', 'focused');

    render(
      <TaskDetailDrawer
        isOpen={true}
        onClose={onClose}
        card={mockCard}
        columnId="col-1"
        teamMembers={[]}
        columns={mockColumns}
        availableTags={['Feature']}
        onUpdateCard={onUpdateCard}
        onMoveCard={onMoveCard}
        onDeleteCard={onDeleteCard}
        onAddChecklistItem={onAddChecklistItem}
        onToggleChecklistItem={onToggleChecklistItem}
        onUpdateChecklistItemText={onUpdateChecklistItemText}
        onDeleteChecklistItem={onDeleteChecklistItem}
        onAddComment={onAddComment}
        onAddActivity={onAddActivity}
      />
    );

    const drawer = screen.getByTestId('task-detail-drawer');
    expect(drawer).toHaveClass('mode-focused');
    expect(drawer).not.toHaveClass('mode-right');

    const overlay = screen.getByTestId('drawer-overlay');
    expect(overlay).toHaveClass('mode-focused');
  });

  test('switches presentation mode when clicking switcher buttons and saves preference', () => {
    render(
      <TaskDetailDrawer
        isOpen={true}
        onClose={onClose}
        card={mockCard}
        columnId="col-1"
        teamMembers={[]}
        columns={mockColumns}
        availableTags={['Feature']}
        onUpdateCard={onUpdateCard}
        onMoveCard={onMoveCard}
        onDeleteCard={onDeleteCard}
        onAddChecklistItem={onAddChecklistItem}
        onToggleChecklistItem={onToggleChecklistItem}
        onUpdateChecklistItemText={onUpdateChecklistItemText}
        onDeleteChecklistItem={onDeleteChecklistItem}
        onAddComment={onAddComment}
        onAddActivity={onAddActivity}
      />
    );

    const drawer = screen.getByTestId('task-detail-drawer');
    const btnLeft = screen.getByTestId('mode-btn-left');
    const btnFocused = screen.getByTestId('mode-btn-focused');
    const btnRight = screen.getByTestId('mode-btn-right');

    // Click Left Panel
    fireEvent.click(btnLeft);
    expect(drawer).toHaveClass('mode-left');
    expect(localStorage.getItem('task_detail_mode')).toBe('left');

    // Click Focused Mode
    fireEvent.click(btnFocused);
    expect(drawer).toHaveClass('mode-focused');
    expect(localStorage.getItem('task_detail_mode')).toBe('focused');

    // Click Right Panel back
    fireEvent.click(btnRight);
    expect(drawer).toHaveClass('mode-right');
    expect(localStorage.getItem('task_detail_mode')).toBe('right');
  });

  test('renders extensibility placeholder button in mode switcher', () => {
    render(
      <TaskDetailDrawer
        isOpen={true}
        onClose={onClose}
        card={mockCard}
        columnId="col-1"
        teamMembers={[]}
        columns={mockColumns}
        availableTags={['Feature']}
        onUpdateCard={onUpdateCard}
        onMoveCard={onMoveCard}
        onDeleteCard={onDeleteCard}
        onAddChecklistItem={onAddChecklistItem}
        onToggleChecklistItem={onToggleChecklistItem}
        onUpdateChecklistItemText={onUpdateChecklistItemText}
        onDeleteChecklistItem={onDeleteChecklistItem}
        onAddComment={onAddComment}
        onAddActivity={onAddActivity}
      />
    );

    const btnFullscreen = screen.getByTestId('mode-btn-fullscreen');
    expect(btnFullscreen).toBeDisabled();
    expect(btnFullscreen).toHaveTextContent('Fullscreen');
  });
});
