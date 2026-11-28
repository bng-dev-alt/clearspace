import React from 'react';
import { describe, expect, test, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import LiveTranscriptView from '../../components/meetings/LiveTranscriptView';

const groups = [{ speaker: '1', startMs: 0, text: 'Dobrý den.' }, { speaker: '2', startMs: 4000, text: 'Souhlasím.' }, { speaker: '1', startMs: 9000, text: 'Pokračujeme.' }];
const view = () => render(<LiveTranscriptView groups={groups} partial="a dál…" status="● Nahrává se" speakerLabel={(s) => `Mluvčí ${s}`} fmt={(ms) => `${ms / 1000}s`} />);

describe('RUN 11 #16 live transcript full screen', () => {
  test('uses the Fullscreen API and follows the browser state (Esc exits there)', async () => {
    let fsEl: Element | null = null;
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fsEl });
    const request = vi.fn(function (this: HTMLElement) { fsEl = this; document.dispatchEvent(new Event('fullscreenchange')); return Promise.resolve(); });
    const exit = vi.fn(() => { fsEl = null; document.dispatchEvent(new Event('fullscreenchange')); return Promise.resolve(); });
    (HTMLElement.prototype as unknown as { requestFullscreen: unknown }).requestFullscreen = request;
    (document as unknown as { exitFullscreen: unknown }).exitFullscreen = exit;
    view();
    const box = screen.getByTestId('live-transcript');
    expect(box.dataset.presenting).toBe('false');
    await act(async () => { fireEvent.click(screen.getByTestId('live-fullscreen')); });
    expect(request).toHaveBeenCalledTimes(1);
    expect(box.dataset.presenting).toBe('true');
    expect(screen.getByTestId('live-fullscreen-status').textContent).toContain('Nahrává se');
    expect(screen.getByTestId('live-fullscreen').getAttribute('aria-pressed')).toBe('true');
    // the browser leaves full screen (Esc): the view follows
    await act(async () => { fsEl = null; document.dispatchEvent(new Event('fullscreenchange')); });
    expect(box.dataset.presenting).toBe('false');
    delete (HTMLElement.prototype as unknown as { requestFullscreen?: unknown }).requestFullscreen;
  });

  test('without the Fullscreen API it shows a full-window layer that Esc closes', async () => {
    view();
    const box = screen.getByTestId('live-transcript');
    await act(async () => { fireEvent.click(screen.getByTestId('live-fullscreen')); });
    expect(box.className).toContain('is-fallback');
    expect(box.dataset.presenting).toBe('true');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(box.dataset.presenting).toBe('false');
  });

  test('speakers keep a stable colour marker and their written name', () => {
    view();
    const segs = screen.getByTestId('live-transcript').querySelectorAll('.mi-seg');
    expect(segs[0].getAttribute('data-speaker-color')).toBe(segs[2].getAttribute('data-speaker-color'));
    expect(segs[0].getAttribute('data-speaker-color')).not.toBe(segs[1].getAttribute('data-speaker-color'));
    expect(segs[1].textContent).toContain('Mluvčí 2');
  });
});
