# RUN 09 – blok vlastníka 2/2: jen přihlášení (~3 min), zbytek dělá Claude

Produkce už běží s pilotem jen pro účet vlastníka (`dpl_54myMw9f…`, 142/142 kontrol, nepilotní účet dostane 403 na všech routách),
webhook Relay a plánovače jsou zapnuté. Claude in Chrome není připojený a ve vestavěném prohlížeči (panel v aplikaci Claude,
Cmd+Shift+B) chybí přihlášení – proto jediný ruční krok jsou přihlášení. Žádné heslo ani kód do chatu.

V panelu prohlížeče jsou připravené tři záložky:
1. **Slack** (`app.slack.com`) – přihlaste se do workspace, kde má běžet pilot (BNG Workspace).
2. **Telegram Web** (`web.telegram.org`) – telefon → Nastavení → Zařízení → Připojit zařízení → naskenovat QR.
3. **ClearSpace** (`clearspace.luffast.com`) – je tam přihlášen prezentační účet (luf…). Odhlaste ho a přihlaste se **svým** účtem
   (mic…@gmail.com). Prezentační účet tím v tomto prohlížeči jen odhlásíte, nic se nemaže.

Pak „přihlášeno“. Claude sám: manifest s událostmi, testovací projekt, kanál `#cs-prod-pilot` a skupina „CS prod pilot“, propojení
přes párovací box, úkoly, komentáře, oznámení, připomínky, odpojení/připojení. Na vás zbudou jen tlačítka **Allow** u OAuth Slacku
(instalace projektové aplikace + osobní oznámení) – na ty Claude upozorní ve chvíli, kdy budou na obrazovce.
