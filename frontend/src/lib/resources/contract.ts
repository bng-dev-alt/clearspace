import type { ResourceContent as DriveContent } from '../google/drive';
import type { GmailContent } from '../google/gmail';

/**
 * RUN 03 -- Project Intelligence foundation: ONE normalized shape for explicitly linked external resources (Drive files,
 * Gmail messages / threads; later meeting transcripts, notes). Server side only. Nothing here calls an AI provider.
 *
 * Boundaries (docs/run03/ARCHITECTURE_DECISION.md §6):
 *  - Only a resource someone EXPLICITLY linked, read with the REQUESTING user's own Google token (Drive: their access;
 *    Gmail: only the person who linked it, from their own mailbox).
 *  - Content is UNTRUSTED data (prompt-injection), never instructions; it is quoted with provenance, never merged into prompts.
 *  - Linking is NOT consent to AI processing. `aiUse` is 'not_consented' for every document this code builds; a future
 *    "Analyzovat obsah" action must obtain an explicit per-use consent, re-check Google's Limited Use rules (no transfer
 *    to train generalized models) and go through the existing AI gateway (owner policy, quota, rate limits).
 */
export type ResourceProvider = 'google_drive' | 'gmail_message' | 'gmail_thread';

export interface ResourceSegment {
  /** Stable citation anchor: `<provider>:<linkId>#<n>` (n = 1-based message / section). */
  ref: string;
  author?: string;
  date?: string | null;
  text: string;
}

export interface ResourceDocument {
  source: { provider: ResourceProvider; linkId: string; retrievedAt: string; retrievedFor: 'requesting_user' };
  title: string;
  segments: ResourceSegment[];
  truncated: boolean;
  trust: 'untrusted';
  aiUse: 'not_consented';
}

const ref = (provider: ResourceProvider, linkId: string, n: number) => `${provider}:${linkId}#${n}`;

export function fromDrive(linkId: string, c: DriveContent): ResourceDocument {
  return {
    source: { provider: 'google_drive', linkId, retrievedAt: c.retrievedAt, retrievedFor: 'requesting_user' },
    title: c.name,
    segments: [{ ref: ref('google_drive', linkId, 1), date: c.modifiedAt, text: c.text }],
    truncated: c.truncated,
    trust: 'untrusted',
    aiUse: 'not_consented',
  };
}

/** Gmail: sender DISPLAY NAME only (addresses stay out of anything that could later be shared). */
export function fromGmail(linkId: string, c: GmailContent): ResourceDocument {
  return {
    source: { provider: c.provider, linkId, retrievedAt: c.retrievedAt, retrievedFor: 'requesting_user' },
    title: c.subject,
    segments: c.messages.map((m, i) => ({ ref: ref(c.provider, linkId, c.omittedMessages + i + 1), author: m.from.name || undefined, date: m.date, text: m.text })),
    truncated: c.omittedMessages > 0 || c.messages.some((m) => m.truncated),
    trust: 'untrusted',
    aiUse: 'not_consented',
  };
}

/** The consent boundary, enforced in code: today nothing may pass a linked resource to an AI provider. */
export function assertAiUseAllowed(doc: ResourceDocument): never {
  throw new Error(`AI processing of ${doc.source.provider} content is not consented (explicit per-use consent required; see RUN 03 ADR §6)`);
}
