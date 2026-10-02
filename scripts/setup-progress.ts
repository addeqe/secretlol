import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ask, hidden, saveEnv } from './helpers.ts';

export const fingerprint = (...values: unknown[]) => createHash('sha256').update(JSON.stringify(values)).digest('hex');
export const deploymentSource = () => readFileSync(new URL('../worker/index.ts', import.meta.url), 'utf8') + readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');

export class SetupProgress {
  private steps: Record<string, string> = {};
  file: string;
  log: (message: string) => void;
  constructor(file = resolve('data/setup-progress.json'), log = console.log) {
    this.file = file; this.log = log;
    if (existsSync(file)) {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      if (saved.version !== 1 || !saved.steps || typeof saved.steps !== 'object') throw new Error('Invalid saved setup progress. Preserve .env and remove data/setup-progress.json to rebuild progress.');
      this.steps = saved.steps;
    }
  }
  done(name: string, key: string) { return this.steps[name] === key; }
  mark(name: string, key: string) {
    this.steps[name] = key;
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, steps: this.steps }, null, 2) + '\n', { mode: 0o600 });
    chmodSync(temporary, 0o600); renameSync(temporary, this.file);
  }
  async run(name: string, key: string, work: () => void | Promise<unknown>) {
    if (this.done(name, key)) { this.log(`Already completed: ${name}.`); return; }
    await work(); this.mark(name, key);
  }
}

type Answers = { env: NodeJS.ProcessEnv; ask: typeof ask; hidden: typeof hidden; save: (updates: Record<string, string>) => void };
export function savedAnswers(options: Partial<Answers> = {}) {
  const io = { env: process.env, ask, hidden, save: saveEnv, ...options };
  const remember = (name: string, value: string) => { io.save({ [name]: value }); io.env[name] = value; return value; };
  return {
    async value(name: string, label: string, valid: (value: string) => boolean, fallback = '') {
      const saved = io.env[name]?.trim();
      if (saved && valid(saved)) return saved;
      const value = await io.ask(label, fallback);
      if (!valid(value)) throw new Error(`Invalid ${label}. Earlier answers are saved; rerun npm run connect.`);
      return remember(name, value);
    },
    async secret(name: string, label: string) {
      if (io.env[name]?.trim()) return io.env[name]!.trim();
      const value = await io.hidden(label);
      if (!value) throw new Error(`Missing ${label}. Earlier answers are saved; rerun npm run connect.`);
      return remember(name, value);
    }
  };
}

export const cloudflareSettingsComplete = (env: NodeJS.ProcessEnv) =>
  ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_DATABASE_ID', 'CATALOG_API_TOKEN', 'CATALOG_API_URL'].every(name => !!env[name]?.trim());

export function cloudflareDeploymentKey(env: NodeJS.ProcessEnv, source: string) {
  return fingerprint(env.CLOUDFLARE_ACCOUNT_ID, env.CLOUDFLARE_DATABASE_ID, env.CATALOG_API_TOKEN, source);
}
