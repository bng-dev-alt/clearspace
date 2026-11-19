/**
 * Jediné místo, které převádí odpověď AI gateway na chybu pro uživatele (R6: konzistentní chyby).
 * Používají ho meetingService, intelligenceService i aiClient. Čisté funkce bez závislostí, bezpečné v prohlížeči.
 * Kódy odpovídají AiErrorCode (src/lib/ai/errors.ts) + `ai_disabled` (produkční firewall) a `network`.
 */
export interface ParsedAiError {
  code: string;
  message: string;
}

export const AI_ERROR_MESSAGES: Record<string, string> = {
  bad_request: 'Požadavek není platný.',
  not_found: 'Požadovaná položka nebyla nalezena.',
  conflict: 'Výsledek už existuje.',
  unauthenticated: 'Přihlášení vypršelo nebo je neplatné. Přihlaste se prosím znovu.',
  forbidden: 'K tomuto projektu nemáte přístup.',
  ai_owner_only: 'AI funkce jsou zatím dostupné jen vlastníkovi instalace.',
  payload_too_large: 'Požadavek je příliš velký.',
  unsupported_media_type: 'Nepodporovaný typ požadavku.',
  rate_limited: 'Příliš mnoho AI požadavků. Zkuste to prosím za minutu.',
  budget_exceeded: 'Byl vyčerpán denní rozpočet AI. Zkuste to prosím zítra.',
  ai_unavailable: 'AI služba je dočasně nedostupná.',
  ai_demo_disabled: 'AI funkce vyžadují přihlášení přes Supabase a v demo režimu nejsou dostupné.',
  ai_timeout: 'AI neodpověděla včas. Zkuste to prosím znovu.',
  ai_overloaded: 'AI služba je teď vytížená. Zkuste to prosím za chvíli.',
  ai_failed: 'Služba AI selhala. Zkuste to prosím znovu.',
  bad_model_output: 'AI vrátila neplatný formát dat. Zkuste to prosím znovu.',
  stt_disabled: 'Přepis zvuku je v této instalaci zatím vypnutý.',
  consent_required: 'Bez souhlasu účastníků se zvuk nezpracovává.',
  stt_no_audio: 'K poradě není nahraný žádný zvuk.',
  stt_attempts_exhausted: 'Byl vyčerpán počet pokusů o přepis. Nahrajte zvuk znovu.',
  stt_invalid_audio: 'Soubor není platný zvukový záznam.',
  stt_unavailable: 'Služba přepisu je dočasně nedostupná. Zkuste to prosím později.',
  stt_failed: 'Přepis se nezdařil. Zkuste to prosím znovu.',
  ai_disabled: 'AI funkce jsou v této instalaci zatím vypnuté.',
  network: 'Nepodařilo se spojit se serverem.',
  unknown: 'Operace se nezdařila. Zkuste to prosím znovu.',
};

export const AI_NETWORK_ERROR: ParsedAiError = { code: 'network', message: AI_ERROR_MESSAGES.network };

/**
 * `body` je JSON odpovědi (nebo null, když nebyl čitelný). Odpověď 403 BEZ našeho `code` pochází z firewallu
 * (pravidlo "deny /api/ai"), ne z gateway: znamená "AI je vypnutá na úrovni infrastruktury".
 */
export function parseAiHttpError(status: number, body: unknown, fallbackMessage?: string): ParsedAiError {
  const b = typeof body === 'object' && body !== null ? (body as { code?: unknown; error?: unknown }) : {};
  const code = typeof b.code === 'string' ? b.code : undefined;
  if (status === 403 && !code) return { code: 'ai_disabled', message: AI_ERROR_MESSAGES.ai_disabled };
  const serverMessage = typeof b.error === 'string' && b.error.trim() ? b.error : undefined;
  if (code) return { code, message: serverMessage ?? AI_ERROR_MESSAGES[code] ?? fallbackMessage ?? AI_ERROR_MESSAGES.unknown };
  return { code: 'unknown', message: serverMessage ?? fallbackMessage ?? AI_ERROR_MESSAGES.unknown };
}

/** Chyby, u kterých má smysl nabídnout "Zkusit znovu" (přechodné). */
export function isRetryableAiError(code: string): boolean {
  return ['network', 'ai_timeout', 'ai_overloaded', 'ai_unavailable', 'ai_failed', 'rate_limited', 'stt_unavailable', 'stt_failed'].includes(code);
}
