import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ResourceUploadError } from '../services/resourceService';

const h = vi.hoisted(() => ({ upload: vi.fn() }));
vi.mock('../services/resourceService', async () => {
  const real = await vi.importActual<typeof import('../services/resourceService')>('../services/resourceService');
  return { ...real, resourceService: { uploadResource: h.upload, fetchTaskResources: async () => [], deleteResource: async () => true } };
});
vi.mock('../components/board/ResourceAiModal', () => ({ default: () => null }));
import TaskResourcesSection from '../components/board/TaskResourcesSection';

const pick = (files: File[]) => fireEvent.change(screen.getByTestId('resource-file-input'), { target: { files } });

describe('TaskResourcesSection upload feedback', () => {
  beforeEach(() => { h.upload.mockReset(); vi.spyOn(window, 'alert').mockImplementation(() => undefined); });

  it('shows the specific reason inline (no generic alert) and keeps trying the other files', async () => {
    h.upload
      .mockRejectedValueOnce(new ResourceUploadError('too_large', 'Soubor je větší než 10 MB.'))
      .mockResolvedValueOnce({ id: 'r2', taskId: 't', storagePath: 'p', filename: 'ok.pdf', mimeType: 'application/pdf', size: 5, uploadedBy: 'U', createdAt: new Date().toISOString(), downloadUrl: 'x' });
    render(<TaskResourcesSection taskId="t" />);
    await waitFor(() => expect(screen.getByTestId('upload-resource-btn')).toBeTruthy());
    pick([new File(['x'], 'big.pdf', { type: 'application/pdf' }), new File(['y'], 'ok.pdf', { type: 'application/pdf' })]);
    const err = await screen.findByTestId('resource-upload-error');
    expect(err.textContent).toContain('big.pdf: Soubor je větší než 10 MB.');
    expect(err.getAttribute('role')).toBe('alert');
    expect(h.upload).toHaveBeenCalledTimes(2);
    expect(await screen.findByText('ok.pdf')).toBeTruthy();
    expect(window.alert).not.toHaveBeenCalled();
    expect(screen.getByText(/do 10 MB/)).toBeTruthy(); // the limit is announced up front
  });

  it('an unexpected (non-typed) error falls back to the generic text, never the raw message', async () => {
    h.upload.mockRejectedValueOnce(new Error('new row violates row-level security policy tasks/abc'));
    render(<TaskResourcesSection taskId="t" />);
    pick([new File(['x'], 'a.pdf', { type: 'application/pdf' })]);
    const err = await screen.findByTestId('resource-upload-error');
    expect(err.textContent).toBe('a.pdf: Nahrávání souboru selhalo. Zkuste to prosím znovu.');
    expect(err.textContent).not.toMatch(/row-level|tasks\//);
  });

  it('errors are cleared by the next upload', async () => {
    h.upload.mockRejectedValueOnce(new ResourceUploadError('permission', 'K tomuto úkolu nemáte oprávnění nahrávat soubory.'));
    render(<TaskResourcesSection taskId="t" />);
    pick([new File(['x'], 'a.pdf', { type: 'application/pdf' })]);
    await screen.findByTestId('resource-upload-error');
    h.upload.mockResolvedValueOnce({ id: 'r3', taskId: 't', storagePath: 'p', filename: 'b.pdf', mimeType: 'application/pdf', size: 1, uploadedBy: 'U', createdAt: new Date().toISOString(), downloadUrl: 'x' });
    pick([new File(['y'], 'b.pdf', { type: 'application/pdf' })]);
    await waitFor(() => expect(screen.queryByTestId('resource-upload-error')).toBeNull());
  });
});
