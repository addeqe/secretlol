import test from 'node:test';
import assert from 'node:assert/strict';
import { D1DatabaseClient } from '../src/database.ts';

const ACCOUNT_ID = 'a'.repeat(32);
const DATABASE_ID = '123e4567-e89b-12d3-a456-426614174000';
const OVER_LIMIT_BYTES = 450 * 1024 * 1024;

function client(readOnly: boolean, onRequest: () => void) {
  const fetcher = (async () => {
    onRequest();
    return new Response(JSON.stringify({ success: true, result: [{
      success: true,
      results: [{ value: 'ok' }],
      meta: { rows_read: 1, rows_written: 0, size_after: OVER_LIMIT_BYTES },
    }] }), { status: 200 });
  }) as typeof fetch;
  return new D1DatabaseClient({ accountId: ACCOUNT_ID, databaseId: DATABASE_ID,
    token: 'test-token', fetcher, readOnly });
}

test('read-only D1 clients keep serving SELECT queries above the normal size ceiling', async () => {
  let requests = 0;
  const database = client(true, () => requests++);
  for (let i = 0; i < 3; i++) {
    const result = await database.query("SELECT value FROM meal_meta WHERE key='inventory'");
    assert.equal(result[0]?.results[0]?.value, 'ok');
  }
  assert.equal(database.sizeBytes, OVER_LIMIT_BYTES);
  assert.equal(database.rowsRead, 3);
  assert.equal(database.rowsWritten, 0);
  assert.equal(requests, 3);
});

test('read-only D1 clients reject mutations, batches, comments, and multi-statement SQL locally', async () => {
  let requests = 0;
  const database = client(true, () => requests++);
  for (const sql of [
    'INSERT INTO meal_meta(key,value) VALUES(?,?)',
    'UPDATE meal_meta SET value=?',
    'DELETE FROM meal_meta',
    'PRAGMA table_info(meal_meta)',
    'SELECT 1; DELETE FROM meal_meta',
    'SELECT 1 -- trailing comment',
    'SELECT 1 /* comment */',
  ]) await assert.rejects(database.query(sql), /Read-only D1 client/);
  await assert.rejects(database.batch([{ sql: 'SELECT 1' }]), /Read-only D1 client/);
  assert.equal(requests, 0);
  assert.equal(database.rowsWritten, 0);
});

test('the default writable client still blocks requests after the size budget is reached', async () => {
  const previousLimit = process.env.MAX_D1_SIZE_MB;
  process.env.MAX_D1_SIZE_MB = '400';
  try {
    let requests = 0;
    const database = client(false, () => requests++);
    await database.query('SELECT 1');
    assert.equal(database.sizeBytes, OVER_LIMIT_BYTES);
    await assert.rejects(database.query('INSERT INTO meal_meta(key,value) VALUES(?,?)'), /budget reached/);
    assert.equal(requests, 1);
    assert.equal(database.rowsWritten, 0);
  } finally {
    if (previousLimit === undefined) delete process.env.MAX_D1_SIZE_MB;
    else process.env.MAX_D1_SIZE_MB = previousLimit;
  }
});
