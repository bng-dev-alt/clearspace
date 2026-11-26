# RUN 07B – jediný owner block (osobní oznámení RUN 05 + projektový hub RUN 07)

Vše ostatní (stack, brána, tunel, webhooky, konfigurace aplikace, testy) je připravené a spouští se jedním příkazem. **Tajemství nikdy
do konverzace** – jen do skrytých výzev skriptů (uloží se do macOS Keychain). Produkce se v tomto bloku nemění.

## A. Rozdíl: nastavení u poskytovatele × běžný uživatel
* **Nastavení u poskytovatele (jednou, vlastník)**: vytvořit Slack aplikace a Telegram boty (kroky B1–B4). Běžný uživatel tohle nikdy nedělá.
* **Běžný uživatel (onboarding, vždy v ClearSpace)**: Nastavení → *Propojit Slack/Telegram účet* (kód → poslat z chatu); správce projektu:
  Projekt → *Integrace* → *Připojit kanál/skupinu* (kód → `/clearspace propojit KÓD` / `/link@bot KÓD`) → *Potvrdit*.

## B. Kroky vlastníka (cca 20 min)
1. **Telegram (@BotFather)** – tři boti, každý `/newbot`:
   * osobní oznámení (RUN 05) – nic dalšího;
   * **projektový** bot – privacy nechat **zapnuté** (výchozí);
   * *volitelně* **PI bot** – `/setprivacy` → vybrat bota → **Disable** (jen pro čtení celé skupiny).
   Pak v Terminálu: `frontend/scripts/notify-live.sh set-telegram` (osobní), `frontend/scripts/hub-live.sh set-telegram` (projektový),
   `frontend/scripts/hub-live.sh set-pi` (volitelný PI bot).
2. **Veřejná HTTPS adresa jen pro webhooky** – doporučeno pojmenovaný tunel (stabilní adresa):
   Cloudflare Zero Trust → Networks → Tunnels → *Create a tunnel* (Cloudflared) → Public hostname např. `hub-dev.<vaše doména>` → Service
   `http://127.0.0.1:3473` → zkopírovat token → `frontend/scripts/hub-live.sh set-tunnel`.
   *(Bez tohoto kroku skript zkusí dočasný quick tunel – Cloudflare ho ale může omezit, viz PROVIDERS.md §3.)*
3. **Slack – dvě aplikace** (api.slack.com → Create New App → *From a manifest* → váš testovací workspace):
   * osobní: manifest `docs/run07b/slack-personal-manifest.yaml` → Basic Information → `frontend/scripts/notify-live.sh set-slack`;
   * projektová: manifest z `HUB_PUBLIC_URL=https://hub-dev.<doména> frontend/scripts/hub-live.sh manifest` →
     `frontend/scripts/hub-live.sh set-slack` (Client ID, Client Secret, **Signing Secret**).
4. **Spuštění**: `HUB_PUBLIC_URL=https://hub-dev.<doména> frontend/scripts/hub-live.sh app` (stack, brána, tunel, Telegram webhooky,
   aplikace). Otevřít `https://localhost:3472/?login=auto` (jednou přijmout lokální certifikát).
5. **OAuth souhlasy v aplikaci** (vlastník, v prohlížeči): Nastavení → *Oznámení mimo aplikaci* → Připojit Slack (osobní) a Telegram (osobní);
   Nastavení → *Slack a Telegram pro projekty* → **Nainstalovat do Slacku**; → *Propojit Slack účet* a *Propojit Telegram účet*.
6. **Testovací místa**: ve Slacku veřejný kanál `#cs-test` a soukromý `#cs-test-priv` (pozvat `@ClearSpace Projekty`); v Telegramu skupina
   „CS test“ (přidat projektového bota, volitelně PI bota). V ClearSpace syntetický projekt „Společný projekt“ (alice = vy přes `?login=auto`) → Integrace →
   připojit oba kanály i skupinu → potvrdit.
7. Napsat mi „**live připraveno**“. Dál běžím sám: `hub-live.sh gate`, kontroly v DB a u poskytovatelů, plánovač, odpojení, revokace.
   Kde je potřeba lidská akce v chatu, pošlu **jeden** krátký seznam (cca 8 akcí: zpráva v kanálu, zkratka „Vytvořit úkol“, odpověď ve vlákně,
   `/task` v Telegramu, odpověď botovi, odebrání bota, odinstalace aplikace, archivace kanálu).

## C. Jeden účet × druhý účet
| Scénář | 1 účet vlastníka stačí? |
|---|---|
| A1–A4, A7–A13, A15–A19, A21–A24, osobní oznámení RUN 05, revokace, odpojení | **ano** (druhé ClearSpace účty jsou syntetické ve stacku) |
| Telegram `/link` od ne-správce skupiny (A3/R6), neověřený autor ve vlákně (A15), čtenář zkouší `/task` (A14) | potřebuje **druhý chat účet** (Slack: druhý uživatel workspace; Telegram: druhé číslo). Bez něj = živě NOT VERIFIED, pokryto simulací |
| Ostatní testy | nečekají na druhý účet |

## D. Volitelné
* **AI s malým rozpočtem** (A25 živě): lokální stack nemá klíč Gemini (AI selže uzavřeně). Pokud chcete živý test izolace kontextu a
  prompt-injection, uložte dev klíč do Keychainu a schvalte strop (např. 20 000 tokenů); jinak zůstane NOT VERIFIED živě.
* **Úklid** (jeden seznam ke schválení): kontejner `clearspace-v1-t95` (RUN 05, zastavený, syntetická data) a stack `cs-notify-sb`
  (data ve volumes; sdílený RUN 05 + 07 – doporučuji ponechat do živé akceptace).
