import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { parseArgs } from 'node:util';
import { loadEnv, required } from '../src/config.ts';
import { D1DatabaseClient, rows } from '../src/database.ts';
import { readDailyD1Writes } from './check-retailer-quota.ts';

type Chunk = { kind: 'recipes' | 'ingredients' | 'sets' | 'planning'; chunkId: number;
  file: string; sha256: string; contentSha256: string; bytes: number; uncompressedBytes: number };
type Enrichment = { schemaVersion: 1; revision: string; baseDatasetId: string; recipes: number;
  chunkWidth: number; recipeChunks: number[]; ingredientChunks: Record<string, number>;
  setChunks: Record<string, number>; planningChunks: number[]; ingredientNames: string[];
  inventoryHash: string; recipeIdsSha256: string; unchangedCounts: Record<string, number>;
  chunks: Chunk[]; estimatedRowsToWrite: number; [key: string]: unknown };
type BaseManifest = { datasetId: string; recipes: number; ingredientOccurrences: number;
  distinctIngredients: number; reviews: number; inventoryHash: string };
type StoredChunk = { kind: string; chunk_id: number; content_sha256: string };

const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const MAX_DATABASE_BYTES = 480 * 1024 * 1024;
const ACCOUNT_WRITE_LIMIT = 90_000;
const WRITE_RESERVE = 10_000;

function readJson(path: string) { return JSON.parse(readFileSync(path, 'utf8')); }
export function validateLocal(folder: string, enrichment: Enrichment) {
  if (enrichment.schemaVersion !== 1 || !/^[\da-f]{64}$/.test(enrichment.baseDatasetId)
    || !/^recipe-filters-3-[\da-f]{20}$/.test(enrichment.revision) || enrichment.chunkWidth !== 1024
    || !Number.isSafeInteger(enrichment.recipes) || enrichment.recipes < 1
    || !Array.isArray(enrichment.recipeChunks) || !Array.isArray(enrichment.planningChunks)
    || !Array.isArray(enrichment.ingredientNames) || !Array.isArray(enrichment.chunks)
    || enrichment.chunks.length !== enrichment.estimatedRowsToWrite - 1) throw new Error('Invalid enrichment manifest');
  const seen = new Set<string>();
  let uncompressedBytes = 0;
  for (const chunk of enrichment.chunks) {
    const key = `${chunk.kind}:${chunk.chunkId}`;
    if (seen.has(key) || !['recipes', 'ingredients', 'sets', 'planning'].includes(chunk.kind)
      || !Number.isSafeInteger(chunk.chunkId) || chunk.chunkId < 0) throw new Error('Invalid enrichment chunk entry');
    seen.add(key);
    if (chunk.file !== `${chunk.kind}-${chunk.chunkId}.json.gz`) throw new Error('Unsafe enrichment chunk path');
    const path = resolve(folder, chunk.file);
    if (!path.startsWith(resolve(folder) + '/') || !existsSync(path)) throw new Error('Enrichment chunk is missing');
    const compressed = readFileSync(path);
    if (compressed.length !== chunk.bytes || sha(compressed) !== chunk.sha256) throw new Error(`Chunk checksum mismatch: ${key}`);
    const document = gunzipSync(compressed, { maxOutputLength: chunk.uncompressedBytes + 1 });
    if (document.length !== chunk.uncompressedBytes || sha(document) !== chunk.contentSha256) throw new Error(`Chunk content mismatch: ${key}`);
    JSON.parse(document.toString('utf8'));
    uncompressedBytes += chunk.uncompressedBytes;
  }
  return { uncompressedBytes, keys: seen };
}

export function planPendingChunks(chunks: Chunk[], existingRows: StoredChunk[]) {
  const expected = new Map(chunks.map(chunk => [`${chunk.kind}:${chunk.chunkId}`, chunk.contentSha256]));
  const existing = new Map(existingRows.map(row => [`${row.kind}:${Number(row.chunk_id)}`, String(row.content_sha256)]));
  for (const [key, checksum] of existing) {
    if (!expected.has(key) || expected.get(key) !== checksum)
      throw new Error(`A partial enrichment chunk conflicts with this revision: ${key}`);
  }
  const pending = chunks.filter(chunk => !existing.has(`${chunk.kind}:${chunk.chunkId}`));
  return { pending, pendingUncompressedBytes: pending.reduce((total, chunk) => total + chunk.uncompressedBytes, 0) };
}

async function verifyBase(database: D1DatabaseClient, manifest: Enrichment, base: BaseManifest) {
  const state = Object.fromEntries((await rows(database,
    "SELECT key,value FROM meal_meta WHERE key IN ('active_dataset','manifest','ready','inventory','enrichment')"))
    .map(r => [String(r.key), String(r.value)]));
  if (state.active_dataset !== manifest.baseDatasetId || state.ready !== manifest.baseDatasetId || !state.manifest)
    throw new Error('The immutable base dataset is not the ready active meal dataset');
  const installed = JSON.parse(state.manifest);
  if (installed.datasetId !== base.datasetId || installed.datasetId !== manifest.baseDatasetId
    || installed.recipes !== base.recipes || installed.reviews !== base.reviews
    || installed.distinctIngredients !== base.distinctIngredients
    || installed.ingredientOccurrences !== base.ingredientOccurrences
    || installed.inventoryHash !== manifest.inventoryHash) throw new Error('Cloud base manifest differs from the pinned local base');
  if (!state.inventory || JSON.parse(state.inventory).hash !== manifest.inventoryHash)
    throw new Error('Cloud ingredient inventory differs from the pinned base');
  const counts = await database.query(`SELECT
      (SELECT COUNT(*) FROM meal_recipes WHERE dataset_id=?) AS recipes,
      (SELECT COUNT(*) FROM meal_ingredients WHERE dataset_id=?) AS ingredients`,
    [manifest.baseDatasetId, manifest.baseDatasetId]);
  const countsRow = counts[0]?.results?.[0];
  if (Number(countsRow?.recipes) !== base.recipes || Number(countsRow?.ingredients) !== base.distinctIngredients)
    throw new Error('Cloud recipe or ingredient row counts differ from the pinned base');
  const ids = await rows(database, 'SELECT recipe_id FROM meal_recipes WHERE dataset_id=? ORDER BY recipe_id', [manifest.baseDatasetId]);
  if (ids.length !== base.recipes || sha(JSON.stringify(ids.map(row => Number(row.recipe_id)))) !== manifest.recipeIdsSha256)
    throw new Error('Cloud recipe IDs differ from the unchanged local base');
  return { state, installed, databaseBytes: database.sizeBytes };
}

async function upload(folder: string, manifest: Enrichment, base: BaseManifest) {
  // D1DatabaseClient's default safety ceiling is 400 MiB. This controlled
  // enrichment path uses the stricter project limit below: 480 MiB.
  process.env.MAX_D1_SIZE_MB ??= '480';
  const database = new D1DatabaseClient({ databaseId: required('MEAL_DATABASE_ID') });
  const { state, databaseBytes } = await verifyBase(database, manifest, base);
  if (!Number.isSafeInteger(databaseBytes) || databaseBytes <= 0) throw new Error('D1 size metadata unavailable; refusing an unbounded write');

  const { uncompressedBytes } = validateLocal(folder, manifest);
  const table = await rows(database,
    "SELECT name FROM sqlite_master WHERE type='table' AND name='meal_enrichment_chunks'");
  const existing: StoredChunk[] = table.length ? await rows(database,
    'SELECT kind,chunk_id,content_sha256 FROM meal_enrichment_chunks WHERE dataset_id=? AND revision=?',
    [manifest.baseDatasetId, manifest.revision]) as StoredChunk[] : [];
  const { pending: pendingChunks, pendingUncompressedBytes } = planPendingChunks(manifest.chunks, existing);

  if (state.enrichment) {
    const active = JSON.parse(state.enrichment);
    if (active.revision === manifest.revision) {
      if (!table.length || pendingChunks.length)
        throw new Error('Active enrichment chunks do not match their manifest');
      console.log(JSON.stringify({ revision: manifest.revision, ready: true, alreadyActive: true, rowsWritten: 0 }));
      return;
    }
  }

  // D1 stores the decoded JSON text. Reserve 1% for row/index overhead plus
  // 256 KB for SQLite metadata. Count only missing chunks so an interrupted
  // upload can resume against storage already occupied by its matching rows.
  const storageAllowance = Math.ceil(pendingUncompressedBytes * 1.01) + 256_000;
  if (databaseBytes + storageAllowance >= MAX_DATABASE_BYTES)
    throw new Error('Enrichment would exceed the 480 MiB project storage ceiling; upload deferred');
  const used = await readDailyD1Writes(process.env);
  const allowance = pendingChunks.length + 1;
  if (used + allowance + WRITE_RESERVE > ACCOUNT_WRITE_LIMIT)
    throw new Error('Shared daily D1 write quota leaves less than the required 10,000-row reserve; upload deferred');

  const pending: Array<{ chunk: Chunk; document: string }> = pendingChunks.map(chunk => {
    const compressed = readFileSync(resolve(folder, chunk.file));
    const document = gunzipSync(compressed, { maxOutputLength: chunk.uncompressedBytes + 1 }).toString('utf8');
    return { chunk, document };
  });
  const migration = readFileSync(new URL('../meal-migrations/0004_meal_enrichment.sql', import.meta.url), 'utf8');
  for (const statement of migration.split(';').map(value => value.trim()).filter(Boolean)) await database.query(statement);
  for (let offset = 0; offset < pending.length; offset += 3) {
    const batch = pending.slice(offset, offset + 3);
    await database.batch(batch.map(({ chunk, document }) => ({ sql:
      'INSERT OR IGNORE INTO meal_enrichment_chunks(dataset_id,revision,kind,chunk_id,document_json,content_sha256) VALUES(?,?,?,?,?,?)',
      params: [manifest.baseDatasetId, manifest.revision, chunk.kind, chunk.chunkId, document, chunk.contentSha256] })));
  }
  const verified = await rows(database, 'SELECT kind,chunk_id,content_sha256 FROM meal_enrichment_chunks WHERE dataset_id=? AND revision=?',
    [manifest.baseDatasetId, manifest.revision]);
  const expected = new Map(manifest.chunks.map(c => [`${c.kind}:${c.chunkId}`, c.contentSha256]));
  if (verified.length !== expected.size || verified.some(r => expected.get(`${r.kind}:${Number(r.chunk_id)}`) !== r.content_sha256))
    throw new Error('Enrichment chunk count or checksum parity failed; active revision was not changed');
  if (database.sizeBytes >= MAX_DATABASE_BYTES) throw new Error('D1 storage ceiling reached before activation; active revision was not changed');

  const metaValue = JSON.stringify(manifest);
  await database.query("INSERT INTO meal_meta(key,value) VALUES('enrichment',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [metaValue]);
  const active = await rows(database, "SELECT value FROM meal_meta WHERE key='enrichment'");
  if (!active[0] || JSON.parse(String(active[0].value)).revision !== manifest.revision)
    throw new Error('Atomic enrichment activation could not be verified');
  console.log(JSON.stringify({ revision: manifest.revision, ready: true, chunks: verified.length,
    rowsWritten: database.rowsWritten, accountWritesBefore: used, reserve: WRITE_RESERVE,
    databaseBytes: database.sizeBytes, uncompressedChunkBytes: uncompressedBytes,
    newlyStagedUncompressedBytes: pendingUncompressedBytes, missingChunksWritten: pending.length }, null, 2));
}

async function main() {
  loadEnv();
  const { values } = parseArgs({ options: {
    folder: { type: 'string', default: 'data/meal-enrichment-20261010' },
    'base-manifest': { type: 'string', default: 'meal-data/manifest.json' },
    apply: { type: 'boolean', default: false },
  } });
  const folder = resolve(values.folder!);
  const manifest = readJson(resolve(folder, 'manifest.json')) as Enrichment;
  const base = readJson(resolve(values['base-manifest']!)) as BaseManifest;
  const local = validateLocal(folder, manifest);
  if (base.datasetId !== manifest.baseDatasetId || base.inventoryHash !== manifest.inventoryHash
    || base.recipes !== manifest.recipes) throw new Error('Local base manifest does not match enrichment export');
  if (!values.apply) {
    console.log(JSON.stringify({ dryRun: true, cloudCalls: 0, revision: manifest.revision,
      baseDatasetId: manifest.baseDatasetId, chunks: manifest.chunks.length,
      estimatedRowsToWrite: manifest.estimatedRowsToWrite, uncompressedBytes: local.uncompressedBytes,
      compressedAssetBytes: manifest.chunks.reduce((total, chunk) => total + chunk.bytes, 0),
      estimatedAdditionalStorageBytes: Math.ceil(local.uncompressedBytes * 1.01) + 256_000,
      storageCeilingBytes: MAX_DATABASE_BYTES,
      nextStep: 'Run with --apply only after an explicit upload authorization.' }, null, 2));
    return;
  }
  await upload(folder, manifest, base);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : 'Meal enrichment upload failed');
    process.exitCode = 1;
  });
}
