import type { Metadata } from 'next';
import Link from 'next/link';
import PublicPage from '../../components/legal/PublicPage';

export const metadata: Metadata = { title: 'Ochrana osobních údajů – ClearSpace' };
// The controller's identity and contact come from SERVER env (PRIVACY_CONTROLLER, PRIVACY_CONTACT_EMAIL): never hard-coded in the
// public repository, never invented. Unset = the page says so plainly (and the rollout gate treats it as a blocker).
export const dynamic = 'force-dynamic';

const VERSION = '25. listopadu 2026';

export default function PrivacyPage() {
  const controller = process.env.PRIVACY_CONTROLLER?.trim();
  const email = process.env.PRIVACY_CONTACT_EMAIL?.trim();
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
          <li>Google – propojení s Google Diskem (jen pokud ho zapnete).</li>
          <li>Resend – odesílání e-mailů (potvrzení účtu, pozvánky do projektů).</li>
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
