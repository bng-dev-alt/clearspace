/** Czech count agreement: 1 návrh · 2–4 návrhy · 0, 5+ návrhů. (Shared since RUN 11; was private in projectIntelligence.ts.) */
export function plural(n: number, one: string, few: string, many: string): string {
  if (n === 1) return one;
  if (n >= 2 && n <= 4) return few;
  return many;
}
