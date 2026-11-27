# RUN 09 – audit rozdělení účtů (read-only, 2026-11-27)

Nic se neměnilo: dotazy jen v `READ ONLY` transakcích nad produkční DB, dokumentace RUN 05–08, stav prohlížeče. Údaje maskované (veřejné repo).

## Účty ClearSpace v produkci
| Účet ClearSpace | Role podle dokumentace | Projekty | Google připojení | Data |
|---|---|---|---|---|
| `luf…@gmail.com` | **prezentační účet** (RUN 06, `PRODUCTION_PILOT.md`); heslo zná jen vlastník, veřejné demo se do něj nepřihlašuje | 14 (`csdp-*`, CSD-CORVANE) | **demo Google účet „Alex Morgan“** – login ClearSpace a Google účet jsou **tatáž adresa**; 5 read-only scopů (Disk, Gmail, Kalendář) | syntetická: 19 dokumentů Disku, 17 událostí; Gmail vlákna **0** (viz nálezy) |
| `mic…@gmail.com` | **osobní účet vlastníka** | 17: 14 kopií CSD (`csd1-*`) + „Vývoj MVP“ + „MedLatina iOS…“ (vlastní projekt) + „Akceptacni test pozvánek“ | **osobní Gmail vlastníka**, jen `drive.file` (1 propojený soubor) | směs demo a osobních dat |
| `mic…@centrum.cz` | jednorázový účet z testů | 0 | – | – |
| `dev…@example.test` | syntetický účet z RUN 00 | 1 (prázdný) | – | – |
| `hub…@clearspace.invalid` | servisní identita hubu (RUN 09) | 0 | – | žádná práva |

Google pilot (RUN 06): `GOOGLE_PILOT_USER_IDS` = prezentační účet, `GOOGLE_PILOT_ACCOUNTS` = demo Google účet (hodnota je ve Vercelu jako Sensitive,
nečitelná; potvrzuje to dokumentace i data – Gmail/Kalendář má jen prezentační účet, osobní účet vlastníka má jen Disk).

## Proč RUN 09 zvolil `mic…`
`PILOT_ROLLOUT.md` (RUN 08B) a zadání RUN 09 říkají „jen účet vlastníka“. Claude to vyložil jako osobní účet vlastníka (adresa vlastníka
z kontextu sezení) – **nikoli** podle cíle „portfolio demo bez soukromých dat“. Pro tento cíl je to špatná volba: Slack/Telegram oznámení
a úkoly by vznikaly vedle osobních projektů a osobního Google připojení, zatímco Disk/Gmail/Kalendář demo běží na jiném účtu.

## Poskytovatelé chatu
* **Slack**: `BNG Workspace` – testovací workspace (kanály `#clearspace_test`, soukromý testovací kanál z RUN 08). Vhodný pro demo.
* **Telegram**: osobní účet vlastníka (obsahuje soukromé konverzace). Boti vidí jen chaty a skupiny, kam jsou přidaní (Relay v privacy mode);
  testovací skupina „ClearSpace Test“ existuje z RUN 08. Osobní konverzace botům přístupné nejsou. Dedikovaný demo Telegram účet by
  vyžadoval další telefonní číslo – volitelné.

## Nálezy
1. **Gmail vlákna prezentačního účtu: 0** (RUN 06 akceptoval 14). Audit: `service_removed` u prezentačního účtu 26. 11.; scope `gmail.readonly`
   zůstává. Stav byl stejný už před první změnou RUN 09 (záloha 19:34: `gmail_sources=0`). Pro portfolio demo je třeba vlákna znovu propojit.
2. **Osobní účet vlastníka má v produkci připojený osobní Google (jen Disk, 1 soubor)** – mimo demo; ponechání/odpojení je rozhodnutí vlastníka.
3. **BotFather chat v Telegramu obsahuje nové tokeny v textu** (standardní chování BotFatheru) – doporučení: ty zprávy v chatu smazat.
4. Ve vestavěném prohlížeči je ClearSpace přihlášen prezentačním účtem.

## Doporučení
Jeden demo účet pro všechny integrace = **prezentační účet `luf…`** (= demo Google identita, syntetická data, už pilot Google):
`HUB_PILOT_USER_IDS` a `NOTIFY_PILOT_USER_IDS` = prezentační účet (místo osobního). Slack = `BNG Workspace`, Telegram = účet vlastníka jen
s testovací skupinou a boty. Změna = 2 proměnné + redeploy + kontroly; v produkci zatím nic propojeno není (0 instalací, 0 identit), takže
není co migrovat. Pak: znovu propojit Gmail vlákna v CSD projektech prezentačního účtu, akceptace Slack/Telegram v témže účtu.
