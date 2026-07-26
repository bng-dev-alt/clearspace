'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '../../hooks/useAuth';
import { User, Mail, Lock, Plus, ArrowLeft } from 'lucide-react';
import { Button } from '../../components/ui';

export default function RegisterPage() {
  const { register } = useAuth();
  const router = useRouter();

  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!displayName.trim() || !email.trim() || !password.trim()) {
      setError('Vyplňte prosím všechna povinná pole.');
      return;
    }

    if (password !== confirmPassword) {
      setError('Hesla se neshodují.');
      return;
    }

    if (password.length < 6) {
      setError('Heslo musí mít alespoň 6 znaků.');
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      await register(email, password, displayName);
      router.push('/');
    } catch (err: unknown) {
      console.error(err);
      setError(err instanceof Error ? err.message : 'Registrace se nezdařila. Zkuste to prosím znovu.');
    } finally {
      setIsSubmitting(false);
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
          aplikace. Redesign Etapa 1 (DESIGN_PLAN.md): tři vrstvené
          organické skvrny + jemné zrno, stejně jako na Loginu. */}
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
        className="register-left-panel"
      >
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
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: '-18%',
            right: '-15%',
            width: '480px',
            height: '480px',
            borderRadius: '50%',
            background: 'radial-gradient(circle, rgba(217, 154, 11, 0.18) 0%, rgba(0,0,0,0) 70%)',
          }}
        />
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            bottom: '-20%',
            left: '-8%',
            width: '360px',
            height: '360px',
            borderRadius: '50%',
            background: 'radial-gradient(circle, rgba(52, 201, 138, 0.16) 0%, rgba(0,0,0,0) 70%)',
          }}
        />
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: '40%',
            left: '22%',
            width: '250px',
            height: '250px',
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
            Začněte ihned.
          </h1>
          <p
            style={{
              color: 'var(--text-muted)',
              fontSize: '0.95rem',
              fontWeight: 500,
              lineHeight: '1.5',
            }}
          >
            Vytvořte si bezplatný účet a začněte koordinovat práci svých týmů v přehledném Kanban prostředí během několika sekund.
          </p>
        </div>

        <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem', fontWeight: 500, zIndex: 10 }}>
          &copy; {new Date().getFullYear()} clearspace. Všechna práva vyhrazena.
        </div>
      </div>

      {/* Pravý panel -- plovoucí glass karta na teplém pozadí stránky,
          stejně jako Login. */}
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
            <Link
              href="/login"
              style={{
                color: 'var(--gray-text)',
                textDecoration: 'none',
                fontSize: '0.8rem',
                fontWeight: 600,
                display: 'flex',
                alignItems: 'center',
                gap: '0.35rem',
                marginBottom: '1rem',
                transition: 'color 0.2s ease',
              }}
              onMouseEnter={(e) => e.currentTarget.style.color = 'var(--dark-navy)'}
              onMouseLeave={(e) => e.currentTarget.style.color = 'var(--gray-text)'}
            >
              <ArrowLeft size={14} />
              Zpět na přihlášení
            </Link>
            <h2
              style={{
                fontSize: '1.75rem',
                fontWeight: 800,
                color: 'var(--dark-navy)',
                letterSpacing: '-0.02em',
                marginBottom: '0.5rem',
              }}
            >
              Registrace
            </h2>
            <p style={{ color: 'var(--gray-text)', fontSize: '0.85rem', fontWeight: 500 }}>
              Zaregistrujte si nový účet v systému clearspace.
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
              <label htmlFor="displayName" className="cs-label">
                Jméno / Název firmy *
              </label>
              <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                <User
                  size={16}
                  style={{
                    position: 'absolute',
                    left: '0.85rem',
                    color: 'var(--gray-text)',
                  }}
                />
                <input
                  id="displayName"
                  type="text"
                  placeholder="Jakub Novák"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  className="cs-input"
                  style={{ paddingLeft: '2.5rem', fontSize: 'var(--auth-input-font)' }}
                  required
                />
              </div>
            </div>

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

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              <label htmlFor="confirmPassword" className="cs-label">
                Potvrzení hesla *
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
                  id="confirmPassword"
                  type="password"
                  placeholder="••••••••"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="cs-input"
                  style={{ paddingLeft: '2.5rem', fontSize: 'var(--auth-input-font)' }}
                  required
                />
              </div>
            </div>

            <Button type="submit" variant="primary" size="lg" block disabled={isSubmitting}>
              <Plus size={16} />
              {isSubmitting ? 'Registrování...' : 'Zaregistrovat se'}
            </Button>
          </form>

          <div style={{ display: 'flex', justifyContent: 'center', fontSize: '0.8rem', fontWeight: 500, color: 'var(--gray-text)' }}>
            Již máte účet?&nbsp;
            <Link
              href="/login"
              style={{
                color: 'var(--blue-primary)',
                textDecoration: 'none',
                fontWeight: 700
              }}
            >
              Přihlaste se
            </Link>
          </div>
        </div>
      </div>

      {/* Visual responsiveness styling */}
      <style jsx>{`
        @media (max-width: 900px) {
          .register-left-panel {
            display: none !important;
          }
        }
      `}</style>
    </div>
  );
}
