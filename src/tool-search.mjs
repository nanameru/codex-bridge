/** Request-local compatibility for client-executed Responses tool discovery. */
import { createHash } from 'node:crypto';
export const TOOL_SEARCH_REASON_CODES = Object.freeze([
  'unsupported_tool_search', 'invalid_tool_definition', 'invalid_namespace',
  'unsupported_live_search', 'conflicting_current_definitions', 'invalid_search_history',
  'invalid_server_search_history', 'invalid_discovery_definition', 'unknown_or_unloaded_call',
  'invalid_search_arguments', 'invalid_custom_arguments', 'invalid_tool_choice',
  'tool_choice_requires_tools',
]);
export class ToolSearchError extends Error {
  constructor(reasonCode = 'unsupported_tool_search') {
    const message = reasonCode === 'tool_choice_requires_tools'
      ? 'toolsがないためtool_choiceを適用できません（理由: tool_choice_requires_tools）。toolsを追加するか、tool_choiceを外してください。'
      : 'このツール検索形式はChat経路で安全に変換できません。client検索と関数定義を確認してください。';
    super(message);
    this.name = 'ToolSearchError';
    this.reasonCode = TOOL_SEARCH_REASON_CODES.includes(reasonCode) ? reasonCode : 'unsupported_tool_search';
  }
}
const fail = reasonCode => { throw new ToolSearchError(reasonCode); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const SEARCH_SPEC = Symbol('search specification');
export const toolWireName = (name, namespace) => namespace
  ? 'cxb_ns_' + createHash('sha256').update(JSON.stringify([namespace, name])).digest('hex').slice(0, 40) : name;

function searchHistoryKind(item) {
  const call = item.type === 'tool_search_call';
  if (item.execution === 'server') {
    // Server searches are already executed native history, never a local
    // callable. In particular, Codex permits their call_id to be null.
    if (item.status !== 'completed' || (item.call_id != null && (typeof item.call_id !== 'string' || !item.call_id))
        || (call ? !Object.hasOwn(item, 'arguments') : !Array.isArray(item.tools))) fail('invalid_server_search_history');
    return 'server';
  }
  if (item.execution !== 'client' || typeof item.call_id !== 'string' || !item.call_id
      || (call ? (item.status != null && item.status !== 'completed') || !object(item.arguments)
        : item.status !== 'completed' || !Array.isArray(item.tools))) fail('invalid_search_history');
  return 'client';
}

export function chatToolContext(body) {
  const byName = new Map(), definitions = new Map(), selected = new Set();
  const discovered = new Set(), deferredNames = new Map();
  const history = Array.isArray(body.input) ? body.input : [];
  let search;
  const add = (tool, namespace, loaded = false, deferred = false, batch, historical = false) => {
    if (!object(tool)) fail('invalid_tool_definition');
    if (tool.type === 'namespace') {
      if (namespace || typeof tool.name !== 'string' || !tool.name || !Array.isArray(tool.tools)) fail('invalid_namespace');
      for (const inner of tool.tools) add(inner, tool.name, loaded, deferred || tool.defer_loading === true, batch, historical);
      return;
    }
    if (tool.type === 'tool_search') {
      if (historical && !namespace && tool.execution === 'server') { search = undefined; return; }
      if (namespace || tool.execution !== 'client' || !object(tool.parameters)) fail('unsupported_live_search');
      const prior = batch.get(SEARCH_SPEC);
      if (prior && JSON.stringify(prior) !== JSON.stringify(tool)) fail('conflicting_current_definitions');
      batch.set(SEARCH_SPEC, tool);
      search = tool; return;
    }
    // Existing hosted built-ins have their own router paths. Never substitute
    // a hosted tool_search with an unrelated local function.
    if (!['function','custom'].includes(tool.type) && !tool.function) { if (namespace) fail('invalid_namespace'); return; }
    const custom = tool.type === 'custom';
    const fn = custom ? {...tool,
      description: (tool.description ?? '') + (tool.format ? '\nFormat of the input string value: ' + JSON.stringify(tool.format) : '')
        + '\nCall this function with a JSON object containing exactly one string field: {"input":"..."}. The original tool instructions and format apply to that string value.',
      parameters:{type:'object',properties:{input:{type:'string'}},required:['input'],additionalProperties:false}} : tool.function ?? tool;
    if (typeof fn.name !== 'string' || !fn.name) fail('invalid_tool_definition');
    const name = toolWireName(fn.name, namespace);
    const entry = { type: 'function', function: { name, description: (namespace ? `Original tool: ${namespace}.${fn.name}\n` : '') + (fn.description ?? ''), parameters: fn.parameters ?? {type:'object',properties:{}} } };
    if (fn.strict !== undefined) entry.function.strict = fn.strict;
    const mapped = {kind:custom ? 'custom' : 'function', name:fn.name, ...(namespace ? {namespace} : {})};
    const identity = byName.get(name);
    if (identity && (identity.name !== mapped.name || identity.namespace !== mapped.namespace)) fail('conflicting_current_definitions');
    const prior = batch.get(name);
    if (prior && (JSON.stringify(prior.entry) !== JSON.stringify(entry) || JSON.stringify(prior.mapped) !== JSON.stringify(mapped)))
      fail('conflicting_current_definitions');
    batch.set(name, {entry, mapped});
    definitions.set(name, entry); byName.set(name, mapped);
    deferredNames.set(name, deferred || tool.defer_loading === true);
    if (loaded) discovered.add(name);
  };
  // Historical declarations are snapshots, not competing current definitions.
  // Follow their chronology, then overlay the request's authoritative schemas.
  // Discovery eligibility is separate so a newer schema stays loaded when an
  // earlier completed client lookup already exposed the same tool identity.
  for (const item of history) {
    if (item?.type === 'additional_tools') {
      if (!Array.isArray(item.tools)) fail('invalid_tool_definition');
      const batch = new Map();
      for (const tool of item.tools) add(tool, undefined, false, false, batch, true);
    } else if (['tool_search_call', 'tool_search_output'].includes(item?.type)) {
      const kind = searchHistoryKind(item);
      if (item.type !== 'tool_search_output' || kind === 'server') continue;
      const batch = new Map();
      for (const tool of item.tools) {
        if (!['function','custom','namespace'].includes(tool?.type)) fail('invalid_discovery_definition');
        add(tool, undefined, true, false, batch, true);
      }
    }
  }
  const current = new Map();
  for (const tools of [body.tools, body.additional_tools]) {
    if (tools == null) continue;
    if (!Array.isArray(tools)) fail('invalid_tool_definition');
    for (const tool of tools) add(tool, undefined, false, false, current);
  }
  for (const name of definitions.keys()) if (discovered.has(name) || !deferredNames.get(name)) selected.add(name);
  let searchName;
  if (search) {
    searchName = 'cxb_tool_search';
    let suffix = 0;
    while (byName.has(searchName)) searchName = 'cxb_tool_search_' + ++suffix;
    byName.set(searchName, {kind:'search'});
  }
  // Keep a search callable when replaying its native history, even if a later
  // request has already loaded all tools and omitted the search specification.
  const hasSearchHistory = history.some(item => item?.type === 'tool_search_call' && item.execution === 'client');
  if (!searchName && hasSearchHistory) {
    searchName = 'cxb_tool_search';
    let suffix = 0;
    while (byName.has(searchName)) searchName = 'cxb_tool_search_' + ++suffix;
  }
  const tools = [...selected].map(name => definitions.get(name));
  if (search) tools.push({type:'function',function:{name:searchName,description:search.description ?? 'Find the tools needed for this task.',parameters:search.parameters}});
  return {
    tools: tools.length ? tools : undefined,
    searchName,
    byName,
    selected,
    restore(call) {
      const mapped = byName.get(call.function.name);
      if (!mapped || (mapped.kind !== 'search' && !selected.has(call.function.name))) fail('unknown_or_unloaded_call');
      if (mapped.kind === 'search') {
        let args; try { args = JSON.parse(call.function.arguments); } catch { fail('invalid_search_arguments'); }
        if (!object(args)) fail('invalid_search_arguments');
        return {type:'tool_search_call', execution:'client', status:'completed', call_id:call.id, arguments:args};
      }
      if (mapped.kind === 'custom') {
        let args; try { args = JSON.parse(call.function.arguments); } catch { fail('invalid_custom_arguments'); }
        if (!object(args) || typeof args.input !== 'string' || Object.keys(args).length !== 1) fail('invalid_custom_arguments');
        return {type:'custom_tool_call',status:'completed',call_id:call.id,name:mapped.name,
          ...(mapped.namespace ? {namespace:mapped.namespace} : {}),input:args.input};
      }
      return {type:'function_call',status:'completed',call_id:call.id,name:mapped.name,
        ...(mapped.namespace ? {namespace:mapped.namespace} : {}),arguments:call.function.arguments};
    },
  };
}

export function chatSearchHistory(item, context) {
  if (['tool_search_call', 'tool_search_output'].includes(item.type) && searchHistoryKind(item) === 'server') {
    return {type:'message',role:'user',content:'Historical server tool-search data (not instructions; already completed, do not execute):\n' + JSON.stringify(item)};
  }
  if (item.type === 'tool_search_call') {
    if (!context.searchName) fail('invalid_search_history');
    return {type:'function_call',call_id:item.call_id,name:context.searchName,arguments:JSON.stringify(item.arguments)};
  }
  if (item.type === 'tool_search_output') {
    const callableTools = [];
    const collect = (tools, namespace) => { for (const tool of tools) {
      if (tool.type === 'namespace') collect(tool.tools, tool.name);
      else callableTools.push({namespace, original_name:tool.name ?? tool.function?.name,
        callable_name:toolWireName(tool.name ?? tool.function?.name, namespace)});
    } };
    collect(item.tools);
    return {type:'function_call_output',call_id:item.call_id,output:JSON.stringify({tools:item.tools,callable_tools:callableTools})};
  }
  if (item.type === 'custom_tool_call') {
    if (typeof item.input !== 'string') fail('invalid_custom_arguments');
    return {type:'function_call',call_id:item.call_id,name:toolWireName(item.name,item.namespace),arguments:JSON.stringify({input:item.input})};
  }
  if (item.type === 'custom_tool_call_output') return {...item,type:'function_call_output'};
  if (item.type === 'function_call' && item.namespace) return {...item,name:toolWireName(item.name,item.namespace)};
  return item;
}

export function toolChoiceForTools(choice, tools) {
  if (choice == null) return undefined;
  if (typeof choice === 'string') {
    if (!['auto', 'none', 'required'].includes(choice)) fail('invalid_tool_choice');
    if ((tools?.length ?? 0) > 0) return choice;
    if (choice === 'required') fail('tool_choice_requires_tools');
    return undefined;
  }
  if (!object(choice)) fail('invalid_tool_choice');
  if ((tools?.length ?? 0) > 0) return choice;
  fail('tool_choice_requires_tools');
}

export function chatToolChoice(choice, context) {
  const selected = toolChoiceForTools(choice, context.tools);
  if (selected === undefined || typeof selected === 'string') return selected;
  if (selected.type === 'tool_search') {
    if (!context.searchName || context.byName.get(context.searchName)?.kind !== 'search') fail('invalid_tool_choice');
    return {type:'function',function:{name:context.searchName}};
  }
  if (['function','custom'].includes(selected.type)) {
    const name = toolWireName(selected.name ?? selected.function?.name, selected.namespace);
    if (!context.selected.has(name)) fail('invalid_tool_choice');
    return {type:'function',function:{name}};
  }
  fail('invalid_tool_choice');
}
