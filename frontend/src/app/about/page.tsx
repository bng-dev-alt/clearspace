import type { Metadata } from 'next';
import Link from 'next/link';
import PublicPage from '../../components/legal/PublicPage';
import { calendarFeatureEnabled } from '../../lib/google/config';

export const metadata: Metadata = { title: 'O aplikaci – ClearSpace' };

/** Public homepage of the app (Google OAuth consent screen "Application home page"): readable without login. */
export default function AboutPage() {
  return (
    <PublicPage label="O APLIKACI" title="ClearSpace" lead="Jednoduchá, rychlá a přehledná správa týmových projektů a úkolů.">
      <section className="settings-card">
        <h2>Co ClearSpace umí</h2>
        <ul>
          <li>Projekty a kanbanové tabule s úkoly, termíny, kontrolními seznamy a komentáři.</li>
          <li>Spolupráce v týmu: pozvánky, role (vlastník, správce, člen, čtenář) a změny v reálném čase.</li>
          <li>Přílohy k úkolům a volitelné propojení s Google Diskem.</li>
        </ul>
      </section>
      <section className="settings-card" id="google">
        <h2>Propojení s Google Diskem</h2>
        <p>Po připojení účtu Google můžete k projektům a úkolům přidávat odkazy na soubory, které sami vyberete v okně Google Disku. ClearSpace získá přístup jen k těmto vybraným souborům, nemění jejich sdílení a nic v Disku nemaže. Ostatní členové projektu uvidí název a odkaz; obsah otevřou jen ti, komu soubor zpřístupníte v Google Disku. Připojení můžete kdykoli zrušit.</p>
        <p style={{ marginTop: '0.5rem' }}>Podrobnosti o zpracování údajů: <Link href="/privacy">Ochrana osobních údajů</Link>.</p>
      </section>
      {calendarFeatureEnabled() && (
        <section className="settings-card" id="calendar" data-testid="about-calendar">
          <h2>Propojení s Google Kalendářem</h2>
          <p>Po povolení jen pro čtení vidíte v kalendáři projektu své vlastní události (jen vy) a můžete k projektu nebo úkolu připojit vybrané události. Členové projektu uvidí jen název, čas, počet účastníků a organizátora. ClearSpace v kalendáři nic nevytváří ani nemění; soukromé události připojit nelze.</p>
          <p style={{ marginTop: '0.5rem' }}>Podrobnosti: <Link href="/privacy#calendar">Ochrana osobních údajů – Google Kalendář</Link>.</p>
        </section>
      )}
      <section className="settings-card">
        <h2>Začít</h2>
        <p><Link href="/login">Přihlásit se</Link> nebo <Link href="/register">založit účet</Link>.</p>
      </section>
    </PublicPage>
  );
}
