/**
 * Presence model (RUN 01). The channel itself lives in useRealtimeBoard (RUN 01B): presence and the server's
 * change signals share ONE private, keyed project channel per tab. Ephemeral: no database writes.
 */
export interface PresenceUser {
  userId: string;
  name: string;
  initials: string;
  color: string;
  /** Every tab of this user is in the background. */
  idle: boolean;
  /** Open tabs/sessions of this user on the project. */
  sessions: number;
}

export interface PresenceMeta {
  user_id: string;
  name: string;
  initials: string;
  color: string;
  idle: boolean;
}

export interface PresenceIdentity {
  userId: string;
  name: string;
  initials: string;
  color: string;
}

/** Folds Realtime presence state (key = user id, one meta per tab) into one entry per person. */
export function foldPresence(state: Record<string, PresenceMeta[]>, selfId?: string): PresenceUser[] {
  return Object.entries(state)
    .filter(([key, metas]) => key !== selfId && metas.length > 0)
    .map(([key, metas]) => ({
      userId: key,
      name: metas[0].name,
      initials: metas[0].initials,
      color: metas[0].color,
      idle: metas.every((m) => m.idle),
      sessions: metas.length,
    }))
    .sort((a, b) => Number(a.idle) - Number(b.idle) || a.name.localeCompare(b.name, 'cs-CZ'));
}
