# ClearSpace V1 – spolupráce a pozvánky e-mailem: produkční nasazení (RUN 01C)

Stav: **připraveno, nic nebylo na produkci změněno.** Produkce byla jen čtena (SELECT a `pg_dump` v režimu jen pro čtení).
Každý krok, který mění produkci, DNS nebo účty, potřebuje vaše výslovné schválení (jedno souhrnné schválení je v oddílu 9).

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

## 3. Co musíte udělat vy (nic z toho nevkládejte do konverzace)

1. **Resend** (resend.com): založte účet → *Domains* → *Add Domain* `notify.luffast.com`, region **Ireland (eu-west-1)**.
   Záznamy přidejte v Cloudflare (nebo použijte Resend *Auto configure* pro Cloudflare) a počkejte na stav *Verified*.
2. **DNS** (Cloudflare, zóna `luffast.com`, záznamy „DNS only“): viz oddíl 4.
3. **API klíč**: Resend → *API Keys* → *Create*, název `clearspace-production`, oprávnění **Sending access**, doména `notify.luffast.com`.
   Uložte jen do správce hesel; použije se ve Vercelu a v Supabase.
4. **Serverové tajemství** (na svém počítači):
   ```bash
   openssl rand -hex 32
   ```
   Výsledek je `EMAIL_SERVER_SECRET` (jen do Vercelu, Sensitive). Jeho otisk pro databázi:
   ```bash
   printf %s 'SEM_VLOZTE_TAJEMSTVI' | shasum -a 256 | cut -d' ' -f1
   ```
5. **Vercel** (projekt ClearSpace, prostředí *Production*): proměnné z oddílu 5.
6. **Supabase Auth** (Dashboard → Authentication):
   * *Emails → SMTP Settings*: Enable custom SMTP; Sender email `ucty@notify.luffast.com`; Sender name `ClearSpace`; Host `smtp.resend.com`;
     Port `465`; Username `resend`; Password = API klíč Resend. Minimální interval nechte výchozí.
   * *Rate Limits*: e-maily za hodinu ponechte 30 (výchozí s vlastním SMTP).
   * *URL Configuration*: Site URL `https://clearspace-ai.vercel.app`; Redirect URLs přidejte `https://clearspace-ai.vercel.app/**`
     (potvrzovací odkaz vrací nového uživatele na `/accept-invite?token=…`; bez toho by se odkaz na pozvánku ztratil).
   * *Emails → Templates → Confirm signup* (volitelně česky): předmět `Potvrďte svůj účet ClearSpace`, text:
     `<p>Dobrý den,</p><p>pro dokončení registrace v ClearSpace potvrďte svou e-mailovou adresu:</p><p><a href="{{ .ConfirmationURL }}">Potvrdit e-mail</a></p><p>Pokud jste se neregistrovali, tento e-mail ignorujte.</p>`
7. Po schválení (oddíl 9) spusťte nebo nechte spustit rollout (oddíl 6) a dejte vědět skutečné testovací adresy pro oddíl 7.

## 4. DNS záznamy (Cloudflare, zóna `luffast.com`)

Přesné hodnoty DKIM zobrazí Resend po přidání domény; tvar záznamů je tento:

| Typ | Název | Hodnota | Pozn. |
|---|---|---|---|
| TXT | `resend._domainkey.notify` | `p=MIGfMA0…` (veřejný klíč DKIM z Resend) | podpis zpráv |
| MX | `send.notify` | `feedback-smtp.eu-west-1.amazonses.com`, priorita 10 | návratová adresa/odrazy |
| TXT | `send.notify` | `v=spf1 include:amazonses.com ~all` | SPF pro návratovou adresu |
| TXT | `_dmarc` | `v=DMARC1; p=none;` | DMARC pro `luffast.com` i subdomény; zatím jen sledování |

Stávající záznamy `luffast.com` (MX Cloudflare Email Routing, SPF, `cf2024-1._domainkey`, `microcrm`, `basedemo`, …) se **nemění**.
DMARC lze po několika týdnech bezproblémového provozu zpřísnit na `p=quarantine`.

## 5. Proměnné prostředí (Vercel, Production) – bez tajných hodnot

| Proměnná | Hodnota | Typ |
|---|---|---|
| `EMAIL_TRANSPORT` | `smtp` | běžná |
| `SMTP_HOST` | `smtp.resend.com` | běžná |
| `SMTP_PORT` | `465` | běžná |
| `SMTP_SECURITY` | `tls` | běžná |
| `SMTP_USER` | `resend` | běžná |
| `SMTP_PASSWORD` | API klíč Resend | **Sensitive** |
| `EMAIL_FROM` | `ClearSpace <pozvanky@notify.luffast.com>` | běžná |
| `EMAIL_REPLY_TO` | nenastavovat (volitelně adresa, kterou chcete ukázat pozvaným) | běžná |
| `APP_BASE_URL` | `https://clearspace-ai.vercel.app` | běžná |
| `EMAIL_SERVER_SECRET` | výstup `openssl rand -hex 32` | **Sensitive** |

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
   CONFIRM_COLLAB=twjlnsxjtuntujarwner EMAIL_SERVER_SECRET_SHA256=<otisk z kroku 3.4> frontend/scripts/apply-collab-hosted.sh
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
2. Účet Resend, ověřená doména `notify.luffast.com` (DNS z oddílu 4) a API klíč – jen vy.
3. Vercel proměnné a Supabase Auth SMTP/URL nastavení – jen vy (nebo já, pokud to schválíte a hodnoty zadáte sami v dashboardu).
4. Hostovaná izolace kanálů a doručení skutečných e-mailů ověřené až po nasazení (oddíly 6.4, 6.6, 7). Do té doby není produkční připravenost ověřená.

## 9. Souhrnná žádost o schválení

> Schvaluji pro `twjlnsxjtuntujarwner` / `clearspace-ai.vercel.app`: (1) staged build větve `feature/run01-collaboration`;
> (2) spuštění `frontend/scripts/apply-collab-hosted.sh` (záloha `public`, migrace 1000 a 1100, registrace otisku e-mailového tajemství);
> (3) smoke test na staged nasazení a jeho promote; (4) vypnutí „Allow public access“ v Realtime; (5) živý test pozvánek na adresy
> A = ________, B = ________ (případně C = ________); (6) [volitelně] založení a smazání dvou jednorázových testovacích účtů pro `hosted-verify.sh`.
> Resend, DNS, Vercel proměnné a Supabase Auth SMTP nastavím sám/sama podle oddílů 3–5.
