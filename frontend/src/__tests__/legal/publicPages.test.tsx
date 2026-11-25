import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import PrivacyPage from '../../app/privacy/page';
import AboutPage from '../../app/about/page';

vi.mock('next/navigation', () => ({ usePathname: () => '/privacy', useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));

describe('RUN 02C public pages (Google OAuth homepage + privacy policy)', () => {
  afterEach(() => { delete process.env.PRIVACY_CONTROLLER; delete process.env.PRIVACY_CONTACT_EMAIL; });

  it('privacy policy states the Google data truthfully: picked files only, stored metadata, encrypted tokens, team access, disconnect, removal, no AI, Limited Use', () => {
    render(<PrivacyPage />);
    const t = document.body.textContent ?? '';
    for (const must of ['jen k souborům, které sami vyberete', 'drive.file', 'Obsah souboru neukládáme', 'AES-256-GCM',
      'nedává přístup k obsahu', 'Odebrání odkazu', 'Odpojení účtu Google', 'neposílá obsah souborů z Google Disku žádnému poskytovateli umělé inteligence',
      'Limited Use', 'myaccount.google.com/permissions']) {
      expect(t, must).toContain(must.replace('myaccount.google.com/permissions', 'nastavení účtu Google'));
    }
    expect(document.querySelector('a[href="https://developers.google.com/terms/api-services-user-data-policy"]')).toBeTruthy();
    expect(document.querySelector('a[href="https://myaccount.google.com/permissions"]')).toBeTruthy();
  });

  it('never invents the controller: without server env it says contact details are missing (rollout blocker)', () => {
    render(<PrivacyPage />);
    expect(screen.getByTestId('privacy-contact-missing')).toBeTruthy();
    expect(screen.queryByTestId('privacy-contact')).toBeNull();
  });

  it('shows the controller and a mailto contact only from server env, and rejects a malformed address', () => {
    process.env.PRIVACY_CONTROLLER = 'Testovací správce';
    process.env.PRIVACY_CONTACT_EMAIL = 'privacy@example.test';
    const { unmount } = render(<PrivacyPage />);
    expect(screen.getByTestId('privacy-contact').textContent).toContain('Testovací správce');
    expect(document.querySelector('a[href="mailto:privacy@example.test"]')).toBeTruthy();
    unmount();
    process.env.PRIVACY_CONTACT_EMAIL = 'x" onmouseover="alert(1)';
    render(<PrivacyPage />);
    expect(screen.getByTestId('privacy-contact-missing')).toBeTruthy();
  });

  it('homepage describes the app (not only a login page) and links to the privacy policy', () => {
    render(<AboutPage />);
    expect(document.body.textContent).toContain('Propojení s Google Diskem');
    expect(document.querySelector('main a[href="/privacy"]')).toBeTruthy();
  });
});
