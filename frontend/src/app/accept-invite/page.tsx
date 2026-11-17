'use client';

import React, { useState, useEffect, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Sparkles, CheckCircle2, AlertCircle, Lock, User, Mail, ArrowRight } from 'lucide-react';
import { collaborationService } from '../../services/collaborationService';
import { useAuth } from '../../hooks/useAuth';

type Preview = Awaited<ReturnType<typeof collaborationService.previewInvitation>>;

function AcceptInviteForm() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { user, isLoading: authLoading } = useAuth();
  const token = searchParams.get('token') || '';

  const [preview, setPreview] = useState<Preview | null>(null);
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(
    token ? null : 'Neplatný nebo chybějící pozvánkový token v adrese.'
  );
  const [success, setSuccess] = useState(false);
  const [needsConfirmation, setNeedsConfirmation] = useState(false);

  // Anonymní náhled: jen stav, maskovaný e-mail a jméno zvoucího.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    collaborationService.previewInvitation(token).then((p) => {
      if (!cancelled) setPreview(p);
    });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const finishAccepted = () => {
    setSuccess(true);
    setTimeout(() => router.push('/'), 1500);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!displayName.trim()) {
      setError('Zadejte prosím své celé jméno.');
      return;
    }
    if (!user) {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
        setError('Zadejte e-mail, na který pozvánka přišla.');
        return;
      }
      if (!password.trim() || password.length < 6) {
        setError('Heslo musí obsahovat alespoň 6 znaků.');
        return;
      }
    }

    setIsLoading(true);
    setError(null);

    try {
      if (user) {
        await collaborationService.acceptInvitationAsSignedInUser(token, displayName.trim());
        finishAccepted();
      } else {
        const res = await collaborationService.acceptInvitationToken(token, email.trim(), displayName.trim(), password);
        if (res.needsEmailConfirmation) {
          setNeedsConfirmation(true);
        } else {
          finishAccepted();
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Nepodařilo se přijmout pozvánku.');
    } finally {
      setIsLoading(false);
    }
  };

  const blocked = preview !== null && preview.state !== 'valid';

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'var(--bg-page)',
        padding: '1.5rem',
      }}
    >
      <div
        style={{
          backgroundColor: 'var(--surface-1)',
          borderRadius: '16px',
          padding: '2.5rem',
          maxWidth: '460px',
          width: '100%',
          boxShadow: 'var(--shadow-xl)',
          border: '1px solid var(--border-color)',
        }}
      >
        <div style={{ textAlign: 'center', marginBottom: '1.75rem' }}>
          <div
            style={{
              width: '54px',
              height: '54px',
              borderRadius: '14px',
              backgroundColor: 'rgba(117, 57, 145, 0.12)',
              color: 'var(--purple-secondary)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto 1rem',
            }}
          >
            <Sparkles size={28} />
          </div>
          <h1 style={{ fontSize: '1.4rem', fontWeight: 800, color: 'var(--dark-navy)', margin: '0 0 0.4rem' }}>
            Přijetí pozvánky do týmu
          </h1>
          <p style={{ fontSize: '0.85rem', color: 'var(--gray-text)', margin: 0 }}>
            ClearSpace Kanban – Pozvánka do workspace
          </p>
        </div>

        {blocked ? (
          <div
            style={{ padding: '1.25rem', border: '1px solid var(--border-color)', borderRadius: '10px', textAlign: 'center' }}
            data-testid="accept-invite-unavailable"
          >
            <AlertCircle size={28} style={{ margin: '0 auto 0.5rem', color: 'var(--danger)' }} />
            <p style={{ margin: 0, fontSize: '0.9rem', fontWeight: 600 }}>
              {preview?.state === 'expired'
                ? 'Platnost pozvánky vypršela. Požádejte vlastníka workspace o novou.'
                : preview?.state === 'used'
                  ? 'Tato pozvánka už byla použita nebo zrušena.'
                  : 'Pozvánka neexistuje nebo není platná.'}
            </p>
          </div>
        ) : needsConfirmation ? (
          <div
            style={{ padding: '1.25rem', border: '1px solid var(--border-color)', borderRadius: '10px', textAlign: 'center' }}
            data-testid="accept-invite-confirm-email"
          >
            <Mail size={28} style={{ margin: '0 auto 0.5rem' }} />
            <p style={{ margin: 0, fontSize: '0.9rem', fontWeight: 600 }}>Potvrďte svůj e-mail</p>
            <p style={{ margin: '0.4rem 0 0', fontSize: '0.82rem', color: 'var(--gray-text)' }}>
              Poslali jsme vám potvrzovací odkaz. Po potvrzení se vrátíte sem a pozvánku dokončíte.
            </p>
          </div>
        ) : success ? (
          <div
            style={{
              padding: '1.25rem',
              backgroundColor: 'rgba(16, 124, 65, 0.12)',
              border: '1px solid rgba(16, 124, 65, 0.3)',
              borderRadius: '10px',
              color: '#107c41',
              textAlign: 'center',
            }}
            data-testid="accept-invite-success"
          >
            <CheckCircle2 size={32} style={{ margin: '0 auto 0.5rem' }} />
            <h3 style={{ margin: '0 0 0.25rem', fontSize: '1rem', fontWeight: 800 }}>Pozvánka úspěšně přijata!</h3>
            <p style={{ margin: 0, fontSize: '0.85rem' }}>Přesměrováváme vás na přehled projektů...</p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1.1rem' }}>
            {error && (
              <div
                style={{
                  padding: '0.75rem 1rem',
                  backgroundColor: 'var(--danger-soft)',
                  color: 'var(--danger)',
                  borderRadius: '8px',
                  fontSize: '0.82rem',
                  fontWeight: 600,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                }}
              >
                <AlertCircle size={18} /> {error}
              </div>
            )}

            {preview?.state === 'valid' && (
              <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--gray-text)' }} data-testid="accept-invite-preview">
                {preview.inviterName ? `${preview.inviterName} vás zve` : 'Byli jste pozváni'} do svého workspace
                {preview.maskedEmail ? ` (pozvánka pro ${preview.maskedEmail})` : ''}.
              </p>
            )}

            {!user && !authLoading && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                <label htmlFor="accept-invite-email" style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--dark-navy)' }}>
                  E-mail, na který pozvánka přišla *
                </label>
                <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                  <Mail size={16} style={{ position: 'absolute', left: '0.85rem', color: 'var(--gray-text)' }} />
                  <input
                    id="accept-invite-email"
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '0.65rem 0.85rem 0.65rem 2.4rem',
                      borderRadius: '8px',
                      border: '1px solid var(--border-color)',
                      fontSize: '0.85rem',
                      outline: 'none',
                    }}
                    data-testid="accept-invite-email-input"
                  />
                </div>
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              <label style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--dark-navy)' }}>
                Vaše celé jméno *
              </label>
              <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                <User size={16} style={{ position: 'absolute', left: '0.85rem', color: 'var(--gray-text)' }} />
                <input
                  type="text"
                  placeholder="Jan Novák..."
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '0.65rem 0.85rem 0.65rem 2.4rem',
                    borderRadius: '8px',
                    border: '1px solid var(--border-color)',
                    fontSize: '0.85rem',
                    outline: 'none',
                  }}
                  data-testid="accept-invite-name-input"
                />
              </div>
            </div>

            {!user && !authLoading && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              <label style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--dark-navy)' }}>
                Nové přístupové heslo *
              </label>
              <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                <Lock size={16} style={{ position: 'absolute', left: '0.85rem', color: 'var(--gray-text)' }} />
                <input
                  type="password"
                  placeholder="Zvolte si heslo (min. 6 znaků)..."
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '0.65rem 0.85rem 0.65rem 2.4rem',
                    borderRadius: '8px',
                    border: '1px solid var(--border-color)',
                    fontSize: '0.85rem',
                    outline: 'none',
                  }}
                  data-testid="accept-invite-password-input"
                />
              </div>
            </div>
            )}

            <button
              type="submit"
              disabled={isLoading || !token || preview === null}
              style={{
                width: '100%',
                padding: '0.75rem',
                backgroundColor: 'var(--purple-secondary)',
                color: '#fff',
                border: 'none',
                borderRadius: '8px',
                fontSize: '0.9rem',
                fontWeight: 700,
                cursor: isLoading || !token || preview === null ? 'not-allowed' : 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '0.5rem',
                marginTop: '0.5rem',
              }}
              data-testid="accept-invite-submit-btn"
            >
              {isLoading ? 'Zpracovávám...' : user ? 'Přijmout pozvánku' : 'Vytvořit účet a přijmout pozvánku'} <ArrowRight size={16} />
            </button>
          </form>
        )}

        <div style={{ marginTop: '1.5rem', textAlign: 'center', borderTop: '1px solid var(--border-color)', paddingTop: '1rem' }}>
          <Link href="/login" style={{ fontSize: '0.8rem', color: 'var(--purple-secondary)', fontWeight: 600, textDecoration: 'none' }}>
            Již máte účet? Přihlásit se
          </Link>
        </div>
      </div>
    </div>
  );
}

export default function AcceptInvitePage() {
  return (
    <Suspense fallback={<div style={{ textAlign: 'center', padding: '3rem' }}>Načítání...</div>}>
      <AcceptInviteForm />
    </Suspense>
  );
}
