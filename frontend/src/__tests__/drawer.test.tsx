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
  checklist: [
    { id: 'check-1', text: 'Splnit první úkol', completed: false },
    { id: 'check-2', text: 'Splnit druhý úkol', completed: true },
  ],
  comments: [
    { id: 'comment-1', authorName: 'Adam Novak', content: 'Super práce', createdAt: new Date().toISOString() },
  ],
  activities: [
    { id: 'act-1', text: 'Task created', createdAt: new Date().toISOString() },
  ],
};

describe('TaskDetailDrawer Component Unit Tests', () => {
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
  });

  test('renders card details correctly inside drawer', () => {
    render(
      <TaskDetailDrawer
        isOpen={true}
        onClose={onClose}
        card={mockCard}
        columnId="col-1"
        teamMembers={[]}
        columns={mockColumns}
        availableTags={['Feature', 'Bug']}
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

    // Title input
    const titleInput = screen.getByTestId('drawer-title-input') as HTMLInputElement;
    expect(titleInput.value).toBe('Testovací Task');

    // Description textarea
    const descInput = screen.getByTestId('drawer-desc-input') as HTMLTextAreaElement;
    expect(descInput.value).toBe('Tohle je popis úkolu');

    // Properties
    expect(screen.getByTestId('drawer-priority-select')).toHaveValue('Medium');
    expect(screen.getByTestId('drawer-assignee-select')).toHaveValue('Alex Rivera');
    expect(screen.getByTestId('drawer-duedate-input')).toHaveValue('2026-07-20');

    // Checklist
    expect(screen.getByTestId('checklist-progress-text')).toHaveTextContent('1 / 2 splněno');
    expect(screen.getByTestId('checklist-input-check-1')).toHaveValue('Splnit první úkol');
    expect(screen.getByTestId('checklist-checkbox-check-1')).not.toBeChecked();
    expect(screen.getByTestId('checklist-checkbox-check-2')).toBeChecked();

    // Comments
    expect(screen.getByTestId('comments-list')).toHaveTextContent('Adam Novak');
    expect(screen.getByTestId('comments-list')).toHaveTextContent('Super práce');
  });

  test('triggers inline update for title on blur', () => {
    render(
      <TaskDetailDrawer
        isOpen={true}
        onClose={onClose}
        card={mockCard}
        columnId="col-1"
        teamMembers={[]}
        columns={mockColumns}
        availableTags={[]}
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

    const titleInput = screen.getByTestId('drawer-title-input');
    fireEvent.change(titleInput, { target: { value: 'Nový název úkolu' } });
    fireEvent.blur(titleInput);

    expect(onUpdateCard).toHaveBeenCalledWith('col-1', 'card-123', { title: 'Nový název úkolu' });
  });

  test('triggers inline update for description on blur', () => {
    render(
      <TaskDetailDrawer
        isOpen={true}
        onClose={onClose}
        card={mockCard}
        columnId="col-1"
        teamMembers={[]}
        columns={mockColumns}
        availableTags={[]}
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

    const descInput = screen.getByTestId('drawer-desc-input');
    fireEvent.change(descInput, { target: { value: 'Nový popis' } });
    fireEvent.blur(descInput);

    expect(onUpdateCard).toHaveBeenCalledWith('col-1', 'card-123', { details: 'Nový popis' });
  });

  test('triggers due date changes and clear operations', () => {
    render(
      <TaskDetailDrawer
        isOpen={true}
        onClose={onClose}
        card={mockCard}
        columnId="col-1"
        teamMembers={[]}
        columns={mockColumns}
        availableTags={[]}
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

    // Change date
    const dateInput = screen.getByTestId('drawer-duedate-input');
    fireEvent.change(dateInput, { target: { value: '2026-07-25' } });
    expect(onUpdateCard).toHaveBeenCalledWith('col-1', 'card-123', { dueDate: '2026-07-25' });

    // Clear date
    const clearBtn = screen.getByTestId('drawer-duedate-clear');
    fireEvent.click(clearBtn);
    expect(onUpdateCard).toHaveBeenCalledWith('col-1', 'card-123', { dueDate: undefined });
  });

  test('triggers checklist mutations: add, toggle, edit, delete', () => {
    render(
      <TaskDetailDrawer
        isOpen={true}
        onClose={onClose}
        card={mockCard}
        columnId="col-1"
        teamMembers={[]}
        columns={mockColumns}
        availableTags={[]}
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

    // Add item
    const addInput = screen.getByTestId('checklist-add-input');
    fireEvent.change(addInput, { target: { value: 'Koupit mléko' } });
    fireEvent.submit(screen.getByTestId('checklist-add-submit'));
    expect(onAddChecklistItem).toHaveBeenCalledWith('col-1', 'card-123', 'Koupit mléko');

    // Toggle item
    const checkbox = screen.getByTestId('checklist-checkbox-check-1');
    fireEvent.click(checkbox);
    expect(onToggleChecklistItem).toHaveBeenCalledWith('col-1', 'card-123', 'check-1');

    // Edit item text
    const itemInput = screen.getByTestId('checklist-input-check-1');
    fireEvent.change(itemInput, { target: { value: 'Změněný text položky' } });
    fireEvent.blur(itemInput);
    expect(onUpdateChecklistItemText).toHaveBeenCalledWith('col-1', 'card-123', 'check-1', 'Změněný text položky');

    // Delete item
    const deleteBtn = screen.getByTestId('checklist-delete-check-1');
    fireEvent.click(deleteBtn);
    expect(onDeleteChecklistItem).toHaveBeenCalledWith('col-1', 'card-123', 'check-1');
  });

  test('triggers comment submissions', () => {
    render(
      <TaskDetailDrawer
        isOpen={true}
        onClose={onClose}
        card={mockCard}
        columnId="col-1"
        teamMembers={[]}
        columns={mockColumns}
        availableTags={[]}
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

    const commentInput = screen.getByTestId('comment-add-input');
    fireEvent.change(commentInput, { target: { value: 'Tohle je testovací komentář' } });
    fireEvent.submit(screen.getByTestId('comment-add-submit'));

    expect(onAddComment).toHaveBeenCalledWith('col-1', 'card-123', 'Testovací Uživatel', 'Tohle je testovací komentář');
  });

  test('AI Assistant section shows improve button, triggers loading, shows preview, and accepts suggestion', async () => {
    const mockResponse = {
      parsed: {
        details: 'Vylepšený popis úkolu od AI',
        acceptanceCriteria: '1. Kritérum A',
        risks: 'Riziko A',
        missingInfo: 'Nic',
        checklist: ['Nová položka A'],
      }
    };
    const mockFetch = vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    } as Response);

    render(
      <TaskDetailDrawer
        isOpen={true}
        onClose={onClose}
        card={mockCard}
        columnId="col-1"
        teamMembers={[]}
        columns={mockColumns}
        availableTags={[]}
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

    const improveBtn = screen.getByTestId('ai-improve-btn');
    expect(improveBtn).toBeInTheDocument();

    fireEvent.click(improveBtn);

    expect(screen.getByTestId('ai-loading')).toBeInTheDocument();
    expect(screen.getByTestId('ai-loading')).toHaveTextContent('AI právě analyzuje úkol...');

    const previewPanel = await screen.findByTestId('ai-preview');
    expect(previewPanel).toBeInTheDocument();
    expect(previewPanel).toHaveTextContent('Vylepšený popis');
    expect(previewPanel).toHaveTextContent('Nová položka A');

    const acceptBtn = screen.getByTestId('ai-accept-btn');
    fireEvent.click(acceptBtn);

    expect(onUpdateCard).toHaveBeenCalledWith('col-1', 'card-123', {
      details: 'Vylepšený popis úkolu od AI\n\n### Kritéria akceptace\n1. Kritérum A\n\n### Možná rizika\nRiziko A\n\n### Chybějící informace k dojasnění\nNic',
    });
    expect(onAddChecklistItem).toHaveBeenCalledWith('col-1', 'card-123', 'Nová položka A');
    expect(onAddActivity).toHaveBeenCalledWith('col-1', 'card-123', 'Accepted AI suggestion');

    mockFetch.mockRestore();
  });

  test('AI Assistant section allows discarding suggestion', async () => {
    const mockResponse = {
      parsed: {
        details: 'Popis',
        acceptanceCriteria: 'Kritérum',
        risks: 'Riziko',
        missingInfo: 'Nic',
        checklist: [],
      }
    };
    const mockFetch = vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    } as Response);

    render(
      <TaskDetailDrawer
        isOpen={true}
        onClose={onClose}
        card={mockCard}
        columnId="col-1"
        teamMembers={[]}
        columns={mockColumns}
        availableTags={[]}
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

    const improveBtn = screen.getByTestId('ai-improve-btn');
    fireEvent.click(improveBtn);

    const previewPanel = await screen.findByTestId('ai-preview');
    expect(previewPanel).toBeInTheDocument();

    const discardBtn = screen.getByTestId('ai-discard-btn');
    fireEvent.click(discardBtn);

    expect(onAddActivity).toHaveBeenCalledWith('col-1', 'card-123', 'Discarded AI suggestion');
    expect(screen.queryByTestId('ai-preview')).not.toBeInTheDocument();

    mockFetch.mockRestore();
  });
});
