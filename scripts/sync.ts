import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnv, integer, storeId } from '../src/config.ts';
import { WillysClient } from '../src/willys.ts';
import { crawl } from '../src/crawl.ts';
import { normalize } from '../src/products.ts';
import { D1DatabaseClient, LocalDatabase } from '../src/database.ts';
import { publish } from '../src/publish.ts';
import type { Scan, SourceProduct } from '../src/types.ts';

loadEnv();
const args = process.argv.slice(2);
const argument = (flag: string) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
let local: LocalDatabase | undefined;
try {
  const source = new WillysClient({ maxRequests: integer('MAX_WILLYS_REQUESTS', 300, 10, 2000), maxMinutes: integer('MAX_RUN_MINUTES', 55, 1, 55) });
  if (args.includes('--stores')) {
    await source.initialize(storeId());
    const stores = await source.stores();
    console.table(stores.map((s: any) => ({ id: s.storeId, name: s.name, city: s.address?.town })));
  } else if (args.includes('--probe')) {
    const store = await source.initialize(storeId());
    const tree = await source.categories(store.storeId);
    const page = await source.category(tree.children[0].url, 0);
    console.log(JSON.stringify({ store, categories: tree.children.length, sampleCategory: tree.children[0].title,
      returnedProducts: page.results.length, categoryTotal: page.pagination.totalNumberOfResults, requests: source.requests }, null, 2));
  } else {
    const fixture = argument('--fixture'), localPath = argument('--local');
    if (fixture && !localPath) throw new Error('Fixture data must use --local. Sample data cannot be uploaded to production.');
    if (localPath) {
      local = new LocalDatabase(localPath);
      local.execute(readFileSync(new URL('../migrations/0001_catalog.sql', import.meta.url), 'utf8'));
    }
    const database = local ?? (args.includes('--dry-run') ? undefined : new D1DatabaseClient());
    if (database && !local) await database.query("SELECT value FROM catalog_state WHERE key='active_snapshot'");
    let scan: Scan;
    if (fixture) {
      const data = JSON.parse(readFileSync(fixture, 'utf8'));
      const now = new Date().toISOString();
      scan = { store: data.store, entries: data.products.map((p: SourceProduct) => normalize(p, 'TEST FIXTURE', now)),
        categories: [], requests: 0, startedAt: now, completedAt: now };
    } else scan = await crawl(source, storeId(), integer('MAX_PRODUCTS', 20000, 1, 20000));
    mkdirSync(resolve('data'), { recursive: true });
    const report = { fixture: !!fixture, store: scan.store, products: scan.entries.length, categories: scan.categories,
      requests: scan.requests, startedAt: scan.startedAt, completedAt: scan.completedAt };
    writeFileSync(resolve('data/last-scan-report.json'), JSON.stringify(report, null, 2));
    if (args.includes('--dry-run')) {
      writeFileSync(resolve('data/catalog-preview.json'), JSON.stringify(scan));
      console.log(JSON.stringify({ ...report, published: false, preview: 'data/catalog-preview.json' }, null, 2));
    } else {
      if (!database) throw new Error('Database is not connected');
      console.log(JSON.stringify(await publish(database, scan, { allowShrink: args.includes('--allow-shrink') }), null, 2));
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Catalogue sync failed'); process.exitCode = 1;
} finally { local?.close(); }
