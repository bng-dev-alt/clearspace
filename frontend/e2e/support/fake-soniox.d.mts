export interface FakeTurn { speaker: string; text: string }
export const DEFAULT_TURNS: FakeTurn[];
export function tokensFor(turns: FakeTurn[], startAt?: number, msPerWord?: number): Array<Record<string, unknown>>;
export interface FakeSoniox {
  url: string;
  wsUrl: string;
  origin: string;
  key: string;
  state: { mode: string; pollsUntilDone: number; durationMs: number; turns: FakeTurn[]; fetchAudio: boolean;
    tempKeys: Map<string, { used: boolean; maxSessionSec: number; ref: string | null }>;
    rt: Array<{ key: string; config: Record<string, unknown> | null; bytes: number; frames: number; ended: boolean; closed: boolean }>;
    rtMode: 'ok' | 'drop_after_first' | 'error_401' | 'mint_402' };
  control(body: Record<string, unknown>): Promise<Response>;
  close(): Promise<void>;
}
export function startFakeSoniox(opts?: { port?: number; expectKey?: string }): Promise<FakeSoniox>;
