export interface FakeTurn { speaker: string; text: string }
export const DEFAULT_TURNS: FakeTurn[];
export function tokensFor(turns: FakeTurn[], startAt?: number, msPerWord?: number): Array<Record<string, unknown>>;
export interface FakeSoniox {
  url: string;
  origin: string;
  key: string;
  state: { mode: string; pollsUntilDone: number; durationMs: number; turns: FakeTurn[]; fetchAudio: boolean };
  control(body: Record<string, unknown>): Promise<Response>;
  close(): Promise<void>;
}
export function startFakeSoniox(opts?: { port?: number; expectKey?: string }): Promise<FakeSoniox>;
