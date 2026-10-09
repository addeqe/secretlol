import { authorized, handle as serviceHandle, type Env as ServiceEnv } from './service.ts';
import { computeShard } from './compute-shard.ts';
import { requestFailure } from './http-errors.ts';
export { expiresAt, packPrice } from './service.ts';
export { MealCompute } from './meal-compute.ts';
export type Env = ServiceEnv & { MEAL_COMPUTE?: DurableObjectNamespace };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
} });

/** The public gateway authenticates and streams; data processing runs separately. */
export async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/health' && request.method === 'GET') return json({service:'willys-catalog',ok:true});
  if (!env.CATALOG_API_TOKEN || env.CATALOG_API_TOKEN.length < 32) return json({error:'service_not_connected'},503);
  const reviewRoute = ['/ingredients/review','/ingredients/refresh'].includes(url.pathname);
  if (reviewRoute && (!env.INGREDIENT_REVIEW_TOKEN || env.INGREDIENT_REVIEW_TOKEN.length < 32)) return json({error:'review_not_connected'},503);
  if (!authorized(request,reviewRoute ? env.INGREDIENT_REVIEW_TOKEN! : env.CATALOG_API_TOKEN)) return json({error:'unauthorized'},401);
  // Compatibility for local callers and databases deployed before this binding.
  if (!env.MEAL_COMPUTE) return serviceHandle(request,env);
  const id = env.MEAL_COMPUTE.idFromName(await computeShard(request));
  return env.MEAL_COMPUTE.get(id).fetch(request);
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env) {
    if (!env.GITHUB_REPOSITORY || !/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY) || !env.GITHUB_DISPATCH_TOKEN) {
      throw new Error('Daily sync is not connected to GitHub. Run npm run connect:github.');
    }
    const response = await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/workflows/sync.yml/dispatches`, {
      method: 'POST', headers: { Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
        Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'WillysCatalog', 'X-GitHub-Api-Version': '2022-11-28' },
      body: JSON.stringify({ ref: 'main' }), signal: AbortSignal.timeout(20000)
    });
    if (!response.ok) throw new Error(`GitHub daily sync dispatch failed (HTTP ${response.status}). Check token/repository/workflow.`);
  },
  async fetch(request: Request, env: Env) {
    try { return await handle(request,env); }
    catch (error) { return requestFailure(error); }
  },
};
