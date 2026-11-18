/**
 * FOLD_SPEC (Universal Meeting Core, PHASE2_CONTRACT_DESIGN.md): NFD, odstranění kombinujících značek,
 * lowercase, každý souvislý úsek ne-písmen/ne-číslic = jedna mezera, trim.
 * Používá se pro porovnání citací, jmen a termínů (nezávisle na diakritice, velikosti písmen a interpunkci).
 */
export function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Počet písmen (ne číslic) ve složeném řetězci -- citace musí mít aspoň 6, aby šlo o důkaz. */
export function letterCount(s: string): number {
  const m = fold(s).match(/\p{L}/gu);
  return m ? m.length : 0;
}

/** Slova složeného textu. */
export function foldedWords(s: string): string[] {
  const f = fold(s);
  return f ? f.split(' ') : [];
}
