import type { RetailerId, RetailTransport } from './types.ts';

/** First-party JSON API hosts approved for local Coop/ICA collection. */
export const RETAILER_ALLOWED_HOSTS: Readonly<Record<RetailerId, readonly string[]>> = {
  coop: ['external.api.coop.se'],
  ica: ['handla.ica.se', 'handlaprivatkund.ica.se'],
};

const MAX_ATTEMPTS = 3;
const DEFAULT_MIN_INTERVAL_MS = 200;
const DEFAULT_MAX_REQUESTS = 1_000;
const DEFAULT_MAX_RUN_MS = 45 * 60_000;
const DEFAULT_BODY_TIMEOUT_MS = 30_000;
const MAX_RETRY_DELAY_MS = 5_000;
const MAX_RETRY_AFTER_MS = 30_000;

export type RetailTransportOptions = {
  retailer: RetailerId;
  fetch?: typeof fetch;
  minIntervalMs?: number;
  maxRequests?: number;
  maxRunMs?: number;
  bodyTimeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export type RetailTransportMetrics = { requests: number; retries: number };

/** Creates a bounded, paced JSON transport. Construct it only when a local collection run starts. */
export function createRetailTransport(options: RetailTransportOptions): RetailTransport & {
  readonly metrics: RetailTransportMetrics;
} {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const minIntervalMs = positiveOrZero(options.minIntervalMs, DEFAULT_MIN_INTERVAL_MS);
  const maxRequests = positiveInteger(options.maxRequests, DEFAULT_MAX_REQUESTS);
  const maxRunMs = positiveInteger(options.maxRunMs, DEFAULT_MAX_RUN_MS);
  const bodyTimeoutMs = positiveInteger(options.bodyTimeoutMs, DEFAULT_BODY_TIMEOUT_MS);
  const allowedHosts = new Set(RETAILER_ALLOWED_HOSTS[options.retailer]);
  const startedAt = now();
  let lastRequestAt: number | null = null;
  let requests = 0;
  let retries = 0;

  const transport = Object.assign(
    async (input: string, init: RequestInit = {}): Promise<Response> => {
      const url = validateUrl(input, allowedHosts);
      const runDeadline = startedAt + maxRunMs;
      let attempt = 0;

      while (attempt < MAX_ATTEMPTS) {
        const remainingRunMs = runDeadline - now();
        if (remainingRunMs <= 0) throw new Error('retail_transport_run_deadline');
        if (requests >= maxRequests) throw new Error('retail_transport_request_limit');

        if (lastRequestAt !== null) {
          const waitMs = minIntervalMs - (now() - lastRequestAt);
          if (waitMs > 0) await sleep(waitMs);
        }
        if (runDeadline - now() <= 0) throw new Error('retail_transport_run_deadline');
        if (requests >= maxRequests) throw new Error('retail_transport_request_limit');

        const controller = new AbortController();
        const callerSignal = init.signal;
        const deadlineTimer = setTimeout(() => controller.abort(new Error('retail_transport_run_deadline')),
          Math.max(1, runDeadline - now()));
        const bodyTimer = setTimeout(() => controller.abort(new Error('retail_transport_body_timeout')), bodyTimeoutMs);
        const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
        const requestInit: RequestInit = { ...init, signal, redirect: 'manual' };
        lastRequestAt = now();
        requests += 1;
        attempt += 1;

        let response: Response;
        try {
          response = await fetchImpl(url.toString(), requestInit);
        } catch (error) {
          clearTimeout(deadlineTimer);
          clearTimeout(bodyTimer);
          if(error instanceof Error&&error.message==='retail_transport_response_too_large')throw error;
          if (shouldRetry(attempt, signal)) {
            retries += 1;
            await sleep(backoffMs(attempt));
            continue;
          }
          throw safeAbortOrNetworkError(signal);
        }

        if (isLoginRedirect(response, url, allowedHosts)) {
          clearTimeout(deadlineTimer);
          clearTimeout(bodyTimer);
          throw new Error('retail_transport_login_redirect');
        }
        if (response.status === 429 || response.status >= 500 && response.status <= 599) {
          clearTimeout(deadlineTimer);
          clearTimeout(bodyTimer);
          if (attempt < MAX_ATTEMPTS && !signal.aborted) {
            retries += 1;
            await sleep(retryAfterMs(response.headers.get('retry-after'), now()) ?? backoffMs(attempt));
            continue;
          }
          return response;
        }
        if (!response.ok) {
          clearTimeout(deadlineTimer);
          clearTimeout(bodyTimer);
          return response;
        }

        const contentType = response.headers.get('content-type') ?? '';
        if (!/(?:^|;)\s*application\/(?:[a-z0-9.+-]*\+)?json\b/i.test(contentType)) {
          clearTimeout(deadlineTimer);
          clearTimeout(bodyTimer);
          throw new Error('retail_transport_non_json_response');
        }

        try {
          const bytes = await readBodyWithinSignal(response, signal);
          clearTimeout(deadlineTimer);
          clearTimeout(bodyTimer);
          return reconstructedResponse(bytes, response);
        } catch (error) {
          clearTimeout(deadlineTimer);
          clearTimeout(bodyTimer);
          if(error instanceof Error&&error.message==='retail_transport_response_too_large')throw error;
          if (shouldRetry(attempt, signal)) {
            retries += 1;
            await sleep(backoffMs(attempt));
            continue;
          }
          throw safeAbortOrNetworkError(signal);
        }
      }
      throw new Error('retail_transport_attempt_limit');
    },
  ) as RetailTransport & { readonly metrics: RetailTransportMetrics };
  Object.defineProperty(transport, 'metrics', { get: () => ({ requests, retries }), enumerable: true });
  return transport;
}

function validateUrl(input: string, allowedHosts: Set<string>): URL {
  let url: URL;
  try { url = new URL(input); }
  catch { throw new Error('retail_transport_invalid_url'); }
  if (url.protocol !== 'https:' || url.username || url.password || !allowedHosts.has(url.hostname.toLowerCase())) {
    throw new Error('retail_transport_forbidden_host');
  }
  return url;
}

function isLoginRedirect(response: Response, requestUrl: URL, allowedHosts: Set<string>): boolean {
  if (response.status >= 300 && response.status < 400) return true;
  if (!response.redirected && (!response.url || response.url === requestUrl.toString())) return false;
  let finalUrl: URL;
  try { finalUrl = new URL(response.url); }
  catch { return response.redirected; }
  if (finalUrl.origin !== requestUrl.origin || !allowedHosts.has(finalUrl.hostname.toLowerCase())) return true;
  return /(?:login|signin|sign-in|authenticate|chooseStore)/i.test(finalUrl.pathname)
    || /text\/html/i.test(response.headers.get('content-type') ?? '');
}

function shouldRetry(attempt: number, signal: AbortSignal): boolean {
  if (attempt >= MAX_ATTEMPTS) return false;
  if (!signal.aborted) return true;
  return String(signal.reason instanceof Error ? signal.reason.message : '').includes('body_timeout');
}

function safeAbortOrNetworkError(signal: AbortSignal): Error {
  if (signal.aborted) {
    const message = String(signal.reason instanceof Error ? signal.reason.message : '');
    if (message.includes('body_timeout')) return new Error('retail_transport_body_timeout');
    if (message.includes('run_deadline')) return new Error('retail_transport_run_deadline');
    return new Error('retail_transport_aborted');
  }
  return new Error('retail_transport_network_error');
}

async function readBodyWithinSignal(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const result = await readOrAbort(reader, signal);
      if (result.done) break;
      chunks.push(result.value);
      total += result.value.byteLength;
      if(total>5*1024*1024)throw new Error('retail_transport_response_too_large');
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function readOrAbort(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise((resolve, reject) => {
    const onAbort = () => { cleanup(); reject(signal.reason); };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    if (signal.aborted) { reject(signal.reason); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    reader.read().then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

function reconstructedResponse(bytes: Uint8Array, response: Response): Response {
  const bodyForbidden = [204, 205, 304].includes(response.status);
  const bodyBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(bodyBuffer).set(bytes);
  return new Response(bodyForbidden ? null : bodyBuffer, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function retryAfterMs(value: string | null, currentTime: number): number | null {
  if (!value) return null;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) && seconds >= 0
    ? seconds * 1_000
    : Date.parse(value) - currentTime;
  if (!Number.isFinite(delay)) return null;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, delay));
}

function backoffMs(attempt: number): number {
  return Math.min(MAX_RETRY_DELAY_MS, 250 * 2 ** (attempt - 1));
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
}

function positiveOrZero(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
}
