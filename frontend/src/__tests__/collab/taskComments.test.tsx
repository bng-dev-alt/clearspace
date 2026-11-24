import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import TaskComments from '../../components/collab/TaskComments';
import type { Comment } from '../../types/kanban';

const people = [{ profileId: 'p-c', name: 'Cyril', initials: 'C', color: '#123' }];
const comments: Comment[] = [
  { id: 'c1', authorName: 'Bob', authorId: 'p-b', content: '<script>alert(1)</script> ahoj @Cyril', mentions: ['p-c'], createdAt: new Date().toISOString() },
  { id: 'c2', authorName: 'Alice', authorId: 'p-a', content: 'cizí', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
];

describe('TaskComments', () => {
  it('renders untrusted content as text (no HTML) and highlights mentions', () => {
    const { container } = render(<TaskComments comments={comments} mentionables={people} currentUserId="p-b" canModerate={false} readOnly={false} onAdd={vi.fn()} />);
    expect(container.querySelector('script')).toBeNull();
    expect(screen.getByText(/<script>alert\(1\)<\/script>/)).toBeInTheDocument();
    expect(screen.getByText('@Cyril')).toHaveClass('comment-mention');
    expect(screen.getByText('(upraveno)')).toBeInTheDocument();
  });

  it('offers edit/delete only on own comments; moderators may delete others', () => {
    const { rerender } = render(<TaskComments comments={comments} mentionables={people} currentUserId="p-b" canModerate={false} readOnly={false} onAdd={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByTestId('comment-edit-c1')).toBeInTheDocument();
    expect(screen.queryByTestId('comment-edit-c2')).toBeNull();
    expect(screen.queryByTestId('comment-delete-c2')).toBeNull();
    rerender(<TaskComments comments={comments} mentionables={people} currentUserId="p-b" canModerate onAdd={vi.fn()} readOnly={false} onEdit={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByTestId('comment-delete-c2')).toBeInTheDocument();
    expect(screen.queryByTestId('comment-edit-c2')).toBeNull();
  });

  it('viewer sees comments but no composer and no actions', () => {
    render(<TaskComments comments={comments} mentionables={people} currentUserId="p-b" canModerate readOnly onAdd={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByTestId('comments-readonly')).toBeInTheDocument();
    expect(screen.queryByTestId('comment-add-input')).toBeNull();
    expect(screen.queryByTestId('comment-edit-c1')).toBeNull();
  });

  it('@ suggests project members and submits their profile ids', async () => {
    const onAdd = vi.fn();
    render(<TaskComments comments={[]} mentionables={people} currentUserId="p-b" canModerate={false} readOnly={false} onAdd={onAdd} />);
    const input = screen.getByTestId('comment-add-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'Ahoj @Cy', selectionStart: 8 } });
    const option = await screen.findByTestId('mention-option-p-c');
    fireEvent.mouseDown(option);
    await waitFor(() => expect(input.value).toBe('Ahoj @Cyril '));
    fireEvent.change(input, { target: { value: 'Ahoj @Cyril prosím mrkni' } });
    fireEvent.click(screen.getByTestId('comment-add-submit'));
    expect(onAdd).toHaveBeenCalledWith('Ahoj @Cyril prosím mrkni', ['p-c']);
  });

  it('nobody outside the project can be suggested', () => {
    render(<TaskComments comments={[]} mentionables={people} currentUserId="p-b" canModerate={false} readOnly={false} onAdd={vi.fn()} />);
    fireEvent.change(screen.getByTestId('comment-add-input'), { target: { value: '@Mallory', selectionStart: 8 } });
    expect(screen.queryByTestId('mention-suggestions')).toBeNull();
  });
});
