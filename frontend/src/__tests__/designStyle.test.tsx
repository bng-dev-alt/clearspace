import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { resolveDesignStyle } from '../lib/designStyle';

// Původní no-flash skript (před Monograph integrací). Bez příznaku musí zůstat znak po znaku stejný.
const ORIGINAL_NO_FLASH = `(function(){try{var t=localStorage.getItem('clearspace-theme')||'system';var d=t==='dark'||(t==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.setAttribute('data-theme',d?'dark':'light');}catch(e){document.documentElement.setAttribute('data-theme','light');}})();`;

describe('resolveDesignStyle (čistá logika)', () => {
  it('příznak vypnutý => vždy stávající vzhled, i když je v úložišti monograph', () => {
    expect(resolveDesignStyle('monograph', false)).toBe('existing');
    expect(resolveDesignStyle(null, false)).toBe('existing');
  });
  it('příznak zapnutý => monograph jen při explicitní uložené volbě, nikdy jako výchozí', () => {
    expect(resolveDesignStyle('monograph', true)).toBe('monograph');
    expect(resolveDesignStyle(null, true)).toBe('existing');
    expect(resolveDesignStyle('existing', true)).toBe('existing');
    expect(resolveDesignStyle('cokoliv-jineho', true)).toBe('existing');
  });
});

async function loadTheme(flag: '1' | '') {
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

  it('příznak vypnutý: uložený monograph se ignoruje, data-style se nenastaví, no-flash skript je beze změny', async () => {
    localStorage.setItem('clearspace-style', 'monograph');
    const m = await loadTheme('');
    expect(m.themeNoFlashScript).toBe(ORIGINAL_NO_FLASH);
    render(<m.ThemeProvider><Probe useTheme={m.useTheme} /></m.ThemeProvider>);
    expect(screen.getByTestId('style').textContent).toBe('existing');
    expect(document.documentElement.hasAttribute('data-style')).toBe(false);
    // ani programové nastavení nesmí styl zapnout
    act(() => screen.getByText('go').click());
    expect(document.documentElement.hasAttribute('data-style')).toBe(false);
    expect(screen.getByTestId('style').textContent).toBe('existing');
  });

  it('příznak zapnutý: výchozí je stávající; uložený monograph se použije; volba se ukládá', async () => {
    const m = await loadTheme('1');
    expect(m.themeNoFlashScript.startsWith(ORIGINAL_NO_FLASH)).toBe(true);
    expect(m.themeNoFlashScript).toContain("data-style");
    const first = render(<m.ThemeProvider><Probe useTheme={m.useTheme} /></m.ThemeProvider>);
    expect(screen.getByTestId('style').textContent).toBe('existing');
    expect(document.documentElement.hasAttribute('data-style')).toBe(false);
    act(() => screen.getByText('go').click());
    expect(document.documentElement.getAttribute('data-style')).toBe('monograph');
    expect(localStorage.getItem('clearspace-style')).toBe('monograph');
    first.unmount();
    document.documentElement.removeAttribute('data-style');
    render(<m.ThemeProvider><Probe useTheme={m.useTheme} /></m.ThemeProvider>);
    expect(screen.getByTestId('style').textContent).toBe('monograph');
    expect(document.documentElement.getAttribute('data-style')).toBe('monograph');
  });
});
