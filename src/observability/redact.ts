const SENSITIVE_KEY_RE = /(private.?key|secret|passphrase|password|jwt|api.?key|authorization|signature|^token$|(^|[_-])(access|auth|refresh|id)[_-]?token$|token[_-]?(secret|value)$)/i;
const PUBLIC_TOKEN_KEY_RE = /^(tokenId|token_id|tokenIds|token_ids|clobTokenIds|clob_token_ids|tokenAddress|token_address)$/i;
const HEX_PRIVATE_KEY_RE = /\b(0x)?[a-fA-F0-9]{64}\b/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._+=/-]{12,}\b/gi;

export function redactString(value: string): string {
  return value
    .replace(BEARER_RE, 'Bearer [REDACTED]')
    .replace(JWT_RE, '[REDACTED_JWT]')
    .replace(HEX_PRIVATE_KEY_RE, '[REDACTED_HEX]');
}

export function redact<T>(value: T): T {
  return redactValue(value, new WeakSet<object>()) as T;
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') {
    return redactString(value);
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'function') {
    return '[Function]';
  }
  if (typeof value === 'symbol') {
    return value.toString();
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const out = value.map((item) => redactValue(item, seen));
    seen.delete(value);
    return out;
  }
  if (value && typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    if (value instanceof Error) {
      const out: Record<string, unknown> = {
        name: value.name,
        message: redactString(value.message)
      };
      if (value.stack) out.stack = redactString(value.stack);
      if ('cause' in value) out.cause = redactValue((value as Error & { cause?: unknown }).cause, seen);
      for (const [key, item] of Object.entries(value as unknown as Record<string, unknown>)) {
        if (key in out) continue;
        out[key] = isSensitiveKey(key) ? '[REDACTED]' : redactValue(item, seen);
      }
      seen.delete(value);
      return out;
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSensitiveKey(key) ? '[REDACTED]' : redactValue(item, seen);
    }
    seen.delete(value);
    return out;
  }
  return value;
}

export function safeJson(value: unknown): string {
  return JSON.stringify(redact(value), null, 2);
}

function isSensitiveKey(key: string): boolean {
  if (PUBLIC_TOKEN_KEY_RE.test(key)) return false;
  return SENSITIVE_KEY_RE.test(key);
}
