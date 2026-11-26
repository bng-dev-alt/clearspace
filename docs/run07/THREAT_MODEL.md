# RUN 07 – threat model

| # | Hrozba | Opatření | Test |
|---|---|---|---|
| T1 | Podvržený Slack požadavek | HMAC `v0` nad raw body, `timingSafeEqual`, okno 5 min, podpis před jakýmkoli parsováním/DB | HTTP: špatný podpis / staré ts → 401 |
| T2 | Podvržený Telegram webhook | `X-Telegram-Bot-Api-Secret-Token` (konstantní čas), jen POST JSON ≤ 256 KB | HTTP: bez/špatné tajemství → 401 |
| T3 | Replay | Slack ts okno + `event_id`/akce do `hub_inbox`; Telegram `update_id` do `hub_inbox` | duplicita = 200 bez efektu |
| T4 | Připojení cizí skupiny/kanálu | jednorázový kód (SHA-256, 10 min) od správce projektu + Telegram admin skupiny (`getChatMember`) + potvrzení v ClearSpace; chat id samo nic | DB + HTTP |
| T5 | Cross-project / cross-tenant routing | vazba unikátní napříč systémem (1 kanál = 1 projekt), směrování výhradně přes (instalace, kanál) / chat id HMAC; RPC ověřují projekt vazby | DB: cizí projekt, cizí workspace |
| T6 | Externí uživatel získá zápis jen přítomností v kanálu | zápis jen přes propojenou identitu + `can_edit_project` v okamžiku akce; nepropojení = jen záznam s označením „externí“ (bez komentáře) | HTTP |
| T7 | Únos propojení identity | odkaz doručen jen soukromě (Slack ephemeral, Telegram soukromý chat), jednorázový, 10 min, vázaný na externího uživatele; potvrzuje přihlášený uživatel | DB |
| T8 | Smyčky a duplicity komentářů | ignorovat zprávy vlastního bota (bot_id/app_id, `from.is_bot`), GUC `clearspace.hub_inbound`, `hub_comment_links`, unikátní klíče zpráv | HTTP |
| T9 | Únik citlivých dat do kanálu | oznámení bez popisů úkolů (jen název, projekt, odkaz); sync jen u výslovně propojeného úkolu; odpojení zastaví vše | unit + HTTP |
| T10 | Tiché sbírání konverzace | bez inteligence se nepropojené zprávy zahodí v paměti (žádný zápis ani log obsahu); PI jen po výslovném zapnutí správcem | HTTP: „notification-only = 0 záznamů“ |
| T11 | Prompt injection z chatu | obsah jen jako citovaná nedůvěryhodná data (`frameUntrusted`), žádné nástroje/akce z textu, AI nic samo nevytváří | unit |
| T12 | Odvolání nefunguje | odpojení smaže vazbu (kaskáda konverzací + volitelně zpráv), PI view filtruje `status='active'` a `intelligence=true` | DB |
| T13 | Únik tokenů | AES-GCM (AAD = účel + id), žádné tokeny v logu/bundlu/repu; redakce + bundle guard | guard |
| T14 | Servisní identita zneužita | RPC vyžadují uid principála **a** server secret; principál nemá žádná projektová práva; heslo jen v env | DB: jiný uživatel se secretem → 42501 |
| T15 | Storm / rate limit | souhrn na cíl a tick, ≥ 1,1 s na cíl, 429 `Retry-After`, max 20 položek/tick | HTTP |
| T16 | Ambiguous delivery | at-most-once (lease → `failed ambiguous`), jako RUN 05 | DB |
| T17 | Demo uniká do reality | demo režim bez Supabase = statická simulace bez jakéhokoli síťového volání poskytovatelů; štítek „simulace“ | E2E demo |
| T18 | Poškození souborů vlastníka | žádný zápis do `V1/` mimo git operace; build/hosted testy jen v dočasném exportu; otisky před/po | inventura |
