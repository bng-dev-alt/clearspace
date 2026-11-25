# Živý akceptační test e-mailových pozvánek (produkce)

Stav (2026-11-25): **prostředí je připravené, nic se neodeslalo.** Skutečné e-maily vzniknou až ve chvíli, kdy vy v aplikaci kliknete
na „Pozvat“ na adresu, kterou sami určíte. Já žádný e-mail neposílám.

## 1. Co od vás potřebuji (do konverzace jen adresy, nic tajného)

| Označení | Co to má být | K čemu |
|---|---|---|
| **A** | vaše skutečná adresa **bez** účtu ClearSpace, ke které máte přístup do schránky | nový člověk: pozvánka → registrace → potvrzovací e-mail → přijetí |
| **B** | adresa **s** existujícím účtem ClearSpace (jiná než vlastníka), nebo další vaše schránka | stávající uživatel: přihlášený přijme pozvánku |
| C *(volitelně)* | třetí adresa | opakované odeslání a zrušení pozvánky |

Doporučení: A a B nechte u **různých poskytovatelů** (např. Gmail a jiná schránka), ať je vidět chování spamových filtrů. Adresy musí patřit vám;
nikdy nepoužívejte cizí osoby ani fiktivní doménu (`example.*`, `.test`): server je záměrně neodesílá.

## 2. Připraveno (ověřeno 2026-11-25, `frontend/scripts/live-acceptance-preflight.sh`: PREFLIGHT OK)

* Produkce `dpl_7RtvpN81…` (commit `78c2b7b`), `/login` 200, `/api/ai/*` 403, anonymní volání trasy pozvánek 401.
* Vercel: 9 e-mailových proměnných (`SMTP_PASSWORD`, `EMAIL_SERVER_SECRET` jako Sensitive), žádná `EMAIL_ALLOW_RESERVED_DOMAINS`, žádný bypass secret.
* DNS: DKIM, odesílací CNAME `send.notify`, DMARC (`p=none`) publikovány.
* Supabase Auth: vlastní SMTP Resend, odesílatel `ucty@notify.luffast.com`, potvrzení e-mailu zapnuté, limit 30 e-mailů/h, česká šablona,
  přesměrování jen na `/accept-invite?token=*`; Realtime jen privátní.
* Databáze: migrace 1000 + 1100, otisk e-mailového tajemství, 0 pozvánek, 0 doručení (čistý základ; viz řádek `baseline` v preflightu).
* Limity: Resend zdarma 100 e-mailů/den a 3 000/měsíc, test spotřebuje asi 5–8; opětovné odeslání téže pozvánky nejdříve po minutě.
* Před startem znovu spusťte `frontend/scripts/live-acceptance-preflight.sh` (jen čte); musí skončit „PREFLIGHT OK“.

## 3. Příprava na vaší straně (2 minuty)

1. Přihlaste se jako vlastník do `https://clearspace-ai.vercel.app`.
2. Vytvořte nový projekt **„Akceptační test pozvánek“** s jedním sloupcem a dvěma úkoly (nepoužívejte demo projekty RUN 00 – ty zůstanou nedotčené).
3. Pošlete mi adresy A, B (C) a napište „spouštím“. Já spustím preflight a po každém vašem kroku read-only report (viz §5).

## 4. Postup testu

| # | Kdo | Krok | Očekávaný výsledek | Důkaz |
|---|---|---|---|---|
| 1 | vy (vlastník) | projekt → **Členové projektu** → e-mail A, role **Editor** → *Pozvat* | „Pozvánka odeslána na …“, v seznamu čekající pozvánka, „E-mail předán poštovnímu serveru (doručení do schránky nelze ověřit).“ | report: delivery `accepted`, transport `smtp` |
| 2 | vy | schránka A | e-mail od **ClearSpace <pozvanky@notify.luffast.com>** do 1–2 minut, česky, jméno zvoucího, projekt, role, platnost 7 dní, tlačítko/odkaz `https://clearspace-ai.vercel.app/accept-invite?token=…`; **ne ve spamu** | ruční kontrola |
| 3 | vy | v e-mailu *Zobrazit původní zprávu*: hlavičky | `SPF: PASS`, `DKIM: PASS` (`d=notify.luffast.com`), `DMARC: PASS` | ruční kontrola |
| 4 | vy | odkaz otevřít v anonymním okně, vyplnit e-mail A, jméno, heslo | stránka „Potvrďte svůj e-mail“ (účet zatím nepřijal pozvánku) | – |
| 5 | vy | schránka A | **potvrzovací e-mail Supabase** od `ucty@notify.luffast.com`, předmět „Potvrďte svůj účet ClearSpace“, česky; DKIM/SPF/DMARC PASS | ruční kontrola |
| 6 | vy | kliknout na potvrzení | návrat na stejnou pozvánku (`/accept-invite?token=…`); doplnit jméno → *Přijmout* | report: účet `confirmed`, pozvánka `accepted` |
| 7 | vy (A i vlastník současně) | A otevře projekt | A vidí úkoly; „také zde“ ukazuje oba; úkol/komentář jednoho se objeví druhému **bez obnovení** | vizuálně |
| 8 | vy | pozvat B jako **Čtenář**; B se přihlásí, otevře odkaz, přijme | B vidí projekt, **nemůže upravovat** (tlačítka zakázána); B se v projektu objeví okamžitě | report: B `viewer`, delivery `accepted` |
| 9 | vy | *Poslat znovu* hned a znovu po minutě (u C nebo u nepřijaté pozvánky) | hned: „Pozvánka byla právě odeslána. Zkuste to za minutu.“; po minutě nový e-mail, **starý odkaz přestane platit** | report: dvě doručení, starý token neplatný |
| 10 | vy | zrušit čekající pozvánku a otevřít její odkaz | „Tato pozvánka už byla použita nebo zrušena.“ | – |
| 11 | vy | odebrat A z projektu | A okamžitě ztratí přístup (otevřený projekt hlásí „nemáte přístup“), další změny už nedostane | report: A bez přístupu |
| 12 | vy | Resend → *Emails* | každá zpráva *Delivered*; žádný *Bounced*/*Complained* | ruční kontrola |

Hranice testu: pozvánky neposílejte nikomu jinému než na A, B, C; nic dalšího není potřeba měnit ani nastavovat.

## 5. Co dělám já během testu (jen čtu)

Po vašem pokynu spustím `frontend/scripts/live-acceptance-report.sh A B [C]` a porovnám výstup s očekávanými hodnotami v tabulce
(účet, pozvánky, pokusy o doručení, přístup k projektu; tokeny a hesla se nezobrazují). Také ověřím, že se nezměnil počet projektů, úkolů
ani dat RUN 00 (kromě testovacího projektu), a že firewall a nastavení zůstaly beze změny.

## 6. Když něco nevyjde

| Příznak | Co to znamená / co dělat |
|---|---|
| UI hlásí „Pozvánka je vytvořená, ale e-mail na … se nepodařilo odeslat. Odkaz můžete zkopírovat.“ | pozvánka existuje, odkaz lze předat ručně; report ukáže `error_code`: `smtp_535` = Resend odmítl klíč, `smtp_unreachable` = server nedostupný, `smtp_ambiguous` = server nepotvrdil převzetí (UI: „Server nepotvrdil převzetí e-mailu, mohl ale odejít…“). **Při `smtp_ambiguous` neposílejte znovu hned** – nejdřív zkontrolujte schránku a Resend → Emails (hrozí duplicita) |
| `smtp_535` | klíč `clearspace-production` ve Vercelu neplatí; vygenerujte nový a spusťte znovu `frontend/scripts/set-resend-keys.sh` |
| E-mail ve spamu | zaznamenat; v hlavičkách ověřit SPF/DKIM/DMARC (§4 krok 3). Zpřísnění DMARC až po několika týdnech |
| Potvrzovací e-mail Supabase nepřišel | Supabase → Authentication → Logs; ověřit limit 30/h a odesílatele `ucty@notify.luffast.com`; Resend → Emails |
| Pozvánka ukazuje špatný odkaz (localhost, jiná doména) | zastavit; `APP_BASE_URL` ve Vercelu musí být `https://clearspace-ai.vercel.app` (preflight to hlídá nepřímo); hlásit mi |
| Cokoli kritického | produkci lze vrátit podle PRODUCTION_ROLLOUT.md oddíl 6 (promote RC5 + rollback skripty); pro samotný e-mail stačí vypnout `EMAIL_TRANSPORT` ve Vercelu a znovu nasadit – aplikace pak předává pozvánky odkazem |

## 7. Úklid po testu

1. Ve Členech projektu odebrat A a B, **smazat projekt „Akceptační test pozvánek“** (kaskádově odstraní sloupce, úkoly, členství a pozvánky).
2. Účty A a B jsou skutečné účty na vašich adresách: ponechte, nebo mi napište a smažu je (admin API, po vašem potvrzení).
3. Spustit `frontend/scripts/live-acceptance-report.sh A B` (musí být bez pozvánek) a `live-acceptance-preflight.sh` (baseline: 17 projektů, 182 úkolů,
   0 pozvánek; počet účtů se vrátí na 2, pokud účty smažete).
4. Výsledek zapíšu do PRODUCTION_ROLLOUT.md §10 a commitnu.
