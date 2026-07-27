import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/supabase', () => ({
  hasSupabaseConfig: true,
  supabase: {},
}));

const mockCreateInvitation = vi.fn();
const mockFetchProjectInvitations = vi.fn().mockResolvedValue([]);
const mockRejectInvitation = vi.fn().mockResolvedValue(true);

vi.mock('../services/collaborationService', () => ({
  collaborationService: {
    createInvitation: (...args: unknown[]) => mockCreateInvitation(...args),
    fetchProjectInvitations: (...args: unknown[]) => mockFetchProjectInvitations(...args),
    rejectInvitation: (...args: unknown[]) => mockRejectInvitation(...args),
  },
}));

import ProjectMembersModal from '../components/board/ProjectMembersModal';

describe('ProjectMembersModal', () => {
  beforeEach(() => {
    mockCreateInvitation.mockReset();
    mockFetchProjectInvitations.mockClear();
    mockFetchProjectInvitations.mockResolvedValue([]);
    mockRejectInvitation.mockClear();
  });

  const baseProps = {
    isOpen: true,
    onClose: vi.fn(),
    workspaceMembers: [],
    projectMemberIds: [],
    onChangeMembers: vi.fn(),
    onManageWorkspace: vi.fn(),
  };

  test('renders members list and toolbar', () => {
    render(<ProjectMembersModal {...baseProps} />);
    expect(screen.getByText('Členové projektu')).toBeInTheDocument();
  });

  test('does not show invite-by-email section (moved to team page)', () => {
    render(<ProjectMembersModal {...baseProps} />);
    expect(screen.queryByTestId('invite-by-email-section')).not.toBeInTheDocument();
  });
});
