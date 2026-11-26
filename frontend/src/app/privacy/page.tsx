import type { Metadata } from 'next';
import Link from 'next/link';
import PublicPage from '../../components/legal/PublicPage';
import { serviceMode } from '../../lib/google/config';
import { slackFeatureEnabled, telegramFeatureEnabled } from '../../lib/notify/config';

export const metadata: Metadata = { title: 'Ochrana osobních údajů – ClearSpace' };
// The controller's identity and contact come from SERVER env (PRIVACY_CONTROLLER, PRIVACY_CONTACT_EMAIL): never hard-coded in the
// public repository, never invented. Unset = the page says so plainly (and the rollout gate treats it as a blocker).
export const dynamic = 'force-dynamic';

const VERSION = '25. listopadu 2026';

export default function PrivacyPage() {
  const controller = process.env.PRIVACY_CONTROLLER?.trim();
  const email = process.env.PRIVACY_CONTACT_EMAIL?.trim();
  // RUN 06: 'pilot' = on for a few listed accounts only -- the same rules apply to them, so the section is shown with a pilot note
  const gmailMode = serviceMode('gmail');
  const calendarMode = serviceMode('calendar');
  const gmail = gmailMode !== 'off';
  const calendar = calendarMode !== 'off';
  const pilotNote = (what: string) => <li data-testid={`privacy-${what}-pilot`}><strong>Pilotní provoz:</strong> na tomto serveru je propojení zapnuté jen pro několik předem určených testovacích účtů; ostatní uživatelé ho nevidí a ClearSpace k jejich údajům nepřistupuje.</li>;
  const slack = slackFeatureEnabled();
  const telegram = telegramFeatureEnabled();
  const contact = email && /^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}$/i.test(email) ? email : null;

  return (
    <PublicPage label="PRÁVNÍ INFORMACE" title="Ochrana osobních údajů" lead={`Jak ClearSpace nakládá s vašimi údaji, včetně dat z Google Disku. Verze z ${VERSION}.`}>
      <section className="settings-card" id="controller">
        <h2>1. Správce a kontakt</h2>
        {controller && contact ? (
          <p data-testid="privacy-contact">Správcem osobních údajů je {controller}. Dotazy, žádosti o přístup, opravu nebo výmaz údajů posílejte na <a href={`mailto:${contact}`}>{contact}</a>.</p>
        ) : (
          <p data-testid="privacy-contact-missing">Kontaktní údaje správce budou doplněny. Do té doby nelze integraci s Google Diskem veřejně zpřístupnit.</p>
        )}
      </section>

      <section className="settings-card" id="app">
        <h2>2. Co je ClearSpace</h2>
        <p>ClearSpace je webová aplikace pro správu týmových projektů a úkolů (kanbanové tabule, komentáře, spolupráce v reálném čase). Účet si zakládáte e-mailem a heslem. Ukládáme údaje, které do aplikace sami zadáte: e-mail, jméno, projekty, úkoly, komentáře, přílohy a záznam aktivity v projektu.</p>
      </section>

      <section className="settings-card" id="google">
        <h2>3. Google Disk (volitelné propojení)</h2>
        <ul>
          <li><strong>Co získáváme od Google:</strong> e-mailovou adresu vašeho účtu Google a jeho stálý identifikátor (abychom připojení přiřadili ke správnému účtu) a přístup <strong>jen k souborům, které sami vyberete</strong> v okně výběru souborů Google (oprávnění „soubory použité s touto aplikací“, <code>drive.file</code>). ClearSpace nevidí ani neprochází zbytek vašeho Disku.</li>
          <li><strong>Co ukládáme o vybraném souboru:</strong> identifikátor souboru v Google Disku, název, typ, velikost, datum poslední úpravy, odkaz na soubor, kdo a kdy ho připojil a ke kterému projektu nebo úkolu. Obsah souboru neukládáme.</li>
          <li><strong>Náhled textu:</strong> u textových dokumentů si můžete na vyžádání zobrazit text. Načte se z Google Disku pod <em>vaším</em> přístupem, zobrazí se jen vám a neukládá se.</li>
          <li><strong>Tokeny:</strong> obnovovací token od Google ukládáme výhradně na serveru, šifrovaný (AES-256-GCM). Krátkodobý přístupový token dostane váš prohlížeč jen pro otevření okna výběru souborů Google. Tokeny nikdy nesdílíme s jinými uživateli.</li>
          <li><strong>Týmový přístup:</strong> název a odkaz připojeného souboru uvidí členové daného projektu. Členství v projektu samo o sobě <strong>nedává přístup k obsahu</strong> souboru – ten určuje výhradně sdílení v Google Disku. ClearSpace sdílení souborů nemění a soubory nemaže ani neupravuje.</li>
          <li><strong>Odebrání odkazu</strong> smaže v ClearSpace jen záznam o připojení (a jeho metadata); soubor v Google Disku zůstává beze změny.</li>
          <li><strong>Odpojení účtu Google</strong> (Nastavení → Propojené účty) zruší oprávnění ClearSpace u Google a smaže uložené tokeny. Dříve připojené odkazy v projektech zůstanou, dokud je neodeberete. Oprávnění můžete zrušit také přímo v <a href="https://myaccount.google.com/permissions" target="_blank" rel="noopener noreferrer">nastavení účtu Google</a>.</li>
          <li><strong>AI:</strong> v současném rozsahu ClearSpace <strong>neposílá obsah souborů z Google Disku žádnému poskytovateli umělé inteligence</strong>.</li>
          <li>Údaje z Google používáme jen pro uvedené funkce. Neprodáváme je, nepoužíváme k reklamě ani k profilování a nepředáváme je třetím stranám mimo zpracovatele níže. Lidé je nečtou, s výjimkou případů, kdy k tomu dáte souhlas, kdy je to nutné z bezpečnostních důvodů nebo to vyžaduje zákon.</li>
          <li>Použití a předávání informací získaných z Google API do jakékoli jiné aplikace se řídí zásadami <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noopener noreferrer">Google API Services User Data Policy</a>, včetně požadavků Limited Use.</li>
        </ul>
      </section>

      <section className="settings-card" id="gmail">
        <h2>3a. Gmail (volitelné propojení)</h2>
        {!gmail ? (
          <p data-testid="privacy-gmail-off">Propojení s Gmailem není na tomto serveru zapnuté. ClearSpace zde k vaší e-mailové schránce nepřistupuje a o povolení přístupu ke Gmailu nežádá.</p>
        ) : (
          <ul data-testid="privacy-gmail">
            {gmailMode === 'pilot' && pilotNote('gmail')}
            <li><strong>Oprávnění:</strong> jen čtení (<code>gmail.readonly</code>), o které žádáte zvlášť tlačítkem „Připojit Gmail“. ClearSpace e-maily neodesílá, nemaže, nepřesouvá ani neoznačuje a schránku nesynchronizuje.</li>
            <li><strong>Co se čte:</strong> jen výsledky hledání, které sami zadáte, a e-maily nebo konverzace, které sami připojíte k projektu nebo úkolu.</li>
            <li><strong>Co ukládáme:</strong> u připojeného e-mailu předmět, jméno odesílatele (nebo jen doménu), datum, počet zpráv a příloh, kdo a kdy ho připojil. Odděleně a nepřístupně pro ostatní uživatele ukládáme identifikátor zprávy a vašeho účtu Google, aby šel e-mail znovu otevřít. Obsah e-mailů, adresy a přílohy neukládáme.</li>
            <li><strong>Náhled obsahu</strong> vidí jen ten, kdo e-mail připojil; načte se z jeho schránky pod jeho přístupem a neukládá se. Ostatní členové projektu vidí jen uložené údaje výše – členství v projektu nedává přístup k cizí schránce.</li>
            <li><strong>Vypnout Gmail</strong> (Nastavení → Propojené účty) zastaví používání Gmailu v ClearSpace a volitelně smaže vaše připojené e-maily. Google neumí odebrat jen Gmail: úplné zrušení oprávnění = odpojení účtu Google (Disk i Gmail).</li>
            <li><strong>AI:</strong> ClearSpace <strong>neposílá obsah e-mailů žádnému poskytovateli umělé inteligence</strong> a údaje z Gmailu nepoužívá k trénování obecných modelů AI.</li>
            <li>Pro údaje z Gmailu platí závazně požadavky Limited Use zásad Google API Services User Data Policy (viz bod 3).</li>
          </ul>
        )}
      </section>

      <section className="settings-card" id="calendar">
        <h2>3b. Google Kalendář (volitelné propojení)</h2>
        {!calendar ? (
          <p data-testid="privacy-calendar-off">Propojení s Google Kalendářem není na tomto serveru zapnuté. ClearSpace zde k vašemu kalendáři nepřistupuje a o povolení přístupu ke Kalendáři nežádá.</p>
        ) : (
          <ul data-testid="privacy-calendar">
            {calendarMode === 'pilot' && pilotNote('calendar')}
            <li><strong>Oprávnění:</strong> jen čtení událostí v kalendářích, které vlastníte (<code>calendar.events.owned.readonly</code>), o které žádáte zvlášť tlačítkem „Připojit Google Kalendář“. ClearSpace čte jen váš hlavní kalendář; události nevytváří, nemění, nemaže, nikoho nezve a kalendář nesynchronizuje.</li>
            <li><strong>Vaše vrstva v kalendáři projektu:</strong> vaše události se načítají jen na vaši žádost pro zobrazené období, vidíte je jen vy a neukládají se.</li>
            <li><strong>Co ukládáme u připojené události:</strong> název, začátek a konec, zda jde o celodenní nebo opakovanou událost, časové pásmo události, počet účastníků, jméno organizátora (nebo jen doménu), kdo a kdy událost připojil. Odděleně a nepřístupně pro ostatní uživatele ukládáme identifikátor události a vašeho účtu Google, aby šla událost obnovit. <strong>Neukládáme</strong> popis, místo, adresy ani jména účastníků, odkazy na online schůzky (Google Meet) ani přílohy – ClearSpace je od Google vůbec nepožaduje.</li>
            <li><strong>Soukromé a důvěrné události</strong> nelze k projektu připojit. Odkaz „Otevřít v Google Kalendáři“ dostane jen ten, kdo událost připojil.</li>
            <li><strong>Vypnout Kalendář</strong> (Nastavení → Propojené účty) zastaví čtení kalendáře a volitelně smaže vaše připojené události. Google neumí odebrat jen Kalendář: úplné zrušení oprávnění = odpojení účtu Google (všechny služby).</li>
            <li><strong>AI a porady:</strong> ClearSpace údaje z Google Kalendáře <strong>neposílá žádnému poskytovateli umělé inteligence</strong> ani službě přepisu (Soniox), nepřipojuje se ke schůzkám a nic nenahrává. Údaje z Kalendáře nepoužívá k trénování obecných modelů AI.</li>
            <li>Pro údaje z Google Kalendáře platí požadavky Limited Use zásad Google API Services User Data Policy (viz bod 3).</li>
          </ul>
        )}
      </section>

      <section className="settings-card" id="notifikace">
        <h2>3c. Oznámení mimo aplikaci – Slack a Telegram (volitelné)</h2>
        {!slack && !telegram ? (
          <p data-testid="privacy-notify-off">Oznámení do Slacku ani Telegramu nejsou na tomto serveru zapnutá. ClearSpace zde nikam mimo aplikaci oznámení neposílá.</p>
        ) : (
          <ul data-testid="privacy-notify">
            <li><strong>Komu:</strong> jen vám osobně – do přímých zpráv od aplikace ClearSpace ve vašem Slacku{telegram ? ' nebo do soukromého chatu s botem ClearSpace v Telegramu' : ''}. Nikdy do kanálů, skupin ani jiným lidem. Propojení zapínáte sami v Nastavení; v Telegramu ho navíc potvrzujete v ClearSpace.</li>
            <li><strong>Co zpráva obsahuje:</strong> typ události (např. přiřazení úkolu, blížící se termín), jméno toho, kdo změnu udělal, název úkolu a projektu, termín a odkaz do ClearSpace. Volbou „Neposílat názvy“ omezíte zprávu na typ a odkaz. <strong>Nikdy</strong> text komentářů, popisy úkolů, přílohy ani údaje z Google Disku, Gmailu či Kalendáře.</li>
            <li><strong>Kontrola přístupu:</strong> těsně před každým odesláním se znovu ověří, že k projektu a úkolu stále máte přístup a že máte daný typ oznámení zapnutý; jinak se zpráva nepošle.</li>
            <li><strong>Co ukládáme:</strong> šifrovaně přístupový údaj (Slack: token aplikace pro váš workspace a vaše ID ve Slacku; Telegram: ID chatu), název workspace nebo jméno v Telegramu (vidíte jen vy) a frontu odeslaných oznámení bez textu (jen identifikátory a stav) po dobu 30 dní.</li>
            <li><strong>Slack a Telegram</strong> jsou samostatní správci zpráv, které vám doručí; zprávy u sebe ukládají podle svých pravidel. Odpojením v ClearSpace smažeme přístupové údaje (u Slacku zrušíme i token, pokud ho nepoužívají další lidé z vašeho workspace).</li>
            <li>Údaje z oznámení se neposílají žádnému poskytovateli umělé inteligence.</li>
          </ul>
        )}
      </section>

      <section className="settings-card" id="retention">
        <h2>4. Uchování a výmaz</h2>
        <ul>
          <li>Údaje účtu a projektů uchováváme, dokud účet nebo projekt existuje.</li>
          <li>Připojení k Google (šifrované tokeny, e-mail účtu Google) smažeme při odpojení účtu Google nebo při zrušení účtu ClearSpace. Odpojení v ClearSpace zruší oprávnění i u Google; při zrušení účtu ClearSpace doporučujeme oprávnění odebrat také v nastavení účtu Google (nebo nejdřív účet Google v ClearSpace odpojit).</li>
          <li>Bezpečnostní záznam o připojení a odpojení (jen událost a čas) uchováváme po dobu existence účtu ClearSpace.</li>
          <li>Odkazy na soubory, které jste připojili k projektům, jsou součástí těchto projektů: zůstávají (bez vazby na váš účet), dokud je člen projektu neodebere nebo dokud projekt nezanikne.</li>
          <li>Rozpracované požadavky na připojení k Google platí 10 minut; po vypršení se odstraňují.</li>
          <li>Výmaz účtu nebo jiných údajů si můžete vyžádat na kontaktu v bodě 1.</li>
        </ul>
      </section>

      <section className="settings-card" id="processors">
        <h2>5. Zpracovatelé</h2>
        <ul>
          <li>Supabase – databáze, přihlášení a úložiště souborů (region EU – Irsko).</li>
          <li>Vercel – provoz webové aplikace.</li>
          <li>Google – propojení s Google Diskem{gmail ? ', Gmailem' : ''}{calendar ? ' a Google Kalendářem' : ''} (jen pokud ho zapnete).</li>
          <li>Resend – odesílání e-mailů (potvrzení účtu, pozvánky do projektů).</li>
          {(slack || telegram) && <li>{[slack && 'Slack', telegram && 'Telegram'].filter(Boolean).join(' a ')} – doručení oznámení, která si sami zapnete (bod 3c).</li>}
          <li>U volitelných AI funkcí a přepisu záznamů porad (jsou-li pro váš účet zapnuté) zpracovávají text nebo zvuk, který do nich sami vložíte, poskytovatelé Google (Gemini) a Soniox. Obsah souborů z Google Disku se jim neposílá.</li>
        </ul>
      </section>

      <section className="settings-card" id="rights">
        <h2>6. Vaše práva</h2>
        <p>Máte právo na přístup k údajům, jejich opravu, výmaz, omezení zpracování, přenositelnost a vznést námitku; můžete se také obrátit na Úřad pro ochranu osobních údajů (<a href="https://uoou.gov.cz" target="_blank" rel="noopener noreferrer">uoou.gov.cz</a>). Žádosti vyřizujeme přes kontakt v bodě 1.</p>
        <p style={{ marginTop: '0.5rem' }}><Link href="/about">Zpět na O aplikaci</Link></p>
      </section>
    </PublicPage>
  );
}
