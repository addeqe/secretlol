import { createInterface } from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, chmodSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { required } from '../src/config.ts';

export async function ask(label: string, fallback = '') {
  if (!process.stdin.isTTY) throw new Error('Connection setup needs an interactive terminal. See SETUP.md for noninteractive settings.');
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await reader.question(`${label}${fallback ? ` [${fallback}]` : ''}: `)).trim() || fallback; }
  finally { reader.close(); }
}
export async function hidden(label: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error('Paste secrets into an interactive terminal, or set environment variables.');
  process.stdout.write(`${label} (hidden): `); process.stdin.setRawMode(true); process.stdin.resume();
  return new Promise((resolveValue, reject) => {
    let value = '';
    const finish = () => { process.stdin.off('data', onData); process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n'); };
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\u0003') { finish(); reject(new Error('Connection setup cancelled')); return; }
        if (char === '\r' || char === '\n') { finish(); resolveValue(value.trim()); return; }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ') value += char;
      }
    };
    process.stdin.on('data', onData);
  });
}
export function saveEnv(updates: Record<string, string>) {
  const file = resolve('.env');
  const original = existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/).filter(line => !Object.keys(updates).some(k => line.startsWith(`${k}=`))) : [];
  const content = [...original, ...Object.entries(updates).map(([key, value]) => `${key}=${JSON.stringify(value)}`)].filter(Boolean).join('\n') + '\n';
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, content, { mode: 0o600 }); chmodSync(temporary, 0o600); renameSync(temporary, file);
  Object.assign(process.env, updates);
}
export function command(binary: string, args: string[], options: { input?: string; capture?: boolean } = {}) {
  const result = spawnSync(binary, args, { cwd: process.cwd(), env: process.env,
    stdio: options.capture || options.input !== undefined ? ['pipe', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8', input: options.input });
  if (result.error || result.status !== 0) throw new Error(`${binary} ${args.slice(0, 2).join(' ')} failed. ${result.error ? result.error.message : 'Check your connection and account permissions.'}`);
  return result.stdout ?? '';
}
export async function cloudflare(path: string, method = 'GET', body?: unknown, allowMissing = false) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, { method,
    headers: { Authorization: `Bearer ${required('CLOUDFLARE_API_TOKEN')}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
  const data = await response.json() as { success: boolean; result: any; errors?: { code: number }[] };
  // A new account's unregistered workers.dev address is API error 10007.
  if (allowMissing && (response.status === 404 || data.errors?.some(error => error.code === 10007))) return null;
  if (!response.ok) throw new Error(`Cloudflare HTTP ${response.status}. Verify account ID and API-token permissions.`);
  if (!data.success) throw new Error('Cloudflare could not complete the setup operation.');
  return data.result;
}
export function connectedConfig() {
  const original = JSON.parse(readFileSync(resolve('wrangler.jsonc'), 'utf8'));
  original.account_id = required('CLOUDFLARE_ACCOUNT_ID');
  original.d1_databases[0].database_id = required('CLOUDFLARE_DATABASE_ID');
  if (process.env.GITHUB_REPOSITORY) original.vars.GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY;
  writeFileSync(resolve('wrangler.connected.json'), JSON.stringify(original, null, 2));
}
export function wrangler(args: string[], options: { input?: string; capture?: boolean } = {}) {
  return command(process.execPath, [resolve('node_modules/wrangler/bin/wrangler.js'), ...args, '--config', 'wrangler.connected.json'], options);
}
