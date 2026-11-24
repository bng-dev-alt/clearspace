import { describe, it, expect } from 'vitest';
import { detectConflicts, pickBase, isNewer, comparable } from '../../lib/collab/conflicts';
import { activeMentionQuery, collectMentions, splitMentions, type Mentionable } from '../../lib/collab/mentions';
import { describeActivity, formatRelativeTime } from '../../lib/collab/activityText';
import { describeNotification, notificationHref } from '../../lib/collab/notificationText';
import { foldPresence } from '../../hooks/usePresence';
import { mapActivityRow, mapNotificationRow } from '../../services/collaborationService';
import type { Card, ProjectActivityLog, AppNotification, TeamMember } from '../../types/kanban';

const member = (id: string): TeamMember => ({ id, fullName: id, initials: id[0], avatarColor: '#000', createdAt: '' });
const card = (over: Partial<Card> = {}): Card => ({ id: 'k1', title: 'A', details: 'd', version: 1, ...over });

describe('concurrent edit rules', () => {
  it('no conflict when the other person changed a different field', () => {
    const base = { title: 'A' };
    const mine = { title: 'Mine' };
    const theirs = card({ title: 'A', details: 'changed by them', version: 2 });
    expect(detectConflicts(base, mine, theirs)).toEqual([]);
  });

  it('conflict when both changed the same field differently', () => {
    expect(detectConflicts({ title: 'A' }, { title: 'Mine' }, card({ title: 'Theirs' }))).toEqual(['title']);
  });

  it('no conflict when both made the identical change', () => {
    expect(detectConflicts({ title: 'A' }, { title: 'Same' }, card({ title: 'Same' }))).toEqual([]);
  });

  it('assignees are compared as an ordered id list, fallback placeholders ignored', () => {
    const base = { assignees: [member('m1')] };
    expect(detectConflicts(base, { assignees: [member('m2')] }, card({ assignees: [member('m1'), member('member-fallback')] }))).toEqual([]);
    expect(detectConflicts(base, { assignees: [member('m2')] }, card({ assignees: [member('m3')] }))).toEqual(['assignees']);
    expect(comparable({ assignees: [member('a'), member('b')] }, 'assignees')).toBe('a,b');
  });

  it('empty and undefined values are equal (clearing a due date twice is not a conflict)', () => {
    expect(detectConflicts({ dueDate: '2026-12-01' }, { dueDate: undefined }, card({ dueDate: '' }))).toEqual([]);
  });

  it('pickBase only takes the edited fields', () => {
    expect(pickBase(card({ title: 'T', priority: 'High' }), { priority: 'Low' })).toEqual({ priority: 'High' });
  });

  it('isNewer rejects stale / out-of-order copies and accepts child revisions', () => {
    expect(isNewer({ version: 3, childRev: 0 }, { version: 2, childRev: 9 })).toBe(false);
    expect(isNewer({ version: 3, childRev: 1 }, { version: 3, childRev: 1 })).toBe(false); // duplicate
    expect(isNewer({ version: 3, childRev: 1 }, { version: 3, childRev: 2 })).toBe(true);
    expect(isNewer({ version: 3 }, { version: 4 })).toBe(true);
    expect(isNewer(undefined, { version: 1 })).toBe(true);
  });
});

describe('mentions', () => {
  const people: Mentionable[] = [
    { profileId: 'p-jan', name: 'Jan Novák', initials: 'JN', color: '#111' },
    { profileId: 'p-jana', name: 'Jana', initials: 'J', color: '#222' },
  ];

  it('detects the query being typed', () => {
    expect(activeMentionQuery('Ahoj @Ja', 8)).toBe('Ja');
    expect(activeMentionQuery('email@example.com', 17)).toBeNull();
    expect(activeMentionQuery('Ahoj @', 6)).toBe('');
    expect(activeMentionQuery('Ahoj', 4)).toBeNull();
  });

  it('collects whole-name mentions only, longest names first', () => {
    expect(collectMentions('Díky @Jan Novák a @Jana!', people).sort()).toEqual(['p-jan', 'p-jana']);
    expect(collectMentions('Jen @Janaa', people)).toEqual([]);
    expect(collectMentions('Bez zmínky', people)).toEqual([]);
  });

  it('splits text for highlighting without ever producing markup', () => {
    const parts = splitMentions('<img src=x onerror=alert(1)> @Jana ok', ['Jana']);
    expect(parts).toEqual([
      { text: '<img src=x onerror=alert(1)> ', mention: false },
      { text: '@Jana', mention: true },
      { text: ' ok', mention: false },
    ]);
    expect(splitMentions('nic', [])).toEqual([{ text: 'nic', mention: false }]);
  });
});

describe('activity text', () => {
  const log = (actionType: string, details: Record<string, unknown> = {}): ProjectActivityLog => ({
    id: 'e', projectId: 'p', actorName: 'Bob', actionType, entityType: 'task', details, createdAt: new Date().toISOString(),
  });

  it('describes completion, moves, assignments, deadlines and members', () => {
    expect(describeActivity(log('card_moved', { title: 'X', from: 'A', to: 'Hotovo', completed: true }))).toEqual({ text: 'dokončil(a) úkol „X"', kind: 'done' });
    expect(describeActivity(log('card_moved', { title: 'X', from: 'A', to: 'B' })).text).toBe('přesunul(a) úkol „X" z A do B');
    expect(describeActivity(log('card_assigned', { title: 'X', name: 'Cyril' })).text).toBe('přiřadil(a) úkol „X" uživateli Cyril');
    expect(describeActivity(log('card_due_changed', { title: 'X', to: null })).text).toBe('odebral(a) termín úkolu „X"');
    expect(describeActivity(log('member_role_changed', { name: 'Cyril', to: 'viewer' })).text).toBe('změnil(a) roli Cyril na čtenář');
    expect(describeActivity(log('comment_added', { title: 'X' })).kind).toBe('comment');
  });

  it('falls back for unknown (future integration) event types', () => {
    expect(describeActivity(log('drive_file_attached')).kind).toBe('other');
  });

  it('formats relative time', () => {
    const now = Date.parse('2026-11-24T12:00:00Z');
    expect(formatRelativeTime('2026-11-24T11:59:40Z', now)).toBe('právě teď');
    expect(formatRelativeTime('2026-11-24T11:30:00Z', now)).toBe('před 30 min');
  });
});

describe('notifications', () => {
  const n = (over: Partial<AppNotification>): AppNotification => ({
    id: 'n1', type: 'mention', actorName: 'Bob', title: 'Logo', createdAt: '', ...over,
  });

  it('texts', () => {
    expect(describeNotification(n({ type: 'mention' }))).toBe('Bob vás zmínil(a) v komentáři u úkolu „Logo"');
    expect(describeNotification(n({ type: 'assignment' }))).toBe('Bob vám přiřadil(a) úkol „Logo"');
  });

  it('links lead only to entities the recipient may still open', () => {
    expect(notificationHref(n({ projectId: 'p 1', cardId: 'k/1' }))).toBe('/projects/p%201?task=k%2F1');
    expect(notificationHref(n({ projectId: 'p1', type: 'project_removed' }))).toBeNull();
    expect(notificationHref(n({ projectId: 'p1', type: 'invitation' }))).toBeNull();
    expect(notificationHref(n({ projectId: undefined }))).toBeNull();
  });
});

describe('presence', () => {
  it('one entry per person across tabs, self excluded, idle only when every tab is idle', () => {
    const meta = (user_id: string, idle: boolean) => ({ user_id, name: user_id, initials: user_id[0], color: '#000', idle });
    const users = foldPresence({ a: [meta('a', false)], b: [meta('b', true), meta('b', false)], c: [meta('c', true)], d: [] }, 'a');
    expect(users.map((u) => [u.userId, u.idle, u.sessions])).toEqual([['b', false, 2], ['c', true, 1]]);
  });
});

describe('row mapping', () => {
  it('maps event and notification rows', () => {
    expect(mapActivityRow({ id: 'e', project_id: 'p', card_id: null, actor_id: null, actor_name: 'Systém', action_type: 'x', entity_type: 'task', entity_id: 'k', source: 'app', details: null, created_at: 't' }))
      .toMatchObject({ cardId: undefined, entityId: 'k', source: 'app' });
    expect(mapNotificationRow({ id: 'n', type: 'assignment', project_id: 'p', card_id: 'k', entity_id: 'k', actor_name: 'A', title: 'T', read_at: null, created_at: 't' }))
      .toMatchObject({ readAt: undefined, cardId: 'k' });
  });
});
