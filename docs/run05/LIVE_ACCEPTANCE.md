# RUN 05 – živá akceptace (skutečný Slack a Telegram)

## Stav: **BLOCKED** (čeká na jediný blok interakce vlastníka)
Skutečný Slack a Telegram vyžadují kroky, které Claude provést nemůže ani nesmí: přihlášení vlastníka do Slacku (vytvoření dev aplikace a souhlas „Allow“)
a do Telegramu (BotFather a „Start“). Podle `RUN_PROMPT.md` §0/§4 Phase 5 živý test **nezastavil běh**: produkce byla nasazena s oběma přepínači vypnutými
(na živé integraci nezávisí), tag `run05-live-complete` **nevznikl**, brána G5 = jen regrese. **Živá integrace je NEOVĚŘENÁ – produkce zůstává vypnutá;
zapnutí vyžaduje nejdřív tuto akceptaci.**

## Co je připraveno (vše na lokálním stacku, nic v produkci)
* `frontend/scripts/notify-live.sh` (Keychain přes skrytý prompt, `app` s HTTPS proxy pro Slack redirect, `gate`, `tick`, `revoke-check`, `forget`).
* `frontend/supabase/tests/notify_live_gate.mjs`: Slack `auth.test`, workspace == uložený HMAC, scopes tokenu **přesně `chat:write`**; Telegram `getMe`,
  **žádný webhook**; produktová cesta in-app přiřazení → fronta → `pg_net` tick → `/api/notify/dispatch` → poskytovatel = `sent`; `revoke-check` po odpojení
  (Slack token mrtvý u Slacku, žádný řádek kanálu).

## Body živé akceptace (po OWNER BLOCKu)
| # | Bod | Důkaz | Stav |
|---|---|---|---|
| L1 | Slack OAuth s dev aplikací (redirect `https://localhost:3472/...`), jen `chat:write` | brána: scopes == [chat:write] | BLOCKED |
| L2 | Telegram deep link → Start → potvrzení v ClearSpace | UI + zpráva v chatu | BLOCKED |
| L3 | Přiřazení → zpráva se správným odkazem na úkol (Slack DM + Telegram) | brána + screenshot | BLOCKED |
| L4 | `due_soon` s testovacím časem (`notify-live.sh tick <now>`) | zpráva „Zítra (…)“ | BLOCKED |
| L5 | Název s `<!channel>`/HTML doslova, bez náhledu odkazu | screenshot | BLOCKED |
| L6 | Režim „bez názvů“, vypnutý typ, filtr projektu | UI + zprávy | BLOCKED |
| L7 | Zablokování bota uživatelem → kanál „zablokovaný“, fronta stojí | stav v UI | BLOCKED |
| L8 | Odpojení: Slack token prokazatelně mrtvý (`revoke-check`), Telegram odpojen | `revoke-check` | BLOCKED |
| L9 | Logy dev serveru bez tokenů/id/textů | grep | BLOCKED |
| L10 | Druhý Slack uživatel / druhý Telegram účet (sdílený workspace, izolace) | jen pokud vlastník má | BLOCKED / NOT VERIFIED |
Ověřené jen proti mocku (ne živě): vše z `NOTIFICATIONS.md` §4. **Mock není důkaz živé integrace.**

## Fakta o poskytovatelích (dokumentace, 2026-11-26; živě NEOVĚŘENO)
Slack: redirect URL musí být HTTPS; `chat.postMessage` s ID uživatele a jen `chat:write` doručí do App Home (Messages tab); ~1 zpráva/s na kanál, 429 + `Retry-After`.
Telegram: `getUpdates` a webhook se vylučují; deep link payload `A-Za-z0-9_-`, ≤ 64 znaků; ~1 zpráva/s na chat, ~30/s globálně; 429 + `retry_after`.
