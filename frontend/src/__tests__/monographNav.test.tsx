import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { buildGroups, MonographRail, MonographBottomNav, type NavEntry } from '../components/layout/MonographNav';

vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => <a href={href} {...rest}>{children}</a> }));

const entry = (key: string, label: string, href: string, active = false): NavEntry => ({ key, label, href, active, testId: `t-${key}` });
const ITEMS = [
  entry('board', 'Board', '/projects/p1', true),
  entry('projects', 'Projekty', '/'),
  entry('ai-studio', 'AI Studio', '/ai-control-center'),
  entry('ai-history', 'Historie AI', '/ai-history'),
  entry('team', 'Tým', '/team'),
];

describe('Monograph navigace nad stejnými položkami jako klasická lišta', () => {
  it('seskupí a očísluje: 01 Projekty, 02 Board, 03 Tým, 04 AI (bez AI pro ne-adminy)', () => {
    expect(buildGroups(ITEMS).map((g) => `${g.n} ${g.label}`)).toEqual(['01 Projekty', '02 Board', '03 Tým', '04 AI']);
    expect(buildGroups(ITEMS.filter((i) => !i.key.startsWith('ai'))).map((g) => g.n)).toEqual(['01', '02', '03']);
  });
  it('rejstřík: skip link, aria-current na aktivní položce, každá destinace dosažitelná, Intelligence jako tlačítko', () => {
    const onIntel = vi.fn();
    render(<MonographRail items={ITEMS} onOpenIntelligence={onIntel} />);
    expect(screen.getByText('Přeskočit na obsah').getAttribute('href')).toBe('#mg-content');
    const nav = screen.getByRole('navigation', { name: 'Hlavní navigace' });
    const links = Array.from(nav.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(links).toEqual(['/', '/projects/p1', '/team', '/ai-control-center']);
    expect(nav.querySelector('[aria-current="page"]')?.textContent).toContain('Board');
    screen.getByRole('button', { name: 'Project Intelligence' }).click();
    expect(onIntel).toHaveBeenCalledOnce();
  });
  it('spodní pruh má stejné cíle a bez Intelligence nevykreslí tlačítko navíc', () => {
    render(<MonographBottomNav items={ITEMS} />);
    const nav = screen.getByRole('navigation', { name: 'Hlavní navigace (mobil)' });
    expect(nav.querySelectorAll('a').length).toBe(4);
    expect(nav.querySelector('button')).toBeNull();
  });
});
