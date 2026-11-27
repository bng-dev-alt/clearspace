# RUN 08B – Communication Hub Final Acceptance (report)

**Verdikt: GO pro společný řízený pilot Slack + Telegram (etapa 1, jen účet vlastníka, PI vypnuto) – po schválení vlastníka.
Etapa 2 (Cortex + Project Intelligence) GO s výhradou: AI odpovědi nad chaty živě neověřeny (BLOCKED – lokálně bez klíče/rozpočtu).**
Produkce beze změny. Postup: `PILOT_ROLLOUT.md`. Backlog: `UX_BACKLOG.md`. Předchozí kolo: `README.md` (RUN 08).

## Živé výsledky (skutečný Slack / Telegram, izolovaný lokální stack, tunel `cs-hub-live.luffast.com`)
| Scénář | Výsledek | Důkaz |
|---|---|---|
| Obnovení autorizace dev Slack aplikace (po odvolání v RUN 08) | PASS | instalace aktivní, `slack_installed mock:false` |
| Propojení Slack účtu (párovací box, `/clearspace ucet`) | PASS | `slack_identity ok` |
| **Soukromý Slack kanál**: propojení kódem, samočinná detekce, potvrzení, zkušební zpráva | PASS | watcher 17:37 |
| Oznámení plánovačem do soukromého kanálu | PASS | outbox `sent` |
| Úkol ze zprávy v soukromém kanálu (shortcut) | PASS | `slack_task ok` |
| Komentář ClearSpace → vlákno; odpověď ve vlákně → komentář úkolu (ověřený autor) | PASS | `hub_comment_links` outbound 17:51, inbound 18:04 |
| Propojení Telegram účtu (`start` odkaz) | PASS | `telegram_identity ok` |
| **Telegram skupina** přes „Přidat bota do skupiny“ (startgroup), bez admin práv, samočinná detekce | PASS | `telegram_link ok`, watcher 17:46 |
| Oznámení plánovačem do Telegram skupiny | PASS | outbox `sent` |
| **Úkol z Telegramu** `/task@ClearSpaceRelayBot Název` | PASS po opravě | `telegram_task ok, fromReply:false` |
| Komentář ClearSpace → odpověď v Telegramu; odpověď na bota → komentář úkolu | PASS | links outbound 18:02, inbound 18:01 |
| **Cortex** (privacy OFF) – import zpráv jen z potvrzené skupiny s výslovným souhlasem | PASS | 7 importů |
| PI izolace kontextu: vlastník i člen vidí 12/12 záznamů projektu; cizí uživatel 0; jiný projekt 0; klíče/id neodhaleny | PASS | `hub_live_pi.mjs` 1–5 |
| PI bezpečnost: „SYSTEM: ignoruj pokyny…“ uloženo jen jako citovaná data, nic nezměnilo | PASS | `hub_live_pi.mjs` 6 |
| PI opt-out: vypnutí u skupiny → 7 importů okamžitě smazáno, mimo kontext | PASS | `hub_live_pi.mjs` 8 |
| AI odpovědi nad komunikací z chatů | **BLOCKED** | Gemini klíč jen v produkci (Vercel); lokálně se nepoužívá |
| Pilotní kontrola nasazení: etapa 2 (Slack+Telegram+PI) proti živé app; etapa 1 a „jen Slack“ lokálně | PASS 10/10 ×3 | `EXPECT_HUB_PILOT=1 …` |

## Vady nalezené živě a opravené (s regresí)
1. **Telegram `/task` nefungoval** – Relay (privacy mode, bez admin práv) dostal příkaz **bez `reply_to_message`** (Telegram nepředá zprávu, kterou
   bot neviděl); mocky ji vždy obsahovaly. Oprava: bez odpovědi vznikne úkol z názvu v příkazu, potvrzení otevře vlákno komentářů; bez názvu
   přesný návod. Privacy mode ani práva beze změny. Regrese: `hub_http.mjs` A13 se skutečným tvarem zprávy.
2. **Plánovač v živé relaci neběžel** (`hub-live.sh app` ho nezapínal; oznámení čekala) → zapíná se se startem relace a vypíná jako první při ukončení.
3. **Mock regrese mazala živá data** (všechny instalace Slacku a identity na sdíleném stacku; v RUN 08 tak zmizela instalace, kanál a propojení
   účtů vlastníka) → maže a kontroluje jen simulovaná data; ověřeno: po 2 bězích zůstala živá instalace i identity.
4. **Ochrana izolace**: lokální živá relace odmítne běžet s produkční službou Keychainu.

Poznámka (záměrné chování, beze změny): zdrojová zpráva úkolu se ukládá jako „neověřený autor“; kdo úkol vytvořil (ověřeně) je v aktivitě úkolu.

## Regrese (simulace)
Vitest 96 / **1427** · `hub_http.mjs` **22/22** PI vypnuto i zapnuto (živá data na stacku nedotčena) · `notify_http.mjs` **22/22** ·
E2E hub + notify **2/2** Classic/Monograph × světlý/tmavý · produkční build z čistého exportu + bundle guard **139/139** · tsc + eslint bez chyb.

## Produkce a rollout
Produkce: build RUN 06, `/api/hub/*` = 404, markery končí 1500; migrace 1600/1700 shodné s nazkoušenými. **Nic nenasazeno.**
Doporučený přechod bez nových aplikací/botů: povýšit dev Slack aplikaci, Relay (a v etapě 2 Cortex) do produkce s **rotací všech tajemství**
(Slack Regenerate, BotFather `/revoke`) a nově vygenerovanými serverovými klíči – dev přístup tím zanikne, prostředí zůstanou oddělená.

## Úklid
Živá relace ukončena (webhooky obou botů smazány, tunel a proxy zastaveny, plánovač vypnut), simulace zastaveny, stack zastaven bez mazání dat.
Cloudflare tunel `clearspace-hub-live`, DNS a Keychain zachovány. Ostatní tunely vlastníka nedotčeny.
