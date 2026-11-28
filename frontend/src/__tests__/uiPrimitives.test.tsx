import React, { useState } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useConfirm, type ConfirmResult } from '../components/ui/useConfirm';
import CopyButton from '../components/ui/CopyButton';
import StatusMessage from '../components/ui/StatusMessage';
import ModalShell from '../components/ui/ModalShell';

function Asker({ onResult, option }: { onResult: (r: ConfirmResult) => void; option?: string }) {
  const [ask, dialog] = useConfirm();
  return (
    <>
      <button onClick={async () => onResult(await ask({ title: 'Odpojit Slack?', message: 'Přestanou chodit oznámení.', confirmLabel: 'Odpojit', danger: true, option }))}>open</button>
      {dialog}
    </>
  );
}

describe('RUN 11 shared primitives', () => {
  test('useConfirm: cancel resolves false, focus starts on the safe button and returns to the opener', async () => {
    const onResult = vi.fn();
    render(<Asker onResult={onResult} />);
    const opener = screen.getByText('open');
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByTestId('confirm-dialog');
    expect(dialog.getAttribute('role')).toBe('alertdialog');
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy();
    expect(screen.getByTestId('confirm-dialog-message').textContent).toContain('Přestanou chodit oznámení.');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('confirm-dialog-cancel')));
    fireEvent.click(screen.getByTestId('confirm-dialog-cancel'));
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(false));
    expect(screen.queryByTestId('confirm-dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  test('useConfirm: Escape cancels; confirm returns the option (unchecked by default = safer choice)', async () => {
    const onResult = vi.fn();
    render(<Asker onResult={onResult} option="Smazat i historii" />);
    fireEvent.click(screen.getByText('open'));
    await screen.findByTestId('confirm-dialog');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(onResult).toHaveBeenLastCalledWith(false));
    fireEvent.click(screen.getByText('open'));
    fireEvent.click(await screen.findByTestId('confirm-dialog-confirm'));
    await waitFor(() => expect(onResult).toHaveBeenLastCalledWith({ option: false }));
    fireEvent.click(screen.getByText('open'));
    fireEvent.click(await screen.findByTestId('confirm-dialog-option'));
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    await waitFor(() => expect(onResult).toHaveBeenLastCalledWith({ option: true }));
  });

  test('ModalShell traps Tab inside the dialog', async () => {
    function Host() { const [o, setO] = useState(true); return <ModalShell isOpen={o} onClose={() => setO(false)} title="T"><button>a</button><button>b</button></ModalShell>; }
    render(<Host />);
    const close = screen.getByLabelText('Zavřít');
    await waitFor(() => expect(document.activeElement).toBe(close));
    screen.getByText('b').focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(screen.getByText('b'));
  });

  test('CopyButton: confirms success, and says so honestly when the clipboard is refused', async () => {
    const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('denied'));
    Object.assign(navigator, { clipboard: { writeText } });
    (document as unknown as { execCommand: () => boolean }).execCommand = () => false;
    render(<CopyButton text="/task@bot Název" label="Kopírovat příkaz" testId="cp" />);
    await act(async () => { fireEvent.click(screen.getByTestId('cp')); });
    expect(writeText).toHaveBeenCalledWith('/task@bot Název');
    expect(screen.getByTestId('cp').textContent).toContain('Zkopírováno');
    await act(async () => { fireEvent.click(screen.getByTestId('cp')); });
    expect(screen.getByTestId('cp-failed').textContent).toContain('označte text ručně');
    expect(screen.getByTestId('cp').textContent).not.toContain('Zkopírováno');
  });

  test('StatusMessage: errors are alerts, the rest polite status', () => {
    render(<><StatusMessage kind="error" testId="e">Chyba</StatusMessage><StatusMessage kind="success" testId="s">Uloženo</StatusMessage></>);
    expect(screen.getByTestId('e').getAttribute('role')).toBe('alert');
    expect(screen.getByTestId('s').getAttribute('role')).toBe('status');
  });
});
