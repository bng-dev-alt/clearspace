'use client';

import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Comment } from '../../types/kanban';
import { formatRelativeTime } from '../../lib/collab/activityText';
import { activeMentionQuery, collectMentions, splitMentions, type Mentionable } from '../../lib/collab/mentions';
import { kanbanService } from '../../services/kanbanService';

interface TaskCommentsProps {
  comments: Comment[];
  /** Project members with an account (the only people who can be mentioned). */
  mentionables: Mentionable[];
  currentUserId?: string;
  /** Owner/admin may delete anybody's comment. */
  canModerate: boolean;
  readOnly: boolean;
  onAdd: (content: string, mentions: string[]) => void;
  onEdit?: (commentId: string, content: string, mentions: string[]) => Promise<boolean>;
  onDelete?: (commentId: string) => Promise<boolean>;
}

/** Text area with @mention suggestions limited to the project's members. */
function MentionComposer({
  value, onChange, mentionables, placeholder, testId, onSubmit, autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  mentionables: Mentionable[];
  placeholder: string;
  testId: string;
  onSubmit: () => void;
  autoFocus?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  // Caret position to restore right after the value we just set is rendered (synchronously, before
  // the next keystroke can land -- a deferred restore would move the caret back mid-typing).
  const pendingCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (pendingCaret.current === null || !ref.current) return;
    const pos = pendingCaret.current;
    pendingCaret.current = null;
    ref.current.focus();
    ref.current.setSelectionRange(pos, pos);
  }, [value]);
  const [active, setActive] = useState(0);
  const query = activeMentionQuery(value, caret);
  const suggestions = useMemo(() => {
    if (query === null) return [];
    const q = query.toLocaleLowerCase('cs-CZ');
    return mentionables.filter((m) => m.name.toLocaleLowerCase('cs-CZ').includes(q)).slice(0, 6);
  }, [query, mentionables]);

  const pick = (m: Mentionable) => {
    const before = value.slice(0, caret).replace(/@[^\s@]*$/u, `@${m.name} `);
    pendingCaret.current = before.length;
    setCaret(before.length);
    onChange(before + value.slice(caret));
  };

  return (
    <div style={{ position: 'relative', flex: 1 }}>
      <textarea
        ref={ref}
        className="comment-textarea"
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        maxLength={5000}
        onChange={(e) => { onChange(e.target.value); setCaret(e.target.selectionStart ?? e.target.value.length); setActive(0); }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
        onKeyDown={(e) => {
          if (suggestions.length > 0) {
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (i + 1) % suggestions.length); return; }
            if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (i - 1 + suggestions.length) % suggestions.length); return; }
            if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(suggestions[active]); return; }
          }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onSubmit(); }
        }}
        aria-autocomplete="list"
        aria-controls={suggestions.length > 0 ? `${testId}-mentions` : undefined}
        data-testid={testId}
      />
      {suggestions.length > 0 && (
        <ul className="mention-suggestions" id={`${testId}-mentions`} role="listbox" data-testid="mention-suggestions">
          {suggestions.map((m, i) => (
            <li key={m.profileId}>
              <button
                type="button"
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => { e.preventDefault(); pick(m); }}
                data-testid={`mention-option-${m.profileId}`}
              >
                <span aria-hidden style={{ width: 18, height: 18, borderRadius: '50%', background: m.color, color: '#fff', fontSize: '0.55rem', fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{m.initials}</span>
                {m.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Comment text with @mentions highlighted. Plain React text only -- never HTML (XSS-safe). */
function CommentBody({ content, names }: { content: string; names: string[] }) {
  return (
    <p className="comment-content" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
      {splitMentions(content, names).map((part, i) =>
        part.mention ? <span key={i} className="comment-mention">{part.text}</span> : <React.Fragment key={i}>{part.text}</React.Fragment>
      )}
    </p>
  );
}

export default function TaskComments({
  comments, mentionables, currentUserId, canModerate, readOnly, onAdd, onEdit, onDelete,
}: TaskCommentsProps) {
  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [revisions, setRevisions] = useState<{ id: string; rows: { content: string; editedAt: string }[] } | null>(null);
  const showRevisions = async (id: string) => {
    if (revisions?.id === id) { setRevisions(null); return; }
    setRevisions({ id, rows: await kanbanService.fetchCommentRevisions(id) });
  };
  const nameById = useMemo(() => new Map(mentionables.map((m) => [m.profileId, m.name])), [mentionables]);

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    onAdd(text, collectMentions(text, mentionables));
    setDraft('');
  };

  const saveEdit = async (id: string) => {
    const text = editDraft.trim();
    if (!text || !onEdit) return;
    setError(null);
    const ok = await onEdit(id, text, collectMentions(text, mentionables));
    if (ok) setEditingId(null);
    else setError('Komentář se nepodařilo upravit.');
  };

  return (
    <>
      {error && <p role="alert" style={{ fontSize: '0.75rem', color: 'var(--danger)', margin: '0 0 0.5rem' }}>{error}</p>}
      <div className="drawer-comments-list" data-testid="comments-list">
        {comments.length === 0 ? (
          <p style={{ fontSize: '0.75rem', color: 'var(--gray-text)', fontStyle: 'italic', padding: '0.5rem 0' }}>
            Zatím žádné komentáře. Napište první!
          </p>
        ) : (
          comments.map((c) => {
            const mine = Boolean(currentUserId && c.authorId === currentUserId);
            const names = (c.mentions ?? []).map((id) => nameById.get(id)).filter((n): n is string => Boolean(n));
            return (
              <div key={c.id} className="comment-item" data-testid={`comment-item-${c.id}`}>
                <div className="comment-meta" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span className="comment-author">{c.authorName}</span>
                  <time className="comment-date" dateTime={c.createdAt} title={new Date(c.createdAt).toLocaleString('cs-CZ')}>
                    {formatRelativeTime(c.createdAt)}
                  </time>
                  {c.origin && c.origin !== 'app' && (
                    <span className="comment-edited" title="Autor ani čas nebyly ověřeny aplikací (obnova ze zálohy, import nebo starší data)." data-testid={`comment-origin-${c.id}`}>
                      {c.origin === 'import' ? '(importováno)' : '(starší záznam)'}
                    </span>
                  )}
                  {c.updatedAt && (
                    <button type="button" className="comment-edited" style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', textDecoration: 'underline dotted' }}
                      onClick={() => void showRevisions(c.id)} data-testid={`comment-edited-${c.id}`} title="Zobrazit předchozí znění">
                      (upraveno)
                    </button>
                  )}
                  {!readOnly && (mine || canModerate) && editingId !== c.id && (
                    <span className="comment-actions">
                      {mine && onEdit && (c.origin ?? 'app') === 'app' && (
                        <button type="button" onClick={() => { setEditingId(c.id); setEditDraft(c.content); }} data-testid={`comment-edit-${c.id}`}>Upravit</button>
                      )}
                      {onDelete && (
                        <button
                          type="button"
                          onClick={async () => {
                            if (!confirm('Smazat komentář?')) return;
                            if (!(await onDelete(c.id))) setError('Komentář se nepodařilo smazat.');
                          }}
                          data-testid={`comment-delete-${c.id}`}
                        >
                          Smazat
                        </button>
                      )}
                    </span>
                  )}
                </div>
                {revisions?.id === c.id && (
                  <div style={{ fontSize: '0.72rem', color: 'var(--gray-text)', borderLeft: '2px solid var(--border)', paddingLeft: '0.5rem', margin: '0.25rem 0' }} data-testid={`comment-revisions-${c.id}`}>
                    {revisions.rows.length === 0 ? 'Předchozí znění není k dispozici.' : revisions.rows.map((r, i) => (
                      <p key={i} style={{ margin: '0.15rem 0', whiteSpace: 'pre-wrap' }}>
                        <time dateTime={r.editedAt}>{new Date(r.editedAt).toLocaleString('cs-CZ')}</time>: {r.content}
                      </p>
                    ))}
                  </div>
                )}
                {editingId === c.id ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                    <MentionComposer value={editDraft} onChange={setEditDraft} mentionables={mentionables} placeholder="Upravit komentář…" testId={`comment-edit-input-${c.id}`} onSubmit={() => void saveEdit(c.id)} autoFocus />
                    <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
                      <button type="button" className="cs-btn cs-btn--ghost cs-btn--sm" onClick={() => setEditingId(null)}>Zrušit</button>
                      <button type="button" className="cs-btn cs-btn--primary cs-btn--sm" disabled={!editDraft.trim()} onClick={() => void saveEdit(c.id)} data-testid={`comment-edit-save-${c.id}`}>Uložit</button>
                    </div>
                  </div>
                ) : (
                  <CommentBody content={c.content} names={names} />
                )}
              </div>
            );
          })
        )}
      </div>

      {readOnly ? (
        <p style={{ fontSize: '0.75rem', color: 'var(--gray-text)' }} data-testid="comments-readonly">Máte roli Čtenář -- komentovat nemůžete.</p>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="comment-input-container">
          <MentionComposer
            value={draft}
            onChange={setDraft}
            mentionables={mentionables}
            placeholder={mentionables.length > 0 ? 'Napište komentář… (@ zmíní kolegu)' : 'Napište komentář…'}
            testId="comment-add-input"
            onSubmit={submit}
          />
          <button
            type="submit"
            disabled={!draft.trim()}
            style={{
              alignSelf: 'flex-end',
              padding: '0.4rem 0.85rem',
              backgroundColor: draft.trim() ? 'var(--purple-secondary)' : 'var(--bg-column)',
              color: draft.trim() ? '#ffffff' : 'var(--gray-text)',
              border: '1px solid var(--border-color)',
              borderRadius: '6px',
              fontSize: '0.8rem',
              fontWeight: 700,
              cursor: draft.trim() ? 'pointer' : 'not-allowed',
              transition: 'var(--spring-transition)',
            }}
            className="comment-add-submit"
            data-testid="comment-add-submit"
          >
            Odeslat
          </button>
        </form>
      )}
    </>
  );
}
