import test from 'node:test';
import assert from 'node:assert/strict';
import { decideQuota, readDailyD1Writes } from '../scripts/check-retailer-quota.ts';

test('Coop quota allows the run only when its allowance and shared reserve fit', () => {
  assert.equal(decideQuota(69_999, 10_000, 10_000, 90_000).allowed, true);
  assert.equal(decideQuota(70_001, 10_000, 10_000, 90_000).allowed, false);
  assert.throws(() => decideQuota(0, 50_001), /between 1 and 50000/);
  assert.throws(() => decideQuota(0, 100, 0, 100_000), /cannot exceed 90000/);
});

test('quota read sums all returned D1 groups for the current UTC day', async () => {
  let request: RequestInit | undefined;
  const now = new Date('2026-10-09T04:50:00.000Z');
  const fetcher = (async (_input: string | URL | Request, init?: RequestInit) => {
    request = init;
    return new Response(JSON.stringify({ errors:null, data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: [
      { sum: { rowsWritten: 120 } }, { sum: { rowsWritten: 30 } },
    ] }] } } }), { status: 200 });
  }) as typeof fetch;
  const total = await readDailyD1Writes({ CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_API_TOKEN: 'private-token' }, fetcher, now);
  assert.equal(total, 150);
  const body = JSON.parse(String(request?.body));
  assert.equal(body.variables.since, '2026-10-09T00:00:00Z');
  assert.equal(body.variables.until, now.toISOString());
  assert.equal(String((request?.headers as Record<string, string>).Authorization), 'Bearer private-token');
});

test('quota read fails closed on an unverified response without exposing the token', async () => {
  const fetcher = (async () => new Response(JSON.stringify({ errors: [{ message: 'denied' }] }), { status: 200 })) as typeof fetch;
  await assert.rejects(
    readDailyD1Writes({ CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_API_TOKEN: 'private-token' }, fetcher),
    error => error instanceof Error && error.message === 'Shared D1 write quota could not be verified; Coop refresh deferred' && !error.message.includes('private-token'),
  );
});

test('quota read permits an explicit empty group list as zero but rejects missing or malformed usage data', async () => {
  const env = { CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_API_TOKEN: 'private-token' };
  const response = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;
  assert.equal(await readDailyD1Writes(env, response({ data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: [] }] } } })), 0);
  const malformed = await readDailyD1Writes(env, response({ data: { viewer: { accounts: [null] } } })).then(
    () => null, error => error as Error,
  );
  assert.ok(malformed instanceof Error);
  assert.match(malformed.message, /could not be verified/);
  for (const groups of [undefined, [{}], [{ sum: {} }], [{ sum: { rowsWritten: '0' } }]]) {
    const result = await readDailyD1Writes(env, response({ data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: groups }] } } })).then(
      () => null, error => error as Error,
    );
    assert.ok(result instanceof Error);
    assert.match(result.message, /quota|write quota/i);
  }
});
