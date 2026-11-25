/**
 * Designový styl "Monograph": VÝCHOZÍ pro každého, kdo si výslovně nezvolil "Stávající" (Classic).
 *
 * Mechanismus: <html data-style="monograph"> vedle stávajícího data-theme (light/dark). Celé stylování žije v
 * app/monograph.css pod tímto atributem; bez něj je soubor inertní. Monograph je zapnutý v každém buildu; vypne ho jen
 * NEXT_PUBLIC_ENABLE_MONOGRAPH=0 (pak vždy Classic, bez přepínače). Dřív byl opt-in přes =1 a build bez příznaku Monograph ztratil.
 * Světlý/tmavý/systém je nezávislý (data-theme, vlastní klíč v úložišti).
 */
export type DesignStyle = 'existing' | 'monograph';

export const STYLE_STORAGE_KEY = 'clearspace-style';

/** Inlinuje se při buildu (literální přístup k process.env.NEXT_PUBLIC_*). Výchozí ZAPNUTO; jen '0' vypíná. */
export const MONOGRAPH_ENABLED = process.env.NEXT_PUBLIC_ENABLE_MONOGRAPH !== '0';

/**
 * Uložená hodnota -> efektivní styl. Příznak vypnutý = vždy stávající vzhled. Příznak zapnutý = Monograph, pokud uživatel výslovně
 * nezvolil 'existing' (výběr se ukládá doslova, takže uložená volba Classic se vždy respektuje; nový uživatel = Monograph).
 */
export function resolveDesignStyle(stored: string | null | undefined, enabled: boolean = MONOGRAPH_ENABLED): DesignStyle {
  return enabled && stored !== 'existing' ? 'monograph' : 'existing';
}
