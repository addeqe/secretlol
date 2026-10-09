import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { loadEnv, required } from '../src/config.ts';
import { D1DatabaseClient, rows } from '../src/database.ts';
import { backfillMealQuoteProjections } from '../src/meal-quote-projection.ts';
import { readDailyD1Writes } from './check-retailer-quota.ts';

loadEnv();
try {
  const database = new D1DatabaseClient({ databaseId: required('MEAL_DATABASE_ID') });
  const state = Object.fromEntries((await rows(database, "SELECT key,value FROM meal_meta WHERE key IN ('active_dataset','ready','manifest')"))
    .map(r => [String(r.key), String(r.value)]));
  if (!state.active_dataset || state.ready !== state.active_dataset) throw new Error('Quote projection waits for the verified recipe import');
  const manifest = JSON.parse(state.manifest);
  const allowance = Number(process.env.MEAL_QUOTE_WRITE_ALLOWANCE ?? 1000);
  if (!Number.isSafeInteger(allowance) || allowance < 1 || allowance > 20000) throw new Error('Invalid quote projection allowance');
  // Operators can supply a conservative floor for recently confirmed writes
  // while Cloudflare's account analytics are still catching up.
  const floor = Number(process.env.MEAL_QUOTE_ACCOUNT_WRITES_FLOOR ?? 0);
  if (!Number.isSafeInteger(floor) || floor < 0) throw new Error('Invalid confirmed account write floor');
  const used = Math.max(await readDailyD1Writes(process.env), floor);
  if (used + allowance + 10000 > 90000) throw new Error('Quote projection deferred to preserve the shared free write quota');
  await database.query(readFileSync(new URL('../meal-migrations/0003_meal_quotes.sql', import.meta.url), 'utf8'));
  let after = 0, processed = 0, done = false;
  while (!done && database.rowsWritten + 100 <= allowance) {
    const page = await backfillMealQuoteProjections(database, state.active_dataset, after);
    after = page.after; processed += page.processed; done = page.done;
  }
  const count = Number((await rows(database, 'SELECT COUNT(*) AS n FROM meal_quote_projections WHERE dataset_id=?', [state.active_dataset]))[0]?.n);
  const report = { checkedAt: new Date().toISOString(), datasetId: state.active_dataset,
    ready: done && count === manifest.recipes, projectedRecipes: count, totalRecipes: manifest.recipes,
    processed, accountWritesBefore: used, allowance, rowsRead: database.rowsRead, rowsWritten: database.rowsWritten, sizeBytes: database.sizeBytes };
  mkdirSync('data', { recursive: true });
  writeFileSync('data/last-meal-quote-projection-report.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Quote projection preparation failed'); process.exitCode = 1;
}
