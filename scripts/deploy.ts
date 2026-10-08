import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { loadEnv, required } from '../src/config.ts';
import { connectedConfig, saveEnv, wrangler } from './helpers.ts';
import {D1DatabaseClient} from '../src/database.ts';
import {ensureCatalogStorage} from '../src/catalog-storage.ts';
import {ensureIngredientStorage} from '../src/ingredient-storage.ts';
loadEnv();
export async function deploy() {
  const apiToken = required('CATALOG_API_TOKEN');
  if (apiToken.length < 32) throw new Error('CATALOG_API_TOKEN must contain at least 32 characters.');
  const database=new D1DatabaseClient();
  await ensureCatalogStorage(database);await ensureIngredientStorage(database);
  connectedConfig();
  const output = wrangler(['deploy'], { capture: true });
  // Deployment logs do not contain our secrets; secret uploads use stdin below.
  process.stdout.write(output);
  wrangler(['secret', 'put', 'CATALOG_API_TOKEN'], { input: apiToken });
  const reviewToken=process.env.INGREDIENT_REVIEW_TOKEN || randomBytes(32).toString('hex');
  if(reviewToken.length<32)throw new Error('INGREDIENT_REVIEW_TOKEN must contain at least 32 characters.');
  saveEnv({INGREDIENT_REVIEW_TOKEN:reviewToken});
  wrangler(['secret','put','INGREDIENT_REVIEW_TOKEN'],{input:reviewToken});
  if (process.env.GITHUB_DISPATCH_TOKEN) wrangler(['secret', 'put', 'GITHUB_DISPATCH_TOKEN'], { input: process.env.GITHUB_DISPATCH_TOKEN });
  const url = output.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/)?.[0];
  if (!url) throw new Error('Worker deployed, but URL was not found. Copy its workers.dev URL from Cloudflare into CATALOG_API_URL in .env.');
  saveEnv({ CATALOG_API_URL: url });
  mkdirSync(resolve('data'), { recursive: true });
  writeFileSync(resolve('data/mealplanner.env'), `PRICE_API_URL=${JSON.stringify(url)}\nPRICE_API_TOKEN=${JSON.stringify(apiToken)}\n`, { mode: 0o600 });
  writeFileSync(resolve('data/ingredient-review.env'),`INGREDIENT_REVIEW_TOKEN=${JSON.stringify(reviewToken)}\n`,{mode:0o600});
  console.log(`Service: ${url}\nThe meal-planner connection values are saved privately in data/mealplanner.env.`);
  return url;
}
if (process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`) {
  try { await deploy(); } catch (error) { console.error(error instanceof Error ? error.message : 'Deployment failed'); process.exitCode = 1; }
}
