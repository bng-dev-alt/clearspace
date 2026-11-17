import { Column } from '../../types/kanban';
import { INITIAL_COLUMNS } from '../../data/dummyData';

/**
 * Seed (výchozí) board -- jediné místo, které z `INITIAL_COLUMNS` vyrábí
 * sloupce a karty konkrétního projektu.
 *
 * ID musí být jedinečné napříč VŠEMI projekty a uživateli: `columns.id`
 * a `cards.id` jsou primární klíče celé tabulky (textové, od klienta).
 * Dřív dostával výchozí projekt holé 'column-1' / 'card-1'. V demu
 * (localStorage per prohlížeč) to nevadilo, ale ve sdílené databázi by druhý
 * registrovaný uživatel narazil na kolizi klíčů a jeho board by se nenaseedoval.
 *
 * Kód, který sloupce hledá podle koncovky (`endsWith('column-3')`), dál
 * funguje -- prefix se přidává zleva.
 *
 * Používá se pro seedování v DATABÁZI. Demo režim (localStorage, board je
 * klíčovaný projektem v prohlížeči) žádné globální klíče nemá a drží si
 * původní holá ID -- na těch stojí e2e testy (`column-count-column-1`).
 */
export const scopedSeedId = (projectId: string, baseId: string): string =>
  `${projectId}-${baseId}`;

export function buildSeedBoard(projectId: string, withCards: boolean): Column[] {
  return INITIAL_COLUMNS.map((col) => ({
    id: scopedSeedId(projectId, col.id),
    name: col.name,
    cards: withCards
      ? col.cards.map((card) => ({ ...card, id: scopedSeedId(projectId, card.id) }))
      : [],
  }));
}
