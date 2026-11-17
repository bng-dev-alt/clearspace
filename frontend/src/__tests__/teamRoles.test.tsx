import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import UserDetailModal from '../components/team/UserDetailModal';
import { TeamMember } from '../types/kanban';

describe('Team Management & Roles Unit Tests', () => {
  const mockMember: TeamMember = {
    id: 'm-100',
    fullName: 'Karel Svoboda',
    initials: 'KS',
    avatarColor: '#209dd7',
    email: 'karel@example.com',
    role: 'Developer',
    workspaceRole: 'member',
    createdAt: '2026-01-01T00:00:00Z',
  };

  it('renders UserDetailModal with member details and metadata', () => {
    render(<UserDetailModal isOpen={true} onClose={vi.fn()} member={mockMember} />);

    expect(screen.getByTestId('user-detail-modal')).toBeInTheDocument();
    expect(screen.getByText('Karel Svoboda')).toBeInTheDocument();
    expect(screen.getByText('karel@example.com')).toBeInTheDocument();
  });
});
