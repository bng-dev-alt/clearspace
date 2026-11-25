# ADR RUN 03 – Gmail: scopes, selection, data model, privacy

Status: **přijato pro MVP (lokálně, mock ověřeno)**, 2026-11-25. Větev `feature/run03-gmail` (základ `run02-complete` = `ca6cd29`).
Živé povolení u Googlu a veřejné publikování **nejsou** tímto rozhodnutím schválené (viz §5, `PRODUCTION_ROLLOUT.md`).

## 1. Ověřená fakta (oficiální dokumentace Google, ověřeno 2026-11-25)

| Fakt | Zdroj |
|---|---|
| `gmail.readonly`, `gmail.metadata`, `gmail.modify`, `gmail.compose`, `gmail.insert`, `gmail.settings.basic`, `https://mail.google.com/` = **restricted**; `gmail.send`, `gmail.addons.current.message.readonly/metadata` = sensitive; `gmail.labels`, `gmail.addons.current.message.action` = non-sensitive | developers.google.com/workspace/gmail/api/auth/scopes |
| `gmail.metadata` **nedovoluje** parametr `q` (vyhledávání) u `messages.list` / `threads.list` ani `format=full/raw` | reference users.messages.list, users.threads.list, Format |
| Žádný „Gmail Picker“ neexistuje (Google Picker nemá Gmail view); scopes `gmail.addons.current.*` fungují jen s tokenem z běhového prostředí Gmail add-onu, ne z běžné webové aplikace | Picker ViewId reference; workspace-scopes |
| Kvóty: `messages.list` 5 j., `messages.get` 20 j. (`full` 60), `threads.list` 10, `threads.get` 40 (`full` 120); 6 000 j./min/uživatel/projekt; `maxResults` ≤ 500 | gmail/api/reference/quota |
| Restricted scope + data přes server třetí strany ⇒ plné ověření aplikace **a každoroční bezpečnostní posouzení CASA** (Tier 2/3) | support.google.com/cloud/answer/13463817, restricted-scope-verification |
| Výjimky: osobní použití, < 100 uživatelů (s varováním „neověřená aplikace“), testování/vývoj, interní aplikace organizace Workspace | support.google.com/cloud/answer/13464323 |
| Režim *Testing*: ≤ 100 testovacích uživatelů, autorizace vyprší po 7 dnech; 100 refresh tokenů na účet a klienta; změna hesla ruší tokeny s Gmail scopes | support.google.com/cloud/answer/15549945, developers.google.com/identity/protocols/oauth2 |
| Limited Use: data jen pro uživatelské funkce; žádný přenos třetím stranám (kromě zákonných výjimek); žádné čtení lidmi bez souhlasu; zákaz použití k tréninku **obecných** AI modelů | developers.google.com/terms/api-services-user-data-policy, workspace-api-user-data-developer-policy |
| Inkrementální autorizace (`include_granted_scopes=true`): nový token pokrývá i dřív udělené scopes; uživatel může u granulárního souhlasu jednotlivé scopes odškrtnout | identity/protocols/oauth2/web-server |
| **Revokace ruší celý grant** (všechny scopes projektu); samostatné odvolání jednoho scope API neumožňuje (žádné takové API nenalezeno) | tamtéž |
| Odkaz na zprávu v Gmail webu podle API id **není oficiálně dokumentovaný** (`#all/<id>` je zavedená konvence; `/u/0/` je index účtu v prohlížeči) | — (UNVERIFIED jako oficiální) |
| Správci Workspace mohou aplikaci blokovat, omezit, nebo označit Gmail jako „restricted service“ / blokovat high-risk scopes | knowledge.workspace.google.com (API controls) |

## 2. Varianty

| Varianta | Scopes | Co umí | Soukromí / bezpečnost | Dopad na veřejné portfolio |
|---|---|---|---|---|
| **A – Ruční odkaz** (uživatel vloží odkaz/předmět) | žádné | nic neověří, metadata zadává člověk | žádná Google data; ale neověřitelný obsah (phishing odkaz) | bez omezení, ale malá hodnota |
| **B – Gmail add-on** (připojení z Gmailu) | `gmail.addons.current.message.*` (sensitive) | kontext jedné otevřené zprávy | nejužší přístup | samostatný produkt v Marketplace, mimo rozsah |
| **C – `gmail.metadata`** | restricted | jen hlavičky, **bez vyhledávání**, bez obsahu | stejná třída jako `readonly` | stejný audit jako D, menší užitek |
| **D – `gmail.readonly` + vlastní výběr v ClearSpace** | restricted | vyhledání, výběr, metadata, náhled pro vlastníka | jen čtení; server; tokeny šifrované; minimalizace dat (§4) | **veřejně jen po ověření + CASA**; do té doby Testing / ≤100 uživatelů / interně |

## 3. Rozhodnutí (MVP)

1. **Varianta D, jediný Gmail scope `https://www.googleapis.com/auth/gmail.readonly`** (+ `openid email`). Je to nejužší scope, který
   umožní vyhledávání (`q`) a náhled vybrané zprávy; `gmail.metadata` je restricted stejně a obojí znemožňuje. Nic dalšího
   (`modify`, `send`, `compose`, `labels`, `mail.google.com`) se nežádá; v kódu neexistuje žádné zapisující volání Gmail API.
2. **Inkrementální autorizace** na sdíleném Google připojení z RUN 02: Gmail se žádá samostatně (`service: 'gmail'`), jen když ho
   uživatel zapne; Drive se při tom neruší. Stav služeb se sleduje zvlášť (`google_connections.scopes` = co ClearSpace **používá**).
3. **Výběr e-mailů** = vlastní dialog ClearSpace (Google nic jako Picker nenabízí); vyhledávání běží na serveru tokenem uživatele,
   stránkovaně (≤ 20 položek, metadata). Žádná synchronizace schránky, žádné automatické připojování.
4. **Datový model**: znovupoužití `external_resource_links` (providers `gmail_message` / `gmail_thread`) pro **sdílená** metadata +
   nová soukromá tabulka `gmail_link_sources` (Gmail id, Google účet) bez jakéhokoli klientského přístupu. Důvod oddělení: RLS
   tabulky odkazů dává řádky všem členům projektu; Gmail id a příslušnost k účtu jsou soukromé a smí je použít jen server pro vlastníka.
5. **Privacy default** (detail `PRIVACY_AND_SECURITY.md`): členové vidí předmět, jméno odesílatele (nebo jen doménu), datum, počty;
   obsah čte **jen ten, kdo e-mail připojil, z vlastní schránky**. Události aktivity nenesou předmět.
6. **Project Intelligence**: jen kontrakt (`src/lib/resources/contract.ts`) – normalizovaný dokument s provenance a citačními kotvami,
   `trust: 'untrusted'`, `aiUse: 'not_consented'` + `assertAiUseAllowed()` vždy odmítne. Žádné volání AI.
7. **Feature switch** `GMAIL_INTEGRATION_ENABLED=1` (výchozí vypnuto), nezávislý na Drive i na grantu u Googlu.

## 4. Důsledky
* Veřejný portfolio nasazení **nesmí** tvrdit, že Gmail je dostupný komukoli, dokud neproběhne ověření + CASA. Realistické cesty:
  (a) Testing režim s ≤ 100 testery, (b) interní aplikace ve vlastní Workspace organizaci, (c) veřejně jen simulace jasně označená „simulace“.
* Revokaci nelze dělat po službách: „Vypnout Gmail“ v ClearSpace jen přestane Gmail používat; skutečné odvolání = odpojit celý účet Google (ukončí i Disk).
* Odkaz „Otevřít v Gmailu“ je best-effort (nedokumentovaná URL), jen pro vlastníka.

## 5. Výslovně odloženo (LATER)
Odesílání, reply/forward, koncepty, AI drafting, sumarizace, klasifikace, synchronizace/watch/Pub/Sub, stahování a import příloh,
sdílení obsahu e-mailu s týmem (snapshot), deduplikace stejné zprávy napříč schránkami (Message-ID), Calendar (RUN 04), produkční rollout.
