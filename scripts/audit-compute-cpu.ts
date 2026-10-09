import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadEnv, required } from '../src/config.ts';

type MetricResult<T> = { available: boolean; reason: string | null; groups: T[] };
loadEnv();

async function graphQL<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST', headers: { Authorization: `Bearer ${required('CLOUDFLARE_API_TOKEN')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(20000),
  });
  const result = await response.json() as any;
  if (!response.ok || result.errors?.length || !result.data?.viewer?.accounts?.length) throw new Error('analytics_unavailable');
  return result.data.viewer.accounts;
}

async function namespaces(): Promise<{ id: string; className: string; scriptName: string } | null> {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${required('CLOUDFLARE_ACCOUNT_ID')}/workers/durable_objects/namespaces`, {
    headers: { Authorization: `Bearer ${required('CLOUDFLARE_API_TOKEN')}` }, signal: AbortSignal.timeout(20000),
  });
  const result = await response.json() as any;
  if (!response.ok || !Array.isArray(result.result)) return null;
  const found = result.result.find((entry: any) => entry.class === 'MealCompute' && entry.script === 'willys-catalog');
  return found && typeof found.id === 'string' ? { id: found.id, className: found.class, scriptName: found.script } : null;
}

try {
  const { values } = parseArgs({ options: {
    input: { type: 'string' }, output: { type: 'string' }, budget: { type: 'string', default: '200' },
  } });
  if (!values.input || !values.output) throw new Error('Supply --input API-probe.json --output compute-CPU-report.json');
  const probe = JSON.parse(readFileSync(values.input, 'utf8'));
  const start = Date.parse(probe.startedAt), end = Date.parse(probe.finishedAt), budget = Number(values.budget);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end - start > 3600000
    || !Number.isFinite(budget) || budget <= 0 || budget >= 30000) throw new Error('Invalid probe window or Durable Object CPU budget');
  const variables = { accountTag: required('CLOUDFLARE_ACCOUNT_ID'),
    start: new Date(Math.floor(start / 1000) * 1000).toISOString(),
    end: new Date(Math.ceil(end / 1000) * 1000 + 1000).toISOString() };
  // Periodic samples do not correspond one-to-one with incoming requests.
  // Include adjacent minutes and report that larger attribution window explicitly.
  const periodicWindow = {
    start: new Date(Math.floor(start / 60000) * 60000 - 60000).toISOString(),
    end: new Date(Math.ceil(end / 60000) * 60000 + 60000).toISOString(),
  };
  const ns = await namespaces();
  let invocations: MetricResult<any> = { available: false, reason: 'namespace_unavailable', groups: [] };
  let periodic: MetricResult<any> = { available: false, reason: 'namespace_unavailable', groups: [] };
  if (ns) {
    const namespaceVariables = { ...variables, namespaceId: ns.id };
    const invocationQuery = `query($accountTag:String!,$start:Time!,$end:Time!,$namespaceId:String!){viewer{accounts(filter:{accountTag:$accountTag}){
      durableObjectsInvocationsAdaptiveGroups(limit:1000,filter:{namespaceId:$namespaceId,datetime_geq:$start,datetime_leq:$end}){
        avg{sampleInterval}sum{requests errors}quantiles{cpuTimeP50 cpuTimeP99 wallTimeP50 wallTimeP99}dimensions{name namespaceId datetime status type}}}}}`;
    try {
      const accounts = await graphQL<any[]>(invocationQuery, namespaceVariables);
      const groups = accounts.flatMap(a => a.durableObjectsInvocationsAdaptiveGroups ?? []);
      const valid = groups.filter((g: any) => Number.isSafeInteger(g.sum?.requests) && Number.isSafeInteger(g.sum?.errors));
      invocations = valid.length ? { available: true, reason: null, groups: valid } : { available: false, reason: 'no_invocation_sample', groups: [] };
    } catch { invocations = { available: false, reason: 'invocation_analytics_unavailable', groups: [] }; }

    const periodicQuery = `query($accountTag:String!,$start:Time!,$end:Time!,$namespaceId:String!){viewer{accounts(filter:{accountTag:$accountTag}){
      durableObjectsPeriodicGroups(limit:1000,filter:{namespaceId:$namespaceId,datetime_geq:$start,datetime_leq:$end}){
        avg{sampleInterval}count sum{cpuTime activeTime duration subrequests rowsRead rowsWritten}dimensions{name namespaceId datetime}}}}}`;
    try {
      const accounts = await graphQL<any[]>(periodicQuery, {...namespaceVariables,...periodicWindow});
      const groups = accounts.flatMap(a => a.durableObjectsPeriodicGroups ?? []);
      const valid = groups.filter((g: any) => [g.sum?.cpuTime, g.sum?.activeTime, g.sum?.duration].every((v: unknown) => typeof v === 'number' && Number.isFinite(v)));
      periodic = valid.length ? { available: true, reason: null, groups: valid } : { available: false, reason: 'no_periodic_sample', groups: [] };
    } catch { periodic = { available: false, reason: 'periodic_analytics_unavailable', groups: [] }; }
  }

  const invocationGroups = invocations.groups;
  const periodicGroups = periodic.groups;
  const p99Values = invocationGroups.map((g: any) => g.quantiles?.cpuTimeP99).filter((v: unknown): v is number => typeof v === 'number' && Number.isFinite(v));
  const p50Values = invocationGroups.map((g: any) => g.quantiles?.cpuTimeP50).filter((v: unknown): v is number => typeof v === 'number' && Number.isFinite(v));
  const requests = invocationGroups.reduce((n: number, g: any) => n + g.sum.requests, 0);
  const errors = invocationGroups.reduce((n: number, g: any) => n + g.sum.errors, 0);
  // Successful authenticated API routes dispatch once; /health stays in the gateway.
  const expectedRequests = Array.isArray(probe.checks) ? probe.checks.filter((check:any)=>
    check.status>=200 && check.status<300 && check.path?.split('?')[0]!=='/health').length : null;
  const coverageComplete = expectedRequests === null || requests >= expectedRequests;
  const maxBucketCpuP99Ms = p99Values.length ? Math.max(...p99Values) / 1000 : null;
  const maxBucketCpuP50Ms = p50Values.length ? Math.max(...p50Values) / 1000 : null;
  const completeCpu = invocationGroups.length>0 && p99Values.length===invocationGroups.length
    && p50Values.length===invocationGroups.length;
  const passed = coverageComplete && completeCpu && periodic.available && maxBucketCpuP99Ms !== null
    && requests > 0 && errors === 0 && maxBucketCpuP99Ms <= budget;
  const optionalTotal=(key:string)=>periodicGroups.length&&periodicGroups.every((g:any)=>typeof g.sum[key]==='number'&&Number.isFinite(g.sum[key]))
    ?periodicGroups.reduce((n:number,g:any)=>n+g.sum[key],0):null;
  const report = {
    checkedAt: new Date().toISOString(), workerVersion: probe.workerVersion ?? null,
    windowStart: variables.start, windowEnd: variables.end,
    periodicWindowStart: periodicWindow.start, periodicWindowEnd: periodicWindow.end,
    durableObject: ns ? { className: ns.className, scriptName: ns.scriptName, namespaceId: ns.id } : null,
    namespaceLookupAvailable: !!ns,
    budgetMs: budget, rawCpuUnit: 'microseconds', sampled: true,
    maxBucketCpuP50Ms, maxBucketCpuP99Ms, requests: invocations.available ? requests : null,
    errors: invocations.available ? errors : null,
    expectedRequests, coverageComplete,
    invocationMetrics: invocations,
    periodicMetrics: periodic,
    periodicTotals: periodic.available ? {
      cpuTimeMs: periodicGroups.reduce((n: number, g: any) => n + g.sum.cpuTime, 0) / 1000,
      activeTimeMs: periodicGroups.reduce((n: number, g: any) => n + g.sum.activeTime, 0) / 1000,
      durationGBSeconds: periodicGroups.reduce((n: number, g: any) => n + g.sum.duration, 0),
      subrequests: optionalTotal('subrequests'),
      rowsRead: optionalTotal('rowsRead'),
      rowsWritten: optionalTotal('rowsWritten'),
    } : null,
    passed,
    limitations: ['Invocation metrics use adaptive sampling; inspect sampleInterval and per-bucket groups.',
      'P99 is the maximum reported bucket percentile, not a pooled percentile across all shards.',
      'Analytics are namespace-level, not request-ID or route attributed; the short probe window is the attribution boundary.',
      'Periodic totals use an expanded adjacent-minute window and can include neighbouring traffic; they are not exact per-probe costs.',
      'Missing invocation CPU or periodic metrics are reported as null/unavailable and do not pass the audit.'],
  };
  writeFileSync(values.output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed, maxBucketCpuP99Ms, budgetMs: budget, requests: report.requests,
    expectedRequests, coverageComplete,
    errors: report.errors, durationGBSeconds: report.periodicTotals?.durationGBSeconds ?? null,
    invocationReason: invocations.reason, periodicReason: periodic.reason }));
  if (!passed || !periodic.available) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Durable Object CPU audit failed'); process.exitCode = 2;
}
