import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { planPendingChunks, validateLocal } from '../scripts/upload-meal-enrichment.ts';

const folders: string[] = [];
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

function fixture() {
  const folder = mkdtempSync(join(tmpdir(), 'meal-enrichment-'));
  folders.push(folder);
  const json = Buffer.from('{"101":{"filters":[],"profile":{"nutrition_metrics":{}}}}');
  const compressed = gzipSync(json);
  const file = 'recipes-0.json.gz';
  writeFileSync(join(folder, file), compressed);
  const manifest = {
    schemaVersion: 1 as const,
    revision: `recipe-filters-3-${'a'.repeat(20)}`,
    baseDatasetId: 'b'.repeat(64),
    recipes: 1,
    chunkWidth: 1024,
    recipeChunks: [0],
    ingredientChunks: {},
    setChunks: {},
    planningChunks: [0],
    ingredientNames: ['eggs'],
    inventoryHash: 'c'.repeat(64),
    recipeIdsSha256: 'd'.repeat(64),
    unchangedCounts: {},
    chunks: [{ kind: 'recipes' as const, chunkId: 0, file, sha256: sha(compressed),
      contentSha256: sha(json), bytes: compressed.length, uncompressedBytes: json.length }],
    estimatedRowsToWrite: 2,
  };
  return { folder, manifest, compressed };
}

afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

test('validates compressed and decompressed hashes for local enrichment chunks', () => {
  const { folder, manifest } = fixture();
  const result = validateLocal(folder, manifest);
  assert.deepEqual([...result.keys], ['recipes:0']);
  assert.equal(result.uncompressedBytes, manifest.chunks[0]!.uncompressedBytes);
});

test('rejects changed compressed chunk bytes before any upload path', () => {
  const { folder, manifest, compressed } = fixture();
  writeFileSync(join(folder, 'recipes-0.json.gz'), Buffer.concat([compressed, Buffer.from('x')]));
  assert.throws(() => validateLocal(folder, manifest), /checksum mismatch/);
});

test('rejects unsafe chunk paths in the manifest', () => {
  const { folder, manifest } = fixture();
  manifest.chunks[0]!.file = '../outside.json.gz';
  assert.throws(() => validateLocal(folder, manifest), /Unsafe enrichment chunk path/);
});

test('rejects duplicate chunk identities', () => {
  const { folder, manifest } = fixture();
  manifest.chunks.push({ ...manifest.chunks[0]! });
  manifest.estimatedRowsToWrite = 3;
  assert.throws(() => validateLocal(folder, manifest), /Invalid enrichment chunk entry/);
});

test('resumes only missing chunks and budgets only their decoded bytes', () => {
  const { manifest } = fixture();
  const chunk = manifest.chunks[0]!;
  const result = planPendingChunks([
    chunk,
    { ...chunk, chunkId: 1, file: 'recipes-1.json.gz', uncompressedBytes: 25 },
  ], [{ kind: 'recipes', chunk_id: 0, content_sha256: chunk.contentSha256 }]);
  assert.deepEqual(result.pending.map(value => value.chunkId), [1]);
  assert.equal(result.pendingUncompressedBytes, 25);
});

test('detects checksum conflicts and extra stored chunks before writes', () => {
  const { manifest } = fixture();
  const chunk = manifest.chunks[0]!;
  assert.throws(() => planPendingChunks([chunk], [
    { kind: 'recipes', chunk_id: 0, content_sha256: 'e'.repeat(64) },
  ]), /conflicts with this revision/);
  assert.throws(() => planPendingChunks([chunk], [
    { kind: 'sets', chunk_id: 1, content_sha256: 'f'.repeat(64) },
  ]), /conflicts with this revision/);
});
