import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { resolveDesignStyle } from '../lib/designStyle';

// Původní no-flash skript (před Monograph integrací). S vypnutým Monographem (=0) musí zůstat znak po znaku stejný.
const ORIGINAL_NO_FLASH = `(function(){try{var t=localStorage.getItem('clearspace-theme')||'system';var d=t==='dark'||(t==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.setAttribute('data-theme',d?'dark':'light');}catch(e){document.documentElement.setAttribute('data-theme','light');}})();`;

describe('resolveDesignStyle (čistá logika)', () => {
  it('příznak vypnutý => vždy stávající vzhled, i když je v úložišti monograph', () => {
    expect(resolveDesignStyle('monograph', false)).toBe('existing');
    expect(resolveDesignStyle(null, false)).toBe('existing');
  });
  it('příznak zapnutý => monograph jen při explicitní uložené volbě, nikdy jako výchozí', () => {
    expect(resolveDesignStyle('monograph', true)).toBe('monograph');
    expect(resolveDesignStyle(null, true)).toBe('monograph'); // nový uživatel: Monograph je výchozí
    expect(resolveDesignStyle('existing', true)).toBe('existing'); // výslovná volba Classic se respektuje
    expect(resolveDesignStyle('cokoliv-jineho', true)).toBe('monograph');
  });
});

async function loadTheme(flag: '1' | '' | '0') {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_ENABLE_MONOGRAPH', flag);
  return import('../contexts/ThemeContext');
}

function Probe({ useTheme }: { useTheme: () => { designStyle: string; setDesignStyle: (s: 'existing' | 'monograph') => void } }) {
  const { designStyle, setDesignStyle } = useTheme();
  return (
    <div>
      <span data-testid="style">{designStyle}</span>
      <button onClick={() => setDesignStyle('monograph')}>go</button>
      <button onClick={() => setDesignStyle('existing')}>classic</button>
    </div>
  );
}

describe('ThemeProvider + příznak NEXT_PUBLIC_ENABLE_MONOGRAPH', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-style');
    window.matchMedia = vi.fn().mockImplementation((q: string) => ({ matches: false, media: q, addEventListener: vi.fn(), removeEventListener: vi.fn() })) as unknown as typeof window.matchMedia;
  });
  afterEach(() => vi.unstubAllEnvs());

  it('vypnuto (=0): uložený monograph se ignoruje, data-style se nenastaví, no-flash skript je beze změny', async () => {
    localStorage.setItem('clearspace-style', 'monograph');
    const m = await loadTheme('0');
    expect(m.themeNoFlashScript).toBe(ORIGINAL_NO_FLASH);
    render(<m.ThemeProvider><Probe useTheme={m.useTheme} /></m.ThemeProvider>);
    expect(screen.getByTestId('style').textContent).toBe('existing');
    expect(document.documentElement.hasAttribute('data-style')).toBe(false);
    // ani programové nastavení nesmí styl zapnout
    act(() => screen.getByText('go').click());
    expect(document.documentElement.hasAttribute('data-style')).toBe(false);
    expect(screen.getByTestId('style').textContent).toBe('existing');
  });

  it.each(['1', ''] as const)('příznak %j (bez příznaku = výchozí): nový uživatel = Monograph; výslovná volba Classic se uloží a respektuje; světlý/tmavý zůstává nezávislý', async (flag) => {
    const m = await loadTheme(flag);
    expect(m.themeNoFlashScript.startsWith(ORIGINAL_NO_FLASH)).toBe(true);
    // no-flash: bez uložené volby nastaví data-style ještě před vykreslením, s volbou 'existing' ne
    document.documentElement.removeAttribute('data-style');
    new Function(m.themeNoFlashScript)();
    expect(document.documentElement.getAttribute('data-style')).toBe('monograph');
    localStorage.setItem('clearspace-style', 'existing');
    document.documentElement.removeAttribute('data-style');
    new Function(m.themeNoFlashScript)();
    expect(document.documentElement.hasAttribute('data-style')).toBe(false);
    localStorage.clear();

    localStorage.setItem('clearspace-theme', 'dark');
    const first = render(<m.ThemeProvider><Probe useTheme={m.useTheme} /></m.ThemeProvider>);
    expect(screen.getByTestId('style').textContent).toBe('monograph');
    expect(document.documentElement.getAttribute('data-style')).toBe('monograph');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    act(() => screen.getByText('classic').click());
    expect(document.documentElement.hasAttribute('data-style')).toBe(false);
    expect(localStorage.getItem('clearspace-style')).toBe('existing');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark'); // styl nemění téma
    first.unmount();
    render(<m.ThemeProvider><Probe useTheme={m.useTheme} /></m.ThemeProvider>);
    expect(screen.getByTestId('style').textContent).toBe('existing');
    expect(document.documentElement.hasAttribute('data-style')).toBe(false);
    act(() => screen.getByText('go').click());
    expect(localStorage.getItem('clearspace-style')).toBe('monograph');
    expect(localStorage.getItem('clearspace-theme')).toBe('dark');
  });
});
