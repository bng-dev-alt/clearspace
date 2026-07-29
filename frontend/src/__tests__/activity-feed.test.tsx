import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, test, expect, vi, beforeEach } from 'vitest';

const mockFetchActivities = vi.fn();

vi.mock('../services/collaborationService', () => ({
  collaborationService: {
    fetchActivities: (...args: unknown[]) => mockFetchActivities(...args),
  },
}));

import ActivityFeedDrawer from '../components/activity/ActivityFeedDrawer';

describe('ActivityFeedDrawer', () => {
  beforeEach(() => {
    mockFetchActivities.mockReset();
  });

  test('does not render when closed', () => {
    render(<ActivityFeedDrawer isOpen={false} onClose={vi.fn()} projectId="proj-1" />);
    expect(screen.queryByTestId('activity-feed-drawer')).not.toBeInTheDocument();
  });

  test('shows empty state when there are no activities', async () => {
    mockFetchActivities.mockResolvedValueOnce([]);
    render(<ActivityFeedDrawer isOpen={true} onClose={vi.fn()} projectId="proj-1" />);

    expect(await screen.findByText(/Zatím žádná aktivita/)).toBeInTheDocument();
    expect(mockFetchActivities).toHaveBeenCalledWith('proj-1');
  });

  test('renders a human-readable line for a known action type', async () => {
    mockFetchActivities.mockResolvedValueOnce([
      {
        id: 'act-1',
        projectId: 'proj-1',
        cardId: 'card-1',
        actorName: 'Jana Nováková',
        actionType: 'card_created',
        entityType: 'task',
        details: { title: 'Opravit bug' },
        createdAt: new Date().toISOString(),
      },
    ]);

    render(<ActivityFeedDrawer isOpen={true} onClose={vi.fn()} projectId="proj-1" />);

    await waitFor(() => expect(screen.getByTestId('activity-item-act-1')).toBeInTheDocument());
    expect(screen.getByText('Jana Nováková')).toBeInTheDocument();
    expect(screen.getByText(/přidal\(a\) úkol „Opravit bug"/)).toBeInTheDocument();
  });

  test('falls back gracefully for an unknown action type', async () => {
    mockFetchActivities.mockResolvedValueOnce([
      {
        id: 'act-2',
        projectId: 'proj-1',
        actorName: 'AI Project Manager',
        actionType: 'some_future_action',
        entityType: 'task',
        details: {},
        createdAt: new Date().toISOString(),
      },
    ]);

    render(<ActivityFeedDrawer isOpen={true} onClose={vi.fn()} projectId="proj-1" />);

    await waitFor(() => expect(screen.getByTestId('activity-item-act-2')).toBeInTheDocument());
    expect(screen.getByText(/provedl\(a\) akci/)).toBeInTheDocument();
  });
});
