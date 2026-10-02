import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnv } from '../src/config.ts';
import { ask, command, hidden, saveEnv } from './helpers.ts';
import { deploy } from './deploy.ts';
import { ensureGitHubAccount } from './github-account.ts';
import { deploymentSource, fingerprint, savedAnswers, SetupProgress } from './setup-progress.ts';

type GitHubIO = { env: NodeJS.ProcessEnv; ask: typeof ask; hidden: typeof hidden; save: typeof saveEnv;
  command: typeof command; fetch: typeof fetch; deploy: () => Promise<unknown>; log: (message: string) => void;
  wait: (ms: number) => Promise<void> };
export async function connectGitHub(progress = new SetupProgress(), options: Partial<GitHubIO> = {}) {
  if (!options.env) loadEnv();
  const io: GitHubIO = { env: process.env, ask, hidden, save: saveEnv, command, fetch, deploy, log: console.log,
    wait: ms => new Promise(resolveWait => setTimeout(resolveWait, ms)), ...options };
  const answers = savedAnswers(io), run = io.command;
  const repository = await answers.value('GITHUB_REPOSITORY', 'GitHub repository (owner/name)', value => /^[\w.-]+\/[\w.-]+$/.test(value));
  const owner = repository.split('/')[0];
  const account = io.env.GITHUB_ACCOUNT || owner;
  if (!/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(account)) throw new Error('Invalid GitHub account username. Update GITHUB_ACCOUNT in .env.');
  if (!io.env.GITHUB_ACCOUNT) { io.save({ GITHUB_ACCOUNT: account }); io.env.GITHUB_ACCOUNT = account; }
  ensureGitHubAccount(account, { command: run, log: io.log, env: io.env });
  if (account.toLowerCase() !== owner.toLowerCase() && run('gh', ['api', `users/${owner}`, '--jq', '.type'], { capture: true }).trim() !== 'Organization') {
    throw new Error(`Repository owner ${owner} differs from your selected GitHub account ${account}. Update GITHUB_REPOSITORY or GITHUB_ACCOUNT in .env before continuing.`);
  }
  await progress.run('GitHub repository', fingerprint(repository, account), async () => {
    let existing = false;
    try { run('gh', ['repo', 'view', repository], { capture: true }); existing = true; } catch {}
    if (!existing) {
      io.log('A public repository uses free standard Actions minutes. Catalogue exports and local secrets are excluded from Git.');
      const visibility = await answers.value('GITHUB_VISIBILITY', 'Visibility for the new repository: public or private', v => ['public', 'private'].includes(v), 'public');
      run('gh', ['repo', 'create', repository, `--${visibility}`, '--description', 'Daily Willys online catalogue and price database']);
    } else {
      const remoteSize = Number(run('gh', ['api', `repos/${repository}`, '--jq', '.size'], { capture: true }).trim());
      if (remoteSize > 0 && !existsSync('.git')) throw new Error('That repository contains files. Choose a new empty repository to avoid replacing existing work.');
    }
  });
  if (!existsSync('.git')) run('git', ['init', '-b', 'main']);
  for (const field of ['name', 'email']) {
    try { run('git', ['config', `user.${field}`], { capture: true }); }
    catch {
      const value = await answers.value(`GIT_AUTHOR_${field.toUpperCase()}`, `Git commit author ${field}`, v => !!v.trim());
      run('git', ['config', `user.${field}`, value]);
    }
  }
  const target = `https://github.com/${repository}.git`;
  let remote = '';
  try { remote = run('git', ['remote', 'get-url', 'origin'], { capture: true }).trim(); } catch {}
  if (remote && remote !== target) throw new Error('This folder already has a different Git origin. Choose that repository or use a fresh copy.');
  if (!remote) run('git', ['remote', 'add', 'origin', target]);
  run('gh', ['auth', 'setup-git']);
  run('git', ['add', '.']);
  if (run('git', ['status', '--porcelain'], { capture: true }).trim()) run('git', ['commit', '-m', 'Set up free Willys catalogue sync']);
  const head = run('git', ['rev-parse', 'HEAD'], { capture: true }).trim();
  await progress.run('GitHub code upload', fingerprint(repository, head), () => { run('git', ['push', '-u', 'origin', 'main']); });
  for (const name of ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_DATABASE_ID', 'CLOUDFLARE_API_TOKEN']) {
    const value = io.env[name]?.trim();
    if (!value) throw new Error(`Missing ${name}. Finish Cloudflare setup first; previous GitHub steps are saved.`);
    await progress.run(`GitHub secret ${name}`, fingerprint(repository, value), () => { run('gh', ['secret', 'set', name, '--repo', repository], { input: value }); });
  }
  const selectedStore = io.env.WILLYS_STORE_ID || '2110';
  await progress.run('GitHub store selection', fingerprint(repository, selectedStore), () => { run('gh', ['variable', 'set', 'WILLYS_STORE_ID', '--repo', repository, '--body', selectedStore]); });
  if (!io.env.GITHUB_DISPATCH_TOKEN) io.log(`Create a fine-grained token while signed in as ${account}: https://github.com/settings/personal-access-tokens/new\nSelect only ${repository}, with repository Actions: Read and write. Record its expiry date.`);
  const dispatchToken = await answers.secret('GITHUB_DISPATCH_TOKEN', 'GitHub daily-trigger token');
  await progress.run('GitHub trigger verification', fingerprint(repository, dispatchToken), async () => {
    const workflowUrl = `https://api.github.com/repos/${repository}/actions/workflows/sync.yml`;
    const headers = { Authorization: `Bearer ${dispatchToken}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    let check = await io.fetch(workflowUrl, { headers, signal: AbortSignal.timeout(15000) });
    for (let attempt = 0; check.status === 404 && attempt < 6; attempt++) {
      await io.wait(5000); check = await io.fetch(workflowUrl, { headers, signal: AbortSignal.timeout(15000) });
    }
    const invalidToken = () => { io.save({ GITHUB_DISPATCH_TOKEN: '' }); io.env.GITHUB_DISPATCH_TOKEN = ''; };
    if (!check.ok) {
      if (check.status === 401 || check.status === 403) invalidToken();
      throw new Error(`GitHub token cannot access the workflow (HTTP ${check.status}). Check the selected repository and Actions permission. Previous steps are saved.`);
    }
    const dispatched = await io.fetch(`${workflowUrl}/dispatches`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'main', inputs: { connection_check: 'true' } }), signal: AbortSignal.timeout(15000)
    });
    if (!dispatched.ok) {
      if (dispatched.status === 401 || dispatched.status === 403) invalidToken();
      throw new Error(`GitHub token cannot start the workflow (HTTP ${dispatched.status}). Grant Actions: Read and write. Previous steps are saved.`);
    }
  });
  await progress.run('Daily refresh deployment', fingerprint(repository, dispatchToken, io.env.CLOUDFLARE_ACCOUNT_ID,
    io.env.CLOUDFLARE_DATABASE_ID, io.env.CATALOG_API_TOKEN, deploymentSource()), io.deploy);
  io.log(`Daily refresh connected for 04:17 UTC. Workflow: https://github.com/${repository}/actions/workflows/sync.yml\nCheck the connection-only job in Actions. It makes no retailer requests.\nThe next scheduled morning will collect the catalogue; run it manually inside the crawl window if needed.`);
}
if (process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`) {
  try { await connectGitHub(); }
  catch (error) { console.error(error instanceof Error ? error.message : 'GitHub connection failed'); console.error('Completed steps and valid answers are saved. Run npm run connect:github to resume.'); process.exitCode = 1; }
}
