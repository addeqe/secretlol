import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { D1DatabaseClient, rows } from '../src/database.ts';

const SCHEDULED_START_CUTOFF_UTC = '07:50';

/** Keep the full configured crawl budget inside the approved 04:00–08:45 UTC window. */
export function scheduledStartAllowed(now = new Date()): boolean {
  const minuteOfDay = now.getUTCHours() * 60 + now.getUTCMinutes();
  const [hour, minute] = SCHEDULED_START_CUTOFF_UTC.split(':').map(Number);
  return minuteOfDay >= 4 * 60 && minuteOfDay < hour * 60 + minute;
}

/** True only when D1 has a valid completed snapshot from this UTC calendar day. */
export function hasRefreshForUtcDay(completedAt: unknown, now = new Date()): boolean {
  if (typeof completedAt !== 'string' || !Number.isFinite(Date.parse(completedAt))) return false;
  const observed = new Date(completedAt);
  if (observed.getTime() > now.getTime() + 60_000) return false;
  return observed.toISOString().slice(0, 10) === now.toISOString().slice(0, 10);
}

export async function shouldRefresh(now = new Date(), database = new D1DatabaseClient({ readOnly: true })) {
  const active = await rows(database, "SELECT value FROM catalog_state WHERE key='active_snapshot'");
  const snapshotId = active[0]?.value;
  if (typeof snapshotId !== 'string' || !snapshotId) return true;
  const snapshot = await rows(database,
    "SELECT completed_at FROM snapshots WHERE id=? AND status='complete'", [snapshotId]);
  return !hasRefreshForUtcDay(snapshot[0]?.completed_at, now);
}

async function main() {
  if (!scheduledStartAllowed()) {
    const output = process.env.GITHUB_OUTPUT;
    if (!output) throw new Error('GITHUB_OUTPUT is required');
    appendFileSync(output, 'refresh=false\n');
    console.log('Scheduled start is too late to fit the configured run budget inside the Willys crawl window; no D1 query or retailer request made.');
    return;
  }
  const refresh = await shouldRefresh();
  const output = process.env.GITHUB_OUTPUT;
  if (!output) throw new Error('GITHUB_OUTPUT is required');
  appendFileSync(output, `refresh=${refresh}\n`);
  console.log(refresh
    ? 'No completed catalogue snapshot exists for today UTC; scheduled refresh may proceed.'
    : 'A completed catalogue snapshot already exists for today UTC; skipping redundant scheduled refresh.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : 'Catalogue freshness check failed');
    process.exitCode = 1;
  });
}
