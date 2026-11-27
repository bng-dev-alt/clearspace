# Communication Hub – finální UX polish backlog (z živých testů RUN 08 / 08B)

Mimo rozsah RUN 08B (žádné nové funkce). Pořadí = doporučená priorita.

| # | Položka | Zdroj | Poznámka k řešení |
|---|---|---|---|
| 1 | **Kompletní redesign stránky Propojené účty** (Nastavení: osobní oznámení RUN 05, Slack/Telegram pro projekty, identity) | vlastník | jedna přehledná stránka: co je připojené, k čemu, jak odpojit; stejný vzor pro osobní i projektové integrace |
| 2 | **Výraznější potvrzení úspěšného připojení** | vlastník | po samočinné detekci (párovací box) velký stav „Propojeno ✓ #kanál / skupina“ místo jednořádkové zprávy; totéž po instalaci Slack aplikace a propojení účtu |
| 3 | **Ruční kopírování Telegram příkazů jen jako záložní možnost** | vlastník | hlavní akce = odkaz (`startgroup` / `start`), příkaz schovat pod „Nefunguje odkaz?“ |
| 4 | **Přidávání Telegram bota bez předvolených administrátorských oprávnění** | vlastník | ověřit v BotFather výchozí práva bota ve skupinách (`/setdefaultgroupadministratorrights` → žádná) a `startgroup` odkaz bez parametru `admin`; Relay práva nepotřebuje |
| 5 | Telegram `/task`: vysvětlit v nápovědě a v potvrzení, že název se píše za příkaz | RUN 08B (živá vada, opraveno v kódu) | Telegram bez admin práv nepředá zprávu, na kterou se odpovídá |
| 6 | Zkušební zpráva vs. skutečné oznámení – v UI odlišit („zkušební zpráva odeslána“ ≠ „oznámení doručena“) | RUN 08B (zmatení při akceptaci) | |
