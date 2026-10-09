import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadEnv, required } from '../src/config.ts';

loadEnv();
try {
  const { values } = parseArgs({ options: {
    input: { type: 'string' }, output: { type: 'string' }, budget: { type: 'string', default: '8' },
  } });
  if (!values.input || !values.output) throw new Error('Supply --input API-probe.json --output CPU-report.json; wait for analytics ingestion first');
  const probe = JSON.parse(readFileSync(values.input, 'utf8'));
  const start = Date.parse(probe.startedAt), end = Date.parse(probe.finishedAt), budget = Number(values.budget);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end - start > 3600000
    || !Number.isFinite(budget) || budget <= 0 || budget > 10) throw new Error('Invalid probe window or Free CPU budget');
  const variables = { accountTag: required('CLOUDFLARE_ACCOUNT_ID'),
    start: new Date(Math.floor(start / 1000) * 1000).toISOString(),
    end: new Date(Math.ceil(end / 1000) * 1000 + 1000).toISOString(), scriptName: 'willys-catalog' };
  const query = `query($accountTag:String!,$start:Time!,$end:Time!,$scriptName:String!){viewer{accounts(filter:{accountTag:$accountTag}){
    workersInvocationsAdaptive(limit:1000,filter:{scriptName:$scriptName,datetime_geq:$start,datetime_leq:$end}){
      sum{requests errors}quantiles{cpuTimeP50 cpuTimeP99}dimensions{datetime status}}}}}`;
  const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST', headers: { Authorization: `Bearer ${required('CLOUDFLARE_API_TOKEN')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(20000),
  });
  const result = await response.json() as any;
  if (!response.ok || result.errors?.length || !result.data?.viewer?.accounts?.length) throw new Error('Worker CPU analytics unavailable');
  const groups = result.data.viewer.accounts.flatMap((a: any) => a.workersInvocationsAdaptive);
  if (!Array.isArray(groups) || !groups.length || groups.some((g: any) => !Number.isFinite(g.quantiles?.cpuTimeP99)
    || !Number.isFinite(g.quantiles?.cpuTimeP50) || !Number.isSafeInteger(g.sum?.requests) || !Number.isSafeInteger(g.sum?.errors)))
    throw new Error('No valid CPU sample yet; retry after analytics ingestion');
  const maxBucketP99Ms = Math.max(...groups.map((g: any) => g.quantiles.cpuTimeP99)) / 1000;
  const errors = groups.reduce((n: number, g: any) => n + g.sum.errors, 0);
  const sampledRequests = groups.reduce((n: number, g: any) => n + g.sum.requests, 0);
  const expectedRequests = Array.isArray(probe.checks) ? probe.checks.length : null;
  const coverageComplete = expectedRequests === null || sampledRequests >= expectedRequests;
  const report = { checkedAt: new Date().toISOString(), workerVersion: probe.workerVersion ?? null,
    windowStart: variables.start, windowEnd: variables.end, rawCpuUnit: 'microseconds', sampled: true,
    routeAttribution: false, budgetMs: budget, maxBucketP99Ms, errors,
    sampledRequests, expectedRequests, coverageComplete,
    passed: coverageComplete && maxBucketP99Ms <= budget && errors === 0, groups,
    limitations: ['Adaptive samples can omit requests.', 'Time buckets do not prove endpoint or version attribution.',
      'This regression probe is evidence for the measured workload, not a guarantee for all future requests.'] };
  writeFileSync(values.output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, maxBucketP99Ms, budgetMs: budget, sampledRequests, expectedRequests, coverageComplete, errors }));
  if (!report.passed) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Worker CPU audit failed'); process.exitCode = 2;
}
