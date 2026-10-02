import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectCloudflare } from '../scripts/connect.ts';
import { connectGitHub } from '../scripts/connect-github.ts';
import { ensureGitHubAccount } from '../scripts/github-account.ts';
import { fingerprint, savedAnswers, SetupProgress } from '../scripts/setup-progress.ts';
import { command } from '../scripts/helpers.ts';

const quiet = () => {};
function temporary() {
  const folder = mkdtempSync(join(tmpdir(), 'willys-setup-test-'));
  return { file: join(folder, 'progress.json'), close: () => rmSync(folder, { recursive: true, force: true }) };
}
const accountId = 'a'.repeat(32), databaseId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const cloudflareEnv = () => ({ CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_DATABASE_ID: databaseId,
  CLOUDFLARE_API_TOKEN: 'test-cloudflare-token', CATALOG_API_TOKEN: 'test-catalogue-token-more-than-thirty-two', CATALOG_API_URL: 'https://catalogue.test.workers.dev', WILLYS_STORE_ID: '2110' });

test('progress survives a restart, retries only failures, and keeps secrets out of its file', async () => {
  const temp = temporary();
  try {
    const key = fingerprint('test-only-secret'); let finished = 0, failed = 0;
    const progress = new SetupProgress(temp.file, quiet);
    await progress.run('completed step', key, async () => { finished++; });
    await assert.rejects(progress.run('failed step', key, async () => { failed++; throw new Error('interrupted'); }), /interrupted/);
    const resumed = new SetupProgress(temp.file, quiet);
    await resumed.run('completed step', key, async () => { finished++; });
    await resumed.run('failed step', key, async () => { failed++; });
    assert.equal(finished, 1); assert.equal(failed, 2);
    assert.ok(!readFileSync(temp.file, 'utf8').includes('test-only-secret'));
    assert.equal(statSync(temp.file).mode & 0o777, 0o600);
    await resumed.run('completed step', fingerprint('changed-setting'), async () => { finished++; });
    assert.equal(finished, 2);
  } finally { temp.close(); }
});

test('answers are saved individually before a later input is cancelled', async () => {
  const env: NodeJS.ProcessEnv = {}, disk: Record<string, string> = {};
  let prompted = 0;
  const save = (updates: Record<string, string>) => Object.assign(disk, updates);
  const first = savedAnswers({ env, save, ask: async () => { prompted++; return 'addeqe/secretlol'; }, hidden: async () => { throw new Error('cancelled'); } });
  await first.value('GITHUB_REPOSITORY', 'repository', v => v.includes('/'));
  await assert.rejects(first.secret('GITHUB_DISPATCH_TOKEN', 'trigger token'), /cancelled/);
  assert.equal(disk.GITHUB_REPOSITORY, 'addeqe/secretlol');
  const resumed = savedAnswers({ env: { ...disk }, save, ask: async () => { prompted++; throw new Error('should not repeat'); }, hidden: async () => 'test-token' });
  assert.equal(await resumed.value('GITHUB_REPOSITORY', 'repository', v => v.includes('/')), 'addeqe/secretlol');
  assert.equal(await resumed.secret('GITHUB_DISPATCH_TOKEN', 'trigger token'), 'test-token');
  assert.equal(prompted, 1);
});

test('the already completed Cloudflare setup from the original wizard is adopted without prompts or remote writes', async () => {
  const temp = temporary();
  try {
    const fail = () => { throw new Error('Cloudflare should not run again'); };
    const env: NodeJS.ProcessEnv = cloudflareEnv();
    const io = { env, save: (updates: Record<string, string>) => { Object.assign(env, updates); }, ask: fail, hidden: fail, cloudflare: fail, query: fail, deploy: fail, log: quiet };
    await connectCloudflare(new SetupProgress(temp.file, quiet), io);
    await connectCloudflare(new SetupProgress(temp.file, quiet), io);
  } finally { temp.close(); }
});

test('a failed Cloudflare deployment preserves inputs, the created database and applied schema', async () => {
  const temp = temporary();
  try {
    const env: NodeJS.ProcessEnv = {}; let prompts = 0, secrets = 0, creates = 0, schemas = 0, deployments = 0, addresses = 0;
    const io = { env, log: quiet, save: (updates: Record<string, string>) => { Object.assign(env, updates); },
      ask: async (label: string) => { prompts++; return label.startsWith('Confirm') ? 'free' : label.includes('account ID') ? accountId : '2110'; },
      hidden: async () => { secrets++; return 'test-cloudflare-token'; },
      cloudflare: async (path: string, method = 'GET') => {
        if (path.endsWith('/subdomain')) { addresses++; return { subdomain: 'already-registered' }; }
        if (method === 'GET') return [];
        creates++; return { uuid: databaseId };
      }, query: async () => { schemas++; }, deploy: async () => {
        deployments++; if (deployments === 1) throw new Error('deploy failed');
        env.CATALOG_API_URL = 'https://catalogue.test.workers.dev';
      } };
    await assert.rejects(connectCloudflare(new SetupProgress(temp.file, quiet), io), /deploy failed/);
    await connectCloudflare(new SetupProgress(temp.file, quiet), io);
    assert.equal(prompts, 3); assert.equal(secrets, 1); assert.equal(creates, 1); assert.equal(schemas, 1);
    assert.equal(addresses, 1); assert.equal(deployments, 2);
  } finally { temp.close(); }
});

function accountCommands(loginWorks = true, cached = true) {
  let active = 'addefrr'; const calls: string[] = [];
  const run: typeof command = (_binary, args) => {
    calls.push(args.join(' '));
    if (args.join(' ') === 'api user --jq .login') return active;
    if (args.includes('--include')) return 'x-oauth-scopes: repo, workflow\n';
    if (args[0] === 'auth' && args[1] === 'switch') { if (!cached) throw new Error('not signed in'); active = 'addeqe'; }
    if (args[0] === 'auth' && args[1] === 'login' && loginWorks) active = 'addeqe';
    return '';
  };
  return { run, calls };
}

test('the selected GitHub account is switched before any repository operations', () => {
  const mock = accountCommands();
  ensureGitHubAccount('addeqe', { command: mock.run, log: quiet, env: {} });
  assert.ok(mock.calls.includes('auth switch --hostname github.com --user addeqe'));
  assert.ok(!mock.calls.some(call => call.startsWith('auth login')));
});

test('an uncached GitHub account opens login, then verifies the resulting identity', () => {
  const success = accountCommands(true, false);
  ensureGitHubAccount('addeqe', { command: success.run, log: quiet, env: {} });
  assert.ok(success.calls.some(call => call.startsWith('auth login')));
  const wrong = accountCommands(false, false);
  assert.throws(() => ensureGitHubAccount('addeqe', { command: wrong.run, log: quiet, env: {} }), /signed in as addefrr/);
});

test('an overriding GitHub environment token cannot silently select the other account', () => {
  const mock = accountCommands();
  assert.throws(() => ensureGitHubAccount('addeqe', { command: mock.run, log: quiet, env: { GH_TOKEN: 'test-wrong-account-token' } }), /overriding/);
  assert.ok(!mock.calls.some(call => call.startsWith('auth switch') || call.startsWith('auth login')));
});

test('GitHub resumes after a secret-upload failure without recreating the repo, pushing again or reasking answers', async () => {
  const temp = temporary();
  try {
    const env: NodeJS.ProcessEnv = { ...cloudflareEnv(), GITHUB_REPOSITORY: 'addeqe/secretlol', GITHUB_ACCOUNT: 'addeqe', GITHUB_VISIBILITY: 'public' };
    const calls: string[] = []; let active = 'addefrr', remote = '', failSecret = true, deployments = 0, hiddenPrompts = 0, fetches = 0;
    const io = { env, log: quiet, save: (updates: Record<string, string>) => { Object.assign(env, updates); },
      ask: async () => { throw new Error('No saved answer should be asked again'); }, hidden: async () => { hiddenPrompts++; return 'test-github-token'; },
      wait: async () => {}, deploy: async () => { deployments++; },
      fetch: (async (_url: unknown, options?: RequestInit) => { fetches++; return options?.method === 'POST' ? new Response(null, { status: 204 }) : Response.json({}); }) as typeof fetch,
      command: ((_binary, args) => {
        const call = args.join(' '); calls.push(call);
        if (call === 'api user --jq .login') return active;
        if (args.includes('--include')) return 'x-oauth-scopes: repo, workflow\n';
        if (call.startsWith('auth switch')) { active = 'addeqe'; return ''; }
        if (call.startsWith('repo view')) throw new Error('not created yet');
        if (call.startsWith('repo create')) { assert.equal(active, 'addeqe'); return ''; }
        if (call.startsWith('config user.')) return 'Test author';
        if (call === 'remote get-url origin') { if (!remote) throw new Error('no remote'); return remote; }
        if (call.startsWith('remote add origin')) remote = args[3];
        if (call === 'rev-parse HEAD') return 'same-test-commit';
        if (call.startsWith('secret set CLOUDFLARE_DATABASE_ID') && failSecret) { failSecret = false; throw new Error('secret upload interrupted'); }
        return '';
      }) as typeof command };
    await assert.rejects(connectGitHub(new SetupProgress(temp.file, quiet), io), /secret upload interrupted/);
    await connectGitHub(new SetupProgress(temp.file, quiet), io);
    await connectGitHub(new SetupProgress(temp.file, quiet), io);
    assert.equal(calls.filter(call => call.startsWith('repo create')).length, 1);
    assert.equal(calls.filter(call => call.startsWith('push ')).length, 1);
    assert.equal(calls.filter(call => call.startsWith('secret set CLOUDFLARE_ACCOUNT_ID')).length, 1);
    assert.equal(calls.filter(call => call.startsWith('secret set CLOUDFLARE_DATABASE_ID')).length, 2);
    assert.equal(hiddenPrompts, 1); assert.equal(deployments, 1); assert.equal(fetches, 2);
  } finally { temp.close(); }
});
