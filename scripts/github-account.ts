import { command } from './helpers.ts';

export function ensureGitHubAccount(account: string, options: { command?: typeof command; log?: (message: string) => void; env?: NodeJS.ProcessEnv } = {}) {
  const run = options.command ?? command, log = options.log ?? console.log, env = options.env ?? process.env;
  const current = () => { try { return run('gh', ['api', 'user', '--jq', '.login'], { capture: true }).trim(); } catch { return ''; } };
  let active = current();
  if (active.toLowerCase() !== account.toLowerCase()) {
    if (env.GH_TOKEN || env.GITHUB_TOKEN) throw new Error(`An environment token is overriding GitHub login${active ? ` as ${active}` : ''}. Unset GH_TOKEN/GITHUB_TOKEN in this terminal or provide a token for ${account}, then rerun npm run connect.`);
    log(`This setup needs GitHub account ${account}${active ? `; the active account is ${active}` : ''}.`);
    try { run('gh', ['auth', 'switch', '--hostname', 'github.com', '--user', account], { capture: true }); }
    catch {
      log(`Sign in as ${account} in the browser. If another account is shown, switch accounts there before authorizing GitHub CLI.`);
      run('gh', ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web', '--scopes', 'workflow']);
    }
    active = current();
  }
  if (active.toLowerCase() !== account.toLowerCase()) throw new Error(`GitHub signed in as ${active || 'no account'}, but this setup requires ${account}. Completed steps are saved. Sign in to ${account} and rerun npm run connect.`);
  log(`Using GitHub account ${active}.`);
  const authHeaders = run('gh', ['api', 'user', '--include'], { capture: true });
  const scopeHeader = /^x-oauth-scopes:[ \t]*(.*)$/im.exec(authHeaders);
  if (scopeHeader && !scopeHeader[1].split(',').map(scope => scope.trim()).includes('workflow')) {
    log('GitHub needs the workflow permission to push the included Actions files.');
    run('gh', ['auth', 'refresh', '--hostname', 'github.com', '--scopes', 'workflow']);
  }
}
