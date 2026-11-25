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

/**
 * Google's OAuth redirect carries the single-use authorization code (and state) in the query string. `next dev` logs every incoming
 * request URL, which would put the code into the terminal / log files: never log that route (RUN 02B finding). Production servers
 * do not print request URLs this way; this only concerns development.
 */
// RUN 03: Gmail search URLs carry the user's search terms (private) -- never printed either.
export const noRequestLogPaths = [/\/api\/google\/oauth\/callback/, /\/api\/gmail\//, /\/api\/calendar\//];

const nextConfig: NextConfig = {
  logging: { incomingRequests: { ignore: noRequestLogPaths } },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
