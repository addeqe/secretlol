import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { integer, required } from './config.ts';
import type { Database, QueryResult, Statement } from './types.ts';

export class D1DatabaseClient implements Database {
  rowsWritten = 0;
  rowsRead = 0;
  sizeBytes = 0;
  private url: string;
  private token: string;
  private fetcher: typeof fetch;
  constructor(options: { accountId?: string; databaseId?: string; token?: string; fetcher?: typeof fetch } = {}) {
    const account = options.accountId ?? required('CLOUDFLARE_ACCOUNT_ID');
    const database = options.databaseId ?? required('CLOUDFLARE_DATABASE_ID');
    if (!/^[a-f0-9]{32}$/i.test(account) || !/^[a-f0-9-]{36}$/i.test(database)) throw new Error('Invalid Cloudflare account/database ID');
    this.url = `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database}/query`;
    this.token = options.token ?? required('CLOUDFLARE_API_TOKEN'); this.fetcher = options.fetcher ?? fetch;
  }
  query(sql: string, params: Statement['params'] = []) { return this.send({ sql, params }); }
  batch(batch: Statement[]) { return this.send({ batch }); }
  async send(body: unknown): Promise<QueryResult[]> {
    if (this.rowsWritten >= integer('MAX_D1_ROWS_WRITTEN', 80000) || this.sizeBytes >= integer('MAX_D1_SIZE_MB', 400) * 1024 * 1024) {
      throw new Error('D1 run/storage budget reached. Stay on Free; investigate usage before retrying.');
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      let response: Response;
      try { response = await this.fetcher(this.url, { method: 'POST', headers: { 'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) }); }
      catch { throw new Error('Cloudflare network error. Re-run sync; publication is idempotent.'); }
      if ((response.status === 429 || response.status >= 500) && attempt < 2) { await sleep(1000 * 2 ** attempt); continue; }
      if (!response.ok) throw new Error(`Cloudflare HTTP ${response.status}. Check D1 credentials and free quotas.`);
      const data = await response.json() as { success?: boolean; result?: QueryResult[] };
      if (!data.success || !Array.isArray(data.result) || data.result.some(r => !r.success)) throw new Error('Cloudflare rejected a database query.');
      for (const result of data.result) {
        this.rowsWritten += result.meta?.rows_written ?? 0; this.rowsRead += result.meta?.rows_read ?? 0;
        this.sizeBytes = result.meta?.size_after ?? this.sizeBytes;
      }
      return data.result;
    }
    throw new Error('Cloudflare retry budget exceeded');
  }
}
export class LocalDatabase implements Database {
  db: DatabaseSync;
  constructor(path: string) { mkdirSync(dirname(path), { recursive: true }); this.db = new DatabaseSync(path); }
  execute(sql: string) { this.db.exec(sql); }
  async query(sql: string, params: Statement['params'] = []): Promise<QueryResult[]> {
    const statement = this.db.prepare(sql);
    const results = statement.all(...params) as Record<string, unknown>[];
    return [{ results, success: true }];
  }
  async batch(statements: Statement[]) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const results = [];
      for (const statement of statements) results.push(...await this.query(statement.sql, statement.params));
      this.db.exec('COMMIT'); return results;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}
export async function rows(database: Database, sql: string, params: Statement['params'] = []) {
  return (await database.query(sql, params)).flatMap(r => r.results ?? []);
}
