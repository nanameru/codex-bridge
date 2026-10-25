// A bounded JSON-RPC client for Codex's private WebSocket-over-Unix control socket.
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { lstatSync, realpathSync } from 'node:fs';

const MAX = 1024 * 1024;
const QUIET = ['thread/started', 'thread/tokenUsage/updated', 'turn/started', 'turn/completed',
  'turn/diff/updated', 'turn/plan/updated', 'item/started', 'item/completed', 'rawResponseItem/completed',
  'rawResponse/completed', 'item/agentMessage/delta', 'item/plan/delta', 'item/reasoning/summaryTextDelta',
  'item/reasoning/summaryPartAdded', 'item/reasoning/textDelta', 'item/commandExecution/outputDelta',
  'item/commandExecution/terminalInteraction', 'item/fileChange/outputDelta', 'command/exec/outputDelta',
  'process/outputDelta', 'item/mcpToolCall/progress'];
export function privateControlSocket(path) {
  if (typeof process.getuid !== 'function') throw new Error('control_unavailable');
  const link = lstatSync(path), resolved = realpathSync(path);
  const info = lstatSync(resolved), parent = lstatSync(dirname(resolved));
  if (link.uid !== process.getuid() || !info.isSocket() || info.uid !== process.getuid()
      || (info.mode & 0o077) || parent.uid !== process.getuid() || (parent.mode & 0o022))
    throw new Error('control_insecure');
  return resolved;
}

function frame(text, opcode = 1) {
  const body = Buffer.from(text), mask = randomBytes(4);
  const size = body.length < 126 ? 2 : body.length < 65536 ? 4 : 10;
  const header = Buffer.alloc(size + 4);
  header[0] = 0x80 | opcode;
  header[1] = 0x80 | (size === 2 ? body.length : size === 4 ? 126 : 127);
  if (size === 4) header.writeUInt16BE(body.length, 2);
  if (size === 10) header.writeBigUInt64BE(BigInt(body.length), 2);
  mask.copy(header, size);
  return Buffer.concat([header, Buffer.from(body.map((b, i) => b ^ mask[i % 4]))]);
}

export class CliControl {
  constructor({ socketPath, timeoutMs = 1000, onNotification = () => {}, observeAll = false }) {
    this.socketPath = socketPath; this.timeoutMs = timeoutMs; this.onNotification = onNotification;
    this.pending = new Map(); this.sequence = 0; this.observeAll = observeAll;
  }
  async connect() {
    if (this.ready) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.#open();
    try { await this.connecting; } finally { this.connecting = null; }
  }
  async #open() {
    const key = randomBytes(16).toString('base64');
    const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    this.buffer = Buffer.alloc(0); this.fragments = []; this.fragmentBytes = 0;
    try {
      await new Promise((resolve, reject) => {
        const request = http.request({ socketPath: privateControlSocket(this.socketPath), path: '/',
          headers: { host: 'localhost', connection: 'Upgrade', upgrade: 'websocket',
            'sec-websocket-version': '13', 'sec-websocket-key': key } });
        this.openRequest = request;
        request.setTimeout(this.timeoutMs, () => request.destroy(new Error('control_timeout')));
        request.once('error', reject);
        request.once('response', response => { response.destroy(); reject(new Error('control_handshake')); });
        request.once('upgrade', (response, socket, head) => {
          if (response.headers['sec-websocket-accept'] !== accept || response.headers['sec-websocket-extensions']) {
            socket.destroy(); reject(new Error('control_handshake')); return;
          }
          socket.setTimeout(0); socket.unref(); this.socket = socket;
          socket.on('data', data => { if (this.socket === socket) this.#read(data); });
          socket.on('error', () => { if (this.socket === socket) this.close(); });
          socket.on('close', () => { if (this.socket === socket) this.close(); });
          resolve(); if (head.length) this.#read(head);
        });
        request.end();
      });
      await this.#call('initialize', { clientInfo: { name: 'codex-bridge-cli-model-sync', version: '1' },
        capabilities: { experimentalApi: true, optOutNotificationMethods: this.observeAll ? [] : QUIET } });
      this.socket.write(frame(JSON.stringify({ method: 'initialized' })));
      this.ready = true; this.epoch = (this.epoch ?? 0) + 1;
    } catch { this.close(); throw new Error('control_unavailable'); }
  }
  #read(data) {
    try {
      this.buffer = Buffer.concat([this.buffer, data]);
      if (this.buffer.length > MAX + 14) throw new Error('control_too_large');
      while (this.buffer.length >= 2) {
        if (!this.socket || this.socket.destroyed) return;
        const b = this.buffer, opcode = b[0] & 15, fin = Boolean(b[0] & 128);
        if ((b[0] & 0x70) || (b[1] & 128)) throw new Error('control_frame');
        let size = b[1] & 127, offset = 2;
        if (size === 126) { if (b.length < 4) return; size = b.readUInt16BE(2); offset = 4; }
        if (size === 127) {
          if (b.length < 10) return;
          const big = b.readBigUInt64BE(2); if (big > BigInt(MAX)) throw new Error('control_too_large');
          size = Number(big); offset = 10;
        }
        if (size > MAX || (opcode >= 8 && (!fin || size > 125))) throw new Error('control_frame');
        if (b.length < offset + size) return;
        const payload = b.subarray(offset, offset + size); this.buffer = b.subarray(offset + size);
        if (opcode === 8) { this.close(); return; }
        if (opcode === 9) { this.socket?.write(frame(payload, 10)); continue; }
        if (opcode === 10) continue;
        if ((opcode !== 0 && opcode !== 1) || (opcode === 0 && !this.fragments.length)
            || (opcode === 1 && this.fragments.length)) throw new Error('control_frame');
        this.fragments.push(payload); this.fragmentBytes += size;
        if (this.fragmentBytes > MAX) throw new Error('control_too_large');
        if (!fin) continue;
        const message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(this.fragments)));
        this.fragments = []; this.fragmentBytes = 0;
        // A model-settings observer never executes or answers tool/approval requests.
        if (message.id !== undefined && typeof message.method === 'string') continue;
        const pending = this.pending.get(message.id);
        if (pending) {
          clearTimeout(pending.timer); this.pending.delete(message.id);
          if (message.error) pending.reject(new Error('control_rpc_failed'));
          else pending.resolve(message.result);
        } else if (typeof message.method === 'string' && message.id === undefined) {
          this.onNotification(message);
        }
      }
    } catch { this.close(); }
  }
  #call(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('control_timeout')); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      if (!this.socket || this.socket.destroyed) { clearTimeout(timer); this.pending.delete(id); reject(new Error('control_unavailable')); return; }
      this.socket.write(frame(JSON.stringify({ id, method, params })));
    });
  }
  async request(method, params) { await this.connect(); return this.#call(method, params); }
  close() {
    this.ready = false;
    this.openRequest?.destroy(); this.openRequest = null;
    const socket = this.socket; this.socket = null; socket?.destroy();
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('control_unavailable')); }
    this.pending.clear();
  }
}
