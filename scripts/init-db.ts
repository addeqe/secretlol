import { readFileSync } from 'node:fs';
import { loadEnv } from '../src/config.ts';
import { D1DatabaseClient } from '../src/database.ts';
loadEnv();
try {
  const sql = readFileSync(new URL('../migrations/0001_catalog.sql', import.meta.url), 'utf8');
  await new D1DatabaseClient().query(sql);
  console.log('Catalogue database is initialized.');
} catch (error) { console.error(error instanceof Error ? error.message : 'Database setup failed'); process.exitCode = 1; }
