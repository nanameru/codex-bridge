#!/usr/bin/env node
// Build a recipient-selected catalog without touching the Codex home.
import { constants, readFileSync, openSync, writeFileSync, closeSync, lstatSync, fstatSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { buildCatalog } from '../src/make-catalog.mjs';

const [cachePath, outputPath, openaiList, opencodeList] = process.argv.slice(2);
if (!cachePath || !outputPath || !openaiList || !opencodeList) {
  console.error('Usage: node scripts/portable_catalog.mjs CACHE OUTPUT OPENAI_IDS OPCODE_IDS (comma-separated IDs)');
  process.exit(1);
}
// Match the launcher's fail-closed policy before reading or creating user data.
if (process.platform === 'win32') throw Error('Use WSL; native Windows ACL verification is unavailable');
function safeParent(path) {
  let current = dirname(resolve(path));
  const parent = lstatSync(current);
  if (!parent.isDirectory() || parent.uid !== process.getuid() || (parent.mode & 0o022)) throw Error('Unsafe catalog directory');
  for (;;) {
    const info = lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink() || ((info.mode & 0o022) && !(info.mode & 0o1000))) throw Error('Unsafe catalog directory');
    const next = dirname(current);
    if (next === current) break;
    current = next;
  }
}
function readCache(path) {
  safeParent(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== process.getuid() || info.nlink !== 1 || (info.mode & 0o022) || info.size > 2 * 1024 * 1024) throw Error('Unsafe model cache');
    return JSON.parse(readFileSync(fd, 'utf8')).models;
  } finally { closeSync(fd); }
}
safeParent(outputPath);
const names = value => value.split(',').filter(Boolean);
const nativeIds = names(openaiList), externalIds = names(opencodeList);
if (!nativeIds.length || !externalIds.length || [...nativeIds, ...externalIds].some(id => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id))) throw Error('Invalid model selection');
const native = readCache(cachePath);
if (!Array.isArray(native) || !native.length || native.length > 500) throw Error('Invalid native model cache');
const seeds = JSON.parse(readFileSync(new URL('../src/models.json', import.meta.url), 'utf8')).models;
const find = (list, key, id) => {
  const matches = list.filter(item => item[key] === id);
  if (matches.length !== 1) throw Error(`Model unavailable or ambiguous: ${id}`);
  return matches[0];
};
const openai = nativeIds.map(id => ({ ...find(native, 'slug', id), router_provider: 'openai', router_model: id }));
if (typeof openai[0].base_instructions !== 'string' || !openai[0].base_instructions) throw Error('Native cache has no base instructions');
const openCode = externalIds.map(id => ({ ...buildCatalog([find(seeds, 'id', id)]).models[0],
  base_instructions: openai[0].base_instructions,
  slug: `opencode/${id}`, router_provider: 'opencode', router_model: id, router_transport: 'chat' }));
const models = [...openai, ...openCode];
if (new Set(models.map(m => m.slug)).size !== models.length) throw Error('Duplicate model');
console.log(`Create new catalog: ${outputPath}\nOpenAI: ${nativeIds.join(', ')}\nOpenCode Go: ${externalIds.join(', ')}`);
const rl = createInterface({ input: stdin, output: stdout });
const answer = await rl.question('Create this catalog? Type YES to approve: ');
rl.close();
if (answer.trim() !== 'YES') process.exit(1);
safeParent(outputPath);
const fd = openSync(outputPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
try { writeFileSync(fd, JSON.stringify({ models }, null, 2) + '\n'); } finally { closeSync(fd); }
