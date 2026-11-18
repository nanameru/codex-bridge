import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { portableRouterConfig, readPortableCatalog, runPortableRouter } from '../scripts/portable_router.mjs';

const script = fileURLToPath(new URL('../scripts/portable_router.mjs', import.meta.url));
const catalog = { models: [{ slug: 'recipient-gpt', router_provider: 'openai' }] };

test('router validates arguments before opening files or listeners', () => {
  for (const args of [[], ['x'], ['x', 'model', '0', '2'], ['x', 'model', '1', '65536'], ['x', '../bad', '1', '2']]) {
    assert.throws(() => runPortableRouter(args), /Invalid router arguments/);
  }
  const child = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /invalid or unsafe; no listener started/);
  assert.doesNotMatch(child.stderr, /at |TypeError|ENOENT/);
});

test('same ports are allowed only when the catalog needs no OpenCode Bridge', { skip: process.platform === 'win32' }, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'portable-catalog-')));
  try {
    const path = join(root, 'catalog.json');
    writeFileSync(path, JSON.stringify(catalog), { mode: 0o600 });
    assert.equal(portableRouterConfig([path, 'recipient-gpt', '8788', '8788']).summaryModel, 'recipient-gpt');
    writeFileSync(path, JSON.stringify({ models: [...catalog.models, { slug: 'opencode/model', router_provider: 'opencode' }] }));
    assert.throws(() => portableRouterConfig([path, 'recipient-gpt', '8788', '8788']), /separate Bridge port/);
    assert.equal(portableRouterConfig([path, 'recipient-gpt', '8790', '8788']).bridgeBase, 'http://127.0.0.1:8788/v1');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('router reads a private catalog without starting a service', { skip: process.platform === 'win32' }, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'portable-catalog-')));
  try {
    const path = join(root, 'catalog.json');
    writeFileSync(path, JSON.stringify(catalog), { mode: 0o600 });
    assert.deepEqual(readPortableCatalog(path, 'recipient-gpt'), catalog);
    assert.throws(() => readPortableCatalog(path, 'missing'), /Invalid catalog/);
    for (const content of ['null', '[]', '{"models":[{"slug":["recipient-gpt"],"router_provider":"openai"}]}', 'x'.repeat(1024 * 1024 + 1)]) {
      writeFileSync(path, content);
      assert.throws(() => readPortableCatalog(path, 'recipient-gpt'));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('router rejects links, shared files and shared parents', { skip: process.platform === 'win32' }, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'portable-catalog-')));
  try {
    const path = join(root, 'catalog.json');
    writeFileSync(path, JSON.stringify(catalog), { mode: 0o600 });
    symlinkSync(path, join(root, 'link.json'));
    assert.throws(() => readPortableCatalog(join(root, 'link.json'), 'recipient-gpt'));
    const alias = join(root, 'alias');
    symlinkSync(root, alias);
    assert.throws(() => readPortableCatalog(join(alias, 'catalog.json'), 'recipient-gpt'));
    linkSync(path, join(root, 'hard.json'));
    assert.throws(() => readPortableCatalog(path, 'recipient-gpt'));
    rmSync(join(root, 'hard.json'));
    chmodSync(path, 0o644);
    assert.throws(() => readPortableCatalog(path, 'recipient-gpt'));
    const shared = join(root, 'shared');
    mkdirSync(shared);
    chmodSync(shared, 0o777);
    writeFileSync(join(shared, 'catalog.json'), JSON.stringify(catalog), { mode: 0o600 });
    assert.throws(() => readPortableCatalog(join(shared, 'catalog.json'), 'recipient-gpt'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
