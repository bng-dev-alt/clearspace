import React from 'react';
import Link from 'next/link';

/** Shell of the public, statically readable pages (/about, /privacy): no login, no client JavaScript needed. */
export default function PublicPage({ label, title, lead, children }: { label: string; title: string; lead: string; children: React.ReactNode }) {
  return (
    <div className="app-container" style={{ backgroundColor: 'var(--bg-page)', minHeight: '100vh' }}>
      <header className="public-page-head">
        <Link href="/about" className="public-page-brand">clearspace<span>.</span></Link>
        <nav aria-label="Veřejné stránky" className="public-page-nav">
          <Link href="/about">O aplikaci</Link>
          <Link href="/privacy">Ochrana osobních údajů</Link>
          <Link href="/login">Přihlásit se</Link>
        </nav>
      </header>
      <section className="app-hero">
        <div className="hero-content">
          <div className="hero-left">
            <span className="hero-team-label">{label}</span>
            <h1 className="hero-title">{title}</h1>
            <p className="hero-desc">{lead}</p>
          </div>
          <div className="hero-right" />
        </div>
      </section>
      <main id="mg-content" className="settings-page public-page">{children}</main>
    </div>
  );
}
