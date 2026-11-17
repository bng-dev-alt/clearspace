import type { NextConfig } from "next";

/**
 * Bezpečnostní hlavičky (odvozené z ClearSpace V2, upravené pro V1).
 *
 * - CSP je záměrně úzká (jen frame-ancestors / base-uri / form-action /
 *   object-src): V1 používá inline skripty (téma bez probliknutí, Next runtime)
 *   a Supabase na proměnné doméně, takže `script-src` / `connect-src` by bez
 *   noncí rozbily aplikaci. Přísnější CSP s noncí je samostatný krok.
 * - Mikrofon zůstává povolený pro vlastní origin (hlasový asistent).
 * - HSTS jen v produkci -- na localhostu by se v prohlížeči "přilepil".
 */
const isProd = process.env.NODE_ENV === "production";

export const securityHeaders = [
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), geolocation=(), payment=(), microphone=(self)" },
  ...(isProd ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }] : []),
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
