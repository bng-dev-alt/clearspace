# RUN 05 – soukromí a bezpečnost (Slack, Telegram)

## Co odchází mimo ClearSpace
Jen to, co uživatel sám zapne, a jen jemu: Slack = přímá zpráva od aplikace ClearSpace uživateli, který kanál připojil; Telegram = soukromý chat
s botem, který uživatel potvrdil v ClearSpace. Nikdy kanály, skupiny ani jiní lidé.
Obsah zprávy: typ události, jméno aktéra, název úkolu a projektu, termín, odkaz `APP_BASE_URL/projects/<id>?task=<id>`. Režim „bez názvů“: typ + odkaz.
**Nikdy**: text komentářů, popisy, checklisty, přílohy, data z Drive/Gmail/Kalendáře, AI výstupy, e-maily (test HTTP N7/§2.4, unit testy rendereru).

## Kontroly přístupu
* Zařazení: trigger jen pro uživatele s aktivním kanálem a povoleným typem/projektem (zdroj = in-app notifikace, která už prošla `collab_notify` → členství).
* **Bezprostředně před odesláním** (`notify_dispatch_claim`): kanál aktivní a zapnutý, předvolby, zdroj existuje (zavřená in-app notifikace = nic), člen projektu
  (`project_role_of`), úkol existuje a není archivovaný, u přiřazení/termínu/změn stále přiřazený, u termínu datum beze změny, úkol není hotový, termín neuplynul.
* Výjimka: `project_removed` (informuje o ztrátě přístupu) – bez odkazu.

## Údaje a jejich ochrana
| Údaj | Kde | Ochrana |
|---|---|---|
| Slack bot token + Slack ID uživatele, Telegram chat id | `notification_channels.secret_enc` | AES-256-GCM, klíč jen ve Vercelu/Keychainu, AAD = poskytovatel + id kanálu (nelze přesunout jinam) |
| Slack workspace | `team_hmac` | HMAC(server secret), ne ID |
| Propojovací token / OAuth state | `link_hash` | jen SHA-256, 10 min, jednorázově; Slack state navíc vázán na prohlížeč (HttpOnly nonce cookie) a na uživatele |
| Název workspace / jméno v Telegramu | `label` | vidí jen vlastník (žádný klientský přístup k tabulce) |
| Fronta | `notification_deliveries` | jen id a stav, žádné texty; retence 30 dní |
Žádná nová tabulka nemá klientský grant; RPC uživatele = `authenticated` + server secret; plánovač/dispatch = interní funkce bez grantů (strážní test
`40_definer_hardening` beze změny: jediné anonymní RPC zůstává `invitation_preview`).

## Ochrana proti zneužití
* Telegram: token v deep linku jen v `private` chatu, replay = jen nápověda, **potvrzení v ClearSpace** před prvním doručením (únos propojení nestačí).
* Slack: jen bot scope `chat:write`; odpověď OAuth s jiným/extra scope, user tokenem nebo Enterprise instalací se odmítne a nic se neuloží.
* Injekce do textu: Slack `& < >` escapováno, `mrkdwn:false`, žádné unfurl; Telegram bez `parse_mode`, bez náhledů; řídicí/bidi/zero-width znaky odstraněny.
* Rate limit: propojení 1 / 3 s, zkušební zpráva 1 / 30 s, doručení ≥ 1,1 s na cíl, `Retry-After` respektován.
* Dispatch endpoint: hlavička `x-notify-secret` (SHA-256 + `timingSafeEqual`), max 512 KB, 401/413; vypnuté přepínače = 503 jako první krok.

## Logy a tajemství
`notifyLog` = whitelist (fáze, kódy, počty); žádné tokeny, chat/Slack/team id, texty ani payloady. `next dev` netiskne `/api/notify/*` (Slack callback nese kód).
Bundle guard (+26 vzorů), `redact-secrets.mjs` (+ `x-notify-secret`, Slack a Telegram tokeny), HTTP test N13 prochází log dev serveru.
Tajemství jen Keychain (`notify-live.sh`, skrytý prompt) a v budoucnu Vercel Sensitive; nikdy v repu (veřejné), chatu ani logu.

## Známá omezení
* Slack: odeslaná zpráva zůstává ve Slacku i po odpojení (Slack je správce zpráv); zrušení instalace aplikace ve workspace je na jeho správci.
* Telegram: po odpojení se pošle poslední zpráva „odpojeno“; bot nemůže smazat historii chatu za uživatele.
* Rotace `NOTIFY_SERVER_SECRET` změní HMAC workspace (sdílení tokenu se pozná až po novém připojení) – řešit spolu s rotací.
