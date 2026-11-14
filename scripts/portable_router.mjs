#!/usr/bin/env node
// Foreground router with an explicitly selected recipient catalog and summary model.
import { constants, openSync, closeSync, lstatSync, fstatSync, readSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRouter } from '../src/model-router.mjs';

const LIMIT = 1024 * 1024;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;

export function readPortableCatalog(path, summaryModel) {
  if (process.platform === 'win32') throw Error('Use WSL');
  path = resolve(path);
  let parent = dirname(path);
  const directory = lstatSync(parent);
  if (!directory.isDirectory() || directory.uid !== process.getuid() || (directory.mode & 0o022)) throw Error('Unsafe catalog directory');
  for (;;) {
    const info = lstatSync(parent);
    if (!info.isDirectory() || info.isSymbolicLink() || ((info.mode & 0o022) && !(info.mode & 0o1000))) throw Error('Unsafe catalog directory');
    const next = dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  const before = lstatSync(path);
  const identity = info => [info.dev, info.ino, info.mode, info.uid, info.nlink, info.size, info.mtimeMs, info.ctimeMs].join(':');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let catalog;
  try {
    const current = fstatSync(fd);
    if (identity(before) !== identity(current) || !current.isFile() || current.nlink !== 1
        || current.uid !== process.getuid() || (current.mode & 0o077) || current.size > LIMIT) throw Error('Unsafe catalog');
    const buffer = Buffer.alloc(LIMIT + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > LIMIT || identity(current) !== identity(fstatSync(fd))) throw Error('Catalog changed or is too large');
    catalog = JSON.parse(buffer.subarray(0, length).toString('utf8'));
  } finally { closeSync(fd); }
  const models = catalog?.models;
  if (!Array.isArray(models) || !models.length || models.length > 500
      || models.some(m => !m || typeof m !== 'object' || typeof m.slug !== 'string' || !MODEL.test(m.slug)
        || !['openai', 'opencode', 'commandcode', 'ollama', 'whatstoken'].includes(m.router_provider))
      || new Set(models.map(m => m.slug)).size !== models.length
      || !models.some(m => m.slug === summaryModel && m.router_provider === 'openai')) throw Error('Invalid catalog');
  return catalog;
}

export function runPortableRouter(args) {
  const [catalogPath, summaryModel, routerPort, bridgePort] = args;
  const port = value => typeof value === 'string' && /^[0-9]{1,5}$/.test(value) && Number(value) >= 1 && Number(value) <= 65535;
  if (args.length !== 4 || !catalogPath || !MODEL.test(summaryModel ?? '')
      || !port(routerPort) || !port(bridgePort) || Number(routerPort) === Number(bridgePort)) throw Error('Invalid router arguments');
  const catalog = readPortableCatalog(catalogPath, summaryModel);
  const server = createRouter({ catalog, summaryModel,
    bridgeBase: `http://127.0.0.1:${bridgePort}/v1`,
    manualProvidersEnabled: false, cliModelSyncEnabled: false,
    autoProviderFallback: false, autoBudgetHandoff: false });
  server.once('error', () => { console.error('Portable router could not start.'); process.exitCode = 1; });
  server.listen(Number(routerPort), '127.0.0.1');
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => server.close(() => process.exit(0)));
  }
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { runPortableRouter(process.argv.slice(2)); }
  catch { console.error('Portable router arguments or catalog are invalid or unsafe; no listener started.'); process.exitCode = 1; }
}
