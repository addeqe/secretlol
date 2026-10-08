import { readFileSync } from 'node:fs';
import { loadEnv } from '../src/config.ts';
import { D1DatabaseClient } from '../src/database.ts';
import {ensureCatalogStorage} from '../src/catalog-storage.ts';
import {ensureIngredientStorage} from '../src/ingredient-storage.ts';
loadEnv();
try {
  const sql = readFileSync(new URL('../migrations/0001_catalog.sql', import.meta.url), 'utf8');
  const database=new D1DatabaseClient();
  await database.query(sql);
  await database.query(readFileSync(new URL('../migrations/0002_ingredients.sql',import.meta.url),'utf8'));
  await ensureCatalogStorage(database);await ensureIngredientStorage(database);
  console.log('Catalogue database is initialized.');
} catch (error) { console.error(error instanceof Error ? error.message : 'Database setup failed'); process.exitCode = 1; }
