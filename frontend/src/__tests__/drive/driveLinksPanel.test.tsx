import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { DriveLink, GoogleStatus } from '../../services/driveService';
import { DRIVE_FIXTURES } from '../../data/driveFixtures';

const h = vi.hoisted(() => ({ list: vi.fn(), status: vi.fn(), remove: vi.fn(), refresh: vi.fn(), attach: vi.fn(), grant: vi.fn(), connect: vi.fn(), pick: vi.fn() }));
vi.mock('../../services/driveService', async () => {
  const real = await vi.importActual<typeof import('../../services/driveService')>('../../services/driveService');
  return { ...real, driveService: { list: h.list, status: h.status, remove: h.remove, refresh: h.refresh, attach: h.attach, pickerGrant: h.grant, connect: h.connect, content: vi.fn() } };
});
vi.mock('../../lib/google/picker', () => ({ pickDriveFiles: h.pick }));
import DriveLinksPanel from '../../components/drive/DriveLinksPanel';

const connected: GoogleStatus = { configured: true, connection: { email: 'anna.mock@example.test', scopes: [], status: 'active', connectedAt: '2026-11-20T00:00:00Z' } };
const links: DriveLink[] = DRIVE_FIXTURES;

describe('DriveLinksPanel', () => {
  beforeEach(() => {
    Object.values(h).forEach((f) => f.mockReset());
    h.list.mockResolvedValue(links);
    h.status.mockResolvedValue(connected);
    h.refresh.mockResolvedValue({ statuses: {}, updated: 0 });
  });

  it('editor, connected: lists project files, can add, sees the visibility notice; file names are text, never markup', async () => {
    render(<DriveLinksPanel projectId="p1" canEdit returnTo="/projects/p1" />);
    expect(await screen.findByText('Rozpočet projektu Q1')).toBeTruthy();
    expect(await screen.findByTestId('drive-attach')).toBeTruthy();
    expect(screen.getByTestId('drive-privacy-note').textContent).toMatch(/uvidí všichni členové projektu/);
    expect(document.querySelector('.drive-panel img')).toBeNull();
    expect(screen.getByText('<img src=x onerror=alert(1)>fdp.exe')).toBeTruthy();
    const open = screen.getAllByTestId('drive-open')[0] as HTMLAnchorElement;
    expect(open.getAttribute('rel')).toBe('noopener noreferrer');
    expect(open.href.startsWith('https://docs.google.com/') || open.href.startsWith('https://drive.google.com/')).toBe(true);
    expect(screen.getByTestId('drive-task-list').textContent).toContain('Zápis z porady');
  });

  it('a link with a non-Google URL is never rendered as a link (defence in depth)', async () => {
    h.list.mockResolvedValue([{ ...links[0], webUrl: 'javascript:alert(1)' }]);
    render(<DriveLinksPanel projectId="p1" canEdit returnTo="/projects/p1" />);
    await screen.findByText(links[0].name);
    expect(screen.queryByTestId('drive-open')).toBeNull();
  });

  it('viewer: reads, but has no add or remove controls', async () => {
    render(<DriveLinksPanel projectId="p1" canEdit={false} returnTo="/projects/p1" />);
    await screen.findByText('Rozpočet projektu Q1');
    await waitFor(() => expect(h.status).toHaveBeenCalled());
    expect(screen.queryByTestId('drive-attach')).toBeNull();
    expect(screen.queryByTestId('drive-remove')).toBeNull();
  });

  it('not connected: offers "Připojit Google Disk"; not configured: says so', async () => {
    h.status.mockResolvedValueOnce({ configured: true, connection: null });
    const { unmount } = render(<DriveLinksPanel projectId="p1" canEdit returnTo="/projects/p1" />);
    fireEvent.click(await screen.findByTestId('drive-connect'));
    expect(h.connect).toHaveBeenCalledWith('/projects/p1');
    unmount();
    h.status.mockResolvedValueOnce({ configured: false, connection: null, message: 'Propojení s Google Diskem není na serveru nastavené.' });
    render(<DriveLinksPanel projectId="p1" canEdit returnTo="/projects/p1" />);
    expect(await screen.findByText('Propojení s Google Diskem není na serveru nastavené.')).toBeTruthy();
  });

  it('revoked: prompts "Znovu připojit účet"', async () => {
    h.status.mockResolvedValue({ ...connected, connection: { ...connected.connection!, status: 'revoked' } });
    render(<DriveLinksPanel projectId="p1" canEdit returnTo="/projects/p1" />);
    expect(await screen.findByTestId('drive-reconnect')).toBeTruthy();
  });

  it('remove asks first, says the Drive file stays, then removes only the association', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    h.remove.mockResolvedValue(undefined);
    render(<DriveLinksPanel projectId="p1" canEdit returnTo="/projects/p1" />);
    await screen.findByText('Rozpočet projektu Q1');
    fireEvent.click(screen.getAllByTestId('drive-remove')[0]);
    expect(confirm.mock.calls[0][0]).toMatch(/Soubor v Google Disku zůstane beze změny/);
    await waitFor(() => expect(h.remove).toHaveBeenCalledWith(links[0].id));
  });

  it('attach: Picker ids go to the server; duplicates and refusals are reported in Czech', async () => {
    h.grant.mockResolvedValue({ accessToken: 't', expiresAt: 0, developerKey: 'k', appId: '1', scriptUrl: 'https://apis.google.com/js/api.js', simulated: false });
    h.pick.mockResolvedValue(['mockDoc_SmlouvaCorvane01', 'mockDoc_BohdanPrivat01']);
    h.attach.mockResolvedValue({ links: [{ id: 'l9', fileId: 'mockDoc_SmlouvaCorvane01', duplicate: true }], failed: [{ fileId: 'mockDoc_BohdanPrivat01', reason: 'no_access', message: 'Přístup k souboru není dostupný.' }] });
    render(<DriveLinksPanel projectId="p1" cardId="c1" canEdit returnTo="/projects/p1" />);
    fireEvent.click(await screen.findByTestId('drive-attach'));
    await waitFor(() => expect(h.attach).toHaveBeenCalledWith('p1', 'c1', ['mockDoc_SmlouvaCorvane01', 'mockDoc_BohdanPrivat01']));
    const msg = await screen.findByTestId('drive-message');
    expect(msg.textContent).toMatch(/už je připojený/);
    expect(msg.textContent).toMatch(/Přístup k souboru není dostupný/);
  });

  it('per-user access state from a refresh is shown with a way to verify own access', async () => {
    h.refresh.mockResolvedValue({ statuses: { [links[0].id]: 'no_access' }, updated: 0 });
    render(<DriveLinksPanel projectId="p1" canEdit returnTo="/projects/p1" />);
    await screen.findByText('Rozpočet projektu Q1');
    fireEvent.click(await screen.findByTestId('drive-refresh'));
    expect((await screen.findAllByTestId('drive-link-problem'))[0].textContent).toMatch(/Přístup k souboru není dostupný/);
    expect(screen.getAllByTestId('drive-verify-access').length).toBeGreaterThan(0);
  });
});
