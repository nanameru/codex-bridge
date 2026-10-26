/** Request-local compatibility for client-executed Responses tool discovery. */
import { createHash } from 'node:crypto';
export class ToolSearchError extends Error {}
const fail = () => { throw new ToolSearchError('このツール検索形式はChat経路で安全に変換できません。client検索と関数定義を確認してください。'); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
export const toolWireName = (name, namespace) => namespace
  ? 'cxb_ns_' + createHash('sha256').update(JSON.stringify([namespace, name])).digest('hex').slice(0, 40) : name;

export function chatToolContext(body) {
  const byName = new Map(), definitions = new Map(), selected = new Set();
  const history = Array.isArray(body.input) ? body.input : [];
  let search;
  const add = (tool, namespace, loaded = false, deferred = false) => {
    if (!object(tool)) fail();
    if (tool.type === 'namespace') {
      if (namespace || typeof tool.name !== 'string' || !tool.name || !Array.isArray(tool.tools)) fail();
      for (const inner of tool.tools) add(inner, tool.name, loaded, deferred || tool.defer_loading === true);
      return;
    }
    if (tool.type === 'tool_search') {
      if (namespace || tool.execution !== 'client' || !object(tool.parameters)) fail();
      if (search && JSON.stringify(search) !== JSON.stringify(tool)) fail();
      search = tool; return;
    }
    // Existing hosted built-ins have their own router paths. Never substitute
    // a hosted tool_search with an unrelated local function.
    if (!['function','custom'].includes(tool.type) && !tool.function) { if (namespace) fail(); return; }
    const custom = tool.type === 'custom';
    const fn = custom ? {...tool,
      description: (tool.description ?? '') + (tool.format ? '\nFormat of the input string value: ' + JSON.stringify(tool.format) : '')
        + '\nCall this function with a JSON object containing exactly one string field: {"input":"..."}. The original tool instructions and format apply to that string value.',
      parameters:{type:'object',properties:{input:{type:'string'}},required:['input'],additionalProperties:false}} : tool.function ?? tool;
    if (typeof fn.name !== 'string' || !fn.name) fail();
    const name = toolWireName(fn.name, namespace);
    const entry = { type: 'function', function: { name, description: (namespace ? `Original tool: ${namespace}.${fn.name}\n` : '') + (fn.description ?? ''), parameters: fn.parameters ?? {type:'object',properties:{}} } };
    if (fn.strict !== undefined) entry.function.strict = fn.strict;
    const prior = definitions.get(name);
    if (prior && JSON.stringify(prior) !== JSON.stringify(entry)) fail();
    const mapped = byName.get(name);
    if (mapped && (mapped.namespace !== namespace || mapped.name !== fn.name || mapped.kind !== (custom ? 'custom' : 'function'))) fail();
    definitions.set(name, entry); byName.set(name, {kind:custom ? 'custom' : 'function', name:fn.name, ...(namespace ? {namespace} : {})});
    if (loaded || (!deferred && tool.defer_loading !== true)) selected.add(name);
  };
  for (const tool of body.tools ?? []) add(tool);
  for (const tool of body.additional_tools ?? []) add(tool);
  for (const item of history) if (item.type === 'additional_tools') {
    if (!Array.isArray(item.tools)) fail();
    for (const tool of item.tools) add(tool);
  }
  for (const item of history) if (item.type === 'tool_search_output') {
    if (item.execution !== 'client' || item.status !== 'completed' || typeof item.call_id !== 'string' || !item.call_id || !Array.isArray(item.tools)) fail();
    for (const tool of item.tools) {
      if (!['function','custom','namespace'].includes(tool?.type)) fail();
      add(tool, undefined, true);
    }
  }
  let searchName;
  if (search) {
    searchName = 'cxb_tool_search';
    let suffix = 0;
    while (byName.has(searchName)) searchName = 'cxb_tool_search_' + ++suffix;
    byName.set(searchName, {kind:'search'});
  }
  // Keep a search callable when replaying its native history, even if a later
  // request has already loaded all tools and omitted the search specification.
  const hasSearchHistory = history.some(item => item.type === 'tool_search_call');
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
      if (!mapped || (mapped.kind !== 'search' && !selected.has(call.function.name))) fail();
      if (mapped.kind === 'search') {
        let args; try { args = JSON.parse(call.function.arguments); } catch { fail(); }
        if (!object(args)) fail();
        return {type:'tool_search_call', execution:'client', status:'completed', call_id:call.id, arguments:args};
      }
      if (mapped.kind === 'custom') {
        let args; try { args = JSON.parse(call.function.arguments); } catch { fail(); }
        if (!object(args) || typeof args.input !== 'string' || Object.keys(args).length !== 1) fail();
        return {type:'custom_tool_call',status:'completed',call_id:call.id,name:mapped.name,
          ...(mapped.namespace ? {namespace:mapped.namespace} : {}),input:args.input};
      }
      return {type:'function_call',status:'completed',call_id:call.id,name:mapped.name,
        ...(mapped.namespace ? {namespace:mapped.namespace} : {}),arguments:call.function.arguments};
    },
  };
}

export function chatSearchHistory(item, context) {
  if (item.type === 'tool_search_call') {
    if (item.execution !== 'client' || (item.status != null && item.status !== 'completed') || typeof item.call_id !== 'string' || !item.call_id || !object(item.arguments) || !context.searchName) fail();
    return {type:'function_call',call_id:item.call_id,name:context.searchName,arguments:JSON.stringify(item.arguments)};
  }
  if (item.type === 'tool_search_output') {
    if (item.execution !== 'client' || item.status !== 'completed' || typeof item.call_id !== 'string' || !item.call_id || !Array.isArray(item.tools)) fail();
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
    if (typeof item.input !== 'string') fail();
    return {type:'function_call',call_id:item.call_id,name:toolWireName(item.name,item.namespace),arguments:JSON.stringify({input:item.input})};
  }
  if (item.type === 'custom_tool_call_output') return {...item,type:'function_call_output'};
  if (item.type === 'function_call' && item.namespace) return {...item,name:toolWireName(item.name,item.namespace)};
  return item;
}

export function chatToolChoice(choice, context) {
  if (choice == null) return undefined;
  if (typeof choice === 'string') {
    if (!['auto', 'none', 'required'].includes(choice)) fail();
    return choice;
  }
  if (!object(choice)) fail();
  if (choice.type === 'tool_search') {
    if (!context.searchName || context.byName.get(context.searchName)?.kind !== 'search') fail();
    return {type:'function',function:{name:context.searchName}};
  }
  if (['function','custom'].includes(choice.type)) {
    const name = toolWireName(choice.name ?? choice.function?.name, choice.namespace);
    if (!context.selected.has(name)) fail();
    return {type:'function',function:{name}};
  }
  fail();
}
