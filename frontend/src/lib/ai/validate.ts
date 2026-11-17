import { AiGatewayError } from './errors';

/**
 * Minimální validátory vstupu AI endpointů (bez závislosti na zod).
 * Každá funkce vrací očištěnou hodnotu nebo vyhodí AiGatewayError('bad_request').
 */
const bad = (msg: string): never => {
  throw new AiGatewayError('bad_request', msg);
};

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function record(v: unknown, name: string): Record<string, unknown> {
  return isRecord(v) ? v : bad(`Neplatný vstup (${name}).`);
}

export function str(v: unknown, name: string, max: number, opts: { min?: number } = {}): string {
  if (typeof v !== 'string') return bad(`Chybí nebo je neplatné pole „${name}".`);
  const t = v.trim();
  if (t.length < (opts.min ?? 0)) return bad(`Pole „${name}" je příliš krátké.`);
  if (t.length > max) return bad(`Pole „${name}" je příliš dlouhé (max ${max} znaků).`);
  return t;
}

export function optStr(v: unknown, name: string, max: number): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  return str(v, name, max);
}

export function oneOf<T extends string>(v: unknown, name: string, allowed: readonly T[]): T | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  return (allowed as readonly unknown[]).includes(v) ? (v as T) : bad(`Neplatná hodnota pole „${name}".`);
}

export function int(v: unknown, name: string, min: number, max: number): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
    return bad(`Pole „${name}" musí být číslo v rozsahu ${min}–${max}.`);
  }
  return Math.trunc(v);
}

export function list(v: unknown, name: string, max: number): unknown[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return bad(`Pole „${name}" musí být seznam.`);
  if (v.length > max) return bad(`Seznam „${name}" je příliš dlouhý (max ${max}).`);
  return v;
}

/** Identifikátor projektu z těla požadavku (ověření oprávnění dělá databáze). */
export function projectIdOf(body: Record<string, unknown>): string {
  return str(body.projectId, 'projectId', 200, { min: 1 });
}
