import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest';

const h = vi.hoisted(() => ({ svc: {} as Record<string, ReturnType<typeof vi.fn>> }));
vi.mock('../../services/meetingService', () => {
  class MeetingServiceError extends Error {
    code: string;
    constructor(code: string, message: string) { super(message); this.code = code; }
  }
  for (const n of ['startTranscription', 'syncTranscription', 'purgeAudio', 'createAudioMeeting', 'createWithTranscript']) h.svc[n] = vi.fn();
  return { MeetingServiceError, meetingService: h.svc };
});

import AudioPanel from '../../components/meetings/AudioPanel';
import { MeetingServiceError, type Meeting } from '../../services/meetingService';

const svc = () => h.svc as Record<string, ReturnType<typeof vi.fn>>;
const meeting = (audio: Partial<Meeting['audio']> = {}): Meeting => ({
  id: 'm1', projectId: 'p1', title: 'Audio', occurredAt: '2026-11-18T10:00:00Z', sourceKind: 'audio', status: 'uploaded', currentRevision: null,
  speakerNames: {}, languageHint: null, createdAt: '',
  audio: { consentAt: '2026-11-18T09:00:00Z', path: 'p1/m1/f.mp3', bytes: 3_145_728, uploadedAt: '2026-11-18T09:01:00Z', deleteAfter: null, deletedAt: null, sttState: 'none', attempts: 0, errorType: null, audioMs: null, costUsd: null, model: null, cleanupPending: false, ...audio },
});
const FAST = { first: 5, max: 10 };

beforeEach(() => { vi.clearAllMocks(); for (const f of Object.values(h.svc)) f.mockReset(); });
afterEach(() => vi.useRealTimers());

describe('AudioPanel', () => {
  test('nothing is sent to the provider until the user clicks; the price is stated up front', async () => {
    render(<AudioPanel meeting={meeting()} projectId="p1" onChanged={vi.fn()} pollMs={FAST} />);
    expect(screen.getByTestId('stt-start')).toBeInTheDocument();
    expect(screen.getByText(/0,10 USD za hodinu/)).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 40));
    expect(svc().startTranscription).not.toHaveBeenCalled();
    expect(svc().syncTranscription).not.toHaveBeenCalled(); // an idle meeting is not polled
  });
  test('without recorded consent the start button is disabled', () => {
    render(<AudioPanel meeting={meeting({ consentAt: null })} projectId="p1" onChanged={vi.fn()} />);
    expect(screen.getByTestId('stt-start')).toBeDisabled();
    expect(screen.getByTestId('audio-info')).toHaveTextContent('Souhlas účastníků nebyl zaznamenán');
  });
  test('start calls the service once (no double click) and reloads', async () => {
    let resolve!: () => void;
    svc().startTranscription.mockReturnValue(new Promise<void>((r) => { resolve = r; }));
    const onChanged = vi.fn();
    render(<AudioPanel meeting={meeting()} projectId="p1" onChanged={onChanged} />);
    fireEvent.click(screen.getByTestId('stt-start'));
    fireEvent.click(screen.getByTestId('stt-start'));
    resolve();
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith('Přepis zahájen.'));
    expect(svc().startTranscription).toHaveBeenCalledTimes(1);
    expect(svc().startTranscription).toHaveBeenCalledWith('p1', 'm1');
  });
  test('server errors (e.g. budget) are shown readably and the button stays usable', async () => {
    svc().startTranscription.mockRejectedValue(new MeetingServiceError('budget_exceeded', 'Byl vyčerpán denní limit přepisu zvuku. Zkuste to prosím zítra.'));
    render(<AudioPanel meeting={meeting()} projectId="p1" onChanged={vi.fn()} />);
    fireEvent.click(screen.getByTestId('stt-start'));
    expect(await screen.findByTestId('audio-error')).toHaveTextContent('denní limit');
    expect(screen.getByTestId('stt-start')).toBeEnabled();
  });
  test('a failed job shows the reason by TYPE and the attempt counter; "try again" is offered up to 3 attempts', () => {
    const { rerender } = render(<AudioPanel meeting={meeting({ sttState: 'failed', errorType: 'empty_transcript', attempts: 1 })} projectId="p1" onChanged={vi.fn()} />);
    expect(screen.getByTestId('stt-error')).toHaveTextContent('nebyla rozpoznána žádná řeč');
    expect(screen.getByTestId('stt-error')).toHaveTextContent('Pokus 1 z 3');
    expect(screen.getByTestId('stt-start')).toHaveTextContent('Zkusit znovu (pokus 2 z 3)');
    rerender(<AudioPanel meeting={meeting({ sttState: 'failed', errorType: 'weird_new_type', attempts: 3 })} projectId="p1" onChanged={vi.fn()} />);
    expect(screen.getByTestId('stt-error')).toHaveTextContent('Přepis se nezdařil.'); // unknown types never show raw text
    expect(screen.getByTestId('stt-error')).toHaveTextContent('Počet pokusů je vyčerpán');
    expect(screen.queryByTestId('stt-start')).toBeNull();
  });
  test('while transcribing the page polls with backoff and reloads when the state changes; polling stops on unmount', async () => {
    svc().syncTranscription.mockResolvedValueOnce({ state: 'transcribing', providerStatus: 'queued', cleanupPending: false }).mockResolvedValueOnce({ state: 'transcribing', cleanupPending: false }).mockResolvedValue({ state: 'completed', revision: 'r'.repeat(64), cleanupPending: false });
    const onChanged = vi.fn();
    const { unmount } = render(<AudioPanel meeting={meeting({ sttState: 'transcribing' })} projectId="p1" onChanged={onChanged} pollMs={FAST} />);
    await waitFor(() => expect(svc().syncTranscription.mock.calls.length).toBeGreaterThanOrEqual(3));
    expect(onChanged).toHaveBeenCalled(); // state changed to completed -> page reloads
    expect(svc().syncTranscription).toHaveBeenCalledWith('p1', 'm1', false);
    unmount();
    const n = svc().syncTranscription.mock.calls.length;
    await new Promise((r) => setTimeout(r, 60));
    expect(svc().syncTranscription.mock.calls.length).toBe(n); // closed page = no more polling (nothing runs in the background)
  });
  test('a polling error is shown but does not break the page', async () => {
    svc().syncTranscription.mockRejectedValue(new MeetingServiceError('stt_unavailable', 'Služba přepisu je dočasně nedostupná.'));
    render(<AudioPanel meeting={meeting({ sttState: 'transcribing' })} projectId="p1" onChanged={vi.fn()} pollMs={FAST} />);
    expect(await screen.findByTestId('audio-error')).toHaveTextContent('dočasně nedostupná');
  });
  test('a stuck job offers a manual check and cancel; cancel passes cancel=true', async () => {
    svc().syncTranscription.mockResolvedValue({ state: 'transcribing', stuck: true, cleanupPending: false });
    const onChanged = vi.fn();
    render(<AudioPanel meeting={meeting({ sttState: 'transcribing' })} projectId="p1" onChanged={onChanged} pollMs={FAST} />);
    expect(await screen.findByTestId('stt-stuck')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('stt-cancel'));
    await waitFor(() => expect(svc().syncTranscription).toHaveBeenCalledWith('p1', 'm1', true));
  });
  test('completed: duration and price estimate are shown; a pending provider cleanup is settled with one sync', async () => {
    svc().syncTranscription.mockResolvedValue({ state: 'completed', cleanupPending: false });
    render(<AudioPanel meeting={meeting({ sttState: 'completed', audioMs: 1_800_000, costUsd: 0.05, model: 'stt-async-v6', cleanupPending: true, deleteAfter: new Date(Date.now() + 5 * 86_400_000).toISOString() })} projectId="p1" onChanged={vi.fn()} pollMs={FAST} />);
    expect(screen.getByTestId('stt-usage')).toHaveTextContent('30.0 min');
    expect(screen.getByTestId('stt-usage')).toHaveTextContent('$0.0500');
    expect(screen.getByTestId('audio-info')).toHaveTextContent('automaticky smaže');
    await waitFor(() => expect(svc().syncTranscription).toHaveBeenCalledTimes(1));
  });
  test('a finished meeting with nothing pending is not polled at all', async () => {
    render(<AudioPanel meeting={meeting({ sttState: 'completed', audioMs: 60_000, deleteAfter: new Date(Date.now() + 86_400_000).toISOString() })} projectId="p1" onChanged={vi.fn()} pollMs={FAST} />);
    await new Promise((r) => setTimeout(r, 40));
    expect(svc().syncTranscription).not.toHaveBeenCalled();
  });
  test('deleting the audio needs a confirmation and says the transcript stays', async () => {
    svc().purgeAudio.mockResolvedValue(undefined);
    const onChanged = vi.fn();
    render(<AudioPanel meeting={meeting({ sttState: 'completed' })} projectId="p1" onChanged={onChanged} />);
    fireEvent.click(screen.getByTestId('audio-delete'));
    expect(svc().purgeAudio).not.toHaveBeenCalled();
    expect(screen.getByText(/Přepis zůstane/)).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByTestId('audio-delete-confirm')); });
    await waitFor(() => expect(svc().purgeAudio).toHaveBeenCalledWith('p1', 'm1'));
    expect(onChanged).toHaveBeenCalledWith('Zvuk smazán.');
  });
  test('after deletion the panel says so and offers no deletion or start', () => {
    render(<AudioPanel meeting={meeting({ sttState: 'completed', path: null, deletedAt: '2026-11-19T10:00:00Z' })} projectId="p1" onChanged={vi.fn()} />);
    expect(screen.getByTestId('audio-info')).toHaveTextContent('Zvuk byl smazán');
    expect(screen.queryByTestId('audio-delete')).toBeNull();
    expect(screen.queryByTestId('stt-start')).toBeNull();
  });
  test('the audio cannot be deleted while a job runs', () => {
    render(<AudioPanel meeting={meeting({ sttState: 'transcribing' })} projectId="p1" onChanged={vi.fn()} pollMs={{ first: 100000, max: 100000 }} />);
    expect(screen.queryByTestId('audio-delete')).toBeNull();
  });
});

describe('NewMeetingForm (audio mode)', () => {
  beforeEach(() => { vi.stubGlobal('Audio', undefined); }); // no media element in jsdom: the duration read must degrade to null instantly
  const load = async (flag: string | undefined) => {
    vi.resetModules();
    if (flag === undefined) vi.unstubAllEnvs(); else vi.stubEnv('NEXT_PUBLIC_ENABLE_MEETING_AUDIO', flag);
    return (await import('../../components/meetings/NewMeetingForm')).default;
  };
  const mp3 = () => new File([Uint8Array.from([0x49, 0x44, 0x33, 0, 0, 0])], 'porada.mp3', { type: 'audio/mpeg' });

  test('feature flag off (default): no audio option at all', async () => {
    const Form = await load(undefined);
    render(<Form projectId="p1" onCreated={vi.fn()} />);
    expect(screen.queryByTestId('mode-audio')).toBeNull();
  });
  test('flag on: the audio form states the consent text and the retention; the text form is unchanged', async () => {
    const Form = await load('1');
    render(<Form projectId="p1" onCreated={vi.fn()} />);
    fireEvent.click(screen.getByTestId('mode-audio'));
    expect(screen.getByTestId('audio-form')).toHaveTextContent('Soniox');
    expect(screen.getByTestId('audio-form')).toHaveTextContent('Google');
    expect(screen.getByTestId('audio-form')).toHaveTextContent('smaže');
    expect((screen.getByTestId('audio-consent') as HTMLInputElement).checked).toBe(false); // never pre-ticked
    fireEvent.click(screen.getByTestId('mode-text'));
    expect(screen.getByLabelText('Přepis')).toBeInTheDocument();
  });
  test('submitting passes the consent state and the file to the service; consent errors are shown', async () => {
    const Form = await load('1');
    const onCreated = vi.fn();
    svc().createAudioMeeting.mockRejectedValueOnce(new MeetingServiceError('consent_required', 'Bez souhlasu účastníků se zvuk nezpracovává.'));
    render(<Form projectId="p1" onCreated={onCreated} />);
    fireEvent.click(screen.getByTestId('mode-audio'));
    fireEvent.change(screen.getByLabelText('Název porady'), { target: { value: 'Porada' } });
    fireEvent.change(screen.getByTestId('audio-file'), { target: { files: [mp3()] } });
    fireEvent.click(screen.getByTestId('meeting-create'));
    expect(await screen.findByTestId('meeting-error')).toHaveTextContent('Bez souhlasu');
    expect(svc().createAudioMeeting).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p1', title: 'Porada', consent: false }));
    expect(onCreated).not.toHaveBeenCalled();
    svc().createAudioMeeting.mockResolvedValueOnce({ meetingId: 'new-1' });
    fireEvent.click(screen.getByTestId('audio-consent'));
    fireEvent.click(screen.getByTestId('meeting-create'));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('new-1', []));
    expect(svc().createAudioMeeting).toHaveBeenLastCalledWith(expect.objectContaining({ consent: true }));
  });
  test('no file selected is a clear error and nothing is called', async () => {
    const Form = await load('1');
    render(<Form projectId="p1" onCreated={vi.fn()} />);
    fireEvent.click(screen.getByTestId('mode-audio'));
    fireEvent.change(screen.getByLabelText('Název porady'), { target: { value: 'Porada' } });
    fireEvent.click(screen.getByTestId('meeting-create'));
    expect(await screen.findByTestId('meeting-error')).toHaveTextContent('Vyberte zvukový soubor');
    expect(svc().createAudioMeeting).not.toHaveBeenCalled();
  });
});
