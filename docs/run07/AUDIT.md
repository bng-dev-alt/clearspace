# RUN 07 – Project Communication Hub: audit (Phase 0)

Datum 2026-11-26. Zadání bylo pojmenováno „RUN 06“, ale číslo RUN 06 už nese Google demo + pilot (`docs/run06/`, nasazeno) → tento běh je **RUN 07**
(`docs/run07/`, větev `feature/run07-communication-hub`, tagy `run07-*`, migrace **1600**). Rozhodnutí D1.

## 1. Výchozí stav (ověřeno příkazy)
| Položka | Stav |
|---|---|
| `main` / `origin/main` | `d1236a2` (RUN 06 close) – ne `eebf605` z RUN 05; mezitím RUN 06 (Gmail/Kalendář pilot, demo seeder) |
| Produkce | `dpl_9NkXChVh…` (RUN 06); Gmail/Kalendář `=pilot` pro prezentační + demo účet; Slack/Telegram (RUN 05) `0`; plánovač notifikací vypnutý |
| Produkční DB | markery do **1500** (RUN 06 schéma neměnil) |
| RUN 05 živá akceptace | stále **BLOCKED** (owner block nikdy neproběhl) |
| `V1/frontend/.env.local` | **obnoven** v RUN 06 (ověřené URL + anon klíč); v RUN 07 jen otisk SHA-256, obsah se nečte ani nemění |
| Chráněné soubory | inventura otisků: `V1/frontend/.env.local`, `V1/frontend/test_intro.mp4`, `V1/DEMO/` (28 souborů), `.env.local` ve `V1-consolidation`, `V1-intelligence` |

## 2. Co z RUN 01–06 znovupoužijeme
| Oblast | Kde | Použití v RUN 07 |
|---|---|---|
| Role projektu | `project_role_of`, `can_manage_project` (owner/admin), `can_edit_project` (+member), `is_project_member` (+viewer) | správa integrací = `can_manage_project`; vytvoření úkolu z chatu = `can_edit_project` propojené identity; čtení komunikace = člen |
| Aktivita | `activity_logs` (`card_created`, `card_moved` s `completed`) | zdroj projektových událostí pro kanály |
| Komentáře | `task_comments` + `collab_comment_rules`/`collab_comment_events` (autor = `auth.uid()`) | komentáře ze Slacku/Telegramu vznikají jako komentáře ověřeného autora |
| Doručování | RUN 05 `notify_*`: outbox, `pg_cron → pg_net → /api/notify/dispatch`, lease, retry, at-most-once | stejný vzor pro projektové cíle (oddělená fronta a endpoint) |
| Kryptografie | `src/lib/google/crypto.ts` (`seal/open`, AAD) | tokeny Slack instalace, id kanálů/skupin |
| Slack/Telegram adaptéry | `src/lib/notify/providers.ts` (fetch, klasifikace chyb, escapování) | rozšíření o kanály, vlákna, modaly, getChatMember |
| Project Intelligence | `src/lib/intelligence/context.ts` (`loadProjectData` → `assembleContext`, ref gramatika, `frameUntrusted`), `resources/contract.ts` (`aiUse`) | nový zdroj `comm:<id>` jen pro cíle se zapnutou inteligencí |
| UI | `Toolbar` (Členové projektu), `ProjectTeamModal`, `ActivityFeedDrawer`, `TaskDetailDrawer`, `/settings` | modal „Integrace“, záložka „Komunikace“, sekce „Konverzace“ v úkolu |

## 3. Zjištění, která mění návrh
1. **Webhooky bez uživatele:** server nemá service-role klíč a strážní test `40_definer_hardening` zakazuje anonymní RPC. Příchozí Slack/Telegram
   události ale nemají uživatelskou relaci → potřebujeme úzkou **servisní identitu** (vlastní Supabase uživatel, RPC jen pro něj + server secret). D4.
2. **Telegram getUpdates vs. webhook:** osobní bot RUN 05 používá `getUpdates`; projektový bot musí mít webhook (příkazy ve skupinách v reálném čase)
   → **samostatný projektový bot**; konfigurace odmítne stejný token pro oba. D5.
3. **Slack scopes:** osobní aplikace RUN 05 má jen `chat:write`; projektové funkce potřebují `commands`, `channels:history`, `groups:history` → **samostatná
   Slack aplikace** (reinstalace osobní by tiše rozšířila oprávnění). D6.
4. **Vercel Hobby:** bez častého cronu; plánovač zůstává v DB (`pg_cron`), příchozí webhooky = obyčejné route handlery (krátké, `after()` pro práci po potvrzení).
5. **Lokálně nelze přijímat Slack Events / Telegram webhook** bez veřejné HTTPS URL (tunel je NESCHVÁLEN) → živá akceptace vyžaduje izolované staging prostředí = owner block.

## 4. Provider fakta (dokumentace 2026-11-26; živě NEOVĚŘENO)
Slack: podpis `v0=HMAC-SHA256(signing_secret, "v0:{ts}:{raw body}")`, tolerance 5 min; shortcut i slash command vyžadují scope `commands` a odpověď do 3 s;
`trigger_id` platí 3 s; `private_metadata` ≤ 3000 znaků; Events API odpověď do 3 s, až 3 opakování (`X-Slack-Retry-Num`); `message.channels` →
`channels:history`, `message.groups` → `groups:history`; bot dostává jen zprávy kanálů, kde je členem; `app_uninstalled`/`tokens_revoked` bez scope;
`chat.getPermalink` bez scope; `chat:write.public` jen veřejné kanály (nepoužijeme); `conversations.info` potřebuje `*:read` (nepoužijeme).
Telegram: privacy mode (výchozí, pro bota globální) doručí ve skupině jen `/cmd@bot`, odpovědi na zprávy bota a servisní zprávy; **bot-admin dostává vše** →
admin práva nevyžadujeme; webhook se `secret_token` hlavičkou, porty 443/80/88/8443, opakování při ne-2xx, `update_id` pro deduplikaci, aktualizace
drženy 24 h; webhook a `getUpdates` se vylučují; `my_chat_member` = změna členství bota; odkazy na zprávy `t.me/c/<id>/<msg>` (soukromé supergroupy),
`t.me/<username>/<msg>` (veřejné). `getChatMember` pro ne-admin bota: dokumentace nepřečtena celá → ověřit živě.
UX (Linear docs): kanál k týmu/projektu volí admin; „Create issue“ přes message action s modalem; synchronizace jen u vlákna vytvořeného z akce;
issue z Slacku jen pro uživatele s účtem v nástroji; bot musí být pozván do soukromých kanálů.
