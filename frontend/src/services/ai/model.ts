/**
 * Jediná definice výchozího modelu. Produkce nastavuje GEMINI_MODEL (ověřený `gemini-3.6-flash`);
 * `gemini-3.5-flash` neexistuje, proto se na něj nikde neodkazuje.
 */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.6-flash';

export function serverModel(): string {
  return process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
}
