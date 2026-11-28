import React from 'react';

/**
 * One inline status pattern for results of user actions (saved, connected, failed) – RUN 11, replaces window.alert and the
 * per-module message styles. Errors are announced immediately (role=alert), everything else politely (role=status).
 */
export default function StatusMessage({ kind = 'info', children, testId, onDismiss }: {
  kind?: 'info' | 'success' | 'error' | 'warning'; children: React.ReactNode; testId?: string; onDismiss?: () => void;
}) {
  return (
    <div className={`cs-status cs-status--${kind}`} role={kind === 'error' ? 'alert' : 'status'} data-testid={testId}>
      <span>{children}</span>
      {onDismiss && <button type="button" className="cs-status-dismiss" onClick={onDismiss} aria-label="Zavřít hlášení">×</button>}
    </div>
  );
}
