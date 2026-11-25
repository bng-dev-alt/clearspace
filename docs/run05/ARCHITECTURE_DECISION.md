# ADR RUN 05 – Slack & Telegram jako aditivní doručovací vrstva nad notifikacemi ClearSpace

Stav: přijato (Phase 0, 2026-11-26). Fakta a zdroje: `AUDIT.md` §9. Rozhodnutí v detailu: `DECISIONS.md`.

## Kontext
ClearSpace má funkční in-app notifikace (`notifications` + `collab_notify`, realtime) a aktivitu (`activity_logs`). RUN 05 přidává doručení
mimo aplikaci (Slack, Telegram) bez změny in-app chování, s vypnutými přepínači v produkci a s migrací, která poběží pod starým buildem.

## Rozhodnutí
1. **Zdroj událostí = stávající data, žádná změna `notifications`.**
   * `AFTER INSERT` trigger na `notifications` (typy `assignment, mention, comment, project_added, project_role_changed, project_removed`) a na
     `activity_logs` (`card_moved` s `completed = true` → `task_completed`; `card_due_changed` → `task_due_changed`, příjemci = přiřazení kromě aktéra)
     zařadí řádek do outboxu `notification_deliveries` **jen pro uživatele s aktivním kanálem** a zapnutým typem/projektem.
   * Oba triggery: `SECURITY DEFINER`, celé tělo v `BEGIN … EXCEPTION WHEN OTHERS THEN RETURN NULL` → selhání zařazení nikdy neshodí původní transakci;
     bez kanálů = jeden `EXISTS` nad prázdnou tabulkou (no-op). Tabulka `notifications` ani existující triggery se nemění ⇒ parita in-app 1400 = 1500.
   * `due_soon` vytváří plánovač (dispatch) podle §3 – nic v triggerech.
2. **Plánovač = Supabase `pg_cron` každou minutu → `pg_net` POST → `/api/notify/dispatch`.**
   * Proč: Vercel Hobby Cron jen 1× denně ±59 min (nestačí pro retry ani doručení do minut); `pg_cron`/`pg_net` jsou na produkčním projektu dostupné
     bez upgradu (ověřeno). Odeslání po zápisu přes `after()` nejde – změny karet jdou z prohlížeče přímo do PostgREST, server je nevidí.
   * **Migrace 1500 extenze neinstaluje ani job neplánuje.** Aktivace je samostatný ops skript `supabase/ops/notify_scheduler_enable.sql`
     (instalace `pg_cron` + `pg_net`, tajemství do Vault, `cron.schedule`) – v produkci až při budoucím zapnutí (rozhodnutí vlastníka).
     Lokální stack ho spouští `notify-stack.sh scheduler-on`.
   * Vlastnosti nezávislé na plánovači: dispatch je idempotentní (outbox s unikátním klíčem, `due_soon` `ON CONFLICT DO NOTHING`), souběh řeší
     `FOR UPDATE SKIP LOCKED` + lease, retry přes `next_attempt_at`, zotavení po výpadku = další tick dožene vše podle pravidel M4 (nic se neztrácí,
     staré připomínky po termínu se zahodí). Ruční tick (`notify-stack.sh tick`) dělá totéž.
3. **Doručovací logika v DB, aplikace bez DB práv pro dispatch (revize v Phase 1).** `notify_scheduler_tick()` je interní funkce (žádný
   `EXECUTE` pro klientské role – strážní test `40_definer_hardening` zůstává beze změny): (1) vyzvedne odpovědi předchozích dávek z `net._http_response`
   a zapíše výsledek každého doručení, (2) `prepare`, (3) `claim` + `net.http_post` dávky (obálky s šifrovanými údaji, jména pro text) na
   `/api/notify/dispatch` s hlavičkou `x-notify-secret` (porovnání SHA-256 v konstantním čase). Aplikace dešifruje, odešle a v odpovědi vrátí
   `[{id, outcome, code, retryAfter}]`. Ztracená odpověď ⇒ lease (5 min) vyprší ⇒ `ambiguous`.
4. **Telegram propojení přes `getUpdates` na vyžádání – bez webhooku.** Uživatel otevře `t.me/<bot>?start=<token>`, stiskne Start, v ClearSpace
   klikne „Zkontrolovat“ (UI to krátce dělá samo). Server zavolá `getUpdates`, zpracuje jen `/start <token>` v `private` chatu (token jednorázový,
   10 min, v DB jen SHA-256), potvrdí offset. Kanál přejde do stavu `confirm`; **odesílat se začne až po potvrzení v ClearSpace** („Je to váš účet
   <jméno>?“). Výhody: žádný veřejný příchozí endpoint, stejná cesta v dev i produkci, žádný `setWebhook`. Cena: propojení vyžaduje jeden klik navíc.
5. **Slack: jen bot scope `chat:write`, zpráva na `authed_user.id`** (Messages tab aplikace – Slack DM otevře sám; `channel_not_found` = nelze psát
   ⇒ „znovu připojit“). Žádné user scopes, žádné kanály. Bot token je per workspace: uložen šifrovaně u kanálu každého uživatele; **`auth.revoke` jen
   pokud žádný jiný aktivní kanál nemá stejný workspace** (porovnání přes HMAC `team_id`).
6. **Obsah se skládá až při odeslání z aktuálních řádků** (název úkolu, projektu, termín) – nic z obsahu se v outboxu neukládá. Ve stejném dotazu se
   ověří přístup, stav kanálu, preference a (u `due_soon`) termín/hotovo. Cokoli neplatí ⇒ `cancelled`.
7. **Nejednoznačné odeslání = at-most-once.** Timeout po odeslání požadavku nebo lease vypršelý ve stavu `sending` ⇒ `failed` (`ambiguous`), bez dalšího
   pokusu. Zdůvodnění: duplicitní zpráva je horší než chybějící, protože in-app notifikace existuje vždy. Jasně nedoručené (síťová chyba před odpovědí,
   5xx, 429) ⇒ retry.
8. **Termín (M4):** datum bez času v `Europe/Prague`; připomenutí den předem v 09:00 místního času (`((due - 1) + time '09:00') AT TIME ZONE 'Europe/Prague'`);
   dohánění do konce dne termínu; jednou na (uživatel, úkol, termín) – klíč `d:<card>:<date>`.
9. **Šifrování:** vlastní klíč `NOTIFY_TOKEN_ENCRYPTION_KEY` (+ `_PREVIOUS`), AAD `clearspace:notify:<provider>:<user>`; `seal/open` z `google/crypto.ts`.
10. **Přepínače:** `SLACK_INTEGRATION_ENABLED`, `TELEGRAM_INTEGRATION_ENABLED` (default off). Dispatch s oběma vypnutými = 503 a nic nedělá.
    S jedním vypnutým se čekající doručení tohoto poskytovatele zruší (`cancelled`, `provider_disabled`), aby se po pozdějším zapnutí neposlaly staré zprávy.

## Varianty, které nevyhrály
| Varianta | Proč ne |
|---|---|
| Vercel Cron | Hobby 1× denně ±59 min; Pro = placený upgrade (NESCHVÁLENO) |
| Externí plánovač (GitHub Actions, cron služby) | nová služba, veřejné repo, nespolehlivé intervaly |
| Telegram webhook | veřejný příchozí endpoint, produkčně neověřitelný bez produkčního bota, odlišná cesta dev/prod |
| Slack Incoming Webhooks | cíl vybírá uživatel (i veřejné kanály) – v rozporu s „jen osobní cíl“; URL webhooku = tajemství bez revokace |
| Service-role klíč pro dispatch | nový vysoce privilegovaný produkční secret; vzor projektu je server secret + úzké RPC |
| Zápis nových typů do `notifications` | starý build by je zobrazil obecným textem; mění in-app chování |

## Důsledky
* Doručení s latencí ≤ ~1 min (tick) + rate limit poskytovatele.
* Produkce po RUN 05: tabulky existují, triggery no-op, žádný plánovač, žádné tajemství, trasy 503.
* Zapnutí v produkci (LATER, vlastník): Slack aplikace + Telegram bot pro produkci, Vercel proměnné, `server_trust('notify')`, ops skript plánovače.
