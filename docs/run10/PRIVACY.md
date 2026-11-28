# RUN 10 – soukromí a životní cyklus dat

**ClearSpace není „automaticky v souladu s GDPR“.** Poskytuje technické prostředky (transparentnost, minimalizace, mazání, přístupová
práva); právní základ a informování účastníků jsou odpovědností organizátora / správce.

| Data | Kde vzniká | Kde je uloženo | Jak dlouho | Kdo vidí |
|---|---|---|---|---|
| Živý zvuk | prohlížeč organizátora | **nikde v ClearSpace**; stream jde přímo k Soniox | jen během streamu; Soniox real-time zvuk ani přepis standardně neukládá (dokumentace Soniox, Security & privacy) | – |
| Dočasné bufferování | prohlížeč (MediaRecorder 250 ms) | paměť prohlížeče | sekundy | – |
| Trvalý zvukový záznam | jen existující cesta „Nahrát záznam“ (RC5) | soukromý bucket | 7 dní od nahrání (max 30), pak smazání | členové projektu |
| Průběžný text (části) | Soniox → prohlížeč → server | `meeting_live_chunks` | do dokončení/zahození přepisu, pak smazáno | členové projektu |
| Přepis (revize) | server (normalizace částí) | `meeting_transcripts` | do smazání porady | členové projektu |
| AI výstupy (shrnutí, návrhy) | Gemini (jen na pokyn „Analyzovat“) | `intelligence_runs/items` | do smazání porady | členové projektu |
| Metadata porady, pozvaní (e-maily) | člen projektu | `meetings`, `meeting_attendees` | do smazání porady | členové projektu |
| Událost v Kalendáři | Google (na pokyn organizátora) | kalendář organizátora; v ClearSpace jen sdílená metadata + soukromé event id | dokud ji organizátor nezruší | metadata členové; event id jen autor |
| Atribuce v PI | odpověď AI | historie konverzace PI | dle PI | člen, který se ptá |
| Ledger nákladů | server | `ai_requests` (bez obsahu) | trvale (účetní stopa) | uživatel sám |

**Do Soniox se neposílá**: jméno, název porady ani projektu, e-maily, nic z projektu – jen zvuk a obecný kontext „Project meeting“.
**Do Gemini** jde přepis + název porady + jména mluvčích zadaná člověkem (jako dosud v RC5), jen po kliknutí na Analyzovat.

## Transparentnost a odpovědnost
* Start vyžaduje zaškrtnuté prohlášení organizátora (informoval účastníky, má oprávnění, zastaví při nesouhlasu); uloží se čas a autor.
* Stav „● Nahrává se“ / „Přepis běží“ je stále viditelný; pauza i stop jsou jedno kliknutí; nikdo se nepřipojuje do hovorů automaticky.
* Kopírovatelná pozvánka obsahuje upozornění na přepis a AI analýzu.
* Hosté nepotřebují účet; jejich e-maily vidí jen členové projektu; úkol lze přiřadit jen členovi projektu.

## Mazání
Smazání porady (autor nebo vlastník projektu) kaskádou odstraní přepisy, AI výstupy, pozvané, vazby na Kalendář (událost v Googlu zůstává,
pokud ji organizátor nezruší), živé segmenty i části a zdroj `meeting:` v PI. Ledger nákladů zůstává bez obsahu. Úkoly už vytvořené
z porady zůstávají v projektu (jsou to samostatná rozhodnutí člověka).

## Zbývající právní odpovědnosti (ČR/EU) – mimo technické řešení
Právní základ zpracování hlasu a přepisu (oprávněný zájem / souhlas) a informační povinnost (čl. 13 GDPR) vůči účastníkům; smlouva o
zpracování (DPA) se Soniox a Google; předávání do USA (Soniox region US; EU region vyžaduje projekt v EU – nenastaveno); interní politiky
organizace; nahrávání telefonních/online hovorů dle § 86 a násl. obč. zák. (ochrana projevů osobní povahy). Doporučení: v pozvánce
informovat předem, na začátku porady říct, že se přepisuje, a respektovat námitku.
