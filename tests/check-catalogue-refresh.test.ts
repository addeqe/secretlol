import test from 'node:test';
import assert from 'node:assert/strict';
import { hasRefreshForUtcDay, scheduledStartAllowed } from '../scripts/check-catalogue-refresh.ts';

const now = new Date('2026-10-14T09:32:24.000Z');

test('only a valid completed timestamp from today UTC suppresses a scheduled scan', () => {
  assert.equal(hasRefreshForUtcDay('2026-10-14T04:17:00.000Z', now), true);
  assert.equal(hasRefreshForUtcDay('2026-10-13T23:59:59.999Z', now), false);
  assert.equal(hasRefreshForUtcDay('2026-10-07T04:17:00.000Z', now), false);
  assert.equal(hasRefreshForUtcDay('not-a-timestamp', now), false);
  assert.equal(hasRefreshForUtcDay(null, now), false);
  assert.equal(hasRefreshForUtcDay('2026-10-14T23:00:00.000Z', now), false);
});

test('UTC day boundaries do not use the runner local timezone', () => {
  assert.equal(hasRefreshForUtcDay('2026-10-14T00:00:00.000Z', new Date('2026-10-14T23:59:59.999Z')), true);
  assert.equal(hasRefreshForUtcDay('2026-10-14T23:59:59.999Z', new Date('2026-10-15T00:00:00.000Z')), false);
});

test('scheduled starts stop before the 55-minute budget would cross the crawl cutoff', () => {
  assert.equal(scheduledStartAllowed(new Date('2026-10-14T03:59:00.000Z')), false);
  assert.equal(scheduledStartAllowed(new Date('2026-10-14T04:00:00.000Z')), true);
  assert.equal(scheduledStartAllowed(new Date('2026-10-14T07:49:00.000Z')), true);
  assert.equal(scheduledStartAllowed(new Date('2026-10-14T07:50:00.000Z')), false);
  assert.equal(scheduledStartAllowed(new Date('2026-10-14T07:50:59.999Z')), false);
  assert.equal(scheduledStartAllowed(new Date('2026-10-14T07:17:00.000+02:00')), true);
});
