'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { supabase, hasSupabaseConfig } from '../../lib/supabase';

/**
 * RUN 11 (F-22): where am I – "Projekt › Porady › Porada". Replaces the bare "← Zpět" links; the project name comes from the same
 * RLS-protected projects row the board reads (one small query, nothing new is exposed).
 */
export default function MeetingBreadcrumb({ projectId, current }: { projectId: string; current?: string }) {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    if (!hasSupabaseConfig) return;
    let alive = true;
    void supabase.from('projects').select('name').eq('id', projectId).maybeSingle().then(({ data }) => { if (alive && data) setName((data as { name: string }).name); });
    return () => { alive = false; };
  }, [projectId]);
  return (
    <nav aria-label="Drobečková navigace" className="mi-breadcrumb" data-testid="meeting-breadcrumb">
      <ol>
        <li><Link href={`/projects/${projectId}`}>{name ?? 'Projekt'}</Link></li>
        <li>{current !== undefined ? <Link href={`/projects/${projectId}/meetings`}>Porady</Link> : <span aria-current="page">Porady</span>}</li>
        {current !== undefined && <li><span aria-current="page">{current}</span></li>}
      </ol>
    </nav>
  );
}
