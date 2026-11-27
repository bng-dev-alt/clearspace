# RUN 08 – krok 2: aktivace a propojení (~15 min)

Prostředí běží: izolovaná aplikace se syntetickými daty, brána + tunel `cs-hub-live.luffast.com` (zvenku dostupné jen webhooky).
Přihlášení do testovací aplikace: **https://localhost:3472/?login=auto** (poprvé potvrďte lokální certifikát – „Pokračovat / Advanced → Proceed“).
Jste přihlášen jako syntetická vlastnice „Alice“ projektu **„Společný projekt“**.

## A. Telegram – PI bot
@BotFather → `/setprivacy` → vyberte **PI bota** → **Disable**. (Ostatní dva boti zůstávají beze změny.)

## B. Slack – druhá fáze manifestu projektové aplikace
https://api.slack.com/apps → **ClearSpace Projekty (dev)** → **App Manifest** → nahraďte celý obsah souborem
`docs/run08/slack-hub-manifest.yaml` → **Save Changes**. Slack ověří adresu událostí (má ukázat *Verified*).
Výzvu „Reinstall your app“ ignorujte – aplikace se nainstaluje z ClearSpace (krok C2).

## C. ClearSpace → Nastavení (ikona ozubeného kola / https://localhost:3472/settings)
1. **Oznámení mimo aplikaci** → *Připojit Slack* → v okně Slacku **Allow** → zpět v ClearSpace „Slack je připojený“.
   Pak *Připojit Telegram* → klikněte na odkaz na **osobního** bota → v Telegramu **Start** → zpět v ClearSpace **Ano, je to můj účet**.
2. **Slack a Telegram pro projekty** → **Nainstalovat do Slacku** → **Allow**.
3. *Propojit Slack účet* → zobrazí se kód → ve Slacku (kdekoli, třeba ve zprávě sobě) napište `/clearspace ucet KÓD`.
4. *Propojit Telegram účet* → **Otevřít Telegram** → **Start** (u **projektového** bota).

## D. Testovací místa
* Slack: veřejný kanál **#cs-test** a soukromý **#cs-test-priv**; v obou napište `/invite @ClearSpace Projekty`.
* Telegram: nová skupina **CS test** – přidejte **projektového** bota a **PI bota** (vy jste zakladatel skupiny).

## E. Propojení s projektem (ClearSpace → Společný projekt → ikona zástrčky „Integrace projektu“)
1. *Připojit Slack kanál* → kód → v **#cs-test** napište `/clearspace propojit KÓD` → v ClearSpace *obnovit* → **Potvrdit propojení**.
2. Totéž pro **#cs-test-priv**.
3. *Připojit Telegram skupinu* → kód → ve skupině **CS test** napište `/link@<uživatelské_jméno_projektového_bota> KÓD` → *obnovit* → **Potvrdit**.

Pak napište **„krok 2 hotový“**. Claude vše ověří v databázi a u poskytovatelů a pošle krátký seznam testovacích akcí (krok 3).
Když něco nejde, stačí napsat, ve kterém bodě – nic nemusíte opravovat sám.
