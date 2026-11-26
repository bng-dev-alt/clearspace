# RUN 07 – návrh UI a obsahu

## Projekt → Integrace (modal z lišty projektu, tlačítko „Integrace“)
* Správce (owner/admin): seznam cílů (ikona Slack/Telegram, název kanálu/skupiny, stav, schopnosti), „Připojit Slack kanál“, „Připojit Telegram skupinu“,
  u čekajících „Potvrdit“/„Zamítnout“, přepínače **Oznámení** / **Interaktivní akce** / **Project Intelligence** (s potvrzovacím dialogem a popisem rozsahu),
  typy událostí, „Zkušební zpráva“, „Odpojit“ (s volbou „smazat i uložené zprávy“), historie změn (audit).
* Člen/čtenář: jen přehled připojených cílů a jejich schopností (bez akcí).
* Stavy: Čeká na potvrzení · Aktivní · Bot odebrán · Přístup odvolán · Kanál archivován · Chyba (+ kód).

## Komunikace (záložka v panelu Aktivita)
Seznam uložených komunikačních záznamů projektu: ikona zdroje, autor (ověřený uživatel ClearSpace / „externí autor“), kanál/skupina, čas, úkol, odkaz na originál.
Hledání v textu + filtr zdroj/cíl. Trvalý pruh: „ClearSpace vidí jen zprávy, které jste výslovně připojili (a u cílů se zapnutou inteligencí zprávy z kanálu
po zapnutí). Nejde o celou konverzaci.“

## Úkol → Konverzace
U úkolu propojeného s vláknem/zprávou: zdrojová zpráva (citace, autor, odkaz) a odpovědi; komentáře z chatu jsou v komentářích úkolu označené ikonou zdroje.

## Nastavení → Propojené identity v chatech
Seznam propojených účtů Slack/Telegram (štítek), „Odpojit“. Stránka `/integrations/link?code=…` pro potvrzení propojení.

## Texty (zkrácené)
Slack: `/clearspace help` · `/clearspace link KÓD` · `/clearspace propojit`; zkratka „Vytvořit úkol v ClearSpace“; odpověď „Úkol „…“ vytvořen v projektu … – <odkaz>“.
Telegram: `/help@bot`, `/link@bot KÓD`, `/task@bot` (jako odpověď), soukromě `/start` → odkaz pro propojení.
