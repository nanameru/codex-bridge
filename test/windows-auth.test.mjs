import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authenticateCodex, diagnoseCodexAuth } from '../src/local-security.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'windows-auth-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('Windows file auth does not fail on POSIX uid and mode fields', t => {
  const root = fixture(t);
  // Windows ACLs are not exposed through fs.Stats. A normal Windows profile
  // file can report POSIX-compatible mode bits that would be too broad on macOS.
  writeFileSync(join(root, 'auth.json'), JSON.stringify({ tokens: { access_token: 'windows-profile-token' } }),
    { mode: 0o644 });
  const diagnostic = diagnoseCodexAuth(root, {
    platform: 'win32',
    keychainRead: () => { throw Error('must not call'); },
  });
  assert.deepEqual(diagnostic, { ok: true, store: 'file', reason: null });
  assert.equal(authenticateCodex({ headers: { authorization: 'Bearer windows-profile-token' } }, root,
    { platform: 'win32' }), true);
  assert.equal(authenticateCodex({ headers: { authorization: 'Bearer foreign-token' } }, root,
    { platform: 'win32' }), false);
});

test('Windows auth failures stay non-secret and distinguishable', t => {
  const root = fixture(t);
  const missing = diagnoseCodexAuth(root, { platform: 'win32' });
  assert.deepEqual(missing, { ok: false, store: 'file', reason: 'auth_file_unavailable' });
  writeFileSync(join(root, 'auth.json'), '{broken-secret-value');
  const broken = diagnoseCodexAuth(root, { platform: 'win32' });
  assert.equal(broken.reason, 'credential_invalid');
  assert.doesNotMatch(JSON.stringify(broken), /broken-secret-value|access_token/);
});
