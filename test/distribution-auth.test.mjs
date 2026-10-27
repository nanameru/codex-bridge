import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createRouter } from '../src/model-router.mjs';
import { authenticateCodex, diagnoseCodexAuth, readCodexAuth } from '../src/local-security.mjs';

function fixture(t, config = '') {
  const root = mkdtempSync(join(tmpdir(), 'distribution-auth-'));
  if (config) writeFileSync(join(root, 'config.toml'), config, { mode: 0o600 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
const token = value => ({ tokens: { access_token: value } });
const saved = (root, value) => writeFileSync(join(root, 'auth.json'), JSON.stringify(token(value)), { mode: 0o600 });
const keychain = value => ({ platform: 'darwin', keychainRead: () => JSON.stringify(token(value)) });

test('different recipient homes authenticate only their own credentials', t => {
  const one = fixture(t), two = fixture(t);
  saved(one, 'recipient-one'); saved(two, 'recipient-two');
  const req = value => ({ headers: { authorization: `Bearer ${value}` } });
  assert.equal(authenticateCodex(req('recipient-one'), one), true);
  assert.equal(authenticateCodex(req('recipient-one'), two), false);
  assert.equal(authenticateCodex(req('recipient-two'), two), true);
});

test('explicit Keychain mode uses the canonical CODEX_HOME account and ignores stale files', t => {
  const root = fixture(t, "cli_auth_credentials_store = 'keyring' # supported\n");
  saved(root, 'stale-file');
  const calls = [];
  const result = readCodexAuth(root, { platform: 'darwin', keychainRead: (...args) => {
    calls.push(args); return JSON.stringify(token('keychain-current'));
  } });
  assert.equal(result.auth.tokens.access_token, 'keychain-current');
  assert.equal(result.store, 'keyring');
  assert.deepEqual(calls, [['Codex Auth', 'cli|' + createHash('sha256').update(realpathSync(root)).digest('hex').slice(0, 16)]]);
});

test('auto prefers Keychain and falls back to private file; file mode never reads Keychain', t => {
  const root = fixture(t, 'cli_auth_credentials_store = "auto"\n');
  saved(root, 'fallback');
  assert.equal(readCodexAuth(root, keychain('preferred')).auth.tokens.access_token, 'preferred');
  assert.equal(readCodexAuth(root, { platform: 'darwin', keychainRead: () => { throw Error('denied'); } }).auth.tokens.access_token, 'fallback');
  writeFileSync(join(root, 'config.toml'), 'cli_auth_credentials_store = "file"\n');
  assert.equal(readCodexAuth(root, { keychainRead: () => { throw Error('must not call'); } }).auth.tokens.access_token, 'fallback');
});

test('keyring errors do not use old file credentials or disclose secret values', t => {
  const root = fixture(t, 'cli_auth_credentials_store = "keyring"\n');
  saved(root, 'stale-file');
  for (const options of [
    { platform: 'linux' },
    { platform: 'darwin', keychainRead: () => { throw Error('secret-value'); } },
    { platform: 'darwin', keychainRead: () => '{broken secret-value' },
  ]) {
    const result = diagnoseCodexAuth(root, options);
    assert.equal(result.ok, false);
    assert.doesNotMatch(JSON.stringify(result), /stale-file|secret-value|access_token/);
    assert.equal(result.store, 'keyring');
  }
});

test('unsafe roots and files, expired tokens and unsupported modes fail closed', t => {
  const root = fixture(t);
  saved(root, 'public'); chmodSync(join(root, 'auth.json'), 0o644);
  assert.equal(diagnoseCodexAuth(root).reason, 'auth_file_unavailable');
  chmodSync(join(root, 'auth.json'), 0o600);
  saved(root, 'x.' + Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url') + '.x');
  assert.equal(diagnoseCodexAuth(root).reason, 'credential_expired');
  chmodSync(root, 0o777);
  assert.equal(readCodexAuth(root, keychain('cannot-use')).auth, null);
  chmodSync(root, 0o700);
  writeFileSync(join(root, 'config.toml'), 'cli_auth_credentials_store = "ephemeral"\n');
  assert.equal(diagnoseCodexAuth(root).reason, 'unsupported_credential_store');
});

test('TOML settings are parsed structurally; malformed config fails closed', t => {
  const root = fixture(t, '[unrelated]\ncli_auth_credentials_store = "keyring"\n');
  saved(root, 'file-value');
  assert.equal(readCodexAuth(root).store, 'file');
  writeFileSync(join(root, 'config.toml'), 'broken = [\n');
  assert.equal(diagnoseCodexAuth(root).reason, 'credential_config_invalid');
});

test('Keychain authentication authorizes the selected provider, reloads refreshes and rejects stale Bearers', async t => {
  const root = fixture(t, 'cli_auth_credentials_store = "keyring"\n');
  let current = 'recipient-keychain-one';
  const options = { platform: 'darwin', keychainRead: () => JSON.stringify(token(current)) };
  writeFileSync(join(root, 'bridge-local-token'), 'b'.repeat(64), { mode: 0o600 });
  const calls = [];
  const server = createRouter({ codexRoot: root,
    authenticate: request => authenticateCodex(request, root, options),
    catalog: { models: [{ slug: 'opencode/test', router_provider: 'opencode', router_model: 'test' }] },
    fetcher: async (url, init) => { calls.push({ url, init }); return Response.json({ output: [] }); },
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const send = value => fetch(`http://127.0.0.1:${server.address().port}/v1/responses`, {
    method: 'POST', headers: { authorization: `Bearer ${value}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'opencode/test', input: 'hello' }),
  });
  const rejected = await send('foreign');
  assert.equal(rejected.status, 401);
  assert.match((await rejected.json()).error.message, /CODEX_HOME/);
  assert.equal(calls.length, 0);
  assert.equal((await send(current)).status, 200);
  current = 'recipient-keychain-two';
  assert.equal((await send('recipient-keychain-one')).status, 401);
  assert.equal((await send(current)).status, 200);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.init.headers.authorization, undefined);
    assert.equal(call.init.headers['x-codex-bridge-auth'], 'b'.repeat(64));
  }
});

test('doctor reports only safe metadata for explicit recipient root, and exits nonzero on failure', t => {
  const root = fixture(t);
  saved(root, 'never-print-this-credential');
  const script = new URL('../src/auth-doctor.mjs', import.meta.url);
  const run = () => spawnSync(process.execPath, [script.pathname, '--root', root], { encoding: 'utf8' });
  const success = run();
  assert.equal(success.status, 0);
  assert.equal(JSON.parse(success.stdout).codex_home, root);
  assert.equal(JSON.parse(success.stdout).ok, true);
  chmodSync(join(root, 'auth.json'), 0o644);
  const failure = run();
  assert.equal(failure.status, 1);
  assert.equal(JSON.parse(failure.stdout).reason, 'auth_file_unavailable');
  assert.doesNotMatch(success.stdout + success.stderr + failure.stdout + failure.stderr, /never-print-this-credential|access_token/);
});
