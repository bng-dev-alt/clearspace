/**
 * Volitelný designový styl "Monograph" (opt-in, nikdy výchozí).
 *
 * Mechanismus: <html data-style="monograph"> vedle stávajícího data-theme (light/dark). Celé stylování žije v
 * app/monograph.css pod tímto atributem; bez něj je soubor inertní. Přepínač stylu se zobrazí a uložená volba se
 * respektuje JEN když je při buildu nastaveno NEXT_PUBLIC_ENABLE_MONOGRAPH=1 (bez příznaku = vzhled beze změny).
 */
export type DesignStyle = 'existing' | 'monograph';

export const STYLE_STORAGE_KEY = 'clearspace-style';

/** Inlinuje se při buildu (literální přístup k process.env.NEXT_PUBLIC_*). */
export const MONOGRAPH_ENABLED = process.env.NEXT_PUBLIC_ENABLE_MONOGRAPH === '1';

/** Uložená hodnota -> efektivní styl. Cokoliv jiného než 'monograph' (a vypnutý příznak) = stávající vzhled. */
export function resolveDesignStyle(stored: string | null | undefined, enabled: boolean = MONOGRAPH_ENABLED): DesignStyle {
  return enabled && stored === 'monograph' ? 'monograph' : 'existing';
}
