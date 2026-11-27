# RUN 09 – blok vlastníka 1/2: produkční přihlašovací údaje (~7 min, jednou)

Stávající aplikace a boti se **povyšují do produkce s rotací tajemství** – nic nového se nezakládá. Tajné hodnoty **nikdy do chatu**:
vkládají se jen do okna Terminálu, které otevřel Claude (`hub-prod.sh owner`) – vstup je skrytý a jde rovnou do macOS Keychain
(služby „ClearSpace V1 - Hub (production)“ a „ClearSpace V1 - Notify (production)“).

Už hotovo (Claude): produkce běží na kódu RUN 09 s vypnutým hubem, migrace 1600 + 1700 jsou v produkční DB, serverová tajemství
jsou nově vygenerovaná, servisní identita zaregistrovaná, **vývojový token Slack aplikace „ClearSpace Projekty“ je odvolán**.

## A. Slack – aplikace „ClearSpace Projekty“ (https://api.slack.com/apps)
1. **App Manifest** → nahraďte celý obsah souborem `docs/run09/slack-hub-manifest.prod-phase1.yaml` → **Save Changes**.
   (Odběr událostí přidáme v bloku 2 – Slack adresu ověřuje hned při uložení a produkce ji umí až po nasazení.)
   Výzvu „Reinstall your app“ ignorujte.
2. **Basic Information → App Credentials**: u **Client Secret** → **Regenerate**; u **Signing Secret** → **Regenerate**.

## B. Slack – aplikace „ClearSpace oznámení (dev)“ (osobní oznámení)
1. **App Manifest** → obsah `docs/run09/slack-personal-manifest.prod.yaml` → **Save Changes** (název bez „(dev)“, adresa produkce).
2. **Basic Information → App Credentials** → **Client Secret** → **Regenerate**.

## C. Telegram – @BotFather (https://t.me/BotFather)
`/revoke` → vyberte **@ClearSpaceRelayBot** → nový token. Totéž pro **@ClearSpaceHQBot** a **@ClearSpaceCortexBot**.
(Starý token tím přestane platit – vývojové prostředí ztratí přístup. Nic jiného v BotFather neměňte.)

## D. Terminál (okno otevřel Claude, nebo spusťte z `V1-run09/frontend`):
```bash
scripts/hub-prod.sh owner
```
Postupně vložte: Projekty – Client ID, Client Secret, Signing Secret · Oznámení – Client ID, Client Secret · Relay – token, jméno ·
HQ – token, jméno · Cortex – token, jméno. Na konci se samo spustí ověření (nové tokeny platí, staré jsou mrtvé, tajemství se liší od dev).

Pak napište do chatu **„blok hotový“**. Claude nasadí produkci s pilotem jen pro váš účet (~5 min) a pošle blok 2
(manifest s událostmi + propojení v aplikaci, ~10 min).

Cortex bude jen uložen – etapa 2 (Project Intelligence z chatů) zůstává vypnutá až do samostatného schválení.
