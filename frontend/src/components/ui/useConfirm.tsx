'use client';

import React, { useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ModalShell from './ModalShell';
import Button from './Button';

export interface ConfirmOptions {
  title: string;
  /** What will happen, in the user's words (consequences, what stays). */
  message: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** Destructive action: danger button. */
  danger?: boolean;
  /** Optional extra choice inside the same dialog (e.g. "also remove attached e-mails"); unchecked by default = the safer choice. */
  option?: string;
}
export type ConfirmResult = false | { option: boolean };

/**
 * One confirmation pattern for the whole app (RUN 11, replaces window.confirm): the dialog is rendered by the component that asks,
 * so it works without a global provider (and in isolated unit tests).
 *   const [ask, confirmDialog] = useConfirm();
 *   const r = await ask({ title, message, confirmLabel, danger: true }); if (!r) return;
 *   ... render {confirmDialog} anywhere in the component.
 */
export function useConfirm(): [(o: ConfirmOptions) => Promise<ConfirmResult>, React.ReactNode] {
  const [open, setOpen] = useState<ConfirmOptions | null>(null);
  const [option, setOption] = useState(false);
  const resolver = useRef<((r: ConfirmResult) => void) | null>(null);

  const ask = useCallback((o: ConfirmOptions) => new Promise<ConfirmResult>((resolve) => {
    resolver.current?.(false);
    resolver.current = resolve;
    setOption(false);
    setOpen(o);
  }), []);

  const finish = useCallback((r: ConfirmResult) => {
    resolver.current?.(r);
    resolver.current = null;
    setOpen(null);
  }, []);

  // React bubbles portal events to the asking component's ancestors (e.g. an overlay that closes on click): stop them here
  const dialog = open ? (
    <div onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
    <ModalShell isOpen onClose={() => finish(false)} title={open.title} maxWidth={480} testId="confirm-dialog" role="alertdialog">
      <div className="cs-confirm-message" data-testid="confirm-dialog-message">{open.message}</div>
      {open.option && (
        <label className="cs-confirm-option">
          <input type="checkbox" checked={option} onChange={(e) => setOption(e.target.checked)} data-testid="confirm-dialog-option" />
          <span>{open.option}</span>
        </label>
      )}
      <div className="cs-confirm-actions">
        {/* destructive: focus starts on the safe choice (WAI-ARIA alertdialog) */}
        <Button variant="ghost" onClick={() => finish(false)} data-testid="confirm-dialog-cancel" data-autofocus={open.danger ? true : undefined}>{open.cancelLabel ?? 'Zrušit'}</Button>
        <Button variant={open.danger ? 'danger' : 'primary'} onClick={() => finish({ option })} data-testid="confirm-dialog-confirm" data-autofocus={open.danger ? undefined : true}>
          {open.confirmLabel}
        </Button>
      </div>
    </ModalShell>
    </div>
  ) : null;

  // portal: never clipped by (or stacked under) the dialog that asks; it is also the last modal in the DOM = the one keys go to
  return [ask, dialog && typeof document !== 'undefined' ? createPortal(dialog, document.body) : dialog];
}
