import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import test from 'node:test';
import { chatToResponses, pipeChatStream, chatMessages } from '../src/chat-protocol.mjs';
import { answerOnlyStream } from '../src/tool-recovery.mjs';
const frame=data=>'data: '+JSON.stringify(data)+'\n\n';
const tool={index:0,id:'call_test',type:'function',function:{name:'probe',arguments:'{}'}};
async function chat(chunks,options={}) {
 const response=new EventEmitter();response.text='';response.writeHead=()=>{};response.write=s=>{response.text+=s;};response.end=()=>{response.writableEnded=true;};
 await pipeChatStream({body:new ReadableStream({start(c){for(const text of chunks)c.enqueue(Buffer.from(text));c.close();}})},response,'test','thread',options);
 return response.text.split('\n\n').filter(f=>f.startsWith('event:')).map(f=>JSON.parse(f.split('\ndata: ')[1]));
}
async function answer(payload,sse=false) {
 const text=sse?payload.map(p=>'event: '+p.type+'\ndata: '+JSON.stringify(p)+'\n\n').join(''):JSON.stringify(payload);
 const parts=[];for await(const c of Readable.from([Buffer.from(text)]).pipe(answerOnlyStream(sse?'text/event-stream':'application/json',4096)))parts.push(c);
 return Buffer.concat(parts).toString();
}

test('EDGE-01 null and malformed choices return non-retry failure without throwing',async()=>{
 for(const payload of [null,{choices:{}},{choices:'bad'},[]]){
  const result=chatToResponses(payload,'test');assert.equal(result.status,'failed');assert.equal(result.error.code,'invalid_prompt');
 }
 const events=await chat([frame({choices:{bad:true}})]);
 assert.equal(events.at(-1).response.error.code,'invalid_prompt');
});

test('EDGE-02 choice one cannot dispatch a tool when choice zero is the answer',async()=>{
 const events=await chat([frame({choices:[{index:1,delta:{tool_calls:[tool]},finish_reason:'tool_calls'}]}),
  frame({choices:[{index:0,delta:{content:'OK'},finish_reason:'stop'}]})]);
 assert.equal(events.at(-1).type,'response.completed');
 assert.deepEqual(events.at(-1).response.output.map(i=>i.type),['message']);
 assert.equal(chatToResponses({choices:[{index:1,message:{tool_calls:[tool]},finish_reason:'tool_calls'}]},'test').status,'failed');
});

test('EDGE-03 changing a streamed call ID and malformed delta types cannot complete a tool',async()=>{
 for(const second of [{index:0,id:'changed'}, {index:0,function:{arguments:{bad:true}}}]){
  const events=await chat([frame({choices:[{delta:{tool_calls:[tool]}}]}),frame({choices:[{delta:{tool_calls:[second]},finish_reason:'tool_calls'}]})]);
  assert.equal(events.at(-1).type,'response.failed');
  assert.equal(events.at(-1).response.error.code,'invalid_prompt');
  assert.ok(!events.some(e=>e.item?.type==='function_call'));
 }
});

test('EDGE-04 telemetry failure cannot change a valid completed tool into a failed response',async()=>{
 const events=await chat([frame({choices:[{delta:{tool_calls:[tool]},finish_reason:'tool_calls'}],usage:{prompt_tokens:1,completion_tokens:1}})],{
  recordUsage(){throw new Error('telemetry unavailable');}});
 assert.equal(events.at(-1).type,'response.completed');
 assert.equal(events.filter(e=>e.type==='response.output_item.done'&&e.item.type==='function_call').length,1);
});

test('EDGE-05 recovery rejects native executable items and tool deltas',async()=>{
 for(const type of ['shell_call','mcp_call','computer_call','web_search_call']){
  const output=await answer({status:'completed',output:[{type,name:'unsafe'}]});
  assert.match(output,/invalid_prompt/);assert.doesNotMatch(output,/unsafe/);
 }
 const output=await answer([{type:'response.function_call_arguments.delta',item_id:'unknown',delta:'{}'},
  {type:'response.completed',response:{status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'OK'}]}]}}],true);
 assert.match(output,/invalid_prompt/);
});

test('EDGE-06 recovery rejects empty answers and contradictory or multiple terminal events',async()=>{
 for(const payload of [{status:'completed',output:[]},{status:'completed',output:[{type:'message',content:[{type:'output_text',text:'   '}]}]}]){
  assert.match(await answer(payload),/invalid_prompt/);
 }
 const terminal={type:'response.completed',response:{status:'completed',output:[{type:'message',content:[{type:'output_text',text:'OK'}]}]}};
 assert.match(await answer([terminal,terminal],true),/invalid_prompt/);
 assert.match(await answer([{...terminal,response:{...terminal.response,status:'in_progress'}}],true),/invalid_prompt/);
});

test('EDGE-07 parallel results may arrive reversed without losing call IDs or duplicating messages',()=>{
 const input=[{role:'user',content:'parallel'},...['a','b'].map(call_id=>({type:'function_call',call_id,name:'probe',arguments:'{}'})),
 ...['b','a'].map(call_id=>({type:'function_call_output',call_id,output:call_id}))];
 const messages=chatMessages({input});
 assert.deepEqual(messages.filter(m=>m.role==='tool').map(m=>m.tool_call_id),['b','a']);
 assert.equal(messages.filter(m=>m.role==='assistant').length,1);assert.equal(messages[1].tool_calls.length,2);
});

test('EDGE-08 repeated stream terminal and invalid UTF8 are non-retry failures with no tools',async()=>{
 const duplicate=await chat([frame({choices:[{delta:{tool_calls:[tool]},finish_reason:'tool_calls'}]}),'data: [DONE]\n\ndata: [DONE]\n\n']);
 assert.equal(duplicate.at(-1).type,'response.failed');
 const invalid=await chat([Buffer.from([0xff])]);
 assert.equal(invalid.at(-1).response.error.code,'invalid_prompt');
});
