import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarWeekEnd, PRICE_FRESHNESS_POLICY_VERSION, PRICE_TIME_ZONE, scanIsCurrent } from '../src/price-freshness.ts';

test('Stockholm calendar-week policy has exact Sunday and Monday millisecond boundaries', () => {
  assert.equal(PRICE_FRESHNESS_POLICY_VERSION, 'stockholm-calendar-week-v1');
  assert.equal(PRICE_TIME_ZONE, 'Europe/Stockholm');
  const sundayLastMillisecond = Date.parse('2026-10-11T21:59:59.999Z'); // 23:59:59.999 CEST
  const mondayMidnight = Date.parse('2026-10-11T22:00:00.000Z'); // 00:00:00.000 CET/CEST local boundary
  assert.equal(calendarWeekEnd(sundayLastMillisecond), mondayMidnight);
  assert.equal(calendarWeekEnd(mondayMidnight), Date.parse('2026-10-18T22:00:00.000Z'));
  assert.equal(scanIsCurrent(sundayLastMillisecond, sundayLastMillisecond), true);
  assert.equal(scanIsCurrent(sundayLastMillisecond, mondayMidnight), false);
  assert.equal(scanIsCurrent(mondayMidnight, mondayMidnight), true);
});

test('calendar-week expiry crosses New Year without changing the week rule', () => {
  assert.equal(calendarWeekEnd(Date.parse('2026-12-31T12:00:00.000Z')),
    Date.parse('2027-01-03T23:00:00.000Z'));
  assert.equal(calendarWeekEnd(Date.parse('2027-01-03T22:59:59.999Z')),
    Date.parse('2027-01-03T23:00:00.000Z'));
  assert.equal(calendarWeekEnd(Date.parse('2027-01-03T23:00:00.000Z')),
    Date.parse('2027-01-10T23:00:00.000Z'));
});

test('calendar-week expiry follows the spring and autumn Stockholm DST changes', () => {
  // The spring week is one hour shorter; the autumn week is one hour longer.
  const springStart = Date.parse('2026-03-22T23:00:00.000Z');
  const springEnd = Date.parse('2026-03-29T22:00:00.000Z');
  assert.equal(calendarWeekEnd(Date.parse('2026-03-29T21:59:59.999Z')), springEnd);
  assert.equal(springEnd - springStart, 167 * 60 * 60 * 1000);
  assert.equal(calendarWeekEnd(springEnd), Date.parse('2026-04-05T22:00:00.000Z'));

  const autumnStart = Date.parse('2026-10-18T22:00:00.000Z');
  const autumnEnd = Date.parse('2026-10-25T23:00:00.000Z');
  assert.equal(calendarWeekEnd(Date.parse('2026-10-25T22:59:59.999Z')), autumnEnd);
  assert.equal(autumnEnd - autumnStart, 169 * 60 * 60 * 1000);
  assert.equal(calendarWeekEnd(autumnEnd), Date.parse('2026-11-01T23:00:00.000Z'));
});

test('scans stay current after 25 hours within the same week and expire at the week boundary', () => {
  const now = Date.parse('2026-10-08T10:00:00.000Z');
  const observed = Date.parse('2026-10-07T08:30:00.000Z');
  assert.ok(now - observed > 25 * 60 * 60 * 1000);
  assert.equal(scanIsCurrent(observed, now), true);
  assert.equal(calendarWeekEnd(observed), Date.parse('2026-10-11T22:00:00.000Z'));
  assert.equal(scanIsCurrent(observed, Date.parse('2026-10-11T22:00:00.000Z')), false);
});

test('a scan from the prior calendar week is stale even when only one minute old', () => {
  const now = Date.parse('2026-10-11T22:00:00.000Z');
  const observed = Date.parse('2026-10-11T21:59:00.000Z');
  assert.equal(now - observed, 60 * 1000);
  assert.equal(calendarWeekEnd(observed), Date.parse('2026-10-11T22:00:00.000Z'));
  assert.equal(calendarWeekEnd(now), Date.parse('2026-10-18T22:00:00.000Z'));
  assert.equal(scanIsCurrent(observed, now), false);
});

test('future observations allow exactly 60 seconds and reject later or invalid timestamps', () => {
  const now = Date.parse('2026-10-08T10:00:00.000Z');
  assert.equal(scanIsCurrent(now + 60_000, now), true);
  assert.equal(scanIsCurrent(now + 60_001, now), false);
  for (const invalid of [NaN, Infinity, -Infinity, Number.MAX_VALUE]) {
    assert.equal(calendarWeekEnd(invalid), NaN);
    assert.equal(scanIsCurrent(invalid, now), false);
    assert.equal(scanIsCurrent(now, invalid), false);
  }
});
