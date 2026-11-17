import { test, expect, type Page } from '@playwright/test';

/**
 * E2E proti současné aplikaci (clearspace, česká UI, projektové routování, mock auth).
 * Běží v demo režimu (localStorage), takže session naseedujeme přes addInitScript a
 * board se sám naseeduje z INITIAL_COLUMNS při navigaci na /projects/project-default.
 * Playwright dává každému testu čistý kontext -> deterministická data.
 */

const MOCK_UID = 'e2e-user';
const BOARD_URL = '/projects/project-default';

async function seedAuth(page: Page) {
  await page.addInitScript((uid) => {
    const session = {
      user: { id: uid, email: 'e2e@clearspace.test', user_metadata: { display_name: 'E2E Tester' } },
      access_token: 'mock-jwt-token-' + uid,
    };
    window.localStorage.setItem('kanban_mock_session', JSON.stringify(session));
    window.localStorage.setItem(
      'kanban_mock_profiles',
      JSON.stringify([{ id: uid, email: 'e2e@clearspace.test', display_name: 'E2E Tester', created_at: new Date().toISOString() }])
    );
  }, MOCK_UID);
}

/** Počká, až doběhnou vstupní animace prvku -- jinak se měří rozměry uprostřed scaleIn. */
async function settled(page: Page, selector: string) {
  await page.locator(selector).evaluate((el) =>
    Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => {})))
  );
}

/**
 * Kalendář se otevírá na AKTUÁLNÍM měsíci, ale demo seed (INITIAL_COLUMNS) má pevné
 * termíny v červenci 2026. Testy kalendáře proto zmrazí čas v tomto měsíci --
 * jinak procházejí jen v červenci a kdykoli jindy hlásí "žádné karty v mřížce".
 * `setFixedTime` mění jen Date (ne časovače), takže animace a čekání běží normálně.
 */
const SEED_MONTH_NOW = new Date('2026-07-15T12:00:00');

async function freezeToSeedMonth(page: Page) {
  await page.clock.setFixedTime(SEED_MONTH_NOW);
  await page.reload();
  await expect(page.locator('.app-container')).toHaveAttribute('data-hydrated', 'true');
}

test.describe('Clearspace board E2E', () => {
  test.beforeEach(async ({ page }) => {
    page.on('pageerror', (err) => console.log('BROWSER ERROR:', err.message));
    await seedAuth(page);
    await page.goto(BOARD_URL);
    // Počkej na klientskou hydrataci (event handlery navázané).
    await expect(page.locator('.app-container')).toHaveAttribute('data-hydrated', 'true');
  });

  test('vykreslí board s českými sloupci a správnými počty', async ({ page }) => {
    for (const name of ['Nápady', 'Naplánováno', 'V průběhu', 'K revizi', 'Hotovo']) {
      await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
    }
    await expect(page.getByTestId('column-count-column-1')).toHaveText('2');
    await expect(page.getByTestId('column-count-column-2')).toHaveText('2');
    await expect(page.getByTestId('column-count-column-3')).toHaveText('1');
    await expect(page.getByTestId('column-count-column-4')).toHaveText('1');
    await expect(page.getByTestId('column-count-column-5')).toHaveText('1');
  });

  test('přidá kartu do sloupce Nápady', async ({ page }) => {
    await page.getByTestId('add-card-btn-column-1').click();

    const modal = page.getByRole('dialog');
    await expect(modal).toBeVisible();
    await expect(modal.locator('h2')).toHaveText('Přidat kartu do: Nápady');

    await modal.locator('#card-title').fill('Napsat E2E testy');
    await modal.locator('#card-details').fill('Automatizovat klíčové toky přes Playwright.');
    await modal.locator('button[type="submit"]').click();

    await expect(modal).not.toBeVisible();
    await expect(page.getByText('Napsat E2E testy')).toBeVisible();
    await expect(page.getByTestId('column-count-column-1')).toHaveText('3');
  });

  test('přejmenuje sloupec', async ({ page }) => {
    await page.getByTestId('column-title-column-4').click();
    const input = page.getByTestId('column-input-column-4');
    await expect(input).toBeVisible();
    await input.fill('QA & Ověření');
    await input.press('Enter');
    await expect(page.getByTestId('column-title-column-4')).toHaveText('QA & Ověření');
  });

  test('přetáhne kartu mezi sloupci', async ({ page }) => {
    // Nativní HTML5 drag&drop -- Playwrightův dragTo() ho nespouští spolehlivě,
    // takže dispatchneme sekvenci DnD eventů se sdíleným DataTransfer.
    const card = page.getByTestId('card-card-3'); // Konfigurace CI/CD pipeline (Naplánováno)
    const target = page.getByTestId('column-column-4'); // K revizi
    await expect(card).toBeVisible();
    await expect(page.getByTestId('column-count-column-2')).toHaveText('2');
    await expect(page.getByTestId('column-count-column-4')).toHaveText('1');

    const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
    await card.dispatchEvent('dragstart', { dataTransfer });
    await target.dispatchEvent('dragenter', { dataTransfer });
    await target.dispatchEvent('dragover', { dataTransfer });
    await target.dispatchEvent('drop', { dataTransfer });
    await card.dispatchEvent('dragend', { dataTransfer });

    await expect(page.getByTestId('column-count-column-2')).toHaveText('1');
    await expect(page.getByTestId('column-count-column-4')).toHaveText('2');
    await expect(page.getByTestId('cards-list-column-4').getByTestId('card-card-3')).toBeVisible();
  });

  test('Project Intelligence: chip má pulse tečku a panel ukazuje deterministické insighty', async ({ page }) => {
    // Pulse chip nese živý stav zdraví.
    await expect(page.getByTestId('pi-chip-dot')).toBeVisible();

    await page.getByTestId('project-intelligence-btn').click();

    const panel = page.getByTestId('project-intelligence-drawer');
    await expect(panel).toBeVisible();
    // Deterministický insight: card-4 má tag "Blokováno" -> 1 blokovaný úkol.
    await expect(panel.getByText(/blokovan/i).first()).toBeVisible();
    // Zdraví a doporučené akce jsou přítomné.
    await expect(page.getByTestId('pi-health')).toBeVisible();
    await expect(page.getByTestId('pi-actions')).toBeVisible();
  });

  test('hero zůstává na desktopu výchozí rozbalené', async ({ page }) => {
    await expect(page.locator('.app-hero')).not.toHaveClass(/collapsed/);
    await expect(page.locator('.hero-title')).toBeVisible();
  });

  test('kalendář zůstává na desktopu read-only (dny nejsou klikací)', async ({ page }) => {
    await freezeToSeedMonth(page);
    await page.getByTestId('view-switch-calendar').click();
    await expect(page.getByTestId('calendar-grid')).toBeVisible();
    // Mobilní dotyková vrstva ani tečky na desktopu neexistují v layoutu.
    await expect(page.locator('.calendar-day-tap').first()).toBeHidden();
    await expect(page.locator('.calendar-day-dots').first()).toBeHidden();
    // Chipy s názvy zůstávají přímo v buňkách jako dosud.
    await expect(page.locator('.calendar-day-cards .calendar-card-chip').first()).toBeVisible();
  });

  test('Project Intelligence se otevře klávesovou zkratkou (Ctrl/Cmd+I)', async ({ page }) => {
    await expect(page.getByTestId('project-intelligence-drawer')).toHaveCount(0);
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.keyboard.press(`${modifier}+KeyI`);
    await expect(page.getByTestId('project-intelligence-drawer')).toBeVisible();
  });
});

/**
 * Mobilní navigace (<= 767px). Desktopové akce se přesouvají do hamburger menu,
 * takže testujeme, že jsou odtamtud stále dostupné a že se nic neztratilo.
 */
test.describe('Clearspace mobilní navigace', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test.beforeEach(async ({ page }) => {
    await seedAuth(page);
    await page.goto(BOARD_URL);
    await expect(page.locator('.app-container')).toHaveAttribute('data-hydrated', 'true');
  });

  test('hamburger otevře menu a nabídne navigaci i board akce', async ({ page }) => {
    // Desktopová navigace i toolbarové akce jsou na mobilu skryté...
    await expect(page.locator('.navbar-center')).toBeHidden();
    await expect(page.getByTestId('project-intelligence-btn')).toBeHidden();

    // ...ale dostupné z menu.
    const burger = page.getByTestId('navbar-burger');
    await expect(burger).toBeVisible();
    await burger.click();

    const menu = page.getByTestId('mobile-menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('link', { name: 'Projekty' })).toBeVisible();
    await expect(page.getByTestId('mobile-menu-intelligence')).toBeVisible();
    await expect(page.getByTestId('mobile-menu-new-task')).toBeVisible();
    await expect(page.getByTestId('mobile-menu-logout')).toBeVisible();

    // Escape zavře.
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
  });

  test('Project Intelligence lze otevřít z mobilního menu', async ({ page }) => {
    await page.getByTestId('navbar-burger').click();
    await page.getByTestId('mobile-menu-intelligence').click();

    await expect(page.getByTestId('mobile-menu')).toHaveCount(0);
    await expect(page.getByTestId('project-intelligence-drawer')).toBeVisible();
  });

  test('sloupce mají na mobilu pevnou šířku a je vidět kus dalšího', async ({ page }) => {
    const box = await page.locator('.column').first().boundingBox();
    const container = await page.locator('.board-container').boundingBox();
    expect(box!.width).toBeCloseTo(280, 0);
    // Peek: sloupec je užší než kontejner, takže je zřejmé, že se scrolluje do strany.
    expect(container!.width).toBeGreaterThan(box!.width + 20);
  });

  test('drawer je na mobilu fullscreen bez pozicovacího baru a s dostupným křížkem', async ({ page }) => {
    await page.getByTestId('navbar-burger').click();
    await page.getByTestId('mobile-menu-intelligence').click();

    const drawer = page.getByTestId('project-intelligence-drawer');
    await expect(drawer).toBeVisible();
    // Pozicovací bar nemá na fullscreenu co ovlivňovat -> skrytý.
    await expect(page.getByTestId('pi-mode-switcher')).toBeHidden();

    // Panel vyplní šířku a křížek je uvnitř viewportu (dřív ho bar vytlačil ven).
    await settled(page, '[data-testid="project-intelligence-drawer"]');
    const box = await drawer.boundingBox();
    expect(box!.width).toBe(375);
    const close = await page.getByTestId('pi-close-btn').boundingBox();
    expect(close!.x + close!.width).toBeLessThanOrEqual(375);

    // Obsah se vejde bez vodorovného scrollu.
    const inner = await drawer.locator('.drawer-scroll-area').evaluate(
      (el) => el.scrollWidth - el.clientWidth
    );
    expect(inner).toBeLessThanOrEqual(0);
  });

  test('dialog je na mobilu fullscreen a patička dosedne ke spodní hraně', async ({ page }) => {
    await page.getByTestId('navbar-burger').click();
    await page.getByTestId('mobile-menu-new-task').click();

    const modal = page.locator('.modal-content');
    await expect(modal).toBeVisible();
    await settled(page, '.modal-content');
    const box = await modal.boundingBox();
    expect(box!.width).toBe(375);

    const footer = await modal.locator('.modal-footer').boundingBox();
    expect(footer!.y + footer!.height).toBeGreaterThan(800);
  });

  test('kalendář je kompaktní: tečky místo názvů, klepnutí na den rozbalí seznam', async ({ page }) => {
    await freezeToSeedMonth(page);
    await page.getByTestId('navbar-burger').click();
    await page.getByTestId('mobile-menu-calendar').click();

    const grid = page.getByTestId('calendar-grid');
    await expect(grid).toBeVisible();
    // Do ~49px buňky se název nevejde -> chipy jsou skryté, zůstávají tečky.
    await expect(grid.locator('.calendar-day-cards').first()).toBeHidden();
    await expect(grid.locator('.calendar-day-dots').first()).toBeVisible();

    // Klepnutí na den s termínem rozbalí seznam pod mřížkou.
    const day = grid.locator('.calendar-day', { has: page.locator('.calendar-day-dots') }).first();
    await day.locator('.calendar-day-tap').click();

    const detail = page.getByTestId('calendar-day-detail');
    await expect(detail).toBeVisible();
    await expect(detail.locator('.calendar-detail-chip')).not.toHaveCount(0);

    // Karta ze seznamu otevře detail úkolu -- funkce zůstává dostupná.
    await detail.locator('.calendar-detail-chip').first().click();
    await expect(page.getByTestId('task-detail-drawer')).toBeVisible();
  });

  test('všechny dotykové cíle na boardu mají aspoň 44x44', async ({ page }) => {
    const small = await page.evaluate(() => {
      const sel = 'button,a,select,input,[role="button"],textarea';
      return [...document.querySelectorAll(sel)]
        .filter((e) => {
          const b = e.getBoundingClientRect();
          return b.width > 0 && b.height > 0 && (b.width < 44 || b.height < 44);
        })
        .map((e) => {
          const b = e.getBoundingClientRect();
          const id = (e as HTMLElement).dataset.testid || e.className || e.tagName;
          return `${id}|${Math.round(b.width)}x${Math.round(b.height)}`;
        });
    });
    expect(small).toEqual([]);
  });

  test('hero je na mobilu výchozí sbalené, ale volba uživatele má přednost', async ({ page }) => {
    // Bez uložené volby -> sbalené, board začíná výš.
    // (Sbalení jede přes opacity/0fr, takže se testuje stavová třída.)
    await expect(page.locator('.app-hero')).toHaveClass(/collapsed/);
    // Sbalení je animované -- bez počkání se měří mezihodnota a test bliká.
    await settled(page, '.app-hero');
    const collapsedTop = await page.locator('.board-container').evaluate(
      (el) => Math.round(el.getBoundingClientRect().top + window.scrollY)
    );

    // Rozbalení se uloží...
    await page.getByTestId('toolbar-toggle-hero-btn').click();
    await expect(page.locator('.app-hero')).not.toHaveClass(/collapsed/);
    await settled(page, '.app-hero');
    const expandedTop = await page.locator('.board-container').evaluate(
      (el) => Math.round(el.getBoundingClientRect().top + window.scrollY)
    );
    expect(expandedTop).toBeGreaterThan(collapsedTop);

    // ...a přežije reload, tedy mobilní výchozí stav ji nepřebije.
    await page.reload();
    await expect(page.locator('.app-hero')).not.toHaveClass(/collapsed/);
  });

  test('globální hledání je na mobilu dostupné z menu', async ({ page }) => {
    // .navbar-right je na mobilu skrytý, takže tlačítko hledání z lišty
    // není dosažitelné -- musí být v hamburger menu.
    await expect(page.getByTestId('open-global-search-btn')).toBeHidden();

    await page.getByTestId('navbar-burger').click();
    await page.getByTestId('mobile-menu-search').click();
    await expect(page.getByTestId('global-search-modal')).toBeVisible();
  });

  test('stránka na 375px vodorovně nepřetéká', async ({ page }) => {
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
