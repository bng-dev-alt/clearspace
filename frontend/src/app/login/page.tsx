'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '../../hooks/useAuth';
import { LogIn, Mail, Lock } from 'lucide-react';
import { Button } from '../../components/ui';

export default function LoginPage() {
  const { login, loginWithOAuth } = useAuth();
  const router = useRouter();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password.trim()) {
      setError('Vyplňte prosím všechna povinná pole.');
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      await login(email, password);
      router.push('/');
    } catch (err: unknown) {
      console.error(err);
      setError(err instanceof Error ? err.message : 'Přihlášení se nezdařilo. Zkontrolujte prosím své údaje.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleOAuthLogin = async (provider: 'google' | 'github') => {
    setError(null);
    try {
      await loginWithOAuth(provider);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : `OAuth přihlášení přes ${provider} selhalo.`);
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        minHeight: '100vh',
        width: '100vw',
        backgroundColor: 'var(--bg-page)',
        fontFamily: 'var(--font-sans)',
      }}
    >
      {/* Levý panel -- pevná redakční tmavá identita, nezávislá na motivu
          aplikace (viz níže). Redesign Etapa 1 (DESIGN_PLAN.md): tři
          vrstvené organické skvrny místo dvou plochých + jemné zrno místo
          čisté barvy -- Design Bible žádala "ambient lighting" a "subtle
          texture", což tu dřív chybělo. */}
      <div
        style={{
          flex: '1.2',
          backgroundColor: '#0e2833', // Pevná ocean navy -- nezávislá na motivu (var(--text) se v dark mode obracel na světlou -> bílé logo/nadpis mizely)
          padding: '4rem',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          color: '#ffffff',
          position: 'relative',
          overflow: 'hidden',
        }}
        className="login-left-panel"
      >
        {/* Jemné zrno -- rozbíjí plochost barvy bez nutnosti obrázkové předlohy. */}
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 0,
            backgroundImage: 'radial-gradient(circle, rgba(255,255,255,0.05) 1px, transparent 1px)',
            backgroundSize: '3px 3px',
            opacity: 0.5,
            pointerEvents: 'none',
          }}
        />
        {/* Skvrna 1: teplý jantarový svit (vpravo nahoře) */}
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: '-22%',
            right: '-12%',
            width: '460px',
            height: '460px',
            borderRadius: '50%',
            background: 'radial-gradient(circle, rgba(217, 154, 11, 0.18) 0%, rgba(0,0,0,0) 70%)',
          }}
        />
        {/* Skvrna 2: emeraldový svit (vlevo dole) */}
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            bottom: '-12%',
            left: '-12%',
            width: '340px',
            height: '340px',
            borderRadius: '50%',
            background: 'radial-gradient(circle, rgba(52, 201, 138, 0.16) 0%, rgba(0,0,0,0) 70%)',
          }}
        />
        {/* Skvrna 3: jemný krémový highlight uprostřed -- dodává hloubku vrstvení. */}
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: '38%',
            left: '18%',
            width: '260px',
            height: '260px',
            borderRadius: '50%',
            background: 'radial-gradient(circle, rgba(251, 249, 244, 0.05) 0%, rgba(0,0,0,0) 72%)',
          }}
        />

        <div style={{ fontSize: '1.5rem', fontWeight: 800, letterSpacing: '-0.03em', color: '#ffffff', zIndex: 10 }}>
          clearspace<span style={{ color: 'var(--accent-yellow)' }}>.</span>
        </div>

        <div style={{ maxWidth: '460px', zIndex: 10 }}>
          <span
            style={{
              color: 'var(--blue-primary)',
              fontSize: '0.7rem',
              fontWeight: 700,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              display: 'block',
              marginBottom: '0.5rem',
            }}
          >
            SaaS Kanban Board
          </span>
          <h1
            style={{
              fontFamily: 'var(--font-serif)',
              fontSize: '3rem',
              fontWeight: 700,
              lineHeight: '1.2',
              marginBottom: '1.5rem',
              letterSpacing: '-0.02em',
            }}
          >
            Pracujte s lehkostí.
          </h1>
          <p
            style={{
              color: 'var(--text-muted)',
              fontSize: '0.95rem',
              fontWeight: 500,
              lineHeight: '1.5',
            }}
          >
            Jednoduchá, rychlá a přehledná správa vašich týmových projektů v moderním designovém prostředí.
          </p>
        </div>

        <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem', fontWeight: 500, zIndex: 10 }}>
          &copy; {new Date().getFullYear()} clearspace. Všechna práva vyhrazena.
        </div>
      </div>

      {/* Pravý panel -- teplé pozadí stránky s plovoucí glass kartou
          (Design Bible: "Floating authentication card... subtle glass,
          premium shadow, rounded corners"). Dřív to byl plochý panel
          přisazený k hraně, ne karta. */}
      <div
        style={{
          flex: '1',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '2.5rem',
          backgroundColor: 'var(--bg-page)',
        }}
      >
        <div
          style={{
            width: '100%',
            maxWidth: '420px',
            display: 'flex',
            flexDirection: 'column',
            gap: '2rem',
            backgroundColor: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-card)',
            boxShadow: 'var(--shadow-lg)',
            padding: '2.5rem',
          }}
        >
          <div>
            <h2
              style={{
                fontSize: '1.75rem',
                fontWeight: 800,
                color: 'var(--dark-navy)',
                letterSpacing: '-0.02em',
                marginBottom: '0.5rem',
              }}
            >
              Vítejte zpět
            </h2>
            <p style={{ color: 'var(--gray-text)', fontSize: '0.85rem', fontWeight: 500 }}>
              Přihlaste se ke svému účtu clearspace.
            </p>
          </div>

          {error && (
            <div
              style={{
                padding: '0.75rem 1rem',
                backgroundColor: 'var(--danger-soft)',
                color: 'var(--danger)',
                borderRadius: 'var(--radius)',
                fontSize: '0.8rem',
                fontWeight: 600,
                border: '1px solid var(--danger-soft)',
              }}
            >
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              <label htmlFor="email" className="cs-label">
                E-mail *
              </label>
              <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                <Mail
                  size={16}
                  style={{
                    position: 'absolute',
                    left: '0.85rem',
                    color: 'var(--gray-text)',
                  }}
                />
                <input
                  id="email"
                  type="email"
                  placeholder="jmeno@firma.cz"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="cs-input"
                  style={{ paddingLeft: '2.5rem', fontSize: 'var(--auth-input-font)' }}
                  required
                />
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              <label htmlFor="password" className="cs-label">
                Heslo *
              </label>
              <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                <Lock
                  size={16}
                  style={{
                    position: 'absolute',
                    left: '0.85rem',
                    color: 'var(--gray-text)',
                  }}
                />
                <input
                  id="password"
                  type="password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="cs-input"
                  style={{ paddingLeft: '2.5rem', fontSize: 'var(--auth-input-font)' }}
                  required
                />
              </div>
            </div>

            <Button type="submit" variant="primary" size="lg" block disabled={isSubmitting}>
              <LogIn size={16} />
              {isSubmitting ? 'Přihlašování...' : 'Přihlásit se'}
            </Button>
          </form>

          {/* Social login divider */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', margin: '0.5rem 0' }}>
            <div style={{ flex: 1, height: '1px', backgroundColor: 'var(--border-color)' }} />
            <span style={{ color: 'var(--gray-text)', fontSize: '0.65rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Nebo</span>
            <div style={{ flex: 1, height: '1px', backgroundColor: 'var(--border-color)' }} />
          </div>

          {/* Social login buttons */}
          <div style={{ display: 'flex', gap: '0.75rem' }}>
            <Button type="button" variant="secondary" onClick={() => handleOAuthLogin('google')} style={{ flex: 1 }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" fill="#FBBC05"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
              </svg>
              Google
            </Button>
            <Button type="button" variant="secondary" onClick={() => handleOAuthLogin('github')} style={{ flex: 1 }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
                <path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.17 6.839 9.49.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.603-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.464-1.11-1.464-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.579.688.481C19.137 20.167 22 16.418 22 12c0-5.523-4.477-10-10-10z"/>
              </svg>
              GitHub
            </Button>
          </div>

          <div style={{ display: 'flex', justifyContent: 'center', fontSize: '0.8rem', fontWeight: 500, color: 'var(--gray-text)' }}>
            Nemáte účet?&nbsp;
            <Link
              href="/register"
              style={{
                color: 'var(--blue-primary)',
                textDecoration: 'none',
                fontWeight: 700
              }}
            >
              Zaregistrujte se
            </Link>
          </div>
        </div>
      </div>

      {/* Visual responsiveness styling */}
      <style jsx>{`
        @media (max-width: 900px) {
          .login-left-panel {
            display: none !important;
          }
        }
      `}</style>
    </div>
  );
}
