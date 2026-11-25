# ClearSpace V1 – spolupráce a pozvánky e-mailem: produkční nasazení (RUN 01C)

Stav (2026-11-25): **nasazeno na produkci a ověřeno** – záznam a výsledky v oddílu 10. Zbývá živý test s vašimi skutečnými adresami (oddíl 7).
Oddíly 1–9 zůstávají jako postup a podklad pro případný rollback (oddíl 6).

## 1. Zjištěný stav (2026-11-24, jen čtení)

| Položka | Zjištění |
|---|---|
| Web | `https://clearspace-ai.vercel.app` (RC5, `dpl_HHk26E8s`, commit `12f7738`) |
| Supabase | projekt `twjlnsxjtuntujarwner`, migrace 0100–0900 (8 značek), schéma `public` **shodné** s nacvičeným stavem 0900 (rozdíl jen v zobrazení `auth.uid()` a v triggerech služby Supabase Storage) |
| Data | 17 projektů (14 demo RUN 00 + 3 skutečné), 182 úkolů, 42 komentářů, 89 členství (75 editor, 14 vlastník), 13 členů workspace (11 demo bez účtu, všechny s `example.*`), 2 účty, 0 pozvánek |
| Auth | registrace zapnuté, **potvrzení e-mailu zapnuté**, odesílá výchozí poštovní služba Supabase (jen členům týmu projektu, 2 e-maily/h) |
| Realtime | veřejné kanály povolené (anonymní připojení k veřejnému kanálu prošlo), privátní kanály vyžadují přihlášení |
| Oprávnění | role `postgres` není superuser, ale smí vytvářet politiky na `realtime.messages` (`supautils.policy_grants`), `realtime.send()` existuje |
| Doména `luffast.com` | DNS u Cloudflare (váš účet), **Cloudflare Email Routing** (jen příjem), SPF `include:_spf.mx.cloudflare.net`, DMARC **chybí**, žádná odesílací služba |
| Ostatní projekty | žádný existující poskytovatel transakčních e-mailů (WebAdviser má jen zakomentovaný příklad SendGrid, MicroCRM nic) |

## 2. Doporučený poskytovatel: Resend (bezplatný tarif) na subdoméně `notify.luffast.com`

Proč:
* **Zdarma** pro tento objem: 3 000 e-mailů měsíčně, max. 100 denně, 1 doména (ověřte aktuální podmínky na resend.com/pricing). Pozvánky
  a potvrzení účtů jsou desítky měsíčně.
* Jeden poskytovatel pro **obojí**: pozvánky z ClearSpace i e-maily Supabase Auth (potvrzení účtu, obnova hesla). SMTP `smtp.resend.com`.
* Domény ověřuje přes DNS (DKIM + SPF na samostatné subdoméně), umí záznamy u Cloudflare doplnit sám.
* Subdoména `notify.luffast.com` odděluje pověst odesílání od hlavní domény a nekoliduje s Cloudflare Email Routing na `luffast.com`.

Zvažované a nezvolené:
* **Cloudflare Email Service** (znovupoužití existujícího účtu, SMTP `smtp.mx.cloudflare.net:465`): odesílání je jen v placeném plánu
  Workers Paid (cca 5 USD měsíčně) – placenou službu bez vašeho souhlasu nezavádím. Je to rozumná alternativa, pokud ten plán už máte nebo ho chcete.
* Brevo (zdarma 300/den) – funguje také, ale vyžaduje firemní údaje a více nastavení. Amazon SES – levný, ale vyžaduje AWS účet a žádost o produkční přístup.
* Výchozí poštovní služba Supabase – posílá jen členům týmu projektu, nová pozvaná osoba by si **nemohla potvrdit účet**.

## 3. Stav konfigurace (2026-11-25) a co zbývá vám

**Hotovo (ověřeno zpětným čtením, bez vypsání tajemství):**
* Resend: účet, doména `notify.luffast.com` *Verified* (Ireland), klíče `clearspace-production` a `clearspace-supabase-auth`
  (Sending access, jen tato doména) – založil vlastník.
* Vercel, projekt `clearspace` (tým `bng-dev-alt`, obsluhuje `clearspace-ai.vercel.app`), *Production*: `EMAIL_TRANSPORT`, `SMTP_HOST`,
  `SMTP_PORT`, `SMTP_SECURITY`, `SMTP_USER`, `EMAIL_FROM`, `APP_BASE_URL` (hodnoty v oddílu 5) a `EMAIL_SERVER_SECRET` (Sensitive).
  Žádné duplicity, žádná `NEXT_PUBLIC_*` e-mailová proměnná. Projeví se až dalším nasazením.
* `EMAIL_SERVER_SECRET` je uložené v Keychainu: služba `ClearSpace V1 – EMAIL_SERVER_SECRET`, účet `clearspace production`.
  Otisk pro migraci se z něj odvodí příkazem v oddílu 6, krok 3 (hodnota se nikam nekopíruje).
* Supabase Auth (`twjlnsxjtuntujarwner`): Site URL `https://clearspace-ai.vercel.app` (beze změny); Redirect URLs zúženy z
  `https://clearspace-ai.vercel.app/**` na **`https://clearspace-ai.vercel.app/accept-invite?token=*`** – jediná cesta, kterou aplikace
  posílá jako `emailRedirectTo` (registrace z pozvánky). Běžná registrace používá Site URL, obnova hesla v aplikaci není.
  Pozn.: GoTrue povoluje každou adresu na hostiteli Site URL, seznam je tedy pojistka pro případ změny Site URL.
  Návrat: `uri_allow_list` = `https://clearspace-ai.vercel.app/**`.
* Přihlášení k `smtp.resend.com:465` ověřeno (TLS s ověřením certifikátu; neplatný klíč server odmítne kódem 535).

**Zbývá vám:**
1. Spusťte v Terminálu (z kořene repozitáře) a do skrytých výzev vložte oba klíče:
   ```bash
   frontend/scripts/set-resend-keys.sh
   ```
   Skript každý klíč nejprve ověří přihlášením k SMTP **bez odeslání e-mailu**, pak: `clearspace-production` → Vercel `SMTP_PASSWORD`
   (Sensitive, Production); `clearspace-supabase-auth` → Supabase Auth vlastní SMTP (`smtp.resend.com`, 465, `resend`,
   odesílatel `ClearSpace <ucty@notify.luffast.com>`, limit 30 e-mailů/h místo 2). Výsledek vypíše bez tajemství.
   Vlastní SMTP v Supabase začne platit hned (potvrzovací e-maily nově dorazí i mimo členy organizace Supabase).
2. Cloudflare → `luffast.com` → DNS → přidat TXT `_dmarc.notify`, hodnota `v=DMARC1; p=none;` (oddíl 4).
3. Volitelně česká šablona *Authentication → Emails → Confirm signup*: předmět `Potvrďte svůj účet ClearSpace`, text:
   `<p>Dobrý den,</p><p>pro dokončení registrace v ClearSpace potvrďte svou e-mailovou adresu:</p><p><a href="{{ .ConfirmationURL }}">Potvrdit e-mail</a></p><p>Pokud jste se neregistrovali, tento e-mail ignorujte.</p>`
4. Schválení (oddíl 9) a skutečné testovací adresy pro oddíl 7.

## 4. DNS záznamy (Cloudflare, zóna `luffast.com`) – skutečný stav 2026-11-25

| Typ | Název | Hodnota | Stav |
|---|---|---|---|
| TXT | `resend._domainkey.notify` | `p=MIGfMA0GCSqGSIb3…` (DKIM Resend) | ✅ publikováno |
| CNAME | `send.notify` | `send.forge.rmta.net` (MX + SPF návratové adresy Resend) | ✅ publikováno |
| CNAME | `rsend.notify` | `rsend-euw1.forge.rmta.net` | ✅ publikováno |
| TXT | `_dmarc.notify` | `v=DMARC1; p=none;` | ❌ **chybí – přidat** |

Všechny záznamy „DNS only“ (bez proxy). DMARC je jen pro odesílací subdoménu, `luffast.com` (Email Routing, SPF, DKIM Cloudflare)
se **nemění**; `_dmarc.luffast.com` neexistuje. Po několika týdnech bez problémů lze zpřísnit na `p=quarantine`.

## 5. Proměnné prostředí (Vercel, Production) – bez tajných hodnot

| Proměnná | Hodnota | Typ |
|---|---|---|
| `EMAIL_TRANSPORT` | `smtp` | běžná |
| `SMTP_HOST` | `smtp.resend.com` | běžná |
| `SMTP_PORT` | `465` | běžná |
| `SMTP_SECURITY` | `tls` | běžná |
| `SMTP_USER` | `resend` | běžná |
| `SMTP_PASSWORD` | klíč Resend `clearspace-production` – nastaví `set-resend-keys.sh` | **Sensitive** |
| `EMAIL_FROM` | `ClearSpace <pozvanky@notify.luffast.com>` | běžná |
| `EMAIL_REPLY_TO` | nenastavovat (volitelně adresa, kterou chcete ukázat pozvaným) | běžná |
| `APP_BASE_URL` | `https://clearspace-ai.vercel.app` | běžná |
| `EMAIL_SERVER_SECRET` | nastaveno 2026-11-25 (Keychain `ClearSpace V1 – EMAIL_SERVER_SECRET`) | **Sensitive** |

**Nikdy** nenastavujte `EMAIL_ALLOW_RESERVED_DOMAINS` ani žádnou z nich jako `NEXT_PUBLIC_*`. Bez proměnných aplikace funguje dál, jen pozvánky předává odkazem.

## 6. Postup nasazení

Nácvik na kopii produkčních dat (dočasný lokální kontejner, smazán): obě migrace jako role `postgres` (bez superuser) proběhly
za 0,1 s každá, počty řádků beze změny, demo data RUN 00 `verify` bez chyb a opakovaný `dry-run` nepřidal nic, rollback 1100 → 1000
vrátil katalog přesně na stav 0900. Stejný skript `frontend/scripts/apply-collab-hosted.sh` prošel nácvikem celý.

1. **Příprava (bez dopadu na uživatele):** oddíly 3–5 hotové, doména v Resend *Verified*. Commit větve je čistý.
   Připravte produkční build větve `feature/run01-collaboration` jako *staged* nasazení (bez přiřazení domény) – jen build, nepromovat.
2. **Krátké okno (oznámit):** RC5 po migraci nemá živé aktualizace a zápis historie úkolu z RC5 databáze odmítne
   (RC5 ukáže chybový pruh „uložení aktivity“, data úkolu se uloží). Okno = kroky 3–5, cíl do 15 minut. RUN 00 v té době nesmí zapisovat.
3. **Migrace + záloha + kontrola** (jedním skriptem; zastaví se před zápisem, pokud cokoli nesedí):
   ```bash
   CONFIRM_COLLAB=twjlnsxjtuntujarwner \
   EMAIL_SERVER_SECRET_SHA256=$(security find-generic-password -s 'ClearSpace V1 – EMAIL_SERVER_SECRET' -w | tr -d '\n' | shasum -a 256 | cut -d' ' -f1) \
   frontend/scripts/apply-collab-hosted.sh
   ```
   Skript: ověří checksumy, značky 0100–0900, katalog = nacvičený stav, oprávnění pro Realtime → udělá `pg_dump` schématu `public`
   do `/Volumes/WORKSPACE/_G2_BACKUP/<datum>-v1-pre-collab/` se SHA256SUMS → aplikuje 1000 a 1100 (každou v jedné transakci) →
   ověří počty řádků, značky, politiky Realtime, prázdnou publikaci, klíče kanálů → zaregistruje otisk tajemství.
4. **Smoke na staged nasazení** (dvě okna, vlastní dva účty): přihlášení; otevření projektu; úkol vytvořený v jednom okně se objeví
   v druhém; komentář s @zmínkou → zvonek; „také zde“ ukazuje oba; dialog *Členové projektu* se otevře. `scripts/hosted-verify.sh`
   (obsahuje `realtime_check.mjs`) s jednorázovými účty, jen pokud jejich založení schválíte.
5. **Promote** staged nasazení na produkci.
6. **Realtime → Settings → „Allow public access“ vypnout** (jen privátní kanály). Až po promote – nová verze veřejné kanály nepoužívá.
   Ověření: anonymní připojení k veřejnému kanálu musí být odmítnuto.
7. **Živý test pozvánek** (oddíl 7).

**Rollback** (kdykoli; data se neztratí):
1. Vercel: promovat zpět RC5 (`dpl_HHk26E8s`).
2. Jako `postgres`, v jedné transakci každý: `frontend/supabase/rollback/20261125001100_collab_hardening.down.sql`, pak
   `frontend/supabase/rollback/20261124001000_collaboration.down.sql`. Skripty odmítnou běžet, pokud by zahodily historii úprav
   komentářů, záznamy o doručení nebo role Správce/Čtenář (vyřešit, nebo vědomě `SET clearspace.rollback_allow_data_loss = 'on'`).
   Rollback vrací publikaci `postgres_changes`, takže RC5 má znovu živé aktualizace.
3. Realtime „Allow public access“ zapnout zpět jen pokud ho RC5 potřebuje (živé aktualizace RC5 běží přes veřejný kanál).
4. Ve Vercelu odstranit e-mailové proměnné; v Supabase vypnout vlastní SMTP jen pokud to chcete (neškodí).
5. Záloha z kroku 3 je v `_G2_BACKUP`; obnova z ní jen při poškození dat (`pg_restore --data-only` do čistého stavu po rollbacku).

## 7. Živý akceptační test pozvánek (po promote, jen na vámi zadané adresy)

Potřebuji dvě vaše skutečné adresy: **A** (nemá účet ClearSpace) a **B** (už účet má, nebo si ho předem založí).

| # | Krok | Očekávaný výsledek |
|---|---|---|
| 1 | Vlastník: projekt → *Členové projektu* → pozvat A jako Editor | „Pozvánka odeslána na A“, stav *čeká*, „předán poštovnímu serveru“ |
| 2 | Schránka A | e-mail od `pozvanky@notify.luffast.com`, česky, jméno zvoucího, projekt, role, platnost 7 dní; odkaz `https://clearspace-ai.vercel.app/accept-invite?token=…`; ne ve spamu; v hlavičkách `dkim=pass`, `spf=pass`, `dmarc=pass` |
| 3 | A otevře odkaz bez přihlášení, vyplní e-mail, jméno, heslo | „Potvrďte svůj e-mail“ |
| 4 | Schránka A | potvrzovací e-mail Supabase od `ucty@notify.luffast.com`; odkaz vrátí na stejnou pozvánku |
| 5 | A dokončí přijetí | přistane v ClearSpace, vidí projekt a jeho úkoly |
| 6 | Vlastník a A současně v projektu | „také zde“ ukazuje oba; úkol/komentář jednoho se živě objeví druhému |
| 7 | Pozvat B jako Čtenář, B přijme přihlášený | B vidí projekt, nemůže upravovat |
| 8 | Poslat znovu pozvánku C (třetí adresa nebo A po zrušení) hned a po minutě | hned: „Zkuste to za minutu“; po minutě nový e-mail, starý odkaz neplatí |
| 9 | Zrušit čekající pozvánku a otevřít její odkaz | „Tato pozvánka už byla použita nebo zrušena.“ |
| 10 | Odebrat A z projektu | A okamžitě ztratí přístup („nemáte přístup“), další změny už nedostane |
| 11 | Resend → *Emails* | každá zpráva *Delivered*; žádný *Bounced* |

Lokálně tato cesta prošla (Mailpit místo skutečné schránky): `e2e/collaboration-01c-confirm.spec.ts` s potvrzováním e-mailu zapnutým.

## 8. Zbývající blokery

1. Vaše schválení (oddíl 9).
2. Oba klíče Resend zadané přes `frontend/scripts/set-resend-keys.sh` (Vercel `SMTP_PASSWORD`, Supabase Auth SMTP) – oddíl 3.
3. DMARC `_dmarc.notify` v Cloudflare – oddíl 4 (nebrání nasazení, zlepšuje doručitelnost).
4. Hostovaná izolace kanálů a doručení skutečných e-mailů ověřené až po nasazení (oddíly 6.4, 6.6, 7). Do té doby není produkční připravenost ověřená.

## 9. Souhrnná žádost o schválení

> Schvaluji pro `twjlnsxjtuntujarwner` / `clearspace-ai.vercel.app`: (1) staged build větve `feature/run01-collaboration`;
> (2) spuštění `frontend/scripts/apply-collab-hosted.sh` (záloha `public`, migrace 1000 a 1100, registrace otisku e-mailového tajemství);
> (3) smoke test na staged nasazení a jeho promote; (4) vypnutí „Allow public access“ v Realtime; (5) živý test pozvánek na adresy
> A = ________, B = ________ (případně C = ________); (6) [volitelně] založení a smazání dvou jednorázových testovacích účtů pro `hosted-verify.sh`.
> Resend, DNS, Vercel proměnné a Supabase Auth SMTP nastavím sám/sama podle oddílů 3–5.

## 10. Záznam nasazení (2026-11-25, schváleno vlastníkem)

**Časová osa (místní čas):** 07:55:19 start skriptu → 07:55:56 migrace 1000 + 1100 hotové (37 s včetně zálohy) → 07:57:47 promote.
Okno, kdy produkce běžela na staré verzi RC5 s novou databází: **asi 2 minuty**. Realtime „Allow public access“ vypnuto po promote.

| Krok | Výsledek |
|---|---|
| DNS | TXT `_dmarc.notify` = `v=DMARC1; p=none;` přidán (jediná změna DNS; ostatní záznamy nedotčeny); DKIM/odesílací záznamy Resend již byly |
| Supabase Auth | česká šablona *Confirm signup* (předmět „Potvrďte svůj účet ClearSpace“); vlastní SMTP Resend; redirect jen `…/accept-invite?token=*`; limit 30 e-mailů/h |
| Staged build | `dpl_7RtvpN81SKBk4UzMLA92G48g8kWc`, commit `78c2b7b`, z čistého `git archive`, bez aliasu; `check-deployment.sh` PASS (77 kontrol: hlavičky, 403 na `/api/ai/*`, bundle bez tajemství) |
| Záloha | `/Volumes/WORKSPACE/_G2_BACKUP/20261125-v1-pre-collab/public.dump` (316 kB, SHA-256 ověřen); firewall před rolloutem: `/Volumes/WORKSPACE/_G2_BACKUP/fw-before-collab-rollout.json` |
| Migrace | 1000 + 1100, každá v jedné transakci jako `postgres`; počty řádků beze změny; 2 značky, 2 politiky Realtime, prázdná publikace, každý projekt má klíč kanálu, 0 e-mailů v zrcadle řešitelů, 0 notifikací; otisk tajemství v `server_trust('email')` |
| Staged smoke | Realtime 9/9, UI 16/16 (jednorázové účty `@example.test`, po testu smazány) |
| Promote | produkce obsluhuje `dpl_7RtvpN81…`; `/api/ai/*` → 403 |
| Realtime | `private_only` null → **true** (ostatní hodnoty beze změny); anon i přihlášený: veřejný kanál odmítnut; privátní téma funguje; presence funguje (dvě relace vidí obě) |
| Produkce po promote | `check-deployment.sh` PASS; `hosted-verify.sh` 16/16 + Realtime 9/9 (první běh: 1 test spadl na síťovém `ConnectTimeoutError`, opakování bez změny kódu prošlo); `hosted-collab-accept.sh` PASS (pozvánka → přijetí přihlášeným pozvaným → přístup → živý úkol → presence → použitý odkaz neplatí → odebrání ruší přístup) |
| Pozvánka přes živou trasu | adresa `@example.test` → `suppressed` (e-mail se neodesílá); anonym 401; špatné serverové tajemství → 42501 `Tato operace je vyhrazena serveru.`; tajemství ve Vercelu odpovídá otisku v DB |
| Data | po všech testech shodné počty jako před migrací (17 projektů, 182 úkolů, 89 členů projektů, 42 komentářů, 297 záznamů historie, 2 uživatelé, 0 pozvánek); RUN 00 `verify`: všech 10 tabulek present = expected, integrita 0, cizí vlastnictví 0; české názvy úkolů zachovány (175 z 182 obsahuje diakritiku) |
| Bezpečnost | všechny tabulky `public` mají RLS; `anon` nemá žádná práva k tabulkám `public`; serverové funkce (`email_delivery_*`, `stt_*`) nejsou pro `anon`; Realtime politiky: jen `clearspace_topic_read` a `clearspace_topic_presence_write` pro `authenticated` |
| Firewall | shodný s pořízeným stavem před rolloutem (jediné pravidlo `Block legacy AI API`, `/api/ai` deny); `ssoProtection` beze změny |

**Nedělal se skutečný e-mail ven.** Všechny testovací adresy byly `@example.test` (potlačeno serverem), Supabase Auth neposlal žádné potvrzení.

**Zbývá / rizika:**
1. ~~Bypass secret ve Vercelu~~ **vyřešeno 2026-11-25 (schváleno vlastníkem):** secret z 23. 11. (jeho hodnota se omylem vypsala do sezení) byl zrušen **bez náhrady** –
   nic trvale na něm nezávisí (skripty ho berou z proměnné při spuštění, v projektu není žádná proměnná `*BYPASS*`). Ověřeno: před zrušením `200`, po zrušení
   `302` na chráněné URL s původní hodnotou; v projektu 0 bypass secretů; produkce 200, firewall shodný, `ssoProtection` beze změny, `check-deployment.sh` 77/77.
   Další staged smoke si vyžádá nový dočasný secret (po testu zrušit).
2. Živý akceptační test se skutečnými adresami (oddíl 7; návod a nástroje: [LIVE_ACCEPTANCE_TEST.md](LIVE_ACCEPTANCE_TEST.md)) – čeká na vaše adresy. Doručení skutečného e-mailu, hlavičky `dkim/spf/dmarc=pass`
   a potvrzovací e-mail Supabase přes Resend zatím nebyly ověřeny. Pozn.: předmět potvrzovacího e-mailu je teď česky („Potvrďte…“).
3. Git: změny jsou jen lokálně ve větvi `feature/run01-collaboration` (commit + tag); nebylo pushováno ani mergováno do `main`. Plán konsolidace: [MAIN_CONSOLIDATION_PLAN.md](MAIN_CONSOLIDATION_PLAN.md). Produkce běží z buildu
   commitu `78c2b7b`, nasazeného přímo přes CLI. Merge do `main` (a případný push) čeká na vaše rozhodnutí.
4. Rollback (oddíl 6) zůstává připraven; záloha a rollback skripty jsou beze změny.
