import type { Metadata } from "next";
import { Sora, Fraunces } from "next/font/google";
import "./globals.css";
import "./design-system.css";
import "./monograph.css"; // opt-in styl Monograph: celé pod html[data-style="monograph"], jinak inertní
import { AuthProvider } from "../contexts/AuthContext";
import { ThemeProvider, themeNoFlashScript } from "../contexts/ThemeContext";
import ProtectedRoute from "../components/auth/ProtectedRoute";

// Tělo / UI / karty. latin-ext kvůli českým znakům (ř, ů, ě, ...).
const sora = Sora({
  subsets: ["latin", "latin-ext"],
  variable: "--font-sans-next",
});

// Editorial serif pro nadpisy (Design Bible). Nahrazuje Playfair @import.
const fraunces = Fraunces({
  subsets: ["latin", "latin-ext"],
  variable: "--font-serif-next",
  style: ["normal", "italic"],
});

export const metadata: Metadata = {
  title: "clearspace — AI Workspace",
  description: "A calm, premium AI workspace for the work that moves your team forward.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="cs" className={`${sora.variable} ${fraunces.variable}`} suppressHydrationWarning>
      <head>
        {/* Nastaví téma před prvním vykreslením -> žádné bliknutí (FOUC). */}
        <script dangerouslySetInnerHTML={{ __html: themeNoFlashScript }} />
      </head>
      <body>
        <ThemeProvider>
          <AuthProvider>
            <ProtectedRoute>
              {children}
            </ProtectedRoute>
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
