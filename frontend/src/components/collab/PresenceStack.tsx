'use client';

import React from 'react';
import { readableOn } from '../../lib/color';
import type { PresenceUser } from '../../hooks/usePresence';
import type { SyncStatus } from '../../hooks/useRealtimeBoard';

/**
 * Who else is on this project right now + the realtime connection state (RUN 01).
 * Uses the toolbar's existing avatar recipe; nothing renders when there is nothing to say.
 */
export function PresenceStack({ users }: { users: PresenceUser[] }) {
  if (users.length === 0) return null;
  const shown = users.slice(0, 4);
  const names = users.map((u) => `${u.name}${u.idle ? ' (neaktivní)' : ''}`).join(', ');
  return (
    <div
      className="toolbar-presence"
      style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}
      aria-label={`Právě v projektu: ${names}`}
      title={`Právě v projektu: ${names}`}
      data-testid="presence-stack"
    >
      <div style={{ display: 'flex', alignItems: 'center' }}>
        {shown.map((u, index) => (
          <span
            key={u.userId}
            style={{
              position: 'relative',
              width: '24px',
              height: '24px',
              borderRadius: '50%',
              backgroundColor: u.color,
              color: readableOn(u.color),
              fontSize: '0.65rem',
              fontWeight: 700,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: '1.5px solid var(--bg-page)',
              marginLeft: index > 0 ? '-6px' : '0px',
              zIndex: 5 - index,
              opacity: u.idle ? 0.55 : 1,
            }}
            data-testid={`presence-user-${u.userId}`}
            data-idle={u.idle ? 'true' : 'false'}
            data-sessions={u.sessions}
          >
            {u.initials}
            <span
              aria-hidden
              style={{
                position: 'absolute',
                right: '-1px',
                bottom: '-1px',
                width: '7px',
                height: '7px',
                borderRadius: '50%',
                backgroundColor: u.idle ? 'var(--gray-text)' : 'var(--success, #2e9e6b)',
                border: '1.5px solid var(--bg-page)',
              }}
            />
          </span>
        ))}
        {users.length > shown.length && (
          <span style={{ marginLeft: '0.3rem', fontSize: '0.7rem', color: 'var(--gray-text)', fontWeight: 600 }}>
            +{users.length - shown.length}
          </span>
        )}
      </div>
      <span style={{ fontSize: '0.72rem', color: 'var(--gray-text)', fontWeight: 600 }}>
        také zde
      </span>
    </div>
  );
}

const STATUS_TEXT: Partial<Record<SyncStatus, string>> = {
  connecting: 'Připojování…',
  reconnecting: 'Spojení přerušeno, obnovuji…',
};

export function SyncIndicator({ status }: { status: SyncStatus }) {
  const text = STATUS_TEXT[status];
  if (!text) return null;
  return (
    <span
      role="status"
      aria-live="polite"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.35rem',
        fontSize: '0.72rem',
        fontWeight: 600,
        color: status === 'reconnecting' ? 'var(--warning, var(--danger))' : 'var(--gray-text)',
      }}
      data-testid="sync-indicator"
      data-status={status}
    >
      <span aria-hidden style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: 'currentColor' }} />
      {text}
    </span>
  );
}
