import { createHmac, randomBytes, randomUUID } from 'node:crypto';

const CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOSPC',
  'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'ENOTFOUND', 'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'ERR_STREAM_PREMATURE_CLOSE', 'ERR_STREAM_DESTROYED', 'ABORT_ERR']);

// Never serialize Error.message/stack/cause: they may contain URLs, tokens or bodies.
export function transportErrorCodes(error) {
  const seen = new Set(), codes = new Set();
  const pending = [error];
  while (pending.length && seen.size < 12) {
    const item = pending.shift();
    if (!item || typeof item !== 'object' || seen.has(item)) continue;
    seen.add(item);
    if (CODES.has(item.code)) codes.add(item.code);
    if (item.cause) pending.push(item.cause);
    if (Array.isArray(item.errors)) pending.push(...item.errors.slice(0, 4));
  }
  return [...codes];
}

const EVENTS = new Set(['router_request_started', 'router_request_decoded',
  'router_request_upstream', 'router_request_headers', 'router_request_finished',
  'router_started', 'router_stopping', 'router_fatal', 'router_exit']);
const STAGES = new Set(['input', 'upstream_headers', 'upstream_stream', 'complete',
  'remote_compaction_handoff', 'budget_rejected', 'handoff', 'budget_handoff']);
const REASONS = new Set(['client_disconnected', 'client_request_aborted',
  'deadline_exceeded', 'upstream_stream_error', 'upstream_error']);

export function createRouterDiagnostics({ write = () => {}, now = Date.now,
  pid = process.pid, instanceId = randomUUID() } = {}) {
  const key = randomBytes(32); // Not logged; thread references last only this router instance.
  const identity = { process_id: pid, process_instance: instanceId };
  return {
    identity,
    timestamp: () => new Date(now()).toISOString(),
    threadRef(value) {
      return typeof value === 'string' && value.length > 0 && value.length <= 200
        ? createHmac('sha256', key).update(value).digest('hex').slice(0, 24) : undefined;
    },
    record(event, data = {}) {
      if (!EVENTS.has(event)) return;
      const result = { event, timestamp: new Date(now()).toISOString(), ...identity };
      if (/^[0-9a-f-]{36}$/i.test(data.request_id ?? '')) result.request_id = data.request_id;
      if (/^[0-9a-f]{24}$/.test(data.thread_ref ?? '')) result.thread_ref = data.thread_ref;
      if (STAGES.has(data.stage)) result.stage = data.stage;
      if (REASONS.has(data.termination_reason)) result.termination_reason = data.termination_reason;
      if (['normal', 'remote_compaction', 'native_tool'].includes(data.request_kind)) result.request_kind = data.request_kind;
      if (['/v1/responses', '/v1/responses/compact'].includes(data.path)) result.path = data.path;
      for (const field of ['received_bytes', 'decoded_bytes', 'total_ms', 'upstream_status', 'status', 'active_requests', 'exit_code', 'port']) {
        if (Number.isSafeInteger(data[field]) && data[field] >= 0) result[field] = data[field];
      }
      if (['SIGTERM', 'SIGINT'].includes(data.signal)) result.signal = data.signal;
      if (['uncaughtException', 'unhandledRejection'].includes(data.origin)) result.origin = data.origin;
      if (Array.isArray(data.transport_error_codes)) result.transport_error_codes = data.transport_error_codes.filter(code => CODES.has(code)).slice(0, 12);
      try { write(result); } catch { /* Diagnostics cannot change request behavior. */ }
    },
  };
}

// Observe crashes without swallowing them or changing Node's default exit behavior.
export function observeRouterProcess(runtime, diagnostics, activeRequests = () => 0) {
  const fatal = (error, origin) => diagnostics.record('router_fatal', {
    origin, transport_error_codes: transportErrorCodes(error), active_requests: activeRequests(),
  });
  const exit = code => diagnostics.record('router_exit', { exit_code: code, active_requests: activeRequests() });
  runtime.on('uncaughtExceptionMonitor', fatal);
  runtime.on('exit', exit);
  return () => { runtime.off('uncaughtExceptionMonitor', fatal); runtime.off('exit', exit); };
}
