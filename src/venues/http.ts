import { redact } from '../observability/redact.js';

const MIN_HTTP_INTERVAL_MS = 120;
const HTTP_RETRY_MAX = 2;
const HTTP_RETRY_BACKOFF_MS = 1000;
const lastRequestByOrigin = new Map<string, number>();
const queueByOrigin = new Map<string, Promise<void>>();

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown
  ) {
    super(message);
  }
}

export async function httpJson<T>(
  url: string,
  options: RequestInit & { timeoutMs?: number } = {}
): Promise<T> {
  for (let attempt = 0; attempt <= HTTP_RETRY_MAX; attempt += 1) {
    try {
      return await httpJsonOnce(url, options);
    } catch (error) {
      const isConnectionError = error instanceof TypeError ||
        (error instanceof Error && (error.message === 'fetch failed' || error.message.includes('aborted')));
      if (!isConnectionError || attempt >= HTTP_RETRY_MAX) throw error;
      await new Promise((resolve) => setTimeout(resolve, HTTP_RETRY_BACKOFF_MS));
    }
  }
  throw new Error('unreachable');
}

async function httpJsonOnce<T>(
  url: string,
  options: RequestInit & { timeoutMs?: number } = {}
): Promise<T> {
  await throttleByOrigin(url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 15000);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        ...(options.headers ?? {})
      }
    });
    const text = await response.text();
    const payload = text ? safeParseJson(text) : {};
    if (!response.ok) {
      throw new HttpError(`HTTP ${response.status} for ${url}`, response.status, redact(payload));
    }
    return payload as T;
  } finally {
    clearTimeout(timeout);
  }
}

async function throttleByOrigin(url: string): Promise<void> {
  const origin = new URL(url).origin;
  const previous = queueByOrigin.get(origin) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const last = lastRequestByOrigin.get(origin) ?? 0;
      const waitMs = Math.max(0, MIN_HTTP_INTERVAL_MS - (Date.now() - last));
      if (waitMs > 0) await sleep(waitMs);
      lastRequestByOrigin.set(origin, Date.now());
    });
  queueByOrigin.set(origin, next);
  await next;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function extractList(payload: any): any[] {
  if (Array.isArray(payload)) return payload;
  const candidates = [
    payload?.data,
    payload?.orders,
    payload?.positions,
    payload?.accounts,
    payload?.markets,
    payload?.items,
    payload?.results,
    payload?.data?.orders,
    payload?.data?.positions,
    payload?.data?.accounts,
    payload?.data?.markets,
    payload?.data?.items,
    payload?.data?.results
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

export function unwrapData(payload: any): any {
  return payload && typeof payload === 'object' && 'data' in payload ? payload.data : payload;
}
