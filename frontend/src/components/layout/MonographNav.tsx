'use client';

/**
 * Navigace designového stylu Monograph (renderuje se JEN když je styl aktivní, viz Navbar).
 * Nemá vlastní data: dostává stejné položky (navItems) jako desktopová lišta a mobilní menu, jen je seskupuje a čísluje.
 *   01 Projekty · 02 Board (podnabídka 02.x = přepínač zobrazení projektu) · 03 Tým · 04 AI (04.1 AI Studio, 04.2 AI History)
 * Desktop >= 901px: 64px svislý rejstřík. <= 900px: číslovaný spodní pruh. Přepínání řeší CSS (monograph.css).
 */
import React from 'react';
import Link from 'next/link';
import { Sparkles } from 'lucide-react';

export interface NavEntry {
  key: string;
  label: string;
  href: string;
  onClick?: (e: React.MouseEvent) => void;
  active: boolean;
  testId?: string;
}

interface Group {
  n: string;
  label: string;
  entries: NavEntry[];
}

export function buildGroups(items: NavEntry[]): Group[] {
  const by = (...keys: string[]) => items.filter((i) => keys.includes(i.key));
  const groups: Group[] = [
    { n: '01', label: 'Projekty', entries: by('projects') },
    { n: '02', label: 'Board', entries: by('board') },
    { n: '03', label: 'Tým', entries: by('team') },
    { n: '04', label: 'AI', entries: by('ai-studio', 'ai-history') },
  ];
  return groups.filter((g) => g.entries.length > 0);
}

export function MonographRail({
  items,
  onOpenIntelligence,
}: {
  items: NavEntry[];
  onOpenIntelligence?: () => void;
}) {
  const groups = buildGroups(items);
  return (
    <>
      <a className="mg-skip" href="#mg-content">Přeskočit na obsah</a>
      <nav className="mg-rail" aria-label="Hlavní navigace">
        <span className="mg-brand" aria-hidden="true">CS</span>
        {groups.map((g) => {
          const first = g.entries[0];
          const active = g.entries.some((e) => e.active);
          return (
            <Link
              key={g.n}
              href={first.href}
              onClick={first.onClick}
              className="mg-tab"
              aria-current={active ? 'page' : undefined}
              data-testid={first.testId}
            >
              <span className="n">{g.n}</span>
              <span className="t">{g.label}</span>
            </Link>
          );
        })}
        {onOpenIntelligence && (
          <div className="mg-rail-foot">
            <button type="button" onClick={onOpenIntelligence} aria-label="Project Intelligence" title="Project Intelligence" data-testid="rail-intelligence">
              <Sparkles size={18} aria-hidden="true" />
            </button>
          </div>
        )}
      </nav>
    </>
  );
}

export function MonographBottomNav({
  items,
  onOpenIntelligence,
}: {
  items: NavEntry[];
  onOpenIntelligence?: () => void;
}) {
  const groups = buildGroups(items);
  return (
    <nav className="mg-bottomnav" aria-label="Hlavní navigace (mobil)">
      {groups.map((g) => {
        const first = g.entries[0];
        const active = g.entries.some((e) => e.active);
        return (
          <Link key={g.n} href={first.href} onClick={first.onClick} aria-current={active ? 'page' : undefined}>
            <span className="n">{g.n}</span>
            <span className="t">{g.label}</span>
          </Link>
        );
      })}
      {onOpenIntelligence && (
        <button type="button" onClick={onOpenIntelligence} data-testid="bottom-intelligence">
          <span className="n" aria-hidden="true">✦</span>
          <span className="t">Intel</span>
        </button>
      )}
    </nav>
  );
}

export interface SubNavItem {
  label: string;
  href: string;
  active: boolean;
  onClick?: () => void;
  testId?: string;
}

/** Číslovaná podnabídka (02.1 …) pro trasy, kde stránka sama přepínač nemá (porady, AI). */
export function MonographSubNav({ n, label, items }: { n: string; label: string; items: SubNavItem[] }) {
  return (
    <nav className="mg-subnav" aria-label={label}>
      {items.map((s, i) => (
        <Link key={s.href + i} href={s.href} onClick={s.onClick} aria-current={s.active ? 'page' : undefined} data-testid={s.testId}>
          <span className="num">{n}.{i + 1}</span>
          <span className="ttl">{s.label}</span>
        </Link>
      ))}
    </nav>
  );
}
