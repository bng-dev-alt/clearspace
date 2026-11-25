'use client';

import React, { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '../../hooks/useAuth';

export default function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  // /accept-invite musí být dostupná i nepřihlášenému (pozvaný si tam zakládá účet).
  // /privacy a /about jsou statické veřejné stránky (Google OAuth: zásady a domovská stránka musí být čitelné bez přihlášení
  // i bez JavaScriptu) -- vykreslí se hned, bez čekání na stav přihlášení.
  const isStaticPublic = pathname === '/privacy' || pathname === '/about';
  const isPublicPath = isStaticPublic || pathname === '/login' || pathname === '/register' || pathname === '/accept-invite';

  useEffect(() => {
    if (!isLoading && !user && !isPublicPath) {
      router.replace('/login');
    }
  }, [user, isLoading, isPublicPath, router]);

  if (isStaticPublic) return <>{children}</>;

  // Loading state with clearspace design style
  if (isLoading) {
    return (
      <div 
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          width: '100vw',
          backgroundColor: 'var(--surface-2)', // Warm off-white
          fontFamily: 'var(--font-sans)',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1.25rem' }}>
          <div style={{ fontSize: '1.5rem', fontWeight: 800, letterSpacing: '-0.03em', color: 'var(--dark-navy)' }}>
            clearspace<span style={{ color: 'var(--accent-yellow)' }}>.</span>
          </div>
          {/* Micro-animation loader */}
          <div className="loader-container" style={{ width: '40px', height: '2px', backgroundColor: 'var(--border-color)', overflow: 'hidden', borderRadius: '1px' }}>
            <div 
              style={{
                width: '50%',
                height: '100%',
                backgroundColor: 'var(--accent-yellow)',
                animation: 'loading-bar 1.5s infinite ease-in-out',
              }}
            />
          </div>
        </div>
        <style jsx global>{`
          @keyframes loading-bar {
            0% {
              transform: translateX(-100%);
            }
            100% {
              transform: translateX(200%);
            }
          }
        `}</style>
      </div>
    );
  }

  // If user is not authenticated and is on a protected route, don't flash content before redirection completes
  if (!user && !isPublicPath) {
    return null;
  }

  return <>{children}</>;
}
