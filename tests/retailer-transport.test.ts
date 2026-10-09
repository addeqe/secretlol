import test from 'node:test';
import assert from 'node:assert/strict';
import { createRetailTransport } from '../src/retailers/transport.ts';

const json = (value: unknown, status = 200, headers: HeadersInit = {}) => new Response(JSON.stringify(value), {
  status,
  headers: { 'content-type': 'application/json', ...headers },
});

function clock() {
  let time = 0;
  const sleeps: number[] = [];
  return {
    now: () => time,
    sleeps,
    async sleep(ms: number) { sleeps.push(ms); time += ms; },
  };
}

test('paces requests, records attempts, and enforces request and run limits', async () => {
  const time = clock();
  const transport = createRetailTransport({ retailer: 'ica', minIntervalMs: 200, maxRequests: 2,
    now: time.now, sleep: time.sleep, fetch: async () => json({ ok: true }) });
  await transport('https://handla.ica.se/api/store/v1');
  await transport('https://handla.ica.se/api/store/v1');
  assert.deepEqual(time.sleeps, [200]);
  assert.deepEqual(transport.metrics, { requests: 2, retries: 0 });
  await assert.rejects(transport('https://handla.ica.se/api/store/v1'), /request_limit/);
  assert.equal(transport.metrics.requests, 2);

  const runClock = clock();
  const boundedRun = createRetailTransport({ retailer: 'ica', minIntervalMs: 200, maxRunMs: 100,
    now: runClock.now, sleep: runClock.sleep, fetch: async () => json({ ok: true }) });
  await boundedRun('https://handla.ica.se/api/store/v1');
  await assert.rejects(boundedRun('https://handla.ica.se/api/store/v1'), /run_deadline/);
});

test('retries a temporary 429 with bounded Retry-After and buffers a later response', async () => {
  const time = clock();
  let calls = 0;
  const transport = createRetailTransport({ retailer: 'coop', minIntervalMs: 0, now: time.now, sleep: time.sleep,
    fetch: async () => ++calls === 1
      ? new Response('busy', { status: 429, headers: { 'retry-after': '999' } })
      : json({ stores: [] }) });
  const response = await transport('https://external.api.coop.se/ecommerce/coop/pointofservices');
  assert.deepEqual(await response.json(), { stores: [] });
  assert.deepEqual(time.sleeps, [30_000]);
  assert.deepEqual(transport.metrics, { requests: 2, retries: 1 });
});

test('retries an interrupted body after successful headers', async () => {
  let calls = 0;
  const transport = createRetailTransport({ retailer: 'ica', minIntervalMs: 0, sleep: async () => undefined,
    fetch: async () => {
      calls += 1;
      if (calls === 1) return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode('{"partial":')); controller.error(new Error('connection reset')); },
      }), { headers: { 'content-type': 'application/json' } });
      return json({ complete: true });
    } });
  const response = await transport('https://handla.ica.se/api/store/v1');
  assert.deepEqual(await response.json(), { complete: true });
  assert.deepEqual(transport.metrics, { requests: 2, retries: 1 });
});

test('does not retry authentication failures or HTML login redirects', async () => {
  let calls = 0;
  const unauthorized = createRetailTransport({ retailer: 'ica', minIntervalMs: 0,
    fetch: async () => { calls += 1; return new Response('denied', { status: calls === 1 ? 401 : 403 }); } });
  assert.equal((await unauthorized('https://handla.ica.se/api/store/v1')).status, 401);
  assert.equal((await unauthorized('https://handla.ica.se/api/store/v1')).status, 403);
  assert.equal(calls, 2);
  assert.deepEqual(unauthorized.metrics, { requests: 2, retries: 0 });

  const login = createRetailTransport({ retailer: 'ica', minIntervalMs: 0,
    fetch: async () => {
      const response = new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } });
      Object.defineProperties(response, { redirected: { value: true }, url: { value: 'https://handla.ica.se/login' } });
      return response;
    } });
  await assert.rejects(login('https://handla.ica.se/api/store/v1'), /login_redirect/);
  assert.deepEqual(login.metrics, { requests: 1, retries: 0 });
});

test('retries a body timeout, but does not retry valid JSON content with malformed JSON text', async () => {
  let timeoutCalls = 0;
  const timeout = createRetailTransport({ retailer: 'ica', minIntervalMs: 0, bodyTimeoutMs: 5,
    sleep: async () => undefined, fetch: async () => {
      timeoutCalls += 1;
      if (timeoutCalls === 1) return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
        headers: { 'content-type': 'application/json' },
      });
      return json({ recovered: true });
    } });
  assert.deepEqual(await (await timeout('https://handla.ica.se/api/store/v1')).json(), { recovered: true });
  assert.deepEqual(timeout.metrics, { requests: 2, retries: 1 });

  let malformedCalls = 0;
  const malformed = createRetailTransport({ retailer: 'ica', minIntervalMs: 0,
    fetch: async () => { malformedCalls += 1; return new Response('{broken', { headers: { 'content-type': 'application/json' } }); } });
  const response = await malformed('https://handla.ica.se/api/store/v1');
  await assert.rejects(response.json());
  assert.equal(malformedCalls, 1);
  assert.deepEqual(malformed.metrics, { requests: 1, retries: 0 });
});

test('rejects foreign, insecure, credentialed, and unrecognized retailer URLs before fetch', async () => {
  let calls = 0;
  const transport = createRetailTransport({ retailer: 'coop', fetch: async () => { calls += 1; return json({}); } });
  for (const url of [
    'https://example.com/data',
    'http://external.api.coop.se/ecommerce/coop',
    'https://user:secret@external.api.coop.se/ecommerce/coop',
    'https://handla.ica.se/api/store/v1',
  ]) await assert.rejects(transport(url), /forbidden_host/);
  assert.equal(calls, 0);
  assert.deepEqual(transport.metrics, { requests: 0, retries: 0 });
});
