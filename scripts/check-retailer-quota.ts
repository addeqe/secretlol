import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Fail-closed preflight for the shared Cloudflare D1 daily write allowance.
 * Emits only a boolean Actions output and aggregate write counts; credentials
 * and account identifiers are never printed.
 */

export type QuotaDecision = {
  allowed: boolean;
  used: number;
  allowance: number;
  reserve: number;
  limit: number;
};

export function decideQuota(used: number, allowance: number, reserve = 10_000, limit = 90_000): QuotaDecision {
  for (const [name, value] of Object.entries({ used, allowance, reserve, limit })) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${name} in shared write quota`);
  }
  if (allowance < 1 || allowance > 50_000) throw new Error('COOP_WRITE_ALLOWANCE must be between 1 and 50000');
  if (limit > 90_000) throw new Error('COOP_ACCOUNT_WRITE_LIMIT cannot exceed 90000');
  if (reserve > limit) throw new Error('COOP_SHARED_WRITE_RESERVE cannot exceed COOP_ACCOUNT_WRITE_LIMIT');
  return { allowed: used + allowance + reserve <= limit, used, allowance, reserve, limit };
}

export async function readDailyD1Writes(env: NodeJS.ProcessEnv, fetcher: typeof fetch = fetch, now = new Date()): Promise<number> {
  const account = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const token = env.CLOUDFLARE_API_TOKEN?.trim();
  if (!account || !token) throw new Error('Missing Cloudflare account settings for quota verification');

  const query = 'query($account:String!,$since:Time!,$until:Time!){viewer{accounts(filter:{accountTag:$account}){d1AnalyticsAdaptiveGroups(limit:100,filter:{datetime_geq:$since,datetime_leq:$until}){sum{rowsWritten}}}}}';
  const response = await fetcher('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: {
      account,
      since: `${now.toISOString().slice(0, 10)}T00:00:00Z`,
      until: now.toISOString(),
    } }),
    signal: AbortSignal.timeout(20_000),
  });
  let analytics: {
    errors?: unknown[] | null;
    data?: { viewer?: { accounts?: { d1AnalyticsAdaptiveGroups?: { sum?: { rowsWritten?: unknown } }[] }[] } };
  };
  try { analytics = await response.json() as typeof analytics; }
  catch { throw new Error('Shared D1 write quota could not be verified; Coop refresh deferred'); }
  if (!analytics || typeof analytics !== 'object' || !response.ok
    || analytics.errors != null && (!Array.isArray(analytics.errors) || analytics.errors.length > 0)) {
    throw new Error('Shared D1 write quota could not be verified; Coop refresh deferred');
  }
  const accounts = analytics.data?.viewer?.accounts;
  if (!Array.isArray(accounts) || !accounts.length
    || accounts.some(item => !item || typeof item !== 'object' || Array.isArray(item))) {
    throw new Error('Shared D1 write quota could not be verified; Coop refresh deferred');
  }
  const groups = accounts.flatMap(item => {
    if (!Array.isArray(item.d1AnalyticsAdaptiveGroups)) throw new Error('Shared D1 write quota could not be verified; Coop refresh deferred');
    return item.d1AnalyticsAdaptiveGroups;
  });
  let total = 0;
  for (const group of groups) {
    const value = group?.sum?.rowsWritten;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new Error('Cloudflare returned invalid D1 write quota data; Coop refresh deferred');
    }
    total += value;
    if (!Number.isSafeInteger(total)) throw new Error('Cloudflare returned invalid D1 write quota data; Coop refresh deferred');
  }
  return total;
}

export async function main(env: NodeJS.ProcessEnv = process.env, fetcher: typeof fetch = fetch) {
  const allowance = Number(env.COOP_WRITE_ALLOWANCE);
  const reserve = Number(env.COOP_SHARED_WRITE_RESERVE ?? 10_000);
  const limit = Number(env.COOP_ACCOUNT_WRITE_LIMIT ?? 90_000);
  const used = await readDailyD1Writes(env, fetcher);
  const decision = decideQuota(used, allowance, reserve, limit);
  if (env.GITHUB_OUTPUT) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(env.GITHUB_OUTPUT, `allowed=${decision.allowed}\n`);
  }
  if (env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(env.GITHUB_STEP_SUMMARY,
      `Coop daily refresh quota preflight: ${decision.allowed ? 'allowed' : 'deferred'}; ${used} D1 writes used today, ${allowance} allowance requested, ${reserve} reserved for shared jobs (limit ${limit}).\n`);
  }
  console.log(decision.allowed
    ? `Shared D1 quota permits Coop refresh (${used} used, ${allowance} allowance, ${reserve} reserved).`
    : `Coop refresh deferred to preserve shared D1 quota (${used} used, ${allowance} allowance, ${reserve} reserved, ${limit} limit).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : 'Shared D1 quota could not be verified; Coop refresh deferred');
    process.exitCode = 1;
  });
}
