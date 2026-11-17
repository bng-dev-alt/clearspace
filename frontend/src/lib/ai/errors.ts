/**
 * Chyby AI gateway. `message` je VŽDY bezpečný text pro klienta -- nikdy
 * surová chyba providera, SQL ani stack.
 */
export type AiErrorCode =
  | 'bad_request'
  | 'unauthenticated'
  | 'forbidden'
  | 'payload_too_large'
  | 'unsupported_media_type'
  | 'rate_limited'
  | 'budget_exceeded'
  | 'ai_unavailable'
  | 'ai_demo_disabled'
  | 'ai_timeout'
  | 'ai_overloaded'
  | 'ai_failed'
  | 'bad_model_output';

const STATUS: Record<AiErrorCode, number> = {
  bad_request: 400,
  unauthenticated: 401,
  forbidden: 403,
  payload_too_large: 413,
  unsupported_media_type: 415,
  rate_limited: 429,
  budget_exceeded: 429,
  ai_unavailable: 503,
  ai_demo_disabled: 503,
  ai_timeout: 504,
  ai_overloaded: 503,
  ai_failed: 502,
  bad_model_output: 502,
};

export class AiGatewayError extends Error {
  readonly code: AiErrorCode;
  readonly status: number;
  constructor(code: AiErrorCode, message: string) {
    super(message);
    this.name = 'AiGatewayError';
    this.code = code;
    this.status = STATUS[code];
  }
}

/** Chyba providera (Gemini) s klasifikací; `message` je už bezpečný text. */
export class AiProviderError extends Error {
  readonly code: AiErrorCode;
  constructor(code: AiErrorCode, message: string) {
    super(message);
    this.name = 'AiProviderError';
    this.code = code;
  }
}
