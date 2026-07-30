'use client';

import React, { useState, useRef, useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '../../hooks/useAuth';
import { useClickOutside } from '../../hooks/useClickOutside';
import { useTheme, ThemeChoice } from '../../contexts/ThemeContext';
import { deriveInitials } from '../../services/workspaceService';
import { LogOut, Sun, Moon, Monitor, Menu, X, Sparkles, Plus, LayoutGrid, CalendarDays, LayoutDashboard, Search } from 'lucide-react';
import AiModelSelector from '../ai/AiModelSelector';

// ThemeToggle component...

const THEME_OPTIONS: { value: ThemeChoice; Icon: typeof Sun; label: string }[] = [
  { value: 'light', Icon: Sun, label: 'Světlý režim' },
  { value: 'system', Icon: Monitor, label: 'Podle systému' },
  { value: 'dark', Icon: Moon, label: 'Tmavý režim' },
];

function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  return (
    <div className="theme-toggle" role="group" aria-label="Přepínač motivu">
      {THEME_OPTIONS.map(({ value, Icon, label }) => (
        <button
          key={value}
          type="button"
          className={`theme-toggle-btn ${theme === value ? 'active' : ''}`}
          onClick={() => setTheme(value)}
          title={label}
          aria-label={label}
          aria-pressed={theme === value}
          data-testid={`theme-${value}`}
        >
          <Icon size={14} />
        </button>
      ))}
    </div>
  );
}

/**
 * Kontext boardu pro mobilní menu. Volitelný -- ostatní stránky renderují
 * <Navbar /> beze změny a příslušné sekce menu se prostě nezobrazí.
 * Díky tomu nevzniká zvláštní "mobilní navbar" ani duplicitní komponenta.
 */
export interface NavbarBoardActions {
  onOpenIntelligence: () => void;
  onNewTask: () => void;
  onOpenSearch?: () => void;
  viewMode: 'board' | 'calendar' | 'dashboard';
  onViewModeChange: (mode: 'board' | 'calendar' | 'dashboard') => void;
}

interface NavbarProps {
  boardActions?: NavbarBoardActions;
}

export default function Navbar({ boardActions }: NavbarProps) {
  const pathname = usePathname() || '';
  const router = useRouter();
  const { profile, logout } = useAuth();
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [lastProjectId, setLastProjectId] = useState<string | null>(null);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const menuPanelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const id = localStorage.getItem('last_opened_project_id');
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLastProjectId(id);
    }
  }, [pathname]);

  useClickOutside(dropdownRef as React.RefObject<HTMLElement | null>, () => {
    setIsDropdownOpen(false);
  });

  // Mobilní menu: Escape zavře, tělo se nescrolluje pod panelem, focus jde do panelu.
  useEffect(() => {
    if (!isMenuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsMenuOpen(false);
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    menuPanelRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [isMenuOpen]);

  // Rozpoznání aktivní sekce podle aktuální adresy
  const isProjectsActive = pathname === '/' || pathname === '/projects';
  const isBoardActive = pathname.startsWith('/projects/');

  const closeMenu = () => setIsMenuOpen(false);

  const handleLogout = async () => {
    setIsDropdownOpen(false);
    closeMenu();
    await logout();
    router.push('/login');
  };

  const handleBoardClick = (e: React.MouseEvent) => {
    e.preventDefault();
    closeMenu();
    if (lastProjectId) {
      router.push(`/projects/${lastProjectId}`);
    } else {
      router.push('/');
    }
  };

  const handleTeamClick = (e: React.MouseEvent) => {
    e.preventDefault();
    closeMenu();
    router.push('/team');
  };

  const displayName = profile?.display_name || profile?.email?.split('@')[0] || 'Uživatel';
  const displayEmail = profile?.email || '';

  const userRole = profile?.workspace_role || 'owner'; // Default owner in demo
  const isAdminOrOwner = userRole === 'owner' || userRole === 'admin';

  // Jediná definice navigace -- používá ji desktop lišta i mobilní menu.
  const navItems = [
    {
      key: 'board',
      label: 'Board',
      href: lastProjectId ? `/projects/${lastProjectId}` : '/',
      onClick: handleBoardClick,
      active: isBoardActive,
      testId: 'navbar-board-link',
    },
    { key: 'projects', label: 'Projekty', href: '/', onClick: closeMenu, active: isProjectsActive },
    ...(isAdminOrOwner
      ? [
          {
            key: 'ai-studio',
            label: 'AI Studio',
            href: '/ai-control-center',
            onClick: closeMenu,
            active: pathname === '/ai-control-center',
          },
          {
            key: 'ai-history',
            label: 'AI History',
            href: '/ai-history',
            onClick: closeMenu,
            active: pathname === '/ai-history',
            testId: 'navbar-history-link',
          },
        ]
      : []),
    { key: 'team', label: 'Tým', href: '/team', onClick: handleTeamClick, active: pathname === '/team', testId: 'navbar-team-link' },
  ];

  const runBoardAction = (fn: () => void) => {
    closeMenu();
    fn();
  };

  return (
    <header className="app-navbar">
      <div className="navbar-left">
        <Link href="/" className="navbar-logo" style={{ textDecoration: 'none', cursor: 'pointer' }}>
          clearspace<span className="logo-dot">.</span>
        </Link>
      </div>

      <nav className="navbar-center">
        {navItems.map((item) => (
          <Link
            key={item.key}
            href={item.href}
            onClick={item.onClick}
            className={`nav-link ${item.active ? 'active' : ''}`}
            style={{ textDecoration: 'none', cursor: 'pointer' }}
            data-testid={item.testId}
          >
            {item.label}
          </Link>
        ))}
      </nav>

      {/* Layout v CSS (ne inline), aby na něj dosáhly breakpointy -- na mobilu se skrývá do menu. */}
      <div className="navbar-right" ref={dropdownRef}>
        {boardActions?.onOpenSearch && (
          <button
            type="button"
            onClick={boardActions.onOpenSearch}
            title="Hledat (Cmd+K)"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.35rem',
              padding: '0.3rem 0.6rem',
              backgroundColor: 'var(--surface-1)',
              border: '1px solid var(--border-color)',
              borderRadius: '8px',
              fontSize: '0.75rem',
              fontWeight: 600,
              color: 'var(--gray-text)',
              cursor: 'pointer',
            }}
            className="navbar-search-btn"
            data-testid="open-global-search-btn"
          >
            <Search size={14} />
            <span
              className="navbar-search-hint"
              style={{ fontSize: '0.65rem', fontWeight: 800, padding: '0.05rem 0.3rem', borderRadius: '4px', backgroundColor: 'var(--bg-column)' }}
            >
              ⌘K
            </span>
          </button>
        )}
        <span className="navbar-model-selector">
          <AiModelSelector compact />
        </span>
        <ThemeToggle />
        <button
          type="button"
          onClick={() => setIsDropdownOpen(!isDropdownOpen)}
          className="navbar-avatar"
          style={{
            cursor: 'pointer',
            border: 'none',
            outline: 'none',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'var(--spring-transition)',
          }}
          onMouseEnter={(e) => e.currentTarget.style.filter = 'brightness(1.1)'}
          onMouseLeave={(e) => e.currentTarget.style.filter = 'none'}
          data-testid="navbar-avatar-btn"
        >
          {deriveInitials(displayName)}
        </button>

        {isDropdownOpen && (
          <div
            style={{
              position: 'absolute',
              right: 0,
              top: '2.5rem',
              backgroundColor: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-md)',
              boxShadow: 'var(--shadow-lg)',
              padding: '1rem',
              minWidth: '220px',
              zIndex: 100,
              display: 'flex',
              flexDirection: 'column',
              gap: '0.75rem',
              fontFamily: 'var(--font-sans)',
            }}
            data-testid="navbar-dropdown"
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
              <span style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--dark-navy)' }}>
                {displayName}
              </span>
              <span style={{ fontSize: '0.7rem', color: 'var(--gray-text)', wordBreak: 'break-all' }}>
                {displayEmail}
              </span>
            </div>

            <div style={{ height: '1px', backgroundColor: 'var(--border-color)', margin: '0.25rem 0' }} />

            <button
              type="button"
              onClick={handleLogout}
              style={{
                background: 'none',
                border: 'none',
                outline: 'none',
                padding: '0.4rem 0.5rem',
                fontSize: '0.8rem',
                fontWeight: 600,
                color: 'var(--danger)',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                borderRadius: 'var(--radius-sm)',
                width: '100%',
                transition: 'background-color 0.2s ease',
              }}
              onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--danger-soft)'}
              onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
              data-testid="logout-btn"
            >
              <LogOut size={14} />
              Odhlásit se
            </button>
          </div>
        )}
      </div>

      {/* --- Mobil: hamburger (viditelný jen pod 768px, řeší CSS) --- */}
      <button
        type="button"
        className="navbar-burger"
        onClick={() => setIsMenuOpen(true)}
        aria-label="Otevřít menu"
        aria-expanded={isMenuOpen}
        aria-controls="mobile-menu"
        data-testid="navbar-burger"
      >
        <Menu size={22} />
      </button>

      {isMenuOpen && (
        <div className="mobile-menu-overlay" onClick={closeMenu} data-testid="mobile-menu-overlay">
          <div
            id="mobile-menu"
            className="mobile-menu"
            role="dialog"
            aria-modal="true"
            aria-label="Hlavní menu"
            tabIndex={-1}
            ref={menuPanelRef}
            onClick={(e) => e.stopPropagation()}
            data-testid="mobile-menu"
          >
            <div className="mobile-menu-head">
              <span className="navbar-logo">clearspace<span className="logo-dot">.</span></span>
              <button
                type="button"
                className="mobile-menu-close"
                onClick={closeMenu}
                aria-label="Zavřít menu"
                data-testid="mobile-menu-close"
              >
                <X size={20} />
              </button>
            </div>

            <nav className="mobile-menu-section" aria-label="Navigace">
              <span className="mobile-menu-label">Navigace</span>
              {navItems.map((item) => (
                <Link
                  key={item.key}
                  href={item.href}
                  onClick={item.onClick}
                  className={`mobile-menu-item ${item.active ? 'active' : ''}`}
                >
                  {item.label}
                </Link>
              ))}
            </nav>

            {boardActions && (
              <>
                <div className="mobile-menu-section">
                  <span className="mobile-menu-label">Akce</span>
                  <button
                    type="button"
                    className="mobile-menu-item"
                    onClick={() => runBoardAction(boardActions.onOpenIntelligence)}
                    data-testid="mobile-menu-intelligence"
                  >
                    <Sparkles size={16} /> Project Intelligence
                  </button>
                  <button
                    type="button"
                    className="mobile-menu-item"
                    onClick={() => runBoardAction(boardActions.onNewTask)}
                    data-testid="mobile-menu-new-task"
                  >
                    <Plus size={16} /> Nový úkol
                  </button>
                  {boardActions.onOpenSearch && (
                    <button
                      type="button"
                      className="mobile-menu-item"
                      onClick={() => runBoardAction(boardActions.onOpenSearch!)}
                      data-testid="mobile-menu-search"
                    >
                      <Search size={16} /> Hledat
                    </button>
                  )}
                </div>

                <div className="mobile-menu-section">
                  <span className="mobile-menu-label">Zobrazení</span>
                  <button
                    type="button"
                    className={`mobile-menu-item ${boardActions.viewMode === 'board' ? 'active' : ''}`}
                    onClick={() => runBoardAction(() => boardActions.onViewModeChange('board'))}
                    data-testid="mobile-menu-board"
                  >
                    <LayoutGrid size={16} /> Board
                  </button>
                  <button
                    type="button"
                    className={`mobile-menu-item ${boardActions.viewMode === 'calendar' ? 'active' : ''}`}
                    onClick={() => runBoardAction(() => boardActions.onViewModeChange('calendar'))}
                    data-testid="mobile-menu-calendar"
                  >
                    <CalendarDays size={16} /> Kalendář
                  </button>
                  <button
                    type="button"
                    className={`mobile-menu-item ${boardActions.viewMode === 'dashboard' ? 'active' : ''}`}
                    onClick={() => runBoardAction(() => boardActions.onViewModeChange('dashboard'))}
                    data-testid="mobile-menu-dashboard"
                  >
                    <LayoutDashboard size={16} /> Dashboard
                  </button>
                </div>
              </>
            )}

            <div className="mobile-menu-section">
              <span className="mobile-menu-label">Motiv</span>
              <ThemeToggle />
            </div>

            <div className="mobile-menu-section mobile-menu-profile">
              <span className="mobile-menu-label">Profil</span>
              <span className="mobile-menu-name">{displayName}</span>
              {displayEmail && <span className="mobile-menu-email">{displayEmail}</span>}
              <button
                type="button"
                className="mobile-menu-item is-danger"
                onClick={handleLogout}
                data-testid="mobile-menu-logout"
              >
                <LogOut size={16} /> Odhlásit se
              </button>
            </div>
          </div>
        </div>
      )}
    </header>
  );
}
