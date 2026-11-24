/**
 * @mentions (RUN 01). A mention is typed as "@Full Name"; the comment stores the mentioned
 * profile ids separately (the database keeps only ids of project members). Pure helpers, tested.
 */
export interface Mentionable {
  profileId: string;
  name: string;
  initials: string;
  color: string;
}

/** The "@query" being typed right before the caret, or null when the caret is not in a mention. */
export function activeMentionQuery(text: string, caret: number): string | null {
  const before = text.slice(0, Math.max(0, caret));
  const m = /(^|\s)@([^\s@]{0,30})$/u.exec(before);
  return m ? m[2] : null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Profile ids whose "@Name" still appears in the text (whole-name match, longest names first). */
export function collectMentions(text: string, people: Mentionable[]): string[] {
  const ids: string[] = [];
  let rest = text;
  for (const p of [...people].sort((a, b) => b.name.length - a.name.length)) {
    const re = new RegExp(`@${escapeRegExp(p.name)}(?![\\p{L}\\p{N}_])`, 'u');
    if (re.test(rest)) {
      ids.push(p.profileId);
      rest = rest.replace(new RegExp(re.source, 'gu'), ' ');
    }
  }
  return ids;
}

/** Splits text into plain and "@Name" parts for highlighting (rendered as text, never HTML). */
export function splitMentions(text: string, names: string[]): { text: string; mention: boolean }[] {
  const valid = [...new Set(names.filter(Boolean))].sort((a, b) => b.length - a.length);
  if (valid.length === 0) return [{ text, mention: false }];
  const re = new RegExp(`@(?:${valid.map(escapeRegExp).join('|')})(?![\\p{L}\\p{N}_])`, 'gu');
  const parts: { text: string; mention: boolean }[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) parts.push({ text: text.slice(last, m.index), mention: false });
    parts.push({ text: m[0], mention: true });
    last = m.index! + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), mention: false });
  return parts;
}
