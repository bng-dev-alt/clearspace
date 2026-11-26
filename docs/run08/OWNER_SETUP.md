# RUN 08 – nastavení pro živý test (jedna session, ~20 min)

Tajné hodnoty **nikdy do chatu** – vkládáte je jen do okna Terminálu, které otevřel Claude (`hub-live.sh setup`): text se nezobrazuje
a ukládá se rovnou do macOS Keychain. Vše ostatní (stack, tunel, webhooky, aplikace, testy) běží automaticky.

Pracuje se jen s **testovacími** aplikacemi a syntetickým projektem v izolovaném lokálním prostředí. Produkce ani pilot RUN 06 se nemění.

## Část 1 – vytvořit boty a aplikace

### A. Cloudflare – token tunelu (Claude tunel už vytvořil: `clearspace-hub-live` → `cs-hub-live.luffast.com`)
1. Otevřete https://one.dash.cloudflare.com/ → **Networks → Tunnels** → `clearspace-hub-live` → **Configure** (nebo ⋯ → Configure).
2. V části *Install and run a connector* zkopírujte dlouhý řetězec za `cloudflared service install` (jen token, bez příkazu).
   **Nic neinstalujte** – tunel spustí Claude jen po dobu testu.
3. Vložte do Terminálu u výzvy *Tunnel token*.

### B. Telegram (aplikace Telegram → chat **@BotFather**, https://t.me/BotFather)
1. `/newbot` → jméno `ClearSpace oznámení (dev)` → uživatelské jméno např. `cs_oznameni_<vaše_iniciály>_bot` → token vložte u výzvy *Personal bot*.
2. `/newbot` → jméno `ClearSpace projekty (dev)` → např. `cs_projekty_<iniciály>_bot` → token u výzvy *Project bot*.
   **Režim soukromí nechte zapnutý** (výchozí – nic neměňte).
3. *(volitelné)* `/newbot` → `ClearSpace PI čtení (dev)` → např. `cs_pi_<iniciály>_bot`; pak `/setprivacy` → vyberte tohoto bota → **Disable**.
   Tento bot jen čte celou skupinu pro Project Intelligence a nikdy nic nepíše. Chcete-li ho vynechat, u výzvy dejte jen Enter.

### C. Slack (doporučeno: samostatný testovací workspace – https://slack.com/get-started#/createnew)
1. https://api.slack.com/apps?new_app=1 → **From a manifest** → vyberte testovací workspace → vložte obsah
   `docs/run08/slack-personal-manifest.yaml` → Create. V **Basic Information → App Credentials** zkopírujte *Client ID* a *Client Secret*
   do výzvy *Slack PERSONAL app*.
2. Znovu **From a manifest** → vložte `docs/run08/slack-hub-manifest-phase1.yaml` → Create. Z *Basic Information* zkopírujte *Client ID*,
   *Client Secret* a **Signing Secret** do výzvy *Slack PROJECT app*.
   (Odběr událostí přidáme v části 2 – Slack ho při vytvoření ověřuje a aplikace mu odpoví až po uložení Signing Secret.)

Až Terminál napíše `== done`, napište do chatu **„krok 1 hotový“**. Claude spustí prostředí a ověří ho zvenku.

## Část 2 – po spuštění prostředí (pošle Claude, ~10 min)
Vložení plného manifestu (události), přihlášení do testovací aplikace jedním odkazem, propojení Slacku a Telegramu (OAuth), testovací kanály
a skupina, a krátký seznam akcí ve Slacku a Telegramu.

## Co dělá Claude bez vás
Spouští stack, bránu, tunel a aplikaci; nastavuje Telegram webhooky; ověřuje zvenku, že je dostupných jen 5 webhookových cest; kontroluje
režim soukromí botů, oprávnění Slack aplikace, data v databázi a doručení; po testu webhooky zruší a vše zastaví.
