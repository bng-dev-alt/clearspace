import { fold } from './fold';

/**
 * České křestní jméno a jeho běžné domácké tvary (Honza = Jan, Kuba = Jakub). Používá validátor vlastníka
 * i návrh řešitele: "Honza" v poznámce a člen "Jan Novák" jsou ten samý člověk. Jen tvary bez diakritiky (fold).
 * Je to záměrně krátká, ručně udržovaná tabulka; nejednoznačné shody se stejně vyhodnotí jako "žádný návrh".
 */
const GROUPS: string[][] = [
  ['jan', 'honza', 'honzik', 'jenda', 'johnny'],
  ['jakub', 'kuba', 'kubik'],
  ['josef', 'pepa', 'jozef', 'pepik'],
  ['vaclav', 'vasek'],
  ['tomas', 'tom', 'tomik'],
  ['frantisek', 'franta', 'frantik'],
  ['miroslav', 'mirek', 'mira'],
  ['jaroslav', 'jara'],
  ['ladislav', 'lada'],
  ['stanislav', 'standa'],
  ['zdenek', 'zdenda'],
  ['antonin', 'tonda', 'tonik'],
  ['ondrej', 'ondra'],
  ['lukas', 'luky'],
  ['pavel', 'pavlik'],
  ['vladimir', 'vlada'],
  ['michal', 'misa'],
  ['katerina', 'kata', 'katka', 'katy'],
  ['barbora', 'bara', 'barca', 'barunka'],
  ['eliska', 'ela'],
  ['alexandra', 'alexa'],
  ['marie', 'maruska'],
  ['jana', 'janka'],
  ['lenka', 'lenny'],
  ['alena', 'alenka'],
  ['petra', 'petrka'],
  ['alexander', 'alex'],
];

const INDEX = new Map<string, Set<string>>();
for (const g of GROUPS) {
  for (const n of g) {
    const set = INDEX.get(n) ?? new Set<string>();
    for (const m of g) set.add(m);
    INDEX.set(n, set);
  }
}

/** Složený token + jeho známé domácké/oficiální varianty (vždy obsahuje i sám token). */
export function nameVariants(token: string): string[] {
  const t = fold(token);
  return [...(INDEX.get(t) ?? [t])];
}

/** Mají dvě jména (po složení) společnou variantu? */
export function sameGivenName(a: string, b: string): boolean {
  const va = new Set(nameVariants(a));
  return nameVariants(b).some((x) => va.has(x));
}

/**
 * Domácký/oficiální tvar jména (Honza ↔ Jan) musí sedět PŘESNĚ: žádná předponová tolerance, jinak by se "Jan"
 * (z aliasu Honza) shodoval s "Jana". Skloňování původního tokenu řeší tokenInWords.
 */
export function aliasInWords(token: string, words: string[]): boolean {
  const t = fold(token);
  return nameVariants(t).some((v) => v !== t && words.includes(v));
}
