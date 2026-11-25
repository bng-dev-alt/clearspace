import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const nav = vi.hoisted(() => ({ path: '/privacy', replace: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.path, useRouter: () => ({ replace: nav.replace }) }));
vi.mock('../../hooks/useAuth', () => ({ useAuth: () => ({ user: null, isLoading: true }) }));
import ProtectedRoute from '../../components/auth/ProtectedRoute';

describe('RUN 02C: static public pages render without waiting for auth (readable for Google review and without JS)', () => {
  it.each(['/privacy', '/about'])('%s renders its content immediately, no login redirect', (p) => {
    nav.path = p;
    render(<ProtectedRoute><p>obsah</p></ProtectedRoute>);
    expect(screen.getByText('obsah')).toBeTruthy();
    expect(nav.replace).not.toHaveBeenCalled();
  });
  it('a protected page still waits (loader, no content)', () => {
    nav.path = '/projects/x';
    render(<ProtectedRoute><p>tajné</p></ProtectedRoute>);
    expect(screen.queryByText('tajné')).toBeNull();
  });
});
