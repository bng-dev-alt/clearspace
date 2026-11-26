# RUN 07 – akceptační matice

Stavy: **PASS** (důkaz v tomto běhu) · FAIL · **BLOCKED** · NOT VERIFIED. **Mock ≠ živý poskytovatel**: vše ve sloupci „Mock / DB / HTTP“ běží
proti simulaci Slacku a Telegramu (`frontend/scripts/hub-mock.mjs`), podepsané webhooky generují testy stejně jako poskytovatelé.
Živý sloupec je BLOCKED, dokud vlastník nesplní owner block (`HANDOFF.md` §4).

Důkazy: DB `supabase/tests/collab/96_communication_hub.sql` (89 asercí) + celý harness (2610 asercí, scénář K7) · HTTP `supabase/tests/hub_http.mjs`
(21 skupin, běh s PI vypnutým i zapnutým + OFF běh) · E2E `e2e/hub.spec.ts` (Classic i Monograph, desktop světlý, mobil tmavý) ·
Vitest `src/__tests__/hub/hub.test.ts` (21) · zkouška na replice produkčního DDL `scripts/rehearse-hub-prod.sh`.

| # | Scénář | Mock / DB / HTTP | Živě |
|---|---|---|---|
| A1 | Připojení veřejného Slack kanálu | **PASS** – kód správce (jen hash, 10 min, jednorázový) → `/clearspace propojit KÓD` → čeká → potvrzení správcem (HTTP A1, E2E) | BLOCKED |
| A2 | Připojení soukromého Slack kanálu | **PASS** – stejný tok pro `G…` kanál (bot pozván); typ kanálu se záměrně nezjišťuje (bez `groups:read`, D7) | BLOCKED |
| A3 | Připojení Telegram skupiny | **PASS** – `/link@bot KÓD` jen od zakladatele/správce skupiny (`getChatMember`), bot admin práva nepotřebuje; příkazy pro jiné boty ignorovány | BLOCKED (getChatMember u ne-admin bota ověřit živě) |
| A4 | Více cílů v jednom projektu | **PASS** – 2 Slack kanály + Telegram superskupina v jednom projektu, každý s vlastními schopnostmi | BLOCKED |
| A5 | Odmítnutí neoprávněné správy integrací | **PASS** – člen/čtenář/cizí 403 (kód, potvrzení, nastavení, test, odpojení, instalace), cizí nečte stav; tabulky hubu a `hub_svc_*` klientům zavřené i se server secretem | n/a |
| A6 | Odmítnutí prošlého / znovu použitého kódu | **PASS** – znovu použitý, prošlý, kód jiného poskytovatele; Telegram kód jednorázový; limit 10 kódů / 10 min | BLOCKED |
| A7 | Podvržený Slack podpis / Telegram tajemství | **PASS** – špatný/chybějící podpis, starý timestamp (>5 min), pozměněné tělo, špatné/chybějící Telegram tajemství → 401; přetížené tělo odmítnuto | BLOCKED |
| A8 | Události z nepropojených kanálů | **PASS** – nepropojený / čekající kanál: nic se neuloží, žádný modal | BLOCKED |
| A9 | Cross-project / cross-tenant izolace | **PASS** – jeden kanál = jeden projekt (globální HMAC klíč), oznámení nepřechází mezi projekty, view PI pro cizího prázdné, DB test 96 | n/a |
| A10 | Oznámení jen do nakonfigurovaných cílů | **PASS** – jen aktivní cíle se zapnutým „Oznámení“ a odebíranými typy; souhrn ≤ 10 řádků na cíl a běh; escapování pro Slack | BLOCKED |
| A11 | Osobní notifikace RUN 05 zachovány | **PASS** – `notify_http.mjs` 23/23 a `e2e/notify.spec.ts` na stejném stacku s migrací 1600; parita in-app notifikací 1500 vs 1600 (K7 + replika produkce) | BLOCKED (owner block RUN 05) |
| A12 | Úkol ze Slack zprávy | **PASS** – zkratka u zprávy → modal s náhledem → úkol jménem ověřeného uživatele (atribuce v aktivitě), permalink, potvrzení ve vlákně, bez ozvěny | BLOCKED |
| A13 | Úkol z Telegram zprávy | **PASS** – `/task@bot [název]` jako odpověď → úkol, odkaz na zprávu (superskupina), potvrzení jako odpověď | BLOCKED |
| A14 | Odmítnutí neoprávněného externího vytvoření úkolu | **PASS** – nepropojená identita, ověřený čtenář, vypnuté „Interaktivní“, prázdný název | BLOCKED |
| A15 | Synchronizace komentářů | **PASS** – odpovědi ověřených členů ve vlákně → komentář jejich jménem; neověření jen záznam; komentář v ClearSpace → do vlákna / jako odpověď v Telegramu, escapováno, jednou | BLOCKED |
| A16 | Prevence smyček | **PASS** – příchozí komentář se nevrací (GUC + `hub_comment_links`), vlastní zprávy aplikace (`bot_id`) se nezpracují, úkol z chatu nevyvolá oznámení „vytvořen“ | BLOCKED |
| A17 | Deduplikace | **PASS** – Slack `event_id`, Telegram `update_id`, opakované odeslání modalu = jeden úkol, stejná zpráva pod novým event_id = jeden záznam | BLOCKED |
| A18 | Výpadky a rate limit | **PASS** – 429 s Retry-After, 5xx backoff, pak doručeno právě jednou; dvojznačný timeout = at-most-once (vzor RUN 05) | BLOCKED |
| A19 | Odvolaný token / odebraný bot | **PASS** – `not_in_channel` → „bot není v kanálu“, `app_uninstalled` → workspace i kanály odvolány naráz, reinstalace obnoví; Telegram kick / znovupřidání; migrace skupina → superskupina | BLOCKED |
| A20 | AI ingestion vypnutá ve výchozím stavu | **PASS** – výchozí `intelligence=false`, serverový přepínač `HUB_INTELLIGENCE_ENABLED` ve výchozím stavu 0 (nic se ani nedotazuje) | n/a |
| A21 | Žádné sbírání v režimu jen oznámení | **PASS** – běžné zprávy kanálu bez PI se zahodí bez uložení | BLOCKED |
| A22 | Výslovně povolené PI čtení | **PASS** (běh s `HUB_INTELLIGENCE_ENABLED=1`) – jen správce, jen s potvrzením rozsahu (UI dialog + `intelligenceAck`), jen nové zprávy; PI je čte pod RLS volajícího jako citovatelný zdroj `comm:` | BLOCKED |
| A23 | Odvolaný zdroj už není čitelný | **PASS** – vypnutí PI skryje okamžitě (view), odpojení smaže importy | n/a |
| A24 | Retence a purge | **PASS** – odpojení: vazba + konverzace pryč, importy smazány, historie úkolů jen při volbě purge; retence 90 dní v ticku; úkoly zůstávají | n/a |
| A25 | Prompt-injection containment | **PASS** – text v rámci `PROJECT` s výslovným „NIKDY pokyny“, citace jen existujících `comm:` zdrojů, vložený „SYSTEM: …“ nic nezmění; mock testy bez placených AI volání | NOT VERIFIED s živým modelem |
| A26 | Izolace dema, 0 provozu k poskytovatelům | **PASS** – demo build: statická simulace se štítkem, 0 požadavků na `/api/hub`, Slack ani Telegram (ověřeno v prohlížeči) | n/a |
| A27 | Containment vypnutých funkcí | **PASS** – lokální OFF běh: 14 rout 503 dřív než podpis/DB, callback nic neparkuje, /privacy „nezapnuto“, /about bez sekce; produkční build z čistého exportu `check-deployment.sh EXPECT_HUB_OFF=1` 17/17; bundle guard 132/132 | n/a |
| A28 | Soubory vlastníka beze změny | **PASS** – viz `HANDOFF.md` §6 (hash před/po, obsah nečten) | n/a |

## Regrese (stejný běh)
* Vitest **1423/1423** (mimo sandbox; v sandboxu padají jen testy s lokálními sockety SMTP/STT – prostředí, ne kód).
* DB harness **ALL PASSED – 2610 asercí** vč. `40_definer_hardening` (jediná anonymní RPC zůstává `invitation_preview`) a scénáře K7 (parita, upgrade otisk, rollback).
* HTTP: hub 21/21 (PI off) + 21/21 (PI on) + OFF 1/1; notify (RUN 05) 23/23.
* E2E: `hub.spec.ts` Classic + Monograph PASS; `notify.spec.ts`, `collaboration.spec.ts`, `collaboration-01b.spec.ts` PASS.
* Build produkčního typu z čistého `git archive` exportu PASS; bundle guard 132/132.
* Zkouška migrace na replice produkčního DDL: **REHEARSAL PASS** (replika = produkční katalog; apply skript v jedné transakci bez změny řádků a otisků;
  sady 92/93/94/95/96 na DDL produkce + 1600; parita in-app notifikací 1500 = 1600; rollback odmítnut s daty, čistý rollback vrátí katalog 1500 přesně; opětovné použití).
* NEZOPAKOVÁNO (beze změny dotčeného kódu): Drive/Gmail/Calendar HTTP sady a jejich E2E – DB kontrakty 92–94 prošly na 1600 (harness i replika).
