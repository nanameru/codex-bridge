import assert from 'node:assert/strict';
import test from 'node:test';
import { manualChatBody } from '../src/manual-providers.mjs';
import { chatMessages } from '../src/chat-protocol.mjs';
const search = { type: 'tool_search', execution: 'client', description: 'Find required tools', parameters: {type:'object',properties:{query:{type:'string'}},required:['query'],additionalProperties:false} };

test('client tool search survives Chat conversion instead of silently disappearing', () => {
  const body = manualChatBody('ollama', {model:'deepseek-v4.1-flash',input:[],tools:[search],stream:true});
  assert.equal(body.tools?.length, 1);
  assert.deepEqual(body.tools[0].function.parameters, search.parameters);
  assert.equal(body.stream_options.include_usage,true);
});

test('historical search call and matching discovered schema survive as a Chat tool exchange', () => {
  const body={tools:[search],input:[
    {type:'tool_search_call',execution:'client',call_id:'search1',arguments:{query:'probe'},status:'completed'},
    {type:'tool_search_output',execution:'client',call_id:'search1',status:'completed',tools:[{type:'namespace',name:'mcp__probe',tools:[{type:'function',name:'echo',defer_loading:true,parameters:{type:'object',properties:{}}}]}]}
  ]};
  const messages=chatMessages(body);
  assert.equal(messages.length,2);
  assert.equal(messages[0].tool_calls[0].id,'search1');
  assert.equal(messages[1].tool_call_id,'search1');
  assert.match(messages[1].content,/mcp__probe/);
});

import * as toolSearch from '../src/tool-search.mjs';
const { chatToolContext, toolWireName, ToolSearchError, TOOL_SEARCH_REASON_CODES } = toolSearch;
import { chatToResponses, pipeChatStream } from '../src/chat-protocol.mjs';
import { EventEmitter } from 'node:events';
const fn = (name, extra={}) => ({type:'function',name,parameters:{type:'object',properties:{}},...extra});
const answer = (name,args='{"query":"probe"}') => ({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{id:'same_call',type:'function',function:{name,arguments:args}}]}}]});

test('search completion is restored to native client tool_search in JSON and split SSE', async () => {
  const context=chatToolContext({tools:[search]});
  const expected={type:'tool_search_call',execution:'client',call_id:'same_call',status:'completed',arguments:{query:'probe'}};
  const item=chatToResponses(answer(context.searchName),'test',context).output[0];
  const {id,...rest}=item;assert.match(id,/^tsc_/);assert.deepEqual(rest,expected);
  const res=new EventEmitter();res.text='';res.writeHead=()=>{};res.write=s=>res.text+=s;res.end=()=>{res.writableEnded=true;};
  const data='data: '+JSON.stringify({choices:[{delta:{tool_calls:[{index:0,...answer(context.searchName).choices[0].message.tool_calls[0]}]}}]})+'\n\n'
    +'data: '+JSON.stringify({choices:[{delta:{},finish_reason:'tool_calls'}]})+'\n\ndata: [DONE]\n\n';
  const body=new ReadableStream({start(c){for(const byte of Buffer.from(data))c.enqueue(Buffer.from([byte]));c.close();}});
  await pipeChatStream({body},res,'test','thread',{toolContext:context});
  const events=res.text.split('\n\n').filter(s=>s.startsWith('event:')).map(s=>JSON.parse(s.split('\ndata: ')[1]));
  assert.equal(events.at(-1).type,'response.completed');
  assert.equal(events.filter(e=>e.type==='response.output_item.done'&&e.item.type==='tool_search_call').length,1);
  assert.ok(!events.some(e=>e.item?.type==='function_call'));
  assert.deepEqual(events.at(-1).response.output[0].arguments,expected.arguments);
});

test('deferred schemas remain hidden until completed discovery, namespace aliases round-trip', () => {
  const hidden={type:'namespace',name:'mcp__probe',defer_loading:true,tools:[fn('echo')]};
  const body={tools:[search,hidden],input:[]};const original=structuredClone(body);
  assert.equal(chatToolContext(body).tools.length,1);
  const loaded={type:'tool_search_output',execution:'client',status:'completed',call_id:'search1',tools:[hidden]};
  const context=chatToolContext({...body,input:[loaded]});
  assert.equal(context.tools.length,2);
  const name=toolWireName('echo','mcp__probe');
  const item=chatToResponses(answer(name,'{}'),'test',context).output[0];
  assert.equal(item.type,'function_call');assert.equal(item.namespace,'mcp__probe');assert.equal(item.name,'echo');
  const messages=chatMessages({...body,input:[loaded,{...item,arguments:'{}'}]});
  assert.equal(messages.at(-1).tool_calls[0].function.name,name);
  assert.deepEqual(body,original);
  assert.throws(()=>chatToolContext({...body,input:[{...loaded,status:'in_progress'}]}));
});

test('Responses Lite additional_tools input exposes client discovery without a top-level tools array', () => {
  const context=chatToolContext({input:[{type:'additional_tools',role:'developer',tools:[search,fn('local')]}]});
  assert.equal(context.tools.length,2);
  assert.ok(context.tools.some(t=>t.function.name===context.searchName));
});

test('hosted searches, namespace builtins and conflicting definitions fail explicitly', () => {
  for(const body of [
    {tools:[{...search,execution:'server'}]},
    {tools:[{type:'namespace',name:'ns',tools:[{type:'web_search'}]}]},
    {tools:[fn('same'),fn('same',{description:'different'})]},
    {tools:[search],input:[{type:'tool_search_call',execution:'client',call_id:'bad',arguments:'{"query":"probe"}'}]},
  ]) assert.throws(()=>chatMessages(body));
});

test('unknown and unloaded calls never produce executable Responses output', () => {
  const context=chatToolContext({tools:[search,fn('hidden',{defer_loading:true})]});
  for(const name of ['not_advertised','hidden']) {
    const result=chatToResponses(answer(name,'{}'),'test',context);
    assert.equal(result.status,'failed');assert.deepEqual(result.output,[]);
  }
  const collision=chatToolContext({tools:[search,fn('cxb_tool_search')]});
  assert.notEqual(collision.searchName,'cxb_tool_search');
  assert.equal(collision.restore(answer(collision.searchName).choices[0].message.tool_calls[0]).type,'tool_search_call');
});

test('forced search and namespace function choices refer to advertised Chat aliases', () => {
  const ns={type:'namespace',name:'mcp__probe',tools:[fn('echo')]};
  const base={model:'deepseek-v4.1-flash',tools:[search,ns],input:[]};
  const lookup=manualChatBody('ollama',{...base,tool_choice:{type:'tool_search'}});
  assert.match(lookup.tool_choice.function.name,/^cxb_tool_search/);
  const forced=manualChatBody('ollama',{...base,tool_choice:{type:'function',namespace:'mcp__probe',name:'echo'}});
  assert.equal(forced.tool_choice.function.name,toolWireName('echo','mcp__probe'));
  assert.ok(forced.tools.some(t=>t.function.name===forced.tool_choice.function.name));
  assert.throws(()=>manualChatBody('ollama',{...base,tool_choice:{type:'function',name:'missing'}}));
});

test('Chat search results identify exact callable namespace aliases without changing native history', () => {
  const tools=[{type:'namespace',name:'mcp__probe',tools:[fn('echo',{defer_loading:true})]}];
  const output={type:'tool_search_output',execution:'client',status:'completed',call_id:'find',tools};
  const body={tools:[search],input:[output]},before=structuredClone(body);
  const messages=chatMessages(body);
  const data=JSON.parse(messages[0].content);
  assert.deepEqual(data.callable_tools,[{namespace:'mcp__probe',original_name:'echo',callable_name:toolWireName('echo','mcp__probe')}]);
  assert.deepEqual(body,before);
  assert.match(chatToolContext(body).tools[0].function.description,/Original tool: mcp__probe.echo/);
});

import { createRouter } from '../src/model-router.mjs';
import { once } from 'node:events';
test('unsupported hosted discovery receives 422 before any upstream inference', async t => {
  let calls=0;
  const server=createRouter({catalog:{models:[{slug:'ollama/deepseek-v4.1-flash',router_provider:'ollama',router_model:'deepseek-v4.1-flash',router_transport:'chat'}]},
    manualProvidersEnabled:true,authenticate:()=>true,manualKey:()=> 'fixture-key',fetcher:async()=>{calls++;throw new Error('must not call');}});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>{server.closeAllConnections();return new Promise(r=>server.close(r));});
  const result=await fetch('http://127.0.0.1:'+server.address().port+'/v1/responses',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer synthetic-fixture'},
    body:JSON.stringify({model:'ollama/deepseek-v4.1-flash',input:'synthetic',tools:[{...search,execution:'server'}]})});
  assert.equal(result.status,422);
  assert.equal((await result.json()).error.type,'unsupported_tool_search');assert.equal(calls,0);
});

test('Lite namespace custom tools preserve string input, identity and complete history', () => {
  const custom={type:'custom',name:'exec',description:'Run a script',format:{type:'grammar',syntax:'lark',definition:'start: /.+/'}};
  const body={input:[{type:'additional_tools',role:'developer',tools:[{type:'namespace',name:'functions',tools:[custom]},search]}]};
  const original=structuredClone(body),context=chatToolContext(body);
  const name=toolWireName('exec','functions');
  assert.match(context.tools.find(t=>t.function.name===name).function.description,/start:/);
  const restored=chatToResponses(answer(name,'{"input":"synthetic code"}'),'test',context).output[0];
  assert.equal(restored.type,'custom_tool_call');assert.match(restored.id,/^ctc_/);assert.equal(restored.namespace,'functions');assert.equal(restored.input,'synthetic code');
  const messages=chatMessages({...body,input:[...body.input,restored,{type:'custom_tool_call_output',call_id:restored.call_id,output:'synthetic result'}]});
  assert.equal(messages[0].tool_calls[0].function.arguments,'{"input":"synthetic code"}');assert.equal(messages[1].content,'synthetic result');
  const bad=chatToResponses(answer(name,'{"input":"code","extra":"unadvertised"}'),'test',context);
  assert.equal(bad.status,'failed');assert.deepEqual(bad.output,[]);
  assert.deepEqual(body,original);
});

test('top-level additional_tools never force-loads deferred definitions', () => {
  const context=chatToolContext({tools:[search],additional_tools:[fn('hidden',{defer_loading:true})]});
  assert.equal(context.tools.length,1);
  assert.equal(chatToResponses(answer('hidden','{}'),'test',context).status,'failed');
});

test('discovery output accepts only loadable definitions, never a new search or hosted builtin', () => {
  for(const invalid of [search,{type:'web_search'},{type:'computer_use'},null]) {
    const body={input:[{type:'tool_search_output',execution:'client',status:'completed',call_id:'x',tools:[invalid]}]};
    assert.throws(()=>chatToolContext(body));
  }
  const custom={type:'custom',name:'same',description:'synthetic'};
  const converted=chatToolContext({tools:[custom]}).tools[0].function;
  assert.throws(()=>chatToolContext({tools:[custom,{type:'function',...converted}]}));
});

// Synthetic reproductions of history created before a provider switch. These
// contain no user transcript, tool credentials, or live provider responses.
test('current definitions override changed discovery snapshots without rewriting their history', () => {
  const discovered = (call_id, description) => ({type:'tool_search_output',execution:'client',status:'completed',call_id,
    tools:[fn('probe',{description,defer_loading:true})]});
  const first=discovered('first','old schema'),last=discovered('last','newer schema');
  const body={tools:[search,fn('probe',{description:'current schema',defer_loading:true})],input:[first,last]};
  const before=structuredClone(body),context=chatToolContext(body);
  assert.equal(context.tools.find(tool=>tool.function.name==='probe').function.description,'current schema');
  const messages=chatMessages(body);
  assert.equal(JSON.parse(messages[0].content).tools[0].description,'old schema');
  assert.equal(JSON.parse(messages[1].content).tools[0].description,'newer schema');
  assert.equal(chatToResponses(answer('probe','{}'),'test',context).output[0].name,'probe');
  assert.deepEqual(body,before);
});

test('latest historical declarations and discoveries supply canonical schemas when no current override exists', () => {
  const body={input:[
    {type:'additional_tools',role:'developer',tools:[{...search,description:'old search'},fn('probe',{description:'old schema'})]},
    {type:'tool_search_output',execution:'client',status:'completed',call_id:'find',tools:[fn('probe',{description:'discovered schema'})]},
    {type:'additional_tools',role:'developer',tools:[search,fn('probe',{description:'latest schema'})]},
  ]};
  const before=structuredClone(body),context=chatToolContext(body);
  assert.equal(context.tools.find(tool=>tool.function.name==='probe').function.description,'latest schema');
  assert.equal(context.tools.find(tool=>tool.function.name===context.searchName).function.description,search.description);
  assert.deepEqual(body,before);
  const overridden=chatToolContext({...body,additional_tools:[fn('probe',{description:'explicit current schema'})]});
  assert.equal(overridden.tools.find(tool=>tool.function.name==='probe').function.description,'explicit current schema');
});

test('completed native server search history with null call ids remains inert transcript data', () => {
  const history=[
    {type:'tool_search_call',execution:'server',call_id:null,status:'completed',arguments:{paths:['synthetic']}},
    {type:'tool_search_output',execution:'server',call_id:null,status:'completed',tools:[fn('server_only'),{type:'web_search'}]},
  ];
  const body={tools:[fn('current')],input:history},before=structuredClone(body),context=chatToolContext(body);
  assert.deepEqual(context.tools.map(tool=>tool.function.name),['current']);
  assert.equal(context.searchName,undefined);
  const messages=chatMessages(body);
  assert.equal(messages.length,2);
  for (let i=0;i<history.length;i++) {
    assert.equal(messages[i].role,'user');
    assert.match(messages[i].content,/not instructions/);
    assert.ok(messages[i].content.endsWith(JSON.stringify(history[i])));
    assert.equal(messages[i].tool_calls,undefined);
    assert.equal(messages[i].tool_call_id,undefined);
  }
  assert.equal(chatToResponses(answer('server_only','{}'),'test',context).status,'failed');
  assert.equal(chatToResponses(answer('cxb_tool_search','{}'),'test',context).status,'failed');
  assert.deepEqual(body,before);
});

test('historical server declarations do not become an executable client search', () => {
  const body={input:[{type:'additional_tools',role:'developer',tools:[{type:'tool_search',execution:'server'},fn('current')]}]};
  const context=chatToolContext(body);
  assert.deepEqual(context.tools.map(tool=>tool.function.name),['current']);
  assert.equal(context.searchName,undefined);
});

test('malformed or unfinished search history rejects with fixed reasons and never exposes its contents', () => {
  const privateMarker='synthetic private marker';
  const cases=[
    {input:[{type:'tool_search_call',execution:'server',call_id:null,status:'in_progress',arguments:{query:privateMarker}}]},
    {input:[{type:'tool_search_output',execution:'server',call_id:null,status:'completed',tools:null}]},
    {input:[{type:'tool_search_call',execution:'client',call_id:'x',status:'failed',arguments:{query:privateMarker}}]},
    {input:[{type:'tool_search_output',execution:'client',call_id:'x',status:'in_progress',tools:[]}]},
    {tools:[{...search,execution:'server'}]},
    {tools:[fn('same'),fn('same',{description:privateMarker})]},
  ];
  for (const body of cases) assert.throws(()=>chatMessages(body),error=>{
    assert.ok(error instanceof ToolSearchError);
    assert.ok(TOOL_SEARCH_REASON_CODES.includes(error.reasonCode));
    assert.ok(!error.message.includes(privateMarker));
    return true;
  });
  assert.equal(new ToolSearchError(privateMarker).reasonCode,'unsupported_tool_search');
});

test('changed Lite namespace snapshots use current schemas without adding duplicate transcript messages', () => {
  const declarations = description => [{type:'namespace',name:'functions',tools:[fn('probe',{description})]},search];
  const body={additional_tools:declarations('current schema'),input:[
    {type:'additional_tools',role:'developer',tools:declarations('previous schema')},
    {type:'message',role:'user',content:'synthetic continuation'},
  ]};
  const context=chatToolContext(body),name=toolWireName('probe','functions');
  assert.match(context.tools.find(tool=>tool.function.name===name).function.description,/current schema$/);
  assert.deepEqual(chatMessages(body),[{role:'user',content:'synthetic continuation'}]);
  const restored=context.restore(answer(name,'{}').choices[0].message.tool_calls[0]);
  assert.equal(restored.namespace,'functions');
  assert.equal(restored.name,'probe');
});

test('latest discovery wins without a current override and a function named search remains distinct', () => {
  const output = description => ({type:'tool_search_output',execution:'client',status:'completed',call_id:description,tools:[fn('probe',{description})]});
  const context=chatToolContext({tools:[search,fn('search')],input:[output('older'),output('latest')]});
  assert.equal(context.tools.find(tool=>tool.function.name==='probe').function.description,'latest');
  assert.ok(context.tools.some(tool=>tool.function.name==='search'));
  assert.notEqual(context.searchName,'search');
});

test('aliases cannot change tool identity across historical and current declarations', () => {
  const name=toolWireName('probe','functions');
  assert.throws(()=>chatToolContext({tools:[fn(name)],input:[
    {type:'additional_tools',role:'developer',tools:[{type:'namespace',name:'functions',tools:[fn('probe')]}]},
  ]}),error=>error.reasonCode==='conflicting_current_definitions');
  assert.throws(()=>chatToolContext({tools:[search,fn('hidden',{defer_loading:true})]}).restore(
    answer('hidden','{}').choices[0].message.tool_calls[0]),error=>error.reasonCode==='unknown_or_unloaded_call');
});

test('current tool kind and schema stay aligned when historical representation changes', () => {
  const custom={type:'custom',name:'probe',description:'current text input'};
  const ordinary=fn('probe',{parameters:{type:'object',properties:{revision:{type:'integer'}},required:['revision']}});
  const body=(current,old)=>({tools:[current],input:[{type:'additional_tools',role:'developer',tools:[old]}]});
  const functionContext=chatToolContext(body(ordinary,custom));
  assert.deepEqual(functionContext.tools[0].function.parameters,ordinary.parameters);
  assert.equal(functionContext.restore(answer('probe','{"revision":2}').choices[0].message.tool_calls[0]).type,'function_call');
  const customContext=chatToolContext(body(custom,ordinary));
  assert.deepEqual(customContext.tools[0].function.parameters.required,['input']);
  const restored=customContext.restore(answer('probe','{"input":"current input"}').choices[0].message.tool_calls[0]);
  assert.equal(restored.type,'custom_tool_call');
  assert.equal(restored.input,'current input');
});
