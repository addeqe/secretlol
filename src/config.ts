import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function loadEnv(path = resolve('.env')) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2].trim();
    if (value.startsWith('"')) value = JSON.parse(value);
    else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}
export function integer(name: string, fallback: number, minimum = 1, maximum = 1000000) {
  const n = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(n) || n < minimum || n > maximum) throw new Error(`Invalid ${name}`);
  return n;
}
export function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}. Run npm run connect or add it to .env / GitHub settings.`);
  return value;
}
export function storeId() {
  const id = process.env.WILLYS_STORE_ID || '2110';
  if (!/^\d{4,8}$/.test(id)) throw new Error('WILLYS_STORE_ID must be a numeric Willys store ID.');
  return id;
}
