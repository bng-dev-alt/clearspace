import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

/**
 * Vynucení demo režimu (localStorage + mock auth) i když jsou Supabase
 * proměnné vyplněné.
 *
 * Používá to E2E sada: testy ověřují chování UI, které je v obou režimech
 * shodné, ale nemají sahat na ostrou databázi ani potřebovat testovací účty.
 * Prázdná hodnota proměnné by nestačila -- Next.js prázdný řetězec považuje
 * za nenastavený a přepsal by ho hodnotou z `.env.local`.
 *
 * Hodí se i pro ukázku aplikace bez backendu.
 */
const forceDemoMode = process.env.NEXT_PUBLIC_FORCE_DEMO === '1';

export const hasSupabaseConfig = !forceDemoMode && !!(supabaseUrl && supabaseAnonKey);

if (!hasSupabaseConfig && !forceDemoMode) {
  if (typeof window !== 'undefined') {
    console.warn(
      'Supabase environment variables are missing. Please add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY to your .env.local file.'
    );
  }
}

export const supabase = createClient(supabaseUrl || 'https://placeholder.supabase.co', supabaseAnonKey || 'placeholder');
