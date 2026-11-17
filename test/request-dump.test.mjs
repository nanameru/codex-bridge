import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import crypto from 'node:crypto';
import fs, { chmodSync, linkSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { mock } from 'node:test';
import { writeRequestDump } from '../src/local-security.mjs';

function temporary(context) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'bridge-dump-test-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

// Real bridge/HTTP/filesystem; only the paid upstream and credentials are synthetic.
async function bridge(context, root, environment) {
  const upstream = http.createServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] }));
  });
  const upstreamPort = await listen(upstream);
  context.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const reservation = http.createServer();
  const port = await listen(reservation);
  await new Promise(done => reservation.close(done));
  const key = 'a'.repeat(64);
  writeFileSync(join(root, 'bridge-local-token'), key, { mode: 0o600 });
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/codex-bridge.mjs', import.meta.url))], {
    env: { ...process.env, HOME: root, CODEX_HOME: root, PORT: String(port),
      OPENCODE_API_KEY: 'synthetic-dump-test-key', UPSTREAM_BASE: `http://127.0.0.1:${upstreamPort}/v1`,
      CODEX_BRIDGE_TEST_UPSTREAM: '1', LOG_LEVEL: 'info', USAGE_HOST: '',
      ALLOW_REQUEST_DUMP: '', DISABLE_DUMP: '', DUMP_DIR: join(root, 'dumps'), ...environment },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  context.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
  });
  let logs = '';
  await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error('bridge startup timed out')), 8000);
    child.stdout.on('data', chunk => {
      logs += chunk;
      if (logs.includes('codex-bridge listening')) { clearTimeout(timer); done(); }
    });
    child.stderr.on('data', chunk => { logs += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('bridge exited before startup')); });
  });
  const body = { model: 'synthetic-model', input: 'SYNTHETIC_DUMP_CONTENT', stream: false };
  const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-codex-bridge-auth': key }, body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  await response.json();
  assert.ok(!logs.includes(body.input), 'request body must not reach stdout/stderr');
  return body;
}

test('bridge refuses an explicitly enabled dump directory that is a link', { skip: process.platform === 'win32', timeout: 15000 }, async context => {
  const root = temporary(context);
  const target = join(root, 'target');
  mkdirSync(target, { mode: 0o700 });
  const directory = join(root, 'dumps');
  symlinkSync(target, directory);
  await bridge(context, root, { ALLOW_REQUEST_DUMP: '1', DUMP_DIR: directory });
  assert.deepEqual(readdirSync(target), []);
});

test('bridge leaves dump storage absent by default and when explicitly disabled', { timeout: 15000 }, async context => {
  for (const environment of [{}, { ALLOW_REQUEST_DUMP: '1', DISABLE_DUMP: '1' }]) {
    await context.test(JSON.stringify(environment), async sub => {
      const root = temporary(sub);
      await bridge(sub, root, environment);
      assert.equal(fs.existsSync(join(root, 'dumps')), false);
    });
  }
});

test('bridge stores synthetic content in a new private file when enabled on POSIX', { skip: process.platform === 'win32', timeout: 15000 }, async context => {
  const root = temporary(context);
  const body = await bridge(context, root, { ALLOW_REQUEST_DUMP: '1' });
  const directory = join(root, 'dumps');
  const files = readdirSync(directory);
  assert.equal(files.length, 1);
  const file = join(directory, files[0]);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).body, body);
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

function options(root, extra = {}) {
  return { home: root, environment: { ALLOW_REQUEST_DUMP: '1', DUMP_DIR: join(root, 'dumps'), ...extra } };
}

test('disabled and unsupported dumps do not serialize or create files', context => {
  const root = temporary(context);
  const body = { toJSON() { throw new Error('must not serialize'); } };
  for (const environment of [{}, { ALLOW_REQUEST_DUMP: 'true' }, { ALLOW_REQUEST_DUMP: '1', DISABLE_DUMP: '1' }]) {
    assert.equal(writeRequestDump(body, { home: root, environment }), false);
  }
  assert.equal(writeRequestDump(body, { ...options(root), platform: 'win32' }), false);
  assert.deepEqual(readdirSync(root), []);
});

test('default enabled location is private under home, with unique single-link files', { skip: process.platform === 'win32' }, context => {
  const root = temporary(context);
  chmodSync(root, 0o755); // Ancestors may be readable, but cannot be writable by others.
  const settings = { home: root, environment: { ALLOW_REQUEST_DUMP: '1' } };
  for (let i = 0; i < 8; i++) assert.equal(writeRequestDump({ synthetic: i }, settings), true);
  const directory = join(root, '.codex-bridge-dumps');
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  const files = readdirSync(directory);
  assert.equal(files.length, 8);
  assert.equal(new Set(files).size, 8);
  for (const name of files) {
    const info = statSync(join(directory, name));
    assert.equal(info.uid, process.getuid());
    assert.equal(info.mode & 0o777, 0o600);
    assert.equal(info.nlink, 1);
  }
});

test('unsafe directories are refused without changing their modes or existing contents', { skip: process.platform === 'win32' }, context => {
  const root = temporary(context);
  const directory = join(root, 'dumps');
  mkdirSync(directory, { mode: 0o700 });
  const existing = join(directory, 'existing');
  writeFileSync(existing, 'SYNTHETIC_KEEP', { mode: 0o644 });
  for (const mode of [0o750, 0o770, 0o777]) {
    chmodSync(directory, mode);
    assert.equal(writeRequestDump({ synthetic: true }, options(root)), false);
    assert.deepEqual(readdirSync(directory), ['existing']);
    assert.equal(readFileSync(existing, 'utf8'), 'SYNTHETIC_KEEP');
    assert.equal(statSync(directory).mode & 0o777, mode);
    assert.equal(statSync(existing).mode & 0o777, 0o644);
  }
});

test('unsafe or linked ancestors and non-directory destinations are refused', { skip: process.platform === 'win32' }, context => {
  const root = temporary(context);
  const parent = join(root, 'parent');
  mkdirSync(parent, { mode: 0o700 });
  const directory = join(parent, 'dumps');
  mkdirSync(directory, { mode: 0o700 });
  chmodSync(parent, 0o777);
  assert.equal(writeRequestDump({}, options(root, { DUMP_DIR: directory })), false);
  assert.deepEqual(readdirSync(directory), []);
  assert.equal(writeRequestDump({}, options(root, { DUMP_DIR: join(parent, 'absent') })), false);
  assert.equal(fs.existsSync(join(parent, 'absent')), false);
  chmodSync(parent, 0o700);
  const link = join(root, 'link');
  symlinkSync(parent, link);
  assert.equal(writeRequestDump({}, options(root, { DUMP_DIR: join(link, 'dumps') })), false);
  const file = join(root, 'file');
  writeFileSync(file, 'SYNTHETIC_KEEP');
  assert.equal(writeRequestDump({}, options(root, { DUMP_DIR: file })), false);
  assert.equal(readFileSync(file, 'utf8'), 'SYNTHETIC_KEEP');
  const dangling = join(root, 'dangling');
  symlinkSync(join(root, 'absent'), dangling);
  assert.equal(writeRequestDump({}, options(root, { DUMP_DIR: dangling })), false);
  assert.equal(fs.existsSync(join(root, 'absent')), false);
});

test('owner mismatch refuses an existing directory and a new directory under a foreign parent', { skip: process.platform === 'win32' }, context => {
  const root = temporary(context);
  mkdirSync(join(root, 'dumps'), { mode: 0o700 });
  const uid = process.getuid();
  const mocked = mock.method(process, 'getuid', () => uid + 1);
  try {
    assert.equal(writeRequestDump({}, options(root)), false);
    assert.equal(writeRequestDump({}, options(root, { DUMP_DIR: join(root, 'absent') })), false);
  } finally { mocked.mock.restore(); }
  assert.deepEqual(readdirSync(root), ['dumps']);
  assert.deepEqual(readdirSync(join(root, 'dumps')), []);
});

test('exclusive creation preserves existing files and links on a forced filename collision', { skip: process.platform === 'win32' }, context => {
  const root = temporary(context);
  const directory = join(root, 'dumps');
  mkdirSync(directory, { mode: 0o700 });
  const existing = join(root, 'existing');
  writeFileSync(existing, 'SYNTHETIC_KEEP', { mode: 0o644 });
  const collision = join(directory, 'fixed-uuid.json');
  const mocked = mock.method(crypto, 'randomUUID', () => 'fixed-uuid');
  syncBuiltinESMExports();
  try {
    for (const kind of ['regular', 'symlink', 'hardlink']) {
      if (kind === 'regular') writeFileSync(collision, 'SYNTHETIC_KEEP', { mode: 0o644 });
      else if (kind === 'symlink') symlinkSync(existing, collision);
      else linkSync(existing, collision);
      assert.equal(writeRequestDump({}, options(root)), false);
      assert.equal(readFileSync(collision, 'utf8'), 'SYNTHETIC_KEEP');
      assert.equal(readFileSync(existing, 'utf8'), 'SYNTHETIC_KEEP');
      assert.equal(statSync(existing).mode & 0o777, 0o644);
      fs.unlinkSync(collision);
    }
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

test('permissions changed after a successful dump are rechecked on the next request', { skip: process.platform === 'win32' }, context => {
  const root = temporary(context);
  assert.equal(writeRequestDump({ synthetic: 1 }, options(root)), true);
  const directory = join(root, 'dumps');
  const before = readdirSync(directory);
  chmodSync(directory, 0o755);
  assert.equal(writeRequestDump({ synthetic: 2 }, options(root)), false);
  assert.deepEqual(readdirSync(directory), before);
});

test('a foreign-owned destination is refused before opening files', { skip: process.platform === 'win32' }, context => {
  const root = temporary(context);
  const directory = join(root, 'dumps');
  mkdirSync(directory, { mode: 0o700 });
  const lstat = fs.lstatSync;
  const mocked = mock.method(fs, 'lstatSync', (path, ...args) => {
    const info = lstat(path, ...args);
    return path === directory ? new Proxy(info, { get: (value, key) => key === 'uid' ? process.getuid() + 1 : value[key] }) : info;
  });
  syncBuiltinESMExports();
  try { assert.equal(writeRequestDump({}, options(root)), false); }
  finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  assert.deepEqual(readdirSync(directory), []);
});

test('opened file metadata is checked and descriptors close when safety checks fail', { skip: process.platform === 'win32' }, context => {
  const root = temporary(context);
  const fstat = fs.fstatSync;
  const descriptors = [];
  const mocked = mock.method(fs, 'fstatSync', descriptor => {
    const info = fstat(descriptor);
    if (!descriptors.includes(descriptor)) descriptors.push(descriptor);
    return info.isFile() ? new Proxy(info, { get: (value, key) => key === 'nlink' ? 2 : value[key] }) : info;
  });
  syncBuiltinESMExports();
  try { assert.equal(writeRequestDump({ synthetic: 'MUST_NOT_BE_WRITTEN' }, options(root)), false); }
  finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  const directory = join(root, 'dumps');
  const files = readdirSync(directory);
  assert.equal(files.length, 1);
  assert.equal(statSync(join(directory, files[0])).size, 0);
  assert.equal(descriptors.length, 2);
  for (const fd of descriptors) assert.throws(() => fstat(fd), { code: 'EBADF' });
});

test('a directory permission change during file creation prevents body writes', { skip: process.platform === 'win32' }, context => {
  const root = temporary(context);
  const directory = join(root, 'dumps');
  const open = fs.openSync;
  const mocked = mock.method(fs, 'openSync', (path, ...args) => {
    const descriptor = open(path, ...args);
    if (String(path).endsWith('.json')) chmodSync(directory, 0o755);
    return descriptor;
  });
  syncBuiltinESMExports();
  try { assert.equal(writeRequestDump({ synthetic: 'MUST_NOT_BE_WRITTEN' }, options(root)), false); }
  finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  const files = readdirSync(directory);
  assert.equal(files.length, 1);
  assert.equal(statSync(join(directory, files[0])).size, 0);
});

test('relative, missing-parent and unserializable dumps fail closed without side effects', context => {
  const root = temporary(context);
  assert.equal(writeRequestDump({}, options(root, { DUMP_DIR: 'relative' })), false);
  assert.equal(writeRequestDump({}, options(root, { DUMP_DIR: join(root, 'missing', 'dumps') })), false);
  const cyclic = {}; cyclic.self = cyclic;
  assert.equal(writeRequestDump(cyclic, options(root)), false);
  assert.deepEqual(readdirSync(root), []);
});
