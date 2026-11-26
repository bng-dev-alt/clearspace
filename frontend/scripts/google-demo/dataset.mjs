// RUN 06 Google demo dataset `CS-GDEMO` 1.0.0 -- the Google side of the fictional Corvane Systems world of CSD-CORVANE (demo-seed).
// Persona: Alex Morgan, Account Director at Corvane Systems, working with the CSD-CORVANE team on its 14 client / internal projects.
// EVERYTHING is fictional. Every address except Alex's own (filled in at run time from the VERIFIED demo account, never stored here)
// is under a reserved domain (RFC 2606 / 6761: example.com|org|net, *.example) -- nothing here can reach a real person.
// Dates are working-day / calendar-day offsets from the anchor (the seeding date), so the demo always looks current.
// Discreet Alien / Blade Runner references, as in CSD-CORVANE: Yutani, Tyrell, LV-426, Nostromo Park, Sevastopol Road, Gateway Yard,
// Tannhäuser, Nexus, rooms Sulaco / Narcissus / Bradbury, surnames Ripley, Holden, Lambert, Bryant, Gaff, Parker.

export const DATASET = 'CS-GDEMO';
export const VERSION = '1.0.0';
export const TIME_ZONE = 'Europe/Prague';

export const P = {   // CSD-CORVANE team (same names and addresses as demo-seed/dataset.mjs)
  helena: ['Helena Ripley', 'helena.ripley@example.com'], dana: ['Dana Whitfield', 'dana.whitfield@example.com'],
  tomas: ['Tomás Holden', 'tomas.holden@example.com'], priya: ['Priya Lambert', 'priya.lambert@example.com'],
  owen: ['Owen Bryant', 'owen.bryant@example.com'], rafael: ['Rafael Gaff', 'rafael.gaff@example.com'],
  mei: ['Mei Tanaka', 'mei.tanaka@example.org'], joaquin: ['Joaquín Reyes', 'joaquin.reyes@example.com'],
  sofia: ['Sofia Brandt', 'sofia.brandt@example.net'], kai: ['Kai Novak', 'kai.novak@example.com'], samuel: ['Samuel Parker', 'samuel.parker@example.net'],
  // client contacts (fictional companies, reserved .example domains)
  okafor: ['Marcus Okafor', 'm.okafor@yutani-logistics.example'], dvorak: ['Jana Dvořáková', 'jana.dvorakova@yutani-logistics.example'],
  voss: ['Elena Voss', 'elena.voss@tyrell-systems.example'], chen: ['Daniel Chen', 'd.chen@tyrell-systems.example'],
  halden: ['Petra Halden', 'petra.halden@haldenbrooke.example'], svoboda: ['Martin Svoboda', 'martin.svoboda@brightwater.example'],
  kral: ['Lucie Králová', 'lucie.kralova@alderbank.example'], marlowe: ['Tereza Marlowe', 'tereza.marlowe@marlowefoods.example'],
  novotny: ['Jakub Novotný', 'jakub.novotny@kestrelfreight.example'], pine: ['Dr. Anna Pinecrest-Malá', 'a.mala@pinecrest-health.example'],
  events: ['Corvane Events', 'events@corvane.example'], it: ['Corvane IT', 'it-servis@corvane.example'],
};
export const PROJECTS = {   // CSD-CORVANE project codes -> names (the ClearSpace projects the items belong to)
  p01: 'Yutani Logistics: Modernizace skladové evidence', p02: 'Tyrell Systems: Přezkum technické shody',
  p03: 'Modernizace zařízení: datacentrum Hadley Park (LV-426)', p04: 'Halden & Brooke Insurance: Program onboardingu klientů',
  p05: 'Brightwater Utilities: Automatizace zákaznické podpory', p06: 'Alderbank Credit Union: Příprava na ISO 27001',
  p07: 'Corvane Flow 2.0: Vydání workflow produktu', p08: 'Kampaň Provozní dokonalost: Poptávkový program 1. čtvrtletí',
  p09: 'Marlowe Foods: Dashboard analýzy poptávky', p10: 'Interní provoz: Dodávka služeb a kapacity ve 4. čtvrtletí',
  p11: 'Kestrel Freight: Nasazení platformy pro plánování tras', p12: 'Pinecrest Health: Migrace pacientského portálu',
  p13: 'Nexus – vzdálený monitoring infrastruktury: Plánování iniciativy', p14: 'Tyrell Systems: Rámec politik pro syntetickou pracovní sílu',
};
export const SIGNATURE = 'Alex Morgan\nAccount Director | Corvane Systems';

// ---------------------------------------------------------------------------------------------------------------- Gmail (14 threads)
// at: [working-day offset (<= 0), 'HH:MM' Prague]. from 'me' = Alex (SENT); others land in the INBOX.
export const THREADS = [
  { key: 't01', project: 'p01', subject: 'Nostromo Park – výsledky pilotu ručních skenerů', messages: [
    { from: 'dvorak', to: ['me'], cc: ['helena'], at: [-12, '08:41'], body: 'Dobrý den, Alexi,\n\nposílám shrnutí dvoutýdenního pilotu ručních skenerů na Nostromo Park. Přesnost párování příjemek vzrostla z 94,1 % na 99,2 %, průměrná doba zaskladnění palety klesla o 3 minuty. Problémy byly jen s vykrytím Wi-Fi v regálové zóně C.\n\nPodrobná data jsou v tabulce na sdíleném disku. Můžeme to probrat na řídicím výboru?\n\nS pozdravem\nJana Dvořáková\nVedoucí skladu Nostromo Park, Yutani Logistics' },
    { from: 'me', to: ['dvorak'], cc: ['helena', 'samuel'], at: [-12, '10:15'], body: 'Dobrý den, Jano,\n\nděkuji, výsledky vypadají výborně. Zónu C si vezme Samuel – navrhne doplnění dvou přístupových bodů ještě před vlnou 2. Výsledky pilotu zařadím jako první bod řídicího výboru.\n\nHeleno, prosím doplň je do statusu projektu.' },
    { from: 'okafor', to: ['me'], cc: ['dvorak'], at: [-11, '17:02'], body: 'Hi Alex,\n\ngreat numbers from Nostromo Park. Before we sign off wave 2 (Sevastopol Road and Gateway Yard) I need a firm date for the Wi-Fi fix in zone C and a rollback plan in case the scanners misbehave during peak season.\n\nCan you have both ready for the steering committee?\n\nBest,\nMarcus Okafor\nHead of Operations, Yutani Logistics' },
    { from: 'me', to: ['okafor'], cc: ['dvorak', 'helena'], at: [-10, '09:20'], body: 'Hi Marcus,\n\nyes – Samuel will install the two access points next Tuesday night, and Helena is preparing a one-page rollback plan (paper picking lists can be reactivated within 30 minutes per site). Both will be in the steering committee deck.\n\nBest regards,' },
  ] },
  { key: 't02', project: 'p02', subject: 'Tyrell Systems – compliance review: evidence request #3', messages: [
    { from: 'voss', to: ['me'], cc: ['rafael'], at: [-9, '16:30'], body: 'Hello Alex,\n\nfor the technical compliance review we still need three items: (1) access-review logs for the last two quarters, (2) the patch-management policy currently in force, (3) evidence that backups of the replicant-registry service – sorry, the "unit registry", old habits – are tested quarterly.\n\nCould you upload them to the evidence checklist by Friday?\n\nKind regards,\nElena Voss\nCompliance Lead, Tyrell Systems' },
    { from: 'me', to: ['voss'], cc: ['rafael', 'sofia'], at: [-8, '09:05'], body: 'Hello Elena,\n\nnoted. Rafael owns items 1 and 2, Sofia will attach the last two restore-test reports for item 3. We will mark each line in the checklist as soon as the evidence is uploaded.\n\nKind regards,' },
    { from: 'rafael', to: ['me'], cc: ['sofia'], at: [-6, '14:48'], body: 'Alexi,\n\nlogy přístupových revizí i patch policy jsou nahrané a označené v checklistu. Jeden nález: dva servisní účty v segmentu Tannhäuser nemají vlastníka. Navrhuji to Tyrellu přiznat rovnou a přidat nápravné opatření s termínem do konce měsíce.\n\nRafael' },
  ] },
  { key: 't03', project: 'p03', subject: 'Hadley Park (LV-426) – servisní okno chlazení', messages: [
    { from: 'samuel', to: ['me', 'dana'], cc: ['tomas'], at: [-7, '11:12'], body: 'Ahoj,\n\ndodavatel chlazení potvrdil výměnu čerpadla v okruhu B. Potřebujeme servisní okno 4 hodiny, ideálně v noci ze středy na čtvrtek. Během výměny poběží hala 2 jen na jednom okruhu, takže doporučuju přesunout zálohovací úlohy mimo okno.\n\nSamuel' },
    { from: 'dana', to: ['samuel', 'me'], cc: ['tomas'], at: [-7, '13:40'], body: 'Souhlasím s nocí ze středy na čtvrtek, 22:00–02:00. Zákazníky v hale 2 informujeme 5 pracovních dní předem standardní servisní notifikací. Alexi, můžeš to potvrdit u dvou klíčových klientů osobně?\n\nDana' },
    { from: 'me', to: ['dana', 'samuel'], cc: ['tomas'], at: [-6, '08:55'], body: 'Ahoj,\n\npotvrzeno. Oba klíčové klienty jsem obvolal, nikdo nemá v tom okně kritický provoz. Okno dávám do kalendáře, plán odstávky je na disku ve složce Hadley Park.' },
    { from: 'tomas', to: ['me', 'samuel', 'dana'], at: [-5, '16:20'], body: 'Ještě doplnění: monitoring Nexus pustíme během okna v režimu zvýšené citlivosti (teplotní alarmy po 2 minutách místo 5). Výsledky přidám do plánu odstávky.\n\nT.' },
  ] },
  { key: 't04', project: 'p04', subject: 'Halden & Brooke – nabídka programu onboardingu klientů', messages: [
    { from: 'halden', to: ['me'], at: [-15, '10:02'], body: 'Dobrý den, pane Morgane,\n\nna základě úvodní schůzky bychom rádi dostali cenovou nabídku na program onboardingu nových klientů: digitální formulář, kontrolu dokladů a uvítací sekvenci. Rozpočet na první fázi máme schválený do konce roku.\n\nS pozdravem\nPetra Halden\nŘeditelka klientských služeb, Halden & Brooke Insurance' },
    { from: 'me', to: ['halden'], cc: ['owen', 'priya'], at: [-13, '15:30'], body: 'Dobrý den, paní Halden,\n\nv příloze posílám rozpis nabídky pro první fázi (3 pracovní balíčky, 11 týdnů). Podrobný popis rozsahu je v dokumentu nabídky, který vám nasdílím. Rádi bychom nabídku představili osobně – vyhovoval by vám příští týden?\n\nS pozdravem,', attach: { name: 'HB-nabidka-faze1-rozpis.csv', type: 'text/csv', text: 'balicek;rozsah;tydny;cena_czk\nWP1;Digitální onboardingový formulář;4;412000\nWP2;Kontrola dokladů a napojení na CRM;5;538000\nWP3;Uvítací sekvence a reporting;2;176000\nCelkem;;11;1126000\n' } },
    { from: 'halden', to: ['me'], cc: ['owen'], at: [-11, '09:47'], body: 'Děkuji, nabídka je srozumitelná. Prezentaci bych ráda spojila se schůzkou s naším IT. Pošlete prosím pozvánku, termín nechám na vás.\n\nP. Halden' },
  ] },
  { key: 't05', project: 'p05', subject: 'Brightwater Utilities – návrh SLA a eskalační matice', messages: [
    { from: 'svoboda', to: ['me'], cc: ['owen'], at: [-10, '07:58'], body: 'Dobrý den,\n\nk návrhu SLA pro automatizovanou podporu: reakční doba 15 minut pro havárie dodávky vody je pro nás minimum, ne cíl. Prosím upravte eskalační matici tak, aby se havárie dostala k dispečerovi bez ohledu na denní dobu.\n\nMartin Svoboda\nVedoucí zákaznické podpory, Brightwater Utilities' },
    { from: 'me', to: ['svoboda'], cc: ['owen', 'tomas'], at: [-9, '11:30'], body: 'Dobrý den, pane Svobodo,\n\nrozumím. Upravili jsme matici: havárie dodávky jde přímo na dispečink 24/7, chatbot ji jen zaznamená a potvrdí zákazníkovi. Revidovaný návrh je v dokumentu SLA, rád ho s vámi projdu na revizi příští týden.\n\nS pozdravem,' },
    { from: 'owen', to: ['me'], at: [-9, '12:05'], body: 'Díky, Alexi. Doplnil jsem do matice i plánované odstávky – ty Brightwater dosud řešil ručně. Na revizi vezmu reporty za poslední tři měsíce.\n\nOwen' },
  ] },
  { key: 't06', project: 'p06', subject: 'Alderbank – termín certifikačního auditu ISO 27001', messages: [
    { from: 'kral', to: ['me'], cc: ['rafael'], at: [-14, '13:10'], body: 'Dobrý den,\n\ncertifikační orgán nám nabídl termín auditu ve dvou dnech na začátku příštího měsíce. Stihneme do té doby uzavřít zbývající nápravná opatření z analýzy mezer?\n\nLucie Králová\nManažerka bezpečnosti informací, Alderbank Credit Union' },
    { from: 'me', to: ['kral'], cc: ['rafael', 'dana'], at: [-13, '09:00'], body: 'Dobrý den, paní Králová,\n\nze 14 opatření zbývají 3, všechna s termínem nejpozději týden před auditem. Navrhuji termín přijmout a týden předem udělat interní audit nanečisto. Registr rizik průběžně aktualizujeme na sdíleném disku.\n\nS pozdravem,' },
    { from: 'rafael', to: ['me'], at: [-4, '10:22'], body: 'Update: opatření A.8.13 (zálohy) je uzavřené, zbývají dvě. Interní audit nanečisto je naplánovaný, pozvánku máš v kalendáři.\n\nR.' },
  ] },
  { key: 't07', project: 'p07', subject: 'Corvane Flow 2.0 – RC2 a rozhodnutí Go/No-Go', messages: [
    { from: 'sofia', to: ['tomas', 'me'], cc: ['mei'], at: [-5, '17:45'], body: 'Ahoj,\n\nregresní testy RC2: 412 testů, 409 prošlo, 3 selhaly – všechny v exportu do PDF u workflow s více než 50 kroky. Kritické chyby nejsou. Protokol je v tabulce na disku.\n\nSofia' },
    { from: 'tomas', to: ['sofia', 'me'], cc: ['mei'], at: [-4, '09:10'], body: 'Oprava exportu je hotová v RC2.1, Sofia ji dnes přetestuje. Pokud projde, navrhuji na Go/No-Go doporučit Go.\n\nTomás' },
    { from: 'mei', to: ['tomas', 'me'], at: [-4, '11:35'], body: 'Ještě drobnost z UX: nové onboardingové okno má na úzkých displejích přetékající tlačítko. Oprava je v CSS, do RC2.1 se vejde.\n\nMei' },
    { from: 'me', to: ['tomas', 'sofia', 'mei'], cc: ['kai'], at: [-3, '08:30'], body: 'Díky všem. Go/No-Go necháváme na plánovaném termínu, Kai mezitím připraví release notes pro zákazníky. Pokud RC2.1 projde, jdeme do vydání podle plánu.' },
  ] },
  { key: 't08', project: 'p09', subject: 'Marlowe Foods – měsíční report poptávky (říjen)', messages: [
    { from: 'joaquin', to: ['me'], at: [-8, '15:00'], body: 'Ahoj Alexi,\n\nv příloze je souhrn říjnové poptávky pro Marlowe Foods. Mléčné výrobky meziměsíčně +6 %, pečivo −2 %. Model předpovědi se trefil s chybou 4,8 %, což je zatím nejlepší výsledek.\n\nJoaquín', attach: { name: 'marlowe-poptavka-rijen.csv', type: 'text/csv', text: 'kategorie;rijen_ks;zmena_mm;chyba_predikce\nMléčné výrobky;184200;+6,1 %;3,9 %\nPečivo;96450;-2,0 %;5,6 %\nOvoce a zelenina;132800;+1,4 %;4,7 %\nNápoje;77310;+0,8 %;5,2 %\n' } },
    { from: 'me', to: ['marlowe'], cc: ['joaquin'], at: [-7, '10:40'], body: 'Dobrý den, paní Marlowe,\n\nposílám měsíční report poptávky za říjen; dashboard je aktualizovaný. Na pravidelné schůzce bych rád probral, zda rozšířit predikci i na sezónní sortiment.\n\nS pozdravem,' },
  ] },
  { key: 't09', project: 'p11', subject: 'Kestrel Freight – akceptační test platformy plánování tras', messages: [
    { from: 'novotny', to: ['me'], cc: ['priya'], at: [-6, '08:20'], body: 'Dobrý den,\n\nposílám scénáře pro akceptační test: 40 tras z regionu Morava, včetně dvou s omezením hmotnosti na mostech. Platforma musí naplánovat všechny do 90 sekund.\n\nJakub Novotný\nVedoucí dispečinku, Kestrel Freight' },
    { from: 'priya', to: ['me'], at: [-2, '13:15'], body: 'Akceptační test proběhl: 40 ze 40 tras, nejdelší výpočet 71 s. Jedna připomínka k zobrazení objížďky. Protokol je na disku, Kestrel ho má k podpisu.\n\nPriya' },
    { from: 'me', to: ['novotny'], cc: ['priya'], at: [-1, '09:30'], body: 'Dobrý den, pane Novotný,\n\nděkujeme za spolupráci při testu. Akceptační protokol vám posíláme k podpisu; připomínku k objížďce opravíme v rámci záruky do dvou týdnů.\n\nS pozdravem,' },
  ] },
  { key: 't10', project: 'p12', subject: 'Pinecrest Health – migrační okno pacientského portálu', messages: [
    { from: 'pine', to: ['me'], cc: ['priya'], at: [-9, '12:00'], body: 'Dobrý den,\n\nmigraci portálu můžeme provést jen o víkendu mimo ordinační hodiny. Pacienty musíme informovat nejméně 10 dní předem. Potvrďte prosím sobotní večer.\n\nAnna Pinecrest-Malá\nŘeditelka IT, Pinecrest Health' },
    { from: 'me', to: ['pine'], cc: ['priya', 'rafael'], at: [-8, '14:25'], body: 'Dobrý den,\n\npotvrzuji sobotu 20:00–24:00. Plán migrace včetně návratového postupu je ve sdíleném dokumentu; Rafael doplní bezpečnostní kontrolu přenosu dat.\n\nS pozdravem,' },
    { from: 'pine', to: ['me'], at: [-7, '08:05'], body: 'Děkuji, termín jsme oznámili pacientům. Prosím o kontakt na pohotovostní linku Corvane během migrace.\n\nA. P.-M.' },
  ] },
  { key: 't11', project: 'p13', subject: 'Nexus – kickoff iniciativy vzdáleného monitoringu', messages: [
    { from: 'samuel', to: ['me', 'tomas', 'rafael'], at: [-3, '10:00'], body: 'Ahoj,\n\nposílám brief iniciativy Nexus: sjednocený vzdálený monitoring pro Hadley Park a dvě menší lokality. Pilot začne segmentem Tannhäuser, protože tam máme nejvíc ručně hlídaných zařízení.\n\nKickoff navrhuji příští týden.\n\nSamuel' },
    { from: 'rafael', to: ['samuel', 'me', 'tomas'], at: [-3, '11:20'], body: 'Za bezpečnost: monitorovací agenti jen s odchozím spojením a vlastním certifikátem na zařízení. Doplním do briefu.\n\nR.' },
    { from: 'me', to: ['samuel', 'tomas', 'rafael'], cc: ['dana'], at: [-2, '09:00'], body: 'Super, kickoff jsem dal do kalendáře. Dano, přidávám tě kvůli kapacitám provozu v prvním čtvrtletí.' },
  ] },
  { key: 't12', project: 'p14', subject: 'Synthetic Workforce Policy Framework – workshop agenda', messages: [
    { from: 'chen', to: ['me'], cc: ['voss'], at: [-4, '18:10'], body: 'Hi Alex,\n\nfor the policy workshop we would like to cover: lifecycle rules for synthetic staff (activation, review, retirement), the human-oversight model, and incident reporting. Our board is particularly interested in the retirement policy for long-running units.\n\nRegards,\nDaniel Chen\nDirector of Workforce Policy, Tyrell Systems' },
    { from: 'me', to: ['chen'], cc: ['voss', 'helena', 'mei'], at: [-3, '09:40'], body: 'Hi Daniel,\n\nthank you. We will structure the workshop in three blocks exactly along those lines, with a draft retirement policy as pre-read. Helena will facilitate, Mei will run the exercise on the oversight model.\n\nBest regards,' },
    { from: 'helena', to: ['me'], at: [-2, '16:00'], body: 'Pre-read je hotový (SoW + návrh zásad), dala jsem ho do složky Tyrell. Na workshop beru i šablonu zápisu.\n\nH.' },
  ] },
  { key: 't13', project: 'p10', subject: 'Kapacity Q4 a plán na leden', messages: [
    { from: 'dana', to: ['me', 'helena'], at: [-10, '08:30'], body: 'Ahoj,\n\nv prosinci máme vytížení delivery týmu 104 %. Navrhuji posunout start Nexus pilotu na leden a na Alderbank vzít externího auditora na 10 dní.\n\nDana' },
    { from: 'me', to: ['dana', 'helena'], at: [-10, '12:10'], body: 'Souhlas s posunem Nexus pilotu, kickoff ale necháme v prosinci. Externího auditora schvaluji; kapacitní plán Q4 prosím aktualizuj na disku.' },
  ] },
  { key: 't14', project: 'p08', subject: 'Webinář „Provozní dokonalost“ – registrace a řečníci', messages: [
    { from: 'kai', to: ['me'], cc: ['events'], at: [-6, '10:30'], body: 'Ahoj Alexi,\n\nregistrace na webinář: 186 přihlášených, z toho 41 z cílových účtů. Potřebuju od tebe potvrzení, že vystoupíš s případovou studií Yutani (bez čísel, která nejsou veřejná).\n\nKai' },
    { from: 'me', to: ['kai'], cc: ['events'], at: [-5, '08:45'], body: 'Potvrzuji. Případovou studii postavím na výsledcích pilotu Nostromo Park, schválení textu od Yutani zajistím přes Marcuse Okafora.' },
  ] },
];

// ---------------------------------------------------------------------------------------------------------------- Drive (21 files)
// kind: 'doc' (HTML -> Google Docs) | 'sheet' (CSV -> Google Sheets). folder: one of FOLDERS.
export const ROOT_FOLDER = 'Corvane Systems – projekty';
export const FOLDERS = ['Yutani Logistics', 'Tyrell Systems', 'Hadley Park', 'Klienti', 'Corvane Flow', 'Interní'];
const h = (title, ...blocks) => `<h1>${title}</h1>` + blocks.map((b) => (b.startsWith('<') ? b : `<p>${b}</p>`)).join('');
const ul = (...items) => `<ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>`;
const h2 = (t) => `<h2>${t}</h2>`;
export const FILES = [
  { key: 'd01', project: 'p01', folder: 'Yutani Logistics', kind: 'doc', name: 'Yutani – Zadání projektu Modernizace skladové evidence',
    html: h('Zadání projektu: Modernizace skladové evidence', 'Klient: Yutani Logistics · Sponzor: Marcus Okafor · Vedoucí projektu: Helena Ripley · Account: Alex Morgan',
      h2('Cíl'), 'Nahradit papírové příjemky a ruční zaskladnění skenery a online evidencí ve třech skladech (Nostromo Park, Sevastopol Road, Gateway Yard).',
      h2('Rozsah'), ul('Ruční skenery a mobilní aplikace pro příjem a zaskladnění', 'Napojení na WMS klienta', 'Školení 120 skladníků', 'Hypercare 4 týdny po každé vlně'),
      h2('Měřítka úspěchu'), ul('Přesnost párování příjemek ≥ 99 %', 'Doba zaskladnění palety −20 %', 'Žádný výpadek expedice v době špičky')) },
  { key: 'd02', project: 'p01', folder: 'Yutani Logistics', kind: 'doc', name: 'Yutani – Zápis z řídicího výboru (listopad)',
    html: h('Zápis z řídicího výboru – listopad', 'Účast: M. Okafor, J. Dvořáková (Yutani); A. Morgan, H. Ripley, S. Parker (Corvane)',
      h2('Rozhodnutí'), ul('Pilot Nostromo Park je úspěšně uzavřen.', 'Vlna 2 (Sevastopol Road, Gateway Yard) je podmíněně schválena – podmínkou je oprava Wi-Fi v zóně C a návratový plán.'),
      h2('Úkoly'), ul('S. Parker: dva přístupové body v zóně C – do příštího úterý', 'H. Ripley: návratový plán na jednu stránku', 'A. Morgan: termín go-live vlny 2 s klientem')) },
  { key: 'd03', project: 'p01', folder: 'Yutani Logistics', kind: 'sheet', name: 'Yutani – Výsledky pilotu skenerů Nostromo Park',
    csv: 'tyden,prijemky,presnost_parovani,doba_zaskladneni_min,incidenty\n1,1840,98.4,11.2,3\n2,1912,99.2,9.6,1\nZáklad (před pilotem),1795,94.1,12.6,7\n' },
  { key: 'd04', project: 'p02', folder: 'Tyrell Systems', kind: 'sheet', name: 'Tyrell – Compliance evidence checklist',
    csv: 'id,requirement,owner,status,evidence\nEV-01,Access review logs (2 quarters),Rafael Gaff,Uploaded,access-reviews-q2-q3.pdf\nEV-02,Patch management policy,Rafael Gaff,Uploaded,patch-policy-v4.pdf\nEV-03,Quarterly restore tests of the unit registry,Sofia Brandt,In progress,\nEV-04,Service accounts with named owners,Rafael Gaff,Finding,Two accounts in segment Tannhäuser without owner\n' },
  { key: 'd05', project: 'p14', folder: 'Tyrell Systems', kind: 'doc', name: 'Tyrell – Statement of Work: Synthetic Workforce Policy Framework',
    html: h('Statement of Work – Synthetic Workforce Policy Framework', 'Client: Tyrell Systems · Sponsor: Daniel Chen · Corvane lead: Helena Ripley',
      h2('Objectives'), ul('Lifecycle policy for synthetic staff: activation, periodic review, retirement', 'Human-oversight model with clear escalation', 'Incident reporting aligned with the compliance review'),
      h2('Deliverables'), ul('Policy framework (draft and final)', 'Facilitated board workshop', 'Implementation roadmap for off-world operations'),
      h2('Timeline'), 'Six weeks from the workshop; draft after three weeks.') },
  { key: 'd06', project: 'p03', folder: 'Hadley Park', kind: 'doc', name: 'Hadley Park (LV-426) – Plán odstávky chlazení, okruh B',
    html: h('Plán odstávky chlazení – okruh B', 'Lokalita: datacentrum Hadley Park (LV-426), hala 2 · Okno: středa 22:00 – čtvrtek 02:00',
      h2('Postup'), ul('21:30 kontrola záloh a přesun zálohovacích úloh', '22:00 přepnutí haly 2 na okruh A', '22:15–01:15 výměna čerpadla (dodavatel)', '01:15 zkouška okruhu B, návrat do normálního režimu', '02:00 uzavření okna, zpráva klientům'),
      h2('Rizika'), ul('Teplota v hale 2 nad 27 °C → okamžitý návrat na oba okruhy', 'Monitoring Nexus v režimu zvýšené citlivosti (alarm po 2 minutách)')) },
  { key: 'd07', project: 'p03', folder: 'Hadley Park', kind: 'sheet', name: 'Hadley Park – Inventář racků a kapacit',
    csv: 'hala,rada,racky,vyuziti_kw,limit_kw,okruh\nHala 1,A,24,148,180,A\nHala 1,B,24,131,180,A\nHala 2,C,20,162,170,B\nHala 2,D,20,118,170,B\n' },
  { key: 'd08', project: 'p04', folder: 'Klienti', kind: 'doc', name: 'Halden & Brooke – Nabídka programu onboardingu klientů (fáze 1)',
    html: h('Nabídka: program onboardingu klientů – fáze 1', 'Pro: Halden & Brooke Insurance, Petra Halden · Připravil: Alex Morgan, Owen Bryant',
      h2('Pracovní balíčky'), ul('WP1 Digitální onboardingový formulář – 4 týdny', 'WP2 Kontrola dokladů a napojení na CRM – 5 týdnů', 'WP3 Uvítací sekvence a reporting – 2 týdny'),
      h2('Cena'), 'Celkem 1 126 000 Kč bez DPH, fakturace po dokončení balíčků. Platnost nabídky 30 dní.') },
  { key: 'd09', project: 'p05', folder: 'Klienti', kind: 'doc', name: 'Brightwater – Návrh SLA a eskalační matice (rev. 2)',
    html: h('SLA automatizované zákaznické podpory – revize 2', h2('Reakční doby'), ul('Havárie dodávky: 15 min, 24/7, přímo dispečink', 'Plánovaná odstávka – dotaz: 4 h v pracovní době', 'Fakturace: 1 pracovní den'),
      h2('Eskalace'), ul('L1 chatbot – záznam a potvrzení', 'L2 zákaznická podpora Brightwater', 'L3 dispečink / Corvane support')) },
  { key: 'd10', project: 'p06', folder: 'Klienti', kind: 'doc', name: 'Alderbank – Analýza mezer ISO 27001',
    html: h('Analýza mezer ISO/IEC 27001:2022', 'Klient: Alderbank Credit Union · Zpracoval: Rafael Gaff',
      h2('Shrnutí'), 'Ze 93 opatření přílohy A je 79 plně zavedeno, 11 částečně a 3 chybí. Nápravná opatření jsou vedena v registru rizik.',
      h2('Hlavní mezery'), ul('A.5.23 Bezpečnost cloudových služeb – chybí hodnocení dodavatelů', 'A.8.13 Zálohování – chybí pravidelné testy obnovy', 'A.8.16 Monitoring – logy se nevyhodnocují centrálně')) },
  { key: 'd11', project: 'p06', folder: 'Klienti', kind: 'sheet', name: 'Alderbank – Registr rizik a nápravných opatření',
    csv: 'id,opatreni,riziko,vlastnik,termin,stav\nR-07,A.5.23 hodnocení cloudových dodavatelů,Střední,Lucie Králová,týden před auditem,Rozpracováno\nR-09,A.8.13 testy obnovy záloh,Vysoké,Rafael Gaff,splněno,Uzavřeno\nR-12,A.8.16 centrální vyhodnocení logů,Střední,Samuel Parker,týden před auditem,Rozpracováno\n' },
  { key: 'd12', project: 'p07', folder: 'Corvane Flow', kind: 'doc', name: 'Corvane Flow 2.0 – Release notes RC2',
    html: h('Corvane Flow 2.0 – Release notes (RC2)', h2('Novinky'), ul('Paralelní větve ve workflow', 'Nové onboardingové okno', 'Export do PDF pro workflow až do 200 kroků'),
      h2('Opravy v RC2.1'), ul('Export do PDF u workflow s více než 50 kroky', 'Přetékající tlačítko na úzkých displejích')) },
  { key: 'd13', project: 'p07', folder: 'Corvane Flow', kind: 'sheet', name: 'Corvane Flow 2.0 – Testovací protokol RC2',
    csv: 'oblast,testu,proslo,selhalo,poznamka\nEditor workflow,148,148,0,\nExport,62,59,3,PDF > 50 kroků (opraveno v RC2.1)\nOprávnění,91,91,0,\nAPI,111,111,0,\n' },
  { key: 'd14', project: 'p09', folder: 'Klienti', kind: 'sheet', name: 'Marlowe Foods – Měsíční report poptávky (říjen)',
    csv: 'kategorie,rijen_ks,zmena_mm_pct,chyba_predikce_pct\nMléčné výrobky,184200,6.1,3.9\nPečivo,96450,-2.0,5.6\nOvoce a zelenina,132800,1.4,4.7\nNápoje,77310,0.8,5.2\n' },
  { key: 'd15', project: 'p11', folder: 'Klienti', kind: 'doc', name: 'Kestrel Freight – Akceptační protokol platformy plánování tras',
    html: h('Akceptační protokol – platforma plánování tras', 'Klient: Kestrel Freight · Test: 40 tras, region Morava',
      h2('Výsledek'), '40 ze 40 tras naplánováno, nejdelší výpočet 71 s (limit 90 s). Omezení hmotnosti na mostech respektováno.',
      h2('Připomínky'), ul('Zobrazení objížďky v mapě – oprava v záruce do 14 dní'), h2('Podpisy'), 'Za Kestrel Freight: ____________ Za Corvane Systems: ____________') },
  { key: 'd16', project: 'p12', folder: 'Klienti', kind: 'doc', name: 'Pinecrest Health – Plán migrace pacientského portálu',
    html: h('Plán migrace pacientského portálu', 'Okno: sobota 20:00–24:00 · Odpovědná: Priya Lambert · Bezpečnost: Rafael Gaff',
      h2('Kroky'), ul('Zmrazení změn 48 h předem', 'Šifrovaný přenos dat a kontrolní součty', 'Smoke test přihlášení a objednávek', 'Návratový postup do 45 minut'),
      h2('Komunikace'), 'Pacienti informováni 10 dní předem; pohotovostní linka Corvane po celou dobu okna.') },
  { key: 'd17', project: 'p13', folder: 'Hadley Park', kind: 'doc', name: 'Nexus – Brief iniciativy vzdáleného monitoringu',
    html: h('Brief: Nexus – vzdálený monitoring infrastruktury', 'Iniciátor: Samuel Parker · Sponzor: Dana Whitfield',
      h2('Problém'), 'Část zařízení v Hadley Park a dvou menších lokalitách se hlídá ručně; alarmy přicházejí pozdě a z více nástrojů.',
      h2('Návrh'), ul('Jednotný monitoring s agenty jen s odchozím spojením', 'Pilot v segmentu Tannhäuser', 'Start pilotu v lednu, kickoff v prosinci')) },
  { key: 'd18', project: 'p10', folder: 'Interní', kind: 'sheet', name: 'Interní – Kapacitní plán Q4',
    csv: 'tym,listopad_pct,prosinec_pct,leden_pct,poznamka\nDelivery,96,104,88,Nexus pilot posunut na leden\nBezpečnost,90,112,95,Externí auditor pro Alderbank (10 dní)\nProvoz,85,92,90,\n' },
  { key: 'd19', project: 'p08', folder: 'Interní', kind: 'doc', name: 'Kampaň Provozní dokonalost – Briefing webináře',
    html: h('Briefing webináře „Provozní dokonalost“', 'Moderuje: Kai Novak · Řečník: Alex Morgan',
      h2('Program'), ul('Úvod a trendy (10 min)', 'Případová studie: digitální sklad (20 min) – bez neveřejných čísel', 'Diskuse a dotazy (15 min)'),
      h2('Cíle'), ul('186 registrací, 41 cílových účtů', '10 navazujících schůzek')) },
  { key: 'd20', project: 'p10', folder: 'Interní', kind: 'doc', name: 'Šablona – Zápis z porady',
    html: h('Zápis z porady', 'Datum: · Účast: · Projekt:', h2('Body jednání'), ul(''), h2('Rozhodnutí'), ul(''), h2('Úkoly (kdo / co / do kdy)'), ul('')) },
  { key: 'd21', project: 'p01', folder: 'Yutani Logistics', kind: 'doc', name: 'Yutani – Osnova prezentace pro řídicí výbor',
    html: h('Řídicí výbor Yutani – osnova prezentace', ul('1. Výsledky pilotu Nostromo Park', '2. Oprava Wi-Fi v zóně C – termín a stav', '3. Návratový plán', '4. Harmonogram vlny 2: Sevastopol Road, Gateway Yard', '5. Rozhodnutí: schválení vlny 2')) },
];

// ---------------------------------------------------------------------------------------------------------------- Calendar (21 events)
// day: working-day offset; time 'HH:MM' + minutes; allDay: calendar-day offset + days; visibility 'private' = personal (ClearSpace refuses it).
export const EVENTS = [
  { key: 'e01', project: 'p10', summary: 'Týdenní koordinace delivery týmu', weekly: 6, weekday: 1, time: '09:00', minutes: 45, location: 'Zasedačka Sulaco, Corvane HQ', attendees: ['helena', 'dana', 'tomas', 'priya'] },
  { key: 'e02', project: 'p01', summary: 'Yutani – řídicí výbor (vlna 2)', day: 3, time: '14:00', minutes: 90, location: 'Yutani Logistics, Nostromo Park – zasedací místnost', attendees: ['okafor', 'dvorak', 'helena', 'samuel'] },
  { key: 'e03', project: 'p01', summary: 'Yutani – go-live vlny 2 (Sevastopol Road, Gateway Yard)', allDay: 19, days: 1 },
  { key: 'e04', project: 'p02', summary: 'Tyrell – compliance evidence review', day: 1, time: '07:00', minutes: 60, timeZone: 'America/Los_Angeles', location: 'Video call', attendees: ['voss', 'rafael', 'sofia'] },
  { key: 'e05', project: 'p14', summary: 'Tyrell – Synthetic Workforce Policy workshop', day: 6, time: '10:00', minutes: 150, location: 'Zasedačka Bradbury, Corvane HQ', attendees: ['chen', 'voss', 'helena', 'mei'] },
  { key: 'e06', project: 'p03', summary: 'Hadley Park – servisní okno chlazení (okruh B)', day: 4, time: '22:00', minutes: 240, location: 'Datacentrum Hadley Park, hala 2', attendees: ['samuel', 'dana', 'tomas'] },
  { key: 'e07', project: 'p03', summary: 'Hadley Park – prohlídka lokality s dodavatelem', day: -3, time: '10:00', minutes: 120, location: 'Datacentrum Hadley Park', attendees: ['samuel'] },
  { key: 'e08', project: 'p04', summary: 'Halden & Brooke – prezentace nabídky onboardingu', day: 1, time: '13:00', minutes: 60, location: 'Halden & Brooke Insurance, Praha', attendees: ['halden', 'owen', 'priya'] },
  { key: 'e09', project: 'p05', summary: 'Brightwater – revize SLA', day: 5, time: '09:30', minutes: 60, location: 'Video call', attendees: ['svoboda', 'owen', 'tomas'] },
  { key: 'e10', project: 'p06', summary: 'Alderbank – certifikační audit ISO 27001', allDay: 26, days: 2 },
  { key: 'e11', project: 'p06', summary: 'Alderbank – interní audit nanečisto', day: 11, time: '13:00', minutes: 180, location: 'Alderbank Credit Union, Brno', attendees: ['kral', 'rafael', 'dana'] },
  { key: 'e12', project: 'p07', summary: 'Corvane Flow 2.0 – Go/No-Go (RC2.1)', day: 2, time: '15:00', minutes: 45, location: 'Zasedačka Narcissus, Corvane HQ', attendees: ['tomas', 'sofia', 'mei', 'kai'] },
  { key: 'e13', project: 'p07', summary: 'Corvane Flow 2.0 – vydání', allDay: 11, days: 1 },
  { key: 'e14', project: 'p09', summary: 'Marlowe Foods – měsíční schůzka k poptávce', day: 5, time: '11:00', minutes: 60, location: 'Video call', attendees: ['marlowe', 'joaquin'] },
  { key: 'e15', project: 'p11', summary: 'Kestrel Freight – akceptační test', day: -1, time: '09:00', minutes: 180, location: 'Kestrel Freight, dispečink Olomouc', attendees: ['novotny', 'priya'] },
  { key: 'e16', project: 'p12', summary: 'Pinecrest Health – migrační okno portálu', saturday: 2, time: '20:00', minutes: 239, location: 'Vzdáleně', attendees: ['pine', 'priya', 'rafael'] },
  { key: 'e17', project: 'p13', summary: 'Nexus – kickoff', day: 7, time: '10:00', minutes: 90, location: 'Zasedačka Sulaco, Corvane HQ', attendees: ['samuel', 'tomas', 'rafael', 'dana'] },
  { key: 'e18', project: 'p08', summary: 'Webinář „Provozní dokonalost“', day: 15, time: '14:00', minutes: 60, location: 'Online', attendees: ['kai'] },
  { key: 'e19', project: 'p10', summary: 'Kapacitní plánování Q1', day: 9, time: '09:00', minutes: 90, location: 'Zasedačka Bradbury, Corvane HQ', attendees: ['dana', 'helena'] },
  { key: 'e20', project: null, summary: 'Lékař', day: 2, time: '07:30', minutes: 45, visibility: 'private' },
  { key: 'e21', project: 'p01', summary: '1:1 Alex a Helena – portfolio klientů', day: 1, time: '11:00', minutes: 30, location: 'Zasedačka Narcissus, Corvane HQ', attendees: ['helena'] },
];

// ---------------------------------------------------------------------------------------------------------------- date helpers
const ymd = (d) => d.toISOString().slice(0, 10);
const addDays = (date, n) => { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
const dow = (date) => new Date(`${date}T12:00:00Z`).getUTCDay();
/** n-th working day from the anchor (0 = the anchor itself, or the next working day if it is a weekend). */
export function workday(anchor, n) {
  let d = anchor; while (dow(d) === 0 || dow(d) === 6) d = addDays(d, n < 0 ? -1 : 1);
  for (let i = 0; i < Math.abs(n); ) { d = addDays(d, n < 0 ? -1 : 1); if (dow(d) !== 0 && dow(d) !== 6) i++; }
  return d;
}
/** UTC offset (minutes) of a time zone at a given local wall time -- stdlib Intl, no tz library. */
function tzOffset(date, time, tz) {
  const guess = new Date(`${date}T${time}:00Z`);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(guess).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
  return (asUtc - guess.getTime()) / 60000;
}
/** Local wall time in `tz` -> RFC 3339 with offset. */
export function zoned(date, time, tz = TIME_ZONE) {
  const off = tzOffset(date, time, tz); const instant = new Date(Date.parse(`${date}T${time}:00Z`) - off * 60000);
  const realOff = tzOffset(ymd(instant), instant.toISOString().slice(11, 16), tz);          // DST edge: recompute at the instant
  const t = new Date(Date.parse(`${date}T${time}:00Z`) - realOff * 60000);
  const sign = realOff >= 0 ? '+' : '-'; const a = Math.abs(realOff);
  const local = new Date(t.getTime() + realOff * 60000).toISOString().slice(0, 19);
  return `${local}${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}
export const plusMinutes = (rfc, m) => {
  const off = rfc.slice(19); const t = new Date(Date.parse(rfc) + m * 60000);
  const sign = off[0] === '-' ? -1 : 1; const mins = sign * (+off.slice(1, 3) * 60 + +off.slice(4, 6));
  return new Date(t.getTime() + mins * 60000).toISOString().slice(0, 19) + off;
};
export { addDays };
